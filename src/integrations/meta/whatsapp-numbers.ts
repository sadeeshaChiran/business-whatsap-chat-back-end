import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Logger, NotFoundException, Optional, Param, ParseIntPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { DataSource } from 'typeorm';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AdminOnly } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { PlanService } from '../../platform/plan.service';
import type { WhatsappChannel } from '../../whatsapp/entities/whatsapp-channel.entity';
import { WhatsappChannelService } from '../../whatsapp/whatsapp-channel.service';
import { MetaGraphService } from './meta-graph.service';
import { buildMetaOAuthState } from './meta-oauth-state.util';

/** What a number is for – shown in the inbox and told to the AI bot. */
export const NUMBER_PURPOSES = ['sales', 'support', 'wholesale', 'ads', 'delivery', 'bookings', 'other'] as const;

export class WhatsappNumberUpdateDto {
  @IsOptional() @IsString() @MaxLength(40) label?: string | null;
  @IsOptional() @IsIn([...NUMBER_PURPOSES]) purpose?: string | null;
  @IsOptional() @IsString() @MaxLength(600) bot_note?: string | null;
  @IsOptional() @IsBoolean() bot_enabled?: boolean;
  /** true = make this the main number */
  @IsOptional() @IsBoolean() is_primary?: boolean;
}

export class WhatsappNumberAddDto {
  @IsOptional() @IsString() @MaxLength(40) label?: string;
  @IsOptional() @IsIn([...NUMBER_PURPOSES]) purpose?: string;
}

export class WhatsappNumberStatsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number;
}

const num = (value: unknown) => Number(value ?? 0) || 0;

/**
 * Several WhatsApp numbers per company (sales, support, wholesale …). Each number is a whatsapp_channels row; the main
 * number is the one the company had before. Customers are answered from the number they wrote to.
 */
@Injectable()
export class WhatsappNumbersService {
  private readonly logger = new Logger(WhatsappNumbersService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly channels: WhatsappChannelService,
    private readonly metaGraph: MetaGraphService,
    @Optional() private readonly planService?: PlanService,
  ) {}

  private async assertOwner(user: AuthenticatedUser) {
    const [company] = await this.dataSource.query(`SELECT id, admin_user_id FROM companies WHERE id = $1`, [user.company_id]);
    if (!company || Number(company.admin_user_id) !== Number(user.id)) throw new ForbiddenException('Only the company owner can manage WhatsApp numbers.');
  }

  /** How many numbers the package allows (null = no limit). */
  private async maxNumbers(companyId: number): Promise<number | null> {
    if (!this.planService) return null;
    const limits = await this.planService.limitsForCompany(companyId).catch(() => null);
    const value = limits?.numbers?.whatsapp_numbers;
    return value === undefined ? null : value;
  }

  /** Fills the shown phone / business name of numbers connected before these columns existed (once). */
  private async fillIdentity(channel: WhatsappChannel): Promise<WhatsappChannel> {
    if (channel.display_phone || channel.provider_type !== 'meta' || !channel.meta_phone_number_id?.trim() || !channel.meta_access_token?.trim()) return channel;
    try {
      const phone = await this.metaGraph.fetchWhatsappPhoneNumber(channel.meta_phone_number_id.trim(), channel.meta_access_token.trim());
      await this.dataSource.query(`UPDATE whatsapp_channels SET display_phone = $2, verified_name = COALESCE(verified_name, $3) WHERE id = $1`,
        [channel.id, phone.display_phone_number || null, phone.verified_name || null]);
      return { ...channel, display_phone: phone.display_phone_number || null, verified_name: channel.verified_name ?? (phone.verified_name || null) };
    } catch (error) {
      this.logger.warn(`number ${channel.id}: could not read the phone from Meta (${error instanceof Error ? error.message : String(error)})`);
      return channel;
    }
  }

