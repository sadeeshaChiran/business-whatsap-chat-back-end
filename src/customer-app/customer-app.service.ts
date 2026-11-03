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
import { CustomerPushService } from './customer-push.service';

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const MAX_SENDS_PER_HOUR = 6;
const MAX_TEXT = 4000;
export const APP_MAX_FILE_MB = 25;

const externalId = (accountId: number) => `ca:${accountId}`;
export type TeamMember = { id: number; name: string; email: string; role: 'admin' | 'supervisor' | 'agent' };
const accountOf = (externalUserId: string) => (/^ca:(\d+)$/.exec(externalUserId)?.[1] ? Number(/^ca:(\d+)$/.exec(externalUserId)![1]) : null);
const hashCode = (phone: string, code: string) => createHash('sha256').update(`${phone}:${code}:${process.env.JWT_SECRET ?? ''}`).digest('hex');

type Row = Record<string, any>;
/** UPDATE / DELETE … RETURNING come back as [rows, count] from TypeORM; INSERT / SELECT as rows. */
const firstRow = (result: unknown): Row | undefined => {
  const list = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  return Array.isArray(list) ? (list[0] as Row | undefined) : undefined;
};

/**
 * Customer app: customers log in with their phone (SMS code). Every business has its own app (/app/<address>, own name and
 * logo); only the numbers the business added can use it (or anyone with its link, when the business allows that). Their chat with a business is an ordinary inbox
 * chat with platform "app" – the team and the AI bot answer it from the Inbox. Free: nothing goes through Meta or SMS
 * except the login code. Nothing here runs for WhatsApp, Messenger, Instagram, TikTok or Telegram.
 */
@Injectable()
export class CustomerAppService implements OnModuleInit {
  private readonly logger = new Logger(CustomerAppService.name);
  private readonly pusher = new PusherService();

  constructor(@InjectDataSource() private readonly dataSource: DataSource, readonly push: CustomerPushService) {}

  onModuleInit() {
    AppChatHook.register({
      delivered: (companyId, external) => {
        const group = /^cag:(\d+)$/.exec(external)?.[1];
        if (group) { void this.groupDelivered?.(companyId, Number(group)).catch((error: unknown) => this.logger.warn(`inbox → group failed: ${String(error)}`)); return; }
        const accountId = accountOf(external);
        this.pingCustomer(accountId, companyId);
        void this.pushReply(accountId, companyId).catch(() => undefined);
      },
    });
  }

  /** Set by the community service: a reply in a group's Inbox chat is posted in the group. */
  groupDelivered?: (companyId: number, groupId: number) => Promise<void>;

  /** Inbox lists update (new group message etc.). */
  notifyInbox(companyId: number, conversationId: number, direction: 'inbound' | 'outbound', preview: string) {
    this.pusher.trigger(`company-${companyId}`, 'conversation_updated', {
      conversation_id: conversationId, platform: 'app', direction, ...(direction === 'inbound' ? { client_message: true, inbound: true } : {}), preview: preview.slice(0, 120),
    });
  }

  /** The team / AI answered in the app chat → a phone notification with a short preview. */
  private async pushReply(accountId: number | null, companyId: number) {
    if (!accountId) return;
    const [last] = await this.dataSource.query(`
      SELECT m.message_type::text AS type, m.content, COALESCE(NULLIF(s.app_name, ''), c.company_name) AS name
        FROM bot_channel_user cu JOIN bot_conversation bc ON bc.bot_channel_user_id = cu.id
        JOIN bot_message m ON m.conversation_id = bc.id AND m.direction::text = 'outbound' AND m.message_type::text <> 'system' AND m.source IS DISTINCT FROM 'sms'
        JOIN companies c ON c.id = cu.company_id LEFT JOIN ca_settings s ON s.company_id = cu.company_id
       WHERE cu.company_id = $1 AND cu.platform = 'app' AND cu.external_user_id = $2 ORDER BY m.id DESC LIMIT 1`, [companyId, externalId(accountId)]);
    if (!last) return;
    this.push.notify([accountId], companyId, { title: String(last.name), body: this.preview(last.type, last.content) || 'New message', target: { kind: 'chat' } });
  }

