/**
 * Website LIVE DEMO (public, no login) – self-contained module.
 *
 * Visitors chat with the REAL AI sales bot of one of the 7 industry demo companies (scripts/make-industry-demos.py,
 * logins <key>@demo.test). The demo can start "from an ad" (the bot gets the ad as its campaign, like a real
 * Click-to-WhatsApp ad chat). Every reply comes back with what the bot decided (language, lookups, order /
 * booking / lead / hand-over, interest, speed, credits) so the website can show HOW it answered.
 *
 * Nothing is saved: no customer, chat or order is created. Only an AI usage row (is_test) on the demo company,
 * so the cost is visible in Super admin. Protection: per-IP throttle, max 24 messages per demo chat, short
 * messages, and a daily cap for the whole site (PUBLIC_DEMO_DAILY_LIMIT, default 3000 replies). PUBLIC_DEMO=off disables it.
 *
 *   GET  /public/demo/businesses            → the demo businesses with their ad card (real product / service data)
 *   POST /public/demo/reply                 → { business, message, history, session, from_ad } → reply + analysis
 */
import { BadRequestException, Body, Controller, Get, HttpException, HttpStatus, Logger, Module, Post, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InjectDataSource } from '@nestjs/typeorm';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { DataSource } from 'typeorm';
import { SalesBotModule } from '../sales-bot/sales-bot.module';
import { SalesBotContextService, type ContextProduct, type SalesBotContext } from '../sales-bot/sales-bot-context.service';
import { SalesBotClient, type SalesBotResult, type SalesBotTurn } from '../sales-bot/sales-bot.client';
import { findZone, orderDeliveryFee } from '../sales-bot/delivery-fee';

type Ad = { headline: string; body: string; product?: string; service?: string; cta: string };
type DemoBusiness = { key: string; industry: string; ad: Ad; starters: string[] };

/** The 7 demo businesses (same keys as scripts/make-industry-demos.py) and the ad each one "runs". */
export const DEMO_BUSINESSES: DemoBusiness[] = [
  { key: 'novagadgets', industry: 'Online shops',
    ad: { headline: 'Nova Pods Pro – noise cancelling earbuds', body: '30 h battery · 1 year warranty · cash on delivery island-wide', product: 'Nova Pods Pro ANC Earbuds', cta: 'Send message' },
    starters: ['Price?', 'Black colour thiyenawada?', 'Kandy ta delivery kiyada?', 'Do you have a cheaper one?'] },
  { key: 'brightpath', industry: 'Education',
    ad: { headline: 'IELTS weekend batch – starts 9 November', body: '6 mock tests · Nugegoda or online · pay in 2-3 parts', service: 'IELTS Academic / General (10 weeks)', cta: 'Send message' },
    starters: ['Fees kiyada?', 'Online classes thiyenawada?', 'Can I pay in parts?', 'I want to talk to someone first'] },
  { key: 'glowandgo', industry: 'Beauty and health',
    ad: { headline: 'Glow before the weekend ✨', body: 'Hydra Glow Facial – deep cleanse and hydration · book on WhatsApp', service: 'Hydra glow facial', cta: 'Book now' },
    starters: ['Price?', 'Heta free da?', 'Mata acne thiyenawa', 'Oily skin ekata serum ekak'] },
  { key: 'spiceroute', industry: 'Food',
    ad: { headline: 'Kottu night 🔥 delivered hot', body: 'Chicken Kottu from Rs 1,250 · Nugegoda area in 30-45 minutes', product: 'Chicken Kottu', cta: 'Order now' },
    starters: ['2 chicken kottu large', 'Delkanda ta delivery?', 'Table ekak 6 denekta raa 8', 'Catering 50 people'] },
  { key: 'islandtrails', industry: 'Travel and tourism',
    ad: { headline: 'Ella in December 🌄', body: '3 days with car, driver-guide and hotels', service: 'Ella & Nuwara Eliya 3D/2N tour', cta: 'Send message' },
    starters: ['Price for 2?', 'Dec 20-22 puluwanda?', 'Airport pickup thiyenawada?', 'Maldives package?'] },
  { key: 'goldenvows', industry: 'Weddings and events',
    ad: { headline: 'Your dream wedding, planned for you', body: 'Planning, decor, photo and video · free consultation', service: 'Gold wedding package', cta: 'Send message' },
    starters: ['Wedding ekak plan karanna ona', 'Feb 14 free da?', 'Poruwa decor price?', 'Photography only?'] },
  { key: 'apexsolar', industry: 'High-value sales',
    ad: { headline: 'Cut your electricity bill with solar ☀️', body: 'Tier-1 panels · Huawei inverters · free site inspection', product: '5 kW On-Grid Solar System', cta: 'Get a quote' },
    starters: ['Price?', 'Bill eka 20,000 witharai', 'Power cut welawata backup ona', 'Loan ekak ganna puluwanda?'] },
];
const KEYS = DEMO_BUSINESSES.map((b) => b.key);
const MAX_TURNS = 24;

