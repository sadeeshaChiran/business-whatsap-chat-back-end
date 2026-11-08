/**
 * Shop API – the shop's own system (POS, website, ERP) talks to Agent Metra.
 *
 *  IN  (the shop calls us, header "Authorization: Bearer am_live_…" or "X-API-Key: am_live_…"):
 *    POST   /open/products                       add / update products by SKU (max 500 a call)
 *    PATCH  /open/products/:sku/availability     { available, variant_value? }  (a variant SKU works too)
 *    DELETE /open/products/:sku                  remove a product
 *    GET    /open/orders?status=&since=&limit=   orders (newest first)      GET /open/orders/:id
 *    PATCH  /open/orders/:id/status              { status }  – same as the dashboard: history + the customer's message
 *    GET    /open/bookings?status=&since=        bookings                   PATCH /open/bookings/:id/status { status }
 *
 *  OUT (we call the shop – webhook): order.created, order.status_changed, booking.created, booking.status_changed, ping.
 *    POST <url>  JSON { id, event, created_at, data }  header X-AgentMetra-Signature: t=<unix>,v1=<hex hmac_sha256(secret, "<t>.<body>")>
 *    A worker looks at orders / bookings every 20 s, so every change is sent whatever made it (bot, team, app, API).
 *    A failed call is tried again (1, 2, 4 … 60 min, 12 times). Test customers (999…) are never sent.
 *
 *  Settings (owner): GET /integrations/api, POST /integrations/api/keys, DELETE /integrations/api/keys/:id,
 *    PUT /integrations/api/webhook, POST /integrations/api/webhook/secret, POST /integrations/api/webhook/test
 *
 * The API acts as the company owner, so every rule of the dashboard applies (package limits, stock, booking times).
 */
import {
  BadRequestException, Body, CanActivate, Controller, createParamDecorator, Delete, ExecutionContext, ForbiddenException, Get, Injectable, Logger, Module,
  NotFoundException, OnModuleDestroy, OnModuleInit, Param, ParseIntPipe, Patch, Post, Put, Query, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InjectDataSource } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUrl, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { createHash, createHmac, randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AuthModule } from '../auth/auth.module';
import { BotAdminModule } from '../bot-admin/bot-admin.module';
import { BotAdminService } from '../bot-admin/bot-admin.service';
import { ProductsModule } from '../products/products.module';
import { ProductsService } from '../products/products.service';
import { SalesBotModule } from '../sales-bot/sales-bot.module';
import { SalesBotAdminService } from '../sales-bot/sales-bot-admin.service';
import { BOT_BOOKING_STATUSES } from '../sales-bot/entities/bot-booking.entity';

export const ORDER_STATUSES = ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'] as const;
export const WEBHOOK_EVENTS = ['order.created', 'order.status_changed', 'booking.created', 'booking.status_changed'] as const;
const TEST_CUSTOMER = '999%';

/** The request object (the guard puts the API caller on it). */
export const CurrentRequest = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest());
const MAX_ATTEMPTS = 12;

/* ─────────────────────────── DTOs ─────────────────────────── */

class ApiVariantDto {
  @IsString() @MaxLength(60) name!: string;
  @IsString() @MaxLength(120) value!: string;
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsString() @MaxLength(80) sku?: string;
  @IsOptional() @IsBoolean() available?: boolean;
  @IsOptional() @IsNumber() @Min(0) weight?: number;
  @IsOptional() @IsString() @MaxLength(1000) image_url?: string;
}

class ApiProductDto {
  @IsOptional() @IsString() @MaxLength(80) sku?: string;
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(120) brand?: string;
  @IsOptional() @IsString() @MaxLength(120) category?: string;
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsNumber() @Min(0) weight?: number;
  @IsOptional() @IsBoolean() available?: boolean;
  @IsOptional() @IsBoolean() show_to_bot?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) selling_points?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) image_urls?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ApiVariantDto) variants?: ApiVariantDto[];
}

