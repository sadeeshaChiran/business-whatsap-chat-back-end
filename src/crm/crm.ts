import { FeatureGuard, RequiresFeature } from '../platform/feature.guard';
import {
  BadRequestException, Body, Controller, Get, Injectable, Logger, Module, NotFoundException, OnModuleDestroy, OnModuleInit,
  Param, ParseIntPipe, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { DataSource } from 'typeorm';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

const LEAD_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'] as const;
const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/* ───────── DTOs ───────── */

export class ContactsQueryDto {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(LEAD_STAGES as unknown as string[]) stage?: string;
  @IsOptional() @IsString() @MaxLength(60) tag?: string;
  @IsOptional() @IsIn(['whatsapp', 'messenger', 'instagram']) channel?: string;
  @IsOptional() @IsIn(['recent', 'value', 'orders', 'name']) sort?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}

export class UpdateContactDto {
  @IsOptional() @IsString() @MaxLength(255) display_name?: string;
  @IsOptional() @IsEmail() @MaxLength(255) email?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) deal_value?: number | null;
  @IsOptional() @IsIn(LEAD_STAGES as unknown as string[]) lead_stage?: string;
  @IsOptional() @Type(() => Number) @IsInt() owner_user_id?: number | null;
}

export class NoteDto {
  @IsString() @MinLength(1) @MaxLength(4000) content: string;
}

export class TaskDto {
  @IsString() @MinLength(2) @MaxLength(255) title: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
  @IsOptional() @IsString() due_at?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() assigned_user_id?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() contact_id?: number | null;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(255) title?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
  @IsOptional() @IsString() due_at?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() assigned_user_id?: number | null;
  @IsOptional() @IsIn(['open', 'done']) status?: 'open' | 'done';
}

export class TasksQueryDto {
  @IsOptional() @IsIn(['open', 'done', 'all']) status?: string;
  @IsOptional() @IsIn(['mine', 'all']) scope?: string;
  @IsOptional() @Type(() => Number) @IsInt() contact_id?: number;
}

/* ───────── Service ───────── */

/**
 * CRM on top of the chat data: every WhatsApp / Messenger / Instagram customer is a contact.
 * Extra CRM fields live in crm_contact; tasks in crm_task; notes reuse bot_customer_note.
 */
