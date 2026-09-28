import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentRoutingService } from '../agent-routing/agent-routing.service';
import { readChatMedia, isChatMediaKey } from '../bot-admin/chat-media.store';
import { BotChannelUser } from '../bot-admin/entities/bot-channel-user.entity';
import { BotConversation } from '../bot-admin/entities/bot-conversation.entity';
import { BotCustomerNote } from '../bot-admin/entities/bot-customer-note.entity';
import { BotMessage } from '../bot-admin/entities/bot-message.entity';
import { BotOrderItem } from '../bot-admin/entities/bot-order-item.entity';
import { BotOrderStatusHistory } from '../bot-admin/entities/bot-order-status-history.entity';
import { BotOrder } from '../bot-admin/entities/bot-order.entity';
import { PusherService } from '../common/pusher.service';
import { SalesBotHook, type SalesBotInboundEvent } from '../common/sales-bot-hook';
import { Company } from '../company/entities/company.entity';
import { WhatsappProviderFactory } from '../integrations/whatsapp/whatsapp-provider.factory';
import { WhatsappService } from '../integrations/whatsapp/whatsapp.service';
import { Product } from '../products/entities/product.entity';
import type { WhatsappChannel } from '../whatsapp/entities/whatsapp-channel.entity';
import { BotAiUsage } from './entities/bot-ai-usage.entity';
import { BotBooking } from './entities/bot-booking.entity';
import { BotDeliveryZone } from './entities/bot-delivery-zone.entity';
import { BotService } from './entities/bot-service.entity';
import { SalesBotClient, type SalesBotOrder, type SalesBotResult, type SalesBotTurn } from './sales-bot.client';
import { SalesBotContextService, optionWeight, productImages, productOptions, productWeight, variantLabel, variantPrice } from './sales-bot-context.service';
import { findZone, hasWeightRule, zoneFee } from './delivery-fee';

type PricedItem = {
  product_id: number; variant_id: number | null; product_name: string; variant_name: string;
  quantity: number; unit_price: number; total_price: number;
  /** kg per unit (variant weight, else product weight; 0 when not set) */
  weight_kg: number;
};
type PendingOrder = {
  items: PricedItem[]; subtotal: number; delivery_area: string | null; total_weight_kg: number;
  delivery_fee: number | null; total: number;
  customer_name: string; customer_phone: string; address: string; payment_method: string; summary_shown: boolean;
};
type BotSession = { language?: string; pending_order?: PendingOrder | null };
/** intent is stored on the bot message, e.g. "lead,handoff" (one reply can do several things). */
type Outcome = { intent: string | null; replyOverride: string | null };

export const BOT_SOURCE = 'sales_bot';
const PLACEHOLDER = /^\[[^\]]*\]$/;
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

/** Sent instead of the AI text when a confirmed order needs a human check. */
function holdMessage(language: string): string {
  if (language === 'sinhala') return 'පොඩ්ඩක් ඉන්න, අපේ team එක ඔයාගේ order එක check කරලා ඉක්මනින්ම confirm කරනවා.';
  if (language === 'tamil') return 'கொஞ்சம் பொறுங்கள், எங்கள் குழு உங்கள் ஆர்டரை சரிபார்த்து விரைவில் உறுதிப்படுத்தும்.';
  if (language === 'sinhala_latin') return 'Poddak inna, ape team eka oyage order eka check karala ikmanatama confirm karanawa.';
  return 'One moment please, our team is checking your order and will confirm it shortly.';
}

/** Sent when the bot itself failed, so the customer is never left without an answer. */
function sorryMessage(language: string): string {
  if (language === 'sinhala') return 'සමාවෙන්න, අපේ team එකේ කෙනෙක් ඉක්මනින්ම ඔයාට reply කරනවා.';
  if (language === 'tamil') return 'மன்னிக்கவும், எங்கள் குழுவில் ஒருவர் விரைவில் பதிலளிப்பார்.';
  if (language === 'sinhala_latin') return 'Samawenna, ape team eke kenek ikmanatama reply karanawa.';
  return 'Sorry, one of our team will reply to you shortly.';
}

