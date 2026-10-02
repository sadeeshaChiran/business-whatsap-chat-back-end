import { FeatureGuard, RequiresFeature } from '../platform/feature.guard';
import {
  Body, Controller, Delete, Get, Injectable, Logger, Module, NotFoundException, OnModuleDestroy, OnModuleInit, Param, ParseIntPipe, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { createSign } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/* ───────── DTOs ───────── */

export class InboxQueryDto {
  @IsOptional() @IsIn(['all', 'mine', 'waiting', 'bot']) filter?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  /** only chats with this tag (bot_customer_label id) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) label_id?: number;
}

export class MessagesQueryDto {
  /** load older messages: ids smaller than this */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) before_id?: number;
}

export class DeviceDto {
  @IsString() @MinLength(20) @MaxLength(512) token: string;
  @IsOptional() @IsIn(['android', 'ios']) platform?: 'android' | 'ios';
}

/* ───────── Push (Firebase Cloud Messaging HTTP v1) ───────── */

/**
 * FCM_SERVICE_ACCOUNT_JSON = the Firebase service account JSON (one line) – Project settings → Service accounts.
 * Pushes: new customer messages (assigned agent, else the admin) and alerts from bot_notification (admins).
 * Polls every 10 s, so it works for every channel without hooks.
 */
