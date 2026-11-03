import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomBytes, timingSafeEqual } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { BotChannelUser } from '../../bot-admin/entities/bot-channel-user.entity';
import { BotConversation } from '../../bot-admin/entities/bot-conversation.entity';
import { BotMessage } from '../../bot-admin/entities/bot-message.entity';
import { mimeFromName, readChatMedia, saveChatMedia } from '../../bot-admin/chat-media.store';
import { PusherService } from '../../common/pusher.service';
import { SalesBotHook } from '../../common/sales-bot-hook';
import { TelegramHook, type TelegramFile, type TelegramSendTarget } from '../../common/telegram-hook';
import {
  TelegramError, deleteWebhook, downloadTelegramFile, getMe, getWebhookInfo, looksLikeBotToken, sendMethodFor, setWebhook, telegramCall, telegramUpload,
  type TelegramChat,
} from './telegram-api';
import { TelegramSpacesService, type SpaceUpdate } from './telegram-spaces.service';

export type TelegramConnection = {
  id: number; company_id: number; bot_id: string; bot_username: string | null; bot_name: string | null; bot_token: string; webhook_secret: string;
  status: string; last_error: string | null; last_event_at: Date | null; welcome_text: string | null;
  channel_chat_id: string | null; channel_title: string | null; channel_username: string | null; created_at: Date; updated_at: Date;
};

type TgUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
type TgPhoto = { file_id: string; file_size?: number; width?: number; height?: number };
type TgMessage = {
  message_id: number; date: number; chat: TelegramChat; from?: TgUser; text?: string; caption?: string;
  photo?: TgPhoto[]; document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  video?: { file_id: string; mime_type?: string; file_size?: number; file_name?: string }; voice?: { file_id: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number }; video_note?: { file_id: string; file_size?: number };
  sticker?: { emoji?: string }; location?: { latitude: number; longitude: number }; venue?: { title?: string; address?: string; location: { latitude: number; longitude: number } };
  contact?: { phone_number: string; first_name?: string; last_name?: string }; reply_to_message?: { message_id: number };
};
export type TelegramUpdate = {
  update_id?: number; message?: TgMessage; edited_message?: TgMessage;
  my_chat_member?: { chat: TelegramChat; from?: TgUser; new_chat_member?: { status?: string; user?: TgUser; can_post_messages?: boolean; can_invite_users?: boolean; can_restrict_members?: boolean } };
} & Pick<SpaceUpdate, 'chat_join_request' | 'chat_member'>;

/** Telegram limits: text 4096 characters, photo / file caption 1024, ~30 messages a second per bot. */
export const TELEGRAM_LIMITS = { text: 4096, caption: 1024, perSecond: 20, photoBytes: 10 * 1024 * 1024, fileBytes: 50 * 1024 * 1024 };
const DEFAULT_WELCOME = 'Hi {name}! 👋 Thanks for following {business} on Telegram. You will get our updates here, and you can message us any time.';

/**
 * Telegram: a business connects its own bot (token from @BotFather). Customers who start the bot reach the inbox; agents and
 * the AI sales bot reply. Announcements go to a linked Telegram channel and / or to everyone who started the bot – free.
 * Nothing here runs for WhatsApp, Messenger, Instagram or TikTok.
 */
