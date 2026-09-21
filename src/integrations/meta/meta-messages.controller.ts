import {
  Body, Controller, ForbiddenException, Get, Headers, Post, Query, Req,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { BotChannelUser } from '../../bot-admin/entities/bot-channel-user.entity';
import { BotConversation } from '../../bot-admin/entities/bot-conversation.entity';
import { BotMessage } from '../../bot-admin/entities/bot-message.entity';
import { MetaPageConnection } from '../../meta/entities/meta-page-connection.entity';
import { MetaGraphService } from './meta-graph.service';

type Attachment = { type?: string; payload?: { url?: string } };
type MessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: Attachment[];
  };
};
type WebhookEntry = { id?: string; messaging?: MessagingEvent[] };
type WebhookBody = { object?: string; entry?: WebhookEntry[] };

@Controller('integrations/meta/messages')
export class MetaMessagesController {
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
      for (const event of entry.messaging ?? []) {
        const senderId = String(event.sender?.id ?? '').trim();
        const message = event.message;
        if (!senderId || senderId === accountId || !message || message.is_echo) continue;
        const providerId = String(message.mid ?? '').trim() || null;
        if (providerId) {
          const duplicate = await this.messageRepository.findOne({
            where: { platform, provider_message_id: providerId },
          });
          if (duplicate) continue;
        }
        let user = await this.userRepository.findOne({
          where: { company_id: Number(connection.company_id), platform, source_account_id: accountId, external_user_id: senderId },
        });
        if (!user) {
          user = this.userRepository.create({
            company_id: Number(connection.company_id),
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
            const profile = await this.graphService.fetchMessagingProfile(
              senderId, connection.page_access_token, platform,
            );
            user.display_name = (profile.username || profile.name || senderId).trim();
          } catch {
            user.display_name = user.display_name || senderId;
          }
        }
        user.last_seen_at = new Date();
        user = await this.userRepository.save(user);

        let conversation = await this.conversationRepository.findOne({
          where: { bot_channel_user_id: user.id },
          order: { id: 'DESC' },
        });
        if (!conversation || conversation.status === 'closed') {
          conversation = this.conversationRepository.create({
            bot_channel_user_id: user.id,
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
        conversation = await this.conversationRepository.save(conversation);
        const attachment = message.attachments?.find((item) => item.payload?.url);
        const image = attachment?.type === 'image';
        await this.messageRepository.save(this.messageRepository.create({
          conversation_id: conversation.id,
          direction: 'inbound',
          message_type: image ? 'image' : 'text',
          platform,
          provider_message_id: providerId,
          content: message.text?.trim() || (image ? '[image]' : '[media]'),
          media_url: image ? attachment?.payload?.url ?? null : null,
          source: 'meta-webhook',
        }));
        saved++;
      }
    }
    return { ok: true, saved };
  }
}
