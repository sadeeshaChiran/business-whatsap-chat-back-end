import { linkQuotedReply, quotedFromMessengerMessage } from '../../common/message-reply';
import { SkipThrottle } from '@nestjs/throttler';
import { SocialHook } from '../../common/social-hook';
import { MarketingHook } from '../../common/marketing-hook';
import {
  Body, Controller, ForbiddenException, Get, Headers, HttpCode, Logger, Post, Query, Req,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { PusherService } from '../../common/pusher.service';
import { BotChannelUser } from '../../bot-admin/entities/bot-channel-user.entity';
import { BotConversation } from '../../bot-admin/entities/bot-conversation.entity';
import { BotMessage } from '../../bot-admin/entities/bot-message.entity';
import { saveChatMedia } from '../../bot-admin/chat-media.store';
import { MetaPageConnection } from '../../meta/entities/meta-page-connection.entity';
import { SalesBotHook } from '../../common/sales-bot-hook';
import { FlowHook } from '../../common/flow-hook';
import { MetaGraphService } from './meta-graph.service';
import { metaAppSecrets } from '../whatsapp/webhook-auth';
import { webhookAccepted, webhookReceived, webhookRejected } from './webhook-stats';
import { recordMetaEvent } from './webhook-events';
import { createHash } from 'crypto';

/** A message of the Page that the customer replied to, read from Meta (we did not have it – e.g. the ad card Meta shows). */
type RepliedCard = { mid: string; title: string; mediaUrl: string | null; mediaType: 'image' | 'video' | null; createdAt: Date; link: string | null };
type GraphMessage = {
  id?: string; created_time?: string; from?: { id?: string }; message?: string;
  attachments?: { data?: Array<{ mime_type?: string; name?: string; image_data?: { url?: string; preview_url?: string }; video_data?: { url?: string; preview_url?: string }; file_url?: string }> };
  shares?: { data?: Array<{ link?: string; name?: string; description?: string }> };
};

type Attachment = {
  type?: string; // image | video | audio | file | location | fallback | template | share | story_mention | ig_reel | reel
  title?: string;
  url?: string;
  payload?: {
    url?: string;
    title?: string;
    sticker_id?: number;
    coordinates?: { lat?: number; long?: number };
  };
};
type MessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    app_id?: number | string;
    is_deleted?: boolean;
    attachments?: Attachment[];
    quick_reply?: { payload?: string };
    reply_to?: { mid?: string; story?: { url?: string; id?: string } };
    referral?: Record<string, unknown>;
  };
  referral?: Record<string, unknown>;
  postback?: { mid?: string; title?: string; payload?: string };
};
type WebhookEntry = { id?: string; messaging?: MessagingEvent[]; standby?: MessagingEvent[]; changes?: Array<{ field?: string }> };
type WebhookBody = { object?: string; entry?: WebhookEntry[] };

type SavedRow = Pick<BotMessage, 'message_type' | 'content' | 'media_url'> & { media_note?: string | null };

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

@Controller('integrations/meta/messages')
export class MetaMessagesController {
  private readonly pusherService = new PusherService();
  private readonly logger = new Logger(MetaMessagesController.name);
  constructor(
    @InjectRepository(MetaPageConnection)
    private readonly connectionRepository: Repository<MetaPageConnection>,
    @InjectRepository(BotChannelUser)
    private readonly userRepository: Repository<BotChannelUser>,
    @InjectRepository(BotConversation)
    private readonly conversationRepository: Repository<BotConversation>,
    @InjectRepository(BotMessage)
    private readonly messageRepository: Repository<BotMessage>,
    private readonly graphService: MetaGraphService,
  ) {}