@Injectable()
export class CrmService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CrmService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  onModuleInit() { this.timer = setInterval(() => void this.remindDueTasks(), 10 * 60 * 1000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private companyId(user: AuthenticatedUser) {
    const id = Number(user.company_id);
    if (!id) throw new BadRequestException('No company.');
    return id;
  }

  private async assertContact(companyId: number, contactId: number) {
    const [row] = await this.dataSource.query(`SELECT id FROM bot_channel_user WHERE id = $1 AND company_id = $2`, [contactId, companyId]);
    if (!row) throw new NotFoundException('Contact not found.');
  }

  async contacts(user: AuthenticatedUser, query: ContactsQueryDto) {
    const companyId = this.companyId(user);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = 50;
    const search = String(query.search ?? '').trim().toLowerCase();
    const order = { value: 'total_spent DESC NULLS LAST', orders: 'orders DESC', name: 'name ASC' }[query.sort ?? ''] ?? 'last_activity DESC NULLS LAST';
    const rows = await this.dataSource.query(`
      WITH base AS (
        SELECT cu.id, COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS name, cu.platform AS channel, cu.external_user_id,
               cc.email, COALESCE(cc.phone, CASE WHEN cu.platform = 'whatsapp' THEN cu.external_user_id END) AS phone,
               COALESCE(cc.tags, '{}') AS tags, cc.deal_value, cc.owner_user_id, cu.created_at,
               cv.id AS conversation_id, COALESCE(cv.lead_stage, 'new') AS lead_stage, cv.lead_details,
               GREATEST(cv.last_message_at, cu.last_seen_at) AS last_activity,
               (SELECT COUNT(*) FROM bot_order o WHERE o.bot_channel_user_id = cu.id AND o.status::text <> 'Cancelled')::int AS orders,
               (SELECT COALESCE(SUM(total_amount), 0) FROM bot_order o WHERE o.bot_channel_user_id = cu.id AND o.status::text <> 'Cancelled') AS total_spent,
               (SELECT COUNT(*) FROM crm_task t WHERE t.bot_channel_user_id = cu.id AND t.status = 'open')::int AS open_tasks
          FROM bot_channel_user cu
          LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
          LEFT JOIN LATERAL (SELECT * FROM bot_conversation c WHERE c.bot_channel_user_id = cu.id ORDER BY c.id DESC LIMIT 1) cv ON TRUE
         WHERE cu.company_id = $1
      )
      SELECT *, COUNT(*) OVER() AS total_count FROM base
       WHERE ($2 = '' OR LOWER(name) LIKE '%' || $2 || '%' OR external_user_id LIKE '%' || $2 || '%' OR LOWER(COALESCE(email, '')) LIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR lead_stage = $3)
         AND ($4::text IS NULL OR $4 = ANY(tags))
         AND ($5::text IS NULL OR channel = $5)
       ORDER BY ${order}
       LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      [companyId, search, query.stage ?? null, query.tag ?? null, query.channel ?? null]);
    const [stats] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS contacts,
             COUNT(*) FILTER (WHERE cu.created_at > NOW() - INTERVAL '30 days')::int AS new_30d,
             (SELECT COUNT(*) FROM crm_task t WHERE t.company_id = $1 AND t.status = 'open' AND t.due_at < NOW())::int AS overdue_tasks
        FROM bot_channel_user cu WHERE cu.company_id = $1`, [companyId]);
    const tags: Array<{ tag: string; n: number }> = await this.dataSource.query(
      `SELECT tag, COUNT(*)::int AS n FROM crm_contact, UNNEST(tags) AS tag WHERE company_id = $1 GROUP BY tag ORDER BY n DESC LIMIT 50`, [companyId]);
    return {
      page, total: num(rows[0]?.total_count), stats, tags,
      contacts: rows.map(({ total_count: _total, ...row }: Record<string, unknown>) => ({ ...row, total_spent: num(row.total_spent), deal_value: row.deal_value == null ? null : num(row.deal_value) })),
    };
  }

  async contact(user: AuthenticatedUser, id: number) {
    const companyId = this.companyId(user);
    await this.assertContact(companyId, id);
    const [profile] = await this.dataSource.query(`
      SELECT cu.id, COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS name, cu.display_name, cu.platform AS channel, cu.external_user_id,
             cu.bot_enabled, cu.created_at, cu.last_seen_at, cc.email, COALESCE(cc.phone, CASE WHEN cu.platform = 'whatsapp' THEN cu.external_user_id END) AS phone,
             COALESCE(cc.tags, '{}') AS tags, cc.deal_value, cc.owner_user_id
        FROM bot_channel_user cu LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id WHERE cu.id = $1`, [id]);
    const conversations = await this.dataSource.query(
      `SELECT id, status, lead_stage, lead_details, last_message_at, created_at FROM bot_conversation WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 10`, [id]);
    const orders = await this.dataSource.query(
      `SELECT id, status, total_amount, created_at FROM bot_order WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 20`, [id]);
    const bookings = await this.dataSource.query(
      `SELECT id, service_name, date, time, status, created_at FROM bot_booking WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 20`, [id]).catch(() => []);
    const notes = await this.dataSource.query(
      `SELECT id, content, created_by_name, created_at FROM bot_customer_note WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 50`, [id]);
    const tasks = await this.dataSource.query(`
      SELECT t.*, u.name AS assigned_name FROM crm_task t LEFT JOIN app_user u ON u.id = t.assigned_user_id
       WHERE t.bot_channel_user_id = $1 ORDER BY (t.status = 'done'), t.due_at NULLS LAST, t.id DESC`, [id]);
    const [messages] = await this.dataSource.query(`
      SELECT COUNT(*) FILTER (WHERE m.direction::text = 'inbound')::int AS received, COUNT(*) FILTER (WHERE m.direction::text = 'outbound')::int AS sent
        FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id WHERE c.bot_channel_user_id = $1`, [id]);
    const timeline = [
      { type: 'contact', at: profile.created_at, text: `First message on ${profile.channel}` },
      ...orders.map((o: Record<string, unknown>) => ({ type: 'order', at: o.created_at, text: `Order #${o.id} – Rs ${num(o.total_amount).toLocaleString()} (${o.status})` })),
      ...bookings.map((b: Record<string, unknown>) => ({ type: 'booking', at: b.created_at, text: `Booking: ${b.service_name} ${b.date} ${b.time} (${b.status})` })),
      ...notes.map((n: Record<string, unknown>) => ({ type: 'note', at: n.created_at, text: String(n.content).slice(0, 160), by: n.created_by_name })),
      ...tasks.map((t: Record<string, unknown>) => ({ type: 'task', at: t.done_at ?? t.created_at, text: `${t.status === 'done' ? 'Done' : 'Task'}: ${t.title}` })),
    ].sort((a, b) => new Date(String(b.at)).getTime() - new Date(String(a.at)).getTime()).slice(0, 60);
    const totalSpent = orders.filter((o: Record<string, unknown>) => o.status !== 'Cancelled').reduce((sum: number, o: Record<string, unknown>) => sum + num(o.total_amount), 0);
    return {
      profile: { ...profile, deal_value: profile.deal_value == null ? null : num(profile.deal_value) },
      stats: { orders: orders.length, total_spent: totalSpent, bookings: bookings.length, messages_received: num(messages?.received), messages_sent: num(messages?.sent) },
      conversations, orders, bookings, notes, tasks, timeline,
    };
  }

  async updateContact(user: AuthenticatedUser, id: number, dto: UpdateContactDto) {
    const companyId = this.companyId(user);
    await this.assertContact(companyId, id);
    if (dto.display_name !== undefined) await this.dataSource.query(`UPDATE bot_channel_user SET display_name = $2 WHERE id = $1`, [id, dto.display_name.trim()]);
    await this.dataSource.query(`
      INSERT INTO crm_contact (bot_channel_user_id, company_id) VALUES ($1, $2) ON CONFLICT (bot_channel_user_id) DO NOTHING`, [id, companyId]);
    const sets: string[] = [];
    const values: unknown[] = [id];
    const add = (column: string, value: unknown) => { values.push(value); sets.push(`${column} = $${values.length}`); };
    if (dto.email !== undefined) add('email', dto.email.trim().toLowerCase() || null);
    if (dto.phone !== undefined) add('phone', dto.phone.replace(/[^\d+]/g, '') || null);
    if (dto.tags !== undefined) add('tags', [...new Set(dto.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]);
    if (dto.deal_value !== undefined) add('deal_value', dto.deal_value);
    if (dto.owner_user_id !== undefined) add('owner_user_id', dto.owner_user_id);
    if (sets.length) await this.dataSource.query(`UPDATE crm_contact SET ${sets.join(', ')}, updated_at = NOW() WHERE bot_channel_user_id = $1`, values);
    if (dto.lead_stage !== undefined) {
      await this.dataSource.query(`
        UPDATE bot_conversation SET lead_stage = $2 WHERE id = (SELECT id FROM bot_conversation WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 1)`, [id, dto.lead_stage]);
    }
    return this.contact(user, id);
  }

  async addNote(user: AuthenticatedUser, id: number, dto: NoteDto) {
    const companyId = this.companyId(user);
    await this.assertContact(companyId, id);
    const [me] = await this.dataSource.query(`SELECT name FROM app_user WHERE id = $1`, [user.id]);
    await this.dataSource.query(
      `INSERT INTO bot_customer_note (company_id, bot_channel_user_id, content, created_by_user_id, created_by_name) VALUES ($1, $2, $3, $4, $5)`,
      [companyId, id, dto.content.trim(), user.id, me?.name ?? 'Team']);
    return this.contact(user, id);
  }

  /* ───── Tasks ───── */

  async tasks(user: AuthenticatedUser, query: TasksQueryDto) {
    const companyId = this.companyId(user);
    return this.dataSource.query(`
      SELECT t.*, u.name AS assigned_name, COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS contact_name
        FROM crm_task t LEFT JOIN app_user u ON u.id = t.assigned_user_id LEFT JOIN bot_channel_user cu ON cu.id = t.bot_channel_user_id
       WHERE t.company_id = $1
         AND ($2 = 'all' OR t.status = $2)
         AND ($3 <> 'mine' OR t.assigned_user_id = $4)
         AND ($5::int IS NULL OR t.bot_channel_user_id = $5)
       ORDER BY (t.status = 'done'), t.due_at NULLS LAST, t.id DESC LIMIT 300`,
      [companyId, query.status ?? 'open', query.scope ?? 'all', user.id, query.contact_id ?? null]);
  }

  private dueDate(value: string | null | undefined) {
    if (value === undefined) return undefined;
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('due_at must be a date.');
    return date;
  }

  private async assertUser(companyId: number, userId: number | null | undefined) {
    if (!userId) return;
    const [row] = await this.dataSource.query(`SELECT 1 FROM app_user WHERE id = $1 AND company_id = $2`, [userId, companyId]);
    if (!row) throw new BadRequestException('That person is not in your team.');
  }

  async createTask(user: AuthenticatedUser, dto: TaskDto) {
    const companyId = this.companyId(user);
    if (dto.contact_id) await this.assertContact(companyId, dto.contact_id);
    await this.assertUser(companyId, dto.assigned_user_id);
    const [row] = await this.dataSource.query(`
      INSERT INTO crm_task (company_id, bot_channel_user_id, title, notes, due_at, assigned_user_id, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [companyId, dto.contact_id ?? null, dto.title.trim(), dto.notes?.trim() ?? '', this.dueDate(dto.due_at) ?? null, dto.assigned_user_id ?? user.id, user.id]);
    return row;
  }

  async updateTask(user: AuthenticatedUser, id: number, dto: UpdateTaskDto) {
    const companyId = this.companyId(user);
    const [task] = await this.dataSource.query(`SELECT * FROM crm_task WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (!task) throw new NotFoundException('Task not found.');
    await this.assertUser(companyId, dto.assigned_user_id);
    const due = this.dueDate(dto.due_at);
    const result = await this.dataSource.query(`
      UPDATE crm_task SET
        title = COALESCE($2, title), notes = COALESCE($3, notes),
        due_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE due_at END,
        reminded_at = CASE WHEN $4::boolean THEN NULL ELSE reminded_at END,
        assigned_user_id = CASE WHEN $6::boolean THEN $7::bigint ELSE assigned_user_id END,
        status = COALESCE($8, status),
        done_at = CASE WHEN $8 = 'done' AND status <> 'done' THEN NOW() WHEN $8 = 'open' THEN NULL ELSE done_at END
      WHERE id = $1 RETURNING *`,
      [id, dto.title?.trim() ?? null, dto.notes ?? null, due !== undefined, due ?? null, dto.assigned_user_id !== undefined, dto.assigned_user_id ?? null, dto.status ?? null]);
    // TypeORM returns [rows, affectedCount] for UPDATE … RETURNING
    return Array.isArray(result[0]) ? result[0][0] : result[0];
  }

  /** Every 10 minutes: tasks due within the next hour → a notification (once per task). */
  async remindDueTasks() {
    try {
      const due = await this.dataSource.query(`
        SELECT t.id, t.company_id, t.title, u.name AS assigned_name, COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS contact
          FROM crm_task t LEFT JOIN app_user u ON u.id = t.assigned_user_id LEFT JOIN bot_channel_user cu ON cu.id = t.bot_channel_user_id
         WHERE t.status = 'open' AND t.reminded_at IS NULL AND t.due_at IS NOT NULL AND t.due_at < NOW() + INTERVAL '1 hour'`);
      for (const task of due) {
        await this.dataSource.query(`INSERT INTO bot_notification (company_id, kind, priority, title, message) VALUES ($1, 'task', 'MEDIUM', $2, $3)`,
          [task.company_id, `Follow-up due: ${task.title}`, `${task.contact ? `Customer: ${task.contact}. ` : ''}${task.assigned_name ? `Assigned to ${task.assigned_name}.` : ''}`]);
        await this.dataSource.query(`UPDATE crm_task SET reminded_at = NOW() WHERE id = $1`, [task.id]);
      }
    } catch (error) {
      this.logger.warn(`task reminders failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /* ───── CSV ───── */

  async exportCsv(user: AuthenticatedUser) {
    const { contacts } = await this.contacts(user, { page: 1 });
    const all = [...contacts];
    for (let page = 2; all.length < 10_000; page += 1) {
      const next = await this.contacts(user, { page });
      if (!next.contacts.length) break;
      all.push(...next.contacts);
    }
    const headers = ['id', 'name', 'channel', 'phone', 'email', 'tags', 'lead_stage', 'orders', 'total_spent', 'deal_value', 'last_activity'];
    const cell = (value: unknown) => {
      let text = Array.isArray(value) ? value.join(';') : value instanceof Date ? value.toISOString() : value == null ? '' : String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // no spreadsheet formulas from customer names
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [headers.join(','), ...all.map((row: Record<string, unknown>) => headers.map((key) => cell(row[key])).join(','))].join('\n');
  }

  /** CSV with columns: name, phone (WhatsApp), email, tags (separated by ;). Existing numbers are updated. */
  async importCsv(user: AuthenticatedUser, file?: { buffer: Buffer }) {
    const companyId = this.companyId(user);
    if (!file?.buffer?.length) throw new BadRequestException('Upload a CSV file.');
    const lines = file.buffer.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) throw new BadRequestException('The CSV has no rows.');
    const split = (line: string) => (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((part) => part.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim());
    const header = split(lines[0]).map((h) => h.toLowerCase());
    const col = (names: string[]) => header.findIndex((h) => names.includes(h));
    const [iName, iPhone, iEmail, iTags] = [col(['name', 'customer', 'full name']), col(['phone', 'whatsapp', 'mobile', 'number']), col(['email']), col(['tags', 'tag'])];
    if (iPhone < 0) throw new BadRequestException('The CSV needs a "phone" (WhatsApp number) column.');
    let created = 0;
    let updated = 0;
    const skipped: number[] = [];
    for (const [index, line] of lines.slice(1).entries()) {
      const cells = split(line);
      let phone = String(cells[iPhone] ?? '').replace(/\D/g, '');
      if (phone.length === 10 && phone.startsWith('0')) phone = `94${phone.slice(1)}`;
      if (phone.length === 9 && phone.startsWith('7')) phone = `94${phone}`;
      if (phone.length < 10) { skipped.push(index + 2); continue; }
      const name = iName >= 0 ? cells[iName] ?? '' : '';
      let [row] = await this.dataSource.query(`SELECT id FROM bot_channel_user WHERE company_id = $1 AND platform = 'whatsapp' AND external_user_id = $2`, [companyId, phone]);
      if (!row) {
        [row] = await this.dataSource.query(`
          INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name, bot_enabled, manual_mode, created_at, updated_at)
          VALUES ($1, 'whatsapp', $2, $3, FALSE, FALSE, NOW(), NOW()) RETURNING id`, [companyId, phone, name || phone]);
        created += 1;
      } else {
        if (name) await this.dataSource.query(`UPDATE bot_channel_user SET display_name = $2 WHERE id = $1`, [row.id, name]);
        updated += 1;
      }
      const tags = iTags >= 0 ? String(cells[iTags] ?? '').split(/[;|]/).map((t) => t.trim().toLowerCase()).filter(Boolean) : [];
      const email = iEmail >= 0 ? String(cells[iEmail] ?? '').trim().toLowerCase() || null : null;
      await this.dataSource.query(`
        INSERT INTO crm_contact (bot_channel_user_id, company_id, email, phone, tags, source) VALUES ($1, $2, $3, $4, $5, 'import')
        ON CONFLICT (bot_channel_user_id) DO UPDATE SET email = COALESCE(EXCLUDED.email, crm_contact.email),
          tags = (SELECT ARRAY(SELECT DISTINCT UNNEST(crm_contact.tags || EXCLUDED.tags))), updated_at = NOW()`,
        [row.id, companyId, email, phone, tags]);
    }
    return { created, updated, skipped_rows: skipped };
  }

  team(user: AuthenticatedUser) {
    return this.dataSource.query(`SELECT id, name FROM app_user WHERE company_id = $1 AND is_active = TRUE ORDER BY name`, [this.companyId(user)]);
  }
}

@Controller('crm')
@ApiTags('CRM')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, FeatureGuard)
@RequiresFeature('crm')
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get('contacts')
  contacts(@CurrentUser() user: AuthenticatedUser, @Query() query: ContactsQueryDto) { return this.crm.contacts(user, query); }

  @Get('contacts/export')
  @AdminOnly()
  async export(@CurrentUser() user: AuthenticatedUser, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(await this.crm.exportCsv(user));
  }

  @Post('contacts/import')
  @AdminOnly()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  import(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file?: { buffer: Buffer }) { return this.crm.importCsv(user, file); }

  @Get('contacts/:id')
  contact(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.crm.contact(user, id); }

  @Patch('contacts/:id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateContactDto) { return this.crm.updateContact(user, id, dto); }

  @Post('contacts/:id/notes')
  note(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: NoteDto) { return this.crm.addNote(user, id, dto); }

  @Get('tasks')
  tasks(@CurrentUser() user: AuthenticatedUser, @Query() query: TasksQueryDto) { return this.crm.tasks(user, query); }

  @Post('tasks')
  createTask(@CurrentUser() user: AuthenticatedUser, @Body() dto: TaskDto) { return this.crm.createTask(user, dto); }

  @Patch('tasks/:id')
  updateTask(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTaskDto) { return this.crm.updateTask(user, id, dto); }

  @Get('team')
  team(@CurrentUser() user: AuthenticatedUser) { return this.crm.team(user); }
}

@Module({ imports: [AuthModule], controllers: [CrmController], providers: [CrmService] })
export class CrmModule {}
