import { BadRequestException, Body, Controller, Delete, Get, Injectable, Logger, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUrl, MaxLength, ValidateNested } from 'class-validator';
import { DataSource } from 'typeorm';
import webpush from 'web-push';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * Phone and desktop notifications through the browser (Web Push) – no app store app needed.
 * Works on Android (Chrome), Windows / Mac (Chrome, Edge, Firefox, Safari) and iPhone / iPad (iOS 16.4+, after
 * "Add to Home Screen"). Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT, or created once and kept in
 * platform_setting 'web_push_vapid' when not set.
 */
export type PushMode = 'all' | 'attention';
export type WebPushPayload = { title: string; body: string; url: string; tag?: string; kind: 'message' | 'alert' | 'test'; needsPerson?: boolean };

class SubscriptionKeysDto {
  @IsString() @MaxLength(200) p256dh!: string;
  @IsString() @MaxLength(100) auth!: string;
}
export class SubscribeDto {
  @IsUrl({ require_tld: false, protocols: ['https', 'http'] }) @MaxLength(1000) endpoint!: string;
  @ValidateNested() @Type(() => SubscriptionKeysDto) keys!: SubscriptionKeysDto;
  @IsOptional() @IsIn(['all', 'attention']) mode?: PushMode;
  @IsOptional() @IsString() @MaxLength(200) device?: string;
}
export class UnsubscribeDto {
  @IsString() @MaxLength(1000) endpoint!: string;
}
export class ModeDto {
  @IsString() @MaxLength(1000) endpoint!: string;
  @IsIn(['all', 'attention']) mode!: PushMode;
}

