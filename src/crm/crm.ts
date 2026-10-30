import { FeatureGuard, RequiresFeature } from '../platform/feature.guard';
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException, OnModuleDestroy, OnModuleInit,
  Param, ParseIntPipe, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import * as XLSX from 'xlsx';
import { DataSource } from 'typeorm';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ManagerOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CustomerInsightsController, CustomerInsightsService } from './insights';

const LEAD_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'] as const;
const PRIORITIES = ['low', 'normal', 'high'] as const;
const TASK_KINDS = ['follow_up', 'call', 'whatsapp', 'meeting', 'payment', 'delivery', 'other'] as const;
/** The contact's stage: from their latest chat, or (no chat yet, e.g. imported) from the CRM record. */
const STAGE_SQL = `COALESCE(cv.lead_stage, cc.stage, 'new')`;
const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
/** 0771234567 / 771234567 / +94 77 123 4567 → 94771234567 ('' when it is not a phone number) */
export function lkPhone(value: string): string {
  let phone = String(value ?? '').replace(/\D/g, '');
  if (phone.length === 10 && phone.startsWith('0')) phone = `94${phone.slice(1)}`;
  if (phone.length === 9 && phone.startsWith('7')) phone = `94${phone}`;
  return phone.length >= 10 && phone.length <= 15 ? phone : '';
}

/* ───────── DTOs ───────── */

/** One contact from the import preview (columns already matched to these fields). */
export class ImportRowDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsString() @MaxLength(40) phone: string;
  @IsOptional() @IsString() @MaxLength(255) email?: string;
  @IsOptional() @IsString() @MaxLength(400) tags?: string;
  @IsOptional() @IsString() @MaxLength(40) stage?: string;
  @IsOptional() @IsString() @MaxLength(40) deal_value?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
export class ImportRowsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => ImportRowDto) rows: ImportRowDto[];
}

export class ContactsQueryDto {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(LEAD_STAGES as unknown as string[]) stage?: string;
  @IsOptional() @IsString() @MaxLength(60) tag?: string;
  @IsOptional() @IsIn(['whatsapp', 'messenger', 'instagram']) channel?: string;
  @IsOptional() @IsIn(['recent', 'value', 'orders', 'name', 'deal', 'newest']) sort?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  /** a team member's id, or 0 = no owner */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) owner?: number;
}

export class CreateContactDto {
  @IsString() @MinLength(1) @MaxLength(255) name: string;
  @IsString() @MinLength(9) @MaxLength(30) phone: string;
  @IsOptional() @IsEmail() @MaxLength(255) email?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsIn(LEAD_STAGES as unknown as string[]) lead_stage?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) deal_value?: number | null;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class BulkContactsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @Type(() => Number) @IsInt({ each: true }) ids: number[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) add_tags?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) remove_tags?: string[];
  @IsOptional() @IsIn(LEAD_STAGES as unknown as string[]) lead_stage?: string;
  /** 0 = remove the owner */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) owner_user_id?: number;
}

export class PipelineQueryDto {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) owner?: number;
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
  @IsOptional() @IsIn(PRIORITIES as unknown as string[]) priority?: string;
  @IsOptional() @IsIn(TASK_KINDS as unknown as string[]) kind?: string;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(255) title?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
  @IsOptional() @IsString() due_at?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() assigned_user_id?: number | null;
  @IsOptional() @IsIn(['open', 'done']) status?: 'open' | 'done';
  @IsOptional() @IsIn(PRIORITIES as unknown as string[]) priority?: string;
  @IsOptional() @IsIn(TASK_KINDS as unknown as string[]) kind?: string;
  /** null = no customer */
  @IsOptional() @Type(() => Number) @IsInt() contact_id?: number | null;
}

export class TasksQueryDto {
  @IsOptional() @IsIn(['open', 'done', 'all']) status?: string;
  @IsOptional() @IsIn(['mine', 'all', 'created']) scope?: string;
  @IsOptional() @Type(() => Number) @IsInt() contact_id?: number;
  @IsOptional() @IsIn(['overdue', 'today', 'week', 'later', 'none']) due?: string;
  @IsOptional() @IsIn(PRIORITIES as unknown as string[]) priority?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
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

  /** null for the company admin; the agent's own id for an agent (agents only see their own customers) */
  private async agentOf(user: AuthenticatedUser): Promise<number | null> {
    if (user.role === 'supervisor') return null; // team lead sees every customer
    const [company] = await this.dataSource.query(`SELECT admin_user_id FROM companies WHERE id = $1`, [Number(user.company_id)]);
    return company && Number(company.admin_user_id) === Number(user.id) ? null : Number(user.id);
  }

  /** "This customer belongs to the agent": their latest chat is assigned to the agent, or the agent owns the CRM contact. */
  private static readonly MINE = `(
    (SELECT c.assigned_agent_id FROM bot_conversation c WHERE c.bot_channel_user_id = cu.id ORDER BY c.id DESC LIMIT 1) = $AGENT
    OR EXISTS (SELECT 1 FROM crm_contact x WHERE x.bot_channel_user_id = cu.id AND x.owner_user_id = $AGENT))`;