export class DemoReplyDto {
  @IsString() @IsIn(KEYS) business!: string;
  @IsString() @MinLength(1) @MaxLength(400) message!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_TURNS * 2) history?: SalesBotTurn[];
  @IsOptional() @IsObject() session?: Record<string, unknown>;
  @IsOptional() @IsBoolean() from_ad?: boolean;
}

const rs = (n: number) => `Rs ${Math.round(n).toLocaleString('en-US')}`;

@Controller('public/demo')
@ApiTags('Public')
export class PublicDemoController {
  private readonly logger = new Logger('PublicDemo');
  private readonly client = new SalesBotClient();
  private companyIds = new Map<string, { id: number; at: number }>();
  private day = '';
  private repliesToday = 0;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly contextService: SalesBotContextService,
  ) {}

  private enabled() {
    return String(process.env.PUBLIC_DEMO ?? 'on').toLowerCase() !== 'off' && SalesBotClient.isConfigured();
  }

  private async companyId(key: string): Promise<number> {
    const hit = this.companyIds.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.id;
    const [row] = await this.dataSource.query(
      `SELECT c.id FROM companies c JOIN app_user u ON u.id = c.admin_user_id WHERE LOWER(u.email) = $1 LIMIT 1`, [`${key}@demo.test`]);
    if (!row) throw new ServiceUnavailableException('This demo business is not set up yet.');
    this.companyIds.set(key, { id: Number(row.id), at: Date.now() });
    return Number(row.id);
  }

  private adCard(business: DemoBusiness, context: SalesBotContext) {
    const product = business.ad.product ? context.products.find((p) => p.name === business.ad.product) : undefined;
    const service = business.ad.service ? context.services.find((s) => s.name === business.ad.service) : undefined;
    return {
      headline: business.ad.headline, body: business.ad.body, cta: business.ad.cta,
      item: product ? {
        kind: 'product', id: product.id, name: product.name, price: product.price, description: product.description,
        points: product.selling_points, image_url: product.image_urls[0] ?? null,
        options: product.variants.filter((v) => v.available !== false).map((v) => v.name).slice(0, 8),
      } : service ? {
        kind: 'service', id: service.service_id, name: service.name, price: service.price, price_note: service.price_note,
        description: service.description, duration_min: service.duration_min,
      } : null,
    };
  }

  @Get('businesses')
  async businesses() {
    if (!this.enabled()) return { enabled: false, businesses: [] };
    const out: Array<Record<string, unknown>> = [];
    for (const business of DEMO_BUSINESSES) {
      try {
        const context = await this.contextService.build(await this.companyId(business.key), null, 'whatsapp');
        out.push({
          key: business.key, industry: business.industry, name: context.company.bot_name || context.company.name,
          about: context.company.about, greeting: context.company.greeting, type: context.company.business_type,
          ad: this.adCard(business, context), starters: business.starters,
        });
      } catch (error) {
        this.logger.warn(`demo ${business.key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { enabled: out.length > 0, businesses: out };
  }

  @Post('reply')
  @Throttle({ default: { limit: Number(process.env.PUBLIC_DEMO_PER_MINUTE ?? 12), ttl: 60_000 } })
  async reply(@Body() dto: DemoReplyDto) {
    if (!this.enabled()) throw new ServiceUnavailableException('The live demo is switched off right now.');
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.repliesToday = 0; }
    if (this.repliesToday >= Number(process.env.PUBLIC_DEMO_DAILY_LIMIT ?? 3000)) {
      throw new HttpException('The live demo is very busy today – please try again tomorrow or message us on WhatsApp.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const history = (dto.history ?? []).filter((t) => t && typeof t.text === 'string' && ['customer', 'bot'].includes(t.role))
      .map((t) => ({ role: t.role, text: t.text.slice(0, 1500) }));
    if (history.filter((t) => t.role === 'customer').length >= MAX_TURNS) {
      throw new BadRequestException('This demo chat is long enough – start a new one or create a free account to test with your own products.');
    }
    const business = DEMO_BUSINESSES.find((b) => b.key === dto.business)!;
    const companyId = await this.companyId(business.key);
    const context = await this.contextService.build(companyId, null, 'whatsapp');
    if (dto.from_ad) {
      const card = this.adCard(business, context);
      context.campaign = {
        source: 'ad', name: business.ad.headline, ad_headline: business.ad.headline, ad_body: business.ad.body, ad_type: 'ad',
        offer: '', instructions: '', product_ids: card.item?.kind === 'product' ? [card.item.id] : [], ends_at: null,
      };
    }
    this.repliesToday += 1;
    let result: SalesBotResult;
    try {
      result = await this.client.reply({
        company_id: companyId, customer_id: null, message: dto.message.trim(), history: history.slice(-20),
        session: dto.session ?? {}, media: null, context,
      });
    } catch (error) {
      this.logger.warn(`demo ${business.key}: ${error instanceof Error ? error.message : String(error)}`);
      throw new ServiceUnavailableException('The AI did not answer – please try again in a moment.');
    }
    await this.dataSource.query(`
      INSERT INTO bot_ai_usage (company_id, model, input_tokens, cached_tokens, output_tokens, calls, cost_usd, latency_ms, is_test)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)`,
      [companyId, result.usage.model, result.usage.input_tokens, result.usage.cached_tokens, result.usage.output_tokens,
        result.usage.calls ?? 1, result.usage.cost_usd, result.usage.latency_ms]).catch(() => undefined);
    const [credit] = await this.dataSource.query(`SELECT value FROM platform_setting WHERE key = 'credits'`).catch(() => []);
    const tokensPerCredit = Number(credit?.value?.tokens_per_credit) || 100_000;
    return this.present(result, context, tokensPerCredit);
  }

  /** The reply as the customer sees it + what the bot decided (nothing saved). */
  private present(result: SalesBotResult, context: SalesBotContext, tokensPerCredit: number) {
    const byId = new Map<number, ContextProduct>(context.products.map((p) => [p.id, p]));
    const messages = String(result.reply ?? '').split(/\n\s*\n/).map((m) => m.trim()).filter(Boolean).slice(0, 3);
    const photos = [...new Set(result.photo_product_ids ?? [])].map((id) => byId.get(id)).filter(Boolean).slice(0, 3)
      .map((p) => ({ id: p!.id, name: p!.name, price: p!.price, image_url: p!.image_urls[0] ?? null }));

    // order: re-priced from the catalogue, delivery fee from the zones – exactly like a real order
    let order: Record<string, unknown> | null = null;
    const items = (result.order?.items ?? []).map((item) => {
      const product = byId.get(Number(item.product_id));
      if (!product) return null;
      const variant = item.variant_id ? product.variants.find((v) => v.variant_id === Number(item.variant_id)) : undefined;
      const unit = variant?.price ?? product.price;
      const qty = Math.max(1, Number(item.quantity) || 1);
      return { name: product.name, option: String(variant?.name ?? '').replace(/^[^:]+:\s*/, ''), quantity: qty, total: unit * qty, kg: (variant?.weight_kg ?? product.weight_kg ?? 0) * qty };
    }).filter(Boolean) as Array<{ name: string; option: string; quantity: number; total: number; kg: number }>;
    if (items.length) {
      const subtotal = items.reduce((sum, i) => sum + i.total, 0);
      const zone = findZone(context.delivery_zones, result.order?.delivery_area ?? null);
      const fee = zone && result.order?.delivery_area ? orderDeliveryFee(zone, items.reduce((s, i) => s + i.kg, 0), subtotal, context.company.free_delivery_over ?? null) : null;
      order = {
        stage: result.order?.confirm_order ? 'confirmed' : result.order?.summary_shown ? 'summary' : 'cart',
        items: items.map((i) => ({ text: `${i.quantity} × ${i.name}${i.option ? ` (${i.option})` : ''}`, price: rs(i.total) })),
        delivery: fee == null ? null : { area: zone?.area && zone.area !== '*' ? zone.area : String(result.order?.delivery_area ?? '').replace('*', '').trim(), fee: rs(fee), days: zone?.days ?? '' },
        total: rs(subtotal + (fee ?? 0)), customer: [result.order?.customer_name, result.order?.address].filter(Boolean).join(', '),
      };
    }
    const decisions: string[] = [];
    if (order) decisions.push(order.stage === 'confirmed' ? 'Order confirmed (a real shop gets it in Orders + invoice PDF)' : order.stage === 'summary' ? 'Order summary with real prices and delivery fee' : 'Items added to the order');
    if (result.booking?.service_name || result.booking?.date) decisions.push(result.booking?.confirm ? 'Booking confirmed in a free time slot' : 'Booking: checking date and time');
    if (result.lead && Object.values(result.lead).some(Boolean)) decisions.push('Lead details saved for the sales team');
    if (result.handoff?.needed) decisions.push(`Handed to a team member${result.handoff.reason ? ` – ${result.handoff.reason}` : ''}`);
    if (photos.length) decisions.push(`Sent ${photos.length} product photo${photos.length > 1 ? 's' : ''}`);
    if (result.guard) decisions.push(`Safety check adjusted the reply (${result.guard})`);
    const credits = (result.usage.input_tokens + result.usage.output_tokens) / tokensPerCredit;
    return {
      messages, photos, order,
      booking: result.booking && (result.booking.service_name || result.booking.date) ? result.booking : null,
      lead: result.lead && Object.values(result.lead).some(Boolean) ? result.lead : null,
      handoff: result.handoff?.needed ? { reason: result.handoff.reason ?? '' } : null,
      analysis: {
        language: result.language, interest: result.interest ?? null, looked_up: result.tools_used ?? [], decisions,
        memory: result.memory ?? null, ms: result.usage.latency_ms, ai_calls: result.usage.calls ?? 1,
        credits: Math.round(credits * 1000) / 1000,
      },
      session: {
        ...(typeof result.memory === 'string' ? { memory: result.memory } : {}),
        language: result.language,
        pending_order: result.order?.confirm_order ? null : (result.order ?? null),
      },
    };
  }
}

@Module({
  imports: [SalesBotModule],
  controllers: [PublicDemoController],
})
export class PublicDemoModule {}
