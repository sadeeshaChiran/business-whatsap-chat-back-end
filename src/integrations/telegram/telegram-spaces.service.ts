import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TelegramError, getWebhookInfo, setWebhook, telegramCall, telegramUpload, type TelegramChat } from './telegram-api';

type Row = Record<string, any>;
type Connection = { id: number; company_id: number; bot_id: string; bot_username: string | null; bot_token: string; webhook_secret: string; status: string };
type TgUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
type ChatMemberInfo = {
  status?: string; user?: TgUser; can_invite_users?: boolean; can_restrict_members?: boolean; can_post_messages?: boolean;
};
export type SpaceUpdate = {
  my_chat_member?: { chat: TelegramChat; new_chat_member?: ChatMemberInfo };
  chat_join_request?: { chat: TelegramChat; from: TgUser; user_chat_id?: number; date?: number };
  chat_member?: { chat: TelegramChat; from?: TgUser; new_chat_member?: ChatMemberInfo; old_chat_member?: ChatMemberInfo };
};

const PER_SECOND = 20;
const returned = (result: unknown): Row[] => (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : Array.isArray(result) ? result : []) as Row[];

/**
 * Telegram groups and channels of a business, only for the customers it lets in. The business creates the group / channel in
 * Telegram and makes its bot an admin ("Invite users" and "Ban users" allowed). From here it invites customers who follow its bot
 * (by tag or by hand): each gets a private message with the join link. The link only sends a join request – the bot approves
 * the invited people and declines everybody else, so a forwarded link is useless. Removing someone takes them out of the group.
 * Telegram does not let bots create groups or channels themselves.
 */
@Injectable()
export class TelegramSpacesService implements OnModuleInit {
  private readonly logger = new Logger(TelegramSpacesService.name);
  /** connections whose webhook already asks Telegram for join requests (checked once per server start) */
  private readonly webhookChecked = new Set<number>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  onModuleInit() {
    void this.dataSource.query(`UPDATE telegram_space SET invite_status = 'stopped' WHERE invite_status = 'sending'`).catch(() => undefined);
  }

  private why(error: unknown) {
    return error instanceof Error ? error.message.replace(/^Telegram:\s*/, '') : String(error);
  }

  private async connection(companyId: number): Promise<Connection> {
    const [row] = await this.dataSource.query(`SELECT * FROM telegram_connection WHERE company_id = $1 AND status = 'CONNECTED' ORDER BY updated_at DESC LIMIT 1`, [companyId]);
    if (!row) throw new BadRequestException('Connect your Telegram bot first (Channels → Telegram).');
    return row;
  }

  /** Older connections were set up without join requests – ask Telegram for them now (keeps everything else the same). */
  private async ensureWebhook(row: Connection) {
    if (this.webhookChecked.has(Number(row.id))) return;
    try {
      const info = await getWebhookInfo(row.bot_token) as { url: string; allowed_updates?: string[] };
      const wanted = ['chat_join_request', 'chat_member'];
      if (info.url && wanted.some((u) => !(info.allowed_updates ?? []).includes(u))) await setWebhook(row.bot_token, info.url, row.webhook_secret);
      this.webhookChecked.add(Number(row.id));
    } catch (error) {
      this.logger.warn(`Telegram webhook check failed: ${this.why(error)}`);
    }
  }

  /* ───────────────────────── updates from Telegram ───────────────────────── */

