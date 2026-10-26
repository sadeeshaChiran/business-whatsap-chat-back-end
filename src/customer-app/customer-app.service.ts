import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, createHmac, randomInt, timingSafeEqual } from 'crypto';
import { DataSource } from 'typeorm';
import { publicChatMediaUrl, saveChatMedia, isChatMediaKey } from '../bot-admin/chat-media.store';
import { AppChatHook } from '../common/app-chat-hook';
import { absoluteProductImage } from '../products/product-images';
import { PusherService } from '../common/pusher.service';
import { SalesBotHook } from '../common/sales-bot-hook';
import { normalizeWhatsapp } from '../verification/verification';
import { otpDevMode, sendPhoneCode } from '../verification/senders';
import { signCustomerToken, type CustomerAccount } from './customer-auth';

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const MAX_SENDS_PER_HOUR = 6;
const MAX_TEXT = 4000;
export const APP_MAX_FILE_MB = 25;

const externalId = (accountId: number) => `ca:${accountId}`;
const accountOf = (externalUserId: string) => (/^ca:(\d+)$/.exec(externalUserId)?.[1] ? Number(/^ca:(\d+)$/.exec(externalUserId)![1]) : null);
const hashCode = (phone: string, code: string) => createHash('sha256').update(`${phone}:${code}:${process.env.JWT_SECRET ?? ''}`).digest('hex');

type Row = Record<string, any>;
/** UPDATE / DELETE … RETURNING come back as [rows, count] from TypeORM; INSERT / SELECT as rows. */
const firstRow = (result: unknown): Row | undefined => {
  const list = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  return Array.isArray(list) ? (list[0] as Row | undefined) : undefined;
};

/**
 * Customer app: customers log in with their phone (SMS code) and see every business that knows their number (a WhatsApp
 * chat or a CRM contact) or that they opened from the business's link. Their chat with a business is an ordinary inbox
 * chat with platform "app" – the team and the AI bot answer it from the Inbox. Free: nothing goes through Meta or SMS
 * except the login code. Nothing here runs for WhatsApp, Messenger, Instagram, TikTok or Telegram.
 */
@Injectable()
export class CustomerAppService implements OnModuleInit {
  private readonly logger = new Logger(CustomerAppService.name);
  private readonly pusher = new PusherService();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  onModuleInit() {
    AppChatHook.register({ delivered: (companyId, external) => this.pingCustomer(accountOf(external), companyId) });
  }

  /* ───────────────────────── login ───────────────────────── */

  /** Mobile numbers of the allowed countries (CUSTOMER_APP_COUNTRIES, default 94 = Sri Lanka) – stops SMS abuse abroad. */
  private phoneOf(value: string): string {
    const phone = normalizeWhatsapp(value);
    const countries = String(process.env.CUSTOMER_APP_COUNTRIES ?? '94').split(',').map((c) => c.trim()).filter(Boolean);
    const sriLanka = /^947\d{8}$/.test(phone);
    const allowed = countries.some((code) => (code === '94' ? sriLanka : phone.startsWith(code) && /^\d{10,15}$/.test(phone)));
    if (!allowed) throw new BadRequestException(countries.length === 1 && countries[0] === '94' ? 'Type your Sri Lankan mobile number, e.g. 077 123 4567.' : 'Type your mobile number with the country code.');
    return phone;
  }

