import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PusherService } from '../common/pusher.service';
import { PlanService } from '../platform/plan.service';
import { normalizeWhatsapp } from '../verification/verification';
import { addSmsCredits, smsMonth } from './sms-wallet';

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
const SENDER = /^[A-Za-z0-9 .&_-]{3,11}$/;
/** How an SMS goes out: the business's own Notify.lk account, or the Agent Metra account paid with SMS credits. */
type Route = { via: 'own' | 'platform'; user_id: string; api_key: string; sender_id: string; footer: string | null };
/** Credits taken for one SMS (free = the part from this month's free credits). */
type Paid = { credits: number; free: number; month: string };
type Platform = { enabled: boolean; user_id: string; api_key: string; default_sender: string; balance: number | null; checked_at: string | null; last_error: string | null };

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
 * SMS: offers / reminders to contacts (campaigns) and single SMS from the Inbox. Sent with the Agent Metra Notify.lk
 * account and paid with SMS credits (1 credit = 1 SMS part; free credits every month from the package, more from SMS
 * packs in Billing) – or with the business's own Notify.lk account (then no credits are used).
 * Every SMS sent to someone with a chat is also saved in that chat (source "sms"), so the team sees it there.
 * SMS sender names are one-way: replies can't come back, customers answer on WhatsApp / the app.
 */
