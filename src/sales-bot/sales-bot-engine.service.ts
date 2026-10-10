import { withQuote } from '../common/message-reply';
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
import { MetaSocialSenderService, socialPlatformOf } from '../integrations/meta/meta-social-sender.service';
import { WhatsappProviderFactory } from '../integrations/whatsapp/whatsapp-provider.factory';
import { WhatsappService } from '../integrations/whatsapp/whatsapp.service';
import { Product } from '../products/entities/product.entity';
import type { WhatsappChannel } from '../whatsapp/entities/whatsapp-channel.entity';
import { BotAdminService } from '../bot-admin/bot-admin.service';
import { PlanService } from '../platform/plan.service';
import { TokenQuotaService } from '../platform/token-quota.service';
import { BotAiUsage } from './entities/bot-ai-usage.entity';
import { BotNotification, type BotNotificationKind } from './entities/bot-notification.entity';
import { bookingMinutes, formatMinutes, isFree, nearestFreeTimes, normalizeBookingDate, slotTakenMessage } from './booking-slots';
import { BotBooking } from './entities/bot-booking.entity';
import { BotDeliveryZone } from './entities/bot-delivery-zone.entity';
import { BotService } from './entities/bot-service.entity';
import { SalesBotClient, type SalesBotOrder, type SalesBotResult, type SalesBotTurn } from './sales-bot.client';
import { SalesBotContextService, sriLankaNow, optionWeight, productImages, productOptions, productWeight, variantLabel, variantPrice } from './sales-bot-context.service';
import { findZone, hasWeightRule, orderDeliveryFee } from './delivery-fee';
import { FOLLOWUP_WINDOW_HOURS, isDaytime, planFollowUp } from './follow-up';

type PricedItem = {
  product_id: number; variant_id: number | null; product_name: string; variant_name: string;
  quantity: number; unit_price: number; total_price: number;
  /** kg per unit (variant weight, else product weight; 0 when not set) */
  weight_kg: number;
};
type PendingOrder = {
  /** special notes said before the order was saved – written into the order note when it is saved */
  notes?: string[];
  items: PricedItem[]; subtotal: number; delivery_area: string | null; total_weight_kg: number;
  delivery_fee: number | null; total: number;
  customer_name: string; customer_phone: string; address: string; payment_method: string; summary_shown: boolean;
};
/** memory = short notes the bot keeps about this customer (older parts of the chat). handoff_at = last hand-over (unix s). */
type BotSession = { language?: string; pending_order?: PendingOrder | null; memory?: string; handoff_at?: number };
/** Splits a bot reply into at most 3 WhatsApp messages at empty lines (extra parts join the last one). */
export function splitReply(text: string, maxParts = 3): string[] {
  const parts = String(text ?? '').split(/\n[ \t]*\n+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= maxParts) return parts.length ? parts : [];
  return [...parts.slice(0, maxParts - 1), parts.slice(maxParts - 1).join('\n')];
}

/** intent is stored on the bot message, e.g. "lead,handoff" (one reply can do several things). */
type Outcome = { intent: string | null; replyOverride: string | null; invoiceOrderIds: number[]; invoiceBookingIds?: number[] };
type LeadStage = 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost';
const LEAD_RANK: Record<LeadStage, number> = { new: 0, contacted: 1, qualified: 2, proposal: 3, won: 4, lost: 4 };

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

/** Sent when the customer tries to order something that is not available right now. */
function unavailableMessage(language: string, item: string): string {
  if (language === 'sinhala') return `සමාවෙන්න, ${item} දැනට ලබා ගත නොහැක. වෙන එකක් බලමුද?`;
  if (language === 'tamil') return `மன்னிக்கவும், ${item} தற்போது கிடைக்கவில்லை. வேறு ஏதாவது பார்க்கலாமா?`;
  if (language === 'sinhala_latin') return `Sorry, ${item} dan available naha. Wena ekak balamuda?`;
  return `Sorry, ${item} is not available right now. Would you like to choose something else?`;
}

/** Sent when an order change could not be applied automatically. */
function changeHoldMessage(language: string): string {
  if (language === 'sinhala') return 'ඔයාගේ වෙනස අපි සටහන් කරගත්තා. අපේ team එක check කරලා ඉක්මනින්ම confirm කරනවා.';
  if (language === 'tamil') return 'உங்கள் மாற்றத்தை குறித்துக்கொண்டோம். எங்கள் குழு சரிபார்த்து விரைவில் உறுதிப்படுத்தும்.';
  if (language === 'sinhala_latin') return 'Oyage wenasa api note kara gaththa. Ape team eka check karala ikmanatama confirm karanawa.';
  return 'We noted your change. Our team will check it and confirm shortly.';
}

const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const rs = (value: number) => `Rs ${Number(value || 0).toLocaleString('en-LK', { maximumFractionDigits: 2 })}`;

/** Asks for the details an order still needs (instead of switching the bot off). */
function askMissingMessage(language: string, missing: string[]): string {
  const want = missing.join(', ');
  if (language === 'sinhala') return `Order එක confirm කරන්න කරුණාකර ${want} එවන්නකෝ.`;
  if (language === 'tamil') return `ஆர்டரை உறுதிப்படுத்த தயவுசெய்து ${want} அனுப்புங்கள்.`;
  if (language === 'sinhala_latin') return `Order eka confirm karanna karunakara ${want} evanna.`;
  return `To confirm your order, please send your ${want}.`;
}

