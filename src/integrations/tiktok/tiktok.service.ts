import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHmac, timingSafeEqual } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { BotChannelUser } from '../../bot-admin/entities/bot-channel-user.entity';
import { BotConversation } from '../../bot-admin/entities/bot-conversation.entity';
import { BotMessage } from '../../bot-admin/entities/bot-message.entity';
import { saveChatMedia } from '../../bot-admin/chat-media.store';
import { linkQuotedReply } from '../../common/message-reply';
import { PusherService } from '../../common/pusher.service';
import { SalesBotHook } from '../../common/sales-bot-hook';
import { TiktokHook, type TiktokImage, type TiktokSendTarget } from '../../common/tiktok-hook';
import {
  TiktokError, downloadTiktokMedia, exchangeTiktokCode, getTiktokWebhook, refreshTiktokToken, sendTiktokMessage, setTiktokWebhook,
  tiktokAuthorizeUrl, tiktokBusinessProfile, tiktokCanSendImage, tiktokConfigured, uploadTiktokImage,
} from './tiktok-api';

/** TikTok's own rules for business accounts (they apply ONLY to TikTok chats). */
export const TIKTOK_RULES = {
  /** replies are possible for 48 hours after the customer's last message */
  windowHours: 48,
  /** at most 10 messages in a row; the next customer message starts a new count */
  maxInARow: 10,
  /** longest text TikTok takes */
  maxText: 6000,
  /** photos: JPG or PNG up to 3 MB */
  maxImageBytes: 3 * 1024 * 1024,
};

export type TiktokConnection = {
  id: number; company_id: number; business_id: string; username: string | null; display_name: string | null; profile_image: string | null;
  access_token: string; refresh_token: string; expires_at: Date; refresh_expires_at: Date; scope: string | null;
  status: string; last_error: string | null; last_event_at: Date | null; created_at: Date; updated_at: Date;
};

/** A TikTok webhook body: { event, user_openid (= our business account), content: JSON string } */
export type TiktokEvent = { event?: string; user_openid?: string; client_key?: string; create_time?: number; content?: string | Record<string, unknown> };
type TiktokContent = {
  type?: string; message_id?: string; timestamp?: number; conversation_id?: string;
  text?: { body?: string }; image?: { media_id?: string }; share_post?: { embed_url?: string }; sticker?: Record<string, unknown>;
  from?: string; from_user?: { id?: string }; to?: string; to_user?: { id?: string };
  referenced_message_info?: { referenced_message_id?: string };
  read?: { last_read_timestamp?: number };
};

/** Friendly reason a TikTok message could not be sent (the rules above). */
export class TiktokRuleError extends Error {}

/**
 * TikTok Business Messaging: connect a TikTok Business account (OAuth), receive its direct messages in the inbox
 * (webhook), and send replies – from agents, the AI sales bot and order messages – with TikTok's rules
 * (48-hour window, 10 messages in a row, text + one photo). Nothing here runs for WhatsApp, Messenger or Instagram.
 */