@Injectable()
export class SmsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmsService.name);
  private readonly pusher = new PusherService();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly plan: PlanService) {}

  onModuleInit() { this.timer = setInterval(() => void this.tick(), 2_000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /* ───────── the account ───────── */

  private async account(companyId: number): Promise<Row | null> {
    const [a] = await this.dataSource.query(`SELECT * FROM sms_account WHERE company_id = $1`, [companyId]);
    return a ?? null;
  }

  /* ───────── Agent Metra SMS (credits) ───────── */

  private platformCache: { at: number; value: Platform } | null = null;

  /** The Agent Metra Notify.lk account (Super admin → SMS). */
  async platform(fresh = false): Promise<Platform> {
    if (!fresh && this.platformCache && Date.now() - this.platformCache.at < 10_000) return this.platformCache.value;
    const [row] = await this.dataSource.query(`SELECT value FROM platform_setting WHERE key = 'sms'`);
    const v = (row?.value ?? {}) as Row;
    // empty = the Notify.lk account the API already uses for login codes (NOTIFYLK_* in .env)
    const env = (key: string) => String(process.env[key] ?? '').trim();
    const value: Platform = {
      enabled: v.enabled === true, user_id: String(v.user_id || env('NOTIFYLK_USER_ID')), api_key: String(v.api_key || env('NOTIFYLK_API_KEY')),
      default_sender: String(v.default_sender || env('NOTIFYLK_SENDER_ID')),
      balance: v.balance != null ? Number(v.balance) : null, checked_at: v.checked_at ?? null, last_error: v.last_error ?? null,
    };
    this.platformCache = { at: Date.now(), value };
    return value;
  }

  private platformReady(p: Platform) { return p.enabled && Boolean(p.user_id && p.api_key && p.default_sender); }

  /** The business's credits row (made on first use; free credits start again in a new month). */
  private async wallet(companyId: number): Promise<Row> {
    const month = smsMonth();
    await this.dataSource.query(`INSERT INTO sms_wallet (company_id, free_month) VALUES ($1, $2) ON CONFLICT (company_id) DO NOTHING`, [companyId, month]);
    await this.dataSource.query(`UPDATE sms_wallet SET free_month = $2, free_used = 0 WHERE company_id = $1 AND free_month IS DISTINCT FROM $2`, [companyId, month]);
    const [w] = await this.dataSource.query(`SELECT * FROM sms_wallet WHERE company_id = $1`, [companyId]);
    return w;
  }

  /** Free SMS credits a month from the package (empty = none). */
  private async freeAllowance(companyId: number) {
    const limits = await this.plan.limitsForCompany(companyId).catch(() => null);
    return Math.max(0, Number(limits?.numbers?.sms_free_per_month ?? 0) || 0);
  }

  async credits(companyId: number) {
    const [w, free] = await Promise.all([this.wallet(companyId), this.freeAllowance(companyId)]);
    const freeLeft = Math.max(0, free - Number(w.free_used));
    const [used] = await this.dataSource.query(`
      SELECT COALESCE(SUM(credits) FILTER (WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Colombo') AT TIME ZONE 'Asia/Colombo'), 0)::int AS month,
             COALESCE(SUM(credits) FILTER (WHERE created_at > NOW() - INTERVAL '30 days'), 0)::int AS d30
        FROM sms_message WHERE company_id = $1 AND via = 'platform' AND credits > 0`, [companyId]);
    return {
      balance: Number(w.balance), free_per_month: free, free_left: freeLeft, available: freeLeft + Number(w.balance),
      used_this_month: Number(used?.month ?? 0), used_30d: Number(used?.d30 ?? 0), month: w.free_month,
    };
  }

  /** Takes credits for one SMS: free credits of this month first, then bought ones. null = not enough. */
  private async spend(companyId: number, n: number): Promise<Paid | null> {
    const free = await this.freeAllowance(companyId);
    await this.wallet(companyId);
    return this.dataSource.transaction(async (m) => {
      const [w] = await m.query(`SELECT balance, free_used, free_month FROM sms_wallet WHERE company_id = $1 FOR UPDATE`, [companyId]);
      const freeLeft = Math.max(0, free - Number(w.free_used));
      if (freeLeft + Number(w.balance) < n) return null;
      const fromFree = Math.min(n, freeLeft);
      await m.query(`UPDATE sms_wallet SET free_used = free_used + $2, balance = balance - $3, updated_at = NOW() WHERE company_id = $1`, [companyId, fromFree, n - fromFree]);
      return { credits: n, free: fromFree, month: String(w.free_month ?? smsMonth()) };
    });
  }

  /** Gives the credits of an SMS that was not sent back (free ones only within the month they were taken in). */
  private async refund(companyId: number, paid: Paid) {
    await this.dataSource.query(`
      UPDATE sms_wallet SET free_used = CASE WHEN free_month = $4 THEN GREATEST(0, free_used - $2) ELSE free_used END,
                            balance = balance + $3, updated_at = NOW() WHERE company_id = $1`,
    [companyId, paid.free, paid.credits - paid.free, paid.month]);
  }

  /** How this business sends: its own account first, else Agent Metra SMS (when switched on). null = cannot send. */
  private async route(companyId: number): Promise<Route | null> {
    const own = await this.account(companyId);
    if (own) return { via: 'own', user_id: own.user_id, api_key: own.api_key, sender_id: own.sender_id, footer: own.footer ?? null };
    const p = await this.platform();
    if (!this.platformReady(p)) return null;
    const w = await this.wallet(companyId);
    // sender_id is set only on approval: it stays in use while a new name waits for approval
    const sender = w.sender_id ? String(w.sender_id) : p.default_sender;
    return { via: 'platform', user_id: p.user_id, api_key: p.api_key, sender_id: sender, footer: w.footer ?? null };
  }

  /** The SMS as it goes out (with the footer line) and the credits it takes. */
  private body(r: Route | null, text: string) {
    const body = r?.footer ? `${text}\n${r.footer}` : text;
    return { body, parts: smsParts(body).segments };
  }

  /** Agent Metra SMS: ask for your own sender name (Super admin approves it with Notify.lk). */
  async requestSender(user: AuthenticatedUser, raw: unknown) {
    const companyId = Number(user.company_id);
    const sender = String(raw ?? '').trim();
    if (!SENDER.test(sender)) throw new BadRequestException('A sender name has 3–11 letters or numbers, e.g. VORAKIDS.');
    await this.wallet(companyId);
    await this.dataSource.query(`
      UPDATE sms_wallet SET sender_requested = $2, sender_status = 'requested', sender_note = NULL, sender_requested_at = NOW(), updated_at = NOW() WHERE company_id = $1`,
    [companyId, sender]);
    return this.settings(companyId);
  }

  /** Agent Metra SMS: the line added to every SMS (own accounts keep theirs on the account). */
  async setFooter(companyId: number, raw: unknown) {
    const footer = String(raw ?? '').trim().slice(0, 80) || null;
    await this.wallet(companyId);
    await this.dataSource.query(`UPDATE sms_wallet SET footer = $2, updated_at = NOW() WHERE company_id = $1`, [companyId, footer]);
    return this.settings(companyId);
  }

  /** Bought / given credits and what each campaign used. */
  async history(companyId: number) {
    const tx: Row[] = await this.dataSource.query(`SELECT credits, kind, note, created_at FROM sms_wallet_tx WHERE company_id = $1 ORDER BY id DESC LIMIT 50`, [companyId]);
    const used: Row[] = await this.dataSource.query(`
      SELECT COALESCE(c.name, 'Single SMS from the Inbox') AS name, SUM(m.credits)::int AS credits, MAX(m.created_at) AS created_at
        FROM sms_message m LEFT JOIN sms_campaign c ON c.id = m.campaign_id
       WHERE m.company_id = $1 AND m.via = 'platform' AND m.credits > 0
       GROUP BY m.campaign_id, c.name ORDER BY MAX(m.created_at) DESC LIMIT 50`, [companyId]);
    return [
      ...tx.map((t) => ({ credits: Number(t.credits), kind: String(t.kind), note: String(t.note), created_at: t.created_at })),
      ...used.map((u) => ({ credits: -Number(u.credits), kind: 'used', note: String(u.name), created_at: u.created_at })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 60);
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
    const r = await this.route(companyId);
    return { connected: Boolean(r), sender_id: r?.sender_id ?? null, via: r?.via ?? null };
  }

  async settings(companyId: number) {
    const a = await this.account(companyId);
    const p = await this.platform();
    const platformOn = this.platformReady(p);
    const w = await this.wallet(companyId);
    const packs: Row[] = platformOn ? await this.dataSource.query(`SELECT id, name, credits, price FROM sms_pack WHERE is_active ORDER BY sort_order, id`) : [];
    const agentMetra = {
      available: platformOn, default_sender: platformOn ? p.default_sender : null,
      sender_id: w.sender_id ? w.sender_id : platformOn ? p.default_sender : null,
      own_sender: w.sender_id ?? null, sender_requested: w.sender_requested ?? null, sender_status: w.sender_status,
      sender_note: w.sender_note ?? null, footer: w.footer ?? null,
      credits: await this.credits(companyId), packs: packs.map((k) => ({ id: Number(k.id), name: k.name, credits: Number(k.credits), price: Number(k.price) })),
    };
    const mode = a ? 'own' : platformOn ? 'platform' : 'off';
    const [stats] = await this.dataSource.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'sent' AND sent_at > NOW() - INTERVAL '30 days')::int AS sent_30d,
             COUNT(*) FILTER (WHERE status = 'failed' AND created_at > NOW() - INTERVAL '30 days')::int AS failed_30d
        FROM sms_message WHERE company_id = $1`, [companyId]);
    const [opt] = await this.dataSource.query(`SELECT COUNT(*)::int AS n FROM sms_optout WHERE company_id = $1`, [companyId]);
    return { ...this.view(a), mode, agent_metra: agentMetra, sent_30d: Number(stats?.sent_30d ?? 0), failed_30d: Number(stats?.failed_30d ?? 0), opted_out: Number(opt?.n ?? 0) };
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
    if (!SENDER.test(sender)) throw new BadRequestException('Enter your approved sender name (3–11 letters or numbers, e.g. VORAKIDS). "NotifyDEMO" works only for your test numbers.');
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
  private async deliver(a: Route, phone: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const { body } = this.body(a, text);
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
    const a = await this.route(companyId);
    if (!a) throw new NotFoundException('Connect your SMS account first.');
    const phone = smsNumber(to);
    if (!phone) throw new BadRequestException('Enter a mobile number, e.g. 077 123 4567.');
    const text = `Test SMS from ${a.sender_id} - your SMS works.`;
    const paid = a.via === 'platform' ? await this.spend(companyId, this.body(a, text).parts) : null;
    if (a.via === 'platform' && !paid) throw new BadRequestException('No SMS credits left – buy an SMS pack in Billing.');
    const r = await this.deliver(a, phone, text);
    if (!r.ok) {
      if (paid) await this.refund(companyId, paid);
      throw new BadRequestException(a.via === 'platform' ? this.platformError(r.error) : `Notify.lk did not send it: ${r.error}`);
    }
    return { sent: true, credits: paid?.credits ?? 0 };
  }

  /** Errors of the Agent Metra account are ours, not the business's: a plain message (and a log line for us). */
  private platformError(error?: string) {
    this.logger.warn(`Agent Metra SMS account: ${error ?? 'failed'}`);
    if (/balance|credit|insufficient|api key|unauthor/i.test(error ?? '')) return 'SMS can\'t be sent right now – we are fixing it. Your credits were not used.';
    return `The SMS was not sent: ${error ?? 'unknown error'}. Your credits were not used.`;
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
    const a = await this.route(companyId);
    const withFooter = smsParts(this.body(a, this.fill(text || ' ', 'Nimal')).body);
    // every name has its own length: the exact number of SMS is counted person by person
    const total = text.trim() ? this.totalParts(a, text, list) : list.length * withFooter.segments;
    const credits = a?.via === 'platform' ? await this.credits(companyId) : null;
    return {
      count: list.length, sample: list.slice(0, 5).map((c) => ({ phone: c.phone, name: c.name })), segments: withFooter.segments, unicode: withFooter.unicode,
      length: withFooter.length, total_sms: total, via: a?.via ?? null, credits_needed: a?.via === 'platform' ? total : 0, credits_available: credits?.available ?? null,
    };
  }

  private totalParts(a: Route | null, text: string, list: Array<{ name: string }>) {
    let total = 0;
    for (const c of list) total += this.body(a, this.fill(text, c.name)).parts;
    return total;
  }

  private fill(text: string, name: string) {
    const first = String(name ?? '').trim().split(/\s+/)[0] ?? '';
    return text.replace(/\{name\}/gi, first || 'there').trim();
  }

  /* ───────── campaigns ───────── */

  async createCampaign(user: AuthenticatedUser, input: { name?: string; text?: string; audience?: SmsAudience }) {
    const companyId = Number(user.company_id);
    const a = await this.route(companyId);
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
    if (a.via === 'platform') {
      const need = this.totalParts(a, text, list);
      const { available } = await this.credits(companyId);
      if (need > available) throw new BadRequestException(`This campaign needs ${need.toLocaleString('en-US')} SMS credits – you have ${available.toLocaleString('en-US')}. Buy an SMS pack in Billing, shorten the message or pick fewer people.`);
    }
    const parts = smsParts(this.body(a, this.fill(text, 'Nimal')).body);
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
      credits: Number(stats?.credits ?? 0),
    };
  }

  async campaigns(companyId: number) {
    const rows: Row[] = await this.dataSource.query(`SELECT * FROM sms_campaign WHERE company_id = $1 ORDER BY id DESC LIMIT 50`, [companyId]);
    if (!rows.length) return [];
    const stats: Row[] = await this.dataSource.query(`
      SELECT campaign_id, COUNT(*) FILTER (WHERE status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
             COUNT(*) FILTER (WHERE status = 'queued')::int AS queued, COALESCE(SUM(credits), 0)::int AS credits
        FROM sms_message WHERE campaign_id = ANY($1::bigint[]) GROUP BY campaign_id`, [rows.map((r) => r.id)]);
    const by = new Map(stats.map((s) => [Number(s.campaign_id), s]));
    return rows.map((r) => this.campaignView(r, by.get(Number(r.id))));
  }

  async campaign(companyId: number, id: number) {
    const [c] = await this.dataSource.query(`SELECT * FROM sms_campaign WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (!c) throw new NotFoundException('Campaign not found.');
    const [stats] = await this.dataSource.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed, COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
             COALESCE(SUM(credits), 0)::int AS credits
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
    const a = await this.route(companyId);
    const stopped = new Set<number>();
    const stop = async (campaignId: number, error: string) => {
      stopped.add(campaignId);
      await this.dataSource.query(`UPDATE sms_campaign SET status = 'stopped', finished_at = NOW(), error = $2 WHERE id = $1 AND status = 'sending'`, [campaignId, error]);
      await this.dataSource.query(`UPDATE sms_message SET status = 'skipped', error = 'Stopped – see campaign error' WHERE campaign_id = $1 AND status = 'queued'`, [campaignId]);
    };
    for (const m of rows) {
      if (m.campaign_id && stopped.has(Number(m.campaign_id))) continue;
      const claim = returned(await this.dataSource.query(`UPDATE sms_message SET status = 'sending', claimed_at = NOW() WHERE id = $1 AND status = 'queued' RETURNING id`, [m.id]));
      if (!claim.length) continue;
      if (!a) { await this.dataSource.query(`UPDATE sms_message SET status = 'failed', error = 'No SMS account' WHERE id = $1`, [m.id]); continue; }
      const text = this.fill(String(m.text), String(m.name ?? ''));
      let paid: Paid | null = null;
      if (a.via === 'platform') {
        paid = await this.spend(companyId, this.body(a, text).parts);
        if (!paid) {
          await this.dataSource.query(`UPDATE sms_message SET status = 'failed', error = 'No SMS credits left', via = 'platform' WHERE id = $1`, [m.id]);
          if (m.campaign_id) await stop(Number(m.campaign_id), 'Out of SMS credits – buy an SMS pack in Billing and send the rest again.');
          continue;
        }
        // written before sending: if the server stops mid-send the SMS may have gone out, so the row keeps what it cost
        await this.dataSource.query(`UPDATE sms_message SET credits = $2, credits_free = $3, via = 'platform' WHERE id = $1`, [m.id, paid.credits, paid.free]);
      }
      const r = await this.deliver(a, String(m.phone), text);
      if (!r.ok && paid) await this.refund(companyId, paid);
      const kept = r.ok && paid ? paid : { credits: 0, free: 0 };
      await this.dataSource.query(`
        UPDATE sms_message SET status = $2::varchar, error = $3, sent_at = CASE WHEN $2::varchar = 'sent' THEN NOW() ELSE NULL END, credits = $4, credits_free = $5, via = $6 WHERE id = $1`,
      [m.id, r.ok ? 'sent' : 'failed', r.ok ? null : (a.via === 'platform' ? 'Not sent – no credits used' : r.error ?? 'Failed'), kept.credits, kept.free, a.via]);
      if (!r.ok && a.via === 'platform') this.logger.warn(`Agent Metra SMS account: ${r.error ?? 'failed'}`);
      if (r.ok && m.bot_channel_user_id) await this.logInChat(Number(m.id), companyId, Number(m.bot_channel_user_id), text, m.sent_by ? Number(m.sent_by) : null).catch(() => undefined);
      // no credit / wrong key: stop the rest of this campaign instead of failing thousands of numbers
      if (!r.ok && m.campaign_id && /balance|credit|insufficient|api key|unauthor/i.test(r.error ?? '')) {
        await stop(Number(m.campaign_id), a.via === 'platform' ? 'SMS can\'t be sent right now – we are fixing it. Your credits were not used.' : String(r.error));
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
    const companyId = Number(user.company_id);
    const a = await this.route(companyId);
    const [opt] = phone ? await this.dataSource.query(`SELECT 1 FROM sms_optout WHERE company_id = $1 AND phone = $2`, [companyId, phone]) : [];
    const credits = a?.via === 'platform' ? (await this.credits(companyId)).available : null;
    return { connected: Boolean(a), sender_id: a?.sender_id ?? null, phone, name: chat.display_name ?? '', opted_out: Boolean(opt), footer: a?.footer ?? null, via: a?.via ?? null, credits_available: credits };
  }

  async sendToChat(user: AuthenticatedUser, conversationId: number, rawText: unknown) {
    const companyId = Number(user.company_id);
    const a = await this.route(companyId);
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
    const paid = a.via === 'platform' ? await this.spend(companyId, this.body(a, text).parts) : null;
    if (a.via === 'platform' && !paid) throw new BadRequestException('No SMS credits left – ask the admin to buy an SMS pack in Billing.');
    // the row carries what it cost from the start (claimed_at: closed by the sender loop if the server stops mid-send)
    const [m] = await this.dataSource.query(`
      INSERT INTO sms_message (company_id, bot_channel_user_id, phone, name, text, status, sent_by, via, credits, credits_free, claimed_at)
      VALUES ($1, $2, $3, $4, $5, 'sending', $6, $7, $8, $9, NOW()) RETURNING id`,
    [companyId, chat.channel_user_id, phone, String(chat.display_name ?? ''), text, user.id, a.via, paid?.credits ?? 0, paid?.free ?? 0]);
    const r = await this.deliver(a, phone, text);
    if (!r.ok && paid) await this.refund(companyId, paid);
    const kept = r.ok && paid ? paid : { credits: 0, free: 0 };
    await this.dataSource.query(`
      UPDATE sms_message SET status = $2::varchar, error = $3, sent_at = CASE WHEN $2::varchar = 'sent' THEN NOW() ELSE NULL END, credits = $4, credits_free = $5 WHERE id = $1`,
    [m.id, r.ok ? 'sent' : 'failed', r.ok ? null : r.error ?? 'Failed', kept.credits, kept.free]);
    if (!r.ok) throw new BadRequestException(a.via === 'platform' ? this.platformError(r.error) : `The SMS was not sent: ${r.error}`);
    await this.logInChat(Number(m.id), companyId, Number(chat.channel_user_id), text, Number(user.id))
      .catch((error) => this.logger.warn(`sms sent but not saved in the chat: ${error instanceof Error ? error.message : String(error)}`));
    return { sent: true, phone, credits: kept.credits };
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

  /* ───────── Super admin: the Agent Metra SMS account, packs, sender names, credits ───────── */

  private platformView(p: Platform, raw: Row) {
    return {
      enabled: p.enabled, user_id: String(raw.user_id ?? ''), api_key_hint: raw.api_key ? `••••${String(raw.api_key).slice(-4)}` : null,
      default_sender: String(raw.default_sender ?? ''), sender_in_use: p.default_sender,
      balance: p.balance, checked_at: p.checked_at, last_error: p.last_error, ready: this.platformReady(p),
      env_account: Boolean(String(process.env.NOTIFYLK_USER_ID ?? '').trim() && String(process.env.NOTIFYLK_API_KEY ?? '').trim()),
    };
  }

  private async savePlatformValue(value: Record<string, unknown>) {
    await this.dataSource.query(`
      INSERT INTO platform_setting (key, value, updated_at) VALUES ('sms', $1::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify(value)]);
    this.platformCache = null;
  }

  async adminOverview() {
    const p = await this.platform(true);
    const [totals] = await this.dataSource.query(`
      SELECT COALESCE(SUM(credits) FILTER (WHERE created_at > NOW() - INTERVAL '30 days'), 0)::int AS used_30d,
             COALESCE(SUM(credits - credits_free) FILTER (WHERE created_at > NOW() - INTERVAL '30 days'), 0)::int AS paid_30d
        FROM sms_message WHERE via = 'platform' AND credits > 0`);
    const [sold] = await this.dataSource.query(`SELECT COALESCE(SUM(balance), 0)::int AS unused FROM sms_wallet`);
    return { account: this.platformView(p, await this.rawPlatform()), used_30d: Number(totals?.used_30d ?? 0), paid_30d: Number(totals?.paid_30d ?? 0), unused_bought: Number(sold?.unused ?? 0) };
  }

  /** What the super admin saved (without the .env fallback). */
  private async rawPlatform(): Promise<Row> {
    const [row] = await this.dataSource.query(`SELECT value FROM platform_setting WHERE key = 'sms'`);
    return (row?.value ?? {}) as Row;
  }

  async savePlatform(input: { enabled?: boolean; user_id?: string; api_key?: string; default_sender?: string }) {
    const raw = await this.rawPlatform();
    const env = (key: string) => String(process.env[key] ?? '').trim();
    const savedUser = input.user_id !== undefined ? String(input.user_id).trim() : String(raw.user_id ?? '');
    const savedKey = String(input.api_key ?? '').trim() || String(raw.api_key ?? '');
    const savedSender = input.default_sender !== undefined ? String(input.default_sender).trim() : String(raw.default_sender ?? '');
    const userId = savedUser || env('NOTIFYLK_USER_ID');
    const apiKey = savedKey || env('NOTIFYLK_API_KEY');
    const sender = savedSender || env('NOTIFYLK_SENDER_ID');
    const enabled = input.enabled ?? raw.enabled === true;
    if (userId && !/^\d{1,20}$/.test(userId)) throw new BadRequestException('User ID: numbers only (Notify.lk → Settings → API Keys).');
    if (sender && !SENDER.test(sender)) throw new BadRequestException('Default sender name: 3–11 letters or numbers.');
    if (enabled && (!userId || !apiKey || !sender)) throw new BadRequestException('Add the User ID, API key and default sender name before switching Agent Metra SMS on.');
    let check: { ok: boolean; balance: number | null; error?: string } = { ok: true, balance: raw.balance ?? null };
    if (userId && apiKey && (input.user_id !== undefined || input.api_key || enabled)) {
      check = await this.status(userId, apiKey);
      if (!check.ok) throw new BadRequestException(check.error);
    }
    await this.savePlatformValue({ enabled, user_id: savedUser, api_key: savedKey, default_sender: savedSender, balance: check.balance, checked_at: new Date().toISOString(), last_error: null });
    return this.adminOverview();
  }

  async refreshPlatform() {
    const p = await this.platform(true);
    if (!p.user_id || !p.api_key) throw new BadRequestException('Add the Notify.lk User ID and API key first.');
    const check = await this.status(p.user_id, p.api_key);
    await this.savePlatformValue({ ...(await this.rawPlatform()), balance: check.ok ? check.balance : p.balance, checked_at: new Date().toISOString(), last_error: check.ok ? null : check.error });
    return this.adminOverview();
  }

  async adminPacks() {
    const rows: Row[] = await this.dataSource.query(`SELECT * FROM sms_pack ORDER BY sort_order, id`);
    return rows.map((k) => ({ id: Number(k.id), name: k.name, credits: Number(k.credits), price: Number(k.price), is_active: k.is_active, sort_order: Number(k.sort_order) }));
  }

  async savePack(input: { name?: string; credits?: number; price?: number; is_active?: boolean; sort_order?: number }, id?: number) {
    const name = String(input.name ?? '').trim().slice(0, 120);
    const credits = Math.trunc(Number(input.credits));
    const price = Number(input.price);
    if (!name || !(credits > 0) || !(price > 0)) throw new BadRequestException('A pack needs a name, credits and a price (more than 0).');
    if (id) {
      const r = returned(await this.dataSource.query(`UPDATE sms_pack SET name = $2, credits = $3, price = $4, is_active = $5, sort_order = $6 WHERE id = $1 RETURNING id`,
        [id, name, credits, price, input.is_active !== false, Math.trunc(Number(input.sort_order ?? 0))]));
      if (!r.length) throw new NotFoundException('SMS pack not found.');
    } else {
      await this.dataSource.query(`INSERT INTO sms_pack (name, credits, price, is_active, sort_order) VALUES ($1, $2, $3, $4, $5)`,
        [name, credits, price, input.is_active !== false, Math.trunc(Number(input.sort_order ?? 0))]);
    }
    return this.adminPacks();
  }

  /** Businesses with credits, sender names waiting for approval first. */
  async adminWallets() {
    const rows: Row[] = await this.dataSource.query(`
      SELECT w.*, co.company_name, co.plan,
             (SELECT COALESCE(SUM(m.credits), 0) FROM sms_message m WHERE m.company_id = w.company_id AND m.via = 'platform' AND m.created_at > NOW() - INTERVAL '30 days')::int AS used_30d
        FROM sms_wallet w JOIN companies co ON co.id = w.company_id
       WHERE w.balance > 0 OR w.free_used > 0 OR w.sender_status <> 'none'
          OR EXISTS (SELECT 1 FROM sms_wallet_tx t WHERE t.company_id = w.company_id)
          OR EXISTS (SELECT 1 FROM sms_message m WHERE m.company_id = w.company_id AND m.via = 'platform')
       ORDER BY (w.sender_status = 'requested') DESC, w.updated_at DESC LIMIT 300`);
    return rows.map((w) => ({
      company_id: Number(w.company_id), company_name: w.company_name, plan: w.plan, balance: Number(w.balance), used_30d: Number(w.used_30d),
      sender_id: w.sender_id ?? null, sender_requested: w.sender_requested ?? null, sender_status: w.sender_status, sender_note: w.sender_note ?? null,
      sender_requested_at: w.sender_requested_at ?? null,
    }));
  }

  async decideSender(companyId: number, input: { approve?: boolean; sender_id?: string; note?: string }) {
    const [w] = await this.dataSource.query(`SELECT * FROM sms_wallet WHERE company_id = $1`, [companyId]);
    if (!w) throw new NotFoundException('This business has no SMS yet.');
    if (input.approve) {
      const sender = String(input.sender_id ?? w.sender_requested ?? '').trim();
      if (!SENDER.test(sender)) throw new BadRequestException('Sender name: 3–11 letters or numbers.');
      await this.dataSource.query(`UPDATE sms_wallet SET sender_id = $2, sender_status = 'approved', sender_note = $3, updated_at = NOW() WHERE company_id = $1`,
        [companyId, sender, String(input.note ?? '').trim().slice(0, 300) || null]);
    } else {
      await this.dataSource.query(`UPDATE sms_wallet SET sender_status = $2, sender_note = $3, sender_requested = NULL, updated_at = NOW() WHERE company_id = $1`,
        [companyId, w.sender_id ? 'approved' : 'rejected', String(input.note ?? '').trim().slice(0, 300) || 'Not approved']);
    }
    return this.adminWallets();
  }

  async adjust(admin: AuthenticatedUser, companyId: number, input: { credits?: number; note?: string }) {
    const credits = Math.trunc(Number(input.credits));
    if (!credits) throw new BadRequestException('Enter the credits to add (or a minus number to take away).');
    const [co] = await this.dataSource.query(`SELECT id FROM companies WHERE id = $1`, [companyId]);
    if (!co) throw new NotFoundException('Company not found.');
    await addSmsCredits(this.dataSource, companyId, credits, 'adjust', String(input.note ?? '').trim() || (credits > 0 ? 'Given by Agent Metra' : 'Taken back by Agent Metra'), null, Number(admin.id));
    return this.adminWallets();
  }

  async tags(companyId: number) {
    const rows: Row[] = await this.dataSource.query(`
      SELECT t AS tag, COUNT(*)::int AS n FROM crm_contact cc, unnest(cc.tags) t WHERE cc.company_id = $1 GROUP BY t ORDER BY n DESC, t LIMIT 200`, [companyId]);
    return rows.map((r) => ({ tag: r.tag, count: Number(r.n) }));
  }
}
