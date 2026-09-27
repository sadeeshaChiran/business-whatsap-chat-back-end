import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Company } from '../company/entities/company.entity';
import { CreateBotTrainingDto } from './dto/create-bot-training.dto';
import { UpdateBotTrainingDto } from './dto/update-bot-training.dto';
import { BotUsersQueryDto } from './dto/bot-users-query.dto';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { ToggleBotUserDto } from './dto/toggle-bot-user.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UpdateStatusTemplateDto } from './dto/update-status-template.dto';
import { CreateBotOrderDto } from './dto/create-bot-order.dto';
import { BotChannelUser } from './entities/bot-channel-user.entity';
import { BotConversation } from './entities/bot-conversation.entity';
import { BotConversationLabel } from './entities/bot-conversation-label.entity';
import { BotCustomerLabel } from './entities/bot-customer-label.entity';
import { BotCustomerNote } from './entities/bot-customer-note.entity';
import { BotMessage } from './entities/bot-message.entity';
import { BotMessageTemplate, type BotTemplateButton } from './entities/bot-message-template.entity';
import { SaveMessageTemplateDto, SendMessageTemplateDto } from './dto/save-message-template.dto';
import { BotOrderStatusHistory } from './entities/bot-order-status-history.entity';
import { BotOrderStatusTemplate } from './entities/bot-order-status-template.entity';
import { BotOrder, type BotOrderStatus } from './entities/bot-order.entity';
import { BotOrderItem } from './entities/bot-order-item.entity';
import { BotTrainingData } from './entities/bot-training-data.entity';
import { SupabaseCustomer } from '../supabase/entities/supabase-customer.entity';
import { WhatsappChannel } from '../whatsapp/entities/whatsapp-channel.entity';
import { MetaPageConnection } from '../meta/entities/meta-page-connection.entity';
import { EvolutionService } from '../integrations/evolution/evolution.service';
import {
  isBrowserDisplayableImageUrl,
  isWhatsAppHostedMediaUrl,
  resolvePhoneFromChatList,
  resolveRelatedChatJids,
  type EvolutionInboxMessage,
} from '../integrations/evolution/evolution-inbox.util';
import { User } from '../users/entities/user.entity';
import { PusherService } from '../common/pusher.service';
import { AgentRoutingService } from '../agent-routing/agent-routing.service';
import { WhatsappService } from '../integrations/whatsapp/whatsapp.service';
import { SendLocationDto } from './dto/send-location.dto';
import { SendContactDto } from './dto/send-contact.dto';
import {
  chatMediaCompanyId,
  isChatMediaKey,
  publicChatMediaUrl,
  readChatMedia,
  saveChatMedia,
} from './chat-media.store';

type CompanyContactChannelUser = {
  id: number;
  platform: string;
  external_user_id: string;
  display_name: string;
  language: string;
  bot_enabled: boolean;
  manual_mode: boolean;
  last_seen_at: Date | string | null;
};

type CompanyContactRow = {
  customer: {
    id: number;
    customer_phone: string;
    assigned_instance: string | null;
    first_seen_at: Date | string;
    last_seen_at: Date | string;
  };
  channelUser: CompanyContactChannelUser | null;
  conversation: {
    id: number;
    status: string;
    lead_stage?: string;
    assigned_agent_id?: number | null;
    last_message_at: Date | string | null;
  } | null;
  evolution_remote_jid: string | null;
  last_message_preview: string | null;
  unread_count?: number;
  last_message_direction?: 'inbound' | 'outbound' | null;
  last_message_delivery_status?: 'sent' | 'delivered' | 'read' | 'failed' | null;
  labels?: Array<{ id: number; name: string; color_code: string }>;
};

@Injectable()
export class BotAdminService {
  constructor(
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(SupabaseCustomer)
    private readonly customerRepository: Repository<SupabaseCustomer>,
    @InjectRepository(BotChannelUser)
    private readonly channelUserRepository: Repository<BotChannelUser>,
    @InjectRepository(BotConversation)
    private readonly conversationRepository: Repository<BotConversation>,
    @InjectRepository(BotConversationLabel)
    private readonly conversationLabelRepository: Repository<BotConversationLabel>,
    @InjectRepository(BotCustomerLabel)
    private readonly customerLabelRepository: Repository<BotCustomerLabel>,
    @InjectRepository(BotCustomerNote)
    private readonly customerNoteRepository: Repository<BotCustomerNote>,
    @InjectRepository(BotMessage)
    private readonly messageRepository: Repository<BotMessage>,
    @InjectRepository(BotMessageTemplate)
    private readonly messageTemplateRepository: Repository<BotMessageTemplate>,
    @InjectRepository(BotTrainingData)
    private readonly trainingRepository: Repository<BotTrainingData>,
    @InjectRepository(BotOrder)
    private readonly orderRepository: Repository<BotOrder>,
    @InjectRepository(BotOrderItem)
    private readonly orderItemRepository: Repository<BotOrderItem>,
    @InjectRepository(BotOrderStatusHistory)
    private readonly orderStatusHistoryRepository: Repository<BotOrderStatusHistory>,
    @InjectRepository(BotOrderStatusTemplate)
    private readonly orderStatusTemplateRepository: Repository<BotOrderStatusTemplate>,
    @InjectRepository(WhatsappChannel)
    private readonly whatsappChannelRepository: Repository<WhatsappChannel>,
    @InjectRepository(MetaPageConnection)
    private readonly metaPageConnectionRepository: Repository<MetaPageConnection>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly evolutionService: EvolutionService,
    private readonly pusherService: PusherService,
    private readonly agentRoutingService: AgentRoutingService,
    private readonly whatsappService: WhatsappService,
  ) {}

  private getEvolutionConfig() {
    // User may paste Evolution Manager URL (ends with /manager). API base is root.
    const rawBase =
      (process.env.EVOLUTION_API_BASE ?? process.env.EVOLUTION_BASE_URL ?? '').trim();
    // Some deployments proxy Evolution API under `/manager` (same origin as Manager UI).
    const base = rawBase.replace(/\/+$/, '');
    const secureKey =
      (process.env.EVOLUTION_API_KEY ?? process.env.EVOLUTION_SECURE_KEY ?? '').trim();
    return { base, secureKey, enabled: Boolean(base && secureKey) };
  }

  private async resolveCompanyWhatsappChannel(companyId: number) {
    const channels = await this.whatsappChannelRepository.find({
      where: { company_id: companyId },
      order: { id: 'DESC' },
    });
    if (!channels.length) {
      return null;
    }
    return (
      channels.find(
        (channel) =>
          channel.provider_type === 'meta' &&
          channel.meta_access_token?.trim() &&
          channel.meta_phone_number_id?.trim(),
      ) ??
      channels.find((channel) => channel.evaluation_whatsapp_key?.trim()) ??
      channels[0]
    );
  }

  private isMetaWhatsappChannel(channel: WhatsappChannel | null | undefined): boolean {
    return (channel?.provider_type ?? 'evolution') === 'meta';
  }

  private looksLikeMetaPhoneNumberId(value: string | null | undefined): boolean {
    const trimmed = String(value ?? '').trim();
    return trimmed.length >= 10 && /^\d+$/.test(trimmed);
  }

  private resolveEvolutionInstanceName(
    channel: WhatsappChannel | null | undefined,
  ): string {
    if (!channel || this.isMetaWhatsappChannel(channel)) {
      return '';
    }
    const alias = channel.evolution_instance_name?.trim();
    if (alias) {
      return alias;
    }
    const instance = channel.instance_name?.trim() ?? '';
    if (instance && !this.looksLikeMetaPhoneNumberId(instance)) {
      return instance;
    }
    return '';
  }

  private throwWhatsappSendError(error: unknown): never {
    console.error('WhatsApp service error details:', error);
    if (error instanceof BadRequestException) {
      throw error;
    }
    const message =
      error instanceof Error ? error.message : 'Failed to send WhatsApp message.';
    throw new BadRequestException(message);
  }

  private async assertWhatsappSendReady(channel: WhatsappChannel | null) {
    if (!channel) {
      throw new BadRequestException('WhatsApp is not configured for this company.');
    }

    if (this.isMetaWhatsappChannel(channel)) {
      if (
        !channel.meta_phone_number_id?.trim() ||
        !channel.meta_access_token?.trim()
      ) {
        throw new BadRequestException(
          'Meta WhatsApp credentials are not configured for this company.',
        );
      }
      return;
    }

    const evolution = this.getEvolutionConfig();
    const instance = channel.instance_name?.trim();
    const apikey = (channel.evaluation_whatsapp_key ?? evolution.secureKey)?.trim();
    if (!instance || !apikey) {
      throw new BadRequestException(
        'WhatsApp instance is not configured for this company.',
      );
    }
    if (!evolution.enabled && !channel.evolution_api_base?.trim()) {
      throw new BadRequestException(
        'Evolution API is not configured for sending WhatsApp messages.',
      );
    }
  }

  private async sendCompanyWhatsappText(
    companyId: number,
    phone: string,
    text: string,
  ): Promise<void> {
    const channel = await this.resolveCompanyWhatsappChannel(companyId);
    await this.assertWhatsappSendReady(channel);
    try {
      await this.whatsappService.sendText(companyId, phone, text);
    } catch (error) {
      this.throwWhatsappSendError(error);
    }
  }

  private async sendCompanyWhatsappMedia(
    companyId: number,
    phone: string,
    media: {
      buffer: Buffer;
      mimetype: string;
      fileName: string;
      caption?: string;
      mediaType: 'image' | 'document' | 'audio' | 'video';
    },
  ): Promise<void> {
    const channel = await this.resolveCompanyWhatsappChannel(companyId);
    await this.assertWhatsappSendReady(channel);
    try {
      await this.whatsappService.sendMedia(companyId, phone, media);
    } catch (error) {
      this.throwWhatsappSendError(error);
    }
  }

  private resolveOutboundMediaType(
    mimetype: string,
  ): 'image' | 'document' | 'audio' | 'video' {
    const mime = (mimetype || '').toLowerCase();
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'document';
  }

  private readonly defaultStatusTemplates: Record<BotOrderStatus, string> = {
    Pending: 'Your order  is pending.',
    Confirmed: 'Your order  has been confirmed.',
    Processing: 'Your order  is being processed.',
    Shipped: 'Your order  has been shipped.',
    Delivered: 'Your order  has been delivered.',
    Cancelled: 'Your order  has been cancelled.',
  };

  async getStats(user: AuthenticatedUser) {
    await this.assertAdminAccess(user);
    const company_id = user.company_id;

    const [totalUsers, activeBots, totalConversations, totalOrders, pendingOrders] =
      await Promise.all([
      this.channelUserRepository.count({ where: { company_id } }),
      this.channelUserRepository.count({ where: { company_id, bot_enabled: true } }),
      this.conversationRepository
        .createQueryBuilder('conversation')
        .leftJoin('conversation.channelUser', 'channelUser')
        .where('channelUser.company_id = :company_id', { company_id })
        .getCount(),
      this.orderRepository.count({ where: { company_id } }),
      this.orderRepository.count({ where: { company_id, status: 'Pending' } }),
    ]);

    return {
      totalUsers,
      activeBots,
      totalConversations,
      totalOrders,
      pendingOrders,
    };
  }

  private async getCompanyForUser(user: AuthenticatedUser): Promise<Company | null> {
    return this.companyRepository.findOne({ where: { id: user.company_id } });
  }

  private async assertCompanyAccess(user: AuthenticatedUser) {
    const company = await this.getCompanyForUser(user);

    if (!company) {
      throw new ForbiddenException('Company not found for the current user.');
    }
  }

  /** Labels and related data are always scoped to the logged-in user's company. */
  private requireUserCompanyId(user: AuthenticatedUser): number {
    const companyId = Number(user.company_id);
    if (!Number.isFinite(companyId) || companyId <= 0) {
      throw new ForbiddenException('Company not found.');
    }
    return companyId;
  }

  private async assertAdminAccess(user: AuthenticatedUser) {
    const company = await this.getCompanyForUser(user);
    if (!company || Number(company.admin_user_id) !== Number(user.id)) {
      throw new ForbiddenException('Only the company admin can manage bot settings.');
    }
  }

  /** Admin OR agent assigned to a conversation in their company can access it */
  private async assertConversationAccess(
    user: AuthenticatedUser,
    conversationId: number,
  ) {
    const company = await this.getCompanyForUser(user);
    if (!company) throw new ForbiddenException('Company not found.');

    const isAdmin = Number(company.admin_user_id) === Number(user.id);
    const conv = isAdmin
      ? await this.findConversationForCompany(conversationId, user.company_id)
      : await this.findConversationForCompany(
          conversationId,
          user.company_id,
          { assignedAgentId: user.id },
        );

    if (!conv) {
      if (isAdmin) {
        throw new NotFoundException('Conversation not found.');
      }
      throw new ForbiddenException('You do not have access to this conversation.');
    }
  }

  private findConversationForCompany(
    conversationId: number,
    companyId: number,
    options?: { assignedAgentId?: number },
  ) {
    const qb = this.conversationRepository
      .createQueryBuilder('c')
      .innerJoinAndSelect('c.channelUser', 'channelUser')
      .where('c.id = :conversationId', { conversationId })
      .andWhere('CAST(channelUser.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId: Number(companyId),
      });

    if (options?.assignedAgentId != null) {
      qb.andWhere('CAST(c.assigned_agent_id AS BIGINT) = CAST(:agentId AS BIGINT)', {
        agentId: Number(options.assignedAgentId),
      });
    }