export class ApiProductsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ApiProductDto) products!: ApiProductDto[];
}

export class ApiAvailabilityDto {
  @IsBoolean() available!: boolean;
  @IsOptional() @IsString() @MaxLength(120) variant_value?: string;
}

export class ApiOrderStatusDto {
  @IsIn(ORDER_STATUSES as unknown as string[]) status!: (typeof ORDER_STATUSES)[number];
}

export class ApiBookingStatusDto {
  @IsIn(BOT_BOOKING_STATUSES) status!: (typeof BOT_BOOKING_STATUSES)[number];
}

export class ApiListQueryDto {
  @IsOptional() @IsString() @MaxLength(20) status?: string;
  /** ISO date-time: only rows changed after it */
  @IsOptional() @IsString() @MaxLength(40) since?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) limit?: number;
}

export class CreateApiKeyDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
}

export class WebhookSettingsDto {
  @IsOptional() @IsUrl({ require_protocol: true, protocols: ['https', 'http'] }) @MaxLength(1000) url?: string;
  @IsOptional() @IsArray() @IsIn(WEBHOOK_EVENTS as unknown as string[], { each: true }) events?: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

/* ─────────────────────────── keys ─────────────────────────── */

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

type ApiActor = { companyId: number; user: AuthenticatedUser; keyId: number };

@Injectable()
export class OpenApiKeysService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async ownerCompany(user: AuthenticatedUser) {
    const [company] = await this.db.query(`SELECT id, admin_user_id FROM company WHERE id = $1`, [Number(user.company_id)]);
    if (!company || Number(company.admin_user_id) !== Number(user.id)) throw new ForbiddenException('Only the company owner can manage the API.');
    return Number(company.id);
  }

  async list(companyId: number) {
    return this.db.query(`SELECT id, name, prefix, created_at, last_used_at FROM company_api_key
                           WHERE company_id = $1 AND revoked_at IS NULL ORDER BY id DESC`, [companyId]);
  }

  /** The full key is shown ONCE – only its hash is kept. */
  async create(companyId: number, userId: number, name?: string) {
    const [{ count }] = await this.db.query(`SELECT count(*)::int AS count FROM company_api_key WHERE company_id = $1 AND revoked_at IS NULL`, [companyId]);
    if (count >= 10) throw new BadRequestException('A company can have up to 10 API keys – remove one first.');
    const key = `am_live_${randomBytes(24).toString('base64url')}`;
    const [row] = await this.db.query(
      `INSERT INTO company_api_key (company_id, user_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, prefix, created_at`, [companyId, userId, (name || 'API key').trim().slice(0, 80), key.slice(0, 14), hashKey(key)]);
    return { ...row, key };
  }

  async revoke(companyId: number, id: number) {
    const rows = await this.db.query(`UPDATE company_api_key SET revoked_at = NOW() WHERE company_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING id`, [companyId, id]);
    if (!rows.length) throw new NotFoundException('API key not found.');
    return { id };
  }

  /** The key → the company and its owner (the API acts as the owner). */
  async verify(key: string): Promise<ApiActor> {
    if (!/^am_live_[A-Za-z0-9_-]{20,}$/.test(key)) throw new UnauthorizedException('Invalid API key.');
    const [row] = await this.db.query(
      `SELECT k.id, k.company_id, c.admin_user_id, u.name, u.email
         FROM company_api_key k JOIN company c ON c.id = k.company_id LEFT JOIN app_user u ON u.id = c.admin_user_id
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL`, [hashKey(key)]);
    if (!row || !row.admin_user_id) throw new UnauthorizedException('Invalid API key.');
    void this.db.query(`UPDATE company_api_key SET last_used_at = NOW() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - interval '1 minute')`, [row.id]).catch(() => undefined);
    return {
      companyId: Number(row.company_id), keyId: Number(row.id),
      user: { id: Number(row.admin_user_id), name: String(row.name ?? 'API'), email: String(row.email ?? ''), company_id: Number(row.company_id), role: 'admin', is_super_admin: false },
    };
  }
}