@Injectable()
export class TiktokService implements OnModuleInit {
  private readonly logger = new Logger(TiktokService.name);
  private readonly pusher = new PusherService();
  /** one token refresh at a time per account */
  private readonly refreshing = new Map<string, Promise<string>>();
  /** IMAGE_SEND capability per TikTok conversation (checked once) */
  private readonly imageCapable = new Map<string, boolean>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(BotChannelUser) private readonly userRepository: Repository<BotChannelUser>,
    @InjectRepository(BotConversation) private readonly conversationRepository: Repository<BotConversation>,
    @InjectRepository(BotMessage) private readonly messageRepository: Repository<BotMessage>,
  ) {}

  onModuleInit() {
    TiktokHook.register({
      sendText: (target, text) => this.sendText(target, text),
      sendImage: (target, image) => this.sendImage(target, image),
    });
  }

  /* ───────────────────────── addresses + OAuth state ───────────────────────── */

  private apiPublic(): string {
    return String(process.env.PUBLIC_API_BASE_URL ?? '').trim().replace(/\/+$/, '');
  }
  redirectUri(): string { return `${this.apiPublic()}/integrations/tiktok/callback`; }
  webhookUrl(): string { return `${this.apiPublic()}/integrations/tiktok/webhook`; }
  appUrl(path: string): string {
    const base = String(process.env.APP_PUBLIC_URL ?? process.env.FRONTEND_URL ?? '').trim().replace(/\/+$/, '');
    return `${base}${path}`;
  }

  private secret(): string {
    const value = String(process.env.TIKTOK_STATE_SECRET ?? process.env.JWT_SECRET ?? '').trim();
    if (!value) throw new Error('JWT_SECRET is required');
    return value;
  }
  /** state = company.user.time signed – valid 30 minutes */
  makeState(companyId: number, userId: number): string {
    const payload = `${companyId}.${userId}.${Date.now()}`;
    return `${Buffer.from(payload).toString('base64url')}.${createHmac('sha256', this.secret()).update(payload).digest('base64url')}`;
  }
  readState(state: string): { companyId: number; userId: number } | null {
    const [encoded, signature] = String(state ?? '').split('.');
    if (!encoded || !signature) return null;
    const payload = Buffer.from(encoded, 'base64url').toString();
    const expected = Buffer.from(createHmac('sha256', this.secret()).update(payload).digest('base64url'));
    const supplied = Buffer.from(signature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const [companyId, userId, at] = payload.split('.').map(Number);
    if (!companyId || Date.now() - at > 30 * 60_000) return null;
    return { companyId, userId };
  }

  /* ───────────────────────── connection ───────────────────────── */

  async connection(companyId: number): Promise<TiktokConnection | null> {
    const [row] = await this.dataSource.query(`SELECT * FROM tiktok_connection WHERE company_id = $1 ORDER BY (status = 'CONNECTED') DESC, updated_at DESC LIMIT 1`, [companyId]);
    return row ?? null;
  }

  private async connectionFor(companyId: number, businessId: string | null): Promise<TiktokConnection> {
    const [row] = businessId
      ? await this.dataSource.query(`SELECT * FROM tiktok_connection WHERE company_id = $1 AND business_id = $2 LIMIT 1`, [companyId, businessId])
      : await this.dataSource.query(`SELECT * FROM tiktok_connection WHERE company_id = $1 AND status = 'CONNECTED' ORDER BY updated_at DESC LIMIT 1`, [companyId]);
    if (!row) throw new TiktokRuleError('Connect your TikTok account first (Channels → TikTok).');
    if (row.status === 'DISCONNECTED') throw new TiktokRuleError('This TikTok account is disconnected. Connect it again in Channels → TikTok.');
    return row;
  }

  connectUrl(companyId: number, userId: number): string {
    if (!tiktokConfigured()) throw new BadRequestException('TikTok is not set up on this server yet (TIKTOK_APP_ID / TIKTOK_APP_SECRET).');
    if (!this.apiPublic()) throw new BadRequestException('PUBLIC_API_BASE_URL is not set on the server.');
    return tiktokAuthorizeUrl(this.redirectUri(), this.makeState(companyId, userId));
  }

  /** OAuth callback: tokens → account details → save (one TikTok account belongs to one company). */
  async completeConnect(code: string, state: string): Promise<{ companyId: number; username: string | null }> {
    const who = this.readState(state);
    if (!who) throw new BadRequestException('The TikTok login link expired. Start again from Channels → TikTok.');
    const tokens = await exchangeTiktokCode(code, this.redirectUri());
    const missing = ['message.list.read', 'message.list.send'].filter((scope) => tokens.scope && !tokens.scope.split(/[,\s]+/).includes(scope));
    if (missing.length) throw new BadRequestException(`Allow all permissions when you connect (missing: ${missing.join(', ')}).`);
    const profile = await tiktokBusinessProfile(tokens.businessId, tokens.accessToken).catch(() => ({ username: null, display_name: null, profile_image: null }));
    const [owner] = await this.dataSource.query(`SELECT company_id FROM tiktok_connection WHERE business_id = $1`, [tokens.businessId]);
    if (owner && Number(owner.company_id) !== who.companyId) {
      throw new BadRequestException('This TikTok account is already connected to another business on Agent Metra.');
    }
    await this.dataSource.query(`
      INSERT INTO tiktok_connection (company_id, business_id, username, display_name, profile_image, access_token, refresh_token, expires_at, refresh_expires_at, scope, status, last_error, connected_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'CONNECTED', NULL, $11)
      ON CONFLICT (business_id) DO UPDATE SET username = EXCLUDED.username, display_name = EXCLUDED.display_name, profile_image = EXCLUDED.profile_image,
        access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, expires_at = EXCLUDED.expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
        scope = EXCLUDED.scope, status = 'CONNECTED', last_error = NULL, connected_by = EXCLUDED.connected_by, updated_at = NOW()`,
    [who.companyId, tokens.businessId, profile.username, profile.display_name, profile.profile_image, tokens.accessToken, tokens.refreshToken,
      tokens.expiresAt, tokens.refreshExpiresAt, tokens.scope || null, who.userId]);
    // one other account of this company stays as it was; the newest is used for new chats
    await this.ensureWebhook().catch((error) => this.logger.warn(`TikTok webhook: ${error instanceof Error ? error.message : String(error)}`));
    return { companyId: who.companyId, username: profile.username };
  }

  /** The app's webhook must point at this server (one URL for all accounts of the app). */
  async ensureWebhook(): Promise<{ url: string | null; ok: boolean }> {
    const wanted = this.webhookUrl();
    const current = await getTiktokWebhook().catch(() => null);
    if (current === wanted) return { url: current, ok: true };
    await setTiktokWebhook(wanted);
    return { url: wanted, ok: true };
  }

  async disconnect(companyId: number) {
    await this.dataSource.query(`UPDATE tiktok_connection SET status = 'DISCONNECTED', updated_at = NOW() WHERE company_id = $1`, [companyId]);
    return { disconnected: true };
  }

  /** Channels page: connection, token, webhook and the last message received. */
  async status(companyId: number) {
    const row = await this.connection(companyId);
    const [stats] = row ? await this.dataSource.query(`
      SELECT COUNT(DISTINCT cu.id)::int AS customers, COUNT(m.id) FILTER (WHERE m.direction::text = 'inbound')::int AS received,
             MAX(m.created_at) FILTER (WHERE m.direction::text = 'inbound') AS last_received_at
        FROM bot_channel_user cu LEFT JOIN bot_conversation c ON c.bot_channel_user_id = cu.id LEFT JOIN bot_message m ON m.conversation_id = c.id
       WHERE cu.company_id = $1 AND cu.platform = 'tiktok' AND cu.source_account_id = $2`, [companyId, row.business_id]) : [null];
    return {
      configured: tiktokConfigured(),
      redirect_uri: this.apiPublic() ? this.redirectUri() : null,
      webhook_url: this.apiPublic() ? this.webhookUrl() : null,
      rules: { window_hours: TIKTOK_RULES.windowHours, max_in_a_row: TIKTOK_RULES.maxInARow, image_max_mb: 3 },
      connection: row ? {
        business_id: row.business_id, username: row.username, display_name: row.display_name, profile_image: row.profile_image,
        status: row.status, last_error: row.last_error, last_event_at: row.last_event_at, connected_at: row.created_at,
        token_ok: new Date(row.refresh_expires_at).getTime() > Date.now(), refresh_expires_at: row.refresh_expires_at,
        customers: Number(stats?.customers ?? 0), received: Number(stats?.received ?? 0), last_received_at: stats?.last_received_at ?? null,
      } : null,
    };
  }

  /** "Check connection": token, account details and the webhook address. */
  async check(companyId: number) {
    const row = await this.connection(companyId);
    if (!row || row.status === 'DISCONNECTED') throw new BadRequestException('Connect your TikTok account first.');
    const steps: Array<{ name: string; ok: boolean; detail: string }> = [];
    let token: string | null = null;
    try {
      token = await this.token(row);
      steps.push({ name: 'Access', ok: true, detail: 'TikTok accepted the connection.' });
    } catch (error) {
      steps.push({ name: 'Access', ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    if (token) {
      try {
        const profile = await tiktokBusinessProfile(row.business_id, token);
        await this.dataSource.query(`UPDATE tiktok_connection SET username = COALESCE($2, username), display_name = COALESCE($3, display_name), profile_image = COALESCE($4, profile_image), updated_at = NOW() WHERE id = $1`,
          [row.id, profile.username, profile.display_name, profile.profile_image]);
        steps.push({ name: 'Account', ok: true, detail: `@${profile.username ?? row.username ?? row.business_id}` });
      } catch (error) {
        steps.push({ name: 'Account', ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }
    try {
      const hook = await this.ensureWebhook();
      steps.push({ name: 'Webhook', ok: hook.ok, detail: hook.url ?? 'not set' });
    } catch (error) {
      steps.push({ name: 'Webhook', ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    return { ok: steps.every((step) => step.ok), steps };
  }

  /** A valid access token: renewed when it expires within 5 minutes (TikTok tokens last about a day). */
  async token(row: TiktokConnection): Promise<string> {
    if (new Date(row.expires_at).getTime() - Date.now() > 5 * 60_000) return row.access_token;
    if (new Date(row.refresh_expires_at).getTime() <= Date.now()) {
      await this.dataSource.query(`UPDATE tiktok_connection SET status = 'REAUTH', last_error = $2, updated_at = NOW() WHERE id = $1`,
        [row.id, 'The TikTok login expired after 30 days without use – connect the account again.']);
      throw new TiktokRuleError('The TikTok login expired – connect the account again in Channels → TikTok.');
    }
    const running = this.refreshing.get(row.business_id);
    if (running) return running;
    const job = (async () => {
      try {
        const fresh = await refreshTiktokToken(row.refresh_token, row.business_id);
        await this.dataSource.query(`
          UPDATE tiktok_connection SET access_token = $2, refresh_token = $3, expires_at = $4, refresh_expires_at = $5, status = 'CONNECTED', last_error = NULL, updated_at = NOW()
           WHERE id = $1`, [row.id, fresh.accessToken, fresh.refreshToken || row.refresh_token, fresh.expiresAt, fresh.refreshExpiresAt]);
        return fresh.accessToken;
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        await this.dataSource.query(`UPDATE tiktok_connection SET status = 'REAUTH', last_error = $2, updated_at = NOW() WHERE id = $1`, [row.id, why]);
        throw new TiktokRuleError(`TikTok access could not be renewed – connect the account again in Channels → TikTok. (${why})`);
      } finally {
        this.refreshing.delete(row.business_id);
      }
    })();
    this.refreshing.set(row.business_id, job);
    return job;
  }

  /* ───────────────────────── TikTok's rules (TikTok chats only) ───────────────────────── */

  /** 48-hour window + messages since the customer's last message, for one TikTok chat. */
  async window(companyId: number, businessId: string | null, ttConversationId: string) {
    const [row] = await this.dataSource.query(`
      WITH users AS (
        SELECT id FROM bot_channel_user WHERE company_id = $1 AND platform = 'tiktok' AND external_user_id = $2 AND ($3::text IS NULL OR source_account_id = $3)
      ), last_in AS (
        SELECT MAX(m.created_at) AS at FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id
         WHERE c.bot_channel_user_id IN (SELECT id FROM users) AND m.direction::text = 'inbound'
      )
      SELECT (SELECT at FROM last_in) AS last_inbound,
             EXTRACT(EPOCH FROM (LOCALTIMESTAMP - (SELECT at FROM last_in))) AS age_s,
             (SELECT COUNT(*) FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id
               WHERE c.bot_channel_user_id IN (SELECT id FROM users) AND m.direction::text = 'outbound'
                 AND COALESCE(m.delivery_status, '') <> 'failed' AND m.provider_message_id IS NOT NULL
                 AND m.created_at > COALESCE((SELECT at FROM last_in), LOCALTIMESTAMP - INTERVAL '100 years'))::int AS sent`,
    [companyId, ttConversationId, businessId]);
    const ageS = row?.age_s == null ? null : Number(row.age_s);
    const hoursLeft = ageS == null ? 0 : Math.max(0, TIKTOK_RULES.windowHours - ageS / 3600);
    const sent = Number(row?.sent ?? 0);
    return {
      open: ageS != null && hoursLeft > 0 && sent < TIKTOK_RULES.maxInARow,
      hours_left: Math.round(hoursLeft * 10) / 10,
      closes_at: row?.last_inbound && ageS != null ? new Date(Date.now() + hoursLeft * 3600_000).toISOString() : null,
      sent, messages_left: Math.max(0, TIKTOK_RULES.maxInARow - sent), max: TIKTOK_RULES.maxInARow,
    };
  }

  private async assertCanSend(target: TiktokSendTarget) {
    const w = await this.window(target.companyId, target.businessId, target.conversationId);
    if (w.hours_left <= 0) {
      throw new TiktokRuleError(`TikTok allows replies only within ${TIKTOK_RULES.windowHours} hours of the customer's last message. Wait for the customer to write again.`);
    }
    if (w.sent >= TIKTOK_RULES.maxInARow) {
      throw new TiktokRuleError(`TikTok allows ${TIKTOK_RULES.maxInARow} messages in a row. Wait for the customer to reply – then you can send more.`);
    }
  }

  /* ───────────────────────── sending ───────────────────────── */

  async sendText(target: TiktokSendTarget, text: string, referencedMessageId?: string | null): Promise<string | null> {
    const body = String(text ?? '').trim();
    if (!body) return null;
    await this.assertCanSend(target);
    const row = await this.connectionFor(target.companyId, target.businessId);
    const token = await this.token(row);
    const safe = body.length > TIKTOK_RULES.maxText ? `${body.slice(0, TIKTOK_RULES.maxText - 1)}…` : body;
    return sendTiktokMessage(row.business_id, token, target.conversationId, { text: safe }, referencedMessageId);
  }

  /** One photo (JPG / PNG, max 3 MB). Countries where TikTok blocks photos get the link as text instead. */
  async sendImage(target: TiktokSendTarget, image: TiktokImage): Promise<string | null> {
    await this.assertCanSend(target);
    const row = await this.connectionFor(target.companyId, target.businessId);
    const token = await this.token(row);
    let file = image.buffer ? { buffer: image.buffer, mimetype: (image.mimetype || 'image/jpeg').toLowerCase() } : null;
    if (!file && image.url && /^https?:\/\//i.test(image.url)) {
      const response = await fetch(image.url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (response?.ok) file = { buffer: Buffer.from(await response.arrayBuffer()), mimetype: (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase() };
    }
    const fallback = async (why: string) => {
      this.logger.log(`TikTok photo sent as a link (${why})`);
      if (!image.url) throw new TiktokRuleError(`TikTok: ${why}`);
      return sendTiktokMessage(row.business_id, token, target.conversationId, { text: image.url });
    };
    if (!file) return fallback('the photo could not be loaded');
    if (!/^image\/(jpe?g|png)$/.test(file.mimetype)) return fallback('TikTok takes only JPG and PNG photos');
    if (file.buffer.length > TIKTOK_RULES.maxImageBytes) return fallback('the photo is larger than 3 MB');
    const key = `${row.business_id}:${target.conversationId}`;
    if (!this.imageCapable.has(key)) {
      this.imageCapable.set(key, await tiktokCanSendImage(row.business_id, token, target.conversationId).catch(() => true));
    }
    if (!this.imageCapable.get(key)) return fallback('TikTok does not allow photos in this chat (country rules)');
    const mediaId = await uploadTiktokImage(row.business_id, token, {
      buffer: file.buffer, mimetype: file.mimetype === 'image/jpg' ? 'image/jpeg' : file.mimetype, fileName: image.fileName || `photo.${file.mimetype.endsWith('png') ? 'png' : 'jpg'}`,
    });
    return sendTiktokMessage(row.business_id, token, target.conversationId, { mediaId });
  }

  /* ───────────────────────── receiving (webhook) ───────────────────────── */

  /** im_receive_msg (customer wrote), im_send_msg (sent from the TikTok app or by us), im_mark_read_msg (customer read). */
  async handleEvent(event: TiktokEvent): Promise<number> {
    const businessId = String(event.user_openid ?? '').trim();
    if (!businessId) return 0;
    const [row]: TiktokConnection[] = await this.dataSource.query(`SELECT * FROM tiktok_connection WHERE business_id = $1 AND status <> 'DISCONNECTED' LIMIT 1`, [businessId]);
    if (!row) return 0;
    let content: TiktokContent;
    try {
      content = (typeof event.content === 'string' ? JSON.parse(event.content) : event.content ?? {}) as TiktokContent;
    } catch {
      return 0;
    }
    await this.dataSource.query(`UPDATE tiktok_connection SET last_event_at = NOW() WHERE id = $1`, [row.id]).catch(() => undefined);
    const companyId = Number(row.company_id);
    if (event.event === 'im_mark_read_msg') return this.markRead(companyId, businessId, content);
    if (event.event !== 'im_receive_msg' && event.event !== 'im_send_msg') return 0;
    const ttConversation = String(content.conversation_id ?? '').trim();
    const messageId = String(content.message_id ?? '').trim() || null;
    if (!ttConversation) return 0;
    const incoming = String(content.to_user?.id ?? '') === businessId || (event.event === 'im_receive_msg' && String(content.from_user?.id ?? '') !== businessId);

    if (messageId) {
      const known = await this.messageRepository.findOne({ where: { platform: 'tiktok', provider_message_id: messageId } });
      if (known) return 0;
    }
    const customerName = String((incoming ? content.from : content.to) ?? '').trim();
    const user = await this.ensureUser(companyId, businessId, ttConversation, customerName);
    const conversation = await this.ensureConversation(user.id);
    const saved = await this.buildRow(row, companyId, ttConversation, content);

    if (!incoming) {
      // our own reply comes back as an echo: already saved when it was sent (same text a moment ago) → skip
      const same = await this.messageRepository.createQueryBuilder('m')
        .where('m.conversation_id = :id', { id: conversation.id })
        .andWhere("m.direction::text = 'outbound'")
        .andWhere('(m.provider_message_id = :mid OR (m.content = :content AND m.created_at > LOCALTIMESTAMP - INTERVAL \'10 minutes\'))', { mid: messageId ?? '', content: saved.content })
        .getOne();
      if (same) {
        if (messageId && !same.provider_message_id) await this.messageRepository.update(same.id, { provider_message_id: messageId });
        return 0;
      }
    }

    const message = await this.messageRepository.save(this.messageRepository.create({
      conversation_id: conversation.id,
      direction: incoming ? 'inbound' : 'outbound',
      delivery_status: incoming ? null : 'sent',
      message_type: saved.message_type,
      platform: 'tiktok',
      provider_message_id: messageId,
      content: saved.content,
      media_url: saved.media_url,
      source: incoming ? 'tiktok-webhook' : 'tiktok-app',
    }));
    const quoted = content.referenced_message_info?.referenced_message_id;
    if (quoted && messageId) await linkQuotedReply(this.dataSource, conversation.id, messageId, { providerId: String(quoted), text: null }).catch(() => undefined);

    this.pusher.trigger(`company-${companyId}`, 'conversation_updated', {
      conversation_id: conversation.id, platform: 'tiktok', direction: incoming ? 'inbound' : 'outbound',
      ...(incoming ? { client_message: true, inbound: true, agent_id: conversation.assigned_agent_id ?? null, preview: saved.content.slice(0, 120) } : {}),
    });
    if (!incoming) return 1;

    // the AI sales bot answers TikTok like Instagram (it decides itself whether it may reply)
    if (SalesBotHook.isActive()) {
      await SalesBotHook.notify({ companyId, conversationId: conversation.id, phone: ttConversation, provider: 'tiktok' });
    }
    return message ? 1 : 0;
  }

  private async buildRow(row: TiktokConnection, companyId: number, ttConversation: string, content: TiktokContent): Promise<{ message_type: 'text' | 'image'; content: string; media_url: string | null }> {
    const type = String(content.type ?? '').toLowerCase();
    if (type === 'text') return { message_type: 'text', content: String(content.text?.body ?? '').trim() || '[empty message]', media_url: null };
    if (type === 'image' && content.image?.media_id && content.message_id) {
      try {
        const token = await this.token(row);
        const file = await downloadTiktokMedia(row.business_id, token, ttConversation, content.message_id, content.image.media_id);
        if (file) return { message_type: 'image', content: '[image]', media_url: saveChatMedia(companyId, file.buffer, file.mimetype, `tiktok.${file.mimetype.endsWith('png') ? 'png' : 'jpg'}`) };
      } catch (error) {
        this.logger.warn(`TikTok photo could not be downloaded: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { message_type: 'text', content: '[photo – open TikTok to see it]', media_url: null };
    }
    if (type === 'share_post') return { message_type: 'text', content: ['🎵 Shared a TikTok post', content.share_post?.embed_url].filter(Boolean).join('\n'), media_url: null };
    if (type === 'sticker') return { message_type: 'text', content: '[sticker]', media_url: null };
    return { message_type: 'text', content: `[${type || 'message'} – open TikTok to see it]`, media_url: null };
  }

  private async markRead(companyId: number, businessId: string, content: TiktokContent): Promise<number> {
    const ttConversation = String(content.conversation_id ?? '').trim();
    const at = Number(content.read?.last_read_timestamp ?? 0);
    if (!ttConversation || !at) return 0;
    const result = await this.dataSource.query(`
      UPDATE bot_message m SET delivery_status = 'read'
        FROM bot_conversation c, bot_channel_user cu
       WHERE m.conversation_id = c.id AND c.bot_channel_user_id = cu.id AND cu.company_id = $1 AND cu.platform = 'tiktok'
         AND cu.external_user_id = $2 AND cu.source_account_id = $3 AND m.direction::text = 'outbound'
         AND COALESCE(m.delivery_status, '') <> 'failed' AND m.created_at <= (to_timestamp($4::double precision / 1000) AT TIME ZONE current_setting('TIMEZONE'))`,
    [companyId, ttConversation, businessId, at]).catch(() => [[], 0]);
    const affected = Array.isArray(result) ? Number(result[1] ?? 0) : 0;
    if (affected) this.pusher.trigger(`company-${companyId}`, 'conversation_updated', { platform: 'tiktok', message_status: 'read' });
    return affected;
  }

  /** The TikTok customer = one TikTok conversation of our business account (TikTok sends replies to the conversation). */
  private async ensureUser(companyId: number, businessId: string, ttConversation: string, name: string) {
    let user = await this.userRepository.findOne({ where: { company_id: companyId, platform: 'tiktok', source_account_id: businessId, external_user_id: ttConversation } });
    if (!user) {
      user = this.userRepository.create({
        company_id: companyId, app_user_id: null, platform: 'tiktok', external_user_id: ttConversation, source_account_id: businessId,
        display_name: name || 'TikTok customer', language: 'English', language_locked: false, session_state: null,
        bot_enabled: false, manual_mode: false, last_seen_at: new Date(),
      });
    } else if (name && (!user.display_name || user.display_name === 'TikTok customer')) {
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
}

export { TiktokError };