export function planAllowsBot(company: Pick<Company, 'plan'> | null | undefined): boolean {
  const plan = String(company?.plan ?? '').trim().toLowerCase();
  return plan === 'free' || plan.startsWith('free ');
}

/**
 * The sales bot for WhatsApp:
 *  inbound message → wait a few seconds (combine quick messages) → Python bot → send reply
 *  → save orders (re-priced from the products table), bookings, leads, or hand the chat to a person.
 */
@Injectable()
export class SalesBotEngineService implements OnModuleInit {
  private readonly logger = new Logger(SalesBotEngineService.name);
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly running = new Set<number>();
  /** Conversations from the Customer simulator: never send to WhatsApp. */
  private readonly simulated = new Set<number>();

  constructor(
    @InjectRepository(Company) private readonly companyRepository: Repository<Company>,
    @InjectRepository(BotConversation) private readonly conversationRepository: Repository<BotConversation>,
    @InjectRepository(BotChannelUser) private readonly channelUserRepository: Repository<BotChannelUser>,
    @InjectRepository(BotMessage) private readonly messageRepository: Repository<BotMessage>,
    @InjectRepository(BotOrder) private readonly orderRepository: Repository<BotOrder>,
    @InjectRepository(BotOrderItem) private readonly orderItemRepository: Repository<BotOrderItem>,
    @InjectRepository(BotOrderStatusHistory) private readonly orderHistoryRepository: Repository<BotOrderStatusHistory>,
    @InjectRepository(BotCustomerNote) private readonly noteRepository: Repository<BotCustomerNote>,
    @InjectRepository(Product) private readonly productRepository: Repository<Product>,
    @InjectRepository(BotService) private readonly serviceRepository: Repository<BotService>,
    @InjectRepository(BotDeliveryZone) private readonly zoneRepository: Repository<BotDeliveryZone>,
    @InjectRepository(BotBooking) private readonly bookingRepository: Repository<BotBooking>,
    @InjectRepository(BotAiUsage) private readonly usageRepository: Repository<BotAiUsage>,
    private readonly contextService: SalesBotContextService,
    private readonly client: SalesBotClient,
    private readonly agentRoutingService: AgentRoutingService,
    private readonly whatsappService: WhatsappService,
    private readonly providerFactory: WhatsappProviderFactory,
    private readonly pusherService: PusherService,
  ) {}

  onModuleInit() {
    if (!SalesBotClient.isConfigured()) {
      this.logger.log('SALES_BOT_URL not set: the Python sales bot is off (n8n keeps handling bot replies).');
      return;
    }
    SalesBotHook.register((event) => this.onInbound(event));
    this.logger.log(`Python sales bot active at ${SalesBotClient.baseUrl()}`);
  }

  static testMode(): boolean {
    return ['1', 'true', 'yes'].includes(String(process.env.SALES_BOT_TEST_MODE ?? '').trim().toLowerCase());
  }

  /** Called for every saved customer message. Returns true = the sales bot owns the reply. */
  async onInbound(event: SalesBotInboundEvent): Promise<boolean> {
    if (event.provider === 'simulator') this.simulated.add(event.conversationId);
    this.schedule(event.companyId, event.conversationId);
    return true;
  }

  /** Waits a few seconds so "hi" + "price?" + "blue one" get one reply. */
  private schedule(companyId: number, conversationId: number, delayMs = Number(process.env.SALES_BOT_DEBOUNCE_MS ?? 3000) || 3000) {
    clearTimeout(this.timers.get(conversationId));
    this.timers.set(conversationId, setTimeout(() => {
      this.timers.delete(conversationId);
      void this.run(companyId, conversationId);
    }, delayMs));
  }

  private async run(companyId: number, conversationId: number) {
    if (this.running.has(conversationId)) {
      this.schedule(companyId, conversationId, 1500);
      return;
    }
    this.running.add(conversationId);
    try {
      await this.turn(companyId, conversationId);
    } catch (error) {
      this.logger.error(`sales bot turn failed for conversation ${conversationId}: ${error instanceof Error ? error.stack : String(error)}`);
    } finally {
      this.running.delete(conversationId);
    }
  }