@Injectable()
export class OpenApiGuard implements CanActivate {
  constructor(private readonly keys: OpenApiKeysService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; openApi?: ApiActor }>();
    const auth = String(req.headers.authorization ?? '');
    const key = (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : String(req.headers['x-api-key'] ?? '')).trim();
    if (!key) throw new UnauthorizedException('Send the API key: "Authorization: Bearer am_live_…" or "X-API-Key: am_live_…".');
    req.openApi = await this.keys.verify(key);
    return true;
  }
}

const actorOf = (req: { openApi?: ApiActor }) => {
  if (!req.openApi) throw new UnauthorizedException();
  return req.openApi;
};

/* ─────────────────────────── views ─────────────────────────── */

const money = (v: unknown) => (v == null ? null : Number(v));

@Injectable()
export class OpenApiViews {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async orders(companyId: number, ids: number[]) {
    if (!ids.length) return [];
    const rows = await this.db.query(`
      SELECT o.id, o.status, o.customer_name, o.customer_phone, o.address, o.delivery_area, o.payment_method, o.delivery_fee,
             o.total_amount, o.total_weight_kg, o.admin_note, o.invoice_url, o.created_by, o.created_at, o.updated_at,
             u.platform AS channel, u.external_user_id
        FROM bot_order o JOIN bot_channel_user u ON u.id = o.bot_channel_user_id
       WHERE o.company_id = $1 AND o.id = ANY($2)`, [companyId, ids]);
    const items = await this.db.query(`
      SELECT i.order_id, i.product_id, p.sku, i.product_name, i.variant_text, i.quantity, i.unit_price, i.total_price
        FROM bot_order_item i LEFT JOIN product p ON p.id = i.product_id WHERE i.order_id = ANY($1) ORDER BY i.id`, [ids]);
    const byOrder = new Map<number, unknown[]>();
    for (const i of items) {
      const list = byOrder.get(Number(i.order_id)) ?? [];
      list.push({ product_id: i.product_id, sku: i.sku || null, name: i.product_name, variant: i.variant_text || null,
        quantity: Number(i.quantity), unit_price: money(i.unit_price), total_price: money(i.total_price) });
      byOrder.set(Number(i.order_id), list);
    }
    const view = new Map<number, unknown>(rows.map((o: Record<string, unknown>) => [Number(o.id), {
      id: Number(o.id), status: o.status, channel: o.channel, created_by: o.created_by ?? 'bot',
      customer: { name: o.customer_name || null, phone: o.customer_phone || o.external_user_id || null, address: o.address || null, area: o.delivery_area || null },
      payment_method: o.payment_method || null, delivery_fee: money(o.delivery_fee), total: money(o.total_amount),
      weight_kg: money(o.total_weight_kg), note: o.admin_note || null, invoice_url: o.invoice_url || null,
      items: byOrder.get(Number(o.id)) ?? [], created_at: o.created_at, updated_at: o.updated_at,
    }]));
    return ids.map((id) => view.get(id)).filter(Boolean);
  }

  async bookings(companyId: number, ids: number[]) {
    if (!ids.length) return [];
    const rows = await this.db.query(`
      SELECT b.id, b.status, b.service_id, b.service_name, b.date, b.time, b.customer_name, b.customer_phone, b.notes, b.price,
             b.duration_min, b.invoice_url, b.created_by, b.created_at, b.updated_at, u.platform AS channel, u.external_user_id
        FROM bot_booking b LEFT JOIN bot_channel_user u ON u.id = b.bot_channel_user_id
       WHERE b.company_id = $1 AND b.id = ANY($2)`, [companyId, ids]);
    const view = new Map<number, unknown>(rows.map((b: Record<string, unknown>) => [Number(b.id), {
      id: Number(b.id), status: b.status, channel: b.channel ?? null, created_by: b.created_by ?? 'bot',
      service: { id: b.service_id ?? null, name: b.service_name }, date: b.date, time: b.time, duration_min: b.duration_min ?? null,
      price: money(b.price), customer: { name: b.customer_name || null, phone: b.customer_phone || b.external_user_id || null },
      notes: b.notes || null, invoice_url: b.invoice_url || null, created_at: b.created_at, updated_at: b.updated_at,
    }]));
    return ids.map((id) => view.get(id)).filter(Boolean);
  }
}