@Injectable()
export class WebPushService {
  private readonly logger = new Logger(WebPushService.name);
  private keys: { publicKey: string; privateKey: string; subject: string } | null = null;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** VAPID keys: from the env, else made once and stored (so subscriptions keep working after a restart). */
  async vapid() {
    if (this.keys) return this.keys;
    const subject = process.env.VAPID_SUBJECT?.trim() || `mailto:${process.env.SMTP_FROM?.match(/[^<\s]+@[^>\s]+/)?.[0] ?? 'support@agentmetra.lk'}`;
    if (process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim()) {
      this.keys = { publicKey: process.env.VAPID_PUBLIC_KEY.trim(), privateKey: process.env.VAPID_PRIVATE_KEY.trim(), subject };
    } else {
      const [row] = await this.dataSource.query(`SELECT value FROM platform_setting WHERE key = 'web_push_vapid'`);
      let stored = row?.value as { publicKey?: string; privateKey?: string } | undefined;
      if (!stored?.publicKey || !stored?.privateKey) {
        const made = webpush.generateVAPIDKeys();
        await this.dataSource.query(`INSERT INTO platform_setting (key, value) VALUES ('web_push_vapid', $1::jsonb) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(made)]);
        const [again] = await this.dataSource.query(`SELECT value FROM platform_setting WHERE key = 'web_push_vapid'`);
        stored = again?.value ?? made;
      }
      this.keys = { publicKey: String(stored!.publicKey), privateKey: String(stored!.privateKey), subject };
    }
    return this.keys;
  }

  async subscribe(user: AuthenticatedUser, dto: SubscribeDto) {
    if (!/^https?:\/\//.test(dto.endpoint)) throw new BadRequestException('Not a push address.');
    await this.dataSource.query(`
      INSERT INTO web_push_subscription (user_id, company_id, endpoint, p256dh, auth, mode, device)
      VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'all'), $7)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, company_id = EXCLUDED.company_id, p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth, mode = COALESCE($6, web_push_subscription.mode), device = EXCLUDED.device, last_error = NULL`,
      [user.id, user.company_id ?? null, dto.endpoint, dto.keys.p256dh, dto.keys.auth, dto.mode ?? null, dto.device ?? null]);
    return this.status(user, dto.endpoint);
  }

  async unsubscribe(user: AuthenticatedUser, endpoint: string) {
    await this.dataSource.query(`DELETE FROM web_push_subscription WHERE endpoint = $1 AND user_id = $2`, [endpoint, user.id]);
    return { ok: true };
  }

  async setMode(user: AuthenticatedUser, dto: ModeDto) {
    await this.dataSource.query(`UPDATE web_push_subscription SET mode = $3 WHERE endpoint = $1 AND user_id = $2`, [dto.endpoint, user.id, dto.mode]);
    return this.status(user, dto.endpoint);
  }

  async status(user: AuthenticatedUser, endpoint?: string) {
    const rows: Array<{ endpoint: string; mode: PushMode; device: string | null; created_at: string; last_sent_at: string | null; last_error: string | null }> =
      await this.dataSource.query(`SELECT endpoint, mode, device, created_at, last_sent_at, last_error FROM web_push_subscription WHERE user_id = $1 ORDER BY id DESC`, [user.id]);
    const keys = await this.vapid();
    const mine = endpoint ? rows.find((r) => r.endpoint === endpoint) ?? null : null;
    return {
      public_key: keys.publicKey,
      devices: rows.map((r) => ({ device: r.device, mode: r.mode, created_at: r.created_at, last_sent_at: r.last_sent_at, ok: !r.last_error, this_device: r.endpoint === endpoint })),
      this_device: mine ? { mode: mine.mode, last_sent_at: mine.last_sent_at, error: mine.last_error } : null,
    };
  }

  async test(user: AuthenticatedUser) {
    const sent = await this.sendToUsers([Number(user.id)], { title: 'Notifications are on 🎉', body: 'New customer messages will show here, even when the app is closed.', url: '/dashboard', tag: 'test', kind: 'test' });
    return { sent };
  }

  /** Sends to every browser of these users that wants this kind of notification. Gone subscriptions are removed. */
  async sendToUsers(userIds: number[], payload: WebPushPayload): Promise<number> {
    const ids = [...new Set(userIds.filter((id) => Number.isFinite(id) && id > 0))];
    if (!ids.length) return 0;
    const subs: Array<{ id: number; endpoint: string; p256dh: string; auth: string; mode: PushMode }> =
      await this.dataSource.query(`SELECT id, endpoint, p256dh, auth, mode FROM web_push_subscription WHERE user_id = ANY($1::bigint[])`, [ids]);
    if (!subs.length) return 0;
    const keys = await this.vapid();
    let sent = 0;
    for (const sub of subs) {
      if (payload.kind === 'message' && sub.mode === 'attention' && !payload.needsPerson) continue;
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({
          title: payload.title.slice(0, 120), body: payload.body.slice(0, 240), url: payload.url, tag: payload.tag ?? payload.url,
        }), { TTL: 6 * 3600, urgency: 'high', vapidDetails: keys, timeout: 15_000 });
        sent++;
        await this.dataSource.query(`UPDATE web_push_subscription SET last_sent_at = NOW(), last_error = NULL WHERE id = $1`, [sub.id]);
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await this.dataSource.query(`DELETE FROM web_push_subscription WHERE id = $1`, [sub.id]); // browser unsubscribed
        } else {
          const message = error instanceof Error ? error.message : String(error);
          await this.dataSource.query(`UPDATE web_push_subscription SET last_error = $2 WHERE id = $1`, [sub.id, message.slice(0, 300)]);
          this.logger.warn(`web push failed (${status ?? 'network'}): ${message}`);
        }
      }
    }
    return sent;
  }
}

@Controller('push/web')
@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class WebPushController {
  constructor(private readonly push: WebPushService) {}

  @Get()
  status(@CurrentUser() user: AuthenticatedUser, @Query('endpoint') endpoint?: string) { return this.push.status(user, endpoint || undefined); }

  @Post('subscribe')
  subscribe(@CurrentUser() user: AuthenticatedUser, @Body() dto: SubscribeDto) { return this.push.subscribe(user, dto); }

  @Patch('mode')
  mode(@CurrentUser() user: AuthenticatedUser, @Body() dto: ModeDto) { return this.push.setMode(user, dto); }

  @Delete('subscribe')
  unsubscribe(@CurrentUser() user: AuthenticatedUser, @Body() dto: UnsubscribeDto) { return this.push.unsubscribe(user, dto.endpoint); }

  @Post('test')
  test(@CurrentUser() user: AuthenticatedUser) { return this.push.test(user); }
}
