import {
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
import { BotFlagsQueryDto } from './dto/bot-flags-query.dto';
import { BotUsersQueryDto } from './dto/bot-users-query.dto';
import { ToggleBotUserDto } from './dto/toggle-bot-user.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UpdateStatusTemplateDto } from './dto/update-status-template.dto';
import { CreateBotOrderDto } from './dto/create-bot-order.dto';
import { BotChannelUser } from './entities/bot-channel-user.entity';
import { BotConversation } from './entities/bot-conversation.entity';
import { BotFlag } from './entities/bot-flag.entity';
import { BotMessage } from './entities/bot-message.entity';
import { BotOrderStatusHistory } from './entities/bot-order-status-history.entity';
import { BotOrderStatusTemplate } from './entities/bot-order-status-template.entity';
import { BotOrder, type BotOrderStatus } from './entities/bot-order.entity';
import { BotOrderItem } from './entities/bot-order-item.entity';
import { BotTrainingData } from './entities/bot-training-data.entity';
import { SupabaseCustomer } from '../supabase/entities/supabase-customer.entity';
import { WhatsappChannel } from '../whatsapp/entities/whatsapp-channel.entity';

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
    @InjectRepository(BotFlag)
    private readonly flagRepository: Repository<BotFlag>,
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

    const [totalUsers, activeBots, totalConversations, pendingAlerts] = await Promise.all([
      this.channelUserRepository.count({ where: { company_id } }),
      this.channelUserRepository.count({ where: { company_id, bot_enabled: true } }),
      this.conversationRepository
        .createQueryBuilder('conversation')
        .leftJoin('conversation.channelUser', 'channelUser')
        .where('channelUser.company_id = :company_id', { company_id })
        .getCount(),
      this.flagRepository
        .createQueryBuilder('flag')
        .leftJoin('flag.channelUser', 'channelUser')
        .where('channelUser.company_id = :company_id', { company_id })
        .andWhere('flag.resolved = false')
        .getCount(),
    ]);

    return {
      totalUsers,
      activeBots,
      totalConversations,
      pendingAlerts,
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

  private normalizePhoneKey(phone: string): string {
    return phone.replace(/\D/g, '');
  }

  async getUsers(user: AuthenticatedUser, query: BotUsersQueryDto) {
    await this.assertAdminAccess(user);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    const builder = this.channelUserRepository
      .createQueryBuilder('channel_user')
      .leftJoinAndSelect('channel_user.conversations', 'conversation')
      .orderBy('channel_user.last_seen_at', 'DESC')
      .addOrderBy('channel_user.id', 'DESC')
      .skip(offset)
      .take(limit);

    builder.where('channel_user.company_id = :companyId', { companyId: user.company_id });

    const [items, total] = await builder.getManyAndCount();

    return {
      items: items.map((item) => ({
        id: item.id,
        platform: item.platform,
        external_user_id: item.external_user_id,
        display_name: item.display_name,
        language: item.language,
        bot_enabled: item.bot_enabled,
        manual_mode: item.manual_mode,
        last_seen_at: item.last_seen_at,
        latest_conversation_id:
          [...(item.conversations ?? [])]
            .sort((left, right) => {
              const leftTime = left.last_message_at ? new Date(left.last_message_at).getTime() : 0;
              const rightTime = right.last_message_at ? new Date(right.last_message_at).getTime() : 0;
              return rightTime - leftTime;
            })[0]?.id ?? null,
      })),
      pagination: {
        page,
        limit,
        total,
      },
    };
  }

  async toggleUser(
    user: AuthenticatedUser,
    id: number,
    payload: ToggleBotUserDto,
  ) {
    await this.assertAdminAccess(user);
    const where: any = { id, company_id: user.company_id };

    const channelUser = await this.channelUserRepository.findOne({
      where,
    });

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

  async getFlags(user: AuthenticatedUser, query: BotFlagsQueryDto) {
    await this.assertAdminAccess(user);
    const unresolvedOnly = query.unresolved !== 'false';

    const builder = this.flagRepository
      .createQueryBuilder('flag')
      .leftJoinAndSelect('flag.channelUser', 'channel_user')
      .leftJoinAndSelect('flag.conversation', 'conversation')
      .orderBy('flag.created_at', 'DESC');

    builder.where('channel_user.company_id = :companyId', { companyId: user.company_id });

    if (unresolvedOnly) {
      builder.andWhere('flag.resolved = false');
    }

    return builder.getMany();
  }

  async getConversations(user: AuthenticatedUser) {
    await this.assertAdminAccess(user);
    const companyId = user.company_id;

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

    const channelUserByPhone = new Map<string, BotChannelUser>();
    for (const channelUser of channelUsers) {
      const phoneKey = this.normalizePhoneKey(channelUser.external_user_id);
      if (!phoneKey) {
        continue;
      }
      const existing = channelUserByPhone.get(phoneKey);
      if (!existing) {
        channelUserByPhone.set(phoneKey, channelUser);
        continue;
      }
      const existingSeen = existing.last_seen_at
        ? new Date(existing.last_seen_at).getTime()
        : 0;
      const nextSeen = channelUser.last_seen_at
        ? new Date(channelUser.last_seen_at).getTime()
        : 0;
      if (nextSeen >= existingSeen) {
        channelUserByPhone.set(phoneKey, channelUser);
      }
    }

    return customers.map((customer) => {
      const phoneKey = this.normalizePhoneKey(customer.customer_phone);
      const channelUser = phoneKey ? channelUserByPhone.get(phoneKey) : undefined;
      const latestConversation = channelUser
        ? [...(channelUser.conversations ?? [])].sort((left, right) => {
            const leftTime = left.last_message_at
              ? new Date(left.last_message_at).getTime()
              : 0;
            const rightTime = right.last_message_at
              ? new Date(right.last_message_at).getTime()
              : 0;
            return rightTime - leftTime;
          })[0]
        : undefined;

      return {
        customer: {
          id: customer.id,
          customer_phone: customer.customer_phone,
          assigned_instance: customer.assigned_instance,
          first_seen_at: customer.first_seen_at,
          last_seen_at: customer.last_seen_at,
        },
        channelUser: channelUser
          ? {
              id: channelUser.id,
              platform: channelUser.platform,
              external_user_id: channelUser.external_user_id,
              display_name: channelUser.display_name,
              language: channelUser.language,
              bot_enabled: channelUser.bot_enabled,
              manual_mode: channelUser.manual_mode,
              last_seen_at: channelUser.last_seen_at,
            }
          : null,
        conversation: latestConversation
          ? {
              id: latestConversation.id,
              status: latestConversation.status,
              last_message_at: latestConversation.last_message_at,
            }
          : null,
      };
    });
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

    return {
      conversation,
      messages,
    };
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