/* ─────────────────────────── webhooks ─────────────────────────── */

export function signWebhook(secret: string, body: string, timestamp: number) {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

type Webhook = { company_id: number; url: string; secret: string; events: string[]; enabled: boolean; enabled_since: string | null };

@Injectable()
export class OpenApiWebhookService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OpenApiWebhookService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(@InjectDataSource() private readonly db: DataSource, private readonly views: OpenApiViews) {}

  onModuleInit() {
    if (process.env.OPEN_API_WEBHOOKS === 'off' || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), 20_000);
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async settings(companyId: number) {
    const [row] = await this.db.query(`SELECT * FROM company_webhook WHERE company_id = $1`, [companyId]);
    return row ? { url: row.url, events: row.events ?? [], enabled: row.enabled, secret: row.secret, last_status: row.last_status,
      last_error: row.last_error, last_at: row.last_at } : { url: null, events: [...WEBHOOK_EVENTS], enabled: false, secret: null, last_status: null, last_error: null, last_at: null };
  }

  async save(companyId: number, dto: WebhookSettingsDto) {
    const current = await this.settings(companyId);
    const url = dto.url !== undefined ? dto.url : current.url;
    const enabled = dto.enabled !== undefined ? dto.enabled : current.enabled;
    if (enabled && !url) throw new BadRequestException('Add the webhook URL first.');
    const events = dto.events ?? current.events ?? [...WEBHOOK_EVENTS];
    await this.db.query(`
      INSERT INTO company_webhook (company_id, url, secret, events, enabled, enabled_since)
      VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 THEN NOW() END)
      ON CONFLICT (company_id) DO UPDATE SET url = EXCLUDED.url, events = EXCLUDED.events, enabled = EXCLUDED.enabled,
        -- switched on now: only orders / bookings from now on are sent (not the whole history)
        enabled_since = CASE WHEN EXCLUDED.enabled AND NOT company_webhook.enabled THEN NOW() ELSE company_webhook.enabled_since END,
        updated_at = NOW()`,
      [companyId, url, current.secret ?? `whsec_${randomBytes(24).toString('base64url')}`, events, enabled]);
    return this.settings(companyId);
  }

  async rotateSecret(companyId: number) {
    await this.db.query(`UPDATE company_webhook SET secret = $2, updated_at = NOW() WHERE company_id = $1`, [companyId, `whsec_${randomBytes(24).toString('base64url')}`]);
    return this.settings(companyId);
  }

  /** One call to the shop: true when it answered 2xx. */
  async deliver(hook: Pick<Webhook, 'company_id' | 'url' | 'secret'>, event: string, data: unknown): Promise<{ ok: boolean; status: number | null; error?: string }> {
    const body = JSON.stringify({ id: `evt_${randomBytes(10).toString('hex')}`, event, created_at: new Date().toISOString(), data });
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const res = await fetch(hook.url, {
        method: 'POST', body, signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'AgentMetra-Webhook/1.0', 'X-AgentMetra-Event': event,
          'X-AgentMetra-Signature': signWebhook(hook.secret, body, timestamp) },
      });
      const result = { ok: res.ok, status: res.status, ...(res.ok ? {} : { error: `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` }) };
      await this.db.query(`UPDATE company_webhook SET last_status = $2, last_error = $3, last_at = NOW() WHERE company_id = $1`,
        [hook.company_id, res.status, result.error ?? null]).catch(() => undefined);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.query(`UPDATE company_webhook SET last_status = NULL, last_error = $2, last_at = NOW() WHERE company_id = $1`,
        [hook.company_id, message.slice(0, 300)]).catch(() => undefined);
      return { ok: false, status: null, error: message };
    }
  }

  async test(companyId: number) {
    const [hook] = await this.db.query(`SELECT company_id, url, secret FROM company_webhook WHERE company_id = $1`, [companyId]) as Webhook[];
    if (!hook?.url) throw new BadRequestException('Add the webhook URL first.');
    return this.deliver(hook, 'ping', { message: 'Agent Metra webhook test', company_id: companyId });
  }

  /** Every 20 s: new orders / bookings and status changes since the last delivery → the shop. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const [{ locked }] = await this.db.query(`SELECT pg_try_advisory_lock(hashtext('open-api-webhooks')) AS locked`);
      if (!locked) return;
      try {
        const hooks: Webhook[] = await this.db.query(`SELECT company_id, url, secret, events, enabled, enabled_since FROM company_webhook
                                                       WHERE enabled AND url IS NOT NULL`);
        for (const hook of hooks) await this.sendFor(hook).catch((e) => this.logger.warn(`webhook ${hook.company_id}: ${e instanceof Error ? e.message : e}`));
      } finally {
        await this.db.query(`SELECT pg_advisory_unlock(hashtext('open-api-webhooks'))`);
      }
    } finally {
      this.running = false;
    }
  }

  private async due(hook: Webhook, kind: 'order' | 'booking') {
    const table = kind === 'order' ? 'bot_order' : 'bot_booking';
    return this.db.query(`
      SELECT x.id, x.status::text AS status, s.sent_status, s.attempts
        FROM ${table} x
        LEFT JOIN bot_channel_user u ON u.id = x.bot_channel_user_id
        LEFT JOIN open_api_sent s ON s.company_id = x.company_id AND s.kind = $2 AND s.ref_id = x.id
       WHERE x.company_id = $1 AND x.created_at >= $3 AND x.created_at < NOW() - interval '10 seconds'
         AND COALESCE(u.external_user_id, '') NOT LIKE '${TEST_CUSTOMER}'
         AND (s.ref_id IS NULL OR s.sent_status IS DISTINCT FROM x.status::text)
         AND (s.next_at IS NULL OR s.next_at <= NOW())
       ORDER BY x.id LIMIT 50`, [hook.company_id, kind, hook.enabled_since ?? new Date()]) as Promise<Array<{ id: number; status: string; sent_status: string | null; attempts: number | null }>>;
  }

  private async sendFor(hook: Webhook) {
    for (const kind of ['order', 'booking'] as const) {
      const rows = await this.due(hook, kind);
      if (!rows.length) continue;
      const views = kind === 'order' ? await this.views.orders(hook.company_id, rows.map((r) => Number(r.id)))
        : await this.views.bookings(hook.company_id, rows.map((r) => Number(r.id)));
      const byId = new Map(views.map((v) => [Number((v as { id: number }).id), v]));
      for (const row of rows) {
        const event = `${kind}.${row.sent_status == null ? 'created' : 'status_changed'}`;
        const wanted = (hook.events ?? []).includes(event);
        const data = { ...(byId.get(Number(row.id)) as object), ...(row.sent_status != null ? { previous_status: row.sent_status } : {}) };
        const result = wanted ? await this.deliver(hook, event, data) : { ok: true };
        const attempts = Number(row.attempts ?? 0) + 1;
        if (result.ok || attempts >= MAX_ATTEMPTS) {
          await this.db.query(`
            INSERT INTO open_api_sent (company_id, kind, ref_id, sent_status, attempts, next_at, updated_at) VALUES ($1, $2, $3, $4, 0, NULL, NOW())
            ON CONFLICT (company_id, kind, ref_id) DO UPDATE SET sent_status = EXCLUDED.sent_status, attempts = 0, next_at = NULL, updated_at = NOW()`,
            [hook.company_id, kind, row.id, row.status]);
        } else {
          await this.db.query(`
            INSERT INTO open_api_sent (company_id, kind, ref_id, sent_status, attempts, next_at, updated_at)
            VALUES ($1, $2, $3, NULL, $4, NOW() + make_interval(mins => $5), NOW())
            ON CONFLICT (company_id, kind, ref_id) DO UPDATE SET attempts = EXCLUDED.attempts, next_at = EXCLUDED.next_at, updated_at = NOW()`,
            [hook.company_id, kind, row.id, attempts, Math.min(60, 2 ** (attempts - 1))]);
          break;   // the shop is down: try again later, in order
        }
      }
    }
  }
}

/* ─────────────────────────── controllers ─────────────────────────── */