  async list(user: AuthenticatedUser, query: WhatsappNumberStatsDto = {}) {
    await this.assertOwner(user);
    const companyId = Number(user.company_id);
    const days = query.days ?? 30;
    const rows = await Promise.all((await this.channels.listForCompany(companyId)).map((channel) => this.fillIdentity(channel)));
    const ids = rows.map((row) => Number(row.id));
    const stats = new Map<number, Record<string, number>>();
    if (ids.length) {
      const [customers, chats, orders] = await Promise.all([
        this.dataSource.query(
          `SELECT first_whatsapp_channel_id AS id, COUNT(*)::int AS customers,
                  COUNT(*) FILTER (WHERE created_at > NOW() - make_interval(days => $2))::int AS new_customers
             FROM bot_channel_user WHERE company_id = $1 AND platform = 'whatsapp' AND first_whatsapp_channel_id IS NOT NULL
            GROUP BY 1`, [companyId, days]),
        this.dataSource.query(
          `SELECT m.whatsapp_channel_id AS id, COUNT(DISTINCT m.conversation_id)::int AS chats, COUNT(*)::int AS messages
             FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
            WHERE cu.company_id = $1 AND m.whatsapp_channel_id IS NOT NULL AND m.created_at > NOW() - make_interval(days => $2)
            GROUP BY 1`, [companyId, days]),
        this.dataSource.query(
          `SELECT whatsapp_channel_id AS id, COUNT(*)::int AS orders, COALESCE(SUM(total_amount), 0)::float AS sales
             FROM bot_order WHERE company_id = $1 AND whatsapp_channel_id IS NOT NULL AND status::text <> 'Cancelled'
              AND created_at > NOW() - make_interval(days => $2)
            GROUP BY 1`, [companyId, days]),
      ]);
      for (const list of [customers, chats, orders] as Array<Array<Record<string, unknown>>>) {
        for (const row of list) {
          const id = num(row.id);
          const current = stats.get(id) ?? {};
          for (const [key, value] of Object.entries(row)) if (key !== 'id') current[key] = num(value);
          stats.set(id, current);
        }
      }
    }
    const max = await this.maxNumbers(companyId);
    return {
      days,
      max_numbers: max,
      can_add: max === null || rows.length < max,
      purposes: NUMBER_PURPOSES,
      numbers: rows.map((row) => {
        const s = stats.get(Number(row.id)) ?? {};
        return {
          id: Number(row.id),
          label: row.label ?? null,
          purpose: row.purpose ?? null,
          bot_note: row.bot_note ?? null,
          bot_enabled: row.bot_enabled !== false,
          is_primary: rows.length === 1 ? true : Boolean(row.is_primary),
          display_phone: row.display_phone ?? null,
          verified_name: row.verified_name ?? null,
          status: row.status ?? null,
          connected: String(row.status ?? '').toUpperCase() === 'CONNECTED' && Boolean(row.meta_phone_number_id),
          last_used_at: row.last_used_at ?? null,
          created_at: row.created_at ?? null,
          stats: {
            customers: s.customers ?? 0, new_customers: s.new_customers ?? 0, chats: s.chats ?? 0, messages: s.messages ?? 0,
            orders: s.orders ?? 0, sales: Math.round(s.sales ?? 0),
          },
        };
      }),
    };
  }

  /** Names of the numbers for the inbox badge (every team member; empty when the company has one number). */
  async labels(user: AuthenticatedUser) {
    const rows = (await this.dataSource.query(
      `SELECT id, label, purpose, display_phone, is_primary FROM whatsapp_channels WHERE company_id = $1 ORDER BY is_primary DESC, id ASC`,
      [user.company_id])) as Array<{ id: number; label: string | null; purpose: string | null; display_phone: string | null; is_primary: boolean }>;
    if (rows.length < 2) return [];
    return rows.map((row) => ({ id: Number(row.id), label: row.label, purpose: row.purpose, display_phone: row.display_phone, is_primary: Boolean(row.is_primary) }));
  }