  private async assertContact(companyId: number, contactId: number, agentId: number | null = null) {
    const [row] = await this.dataSource.query(
      `SELECT cu.id FROM bot_channel_user cu WHERE cu.id = $1 AND cu.company_id = $2
         AND ($3::int IS NULL OR ${CrmService.MINE.replace(/\$AGENT/g, '$3')})`, [contactId, companyId, agentId]);
    if (!row) throw new NotFoundException(agentId ? 'This customer is not assigned to you.' : 'Contact not found.');
  }

  async contacts(user: AuthenticatedUser, query: ContactsQueryDto) {
    const companyId = this.companyId(user);
    const agentId = await this.agentOf(user);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = 50;
    const search = String(query.search ?? '').trim().toLowerCase();
    const order = {
      value: 'total_spent DESC NULLS LAST', orders: 'orders DESC', name: 'name ASC', deal: 'deal_value DESC NULLS LAST', newest: 'created_at DESC',
    }[query.sort ?? ''] ?? 'last_activity DESC NULLS LAST';
    const rows = await this.dataSource.query(`
      WITH base AS (
        SELECT cu.id, COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS name, cu.platform AS channel, cu.external_user_id,
               cc.email, COALESCE(cc.phone, CASE WHEN cu.platform = 'whatsapp' THEN cu.external_user_id END) AS phone,
               COALESCE(cc.tags, '{}') AS tags, cc.deal_value, cc.owner_user_id, ow.name AS owner_name, cu.created_at,
               cv.id AS conversation_id, ${STAGE_SQL} AS lead_stage, cv.lead_details, cv.assigned_agent_id, ag.name AS agent_name,
               GREATEST(cv.last_message_at, cu.last_seen_at) AS last_activity,
               (SELECT COUNT(*) FROM bot_order o WHERE o.bot_channel_user_id = cu.id AND o.status::text <> 'Cancelled')::int AS orders,
               (SELECT COALESCE(SUM(total_amount), 0) FROM bot_order o WHERE o.bot_channel_user_id = cu.id AND o.status::text <> 'Cancelled') AS total_spent,
               (SELECT COUNT(*) FROM crm_task t WHERE t.bot_channel_user_id = cu.id AND t.status = 'open')::int AS open_tasks
          FROM bot_channel_user cu
          LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
          LEFT JOIN LATERAL (SELECT * FROM bot_conversation c WHERE c.bot_channel_user_id = cu.id ORDER BY c.id DESC LIMIT 1) cv ON TRUE
          LEFT JOIN app_user ow ON ow.id = cc.owner_user_id
          LEFT JOIN app_user ag ON ag.id = cv.assigned_agent_id
         WHERE cu.company_id = $1 AND ($6::int IS NULL OR ${CrmService.MINE.replace(/\$AGENT/g, '$6')})
           AND ($7::int IS NULL OR ($7 = 0 AND cc.owner_user_id IS NULL) OR cc.owner_user_id = $7)
      )
      SELECT *, COUNT(*) OVER() AS total_count FROM base
       WHERE ($2 = '' OR LOWER(name) LIKE '%' || $2 || '%' OR external_user_id LIKE '%' || $2 || '%' OR LOWER(COALESCE(email, '')) LIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR lead_stage = $3)
         AND ($4::text IS NULL OR $4 = ANY(tags))
         AND ($5::text IS NULL OR channel = $5)
       ORDER BY ${order}
       LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      [companyId, search, query.stage ?? null, query.tag ?? null, query.channel ?? null, agentId, query.owner ?? null]);
    const [stats] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS contacts,
             COUNT(*) FILTER (WHERE cu.created_at > NOW() - INTERVAL '30 days')::int AS new_30d,
             (SELECT COUNT(*) FROM crm_task t WHERE t.company_id = $1 AND t.status = 'open' AND t.due_at < NOW()
                AND ($2::int IS NULL OR t.assigned_user_id = $2))::int AS overdue_tasks
        FROM bot_channel_user cu WHERE cu.company_id = $1 AND ($2::int IS NULL OR ${CrmService.MINE.replace(/\$AGENT/g, '$2')})`, [companyId, agentId]);
    const tags: Array<{ tag: string; n: number }> = await this.dataSource.query(
      `SELECT tag, COUNT(*)::int AS n FROM crm_contact, UNNEST(tags) AS tag WHERE company_id = $1 GROUP BY tag ORDER BY n DESC LIMIT 50`, [companyId]);
    return {
      page, total: num(rows[0]?.total_count), stats, tags,
      contacts: rows.map(({ total_count: _total, ...row }: Record<string, unknown>) => ({ ...row, total_spent: num(row.total_spent), deal_value: row.deal_value == null ? null : num(row.deal_value) })),
    };
  }