    return qb.getOne();
  }

  private findAssignedConversationForAgent(
    conversationId: number,
    agentId: number,
    companyId: number,
  ) {
    return this.findConversationForCompany(conversationId, companyId, {
      assignedAgentId: agentId,
    });
  }

  /** Toggle the logged-in user's own is_agent_active status (online/offline for agents) */
  async toggleOwnStatus(user: AuthenticatedUser) {
    const u = await this.userRepository.findOne({ where: { id: user.id } });
    if (!u) throw new NotFoundException('User not found.');
    u.is_agent_active = !u.is_agent_active;
    const saved = await this.userRepository.save(u);

    let autoAssigned = 0;
    if (saved.is_agent_active) {
      autoAssigned = await this.agentRoutingService.assignOpenQueueForCompany(
        Number(user.company_id),
      );
      if (autoAssigned > 0) {
        this.pusherService.trigger(
          `company-${user.company_id}`,
          'conversation_updated',
          { auto_assigned: autoAssigned },
        );
      }
    } else {
      await this.agentRoutingService.releasePendingChatsWhenNoOnlineAgents(
        Number(user.company_id),
      );
    }

    this.pusherService.trigger(
      `company-${user.company_id}`,
      'agent_status_changed',
      { agent_id: saved.id, is_agent_active: saved.is_agent_active },
    );
    return {
      id: saved.id,
      is_agent_active: saved.is_agent_active,
      auto_assigned: autoAssigned,
    };
  }

  /** Agent accepts a pending conversation (status: pending → active) */
  async acceptConversation(user: AuthenticatedUser, conversationId: number) {
    const conv = await this.findAssignedConversationForAgent(
      conversationId,
      user.id,
      user.company_id,
    );
    if (!conv) throw new NotFoundException('Conversation not found or not assigned to you.');
    if (conv.status !== 'pending') {
      throw new BadRequestException('Conversation is not in pending state.');
    }
    conv.status = 'active';
    conv.timeout_at = null;
    conv.agent_last_read_at = new Date();
    const saved = await this.conversationRepository.save(conv);

    const channelUser = conv.channelUser;
    const phone = channelUser?.external_user_id ?? '';
    if (phone) {
      await this.agentRoutingService.recordStickyAgent(
        user.company_id,
        phone,
        user.id,
      );
    }

    if (channelUser) {
      channelUser.manual_mode = false;
      channelUser.last_seen_at = new Date();
      await this.channelUserRepository.save(channelUser);
    }

    const agentLabel =
      user.name?.trim() || user.email?.split('@')[0]?.trim() || 'Our team';
    const welcomeText = `Hi! ${agentLabel} is now here to help you. How can I assist you today?`;
    if (phone) {
      try {
        await this.sendCompanyWhatsappText(user.company_id, phone, welcomeText);
        await this.messageRepository.save(
          this.messageRepository.create({
            conversation_id: saved.id,
            direction: 'outbound',
            message_type: 'text',
            platform: channelUser?.platform || 'whatsapp',
            content: welcomeText,
            source: 'admin',
          }),
        );
      } catch (error) {
        console.warn(
          `Accept welcome WhatsApp failed for conversation ${saved.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    this.pusherService.trigger(
      `company-${user.company_id}`,
      'conversation_updated',
      { conversation_id: saved.id, status: saved.status, agent_id: user.id },
    );
    return { id: saved.id, status: saved.status };
  }

  /** Agent rejects a pending conversation and routes it to the next available agent */
  async rejectConversation(user: AuthenticatedUser, conversationId: number) {
    const conv = await this.findAssignedConversationForAgent(
      conversationId,
      user.id,
      user.company_id,
    );
    if (!conv) {
      throw new NotFoundException('Conversation not found or not assigned to you.');
    }
    if (conv.status !== 'pending') {
      throw new BadRequestException('Only pending conversations can be rejected.');
    }

    const phone = conv.channelUser?.external_user_id ?? '';
    const result = await this.agentRoutingService.routeInboundConversation(
      user.company_id,
      conversationId,
      phone,
      user.id,
    );

    return {
      id: conversationId,
      status: result.agentId ? 'pending' : 'open',
      assigned_agent_id: result.agentId,
      assignment_mode: result.assignmentMode,
      message: result.agentId
        ? 'Conversation reassigned to the next available agent.'
        : 'No other agents are online. Conversation returned to the open queue.',
    };
  }

  async updateLeadStage(
    user: AuthenticatedUser,
    conversationId: number,
    leadStage: 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost',
  ) {
    await this.assertAdminAccess(user);
    const conversation = await this.findConversationForCompany(conversationId, user.company_id);
    if (!conversation) throw new NotFoundException('Conversation not found.');
    conversation.lead_stage = leadStage;
    const saved = await this.conversationRepository.save(conversation);
    return { id: saved.id, lead_stage: saved.lead_stage };
  }
  async getUnassignedConversations(user: AuthenticatedUser) {
    await this.assertAdminAccess(user);
    return this.agentRoutingService.getUnassignedConversations(user.company_id);
  }

  async manualAssignConversation(
    user: AuthenticatedUser,
    conversationId: number,
    agentId: number,
  ) {
    await this.assertAdminAccess(user);
    await this.agentRoutingService.manualAssignConversation(
      user.company_id,
      conversationId,
      agentId,
    );
    return {
      id: conversationId,
      status: 'pending',
      assigned_agent_id: agentId,
      assignment_mode: 'manual',
    };
  }

  private normalizePhoneKey(phone: string): string {
    return phone.replace(/\D/g, '');
  }

  private phoneKeysEquivalent(left: string, right: string): boolean {
    const a = this.normalizePhoneKey(left);
    const b = this.normalizePhoneKey(right);
    if (!a || !b) {
      return false;
    }
    if (a === b) {
      return true;
    }
    const stripLeadingZeros = (value: string) => value.replace(/^0+/, '') || value;
    const sa = stripLeadingZeros(a);
    const sb = stripLeadingZeros(b);
    if (sa === sb) {
      return true;
    }
    return false;
  }

  private hashEvolutionMessageId(id: string): number {
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) {
      hash = (hash * 31 + id.charCodeAt(index)) % 900_000_000;
    }
    return Math.abs(hash);
  }

  private mapEvolutionMessagesToBotMessages(
    messages: Array<{
      id?: string;
      direction: 'inbound' | 'outbound';
      message_type: 'text' | 'image' | 'voice' | 'system';
      content: string;
      media_url?: string | null;
      created_at: string;
    }>,
  ) {
    return messages.map((message, index) =>
      this.hydrateThreadMessage({
        id: message.id
          ? 1_000_000_000 + this.hashEvolutionMessageId(message.id)
          : 1_000_000_000 + index,
        direction: message.direction,
        message_type: message.message_type,
        platform: 'whatsapp',
        content: message.content,
        media_url: message.media_url ?? null,
        transcript: null,
        created_at: message.created_at,
      }),
    );
  }

  private contactPhoneFromRow(row: CompanyContactRow): string {
    return (
      this.normalizePhoneKey(row.customer.customer_phone) ||
      this.normalizePhoneKey(String(row.channelUser?.external_user_id ?? '')) ||
      this.normalizePhoneKey(String(row.evolution_remote_jid ?? '').split('@')[0] ?? '')
    );
  }

  private rowMatchesPhone(row: CompanyContactRow, phone: string): boolean {
    if (!phone) {
      return false;
    }
    if (this.phoneKeysEquivalent(row.customer.customer_phone, phone)) {
      return true;
    }
    if (
      row.channelUser &&
      this.phoneKeysEquivalent(row.channelUser.external_user_id, phone)
    ) {
      return true;
    }
    if (row.evolution_remote_jid) {
      const jidPhone = this.normalizePhoneKey(row.evolution_remote_jid.split('@')[0] ?? '');
      if (jidPhone && this.phoneKeysEquivalent(jidPhone, phone)) {
        return true;
      }
    }
    return false;
  }

  private static readonly THREAD_IMAGE_URL_RE = /https?:\/\/[^\s<>"']+/gi;

  private isDisplayableImageUrl(value: string | null | undefined): boolean {
    return isBrowserDisplayableImageUrl(String(value ?? '').trim());
  }

  /** Images AND voice notes from Evolution get their media inlined (the inbox can't fetch Evolution ids). */
  private needsEvolutionImageEnrichment(message: EvolutionInboxMessage): boolean {
    if (message.message_type !== 'image' && message.message_type !== 'voice') {
      return false;
    }
    const mediaUrl = String(message.media_url ?? '').trim();
    if (!mediaUrl) {
      return true;
    }
    if (mediaUrl.startsWith('data:')) {
      return false;
    }
    return isWhatsAppHostedMediaUrl(mediaUrl) || !/^https?:\/\//.test(mediaUrl) || message.message_type === 'voice';
  }

  private hydrateThreadMessage<
    T extends {
      id?: number;
      direction: string;
      message_type: string;
      content: string;
      media_url?: string | null;
    },
  >(message: T): T {
    let mediaUrl = String(message.media_url ?? '').trim();
    if (!this.isDisplayableImageUrl(mediaUrl)) {
      const matches = String(message.content ?? '').match(
        BotAdminService.THREAD_IMAGE_URL_RE,
      );
      const fromContent = matches?.find((url) => this.isDisplayableImageUrl(url))?.trim();
      if (fromContent) {
        mediaUrl = fromContent;
      }
    }
    if (!mediaUrl) {
      return message;
    }
    if (message.message_type !== 'image' && this.isDisplayableImageUrl(mediaUrl)) {
      return { ...message, media_url: mediaUrl, message_type: 'image' };
    }
    if (!message.media_url) {
      return { ...message, media_url: mediaUrl };
    }
    return message;
  }

  private messageMergeKey(message: {
    id?: number;
    direction: string;
    message_type?: string;
    content: string;
    media_url?: string | null;
    created_at: string | Date;
  }): string {
    const mediaUrl = String(message.media_url ?? '').trim();
    const messageType = String(message.message_type ?? 'text');
    if (messageType === 'image' || mediaUrl) {
      const id = Number(message.id);
      if (Number.isFinite(id) && id > 0) {
        return `img:${id}`;
      }
      const timestamp = new Date(message.created_at).getTime();
      const bucket = Number.isFinite(timestamp) ? Math.floor(timestamp / 30000) : 0;
      return `img:${message.direction}|${mediaUrl || message.content.trim().toLowerCase()}|${bucket}`;
    }

    const timestamp = new Date(message.created_at).getTime();
    const bucket = Number.isFinite(timestamp) ? Math.floor(timestamp / 30000) : 0;
    return `${message.direction}|${message.content.trim().toLowerCase()}|${bucket}`;
  }

  private serializeBotMessage(message: BotMessage) {
    return this.hydrateThreadMessage({
      id: message.id,
      direction: message.direction,
      message_type: message.message_type,
      platform: message.platform,
      content: message.content,
      media_url: message.media_url,
      transcript: message.transcript,
      created_at: message.created_at,
    });
  }

  private toDataImageUrl(base64: string, mimetype: string): string {
    const trimmed = base64.trim();
    if (!trimmed) {
      return '';
    }
    if (trimmed.startsWith('data:')) {
      return trimmed;
    }
    const cleaned = trimmed.includes(',') ? trimmed.split(',').pop() ?? trimmed : trimmed;
    // "audio/ogg; codecs=opus" → "audio/ogg" (parameters break data URLs and our parser)
    const mime = (mimetype || 'image/jpeg').split(';')[0].trim() || 'image/jpeg';
    return `data:${mime};base64,${cleaned}`;
  }

  private static readonly META_MEDIA_PREFIX = 'meta-media:';

  private metaGraphVersion(): string {
    return (
      process.env.META_GRAPH_API_VERSION ??
      process.env.WHATSAPP_GRAPH_API_VERSION ??
      'v22.0'
    ).trim();
  }

  private extractMetaMediaId(message: {
    media_url?: string | null;
    content?: string | null;
  }): string {
    const mediaUrl = String(message.media_url ?? '').trim();
    if (mediaUrl.startsWith(BotAdminService.META_MEDIA_PREFIX)) {
      return mediaUrl.slice(BotAdminService.META_MEDIA_PREFIX.length).trim();
    }
    if (/^\d{10,}$/.test(mediaUrl)) {
      return mediaUrl;
    }
    const content = String(message.content ?? '').trim();
    const customerImageMatch = content.match(/\[customer image:\s*([^\]]+)\]/i);
    if (customerImageMatch?.[1]?.trim()) {
      return customerImageMatch[1].trim();
    }
    return '';
  }

  /** Only real images. Voice notes / documents / videos must keep their type and are loaded by the inbox on demand. */
  private needsMetaImageEnrichment(message: {
    message_type?: string;
    content?: string;
    media_url?: string | null;
  }): boolean {
    if (this.isDisplayableImageUrl(message.media_url) || isChatMediaKey(message.media_url)) {
      return false;
    }
    const messageType = String(message.message_type ?? '').toLowerCase();
    const content = String(message.content ?? '').trim();
    const looksLikeImage = messageType === 'image' || content === '[image]' || /\[customer image:/i.test(content);
    if (!looksLikeImage) {
      return false;
    }
    return Boolean(this.extractMetaMediaId(message)) || isWhatsAppHostedMediaUrl(String(message.media_url ?? '')) || messageType === 'image';
  }

  private async fetchMetaMediaAsDataUrl(
    mediaId: string,
    accessToken: string,
  ): Promise<string> {
    const id = mediaId.trim();
    const token = accessToken.trim();
    if (!id || !token) {
      return '';
    }

    try {
      const metaRes = await fetch(
        `https://graph.facebook.com/${this.metaGraphVersion()}/${id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(12000),
        },
      );
      if (!metaRes.ok) {
        return '';
      }
      const metaJson = (await metaRes.json()) as { url?: string; mime_type?: string };
      const mediaUrl = String(metaJson.url ?? '').trim();
      if (!mediaUrl) {
        return '';
      }
      const binRes = await fetch(mediaUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!binRes.ok) {
        return '';
      }
      const mime =
        binRes.headers.get('content-type')?.trim() ||
        String(metaJson.mime_type ?? '').trim() ||
        'image/jpeg';
      const buffer = Buffer.from(await binRes.arrayBuffer());
      if (!buffer.length) {
        return '';
      }
      return this.toDataImageUrl(buffer.toString('base64'), mime);
    } catch {
      return '';
    }
  }

  private async fetchWhatsAppHostedMediaAsDataUrl(
    mediaUrl: string,
    accessToken: string,
  ): Promise<string> {
    const url = mediaUrl.trim();
    const token = accessToken.trim();
    if (!url || !token || !isWhatsAppHostedMediaUrl(url)) {
      return '';
    }
    try {
      const binRes = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!binRes.ok) {
        return '';
      }
      const mime = binRes.headers.get('content-type')?.trim() || 'image/jpeg';
      const buffer = Buffer.from(await binRes.arrayBuffer());
      if (!buffer.length) {
        return '';
      }
      return this.toDataImageUrl(buffer.toString('base64'), mime);
    } catch {
      return '';
    }
  }

  private async enrichMetaDbImageMessages<
    T extends {
      id?: number;
      message_type?: string;
      content?: string;
      media_url?: string | null;
    },
  >(messages: T[], channel: WhatsappChannel | null): Promise<T[]> {
    const token = channel?.meta_access_token?.trim() ?? '';
    if (!token) {
      return messages;
    }

    const enrichedByKey = new Map<string, string>();
    const targets = messages
      .filter((message) => this.needsMetaImageEnrichment(message))
      .slice(-24);

    for (const message of targets) {
      const mediaId = this.extractMetaMediaId(message);
      let dataUrl = '';
      if (mediaId) {
        dataUrl = await this.fetchMetaMediaAsDataUrl(mediaId, token);
      }
      if (!dataUrl) {
        dataUrl = await this.fetchWhatsAppHostedMediaAsDataUrl(
          String(message.media_url ?? ''),
          token,
        );
      }
      // only real images are inlined – never turn audio/documents into image rows
      if (!dataUrl || !dataUrl.startsWith('data:image/')) {
        continue;
      }
      const key =
        Number(message.id) > 0
          ? `id:${message.id}`
          : `${String(message.message_type ?? '')}|${String(message.media_url ?? '')}|${String(message.content ?? '').slice(0, 80)}`;
      enrichedByKey.set(key, dataUrl);
    }

    if (!enrichedByKey.size) {
      return messages;
    }

    return messages.map((message) => {
      const key =
        Number(message.id) > 0
          ? `id:${message.id}`
          : `${String(message.message_type ?? '')}|${String(message.media_url ?? '')}|${String(message.content ?? '').slice(0, 80)}`;
      const mediaUrl = enrichedByKey.get(key);
      if (!mediaUrl) {
        return message;
      }
      return {
        ...message,
        message_type: 'image',
        media_url: mediaUrl,
      };
    });
  }

  private async enrichEvolutionImageMessages(
    instance: string,
    apikey: string,
    messages: EvolutionInboxMessage[],
    phone = '',
  ): Promise<EvolutionInboxMessage[]> {
    const targets = messages.filter((message) => this.needsEvolutionImageEnrichment(message)).slice(-24);

    if (!targets.length) {
      return messages;
    }

    const enrichedById = new Map<string, string>();
    for (const message of targets) {
      const remoteJids = [message.remote_jid];
      const normalizedPhone = this.normalizePhoneKey(phone);
      if (message.remote_jid.endsWith('@lid') && normalizedPhone) {
        remoteJids.push(`${normalizedPhone}@s.whatsapp.net`);
      }

      let dataUrl = '';
      for (const remoteJid of remoteJids) {
        const media = await this.evolutionService.getBase64FromMediaMessage(
          instance,
          {
            messageId: message.id,
            remoteJid,
            fromMe: message.direction === 'outbound',
          },
          apikey,
        );
        if (!media?.base64) {
          continue;
        }
        dataUrl = this.toDataImageUrl(media.base64, media.mimetype);
        if (dataUrl) {
          break;
        }
      }
      if (dataUrl) {
        enrichedById.set(message.id, dataUrl);
      }
    }

    if (!enrichedById.size) {
      return messages;
    }

    return messages.map((message) => {
      const mediaUrl = enrichedById.get(message.id);
      if (!mediaUrl) {
        return message;
      }
      return { ...message, media_url: mediaUrl };
    });
  }

  private mergeConversationThreadMessages(
    dbMessages: BotMessage[],
    evolutionMessages: Array<{
      direction: 'inbound' | 'outbound';
      message_type: 'text' | 'image' | 'voice' | 'system';
      content: string;
      media_url?: string | null;
      created_at: string;
    }>,
  ) {
    const seen = new Set<string>();
    const merged = [
      ...dbMessages.map((message) => this.serializeBotMessage(message)),
      ...this.mapEvolutionMessagesToBotMessages(evolutionMessages),
    ].filter((message) => {
      const key = this.messageMergeKey(message);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    return merged
      .map((message) => this.hydrateThreadMessage(message))
      .sort(
        (left, right) =>
          new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
      );
  }

  private async findDbMessagesForPhone(companyId: number, phone: string) {
    const normalized = this.normalizePhoneKey(phone);
    if (!normalized) {
      return [];
    }

    const channelUsers = await this.channelUserRepository.find({
      where: { company_id: companyId },
      relations: ['conversations'],
    });
    const channelUser = channelUsers.find((item) =>
      this.phoneKeysEquivalent(item.external_user_id, normalized),
    );
    if (!channelUser?.conversations?.length) {
      return [];
    }

    const conversation = [...channelUser.conversations].sort((left, right) => {
      const leftTime = left.last_message_at
        ? new Date(left.last_message_at).getTime()
        : 0;
      const rightTime = right.last_message_at
        ? new Date(right.last_message_at).getTime()
        : 0;
      return rightTime - leftTime;
    })[0];

    if (!conversation) {
      return [];
    }

    return this.messageRepository.find({
      where: { conversation_id: conversation.id },
      order: { id: 'ASC' },
    });
  }

  private preferredEvolutionJid(
    requestedJid: string,
    relatedJids: string[],
    phone: string,
  ): string {
    const phoneJid = relatedJids.find(
      (item) => item.endsWith('@s.whatsapp.net') || item.endsWith('@c.us'),
    );
    if (phoneJid) {
      return phoneJid;
    }
    if (phone) {
      return `${phone}@s.whatsapp.net`;
    }
    return relatedJids[0] ?? requestedJid;
  }

  private async fetchEvolutionMessagesForJid(
    companyId: number,
    remoteJid: string,
    instance: string,
    apikey: string,
    page = 1,
    limit = 150,
  ) {
    const jid = remoteJid.trim();
    let chats: Awaited<ReturnType<EvolutionService['findChats']>> = [];

    try {
      chats = await this.evolutionService.findChats(instance, apikey);
    } catch (error) {
      console.error('Evolution findChats failed:', error);
    }

    const relatedJids = resolveRelatedChatJids(jid, chats);
    if (!relatedJids.length) {
      relatedJids.push(jid);
    }

    const allowedJids = new Set(relatedJids.map((value) => value.trim().toLowerCase()));
    const byId = new Map<string, EvolutionInboxMessage>();
    let hasMore = false;
    for (const relatedJid of relatedJids) {
      try {
        const batch = await this.evolutionService.findMessages(
          instance,
          relatedJid,
          apikey,
          limit,
          page,
        );
        const batchIds = new Set(batch.map((message) => message.id));
        for (const message of batch) {
          if (!allowedJids.has(message.remote_jid.trim().toLowerCase())) {
            continue;
          }
          if (!byId.has(message.id)) {
            byId.set(message.id, message);
          }
        }

        if (!hasMore && batch.length >= limit) {
          const nextBatch = await this.evolutionService.findMessages(
            instance,
            relatedJid,
            apikey,
            limit,
            page + 1,
          );
          hasMore = nextBatch.some(
            (message) =>
              allowedJids.has(message.remote_jid.trim().toLowerCase()) &&
              !batchIds.has(message.id),
          );
        }
      } catch (error) {
        console.error(`Evolution findMessages failed for ${relatedJid}:`, error);
      }
    }

    let messages = Array.from(byId.values()).sort(
      (left, right) =>
        new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
    );
    const phone = resolvePhoneFromChatList(jid, chats);
    messages = await this.enrichEvolutionImageMessages(instance, apikey, messages, phone);

    return {
      remoteJid: this.preferredEvolutionJid(jid, relatedJids, phone),
      phone,
      messages,
      hasMore,
      page,
      limit,
    };
  }

  private async loadEvolutionMessagesForPhone(companyId: number, phone: string) {
    const normalized = this.normalizePhoneKey(phone);
    if (!normalized) {
      return [];
    }

    const channel = await this.resolveCompanyWhatsappChannel(companyId);
    const instance = this.resolveEvolutionInstanceName(channel);
    const apikey = (channel?.evaluation_whatsapp_key ?? this.getEvolutionConfig().secureKey)?.trim();
    if (!instance || !apikey) {
      return [];
    }

    const { messages } = await this.fetchEvolutionMessagesForJid(
      companyId,
      `${normalized}@s.whatsapp.net`,
      instance,
      apikey,
    );
    return this.mapEvolutionMessagesToBotMessages(messages);
  }

  private dedupeConversationRows(rows: CompanyContactRow[]): CompanyContactRow[] {
    const merged: CompanyContactRow[] = [];

    for (const row of rows) {
      const phone = this.contactPhoneFromRow(row);
      if (!phone) {
        merged.push(row);
        continue;
      }

      const existingIndex = merged.findIndex((item) =>
        item.channelUser?.platform === row.channelUser?.platform && this.rowMatchesPhone(item, phone),
      );

      if (existingIndex < 0) {
        merged.push(row);
        continue;
      }

      const existing = merged[existingIndex];
      const existingTime = existing.conversation?.last_message_at
        ? new Date(existing.conversation.last_message_at).getTime()
        : 0;
      const rowTime = row.conversation?.last_message_at
        ? new Date(row.conversation.last_message_at).getTime()
        : 0;
      const latest = rowTime >= existingTime ? row : existing;
      const other = latest === row ? existing : row;
      const conversationId =
        (existing.conversation?.id ?? 0) > 0
          ? existing.conversation!.id
          : (row.conversation?.id ?? 0) > 0
            ? row.conversation!.id
            : 0;

      merged[existingIndex] = {
        ...latest,
        customer:
          latest.customer.id > 0
            ? latest.customer
            : other.customer.id > 0
              ? other.customer
              : latest.customer,
        channelUser: latest.channelUser?.id
          ? latest.channelUser
          : other.channelUser ?? latest.channelUser,
        conversation:
          conversationId > 0
            ? {
                id: conversationId,
                status: latest.conversation?.status ?? other.conversation?.status ?? 'open',
                last_message_at:
                  latest.conversation?.last_message_at ??
                  other.conversation?.last_message_at ??
                  null,
              }
            : latest.conversation ?? other.conversation,
        evolution_remote_jid:
          latest.evolution_remote_jid ?? other.evolution_remote_jid ?? null,
        last_message_preview:
          latest.last_message_preview || other.last_message_preview || null,
      };
    }

    return merged.sort((left, right) => {
      const leftTime = left.conversation?.last_message_at
        ? new Date(left.conversation.last_message_at).getTime()
        : 0;
      const rightTime = right.conversation?.last_message_at
        ? new Date(right.conversation.last_message_at).getTime()
        : 0;
      return rightTime - leftTime;
    });
  }

  async getUsers(user: AuthenticatedUser, query: BotUsersQueryDto) {
    await this.assertAdminAccess(user);
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const offset = (page - 1) * limit;

    const rows = await this.buildCompanyContactRows(user.company_id);
    const mapped = rows
      .map((row) => this.mapContactRowToBotUser(row))
      .sort((left, right) => {
        const leftTime = left.last_seen_at ? new Date(left.last_seen_at).getTime() : 0;
        const rightTime = right.last_seen_at ? new Date(right.last_seen_at).getTime() : 0;
        return rightTime - leftTime;
      });

    return {
      items: mapped.slice(offset, offset + limit),
      pagination: {
        page,
        limit,
        total: mapped.length,
      },
    };
  }

  async createContact(user: AuthenticatedUser, payload: CreateContactDto) {
    await this.assertAdminAccess(user);
    const phone = this.normalizePhoneKey(payload.phone);
    const displayName = payload.display_name.trim();
    if (!phone || !displayName) throw new BadRequestException('Name and phone are required.');
    const existing = await this.channelUserRepository.find({
      where: { company_id: user.company_id, platform: 'whatsapp' },
    });
    if (this.findChannelUserForPhone(existing, phone)) {
      throw new BadRequestException('This WhatsApp contact already exists.');
    }
    const contact = await this.channelUserRepository.save(this.channelUserRepository.create({
      company_id: user.company_id,
      platform: 'whatsapp',
      external_user_id: phone,
      display_name: displayName,
      bot_enabled: false,
      manual_mode: false,
    }));
    return { id: contact.id, display_name: contact.display_name, external_user_id: contact.external_user_id };
  }

  async updateContact(user: AuthenticatedUser, id: number, payload: UpdateContactDto) {
    await this.assertAdminAccess(user);
    const contact = await this.channelUserRepository.findOne({ where: { id, company_id: user.company_id } });
    if (!contact) throw new NotFoundException('Contact not found.');
    const displayName = payload.display_name.trim();
    if (!displayName) throw new BadRequestException('Name is required.');
    contact.display_name = displayName;
    await this.channelUserRepository.save(contact);
    return { id: contact.id, display_name: contact.display_name };
  }

  async deleteContact(user: AuthenticatedUser, id: number) {
    await this.assertAdminAccess(user);
    const contact = await this.channelUserRepository.findOne({ where: { id, company_id: user.company_id } });
    if (!contact) throw new NotFoundException('Contact not found.');
    const hasConversation = await this.conversationRepository.exist({ where: { bot_channel_user_id: id } });
    if (hasConversation) throw new BadRequestException('This contact has chat history and cannot be deleted.');
    const [hasOrder, hasNote] = await Promise.all([
      this.orderRepository.exist({ where: { bot_channel_user_id: id, company_id: user.company_id } }),
      this.customerNoteRepository.exist({ where: { bot_channel_user_id: id, company_id: user.company_id } }),
    ]);
    if (hasOrder || hasNote) throw new BadRequestException('This contact has orders or notes and cannot be deleted.');
    const hasCustomer = contact.platform === 'whatsapp' && await this.customerRepository.exist({
      where: { company_id: user.company_id, customer_phone: contact.external_user_id },
    });
    if (hasCustomer) throw new BadRequestException('This contact is linked to a customer record and cannot be deleted.');
    await this.channelUserRepository.remove(contact);
    return { id, removed: true };
  }
  private findChannelUserForPhone(
    channelUsers: BotChannelUser[],
    phone: string,
  ): BotChannelUser | undefined {
    return channelUsers.find((item) =>
      this.phoneKeysEquivalent(item.external_user_id, phone),
    );
  }

  private mapContactRowToBotUser(row: CompanyContactRow) {
    const channelUser = row.channelUser;
    const conversationId = row.conversation?.id ?? 0;
    return {
      id: channelUser?.id ?? 0,
      customer_id: row.customer.id,
      platform: channelUser?.platform ?? 'whatsapp',
      external_user_id: channelUser?.external_user_id ?? row.customer.customer_phone,
      display_name:
        channelUser?.display_name?.trim() ||
        row.customer.customer_phone,
      language: channelUser?.language ?? 'English',
      bot_enabled: channelUser?.bot_enabled ?? true,
      manual_mode: channelUser?.manual_mode ?? false,
      last_seen_at:
        channelUser?.last_seen_at ??
        row.customer.last_seen_at ??
        null,
      latest_conversation_id: conversationId > 0 ? conversationId : null,
      evolution_remote_jid: row.evolution_remote_jid ?? null,
    };
  }

  private async ensureChannelUserForContact(
    companyId: number,
    phone: string,
    displayName?: string,
  ): Promise<BotChannelUser> {
    const normalizedPhone = this.normalizePhoneKey(phone);
    if (!normalizedPhone) {
      throw new BadRequestException('A valid phone number is required.');
    }

    const companyScoped = await this.channelUserRepository.findOne({
      where: {
        company_id: companyId,
        platform: 'whatsapp',
        external_user_id: normalizedPhone,
      },
    });
    if (companyScoped) {
      if (displayName?.trim() && !companyScoped.display_name?.trim()) {
        companyScoped.display_name = displayName.trim();
      }
      companyScoped.last_seen_at = companyScoped.last_seen_at ?? new Date();
      return this.channelUserRepository.save(companyScoped);
    }

    const companyUsers = await this.channelUserRepository.find({
      where: { company_id: companyId, platform: 'whatsapp' },
    });
    const matched = this.findChannelUserForPhone(companyUsers, normalizedPhone);
    if (matched) {
      return matched;
    }

    return this.channelUserRepository.save(
      this.channelUserRepository.create({
        company_id: companyId,
        platform: 'whatsapp',
        external_user_id: normalizedPhone,
        display_name: displayName?.trim() || normalizedPhone,
        bot_enabled: false,
        manual_mode: false,
        last_seen_at: new Date(),
      }),
    );
  }

  async toggleUser(
    user: AuthenticatedUser,
    id: number,
    payload: ToggleBotUserDto,
  ) {
    const company = await this.getCompanyForUser(user);
    if (!company) {
      throw new ForbiddenException('Company not found.');
    }

    const isAdmin = Number(company.admin_user_id) === Number(user.id);
    let channelUser: BotChannelUser | null = null;

    if (id > 0) {
      channelUser = await this.channelUserRepository.findOne({
        where: { id, company_id: user.company_id },
      });
    }

    // Only admins may create/ensure a channel user from an external id.
    if (!channelUser && isAdmin && payload.external_user_id?.trim()) {
      channelUser = await this.ensureChannelUserForContact(
        user.company_id,
        payload.external_user_id,
      );
    }

    if (!channelUser) {
      throw new NotFoundException('Bot user not found.');
    }

    // Agents may only toggle bot for clients already assigned to them.
    if (!isAdmin) {
      const assigned = await this.conversationRepository
        .createQueryBuilder('c')
        .innerJoin('c.channelUser', 'channelUser')
        .where('c.bot_channel_user_id = :channelUserId', {
          channelUserId: channelUser.id,
        })
        .andWhere(
          'CAST(c.assigned_agent_id AS BIGINT) = CAST(:agentId AS BIGINT)',
          { agentId: Number(user.id) },
        )
        .andWhere(
          'CAST(channelUser.company_id AS BIGINT) = CAST(:companyId AS BIGINT)',
          { companyId: Number(user.company_id) },
        )
        .andWhere('LOWER(c.status) IN (:...statuses)', {
          statuses: ['pending', 'active'],
        })
        .getOne();

      if (!assigned) {
        throw new ForbiddenException(
          'You can only turn the client bot on/off for conversations assigned to you.',
        );
      }
    }

    const freePlanCanUseBot = String(company.plan ?? '').trim().toLowerCase() === 'free' && company.bot_enabled !== false;
    channelUser.bot_enabled = freePlanCanUseBot ? payload.manual_mode !== true : false;
    channelUser.manual_mode = !channelUser.bot_enabled;

    const saved = await this.channelUserRepository.save(channelUser);
    return {
      id: saved.id,
      bot_enabled: saved.bot_enabled,
      manual_mode: saved.manual_mode,
    };
  }

  async getConversations(user: AuthenticatedUser, requestedPage?: number, requestedLimit?: number) {
    await this.assertAdminAccess(user);
    if (requestedPage != null || requestedLimit != null) {
      return this.buildCompanyConversationRows(user.company_id, requestedPage, requestedLimit);
    }
    return this.buildCompanyContactRows(user.company_id);
  }

  /** Returns conversations assigned to this agent only (pending + active), regardless of online status. */
  async getAgentConversations(user: AuthenticatedUser) {
    const agentId = Number(user.id);
    const companyId = Number(user.company_id);
    if (!Number.isFinite(companyId) || companyId <= 0) {
      throw new ForbiddenException('Company not found.');
    }

    const dbUser = await this.userRepository.findOne({ where: { id: agentId } });
    if (!dbUser || Number(dbUser.company_id) !== companyId) {
      throw new ForbiddenException('Agent company mismatch.');
    }

    const all = await this.conversationRepository
      .createQueryBuilder('c')
      .innerJoinAndSelect('c.channelUser', 'channelUser')
      .where('CAST(c.assigned_agent_id AS BIGINT) = CAST(:agentId AS BIGINT)', { agentId })
      .andWhere('CAST(channelUser.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId,
      })
      .andWhere('LOWER(c.status) IN (:...statuses)', {
        statuses: ['pending', 'active'],
      })
      .orderBy(
        `CASE WHEN LOWER(c.status) = 'active' THEN 0 WHEN LOWER(c.status) = 'pending' THEN 1 ELSE 2 END`,
        'ASC',
      )
      .addOrderBy('c.last_message_at', 'DESC', 'NULLS LAST')
      .addOrderBy('c.id', 'DESC')
      .getMany();

    const conversationIds = all.map((conv) => conv.id);
    const previewByConversation = new Map<
      number,
      { content: string; direction: string; created_at: Date }
    >();

    if (conversationIds.length > 0) {
      const latestMessages = await this.messageRepository
        .createQueryBuilder('m')
        .where('m.conversation_id IN (:...conversationIds)', { conversationIds })
        .orderBy('m.conversation_id', 'ASC')
        .addOrderBy('m.id', 'DESC')
        .getMany();

      for (const message of latestMessages) {
        if (!previewByConversation.has(message.conversation_id)) {
          previewByConversation.set(message.conversation_id, {
            content: message.content,
            direction: message.direction,
            created_at: message.created_at,
          });
        }
      }
    }

    const rows = await Promise.all(
      all.map(async (conv) => {
        const unreadCount = await this.countUnreadInboundMessages(conv);
        const preview = previewByConversation.get(conv.id);
        return {
          id: conv.id,
          status: conv.status,
          assigned_agent_id: conv.assigned_agent_id,
          assigned_at: conv.assigned_at,
          last_message_at: conv.last_message_at,
          unread_count: unreadCount,
          last_message_preview: preview?.content?.trim() || null,
          last_message_direction: preview?.direction ?? null,
          channelUser: conv.channelUser
            ? {
                id: conv.channelUser.id,
                display_name: conv.channelUser.display_name,
                external_user_id: conv.channelUser.external_user_id,
                platform: conv.channelUser.platform,
                bot_enabled: conv.channelUser.bot_enabled,
                manual_mode: conv.channelUser.manual_mode,
              }
            : null,
          conversation: {
            id: conv.id,
            status: conv.status,
            last_message_at: conv.last_message_at,
          },
        };
      }),
    );

    return rows.sort((left, right) => {
      const leftActive = String(left.status).toLowerCase() === 'active' ? 0 : 1;
      const rightActive = String(right.status).toLowerCase() === 'active' ? 0 : 1;
      if (leftActive !== rightActive) {
        return leftActive - rightActive;
      }
      const unreadDiff = (right.unread_count ?? 0) - (left.unread_count ?? 0);
      if (unreadDiff !== 0) {
        return unreadDiff;
      }
      const leftTime = new Date(left.last_message_at ?? 0).getTime();
      const rightTime = new Date(right.last_message_at ?? 0).getTime();
      return rightTime - leftTime;
    });
  }

  private async countUnreadInboundMessages(
    conversation: BotConversation,
  ): Promise<number> {
    const qb = this.messageRepository
      .createQueryBuilder('m')
      .where('m.conversation_id = :conversationId', {
        conversationId: conversation.id,
      })
      .andWhere("m.direction::text = 'inbound'");

    if (conversation.agent_last_read_at) {
      qb.andWhere('m.created_at > :since', {
        since: conversation.agent_last_read_at,
      });
    } else if (conversation.assigned_at) {
      qb.andWhere('m.created_at >= :since', {
        since: conversation.assigned_at,
      });
    }

    return qb.getCount();
  }

  private async buildCompanyConversationRows(
    companyId: number,
    requestedPage?: number,
    requestedLimit?: number,
  ): Promise<CompanyContactRow[]> {
    const page = Number.isInteger(requestedPage) && Number(requestedPage) > 0 ? Number(requestedPage) : 1;
    const limit = Number.isInteger(requestedLimit) && Number(requestedLimit) > 0 ? Math.min(Number(requestedLimit), 100) : 60;
    const offset = (page - 1) * limit;

    const conversations = await this.conversationRepository
      .createQueryBuilder('conversation')
      .innerJoinAndSelect('conversation.channelUser', 'channelUser')
      .where('CAST(channelUser.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', { companyId })
      .orderBy('conversation.last_message_at', 'DESC', 'NULLS LAST')
      .addOrderBy('conversation.id', 'DESC')
      .skip(offset)
      .take(limit)
      .getMany();

    const conversationIds = conversations.map((conversation) => Number(conversation.id));
    const previewByConversation = new Map<number, { content: string; direction: 'inbound' | 'outbound'; delivery_status: 'sent' | 'delivered' | 'read' | 'failed' | null }>();
    const unreadByConversation = new Map<number, number>();
    const labelsByConversation = new Map<number, Array<{ id: number; name: string; color_code: string }>>();

    if (conversationIds.length > 0) {
      // Only the newest message per conversation (was: every message of every conversation).
      const latest: Array<{ conversation_id: number; content: string | null; direction: 'inbound' | 'outbound'; delivery_status: 'sent' | 'delivered' | 'read' | 'failed' | null }> =
        await this.messageRepository.query(
          `SELECT DISTINCT ON (conversation_id) conversation_id, content, direction::text AS direction, delivery_status
             FROM bot_message
            WHERE conversation_id = ANY($1)
            ORDER BY conversation_id, id DESC`,
          [conversationIds],
        );
      for (const row of latest) {
        previewByConversation.set(Number(row.conversation_id), {
          content: String(row.content ?? '').trim(),
          direction: row.direction,
          delivery_status: row.delivery_status ?? null,
        });
      }

      // Unread = customer messages after the later of: last time the team opened the chat,
      // or the last reply sent to the customer (by an agent, admin or the bot).
      const unread: Array<{ conversation_id: number; unread: number }> = await this.messageRepository.query(
        `SELECT m.conversation_id, COUNT(*)::int AS unread
           FROM bot_message m
           JOIN bot_conversation c ON c.id = m.conversation_id
          WHERE m.conversation_id = ANY($1)
            AND m.direction::text = 'inbound'
            AND m.created_at > GREATEST(
                  COALESCE(c.agent_last_read_at::timestamp, 'epoch'::timestamp),
                  COALESCE((SELECT MAX(o.created_at) FROM bot_message o
                             WHERE o.conversation_id = m.conversation_id
                               AND o.direction::text = 'outbound'), 'epoch'::timestamp))
          GROUP BY m.conversation_id`,
        [conversationIds],
      );
      for (const row of unread) {
        unreadByConversation.set(Number(row.conversation_id), Number(row.unread) || 0);
      }

      // Tags on each chat – used by the tag filter and the chips in the chat list.
      const labelRows = await this.conversationLabelRepository
        .createQueryBuilder('cl')
        .innerJoin(BotCustomerLabel, 'l', 'l.id = cl.label_id')
        .where('cl.conversation_id IN (:...conversationIds)', { conversationIds })
        .andWhere('CAST(l.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', { companyId })
        .select([
          'cl.conversation_id AS conversation_id',
          'l.id AS id',
          'l.name AS name',
          'l.color_code AS color_code',
        ])
        .orderBy('l.name', 'ASC')
        .getRawMany<{ conversation_id: string | number; id: string | number; name: string; color_code: string }>();
      for (const row of labelRows) {
        const key = Number(row.conversation_id);
        const list = labelsByConversation.get(key) ?? [];
        list.push({ id: Number(row.id), name: row.name, color_code: row.color_code });
        labelsByConversation.set(key, list);
      }
    }

    return conversations.map((conversation) => {
      const channelUser = conversation.channelUser;
      const seenAt = channelUser.last_seen_at ?? conversation.last_message_at ?? channelUser.created_at;
      const preview = previewByConversation.get(Number(conversation.id));
      return {
        customer: {
          id: 0,
          customer_phone: channelUser.external_user_id,
          assigned_instance: null,
          first_seen_at: channelUser.created_at,
          last_seen_at: seenAt,
        },
        channelUser: {
          id: channelUser.id,
          platform: channelUser.platform,
          external_user_id: channelUser.external_user_id,
          display_name: channelUser.display_name,
          language: channelUser.language,
          bot_enabled: channelUser.bot_enabled,
          manual_mode: channelUser.manual_mode,
          last_seen_at: channelUser.last_seen_at,
        },
        conversation: {
          id: conversation.id,
          status: conversation.status,
          lead_stage: conversation.lead_stage || 'new',
          assigned_agent_id: conversation.assigned_agent_id,
          last_message_at: conversation.last_message_at,
        },
        evolution_remote_jid: null,
        last_message_preview: preview?.content || null,
        last_message_direction: preview?.direction ?? null,
        last_message_delivery_status: preview?.delivery_status ?? null,
        unread_count: unreadByConversation.get(Number(conversation.id)) ?? 0,
        labels: labelsByConversation.get(Number(conversation.id)) ?? [],
      };
    });
  }

  private async buildCompanyContactRows(companyId: number): Promise<CompanyContactRow[]> {
    const [customers, channelUsers] = await Promise.all([
      this.customerRepository.find({
        where: { company_id: companyId },
        order: { last_seen_at: 'DESC', id: 'DESC' },
      }),
      this.channelUserRepository.find({
        where: { company_id: companyId },
        relations: ['conversations'],
      }),
    ]);

    const mapChannelUser = (channelUser: BotChannelUser): CompanyContactChannelUser => ({
      id: channelUser.id,
      platform: channelUser.platform,
      external_user_id: channelUser.external_user_id,
      display_name: channelUser.display_name,
      language: channelUser.language,
      bot_enabled: channelUser.bot_enabled,
      manual_mode: channelUser.manual_mode,
      last_seen_at: channelUser.last_seen_at,
    });

    const latestConversation = (channelUser: BotChannelUser | undefined) => {
      if (!channelUser) {
        return undefined;
      }
      return [...(channelUser.conversations ?? [])].sort((left, right) => {
        const leftTime = left.last_message_at
          ? new Date(left.last_message_at).getTime()
          : 0;
        const rightTime = right.last_message_at
          ? new Date(right.last_message_at).getTime()
          : 0;
        return rightTime - leftTime;
      })[0];
    };

    const rows: CompanyContactRow[] = customers.map((customer) => {
      const channelUser = this.findChannelUserForPhone(
        channelUsers.filter((item) => item.platform === 'whatsapp'),
        customer.customer_phone,
      );
      const conversation = latestConversation(channelUser);

      return {
        customer: {
          id: customer.id,
          customer_phone: customer.customer_phone,
          assigned_instance: customer.assigned_instance,
          first_seen_at: customer.first_seen_at,
          last_seen_at: customer.last_seen_at,
        },
        channelUser: channelUser ? mapChannelUser(channelUser) : null,
        conversation: conversation
          ? {
              id: conversation.id,
              status: conversation.status,
              lead_stage: conversation.lead_stage || 'new',
              assigned_agent_id: conversation.assigned_agent_id,
              last_message_at: conversation.last_message_at,
            }
          : null,
        evolution_remote_jid: null as string | null,
        last_message_preview: null as string | null,
      };
    });

    for (const channelUser of channelUsers) {
      const alreadyListed = rows.some(
        (row) =>
          row.channelUser?.id === channelUser.id ||
          (channelUser.platform === 'whatsapp' && row.channelUser?.platform === 'whatsapp' && this.phoneKeysEquivalent(
            row.customer.customer_phone,
            channelUser.external_user_id,
          )),
      );
      if (alreadyListed) {
        continue;
      }

      const conversation = latestConversation(channelUser);
      rows.push({
        customer: {
          id: 0,
          customer_phone: channelUser.external_user_id,
          assigned_instance: null,
          first_seen_at: channelUser.created_at,
          last_seen_at: channelUser.last_seen_at ?? channelUser.created_at,
        },
        channelUser: mapChannelUser(channelUser),
        conversation: conversation
          ? {
              id: conversation.id,
              status: conversation.status,
              lead_stage: conversation.lead_stage || 'new',
              assigned_agent_id: conversation.assigned_agent_id,
              last_message_at: conversation.last_message_at,
            }
          : null,
        evolution_remote_jid: null,
        last_message_preview: null,
      });
    }

    return this.mergeEvolutionInboxChats(companyId, rows, channelUsers);
  }

  /** Load chats from Evolution API (same source as Manager → Chat). */
  private async mergeEvolutionInboxChats(
    companyId: number,
    rows: CompanyContactRow[],
    channelUsers: BotChannelUser[],
  ): Promise<CompanyContactRow[]> {
    const channel = await this.resolveCompanyWhatsappChannel(companyId);
    if (this.isMetaWhatsappChannel(channel)) {
      return rows.filter((row) => Number(row.conversation?.id ?? 0) > 0);
    }
    const instance = this.resolveEvolutionInstanceName(channel);
    if (!instance) {
      return rows.filter((row) => Number(row.conversation?.id ?? 0) > 0);
    }

    const apikey = (channel?.evaluation_whatsapp_key ?? this.getEvolutionConfig().secureKey)?.trim();
    if (!apikey) {
      return rows.filter((row) => Number(row.conversation?.id ?? 0) > 0);
    }

    try {
      const chats = await this.evolutionService.findChats(instance, apikey);
      const instanceRows: CompanyContactRow[] = [];

      for (const chat of chats) {
        const phone = chat.phone;
        if (!phone) {
          continue;
        }
        const preferredJid =
          chat.alternate_jid?.endsWith('@s.whatsapp.net') ||
          chat.alternate_jid?.endsWith('@c.us')
            ? chat.alternate_jid
            : chat.remote_jid.endsWith('@s.whatsapp.net') ||
                chat.remote_jid.endsWith('@c.us')
              ? chat.remote_jid
              : chat.alternate_jid ?? chat.remote_jid;
        const existingIndex = rows.findIndex(
          (item) =>
            this.rowMatchesPhone(item, phone) ||
            item.evolution_remote_jid === chat.remote_jid ||
            (chat.alternate_jid && item.evolution_remote_jid === chat.alternate_jid),
        );
        if (existingIndex >= 0) {
          const row = rows[existingIndex];
          row.evolution_remote_jid = preferredJid;
          row.last_message_preview = chat.last_message_preview || row.last_message_preview;
          if (!row.conversation && chat.last_message_at) {
            row.conversation = {
              id: 0,
              status: 'open',
              last_message_at: chat.last_message_at,
            };
          }
          if (row.channelUser && chat.display_name) {
            row.channelUser.display_name = chat.display_name;
          }
          if (!instanceRows.includes(row)) {
            instanceRows.push(row);
          }
          continue;
        }

        const matchedChannelUser = this.findChannelUserForPhone(channelUsers, phone);
        instanceRows.push({
          customer: {
            id: 0,
            customer_phone: phone,
            assigned_instance: instance,
            first_seen_at: chat.last_message_at ?? new Date().toISOString(),
            last_seen_at: chat.last_message_at ?? new Date().toISOString(),
          },
          channelUser: matchedChannelUser
            ? {
                id: matchedChannelUser.id,
                platform: matchedChannelUser.platform,
                external_user_id: matchedChannelUser.external_user_id,
                display_name:
                  chat.display_name?.trim() ||
                  matchedChannelUser.display_name ||
                  phone,
                language: matchedChannelUser.language,
                bot_enabled: matchedChannelUser.bot_enabled,
                manual_mode: matchedChannelUser.manual_mode,
                last_seen_at:
                  matchedChannelUser.last_seen_at ?? chat.last_message_at,
              }
            : null,
          conversation: {
            id: 0,
            status: 'open',
            last_message_at: chat.last_message_at,
          },
          evolution_remote_jid: preferredJid,
          last_message_preview: chat.last_message_preview,
        });
      }

      const otherChannels = rows.filter((row) => row.channelUser?.platform !== 'whatsapp' && Number(row.conversation?.id ?? 0) > 0);
      return this.dedupeConversationRows([...instanceRows, ...otherChannels]);
    } catch (error) {
      console.error('Evolution findChats failed:', error);
      return rows.filter((row) => Number(row.conversation?.id ?? 0) > 0);
    }
  }

  async getEvolutionInboxMessages(
    user: AuthenticatedUser,
    remoteJid: string,
    requestedPage = 1,
    requestedLimit = 30,
  ) {
    const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const limit =
      Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 50)
        : 30;
    await this.assertAdminAccess(user);
    const jid = remoteJid.trim();
    if (!jid) {
      throw new BadRequestException('remoteJid is required.');
    }

    const channel = await this.resolveCompanyWhatsappChannel(user.company_id);
    if (this.isMetaWhatsappChannel(channel)) {
      const phone =
        this.normalizePhoneKey(jid.split('@')[0] ?? jid) ||
        this.normalizePhoneKey(jid);
      if (!phone) {
        throw new BadRequestException('Invalid WhatsApp JID.');
      }
      const dbMessages = await this.findDbMessagesForPhone(user.company_id, phone);
      let mergedMessages = this.mergeConversationThreadMessages(dbMessages, []);
      if (this.isMetaWhatsappChannel(channel)) {
        mergedMessages = await this.enrichMetaDbImageMessages(mergedMessages, channel);
      }
      const end = Math.max(0, mergedMessages.length - (page - 1) * limit);
      const start = Math.max(0, end - limit);
      return {
        remote_jid: jid.endsWith('@s.whatsapp.net') ? jid : `${phone}@s.whatsapp.net`,
        messages: mergedMessages.slice(start, end),
        pagination: { page, limit, has_more: start > 0 },
      };
    }

    const instance = this.resolveEvolutionInstanceName(channel);
    if (!instance) {
      throw new BadRequestException('WhatsApp instance is not configured.');
    }

    const apikey = (channel?.evaluation_whatsapp_key ?? this.getEvolutionConfig().secureKey)?.trim();
    if (!apikey) {
      throw new BadRequestException('WhatsApp instance API key is missing.');
    }

    const { remoteJid: resolvedJid, messages, hasMore } =
      await this.fetchEvolutionMessagesForJid(
        user.company_id,
        jid,
        instance,
        apikey,
        page,
        limit,
      );

    return {
      remote_jid: resolvedJid,
      messages: this.mergeConversationThreadMessages([], messages),
      pagination: { page, limit, has_more: hasMore },
    };
  }

  async sendEvolutionInboxMessage(
    user: AuthenticatedUser,
    remoteJid: string,
    text: string,
  ) {
    await this.assertAdminAccess(user);
    const trimmed = text.trim();
    const jid = remoteJid.trim();
    if (!trimmed) {
      throw new BadRequestException('Message text is required.');
    }
    if (!jid) {
      throw new BadRequestException('remoteJid is required.');
    }

    const channel = await this.resolveCompanyWhatsappChannel(user.company_id);
    if (this.isMetaWhatsappChannel(channel)) {
      let phone = '';
      if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) {
        phone = this.normalizePhoneKey(jid.split('@')[0] ?? jid);
      }
      if (!phone) {
        phone = this.normalizePhoneKey(jid);
      }
      if (!phone) {
        throw new BadRequestException('Invalid WhatsApp JID.');
      }
      await this.sendCompanyWhatsappText(user.company_id, phone, trimmed);
      return { remote_jid: jid, sent: true, text: trimmed };
    }

    const evolution = this.getEvolutionConfig();
    if (!evolution.enabled) {
      throw new BadRequestException(
        'Evolution API is not configured for sending WhatsApp messages.',
      );
    }

    const instance = this.resolveEvolutionInstanceName(channel);
    const apikey = (channel?.evaluation_whatsapp_key ?? evolution.secureKey)?.trim();

    if (!instance || !apikey) {
      throw new BadRequestException(
        'WhatsApp instance is not configured for this company.',
      );
    }

    let phone = '';
    if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) {
      phone = this.normalizePhoneKey(jid.split('@')[0] ?? jid);
    }
    if (!phone || jid.endsWith('@lid')) {
      try {
        const chats = await this.evolutionService.findChats(instance, apikey);
        phone = resolvePhoneFromChatList(jid, chats);
      } catch (error) {
        console.error('Evolution findChats failed while sending:', error);
      }
    }
    if (!phone) {
      throw new BadRequestException('Invalid WhatsApp JID.');
    }

    try {
      const response = await fetch(
        `${evolution.base}/message/sendText/${encodeURIComponent(instance)}`,
        {
          method: 'POST',
          headers: {
            apikey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            number: phone,
            text: trimmed,
            delay: 1200,
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new BadRequestException(
          body || 'Failed to send WhatsApp message via Evolution.',
        );
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to send WhatsApp message via Evolution.');
    }

    return { remote_jid: jid, sent: true, text: trimmed };
  }

  /**
   * Opens a chat fast:
   *  - first call:  newest `limit` messages
   *  - scroll up:   before_id = oldest loaded id  → the page before it
   *  - polling:     after_id  = newest loaded id + light=true → only new messages, no labels/orders/notes
   * Media is never sent inline – the inbox loads each file from /messages/:id/media when it is shown.
   */
  async getConversation(
    user: AuthenticatedUser,
    id: number,
    requestedPage?: number,
    requestedLimit?: number,
    options: { beforeId?: number; afterId?: number; light?: boolean } = {},
  ) {
    const paged = requestedPage != null || options.beforeId != null || options.afterId != null;
    const page =
      Number.isInteger(requestedPage) && Number(requestedPage) > 0
        ? Number(requestedPage)
        : 1;
    const limit =
      Number.isInteger(requestedLimit) && Number(requestedLimit) > 0
        ? Math.min(Number(requestedLimit), 100)
        : 40;
    const company = await this.getCompanyForUser(user);
    if (!company) {
      throw new ForbiddenException('Company not found.');
    }

    const isAdmin = Number(company.admin_user_id) === Number(user.id);

    const conversation = isAdmin
      ? await this.findConversationForCompany(id, user.company_id)
      : await this.findConversationForCompany(id, user.company_id, {
          assignedAgentId: user.id,
        });

    if (!conversation) {
      if (isAdmin) {
        throw new NotFoundException('Conversation not found.');
      }
      throw new ForbiddenException('You do not have access to this conversation.');
    }

    const phone = this.normalizePhoneKey(conversation.channelUser?.external_user_id ?? '');
    const channel = await this.resolveCompanyWhatsappChannel(user.company_id);
    const platform = String(conversation.channelUser?.platform ?? 'whatsapp').toLowerCase();
    // Messenger / Instagram always live in our DB, even when WhatsApp uses Evolution.
    const readFromDb = this.isMetaWhatsappChannel(channel) || platform !== 'whatsapp';

    const dbMessages = readFromDb
      ? await this.loadConversationDbMessagesPage(id, {
          page: paged ? page : undefined,
          limit: paged ? limit : 150,
          beforeId: options.beforeId,
          afterId: options.afterId,
        })
      : { messages: [] as BotMessage[], hasMore: false };

    const instance = this.resolveEvolutionInstanceName(channel);
    const apikey = (channel?.evaluation_whatsapp_key ?? this.getEvolutionConfig().secureKey)?.trim();
    const fetchedEvolution =
      !readFromDb && phone && instance && apikey
        ? await this.fetchEvolutionMessagesForJid(
            user.company_id,
            `${phone}@s.whatsapp.net`,
            instance,
            apikey,
            page,
            paged ? limit : 150,
          )
        : null;

    const mergedMessages = readFromDb
      ? this.mergeConversationThreadMessages(dbMessages.messages, [])
      : this.mergeConversationThreadMessages([], fetchedEvolution?.messages ?? []);
    const hasMore = readFromDb ? dbMessages.hasMore : fetchedEvolution?.hasMore ?? false;

    // Opening the newest page (or receiving new customer messages while open) = read.
    const isNewestView = options.beforeId == null && page === 1;
    const gotNewInbound = dbMessages.messages.some((message) => message.direction === 'inbound');
    if (isNewestView && (!options.light || gotNewInbound)) {
      void this.markConversationRead(conversation, user.company_id).catch((error) =>
        console.warn(`Mark read failed for conversation ${conversation.id}:`, error instanceof Error ? error.message : error),
      );
    }

    const channelUserId = Number(conversation.bot_channel_user_id || 0);
    // Light polls skip the side data (labels / orders / notes) – the inbox keeps what it already has.
    const [labels, customerOrders, customerNotes] = options.light
      ? [undefined, undefined, undefined]
      : await Promise.all([
          this.listConversationLabels(id, user.company_id),
          this.getOrdersForChannelUser(user.company_id, channelUserId),
          this.listNotesForChannelUser(user.company_id, channelUserId),
        ]);

    return {
      conversation,
      messages: mergedMessages,
      ...(paged ? { pagination: { page, limit, has_more: hasMore } } : {}),
      ...(options.light ? {} : { labels, customer_orders: customerOrders, customer_notes: customerNotes }),
    };
  }

  /**
   * Loads a page of messages WITHOUT the heavy inline media.
   * Old rows store images/voice as "data:…;base64,…" (MBs each). Those are replaced by
   * "inline:<mime>" here, so the list stays tiny; the file itself is served by /media.
   */
  private async loadConversationDbMessagesPage(
    conversationId: number,
    options: { page?: number; limit?: number; beforeId?: number; afterId?: number },
  ): Promise<{ messages: BotMessage[]; hasMore: boolean }> {
    const limit = options.limit ?? 150;
    const qb = this.messageRepository
      .createQueryBuilder('m')
      .select([
        'm.id',
        'm.conversation_id',
        'm.direction',
        'm.message_type',
        'm.platform',
        'm.provider_message_id',
        'm.content',
        'm.transcript',
        'm.source',
        'm.created_at',
      ])
      .addSelect(
        `CASE WHEN m.media_url LIKE 'data:%'
              THEN 'inline:' || split_part(split_part(substr(m.media_url, 6), ',', 1), ';', 1)
              ELSE m.media_url END`,
        'media_light',
      )
      .where('m.conversation_id = :conversationId', { conversationId });

    const run = async () => {
      const { entities, raw } = await qb.getRawAndEntities<{ media_light: string | null }>();
      return entities.map((entity, index) => {
        entity.media_url = raw[index]?.media_light ?? null;
        return entity;
      });
    };

    // polling: only messages newer than what the inbox already has
    if (options.afterId != null) {
      qb.andWhere('m.id > :afterId', { afterId: options.afterId }).orderBy('m.id', 'ASC').take(200);
      return { messages: await run(), hasMore: false };
    }

    // scrolling up: the page just before the oldest loaded message (stable even when new messages arrive)
    if (options.beforeId != null) {
      qb.andWhere('m.id < :beforeId', { beforeId: options.beforeId }).orderBy('m.id', 'DESC').take(limit + 1);
      const newestFirst = await run();
      return { messages: newestFirst.slice(0, limit).reverse(), hasMore: newestFirst.length > limit };
    }

    if (options.page == null) {
      qb.orderBy('m.id', 'ASC').take(limit);
      return { messages: await run(), hasMore: false };
    }

    const offset = Math.max(0, (options.page - 1) * limit);
    qb.orderBy('m.id', 'DESC').skip(offset).take(limit + 1);
    const newestFirst = await run();
    return {
      messages: newestFirst.slice(0, limit).reverse(),
      hasMore: newestFirst.length > limit,
    };
  }

  /** Search the WHOLE chat history on the server (not only the loaded messages). */
  async searchConversationMessages(
    user: AuthenticatedUser,
    conversationId: number,
    query: string,
    requestedLimit = 50,
  ) {
    await this.assertConversationAccess(user, conversationId);
    const text = String(query ?? '').trim();
    if (text.length < 2) {
      return { results: [] };
    }
    const limit = Math.min(Math.max(Number(requestedLimit) || 50, 1), 100);
    const pattern = `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = await this.messageRepository
      .createQueryBuilder('m')
      .select(['m.id', 'm.direction', 'm.message_type', 'm.content', 'm.created_at'])
      .where('m.conversation_id = :conversationId', { conversationId })
      .andWhere('(m.content ILIKE :pattern OR m.transcript ILIKE :pattern)', { pattern })
      .orderBy('m.id', 'DESC')
      .take(limit)
      .getMany();
    return {
      results: rows.map((row) => ({
        id: row.id,
        direction: row.direction,
        message_type: row.message_type,
        content: String(row.content ?? '').slice(0, 300),
        created_at: row.created_at,
      })),
    };
  }

  async getConversationMessageMedia(
    user: AuthenticatedUser,
    conversationId: number,
    messageId: number,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    await this.assertConversationAccess(user, conversationId);

    const message = await this.messageRepository.findOne({
      where: { id: messageId, conversation_id: conversationId },
    });
    if (!message) {
      throw new NotFoundException('Message not found.');
    }

    const stored = String(message.media_url ?? '').trim();

    // 1. Files we stored ourselves (agent uploads, Messenger/Instagram downloads)
    if (isChatMediaKey(stored)) {
      if (chatMediaCompanyId(stored) !== Number(user.company_id)) {
        throw new ForbiddenException('You do not have access to this file.');
      }
      const file = readChatMedia(stored);
      if (file) {
        return { buffer: file.buffer, contentType: file.contentType };
      }
      throw new NotFoundException('This file is no longer stored on the server.');
    }

    // 2. Inline data URLs (older rows)
    if (stored.startsWith('data:')) {
      const parsed = this.parseDataImageUrl(stored);
      if (parsed) {
        return parsed;
      }
    }

    // 3. WhatsApp Cloud API media id ("meta-media:<id>") – images, voice, video, documents
    const channel = await this.resolveCompanyWhatsappChannel(user.company_id);
    const metaToken = channel?.meta_access_token?.trim() ?? '';
    const metaMediaId = this.extractMetaMediaId(message);
    if (metaMediaId && metaToken) {
      const file = await this.fetchMetaMediaBuffer(metaMediaId, metaToken);
      if (file) {
        return file;
      }
    }

    // 4. WhatsApp-hosted URL (needs the token)
    if (isWhatsAppHostedMediaUrl(stored) && metaToken) {
      const dataUrl = await this.fetchWhatsAppHostedMediaAsDataUrl(stored, metaToken);
      const parsed = dataUrl ? this.parseDataImageUrl(dataUrl) : null;
      if (parsed) {
        return parsed;
      }
    }

    // 5. Any public link (Messenger/Instagram CDN, images inside text…)
    const remoteUrl = /^https?:\/\//i.test(stored)
      ? stored
      : String(message.content ?? '').match(BotAdminService.THREAD_IMAGE_URL_RE)?.[0] ?? '';
    if (remoteUrl) {
      const proxied = await this.fetchRemoteMediaBuffer(remoteUrl);
      if (proxied) {
        return proxied;
      }
    }

    throw new NotFoundException('Message media is not available.');
  }

  /** Download a WhatsApp Cloud API media id as raw bytes (any type). */
  private async fetchMetaMediaBuffer(
    mediaId: string,
    accessToken: string,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    try {
      const metaRes = await fetch(
        `https://graph.facebook.com/${this.metaGraphVersion()}/${encodeURIComponent(mediaId.trim())}`,
        { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(12000) },
      );
      if (!metaRes.ok) {
        console.warn(`Meta media lookup failed for ${mediaId}: ${metaRes.status}`);
        return null;
      }
      const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
      if (!meta.url) {
        return null;
      }
      const binRes = await fetch(meta.url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(20000),
      });
      if (!binRes.ok) {
        console.warn(`Meta media download failed for ${mediaId}: ${binRes.status}`);
        return null;
      }
      const buffer = Buffer.from(await binRes.arrayBuffer());
      if (!buffer.length) {
        return null;
      }
      const contentType = (meta.mime_type || binRes.headers.get('content-type') || 'application/octet-stream')
        .split(';')[0]
        .trim();
      return { buffer, contentType };
    } catch (error) {
      console.warn('Meta media fetch error:', error instanceof Error ? error.message : error);
      return null;
    }
  }

  /** Download any public media URL (no type restriction – voice, video and files too). */
  private async fetchRemoteMediaBuffer(
    url: string,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        return null;
      }
      const contentType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
      if (/text\/html|application\/json/i.test(contentType)) {
        return null; // an error page, not a file
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      return buffer.length ? { buffer, contentType } : null;
    } catch {
      return null;
    }
  }

  /** Works for any data URL, including "data:audio/ogg; codecs=opus;base64,…". */
  private parseDataImageUrl(
    dataUrl: string,
  ): { buffer: Buffer; contentType: string } | null {
    if (!dataUrl.startsWith('data:')) {
      return null;
    }
    const comma = dataUrl.indexOf(',');
    if (comma < 0) {
      return null;
    }
    const header = dataUrl.slice(5, comma);
    const body = dataUrl.slice(comma + 1);
    const isBase64 = /;\s*base64/i.test(header);
    const contentType = header.split(';')[0].trim() || 'application/octet-stream';
    try {
      const buffer = isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body));
      return buffer.length ? { buffer, contentType } : null;
    } catch {
      return null;
    }
  }

  private async sendSocialConversationText(companyId: number, platform: string, accountId: string | null, recipientId: string, text: string): Promise<string | null> {
    if (!accountId) throw new BadRequestException('This legacy conversation is not linked to a Meta account. Wait for a new incoming message before replying.');
    const connection = await this.metaPageConnectionRepository.findOne({
      where: platform === 'instagram'
        ? { company_id: companyId, instagram_business_account_id: accountId, status: 'CONNECTED' }
        : { company_id: companyId, page_id: accountId, status: 'CONNECTED' },
      order: { updated_at: 'DESC' },
    });
    if (!connection?.page_access_token) throw new BadRequestException('Connect a Meta Page before replying to this conversation.');
    if (platform === 'instagram' && !connection.instagram_business_account_id) throw new BadRequestException('Link an Instagram Business account before replying.');
    const sendAccountId = platform === 'instagram' ? connection.instagram_business_account_id : connection.page_id;
    const version = process.env.META_GRAPH_API_VERSION?.trim() || 'v19.0';
    const response = await fetch(`https://graph.facebook.com/${version}/${sendAccountId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.page_access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text }, messaging_type: 'RESPONSE' }),
    });
    const result = await response.json() as { message_id?: string; error?: { message?: string } };
    if (!response.ok) throw new BadRequestException(result.error?.message || 'Meta rejected the message. Check messaging permissions and the reply window.');
    return result.message_id ?? null;
  }

  private async getSocialReplyTarget(companyId: number, platform: string, accountId: string | null) {
    if (!accountId) throw new BadRequestException('This conversation is not linked to a Meta account.');
    const normalized = platform === 'facebook' ? 'messenger' : platform;
    const connection = await this.metaPageConnectionRepository.findOne({
      where: normalized === 'instagram'
        ? { company_id: companyId, instagram_business_account_id: accountId, status: 'CONNECTED' }
        : { company_id: companyId, page_id: accountId, status: 'CONNECTED' },
      order: { updated_at: 'DESC' },
    });
    if (!connection?.page_access_token) throw new BadRequestException('Connect a Meta Page before replying.');
    const sendAccountId = normalized === 'instagram' ? connection.instagram_business_account_id : connection.page_id;
    if (!sendAccountId) throw new BadRequestException('The selected Meta channel is not connected.');
    return { connection, sendAccountId, platform: normalized };
  }

  private async postSocialMessage(companyId: number, platform: string, accountId: string | null, recipientId: string, message: Record<string, unknown>) {
    const target = await this.getSocialReplyTarget(companyId, platform, accountId);
    const version = process.env.META_GRAPH_API_VERSION?.trim() || 'v19.0';
    const response = await fetch(`https://graph.facebook.com/${version}/${target.sendAccountId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.connection.page_access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, message, messaging_type: 'RESPONSE' }),
    });
    const result = await response.json() as { message_id?: string; error?: { message?: string } };
    if (!response.ok) throw new BadRequestException(result.error?.message || 'Meta rejected this message. Check channel permissions and the reply window.');
    return result.message_id ?? null;
  }

  private async sendMessengerMedia(companyId: number, accountId: string | null, recipientId: string, file: { buffer: Buffer; mimetype: string; originalname: string }, caption?: string) {
    const target = await this.getSocialReplyTarget(companyId, 'messenger', accountId);
    const version = process.env.META_GRAPH_API_VERSION?.trim() || 'v19.0';
    const attachmentType = file.mimetype.startsWith('image/') ? 'image' : file.mimetype.startsWith('video/') ? 'video' : file.mimetype.startsWith('audio/') ? 'audio' : 'file';
    const form = new FormData();
    form.append('recipient', JSON.stringify({ id: recipientId }));
    form.append('messaging_type', 'RESPONSE');
    form.append('message', JSON.stringify({ attachment: { type: attachmentType, payload: { is_reusable: true } } }));
    form.append('filedata', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.originalname);
    const response = await fetch(`https://graph.facebook.com/${version}/${target.sendAccountId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${target.connection.page_access_token}` }, body: form,
    });
    const result = await response.json() as { message_id?: string; error?: { message?: string } };
    if (!response.ok) throw new BadRequestException(result.error?.message || 'Messenger rejected this attachment.');
    if (caption?.trim()) await this.postSocialMessage(companyId, 'messenger', accountId, recipientId, { text: caption.trim() });
    return result.message_id ?? null;
  }
  async listMessageTemplates(user: AuthenticatedUser) {
    await this.assertCompanyAccess(user);
    return this.messageTemplateRepository.find({ where: { company_id: user.company_id }, order: { updated_at: 'DESC' } });
  }

  async createMessageTemplate(user: AuthenticatedUser, payload: SaveMessageTemplateDto) {
    await this.assertAdminAccess(user);
    const name = payload.name.trim();
    if (!name || !payload.body.trim()) throw new BadRequestException('Template name and body are required.');
    const existing = await this.messageTemplateRepository.findOne({ where: { company_id: user.company_id, name } });
    const row = existing ?? this.messageTemplateRepository.create({ company_id: user.company_id });
    row.name = name;
    row.title = payload.title?.trim() || '';
    row.body = payload.body.trim();
    row.image_url = payload.image_url?.trim() || null;
    row.buttons = (payload.buttons ?? []).map(button => ({ label: button.label.trim(), url: button.url?.trim(), payload: button.payload?.trim() })).filter(button => button.label) as BotTemplateButton[];
    row.platforms = payload.platforms?.length ? payload.platforms : ['messenger', 'instagram'];
    return this.messageTemplateRepository.save(row);
  }

  async deleteMessageTemplate(user: AuthenticatedUser, id: number) {
    await this.assertAdminAccess(user);
    const row = await this.messageTemplateRepository.findOne({ where: { id, company_id: user.company_id } });
    if (!row) throw new NotFoundException('Message template not found.');
    await this.messageTemplateRepository.remove(row);
    return { id, removed: true };
  }

  private async resolveConversationTemplateLanguage(conversation: BotConversation): Promise<string> {
    const savedLanguage = conversation.channelUser?.language?.trim();
    if (savedLanguage && savedLanguage.toLowerCase() !== 'english') {
      return savedLanguage;
    }

    const recentInbound = await this.messageRepository.find({
      where: { conversation_id: conversation.id, direction: 'inbound' },
      order: { id: 'DESC' },
      take: 8,
    });
    const sample = recentInbound.map((message) => message.content || '').join('\n');
    return this.detectConversationLanguage(sample) || savedLanguage || 'English';
  }

  private detectConversationLanguage(text: string): string | null {
    if (!text.trim()) {
      return null;
    }
    if (/[\u0D80-\u0DFF]/.test(text)) {
      return 'Sinhala';
    }
    if (/[\u0B80-\u0BFF]/.test(text)) {
      return 'Tamil';
    }
    const normalized = text.toLowerCase();
    const sinhalaSignals = ['kohomada', 'oyage', 'mage', 'hari', 'puluwan', 'karanna', 'denna', 'epa', 'ow', 'ne'];
    const tamilSignals = ['vanakkam', 'nandri', 'enna', 'epdi', 'ungal', 'venum', 'illai', 'seri'];
    if (sinhalaSignals.some((word) => normalized.includes(word))) {
      return 'Sinhala';
    }
    if (tamilSignals.some((word) => normalized.includes(word))) {
      return 'Tamil';
    }
    return 'English';
  }

  private convertTemplateTextForLanguage(text: string, language: string): string {
    const target = language.trim().toLowerCase();
    if (!text.trim() || target === 'english' || target === 'en') {
      return text;
    }

    const protectedValues: string[] = [];
    const protect = (value: string) => {
      const token = `__BT_SAFE_${protectedValues.length}__`;
      protectedValues.push(value);
      return token;
    };
    let converted = text
      .replace(/{{\s*[^{}]+\s*}}/g, protect)
      .replace(/https?:\/\/\S+/gi, protect);

    converted = target.includes('sinhala') || target.includes('si')
      ? this.convertCommonTemplatePhrases(converted, [
          ['Your BizTalk demo', 'ඔබගේ BizTalk demo'],
          ['Thanks for your interest in BizTalk!', 'BizTalk ගැන ඔබගේ උනන්දුවට ස්තුතියි!'],
          ['Thanks for your interest', 'ඔබගේ උනන්දුවට ස්තුතියි'],
          ['Your demo is booked for', 'ඔබගේ demo එක වෙන් කර ඇත'],
          ['Please reply if you need to change the time.', 'වේලාව වෙනස් කිරීමට අවශ්‍ය නම් කරුණාකර reply කරන්න.'],
          ['Shared inbox for your business', 'ඔබේ ව්‍යාපාරය සඳහා shared inbox'],
          ['Confirm', 'තහවුරු කරන්න'],
          ['Reschedule', 'නැවත වේලාවක් තෝරන්න'],
          ['Visit website', 'වෙබ් අඩවිය බලන්න'],
          ['Hi', 'ආයුබෝවන්'],
          ['Hello', 'ආයුබෝවන්'],
          ['Thank you', 'ස්තුතියි'],
          ['Thank you.', 'ස්තුතියි.'],
        ])
      : target.includes('tamil') || target.includes('ta')
        ? this.convertCommonTemplatePhrases(converted, [
            ['Your BizTalk demo', 'உங்கள் BizTalk demo'],
            ['Thanks for your interest in BizTalk!', 'BizTalk பற்றிய உங்கள் ஆர்வத்திற்கு நன்றி!'],
            ['Thanks for your interest', 'உங்கள் ஆர்வத்திற்கு நன்றி'],
            ['Your demo is booked for', 'உங்கள் demo பதிவு செய்யப்பட்டுள்ளது'],
            ['Please reply if you need to change the time.', 'நேரத்தை மாற்ற வேண்டுமெனில் reply செய்யவும்.'],
            ['Shared inbox for your business', 'உங்கள் வணிகத்திற்கான shared inbox'],
            ['Confirm', 'உறுதிப்படுத்து'],
            ['Reschedule', 'மீண்டும் திட்டமிடு'],
            ['Visit website', 'வலைத்தளத்தைப் பாருங்கள்'],
            ['Hi', 'வணக்கம்'],
            ['Hello', 'வணக்கம்'],
            ['Thank you', 'நன்றி'],
            ['Thank you.', 'நன்றி.'],
          ])
        : converted;

    protectedValues.forEach((value, index) => {
      converted = converted.replace(new RegExp(`__BT_SAFE_${index}__`, 'g'), value);
    });
    return converted;
  }

  private convertCommonTemplatePhrases(text: string, dictionary: Array<[string, string]>): string {
    return dictionary.reduce((current, [source, replacement]) => {
      return current.replace(new RegExp(this.escapeRegExp(source), 'gi'), replacement);
    }, text);
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  async sendConversationTemplate(user: AuthenticatedUser, conversationId: number, templateId: number, custom: SendMessageTemplateDto) {
    await this.assertConversationAccess(user, conversationId);
    const conversation = await this.findConversationForCompany(conversationId, user.company_id);
    if (!conversation?.channelUser) throw new NotFoundException('Conversation not found.');
    const channelUser = conversation.channelUser;
    const platform = channelUser.platform?.toLowerCase() === 'facebook' ? 'messenger' : channelUser.platform?.toLowerCase();
    if (platform !== 'messenger' && platform !== 'instagram') throw new BadRequestException('Social templates are only available for Messenger and Instagram.');
    const template = await this.messageTemplateRepository.findOne({ where: { id: templateId, company_id: user.company_id } });
    if (!template || !template.platforms.includes(platform)) throw new BadRequestException('This template is not available for the selected channel.');
    const rawBody = custom.body?.trim() || template.body;
    const rawTitle = custom.title?.trim() || template.title || template.name;
    const imageUrl = custom.image_url?.trim() || template.image_url || undefined;
    const targetLanguage = await this.resolveConversationTemplateLanguage(conversation);
    const title = this.convertTemplateTextForLanguage(rawTitle, targetLanguage);
    const body = this.convertTemplateTextForLanguage(rawBody, targetLanguage);
    const buttons = (custom.buttons?.length ? custom.buttons : template.buttons).slice(0, 3).map((button) => ({
      ...button,
      label: this.convertTemplateTextForLanguage(button.label, targetLanguage),
    }));
    const element: Record<string, unknown> = { title, subtitle: body };
    if (imageUrl) element.image_url = imageUrl;
    if (buttons.length) element.buttons = buttons.map(button => button.url
      ? { type: 'web_url', title: button.label, url: button.url }
      : { type: 'postback', title: button.label, payload: button.payload || button.label });
    const providerMessageId = await this.postSocialMessage(user.company_id, platform, channelUser.source_account_id, channelUser.external_user_id, {
      attachment: { type: 'template', payload: { template_type: 'generic', elements: [element] } },
    });
    const saved = await this.messageRepository.save(this.messageRepository.create({
      conversation_id: conversationId, direction: 'outbound', message_type: imageUrl ? 'image' : 'text', platform,
      provider_message_id: providerMessageId, content: `${title}\n${body}`, media_url: imageUrl || null, source: 'template',
    }));
    conversation.last_message_at = new Date(); await this.conversationRepository.save(conversation);
    return { message: saved };
  }
  async sendConversationMessage(
    user: AuthenticatedUser,
    conversationId: number,
    text: string,
  ) {
    await this.assertConversationAccess(user, conversationId);
    const trimmed = text.trim();
    if (!trimmed) {
      throw new BadRequestException('Message text is required.');
    }

    const conversation = await this.findConversationForCompany(
      conversationId,
      user.company_id,
    );

    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }

    const company = await this.getCompanyForUser(user);
    const isAdmin =
      company != null && Number(company.admin_user_id) === Number(user.id);
    if (
      !isAdmin &&
      Number(conversation.assigned_agent_id) !== Number(user.id)
    ) {
      throw new ForbiddenException('You do not have access to this conversation.');
    }

    const channelUser = conversation.channelUser;
    if (!channelUser) {
      throw new BadRequestException('Conversation has no linked channel user.');
    }

    const socialPlatform = channelUser.platform?.toLowerCase();
    let providerMessageId: string | null = null;
    if (socialPlatform === 'messenger' || socialPlatform === 'facebook' || socialPlatform === 'instagram') {
      providerMessageId = await this.sendSocialConversationText(user.company_id, socialPlatform === 'facebook' ? 'messenger' : socialPlatform, channelUser.source_account_id, channelUser.external_user_id, trimmed);
    } else {
      const phone = this.normalizePhoneKey(channelUser.external_user_id);
      if (!phone) throw new BadRequestException('Invalid customer phone on this conversation.');
      await this.sendCompanyWhatsappText(user.company_id, phone, trimmed);
    }

    channelUser.manual_mode = true;
    channelUser.last_seen_at = new Date();
    await this.channelUserRepository.save(channelUser);

    const message = this.messageRepository.create({
      conversation_id: conversationId,
      direction: 'outbound',
      message_type: 'text',
      platform: channelUser.platform || 'whatsapp',
      content: trimmed,
      source: isAdmin ? 'admin' : 'agent',
      provider_message_id: providerMessageId,
      delivery_status: providerMessageId ? 'sent' : null,
    });
    const saved = await this.messageRepository.save(message);

    conversation.last_message_at = new Date();
    await this.conversationRepository.save(conversation);

    return { message: saved };
  }

  private normalizeUploadedMediaFile(file: {
    buffer?: Buffer | Uint8Array;
    mimetype?: string;
    originalname?: string;
    size?: number;
    path?: string;
  } | null | undefined): {
    buffer: Buffer;
    mimetype: string;
    originalname: string;
    size: number;
  } {
    if (!file) {
      throw new BadRequestException(
        'Media file is required. Attach an image or file and try again.',
      );
    }

    let buffer: Buffer | null = null;
    if (Buffer.isBuffer(file.buffer)) {
      buffer = file.buffer;
    } else if (file.buffer instanceof Uint8Array) {
      buffer = Buffer.from(file.buffer);
    } else if (file.path && existsSync(file.path)) {
      buffer = readFileSync(file.path);
    }

    if (!buffer?.length) {
      throw new BadRequestException(
        'Media file is required. Attach an image or file and try again.',
      );
    }

    const maxBytes = 16 * 1024 * 1024;
    const size = file.size ?? buffer.length;
    if (size > maxBytes || buffer.length > maxBytes) {
      throw new BadRequestException('Media file is too large (max 16MB).');
    }

    return {
      buffer,
      mimetype: (file.mimetype || 'application/octet-stream').trim(),
      originalname: (file.originalname || 'file').trim() || 'file',
      size,
    };
  }

  async sendConversationMedia(
    user: AuthenticatedUser,
    conversationId: number,
    file: {
      buffer?: Buffer | Uint8Array;
      mimetype?: string;
      originalname?: string;
      size?: number;
      path?: string;
    } | null | undefined,
    caption?: string,
  ) {
    const { conversation, channelUser, isAdmin } = await this.loadWritableConversation(user, conversationId);
    const uploaded = this.normalizeUploadedMediaFile(file);
    const mimetype = uploaded.mimetype.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    const fileName = uploaded.originalname;
    const mediaType = this.resolveOutboundMediaType(mimetype);
    const trimmedCaption = caption?.trim() || '';
    const platform = this.normalizeChannelPlatform(channelUser.platform);

    // Keep our own copy: the inbox can always show/download it, and Instagram needs a public URL.
    const storedKey = saveChatMedia(user.company_id, uploaded.buffer, mimetype, fileName);

    let providerMessageId: string | null = null;
    if (platform === 'instagram') {
      providerMessageId = await this.sendInstagramMedia(
        user.company_id, channelUser.source_account_id, channelUser.external_user_id, storedKey, mediaType, trimmedCaption,
      );
    } else if (platform === 'messenger') {
      providerMessageId = await this.sendMessengerMedia(
        user.company_id, channelUser.source_account_id, channelUser.external_user_id,
        { buffer: uploaded.buffer, mimetype, originalname: fileName }, trimmedCaption,
      );
    } else {
      const phone = this.normalizePhoneKey(channelUser.external_user_id);
      if (!phone) {
        throw new BadRequestException('Invalid customer phone on this conversation.');
      }
      await this.sendCompanyWhatsappMedia(user.company_id, phone, {
        buffer: uploaded.buffer,
        mimetype,
        fileName,
        caption: trimmedCaption || undefined,
        mediaType,
      });
    }

    channelUser.manual_mode = true;
    channelUser.last_seen_at = new Date();
    await this.channelUserRepository.save(channelUser);

    // Row format the inbox understands:
    //   image → image,  audio → voice,  video/document → text row with the file
    //   documents keep their file name as content so a document card is shown.
    const saved = await this.messageRepository.save(
      this.messageRepository.create({
        conversation_id: conversationId,
        direction: 'outbound',
        message_type: mediaType === 'image' ? 'image' : mediaType === 'audio' ? 'voice' : 'text',
        platform: channelUser.platform || 'whatsapp',
        provider_message_id: providerMessageId,
        delivery_status: providerMessageId ? 'sent' : null,
        content: mediaType === 'document' ? fileName : trimmedCaption || `[${mediaType}]`,
        media_url: storedKey,
        source: isAdmin ? 'admin' : 'agent',
      }),
    );

    conversation.last_message_at = new Date();
    await this.conversationRepository.save(conversation);
    return { message: saved };
  }

  /* ════════════════ New helpers (add inside BotAdminService) ════════════════ */

  private normalizeChannelPlatform(value: string | null | undefined): 'whatsapp' | 'messenger' | 'instagram' {
    const platform = String(value ?? '').toLowerCase();
    if (platform.includes('instagram')) return 'instagram';
    if (platform.includes('messenger') || platform.includes('facebook')) return 'messenger';
    return 'whatsapp';
  }

  /** Same access rules as sending a text message. */
  private async loadWritableConversation(user: AuthenticatedUser, conversationId: number) {
    await this.assertConversationAccess(user, conversationId);
    const conversation = await this.findConversationForCompany(conversationId, user.company_id);
    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }
    const company = await this.getCompanyForUser(user);
    const isAdmin = company != null && Number(company.admin_user_id) === Number(user.id);
    if (!isAdmin && Number(conversation.assigned_agent_id) !== Number(user.id)) {
      throw new ForbiddenException('You do not have access to this conversation.');
    }
    const channelUser = conversation.channelUser;
    if (!channelUser) {
      throw new BadRequestException('Conversation has no linked channel user.');
    }
    return { conversation, channelUser, isAdmin };
  }

  /** Instagram only accepts media by public URL → send a signed link to our stored copy. */
  private async sendInstagramMedia(
    companyId: number,
    accountId: string | null,
    recipientId: string,
    storedKey: string,
    mediaType: 'image' | 'document' | 'audio' | 'video',
    caption: string,
  ): Promise<string | null> {
    if (mediaType === 'document') {
      throw new BadRequestException('Instagram can only receive photos, videos and audio.');
    }
    const url = publicChatMediaUrl(storedKey, 60 * 60);
    if (!url) {
      throw new BadRequestException(
        'Set PUBLIC_API_BASE_URL on the server (your public https API address) so Instagram can download the file.',
      );
    }
    const messageId = await this.postSocialMessage(companyId, 'instagram', accountId, recipientId, {
      attachment: { type: mediaType, payload: { url } },
    });
    if (caption) {
      await this.postSocialMessage(companyId, 'instagram', accountId, recipientId, { text: caption });
    }
    return messageId;
  }

  /** Marks the chat read for the team and sends a read receipt (blue ticks) when something was unread. */
  private async markConversationRead(conversation: BotConversation, companyId: number): Promise<void> {
    const unreadBefore = await this.countUnreadInboundMessages(conversation);
    await this.conversationRepository.update({ id: conversation.id }, { agent_last_read_at: new Date() });
    if (unreadBefore > 0) {
      await this.sendReadReceipt(conversation, companyId);
    }
  }

  private async sendReadReceipt(conversation: BotConversation, companyId: number): Promise<void> {
    const channelUser = conversation.channelUser;
    if (!channelUser) return;
    const platform = this.normalizeChannelPlatform(channelUser.platform);
    try {
      if (platform === 'whatsapp') {
        const channel = await this.resolveCompanyWhatsappChannel(companyId);
        const token = channel?.meta_access_token?.trim();
        const phoneNumberId = channel?.meta_phone_number_id?.trim();
        if (!this.isMetaWhatsappChannel(channel) || !token || !phoneNumberId) return;
        const lastInbound = await this.messageRepository
          .createQueryBuilder('m')
          .where('m.conversation_id = :id', { id: conversation.id })
          .andWhere("m.direction::text = 'inbound'")
          .andWhere("m.provider_message_id LIKE 'wamid.%'")
          .orderBy('m.id', 'DESC')
          .getOne();
        if (!lastInbound?.provider_message_id) return;
        await fetch(`https://graph.facebook.com/${this.metaGraphVersion()}/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: lastInbound.provider_message_id }),
          signal: AbortSignal.timeout(8000),
        });
        return;
      }
      // Messenger / Instagram: "seen"
      const target = await this.getSocialReplyTarget(companyId, platform, channelUser.source_account_id);
      const version = process.env.META_GRAPH_API_VERSION?.trim() || 'v19.0';
      await fetch(`https://graph.facebook.com/${version}/${target.sendAccountId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${target.connection.page_access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: channelUser.external_user_id }, sender_action: 'mark_seen' }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (error) {
      console.warn('Read receipt failed:', error instanceof Error ? error.message : error);
    }
  }

  /* ───── Location & contact: native WhatsApp cards, text fallback everywhere else ───── */

  async sendConversationLocation(user: AuthenticatedUser, conversationId: number, dto: SendLocationDto) {
    const name = dto.name?.trim() || 'Location';
    const address = dto.address?.trim() || '';
    // Stored in the format the inbox renders as a map card.
    const text = [`📍 ${name}`, address, `https://maps.google.com/?q=${dto.latitude},${dto.longitude}`]
      .filter(Boolean)
      .join('\n');
    return this.sendStructuredMessage(user, conversationId, text, {
      type: 'location',
      meta: { latitude: dto.latitude, longitude: dto.longitude, name, address: address || undefined },
      evolutionPath: 'sendLocation',
      evolutionBody: { name, address, latitude: dto.latitude, longitude: dto.longitude },
    });
  }

  async sendConversationContact(user: AuthenticatedUser, conversationId: number, dto: SendContactDto) {
    const digits = dto.phone.replace(/\D/g, '');
    const name = dto.name.trim();
    const text = `Contact: ${name}\nPhone: +${digits}${dto.company?.trim() ? `\nCompany: ${dto.company.trim()}` : ''}`;
    return this.sendStructuredMessage(user, conversationId, text, {
      type: 'contacts',
      meta: [{
        name: { formatted_name: name, first_name: name.split(' ')[0] || name },
        phones: [{ phone: `+${digits}`, type: 'CELL', wa_id: digits }],
        ...(dto.company?.trim() ? { org: { company: dto.company.trim() } } : {}),
      }],
      evolutionPath: 'sendContact',
      evolutionBody: { contact: [{ fullName: name, wuid: digits, phoneNumber: `+${digits}`, organization: dto.company?.trim() || undefined }] },
    });
  }

  private async sendStructuredMessage(
    user: AuthenticatedUser,
    conversationId: number,
    text: string,
    native: { type: 'location' | 'contacts'; meta: unknown; evolutionPath: string; evolutionBody: Record<string, unknown> },
  ) {
    const { conversation, channelUser, isAdmin } = await this.loadWritableConversation(user, conversationId);
    const platform = this.normalizeChannelPlatform(channelUser.platform);
    let providerMessageId: string | null = null;
    let sentNative = false;

    if (platform === 'whatsapp') {
      const phone = this.normalizePhoneKey(channelUser.external_user_id);
      if (!phone) {
        throw new BadRequestException('Invalid customer phone on this conversation.');
      }
      const result = await this.trySendWhatsappNative(user.company_id, phone, native);
      sentNative = result.ok;
      providerMessageId = result.messageId;
      if (!sentNative) {
        await this.sendCompanyWhatsappText(user.company_id, phone, text); // fallback: customer gets the text version
      }
    } else {
      providerMessageId = await this.sendSocialConversationText(
        user.company_id, platform, channelUser.source_account_id, channelUser.external_user_id, text,
      );
    }

    channelUser.manual_mode = true;
    channelUser.last_seen_at = new Date();
    await this.channelUserRepository.save(channelUser);

    const saved = await this.messageRepository.save(
      this.messageRepository.create({
        conversation_id: conversationId,
        direction: 'outbound',
        message_type: 'text',
        platform: channelUser.platform || 'whatsapp',
        provider_message_id: providerMessageId,
        delivery_status: providerMessageId ? 'sent' : null,
        content: text,
        source: isAdmin ? 'admin' : 'agent',
      }),
    );
    conversation.last_message_at = new Date();
    await this.conversationRepository.save(conversation);
    return { message: saved, native: sentNative };
  }

  /** Sends a real WhatsApp location/contact card (Meta Cloud API or Evolution). Never throws. */
  private async trySendWhatsappNative(
    companyId: number,
    phone: string,
    native: { type: 'location' | 'contacts'; meta: unknown; evolutionPath: string; evolutionBody: Record<string, unknown> },
  ): Promise<{ ok: boolean; messageId: string | null }> {
    try {
      const channel = await this.resolveCompanyWhatsappChannel(companyId);
      if (!channel) return { ok: false, messageId: null };

      if (this.isMetaWhatsappChannel(channel)) {
        const token = channel.meta_access_token?.trim();
        const phoneNumberId = channel.meta_phone_number_id?.trim();
        if (!token || !phoneNumberId) return { ok: false, messageId: null };
        const res = await fetch(`https://graph.facebook.com/${this.metaGraphVersion()}/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: native.type, [native.type]: native.meta }),
          signal: AbortSignal.timeout(15000),
        });
        const json = (await res.json().catch(() => ({}))) as { messages?: Array<{ id?: string }>; error?: { message?: string } };
        if (!res.ok) {
          console.warn(`WhatsApp native ${native.type} failed:`, json.error?.message ?? res.status);
          return { ok: false, messageId: null };
        }
        return { ok: true, messageId: json.messages?.[0]?.id ?? null };
      }

      const evolution = this.getEvolutionConfig();
      const base = (channel.evolution_api_base?.trim() || evolution.base || '').replace(/\/+$/, '');
      const instance = this.resolveEvolutionInstanceName(channel) || channel.instance_name?.trim() || '';
      const apikey = (channel.evaluation_whatsapp_key ?? evolution.secureKey)?.trim();
      if (!base || !instance || !apikey) return { ok: false, messageId: null };
      const res = await fetch(`${base}/message/${native.evolutionPath}/${encodeURIComponent(instance)}`, {
        method: 'POST',
        headers: { apikey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: phone, ...native.evolutionBody }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        console.warn(`Evolution ${native.evolutionPath} failed:`, res.status, await res.text().catch(() => ''));
        return { ok: false, messageId: null };
      }
      return { ok: true, messageId: null };
    } catch (error) {
      console.warn('Native WhatsApp send error:', error instanceof Error ? error.message : error);
      return { ok: false, messageId: null };
    }
  }

  async createTraining(user: AuthenticatedUser, payload: CreateBotTrainingDto) {
    await this.assertCompanyAccess(user);

    // Call the Python bot's AI extraction endpoint for better Q&A generation
    try {
      const response = await fetch(`${this.getBotServiceBaseUrl()}/external/admin/training/upload-raw-content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: user.company_id,
          admin_user_id: user.id,
          content: payload.answer, // Use the pasted content as raw input
          category: payload.category?.trim() ?? 'Manual',
          language: payload.language?.trim() ?? 'English',
        }),
      });

      if (response.ok) {
        return response.json();
      }
    } catch (error) {
      console.error('Failed to call bot extraction endpoint:', error);
    }

    // Fallback to simple creation if bot is down or fails
    const item = this.trainingRepository.create({
      company_id: user.company_id,
      question: payload.question.trim(),
      answer: payload.answer.trim(),
      category: payload.category?.trim() ?? '',
      language: payload.language?.trim() ?? 'English',
      is_active: true,
    });

    return this.trainingRepository.save(item);
  }

  async uploadTrainingFile(
    user: AuthenticatedUser,
    file: any,
    category?: string,
    content?: string,
  ) {
    await this.assertCompanyAccess(user);

    // Convert file to base64 with proper data URL prefix so the bot can detect the mime type
    const mimeType = file.mimetype || 'image/jpeg';
    const imageBase64 = `data:${mimeType};base64,${file.buffer.toString('base64')}`;
    const rawContent = content?.trim()
      ? content.trim()
      : `This is an image of a product named "${file.originalname.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ')}". Extract training Q&A pairs about it.`;
    
    try {
      const response = await fetch(`${this.getBotServiceBaseUrl()}/external/admin/training/upload-raw-content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: user.company_id,
          admin_user_id: user.id,
          content: rawContent,
          image_base64: imageBase64,
          category: category?.trim() ?? 'Document',
        }),
      });

      if (response.ok) {
        return response.json();
      }
      
      const errBody = await response.text();
      console.error('Bot training upload failed:', response.status, errBody);
    } catch (error) {
      console.error('Failed to connect to Python bot for file training:', error);
    }

    // Fallback: simple record (not ideal, but prevents crash)
    const item = this.trainingRepository.create({
      company_id: user.company_id,
      question: `Document: ${file.originalname}`,
      answer: `[Processing Failed] Content from ${file.originalname}`,
      category: category?.trim() ?? 'Document',
      language: 'English',
      is_active: true,
    });

    return this.trainingRepository.save(item);
  }

  async getTrainingHistory(user: AuthenticatedUser) {
    await this.assertCompanyAccess(user);
    const builder = this.trainingRepository
      .createQueryBuilder('training')
      .orderBy('training.created_at', 'DESC')
      .take(100);

    builder
      .where('training.company_id = :companyId', { companyId: user.company_id })
      .andWhere('training.is_active = true');

    return builder.getMany();
  }

  async updateTraining(user: AuthenticatedUser, id: number, payload: UpdateBotTrainingDto) {
    await this.assertCompanyAccess(user);
    const item = await this.trainingRepository.findOne({
      where: { id, company_id: user.company_id, is_active: true },
    });
    if (!item) throw new NotFoundException('Training item not found.');
    item.question = payload.question.trim();
    item.answer = payload.answer.trim();
    item.category = payload.category?.trim() ?? item.category;
    item.language = payload.language?.trim() ?? item.language;
    return this.trainingRepository.save(item);
  }
  async deleteTraining(user: AuthenticatedUser, id: number) {
    await this.assertCompanyAccess(user);
    const item = await this.trainingRepository.findOne({
      where: { id, company_id: user.company_id },
    });
    if (!item) {
      throw new NotFoundException('Training item not found.');
    }

    item.is_active = false;
    await this.trainingRepository.save(item);

    try {
      const response = await fetch(`${this.getBotServiceBaseUrl()}/bot/sync/training/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: user.company_id,
          user_id: user.id,
          training_id: id,
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        console.error('Bot training vector delete failed:', response.status, body);
      }
    } catch (error) {
      console.error('Failed to delete training vector from bot:', error);
    }

    return { id, removed: true };
  }

  async getOrders(user: AuthenticatedUser) {
    await this.assertAdminAccess(user);
    return this.orderRepository.find({
      where: { company_id: user.company_id },
      relations: ['channelUser', 'items', 'statusHistory'],
      order: { id: 'DESC' },
      take: 100,
    });
  }

  /**
   * Orders for clients currently assigned to this agent (pending/active chats only).
   * Does not change admin order listing or mutations.
   */
  async getAgentOrders(user: AuthenticatedUser) {
    const agentId = Number(user.id);
    const companyId = Number(user.company_id);
    if (!Number.isFinite(companyId) || companyId <= 0) {
      throw new ForbiddenException('Company not found.');
    }

    const dbUser = await this.userRepository.findOne({ where: { id: agentId } });
    if (!dbUser || Number(dbUser.company_id) !== companyId) {
      throw new ForbiddenException('Agent company mismatch.');
    }

    const assignedConversations = await this.conversationRepository
      .createQueryBuilder('c')
      .innerJoin('c.channelUser', 'channelUser')
      .where('CAST(c.assigned_agent_id AS BIGINT) = CAST(:agentId AS BIGINT)', {
        agentId,
      })
      .andWhere(
        'CAST(channelUser.company_id AS BIGINT) = CAST(:companyId AS BIGINT)',
        { companyId },
      )
      .andWhere('LOWER(c.status) IN (:...statuses)', {
        statuses: ['pending', 'active'],
      })
      .getMany();

    const channelUserIds = [
      ...new Set(
        assignedConversations
          .map((row) => Number(row.bot_channel_user_id))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    ];

    if (channelUserIds.length === 0) {
      return [];
    }

    return this.orderRepository
      .createQueryBuilder('o')
      .leftJoinAndSelect('o.channelUser', 'channelUser')
      .leftJoinAndSelect('o.items', 'items')
      .leftJoinAndSelect('o.statusHistory', 'statusHistory')
      .where('CAST(o.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId,
      })
      .andWhere('o.bot_channel_user_id IN (:...channelUserIds)', {
        channelUserIds,
      })
      .orderBy('o.id', 'DESC')
      .take(100)
      .getMany();
  }

  async createOrder(user: AuthenticatedUser, payload: CreateBotOrderDto) {
    const companyId = this.requireUserCompanyId(user);
    const company = await this.getCompanyForUser(user);
    if (!company || Number(company.id) !== companyId) {
      throw new ForbiddenException('Company not found.');
    }
    const isAdmin = Number(company.admin_user_id) === Number(user.id);

    // Verify channel user exists and belongs to this company
    const channelUser = await this.channelUserRepository
      .createQueryBuilder('channelUser')
      .where('channelUser.id = :channelUserId', {
        channelUserId: payload.bot_channel_user_id,
      })
      .andWhere(
        'CAST(channelUser.company_id AS BIGINT) = CAST(:companyId AS BIGINT)',
        { companyId },
      )
      .getOne();

    if (!channelUser) {
      throw new NotFoundException('Channel user not found.');
    }

    // Agents may only create orders for clients currently assigned to them.
    if (!isAdmin) {
      const assigned = await this.conversationRepository
        .createQueryBuilder('c')
        .where('c.bot_channel_user_id = :channelUserId', {
          channelUserId: channelUser.id,
        })
        .andWhere(
          'CAST(c.assigned_agent_id AS BIGINT) = CAST(:agentId AS BIGINT)',
          { agentId: Number(user.id) },
        )
        .andWhere('LOWER(c.status) IN (:...statuses)', {
          statuses: ['pending', 'active'],
        })
        .getOne();
      if (!assigned) {
        throw new ForbiddenException(
          'You can only create orders for clients currently assigned to you.',
        );
      }
    }

    if (!payload.items?.length) {
      throw new BadRequestException('Add at least one order item.');
    }

    // Create order
    const order = this.orderRepository.create({
      company_id: companyId,
      bot_channel_user_id: payload.bot_channel_user_id,
      customer_name: payload.customer_name ?? '',
      customer_phone: payload.customer_phone ?? '',
      address: payload.address || null,
      status: 'Pending',
      total_amount: 0,
    });

    const savedOrder = await this.orderRepository.save(order);

    // Create order items and calculate total
    let totalAmount = 0;
    const items: BotOrderItem[] = [];

    for (const itemPayload of payload.items) {
      const unitPrice = itemPayload.unit_price ?? 0;
      const totalPrice = itemPayload.quantity * unitPrice;
      totalAmount += totalPrice;

      const item = this.orderItemRepository.create({
        order_id: savedOrder.id,
        product_name: itemPayload.product_name,
        variant_text: itemPayload.variant_text || null,
        quantity: itemPayload.quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
      });

      items.push(await this.orderItemRepository.save(item));
    }

    // Update order with total amount
    savedOrder.total_amount = totalAmount;
    await this.orderRepository.save(savedOrder);

    // Create initial status history
    await this.orderStatusHistoryRepository.save(
      this.orderStatusHistoryRepository.create({
        order_id: savedOrder.id,
        status: 'Pending',
        message: 'Order created and pending confirmation.',
      }),
    );

    return {
      order: { ...savedOrder, items },
      message: 'Order created successfully.',
    };
  }

  async updateOrderStatus(
    user: AuthenticatedUser,
    id: number,
    payload: UpdateOrderStatusDto,
  ) {
    await this.assertAdminAccess(user);
    const order = await this.orderRepository.findOne({
      where: { id, company_id: user.company_id },
      relations: ['channelUser', 'items'],
    });
    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    order.status = payload.status;
    const saved = await this.orderRepository.save(order);
    const message = await this.renderOrderStatusMessage(user.company_id, saved);
    await this.orderStatusHistoryRepository.save(
      this.orderStatusHistoryRepository.create({
        order_id: saved.id,
        status: saved.status,
        message,
      }),
    );
    await this.sendWhatsappStatusMessage(
      user.company_id,
      saved.channelUser?.external_user_id,
      message,
    );
    return { order: saved, message };
  }

  async getStatusTemplates(user: AuthenticatedUser) {
    await this.assertAdminAccess(user);
    const existing = await this.orderStatusTemplateRepository.find({
      where: { company_id: user.company_id },
      order: { status: 'ASC' },
    });
    const map = new Map(existing.map((item) => [item.status, item]));
    return Object.entries(this.defaultStatusTemplates).map(([status, template]) => ({
      status,
      template: map.get(status as BotOrderStatus)?.template ?? template,
    }));
  }

  async updateStatusTemplate(
    user: AuthenticatedUser,
    payload: UpdateStatusTemplateDto,
  ) {
    await this.assertAdminAccess(user);
    let template = await this.orderStatusTemplateRepository.findOne({
      where: { company_id: user.company_id, status: payload.status },
    });
    if (!template) {
      template = this.orderStatusTemplateRepository.create({
        company_id: user.company_id,
        status: payload.status,
      });
    }
    template.template = payload.template.trim();
    return this.orderStatusTemplateRepository.save(template);
  }

  private async renderOrderStatusMessage(companyId: number, order: BotOrder) {
    const template = await this.orderStatusTemplateRepository.findOne({
      where: { company_id: companyId, status: order.status },
    });
    const raw = template?.template ?? this.defaultStatusTemplates[order.status];
    return raw
      .replace(/\{orderId\}/g, String(order.id))
      .replace(/\{status\}/g, order.status)
      .replace(/\{total\}/g, String(order.total_amount))
      .replace(/\{customerName\}/g, order.customer_name || 'customer')
      .replace(/\{invoiceUrl\}/g, order.invoice_url || '');
  }

  private async sendWhatsappStatusMessage(
    companyId: number,
    phone: string | undefined,
    message: string,
  ) {
    const cleanedPhone = String(phone ?? '').replace(/\D/g, '');
    if (!cleanedPhone) {
      return false;
    }

    const channel = await this.resolveCompanyWhatsappChannel(companyId);
    if (!channel) {
      return false;
    }

    if (channel.provider_type === 'meta') {
      const phoneNumberId = channel.meta_phone_number_id?.trim();
      const accessToken = channel.meta_access_token?.trim();
      if (!phoneNumberId || !accessToken) {
        return false;
      }

      const pdfMatch = message.match(/https?:\/\/[^\s<>"]+\.pdf/i);
      const hasPdf = !!pdfMatch;
      const pdfUrl = hasPdf ? pdfMatch[0] : null;
      const graphVersion =
        this.getEnvValue('META_GRAPH_API_VERSION') || 'v22.0';

      try {
        let payload: Record<string, unknown>;
        if (hasPdf && pdfUrl) {
          const cleanMessage = message.replace(pdfUrl, '').trim();
          payload = {
            messaging_product: 'whatsapp',
            to: cleanedPhone,
            type: 'document',
            document: {
              link: pdfUrl,
              filename: `invoice_${pdfUrl.split('/').pop() || 'order'}.pdf`,
              caption: cleanMessage || undefined,
            },
          };
        } else {
          payload = {
            messaging_product: 'whatsapp',
            to: cleanedPhone,
            type: 'text',
            text: { body: message },
          };
        }

        const response = await fetch(
          `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          },
        );
        return response.ok;
      } catch (error) {
        console.error('Failed to send order status WhatsApp message via Meta:', error);
        return false;
      }
    }

    const evolution = this.getEvolutionConfig();
    const base = (
      channel.evolution_api_base?.trim() ||
      evolution.base ||
      ''
    ).replace(/\/+$/, '');
    const instance = channel.instance_name?.trim();
    const apikey = (channel.evaluation_whatsapp_key ?? evolution.secureKey)?.trim();

    if (!base || !instance || !apikey) {
      return false;
    }

    try {
      const response = await fetch(
        `${base}/message/sendText/${encodeURIComponent(instance)}`,
        {
          method: 'POST',
          headers: {
            apikey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            number: cleanedPhone,
            text: message,
            delay: 1200,
          }),
        },
      );
      return response.ok;
    } catch (error) {
      console.error('Failed to send WhatsApp message via Evolution:', error);
      return false;
    }
  }

  async sendOrderInvoice(user: AuthenticatedUser, id: number) {
    await this.assertAdminAccess(user);
    const order = await this.orderRepository.findOne({
      where: { id, company_id: user.company_id },
      relations: ['channelUser', 'items'],
    });

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    const company = await this.getCompanyForUser(user);

    const invoiceUrl = this.writeInvoicePdf(order, company);
    order.invoice_url = invoiceUrl;
    const saved = await this.orderRepository.save(order);

    const message = `Invoice for order #${saved.id}\nTotal: ${this.formatMoney(saved.total_amount)}\n${invoiceUrl}`;
    const sent = await this.sendWhatsappStatusMessage(
      user.company_id,
      saved.channelUser?.external_user_id,
      message,
    );

    await this.orderStatusHistoryRepository.save(
      this.orderStatusHistoryRepository.create({
        order_id: saved.id,
        status: saved.status,
        message: sent ? 'Invoice sent to customer.' : 'Invoice generated, but WhatsApp send failed.',
      }),
    );

    return {
      order: saved,
      invoice_url: invoiceUrl,
      sent,
      message: sent
        ? 'Invoice sent to customer.'
        : 'Invoice generated, but WhatsApp send failed. Check WhatsApp credentials and public bot URL.',
    };
  }

  private writeInvoicePdf(order: BotOrder, company: Company | null) {
    const invoiceDir = this.getInvoiceDirectory();
    mkdirSync(invoiceDir, { recursive: true });

    const filename = `invoice-order-${order.id}.pdf`;
    const filePath = join(invoiceDir, filename);
    const lines = this.buildInvoiceLines(order, company);
    writeFileSync(filePath, this.buildSimplePdf(lines));

    const publicBaseUrl = this.getBotPublicBaseUrl();
    return `${publicBaseUrl}/external/static/invoices/${filename}`;
  }

  private getInvoiceDirectory() {
    return resolve(
      this.getEnvValue('BOT_INVOICE_DIR') ??
        join(process.cwd(), '..', 'bot', 'app', 'static', 'invoices'),
    );
  }

  private getBotPublicBaseUrl() {
    return (
      this.getEnvValue('BOT_PUBLIC_BASE_URL') ??
      this.getEnvValue('BOT_PUBLIC_URL') ??
      this.getEnvValue('BOT_BASE_URL') ??
      'http://localhost:5005'
    ).replace(/\/+$/, '');
  }

  private getBotServiceBaseUrl() {
    return (
      this.getEnvValue('BOT_API_BASE_URL') ??
      this.getEnvValue('BOT_INTERNAL_BASE_URL') ??
      this.getEnvValue('BOT_BASE_URL') ??
      'http://localhost:5005'
    ).replace(/\/+$/, '');
  }

  private getEnvValue(key: string) {
    const direct = process.env[key]?.trim();
    if (direct) {
      return direct;
    }

    const botEnvPath = resolve(process.cwd(), '..', 'bot', '.env');
    if (!existsSync(botEnvPath)) {
      return undefined;
    }

    const content = readFileSync(botEnvPath, 'utf8');
    const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'));
    if (!match) {
      return undefined;
    }

    return match[1].trim().replace(/^['"]|['"]$/g, '');
  }

  private buildInvoiceLines(order: BotOrder, company: Company | null) {
    const companyName = company?.name?.trim() || 'Invoice';
    const companyDetails = [
      company?.address?.trim(),
      company?.phone?.trim() ? `Phone: ${company.phone.trim()}` : '',
      company?.email?.trim() ? `Email: ${company.email.trim()}` : '',
    ].filter((detail): detail is string => Boolean(detail));

    const lines = [
      companyName,
      ...companyDetails,
      '============================================================',
      `INVOICE #${order.id}`,
      `Date: ${this.formatDate(order.created_at)}`,
      `Status: ${order.status}`,
      '',
      'BILL TO',
      `Name    : ${order.customer_name || '-'}`,
      `Phone   : ${order.customer_phone || order.channelUser?.external_user_id || '-'}`,
      `Address : ${order.address || '-'}`,
      '',
      'ITEMS',
      '------------------------------------------------------------',
      'Description                         Qty    Unit       Amount',
      '------------------------------------------------------------',
    ];

    for (const item of order.items ?? []) {
      const description = item.product_name;
      lines.push(
        `${description.padEnd(34).slice(0, 34)} ${String(item.quantity).padStart(3)}  ${this.formatMoney(item.unit_price).padStart(9)}  ${this.formatMoney(item.total_price).padStart(10)}`,
      );
      if (item.variant_text) {
        lines.push(`  ${item.variant_text}`);
      }
    }

    lines.push(
      '------------------------------------------------------------',
      `${'TOTAL'.padEnd(49)}${this.formatMoney(order.total_amount).padStart(10)}`,
      '============================================================',
      '',
      'Thank you for your order.',
    );
    return lines;
  }

  private formatMoney(value: unknown) {
    const amount = Number(value || 0);
    const symbol = this.getEnvValue('BOT_ORDER_CURRENCY_SYMBOL') ?? 'Rs';
    const separator = symbol.length === 1 ? '' : ' ';
    return `${symbol}${separator}${amount.toLocaleString(undefined, {
      minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    })}`;
  }

  private formatDate(value: Date | string | undefined) {
    return value ? new Date(value).toLocaleString() : new Date().toLocaleString();
  }

  private buildSimplePdf(lines: string[]) {
    const sanitizedLines = lines.flatMap((line) => {
      const chunks = line.match(/.{1,86}/g) ?? [''];
      return chunks.map((chunk) =>
        chunk
          .replace(/\\/g, '\\\\')
          .replace(/\(/g, '\\(')
          .replace(/\)/g, '\\)'),
      );
    });

    const contentStream = [
      'BT',
      '/F1 12 Tf',
      '50 780 Td',
      ...sanitizedLines.flatMap((line, index) =>
        index === 0 ? [`(${line}) Tj`] : ['0 -16 Td', `(${line}) Tj`],
      ),
      'ET',
    ].join('\n');

    const objects = [
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
      '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
      `5 0 obj << /Length ${Buffer.byteLength(contentStream, 'utf8')} >> stream\n${contentStream}\nendstream endobj`,
    ];

    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [0];
    objects.forEach((object) => {
      offsets.push(Buffer.byteLength(pdf, 'utf8'));
      pdf += `${object}\n`;
    });

    const xrefPosition = Buffer.byteLength(pdf, 'utf8');
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += '0000000000 65535 f \n';
    offsets.slice(1).forEach((offset) => {
      pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
    });
    pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF`;

    return Buffer.from(pdf, 'utf8');
  }

  async updateOrderNote(
    user: AuthenticatedUser,
    orderId: number,
    adminNote: string,
  ) {
    await this.assertAdminAccess(user);
    const order = await this.orderRepository.findOne({
      where: { id: orderId, company_id: user.company_id },
    });
    if (!order) {
      throw new NotFoundException('Order not found.');
    }
    order.admin_note = adminNote.trim() || null;
    await this.orderRepository.save(order);
    return { order };
  }

  async updateOrder(
    user: AuthenticatedUser,
    orderId: number,
    payload: {
      customer_name?: string;
      customer_phone?: string;
      address?: string;
      status?: BotOrderStatus;
      admin_note?: string;
    },
  ) {
    await this.assertAdminAccess(user);
    const order = await this.orderRepository.findOne({
      where: { id: orderId, company_id: user.company_id },
      relations: ['channelUser', 'items'],
    });
    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    if (payload.customer_name !== undefined) {
      order.customer_name = payload.customer_name.trim();
    }
    if (payload.customer_phone !== undefined) {
      order.customer_phone = payload.customer_phone.trim();
    }
    if (payload.address !== undefined) {
      order.address = payload.address.trim() || null;
    }
    if (payload.status !== undefined) {
      order.status = payload.status;
    }
    if (payload.admin_note !== undefined) {
      order.admin_note = payload.admin_note.trim() || null;
    }

    const saved = await this.orderRepository.save(order);
    return { order: saved };
  }

  async deleteOrder(user: AuthenticatedUser, orderId: number) {
    await this.assertAdminAccess(user);
    const order = await this.orderRepository.findOne({
      where: { id: orderId, company_id: user.company_id },
    });
    if (!order) {
      throw new NotFoundException('Order not found.');
    }
    await this.orderItemRepository.delete({ order_id: orderId });
    await this.orderStatusHistoryRepository.delete({ order_id: orderId });
    await this.orderRepository.remove(order);
    return { id: orderId, removed: true };
  }

  async getOrdersForChannelUser(companyId: number, channelUserId: number) {
    if (channelUserId <= 0) {
      return [];
    }
    return this.orderRepository.find({
      where: { company_id: companyId, bot_channel_user_id: channelUserId },
      relations: ['items'],
      order: { created_at: 'DESC' },
      take: 20,
    });
  }

  formatOrdersAsNotes(orders: BotOrder[]): string {
    if (!orders.length) {
      return '';
    }
    return orders
      .map((order) => {
        const lines = (order.items ?? []).map((item) => {
          const variant = item.variant_text?.trim();
          const label = variant
            ? `${item.product_name} (${variant})`
            : item.product_name;
          return `- ${label} x ${item.quantity} = ${this.formatMoney(Number(item.total_price || 0))}`;
        });
        const note = order.admin_note?.trim();
        const noteLine = note ? `\nNote: ${note}` : '';
        return [
          `Order #${order.id} (${order.status}) — ${this.formatDate(order.created_at)}`,
          lines.join('\n') || '- (no items)',
          `Total: ${this.formatMoney(Number(order.total_amount || 0))}${noteLine}`,
        ].join('\n');
      })
      .join('\n\n');
  }

  async listCustomerLabels(user: AuthenticatedUser) {
    const companyId = this.requireUserCompanyId(user);
    const rows = await this.customerLabelRepository
      .createQueryBuilder('label')
      .where('CAST(label.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId,
      })
      .orderBy('label.name', 'ASC')
      .getMany();
    return rows.map((label) => ({
      id: Number(label.id),
      name: label.name,
      color_code: label.color_code,
    }));
  }

  async listLabelAssignments(user: AuthenticatedUser) {
    const companyId = this.requireUserCompanyId(user);

    const company = await this.getCompanyForUser(user);
    if (!company || Number(company.id) !== companyId) {
      throw new ForbiddenException('Company not found.');
    }
    const isAdmin = Number(company.admin_user_id) === Number(user.id);

    const labels = await this.listCustomerLabels(user);
    const conversationsByLabel = new Map<number, Set<number>>(
      labels.map((label) => [label.id, new Set<number>()]),
    );

    const qb = this.conversationLabelRepository
      .createQueryBuilder('cl')
      .innerJoinAndSelect('cl.label', 'label')
      .innerJoinAndSelect('cl.conversation', 'conversation')
      .innerJoinAndSelect('conversation.channelUser', 'channelUser')
      .where('CAST(label.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId,
      })
      .andWhere(
        'CAST(channelUser.company_id AS BIGINT) = CAST(:companyId AS BIGINT)',
        { companyId },
      );

    // Agents only see labels on conversations currently assigned to them.
    if (!isAdmin) {
      qb.andWhere(
        'CAST(conversation.assigned_agent_id AS BIGINT) = CAST(:agentId AS BIGINT)',
        { agentId: Number(user.id) },
      ).andWhere('LOWER(conversation.status) IN (:...statuses)', {
        statuses: ['pending', 'active'],
      });
    }

    const rows = await qb
      .orderBy('conversation.last_message_at', 'DESC', 'NULLS LAST')
      .addOrderBy('conversation.id', 'DESC')
      .addOrderBy('label.name', 'ASC')
      .getMany();

    type AssignmentConversation = {
      conversation_id: number;
      status: string;
      last_message_at: string | null;
      display_name: string;
      external_user_id: string;
      platform: string;
      labels: Array<{ id: number; name: string; color_code: string }>;
    };

    const conversationMap = new Map<number, AssignmentConversation>();

    for (const row of rows) {
      const conversationId = Number(row.conversation_id);
      const labelId = Number(row.label_id);
      const label = row.label;
      const conversation = row.conversation;
      if (
        !label ||
        !conversation ||
        !Number.isInteger(conversationId) ||
        conversationId <= 0 ||
        !Number.isInteger(labelId) ||
        labelId <= 0
      ) {
        continue;
      }

      const labelConversationSet =
        conversationsByLabel.get(labelId) ?? new Set<number>();
      labelConversationSet.add(conversationId);
      conversationsByLabel.set(labelId, labelConversationSet);

      if (!conversationMap.has(conversationId)) {
        const channelUser = conversation.channelUser;
        conversationMap.set(conversationId, {
          conversation_id: conversationId,
          status: String(conversation.status || 'open'),
          last_message_at: conversation.last_message_at
            ? new Date(conversation.last_message_at).toISOString()
            : null,
          display_name: String(channelUser?.display_name || '').trim(),
          external_user_id: String(channelUser?.external_user_id || '').trim(),
          platform: String(channelUser?.platform || '').trim(),
          labels: [],
        });
      }

      const assignment = conversationMap.get(conversationId);
      if (!assignment) {
        continue;
      }
      if (!assignment.labels.some((item) => item.id === labelId)) {
        assignment.labels.push({
          id: labelId,
          name: label.name,
          color_code: label.color_code,
        });
      }
    }

    return {
      summary: labels.map((label) => ({
        ...label,
        conversation_count: conversationsByLabel.get(label.id)?.size ?? 0,
      })),
      conversations: [...conversationMap.values()],
    };
  }

  async createCustomerLabel(
    user: AuthenticatedUser,
    name: string,
    colorCode?: string,
  ) {
    await this.assertAdminAccess(user);
    const companyId = this.requireUserCompanyId(user);
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new BadRequestException('Label name is required.');
    }
    const existing = await this.customerLabelRepository
      .createQueryBuilder('label')
      .where('CAST(label.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId,
      })
      .andWhere('label.name = :name', { name: trimmedName })
      .getOne();
    if (existing) {
      throw new BadRequestException('A label with this name already exists.');
    }
    const label = await this.customerLabelRepository.save(
      this.customerLabelRepository.create({
        company_id: companyId,
        name: trimmedName,
        color_code: colorCode?.trim() || '#64748b',
      }),
    );
    return {
      id: Number(label.id),
      name: label.name,
      color_code: label.color_code,
    };
  }

  async deleteCustomerLabel(user: AuthenticatedUser, labelId: number) {
    await this.assertAdminAccess(user);
    const companyId = this.requireUserCompanyId(user);
    const label = await this.customerLabelRepository
      .createQueryBuilder('label')
      .where('label.id = :labelId', { labelId })
      .andWhere('CAST(label.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId,
      })
      .getOne();
    if (!label) {
      throw new NotFoundException('Label not found.');
    }
    await this.conversationLabelRepository.delete({ label_id: labelId });
    await this.customerLabelRepository.remove(label);
    return { id: labelId, removed: true };
  }

  async listConversationLabels(conversationId: number, companyId: number) {
    const scopedCompanyId = Number(companyId);
    if (!Number.isFinite(scopedCompanyId) || scopedCompanyId <= 0) {
      return [];
    }
    const rows = await this.conversationLabelRepository
      .createQueryBuilder('cl')
      .innerJoin(BotCustomerLabel, 'l', 'l.id = cl.label_id')
      .innerJoin(BotConversation, 'c', 'c.id = cl.conversation_id')
      .innerJoin(BotChannelUser, 'cu', 'cu.id = c.bot_channel_user_id')
      .where('cl.conversation_id = :conversationId', { conversationId })
      .andWhere('CAST(l.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId: scopedCompanyId,
      })
      .andWhere('CAST(cu.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId: scopedCompanyId,
      })
      .select([
        'l.id AS id',
        'l.name AS name',
        'l.color_code AS color_code',
      ])
      .getRawMany<{ id: string | number; name: string; color_code: string }>();
    return rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      color_code: row.color_code,
    }));
  }

  async assignConversationLabels(
    user: AuthenticatedUser,
    conversationId: number,
    labelIds: number[],
  ) {
    const companyId = this.requireUserCompanyId(user);
    await this.assertConversationAccess(user, conversationId);

    // Conversation must belong to this company (defense in depth).
    const conversation = await this.findConversationForCompany(
      conversationId,
      companyId,
    );
    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }

    const uniqueIds = [
      ...new Set(labelIds.map((id) => Number(id)).filter((id) => id > 0)),
    ];
    const labels = uniqueIds.length
      ? await this.customerLabelRepository
          .createQueryBuilder('label')
          .where('label.id IN (:...uniqueIds)', { uniqueIds })
          .andWhere(
            'CAST(label.company_id AS BIGINT) = CAST(:companyId AS BIGINT)',
            { companyId },
          )
          .getMany()
      : [];
    if (uniqueIds.length && labels.length !== uniqueIds.length) {
      throw new BadRequestException(
        'One or more labels are invalid for this company.',
      );
    }

    // Only clear this company's label assignments on the conversation.
    const companyLabelIds = await this.customerLabelRepository
      .createQueryBuilder('label')
      .select('label.id', 'id')
      .where('CAST(label.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId,
      })
      .getRawMany<{ id: string | number }>();
    const scopedLabelIds = companyLabelIds
      .map((row) => Number(row.id))
      .filter((id) => Number.isFinite(id) && id > 0);
    if (scopedLabelIds.length > 0) {
      await this.conversationLabelRepository
        .createQueryBuilder()
        .delete()
        .from(BotConversationLabel)
        .where('conversation_id = :conversationId', { conversationId })
        .andWhere('label_id IN (:...scopedLabelIds)', { scopedLabelIds })
        .execute();
    }

    if (labels.length) {
      await this.conversationLabelRepository.save(
        labels.map((label) =>
          this.conversationLabelRepository.create({
            conversation_id: Number(conversationId),
            label_id: Number(label.id),
          }),
        ),
      );
    }
    return {
      conversation_id: conversationId,
      labels: labels.map((label) => ({
        id: Number(label.id),
        name: label.name,
        color_code: label.color_code,
      })),
    };
  }

  private mapCustomerNote(note: BotCustomerNote) {
    const channelUser = note.channelUser;
    return {
      id: Number(note.id),
      company_id: Number(note.company_id),
      bot_channel_user_id: Number(note.bot_channel_user_id),
      content: note.content,
      created_by_user_id:
        note.created_by_user_id == null ? null : Number(note.created_by_user_id),
      created_by_name: note.created_by_name,
      sent_at: note.sent_at ? new Date(note.sent_at).toISOString() : null,
      checked_by_admin: Boolean(note.checked_by_admin),
      checked_at: note.checked_at ? new Date(note.checked_at).toISOString() : null,
      checked_by_user_id:
        note.checked_by_user_id == null ? null : Number(note.checked_by_user_id),
      created_at: note.created_at
        ? new Date(note.created_at).toISOString()
        : null,
      channelUser: channelUser
        ? {
            id: Number(channelUser.id),
            display_name: channelUser.display_name,
            external_user_id: channelUser.external_user_id,
            platform: channelUser.platform,
          }
        : null,
    };
  }

  /** Admin: any company client. Agent: only currently assigned clients. */
  private async assertChannelUserNoteAccess(
    user: AuthenticatedUser,
    channelUserId: number,
  ) {
    const companyId = this.requireUserCompanyId(user);
    const company = await this.getCompanyForUser(user);
    if (!company || Number(company.id) !== companyId) {
      throw new ForbiddenException('Company not found.');
    }
    const isAdmin = Number(company.admin_user_id) === Number(user.id);

    const channelUser = await this.channelUserRepository
      .createQueryBuilder('channelUser')
      .where('channelUser.id = :channelUserId', { channelUserId })
      .andWhere(
        'CAST(channelUser.company_id AS BIGINT) = CAST(:companyId AS BIGINT)',
        { companyId },
      )
      .getOne();

    if (!channelUser) {
      throw new NotFoundException('Client not found.');
    }

    if (!isAdmin) {
      const assigned = await this.conversationRepository
        .createQueryBuilder('c')
        .where('c.bot_channel_user_id = :channelUserId', { channelUserId })
        .andWhere(
          'CAST(c.assigned_agent_id AS BIGINT) = CAST(:agentId AS BIGINT)',
          { agentId: Number(user.id) },
        )
        .andWhere('LOWER(c.status) IN (:...statuses)', {
          statuses: ['pending', 'active'],
        })
        .getOne();
      if (!assigned) {
        throw new ForbiddenException(
          'You can only manage notes for clients currently assigned to you.',
        );
      }
    }

    return { companyId, isAdmin, channelUser };
  }

  private async listNotesForChannelUser(
    companyId: number,
    channelUserId: number,
  ) {
    if (!channelUserId) return [];
    const rows = await this.customerNoteRepository
      .createQueryBuilder('note')
      .leftJoinAndSelect('note.channelUser', 'channelUser')
      .where('CAST(note.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId,
      })
      .andWhere('note.bot_channel_user_id = :channelUserId', { channelUserId })
      .orderBy('note.created_at', 'DESC')
      .addOrderBy('note.id', 'DESC')
      .getMany();
    return rows.map((row) => this.mapCustomerNote(row));
  }

  async listCustomerNotes(user: AuthenticatedUser) {
    const companyId = this.requireUserCompanyId(user);
    const company = await this.getCompanyForUser(user);
    if (!company || Number(company.id) !== companyId) {
      throw new ForbiddenException('Company not found.');
    }
    const isAdmin = Number(company.admin_user_id) === Number(user.id);

    const qb = this.customerNoteRepository
      .createQueryBuilder('note')
      .leftJoinAndSelect('note.channelUser', 'channelUser')
      .where('CAST(note.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId,
      });

    if (!isAdmin) {
      const assignedConversations = await this.conversationRepository
        .createQueryBuilder('c')
        .innerJoin('c.channelUser', 'channelUser')
        .where(
          'CAST(c.assigned_agent_id AS BIGINT) = CAST(:agentId AS BIGINT)',
          { agentId: Number(user.id) },
        )
        .andWhere(
          'CAST(channelUser.company_id AS BIGINT) = CAST(:companyId AS BIGINT)',
          { companyId },
        )
        .andWhere('LOWER(c.status) IN (:...statuses)', {
          statuses: ['pending', 'active'],
        })
        .getMany();

      const channelUserIds = [
        ...new Set(
          assignedConversations
            .map((row) => Number(row.bot_channel_user_id))
            .filter((id) => Number.isFinite(id) && id > 0),
        ),
      ];
      if (channelUserIds.length === 0) {
        return [];
      }
      qb.andWhere('note.bot_channel_user_id IN (:...channelUserIds)', {
        channelUserIds,
      });
    }

    const rows = await qb
      .orderBy('note.created_at', 'DESC')
      .addOrderBy('note.id', 'DESC')
      .take(200)
      .getMany();

    return rows.map((row) => this.mapCustomerNote(row));
  }

  async listChannelUserNotes(user: AuthenticatedUser, channelUserId: number) {
    await this.assertChannelUserNoteAccess(user, channelUserId);
    return this.listNotesForChannelUser(
      this.requireUserCompanyId(user),
      channelUserId,
    );
  }

  async createCustomerNote(
    user: AuthenticatedUser,
    channelUserId: number,
    content: string,
  ) {
    const { companyId, channelUser } = await this.assertChannelUserNoteAccess(
      user,
      channelUserId,
    );
    const trimmed = content.trim();
    if (!trimmed) {
      throw new BadRequestException('Note content is required.');
    }

    const author = await this.userRepository.findOne({ where: { id: user.id } });
    const note = await this.customerNoteRepository.save(
      this.customerNoteRepository.create({
        company_id: companyId,
        bot_channel_user_id: channelUser.id,
        content: trimmed,
        created_by_user_id: Number(user.id),
        created_by_name: author?.name?.trim() || author?.email || 'User',
        sent_at: null,
        checked_by_admin: false,
        checked_at: null,
        checked_by_user_id: null,
      }),
    );
    note.channelUser = channelUser;
    return this.mapCustomerNote(note);
  }

  async deleteCustomerNote(user: AuthenticatedUser, noteId: number) {
    const companyId = this.requireUserCompanyId(user);
    const note = await this.customerNoteRepository
      .createQueryBuilder('note')
      .leftJoinAndSelect('note.channelUser', 'channelUser')
      .where('note.id = :noteId', { noteId })
      .andWhere('CAST(note.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId,
      })
      .getOne();
    if (!note) {
      throw new NotFoundException('Note not found.');
    }
    await this.assertChannelUserNoteAccess(user, Number(note.bot_channel_user_id));
    await this.customerNoteRepository.remove(note);
    return { id: noteId, removed: true };
  }


  async setCustomerNoteChecked(
    user: AuthenticatedUser,
    noteId: number,
    checked: boolean,
  ) {
    await this.assertAdminAccess(user);
    const companyId = this.requireUserCompanyId(user);
    const note = await this.customerNoteRepository
      .createQueryBuilder('note')
      .leftJoinAndSelect('note.channelUser', 'channelUser')
      .where('note.id = :noteId', { noteId })
      .andWhere('note.company_id = :companyId', { companyId })
      .getOne();

    if (!note) {
      throw new NotFoundException('Note not found.');
    }

    note.checked_by_admin = checked;
    note.checked_at = checked ? new Date() : null;
    note.checked_by_user_id = checked ? Number(user.id) : null;
    const saved = await this.customerNoteRepository.save(note);
    return this.mapCustomerNote(saved);
  }

  async sendCustomerNote(user: AuthenticatedUser, noteId: number) {
    const companyId = this.requireUserCompanyId(user);
    const note = await this.customerNoteRepository
      .createQueryBuilder('note')
      .leftJoinAndSelect('note.channelUser', 'channelUser')
      .where('note.id = :noteId', { noteId })
      .andWhere('CAST(note.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId,
      })
      .getOne();
    if (!note) {
      throw new NotFoundException('Note not found.');
    }

    const { channelUser, isAdmin } = await this.assertChannelUserNoteAccess(
      user,
      Number(note.bot_channel_user_id),
    );

    const phone = this.normalizePhoneKey(channelUser.external_user_id);
    if (!phone) {
      throw new BadRequestException('Invalid customer phone for this client.');
    }

    const text = note.content.trim();
    if (!text) {
      throw new BadRequestException('Note content is empty.');
    }

    await this.sendCompanyWhatsappText(companyId, phone, text);

    note.sent_at = new Date();
    const saved = await this.customerNoteRepository.save(note);
    saved.channelUser = channelUser;

    // Also store as outbound chat message when a conversation exists.
    const conversation = await this.conversationRepository
      .createQueryBuilder('c')
      .where('c.bot_channel_user_id = :channelUserId', {
        channelUserId: channelUser.id,
      })
      .orderBy('c.id', 'DESC')
      .getOne();

    if (conversation) {
      await this.messageRepository.save(
        this.messageRepository.create({
          conversation_id: conversation.id,
          direction: 'outbound',
          message_type: 'text',
          platform: channelUser.platform || 'whatsapp',
          content: text,
          source: isAdmin ? 'admin' : 'agent',
        }),
      );
      conversation.last_message_at = new Date();
      await this.conversationRepository.save(conversation);
    }

    return {
      note: this.mapCustomerNote(saved),
      message: 'Note sent to client on WhatsApp.',
    };
  }
}