type ApiRequest = { openApi?: ApiActor };

@Controller('open')
@ApiTags('Shop API')
@UseGuards(OpenApiGuard)
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class OpenApiController {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly products: ProductsService,
    private readonly botAdmin: BotAdminService,
    private readonly salesBotAdmin: SalesBotAdminService,
    private readonly views: OpenApiViews,
  ) {}

  @Get('me')
  async me(@CurrentRequest() req: ApiRequest) {
    const actor = actorOf(req);
    const [company] = await this.db.query(`SELECT id, name FROM company WHERE id = $1`, [actor.companyId]);
    return { company: { id: Number(company.id), name: company.name } };
  }

  @Post('products')
  upsertProducts(@CurrentRequest() req: ApiRequest, @Body() dto: ApiProductsDto) {
    return this.products.upsertFromApi(dto.products, actorOf(req).user);
  }

  @Patch('products/:sku/availability')
  async availability(@CurrentRequest() req: ApiRequest, @Param('sku') sku: string, @Body() dto: ApiAvailabilityDto) {
    const actor = actorOf(req);
    const found = await this.products.findBySkuForApi(actor.companyId, sku);
    if (!found) throw new NotFoundException(`No product with SKU ${sku}.`);
    return this.products.setAvailability(found.product.id, dto.available, dto.variant_value ?? found.variantValue, actor.user);
  }

  @Delete('products/:sku')
  async removeProduct(@CurrentRequest() req: ApiRequest, @Param('sku') sku: string) {
    const actor = actorOf(req);
    const found = await this.products.findBySkuForApi(actor.companyId, sku);
    if (!found || found.variantValue) throw new NotFoundException(`No product with SKU ${sku}.`);
    return this.products.remove(found.product.id, actor.user);
  }

  private async list(kind: 'order' | 'booking', companyId: number, query: ApiListQueryDto) {
    const table = kind === 'order' ? 'bot_order' : 'bot_booking';
    const params: unknown[] = [companyId];
    let where = `x.company_id = $1 AND COALESCE(u.external_user_id, '') NOT LIKE '${TEST_CUSTOMER}'`;
    if (query.status) { params.push(query.status); where += ` AND x.status::text = $${params.length}`; }
    if (query.since) {
      const since = new Date(query.since);
      if (Number.isNaN(since.getTime())) throw new BadRequestException('since must be a date-time, e.g. 2026-11-06T10:00:00Z');
      params.push(since); where += ` AND x.updated_at > $${params.length}`;
    }
    params.push(Math.min(Number(query.limit ?? 50), 200));
    const ids = await this.db.query(`SELECT x.id FROM ${table} x LEFT JOIN bot_channel_user u ON u.id = x.bot_channel_user_id
                                       WHERE ${where} ORDER BY x.id DESC LIMIT $${params.length}`, params);
    const list = ids.map((r: { id: number }) => Number(r.id));
    return kind === 'order' ? this.views.orders(companyId, list) : this.views.bookings(companyId, list);
  }

  @Get('orders')
  orders(@CurrentRequest() req: ApiRequest, @Query() query: ApiListQueryDto) {
    return this.list('order', actorOf(req).companyId, query);
  }

  @Get('orders/:id')
  async order(@CurrentRequest() req: ApiRequest, @Param('id', ParseIntPipe) id: number) {
    const [order] = await this.views.orders(actorOf(req).companyId, [id]);
    if (!order) throw new NotFoundException('Order not found.');
    return order;
  }

  @Patch('orders/:id/status')
  async orderStatus(@CurrentRequest() req: ApiRequest, @Param('id', ParseIntPipe) id: number, @Body() dto: ApiOrderStatusDto) {
    const actor = actorOf(req);
    const result = await this.botAdmin.updateOrderStatus(actor.user, id, { status: dto.status });
    // the shop made this change – it does not need a webhook about it
    await this.markSent(actor.companyId, 'order', id, dto.status);
    const [order] = await this.views.orders(actor.companyId, [id]);
    return { order, customer_message: (result as { message?: string }).message ?? null };
  }

  @Get('bookings')
  bookings(@CurrentRequest() req: ApiRequest, @Query() query: ApiListQueryDto) {
    return this.list('booking', actorOf(req).companyId, query);
  }

  @Patch('bookings/:id/status')
  async bookingStatus(@CurrentRequest() req: ApiRequest, @Param('id', ParseIntPipe) id: number, @Body() dto: ApiBookingStatusDto) {
    const actor = actorOf(req);
    await this.salesBotAdmin.updateBookingStatus(actor.user, id, { status: dto.status });
    await this.markSent(actor.companyId, 'booking', id, dto.status);
    const [booking] = await this.views.bookings(actor.companyId, [id]);
    return { booking };
  }

  private async markSent(companyId: number, kind: 'order' | 'booking', id: number, status: string) {
    await this.db.query(`
      INSERT INTO open_api_sent (company_id, kind, ref_id, sent_status, attempts, updated_at) VALUES ($1, $2, $3, $4, 0, NOW())
      ON CONFLICT (company_id, kind, ref_id) DO UPDATE SET sent_status = EXCLUDED.sent_status, attempts = 0, next_at = NULL, updated_at = NOW()`,
      [companyId, kind, id, status]).catch(() => undefined);
  }
}