  async contact(user: AuthenticatedUser, id: number) {
    const companyId = this.companyId(user);
    await this.assertContact(companyId, id, await this.agentOf(user));
    const [profile] = await this.dataSource.query(`
      SELECT cu.id, COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS name, cu.display_name, cu.platform AS channel, cu.external_user_id,
             cu.bot_enabled, cu.created_at, cu.last_seen_at, cc.email, COALESCE(cc.phone, CASE WHEN cu.platform = 'whatsapp' THEN cu.external_user_id END) AS phone,
             COALESCE(cc.tags, '{}') AS tags, cc.deal_value, cc.owner_user_id, ow.name AS owner_name,
             COALESCE((SELECT c.lead_stage FROM bot_conversation c WHERE c.bot_channel_user_id = cu.id ORDER BY c.id DESC LIMIT 1), cc.stage, 'new') AS lead_stage
        FROM bot_channel_user cu LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id LEFT JOIN app_user ow ON ow.id = cc.owner_user_id
       WHERE cu.id = $1`, [id]);
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
    const agentId = await this.agentOf(user);
    await this.assertContact(companyId, id, agentId);
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
    if (dto.owner_user_id !== undefined) {
      if (agentId) throw new ForbiddenException('Only the admin can change who owns a customer.');
      await this.assertUser(companyId, dto.owner_user_id);
      add('owner_user_id', dto.owner_user_id || null);
    }
    if (sets.length) await this.dataSource.query(`UPDATE crm_contact SET ${sets.join(', ')}, updated_at = NOW() WHERE bot_channel_user_id = $1`, values);
    if (dto.lead_stage !== undefined) {
      await this.dataSource.query(`UPDATE crm_contact SET stage = $2, updated_at = NOW() WHERE bot_channel_user_id = $1`, [id, dto.lead_stage]);
      await this.dataSource.query(`
        UPDATE bot_conversation SET lead_stage = $2, lead_stage_manual = TRUE WHERE id = (SELECT id FROM bot_conversation WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 1)`, [id, dto.lead_stage]);
    }
    return this.contact(user, id);
  }

  async addNote(user: AuthenticatedUser, id: number, dto: NoteDto) {
    const companyId = this.companyId(user);
    await this.assertContact(companyId, id, await this.agentOf(user));
    const [me] = await this.dataSource.query(`SELECT name FROM app_user WHERE id = $1`, [user.id]);
    await this.dataSource.query(
      `INSERT INTO bot_customer_note (company_id, bot_channel_user_id, content, created_by_user_id, created_by_name) VALUES ($1, $2, $3, $4, $5)`,
      [companyId, id, dto.content.trim(), user.id, me?.name ?? 'Team']);
    return this.contact(user, id);
  }

