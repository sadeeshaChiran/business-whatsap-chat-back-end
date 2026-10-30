import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PusherService } from '../common/pusher.service';
import { normalizeWhatsapp } from '../verification/verification';

type Row = Record<string, any>;
export type SmsAudience = { all?: boolean; tags?: string[]; exclude_tags?: string[]; numbers?: string };

const MAX_TEXT = 800;
const BATCH = 25;
/** Notify.lk (Sri Lanka). Tests point SMS_PROVIDER_BASE_URL at a fake server. */
const base = () => (process.env.SMS_PROVIDER_BASE_URL || 'https://app.notify.lk/api/v1').replace(/\/+$/, '');
const returned = (result: unknown): Row[] => (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : Array.isArray(result) ? result : []) as Row[];
/** Pasted numbers: whole lines only (never cut a number in half), at most 50,000 lines. */
const pastedLines = (value: unknown) => String(value ?? '').split(/[\n;]+/).map((l) => l.trim()).filter(Boolean).slice(0, 50_000);
const manager = (user: AuthenticatedUser) => user.role === 'admin' || user.role === 'supervisor';

/** GSM-7 characters (one SMS = 160); anything else (Sinhala, Tamil, emoji) is Unicode (one SMS = 70). */
const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
export function smsParts(text: string) {
  const unicode = !GSM.test(text);
  // Unicode SMS count UTF-16 units (an emoji takes 2); GSM counts the escape characters twice
  const length = unicode ? text.length : text.length + (text.match(/[\^{}\\[~\]|€]/g) ?? []).length;
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return { unicode, length, segments: length <= single ? 1 : Math.ceil(length / multi), per: length <= single ? single : multi };
}

/** "0771234567" → "94771234567"; null when it is not a Sri Lankan mobile number (landlines and foreign numbers are skipped). */
export function smsNumber(value: unknown): string | null {
  const n = normalizeWhatsapp(String(value ?? ''));
  return /^947\d{8}$/.test(n) ? n : null;
}

/**
 * SMS with the business's own Notify.lk account: offers / reminders to contacts (campaigns) and single SMS from the
 * Inbox. Every SMS sent to someone with a chat is also saved in that chat (source "sms"), so the team sees it there.
 * SMS sender names are one-way: replies can't come back, customers answer on WhatsApp / the app.
 */
