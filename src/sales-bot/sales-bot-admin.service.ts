import { followUpView } from '../bot-admin/bot-admin.service';
import { isTestPhone, TEST_PHONE_PREFIX } from '../common/test-phone';
import { planFollowUp } from './follow-up';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { blockingStatuses, bookingMinutes, formatMinutes, isFree, nearestFreeTimes, normalizeBookingDate } from './booking-slots';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AgentRoutingService } from '../agent-routing/agent-routing.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { saveChatMedia } from '../bot-admin/chat-media.store';
import { BotChannelUser } from '../bot-admin/entities/bot-channel-user.entity';
import { BotConversation } from '../bot-admin/entities/bot-conversation.entity';
import { SalesBotHook } from '../common/sales-bot-hook';
import { Company } from '../company/entities/company.entity';
import type {
  BookingsQueryDto, CreateBotServiceDto, CreateDeliveryZoneDto, RepliesQueryDto, SalesBotTestDto,
  SimulateCustomerMessageDto, UpdateBookingNotesDto, UpdateBookingStatusDto, UpdateBotServiceDto, UpdateDeliveryZoneDto, UpdateSalesBotSettingsDto,
} from './dto/sales-bot.dto';
import { BotAiUsage } from './entities/bot-ai-usage.entity';
import { BotBooking } from './entities/bot-booking.entity';
import { BotDeliveryZone } from './entities/bot-delivery-zone.entity';
import { BotService } from './entities/bot-service.entity';
import { SalesBotSettings } from './entities/sales-bot-settings.entity';
import { SalesBotClient } from './sales-bot.client';
import { SalesBotContextService } from './sales-bot-context.service';
import { BotAdminService } from '../bot-admin/bot-admin.service';
import { BOT_SOURCE, SalesBotEngineService } from './sales-bot-engine.service';
import { PlanService } from '../platform/plan.service';
import { TokenQuotaService } from '../platform/token-quota.service';

type UploadedFile = { buffer: Buffer; mimetype: string; originalname: string; size: number };

export { effectiveSellsOf as effectiveSells } from './sales-bot-context.service';
import { effectiveSellsOf as effectiveSells } from './sales-bot-context.service';

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const PLACEHOLDER_LINE = /^\[[^\]]*\]$/;