  /** Should the bot answer this chat right now? */
  private async botMayReply(company: Company | null, conversation: BotConversation, channelUser: BotChannelUser, simulated: boolean) {
    if (!company || !planAllowsBot(company) || !company.bot_enabled) return false;
    if (conversation.status === 'active' || conversation.status === 'closed') return false; // an agent is handling it
    if (channelUser.bot_enabled) return true;
    // Never toggled by an agent (manual_mode false) → new customer: switch the bot on if the company wants that.
    if (!channelUser.manual_mode) {
      const settings = await this.contextService.getSettings(Number(company.id));
      if (settings.auto_enable_new_customers || simulated) {
        channelUser.bot_enabled = true;
        await this.channelUserRepository.update(channelUser.id, { bot_enabled: true });
        return true;
      }
    }
    return false;
  }

  private async turn(companyId: number, conversationId: number) {
    const simulated = this.simulated.has(conversationId) && SalesBotEngineService.testMode();
    const conversation = await this.conversationRepository.findOne({ where: { id: conversationId }, relations: ['channelUser'] });
    if (!conversation?.channelUser) return;
    const channelUser = conversation.channelUser;
    const company = await this.companyRepository.findOne({ where: { id: companyId } });
    if (!(await this.botMayReply(company, conversation, channelUser, simulated))) return;

    // Customer messages since our last reply (several quick messages are answered together)
    const lastOut = await this.messageRepository.findOne({
      where: { conversation_id: conversationId, direction: 'outbound' },
      order: { id: 'DESC' },
    });
    const pending = await this.messageRepository
      .createQueryBuilder('m')
      .where('m.conversation_id = :conversationId', { conversationId })
      .andWhere("m.direction::text = 'inbound'")
      .andWhere('m.id > :after', { after: lastOut?.id ?? 0 })
      .orderBy('m.id', 'ASC')
      .getMany();
    if (!pending.length) return;

    const message = pending
      .map((row) => String(row.content ?? '').split('\n').filter((line) => !PLACEHOLDER.test(line.trim())).join('\n').trim())
      .filter(Boolean)
      .join('\n');
    const mediaRow = [...pending].reverse().find((row) => row.media_url && (row.message_type === 'image' || row.message_type === 'voice'));
    const channel = simulated ? null : await this.whatsappService.getChannelForCompany(companyId).catch(() => null);
    const media = mediaRow ? await this.loadMedia(mediaRow.media_url as string, channel) : null;
    if (!message && !media) return;

    const history = await this.history(conversationId, pending[0].id);
    const sessionState = this.readSessionState(channelUser.session_state);
    const session: BotSession = (sessionState.sales_bot as BotSession) ?? {};

    let result: SalesBotResult;
    try {
      const context = await this.contextService.build(companyId, channelUser.id);
      result = await this.client.reply({
        company_id: companyId, customer_id: channelUser.id, message, history,
        session: { language: session.language, pending_order: session.pending_order ?? null },
        media, context,
      });
    } catch (error) {
      this.logger.error(`sales bot request failed (conversation ${conversationId}): ${error instanceof Error ? error.message : String(error)}`);
      const language = session.language ?? 'english';
      await this.sendText(companyId, conversation, channelUser, channel, sorryMessage(language), 'handoff', simulated);
      await this.handoff(companyId, conversation, channelUser, 'bot_error', 'The bot could not answer – please reply to the customer.');
      return;
    }

    // An agent may have taken over while the AI was thinking
    const fresh = await this.conversationRepository.findOne({ where: { id: conversationId } });
    const freshUser = await this.channelUserRepository.findOne({ where: { id: channelUser.id } });
    if (!fresh || fresh.status === 'active' || fresh.status === 'closed' || !freshUser?.bot_enabled) return;

    // Save first, so a blocked order never gets a "confirmed!" message
    const outcome = await this.applyActions(companyId, conversation, channelUser, result, session);
    session.language = result.language;
    await this.channelUserRepository.update(channelUser.id, {
      session_state: JSON.stringify({ ...sessionState, sales_bot: session }),
    });

    await this.sendPhotos(companyId, conversation, channelUser, channel, result.photo_product_ids, simulated);
    const text = outcome.replyOverride ?? result.reply;
    if (text) await this.sendText(companyId, conversation, channelUser, channel, text, outcome.intent, simulated);

    await this.usageRepository.save(this.usageRepository.create({
      company_id: companyId, conversation_id: conversationId, model: result.usage.model,
      input_tokens: result.usage.input_tokens, cached_tokens: result.usage.cached_tokens,
      output_tokens: result.usage.output_tokens, calls: result.usage.calls ?? 1,
      cost_usd: result.usage.cost_usd, latency_ms: result.usage.latency_ms, is_test: false,
    }));
    this.logger.log(`conv ${conversationId}: ${result.usage.calls ?? 1} AI calls, ${result.usage.latency_ms} ms, $${result.usage.cost_usd.toFixed(5)}, intent ${outcome.intent ?? '-'}`);
  }