  /** The bot was added to / removed from a group or channel, or its admin rights changed. */
  async onBotMember(row: Connection, chat: TelegramChat, member: ChatMemberInfo | undefined) {
    if (chat.type === 'private') return;
    const status = String(member?.status ?? 'left');
    const admin = status === 'administrator' || status === 'creator';
    if (!admin && !(await this.dataSource.query(`SELECT 1 FROM telegram_space WHERE connection_id = $1 AND chat_id = $2`, [row.id, String(chat.id)])).length) return;
    await this.dataSource.query(`
      INSERT INTO telegram_space (company_id, connection_id, chat_id, type, title, username, bot_status, can_invite, can_restrict, can_post)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (connection_id, chat_id) DO UPDATE SET type = EXCLUDED.type, title = COALESCE(EXCLUDED.title, telegram_space.title), username = EXCLUDED.username,
        bot_status = EXCLUDED.bot_status, can_invite = EXCLUDED.can_invite, can_restrict = EXCLUDED.can_restrict, can_post = EXCLUDED.can_post, updated_at = NOW()`,
    [row.company_id, row.id, String(chat.id), chat.type, chat.title ?? null, chat.username ?? null, status,
      status === 'creator' || Boolean(member?.can_invite_users), status === 'creator' || Boolean(member?.can_restrict_members),
      chat.type !== 'channel' || status === 'creator' || member?.can_post_messages !== false]);
  }

  /** Someone opened the join link: invited people are let in, everybody else is declined (and told why). */
  async onJoinRequest(row: Connection, request: NonNullable<SpaceUpdate['chat_join_request']>): Promise<number> {
    const [space] = await this.dataSource.query(`SELECT * FROM telegram_space WHERE connection_id = $1 AND chat_id = $2`, [row.id, String(request.chat.id)]);
    if (!space) return 0;
    const [person] = await this.dataSource.query(`
      SELECT cu.id, a.status, COALESCE(cc.tags, '{}') AS tags FROM bot_channel_user cu
        LEFT JOIN telegram_space_access a ON a.space_id = $3 AND a.channel_user_id = cu.id
        LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
       WHERE cu.company_id = $1 AND cu.platform = 'telegram' AND cu.source_account_id = $2 AND cu.external_user_id = $4`,
    [row.company_id, row.bot_id, space.id, String(request.from.id)]);
    const byTag = person && (space.audience_tags ?? []).length && (person.tags as string[]).some((t) => (space.audience_tags as string[]).includes(t));
    const allowed = !space.members_only || (person && (['invited', 'joined', 'left'].includes(String(person.status)) || (byTag && person.status !== 'removed')));
    const params = { chat_id: request.chat.id, user_id: request.from.id };
    try {
      await telegramCall(row.bot_token, allowed ? 'approveChatJoinRequest' : 'declineChatJoinRequest', params);
    } catch (error) {
      this.logger.warn(`Telegram join request ${allowed ? 'approve' : 'decline'} failed: ${this.why(error)}`);
      return 0;
    }
    if (person) {
      await this.dataSource.query(`
        INSERT INTO telegram_space_access (space_id, channel_user_id, status, joined_at, updated_at) VALUES ($1, $2, $3::text, CASE WHEN $3::text = 'joined' THEN NOW() END, NOW())
        ON CONFLICT (space_id, channel_user_id) DO UPDATE SET status = CASE WHEN EXCLUDED.status = 'declined' AND telegram_space_access.status = 'removed' THEN 'removed' ELSE EXCLUDED.status END,
          joined_at = COALESCE(EXCLUDED.joined_at, telegram_space_access.joined_at), updated_at = NOW()`,
      [space.id, person.id, allowed ? 'joined' : 'declined']).catch((error) => this.logger.warn(`Telegram join record failed: ${this.why(error)}`));
    }
    if (!allowed) {
      // Telegram lets the bot message someone for a few minutes after their join request, even if they never started it
      const [company] = await this.dataSource.query(`SELECT company_name FROM companies WHERE id = $1`, [row.company_id]).catch(() => [null]);
      await telegramCall(row.bot_token, 'sendMessage', {
        chat_id: request.user_chat_id ?? request.from.id,
        text: `Sorry – "${space.title ?? 'this group'}" is only for ${company?.company_name ?? 'our'} customers who were invited. Send us a message here if you would like to join.`,
      }).catch(() => undefined);
    }
    return 1;
  }