/** The order summary written by the backend (real prices) when the bot skipped it. */
function summaryMessage(language: string, order: { items: Array<{ quantity: number; product_name: string; variant_name: string; total_price: number }>;
  delivery_area: string | null; delivery_fee: number | null; total: number; customer_name: string; address: string; customer_phone: string; payment_method: string }): string {
  const lines = order.items.map((item) => `${item.quantity} x ${item.product_name}${item.variant_name ? ` (${item.variant_name})` : ''} – ${rs(item.total_price)}`);
  lines.push(order.delivery_fee == null ? 'Delivery: to be confirmed' : `Delivery${order.delivery_area && order.delivery_area !== '*' ? ` (${order.delivery_area})` : ''}: ${rs(order.delivery_fee)}`);
  lines.push(`Total: ${rs(order.total)}`);
  lines.push([order.customer_name, order.address, order.customer_phone].filter(Boolean).join(', '));
  lines.push(`Payment: ${order.payment_method}`);
  const ask = language === 'sinhala' ? 'Order එක confirm කරන්නද?' : language === 'tamil' ? 'ஆர்டரை உறுதிப்படுத்தவா?'
    : language === 'sinhala_latin' ? 'Order eka confirm karannada?' : 'Shall I confirm the order?';
  return `${lines.join('\n')}\n\n${ask}`;
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
    @InjectRepository(BotNotification) private readonly notificationRepository: Repository<BotNotification>,
    private readonly contextService: SalesBotContextService,
    private readonly client: SalesBotClient,
    private readonly agentRoutingService: AgentRoutingService,
    private readonly whatsappService: WhatsappService,
    private readonly providerFactory: WhatsappProviderFactory,
    private readonly pusherService: PusherService,
    private readonly botAdminService: BotAdminService,
    private readonly planService: PlanService,
    private readonly tokenQuota: TokenQuotaService,
    private readonly socialSender: MetaSocialSenderService,
  ) {}

  onModuleInit() {
    if (!SalesBotClient.isConfigured()) {
      this.logger.log('SALES_BOT_URL not set: the Python sales bot is off (n8n keeps handling bot replies).');
      return;
    }
    SalesBotHook.register((event) => this.onInbound(event));
    this.logger.log(`Python sales bot active at ${SalesBotClient.baseUrl()}`);
    const tick = Number(process.env.SALES_BOT_FOLLOWUP_TICK_MS ?? 60_000) || 60_000;
    setInterval(() => void this.runDueFollowUps(), tick).unref();
  }

  static testMode(): boolean {
    return ['1', 'true', 'yes'].includes(String(process.env.SALES_BOT_TEST_MODE ?? '').trim().toLowerCase());
  }

  /** Called for every saved customer message. Returns true = the sales bot owns the reply. */
  async onInbound(event: SalesBotInboundEvent): Promise<boolean> {
    if (event.provider === 'simulator') this.simulated.add(event.conversationId);
    // a new customer message cancels the planned follow-up (the reply to it plans a new one)
    await this.cancelPlannedFollowUp(event.conversationId).catch(() => undefined);
    this.schedule(event.companyId, event.conversationId);
    return true;
  }

  /** when the first unanswered message of a burst arrived (per conversation) */
  private readonly burstStart = new Map<number, number>();

  /**
   * Waits until the customer stops typing, so "hi" + "price?" + "blue one" + "Colombo ta" get ONE reply:
   * every new message restarts the wait (SALES_BOT_DEBOUNCE_MS, default 4 s), but never longer than
   * SALES_BOT_DEBOUNCE_MAX_MS (default 15 s) after the first message.
   */
  private schedule(companyId: number, conversationId: number, delayMs?: number) {
    const base = Number(process.env.SALES_BOT_DEBOUNCE_MS ?? 4000) || 4000;
    const max = Math.max(base, Number(process.env.SALES_BOT_DEBOUNCE_MAX_MS ?? 15000) || 15000);
    const now = Date.now();
    if (!this.burstStart.has(conversationId)) this.burstStart.set(conversationId, now);
    const waited = now - (this.burstStart.get(conversationId) ?? now);
    const wait = delayMs ?? Math.max(300, Math.min(base, max - waited));
    clearTimeout(this.timers.get(conversationId));
    this.timers.set(conversationId, setTimeout(() => {
      this.timers.delete(conversationId);
      this.burstStart.delete(conversationId);
      void this.run(companyId, conversationId);
    }, wait));
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
    if (!company || !(await this.planService.planAllowsBot(company.plan)) || !company.bot_enabled) return false;
    // package limits: Messenger / Instagram must be included in the package
    const social = socialPlatformOf(channelUser.platform);
    if (social && !(await this.planService.hasFeature(Number(company.id), social))) return false;
    // tokens used up / package expired / suspended → the bot stops, the chat stays with the agents
    if (!(await this.tokenQuota.canBotReply(Number(company.id)))) return false;
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
      .map((row) => {
        const text = String(row.content ?? '').split('\n').filter((line) => !PLACEHOLDER.test(line.trim())).join('\n').trim();
        // "Mata me pack eka danna" quoting an earlier message → the AI sees which message "me pack eka" is
        return text ? withQuote(row, text) : '';
      })
      .filter(Boolean)
      .join('\n');
    const mediaRow = [...pending].reverse().find((row) => row.media_url && (row.message_type === 'image' || row.message_type === 'voice'));
    const social = socialPlatformOf(channelUser.platform);
    // Messenger / Instagram chats are answered through the connected Page, not a WhatsApp channel
    const channel = simulated || social ? null : await this.whatsappService.getChannelForCompany(companyId).catch(() => null);
    const media = mediaRow ? await this.loadMedia(mediaRow.media_url as string, channel) : null;
    if (!message && !media) return;

    const history = await this.history(conversationId, pending[0].id);
    const sessionState = this.readSessionState(channelUser.session_state);
    const session: BotSession = (sessionState.sales_bot as BotSession) ?? {};

    let result: SalesBotResult;
    try {
      const context = await this.contextService.build(companyId, channelUser.id, social ?? 'whatsapp', { conversationId: conversation.id, message });
      result = await this.client.reply({
        company_id: companyId, customer_id: channelUser.id, message, history,
        session: {
          language: session.language, pending_order: session.pending_order ?? null, channel: social ?? 'whatsapp',
          memory: session.memory ?? '', handoff_at: session.handoff_at ?? 0,
        },
        media, context,
      });
    } catch (error) {
      this.logger.error(`sales bot request failed (conversation ${conversationId}): ${error instanceof Error ? error.message : String(error)}`);
      const language = session.language ?? 'english';
      await this.sendText(companyId, conversation, channelUser, channel, sorryMessage(language), 'handoff', simulated);
      await this.handoff(companyId, conversation, channelUser, 'bot_error', 'The bot could not answer – please reply to the customer.');
      await this.conversationRepository.query(
        `UPDATE bot_conversation SET followup_status = 'stopped', followup_due_at = NULL WHERE id = $1 AND followup_status = 'waiting'`, [conversationId]);
      return;
    }

    // An agent may have taken over while the AI was thinking
    const fresh = await this.conversationRepository.findOne({ where: { id: conversationId } });
    const freshUser = await this.channelUserRepository.findOne({ where: { id: channelUser.id } });
    if (!fresh || fresh.status === 'active' || fresh.status === 'closed' || !freshUser?.bot_enabled) return;

    // Save first, so a blocked order never gets a "confirmed!" message
    const outcome = await this.applyActions(companyId, conversation, channelUser, result, session);
    session.language = result.language;
    if (result.memory) session.memory = String(result.memory).slice(0, 600);
    if (outcome.intent && String(outcome.intent).includes('handoff')) session.handoff_at = Math.floor(Date.now() / 1000);
    await this.channelUserRepository.update(channelUser.id, {
      session_state: JSON.stringify({ ...sessionState, sales_bot: session }),
    });

    await this.sendPhotos(companyId, conversation, channelUser, channel, result.photo_product_ids, simulated);
    const text = outcome.replyOverride ?? result.reply;
    if (text) {
      // short WhatsApp-style replies: the bot separates parts with an empty line → one message each
      const parts = outcome.replyOverride ? [text] : splitReply(text);
      const pause = Number(process.env.SALES_BOT_PART_DELAY_MS ?? 900) || 0;
      for (let index = 0; index < parts.length; index++) {
        if (index && pause && !simulated) await new Promise((resolve) => setTimeout(resolve, pause));
        await this.sendText(companyId, conversation, channelUser, channel, parts[index], index === 0 ? outcome.intent : null, simulated);
      }
    }
    await this.advanceLead(conversation.id, 'contacted');
    await this.planFollowUpAfterReply(companyId, conversation, result, outcome, session)
      .catch((error: unknown) => this.logger.warn(`follow-up plan failed: ${error instanceof Error ? error.message : String(error)}`));

    // Invoice PDF after a new or changed order (existing invoice feature, on the customer's channel)
    if (outcome.invoiceOrderIds.length) {
      const settings = await this.contextService.getSettings(companyId);
      const askedFor = String(outcome.intent ?? '').includes('invoice');
      for (const orderId of outcome.invoiceOrderIds) {
        if (!settings.auto_send_invoice && !askedFor) break;
        if (simulated) {
          await this.messageRepository.save(this.messageRepository.create({
            conversation_id: conversation.id, direction: 'outbound', message_type: 'text', platform: channelUser.platform || 'whatsapp',
            content: `[invoice for order #${orderId} – not sent in the simulator]`, source: BOT_SOURCE,
          }));
          continue;
        }
        await this.botAdminService.sendInvoiceForCompany(companyId, orderId).catch((error: unknown) =>
          this.logger.warn(`auto invoice for order ${orderId} failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    }

    // Booking confirmation PDF after a new or changed booking, or when the customer asks for it
    if (outcome.invoiceBookingIds?.length) {
      const settings = await this.contextService.getSettings(companyId);
      const askedFor = String(outcome.intent ?? '').includes('invoice');
      for (const bookingId of outcome.invoiceBookingIds) {
        if (!settings.auto_send_invoice && !askedFor) break;
        if (simulated) {
          await this.messageRepository.save(this.messageRepository.create({
            conversation_id: conversation.id, direction: 'outbound', message_type: 'text', platform: channelUser.platform || 'whatsapp',
            content: `[booking invoice #${bookingId} – not sent in the simulator]`, source: BOT_SOURCE,
          }));
          continue;
        }
        await this.botAdminService.sendBookingInvoiceForCompany(companyId, bookingId).catch((error: unknown) =>
          this.logger.warn(`auto invoice for booking ${bookingId} failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    }

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
      if (row.direction === 'inbound') return { role: 'customer' as const, text: content ? withQuote(row, content) : content };
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
    const social = socialPlatformOf(channelUser.platform);
    if (!simulated && social) {
      try {
        messageId = await this.socialSender.sendText(companyId, social, channelUser.source_account_id, channelUser.external_user_id, text);
      } catch (error) {
        failed = true;
        this.logger.warn(`sending the bot reply on ${social} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (!simulated && channel) {
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
      conversation_id: conversation.id, direction: 'outbound', message_type: 'text', platform: social ?? (channelUser.platform || 'whatsapp'),
      provider_message_id: messageId, delivery_status: failed ? 'failed' : messageId ? 'sent' : null,
      content: text, source: BOT_SOURCE, intent, llm_provider: 'gemini',
    }));
    await this.touch(companyId, conversation.id);
    return !failed;
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
        const social = socialPlatformOf(channelUser.platform);
        if (!simulated && social) {
          try {
            let buffer: Buffer | undefined;
            let mimetype: string | undefined;
            if (social === 'messenger') {
              const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
              if (!response.ok) continue;
              buffer = Buffer.from(await response.arrayBuffer());
              mimetype = (response.headers.get('content-type') || 'image/jpeg').split(';')[0];
            }
            messageId = await this.socialSender.sendImage(companyId, social, channelUser.source_account_id, channelUser.external_user_id, {
              url, buffer, mimetype, fileName: `${product.name}.${(mimetype || 'image/jpeg').split('/')[1] || 'jpg'}`,
            });
          } catch (error) {
            this.logger.warn(`sending a product photo on ${social} failed: ${error instanceof Error ? error.message : String(error)}`);
            continue;
          }
        } else if (!simulated && channel) {
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
          conversation_id: conversation.id, direction: 'outbound', message_type: 'image', platform: socialPlatformOf(channelUser.platform) ?? (channelUser.platform || 'whatsapp'),
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
    const invoiceOrderIds: number[] = [];
    const invoiceBookingIds: number[] = [];
    let savedOrderId: number | null = null;
    const who = channelUser.display_name || channelUser.external_user_id;

    const booking = result.booking;
    if (booking?.confirm && booking.service_name && booking.date) {
      const service = booking.service_id
        ? await this.serviceRepository.findOne({ where: { id: Number(booking.service_id), company_id: companyId } })
        : null;
      // a clear date + time is saved in one format ("2026-10-12", "14:30") so the time check can read it
      const date = normalizeBookingDate(booking.date) ?? String(booking.date).slice(0, 40);
      const start = bookingMinutes(booking.time);
      const time = start == null ? String(booking.time ?? '').slice(0, 40) : formatMinutes(start);
      const row = this.bookingRepository.create({
        company_id: companyId, bot_channel_user_id: channelUser.id, conversation_id: conversation.id,
        service_id: service?.id ?? null, service_name: service?.name ?? booking.service_name,
        date, time,
        customer_name: booking.customer_name || channelUser.display_name || '',
        customer_phone: socialPlatformOf(channelUser.platform) ? null : channelUser.external_user_id, // Messenger/Instagram ids are not phone numbers
        notes: booking.notes ?? '', status: 'requested',
        price: service ? Number(service.price) || null : null,
        duration_min: service?.duration_min ?? null,
      });
      // the time must still be free (two customers can ask for the same time at once: lock that day while checking)
      const taken = await this.bookingRepository.manager.transaction(async (manager) => {
        if (start != null && normalizeBookingDate(date)) {
          await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [companyId, date]);
          const day = await this.contextService.bookingDay(companyId, date);
          const duration = day.durationOf(service?.id ?? null);
          if (!isFree(day.busy, start, start + duration, day.capacity)) {
            return nearestFreeTimes(day.busy, start, duration, day.capacity, 3, day.window);
          }
        }
        await manager.save(row);
        return null;
      });
      if (taken) {
        replyOverride = slotTakenMessage(result.language, date, start as number, taken);
        await this.advanceLead(conversation.id, 'proposal', { booking: `${booking.service_name} ${date} ${time} (time taken)`.trim() });
      } else {
        intents.add('booking');
        if (row.id) invoiceBookingIds.push(row.id);
        await this.advanceLead(conversation.id, 'won', { booking: `${booking.service_name} ${date} ${time}`.trim() });
      }
    } else if (booking?.service_name) {
      await this.advanceLead(conversation.id, 'proposal', { booking: `${booking.service_name} ${booking.date ?? ''} ${booking.time ?? ''}`.trim() });
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
      await this.advanceLead(conversation.id, 'qualified', {
        need: lead.need, budget: lead.budget, location: lead.location, contact_time: lead.contact_time, name: lead.customer_name,
      });
      intents.add('lead');
    }

    if (result.order?.items?.length) {
      const orderOutcome = await this.handleOrder(companyId, conversation, channelUser, result.order, session);
      if (orderOutcome.startsWith('saved:')) {
        savedOrderId = Number(orderOutcome.slice(6));
        invoiceOrderIds.push(savedOrderId);
        intents.add('order');
      }
      if (orderOutcome.startsWith('ask:')) {
        replyOverride = askMissingMessage(result.language, orderOutcome.slice(4).split(','));
      }
      if (orderOutcome === 'summary' && session.pending_order) {
        replyOverride = summaryMessage(result.language, session.pending_order);
      }
      if (orderOutcome.startsWith('unavailable:')) {
        replyOverride = unavailableMessage(result.language, orderOutcome.slice(12));
      }
      if (orderOutcome.startsWith('blocked:')) {
        replyOverride = holdMessage(result.language);
        await this.handoff(companyId, conversation, channelUser, 'order_check', `Order needs a check: ${orderOutcome.slice(8)}`);
        intents.add('handoff');
      }
    }

    if (result.order_change) {
      const change = await this.handleOrderChange(companyId, conversation, channelUser, result.order_change, who);
      if (change.intent) intents.add(change.intent);
      if (change.invoice) invoiceOrderIds.push(change.invoice);
      if (change.hold) replyOverride = changeHoldMessage(result.language);
      if (change.unavailable) replyOverride = unavailableMessage(result.language, change.unavailable);
      if (change.handoff) {
        await this.handoff(companyId, conversation, channelUser, 'bot_handoff', change.handoff);
        intents.add('handoff');
      }
    }

    if (result.cancel_request) {
      const cancel = await this.handleCancel(companyId, conversation, channelUser, result.cancel_request, who);
      if (cancel.intent) intents.add(cancel.intent);
      if (cancel.handoff) {
        await this.handoff(companyId, conversation, channelUser, 'bot_handoff', cancel.handoff);
        intents.add('handoff');
      }
    }

    if (result.booking_change) {
      const change = await this.handleBookingChange(companyId, conversation, channelUser, result.booking_change, result.language, who);
      if (change.intent) intents.add(change.intent);
      if (change.replyOverride) replyOverride = change.replyOverride;
      if (change.invoice && !invoiceBookingIds.includes(change.invoice)) invoiceBookingIds.push(change.invoice);
    }

    if (result.booking_cancel) {
      const cancelled = await this.handleBookingCancel(companyId, conversation, channelUser, result.booking_cancel, who);
      if (cancelled) intents.add('booking_cancelled');
    }

    if (result.send_invoice) {
      if (result.send_invoice.booking_id) {
        const bookingRow = await this.findOpenBooking(companyId, channelUser.id, result.send_invoice.booking_id, true);
        if (bookingRow && !invoiceBookingIds.includes(bookingRow.id)) invoiceBookingIds.push(bookingRow.id);
        if (bookingRow) intents.add('invoice');
      } else {
        const order = await this.findInvoiceOrder(companyId, channelUser.id, result.send_invoice.order_id);
        if (order && !invoiceOrderIds.includes(order.id)) invoiceOrderIds.push(order.id);
        if (order) intents.add('invoice');
      }
    }

    for (const note of result.notes ?? []) {
      await this.handleSpecialNote(companyId, conversation, channelUser, note, savedOrderId, session, who);
      intents.add('note');
    }

    if (result.handoff?.needed && !intents.has('handoff')) {
      await this.handoff(companyId, conversation, channelUser, 'bot_handoff', result.handoff.reason || 'The bot asked for a person.');
      intents.add('handoff');
    }
    return { intent: intents.size ? [...intents].join(',') : null, replyOverride, invoiceOrderIds, invoiceBookingIds };
  }

  /** A booking of this customer (requested / confirmed; any status when `any`), or their latest open one. */
  private async findOpenBooking(companyId: number, channelUserId: number, bookingId?: number, any = false): Promise<BotBooking | null> {
    const qb = this.bookingRepository.createQueryBuilder('b')
      .where('b.company_id = :companyId AND b.bot_channel_user_id = :channelUserId', { companyId, channelUserId });
    if (!any) qb.andWhere("b.status IN ('requested', 'confirmed')");
    if (bookingId) qb.andWhere('b.id = :bookingId', { bookingId: Number(bookingId) });
    return qb.orderBy('b.id', 'DESC').getOne();
  }

  private appendBookingNote(row: BotBooking, text: string) {
    const now = sriLankaNow();
    const stamp = `${now.date} ${now.label.split(' ').pop()}`; // 2026-10-10 14:20
    row.notes = [String(row.notes ?? '').trim(), `[${stamp}] ${text}`].filter(Boolean).join('\n').slice(-4000);
  }

  /**
   * Customer changes an open booking (like a Pending order): new date / time / service, checked against the
   * booked times (its own old time does not count). A confirmed booking goes back to "requested" – the team
   * confirms the new time. A note records what changed.
   */
  private async handleBookingChange(companyId: number, conversation: BotConversation, channelUser: BotChannelUser,
    change: NonNullable<SalesBotResult['booking_change']>, language: string, who: string): Promise<{ intent: string | null; replyOverride?: string; invoice?: number }> {
    const row = await this.findOpenBooking(companyId, channelUser.id, change.booking_id);
    if (!row) return { intent: null };
    const request = String(change.request ?? '').trim() || 'wants to change the booking';
    const service = change.service_id && Number(change.service_id) !== Number(row.service_id)
      ? await this.serviceRepository.findOne({ where: { id: Number(change.service_id), company_id: companyId } })
      : null;
    const date = normalizeBookingDate(change.date) ?? row.date;
    const start = bookingMinutes(change.time) ?? bookingMinutes(row.time);
    const time = start == null ? row.time : formatMinutes(start);
    const before = `${row.service_name} ${row.date} ${row.time}`.trim();
    const serviceId = service?.id ?? row.service_id;

    const taken = await this.bookingRepository.manager.transaction(async (manager) => {
      if (start != null && normalizeBookingDate(date)) {
        await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [companyId, date]);
        const day = await this.contextService.bookingDay(companyId, date, { excludeId: row.id });
        const duration = day.durationOf(serviceId);
        if (!isFree(day.busy, start, start + duration, day.capacity)) return nearestFreeTimes(day.busy, start, duration, day.capacity, 3, day.window);
      }
      if (service) {
        row.service_id = service.id;
        row.service_name = service.name;
        row.price = Number(service.price) || null;
        row.duration_min = service.duration_min ?? null;
      }
      const wasConfirmed = row.status === 'confirmed';
      row.date = date;
      row.time = time;
      if (change.notes?.trim()) this.appendBookingNote(row, `Customer note: ${change.notes.trim()}`);
      this.appendBookingNote(row, `✏️ Changed by the customer: ${before} → ${row.service_name} ${date} ${time} (${request})${wasConfirmed ? ' – was confirmed, please confirm the new time' : ''}`);
      if (wasConfirmed) row.status = 'requested';
      await manager.save(row);
      return null;
    });
    if (taken) return { intent: null, replyOverride: slotTakenMessage(language, date, start as number, taken) };
    await this.notifyTeam(companyId, 'booking_changed', 'MEDIUM', `Booking #${row.id} changed by the customer`,
      `${who}: ${before} → ${row.service_name} ${row.date} ${row.time}`, conversation.id);
    await this.advanceLead(conversation.id, 'won', { booking: `${row.service_name} ${row.date} ${row.time}`.trim() });
    return { intent: 'booking_changed', invoice: row.id };
  }

  /** Customer cancels an open booking: cancelled right away (the time is free again), with a note and a team alert. */
  private async handleBookingCancel(companyId: number, conversation: BotConversation, channelUser: BotChannelUser,
    cancel: NonNullable<SalesBotResult['booking_cancel']>, who: string): Promise<boolean> {
    const row = await this.findOpenBooking(companyId, channelUser.id, cancel.booking_id);
    if (!row) return false;
    const reason = String(cancel.reason ?? '').trim() || 'no reason given';
    this.appendBookingNote(row, `❌ Cancelled by the customer: ${reason}`);
    row.status = 'cancelled';
    await this.bookingRepository.save(row);
    await this.notifyTeam(companyId, 'booking_cancelled', 'MEDIUM', `Booking #${row.id} cancelled by the customer`,
      `${who}: ${row.service_name} ${row.date} ${row.time} – ${reason}`, conversation.id);
    return true;
  }

  /* ───────────────── Follow-ups (interested customers who went quiet) ───────────────── */

  /**
   * The customer's last message: id + time as a real instant. bot_message.created_at has no time zone, so it is
   * converted in SQL with the same session time zone that wrote it (safe whatever TZ the server or database uses).
   */
  private async lastInbound(conversationId: number): Promise<{ id: number; at: Date } | null> {
    const [row] = (await this.conversationRepository.query(
      `SELECT id, created_at::timestamptz AS at FROM bot_message WHERE conversation_id = $1 AND direction::text = 'inbound' ORDER BY id DESC LIMIT 1`,
      [conversationId])) as Array<{ id: number; at: Date }>;
    if (!row) return null;
    const at = new Date(row.at);
    return { id: Number(row.id), at: at.getTime() > Date.now() ? new Date() : at };
  }

  private static hoursOf(settings: { followup_first_hours?: number | string | null; followup_second_hours?: number | string | null }) {
    return { firstHours: Number(settings.followup_first_hours ?? 3), secondHours: Math.min(22, Number(settings.followup_second_hours ?? 22)) };
  }

  /** After every bot reply: plan follow-up 1, or mark the chat converted / stopped. */
  private async planFollowUpAfterReply(companyId: number, conversation: BotConversation, result: SalesBotResult,
    outcome: Outcome, session: BotSession) {
    if (!result.interest && (result.usage.calls ?? 1) === 0) return; // no AI call ("thanks", welcome): nothing new
    const current = await this.conversationRepository.findOne({ where: { id: conversation.id }, relations: ['channelUser'] });
    if (!current) return;
    const intents = String(outcome.intent ?? '').split(',');
    const off = current.followup_status === 'off'; // the team switched follow-ups off for this chat: never change that
    const patch: Partial<Pick<BotConversation, 'followup_status' | 'followup_interest' | 'followup_note' | 'followup_due_at' | 'followup_count' | 'followup_quiet_since'>> = {
      followup_interest: result.interest ?? current.followup_interest ?? null,
    };
    if (result.followup_note) patch.followup_note = result.followup_note;
    // a person was asked for in the last 24 h, or an agent took the chat: no automatic follow-ups
    const handoffOpen = Boolean(current.channelUser?.manual_mode) || Number(session.handoff_at ?? 0) > Date.now() / 1000 - 24 * 3600;
    if (intents.includes('order') || intents.includes('booking')) {
      Object.assign(patch, { followup_status: off ? 'off' : current.followup_status ? 'converted' : null, followup_due_at: null });
    } else if (intents.includes('handoff') || handoffOpen) {
      Object.assign(patch, { followup_status: off ? 'off' : current.followup_status ? 'stopped' : null, followup_due_at: null });
    } else if (off) {
      patch.followup_due_at = null;
    } else if (result.interest === 'none') {
      // said no / not buying now: no follow-up (and an old order draft does not count any more)
      Object.assign(patch, { followup_status: current.followup_status === 'waiting' ? 'stopped' : current.followup_status, followup_due_at: null });
    } else if (result.interest === 'interested' || result.interest === 'ready' || (result.order?.items?.length && result.interest !== 'browsing')) {
      const settings = await this.contextService.getSettings(companyId);
      const last = await this.lastInbound(conversation.id);
      const quietSince = last?.at ?? new Date();
      const hours = SalesBotEngineService.hoursOf(settings);
      const due = settings.followup_enabled && !(await this.followUpCapReached(conversation.id))
        ? planFollowUp({ quietSince, number: 1, ...hours, now: new Date() }) ?? planFollowUp({ quietSince, number: 2, ...hours, now: new Date() })
        : null;
      Object.assign(patch, { followup_status: due ? 'waiting' : null, followup_due_at: due, followup_count: 0, followup_quiet_since: quietSince });
      await this.advanceLead(conversation.id, 'qualified', { interest: result.interest, wants: result.followup_note });
    } else {
      // browsing: no follow-up
      Object.assign(patch, { followup_status: current.followup_status === 'waiting' ? null : current.followup_status, followup_due_at: null });
    }
    await this.conversationRepository.update(conversation.id, patch);
  }

  /** Never more than 2 follow-ups in 24 hours or 4 in 7 days for one chat (whatever happens in between). */
  private async followUpCapReached(conversationId: number): Promise<boolean> {
    const [row] = (await this.conversationRepository.query(
      `SELECT COUNT(*) FILTER (WHERE created_at::timestamptz > NOW() - INTERVAL '24 hours')::int AS day,
              COUNT(*)::int AS week
         FROM bot_message WHERE conversation_id = $1 AND intent LIKE 'followup_%' AND created_at::timestamptz > NOW() - INTERVAL '7 days'`,
      [conversationId])) as Array<{ day: number; week: number }>;
    return Number(row?.day ?? 0) >= 2 || Number(row?.week ?? 0) >= 4;
  }

  /** A new customer message cancels the planned follow-up (the reply to it plans a new one). */
  private async cancelPlannedFollowUp(conversationId: number) {
    await this.conversationRepository.query(
      `UPDATE bot_conversation SET followup_due_at = NULL, followup_status = NULL WHERE id = $1 AND followup_status = 'waiting'`, [conversationId]);
  }

  private followUpBusy = false;

  /** Sends the follow-ups that are due (runs every minute). */
  async runDueFollowUps() {
    if (this.followUpBusy) return;
    this.followUpBusy = true;
    try {
      const raw: unknown = await this.conversationRepository.query(
        `UPDATE bot_conversation SET followup_due_at = NULL
          WHERE id IN (SELECT id FROM bot_conversation WHERE followup_status = 'waiting' AND followup_due_at <= NOW()
                        ORDER BY followup_due_at LIMIT 20 FOR UPDATE SKIP LOCKED)
          RETURNING id`);
      // postgres UPDATE … RETURNING comes back as [rows, count]
      const rows = (Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw) as Array<{ id: number }>;
      for (const row of rows) {
        const id = Number(row.id);
        if (this.running.has(id) || this.timers.has(id)) {
          // the customer is writing right now: their reply plans again
          await this.conversationRepository.query(`UPDATE bot_conversation SET followup_status = NULL WHERE id = $1 AND followup_status = 'waiting'`, [id]);
          continue;
        }
        this.running.add(id);
        try {
          await this.sendFollowUp(id);
        } catch (error) {
          this.logger.warn(`follow-up for conversation ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
          await this.retryFollowUp(id);
        } finally {
          this.running.delete(id);
        }
      }
    } finally {
      this.followUpBusy = false;
    }
  }

  /** A temporary problem (AI / network): try again in 10 minutes while the 24-hour window allows it. */
  private async retryFollowUp(conversationId: number) {
    const conversation = await this.conversationRepository.findOne({ where: { id: conversationId } });
    if (!conversation || conversation.followup_status !== 'waiting') return;
    const quiet = conversation.followup_quiet_since ? new Date(conversation.followup_quiet_since).getTime() : 0;
    const retryAt = new Date(Date.now() + 10 * 60_000);
    const ok = quiet && retryAt.getTime() < quiet + FOLLOWUP_WINDOW_HOURS * 3_600_000 - 15 * 60_000;
    await this.conversationRepository.query(
      `UPDATE bot_conversation SET followup_due_at = $2, followup_status = $3 WHERE id = $1 AND followup_status = 'waiting'`,
      [conversationId, ok ? retryAt : null, ok ? 'waiting' : null]);
  }

  private async sendFollowUp(conversationId: number) {
    const conversation = await this.conversationRepository.findOne({ where: { id: conversationId }, relations: ['channelUser'] });
    const channelUser = conversation?.channelUser;
    if (!conversation || !channelUser || conversation.followup_status !== 'waiting') return;
    const end = (status: string | null) =>
      this.conversationRepository.query(`UPDATE bot_conversation SET followup_status = $2, followup_due_at = NULL WHERE id = $1 AND followup_status = 'waiting'`, [conversationId, status]);
    const companyId = Number(channelUser.company_id);
    const settings = await this.contextService.getSettings(companyId);
    if (!settings.followup_enabled) return end('stopped');

    const lastIn = await this.lastInbound(conversationId);
    const last = await this.messageRepository.findOne({ where: { conversation_id: conversationId }, order: { id: 'DESC' } });
    if (!lastIn || !last || last.direction === 'inbound') return end(null); // the customer answered: their reply plans again
    const quietSince = lastIn.at;
    const planned = conversation.followup_quiet_since ? new Date(conversation.followup_quiet_since).getTime() : 0;
    if (Math.abs(planned - quietSince.getTime()) > 5_000) return end(null); // planned for an older message
    if (Date.now() - quietSince.getTime() > FOLLOWUP_WINDOW_HOURS * 3_600_000) return end(Number(conversation.followup_count) > 0 ? 'sent' : 'expired');
    // a person wrote after the customer (agent reply, template, broadcast) or the chat is with the team → stop
    const others = await this.messageRepository.createQueryBuilder('m')
      .where('m.conversation_id = :conversationId AND m.id > :after', { conversationId, after: lastIn.id })
      .andWhere("m.direction::text = 'outbound'")
      .andWhere("COALESCE(m.source, '') <> :bot", { bot: BOT_SOURCE })
      .getCount();
    const handedOver = Number((this.readSessionState(channelUser.session_state).sales_bot as BotSession | undefined)?.handoff_at ?? 0) > Date.now() / 1000 - 24 * 3600;
    if (others || handedOver || channelUser.manual_mode) return end('stopped');
    const simulated = String((await this.messageRepository.findOne({ where: { id: lastIn.id } }))?.provider_message_id ?? '').startsWith('sim-');
    if (simulated && !SalesBotEngineService.testMode()) return end('stopped');
    const company = await this.companyRepository.findOne({ where: { id: companyId } });
    if (!(await this.botMayReply(company, conversation, channelUser, simulated))) return end('stopped');
    const ordered = await this.orderRepository.createQueryBuilder('o')
      .where('o.company_id = :companyId AND o.bot_channel_user_id = :userId AND o.created_at::timestamptz >= :since',
        { companyId, userId: channelUser.id, since: quietSince })
      .getCount();
    if (ordered) return end('converted');
    const optedOut = (await this.conversationRepository.query(
      'SELECT 1 FROM marketing_optout WHERE company_id = $1 AND bot_channel_user_id = $2 LIMIT 1', [companyId, channelUser.id]).catch(() => [])) as unknown[];
    if (optedOut.length) return end('stopped');
    if (await this.followUpCapReached(conversationId)) return end('sent');

    const hours = SalesBotEngineService.hoursOf(settings);
    const max = hours.secondHours > 0 ? 2 : 1;
    const number = Number(conversation.followup_count ?? 0) + 1;
    if (number > max) return end('sent');
    const anyTime = SalesBotEngineService.testMode() && process.env.SALES_BOT_FOLLOWUP_ANY_TIME === 'true'; // tests only
    if (!anyTime && !isDaytime(new Date())) {
      const due = planFollowUp({ quietSince, number: number as 1 | 2, ...hours, now: new Date(), lastSentAt: conversation.followup_last_at });
      if (due) await this.conversationRepository.query(`UPDATE bot_conversation SET followup_due_at = $2 WHERE id = $1 AND followup_status = 'waiting'`, [conversationId, due]);
      else await end(number > 1 ? 'sent' : 'expired');
      return;
    }

    const social = socialPlatformOf(channelUser.platform);
    const channel = simulated || social ? null : await this.whatsappService.getChannelForCompany(companyId).catch(() => null);
    const sessionState = this.readSessionState(channelUser.session_state);
    const session: BotSession = (sessionState.sales_bot as BotSession) ?? {};
    const context = await this.contextService.build(companyId, channelUser.id, social ?? 'whatsapp', { conversationId });
    const result = await this.client.reply({
      company_id: companyId, customer_id: channelUser.id, message: '', history: await this.history(conversationId, last.id + 1),
      session: {
        language: session.language, pending_order: session.pending_order ?? null, channel: social ?? 'whatsapp', memory: session.memory ?? '',
        followup: { number, max, note: conversation.followup_note ?? '', hours_quiet: Math.round((Date.now() - quietSince.getTime()) / 3_600_000) },
      },
      media: null, context,
    });
    await this.usageRepository.save(this.usageRepository.create({
      company_id: companyId, conversation_id: conversationId, model: result.usage.model,
      input_tokens: result.usage.input_tokens, cached_tokens: result.usage.cached_tokens, output_tokens: result.usage.output_tokens,
      calls: result.usage.calls ?? 1, cost_usd: result.usage.cost_usd, latency_ms: result.usage.latency_ms, is_test: false,
    }));
    if (!result.reply) return end(null);
    // last check right before sending: the customer wrote, or the team stopped it, while the AI was thinking
    const newest = await this.messageRepository.findOne({ where: { conversation_id: conversationId }, order: { id: 'DESC' } });
    const fresh = await this.conversationRepository.findOne({ where: { id: conversationId } });
    if ((newest && newest.id !== last.id) || fresh?.followup_status !== 'waiting' || this.timers.has(conversationId)) return;
    const delivered = await this.sendText(companyId, conversation, channelUser, channel, result.reply, `followup_${number}`, simulated);
    if (!delivered) {
      await this.retryFollowUp(conversationId);
      return;
    }
    const sentAt = new Date();
    const next = number < max ? planFollowUp({ quietSince, number: 2, ...hours, now: sentAt, lastSentAt: sentAt }) : null;
    await this.conversationRepository.query(
      `UPDATE bot_conversation SET followup_count = $2, followup_total = followup_total + 1, followup_last_at = $3,
              followup_due_at = $4, followup_status = $5
        WHERE id = $1 AND followup_status = 'waiting' AND followup_count = $6`,
      [conversationId, number, sentAt, next, next ? 'waiting' : 'sent', number - 1]);
    this.pusherService.trigger(`company-${companyId}`, 'conversation_updated', { conversation_id: conversationId, followup: number });
    this.logger.log(`conv ${conversationId}: follow-up ${number} sent, $${result.usage.cost_usd.toFixed(5)}`);
  }

  /* ───────────────── Special notes, order changes, cancellations, lead stages ───────────────── */

  /** Alert for the team: stored for the Notifications feed + live event for open dashboards. */
  private async notifyTeam(companyId: number, kind: BotNotificationKind, priority: 'LOW' | 'MEDIUM' | 'HIGH',
    title: string, message: string, conversationId: number | null, orderId: number | null = null) {
    await this.notificationRepository.save(this.notificationRepository.create({
      company_id: companyId, kind, priority, title: title.slice(0, 255), message, conversation_id: conversationId, order_id: orderId,
    }));
    this.pusherService.trigger(`company-${companyId}`, 'bot_notification', { kind, priority, title, message, conversation_id: conversationId, order_id: orderId });
  }

  /** Adds a dated line to the order's note (admin_note), keeping what is already there. */
  private async appendOrderNote(orderId: number, line: string) {
    const order = await this.orderRepository.findOne({ where: { id: orderId } });
    if (!order) return;
    const next = [order.admin_note?.trim(), `${line} (${stamp()})`].filter(Boolean).join('\n');
    await this.orderRepository.update(orderId, { admin_note: next.slice(-5000) });
  }

  /** The order the customer wants an invoice for: the one they named, else their newest non-cancelled order. */
  private async findInvoiceOrder(companyId: number, channelUserId: number, orderId?: number | null): Promise<BotOrder | null> {
    if (orderId) {
      const named = await this.orderRepository.findOne({ where: { id: Number(orderId), company_id: companyId, bot_channel_user_id: channelUserId } });
      if (named) return named;
    }
    return this.orderRepository
      .createQueryBuilder('o')
      .where('o.company_id = :companyId AND o.bot_channel_user_id = :channelUserId', { companyId, channelUserId })
      .andWhere("o.status::text <> 'Cancelled'")
      .orderBy('o.id', 'DESC')
      .getOne();
  }

  /** The order the customer named, else their newest order that is not delivered or cancelled. */
  private async findOpenOrder(companyId: number, channelUserId: number, orderId?: number | null): Promise<BotOrder | null> {
    if (orderId) {
      const named = await this.orderRepository.findOne({ where: { id: Number(orderId), company_id: companyId, bot_channel_user_id: channelUserId }, relations: ['items'] });
      if (named) return named;
    }
    return this.orderRepository
      .createQueryBuilder('o')
      .leftJoinAndSelect('o.items', 'items')
      .where('o.company_id = :companyId AND o.bot_channel_user_id = :channelUserId', { companyId, channelUserId })
      .andWhere("o.status::text NOT IN ('Delivered', 'Cancelled')")
      .orderBy('o.id', 'DESC')
      .getOne();
  }

  /**
   * Moves the chat forward in Lead Management (never backwards, so manual moves are kept).
   * won / lost always apply (order saved / order cancelled).
   */
  private async advanceLead(conversationId: number, stage: LeadStage, details?: Record<string, unknown>) {
    const conversation = await this.conversationRepository.findOne({ where: { id: conversationId } });
    if (!conversation) return;
    const current = (conversation.lead_stage ?? 'new') as LeadStage;
    let next = current;
    if (stage === 'won' || stage === 'lost') next = stage;
    else if (current !== 'won' && current !== 'lost' && LEAD_RANK[stage] > LEAD_RANK[current]) next = stage;
    const cleaned = Object.fromEntries(Object.entries(details ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    const hasDetails = Object.keys(cleaned).length > 0;
    if (next === current && !hasDetails) return;
    await this.conversationRepository.update(conversationId, {
      lead_stage: next,
      ...(hasDetails ? { lead_details: { ...(conversation.lead_details ?? {}), ...cleaned, updated_at: new Date().toISOString() } } : {}),
    });
  }

  private async handleSpecialNote(companyId: number, conversation: BotConversation, channelUser: BotChannelUser,
    note: { text: string; about?: 'order' | 'customer' }, savedOrderId: number | null, session: BotSession, who: string) {
    if (note.about === 'order') {
      const order = savedOrderId ? { id: savedOrderId } : await this.findOpenOrder(companyId, channelUser.id);
      if (order) {
        await this.appendOrderNote(order.id, `📝 Special note: ${note.text}`);
        await this.notifyTeam(companyId, 'special_note', 'MEDIUM', `Special note on order #${order.id}`, `${who}: ${note.text}`, conversation.id, order.id);
        return;
      }
      if (session.pending_order) {
        // order not saved yet – the note goes into the order note when it is saved
        session.pending_order.notes = [...(session.pending_order.notes ?? []), note.text].slice(-10);
        await this.notifyTeam(companyId, 'special_note', 'LOW', `Special note from ${who}`, `${note.text} (for the order being placed)`, conversation.id);
        return;
      }
    }
    await this.noteRepository.save(this.noteRepository.create({
      company_id: companyId, bot_channel_user_id: channelUser.id, content: `📝 Special note from the customer: ${note.text}`,
      created_by_user_id: null, created_by_name: 'Sales bot',
    }));
    await this.notifyTeam(companyId, 'special_note', 'MEDIUM', `Special note from ${who}`, note.text, conversation.id);
  }

  /** Pending → the bot edits the order. Confirmed / Processing → request only. Shipped → request + a person. */
  private async handleOrderChange(companyId: number, conversation: BotConversation, channelUser: BotChannelUser,
    change: NonNullable<SalesBotResult['order_change']>, who: string): Promise<{ intent: string | null; invoice?: number; hold?: boolean; handoff?: string; unavailable?: string }> {
    const order = await this.findOpenOrder(companyId, channelUser.id, change.order_id);
    const request = String(change.request ?? '').trim() || 'wants to change the order';
    if (!order) return { intent: null };

    if (order.status !== 'Pending') {
      await this.appendOrderNote(order.id, `🔔 Customer asked to change the order: ${request}`);
      await this.notifyTeam(companyId, 'change_request', 'HIGH', `Change request for order #${order.id} (${order.status})`, `${who}: ${request}`, conversation.id, order.id);
      return order.status === 'Shipped'
        ? { intent: 'change_request', handoff: `Order #${order.id} already shipped – customer wants a change: ${request}` }
        : { intent: 'change_request' };
    }

    // Pending: apply the change – prices and delivery fee are recalculated here, never taken from the AI
    let items = order.items ?? [];
    let weight = Number(order.total_weight_kg ?? 0);
    if (change.items?.length) {
      const priced = await this.priceItems(companyId, change.items);
      // an item that is not available now → tell the customer, the order stays as it is
      if (priced.problem.startsWith('unavailable:')) return { intent: null, unavailable: priced.problem.slice(12) };
      if (priced.problem || !priced.items.length) {
        await this.appendOrderNote(order.id, `🔔 Customer asked to change the order (not applied automatically: ${priced.problem || 'no items'}): ${request}`);
        await this.notifyTeam(companyId, 'change_request', 'HIGH', `Change request for order #${order.id}`, `${who}: ${request}`, conversation.id, order.id);
        return { intent: 'change_request', hold: true };
      }
      await this.orderItemRepository.delete({ order_id: order.id });
      for (const item of priced.items) {
        await this.orderItemRepository.save(this.orderItemRepository.create({
          order_id: order.id, product_id: item.product_id, product_name: item.product_name,
          variant_text: item.variant_name || null, quantity: item.quantity, unit_price: item.unit_price, total_price: item.total_price,
        }));
      }
      items = await this.orderItemRepository.find({ where: { order_id: order.id } });
      weight = Math.round(priced.items.reduce((sum, item) => sum + item.weight_kg * item.quantity, 0) * 1000) / 1000;
    }
    const subtotal = items.reduce((sum, item) => sum + Number(item.total_price || 0), 0);
    const zones = await this.zoneRepository.find({ where: { company_id: companyId } });
    const area = String(change.delivery_area ?? order.delivery_area ?? '').trim();
    const zone = area ? findZone(zones, area) : null;
    const freeOver = (await this.contextService.getSettings(companyId)).free_delivery_over;
    const fee = zone ? orderDeliveryFee(zone, weight, subtotal, freeOver) : order.delivery_fee == null ? null : Number(order.delivery_fee);
    const phone = String(change.customer_phone ?? '').replace(/[^\d+]/g, '');
    await this.orderRepository.update(order.id, {
      total_amount: subtotal + (fee ?? 0), delivery_fee: fee, total_weight_kg: weight || null,
      delivery_area: zone?.area ?? order.delivery_area,
      ...(change.address?.trim() ? { address: change.address.trim() } : {}),
      ...(change.customer_name?.trim() ? { customer_name: change.customer_name.trim().slice(0, 255) } : {}),
      ...(phone.replace(/\D/g, '').length >= 9 ? { customer_phone: phone } : {}),
    });
    await this.orderHistoryRepository.save(this.orderHistoryRepository.create({
      order_id: order.id, status: 'Pending', message: `Order changed by the customer in chat (sales bot): ${request}`,
    }));
    await this.appendOrderNote(order.id, `✏️ Changed by the customer: ${request}`);
    await this.notifyTeam(companyId, 'order_changed', 'MEDIUM', `Order #${order.id} changed by the customer`, `${who}: ${request}`, conversation.id, order.id);
    await this.advanceLead(conversation.id, 'won', { order_value: subtotal + (fee ?? 0), order_id: order.id });
    return { intent: 'order_changed', invoice: order.id };
  }

  /** Pending → cancelled. Confirmed / Processing → request only (the team decides). Shipped → request + a person. */
  private async handleCancel(companyId: number, conversation: BotConversation, channelUser: BotChannelUser,
    cancel: NonNullable<SalesBotResult['cancel_request']>, who: string): Promise<{ intent: string | null; handoff?: string }> {
    const order = await this.findOpenOrder(companyId, channelUser.id, cancel.order_id);
    if (!order) return { intent: null };
    const reason = String(cancel.reason ?? '').trim() || 'no reason given';
    if (order.status === 'Pending') {
      await this.orderRepository.update(order.id, { status: 'Cancelled' });
      await this.orderHistoryRepository.save(this.orderHistoryRepository.create({
        order_id: order.id, status: 'Cancelled', message: `Cancelled by the customer in chat (sales bot): ${reason}`,
      }));
      await this.appendOrderNote(order.id, `❌ Cancelled by the customer: ${reason}`);
      await this.notifyTeam(companyId, 'order_cancelled', 'MEDIUM', `Order #${order.id} cancelled by the customer`, `${who}: ${reason}`, conversation.id, order.id);
      await this.advanceLead(conversation.id, 'lost', { lost_reason: reason });
      return { intent: 'cancelled' };
    }
    await this.appendOrderNote(order.id, `🔔 Customer requested cancellation: ${reason}`);
    await this.notifyTeam(companyId, 'cancel_request', 'HIGH', `Cancellation request for order #${order.id} (${order.status})`, `${who}: ${reason}`, conversation.id, order.id);
    return order.status === 'Shipped'
      ? { intent: 'cancel_request', handoff: `Order #${order.id} already shipped – customer wants to cancel: ${reason}` }
      : { intent: 'cancel_request' };
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
      if (product.is_available === false) return { items: priced, problem: `unavailable:${product.name}` };
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
        if (options[index].available === false) return { items: priced, problem: `unavailable:${product.name} (${variantLabel(options[index])})` };
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
    const fee = zone ? orderDeliveryFee(zone, totalWeight, subtotal, (await this.contextService.getSettings(companyId)).free_delivery_over) : null;
    const total = subtotal + (fee ?? 0);
    const address = String(order.address ?? '').trim();
    const name = String(order.customer_name ?? '').trim();
    const isSocial = socialPlatformOf(channelUser.platform) !== null;
    // WhatsApp: the chat number is the customer's phone. Messenger / Instagram: the chat id is not a phone, the customer must give one.
    const phone = String(order.customer_phone || (isSocial ? '' : channelUser.external_user_id) || '').replace(/[^\d+]/g, '');
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
    pending.notes = previous?.notes ?? [];
    if (!order.confirm_order) {
      session.pending_order = pending;
      if (summaryShown) await this.advanceLead(conversation.id, 'proposal', { order_value: total });
      return 'pending';
    }

    // Not available right now → the bot tells the customer and keeps helping (no hand-over)
    if (problem.startsWith('unavailable:')) {
      return problem;
    }
    // Something a person must look at (unknown product / variant, zero total)
    if (problem || subtotal <= 0) {
      session.pending_order = pending;
      return `blocked:${problem || 'total is zero'}`;
    }
    // Details missing → ask the customer (the bot keeps going)
    const missing = [
      !name ? 'name' : '', !address ? 'address' : '',
      isSocial && phone.replace(/\D/g, '').length < 9 ? 'phone number' : '',
    ].filter(Boolean);
    if (missing.length) {
      session.pending_order = { ...pending, summary_shown: false };
      return `ask:${missing.join(',')}`;
    }
    // The customer said yes but never saw the summary → show the real summary and ask again
    if (!previousShown) {
      session.pending_order = { ...pending, summary_shown: true };
      return 'summary';
    }

    const saved = await this.orderRepository.save(this.orderRepository.create({
      company_id: companyId, bot_channel_user_id: channelUser.id, customer_name: name, customer_phone: phone,
      address, status: 'Pending', total_amount: total, delivery_fee: fee, payment_method: pending.payment_method,
      total_weight_kg: totalWeight || null, delivery_area: pending.delivery_area,
      admin_note: ['Created by the sales bot.', ...(pending.notes ?? []).map((text) => `📝 Special note: ${text} (${stamp()})`)].join('\n'),
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
    await this.notifyTeam(companyId, 'new_order', 'LOW', `New order #${saved.id} from the sales bot`,
      `${name} – ${items.length} item(s), total Rs ${total.toLocaleString('en-LK')}${(pending.notes ?? []).length ? ' – has special notes' : ''}`, conversation.id, saved.id);
    await this.advanceLead(conversation.id, 'won', { order_value: total, order_id: saved.id, name });
    return `saved:${saved.id}`;
  }

  /** Bot stops for this customer and a person takes over (online agent, or the unassigned queue). */
  /**
   * A person is needed. Default: the bot KEEPS replying, the team gets a Client note + a notification and the
   * chat is routed to an agent. Setting "bot_off_on_handoff" = true switches the bot off for this customer (old behaviour).
   */
  async handoff(companyId: number, conversation: BotConversation, channelUser: BotChannelUser, reason: string, note: string) {
    const settings = await this.contextService.getSettings(companyId);
    if (settings.bot_off_on_handoff) {
      await this.channelUserRepository.update(channelUser.id, { bot_enabled: false, manual_mode: true });
    }
    const label = reason === 'order_check' ? 'Order needs a check' : reason === 'bot_error' ? 'Bot could not reply' : 'Customer needs a person';
    await this.noteRepository.save(this.noteRepository.create({
      company_id: companyId, bot_channel_user_id: channelUser.id, content: `🙋 ${label}: ${note}`,
      created_by_user_id: null, created_by_name: 'Sales bot',
    }));
    await this.notifyTeam(companyId, 'handoff', 'HIGH', `${label} – ${channelUser.display_name || channelUser.external_user_id}`,
      `${note}${settings.bot_off_on_handoff ? ' (bot switched off for this customer)' : ' (bot keeps replying)'}`, conversation.id);
    await this.conversationRepository.update(conversation.id, { queue_reason: reason, queue_note: note.slice(0, 500) });
    const fresh = await this.conversationRepository.findOne({ where: { id: conversation.id } });
    if (fresh && (fresh.status === 'open' || fresh.assigned_agent_id == null)) {
      await this.agentRoutingService.assignConversationRoundRobin(companyId, conversation.id).catch((error: unknown) =>
        this.logger.warn(`handoff routing failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.pusherService.trigger(`company-${companyId}`, 'conversation_updated', { conversation_id: conversation.id, handoff: reason });
  }
}