  /** A member's short ID inside one business's app, e.g. "K7Q2MX" – shown instead of a phone number. */
  memberCode(companyId: number, accountId: number) {
    const secret = String(process.env.CUSTOMER_APP_SECRET || process.env.JWT_SECRET || '');
    const digest = createHmac('sha256', secret).update(`ca-member:${companyId}:${accountId}`).digest();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from(digest.subarray(0, 6)).map((byte) => alphabet[byte % alphabet.length]).join('');
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

  /* ───────────────────────── which business app ───────────────────────── */

  /** A business's own app: its address ("slug") or its chat link code. Null = the shared /chat app. */
  async appCompany(input: { app?: string | null; link?: string | null }): Promise<{ id: number; name: string; access: string } | null> {
    const slug = String(input.app ?? '').trim().toLowerCase();
    const link = String(input.link ?? '').trim();
    if (!slug && !link) return null;
    const id = slug ? null : this.companyFromLink(link);
    const [row] = await this.dataSource.query(`
      SELECT c.id, COALESCE(NULLIF(s.app_name, ''), c.company_name) AS name, s.access FROM ca_settings s JOIN companies c ON c.id = s.company_id
       WHERE s.enabled AND ${slug ? 's.slug = $1' : 's.company_id = $1'}`, [slug || id]);
    if (!row) throw new NotFoundException('This app is not available. Ask the business for its link again.');
    return { id: Number(row.id), name: String(row.name), access: String(row.access ?? 'invited') };
  }

  /** May this number use the business's app? Only numbers the business added (or that joined from its link, when it allows that). */
  async isMember(companyId: number, phone: string): Promise<boolean> {
    const rows = await this.dataSource.query(`SELECT 1 FROM ca_app_member WHERE company_id = $1 AND phone = $2`, [companyId, phone]);
    return rows.length > 0;
  }

  /** Taken off the list by the business – the link does not bring them back. */
  async wasRemoved(companyId: number, phone: string): Promise<boolean> {
    const rows = await this.dataSource.query(`SELECT 1 FROM ca_app_removed WHERE company_id = $1 AND phone = $2`, [companyId, phone]);
    return rows.length > 0;
  }

  /**
   * The business's own team on its app: the owner (the mobile number of the Agent Metra account / company) and agents
   * whose mobile number the owner saved (Customer app → Team). They log in with the same SMS code as customers and then
   * work as the business (chats, groups, calls, meetings). Agents' numbers count as verified once the SMS login worked.
   */
  async teamMember(companyId: number, phone: string): Promise<TeamMember | null> {
    if (!phone) return null;
    const key = `${companyId}:${phone}`;
    const cached = this.teamCache.get(key);
    if (cached && cached.until > Date.now()) return cached.value;
    const value = await this.findTeamMember(companyId, phone);
    if (this.teamCache.size > 2000) this.teamCache.clear();
    // short: access removed in the dashboard stops working within seconds
    this.teamCache.set(key, { value, until: Date.now() + 5_000 });
    return value;
  }

  /** After the owner changes a team member's mobile number. */
  forgetTeam() { this.teamCache.clear(); }

  private readonly teamCache = new Map<string, { value: TeamMember | null; until: number }>();

  private async findTeamMember(companyId: number, phone: string): Promise<TeamMember | null> {
    // owner and agents by their own mobile number (the owner's was checked with a code at sign-up / in Settings;
    // the free-text business phone of the company is NOT used – nobody confirmed it)
    const rows: Row[] = await this.dataSource.query(`
      SELECT u.id, u.name, u.email, u.team_role, u.whatsapp_number, c.admin_user_id
        FROM app_user u JOIN companies c ON c.id = u.company_id
       WHERE u.company_id = $1 AND u.is_active AND NOT u.access_disabled AND NOT u.is_super_admin AND u.whatsapp_number IS NOT NULL
         AND UPPER(COALESCE(c.status, '')) <> 'SUSPENDED'
       ORDER BY (u.id = c.admin_user_id) DESC, u.id`, [companyId]);
    const hit = rows.find((r) => normalizeWhatsapp(String(r.whatsapp_number)) === phone);
    if (!hit) return null;
    const owner = Number(hit.id) === Number(hit.admin_user_id);
    return { id: Number(hit.id), name: String(hit.name), email: String(hit.email), role: owner ? 'admin' : hit.team_role === 'supervisor' ? 'supervisor' : 'agent' };
  }

  private notOnList(name: string) {
    return new ForbiddenException(`This number is not on ${name}'s list yet. Ask ${name} to add your number, then try again.`);
  }

  async startLogin(rawPhone: string, appInput: { app?: string | null; link?: string | null } = {}) {
    const phone = this.phoneOf(rawPhone);
    // no SMS for numbers that could not use the app anyway
    const company = await this.appCompany(appInput);
    if (company) {
      if (!(await this.isMember(company.id, phone)) && !(await this.teamMember(company.id, phone))
        && (company.access !== 'link' || (await this.wasRemoved(company.id, phone)))) throw this.notOnList(company.name);
    } else {
      const [any] = await this.dataSource.query(`
        SELECT 1 FROM ca_app_member m JOIN ca_settings s ON s.company_id = m.company_id AND s.enabled WHERE m.phone = $1 LIMIT 1`, [phone]);
      if (!any) throw new ForbiddenException('This number is not on any business\'s list yet. Ask the business to add your number, or open its link.');
    }
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

  async verifyLogin(rawPhone: string, rawCode: string, name?: string, appInput: { app?: string | null; link?: string | null } = {}) {
    const phone = this.phoneOf(rawPhone);
    const company = await this.appCompany(appInput);
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
    if (company) await this.joinApp(company, { id: Number(account.id), phone, name: account.name ?? null } as CustomerAccount);
    // the shared /chat app shows every business that added the number → they "have the app" for all of them
    else await this.dataSource.query(`UPDATE ca_app_member SET joined_at = COALESCE(joined_at, NOW()), last_open_at = NOW() WHERE phone = $1`, [phone]);
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
    await this.push.forget(customer.id);
    // encrypted member chats: those devices can't read new messages any more
    await this.dataSource.query(`UPDATE ca_device_key SET revoked_at = NOW() WHERE account_id = $1 AND revoked_at IS NULL`, [customer.id]);
    return { logged_out: true };
  }

  /* ───────────────────────── businesses ("places") ───────────────────────── */

  /**
   * The customer opened a business's app: added numbers are marked "on the app"; with "anyone with the link" the number is
   * added now. Otherwise the number is not on the list → no access.
   */
  async joinApp(company: { id: number; name: string; access: string }, customer: CustomerAccount) {
    const team = await this.teamMember(company.id, customer.phone);
    if (team) {
      // the SMS code proved the number → the agent's mobile counts as verified
      await this.dataSource.query(`UPDATE app_user SET whatsapp_verified_at = COALESCE(whatsapp_verified_at, NOW()) WHERE id = $1 AND whatsapp_number IS NOT NULL`, [team.id]);
    }
    const updated = await this.dataSource.query(`
      UPDATE ca_app_member SET joined_at = COALESCE(joined_at, NOW()), last_open_at = NOW(), name = COALESCE(name, $3)
       WHERE company_id = $1 AND phone = $2 RETURNING phone`, [company.id, customer.phone, customer.name ?? null]);
    if (firstRow(updated) || team) return true;
    if (company.access !== 'link' || (await this.wasRemoved(company.id, customer.phone))) return false;
    await this.dataSource.query(`
      INSERT INTO ca_app_member (company_id, phone, name, source, joined_at, last_open_at) VALUES ($1, $2, $3, 'link', NOW(), NOW()) ON CONFLICT DO NOTHING`,
    [company.id, customer.phone, customer.name ?? null]);
    return true;
  }

  /** Opening a business's own app (/app/<address>): may this customer use it? */
  async openApp(customer: CustomerAccount, slug: string) {
    const company = await this.appCompany({ app: slug });
    if (!(await this.joinApp(company!, customer))) throw this.notOnList(company!.name);
    return { company_id: company!.id, name: company!.name };
  }

  /** Businesses whose app is on and that added this number. */
  async places(customer: CustomerAccount) {
    // the shared app lists every business that added the number → "has the app" for each of them
    await this.dataSource.query(`
      UPDATE ca_app_member SET joined_at = COALESCE(joined_at, NOW()), last_open_at = NOW()
       WHERE phone = $1 AND (joined_at IS NULL OR last_open_at IS NULL OR last_open_at < NOW() - INTERVAL '5 minutes')`, [customer.phone]);
    const rows: Row[] = await this.dataSource.query(`
      SELECT c.id, COALESCE(NULLIF(s.app_name, ''), c.company_name) AS name, s.slug, cu.id AS channel_user_id,
             last.content AS last_text, last.message_type AS last_type, last.direction AS last_direction, last.created_at AS last_at,
             (SELECT COUNT(*)::int FROM bot_message m JOIN bot_conversation bc ON bc.id = m.conversation_id
               WHERE bc.bot_channel_user_id = cu.id AND m.direction::text = 'outbound' AND m.message_type::text <> 'system' AND m.source IS DISTINCT FROM 'sms'
                 AND m.created_at > COALESCE(st.last_read_at, 'epoch'::timestamptz)) AS unread,
             p.logo_key,
             (SELECT COUNT(*)::int FROM ca_news n WHERE n.company_id = c.id AND n.deleted_at IS NULL
                 AND n.created_at > NOW() - INTERVAL '60 days'
                 AND NOT EXISTS (SELECT 1 FROM ca_news_view v WHERE v.news_id = n.id AND v.account_id = $3)) AS news_unread,
             (SELECT COUNT(*)::int FROM ca_group_member gm JOIN ca_group g ON g.id = gm.group_id AND g.archived_at IS NULL
                JOIN ca_group_message msg ON msg.group_id = g.id AND msg.id > gm.last_read_id AND msg.deleted_at IS NULL AND msg.sender_account_id IS DISTINCT FROM gm.account_id
               WHERE gm.account_id = $3 AND g.company_id = c.id) AS groups_unread,
             (SELECT COUNT(*)::int FROM ca_dm d JOIN ca_dm_message dm ON dm.dm_id = d.id AND dm.deleted_at IS NULL AND dm.sender_account_id <> $3
                 AND dm.id > CASE WHEN d.account_a = $3 THEN d.a_last_read_id ELSE d.b_last_read_id END
               WHERE d.company_id = c.id AND (d.account_a = $3 OR d.account_b = $3)) AS dms_unread
        FROM ca_settings s
        JOIN companies c ON c.id = s.company_id
        LEFT JOIN ca_business_profile p ON p.company_id = c.id
        LEFT JOIN bot_channel_user cu ON cu.company_id = c.id AND cu.platform = 'app' AND cu.external_user_id = $1
        LEFT JOIN ca_chat_state st ON st.channel_user_id = cu.id
        LEFT JOIN LATERAL (
          SELECT m.content, m.message_type::text AS message_type, m.direction::text AS direction, m.created_at FROM bot_message m JOIN bot_conversation bc ON bc.id = m.conversation_id
           WHERE bc.bot_channel_user_id = cu.id AND m.message_type::text <> 'system' AND m.source IS DISTINCT FROM 'sms' ORDER BY m.id DESC LIMIT 1) last ON TRUE
       WHERE s.enabled AND EXISTS (SELECT 1 FROM ca_app_member am WHERE am.company_id = c.id AND am.phone = $2)
       ORDER BY last.created_at DESC NULLS LAST, c.company_name`,
    [externalId(customer.id), customer.phone, customer.id]);
    return rows.map((row) => ({
      id: Number(row.id), name: row.name, slug: row.slug ?? null, started: Boolean(row.channel_user_id), unread: Number(row.unread ?? 0),
      logo_url: row.logo_key ? publicChatMediaUrl(row.logo_key, 24 * 3600) : null,
      news_unread: Number(row.news_unread ?? 0), groups_unread: Number(row.groups_unread ?? 0), dms_unread: Number(row.dms_unread ?? 0),
      last: row.last_at ? { text: this.preview(row.last_type, row.last_text), from_me: row.last_direction === 'inbound', at: row.last_at } : null,
    }));
  }

  preview(type: string, text: string | null) {
    if (type === 'image') return '📷 Photo';
    if (type === 'voice') return '🎤 Voice message';
    const value = String(text ?? '').trim();
    return /^\[(video|audio|document)\]/i.test(value) ? `📎 ${value.slice(1, value.indexOf(']'))}` : value.slice(0, 120);
  }

  /** A business the customer may open: the app is on and the business added the number (see joinApp). */
  async place(customer: CustomerAccount, companyId: number) {
    const [row] = await this.dataSource.query(`
      SELECT c.id, COALESCE(NULLIF(s.app_name, ''), c.company_name) AS name, s.enabled, s.welcome_text, s.member_dm,
             EXISTS (SELECT 1 FROM app_user u WHERE u.company_id = c.id AND COALESCE(u.is_active, TRUE) AND COALESCE(u.is_agent_active, FALSE)) AS team_online,
             EXISTS (SELECT 1 FROM ca_app_member am WHERE am.company_id = c.id AND am.phone = $2) AS member
        FROM companies c JOIN ca_settings s ON s.company_id = c.id WHERE c.id = $1`, [companyId, customer.phone]);
    if (!row?.enabled) throw new NotFoundException('This business does not use the app (yet).');
    const team = await this.teamMember(Number(row.id), customer.phone);
    if (!row.member && !team) throw this.notOnList(String(row.name));
    return {
      id: Number(row.id), name: String(row.name), welcome_text: row.welcome_text as string | null, member_dm: Boolean(row.member_dm), team_online: Boolean(row.team_online),
      team: team ? { role: team.role, name: team.name } : null, member: Boolean(row.member),
    };
  }

  /** The customer's inbox chat with a business (created the first time, with the business's welcome message). */
  async channelUser(customer: CustomerAccount, companyId: number, create: boolean, options: { welcome?: boolean } = {}): Promise<Row | null> {
    const [existing] = await this.dataSource.query(`SELECT * FROM bot_channel_user WHERE company_id = $1 AND platform = 'app' AND external_user_id = $2`, [companyId, externalId(customer.id)]);
    if (existing || !create) return existing ?? null;
    const place = await this.place(customer, companyId);
    const [user] = await this.dataSource.query(`
      INSERT INTO bot_channel_user (company_id, app_user_id, platform, external_user_id, source_account_id, display_name, language, language_locked, session_state, bot_enabled, manual_mode, last_seen_at, created_at, updated_at)
      VALUES ($1, NULL, 'app', $2, NULL, $3, 'English', false, NULL, false, false, NOW(), NOW(), NOW())
      ON CONFLICT DO NOTHING RETURNING *`, [companyId, externalId(customer.id), customer.name || this.maskedPhone(customer.phone)]);
    if (!user) return (await this.dataSource.query(`SELECT * FROM bot_channel_user WHERE company_id = $1 AND platform = 'app' AND external_user_id = $2`, [companyId, externalId(customer.id)]))[0];
    const created = user;
    if (place.welcome_text && options.welcome !== false) {
      const conversation = await this.conversation(Number(created.id));
      await this.saveMessage(conversation, 'outbound', 'text', place.welcome_text, null, 'app-welcome');
    }
    return created;
  }

  maskedPhone(phone: string) {
    return `+${phone.slice(0, -4).replace(/\d(?=\d{3})/g, '•')}${phone.slice(-4)}`;
  }

  /** latest open chat of this customer (a new one after the team closed the old one) */
  async conversation(channelUserId: number): Promise<Row> {
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

  companyFromLink(code: string): number {
    const id = Number(/^(\d+)-[\w-]{12}$/.exec(String(code ?? ''))?.[1] ?? 0);
    const expected = id ? Buffer.from(this.linkCode(id)) : Buffer.alloc(0);
    const given = Buffer.from(String(code ?? ''));
    if (!id || expected.length !== given.length || !timingSafeEqual(expected, given)) throw new NotFoundException('This chat link is not valid. Ask the business for its link again.');
    return id;
  }

  /** Opened from the business's link / QR: the business appears in the customer's list (if it added the number, or allows its link). */
  async open(customer: CustomerAccount, link: string) {
    const company = await this.appCompany({ link });
    if (!(await this.joinApp(company!, customer))) throw this.notOnList(company!.name);
    const place = await this.place(customer, company!.id);
    await this.channelUser(customer, company!.id, true);
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
       WHERE bc.bot_channel_user_id = $1 AND m.message_type::text <> 'system' AND m.source IS DISTINCT FROM 'sms' AND ($2::bigint IS NULL OR m.id < $2)
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
  mediaLink(value: string | null): string | null {
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
    await this.place(customer, companyId);
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

  /** Own channel, or the channel of a group the customer is a member of. */
  async authorizeRealtime(customer: CustomerAccount, socketId: string, channel: string) {
    const group = /^private-ca-group-(\d+)$/.exec(channel)?.[1];
    const allowed = channel === this.customerChannel(customer.id)
      || (group ? (await this.dataSource.query(`SELECT 1 FROM ca_group_member gm JOIN ca_group g ON g.id = gm.group_id AND g.archived_at IS NULL WHERE gm.group_id = $1 AND gm.account_id = $2`, [Number(group), customer.id])).length > 0 : false);
    if (!allowed) throw new ForbiddenException('You cannot listen to this channel.');
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

  /** "VORA Kids" → "vora-kids" (made once; the business can change it). */
  private async ensureSlug(companyId: number): Promise<string> {
    const [row] = await this.dataSource.query(`SELECT s.slug, c.company_name FROM companies c LEFT JOIN ca_settings s ON s.company_id = c.id WHERE c.id = $1`, [companyId]);
    if (row?.slug) return String(row.slug);
    const base = String(row?.company_name ?? 'business').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'business';
    for (const candidate of [base.length >= 3 ? base : `${base}-app`, `${base}-${companyId}`]) {
      const saved = await this.dataSource.query(`
        INSERT INTO ca_settings (company_id, enabled, slug, updated_at) VALUES ($1, FALSE, $2, NOW())
        ON CONFLICT (company_id) DO UPDATE SET slug = COALESCE(ca_settings.slug, EXCLUDED.slug) RETURNING slug`, [companyId, candidate]).catch(() => null);
      const slug = firstRow(saved)?.slug;
      if (slug) return String(slug);
    }
    return `${base}-${companyId}`;
  }

  async settings(companyId: number) {
    const slug = await this.ensureSlug(companyId);
    const [row] = await this.dataSource.query(`
      SELECT s.enabled, s.welcome_text, s.app_name, s.theme_color, s.access, s.member_dm, s.icon_key, s.dm_mode, s.dm_rules, c.company_name
        FROM ca_settings s JOIN companies c ON c.id = s.company_id WHERE s.company_id = $1`, [companyId]);
    const [stats] = await this.dataSource.query(`
      SELECT (SELECT COUNT(*)::int FROM ca_app_member WHERE company_id = $1) AS members,
             (SELECT COUNT(*)::int FROM ca_app_member m WHERE m.company_id = $1 AND m.joined_at IS NOT NULL) AS customers,
             (SELECT COUNT(*)::int FROM ca_app_member m WHERE m.company_id = $1 AND m.last_open_at > NOW() - INTERVAL '7 days') AS active_week`, [companyId]);
    return {
      enabled: Boolean(row?.enabled), welcome_text: row?.welcome_text ?? null, slug,
      app_name: row?.app_name ?? null, default_name: String(row?.company_name ?? ''), theme_color: row?.theme_color ?? null,
      access: row?.access === 'link' ? 'link' : 'invited', member_dm: Boolean(row?.member_dm),
      dm_mode: row?.dm_mode === 'roles' ? 'roles' : 'groups', dm_rules: Array.isArray(row?.dm_rules) ? row.dm_rules : [],
      icon_url: row?.icon_key ? publicChatMediaUrl(row.icon_key, 24 * 3600) : null,
      members: Number(stats?.members ?? 0), customers: Number(stats?.customers ?? 0), active_week: Number(stats?.active_week ?? 0),
    };
  }

  async saveSettings(companyId: number, input: {
    enabled?: boolean; welcome_text?: string | null; slug?: string; app_name?: string | null; theme_color?: string | null; access?: string; member_dm?: boolean;
    dm_mode?: string; dm_rules?: unknown;
  }) {
    await this.ensureSlug(companyId);
    const sets: string[] = [];
    const params: unknown[] = [companyId];
    const set = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`); };
    if (input.enabled !== undefined) set('enabled', Boolean(input.enabled));
    if (input.welcome_text !== undefined) set('welcome_text', input.welcome_text == null ? null : String(input.welcome_text).trim().slice(0, 1000) || null);
    if (input.app_name !== undefined) set('app_name', input.app_name == null ? null : String(input.app_name).trim().slice(0, 40) || null);
    if (input.theme_color !== undefined) {
      const color = input.theme_color == null ? null : String(input.theme_color).trim();
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new BadRequestException('Pick a colour like #6d4dff.');
      set('theme_color', color || null);
    }
    if (input.access !== undefined) set('access', input.access === 'link' ? 'link' : 'invited');
    if (input.member_dm !== undefined) set('member_dm', Boolean(input.member_dm));
    if (input.dm_mode !== undefined) set('dm_mode', input.dm_mode === 'roles' ? 'roles' : 'groups');
    if (input.dm_rules !== undefined) {
      const role = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9 _*-]/g, '').slice(0, 30);
      const rules = (Array.isArray(input.dm_rules) ? input.dm_rules : []).filter((p): p is unknown[] => Array.isArray(p) && p.length === 2)
        .map((p) => [role(p[0]), role(p[1])]).filter(([a, b]) => a && b).slice(0, 50);
      params.push(JSON.stringify(rules)); sets.push(`dm_rules = $${params.length}::jsonb`);
    }
    if (input.slug !== undefined) {
      const slug = String(input.slug ?? '').trim().toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug)) throw new BadRequestException('The app address can have 3–40 small letters, numbers and dashes, e.g. vora-kids.');
      if (['chat', 'app', 'admin', 'api', 'login', 'www'].includes(slug)) throw new BadRequestException('That address is reserved – try another one.');
      const [taken] = await this.dataSource.query(`SELECT 1 FROM ca_settings WHERE slug = $1 AND company_id <> $2`, [slug, companyId]);
      if (taken) throw new BadRequestException('Another business already uses this address – try another one.');
      set('slug', slug);
    }
    if (sets.length) await this.dataSource.query(`UPDATE ca_settings SET ${sets.join(', ')}, updated_at = NOW() WHERE company_id = $1`, params);
    return this.settings(companyId);
  }

  /** The home-screen icon (a square PNG the browser made from the logo). */
  async setIcon(companyId: number, file: { buffer: Buffer; mimetype: string } | null) {
    let key: string | null = null;
    if (file?.buffer?.length) {
      if (!/^image\/png$/i.test(String(file.mimetype))) throw new BadRequestException('The icon must be a PNG.');
      if (file.buffer.length > 2 * 1024 * 1024) throw new BadRequestException('The icon must be smaller than 2 MB.');
      key = saveChatMedia(companyId, file.buffer, 'image/png', 'app-icon.png');
    }
    await this.ensureSlug(companyId);
    await this.dataSource.query(`UPDATE ca_settings SET icon_key = $2, updated_at = NOW() WHERE company_id = $1`, [companyId, key]);
    return this.settings(companyId);
  }
}