@Controller('integrations/api')
@ApiTags('Shop API settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@AdminOnly()
export class OpenApiSettingsController {
  constructor(private readonly keys: OpenApiKeysService, private readonly webhooks: OpenApiWebhookService) {}

  @Get()
  async overview(@CurrentUser() user: AuthenticatedUser) {
    const companyId = await this.keys.ownerCompany(user);
    const base = (process.env.PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');
    return { base_url: base ? `${base}/open` : null, keys: await this.keys.list(companyId), webhook: await this.webhooks.settings(companyId),
      events: WEBHOOK_EVENTS };
  }

  @Post('keys')
  async createKey(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateApiKeyDto) {
    return this.keys.create(await this.keys.ownerCompany(user), Number(user.id), dto.name);
  }

  @Delete('keys/:id')
  async revokeKey(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) {
    return this.keys.revoke(await this.keys.ownerCompany(user), id);
  }

  @Put('webhook')
  async saveWebhook(@CurrentUser() user: AuthenticatedUser, @Body() dto: WebhookSettingsDto) {
    return this.webhooks.save(await this.keys.ownerCompany(user), dto);
  }

  @Post('webhook/secret')
  async rotate(@CurrentUser() user: AuthenticatedUser) {
    return this.webhooks.rotateSecret(await this.keys.ownerCompany(user));
  }

  @Post('webhook/test')
  async test(@CurrentUser() user: AuthenticatedUser) {
    return this.webhooks.test(await this.keys.ownerCompany(user));
  }
}

@Module({
  imports: [AuthModule, ProductsModule, BotAdminModule, SalesBotModule],
  controllers: [OpenApiController, OpenApiSettingsController],
  providers: [OpenApiKeysService, OpenApiGuard, OpenApiViews, OpenApiWebhookService],
})
export class OpenApiModule {}