@Injectable()
export class SmsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmsService.name);
  private readonly pusher = new PusherService();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  onModuleInit() { this.timer = setInterval(() => void this.tick(), 2_000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /* ───────── the account ───────── */

  private async account(companyId: number): Promise<Row | null> {
    const [a] = await this.dataSource.query(`SELECT * FROM sms_account WHERE company_id = $1`, [companyId]);
    return a ?? null;
  }

  private view(a: Row | null) {
    if (!a) return { connected: false };
    return {
      connected: true, provider: a.provider, user_id: a.user_id, api_key_hint: `••••${String(a.api_key).slice(-4)}`, sender_id: a.sender_id,
      footer: a.footer ?? null, balance: a.balance != null ? Number(a.balance) : null, status: a.status, last_error: a.last_error ?? null,
      connected_at: a.connected_at, checked_at: a.checked_at ?? null,
    };
  }

  /** For everyone in the team (the Inbox shows "Send SMS" when it is on) – no account details. */
  async ready(companyId: number) {
    const a = await this.account(companyId);
    return { connected: Boolean(a), sender_id: a?.sender_id ?? null };
  }

  async settings(companyId: number) {
    const a = await this.account(companyId);
    const [stats] = await this.dataSource.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'sent' AND sent_at > NOW() - INTERVAL '30 days')::int AS sent_30d,
             COUNT(*) FILTER (WHERE status = 'failed' AND created_at > NOW() - INTERVAL '30 days')::int AS failed_30d
        FROM sms_message WHERE company_id = $1`, [companyId]);
    const [opt] = await this.dataSource.query(`SELECT COUNT(*)::int AS n FROM sms_optout WHERE company_id = $1`, [companyId]);
    return { ...this.view(a), sent_30d: Number(stats?.sent_30d ?? 0), failed_30d: Number(stats?.failed_30d ?? 0), opted_out: Number(opt?.n ?? 0) };
  }

  /** Asks Notify.lk for the account status (also checks the keys). */
  private async status(userId: string, apiKey: string): Promise<{ ok: boolean; balance: number | null; error?: string }> {
    try {
      const q = new URLSearchParams({ user_id: userId, api_key: apiKey });
      const r = await fetch(`${base()}/status?${q.toString()}`, { signal: AbortSignal.timeout(15_000) });
      const body = (await r.json().catch(() => ({}))) as { status?: string; data?: { active?: boolean; acc_balance?: number | string }; message?: string; errors?: unknown };
      if (!r.ok || String(body.status ?? '').toLowerCase() !== 'success') return { ok: false, balance: null, error: body.message || 'Notify.lk did not accept this User ID / API key.' };
      const balance = body.data?.acc_balance != null && body.data.acc_balance !== '' ? Number(body.data.acc_balance) : null;
      return { ok: true, balance: Number.isFinite(balance) ? balance : null };
    } catch (error) {
      return { ok: false, balance: null, error: `Could not reach Notify.lk: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async connect(user: AuthenticatedUser, input: { user_id?: string; api_key?: string; sender_id?: string; footer?: string | null }) {
    const companyId = Number(user.company_id);
    const current = await this.account(companyId);
    const userId = String(input.user_id ?? '').trim();
    const apiKey = String(input.api_key ?? '').trim() || String(current?.api_key ?? '');
    const sender = String(input.sender_id ?? '').trim();
    if (!/^\d{1,20}$/.test(userId)) throw new BadRequestException('Enter the User ID from Notify.lk (Settings → API Keys) – numbers only.');
    if (apiKey.length < 8) throw new BadRequestException('Enter the API key from Notify.lk (Settings → API Keys).');
    if (!/^[A-Za-z0-9 .&_-]{3,11}$/.test(sender)) throw new BadRequestException('Enter your approved sender name (3–11 letters or numbers, e.g. VORAKIDS). "NotifyDEMO" works only for your test numbers.');
    const footer = input.footer == null ? (current?.footer ?? null) : String(input.footer).trim().slice(0, 80) || null;
    const check = await this.status(userId, apiKey);
    if (!check.ok) throw new BadRequestException(check.error);
    await this.dataSource.query(`
      INSERT INTO sms_account (company_id, user_id, api_key, sender_id, footer, balance, status, last_error, connected_by, connected_at, checked_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'ok', NULL, $7, NOW(), NOW())
      ON CONFLICT (company_id) DO UPDATE SET user_id = EXCLUDED.user_id, api_key = EXCLUDED.api_key, sender_id = EXCLUDED.sender_id, footer = EXCLUDED.footer,
        balance = EXCLUDED.balance, status = 'ok', last_error = NULL, connected_by = EXCLUDED.connected_by, checked_at = NOW()`,
    [companyId, userId, apiKey, sender, footer, check.balance, user.id]);
    return this.settings(companyId);
  }

  async refresh(companyId: number) {
    const a = await this.account(companyId);
    if (!a) throw new NotFoundException('Connect your SMS account first.');
    const check = await this.status(a.user_id, a.api_key);
    await this.dataSource.query(`UPDATE sms_account SET balance = COALESCE($2, balance), status = $3, last_error = $4, checked_at = NOW() WHERE company_id = $1`,
      [companyId, check.balance, check.ok ? 'ok' : 'error', check.ok ? null : check.error]);
    return this.settings(companyId);
  }

  async disconnect(companyId: number) {
    await this.dataSource.query(`UPDATE sms_campaign SET status = 'stopped', finished_at = NOW() WHERE company_id = $1 AND status = 'sending'`, [companyId]);
    await this.dataSource.query(`UPDATE sms_message SET status = 'skipped', error = 'SMS account removed' WHERE company_id = $1 AND status = 'queued'`, [companyId]);
    await this.dataSource.query(`DELETE FROM sms_account WHERE company_id = $1`, [companyId]);
    return { connected: false };
  }

  /** Sends one SMS now. */
  private async deliver(a: Row, phone: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const body = a.footer ? `${text}\n${a.footer}` : text;
    const q = new URLSearchParams({ user_id: a.user_id, api_key: a.api_key, sender_id: a.sender_id, to: phone, message: body });
    if (smsParts(body).unicode) q.set('type', 'unicode');
    try {
      const r = await fetch(`${base()}/send?${q.toString()}`, { signal: AbortSignal.timeout(15_000) });
      const res = (await r.json().catch(() => ({}))) as { status?: string; message?: string; errors?: unknown };
      if (r.ok && String(res.status ?? '').toLowerCase() === 'success') return { ok: true };
      return { ok: false, error: String(res.message || (res.errors ? JSON.stringify(res.errors) : `HTTP ${r.status}`)).slice(0, 300) };
    } catch (error) {
      return { ok: false, error: `Could not reach Notify.lk: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
    }
  }

  async test(user: AuthenticatedUser, to: unknown) {
    const companyId = Number(user.company_id);
    const a = await this.account(companyId);
    if (!a) throw new NotFoundException('Connect your SMS account first.');
    const phone = smsNumber(to);
    if (!phone) throw new BadRequestException('Enter a mobile number, e.g. 077 123 4567.');
    const r = await this.deliver(a, phone, `Test SMS from ${a.sender_id} – your SMS account works.`);
    if (!r.ok) throw new BadRequestException(`Notify.lk did not send it: ${r.error}`);
    return { sent: true };
  }

  /* ───────── who gets it ───────── */

  /** Contacts with a mobile number (WhatsApp, the customer app, or a number saved in CRM), by tags; not opted out. */
  private async contacts(companyId: number, audience: SmsAudience) {
    const tags = (audience.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    const without = (audience.exclude_tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    const out = new Map<string, { phone: string; name: string; channel_user_id: number | null }>();
    if (audience.all || tags.length) {
      const rows: Row[] = await this.dataSource.query(`
        SELECT cu.id, cu.platform, cu.external_user_id, COALESCE(NULLIF(cu.display_name, ''), '') AS name, cc.phone AS crm_phone, a.phone AS app_phone
          FROM bot_channel_user cu
          LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
          LEFT JOIN ca_account a ON cu.platform = 'app' AND cu.external_user_id = 'ca:' || a.id
         WHERE cu.company_id = $1 AND cu.external_user_id NOT LIKE 'cag:%'
           AND NOT EXISTS (SELECT 1 FROM marketing_optout o WHERE o.company_id = $1 AND o.bot_channel_user_id = cu.id)
           AND (COALESCE(array_length($2::text[], 1), 0) = 0 OR COALESCE(cc.tags, '{}') && $2::text[])
           AND (COALESCE(array_length($3::text[], 1), 0) = 0 OR NOT (COALESCE(cc.tags, '{}') && $3::text[]))
         ORDER BY cu.id`, [companyId, tags, without]);
      for (const r of rows) {
        const phone = smsNumber(r.crm_phone) ?? (r.platform === 'whatsapp' ? smsNumber(r.external_user_id) : null) ?? smsNumber(r.app_phone);
        if (phone && !out.has(phone)) out.set(phone, { phone, name: String(r.name ?? ''), channel_user_id: Number(r.id) });
      }
    }
    // typed / pasted numbers: one per line, optionally "0771234567, Nimal"; several numbers on one line also work
    for (const line of pastedLines(audience.numbers)) {
      const parts = line.split(/[,\t]/).map((x) => x.trim()).filter(Boolean);
      const phones = parts.map((x) => smsNumber(x));
      const name = parts.filter((_, i) => !phones[i]).join(' ').slice(0, 80);
      for (const phone of phones) if (phone && !out.has(phone)) out.set(phone, { phone, name: phones.filter(Boolean).length === 1 ? name : '', channel_user_id: null });
    }
    const opted: Row[] = await this.dataSource.query(`SELECT phone FROM sms_optout WHERE company_id = $1`, [companyId]);
    for (const o of opted) out.delete(String(o.phone));
    // WhatsApp customers who said STOP are skipped for typed numbers too
    const stopped: Row[] = await this.dataSource.query(`
      SELECT cu.external_user_id FROM marketing_optout o JOIN bot_channel_user cu ON cu.id = o.bot_channel_user_id
       WHERE o.company_id = $1 AND cu.platform = 'whatsapp'`, [companyId]);
    for (const s of stopped) { const p = smsNumber(s.external_user_id); if (p) out.delete(p); }
    // typed numbers that belong to a known chat → the SMS also shows in that chat
    const loose = [...out.values()].filter((c) => !c.channel_user_id).map((c) => c.phone);
    if (loose.length) {
      const known: Row[] = await this.dataSource.query(`
        SELECT DISTINCT ON (p) p, cu.id FROM (SELECT unnest($2::text[]) AS p) x
          JOIN bot_channel_user cu ON cu.company_id = $1 AND cu.platform = 'whatsapp' AND regexp_replace(cu.external_user_id, '\\D', '', 'g') = x.p
         ORDER BY p, cu.id`, [companyId, loose]);
      for (const k of known) { const c = out.get(String(k.p)); if (c) c.channel_user_id = Number(k.id); }
    }
    return [...out.values()];
  }

  async preview(companyId: number, audience: SmsAudience, text = '') {
    const list = await this.contacts(companyId, audience ?? {});
    const parts = smsParts(this.fill(text || ' ', 'Nimal'));
    const a = await this.account(companyId);
    const withFooter = a?.footer ? smsParts(`${this.fill(text || ' ', 'Nimal')}\n${a.footer}`) : parts;
    return { count: list.length, sample: list.slice(0, 5).map((c) => ({ phone: c.phone, name: c.name })), segments: withFooter.segments, unicode: withFooter.unicode, length: withFooter.length, total_sms: list.length * withFooter.segments };
  }

  private fill(text: string, name: string) {
    const first = String(name ?? '').trim().split(/\s+/)[0] ?? '';
    return text.replace(/\{name\}/gi, first || 'there').trim();
  }

  /* ───────── campaigns ───────── */

  async createCampaign(user: AuthenticatedUser, input: { name?: string; text?: string; audience?: SmsAudience }) {
    const companyId = Number(user.company_id);
    const a = await this.account(companyId);
    if (!a) throw new BadRequestException('Connect your SMS account first (Channels → SMS).');
    const text = String(input.text ?? '').trim();
    if (!text) throw new BadRequestException('Write the message.');
    if (text.length > MAX_TEXT) throw new BadRequestException(`An SMS campaign can have up to ${MAX_TEXT} characters.`);
    const name = String(input.name ?? '').trim().slice(0, 120) || text.slice(0, 40);
    const audience: SmsAudience = {
      all: input.audience?.all === true, tags: (input.audience?.tags ?? []).slice(0, 30), exclude_tags: (input.audience?.exclude_tags ?? []).slice(0, 30),
      numbers: pastedLines(input.audience?.numbers).join('\n'),
    };
    const list = await this.contacts(companyId, audience);
    if (!list.length) throw new BadRequestException('Nobody with a mobile number matches. Pick tags, "all contacts", or type numbers.');
    if (list.length > 50_000) throw new BadRequestException('Up to 50,000 numbers per campaign.');
    const parts = smsParts(a.footer ? `${this.fill(text, 'Nimal')}\n${a.footer}` : this.fill(text, 'Nimal'));
    const [c] = await this.dataSource.query(`
      INSERT INTO sms_campaign (company_id, name, text, audience, status, total, segments, created_by) VALUES ($1, $2, $3, $4::jsonb, 'sending', $5, $6, $7) RETURNING *`,
    [companyId, name, text, JSON.stringify({ ...audience, numbers: audience.numbers ? `${audience.numbers.split(/\n/).length} typed` : '' }), list.length, parts.segments, user.id]);
    for (let i = 0; i < list.length; i += 1000) {
      const chunk = list.slice(i, i + 1000);
      await this.dataSource.query(`
        INSERT INTO sms_message (company_id, campaign_id, bot_channel_user_id, phone, name, text, status, sent_by)
        SELECT $1, $2, x.cu, x.phone, x.name, $3, 'queued', $4 FROM jsonb_to_recordset($5::jsonb) AS x(cu int, phone text, name text)`,
      [companyId, c.id, text, user.id, JSON.stringify(chunk.map((r) => ({ cu: r.channel_user_id, phone: r.phone, name: r.name })))]);
    }
    void this.tick();
    return this.campaignView(c);
  }

  private campaignView(c: Row, stats?: Row) {
    return {
      id: Number(c.id), name: c.name, text: c.text, status: c.status, total: Number(c.total), segments: Number(c.segments), created_at: c.created_at,
      finished_at: c.finished_at ?? null, error: c.error ?? null,
      sent: Number(stats?.sent ?? 0), failed: Number(stats?.failed ?? 0), queued: Number(stats?.queued ?? (c.status === 'sending' ? c.total : 0)),
    };
  }

  async campaigns(companyId: number) {
    const rows: Row[] = await this.dataSource.query(`SELECT * FROM sms_campaign WHERE company_id = $1 ORDER BY id DESC LIMIT 50`, [companyId]);
    if (!rows.length) return [];
    const stats: Row[] = await this.dataSource.query(`
      SELECT campaign_id, COUNT(*) FILTER (WHERE status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
             COUNT(*) FILTER (WHERE status = 'queued')::int AS queued
        FROM sms_message WHERE campaign_id = ANY($1::bigint[]) GROUP BY campaign_id`, [rows.map((r) => r.id)]);
    const by = new Map(stats.map((s) => [Number(s.campaign_id), s]));
    return rows.map((r) => this.campaignView(r, by.get(Number(r.id))));
  }

  async campaign(companyId: number, id: number) {
    const [c] = await this.dataSource.query(`SELECT * FROM sms_campaign WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (!c) throw new NotFoundException('Campaign not found.');
    const [stats] = await this.dataSource.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed, COUNT(*) FILTER (WHERE status = 'queued')::int AS queued
        FROM sms_message WHERE campaign_id = $1`, [id]);
    const failed: Row[] = await this.dataSource.query(`SELECT phone, name, error FROM sms_message WHERE campaign_id = $1 AND status = 'failed' ORDER BY id LIMIT 200`, [id]);
    return { ...this.campaignView(c, stats), failures: failed.map((f) => ({ phone: f.phone, name: f.name, error: f.error })) };
  }

  async stop(companyId: number, id: number) {
    const r = await this.dataSource.query(`UPDATE sms_campaign SET status = 'stopped', finished_at = NOW() WHERE id = $1 AND company_id = $2 AND status = 'sending' RETURNING id`, [id, companyId]);
    if (!returned(r).length) throw new BadRequestException('This campaign is not sending.');
    await this.dataSource.query(`UPDATE sms_message SET status = 'skipped', error = 'Stopped' WHERE campaign_id = $1 AND status = 'queued'`, [id]);
    return this.campaign(companyId, id);
  }

  /* ───────── the sender (background) ───────── */

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // picked up but never finished (the server restarted mid-send): closed as unknown – never sent twice
      await this.dataSource.query(`
        UPDATE sms_message SET status = 'failed', error = 'Unknown – the server restarted while sending'
         WHERE status = 'sending' AND claimed_at < NOW() - INTERVAL '2 minutes'`);
      // a fair share for every business: a few rows of each, businesses in parallel
      const batch: Row[] = await this.dataSource.query(`
        SELECT * FROM (
          SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.company_id ORDER BY m.id) AS rn
            FROM sms_message m LEFT JOIN sms_campaign c ON c.id = m.campaign_id
           WHERE m.status = 'queued' AND (m.campaign_id IS NULL OR c.status = 'sending')) q
         WHERE rn <= ${BATCH} ORDER BY company_id, id LIMIT 500`);
      const byCompany = new Map<number, Row[]>();
      for (const m of batch) byCompany.set(Number(m.company_id), [...(byCompany.get(Number(m.company_id)) ?? []), m]);
      await Promise.all([...byCompany.entries()].map(([companyId, rows]) => this.sendRows(companyId, rows)));
      await this.dataSource.query(`
        UPDATE sms_campaign c SET status = 'done', finished_at = NOW()
         WHERE c.status = 'sending' AND NOT EXISTS (SELECT 1 FROM sms_message m WHERE m.campaign_id = c.id AND m.status IN ('queued', 'sending'))`);
    } catch (error) {
      this.logger.warn(`sms sender: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async sendRows(companyId: number, rows: Row[]) {
    const a = await this.account(companyId);
    const stopped = new Set<number>();
    for (const m of rows) {
      if (m.campaign_id && stopped.has(Number(m.campaign_id))) continue;
      const claim = returned(await this.dataSource.query(`UPDATE sms_message SET status = 'sending', claimed_at = NOW() WHERE id = $1 AND status = 'queued' RETURNING id`, [m.id]));
      if (!claim.length) continue;
      if (!a) { await this.dataSource.query(`UPDATE sms_message SET status = 'failed', error = 'No SMS account' WHERE id = $1`, [m.id]); continue; }
      const text = this.fill(String(m.text), String(m.name ?? ''));
      const r = await this.deliver(a, String(m.phone), text);
      await this.dataSource.query(`UPDATE sms_message SET status = $2::varchar, error = $3, sent_at = CASE WHEN $2::varchar = 'sent' THEN NOW() ELSE NULL END WHERE id = $1`,
        [m.id, r.ok ? 'sent' : 'failed', r.ok ? null : r.error ?? 'Failed']);
      if (r.ok && m.bot_channel_user_id) await this.logInChat(Number(m.id), companyId, Number(m.bot_channel_user_id), text, m.sent_by ? Number(m.sent_by) : null).catch(() => undefined);
      // no credit / wrong key: stop the rest of this campaign instead of failing thousands of numbers
      if (!r.ok && m.campaign_id && /balance|credit|insufficient|api key|unauthor/i.test(r.error ?? '')) {
        stopped.add(Number(m.campaign_id));
        await this.dataSource.query(`UPDATE sms_campaign SET status = 'stopped', finished_at = NOW(), error = $2 WHERE id = $1 AND status = 'sending'`, [m.campaign_id, r.error]);
        await this.dataSource.query(`UPDATE sms_message SET status = 'skipped', error = 'Stopped – see campaign error' WHERE campaign_id = $1 AND status = 'queued'`, [m.campaign_id]);
      }
    }
  }

  /** The SMS also shows in the customer's chat (the team sees what was sent). */
  private async logInChat(smsId: number, companyId: number, channelUserId: number, text: string, userId: number | null) {
    const [cu] = await this.dataSource.query(`SELECT id, platform FROM bot_channel_user WHERE id = $1 AND company_id = $2`, [channelUserId, companyId]);
    if (!cu) return;
    let [conv] = await this.dataSource.query(`SELECT id FROM bot_conversation WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 1`, [channelUserId]);
    if (!conv) {
      [conv] = await this.dataSource.query(`INSERT INTO bot_conversation (bot_channel_user_id, status, last_message_at) VALUES ($1, 'open', NOW()) RETURNING id`, [channelUserId]);
    }
    const [msg] = await this.dataSource.query(`
      INSERT INTO bot_message (conversation_id, direction, message_type, platform, provider_message_id, delivery_status, content, source, sender_user_id, created_at, updated_at)
      VALUES ($1, 'outbound', 'text', $2, $3, 'sent', $4, 'sms', $5, NOW(), NOW()) RETURNING id`,
    [conv.id, cu.platform, `sms:${smsId}`, text, userId]);
    await this.dataSource.query(`UPDATE sms_message SET bot_message_id = $2 WHERE id = $1`, [smsId, msg.id]);
    await this.dataSource.query(`UPDATE bot_conversation SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`, [conv.id]);
    this.pusher.trigger(`company-${companyId}`, 'conversation_updated', { conversation_id: Number(conv.id), direction: 'outbound', preview: `📱 SMS: ${text.slice(0, 80)}` });
  }

  /* ───────── one SMS from a chat in the Inbox ───────── */

  private async chatTarget(user: AuthenticatedUser, conversationId: number) {
    const [c] = await this.dataSource.query(`
      SELECT bc.id, bc.assigned_agent_id, cu.id AS channel_user_id, cu.platform, cu.external_user_id, cu.display_name, cc.phone AS crm_phone, a.phone AS app_phone
        FROM bot_conversation bc JOIN bot_channel_user cu ON cu.id = bc.bot_channel_user_id
        LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
        LEFT JOIN ca_account a ON cu.platform = 'app' AND cu.external_user_id = 'ca:' || a.id
       WHERE bc.id = $1 AND cu.company_id = $2`, [conversationId, Number(user.company_id)]);
    if (!c) throw new NotFoundException('Chat not found.');
    if (!manager(user) && Number(c.assigned_agent_id) !== Number(user.id)) throw new ForbiddenException('You do not have access to this conversation.');
    if (String(c.external_user_id).startsWith('cag:')) return { chat: c, phone: null as string | null };
    const phone = smsNumber(c.crm_phone) ?? (c.platform === 'whatsapp' ? smsNumber(c.external_user_id) : null) ?? smsNumber(c.app_phone);
    return { chat: c, phone };
  }

  async chatInfo(user: AuthenticatedUser, conversationId: number) {
    const { chat, phone } = await this.chatTarget(user, conversationId);
    const a = await this.account(Number(user.company_id));
    const [opt] = phone ? await this.dataSource.query(`SELECT 1 FROM sms_optout WHERE company_id = $1 AND phone = $2`, [Number(user.company_id), phone]) : [];
    return { connected: Boolean(a), sender_id: a?.sender_id ?? null, phone, name: chat.display_name ?? '', opted_out: Boolean(opt), footer: a?.footer ?? null };
  }

  async sendToChat(user: AuthenticatedUser, conversationId: number, rawText: unknown) {
    const companyId = Number(user.company_id);
    const a = await this.account(companyId);
    if (!a) throw new BadRequestException('Connect your SMS account first (Channels → SMS).');
    const { chat, phone } = await this.chatTarget(user, conversationId);
    if (!phone) throw new BadRequestException('This chat has no mobile number. Add one in the contact details (CRM).');
    const [opt] = await this.dataSource.query(`SELECT 1 FROM sms_optout WHERE company_id = $1 AND phone = $2`, [companyId, phone]);
    if (opt) throw new BadRequestException('This number asked not to get SMS from you.');
    const text = String(rawText ?? '').trim();
    if (!text) throw new BadRequestException('Write the SMS.');
    if (text.length > MAX_TEXT) throw new BadRequestException(`An SMS can have up to ${MAX_TEXT} characters.`);
    const [recent] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS n FROM sms_message WHERE company_id = $1 AND campaign_id IS NULL AND sent_by = $2 AND created_at > NOW() - INTERVAL '1 hour'`, [companyId, user.id]);
    if (Number(recent?.n ?? 0) >= 60) throw new BadRequestException('Too many single SMS this hour – use an SMS campaign for many people.');
    const [same] = await this.dataSource.query(`
      SELECT 1 FROM sms_message WHERE company_id = $1 AND phone = $2 AND text = $3 AND status IN ('sent', 'sending') AND created_at > NOW() - INTERVAL '2 minutes'`, [companyId, phone, text]);
    if (same) throw new BadRequestException('This SMS was just sent to this number.');
    const [m] = await this.dataSource.query(`
      INSERT INTO sms_message (company_id, bot_channel_user_id, phone, name, text, status, sent_by) VALUES ($1, $2, $3, $4, $5, 'sending', $6) RETURNING id`,
    [companyId, chat.channel_user_id, phone, String(chat.display_name ?? ''), text, user.id]);
    const r = await this.deliver(a, phone, text);
    await this.dataSource.query(`UPDATE sms_message SET status = $2::varchar, error = $3, sent_at = CASE WHEN $2::varchar = 'sent' THEN NOW() ELSE NULL END WHERE id = $1`,
      [m.id, r.ok ? 'sent' : 'failed', r.ok ? null : r.error ?? 'Failed']);
    if (!r.ok) throw new BadRequestException(`The SMS was not sent: ${r.error}`);
    await this.logInChat(Number(m.id), companyId, Number(chat.channel_user_id), text, Number(user.id))
      .catch((error) => this.logger.warn(`sms sent but not saved in the chat: ${error instanceof Error ? error.message : String(error)}`));
    return { sent: true, phone };
  }

  /* ───────── do-not-SMS list ───────── */

  async optouts(companyId: number) {
    const rows: Row[] = await this.dataSource.query(`SELECT phone, created_at FROM sms_optout WHERE company_id = $1 ORDER BY created_at DESC LIMIT 2000`, [companyId]);
    return rows.map((r) => ({ phone: r.phone, created_at: r.created_at }));
  }

  async setOptout(companyId: number, raw: unknown, out: boolean) {
    const phone = smsNumber(raw);
    if (!phone) throw new BadRequestException('Enter a mobile number, e.g. 077 123 4567.');
    if (out) await this.dataSource.query(`INSERT INTO sms_optout (company_id, phone) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [companyId, phone]);
    else await this.dataSource.query(`DELETE FROM sms_optout WHERE company_id = $1 AND phone = $2`, [companyId, phone]);
    await this.dataSource.query(`UPDATE sms_message SET status = 'skipped', error = 'Asked not to get SMS' WHERE company_id = $1 AND phone = $2 AND status = 'queued'`, [companyId, phone]);
    return { phone, opted_out: out };
  }

  async tags(companyId: number) {
    const rows: Row[] = await this.dataSource.query(`
      SELECT t AS tag, COUNT(*)::int AS n FROM crm_contact cc, unnest(cc.tags) t WHERE cc.company_id = $1 GROUP BY t ORDER BY n DESC, t LIMIT 200`, [companyId]);
    return rows.map((r) => ({ tag: r.tag, count: Number(r.n) }));
  }
}
