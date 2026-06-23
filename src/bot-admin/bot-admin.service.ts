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
import { BotUsersQueryDto } from './dto/bot-users-query.dto';
import { ToggleBotUserDto } from './dto/toggle-bot-user.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UpdateStatusTemplateDto } from './dto/update-status-template.dto';
import { CreateBotOrderDto } from './dto/create-bot-order.dto';
import { BotChannelUser } from './entities/bot-channel-user.entity';
import { BotConversation } from './entities/bot-conversation.entity';
import { BotMessage } from './entities/bot-message.entity';
import { BotOrderStatusHistory } from './entities/bot-order-status-history.entity';
import { BotOrderStatusTemplate } from './entities/bot-order-status-template.entity';
import { BotOrder, type BotOrderStatus } from './entities/bot-order.entity';
import { BotOrderItem } from './entities/bot-order-item.entity';
import { BotTrainingData } from './entities/bot-training-data.entity';
import { SupabaseCustomer } from '../supabase/entities/supabase-customer.entity';
import { WhatsappChannel } from '../whatsapp/entities/whatsapp-channel.entity';
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
    last_message_at: Date | string | null;
  } | null;
  evolution_remote_jid: string | null;
  last_message_preview: string | null;
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
    @InjectRepository(BotMessage)
    private readonly messageRepository: Repository<BotMessage>,
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
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly evolutionService: EvolutionService,
    private readonly pusherService: PusherService,
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
    return this.whatsappChannelRepository.findOne({
      where: { company_id: companyId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      order: { id: 'ASC' as any },
    });
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

  private async assertAdminAccess(user: AuthenticatedUser) {
    const company = await this.getCompanyForUser(user);
    if (!company || Number(company.admin_user_id) !== Number(user.id)) {
      throw new ForbiddenException('Only the company admin can manage bot settings.');
    }
  }

  /** Admin OR agent assigned to a conversation can access it */
  private async assertConversationAccess(
    user: AuthenticatedUser,
    conversationId: number,
  ) {
    const company = await this.getCompanyForUser(user);
    if (!company) throw new ForbiddenException('Company not found.');
    // Admin always has access
    if (Number(company.admin_user_id) === Number(user.id)) return;
    // Non-admin can only access their assigned conversation
    const conv = await this.conversationRepository.findOne({
      where: { id: conversationId },
    });
    if (!conv || Number(conv.assigned_agent_id) !== Number(user.id)) {
      throw new ForbiddenException('You do not have access to this conversation.');
    }
  }

  /** Toggle the logged-in user's own is_active status (online/offline for agents) */
  async toggleOwnStatus(user: AuthenticatedUser) {
    const u = await this.userRepository.findOne({ where: { id: user.id } });
    if (!u) throw new NotFoundException('User not found.');
    u.is_active = !u.is_active;
    const saved = await this.userRepository.save(u);
    // Broadcast to company channel
    this.pusherService.trigger(
      `company-${user.company_id}`,
      'agent_status_changed',
      { agent_id: saved.id, is_active: saved.is_active },
    );
    return { id: saved.id, is_active: saved.is_active };
  }

  /** Agent accepts a pending conversation (status: pending → active) */
  async acceptConversation(user: AuthenticatedUser, conversationId: number) {
    const conv = await this.conversationRepository.findOne({
      where: { id: conversationId, assigned_agent_id: user.id },
    });
    if (!conv) throw new NotFoundException('Conversation not found or not assigned to you.');
    if (conv.status !== 'pending') {
      throw new BadRequestException('Conversation is not in pending state.');
    }
    conv.status = 'active';
    const saved = await this.conversationRepository.save(conv);
    this.pusherService.trigger(
      `company-${user.company_id}`,
      'conversation_updated',
      { conversation_id: saved.id, status: saved.status, agent_id: user.id },
    );
    return { id: saved.id, status: saved.status };
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
    if (sa.length >= 9 && sb.length >= 9) {
      return sa.endsWith(sb) || sb.endsWith(sa);
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

  private needsEvolutionImageEnrichment(message: EvolutionInboxMessage): boolean {
    if (message.message_type !== 'image') {
      return false;
    }
    const mediaUrl = String(message.media_url ?? '').trim();
    if (!mediaUrl) {
      return true;
    }
    if (mediaUrl.startsWith('data:image/')) {
      return false;
    }
    return isWhatsAppHostedMediaUrl(mediaUrl) || !isBrowserDisplayableImageUrl(mediaUrl);
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
    return `data:${mimetype || 'image/jpeg'};base64,${cleaned}`;
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

    const byId = new Map<string, EvolutionInboxMessage>();
    for (const relatedJid of relatedJids) {
      try {
        const batch = await this.evolutionService.findMessages(
          instance,
          relatedJid,
          apikey,
        );
        for (const message of batch) {
          if (!byId.has(message.id)) {
            byId.set(message.id, message);
          }
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
    };
  }

  private async loadEvolutionMessagesForPhone(companyId: number, phone: string) {
    const normalized = this.normalizePhoneKey(phone);
    if (!normalized) {
      return [];
    }

    const channel = await this.resolveCompanyWhatsappChannel(companyId);
    const instance = channel?.instance_name?.trim();
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

      const existingIndex = merged.findIndex((item) => this.rowMatchesPhone(item, phone));

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

    const companyUsers = await this.channelUserRepository.find({
      where: { company_id: companyId, platform: 'whatsapp' },
    });
    const matched = this.findChannelUserForPhone(companyUsers, normalizedPhone);
    if (matched) {
      return matched;
    }

    const existing = await this.channelUserRepository.findOne({
      where: { platform: 'whatsapp', external_user_id: normalizedPhone },
    });
    if (existing) {
      if (existing.company_id !== companyId) {
        existing.company_id = companyId;
      }
      if (displayName?.trim() && !existing.display_name?.trim()) {
        existing.display_name = displayName.trim();
      }
      existing.last_seen_at = existing.last_seen_at ?? new Date();
      return this.channelUserRepository.save(existing);
    }

    return this.channelUserRepository.save(
      this.channelUserRepository.create({
        company_id: companyId,
        platform: 'whatsapp',
        external_user_id: normalizedPhone,
        display_name: displayName?.trim() || normalizedPhone,
        bot_enabled: true,
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
    await this.assertAdminAccess(user);
    let channelUser: BotChannelUser | null = null;

    if (id > 0) {
      channelUser = await this.channelUserRepository.findOne({
        where: { id, company_id: user.company_id },
      });
    }

    if (!channelUser && payload.external_user_id?.trim()) {
      channelUser = await this.ensureChannelUserForContact(
        user.company_id,
        payload.external_user_id,
      );
    }

    if (!channelUser) {
      throw new NotFoundException('Bot user not found.');
    }

    channelUser.bot_enabled = !channelUser.bot_enabled;
    channelUser.manual_mode =
      channelUser.bot_enabled === false
        ? payload.manual_mode ?? true
        : false;

    const saved = await this.channelUserRepository.save(channelUser);
    return {
      id: saved.id,
      bot_enabled: saved.bot_enabled,
      manual_mode: saved.manual_mode,
    };
  }

  async getConversations(user: AuthenticatedUser) {
    await this.assertAdminAccess(user);
    return this.buildCompanyContactRows(user.company_id);
  }

  /** Returns conversations assigned to this agent, with latest message info */
  async getAgentConversations(user: AuthenticatedUser) {
    const conversations = await this.conversationRepository.find({
      where: {
        assigned_agent_id: user.id,
        status: 'pending' as any,
      },
      relations: ['channelUser'],
      order: { last_message_at: 'DESC' },
    });

    // Also include active conversations assigned to this agent
    const activeConversations = await this.conversationRepository.find({
      where: {
        assigned_agent_id: user.id,
        status: 'active' as any,
      },
      relations: ['channelUser'],
      order: { last_message_at: 'DESC' },
    });

    const all = [...conversations, ...activeConversations].sort(
      (a, b) =>
        new Date(b.last_message_at ?? 0).getTime() -
        new Date(a.last_message_at ?? 0).getTime(),
    );

    return all.map((conv) => ({
      id: conv.id,
      status: conv.status,
      assigned_agent_id: conv.assigned_agent_id,
      assigned_at: conv.assigned_at,
      last_message_at: conv.last_message_at,
      channelUser: conv.channelUser
        ? {
            id: conv.channelUser.id,
            display_name: conv.channelUser.display_name,
            external_user_id: conv.channelUser.external_user_id,
            platform: conv.channelUser.platform,
          }
        : null,
    }));
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
        channelUsers,
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
          this.phoneKeysEquivalent(
            row.customer.customer_phone,
            channelUser.external_user_id,
          ),
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
    const instance = channel?.instance_name?.trim();
    if (!instance) {
      return rows;
    }

    const apikey = (channel?.evaluation_whatsapp_key ?? this.getEvolutionConfig().secureKey)?.trim();
    if (!apikey) {
      return rows;
    }

    try {
      const chats = await this.evolutionService.findChats(instance, apikey);

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
          continue;
        }

        const matchedChannelUser = this.findChannelUserForPhone(channelUsers, phone);
        rows.push({
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
    } catch (error) {
      console.error('Evolution findChats failed:', error);
    }

    return this.dedupeConversationRows(rows);
  }

  async getEvolutionInboxMessages(
    user: AuthenticatedUser,
    remoteJid: string,
  ) {
    await this.assertAdminAccess(user);
    const jid = remoteJid.trim();
    if (!jid) {
      throw new BadRequestException('remoteJid is required.');
    }

    const channel = await this.resolveCompanyWhatsappChannel(user.company_id);
    const instance = channel?.instance_name?.trim();
    if (!instance) {
      throw new BadRequestException('WhatsApp instance is not configured.');
    }

    const apikey = (channel?.evaluation_whatsapp_key ?? this.getEvolutionConfig().secureKey)?.trim();
    if (!apikey) {
      throw new BadRequestException('WhatsApp instance API key is missing.');
    }

    const { remoteJid: resolvedJid, phone, messages } =
      await this.fetchEvolutionMessagesForJid(
        user.company_id,
        jid,
        instance,
        apikey,
      );

    const resolvedPhone =
      phone || this.normalizePhoneKey(resolvedJid.split('@')[0] ?? resolvedJid);
    const dbMessages = resolvedPhone
      ? await this.findDbMessagesForPhone(user.company_id, resolvedPhone)
      : [];

    return {
      remote_jid: resolvedJid,
      messages: this.mergeConversationThreadMessages(dbMessages, messages),
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

    const evolution = this.getEvolutionConfig();
    if (!evolution.enabled) {
      throw new BadRequestException(
        'Evolution API is not configured for sending WhatsApp messages.',
      );
    }

    const channel = await this.resolveCompanyWhatsappChannel(user.company_id);
    const instance = channel?.instance_name?.trim();
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

  async getConversation(user: AuthenticatedUser, id: number) {
    await this.assertAdminAccess(user);
    const where: any = { id, channelUser: { company_id: user.company_id } };

    const conversation = await this.conversationRepository.findOne({
      where,
      relations: ['channelUser'],
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }

    const messages = await this.messageRepository.find({
      where: { conversation_id: id },
      order: { id: 'ASC' },
    });

    const phone = this.normalizePhoneKey(conversation.channelUser?.external_user_id ?? '');
    const channel = await this.resolveCompanyWhatsappChannel(user.company_id);
    const instance = channel?.instance_name?.trim();
    const apikey = (channel?.evaluation_whatsapp_key ?? this.getEvolutionConfig().secureKey)?.trim();
    const fetchedEvolution =
      phone && instance && apikey
        ? (
            await this.fetchEvolutionMessagesForJid(
              user.company_id,
              `${phone}@s.whatsapp.net`,
              instance,
              apikey,
            )
          ).messages
        : [];

    return {
      conversation,
      messages: this.mergeConversationThreadMessages(messages, fetchedEvolution),
    };
  }

  async sendConversationMessage(
    user: AuthenticatedUser,
    conversationId: number,
    text: string,
  ) {
    await this.assertAdminAccess(user);
    const trimmed = text.trim();
    if (!trimmed) {
      throw new BadRequestException('Message text is required.');
    }

    const conversation = await this.conversationRepository.findOne({
      where: {
        id: conversationId,
        channelUser: { company_id: user.company_id },
      },
      relations: ['channelUser'],
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }

    const channelUser = conversation.channelUser;
    if (!channelUser) {
      throw new BadRequestException('Conversation has no linked channel user.');
    }

    const phone = this.normalizePhoneKey(channelUser.external_user_id);
    if (!phone) {
      throw new BadRequestException('Invalid customer phone on this conversation.');
    }

    const evolution = this.getEvolutionConfig();
    if (!evolution.enabled) {
      throw new BadRequestException(
        'Evolution API is not configured for sending WhatsApp messages.',
      );
    }

    const channel = await this.resolveCompanyWhatsappChannel(user.company_id);
    const instance = channel?.instance_name?.trim();
    const apikey = (channel?.evaluation_whatsapp_key ?? evolution.secureKey)?.trim();

    if (!instance || !apikey) {
      throw new BadRequestException(
        'WhatsApp instance is not configured for this company.',
      );
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
        let message = body || 'Failed to send WhatsApp message via Evolution.';
        try {
          const parsed = JSON.parse(body) as { message?: string; error?: string };
          message = parsed.message ?? parsed.error ?? message;
        } catch {
          // keep raw body
        }
        throw new BadRequestException(message);
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to send WhatsApp message via Evolution.');
    }

    const message = this.messageRepository.create({
      conversation_id: conversationId,
      direction: 'outbound',
      message_type: 'text',
      platform: channelUser.platform || 'whatsapp',
      content: trimmed,
      source: 'admin',
    });
    const saved = await this.messageRepository.save(message);

    conversation.last_message_at = new Date();
    await this.conversationRepository.save(conversation);

    return { message: saved };
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

  async createOrder(user: AuthenticatedUser, payload: CreateBotOrderDto) {
    await this.assertAdminAccess(user);

    // Verify channel user exists and belongs to this company
    const channelUser = await this.channelUserRepository.findOne({
      where: { id: payload.bot_channel_user_id, company_id: user.company_id },
    });

    if (!channelUser) {
      throw new NotFoundException('Channel user not found.');
    }

    // Create order
    const order = this.orderRepository.create({
      company_id: user.company_id,
      bot_channel_user_id: payload.bot_channel_user_id,
      customer_name: payload.customer_name,
      customer_phone: payload.customer_phone,
      address: payload.address || null,
      status: 'Pending',
      total_amount: 0,
    });

    const savedOrder = await this.orderRepository.save(order);

    // Create order items and calculate total
    let totalAmount = 0;
    const items: BotOrderItem[] = [];

    for (const itemPayload of payload.items) {
      const totalPrice = itemPayload.quantity * itemPayload.unit_price;
      totalAmount += totalPrice;

      const item = this.orderItemRepository.create({
        order_id: savedOrder.id,
        product_name: itemPayload.product_name,
        variant_text: itemPayload.variant_text || null,
        quantity: itemPayload.quantity,
        unit_price: itemPayload.unit_price,
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

    const evolution = this.getEvolutionConfig();
    if (evolution.enabled) {
      const channel = await this.resolveCompanyWhatsappChannel(companyId);
      const instance = channel?.instance_name?.trim();
      const apikey = (channel?.evaluation_whatsapp_key ?? evolution.secureKey)?.trim();

      if (!instance || !apikey) {
        return false;
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

    const phoneNumberId = this.getEnvValue('WHATSAPP_PHONE_NUMBER_ID');
    const accessToken = this.getEnvValue('WHATSAPP_ACCESS_TOKEN');
    if (!phoneNumberId || !accessToken) {
      return false;
    }

    // Check if the message contains a PDF link
    const pdfMatch = message.match(/https?:\/\/[^\s<>"]+\.pdf/i);
    const hasPdf = !!pdfMatch;
    const pdfUrl = hasPdf ? pdfMatch[0] : null;

    try {
      let payload: any;
      if (hasPdf && pdfUrl) {
        // Send as document if PDF found
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
        // Fallback to text
        payload = {
          messaging_product: 'whatsapp',
          to: cleanedPhone,
          type: 'text',
          text: { body: message },
        };
      }

      const response = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      return response.ok;
    } catch (error) {
      console.error('Failed to send order status WhatsApp message:', error);
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
}
