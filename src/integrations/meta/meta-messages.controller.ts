import {
  Body, Controller, ForbiddenException, Get, Headers, Post, Query, Req,
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
import { MetaGraphService } from './meta-graph.service';

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
    is_deleted?: boolean;
    attachments?: Attachment[];
    quick_reply?: { payload?: string };
  };
  postback?: { mid?: string; title?: string; payload?: string };
};
type WebhookEntry = { id?: string; messaging?: MessagingEvent[] };
type WebhookBody = { object?: string; entry?: WebhookEntry[] };

type SavedRow = Pick<BotMessage, 'message_type' | 'content' | 'media_url'>;

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

@Controller('integrations/meta/messages')
export class MetaMessagesController {
  private readonly pusherService = new PusherService();
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
  @RawResponse()
  async receive(
    @Body() body: WebhookBody,
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature?: string,
  ) {
    const secret = process.env.META_APP_SECRET?.trim();
    const raw = request.rawBody;
    if (!secret || !raw || !signature?.startsWith('sha256=')) {
      throw new ForbiddenException('Meta webhook signature could not be verified.');
    }
    const expected = createHmac('sha256', secret).update(raw).digest();
    const supplied = Buffer.from(signature.slice(7), 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ForbiddenException('Invalid Meta webhook signature.');
    }

    let saved = 0;
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
        const senderId = String(event.sender?.id ?? '').trim();
        const message = event.message;
        const postback = event.postback;
        if (!senderId || senderId === accountId) continue;
        const statusHandled = await this.applyMessageStatus(companyId, platform, accountId, senderId, event);
        if (statusHandled) {
          saved++;
          continue;
        }
        if (message?.is_echo || message?.is_deleted) continue;
        if (!message && !postback) continue;

        const providerId = String(message?.mid ?? postback?.mid ?? '').trim() || null;
        if (providerId) {
          const duplicate = await this.messageRepository.findOne({
            where: { platform, provider_message_id: providerId },
          });
          if (duplicate) continue;
        }

        const rows = await this.buildRows(companyId, message, postback);
        if (!rows.length) continue;

        const user = await this.ensureUser(companyId, platform, accountId, senderId, connection.page_access_token);
        const conversation = await this.ensureConversation(user.id);

        for (const [index, row] of rows.entries()) {
          await this.messageRepository.save(this.messageRepository.create({
            conversation_id: conversation.id,
            direction: 'inbound',
            message_type: row.message_type,
            platform,
            // one Meta message can carry several attachments → keep ids unique
            provider_message_id: providerId ? (index === 0 ? providerId : `${providerId}:${index}`) : null,
            content: row.content,
            media_url: row.media_url,
            source: 'meta-webhook',
          }));
          saved++;
        }

        // live update for the inbox (the chat list + open chat refresh instantly)
        this.pusherService.trigger(`company-${companyId}`, 'conversation_updated', {
          conversation_id: conversation.id,
          platform,
          direction: 'inbound',
        });
      }
    }
    return { ok: true, saved };
  }

  /* ───────── message → rows in the formats the inbox understands ───────── */

  private async buildRows(companyId: number, message: MessagingEvent['message'], postback: MessagingEvent['postback']): Promise<SavedRow[]> {
    if (postback) {
      return [{ message_type: 'text', content: postback.title?.trim() || postback.payload?.trim() || '[button]', media_url: null }];
    }
    if (!message) return [];
    const text = message.text?.trim() ?? '';
    const attachments = message.attachments ?? [];
    if (!attachments.length) {
      return text ? [{ message_type: 'text', content: text, media_url: null }] : [];
    }

    const rows: SavedRow[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const caption = index === 0 ? text : '';
      const type = String(attachment.type ?? '').toLowerCase();
      const url = attachment.payload?.url ?? attachment.url ?? '';

      if (type === 'location') {
        const lat = attachment.payload?.coordinates?.lat;
        const lng = attachment.payload?.coordinates?.long;
        const name = attachment.title?.trim() || attachment.payload?.title?.trim() || 'Location';
        rows.push({
          message_type: 'text',
          content: lat != null && lng != null ? `📍 ${name}\nhttps://maps.google.com/?q=${lat},${lng}` : '[location]',
          media_url: null,
        });
        continue;
      }

      if (['image', 'video', 'audio', 'file', 'ig_reel', 'reel', 'story_mention'].includes(type) && url) {
        const stored = await this.downloadAndStore(companyId, url);
        const mediaUrl = stored?.key ?? url; // keep the Meta link if download failed
        if (type === 'image') {
          rows.push({ message_type: 'image', content: caption || (attachment.payload?.sticker_id ? '[sticker]' : '[image]'), media_url: mediaUrl });
        } else if (type === 'audio') {
          rows.push({ message_type: 'voice', content: caption || '[audio]', media_url: mediaUrl });
        } else if (type === 'file') {
          rows.push({ message_type: 'text', content: stored?.fileName || caption || 'Document', media_url: mediaUrl });
        } else {
          rows.push({ message_type: 'text', content: caption || '[video]', media_url: mediaUrl });
        }
        continue;
      }

      // share / fallback / template / anything else → keep it readable
      const title = attachment.title?.trim() || attachment.payload?.title?.trim();
      const parts = [caption, title, url].filter(Boolean);
      rows.push({ message_type: 'text', content: parts.join('\n') || '[unsupported]', media_url: null });
    }
    return rows;
  }

  /** Meta CDN links expire – keep our own copy so the chat can always show it. */
  private async downloadAndStore(companyId: number, url: string): Promise<{ key: string; fileName: string } | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return null;
      const size = Number(res.headers.get('content-length') ?? 0);
      if (size > MAX_DOWNLOAD_BYTES) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_DOWNLOAD_BYTES) return null;
      const contentType = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
      const fileName = this.fileNameFromUrl(url, res.headers.get('content-disposition'));
      return { key: saveChatMedia(companyId, buffer, contentType, fileName), fileName };
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
  private async ensureUser(companyId: number, platform: 'messenger' | 'instagram', accountId: string, senderId: string, pageToken: string) {
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
        manual_mode: true,
        last_seen_at: new Date(),
      });
    }
    if (!user.display_name || user.display_name === senderId) {
      try {
        const profile = await this.graphService.fetchMessagingProfile(senderId, pageToken, platform);
        user.display_name = (profile.username || profile.name || senderId).trim();
      } catch {
        user.display_name = user.display_name || senderId;
      }
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
