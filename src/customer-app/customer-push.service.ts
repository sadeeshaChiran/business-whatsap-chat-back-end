import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import webpush from 'web-push';
import type { CustomerAccount } from './customer-auth';

type Row = Record<string, any>;
/** Where a tap on the notification opens: the chat, the news, a group or a member chat. */
export type CaPushTarget = { kind: 'chat' } | { kind: 'news' } | { kind: 'group'; id: number } | { kind: 'dm'; id: number } | { kind: 'team' };
/** call: an incoming call – the phone shows it like a call (stays on screen, Answer / Decline). */
export type CaPushMessage = { title: string; body: string; target: CaPushTarget; tag?: string; groupId?: number; call?: { id: number; video: boolean } };

const CONCURRENCY = 8;

/**
 * Phone notifications of the customer app (Web Push – Android Chrome, desktop browsers, iPhone after "Add to Home Screen").
 * A notification only says "new message from <business>" with a short preview; the app loads the rest after login.
 * Muted businesses / groups get nothing. Same server keys as the team's notifications (platform_setting 'web_push_vapid').
 */
@Injectable()
export class CustomerPushService {
  private readonly logger = new Logger(CustomerPushService.name);
  private keys: { publicKey: string; privateKey: string; subject: string } | null = null;
  private readonly queue: Array<() => Promise<void>> = [];
  private running = 0;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async vapid() {
    if (this.keys) return this.keys;
    const subject = process.env.VAPID_SUBJECT?.trim() || `mailto:${process.env.SMTP_FROM?.match(/[^<\s]+@[^>\s]+/)?.[0] ?? 'support@agentmetra.lk'}`;
    if (process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim()) {
      this.keys = { publicKey: process.env.VAPID_PUBLIC_KEY.trim(), privateKey: process.env.VAPID_PRIVATE_KEY.trim(), subject };
      return this.keys;
    }
    const [row] = await this.dataSource.query(`SELECT value FROM platform_setting WHERE key = 'web_push_vapid'`);
    let stored = row?.value as { publicKey?: string; privateKey?: string } | undefined;
    if (!stored?.publicKey || !stored?.privateKey) {
      const made = webpush.generateVAPIDKeys();
      await this.dataSource.query(`INSERT INTO platform_setting (key, value) VALUES ('web_push_vapid', $1::jsonb) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(made)]);
      const [again] = await this.dataSource.query(`SELECT value FROM platform_setting WHERE key = 'web_push_vapid'`);
      stored = again?.value ?? made;
    }
    this.keys = { publicKey: String(stored!.publicKey), privateKey: String(stored!.privateKey), subject };
    return this.keys;
  }

  /* ───────── customer: turn notifications on / off on this phone ───────── */

  async status(customer: CustomerAccount, endpoint?: string) {
    const keys = await this.vapid();
    const [mine] = endpoint ? await this.dataSource.query(`SELECT id FROM ca_push_sub WHERE endpoint = $1 AND account_id = $2`, [endpoint, customer.id]) : [];
    return { public_key: keys.publicKey, this_device: Boolean(mine) };
  }

  async subscribe(customer: CustomerAccount, input: { endpoint?: string; keys?: { p256dh?: string; auth?: string }; company_id?: number | null }) {
    const endpoint = String(input.endpoint ?? '');
    const p256dh = String(input.keys?.p256dh ?? '');
    const auth = String(input.keys?.auth ?? '');
    if (!/^https:\/\/[^\s]{10,1000}$/.test(endpoint) || !/^[\w-]{20,200}$/.test(p256dh) || !/^[\w-]{8,100}$/.test(auth)) throw new BadRequestException('Not a push address.');
    const companyId = Number(input.company_id) > 0 ? Number(input.company_id) : null;
    await this.dataSource.query(`
      INSERT INTO ca_push_sub (account_id, company_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (endpoint) DO UPDATE SET account_id = EXCLUDED.account_id, company_id = EXCLUDED.company_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, last_error = NULL`,
    [customer.id, companyId, endpoint, p256dh, auth]);
    return { this_device: true };
  }

  async unsubscribe(customer: CustomerAccount, endpoint: string) {
    await this.dataSource.query(`DELETE FROM ca_push_sub WHERE endpoint = $1 AND account_id = $2`, [String(endpoint ?? ''), customer.id]);
    return { this_device: false };
  }

  /** Logging out / deleting the account: this phone gets nothing any more. */
  async forget(accountId: number) {
    await this.dataSource.query(`DELETE FROM ca_push_sub WHERE account_id = $1`, [accountId]);
  }

  /* ───────── sending ───────── */

  /** Sends in the background (never slows down the request that caused it). */
  notify(accountIds: number[], companyId: number, message: CaPushMessage) {
    const ids = [...new Set(accountIds.filter((id) => Number.isFinite(id) && id > 0))];
    if (!ids.length) return;
    this.queue.push(async () => { await this.send(ids, companyId, message); });
    this.drain();
  }

  private drain() {
    while (this.running < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!;
      this.running += 1;
      void job().catch((error) => this.logger.warn(`customer push failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { this.running -= 1; this.drain(); });
    }
  }

  private path(target: CaPushTarget) {
    return target.kind === 'chat' ? 'chat' : target.kind === 'news' ? 'news' : target.kind === 'team' ? '' : target.kind === 'group' ? `g/${target.id}` : `dm/${target.id}`;
  }

  private hubPath(companyId: number, target: CaPushTarget) {
    return target.kind === 'chat' || target.kind === 'team' ? `/chat/b/${companyId}` : target.kind === 'news' ? `/chat/b/${companyId}?tab=news`
      : target.kind === 'group' ? `/chat/g/${target.id}` : `/chat/d/${target.id}`;
  }

  async send(accountIds: number[], companyId: number, message: CaPushMessage): Promise<number> {
    // muted business (or muted group) → no notification; subscriptions of this business's app or of the shared app
    const subs: Row[] = await this.dataSource.query(`
      SELECT p.id, p.endpoint, p.p256dh, p.auth, p.company_id FROM ca_push_sub p
       WHERE p.account_id = ANY($1::bigint[]) AND (p.company_id IS NULL OR p.company_id = $2)
         AND NOT EXISTS (SELECT 1 FROM ca_business_mute bm WHERE bm.account_id = p.account_id AND bm.company_id = $2)
         AND ($3::bigint IS NULL OR NOT EXISTS (SELECT 1 FROM ca_group_member gm WHERE gm.group_id = $3 AND gm.account_id = p.account_id AND gm.muted))`,
    [accountIds, companyId, message.groupId ?? null]);
    if (!subs.length) return 0;
    const [app] = await this.dataSource.query(`SELECT slug FROM ca_settings WHERE company_id = $1`, [companyId]);
    const api = String(process.env.PUBLIC_API_BASE_URL ?? '').trim().replace(/\/+$/, '');
    const icon = app?.slug && api ? `${api}/ca/app/${app.slug}/icon.png` : undefined;
    const keys = await this.vapid();
    let sent = 0;
    for (const sub of subs) {
      const url = sub.company_id && app?.slug ? `/app/${app.slug}/${this.path(message.target)}` : this.hubPath(companyId, message.target);
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({
          title: message.title.slice(0, 80), body: message.body.slice(0, 180), url, icon, tag: message.tag ?? `${companyId}:${this.path(message.target)}`,
          ...(message.call ? { call: message.call } : {}),
        }), { TTL: message.call ? 60 : 24 * 3600, urgency: 'high', vapidDetails: keys, timeout: 15_000 });
        sent += 1;
        await this.dataSource.query(`UPDATE ca_push_sub SET last_sent_at = NOW(), last_error = NULL WHERE id = $1`, [sub.id]);
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await this.dataSource.query(`DELETE FROM ca_push_sub WHERE id = $1`, [sub.id]);
        else await this.dataSource.query(`UPDATE ca_push_sub SET last_error = $2 WHERE id = $1`, [sub.id, (error instanceof Error ? error.message : String(error)).slice(0, 300)]);
      }
    }
    return sent;
  }
}