  /** Joined / left / removed inside Telegram (needs the bot to be an admin). */
  async onMember(row: Connection, update: NonNullable<SpaceUpdate['chat_member']>): Promise<number> {
    const user = update.new_chat_member?.user;
    if (!user || user.is_bot) return 0;
    const status = String(update.new_chat_member?.status ?? '');
    const next = ['member', 'administrator', 'creator', 'restricted'].includes(status) ? 'joined' : status === 'kicked' ? 'removed' : status === 'left' ? 'left' : null;
    if (!next) return 0;
    // members only: someone who got in without an invite (a public @username, an old link) is taken out again
    if (next === 'joined' && !['administrator', 'creator'].includes(status)) {
      const [space] = await this.dataSource.query(`SELECT * FROM telegram_space WHERE connection_id = $1 AND chat_id = $2`, [row.id, String(update.chat.id)]);
      if (space?.members_only) {
        const [person] = await this.dataSource.query(`
          SELECT a.status, COALESCE(cc.tags, '{}') AS tags FROM bot_channel_user cu
            LEFT JOIN telegram_space_access a ON a.space_id = $3 AND a.channel_user_id = cu.id LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
           WHERE cu.company_id = $1 AND cu.platform = 'telegram' AND cu.source_account_id = $2 AND cu.external_user_id = $4`,
        [row.company_id, row.bot_id, space.id, String(user.id)]);
        const byTag = person && person.status !== 'removed' && (space.audience_tags ?? []).length && (person.tags as string[]).some((t) => (space.audience_tags as string[]).includes(t));
        const allowed = person && (['invited', 'joined', 'left'].includes(String(person.status)) || byTag);
        if (!allowed) {
          try {
            await telegramCall(row.bot_token, 'banChatMember', { chat_id: update.chat.id, user_id: user.id, revoke_messages: false });
            await telegramCall(row.bot_token, 'unbanChatMember', { chat_id: update.chat.id, user_id: user.id, only_if_banned: true });
          } catch (error) {
            this.logger.warn(`Telegram: could not remove an uninvited member: ${this.why(error)}`);
          }
          return 1;
        }
      }
    }
    const result = await this.dataSource.query(`
      UPDATE telegram_space_access a SET status = CASE WHEN a.status = 'removed' AND $4::text = 'left' THEN 'removed' ELSE $4::text END,
             joined_at = CASE WHEN $4::text = 'joined' THEN COALESCE(a.joined_at, NOW()) ELSE a.joined_at END, updated_at = NOW()
        FROM telegram_space s, bot_channel_user cu
       WHERE s.id = a.space_id AND s.connection_id = $1 AND s.chat_id = $2 AND cu.id = a.channel_user_id AND cu.external_user_id = $3 AND cu.platform = 'telegram'
       RETURNING a.space_id`, [row.id, String(update.chat.id), String(user.id), next]);
    return returned(result).length;
  }

  /* ───────────────────────── business: list, settings ───────────────────────── */

  async list(companyId: number) {
    const row = await this.connection(companyId);
    await this.ensureWebhook(row);
    const rows: Row[] = await this.dataSource.query(`
      SELECT s.*, (SELECT COUNT(*)::int FROM telegram_space_access a WHERE a.space_id = s.id AND a.status = 'joined') AS joined,
             (SELECT COUNT(*)::int FROM telegram_space_access a WHERE a.space_id = s.id AND a.status = 'invited') AS invited
        FROM telegram_space s WHERE s.company_id = $1 AND s.connection_id = $2 ORDER BY (s.bot_status IN ('administrator', 'creator')) DESC, s.created_at DESC`, [companyId, row.id]);
    return {
      bot_username: row.bot_username,
      items: rows.map((s) => this.view(s)),
    };
  }