  private async own(companyId: number, id: number) {
    const [row] = await this.dataSource.query(`SELECT id, is_primary FROM whatsapp_channels WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (!row) throw new NotFoundException('WhatsApp number not found.');
    return row as { id: number; is_primary: boolean };
  }

  async update(user: AuthenticatedUser, id: number, body: WhatsappNumberUpdateDto) {
    await this.assertOwner(user);
    const companyId = Number(user.company_id);
    await this.own(companyId, id);
    const sets: string[] = [];
    const params: unknown[] = [id, companyId];
    const put = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`); };
    if (body.label !== undefined) put('label', body.label?.trim() || null);
    if (body.purpose !== undefined) put('purpose', body.purpose || null);
    if (body.bot_note !== undefined) put('bot_note', body.bot_note?.trim() || null);
    if (body.bot_enabled !== undefined) put('bot_enabled', body.bot_enabled);
    await this.dataSource.transaction(async (manager) => {
      if (sets.length) await manager.query(`UPDATE whatsapp_channels SET ${sets.join(', ')} WHERE id = $1 AND company_id = $2`, params);
      if (body.is_primary === true) {
        await manager.query(`UPDATE whatsapp_channels SET is_primary = (id = $1) WHERE company_id = $2`, [id, companyId]);
      }
    });
    return this.list(user);
  }

  /** Disconnects an extra number. Its customers are answered from the main number from now on; chats and orders stay. */
  async remove(user: AuthenticatedUser, id: number) {
    await this.assertOwner(user);
    const companyId = Number(user.company_id);
    const row = await this.own(companyId, id);
    const [{ count }] = await this.dataSource.query(`SELECT COUNT(*)::int AS count FROM whatsapp_channels WHERE company_id = $1`, [companyId]);
    if (row.is_primary || num(count) <= 1)
      throw new BadRequestException('This is your main number. Make another number the main one first, or change the number on this page.');
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE bot_channel_user SET whatsapp_channel_id = NULL WHERE company_id = $1 AND whatsapp_channel_id = $2`, [companyId, id]);
      await manager.query(`DELETE FROM whatsapp_channels WHERE id = $1 AND company_id = $2`, [id, companyId]);
    });
    return this.list(user);
  }

  /** Meta login link that ADDS a number (the main number keeps working). */
  async addUrl(user: AuthenticatedUser, body: WhatsappNumberAddDto) {
    await this.assertOwner(user);
    const companyId = Number(user.company_id);
    const max = await this.maxNumbers(companyId);
    const count = (await this.channels.listForCompany(companyId)).length;
    if (count === 0) throw new BadRequestException('Connect your main WhatsApp number first.');
    if (max !== null && count >= max)
      throw new ForbiddenException(`Your package allows ${max} WhatsApp number${max === 1 ? '' : 's'}. Upgrade in Billing to add more.`);
    const state = buildMetaOAuthState(companyId, Number(user.id), '/channels/whatsapp', true, { label: body.label, purpose: body.purpose });
    return { url: this.metaGraph.buildWhatsappAuthUrl(state) };
  }
}

@Controller('whatsapp-numbers')
@ApiTags('WhatsApp numbers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class WhatsappNumbersController {
  constructor(private readonly numbers: WhatsappNumbersService) {}

  @Get()
  @AdminOnly()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: WhatsappNumberStatsDto) {
    return this.numbers.list(user, query);
  }

  @Get('labels')
  labels(@CurrentUser() user: AuthenticatedUser) {
    return this.numbers.labels(user);
  }

  @Get('add-url')
  @AdminOnly()
  addUrl(@CurrentUser() user: AuthenticatedUser, @Query() query: WhatsappNumberAddDto) {
    return this.numbers.addUrl(user, query);
  }

  @Patch(':id')
  @AdminOnly()
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() body: WhatsappNumberUpdateDto) {
    return this.numbers.update(user, id, body);
  }

  @Delete(':id')
  @AdminOnly()
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) {
    return this.numbers.remove(user, id);
  }
}