  /** All login SMS of the day (CUSTOMER_APP_SMS_PER_DAY, default 3000) – a cap against someone sending codes to many numbers. */
  private async countSms() {
    const cap = Number(process.env.CUSTOMER_APP_SMS_PER_DAY ?? 3000);
    const [row] = await this.dataSource.query(`
      INSERT INTO ca_sms_day (day, sent) VALUES (CURRENT_DATE, 1)
      ON CONFLICT (day) DO UPDATE SET sent = ca_sms_day.sent + 1 RETURNING sent`);
    if (Number(row?.sent ?? 0) > cap) {
      this.logger.warn(`customer app: daily SMS cap ${cap} reached`);
      throw new HttpException('Too many logins right now. Please try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async startLogin(rawPhone: string) {
    const phone = this.phoneOf(rawPhone);
    const [current] = await this.dataSource.query(`SELECT * FROM ca_login_code WHERE phone = $1`, [phone]);
    const now = Date.now();
    if (current) {
      const wait = RESEND_SECONDS - Math.floor((now - new Date(current.last_sent_at).getTime()) / 1000);
      if (wait > 0) throw new HttpException(`Please wait ${wait} seconds before asking for a new code.`, HttpStatus.TOO_MANY_REQUESTS);
      const sameHour = now - new Date(current.hour_started_at).getTime() < 3600_000;
      if (sameHour && Number(current.sends_this_hour) >= MAX_SENDS_PER_HOUR) throw new HttpException('Too many codes for this number. Try again in an hour.', HttpStatus.TOO_MANY_REQUESTS);
    }
    await this.countSms();
    const code = String(randomInt(100000, 1000000));
    await this.dataSource.query(`
      INSERT INTO ca_login_code (phone, code_hash, expires_at, attempts, last_sent_at, hour_started_at, sends_this_hour)
      VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval, 0, NOW(), NOW(), 1)
      ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, last_sent_at = NOW(),
        attempts = CASE WHEN ca_login_code.hour_started_at < NOW() - INTERVAL '1 hour' THEN 0 ELSE LEAST(ca_login_code.attempts, 2) END,
        hour_started_at = CASE WHEN ca_login_code.hour_started_at < NOW() - INTERVAL '1 hour' THEN NOW() ELSE ca_login_code.hour_started_at END,
        sends_this_hour = CASE WHEN ca_login_code.hour_started_at < NOW() - INTERVAL '1 hour' THEN 1 ELSE ca_login_code.sends_this_hour + 1 END`,
    [phone, hashCode(phone, code), String(CODE_MINUTES)]);
    const via = await sendPhoneCode(phone, code);
    if (!via) throw new BadRequestException('The SMS could not be sent right now. Please try again in a minute.');
    return { phone, sent_via: via, resend_seconds: RESEND_SECONDS, ...(otpDevMode() ? { dev_code: code } : {}) };
  }

  async verifyLogin(rawPhone: string, rawCode: string, name?: string) {
    const phone = this.phoneOf(rawPhone);
    const code = String(rawCode ?? '').replace(/\D/g, '');
    // one try is used up BEFORE comparing (parallel guesses can never go past the limit)
    const row = firstRow(await this.dataSource.query(`
      UPDATE ca_login_code SET attempts = attempts + 1 WHERE phone = $1 AND attempts < $2 AND expires_at > NOW() RETURNING code_hash`, [phone, MAX_ATTEMPTS]));
    if (!row) {
      const [current] = await this.dataSource.query(`SELECT attempts, expires_at FROM ca_login_code WHERE phone = $1`, [phone]);
      if (current && new Date(current.expires_at).getTime() > Date.now()) throw new BadRequestException('Too many wrong codes. Ask for a new one.');
      throw new BadRequestException('The code expired. Ask for a new one.');
    }
    const expected = Buffer.from(String(row.code_hash));
    const given = Buffer.from(hashCode(phone, code));
    if (code.length !== 6 || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new BadRequestException('Wrong code. Check the SMS and try again.');
    }
    const used = firstRow(await this.dataSource.query(`DELETE FROM ca_login_code WHERE phone = $1 AND code_hash = $2 RETURNING phone`, [phone, row.code_hash]));
    if (!used) throw new BadRequestException('The code expired. Ask for a new one.');
    const cleanName = String(name ?? '').trim().slice(0, 60) || null;
    const [account] = await this.dataSource.query(`
      INSERT INTO ca_account (phone, name, last_seen_at) VALUES ($1, $2, NOW())
      ON CONFLICT (phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, ca_account.name), last_seen_at = NOW()
      RETURNING id, phone, name, token_version`, [phone, cleanName]);
    return { token: signCustomerToken(Number(account.id), Number(account.token_version)), account: this.publicAccount(account), new_account: !account.name };
  }

  publicAccount(account: Row) {
    return { id: Number(account.id), phone: String(account.phone), name: account.name ?? null };
  }

  async updateProfile(customer: CustomerAccount, input: { name?: string }) {
    const name = String(input.name ?? '').trim().slice(0, 60);
    if (!name) throw new BadRequestException('Type your name.');
    await this.dataSource.query(`UPDATE ca_account SET name = $2 WHERE id = $1`, [customer.id, name]);
    // the businesses see the new name in their inbox
    await this.dataSource.query(`UPDATE bot_channel_user SET display_name = $2 WHERE platform = 'app' AND external_user_id = $1`, [externalId(customer.id), name]);
    return { ...this.publicAccount(customer), name };
  }

  /** "Log out on all devices": every older token stops working. */
  async logoutEverywhere(customer: CustomerAccount) {
    await this.dataSource.query(`UPDATE ca_account SET token_version = token_version + 1 WHERE id = $1`, [customer.id]);
    return { logged_out: true };
  }

  /* ───────────────────────── businesses ("places") ───────────────────────── */

  private localPhone(phone: string) {
    return phone.startsWith('94') ? `0${phone.slice(2)}` : phone;
  }

  /** Businesses with the app on that know this number (WhatsApp chat / CRM contact) or that the customer opened. */
  async places(customer: CustomerAccount) {
    const rows: Row[] = await this.dataSource.query(`
      SELECT c.id, c.company_name AS name, cu.id AS channel_user_id,
             last.content AS last_text, last.message_type AS last_type, last.direction AS last_direction, last.created_at AS last_at,
             (SELECT COUNT(*)::int FROM bot_message m JOIN bot_conversation bc ON bc.id = m.conversation_id
               WHERE bc.bot_channel_user_id = cu.id AND m.direction::text = 'outbound' AND m.message_type::text <> 'system'
                 AND m.created_at > COALESCE(st.last_read_at, 'epoch'::timestamptz)) AS unread
        FROM ca_settings s
        JOIN companies c ON c.id = s.company_id
        LEFT JOIN bot_channel_user cu ON cu.company_id = c.id AND cu.platform = 'app' AND cu.external_user_id = $1
        LEFT JOIN ca_chat_state st ON st.channel_user_id = cu.id
        LEFT JOIN LATERAL (
          SELECT m.content, m.message_type::text AS message_type, m.direction::text AS direction, m.created_at FROM bot_message m JOIN bot_conversation bc ON bc.id = m.conversation_id
           WHERE bc.bot_channel_user_id = cu.id AND m.message_type::text <> 'system' ORDER BY m.id DESC LIMIT 1) last ON TRUE
       WHERE s.enabled
         AND (cu.id IS NOT NULL
           OR EXISTS (SELECT 1 FROM bot_channel_user w WHERE w.company_id = c.id AND w.platform = 'whatsapp' AND w.external_user_id IN ($2, $3))
           OR EXISTS (SELECT 1 FROM crm_contact cc WHERE cc.company_id = c.id AND regexp_replace(COALESCE(cc.phone, ''), '\\D', '', 'g') IN ($2, $3)))
       ORDER BY last.created_at DESC NULLS LAST, c.company_name`,
    [externalId(customer.id), customer.phone, this.localPhone(customer.phone)]);
    return rows.map((row) => ({
      id: Number(row.id), name: row.name, started: Boolean(row.channel_user_id), unread: Number(row.unread ?? 0),
      last: row.last_at ? { text: this.preview(row.last_type, row.last_text), from_me: row.last_direction === 'inbound', at: row.last_at } : null,
    }));
  }

  private preview(type: string, text: string | null) {
    if (type === 'image') return '📷 Photo';
    if (type === 'voice') return '🎤 Voice message';
    const value = String(text ?? '').trim();
    return /^\[(video|audio|document)\]/i.test(value) ? `📎 ${value.slice(1, value.indexOf(']'))}` : value.slice(0, 120);
  }

  /** A business the customer may open: the app is on, and it knows the number or the customer came from its link. */
  async place(customer: CustomerAccount, companyId: number, fromLink = false) {
    const [row] = await this.dataSource.query(`SELECT c.id, c.company_name AS name, s.enabled, s.welcome_text FROM companies c JOIN ca_settings s ON s.company_id = c.id WHERE c.id = $1`, [companyId]);
    if (!row?.enabled) throw new NotFoundException('This business does not use the app (yet).');
    if (!fromLink) {
      const known = (await this.places(customer)).some((place) => place.id === companyId);
      if (!known) throw new ForbiddenException('Open this business from its link or QR code first.');
    }
    return { id: Number(row.id), name: String(row.name), welcome_text: row.welcome_text as string | null };
  }

  /** The customer's inbox chat with a business (created the first time, with the business's welcome message). */
  private async channelUser(customer: CustomerAccount, companyId: number, create: boolean, fromLink = false): Promise<Row | null> {
    const [existing] = await this.dataSource.query(`SELECT * FROM bot_channel_user WHERE company_id = $1 AND platform = 'app' AND external_user_id = $2`, [companyId, externalId(customer.id)]);
    if (existing || !create) return existing ?? null;
    const place = await this.place(customer, companyId, fromLink);
    const [user] = await this.dataSource.query(`
      INSERT INTO bot_channel_user (company_id, app_user_id, platform, external_user_id, source_account_id, display_name, language, language_locked, session_state, bot_enabled, manual_mode, last_seen_at, created_at, updated_at)
      VALUES ($1, NULL, 'app', $2, NULL, $3, 'English', false, NULL, false, false, NOW(), NOW(), NOW())
      ON CONFLICT DO NOTHING RETURNING *`, [companyId, externalId(customer.id), customer.name || this.maskedPhone(customer.phone)]);
    if (!user) return (await this.dataSource.query(`SELECT * FROM bot_channel_user WHERE company_id = $1 AND platform = 'app' AND external_user_id = $2`, [companyId, externalId(customer.id)]))[0];
    const created = user;
    if (place.welcome_text) {
      const conversation = await this.conversation(Number(created.id));
      await this.saveMessage(conversation, 'outbound', 'text', place.welcome_text, null, 'app-welcome');
    }
    return created;
  }

  private maskedPhone(phone: string) {
    return `+${phone.slice(0, -4).replace(/\d(?=\d{3})/g, '•')}${phone.slice(-4)}`;
  }

  /** latest open chat of this customer (a new one after the team closed the old one) */
  private async conversation(channelUserId: number): Promise<Row> {
    const [open] = await this.dataSource.query(`SELECT * FROM bot_conversation WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 1`, [channelUserId]);
    if (open && open.status !== 'closed') return open;
    const [created] = await this.dataSource.query(`
      INSERT INTO bot_conversation (bot_channel_user_id, status, assignment_mode, last_message_at, created_at, updated_at)
      VALUES ($1, 'open', 'unassigned', NOW(), NOW(), NOW()) RETURNING *`, [channelUserId]);
    return created;
  }

  private async saveMessage(conversation: Row, direction: 'inbound' | 'outbound', type: 'text' | 'image' | 'voice', content: string, mediaKey: string | null, source: string) {
    const [row] = await this.dataSource.query(`
      INSERT INTO bot_message (conversation_id, direction, message_type, platform, provider_message_id, delivery_status, content, media_url, source, created_at, updated_at)
      VALUES ($1, $2, $3, 'app', $4, $5, $6, $7, $8, NOW(), NOW()) RETURNING *`,
    [conversation.id, direction, type, direction === 'outbound' ? `app:${Date.now().toString(36)}` : null, direction === 'outbound' ? 'sent' : null, content, mediaKey, source]);
    await this.dataSource.query(`UPDATE bot_conversation SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`, [conversation.id]);
    return row;
  }

  /** The business's chat link: "<company>-<signature>" – a link can't be guessed from a company number. */
  linkCode(companyId: number) {
    const secret = String(process.env.CUSTOMER_APP_SECRET || process.env.JWT_SECRET || '');
    return `${companyId}-${createHmac('sha256', secret).update(`ca-link:${companyId}`).digest('base64url').slice(0, 12)}`;
  }

  private companyFromLink(code: string): number {
    const id = Number(/^(\d+)-[\w-]{12}$/.exec(String(code ?? ''))?.[1] ?? 0);
    const expected = id ? Buffer.from(this.linkCode(id)) : Buffer.alloc(0);
    const given = Buffer.from(String(code ?? ''));
    if (!id || expected.length !== given.length || !timingSafeEqual(expected, given)) throw new NotFoundException('This chat link is not valid. Ask the business for its link again.');
    return id;
  }

  /** Opened from the business's link / QR: the business appears in the customer's list. */
  async open(customer: CustomerAccount, link: string) {
    const companyId = this.companyFromLink(link);
    const place = await this.place(customer, companyId, true);
    await this.channelUser(customer, companyId, true, true);
    return place;
  }

  /* ───────────────────────── chat ───────────────────────── */

  async messages(customer: CustomerAccount, companyId: number, beforeId?: number) {
    const place = await this.place(customer, companyId);
    const user = await this.channelUser(customer, companyId, false);
    if (!user) {
      // nothing saved yet – the business's welcome is shown; the chat starts with the customer's first message
      const welcome = place.welcome_text ? [{ id: 0, mine: false, type: 'text', text: place.welcome_text, media_url: null, created_at: new Date().toISOString(), reply_to_id: null, sender: null }] : [];
      return { place, has_more: false, messages: welcome };
    }
    const [conversation] = await this.dataSource.query(`SELECT agent_last_read_at FROM bot_conversation WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 1`, [user!.id]);
    const rows: Row[] = await this.dataSource.query(`
      SELECT m.id, m.direction::text AS direction, m.message_type::text AS type, m.content, m.media_url, m.created_at, m.source, m.delivery_status,
             m.reply_to_message_id, u.name AS agent_name
        FROM bot_message m JOIN bot_conversation bc ON bc.id = m.conversation_id
        LEFT JOIN app_user u ON u.id = m.sender_user_id
       WHERE bc.bot_channel_user_id = $1 AND m.message_type::text <> 'system' AND ($2::bigint IS NULL OR m.id < $2)
       ORDER BY m.id DESC LIMIT 40`, [user!.id, beforeId ?? null]);
    const agentRead = conversation?.agent_last_read_at ? new Date(conversation.agent_last_read_at).getTime() : 0;
    return {
      place,
      has_more: rows.length === 40,
      messages: rows.reverse().map((row) => {
        const mine = row.direction === 'inbound';
        const media = this.mediaLink(row.media_url);
        return {
          id: Number(row.id), mine, type: row.type, text: row.content ?? '', media_url: media, created_at: row.created_at,
          reply_to_id: row.reply_to_message_id ? Number(row.reply_to_message_id) : null,
          status: mine ? (agentRead >= new Date(row.created_at).getTime() ? 'read' : 'delivered') : undefined,
          sender: mine ? null : row.source === 'sales_bot' || row.source === 'bot' ? 'ai' : row.agent_name ? String(row.agent_name) : null,
        };
      }),
    };
  }

  /** Our stored chat files get a signed link (6 hours); product photos their public link; anything else is not shown. */
  private mediaLink(value: string | null): string | null {
    if (!value) return null;
    if (isChatMediaKey(value)) return publicChatMediaUrl(value, 6 * 3600);
    const absolute = absoluteProductImage(value);
    return /^https?:\/\//i.test(absolute) ? absolute : null;
  }

  async send(customer: CustomerAccount, companyId: number, input: { text?: string; file?: { buffer: Buffer; mimetype: string; originalname: string } | null }) {
    await this.place(customer, companyId);
    const user = await this.channelUser(customer, companyId, true);
    const text = String(input.text ?? '').trim();
    if (!text && !input.file) throw new BadRequestException('Type a message.');
    if (text.length > MAX_TEXT) throw new BadRequestException(`A message can have up to ${MAX_TEXT} characters.`);
    const conversation = await this.conversation(Number(user!.id));
    let type: 'text' | 'image' | 'voice' = 'text';
    let key: string | null = null;
    let content = text;
    if (input.file) {
      const mime = String(input.file.mimetype || 'application/octet-stream').split(';')[0].toLowerCase();
      if (input.file.buffer.length > APP_MAX_FILE_MB * 1024 * 1024) throw new BadRequestException(`Files can be up to ${APP_MAX_FILE_MB} MB.`);
      if (/^(text\/html|image\/svg|application\/(x-)?javascript)/.test(mime)) throw new BadRequestException('This kind of file can not be sent.');
      key = saveChatMedia(companyId, input.file.buffer, mime, input.file.originalname || 'file');
      if (mime.startsWith('image/')) { type = 'image'; content = text || '[image]'; }
      else if (/^audio\/(webm|ogg|mp4|mpeg|aac|x-m4a)/.test(mime) && /^voice/i.test(input.file.originalname || '')) { type = 'voice'; content = '[voice]'; }
      else if (mime.startsWith('video/')) content = `[video]${text ? `\n${text}` : ''}`;
      else if (mime.startsWith('audio/')) content = `[audio]${text ? `\n${text}` : ''}`;
      else content = [input.file.originalname || 'file', text].filter(Boolean).join('\n');
    }
    const row = await this.saveMessage(conversation, 'inbound', type, content, key, 'customer-app');
    await this.dataSource.query(`UPDATE bot_channel_user SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1`, [user!.id]);
    this.pusher.trigger(`company-${companyId}`, 'conversation_updated', {
      conversation_id: Number(conversation.id), platform: 'app', direction: 'inbound', client_message: true, inbound: true,
      agent_id: conversation.assigned_agent_id ?? null, preview: this.preview(type, content),
    });
    // the AI sales bot answers like on Messenger (it decides itself whether it may reply)
    if (SalesBotHook.isActive()) {
      await SalesBotHook.notify({ companyId, conversationId: Number(conversation.id), phone: externalId(customer.id), provider: 'app' })
        .catch((error: unknown) => this.logger.warn(`sales bot notify failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    return { id: Number(row.id), created_at: row.created_at };
  }

  /** The customer opened the chat: the team sees "read" on its messages; the unread count goes to 0. */
  async markRead(customer: CustomerAccount, companyId: number) {
    const user = await this.channelUser(customer, companyId, false);
    if (!user) return { ok: true };
    await this.dataSource.query(`
      INSERT INTO ca_chat_state (channel_user_id, account_id, last_read_at, updated_at) VALUES ($1, $2, NOW(), NOW())
      ON CONFLICT (channel_user_id) DO UPDATE SET last_read_at = NOW(), updated_at = NOW()`, [user.id, customer.id]);
    const updated = await this.dataSource.query(`
      UPDATE bot_message m SET delivery_status = 'read' FROM bot_conversation bc
       WHERE bc.id = m.conversation_id AND bc.bot_channel_user_id = $1 AND m.direction::text = 'outbound' AND COALESCE(m.delivery_status, '') IN ('sent', 'delivered')`, [user.id]);
    if (Array.isArray(updated) && Number(updated[1] ?? 0) > 0) this.pusher.trigger(`company-${companyId}`, 'conversation_updated', { platform: 'app', message_status: 'read' });
    return { ok: true };
  }

  /* ───────────────────────── realtime ───────────────────────── */

  customerChannel(accountId: number) {
    return `private-customer-${accountId}`;
  }

  authorizeRealtime(customer: CustomerAccount, socketId: string, channel: string) {
    if (channel !== this.customerChannel(customer.id)) throw new ForbiddenException('You cannot listen to this channel.');
    return this.pusher.authorize(socketId, channel);
  }

  realtimeEnabled() {
    return this.pusher.enabled;
  }

  /** Wakes up the customer's app: only "something new from business X" – the app then loads it with the customer's login. */
  pingCustomer(accountId: number | null, companyId: number) {
    if (!accountId) return;
    this.pusher.trigger(this.customerChannel(accountId), 'message', { company_id: companyId });
  }

  /* ───────────────────────── business side ───────────────────────── */

  async settings(companyId: number) {
    const [row] = await this.dataSource.query(`SELECT enabled, welcome_text FROM ca_settings WHERE company_id = $1`, [companyId]);
    const [stats] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS customers, COUNT(*) FILTER (WHERE cu.last_seen_at > NOW() - INTERVAL '7 days')::int AS active_week
        FROM bot_channel_user cu WHERE cu.company_id = $1 AND cu.platform = 'app'`, [companyId]);
    return { enabled: Boolean(row?.enabled), welcome_text: row?.welcome_text ?? null, customers: Number(stats?.customers ?? 0), active_week: Number(stats?.active_week ?? 0) };
  }

  async saveSettings(companyId: number, input: { enabled?: boolean; welcome_text?: string | null }) {
    const welcome = input.welcome_text == null ? null : String(input.welcome_text).trim().slice(0, 1000) || null;
    await this.dataSource.query(`
      INSERT INTO ca_settings (company_id, enabled, welcome_text, updated_at) VALUES ($1, $2, $3, NOW())
      ON CONFLICT (company_id) DO UPDATE SET enabled = EXCLUDED.enabled, welcome_text = EXCLUDED.welcome_text, updated_at = NOW()`,
    [companyId, Boolean(input.enabled), welcome]);
    return this.settings(companyId);
  }
}