  /** Add a customer by hand (WhatsApp number). An agent who adds one becomes its owner, so it shows in their CRM. */
  async createContact(user: AuthenticatedUser, dto: CreateContactDto) {
    const companyId = this.companyId(user);
    const agentId = await this.agentOf(user);
    const phone = lkPhone(dto.phone);
    if (!phone) throw new BadRequestException('Enter a WhatsApp number, e.g. 0771234567 or 94771234567.');
    const [existing] = await this.dataSource.query(
      `SELECT id FROM bot_channel_user WHERE company_id = $1 AND platform = 'whatsapp' AND regexp_replace(external_user_id, '\\D', '', 'g') IN ($2, $3)`,
      [companyId, phone, phone.startsWith('94') ? `0${phone.slice(2)}` : phone]);
    if (existing) throw new BadRequestException(`This number is already a contact (#${existing.id}).`);
    const [row] = await this.dataSource.query(`
      INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name, bot_enabled, manual_mode, created_at, updated_at)
      VALUES ($1, 'whatsapp', $2, $3, FALSE, FALSE, NOW(), NOW()) RETURNING id`, [companyId, phone, dto.name.trim()]);
    const tags = [...new Set((dto.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
    await this.dataSource.query(`
      INSERT INTO crm_contact (bot_channel_user_id, company_id, email, phone, tags, deal_value, owner_user_id, source, stage)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', $8)`,
      [row.id, companyId, dto.email?.trim().toLowerCase() || null, phone, tags, dto.deal_value ?? null, agentId, dto.lead_stage ?? 'new']);
    if (dto.note?.trim()) await this.addNote(user, Number(row.id), { content: dto.note.trim() });
    return this.contact(user, Number(row.id));
  }

  /** Tags / stage / owner for many contacts at once (agents: only their own customers, and no owner changes). */
  async bulk(user: AuthenticatedUser, dto: BulkContactsDto) {
    const companyId = this.companyId(user);
    const agentId = await this.agentOf(user);
    if (agentId && dto.owner_user_id !== undefined) throw new ForbiddenException('Only the admin can change who owns a customer.');
    if (dto.owner_user_id) await this.assertUser(companyId, dto.owner_user_id);
    const rows: Array<{ id: number }> = await this.dataSource.query(`
      SELECT cu.id FROM bot_channel_user cu WHERE cu.company_id = $1 AND cu.id = ANY($2::int[])
         AND ($3::int IS NULL OR ${CrmService.MINE.replace(/\$AGENT/g, '$3')})`, [companyId, [...new Set(dto.ids)], agentId]);
    const ids = rows.map((r) => Number(r.id));
    if (!ids.length) throw new NotFoundException('None of these contacts can be changed.');
    const clean = (list?: string[]) => [...new Set((list ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
    const add = clean(dto.add_tags);
    const remove = clean(dto.remove_tags);
    await this.dataSource.query(`
      INSERT INTO crm_contact (bot_channel_user_id, company_id) SELECT UNNEST($1::int[]), $2 ON CONFLICT (bot_channel_user_id) DO NOTHING`, [ids, companyId]);
    if (add.length || remove.length) {
      await this.dataSource.query(`
        UPDATE crm_contact SET tags = ARRAY(SELECT DISTINCT t FROM UNNEST(tags || $2::text[]) AS t WHERE NOT (t = ANY($3::text[]))), updated_at = NOW()
         WHERE bot_channel_user_id = ANY($1::int[])`, [ids, add, remove]);
    }
    if (dto.owner_user_id !== undefined) {
      await this.dataSource.query(`UPDATE crm_contact SET owner_user_id = $2, updated_at = NOW() WHERE bot_channel_user_id = ANY($1::int[])`, [ids, dto.owner_user_id || null]);
    }
    if (dto.lead_stage) {
      await this.dataSource.query(`UPDATE crm_contact SET stage = $2, updated_at = NOW() WHERE bot_channel_user_id = ANY($1::int[])`, [ids, dto.lead_stage]);
      await this.dataSource.query(`
        UPDATE bot_conversation c SET lead_stage = $2, lead_stage_manual = TRUE FROM (
          SELECT DISTINCT ON (bot_channel_user_id) id FROM bot_conversation WHERE bot_channel_user_id = ANY($1::int[]) ORDER BY bot_channel_user_id, id DESC
        ) last WHERE c.id = last.id`, [ids, dto.lead_stage]);
    }
    return { updated: ids.length, skipped: dto.ids.length - ids.length };
  }

  /** The CRM home: stage funnel with deal values, tasks due, new contacts per day, channels, top customers and tags. */
  async overview(user: AuthenticatedUser) {
    const companyId = this.companyId(user);
    const agentId = await this.agentOf(user);
    const mine = `($2::int IS NULL OR ${CrmService.MINE.replace(/\$AGENT/g, '$2')})`;
    const base = `
      FROM bot_channel_user cu
      LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
      LEFT JOIN LATERAL (SELECT lead_stage, last_message_at FROM bot_conversation c WHERE c.bot_channel_user_id = cu.id ORDER BY c.id DESC LIMIT 1) cv ON TRUE
     WHERE cu.company_id = $1 AND ${mine}`;
    const funnel: Array<Record<string, unknown>> = await this.dataSource.query(`
      SELECT ${STAGE_SQL} AS stage, COUNT(*)::int AS contacts, COALESCE(SUM(cc.deal_value), 0) AS deal_value ${base} GROUP BY 1`, [companyId, agentId]);
    const [totals] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS contacts,
             COUNT(*) FILTER (WHERE cu.created_at > NOW() - INTERVAL '7 days')::int AS new_7d,
             COUNT(*) FILTER (WHERE cu.created_at > NOW() - INTERVAL '30 days')::int AS new_30d,
             COUNT(*) FILTER (WHERE GREATEST(cv.last_message_at, cu.last_seen_at) > NOW() - INTERVAL '7 days')::int AS active_7d,
             COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM bot_order o WHERE o.bot_channel_user_id = cu.id AND o.status::text <> 'Cancelled'))::int AS customers,
             COUNT(*) FILTER (WHERE cc.owner_user_id IS NULL)::int AS without_owner
        ${base}`, [companyId, agentId]);
    const channels: Array<Record<string, unknown>> = await this.dataSource.query(`SELECT cu.platform AS channel, COUNT(*)::int AS contacts ${base} GROUP BY 1 ORDER BY 2 DESC`, [companyId, agentId]);
    const daily: Array<Record<string, unknown>> = await this.dataSource.query(`
      WITH days AS (SELECT generate_series((NOW() AT TIME ZONE 'Asia/Colombo')::date - 29, (NOW() AT TIME ZONE 'Asia/Colombo')::date, INTERVAL '1 day')::date AS day)
      SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
             (SELECT COUNT(*) FROM bot_channel_user cu WHERE cu.company_id = $1 AND ${mine} AND (cu.created_at AT TIME ZONE 'Asia/Colombo')::date = d.day)::int AS contacts
        FROM days d ORDER BY d.day`, [companyId, agentId]);
    const [revenue] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS orders, COALESCE(SUM(o.total_amount), 0) AS revenue
        FROM bot_order o JOIN bot_channel_user cu ON cu.id = o.bot_channel_user_id
       WHERE cu.company_id = $1 AND ${mine} AND o.status::text <> 'Cancelled' AND o.created_at > NOW() - INTERVAL '30 days'`, [companyId, agentId]);
    const top: Array<Record<string, unknown>> = await this.dataSource.query(`
      SELECT cu.id, COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS name, cu.platform AS channel,
             COUNT(o.id)::int AS orders, COALESCE(SUM(o.total_amount), 0) AS total_spent, MAX(o.created_at) AS last_order_at
        FROM bot_channel_user cu JOIN bot_order o ON o.bot_channel_user_id = cu.id AND o.status::text <> 'Cancelled'
       WHERE cu.company_id = $1 AND ${mine}
       GROUP BY cu.id ORDER BY total_spent DESC LIMIT 6`, [companyId, agentId]);
    const tags: Array<Record<string, unknown>> = await this.dataSource.query(`
      SELECT tag, COUNT(*)::int AS n FROM bot_channel_user cu JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id, UNNEST(cc.tags) AS tag
       WHERE cu.company_id = $1 AND ${mine} GROUP BY tag ORDER BY n DESC LIMIT 10`, [companyId, agentId]);
    const taskScope = `t.company_id = $1 AND ($2::int IS NULL OR t.assigned_user_id = $2 OR t.created_by_user_id = $2)`;
    const today = `(NOW() AT TIME ZONE 'Asia/Colombo')::date`;
    const [tasks] = await this.dataSource.query(`
      SELECT COUNT(*) FILTER (WHERE t.status = 'open')::int AS open,
             COUNT(*) FILTER (WHERE t.status = 'open' AND t.due_at < NOW())::int AS overdue,
             COUNT(*) FILTER (WHERE t.status = 'open' AND (t.due_at AT TIME ZONE 'Asia/Colombo')::date = ${today})::int AS today,
             COUNT(*) FILTER (WHERE t.status = 'open' AND (t.due_at AT TIME ZONE 'Asia/Colombo')::date > ${today} AND t.due_at < NOW() + INTERVAL '7 days')::int AS this_week,
             COUNT(*) FILTER (WHERE t.status = 'open' AND t.priority = 'high')::int AS high,
             COUNT(*) FILTER (WHERE t.status = 'done' AND t.done_at > NOW() - INTERVAL '7 days')::int AS done_7d
        FROM crm_task t WHERE ${taskScope}`, [companyId, agentId]);
    const upcoming = await this.dataSource.query(`
      SELECT t.id, t.title, t.due_at, t.priority, t.kind, t.bot_channel_user_id, u.name AS assigned_name,
             COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS contact_name
        FROM crm_task t LEFT JOIN app_user u ON u.id = t.assigned_user_id LEFT JOIN bot_channel_user cu ON cu.id = t.bot_channel_user_id
       WHERE ${taskScope} AND t.status = 'open'
       ORDER BY t.due_at NULLS LAST, (t.priority = 'high') DESC, t.id LIMIT 8`, [companyId, agentId]);
    const byStage = new Map(funnel.map((row) => [String(row.stage), row]));
    return {
      totals: { ...totals, orders_30d: num(revenue?.orders), revenue_30d: num(revenue?.revenue) },
      funnel: LEAD_STAGES.map((stage) => ({ stage, contacts: num(byStage.get(stage)?.contacts), deal_value: num(byStage.get(stage)?.deal_value) })),
      pipeline_value: funnel.filter((row) => !['won', 'lost'].includes(String(row.stage))).reduce((sum, row) => sum + num(row.deal_value), 0),
      won_value: num(byStage.get('won')?.deal_value),
      channels, daily, tags,
      top_customers: top.map((row) => ({ ...row, total_spent: num(row.total_spent) })),
      tasks: { ...tasks, upcoming },
    };
  }

  /** Kanban: contacts per stage with deal values (the newest 60 per stage). */
  async pipeline(user: AuthenticatedUser, query: PipelineQueryDto) {
    const companyId = this.companyId(user);
    const agentId = await this.agentOf(user);
    const search = String(query.search ?? '').trim().toLowerCase();
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(`
      WITH base AS (
        SELECT cu.id, COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS name, cu.platform AS channel, cu.external_user_id,
               ${STAGE_SQL} AS stage, cc.deal_value, COALESCE(cc.tags, '{}') AS tags, cc.owner_user_id, ow.name AS owner_name,
               cv.id AS conversation_id, GREATEST(cv.last_message_at, cu.last_seen_at) AS last_activity,
               (SELECT COUNT(*) FROM crm_task t WHERE t.bot_channel_user_id = cu.id AND t.status = 'open')::int AS open_tasks,
               (SELECT COALESCE(SUM(total_amount), 0) FROM bot_order o WHERE o.bot_channel_user_id = cu.id AND o.status::text <> 'Cancelled') AS total_spent
          FROM bot_channel_user cu
          LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
          LEFT JOIN LATERAL (SELECT * FROM bot_conversation c WHERE c.bot_channel_user_id = cu.id ORDER BY c.id DESC LIMIT 1) cv ON TRUE
          LEFT JOIN app_user ow ON ow.id = cc.owner_user_id
         WHERE cu.company_id = $1 AND ($2::int IS NULL OR ${CrmService.MINE.replace(/\$AGENT/g, '$2')})
           AND ($3 = '' OR LOWER(COALESCE(cu.display_name, '')) LIKE '%' || $3 || '%' OR cu.external_user_id LIKE '%' || $3 || '%')
           AND ($4::int IS NULL OR ($4 = 0 AND cc.owner_user_id IS NULL) OR cc.owner_user_id = $4)
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY stage ORDER BY last_activity DESC NULLS LAST, id DESC) AS rn,
               COUNT(*) OVER (PARTITION BY stage) AS stage_count, SUM(COALESCE(deal_value, 0)) OVER (PARTITION BY stage) AS stage_value
          FROM base
      )
      SELECT * FROM ranked WHERE rn <= 60`, [companyId, agentId, search, query.owner ?? null]);
    return LEAD_STAGES.map((stage) => {
      const cards = rows.filter((row) => row.stage === stage);
      return {
        stage, count: num(cards[0]?.stage_count), value: num(cards[0]?.stage_value),
        contacts: cards.map(({ rn: _rn, stage_count: _c, stage_value: _v, ...row }) => ({ ...row, deal_value: row.deal_value == null ? null : num(row.deal_value), total_spent: num(row.total_spent) })),
      };
    });
  }

  /* ───── Tasks ───── */

  async tasks(user: AuthenticatedUser, query: TasksQueryDto) {
    const companyId = this.companyId(user);
    const today = `(NOW() AT TIME ZONE 'Asia/Colombo')::date`;
    const due = {
      overdue: `t.due_at < NOW()`,
      today: `(t.due_at AT TIME ZONE 'Asia/Colombo')::date = ${today}`,
      week: `t.due_at >= NOW() AND t.due_at < NOW() + INTERVAL '7 days'`,
      later: `t.due_at >= NOW() + INTERVAL '7 days'`,
      none: `t.due_at IS NULL`,
    }[query.due ?? ''] ?? 'TRUE';
    return this.dataSource.query(`
      SELECT t.*, u.name AS assigned_name, cb.name AS created_by_name, COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS contact_name,
             cu.platform AS contact_channel
        FROM crm_task t LEFT JOIN app_user u ON u.id = t.assigned_user_id LEFT JOIN app_user cb ON cb.id = t.created_by_user_id
        LEFT JOIN bot_channel_user cu ON cu.id = t.bot_channel_user_id
       WHERE t.company_id = $1
         AND ($2 = 'all' OR t.status = $2)
         AND ($3 <> 'mine' OR t.assigned_user_id = $4)
         AND ($3 <> 'created' OR t.created_by_user_id = $4)
         AND ($5::int IS NULL OR t.bot_channel_user_id = $5)
         AND ($6::int IS NULL OR t.assigned_user_id = $6 OR t.created_by_user_id = $6 OR (cu.id IS NOT NULL AND ${CrmService.MINE.replace(/\$AGENT/g, '$6')}))
         AND ($7::text IS NULL OR t.priority = $7)
         AND ($8 = '' OR LOWER(t.title) LIKE '%' || $8 || '%' OR LOWER(t.notes) LIKE '%' || $8 || '%' OR LOWER(COALESCE(cu.display_name, '')) LIKE '%' || $8 || '%')
         AND ${due}
       ORDER BY (t.status = 'done'), t.due_at NULLS LAST, CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.id DESC LIMIT 500`,
      [companyId, query.status ?? 'open', query.scope ?? 'all', user.id, query.contact_id ?? null, await this.agentOf(user),
        query.priority ?? null, String(query.search ?? '').trim().toLowerCase()]);
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
    if (dto.contact_id) await this.assertContact(companyId, dto.contact_id, await this.agentOf(user));
    await this.assertUser(companyId, dto.assigned_user_id);
    const [row] = await this.dataSource.query(`
      INSERT INTO crm_task (company_id, bot_channel_user_id, title, notes, due_at, assigned_user_id, created_by_user_id, priority, kind)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [companyId, dto.contact_id ?? null, dto.title.trim(), dto.notes?.trim() ?? '', this.dueDate(dto.due_at) ?? null, dto.assigned_user_id ?? user.id, user.id,
        dto.priority ?? 'normal', dto.kind ?? 'follow_up']);
    return row;
  }

  /** The task, if this user may change it (admin: all; agent: assigned to / made by them, or about their customer). */
  private async ownTask(user: AuthenticatedUser, id: number) {
    const companyId = this.companyId(user);
    const [task] = await this.dataSource.query(`SELECT * FROM crm_task WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (!task) throw new NotFoundException('Task not found.');
    const agentId = await this.agentOf(user);
    if (agentId && Number(task.assigned_user_id) !== agentId && Number(task.created_by_user_id) !== agentId) {
      if (!task.bot_channel_user_id) throw new NotFoundException('Task not found.');
      await this.assertContact(companyId, Number(task.bot_channel_user_id), agentId);
    }
    return { task, companyId, agentId };
  }

  async updateTask(user: AuthenticatedUser, id: number, dto: UpdateTaskDto) {
    const { task, companyId, agentId } = await this.ownTask(user, id);
    // only the person who made the task (and the admin / supervisors) change it; anyone else who sees it can only mark it done / open
    if (agentId && Number(task.created_by_user_id) !== agentId) {
      const other = Object.entries(dto).some(([key, value]) => key !== 'status' && value !== undefined);
      if (other) throw new ForbiddenException('Only the person who added this task or the admin can change it. You can mark it done.');
    }
    await this.assertUser(companyId, dto.assigned_user_id);
    if (dto.contact_id) await this.assertContact(companyId, dto.contact_id, agentId);
    if (dto.priority !== undefined || dto.kind !== undefined || dto.contact_id !== undefined) {
      await this.dataSource.query(`
        UPDATE crm_task SET priority = COALESCE($2, priority), kind = COALESCE($3, kind),
               bot_channel_user_id = CASE WHEN $4::boolean THEN $5::int ELSE bot_channel_user_id END WHERE id = $1`,
        [id, dto.priority ?? null, dto.kind ?? null, dto.contact_id !== undefined, dto.contact_id || null]);
    }
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

  async deleteTask(user: AuthenticatedUser, id: number) {
    const { task, agentId } = await this.ownTask(user, id);
    if (agentId && Number(task.created_by_user_id) !== agentId) throw new ForbiddenException('Only the admin or the person who made the task can delete it.');
    await this.dataSource.query(`DELETE FROM crm_task WHERE id = $1`, [id]);
    return { id, deleted: true };
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

  /* ───── Import with a preview (like products): read the file → match columns → import the rows ───── */

  /** CSV or Excel → header + rows (strings), for the preview. */
  readImportFile(file?: { buffer: Buffer; originalname?: string }) {
    if (!file?.buffer?.length) throw new BadRequestException('Choose a CSV or Excel file.');
    let table: string[][];
    try {
      const book = XLSX.read(file.buffer, { type: 'buffer', raw: false, codepage: 65001 });
      const sheet = book.Sheets[book.SheetNames[0]];
      table = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: false })
        .map((row) => row.map((cell) => String(cell ?? '').trim()));
    } catch {
      throw new BadRequestException('This file could not be read. Use a CSV or an Excel (.xlsx) file.');
    }
    table = table.filter((row) => row.some(Boolean));
    if (table.length < 2) throw new BadRequestException('The file has no rows under the header.');
    const headers = table[0].map((h, i) => h || `Column ${i + 1}`);
    if (table.length - 1 > 5000) throw new BadRequestException('Up to 5,000 contacts per file. Split the file and import the parts.');
    return { headers, rows: table.slice(1).map((row) => headers.map((_, i) => row[i] ?? '')) };
  }

  /** Sample file with the columns the import understands. */
  importTemplate() {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['name', 'phone', 'email', 'tags', 'stage', 'deal_value', 'note'],
      ['Nimal Perera', '0771234567', 'nimal@example.com', 'vip; colombo', 'contacted', '15000', 'Asked about school shoes'],
      ['Kamala Silva', '0712345678', '', 'wholesale', 'new', '', ''],
    ]);
    sheet['!cols'] = [18, 14, 24, 18, 12, 12, 30].map((wch) => ({ wch }));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Contacts');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  /** The rows from the preview. Existing numbers are updated (name, email; tags added; stage / deal value when given). */
  async importRows(user: AuthenticatedUser, dto: ImportRowsDto) {
    const companyId = this.companyId(user);
    const agentId = await this.agentOf(user);
    const [me] = await this.dataSource.query(`SELECT name FROM app_user WHERE id = $1`, [user.id]);
    let created = 0;
    let updated = 0;
    const skipped: Array<{ row: number; reason: string }> = [];
    const seen = new Set<string>();
    for (const [index, raw] of dto.rows.entries()) {
      const rowNo = index + 1;
      const phone = lkPhone(raw.phone);
      if (!phone) { skipped.push({ row: rowNo, reason: 'Not a phone number' }); continue; }
      if (seen.has(phone)) { skipped.push({ row: rowNo, reason: 'Same number as an earlier row' }); continue; }
      seen.add(phone);
      const email = String(raw.email ?? '').trim().toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped.push({ row: rowNo, reason: 'Email is not valid' }); continue; }
      const stage = String(raw.stage ?? '').trim().toLowerCase();
      if (stage && !(LEAD_STAGES as readonly string[]).includes(stage)) { skipped.push({ row: rowNo, reason: `Stage must be one of: ${LEAD_STAGES.join(', ')}` }); continue; }
      const dealText = String(raw.deal_value ?? '').replace(/[^\d.]/g, '');
      const deal = dealText ? Number(dealText) : null;
      if (deal !== null && (!Number.isFinite(deal) || deal > 999_999_999_999)) { skipped.push({ row: rowNo, reason: 'Deal value is not a number' }); continue; }
      const name = String(raw.name ?? '').trim().slice(0, 255);
      const tags = [...new Set(String(raw.tags ?? '').split(/[;|,]/).map((t) => t.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20);
      let [row] = await this.dataSource.query(
        `SELECT id FROM bot_channel_user WHERE company_id = $1 AND platform = 'whatsapp' AND regexp_replace(external_user_id, '\\D', '', 'g') IN ($2, $3) ORDER BY id LIMIT 1`,
        [companyId, phone, `0${phone.slice(2)}`]);
      if (row && agentId) {
        // an agent updates only their own customers
        const [mine] = await this.dataSource.query(`SELECT 1 FROM bot_channel_user cu WHERE cu.id = $1 AND ${CrmService.MINE.replace(/\$AGENT/g, '$2')}`, [row.id, agentId]);
        if (!mine) { skipped.push({ row: rowNo, reason: 'This customer belongs to another agent' }); continue; }
      }
      if (!row) {
        [row] = await this.dataSource.query(`
          INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name, bot_enabled, manual_mode, created_at, updated_at)
          VALUES ($1, 'whatsapp', $2, $3, FALSE, FALSE, NOW(), NOW()) RETURNING id`, [companyId, phone, name || phone]);
        created += 1;
      } else {
        if (name) await this.dataSource.query(`UPDATE bot_channel_user SET display_name = $2 WHERE id = $1`, [row.id, name]);
        updated += 1;
      }
      await this.dataSource.query(`
        INSERT INTO crm_contact (bot_channel_user_id, company_id, email, phone, tags, source, stage, deal_value, owner_user_id) VALUES ($1, $2, $3, $4, $5, 'import', $6, $7, $8)
        ON CONFLICT (bot_channel_user_id) DO UPDATE SET email = COALESCE(EXCLUDED.email, crm_contact.email),
          tags = (SELECT ARRAY(SELECT DISTINCT UNNEST(crm_contact.tags || EXCLUDED.tags))),
          stage = COALESCE($9::text, crm_contact.stage), deal_value = COALESCE($7, crm_contact.deal_value), updated_at = NOW()`,
        [row.id, companyId, email || null, phone, tags, stage || 'new', deal, agentId, stage || null]);
      const note = String(raw.note ?? '').trim();
      if (note) {
        await this.dataSource.query(
          `INSERT INTO bot_customer_note (company_id, bot_channel_user_id, content, created_by_user_id, created_by_name) VALUES ($1, $2, $3, $4, $5)`,
          [companyId, row.id, note.slice(0, 2000), user.id, me?.name ?? 'Team']);
      }
    }
    return { created, updated, skipped };
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
  @ManagerOnly()
  async export(@CurrentUser() user: AuthenticatedUser, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(await this.crm.exportCsv(user));
  }

  @Post('contacts/import/read')
  @ManagerOnly()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  readImport(@UploadedFile() file?: { buffer: Buffer; originalname?: string }) { return this.crm.readImportFile(file); }

  @Post('contacts/import/rows')
  @ManagerOnly()
  importRows(@CurrentUser() user: AuthenticatedUser, @Body() dto: ImportRowsDto) { return this.crm.importRows(user, dto); }

  @Get('contacts/import/template')
  @ManagerOnly()
  template(@Res() res: Response) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts-sample.xlsx"');
    res.send(this.crm.importTemplate());
  }

  @Post('contacts/import')
  @ManagerOnly()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  import(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file?: { buffer: Buffer }) { return this.crm.importCsv(user, file); }

  @Get('overview')
  overview(@CurrentUser() user: AuthenticatedUser) { return this.crm.overview(user); }

  @Get('pipeline')
  pipeline(@CurrentUser() user: AuthenticatedUser, @Query() query: PipelineQueryDto) { return this.crm.pipeline(user, query); }

  @Post('contacts')
  createContact(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateContactDto) { return this.crm.createContact(user, dto); }

  @Post('contacts/bulk')
  bulk(@CurrentUser() user: AuthenticatedUser, @Body() dto: BulkContactsDto) { return this.crm.bulk(user, dto); }

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

  @Delete('tasks/:id')
  deleteTask(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.crm.deleteTask(user, id); }

  @Get('team')
  team(@CurrentUser() user: AuthenticatedUser) { return this.crm.team(user); }
}

@Module({ imports: [AuthModule], controllers: [CrmController, CustomerInsightsController], providers: [CrmService, CustomerInsightsService] })
export class CrmModule {}