  private readSessionState(raw: string | null): Record<string, unknown> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private async history(conversationId: number, beforeId: number): Promise<SalesBotTurn[]> {
    const rows = await this.messageRepository
      .createQueryBuilder('m')
      .where('m.conversation_id = :conversationId', { conversationId })
      .andWhere('m.id < :beforeId', { beforeId })
      .orderBy('m.id', 'DESC')
      .limit(20)
      .getMany();
    return rows.reverse().map((row) => {
      const content = row.message_type === 'image' ? `[photo] ${PLACEHOLDER.test(row.content.trim()) ? '' : row.content}`.trim()
        : row.message_type === 'voice' ? '[voice note]' : row.content;
      if (row.direction === 'inbound') return { role: 'customer' as const, text: content };
      const isBot = ['sales_bot', 'bot', 'meta_bot', 'n8n'].includes(String(row.source ?? ''));
      return { role: isBot ? ('bot' as const) : ('agent' as const), text: content };
    }).filter((turn) => turn.text);
  }

  /** Photo or voice note for Gemini: our stored files, WhatsApp Cloud media ids, data URLs, public links. */
  private async loadMedia(mediaUrl: string, channel: WhatsappChannel | null): Promise<{ mime_type: string; data_b64: string } | null> {
    const stored = mediaUrl.trim();
    try {
      if (isChatMediaKey(stored)) {
        const file = readChatMedia(stored);
        return file && file.buffer.length <= MAX_MEDIA_BYTES ? { mime_type: file.contentType, data_b64: file.buffer.toString('base64') } : null;
      }
      if (stored.startsWith('data:')) {
        const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(stored);
        return match && match[2] ? { mime_type: match[1], data_b64: match[3] } : null;
      }
      const token = channel?.meta_access_token?.trim();
      let url = stored;
      let headers: Record<string, string> = {};
      if (stored.startsWith('meta-media:')) {
        if (!token) return null;
        const version = process.env.META_GRAPH_API_VERSION || 'v22.0';
        const meta = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(stored.slice(11))}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000),
        });
        if (!meta.ok) return null;
        url = String(((await meta.json()) as { url?: string }).url ?? '');
        headers = { Authorization: `Bearer ${token}` };
      }
      if (!/^https?:\/\//i.test(url)) return null;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) return null;
      const mime = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
      return { mime_type: mime, data_b64: buffer.toString('base64') };
    } catch (error) {
      this.logger.warn(`could not load customer media: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /* ───────────────────────── Sending ───────────────────────── */

  private async sendText(companyId: number, conversation: BotConversation, channelUser: BotChannelUser,
    channel: WhatsappChannel | null, text: string, intent: string | null, simulated: boolean) {
    let messageId: string | null = null;
    let failed = false;
    if (!simulated && channel) {
      try {
        messageId = (await this.providerFactory.getAdapterForChannel(channel).sendText(channel, channelUser.external_user_id, text)).messageId;
      } catch (error) {
        failed = true;
        this.logger.warn(`sending the bot reply failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (!simulated) {
      failed = true;
    }
    await this.messageRepository.save(this.messageRepository.create({
      conversation_id: conversation.id, direction: 'outbound', message_type: 'text', platform: channelUser.platform || 'whatsapp',
      provider_message_id: messageId, delivery_status: failed ? 'failed' : messageId ? 'sent' : null,
      content: text, source: BOT_SOURCE, intent, llm_provider: 'gemini',
    }));
    await this.touch(companyId, conversation.id);
  }

  private async sendPhotos(companyId: number, conversation: BotConversation, channelUser: BotChannelUser,
    channel: WhatsappChannel | null, productIds: number[], simulated: boolean) {
    if (!productIds.length) return;
    const products = await this.productRepository.find({ where: productIds.slice(0, 3).map((id) => ({ id, company_id: companyId, is_deleted: false })) });
    let sent = 0;
    for (const product of products) {
      for (const url of productImages(product).slice(0, 3)) {
        if (sent >= 6) break;
        let messageId: string | null = null;
        if (!simulated && channel) {
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
            if (!response.ok) continue;
            const buffer = Buffer.from(await response.arrayBuffer());
            const mimetype = (response.headers.get('content-type') || 'image/jpeg').split(';')[0];
            messageId = (await this.providerFactory.getAdapterForChannel(channel).sendMedia(channel, channelUser.external_user_id, {
              buffer, mimetype, fileName: `${product.name}.${mimetype.split('/')[1] || 'jpg'}`, mediaType: 'image',
            })).messageId;
          } catch (error) {
            this.logger.warn(`sending a product photo failed: ${error instanceof Error ? error.message : String(error)}`);
            continue;
          }
        }
        await this.messageRepository.save(this.messageRepository.create({
          conversation_id: conversation.id, direction: 'outbound', message_type: 'image', platform: channelUser.platform || 'whatsapp',
          provider_message_id: messageId, delivery_status: messageId ? 'sent' : null, content: '[image]', media_url: url, source: BOT_SOURCE,
        }));
        sent += 1;
      }
    }
    if (sent) await this.touch(companyId, conversation.id);
  }

  private async touch(companyId: number, conversationId: number) {
    await this.conversationRepository.update(conversationId, { last_message_at: new Date() });
    this.pusherService.trigger(`company-${companyId}`, 'conversation_updated', { conversation_id: conversationId, inbound: false });
  }

  /* ───────────────────────── Actions ───────────────────────── */

  private async applyActions(companyId: number, conversation: BotConversation, channelUser: BotChannelUser,
    result: SalesBotResult, session: BotSession): Promise<Outcome> {
    const intents = new Set<string>();
    let replyOverride: string | null = null;

    const booking = result.booking;
    if (booking?.confirm && booking.service_name && booking.date) {
      const service = booking.service_id
        ? await this.serviceRepository.findOne({ where: { id: Number(booking.service_id), company_id: companyId } })
        : null;
      await this.bookingRepository.save(this.bookingRepository.create({
        company_id: companyId, bot_channel_user_id: channelUser.id, conversation_id: conversation.id,
        service_id: service?.id ?? null, service_name: service?.name ?? booking.service_name,
        date: String(booking.date).slice(0, 40), time: String(booking.time ?? '').slice(0, 40),
        customer_name: booking.customer_name || channelUser.display_name || '', customer_phone: channelUser.external_user_id,
        notes: booking.notes ?? '', status: 'requested',
      }));
      intents.add('booking');
    }

    const lead = result.lead;
    if (lead && (lead.need || lead.notes)) {
      const lines = [
        '🎯 Lead collected by the sales bot',
        lead.need ? `Need: ${lead.need}` : '', lead.budget ? `Budget: ${lead.budget}` : '',
        lead.location ? `Location: ${lead.location}` : '', lead.contact_time ? `Best time to contact: ${lead.contact_time}` : '',
        lead.customer_name ? `Name: ${lead.customer_name}` : '', lead.notes ? `Notes: ${lead.notes}` : '',
      ].filter(Boolean);
      await this.noteRepository.save(this.noteRepository.create({
        company_id: companyId, bot_channel_user_id: channelUser.id, content: lines.join('\n'),
        created_by_user_id: null, created_by_name: 'Sales bot',
      }));
      if (['new', 'contacted'].includes(String(conversation.lead_stage ?? 'new'))) {
        await this.conversationRepository.update(conversation.id, { lead_stage: 'qualified' });
      }
      intents.add('lead');
    }

    if (result.order?.items?.length) {
      const orderOutcome = await this.handleOrder(companyId, conversation, channelUser, result.order, session);
      if (orderOutcome === 'saved') intents.add('order');
      if (orderOutcome.startsWith('blocked:')) {
        replyOverride = holdMessage(result.language);
        await this.handoff(companyId, conversation, channelUser, 'order_check', `Order needs a check: ${orderOutcome.slice(8)}`);
        intents.add('handoff');
      }
    }

    if (result.handoff?.needed && !intents.has('handoff')) {
      await this.handoff(companyId, conversation, channelUser, 'bot_handoff', result.handoff.reason || 'The bot asked for a person.');
      intents.add('handoff');
    }
    return { intent: intents.size ? [...intents].join(',') : null, replyOverride };
  }

  /** Prices always come from the products table – never from the AI. */
  async priceItems(companyId: number, items: NonNullable<SalesBotOrder['items']>): Promise<{ items: PricedItem[]; problem: string }> {
    const priced: PricedItem[] = [];
    for (const item of items) {
      const product = await this.productRepository.findOne({
        where: { id: Number(item.product_id), company_id: companyId, is_deleted: false, show_to_bot: true },
        relations: ['variants'],
      });
      if (!product) return { items: priced, problem: `unknown_product_${item.product_id}` };
      const options = productOptions(product);
      let unit = Number(product.price) || 0;
      let variantName = '';
      let variantId: number | null = null;
      let weightKg = productWeight(product) ?? 0;
      if (options.length) {
        const byId = item.variant_id ? options[Number(item.variant_id) - 1] : undefined;
        const wanted = String(item.variant_name ?? '').trim().toLowerCase();
        const byName = options.findIndex((option) => variantLabel(option).toLowerCase() === wanted || String(option.variant_value ?? '').trim().toLowerCase() === wanted);
        const index = byId && (!wanted || variantLabel(byId).toLowerCase() === wanted) ? Number(item.variant_id) - 1 : byName;
        if (index < 0) return { items: priced, problem: `choose_variant_for_${product.name}` };
        unit = variantPrice(product, options[index]);
        variantName = variantLabel(options[index]);
        variantId = index + 1;
        weightKg = optionWeight(options[index]) ?? weightKg;
      }
      const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
      priced.push({ product_id: product.id, variant_id: variantId, product_name: product.name, variant_name: variantName, quantity, unit_price: unit, total_price: unit * quantity, weight_kg: weightKg });
    }
    return { items: priced, problem: '' };
  }

  private async handleOrder(companyId: number, conversation: BotConversation, channelUser: BotChannelUser,
    order: SalesBotOrder, session: BotSession): Promise<string> {
    const { items, problem } = await this.priceItems(companyId, order.items ?? []);
    const subtotal = items.reduce((sum, item) => sum + item.total_price, 0);
    const totalWeight = Math.round(items.reduce((sum, item) => sum + item.weight_kg * item.quantity, 0) * 1000) / 1000;
    // The fee is always calculated here (zone + order weight) – never taken from the AI.
    const zones = await this.zoneRepository.find({ where: { company_id: companyId } });
    const area = String(order.delivery_area ?? '').trim();
    let zone = area ? findZone(zones, area) : null;
    if (!zone && order.delivery_fee != null) {
      // older bot replies without delivery_area: accept only a flat zone with exactly that fee
      zone = zones.find((row) => !hasWeightRule(row) && Number(row.fee) === Number(order.delivery_fee)) ?? null;
    }
    const fee = zone ? zoneFee(zone, totalWeight) : null;
    const total = subtotal + (fee ?? 0);
    const address = String(order.address ?? '').trim();
    const name = String(order.customer_name ?? '').trim();
    const phone = String(order.customer_phone || channelUser.external_user_id || '').replace(/[^\d+]/g, '');
    const previous = session.pending_order;
    const signature = (value: { items?: Array<{ product_id: number; variant_id?: number | null; quantity: number }>; address?: string } | null | undefined) =>
      JSON.stringify({ i: (value?.items ?? []).map((item) => [item.product_id, item.variant_id ?? null, item.quantity]), a: String(value?.address ?? '').trim() });
    const previousShown = previous?.summary_shown === true;
    const summaryShown = order.summary_shown === true || (previousShown && signature(previous) === signature({ items, address }));

    const pending: PendingOrder = {
      items, subtotal, delivery_area: zone?.area ?? (area || null), total_weight_kg: totalWeight,
      delivery_fee: fee, total, customer_name: name, customer_phone: phone, address,
      payment_method: String(order.payment_method || 'COD').slice(0, 60), summary_shown: summaryShown,
    };
    if (!order.confirm_order) {
      session.pending_order = pending;
      return 'pending';
    }

    let blocked = problem;
    if (!blocked && !previousShown) blocked = 'confirmed before the summary was shown';
    if (!blocked && (!name || !address)) blocked = 'name or address missing';
    if (!blocked && subtotal <= 0) blocked = 'total is zero';
    if (blocked) {
      session.pending_order = pending;
      return `blocked:${blocked}`;
    }

    const saved = await this.orderRepository.save(this.orderRepository.create({
      company_id: companyId, bot_channel_user_id: channelUser.id, customer_name: name, customer_phone: phone,
      address, status: 'Pending', total_amount: total, delivery_fee: fee, payment_method: pending.payment_method,
      total_weight_kg: totalWeight || null,
      admin_note: 'Created by the sales bot.',
    }));
    for (const item of items) {
      await this.orderItemRepository.save(this.orderItemRepository.create({
        order_id: saved.id, product_id: item.product_id, product_name: item.product_name,
        variant_text: item.variant_name || null, quantity: item.quantity, unit_price: item.unit_price, total_price: item.total_price,
      }));
    }
    await this.orderHistoryRepository.save(this.orderHistoryRepository.create({
      order_id: saved.id, status: 'Pending', message: 'Order confirmed by the customer in chat (sales bot).',
    }));
    if (name && (!channelUser.display_name || channelUser.display_name === channelUser.external_user_id)) {
      await this.channelUserRepository.update(channelUser.id, { display_name: name.slice(0, 255) });
    }
    session.pending_order = null;
    this.pusherService.trigger(`company-${companyId}`, 'conversation_updated', { conversation_id: conversation.id, order_created: saved.id });
    return 'saved';
  }

  /** Bot stops for this customer and a person takes over (online agent, or the unassigned queue). */
  async handoff(companyId: number, conversation: BotConversation, channelUser: BotChannelUser, reason: string, note: string) {
    await this.channelUserRepository.update(channelUser.id, { bot_enabled: false, manual_mode: true });
    await this.conversationRepository.update(conversation.id, { queue_reason: reason, queue_note: note.slice(0, 500) });
    const fresh = await this.conversationRepository.findOne({ where: { id: conversation.id } });
    if (fresh && (fresh.status === 'open' || fresh.assigned_agent_id == null)) {
      await this.agentRoutingService.assignConversationRoundRobin(companyId, conversation.id).catch((error: unknown) =>
        this.logger.warn(`handoff routing failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.pusherService.trigger(`company-${companyId}`, 'conversation_updated', { conversation_id: conversation.id, handoff: reason });
  }
}