  private view(s: Row) {
    const admin = s.bot_status === 'administrator' || s.bot_status === 'creator';
    const problems = [
      !admin ? 'The bot is not an admin here any more.' : null,
      admin && !s.can_invite ? 'Allow the bot to "Invite users via link".' : null,
      admin && !s.can_restrict ? 'Allow the bot to "Ban users" (needed to remove people).' : null,
      admin && s.type === 'channel' && !s.can_post ? 'Allow the bot to "Post messages" to post from here.' : null,
    ].filter(Boolean);
    return {
      id: Number(s.id), type: s.type, title: s.title, username: s.username, public_link: s.username ? `https://t.me/${s.username}` : null,
      members_only: Boolean(s.members_only), audience_tags: s.audience_tags ?? [], has_invite_link: Boolean(s.invite_link), ready: admin && s.can_invite,
      problems, member_count: s.member_count == null ? null : Number(s.member_count), joined: Number(s.joined ?? 0), invited: Number(s.invited ?? 0),
      invite: s.invite_status ? { status: s.invite_status, total: Number(s.invite_total), sent: Number(s.invite_sent), failed: Number(s.invite_failed) } : null,
    };
  }

  private async space(companyId: number, id: number) {
    const [s] = await this.dataSource.query(`SELECT * FROM telegram_space WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (!s) throw new NotFoundException('This Telegram group / channel is not linked.');
    const row = await this.connection(companyId);
    if (Number(s.connection_id) !== Number(row.id)) throw new BadRequestException('This group belongs to a Telegram bot you disconnected.');
    return { s: s as Row, row };
  }

  /** Read the group / channel again from Telegram (title, the bot's rights, how many people are in it). */
  async refresh(companyId: number, id: number) {
    const { s, row } = await this.space(companyId, id);
    try {
      const chat = await telegramCall<TelegramChat>(row.bot_token, 'getChat', { chat_id: s.chat_id });
      const me = await telegramCall<ChatMemberInfo>(row.bot_token, 'getChatMember', { chat_id: s.chat_id, user_id: Number(row.bot_id) });
      await this.onBotMember(row, chat, me);
      const count = await telegramCall<number>(row.bot_token, 'getChatMemberCount', { chat_id: s.chat_id }).catch(() => null);
      if (count != null) await this.dataSource.query(`UPDATE telegram_space SET member_count = $2 WHERE id = $1`, [id, count]);
    } catch (error) {
      if (error instanceof TelegramError && (error.code === 400 || error.code === 403)) {
        await this.dataSource.query(`UPDATE telegram_space SET bot_status = 'left', updated_at = NOW() WHERE id = $1`, [id]);
      } else throw new BadRequestException(this.why(error));
    }
    return this.one(companyId, id);
  }

  private async one(companyId: number, id: number) {
    const [s] = await this.dataSource.query(`
      SELECT s.*, (SELECT COUNT(*)::int FROM telegram_space_access a WHERE a.space_id = s.id AND a.status = 'joined') AS joined,
             (SELECT COUNT(*)::int FROM telegram_space_access a WHERE a.space_id = s.id AND a.status = 'invited') AS invited
        FROM telegram_space s WHERE s.id = $1 AND s.company_id = $2`, [id, companyId]);
    return this.view(s);
  }

  /** A public group / channel by its @username or t.me link (private ones appear by themselves when the bot is made admin). */
  async link(companyId: number, input: string) {
    const row = await this.connection(companyId);
    await this.ensureWebhook(row);
    const value = String(input ?? '').trim().replace(/^https?:\/\/(t|telegram)\.me\//i, '').replace(/\/.*$/, '');
    if (!value) throw new BadRequestException('Type the @username or t.me link.');
    const chatId = /^-?\d+$/.test(value) ? value : `@${value.replace(/^@/, '')}`;
    let chat: TelegramChat;
    try {
      chat = await telegramCall<TelegramChat>(row.bot_token, 'getChat', { chat_id: chatId });
    } catch {
      throw new BadRequestException(`Telegram can not find it for your bot. Add @${row.bot_username ?? 'your bot'} to the group / channel as an admin first.`);
    }
    if (chat.type === 'private') throw new BadRequestException('That is a person, not a group or channel.');
    const me = await telegramCall<ChatMemberInfo>(row.bot_token, 'getChatMember', { chat_id: chat.id, user_id: Number(row.bot_id) }).catch(() => ({ status: 'left' }));
    if (!(me.status === 'administrator' || me.status === 'creator')) throw new BadRequestException(`Make @${row.bot_username ?? 'your bot'} an admin there first, then try again.`);
    await this.onBotMember(row, chat, me);
    const [s] = await this.dataSource.query(`SELECT id FROM telegram_space WHERE connection_id = $1 AND chat_id = $2`, [row.id, String(chat.id)]);
    return this.refresh(companyId, Number(s.id));
  }

  async settings(companyId: number, id: number, input: { members_only?: unknown; audience_tags?: unknown }) {
    const { s } = await this.space(companyId, id);
    const membersOnly = input.members_only === undefined ? Boolean(s.members_only) : input.members_only === true || input.members_only === 'true';
    const tags = input.audience_tags === undefined ? s.audience_tags
      : (Array.isArray(input.audience_tags) ? input.audience_tags : String(input.audience_tags ?? '').split(',')).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
    await this.dataSource.query(`UPDATE telegram_space SET members_only = $2, audience_tags = $3, updated_at = NOW() WHERE id = $1`, [id, membersOnly, tags]);
    return this.one(companyId, id);
  }

  /** Stop managing it here (the group itself stays in Telegram – remove the bot there if you want). */
  async unlink(companyId: number, id: number) {
    await this.space(companyId, id).catch(() => undefined);
    await this.dataSource.query(`DELETE FROM telegram_space_access WHERE space_id IN (SELECT id FROM telegram_space WHERE id = $1 AND company_id = $2)`, [id, companyId]);
    await this.dataSource.query(`DELETE FROM telegram_space WHERE id = $1 AND company_id = $2`, [id, companyId]);
    return { unlinked: true };
  }

  /** The space's join link: it only creates join requests, the bot decides who gets in. */
  private async inviteLink(s: Row, row: Connection) {
    if (s.invite_link) return String(s.invite_link);
    try {
      const made = await telegramCall<{ invite_link: string }>(row.bot_token, 'createChatInviteLink', { chat_id: s.chat_id, name: 'Customers', creates_join_request: true });
      await this.dataSource.query(`UPDATE telegram_space SET invite_link = $2 WHERE id = $1`, [s.id, made.invite_link]);
      return made.invite_link;
    } catch (error) {
      throw new BadRequestException(`Telegram did not make a join link: ${this.why(error)}. Allow the bot to "Invite users via link".`);
    }
  }

  /* ───────────────────────── people ───────────────────────── */

  async members(companyId: number, id: number) {
    await this.space(companyId, id);
    const rows: Row[] = await this.dataSource.query(`
      SELECT cu.id, COALESCE(NULLIF(cu.display_name, ''), 'Telegram customer') AS name, a.status, a.invited_at, a.joined_at, COALESCE(cc.tags, '{}') AS tags
        FROM telegram_space_access a JOIN bot_channel_user cu ON cu.id = a.channel_user_id LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
       WHERE a.space_id = $1 ORDER BY CASE a.status WHEN 'joined' THEN 0 WHEN 'invited' THEN 1 WHEN 'declined' THEN 2 ELSE 3 END, a.updated_at DESC LIMIT 1000`, [id]);
    return rows.map((r) => ({ channel_user_id: Number(r.id), name: r.name, status: r.status, invited_at: r.invited_at, joined_at: r.joined_at, tags: r.tags }));
  }

  /** Followers of the bot who can be invited (not blocked). */
  async candidates(companyId: number, id: number, search = '') {
    const { row } = await this.space(companyId, id);
    const q = `%${search.trim().toLowerCase()}%`;
    const rows: Row[] = await this.dataSource.query(`
      SELECT cu.id, COALESCE(NULLIF(cu.display_name, ''), 'Telegram customer') AS name, COALESCE(cc.tags, '{}') AS tags, a.status
        FROM bot_channel_user cu LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
        LEFT JOIN telegram_subscriber_state st ON st.channel_user_id = cu.id
        LEFT JOIN telegram_space_access a ON a.space_id = $3 AND a.channel_user_id = cu.id
       WHERE cu.company_id = $1 AND cu.platform = 'telegram' AND cu.source_account_id = $2 AND st.blocked_at IS NULL
         AND ($4 = '%%' OR LOWER(COALESCE(cu.display_name, '')) LIKE $4)
       ORDER BY cu.last_seen_at DESC NULLS LAST LIMIT 300`, [companyId, row.bot_id, id, q]);
    return rows.map((r) => ({ channel_user_id: Number(r.id), name: r.name, tags: r.tags, status: r.status ?? null }));
  }

  /**
   * Invite followers (chosen ones, by tag, or all): they may join from now on, and each gets the join link in a private message
   * (sent in the background, ~20 a second).
   */
  async invite(companyId: number, id: number, input: { channel_user_ids?: unknown; tags?: unknown; all?: unknown; message?: unknown }) {
    const { s, row } = await this.space(companyId, id);
    if (!(s.bot_status === 'administrator' || s.bot_status === 'creator')) throw new BadRequestException('Make the bot an admin of this group / channel again first.');
    if (s.invite_status === 'sending') throw new BadRequestException('Invites are still being sent – wait a moment.');
    const ids = (Array.isArray(input.channel_user_ids) ? input.channel_user_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 10000);
    const tags = (Array.isArray(input.tags) ? input.tags : String(input.tags ?? '').split(',')).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
    const all = input.all === true || input.all === 'true';
    if (!ids.length && !tags.length && !all) throw new BadRequestException('Choose people, a tag or "all followers".');
    const link = await this.inviteLink(s, row);
    const people: Row[] = await this.dataSource.query(`
      SELECT cu.id, cu.external_user_id AS chat_id, COALESCE(NULLIF(cu.display_name, ''), '') AS name
        FROM bot_channel_user cu LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
        LEFT JOIN telegram_subscriber_state st ON st.channel_user_id = cu.id
        LEFT JOIN telegram_space_access a ON a.space_id = $5 AND a.channel_user_id = cu.id
       WHERE cu.company_id = $1 AND cu.platform = 'telegram' AND cu.source_account_id = $2 AND st.blocked_at IS NULL
         AND COALESCE(a.status, '') <> 'joined'
         AND (cu.id = ANY($3::int[])
              OR (COALESCE(a.status, '') <> 'removed' AND ($6 OR (COALESCE(array_length($4::text[], 1), 0) > 0 AND COALESCE(cc.tags, '{}') && $4::text[]))))`,
    [companyId, row.bot_id, ids, tags, id, all]);
    if (!people.length) throw new BadRequestException('Nobody to invite – everyone chosen is already in, or they don\'t follow your bot yet.');
    for (const p of people) {
      await this.dataSource.query(`
        INSERT INTO telegram_space_access (space_id, channel_user_id, status, invited_at, updated_at) VALUES ($1, $2, 'invited', NOW(), NOW())
        ON CONFLICT (space_id, channel_user_id) DO UPDATE SET status = 'invited', invited_at = NOW(), updated_at = NOW()`, [id, p.id]);
    }
    await this.dataSource.query(`UPDATE telegram_space SET invite_status = 'sending', invite_total = $2, invite_sent = 0, invite_failed = 0 WHERE id = $1`, [id, people.length]);
    const note = String(input.message ?? '').trim().slice(0, 900);
    void this.sendInvites(row, s, link, note, people).catch((error) => this.logger.error(`Telegram invites failed: ${this.why(error)}`));
    return { invited: people.length };
  }

  private async sendInvites(row: Connection, s: Row, link: string, note: string, people: Row[]) {
    const kind = s.type === 'channel' ? 'channel' : 'group';
    let sent = 0;
    let failed = 0;
    const gap = Math.ceil(1000 / PER_SECOND);
    for (const person of people) {
      const started = Date.now();
      const first = person.name && person.name !== 'Telegram customer' && !String(person.name).startsWith('@') ? String(person.name).split(' ')[0] : '';
      const text = `${note ? `${note.replace(/\{name\}/gi, first || 'there')}\n\n` : `Hi${first ? ` ${first}` : ''}! `}You are invited to our ${kind} "${s.title ?? ''}". Tap the button to join.`;
      try {
        await telegramCall(row.bot_token, 'sendMessage', { chat_id: person.chat_id, text, reply_markup: { inline_keyboard: [[{ text: `Join the ${kind}`, url: link }]] } });
        sent += 1;
      } catch (error) {
        failed += 1;
        if (error instanceof TelegramError && error.code === 429 && (error.retryAfter ?? 0) <= 30) await new Promise((r) => setTimeout(r, (error.retryAfter ?? 1) * 1000));
      }
      if ((sent + failed) % 20 === 0) await this.dataSource.query(`UPDATE telegram_space SET invite_sent = $2, invite_failed = $3 WHERE id = $1`, [s.id, sent, failed]);
      const wait = gap - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    await this.dataSource.query(`UPDATE telegram_space SET invite_status = 'sent', invite_sent = $2, invite_failed = $3 WHERE id = $1`, [s.id, sent, failed]);
  }

  /** Take someone out (and they can't come back with the link unless invited again). */
  async remove(companyId: number, id: number, channelUserId: number) {
    const { s, row } = await this.space(companyId, id);
    const [person] = await this.dataSource.query(`SELECT external_user_id FROM bot_channel_user WHERE id = $1 AND company_id = $2 AND platform = 'telegram'`, [channelUserId, companyId]);
    if (!person) throw new NotFoundException('Person not found.');
    try {
      await telegramCall(row.bot_token, 'banChatMember', { chat_id: s.chat_id, user_id: Number(person.external_user_id), revoke_messages: false });
      // a short ban = removed but may come back later if the business invites them again
      await telegramCall(row.bot_token, 'unbanChatMember', { chat_id: s.chat_id, user_id: Number(person.external_user_id), only_if_banned: true });
    } catch (error) {
      if (!(error instanceof TelegramError && /not found|USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID/i.test(error.message))) throw new BadRequestException(`Telegram: ${this.why(error)}`);
    }
    await this.dataSource.query(`
      INSERT INTO telegram_space_access (space_id, channel_user_id, status, updated_at) VALUES ($1, $2, 'removed', NOW())
      ON CONFLICT (space_id, channel_user_id) DO UPDATE SET status = 'removed', updated_at = NOW()`, [id, channelUserId]);
    return { removed: true };
  }

  /** Post into the group / channel as the bot (text and an optional photo). */
  async post(companyId: number, id: number, input: { text?: string; photo?: { buffer: Buffer; mimetype: string; fileName: string } | null }) {
    const { s, row } = await this.space(companyId, id);
    const text = String(input.text ?? '').trim();
    if (!text && !input.photo) throw new BadRequestException('Write the message.');
    if (text.length > (input.photo ? 1024 : 4096)) throw new BadRequestException(`Up to ${input.photo ? 1024 : 4096} characters${input.photo ? ' with a photo' : ''}.`);
    try {
      const result = input.photo
        ? await telegramUpload<{ message_id: number }>(row.bot_token, 'sendPhoto', 'photo', input.photo, { chat_id: s.chat_id, caption: text || undefined })
        : await telegramCall<{ message_id: number }>(row.bot_token, 'sendMessage', { chat_id: s.chat_id, text });
      return { posted: true, message_id: result.message_id };
    } catch (error) {
      throw new BadRequestException(`Telegram: ${this.why(error)}`);
    }
  }
}