@Injectable()
export class SalesBotAdminService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Company) private readonly companyRepository: Repository<Company>,
    @InjectRepository(SalesBotSettings) private readonly settingsRepository: Repository<SalesBotSettings>,
    @InjectRepository(BotService) private readonly serviceRepository: Repository<BotService>,
    @InjectRepository(BotDeliveryZone) private readonly zoneRepository: Repository<BotDeliveryZone>,
    @InjectRepository(BotBooking) private readonly bookingRepository: Repository<BotBooking>,
    @InjectRepository(BotAiUsage) private readonly usageRepository: Repository<BotAiUsage>,
    @InjectRepository(BotChannelUser) private readonly channelUserRepository: Repository<BotChannelUser>,
    @InjectRepository(BotConversation) private readonly conversationRepository: Repository<BotConversation>,
    private readonly contextService: SalesBotContextService,
    private readonly client: SalesBotClient,
    private readonly agentRoutingService: AgentRoutingService,
    private readonly planService: PlanService,
    private readonly tokenQuota: TokenQuotaService,
    private readonly botAdminService: BotAdminService,
  ) {}

  /** Same rule as the rest of the bot admin: only the company admin. */
  private async adminCompany(user: AuthenticatedUser): Promise<Company> {
    const companyId = Number(user.company_id);
    if (!Number.isFinite(companyId) || companyId <= 0) throw new ForbiddenException('Company not found.');
    const company = await this.companyRepository.findOne({ where: { id: companyId } });
    if (!company || Number(company.admin_user_id) !== Number(user.id)) {
      throw new ForbiddenException('Only the company admin can manage the sales bot.');
    }
    return company;
  }

  /* ───────────────────────── Services ───────────────────────── */

  private serviceView(row: BotService) {
    return { id: row.id, name: row.name, description: row.description, price: num(row.price), price_note: row.price_note, duration_min: row.duration_min, is_active: row.is_active, is_available: row.is_available !== false };
  }

  async listServices(user: AuthenticatedUser) {
    const company = await this.adminCompany(user);
    const rows = await this.serviceRepository.find({ where: { company_id: Number(company.id) }, order: { name: 'ASC' } });
    return rows.map((row) => this.serviceView(row));
  }

  /** Package limit: max services (null = unlimited) – same message style as the product limit. */
  private async assertServiceRoom(companyId: number) {
    const limits = await this.planService.limitsForCompany(companyId);
    if (limits.max_services == null) return;
    const current = await this.serviceRepository.count({ where: { company_id: companyId } });
    if (current + 1 <= limits.max_services) return;
    const currentPrice = Number(limits.package?.price_monthly ?? 0);
    const upgrade = (await this.planService.packages())
      .filter((p) => p.is_active && p.is_public && p.id !== limits.package?.id && Number(p.price_monthly) > currentPrice
        && (p.max_services == null || p.max_services > limits.max_services!))
      .sort((a, b) => Number(a.price_monthly) - Number(b.price_monthly))[0];
    throw new ForbiddenException({
      statusCode: 403, error: 'Forbidden', code: 'LIMIT_REACHED', feature: 'max_services', upgrade_to: upgrade?.name ?? null,
      message: `Your ${limits.package?.name ?? ''} package allows ${limits.max_services} services (you have ${current}).${upgrade ? ` Upgrade to ${upgrade.name} for more.` : ''}`,
    });
  }

  async createService(user: AuthenticatedUser, dto: CreateBotServiceDto) {
    const company = await this.adminCompany(user);
    await this.assertServiceRoom(Number(company.id));
    const saved = await this.serviceRepository.save(this.serviceRepository.create({
      company_id: Number(company.id), name: dto.name.trim(), description: dto.description?.trim() ?? '', price: dto.price,
      price_note: dto.price_note?.trim() ?? '', duration_min: dto.duration_min ?? null, is_active: dto.is_active ?? true, is_available: dto.is_available ?? true,
    }));
    return this.serviceView(saved);
  }

  async updateService(user: AuthenticatedUser, id: number, dto: UpdateBotServiceDto) {
    const company = await this.adminCompany(user);
    const row = await this.serviceRepository.findOne({ where: { id, company_id: Number(company.id) } });
    if (!row) throw new NotFoundException('Service not found.');
    if (dto.name !== undefined) row.name = dto.name.trim();
    if (dto.description !== undefined) row.description = dto.description.trim();
    if (dto.price !== undefined) row.price = dto.price;
    if (dto.price_note !== undefined) row.price_note = dto.price_note.trim();
    if (dto.duration_min !== undefined) row.duration_min = dto.duration_min ?? null;
    if (dto.is_active !== undefined) row.is_active = dto.is_active;
    if (dto.is_available !== undefined) row.is_available = dto.is_available;
    return this.serviceView(await this.serviceRepository.save(row));
  }

  async deleteService(user: AuthenticatedUser, id: number) {
    const company = await this.adminCompany(user);
    const result = await this.serviceRepository.delete({ id, company_id: Number(company.id) });
    if (!result.affected) throw new NotFoundException('Service not found.');
    return { id, removed: true };
  }

  /* ───────────────────────── Delivery zones ───────────────────────── */

  private zoneView(row: BotDeliveryZone) {
    return {
      id: row.id, area: row.area, fee: num(row.fee), days: row.days,
      included_kg: row.included_kg == null ? null : num(row.included_kg),
      per_extra_kg: row.per_extra_kg == null ? null : num(row.per_extra_kg),
      weight_rounding: row.weight_rounding || 'up',
    };
  }

  private async assertUniqueArea(companyId: number, area: string, exceptId?: number) {
    const existing = await this.zoneRepository
      .createQueryBuilder('z')
      .where('z.company_id = :companyId', { companyId })
      .andWhere('LOWER(TRIM(z.area)) = LOWER(TRIM(:area))', { area })
      .getOne();
    if (existing && existing.id !== exceptId) throw new BadRequestException(`"${area}" already has a delivery fee.`);
  }

  async listZones(user: AuthenticatedUser) {
    const company = await this.adminCompany(user);
    const rows = await this.zoneRepository.find({ where: { company_id: Number(company.id) }, order: { area: 'ASC' } });
    return rows.map((row) => this.zoneView(row));
  }

  async createZone(user: AuthenticatedUser, dto: CreateDeliveryZoneDto) {
    const company = await this.adminCompany(user);
    const area = dto.area.trim();
    await this.assertUniqueArea(Number(company.id), area);
    const saved = await this.zoneRepository.save(this.zoneRepository.create({
      company_id: Number(company.id), area, fee: dto.fee, days: dto.days?.trim() ?? '',
      included_kg: dto.included_kg ?? null, per_extra_kg: dto.per_extra_kg ?? null,
      weight_rounding: dto.weight_rounding ?? 'up',
    }));
    return this.zoneView(saved);
  }

  async updateZone(user: AuthenticatedUser, id: number, dto: UpdateDeliveryZoneDto) {
    const company = await this.adminCompany(user);
    const row = await this.zoneRepository.findOne({ where: { id, company_id: Number(company.id) } });
    if (!row) throw new NotFoundException('Delivery zone not found.');
    if (dto.area !== undefined) {
      await this.assertUniqueArea(Number(company.id), dto.area.trim(), id);
      row.area = dto.area.trim();
    }
    if (dto.fee !== undefined) row.fee = dto.fee;
    if (dto.days !== undefined) row.days = dto.days.trim();
    if (dto.included_kg !== undefined) row.included_kg = dto.included_kg ?? null;
    if (dto.per_extra_kg !== undefined) row.per_extra_kg = dto.per_extra_kg ?? null;
    if (dto.weight_rounding !== undefined) row.weight_rounding = dto.weight_rounding;
    return this.zoneView(await this.zoneRepository.save(row));
  }

  async deleteZone(user: AuthenticatedUser, id: number) {
    const company = await this.adminCompany(user);
    const result = await this.zoneRepository.delete({ id, company_id: Number(company.id) });
    if (!result.affected) throw new NotFoundException('Delivery zone not found.');
    return { id, removed: true };
  }

  /* ───────────────────────── Bookings ───────────────────────── */

  private bookingView(row: BotBooking) {
    return {
      id: row.id, service_id: row.service_id, service_name: row.service_name, date: row.date, time: row.time,
      customer_name: row.customer_name, customer_phone: row.customer_phone, notes: row.notes, status: row.status,
      conversation_id: row.conversation_id, created_at: row.created_at, updated_at: row.updated_at,
      price: row.price == null ? null : Number(row.price), duration_min: row.duration_min, invoice_url: row.invoice_url,
    };
  }

  async updateBookingNotes(user: AuthenticatedUser, id: number, dto: UpdateBookingNotesDto) {
    const company = await this.adminCompany(user);
    const row = await this.bookingRepository.findOne({ where: { id, company_id: Number(company.id) } });
    if (!row) throw new NotFoundException('Booking not found.');
    row.notes = dto.notes.trim();
    return this.bookingView(await this.bookingRepository.save(row));
  }

  async sendBookingInvoice(user: AuthenticatedUser, id: number) {
    const company = await this.adminCompany(user);
    const row = await this.bookingRepository.findOne({ where: { id, company_id: Number(company.id) } });
    if (!row) throw new NotFoundException('Booking not found.');
    return this.botAdminService.sendBookingInvoiceForCompany(Number(company.id), id);
  }

  async listBookings(user: AuthenticatedUser, query: BookingsQueryDto) {
    const company = await this.adminCompany(user);
    const rows = await this.bookingRepository.find({
      where: { company_id: Number(company.id), ...(query.status ? { status: query.status } : {}) },
      order: { created_at: 'DESC' },
      take: 500,
    });
    return rows.map((row) => this.bookingView(row));
  }

  async updateBookingStatus(user: AuthenticatedUser, id: number, dto: UpdateBookingStatusDto) {
    const company = await this.adminCompany(user);
    const row = await this.bookingRepository.findOne({ where: { id, company_id: Number(company.id) } });
    if (!row) throw new NotFoundException('Booking not found.');
    const companyId = Number(company.id);
    const settings = await this.contextService.getSettings(companyId);
    const start = bookingMinutes(row.time);
    const date = normalizeBookingDate(row.date);
    // moving a booking to a status that holds its time: the time must still be free
    if (dto.status !== row.status && blockingStatuses(settings.booking_block_status).includes(dto.status) && date && start != null) {
      const saved = await this.bookingRepository.manager.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [companyId, date]);
        const day = await this.contextService.bookingDay(companyId, date, { excludeId: row.id });
        const duration = day.durationOf(row.service_id);
        if (!isFree(day.busy, start, start + duration, day.capacity)) {
          const free = nearestFreeTimes(day.busy, start, duration, day.capacity, 3, day.window);
          throw new ConflictException(`${date} ${formatMinutes(start)} already has ${day.capacity > 1 ? `${day.capacity} bookings` : 'a booking'} at that time.` +
            ` Cancel or move the other booking first${free.length ? `, or offer the customer ${free.join(', ')}` : ''}.`);
        }
        row.status = dto.status;
        return manager.save(row);
      });
      return this.bookingView(saved);
    }
    row.status = dto.status;
    return this.bookingView(await this.bookingRepository.save(row));
  }

  /* ───────────────────────── Settings ───────────────────────── */

  private async settingsView(company: Company, settings: SalesBotSettings) {
    return {
      bot_enabled: (await this.planService.planAllowsBot(company.plan)) && Boolean(company.bot_enabled),
      bot_name: settings.bot_name, tone: settings.tone, default_language: settings.default_language || 'auto',
      greeting: settings.greeting, about: settings.about, opening_hours: settings.opening_hours,
      payment_methods: settings.payment_methods, auto_enable_new_customers: settings.auto_enable_new_customers,
      sells: settings.sells || 'auto', auto_send_invoice: settings.auto_send_invoice ?? true,
      bot_off_on_handoff: settings.bot_off_on_handoff ?? false,
      free_delivery_over: settings.free_delivery_over == null ? null : Number(settings.free_delivery_over),
      booking_block_status: settings.booking_block_status === 'confirmed' ? 'confirmed' : 'requested',
      booking_capacity: Math.max(1, Number(settings.booking_capacity ?? 1)),
      followup_enabled: settings.followup_enabled ?? true,
      followup_first_hours: Number(settings.followup_first_hours ?? 3),
      followup_second_hours: Number(settings.followup_second_hours ?? 22),
      /** what the dashboard should show: products page, services page, or both */
      sells_effective: effectiveSells(company, settings),
    };
  }

  /** For every signed-in user (admins and agents): which pages the dashboard shows. */
  async getSellsInfo(user: AuthenticatedUser) {
    const company = await this.companyRepository.findOne({ where: { id: Number(user.company_id) } });
    const settings = await this.contextService.getSettings(Number(user.company_id));
    return { sells: effectiveSells(company, settings) };
  }

  async getSettings(user: AuthenticatedUser) {
    const company = await this.adminCompany(user);
    return this.settingsView(company, await this.contextService.getSettings(Number(company.id)));
  }

  async updateSettings(user: AuthenticatedUser, dto: UpdateSalesBotSettingsDto) {
    const company = await this.adminCompany(user);
    if (dto.bot_enabled !== undefined && dto.bot_enabled !== Boolean(company.bot_enabled)) {
      if (dto.bot_enabled && !(await this.planService.planAllowsBot(company.plan))) {
        throw new ForbiddenException('AI replies need an active package.');
      }
      company.bot_enabled = dto.bot_enabled;
      await this.companyRepository.update(company.id, { bot_enabled: dto.bot_enabled });
    }
    const settings = await this.contextService.getSettings(Number(company.id));
    const fields = ['bot_name', 'tone', 'default_language', 'greeting', 'about', 'opening_hours', 'payment_methods', 'auto_enable_new_customers', 'sells', 'auto_send_invoice', 'bot_off_on_handoff', 'followup_enabled', 'followup_first_hours', 'followup_second_hours', 'free_delivery_over', 'booking_block_status', 'booking_capacity'] as const;
    for (const field of fields) {
      const value = dto[field];
      if (value !== undefined) (settings as unknown as Record<string, unknown>)[field] = typeof value === 'string' ? value.trim() : value;
    }
    const saved = await this.settingsRepository.save(settings);
    return this.settingsView(company, saved);
  }

  /* ───────────────────────── Follow-ups ───────────────────────── */

  private async companyConversation(companyId: number, conversationId: number) {
    const conversation = await this.conversationRepository.findOne({ where: { id: conversationId }, relations: ['channelUser'] });
    if (!conversation || Number(conversation.channelUser?.company_id) !== companyId) throw new NotFoundException('Conversation not found.');
    return conversation;
  }

  /** stop = no more follow-ups for this chat · resume = plan the next one again */
  async setFollowUp(user: AuthenticatedUser, conversationId: number, action: 'stop' | 'resume') {
    const company = await this.adminCompany(user);
    const conversation = await this.companyConversation(Number(company.id), conversationId);
    if (action === 'stop') {
      await this.conversationRepository.update(conversation.id, { followup_status: 'off', followup_due_at: null });
    } else {
      const settings = await this.contextService.getSettings(Number(company.id));
      // count from the customer's latest message (as a real instant, see SalesBotEngineService.lastInbound)
      const [last] = (await this.conversationRepository.query(
        `SELECT created_at::timestamptz AS at FROM bot_message WHERE conversation_id = $1 AND direction::text = 'inbound' ORDER BY id DESC LIMIT 1`,
        [conversation.id])) as Array<{ at: Date }>;
      const quietSince = last ? new Date(last.at) : null;
      const sameRound = quietSince && conversation.followup_quiet_since
        && Math.abs(new Date(conversation.followup_quiet_since).getTime() - quietSince.getTime()) < 5_000;
      const count = sameRound ? Number(conversation.followup_count ?? 0) : 0;
      const due = settings.followup_enabled && quietSince && count < 2
        ? planFollowUp({
            quietSince, number: (count + 1) as 1 | 2, now: new Date(),
            firstHours: Number(settings.followup_first_hours ?? 3), secondHours: Number(settings.followup_second_hours ?? 22),
            lastSentAt: sameRound ? conversation.followup_last_at : null,
          })
        : null;
      await this.conversationRepository.update(conversation.id, {
        followup_status: due ? 'waiting' : null, followup_due_at: due, followup_count: count, followup_quiet_since: quietSince,
      });
    }
    const fresh = await this.conversationRepository.findOneOrFail({ where: { id: conversation.id } });
    return { id: fresh.id, ...followUpView(fresh) };
  }

  /** Last 30 days: chats that got a follow-up, and how many of those customers ordered within 7 days after it. */
  async followUpStats(user: AuthenticatedUser) {
    const company = await this.adminCompany(user);
    const companyId = Number(company.id);
    const [row] = (await this.conversationRepository.query(
      `WITH fu AS (
         SELECT m.conversation_id, c.bot_channel_user_id, MIN(m.created_at::timestamptz) AS first_at, COUNT(*)::int AS n
           FROM bot_message m
           JOIN bot_conversation c ON c.id = m.conversation_id
           JOIN bot_channel_user u ON u.id = c.bot_channel_user_id
          WHERE u.company_id = $1 AND m.intent LIKE 'followup_%' AND m.created_at::timestamptz > NOW() - INTERVAL '30 days'
          GROUP BY m.conversation_id, c.bot_channel_user_id)
       SELECT COUNT(*)::int AS followed_up, COALESCE(SUM(n), 0)::int AS messages,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM bot_order o WHERE o.company_id = $1 AND o.bot_channel_user_id = fu.bot_channel_user_id
                  AND o.created_at::timestamptz >= fu.first_at AND o.created_at::timestamptz <= fu.first_at + INTERVAL '7 days'))::int AS converted
         FROM fu`, [companyId])) as Array<{ followed_up: number; messages: number; converted: number }>;
    const [waiting] = (await this.conversationRepository.query(
      `SELECT COUNT(*)::int AS n FROM bot_conversation c JOIN bot_channel_user u ON u.id = c.bot_channel_user_id
        WHERE u.company_id = $1 AND c.followup_status = 'waiting' AND c.followup_due_at IS NOT NULL`, [companyId])) as Array<{ n: number }>;
    const followedUp = Number(row?.followed_up ?? 0);
    const converted = Number(row?.converted ?? 0);
    return { waiting: Number(waiting?.n ?? 0), followed_up: followedUp, messages: Number(row?.messages ?? 0), converted,
      conversion_rate: followedUp ? Math.round((converted / followedUp) * 1000) / 10 : 0 };
  }

  /* ───────────────────────── Test chat ───────────────────────── */

  /** Nothing is saved or sent: only the AI usage row (marked as test) for cost tracking. */
  async testReply(user: AuthenticatedUser, dto: SalesBotTestDto) {
    const company = await this.adminCompany(user);
    if (!(await this.tokenQuota.canBotReply(Number(company.id)))) {
      throw new ForbiddenException('Your AI tokens for this month are used up. Renew or buy more tokens to use the bot.');
    }
    const context = await this.contextService.build(Number(company.id), null);
    const result = await this.client.reply({
      company_id: Number(company.id), customer_id: null, message: dto.message,
      history: (dto.history ?? []).slice(-20), session: dto.session ?? {}, media: null, context,
    });
    await this.usageRepository.save(this.usageRepository.create({
      company_id: Number(company.id), conversation_id: null, model: result.usage.model,
      input_tokens: result.usage.input_tokens, cached_tokens: result.usage.cached_tokens, output_tokens: result.usage.output_tokens,
      calls: result.usage.calls ?? 1, cost_usd: result.usage.cost_usd, latency_ms: result.usage.latency_ms, is_test: true,
    }));
    this.tokenQuota.forget(Number(company.id));
    // companies see tokens, never the AI cost (super admin only)
    const tpc = await this.planService.tokensPerCredit();
    return { ...result, usage: { ...result.usage, cost_usd: undefined, credits: Math.round(((result.usage.input_tokens + result.usage.output_tokens) / tpc) * 1000) / 1000 } };
  }

  /* ───────────────────────── Customer simulator ───────────────────────── */

  simulatorStatus() {
    return { test_mode: SalesBotEngineService.testMode() && SalesBotClient.isConfigured() };
  }

  private normalizePhone(phone: string) {
    return this.agentRoutingService.normalizePhone(phone);
  }

  async simulate(user: AuthenticatedUser, dto: SimulateCustomerMessageDto, file?: UploadedFile) {
    const company = await this.adminCompany(user);
    if (!SalesBotEngineService.testMode()) throw new ForbiddenException('Test mode is off (set SALES_BOT_TEST_MODE=true).');
    if (!SalesBotClient.isConfigured()) throw new ForbiddenException('The sales bot is not configured (SALES_BOT_URL).');
    const phone = this.normalizePhone(dto.phone);
    if (!isTestPhone(phone)) {
      throw new BadRequestException(`Simulator numbers must start with ${TEST_PHONE_PREFIX} (for example ${TEST_PHONE_PREFIX}771234567), so a test chat can never reach a real person.`);
    }
    const text = dto.text?.trim() ?? '';
    const kind = file?.mimetype?.startsWith('image/') ? 'image' : file?.mimetype?.startsWith('audio/') ? 'voice' : null;
    if (file && !kind) throw new BadRequestException('Only photos and voice notes are supported.');
    if (!phone || (!text && !kind)) throw new BadRequestException('Phone number and a message or file are required.');

    const mediaUrl = file && kind ? saveChatMedia(Number(company.id), file.buffer, file.mimetype, file.originalname) : null;
    const content = text || (kind === 'image' ? '[image]' : kind === 'voice' ? '[voice note]' : '');
    const routing = await this.agentRoutingService.handleWhatsAppInboundForRouting(Number(company.id), phone, dto.name?.trim() || undefined, {
      content, message_type: kind ?? 'text', media_url: mediaUrl, source: 'customer',
      provider_message_id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    if (routing.conversationId) {
      await SalesBotHook.notify({ companyId: Number(company.id), conversationId: routing.conversationId, phone, provider: 'simulator' });
    }
    const botNote = routing.conversationId ? await this.simulatorBotNote(company, routing.conversationId).catch(() => null) : null;
    return { conversation_id: routing.conversationId, bot_note: botNote };
  }

  /** Why the bot will NOT answer this simulator chat (null = it will answer). Same rules as the engine's botMayReply. */
  private async simulatorBotNote(company: Company, conversationId: number): Promise<string | null> {
    if (!(await this.planService.planAllowsBot(company.plan))) return 'Your package does not include the AI sales bot.';
    if (!company.bot_enabled) return 'The AI sales bot is switched off. Switch it on in AI Sales Bot settings.';
    if (!(await this.tokenQuota.canBotReply(Number(company.id)))) return 'No AI replies left (monthly limit used, or the package expired).';
    const conversation = await this.conversationRepository.findOne({ where: { id: conversationId }, relations: ['channelUser'] });
    if (!conversation?.channelUser) return null;
    if (conversation.status === 'active' || conversation.status === 'closed') {
      return 'A team member is handling this chat, so the bot stays quiet. Tap "New customer" or give the chat back to the bot in the inbox.';
    }
    if (!conversation.channelUser.bot_enabled && conversation.channelUser.manual_mode) {
      return 'The bot was switched off for this customer in the inbox. Tap "New customer" or switch the bot on for this chat.';
    }
    return null;
  }

  async findSimulatorConversation(user: AuthenticatedUser, phoneRaw: string) {
    const company = await this.adminCompany(user);
    const phone = this.normalizePhone(phoneRaw);
    if (!phone) return { conversation_id: null };
    const channelUser = await this.channelUserRepository.findOne({ where: { company_id: Number(company.id), platform: 'whatsapp', external_user_id: phone } });
    if (!channelUser) return { conversation_id: null };
    const conversation = await this.conversationRepository
      .createQueryBuilder('c')
      .where('c.bot_channel_user_id = :id', { id: channelUser.id })
      .andWhere("c.status <> 'closed'")
      .orderBy('c.id', 'DESC')
      .getOne();
    return { conversation_id: conversation?.id ?? null };
  }

  /* ───────────────────────── Reply review ───────────────────────── */

  async replies(user: AuthenticatedUser, query: RepliesQueryDto) {
    const company = await this.adminCompany(user);
    const limit = Math.min(Math.max(Number(query.limit) || 60, 1), 200);
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT b.id, b.conversation_id, b.content AS bot_reply, b.created_at, b.intent,
              cu.display_name AS customer_name, cu.external_user_id AS customer_phone,
              (SELECT string_agg(NULLIF(m.content, ''), E'\\n' ORDER BY m.id)
                 FROM bot_message m
                WHERE m.conversation_id = b.conversation_id AND m.direction::text = 'inbound' AND m.id < b.id
                  AND m.id > COALESCE((SELECT MAX(o.id) FROM bot_message o
                                        WHERE o.conversation_id = b.conversation_id AND o.direction::text = 'outbound' AND o.id < b.id), 0)
              ) AS customer_text,
              (SELECT string_agg(DISTINCT m.message_type::text, ',')
                 FROM bot_message m
                WHERE m.conversation_id = b.conversation_id AND m.direction::text = 'inbound' AND m.id < b.id
                  AND m.message_type::text <> 'text'
                  AND m.id > COALESCE((SELECT MAX(o.id) FROM bot_message o
                                        WHERE o.conversation_id = b.conversation_id AND o.direction::text = 'outbound' AND o.id < b.id), 0)
              ) AS media
         FROM bot_message b
         JOIN bot_conversation c ON c.id = b.conversation_id
         JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
        WHERE CAST(cu.company_id AS BIGINT) = CAST($1 AS BIGINT)
          AND b.direction::text = 'outbound' AND b.source = $2 AND b.message_type::text = 'text'
          AND ($3::text IS NULL OR b.intent LIKE '%' || $3 || '%')
        ORDER BY b.id DESC
        LIMIT $4`,
      [Number(company.id), BOT_SOURCE, query.only === 'handoff' ? 'handoff' : null, limit],
    );
    return rows.map((row) => {
      const customerText = String(row.customer_text ?? '')
        .split('\n').filter((line) => !PLACEHOLDER_LINE.test(line.trim())).join('\n').trim();
      return {
        id: Number(row.id), conversation_id: Number(row.conversation_id),
        customer_name: (row.customer_name as string) || null, customer_phone: String(row.customer_phone ?? ''),
        customer_text: customerText || null, media: (row.media as string) || null,
        bot_reply: String(row.bot_reply ?? ''), handed_off: String(row.intent ?? '').includes('handoff'), created_at: row.created_at,
      };
    });
  }

  /* ───────────────────────── Reports ───────────────────────── */

  async report(user: AuthenticatedUser, daysRaw?: number) {
    const company = await this.adminCompany(user);
    const companyId = Number(company.id);
    const maxDays = (await this.planService.limitsForCompany(companyId)).numbers.reports_days;
    const days = Math.min(Math.max(Number(daysRaw) || 30, 1), 365, maxDays ?? 365);
    const [summary] = await this.dataSource.query(
      `WITH since AS (SELECT NOW() - make_interval(days => $2::int) AS t)
       SELECT
         (SELECT COUNT(*) FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
           WHERE CAST(cu.company_id AS BIGINT) = $1 AND c.created_at > (SELECT t FROM since))::int AS conversations,
         (SELECT COUNT(*) FROM bot_order o WHERE CAST(o.company_id AS BIGINT) = $1 AND o.created_at > (SELECT t FROM since)
           AND o.status::text <> 'Cancelled')::int AS orders,
         (SELECT COALESCE(SUM(o.total_amount), 0) FROM bot_order o WHERE CAST(o.company_id AS BIGINT) = $1
           AND o.created_at > (SELECT t FROM since) AND o.status::text <> 'Cancelled') AS revenue,
         (SELECT COUNT(*) FROM bot_booking b WHERE b.company_id = $1 AND b.created_at > (SELECT t FROM since))::int AS bookings,
         (SELECT COUNT(*) FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id
           JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
           WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.source = $3 AND m.intent LIKE '%lead%' AND m.created_at > (SELECT t FROM since))::int AS leads,
         (SELECT COUNT(*) FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id
           JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
           WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.source = $3 AND m.intent LIKE '%handoff%' AND m.created_at > (SELECT t FROM since))::int AS handoffs,
         (SELECT COUNT(*) FROM bot_ai_usage u WHERE u.company_id = $1 AND NOT u.is_test AND u.created_at > (SELECT t FROM since))::int AS ai_replies,
         (SELECT COALESCE(SUM(u.input_tokens + u.output_tokens), 0) FROM bot_ai_usage u WHERE u.company_id = $1 AND u.created_at > (SELECT t FROM since)) AS ai_tokens,
         (SELECT COALESCE(AVG(u.latency_ms), 0) FROM bot_ai_usage u WHERE u.company_id = $1 AND NOT u.is_test AND u.created_at > (SELECT t FROM since)) AS avg_latency_ms,
         (SELECT COALESCE(AVG(u.calls), 0) FROM bot_ai_usage u WHERE u.company_id = $1 AND NOT u.is_test AND u.created_at > (SELECT t FROM since)) AS avg_calls`,
      [companyId, days, BOT_SOURCE],
    );
    const daily: Array<{ day: string; conversations: number; orders: number }> = await this.dataSource.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day,
              (SELECT COUNT(*) FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
                WHERE CAST(cu.company_id AS BIGINT) = $1 AND c.created_at::date = d::date)::int AS conversations,
              (SELECT COUNT(*) FROM bot_order o WHERE CAST(o.company_id AS BIGINT) = $1 AND o.created_at::date = d::date
                AND o.status::text <> 'Cancelled')::int AS orders
         FROM generate_series(CURRENT_DATE - ($2::int - 1), CURRENT_DATE, INTERVAL '1 day') d
        ORDER BY d`,
      [companyId, days],
    );
    const conversations = num(summary?.conversations);
    const orders = num(summary?.orders);
    const bookings = num(summary?.bookings);
    return {
      days, max_days: maxDays, conversations, orders, revenue: num(summary?.revenue), bookings, leads: num(summary?.leads),
      handoffs: num(summary?.handoffs), ai_replies: num(summary?.ai_replies), ai_tokens: num(summary?.ai_tokens),
      ai_credits: Math.round((num(summary?.ai_tokens) / (await this.planService.tokensPerCredit())) * 10) / 10,
      avg_latency_ms: Math.round(num(summary?.avg_latency_ms)), avg_calls: num(summary?.avg_calls),
      conversion: conversations ? (orders + bookings) / conversations : 0,
      daily: daily.map((row) => ({ day: row.day, conversations: num(row.conversations), orders: num(row.orders) })),
    };
  }
}