  @Get('webhook')
  @RawResponse()
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ) {
    const expected = process.env.META_MESSAGING_VERIFY_TOKEN?.trim();
    if (!expected || mode !== 'subscribe' || !token || token !== expected) {
      throw new ForbiddenException('Invalid Meta messaging webhook verification token.');
    }
    return challenge ?? '';
  }

  @Post('webhook')
  @SkipThrottle()
  @HttpCode(200)
  @RawResponse()
  async receive(
    @Body() body: WebhookBody,
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature?: string,
  ) {
    const events = (body?.entry ?? []).reduce((n, e) => n + (e.messaging?.length ?? 0), 0);
    const standby = (body?.entry ?? []).reduce((n, e) => n + (e.standby?.length ?? 0), 0);
    const changes = Array.from(new Set((body?.entry ?? []).flatMap((e) => (e.changes ?? []).map((c) => c.field ?? '?'))));
    this.logger.log(`webhook received: object=${body?.object ?? '?'} entries=${body?.entry?.length ?? 0} messaging=${events}`
      + `${standby ? ` standby=${standby}` : ''}${changes.length ? ` changes=${changes.join(',')}` : ''} account=${(body?.entry ?? []).map((e) => e.id ?? '?').join(',')}`);
    webhookReceived('messenger');
    const secrets = metaAppSecrets();
    const raw = request.rawBody;
    if (!secrets.length || !raw || !signature?.startsWith('sha256=')) {
      this.logger.warn('webhook rejected: missing signature or META_APP_SECRET');
      webhookRejected('messenger', !secrets.length ? 'META_APP_SECRET is not set on the server.' : 'Missing webhook signature (the request did not come from Meta).');
      throw new ForbiddenException('Meta webhook signature could not be verified.');
    }
    const supplied = Buffer.from(signature.slice(7), 'hex');
    const valid = secrets.some((secret) => {
      const expected = createHmac('sha256', secret).update(raw).digest();
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    });
    if (!valid) {
      this.logger.warn('webhook rejected: invalid signature – META_APP_SECRET does not match the Meta app');
      webhookRejected('messenger', 'Invalid signature – META_APP_SECRET on the server is not the secret of the Meta app that sent it (old app still subscribed, or the secret was reset).');
      throw new ForbiddenException('Invalid Meta webhook signature.');
    }
    webhookAccepted('messenger');

    let saved = 0;
    // comments and posts (Page "feed" / Instagram "comments") go to the Social section
    SocialHook.capture(body);
    const platform = body?.object === 'instagram' ? 'instagram' : body?.object === 'page' ? 'messenger' : null;
    if (!platform) return { ok: true, saved };

    for (const entry of body.entry ?? []) {
      const accountId = String(entry.id ?? '').trim();
      if (!accountId) continue;
      const connection = await this.connectionRepository.findOne({
        where: platform === 'instagram'
          ? { instagram_business_account_id: accountId, status: 'CONNECTED' }
          : { page_id: accountId, status: 'CONNECTED' },
        order: { updated_at: 'DESC' },
      });
      if (!connection) continue;
      const companyId = Number(connection.company_id);

      for (const event of entry.messaging ?? []) {
        saved += await this.handleEvent(connection, companyId, platform, accountId, event, 'meta-webhook');
      }
      // "standby": another app (an old chatbot) or the Page inbox still holds this chat. Take the chat over so the
      // bot / team can answer, then handle the message like any other. Echoes in standby are just saved.
      for (const event of entry.standby ?? []) {
        const customer = String(event.sender?.id ?? '').trim();
        if (platform === 'messenger' && event.message && !event.message.is_echo && customer && customer !== accountId && connection.page_access_token) {
          const taken = await this.graphService.takeThreadControl(connection.page_access_token, customer);
          if (!taken) this.logger.warn(`standby: could not take the chat of ${customer} on page ${accountId} – set Agent Metra as the default routing app`);
        }
        saved += await this.handleEvent(connection, companyId, platform, accountId, event, 'meta-webhook-standby');
      }
    }
    return { ok: true, saved };
  }

  /** One Messenger / Instagram webhook event → contact, conversation, messages, bot. */
  private async handleEvent(connection: MetaPageConnection, companyId: number, platform: 'messenger' | 'instagram', accountId: string,
    event: MessagingEvent, source: string): Promise<number> {
    let saved = 0;
    const message = event.message;
    const postback = event.postback;
    recordMetaEvent(companyId, platform, event as Record<string, any>);
    if (process.env.META_WEBHOOK_LOG === '1') this.logger.log(`meta event (${platform}): ${JSON.stringify(event).slice(0, 4000)}`);
    // echo = a message the Page itself sent (Messenger app, Business Suite, another tool) → customer is the recipient
    const isEcho = Boolean(message?.is_echo);
    const senderId = String((isEcho ? event.recipient?.id : event.sender?.id) ?? '').trim();
    if (!senderId || senderId === accountId) return saved;
    const statusHandled = await this.applyMessageStatus(companyId, platform, accountId, senderId, event);
    if (statusHandled) {
      return 1;
    }
    if (message?.is_deleted) return saved;
    // sent through this app (agent reply, bot, private reply) → already saved when it was sent
    if (isEcho && String(message?.app_id ?? '') === String(process.env.META_APP_ID ?? '').trim()) return saved;
    if (!message && !postback) {
      // "opened the chat from an ad / post / m.me link" (before the customer writes anything) = a new lead right away
      if (event.referral) saved += await this.handleOpenedFromAd(connection, companyId, platform, accountId, senderId, event);
      return saved;
    }

    const providerId = String(message?.mid ?? postback?.mid ?? '').trim() || null;
    if (providerId) {
      const duplicate = await this.messageRepository.findOne({
        where: { platform, provider_message_id: providerId },
      });
      if (duplicate) return saved;
    }

    const rows = await this.buildRows(companyId, message, postback, {
      token: connection.page_access_token, mid: providerId, pageId: connection.page_id, igId: connection.instagram_business_account_id, isEcho,
    });
    if (!rows.length) return saved;

    const user = await this.ensureUser(companyId, platform, accountId, senderId, connection.page_access_token, connection.page_id);
    const conversation = await this.ensureConversation(user.id);
    if (isEcho) {
      // same text already saved as our own reply (bot / agent / private reply) a moment ago → not a new message
      const same = await this.messageRepository.createQueryBuilder('m')
        .where('m.conversation_id = :id', { id: conversation.id })
        .andWhere("m.direction::text = 'outbound'")
        .andWhere('m.content = :content', { content: rows[0].content })
        .andWhere("m.created_at > NOW() - INTERVAL '30 minutes'")
        .getOne();
      if (same) return saved;
    }

    // the customer replied to a Page message we never saw (the ad card Meta shows, a post, a story, an old message):
    // read it from Meta so the chat, the AI and the ads report know what "this" is
    const referralInEvent = Boolean(event.referral ?? message?.referral ?? (postback as { referral?: unknown } | undefined)?.referral);
    let card: RepliedCard | null = null;
    let cardIsLead = false;
    const safe = async <T>(run: () => Promise<T>, fallback: T) => { try { return await run(); } catch { return fallback; } };
    const recentClick = async (minutes = 10) => (await safe(() => this.messageRepository.query(
      `SELECT 1 FROM marketing_ad_click WHERE conversation_id = $1 AND clicked_at > NOW() - make_interval(mins => $2::int) LIMIT 1`, [conversation.id, minutes]), [] as unknown[])).length > 0;
    if (!isEcho && message?.reply_to?.mid) {
      card = await this.loadRepliedMessage(connection, platform, accountId, conversation.id, String(message.reply_to.mid)).catch(() => null);
      if (card) {
        // an ad / post card: has a photo, video or link and was shown to the customer in the last 3 days
        cardIsLead = !referralInEvent && Boolean(card.mediaUrl || card.link) && Date.now() - card.createdAt.getTime() < 3 * 86_400_000 && !(await recentClick());
        const stored = await this.saveContextMessage(companyId, conversation.id, platform, card.mid, card.title, card.mediaUrl, card.createdAt);
        if (stored) card.mediaUrl = stored;
      }
    } else if (!isEcho && message && !referralInEvent && !message.reply_to) {
      // Click-to-Messenger / Instagram ad with a welcome message: Meta shows the ad card + greeting in the chat but often
      // sends us neither. When a customer writes after a quiet time, read the last messages of the chat from Meta and
      // bring in the Page messages we never got (the ad card, the greeting) – the newest card = the ad they came from.
      const quiet = await safe(() => this.messageRepository.query(
        `SELECT 1 FROM bot_message WHERE conversation_id = $1 AND direction::text = 'inbound' AND created_at > NOW() - INTERVAL '30 minutes' LIMIT 1`, [conversation.id]), [{}] as unknown[]);
      if (!quiet.length) {
        const found = await safe(() => this.loadRecentPageMessages(connection, platform, accountId, senderId, conversation.id), [] as RepliedCard[]);
        for (const item of found) {
          const stored = await this.saveContextMessage(companyId, conversation.id, platform, item.mid, item.title, item.mediaUrl, item.createdAt).catch(() => null);
          if (item.mediaUrl || item.link) card = { ...item, mediaUrl: stored ?? item.mediaUrl };
        }
        // the click itself was already counted (Meta sent it when the chat was opened) → only the card is shown
        if (card) cardIsLead = !(await recentClick(24 * 60));
      }
    }
    if (!isEcho && message?.reply_to?.story?.url) {
      const storyId = `story:${message.reply_to.story.id ?? createHash('sha1').update(message.reply_to.story.url).digest('hex').slice(0, 16)}`;
      await this.saveContextMessage(companyId, conversation.id, platform, storyId, '📖 Your story', message.reply_to.story.url, new Date()).catch(() => undefined);
    }

    for (const [index, row] of rows.entries()) {
      await this.messageRepository.save(this.messageRepository.create({
        conversation_id: conversation.id,
        direction: isEcho ? 'outbound' : 'inbound',
        delivery_status: isEcho ? 'sent' : null,
        message_type: row.message_type,
        platform,
        // one Meta message can carry several attachments → keep ids unique
        provider_message_id: providerId ? (index === 0 ? providerId : `${providerId}:${index}`) : null,
        content: row.content,
        media_url: row.media_url,
        media_note: row.media_note ?? null,
        source: isEcho ? 'meta-echo' : source,
      }));
      saved++;
    }

    // live update for the inbox (the chat list + open chat refresh instantly)
    this.pusherService.trigger(`company-${companyId}`, 'conversation_updated', {
      conversation_id: conversation.id,
      platform,
      direction: isEcho ? 'outbound' : 'inbound',
    });
    if (isEcho) return saved; // the bot answers customers, not the Page's own messages

    // the customer replied to (quoted) an earlier message
    const quoted = quotedFromMessengerMessage(message as { reply_to?: { mid?: string } } | undefined);
    if (quoted && providerId) {
      if (card && !quoted.text) quoted.text = card.title || (card.mediaType === 'video' ? '[your video]' : '[your photo]');
      await linkQuotedReply(this.messageRepository.manager, conversation.id, providerId, quoted).catch(() => undefined);
    }
    if (message?.reply_to?.story?.url && providerId) {
      const storyId = `story:${message.reply_to.story.id ?? createHash('sha1').update(message.reply_to.story.url).digest('hex').slice(0, 16)}`;
      await linkQuotedReply(this.messageRepository.manager, conversation.id, providerId, { providerId: storyId, text: 'your story' }).catch(() => undefined);
    }

    // ad tracking before flows and the AI, so they know which ad the customer clicked
    await MarketingHook.run({ entry: [{ id: accountId, messaging: [event] }] }, platform);
    if (card && cardIsLead && providerId) {
      // Meta sent no ad details, but the customer answered the ad / post card → count it as a lead from that card
      const key = createHash('sha1').update(`${platform}:${card.title}:${card.link ?? ''}`).digest('hex').slice(0, 14);
      await MarketingHook.run({ entry: [{ id: accountId, messaging: [{
        sender: { id: senderId }, recipient: { id: accountId }, message: { mid: providerId },
        referral: { source: 'REPLY_CARD', card: { key: `card-${key}`, title: card.title, media_url: card.mediaUrl, media_type: card.mediaType, link: card.link } },
      }] }] }, platform);
    }

    // Automation flows first (first message / keyword / ad / a waiting answer); a handled message gets no AI reply
    const referral = (event as { referral?: { ad_id?: string; source?: string } }).referral
      ?? (message as { referral?: { ad_id?: string; source?: string } } | undefined)?.referral
      ?? (postback as { referral?: { ad_id?: string; source?: string } } | undefined)?.referral;
    const flowHandled = await FlowHook.inbound({
      companyId, conversationId: conversation.id, platform, text: rows[0]?.content ?? '',
      adId: referral && (referral.ad_id || referral.source === 'ADS') ? String(referral.ad_id ?? '') || null : null,
      payload: (message as { quick_reply?: { payload?: string } } | undefined)?.quick_reply?.payload ?? (postback as { payload?: string } | undefined)?.payload ?? null,
    });
    if (flowHandled) return saved;

    // Python sales bot (when SALES_BOT_URL is set): answers Messenger / Instagram exactly like WhatsApp.
    // It decides by itself whether the bot may reply (company setting, agent takeover, closed chat).
    if (SalesBotHook.isActive()) {
      await SalesBotHook.notify({ companyId, conversationId: conversation.id, phone: senderId, provider: platform });
    }
    return saved;
  }

  /**
   * The customer tapped an ad / a post's "Send message" button / an m.me link. Meta shows them the card and the Page's
   * greeting; we create the contact and the chat now, bring in those Page messages, record the ad click and tell the team
   * – so the lead is in the inbox before the customer types anything.
   */
  private async handleOpenedFromAd(connection: MetaPageConnection, companyId: number, platform: 'messenger' | 'instagram', accountId: string,
    senderId: string, event: MessagingEvent): Promise<number> {
    const referral = (event.referral ?? {}) as { ad_id?: string; source?: string; ref?: string; ads_context_data?: { ad_title?: string } };
    const fromAd = Boolean(referral.ad_id || referral.source === 'ADS' || referral.ads_context_data);
    let conversationId: number | null = null;
    let name = '';
    try {
      const user = await this.ensureUser(companyId, platform, accountId, senderId, connection.page_access_token, connection.page_id);
      const conversation = await this.ensureConversation(user.id);
      conversationId = conversation.id;
      name = String(user.display_name || '').trim();
    } catch (error) {
      this.logger.warn(`ad click: could not create the chat (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!conversationId) {
      await MarketingHook.run({ entry: [{ id: accountId, messaging: [event] }] }, platform); // kept until the first message
      return 0;
    }
    const before = await this.messageRepository.query(
      `SELECT 1 FROM marketing_ad_click WHERE conversation_id = $1 AND clicked_at > NOW() - INTERVAL '10 minutes' LIMIT 1`, [conversationId]).catch(() => []);
    let saved = 0;
    const found = await this.loadRecentPageMessages(connection, platform, accountId, senderId, conversationId).catch(() => [] as RepliedCard[]);
    for (const item of found) {
      await this.saveContextMessage(companyId, conversationId, platform, item.mid, item.title, item.mediaUrl, item.createdAt).catch(() => null);
      saved++;
    }
    await MarketingHook.run({ entry: [{ id: accountId, messaging: [event] }] }, platform);
    if (fromAd && !before.length) {
      const [row] = await this.messageRepository.query(`SELECT ad_headline FROM bot_conversation WHERE id = $1`, [conversationId]).catch(() => [{}]);
      const headline = String(row?.ad_headline || referral.ads_context_data?.ad_title || '').trim();
      await this.messageRepository.query(
        `INSERT INTO bot_notification (company_id, kind, priority, title, message, conversation_id) VALUES ($1, 'ad_lead', 'MEDIUM', $2, $3, $4)`,
        [companyId, `New lead from your ${platform === 'instagram' ? 'Instagram' : 'Facebook'} ad`,
          `${name || 'A customer'} opened a chat from your ad${headline ? ` “${headline.slice(0, 80)}”` : ''}. Say hello before they leave.`, conversationId]).catch(() => undefined);
    }
    this.pusherService.trigger(`company-${companyId}`, 'conversation_updated', { conversation_id: conversationId, platform, direction: 'inbound' });
    return saved;
  }

  /** Reads a Page message the customer replied to, when it is not in the chat yet (null: ours already, the customer's own, or Meta refuses). */
  private async loadRepliedMessage(connection: MetaPageConnection, platform: 'messenger' | 'instagram', accountId: string, conversationId: number, mid: string): Promise<RepliedCard | null> {
    const known = await this.messageRepository.query(
      `SELECT 1 FROM bot_message WHERE conversation_id = $1 AND (provider_message_id = $2 OR provider_message_id LIKE $2 || ':%') LIMIT 1`, [conversationId, mid]);
    if (known.length || !connection.page_access_token) return null;
    const res = await this.graphService.healthGet<GraphMessage>(`/${encodeURIComponent(mid)}`, connection.page_access_token, {
      fields: 'id,created_time,from,message,attachments{mime_type,name,image_data,video_data,file_url},shares{link,name,description}',
    });
    if (!res.ok || !res.data) {
      this.logger.log(`replied-to message ${mid} (${platform}) could not be read from Meta: ${res.error ?? 'empty'}`);
      return null;
    }
    const from = String(res.data.from?.id ?? '');
    const ours = [accountId, connection.page_id, connection.instagram_business_account_id].filter(Boolean).map(String);
    if (from && !ours.includes(from)) return null; // the customer quoted their own message
    const attachment = res.data.attachments?.data?.[0];
    const share = res.data.shares?.data?.[0];
    const image = attachment?.image_data?.url ?? attachment?.image_data?.preview_url ?? null;
    const video = attachment?.video_data?.url ?? null;
    const title = (res.data.message ?? share?.name ?? share?.description ?? '').trim().slice(0, 1000);
    const mediaUrl = image ?? attachment?.video_data?.preview_url ?? null;
    if (!title && !mediaUrl && !share?.link) return null;
    const created = res.data.created_time ? new Date(res.data.created_time) : new Date();
    return {
      mid, title, mediaUrl, mediaType: video ? 'video' : image ? 'image' : null,
      createdAt: Number.isNaN(created.getTime()) ? new Date() : created, link: share?.link ?? null,
    };
  }

  /** Puts a Page message we did not have (ad card, story, old message) into the chat, before the customer's reply. */
  private async saveContextMessage(companyId: number, conversationId: number, platform: 'messenger' | 'instagram', providerId: string,
    text: string, mediaUrl: string | null, createdAt: Date): Promise<string | null> {
    const exists = await this.messageRepository.query(`SELECT media_url FROM bot_message WHERE conversation_id = $1 AND provider_message_id = $2 LIMIT 1`, [conversationId, providerId]);
    if (exists.length) return exists[0].media_url ?? null;
    const stored = mediaUrl ? await this.downloadAndStore(companyId, mediaUrl) : null;
    const row = await this.messageRepository.save(this.messageRepository.create({
      conversation_id: conversationId, direction: 'outbound', delivery_status: 'sent', platform,
      message_type: mediaUrl ? 'image' : 'text', content: text || (mediaUrl ? '[image]' : '[message]'),
      media_url: mediaUrl ? stored?.key ?? mediaUrl : null, provider_message_id: providerId, source: 'meta-context',
    }));
    await this.messageRepository.query(`UPDATE bot_message SET created_at = LEAST(($2::timestamptz)::timestamp, created_at) WHERE id = $1`, [row.id, createdAt.toISOString()]).catch(() => undefined);
    return row.media_url ?? null;
  }

  /**
   * Page messages of the last 24 hours in this chat that we never received (the ad card and greeting Meta shows after
   * an ad click, messages sent from a phone before the app was connected), oldest first. Read from Meta's conversation.
   */
  private async loadRecentPageMessages(connection: MetaPageConnection, platform: 'messenger' | 'instagram', accountId: string, senderId: string,
    conversationId: number): Promise<RepliedCard[]> {
    if (!connection.page_access_token || !connection.page_id) return [];
    const res = await this.graphService.healthGet<{ data?: Array<{ messages?: { data?: GraphMessage[] } }> }>(`/${connection.page_id}/conversations`, connection.page_access_token, {
      platform, user_id: senderId,
      fields: 'messages.limit(10){id,created_time,from,message,attachments{mime_type,name,image_data,video_data},shares{link,name,description}}',
    });
    if (!res.ok) {
      this.logger.log(`recent ${platform} messages could not be read from Meta: ${res.error ?? 'empty'}`);
      return [];
    }
    const ours = [accountId, connection.page_id, connection.instagram_business_account_id].filter(Boolean).map(String);
    const list = (res.data?.data?.[0]?.messages?.data ?? [])
      .filter((m) => m.id && ours.includes(String(m.from?.id ?? '')))
      .filter((m) => m.created_time && Date.now() - new Date(m.created_time).getTime() < 24 * 3600_000);
    if (!list.length) return [];
    const known: Array<{ provider_message_id: string; content: string }> = await this.messageRepository.query(
      `SELECT provider_message_id, content FROM bot_message WHERE conversation_id = $1 AND direction::text = 'outbound' AND created_at > NOW() - INTERVAL '2 days'`, [conversationId]);
    const ids = new Set(known.map((k) => String(k.provider_message_id ?? '').split(':')[0]));
    const texts = new Set(known.map((k) => String(k.content ?? '').trim()));
    const out: RepliedCard[] = [];
    for (const m of list) {
      const attachment = m.attachments?.data?.[0];
      const share = m.shares?.data?.[0];
      const image = attachment?.image_data?.url ?? attachment?.image_data?.preview_url ?? null;
      const video = attachment?.video_data?.url ?? null;
      const mediaUrl = image ?? attachment?.video_data?.preview_url ?? null;
      const title = (m.message ?? share?.name ?? share?.description ?? '').trim().slice(0, 1000);
      if (ids.has(String(m.id)) || (!mediaUrl && texts.has(title))) continue; // we have it (our own reply / echo)
      if (!title && !mediaUrl && !share?.link) continue;
      out.push({ mid: String(m.id), title, mediaUrl, mediaType: video ? 'video' : image ? 'image' : null, createdAt: new Date(String(m.created_time)), link: share?.link ?? null });
    }
    return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /* ───────── message → rows in the formats the inbox understands ───────── */

  private async buildRows(companyId: number, message: MessagingEvent['message'], postback: MessagingEvent['postback'],
    ctx: { token?: string | null; mid?: string | null; pageId?: string | null; igId?: string | null; isEcho?: boolean } = {}): Promise<SavedRow[]> {
    if (postback) {
      return [{ message_type: 'text', content: postback.title?.trim() || postback.payload?.trim() || '[button]', media_url: null }];
    }
    if (!message) return [];
    const text = message.text?.trim() ?? '';
    const attachments = message.attachments ?? [];
    if (!attachments.length) {
      if (!text) return [];
      // a shared link to one of our posts / reels → what that post says, so the bot knows which item they mean
      const note = ctx.isEcho ? null : await this.describeSharedLink(text, ctx).catch(() => null);
      return [{ message_type: 'text', content: text, media_url: null, media_note: note }];
    }

    const rows: SavedRow[] = [];
    // media Meta did not put in the webhook (no link) – read once from the message itself
    let graphMedia: Array<{ url: string; kind: 'image' | 'video' | 'audio' | 'file' }> | null = null;
    const mediaFromGraph = async () => {
      if (graphMedia) return graphMedia;
      graphMedia = [];
      if (!ctx.token || !ctx.mid) return graphMedia;
      const res = await this.graphService.healthGet<GraphMessage>(`/${encodeURIComponent(ctx.mid)}`, ctx.token, {
        fields: 'attachments{mime_type,name,image_data,video_data,file_url}',
      });
      for (const a of res.data?.attachments?.data ?? []) {
        const url = a.image_data?.url || a.video_data?.url || a.file_url || '';
        if (!url) continue;
        const mime = String(a.mime_type ?? '');
        graphMedia.push({ url, kind: a.image_data ? 'image' : a.video_data ? 'video' : mime.startsWith('audio') ? 'audio' : mime.startsWith('image') ? 'image' : 'file' });
      }
      if (!res.ok) this.logger.warn(`media lookup for ${ctx.mid} failed: ${res.error}`);
      return graphMedia;
    };

    for (const [index, attachment] of attachments.entries()) {
      const caption = index === 0 ? text : '';
      const type = String(attachment.type ?? '').toLowerCase();
      let url = attachment.payload?.url ?? attachment.url ?? '';
      const title = attachment.title?.trim() || attachment.payload?.title?.trim() || '';

      if (type === 'location') {
        const lat = attachment.payload?.coordinates?.lat;
        const lng = attachment.payload?.coordinates?.long;
        rows.push({
          message_type: 'text',
          content: lat != null && lng != null ? `📍 ${title || 'Location'}\nhttps://maps.google.com/?q=${lat},${lng}` : '[location]',
          media_url: null,
        });
        continue;
      }

      // the card Meta puts on a private reply to a comment ("You are responding to a user comment…") → the comment and its post
      if (/comment/i.test(title) && /respond|reply/i.test(title) || /[?&]comment_id=/.test(url)) {
        rows.push(...(await this.commentContextRows(companyId, url, caption, ctx.token)));
        continue;
      }

      const mediaType = ['image', 'video', 'audio', 'file', 'ig_reel', 'reel', 'story_mention', 'ig_post', 'share', 'animated_image'].includes(type);
      if (!url && (mediaType || type === 'unsupported_type' || !type)) {
        const found = (await mediaFromGraph())[index] ?? (await mediaFromGraph())[0];
        if (found) url = found.url;
      }
      if (url && (mediaType || type === 'unsupported_type' || type === 'template' || type === 'fallback')) {
        const stored = await this.downloadAndStore(companyId, url);
        const contentType = stored?.contentType ?? '';
        const looksImage = type === 'image' || type === 'animated_image' || contentType.startsWith('image/') || ((type === 'ig_post' || type === 'share') && !contentType);
        if (stored || mediaType) {
          const mediaUrl = stored?.key ?? url; // keep the Meta link if the download failed
          const label = type === 'ig_post' || type === 'share' ? (title ? `[shared post] ${title}` : '[shared post]')
            : type === 'story_mention' ? '[story mention]' : '';
          if (looksImage) {
            rows.push({ message_type: 'image', content: [caption, label].filter(Boolean).join('\n') || (attachment.payload?.sticker_id ? '[sticker]' : '[image]'), media_url: mediaUrl });
          } else if (type === 'audio' || contentType.startsWith('audio/')) {
            rows.push({ message_type: 'voice', content: caption || '[audio]', media_url: mediaUrl });
          } else if (type === 'file' || contentType === 'application/pdf') {
            rows.push({ message_type: 'text', content: stored?.fileName || caption || 'Document', media_url: mediaUrl });
          } else {
            rows.push({ message_type: 'text', content: [caption, label].filter(Boolean).join('\n') || '[video]', media_url: mediaUrl });
          }
          continue;
        }
      }

      // anything else → keep it readable, and log what Meta sent so it can be supported later
      if (!url && !title) this.logger.warn(`unsupported ${type || 'attachment'} from Meta: ${JSON.stringify(attachment).slice(0, 400)}`);
      const parts = [caption, title, url].filter(Boolean);
      rows.push({ message_type: 'text', content: parts.join('\n') || '[unsupported]', media_url: null });
    }
    return rows;
  }

  /**
   * A private reply to a comment: show what the customer commented and on which post (with the post photo),
   * so the team and the bot know what the chat is about.
   */
  private async commentContextRows(companyId: number, url: string, caption: string, token?: string | null): Promise<SavedRow[]> {
    let commentId = '';
    try { commentId = new URL(url).searchParams.get('comment_id') ?? ''; } catch { /* not a link */ }
    type Row = { message: string; post_id: string | null; post_text: string; post_link: string | null };
    const rows = commentId
      ? ((await this.messageRepository.query(
        `SELECT message, post_id, post_text, post_link FROM social_comment
          WHERE company_id = $1 AND (comment_id = $2 OR comment_id LIKE '%\\_' || $2) ORDER BY id DESC LIMIT 1`,
        [companyId, commentId]).catch(() => [])) as Row[])
      : [];
    const comment = rows[0];
    let picture: string | null = null;
    let postText = comment?.post_text ?? '';
    let link = comment?.post_link || url || null;
    if (comment?.post_id && token) {
      const post = await this.graphService.healthGet<{ full_picture?: string; message?: string; permalink_url?: string }>(
        `/${encodeURIComponent(comment.post_id)}`, token, { fields: 'full_picture,message,permalink_url' });
      if (post.data?.full_picture) picture = (await this.downloadAndStore(companyId, post.data.full_picture))?.key ?? null;
      postText ||= post.data?.message ?? '';
      link = post.data?.permalink_url || link;
    }
    const lines = [
      caption,
      comment?.message ? `💬 Reply to their comment: “${comment.message.slice(0, 300)}”` : '💬 Reply to their comment on your post',
      postText ? `📝 Post: ${postText.replace(/\s+/g, ' ').slice(0, 200)}` : '',
      link ?? '',
    ].filter(Boolean);
    return [{ message_type: picture ? 'image' : 'text', content: lines.join('\n'), media_url: picture }];
  }

  /**
   * The customer pasted a Facebook / Instagram link (facebook.com/share/r/…, a reel, a post, instagram.com/p/…).
   * When it is one of this Page's own posts or reels, read its text from Meta. Other people's posts stay a plain link.
   */
  private async describeSharedLink(text: string, ctx: { token?: string | null; pageId?: string | null; igId?: string | null }): Promise<string | null> {
    const link = text.match(/https?:\/\/(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.watch|instagram\.com)\/[^\s]+/i)?.[0];
    if (!link || !ctx.token) return null;
    let final = link;
    if (/\/share\/|fb\.watch/i.test(link)) {
      const res = await fetch(link, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentMetra/1.0)' } }).catch(() => null);
      if (res?.url) final = res.url;
      try { final = decodeURIComponent(new URL(final).searchParams.get('next') ?? '') || final; } catch { /* keep */ }
    }
    const describe = (t?: string | null) => (t ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
    // Instagram: /p/<code> or /reel/<code> → find it among the account's own posts
    const igCode = final.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i)?.[1];
    if (igCode && ctx.igId) {
      const media = await this.graphService.healthGet<{ data?: Array<{ shortcode?: string; caption?: string }> }>(
        `/${ctx.igId}/media`, ctx.token, { fields: 'shortcode,caption', limit: '100' });
      const hit = media.data?.data?.find((m) => m.shortcode === igCode);
      return hit ? `shared our Instagram post: ${describe(hit.caption) || '(no caption)'}` : null;
    }
    const id = final.match(/(?:reel|videos)\/(?:[^/?]+\/)?(\d{6,})/i)?.[1]
      ?? final.match(/[?&](?:story_fbid|v|fbid)=(\d{6,})/i)?.[1]
      ?? final.match(/\/(?:posts|permalink)\/(?:[^/?]+\/)?(pfbid\w+|\d{6,})/i)?.[1];
    if (!id) return null;
    for (const objectId of [id, ctx.pageId ? `${ctx.pageId}_${id}` : '']) {
      if (!objectId) continue;
      const res = await this.graphService.healthGet<{ message?: string; description?: string; title?: string; from?: { id?: string } }>(
        `/${objectId}`, ctx.token, { fields: /\d+_\d+/.test(objectId) ? 'message,from' : 'description,title,from' });
      const body = res.data;
      if (!res.ok || !body) continue;
      if (ctx.pageId && body.from?.id && String(body.from.id) !== String(ctx.pageId)) return null; // someone else's post
      const words = describe([body.title, body.message ?? body.description].filter(Boolean).join(' – '));
      return `shared our ${/reel|videos|fb\.watch|[?&]v=/i.test(final) ? 'reel / video' : 'post'}: ${words || '(no text)'}`;
    }
    return null;
  }

  /** Meta CDN links expire – keep our own copy so the chat can always show it. */
  private async downloadAndStore(companyId: number, url: string): Promise<{ key: string; fileName: string; contentType: string } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const stored = await this.downloadOnce(companyId, url);
      if (stored) return stored;
    }
    this.logger.warn(`could not download media from Meta: ${url.slice(0, 120)}`);
    return null;
  }

  private async downloadOnce(companyId: number, url: string): Promise<{ key: string; fileName: string; contentType: string } | null> {
    try {
      // some Meta CDN links (Instagram lookaside) refuse requests without a browser-like agent
      const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentMetra/1.0)', Accept: '*/*' } });
      if (!res.ok) return null;
      const size = Number(res.headers.get('content-length') ?? 0);
      if (size > MAX_DOWNLOAD_BYTES) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_DOWNLOAD_BYTES) return null;
      const contentType = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
      const fileName = this.fileNameFromUrl(url, res.headers.get('content-disposition'));
      return { key: saveChatMedia(companyId, buffer, contentType, fileName), fileName, contentType };
    } catch {
      return null;
    }
  }

  private fileNameFromUrl(url: string, disposition: string | null): string {
    const fromHeader = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
    if (fromHeader) return decodeURIComponent(fromHeader).trim();
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
      return /\.[a-z0-9]{1,5}$/i.test(last) ? last : '';
    } catch {
      return '';
    }
  }

  /* ───────── contact + conversation (same behaviour as before) ───────── */

  private async applyMessageStatus(companyId: number, platform: 'messenger' | 'instagram', accountId: string, senderId: string, event: any): Promise<boolean> {
    const delivery = event.delivery;
    const read = event.read;
    const status = read ? 'read' : delivery ? 'delivered' : null;
    if (!status) return false;

    const user = await this.userRepository.findOne({ where: { company_id: companyId, platform, source_account_id: accountId, external_user_id: senderId } });
    if (!user) return true;
    const conversation = await this.conversationRepository.findOne({ where: { bot_channel_user_id: user.id }, order: { id: 'DESC' } });
    if (!conversation) return true;

    const mids = Array.isArray(delivery?.mids) ? delivery.mids.map((mid: unknown) => String(mid).trim()).filter(Boolean) : [];
    const watermark = Number(read?.watermark ?? delivery?.watermark ?? 0);
    let affected = 0;

    if (mids.length) {
      const result = await this.messageRepository
        .createQueryBuilder()
        .update(BotMessage)
        .set({ delivery_status: status })
        .where('conversation_id = :conversationId', { conversationId: conversation.id })
        .andWhere('platform = :platform', { platform })
        .andWhere('provider_message_id IN (:...mids)', { mids })
        .andWhere("direction::text = 'outbound'")
        .execute();
      affected = Number(result.affected ?? 0);
    } else if (watermark > 0) {
      const seenAt = new Date(watermark);
      const result = await this.messageRepository
        .createQueryBuilder()
        .update(BotMessage)
        .set({ delivery_status: status })
        .where('conversation_id = :conversationId', { conversationId: conversation.id })
        .andWhere('platform = :platform', { platform })
        .andWhere("direction::text = 'outbound'")
        .andWhere('created_at <= :seenAt', { seenAt })
        .execute();
      affected = Number(result.affected ?? 0);
    }

    if (affected > 0) {
      this.pusherService.trigger(`company-${companyId}`, 'conversation_updated', { conversation_id: conversation.id, platform, message_status: status });
    }
    return true;
  }
  private async ensureUser(companyId: number, platform: 'messenger' | 'instagram', accountId: string, senderId: string, pageToken: string, pageId?: string | null) {
    let user = await this.userRepository.findOne({
      where: { company_id: companyId, platform, source_account_id: accountId, external_user_id: senderId },
    });
    if (!user) {
      user = this.userRepository.create({
        company_id: companyId,
        app_user_id: null,
        platform,
        external_user_id: senderId,
        source_account_id: accountId,
        display_name: senderId,
        language: 'English',
        language_locked: false,
        session_state: null,
        bot_enabled: false,
        // false = "no agent has decided yet", so the company's "auto-enable bot for new customers"
        // setting applies (same as new WhatsApp customers). true would keep the bot off forever.
        manual_mode: false,
        last_seen_at: new Date(),
      });
    }
    if (!user.display_name || user.display_name === senderId) {
      let name = '';
      try {
        const profile = await this.graphService.fetchMessagingProfile(senderId, pageToken, platform);
        name = (profile.username || profile.name || '').trim();
      } catch { /* the profile needs an extra Meta feature – the chat's participants below work without it */ }
      if (!name && pageId) {
        const res = await this.graphService.healthGet<{ data?: Array<{ participants?: { data?: Array<{ id?: string; name?: string; username?: string }> } }> }>(
          `/${pageId}/conversations`, pageToken, { platform, user_id: senderId, fields: 'participants' });
        const person = res.data?.data?.[0]?.participants?.data?.find((p) => String(p.id) === senderId);
        name = (person?.username || person?.name || '').trim();
      }
      user.display_name = name || user.display_name || senderId;
    }
    user.last_seen_at = new Date();
    return this.userRepository.save(user);
  }

  private async ensureConversation(channelUserId: number) {
    let conversation = await this.conversationRepository.findOne({
      where: { bot_channel_user_id: channelUserId },
      order: { id: 'DESC' },
    });
    if (!conversation || conversation.status === 'closed') {
      conversation = this.conversationRepository.create({
        bot_channel_user_id: channelUserId,
        status: 'open',
        assigned_agent_id: null,
        assigned_at: null,
        timeout_at: null,
        assignment_mode: 'unassigned',
        agent_last_read_at: null,
        last_message_at: new Date(),
      });
    }
    conversation.last_message_at = new Date();
    return this.conversationRepository.save(conversation);
  }
}