@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private token: { value: string; expires: number } | null = null;
  private account: { project_id: string; client_email: string; private_key: string } | null = null;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  onModuleInit() {
    try {
      const raw = String(process.env.FCM_SERVICE_ACCOUNT_JSON ?? '').trim();
      if (raw) this.account = JSON.parse(raw);
    } catch {
      this.logger.error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON – push notifications are off.');
    }
    if (this.account) {
      this.timer = setInterval(() => void this.tick(), 10_000);
      this.logger.log(`Push notifications on (Firebase project ${this.account.project_id}).`);
    }
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async accessToken(): Promise<string | null> {
    if (!this.account) return null;
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key).toString('base64url');
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const payload = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) { this.logger.warn('Firebase did not give an access token.'); return null; }
    this.token = { value: payload.access_token, expires: Date.now() + (payload.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** Sends to every device of these users. Invalid tokens are removed. */
  async sendToUsers(userIds: number[], title: string, body: string, data: Record<string, string>) {
    if (!this.account || !userIds.length) return;
    const devices: Array<{ token: string }> = await this.dataSource.query(`SELECT token FROM push_device WHERE user_id = ANY($1)`, [userIds]);
    const access = devices.length ? await this.accessToken() : null;
    if (!access) return;
    for (const device of devices) {
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`, {
        method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: {
          token: device.token, notification: { title: title.slice(0, 120), body: body.slice(0, 240) }, data,
          android: { priority: 'HIGH', notification: { channel_id: 'chats', sound: 'default' } },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        } }),
        signal: AbortSignal.timeout(15000),
      }).catch(() => null);
      if (response && (response.status === 404 || response.status === 400)) {
        const text = await response.text().catch(() => '');
        if (/UNREGISTERED|INVALID_ARGUMENT/.test(text)) await this.dataSource.query(`DELETE FROM push_device WHERE token = $1`, [device.token]);
      }
    }
  }

  private async cursor(name: string, fallbackSql: string): Promise<number> {
    const [row] = await this.dataSource.query(`SELECT last_id FROM push_cursor WHERE name = $1`, [name]);
    if (row) return Number(row.last_id);
    const [start] = await this.dataSource.query(fallbackSql); // start from "now" – never push old history
    const id = Number(start?.id ?? 0);
    await this.dataSource.query(`INSERT INTO push_cursor (name, last_id) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [name, id]);
    return id;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // 1) new customer messages
      const lastMessage = await this.cursor('messages', `SELECT COALESCE(MAX(id), 0) AS id FROM bot_message`);
      const messages = await this.dataSource.query(`
        SELECT m.id, m.conversation_id, m.content, m.message_type::text AS type, c.assigned_agent_id, cu.company_id,
               COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS name, cu.platform, co.admin_user_id
          FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
          LEFT JOIN companies co ON co.id = cu.company_id
         WHERE m.id > $1 AND m.direction::text = 'inbound' ORDER BY m.id LIMIT 200`, [lastMessage]);
      for (const m of messages) {
        const to = [m.assigned_agent_id ?? m.admin_user_id].filter(Boolean).map(Number);
        const text = m.type === 'image' ? '📷 Photo' : m.type === 'voice' ? '🎤 Voice note' : String(m.content ?? '');
        await this.sendToUsers(to, `${m.name} · ${m.platform}`, text, { type: 'message', conversation_id: String(m.conversation_id) });
      }
      if (messages.length) await this.dataSource.query(`UPDATE push_cursor SET last_id = $2 WHERE name = $1`, ['messages', messages[messages.length - 1].id]);

      // 2) alerts (orders, handoffs, cancellation requests, credits, announcements …)
      const lastAlert = await this.cursor('alerts', `SELECT COALESCE(MAX(id), 0) AS id FROM bot_notification`);
      const alerts = await this.dataSource.query(`
        SELECT n.id, n.title, n.message, n.kind, n.conversation_id, n.order_id, co.admin_user_id
          FROM bot_notification n LEFT JOIN companies co ON co.id = n.company_id
         WHERE n.id > $1 AND n.priority IN ('MEDIUM', 'HIGH') ORDER BY n.id LIMIT 200`, [lastAlert]);
      for (const alert of alerts) {
        if (!alert.admin_user_id) continue;
        await this.sendToUsers([Number(alert.admin_user_id)], alert.title, alert.message, {
          type: alert.kind, conversation_id: String(alert.conversation_id ?? ''), order_id: String(alert.order_id ?? ''),
        });
      }
      if (alerts.length) await this.dataSource.query(`UPDATE push_cursor SET last_id = $2 WHERE name = $1`, ['alerts', alerts[alerts.length - 1].id]);
    } catch (error) {
      this.logger.warn(`push tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}

/* ───────── Mobile API ───────── */

@Injectable()
export class MobileService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private async role(user: AuthenticatedUser) {
    const [row] = await this.dataSource.query(`SELECT admin_user_id FROM companies WHERE id = $1`, [user.company_id]);
    return Number(row?.admin_user_id) === Number(user.id) ? 'admin' : 'agent';
  }

  /** Chat list: admins see every chat, agents see the chats assigned to them. */
  async inbox(user: AuthenticatedUser, query: InboxQueryDto) {
    const isAdmin = (await this.role(user)) === 'admin';
    const filter = query.filter ?? (isAdmin ? 'all' : 'mine');
    const page = Math.max(1, Number(query.page) || 1);
    const search = String(query.search ?? '').trim().toLowerCase();
    const rows = await this.dataSource.query(`
      SELECT c.id AS conversation_id, cu.id AS contact_id, COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS name,
             cu.platform AS channel, cu.external_user_id, cu.bot_enabled, c.status, c.assigned_agent_id, u.name AS assigned_agent_name,
             c.lead_stage, c.last_message_at,
             lm.content AS last_message, lm.message_type::text AS last_type, lm.direction::text AS last_direction,
             lm.delivery_status AS last_status,
             COALESCE((SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color_code', l.color_code) ORDER BY l.name)
                         FROM bot_conversation_label cl JOIN bot_customer_label l ON l.id = cl.label_id
                        WHERE cl.conversation_id = c.id), '[]'::json) AS labels,
             (SELECT COUNT(*) FROM bot_message x WHERE x.conversation_id = c.id AND x.direction::text = 'inbound'
                AND x.created_at > COALESCE(c.agent_last_read_at, 'epoch'))::int AS unread
        FROM bot_conversation c
        JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
        LEFT JOIN app_user u ON u.id = c.assigned_agent_id
        LEFT JOIN LATERAL (SELECT content, message_type, direction, delivery_status FROM bot_message m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) lm ON TRUE
       WHERE cu.company_id = $1 AND c.status <> 'closed'
         AND ($2::boolean OR c.assigned_agent_id = $3)
         AND ($4 <> 'mine' OR c.assigned_agent_id = $3)
         AND ($4 <> 'waiting' OR c.status IN ('open', 'pending'))
         AND ($4 <> 'bot' OR cu.bot_enabled = TRUE)
         AND ($5 = '' OR LOWER(COALESCE(cu.display_name, '')) LIKE '%' || $5 || '%' OR cu.external_user_id LIKE '%' || $5 || '%')
         AND ($6::int IS NULL OR EXISTS (SELECT 1 FROM bot_conversation_label cl WHERE cl.conversation_id = c.id AND cl.label_id = $6))
       ORDER BY c.last_message_at DESC NULLS LAST
       LIMIT 40 OFFSET ${(page - 1) * 40}`,
      [user.company_id, isAdmin, user.id, filter, search, query.label_id ?? null]);
    return { role: isAdmin ? 'admin' : 'agent', page, conversations: rows };
  }

  private async assertAccess(user: AuthenticatedUser, conversationId: number) {
    const [row] = await this.dataSource.query(`
      SELECT c.id, c.status, c.assigned_agent_id, c.lead_stage, cu.id AS contact_id, cu.bot_enabled, cu.platform AS channel, cu.external_user_id,
             COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS name, u.name AS assigned_agent_name
        FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id LEFT JOIN app_user u ON u.id = c.assigned_agent_id
       WHERE c.id = $1 AND cu.company_id = $2`, [conversationId, user.company_id]);
    if (!row) throw new NotFoundException('Chat not found.');
    if ((await this.role(user)) !== 'admin' && Number(row.assigned_agent_id) !== Number(user.id) && row.assigned_agent_id != null) {
      throw new NotFoundException('Chat not found.');
    }
    return row;
  }

  async messages(user: AuthenticatedUser, conversationId: number, query: MessagesQueryDto) {
    const conversation = await this.assertAccess(user, conversationId);
    const rows = await this.dataSource.query(`
      SELECT id, direction::text AS direction, message_type::text AS type, content, transcript, source, delivery_status, created_at,
             (media_url IS NOT NULL AND media_url <> '') AS has_media
        FROM bot_message WHERE conversation_id = $1 AND ($2::int IS NULL OR id < $2)
       ORDER BY id DESC LIMIT 50`, [conversationId, query.before_id ?? null]);
    return {
      conversation, has_more: rows.length === 50,
      messages: rows.reverse().map((m: Record<string, unknown>) => ({
        ...m, media_path: m.has_media ? `/bot/conversations/${conversationId}/messages/${m.id}/media` : null,
      })),
    };
  }

  async markRead(user: AuthenticatedUser, conversationId: number) {
    await this.assertAccess(user, conversationId);
    await this.dataSource.query(`UPDATE bot_conversation SET agent_last_read_at = NOW() WHERE id = $1`, [conversationId]);
    return { ok: true };
  }

  async registerDevice(user: AuthenticatedUser, dto: DeviceDto) {
    await this.dataSource.query(`
      INSERT INTO push_device (user_id, company_id, token, platform) VALUES ($1, $2, $3, $4)
      ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, company_id = EXCLUDED.company_id, platform = EXCLUDED.platform, last_seen = NOW()`,
      [user.id, user.company_id ?? null, dto.token, dto.platform ?? 'android']);
    return { ok: true };
  }

  async removeDevice(user: AuthenticatedUser, token: string) {
    await this.dataSource.query(`DELETE FROM push_device WHERE token = $1 AND user_id = $2`, [token, user.id]);
    return { ok: true };
  }
}

@Controller('mobile')
@ApiTags('Mobile app')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, FeatureGuard)
@RequiresFeature('mobile_app')
export class MobileController {
  constructor(private readonly mobile: MobileService) {}

  @Get('inbox')
  inbox(@CurrentUser() user: AuthenticatedUser, @Query() query: InboxQueryDto) { return this.mobile.inbox(user, query); }

  @Get('conversations/:id/messages')
  messages(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Query() query: MessagesQueryDto) {
    return this.mobile.messages(user, id, query);
  }

  @Post('conversations/:id/read')
  read(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.mobile.markRead(user, id); }

  @Post('devices')
  register(@CurrentUser() user: AuthenticatedUser, @Body() dto: DeviceDto) { return this.mobile.registerDevice(user, dto); }

  @Delete('devices/:token')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('token') token: string) { return this.mobile.removeDevice(user, token); }
}

@Module({ imports: [AuthModule], controllers: [MobileController], providers: [MobileService, PushService] })
export class MobileModule {}