@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private readonly pusher = new PusherService();
  /** updates of one chat are handled one after another, so a slow photo download never puts messages out of order */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(BotChannelUser) private readonly userRepository: Repository<BotChannelUser>,
    @InjectRepository(BotConversation) private readonly conversationRepository: Repository<BotConversation>,
    @InjectRepository(BotMessage) private readonly messageRepository: Repository<BotMessage>,
    private readonly spaces: TelegramSpacesService,
  ) {}

  onModuleInit() {
    TelegramHook.register({
      sendText: (target, text) => this.sendText(target, text),
      sendFile: (target, file) => this.sendFile(target, file),
    });
    // an announcement that was still sending when the server stopped is closed with a clear note (it is not sent twice)
    void this.dataSource.query(`
      UPDATE telegram_announcement SET status = 'cancelled', finished_at = NOW(),
             last_error = COALESCE(last_error, 'Stopped by a server restart – the people counted as delivered got it; send a new one for the rest.')
       WHERE status = 'sending' AND created_at < NOW() - INTERVAL '1 minute'`).catch(() => undefined);
  }

  /* ───────────────────────── addresses ───────────────────────── */

  private apiPublic(): string {
    return String(process.env.PUBLIC_API_BASE_URL ?? '').trim().replace(/\/+$/, '');
  }
  webhookUrl(connectionId: number): string { return `${this.apiPublic()}/integrations/telegram/webhook/${connectionId}`; }
  startLink(row: Pick<TelegramConnection, 'bot_username'>, payload?: string): string | null {
    return row.bot_username ? `https://t.me/${row.bot_username}${payload ? `?start=${encodeURIComponent(payload)}` : ''}` : null;
  }

  /* ───────────────────────── connection ───────────────────────── */

  async connection(companyId: number): Promise<TelegramConnection | null> {
    const [row] = await this.dataSource.query(`SELECT * FROM telegram_connection WHERE company_id = $1 ORDER BY (status = 'CONNECTED') DESC, updated_at DESC LIMIT 1`, [companyId]);
    return row ?? null;
  }

  private async connectionFor(companyId: number, botId: string | null): Promise<TelegramConnection> {
    const [row] = botId
      ? await this.dataSource.query(`SELECT * FROM telegram_connection WHERE company_id = $1 AND bot_id = $2 LIMIT 1`, [companyId, botId])
      : await this.dataSource.query(`SELECT * FROM telegram_connection WHERE company_id = $1 AND status = 'CONNECTED' ORDER BY updated_at DESC LIMIT 1`, [companyId]);
    if (!row) throw new BadRequestException('Connect your Telegram bot first (Channels → Telegram).');
    if (row.status === 'DISCONNECTED') throw new BadRequestException('This Telegram bot is disconnected. Connect it again in Channels → Telegram.');
    return row;
  }

  /** Paste the bot token from @BotFather → check it, save it and point the bot's webhook at this server. */
  async connect(companyId: number, userId: number, rawToken: string) {
    const token = String(rawToken ?? '').trim();
    if (!looksLikeBotToken(token)) throw new BadRequestException('That is not a bot token. In Telegram open @BotFather, send /newbot (or /token) and copy the whole token, e.g. 123456789:AAH…');
    if (!this.apiPublic()) throw new BadRequestException('PUBLIC_API_BASE_URL is not set on the server.');
    const bot = await getMe(token).catch((error: unknown) => {
      throw new BadRequestException(error instanceof TelegramError && error.code === 401 ? 'Telegram does not know this token – copy it again from @BotFather.' : this.why(error));
    });
    const botId = String(bot.id);
    const [owner] = await this.dataSource.query(`SELECT company_id FROM telegram_connection WHERE bot_id = $1`, [botId]);
    if (owner && Number(owner.company_id) !== companyId) throw new BadRequestException('This Telegram bot is already connected to another business on Agent Metra.');
    // one bot per business: another bot of this company is switched off (its chats stay)
    await this.dataSource.query(`UPDATE telegram_connection SET status = 'DISCONNECTED', updated_at = NOW() WHERE company_id = $1 AND bot_id <> $2`, [companyId, botId]);
    const secret = randomBytes(24).toString('hex');
    const [row] = await this.dataSource.query(`
      INSERT INTO telegram_connection (company_id, bot_id, bot_username, bot_name, bot_token, webhook_secret, status, last_error, connected_by)
      VALUES ($1, $2, $3, $4, $5, $6, 'CONNECTED', NULL, $7)
      ON CONFLICT (bot_id) DO UPDATE SET bot_username = EXCLUDED.bot_username, bot_name = EXCLUDED.bot_name, bot_token = EXCLUDED.bot_token,
        webhook_secret = EXCLUDED.webhook_secret, status = 'CONNECTED', last_error = NULL, connected_by = EXCLUDED.connected_by, updated_at = NOW()
       WHERE telegram_connection.company_id = EXCLUDED.company_id
      RETURNING *`, [companyId, botId, bot.username ?? null, bot.first_name ?? null, token, secret, userId]);
    if (!row) throw new BadRequestException('This Telegram bot is already connected to another business on Agent Metra.');
    try {
      await setWebhook(token, this.webhookUrl(Number(row.id)), secret);
    } catch (error) {
      const why = this.why(error);
      await this.dataSource.query(`UPDATE telegram_connection SET status = 'DISCONNECTED', last_error = $2, updated_at = NOW() WHERE id = $1`, [row.id, why]);
      throw new BadRequestException(/https/i.test(why) ? 'Telegram needs the server address to start with https:// (PUBLIC_API_BASE_URL).' : why);
    }
    return this.status(companyId);
  }

  async disconnect(companyId: number) {
    const row = await this.connection(companyId);
    if (row) await deleteWebhook(row.bot_token).catch(() => undefined);
    await this.dataSource.query(`UPDATE telegram_connection SET status = 'DISCONNECTED', updated_at = NOW() WHERE company_id = $1`, [companyId]);
    return { disconnected: true };
  }

  async saveSettings(companyId: number, settings: { welcome_text?: string | null }) {
    const row = await this.connectionFor(companyId, null);
    const welcome = settings.welcome_text == null ? null : String(settings.welcome_text).trim().slice(0, 1000) || null;
    await this.dataSource.query(`UPDATE telegram_connection SET welcome_text = $2, updated_at = NOW() WHERE id = $1`, [row.id, welcome]);
    return this.status(companyId);
  }

  /** Channels page: the bot, its start link, the linked channel and how many customers follow it. */
  async status(companyId: number) {
    const row = await this.connection(companyId);
    const [stats] = row ? await this.dataSource.query(`
      SELECT COUNT(DISTINCT cu.id)::int AS customers,
             COUNT(DISTINCT cu.id) FILTER (WHERE s.blocked_at IS NOT NULL)::int AS blocked,
             MAX(cu.last_seen_at) AS last_received_at
        FROM bot_channel_user cu LEFT JOIN telegram_subscriber_state s ON s.channel_user_id = cu.id
       WHERE cu.company_id = $1 AND cu.platform = 'telegram' AND cu.source_account_id = $2`, [companyId, row.bot_id]) : [null];
    return {
      webhook_ready: Boolean(this.apiPublic()),
      default_welcome: DEFAULT_WELCOME,
      limits: { text: TELEGRAM_LIMITS.text, caption: TELEGRAM_LIMITS.caption, file_mb: 50, photo_mb: 10 },
      connection: row ? {
        bot_id: row.bot_id, bot_username: row.bot_username, bot_name: row.bot_name, status: row.status, last_error: row.last_error,
        last_event_at: row.last_event_at, connected_at: row.created_at, welcome_text: row.welcome_text,
        start_link: this.startLink(row),
        channel: row.channel_chat_id ? { chat_id: row.channel_chat_id, title: row.channel_title, username: row.channel_username, link: row.channel_username ? `https://t.me/${row.channel_username}` : null } : null,
        customers: Number(stats?.customers ?? 0), blocked: Number(stats?.blocked ?? 0), subscribers: Number(stats?.customers ?? 0) - Number(stats?.blocked ?? 0),
        last_received_at: stats?.last_received_at ?? null,
      } : null,
    };
  }

  /** "Check connection": the token, the webhook address and Telegram's last delivery error. */
  async check(companyId: number) {
    const row = await this.connection(companyId);
    if (!row || row.status === 'DISCONNECTED') throw new BadRequestException('Connect your Telegram bot first.');
    const steps: Array<{ name: string; ok: boolean; detail: string }> = [];
    try {
      const bot = await getMe(row.bot_token);
      await this.dataSource.query(`UPDATE telegram_connection SET bot_username = $2, bot_name = $3, updated_at = NOW() WHERE id = $1`, [row.id, bot.username ?? row.bot_username, bot.first_name ?? row.bot_name]);
      steps.push({ name: 'Bot', ok: true, detail: `@${bot.username ?? row.bot_username}` });
    } catch (error) {
      steps.push({ name: 'Bot', ok: false, detail: this.why(error) });
      return { ok: false, steps };
    }
    try {
      let info = await getWebhookInfo(row.bot_token);
      if (info.url !== this.webhookUrl(Number(row.id))) {
        await setWebhook(row.bot_token, this.webhookUrl(Number(row.id)), row.webhook_secret);
        info = await getWebhookInfo(row.bot_token);
      }
      const recentError = info.last_error_date && Date.now() / 1000 - info.last_error_date < 3600 ? info.last_error_message : null;
      steps.push({ name: 'Webhook', ok: !recentError, detail: recentError ? `Telegram could not reach the server: ${recentError}` : info.url });
    } catch (error) {
      steps.push({ name: 'Webhook', ok: false, detail: this.why(error) });
    }
    if (row.channel_chat_id) {
      try {
        const member = await telegramCall<{ status: string; can_post_messages?: boolean }>(row.bot_token, 'getChatMember', { chat_id: row.channel_chat_id, user_id: Number(row.bot_id) });
        const ok = member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages !== false);
        steps.push({ name: 'Channel', ok, detail: ok ? (row.channel_title ?? row.channel_chat_id) : 'The bot is no longer an admin who can post in the channel.' });
      } catch (error) {
        steps.push({ name: 'Channel', ok: false, detail: this.why(error) });
      }
    }
    return { ok: steps.every((step) => step.ok), steps };
  }

  /** Link a Telegram channel: the bot must be an admin of it who can post (by @username, t.me link or the -100… id). */
  async linkChannel(companyId: number, input: string) {
    const row = await this.connectionFor(companyId, null);
    const value = String(input ?? '').trim().replace(/^https?:\/\/(t|telegram)\.me\//i, '').replace(/\/.*$/, '');
    if (!value) throw new BadRequestException('Type the channel @username or link.');
    const chatId = /^-?\d+$/.test(value) ? value : `@${value.replace(/^@/, '')}`;
    let chat: TelegramChat;
    try {
      chat = await telegramCall<TelegramChat>(row.bot_token, 'getChat', { chat_id: chatId });
    } catch {
      throw new BadRequestException('Telegram can not find that channel for your bot. Add the bot to the channel as an admin first, then try again.');
    }
    if (chat.type !== 'channel') throw new BadRequestException('That is not a Telegram channel.');
    const member = await telegramCall<{ status: string; can_post_messages?: boolean }>(row.bot_token, 'getChatMember', { chat_id: chat.id, user_id: Number(row.bot_id) })
      .catch(() => ({ status: 'left', can_post_messages: false }));
    if (!(member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages !== false))) {
      throw new BadRequestException(`Make @${row.bot_username ?? 'your bot'} an admin of the channel with "Post messages" allowed, then try again.`);
    }
    await this.saveChannel(row.id, chat);
    return this.status(companyId);
  }

  async unlinkChannel(companyId: number) {
    const row = await this.connectionFor(companyId, null);
    await this.dataSource.query(`UPDATE telegram_connection SET channel_chat_id = NULL, channel_title = NULL, channel_username = NULL, updated_at = NOW() WHERE id = $1`, [row.id]);
    return this.status(companyId);
  }

  private saveChannel(connectionId: number, chat: TelegramChat) {
    return this.dataSource.query(`UPDATE telegram_connection SET channel_chat_id = $2, channel_title = $3, channel_username = $4, updated_at = NOW() WHERE id = $1`,
      [connectionId, String(chat.id), chat.title ?? null, chat.username ?? null]);
  }

  /* ───────────────────────── sending (one chat) ───────────────────────── */

  async sendText(target: TelegramSendTarget, text: string): Promise<string | null> {
    const body = String(text ?? '').trim();
    if (!body) return null;
    const row = await this.connectionFor(target.companyId, target.botId);
    let first: string | null = null;
    // Telegram takes 4096 characters per message – longer text is split (by characters, so emoji stay whole)
    const chars = Array.from(body);
    for (let i = 0; i < chars.length; i += TELEGRAM_LIMITS.text) {
      const result = await this.call<{ message_id: number }>(row, target, 'sendMessage', { chat_id: target.chatId, text: chars.slice(i, i + TELEGRAM_LIMITS.text).join(''), link_preview_options: { is_disabled: false } });
      first ??= `${target.chatId}:${result.message_id}`;
    }
    return first;
  }

  /** Photo, video, voice note, audio or any document – the right Telegram method is picked from the file type. */
  async sendFile(target: TelegramSendTarget, file: TelegramFile): Promise<string | null> {
    const row = await this.connectionFor(target.companyId, target.botId);
    const loaded = this.loadFile(file);
    const caption = String(file.caption ?? '').trim();
    const fits = caption.length <= TELEGRAM_LIMITS.caption;
    if (!loaded) {
      // a web link (e.g. a product photo): Telegram downloads it itself – this server never fetches outside addresses
      if (file.url && /^https:\/\//i.test(file.url)) {
        const name = file.fileName || decodeURIComponent(new URL(file.url).pathname.split('/').pop() || '');
        const { method, field } = sendMethodFor(file.mimetype || mimeFromName(name, 'image/jpeg'), name);
        try {
          const result = await this.call<{ message_id: number }>(row, target, method, { chat_id: target.chatId, [field]: file.url, caption: fits ? caption || undefined : undefined });
          if (!fits) await this.sendText(target, caption);
          return `${target.chatId}:${result.message_id}`;
        } catch (error) {
          if (error instanceof BadRequestException && /blocked/i.test(error.message)) throw error;
        }
      }
      const text = [caption, file.url].filter(Boolean).join('\n');
      if (!text) throw new BadRequestException('The file could not be loaded.');
      return this.sendText(target, text);
    }
    const { method, field } = sendMethodFor(loaded.mimetype, loaded.fileName);
    const limit = method === 'sendPhoto' ? TELEGRAM_LIMITS.photoBytes : TELEGRAM_LIMITS.fileBytes;
    if (loaded.buffer.length > limit) throw new BadRequestException(`Telegram takes ${method === 'sendPhoto' ? 'photos up to 10 MB' : 'files up to 50 MB'}.`);
    const result = await this.upload<{ message_id: number }>(row, target, method, field, loaded, { chat_id: target.chatId, caption: fits ? caption || undefined : undefined });
    if (!fits) await this.sendText(target, caption);
    return `${target.chatId}:${result.message_id}`;
  }

  /** Only bytes we were given or our own stored chat media – web addresses are never fetched here (no SSRF). */
  private loadFile(file: TelegramFile): { buffer: Buffer; mimetype: string; fileName: string } | null {
    if (file.buffer?.length) {
      const fileName = file.fileName || 'file';
      return { buffer: file.buffer, mimetype: (file.mimetype || mimeFromName(fileName)).split(';')[0].trim().toLowerCase(), fileName };
    }
    if (!file.url) return null;
    const stored = readChatMedia(file.url);
    return stored ? { buffer: stored.buffer, mimetype: stored.contentType, fileName: file.fileName || stored.fileName } : null;
  }

  /** One Telegram call for a chat: waits once when Telegram says "too many requests"; a blocked bot is remembered. */
  private async call<T>(row: TelegramConnection, target: TelegramSendTarget, method: string, params: Record<string, unknown>): Promise<T> {
    return this.guard(target, () => telegramCall<T>(row.bot_token, method, params));
  }
  private async upload<T>(row: TelegramConnection, target: TelegramSendTarget, method: string, field: string,
    file: { buffer: Buffer; mimetype: string; fileName: string }, params: Record<string, string | number | undefined>): Promise<T> {
    return this.guard(target, () => telegramUpload<T>(row.bot_token, method, field, file, params));
  }
  private async guard<T>(target: TelegramSendTarget, run: () => Promise<T>): Promise<T> {
    try {
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof TelegramError && error.code === 429 && (error.retryAfter ?? 0) <= 10)) throw error;
        await new Promise((resolve) => setTimeout(resolve, (error.retryAfter ?? 1) * 1000));
        return await run();
      }
    } catch (error) {
      if (error instanceof TelegramError && error.unreachable) {
        await this.markBlocked(target.companyId, target.chatId, true, target.botId);
        throw new BadRequestException('This customer blocked your Telegram bot (or deleted their account) – Telegram does not deliver messages to them.');
      }
      throw new BadRequestException(this.why(error));
    }
  }

  private why(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  private async markBlocked(companyId: number, chatId: string, blocked: boolean, botId: string | null) {
    await this.dataSource.query(`
      INSERT INTO telegram_subscriber_state (channel_user_id, blocked_at, updated_at)
      SELECT id, CASE WHEN $3 THEN NOW() ELSE NULL END, NOW() FROM bot_channel_user
       WHERE company_id = $1 AND platform = 'telegram' AND external_user_id = $2 AND ($4::text IS NULL OR source_account_id = $4)
      ON CONFLICT (channel_user_id) DO UPDATE SET blocked_at = CASE WHEN $3 THEN COALESCE(telegram_subscriber_state.blocked_at, NOW()) ELSE NULL END, updated_at = NOW()`,
    [companyId, chatId, blocked, botId]).catch(() => undefined);
  }

  /* ───────────────────────── receiving (webhook) ───────────────────────── */

  /** Checks the secret Telegram sends with every update (set with setWebhook). */
  async connectionForWebhook(connectionId: number, secret: string | undefined): Promise<TelegramConnection | null> {
    const [row]: TelegramConnection[] = await this.dataSource.query(`SELECT * FROM telegram_connection WHERE id = $1`, [connectionId]);
    if (!row || !secret) return null;
    const a = Buffer.from(String(secret));
    const b = Buffer.from(row.webhook_secret);
    return a.length === b.length && timingSafeEqual(a, b) ? row : null;
  }

  enqueue(row: TelegramConnection, update: TelegramUpdate): Promise<number> {
    const chat = update.message?.chat.id ?? update.my_chat_member?.chat.id ?? update.chat_join_request?.chat.id ?? update.chat_member?.chat.id ?? 'other';
    const key = `${row.id}:${chat}`;
    const next = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.handleUpdate(row, update));
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => undefined);
    return next;
  }

  async handleUpdate(row: TelegramConnection, update: TelegramUpdate): Promise<number> {
    if (row.status === 'DISCONNECTED') return 0;
    const companyId = Number(row.company_id);
    await this.dataSource.query(`UPDATE telegram_connection SET last_event_at = NOW() WHERE id = $1`, [row.id]).catch(() => undefined);

    // the business's Telegram groups / channels: join requests and members (only for groups linked in Channels → Telegram)
    if (update.chat_join_request) return this.spaces.onJoinRequest(row, update.chat_join_request);
    if (update.chat_member) return this.spaces.onMember(row, update.chat_member);

    const member = update.my_chat_member;
    if (member) {
      if (member.chat.type !== 'private') await this.spaces.onBotMember(row, member.chat, member.new_chat_member).catch((error) => this.logger.warn(`Telegram group update failed: ${this.why(error)}`));
      const status = member.new_chat_member?.status ?? '';
      if (member.chat.type === 'private') {
        await this.markBlocked(companyId, String(member.chat.id), status === 'kicked', row.bot_id);
        return 0;
      }
      if (member.chat.type === 'channel') {
        // the bot was made admin of a channel → link it (when none is linked yet); removed from the linked channel → unlink
        if (status === 'administrator' && member.new_chat_member?.can_post_messages !== false && !row.channel_chat_id) await this.saveChannel(row.id, member.chat);
        if ((status === 'left' || status === 'kicked') && row.channel_chat_id === String(member.chat.id)) {
          await this.dataSource.query(`UPDATE telegram_connection SET channel_chat_id = NULL, channel_title = NULL, channel_username = NULL, updated_at = NOW() WHERE id = $1`, [row.id]);
        }
      }
      return 0;
    }

    const message = update.message;
    if (!message || message.chat.type !== 'private' || message.from?.is_bot) return 0; // groups and edits are not handled
    const chatId = String(message.chat.id);
    const providerId = `${chatId}:${message.message_id}`;
    const known = await this.messageRepository.findOne({ where: { platform: 'telegram', provider_message_id: providerId } });
    if (known) return 0;

    const name = [message.from?.first_name ?? message.chat.first_name, message.from?.last_name ?? message.chat.last_name].filter(Boolean).join(' ').trim()
      || (message.from?.username ? `@${message.from.username}` : '');
    const user = await this.ensureUser(companyId, row.bot_id, chatId, name);
    const conversation = await this.ensureConversation(user.id);
    await this.markBlocked(companyId, chatId, false, row.bot_id);

    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(message.text?.trim() ?? '');
    if (start) {
      // a new follower: no AI reply, the business's welcome message instead
      await this.messageRepository.save(this.messageRepository.create({
        conversation_id: conversation.id, direction: 'inbound', delivery_status: null, message_type: 'system', platform: 'telegram',
        provider_message_id: providerId, content: `👋 Started the bot${start[1] ? ` · ${start[1]}` : ''}`, media_url: null, source: 'telegram-webhook',
      }));
      await this.sendWelcome(row, conversation.id, chatId, name).catch((error) => this.logger.warn(`Telegram welcome failed: ${this.why(error)}`));
      this.pusher.trigger(`company-${companyId}`, 'conversation_updated', { conversation_id: conversation.id, platform: 'telegram', direction: 'inbound' });
      return 1;
    }

    const saved = await this.buildRow(row, companyId, message);
    await this.messageRepository.save(this.messageRepository.create({
      conversation_id: conversation.id, direction: 'inbound', delivery_status: null, message_type: saved.message_type, platform: 'telegram',
      provider_message_id: providerId, content: saved.content, media_url: saved.media_url, source: 'telegram-webhook',
    }));
    this.pusher.trigger(`company-${companyId}`, 'conversation_updated', {
      conversation_id: conversation.id, platform: 'telegram', direction: 'inbound', client_message: true, inbound: true,
      agent_id: conversation.assigned_agent_id ?? null, preview: saved.content.slice(0, 120),
    });
    // the AI sales bot answers Telegram like Messenger (it decides itself whether it may reply)
    if (SalesBotHook.isActive()) await SalesBotHook.notify({ companyId, conversationId: conversation.id, phone: chatId, provider: 'telegram' });
    return 1;
  }

  private async sendWelcome(row: TelegramConnection, conversationId: number, chatId: string, name: string) {
    const [company] = await this.dataSource.query(`SELECT company_name FROM companies WHERE id = $1`, [row.company_id]).catch(() => [null]);
    const text = (row.welcome_text || DEFAULT_WELCOME)
      .replace(/\{name\}/gi, name.split(' ')[0] || 'there')
      .replace(/\{business\}/gi, company?.company_name || row.bot_name || 'us');
    const result = await telegramCall<{ message_id: number }>(row.bot_token, 'sendMessage', { chat_id: chatId, text });
    await this.messageRepository.save(this.messageRepository.create({
      conversation_id: conversationId, direction: 'outbound', delivery_status: 'sent', message_type: 'text', platform: 'telegram',
      provider_message_id: `${chatId}:${result.message_id}`, content: text, media_url: null, source: 'telegram-welcome',
    }));
  }

  private async buildRow(row: TelegramConnection, companyId: number, message: TgMessage): Promise<{ message_type: 'text' | 'image' | 'voice'; content: string; media_url: string | null }> {
    const caption = String(message.caption ?? '').trim();
    if (message.text) return { message_type: 'text', content: message.text.trim() || '[empty message]', media_url: null };
    const save = async (fileId: string, mimetype: string, fileName: string) => {
      const file = await downloadTelegramFile(row.bot_token, fileId).catch((error) => { this.logger.warn(`Telegram file download failed: ${this.why(error)}`); return null; });
      if (!file) return null;
      const name = fileName || file.path.split('/').pop() || 'file';
      return saveChatMedia(companyId, file.buffer, mimetype || mimeFromName(name), name);
    };
    if (message.photo?.length) {
      const best = [...message.photo].sort((a, b) => (b.file_size ?? b.width ?? 0) - (a.file_size ?? a.width ?? 0))[0];
      const key = await save(best.file_id, 'image/jpeg', 'photo.jpg');
      return key ? { message_type: 'image', content: caption || '[image]', media_url: key } : { message_type: 'text', content: '[photo – too big to download, open Telegram to see it]', media_url: null };
    }
    if (message.voice || message.video_note) {
      const media = message.voice ?? message.video_note!;
      const isVoice = Boolean(message.voice);
      const key = await save(media.file_id, isVoice ? (message.voice?.mime_type || 'audio/ogg') : 'video/mp4', isVoice ? 'voice.ogg' : 'video-note.mp4');
      if (!key) return { message_type: 'text', content: `[${isVoice ? 'voice' : 'video'}]\nToo big to download – open Telegram to listen.`, media_url: null };
      return isVoice ? { message_type: 'voice', content: '[voice]', media_url: key } : { message_type: 'text', content: '[video]', media_url: key };
    }
    const fileLike = message.video ?? message.audio ?? message.document;
    if (fileLike) {
      const kind = message.video ? 'video' : message.audio ? 'audio' : 'document';
      const fileName = ('file_name' in fileLike && fileLike.file_name) || (kind === 'video' ? 'video.mp4' : kind === 'audio' ? 'audio.mp3' : 'file');
      const key = await save(fileLike.file_id, fileLike.mime_type || mimeFromName(fileName), fileName);
      if (!key) return { message_type: 'text', content: `[${kind}]\nToo big to download (over 20 MB) – open Telegram to see it.`, media_url: null };
      return { message_type: 'text', content: kind === 'document' ? [fileName, caption].filter(Boolean).join('\n') : `[${kind}]${caption ? `\n${caption}` : ''}`, media_url: key };
    }
    const point = message.venue?.location ?? message.location;
    if (point) {
      const title = message.venue?.title ? `📍 ${message.venue.title}` : '📍 Location';
      return { message_type: 'text', content: [title, message.venue?.address, `https://maps.google.com/?q=${point.latitude},${point.longitude}`].filter(Boolean).join('\n'), media_url: null };
    }
    if (message.contact) {
      const name = [message.contact.first_name, message.contact.last_name].filter(Boolean).join(' ') || 'Contact';
      return { message_type: 'text', content: `Contact: ${name}\nPhone: ${message.contact.phone_number}`, media_url: null };
    }
    if (message.sticker) return { message_type: 'text', content: message.sticker.emoji || '[sticker]', media_url: null };
    return { message_type: 'text', content: '[unsupported]', media_url: null };
  }

  /** The Telegram customer = one private chat with our bot. */
  private async ensureUser(companyId: number, botId: string, chatId: string, name: string) {
    let user = await this.userRepository.findOne({ where: { company_id: companyId, platform: 'telegram', source_account_id: botId, external_user_id: chatId } });
    if (!user) {
      user = this.userRepository.create({
        company_id: companyId, app_user_id: null, platform: 'telegram', external_user_id: chatId, source_account_id: botId,
        display_name: name || 'Telegram customer', language: 'English', language_locked: false, session_state: null,
        bot_enabled: false, manual_mode: false, last_seen_at: new Date(),
      });
    } else if (name && (!user.display_name || user.display_name === 'Telegram customer')) {
      user.display_name = name;
    }
    user.last_seen_at = new Date();
    return this.userRepository.save(user);
  }

  private async ensureConversation(channelUserId: number) {
    let conversation = await this.conversationRepository.findOne({ where: { bot_channel_user_id: channelUserId }, order: { id: 'DESC' } });
    if (!conversation || conversation.status === 'closed') {
      conversation = this.conversationRepository.create({
        bot_channel_user_id: channelUserId, status: 'open', assigned_agent_id: null, assigned_at: null, timeout_at: null,
        assignment_mode: 'unassigned', agent_last_read_at: null, last_message_at: new Date(),
      });
    }
    conversation.last_message_at = new Date();
    return this.conversationRepository.save(conversation);
  }

  /* ───────────────────────── announcements ───────────────────────── */

  /** Customers who started the bot and did not block it (optionally only some tags). */
  private async subscribers(companyId: number, botId: string, tags: string[]) {
    return this.dataSource.query(`
      SELECT cu.id, cu.external_user_id AS chat_id, COALESCE(NULLIF(cu.display_name, ''), '') AS name
        FROM bot_channel_user cu
        LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
        LEFT JOIN telegram_subscriber_state s ON s.channel_user_id = cu.id
       WHERE cu.company_id = $1 AND cu.platform = 'telegram' AND cu.source_account_id = $2 AND s.blocked_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM marketing_optout o WHERE o.company_id = $1 AND o.bot_channel_user_id = cu.id)
         AND (COALESCE(array_length($3::text[], 1), 0) = 0 OR COALESCE(cc.tags, '{}') && $3::text[])
       ORDER BY cu.id`, [companyId, botId, tags]) as Promise<Array<{ id: number; chat_id: string; name: string }>>;
  }

  async audience(companyId: number, tags: string[] = []) {
    const row = await this.connectionFor(companyId, null);
    const list = await this.subscribers(companyId, row.bot_id, tags.map((t) => t.toLowerCase()));
    return { subscribers: list.length, channel: row.channel_chat_id ? { title: row.channel_title, username: row.channel_username } : null };
  }

  async announcements(companyId: number) {
    return this.dataSource.query(`SELECT id, text, media_url, to_channel, to_subscribers, tags, status, total, sent, failed, channel_ok, last_error, created_at, finished_at
      FROM telegram_announcement WHERE company_id = $1 ORDER BY created_at DESC LIMIT 50`, [companyId]);
  }

  /**
   * Announcement: posted in the linked channel and / or sent to everyone who started the bot (free). Subscribers get it as a
   * normal message in their own chat (it shows in each inbox chat). Sending runs in the background at ~20 a second.
   */
  async announce(companyId: number, userId: number, input: {
    text: string; to_channel?: boolean; to_subscribers?: boolean; tags?: string[]; photo?: { buffer: Buffer; mimetype: string; fileName: string } | null;
  }) {
    const row = await this.connectionFor(companyId, null);
    const text = String(input.text ?? '').trim();
    if (!text && !input.photo) throw new BadRequestException('Write the announcement.');
    const limit = input.photo ? TELEGRAM_LIMITS.caption : TELEGRAM_LIMITS.text;
    if (text.length > limit) throw new BadRequestException(`An announcement${input.photo ? ' with a photo' : ''} can have up to ${limit} characters.`);
    if (input.photo && !/^image\/(jpe?g|png|webp)$/.test(input.photo.mimetype)) throw new BadRequestException('The photo must be JPG, PNG or WEBP.');
    if (input.photo && input.photo.buffer.length > TELEGRAM_LIMITS.photoBytes) throw new BadRequestException('The photo must be smaller than 10 MB.');
    const toChannel = Boolean(input.to_channel);
    const toSubscribers = Boolean(input.to_subscribers);
    if (!toChannel && !toSubscribers) throw new BadRequestException('Choose where to send it: the channel, your bot subscribers or both.');
    if (toChannel && !row.channel_chat_id) throw new BadRequestException('Link a Telegram channel first (or send only to bot subscribers).');
    const tags = (input.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    const list = toSubscribers ? await this.subscribers(companyId, row.bot_id, tags) : [];
    const mediaKey = input.photo ? saveChatMedia(companyId, input.photo.buffer, input.photo.mimetype, input.photo.fileName) : null;
    const [record] = await this.dataSource.query(`
      INSERT INTO telegram_announcement (company_id, text, media_url, to_channel, to_subscribers, tags, status, total, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, 'sending', $7, $8) RETURNING *`, [companyId, text, mediaKey, toChannel, toSubscribers, tags, list.length, userId]);
    void this.runAnnouncement(row, Number(record.id), text, input.photo ?? null, mediaKey, toChannel, list)
      .catch((error) => this.logger.error(`Telegram announcement ${record.id} failed: ${this.why(error)}`));
    return record;
  }

  private async runAnnouncement(row: TelegramConnection, id: number, text: string, photo: { buffer: Buffer; mimetype: string; fileName: string } | null,
    mediaKey: string | null, toChannel: boolean, list: Array<{ id: number; chat_id: string; name: string }>) {
    let fileId: string | null = null; // the photo is uploaded once, then re-used by its Telegram id
    const post = async (chatId: string | number, body: string): Promise<number> => {
      if (photo) {
        const params = { chat_id: chatId, caption: body || undefined };
        const result = fileId
          ? await telegramCall<{ message_id: number }>(row.bot_token, 'sendPhoto', { ...params, photo: fileId })
          : await telegramUpload<{ message_id: number; photo?: TgPhoto[] }>(row.bot_token, 'sendPhoto', 'photo', photo, params);
        if (!fileId) fileId = (result as { photo?: TgPhoto[] }).photo?.slice(-1)[0]?.file_id ?? null;
        return result.message_id;
      }
      return (await telegramCall<{ message_id: number }>(row.bot_token, 'sendMessage', { chat_id: chatId, text: body })).message_id;
    };
    const retrying = async (chatId: string | number, body: string) => {
      try {
        return await post(chatId, body);
      } catch (error) {
        if (error instanceof TelegramError && error.code === 429 && (error.retryAfter ?? 0) <= 30) {
          await new Promise((resolve) => setTimeout(resolve, (error.retryAfter ?? 1) * 1000));
          return post(chatId, body);
        }
        throw error;
      }
    };
    const named = (who: string) => text.replace(/\{name\}/gi, who);

    if (toChannel && row.channel_chat_id) {
      try {
        await retrying(row.channel_chat_id, named('everyone'));
        await this.dataSource.query(`UPDATE telegram_announcement SET channel_ok = TRUE WHERE id = $1`, [id]);
      } catch (error) {
        await this.dataSource.query(`UPDATE telegram_announcement SET channel_ok = FALSE, last_error = $2 WHERE id = $1`, [id, this.why(error)]);
      }
    }

    let sent = 0;
    let failed = 0;
    const gap = Math.ceil(1000 / TELEGRAM_LIMITS.perSecond);
    for (const person of list) {
      const [state] = await this.dataSource.query(`SELECT status FROM telegram_announcement WHERE id = $1`, [id]);
      if (state?.status === 'cancelled') break;
      const started = Date.now();
      try {
        const first = person.name && person.name !== 'Telegram customer' && !person.name.startsWith('@') ? person.name.split(' ')[0] : '';
        const personal = named(first || 'everyone');
        const messageId = await retrying(person.chat_id, personal);
        sent += 1;
        await this.saveAnnouncementMessage(person.id, `${person.chat_id}:${messageId}`, personal, mediaKey);
      } catch (error) {
        failed += 1;
        if (error instanceof TelegramError && error.unreachable) await this.markBlocked(Number(row.company_id), person.chat_id, true, row.bot_id);
        await this.dataSource.query(`UPDATE telegram_announcement SET last_error = $2 WHERE id = $1`, [id, this.why(error)]);
      }
      if ((sent + failed) % 20 === 0) await this.dataSource.query(`UPDATE telegram_announcement SET sent = $2, failed = $3 WHERE id = $1`, [id, sent, failed]);
      const wait = gap - (Date.now() - started);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    await this.dataSource.query(`
      UPDATE telegram_announcement SET sent = $2, failed = $3, status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE 'sent' END, finished_at = NOW() WHERE id = $1`,
    [id, sent, failed]);
    this.pusher.trigger(`company-${row.company_id}`, 'conversation_updated', { platform: 'telegram', announcement: id });
  }

  private async saveAnnouncementMessage(channelUserId: number, providerId: string, text: string, mediaKey: string | null) {
    const conversation = await this.conversationRepository.findOne({ where: { bot_channel_user_id: channelUserId }, order: { id: 'DESC' } });
    if (!conversation) return;
    await this.messageRepository.save(this.messageRepository.create({
      conversation_id: conversation.id, direction: 'outbound', delivery_status: 'sent', message_type: mediaKey ? 'image' : 'text', platform: 'telegram',
      provider_message_id: providerId, content: text || '[image]', media_url: mediaKey, source: 'telegram-announcement',
    }));
  }

  async cancelAnnouncement(companyId: number, id: number) {
    await this.dataSource.query(`UPDATE telegram_announcement SET status = 'cancelled' WHERE id = $1 AND company_id = $2 AND status = 'sending'`, [id, companyId]);
    return { cancelled: true };
  }
}
