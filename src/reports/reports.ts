import { BadRequestException, Body, Controller, Get, Injectable, Logger, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { DataSource } from 'typeorm';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ManagerOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { looksLikeProductQuestion, normalQuestion, productStock, reorderState, saysNotAvailable, typicalGapDays, type ReorderState } from './stock-logic';

/**
 * Product and customer reports:
 *  - Product demand: per product – how many chats saw it (photos), put it in an order summary, ordered it, and asked for
 *    it while it was unavailable; plus questions for things the shop does not sell.
 *  - Customer purchases: per customer – orders, spend, what they buy and how often.
 *  - Reorder due: customers who probably need a product again soon (from how often they bought it, or the product's
 *    "lasts about N days").
 * Demand events are written by the sales bot after each reply (recordTurn) – they never change what the bot says.
 */

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export type DemandTurn = {
  companyId: number;
  conversationId: number | null;
  channelUserId: number | null;
  /** products the bot showed (photos / products it talked about) */
  shownProductIds: number[];
  /** products in the order summary the customer saw */
  cartProductIds: number[];
  /** "Name (Option)" the customer wanted but it is unavailable */
  unavailableItem?: string | null;
  customerText: string;
  reply: string;
  isTest: boolean;
};

export class ReportPeriodDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) days?: number;
}

export class CustomerReportDto extends ReportPeriodDto {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) product_id?: number;
  @IsOptional() @IsIn(['spent', 'orders', 'recent', 'name']) sort?: 'spent' | 'orders' | 'recent' | 'name';
  @IsOptional() @IsIn(['whatsapp', 'messenger', 'instagram']) platform?: 'whatsapp' | 'messenger' | 'instagram';
}

export class ReorderDto {
  /** show customers due within this many days (overdue ones are always shown) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(90) window?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) product_id?: number;
  /** ignore customers who were due more than this many days ago (they have probably gone elsewhere) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) max_overdue?: number;
}

export class ReorderTagDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2000) @Type(() => Number) @IsInt({ each: true }) customer_ids!: number[];
  @IsString() @MaxLength(40) @Matches(/\S/) tag!: string;
}

@Injectable()
export class DemandService {
  private readonly logger = new Logger(DemandService.name);
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Never throws – the report must never get in the way of a reply. */
  async recordTurnSafe(turn: DemandTurn): Promise<void> {
    await this.recordTurn(turn).catch((error: unknown) =>
      this.logger.warn(`demand not recorded: ${error instanceof Error ? error.message : String(error)}`));
  }

  async recordTurn(turn: DemandTurn): Promise<void> {
    const base = [turn.companyId, turn.conversationId, turn.channelUserId, turn.isTest];
    const insert = (productId: number | null, event: string, option: string | null, text: string | null) =>
      this.dataSource.query(
        `INSERT INTO product_demand_event (company_id, conversation_id, bot_channel_user_id, is_test, product_id, event, option_label, query_text)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8
          WHERE $5::int IS NULL OR EXISTS (SELECT 1 FROM product WHERE id = $5 AND company_id = $1)
         ON CONFLICT DO NOTHING`, [...base, productId, event, option?.slice(0, 255) ?? null, text?.slice(0, 300) ?? null]);
    const text = String(turn.customerText ?? '').trim().slice(0, 300) || null;
    for (const id of [...new Set(turn.shownProductIds.map(Number).filter((n) => n > 0))].slice(0, 10)) await insert(id, 'shown', null, null);
    for (const id of [...new Set(turn.cartProductIds.map(Number).filter((n) => n > 0))].slice(0, 20)) await insert(id, 'cart', null, null);

    if (turn.unavailableItem) {
      const raw = String(turn.unavailableItem).trim();
      const m = raw.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
      const name = (m ? m[1] : raw).trim();
      const option = m ? m[2].trim() : null;
      const [product] = await this.dataSource.query(
        `SELECT id FROM product WHERE company_id = $1 AND is_deleted = false AND LOWER(name) = LOWER($2) ORDER BY id LIMIT 1`, [turn.companyId, name]);
      await insert(product ? num(product.id) : null, 'unavailable', option ?? (product ? null : name), text);
      return;
    }
    // "Huggies thiyenawada?" → "Sorry, we don't have Huggies" : something customers want that the shop does not sell
    if (text && looksLikeProductQuestion(text) && saysNotAvailable(turn.reply)) await insert(null, 'no_match', null, text);
  }
}

@Injectable()
export class ProductReportService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async report(user: AuthenticatedUser, query: ReportPeriodDto) {
    const companyId = Number(user.company_id);
    const days = query.days ?? 30;
    const rows: Array<Record<string, any>> = await this.dataSource.query(`
      WITH ev AS (
        SELECT product_id,
               COUNT(DISTINCT conversation_id) FILTER (WHERE event = 'shown') AS shown,
               COUNT(DISTINCT conversation_id) FILTER (WHERE event = 'cart') AS cart,
               COUNT(*) FILTER (WHERE event = 'unavailable') AS unavailable
          FROM product_demand_event
         WHERE company_id = $1 AND is_test = false AND product_id IS NOT NULL AND created_at > NOW() - make_interval(days => $2)
         GROUP BY product_id
      ), sales AS (
        SELECT i.product_id, COUNT(DISTINCT o.id) AS orders, SUM(i.quantity) AS qty, SUM(i.total_price) AS revenue,
               COUNT(DISTINCT o.bot_channel_user_id) AS buyers,
               COUNT(DISTINCT o.id) FILTER (WHERE o.created_by = 'bot') AS bot_orders
          FROM bot_order_item i JOIN bot_order o ON o.id = i.order_id
         WHERE o.company_id = $1 AND o.status::text <> 'Cancelled' AND i.product_id IS NOT NULL AND o.created_at > NOW() - make_interval(days => $2)
         GROUP BY i.product_id
      )
      SELECT p.id, p.name, p.sku, p.brand, p.image_url, p.price, p.is_available, p.show_to_bot, p.track_stock, p.quantity,
             p.low_stock_level, p.has_variants,
             (SELECT v.variants FROM product_variant v WHERE v.product_id = p.id ORDER BY v.id LIMIT 1) AS options,
             COALESCE(ev.shown, 0)::int AS shown, COALESCE(ev.cart, 0)::int AS cart, COALESCE(ev.unavailable, 0)::int AS unavailable,
             COALESCE(s.orders, 0)::int AS orders, COALESCE(s.qty, 0)::int AS qty, COALESCE(s.revenue, 0)::float AS revenue,
             COALESCE(s.buyers, 0)::int AS buyers, COALESCE(s.bot_orders, 0)::int AS bot_orders
        FROM product p
        LEFT JOIN ev ON ev.product_id = p.id
        LEFT JOIN sales s ON s.product_id = p.id
       WHERE p.company_id = $1 AND p.is_deleted = false
       ORDER BY COALESCE(s.revenue, 0) DESC, COALESCE(ev.shown, 0) DESC, p.name ASC
       LIMIT 2000`, [companyId, days]);
    const products = rows.map((r) => {
      const held = productStock(Boolean(r.has_variants), r.options, r.quantity, num(r.low_stock_level));
      return {
      id: num(r.id), name: String(r.name), sku: r.sku ?? '', brand: r.brand ?? null, image_url: r.image_url ?? null, price: num(r.price),
      is_available: r.is_available !== false, show_to_bot: r.show_to_bot !== false, track_stock: Boolean(r.track_stock),
      stock: r.track_stock ? held.stock : null, stock_state: r.track_stock ? held.state : null, low_stock_level: num(r.low_stock_level),
      shown: num(r.shown), cart: num(r.cart), unavailable: num(r.unavailable),
      orders: num(r.orders), qty: num(r.qty), revenue: Math.round(num(r.revenue)), buyers: num(r.buyers), bot_orders: num(r.bot_orders),
      // of the chats that saw it, how many ordered it (bot orders only – manual orders may not come from a chat that saw it)
      conversion: pct(num(r.bot_orders), num(r.shown)),
      };
    });

    const unavailable: Array<Record<string, any>> = await this.dataSource.query(`
      SELECT e.id, e.product_id, p.name AS product_name, e.option_label, e.query_text, e.created_at, e.conversation_id,
             cu.id AS customer_id, COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS customer_name, cu.platform
        FROM product_demand_event e
        LEFT JOIN product p ON p.id = e.product_id
        LEFT JOIN bot_channel_user cu ON cu.id = e.bot_channel_user_id
       WHERE e.company_id = $1 AND e.is_test = false AND e.event = 'unavailable' AND e.created_at > NOW() - make_interval(days => $2)
       ORDER BY e.id DESC LIMIT 100`, [companyId, days]);
    const missingRaw: Array<Record<string, any>> = await this.dataSource.query(`
      SELECT e.query_text, e.created_at, e.conversation_id, e.bot_channel_user_id
        FROM product_demand_event e
       WHERE e.company_id = $1 AND e.is_test = false AND e.event = 'no_match' AND e.created_at > NOW() - make_interval(days => $2)
       ORDER BY e.id DESC LIMIT 2000`, [companyId, days]);
    const groups = new Map<string, { question: string; asks: number; customers: Set<number>; last_at: string; conversation_id: number | null }>();
    for (const row of missingRaw) {
      const key = normalQuestion(row.query_text);
      if (!key) continue;
      const g = groups.get(key) ?? { question: String(row.query_text), asks: 0, customers: new Set<number>(), last_at: row.created_at, conversation_id: row.conversation_id == null ? null : num(row.conversation_id) };
      g.asks += 1;
      if (row.bot_channel_user_id) g.customers.add(num(row.bot_channel_user_id));
      groups.set(key, g);
    }
    const notInCatalog = [...groups.values()].map((g) => ({ question: g.question, asks: g.asks, customers: g.customers.size, last_at: g.last_at, conversation_id: g.conversation_id }))
      .sort((a, b) => b.customers - a.customers || b.asks - a.asks).slice(0, 100);

    const totals = {
      products: products.length,
      shown: products.reduce((s, p) => s + p.shown, 0),
      orders: products.reduce((s, p) => s + p.orders, 0),
      qty: products.reduce((s, p) => s + p.qty, 0),
      revenue: products.reduce((s, p) => s + p.revenue, 0),
      unavailable_asks: unavailable.length,
      not_in_catalog_asks: missingRaw.length,
      never_sold: products.filter((p) => p.is_available && p.orders === 0).length,
    };
    return {
      days, totals, products,
      findings: findings(products, notInCatalog.length),
      unavailable: unavailable.map((r) => ({ ...r, id: num(r.id), product_id: r.product_id == null ? null : num(r.product_id), customer_id: r.customer_id == null ? null : num(r.customer_id), conversation_id: r.conversation_id == null ? null : num(r.conversation_id) })),
      not_in_catalog: notInCatalog,
    };
  }

  /** One product: daily sales and interest, and who bought it. */
  async product(user: AuthenticatedUser, productId: number, query: ReportPeriodDto) {
    const companyId = Number(user.company_id);
    const days = query.days ?? 90;
    const [product] = await this.dataSource.query(`SELECT id, name, price, track_stock, quantity FROM product WHERE id = $1 AND company_id = $2 AND is_deleted = false`, [productId, companyId]);
    if (!product) throw new NotFoundException('Product not found');
    const daily: Array<Record<string, any>> = await this.dataSource.query(`
      SELECT d::date AS day,
             COALESCE((SELECT SUM(i.quantity) FROM bot_order_item i JOIN bot_order o ON o.id = i.order_id
                        WHERE i.product_id = $1 AND o.company_id = $2 AND o.status::text <> 'Cancelled' AND o.created_at::date = d::date), 0)::int AS qty,
             COALESCE((SELECT COUNT(DISTINCT conversation_id) FROM product_demand_event e
                        WHERE e.product_id = $1 AND e.company_id = $2 AND e.event = 'shown' AND e.is_test = false AND e.day = d::date), 0)::int AS shown
        FROM generate_series(CURRENT_DATE - make_interval(days => $3 - 1), CURRENT_DATE, INTERVAL '1 day') AS d
       ORDER BY d`, [productId, companyId, Math.min(days, 365)]);
    const options: Array<Record<string, any>> = await this.dataSource.query(`
      SELECT COALESCE(NULLIF(i.variant_text, ''), '—') AS option, SUM(i.quantity)::int AS qty, SUM(i.total_price)::float AS revenue
        FROM bot_order_item i JOIN bot_order o ON o.id = i.order_id
       WHERE i.product_id = $1 AND o.company_id = $2 AND o.status::text <> 'Cancelled' AND o.created_at > NOW() - make_interval(days => $3)
       GROUP BY 1 ORDER BY 2 DESC`, [productId, companyId, days]);
    const buyers: Array<Record<string, any>> = await this.dataSource.query(`
      SELECT cu.id AS customer_id, COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS name, cu.platform,
             COUNT(DISTINCT o.id)::int AS orders, SUM(i.quantity)::int AS qty, MAX(o.created_at) AS last_at
        FROM bot_order_item i JOIN bot_order o ON o.id = i.order_id JOIN bot_channel_user cu ON cu.id = o.bot_channel_user_id
       WHERE i.product_id = $1 AND o.company_id = $2 AND o.status::text <> 'Cancelled' AND o.created_at > NOW() - make_interval(days => $3)
       GROUP BY 1, 2, 3 ORDER BY 5 DESC LIMIT 200`, [productId, companyId, days]);
    return {
      product: { id: num(product.id), name: product.name, price: num(product.price), stock: product.track_stock ? num(product.quantity) : null },
      days, daily, options, buyers: buyers.map((b) => ({ ...b, customer_id: num(b.customer_id) })),
    };
  }
}

/** Plain-language findings for the owner. */
const many = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;

function findings(products: Array<{ name: string; shown: number; orders: number; bot_orders: number; unavailable: number; revenue: number; conversion: number; is_available: boolean; track_stock: boolean; stock: number | null; stock_state: string | null; low_stock_level: number }>, notInCatalog: number): string[] {
  const out: string[] = [];
  const sellers = products.filter((p) => p.orders > 0).sort((a, b) => b.revenue - a.revenue);
  if (sellers.length) out.push(`Best seller: ${sellers[0].name} (${sellers[0].orders} orders, Rs ${sellers[0].revenue.toLocaleString('en-LK')}).`);
  const restock = products.filter((p) => p.unavailable > 0).sort((a, b) => b.unavailable - a.unavailable);
  if (restock.length) out.push(`${many(restock.length, 'product was', 'products were')} asked for while unavailable – most: ${restock[0].name} (${restock[0].unavailable} times). Restocking them is the quickest extra sales.`);
  const weak = products.filter((p) => p.shown >= 5 && p.conversion < 10).sort((a, b) => b.shown - a.shown);
  if (weak.length) out.push(`${weak[0].name} was shown in ${weak[0].shown} chats but ${weak[0].conversion ? `only ${weak[0].conversion}% ordered` : "nobody ordered it"} – check its price, photos or selling points.`);
  const low = products.filter((p) => p.track_stock && (p.stock_state === 'low' || p.stock_state === 'out') && p.orders > 0);
  if (low.length) out.push(`${many(low.length, 'selling product is', 'selling products are')} low or out of stock: ${low.slice(0, 3).map((p) => `${p.name} (${p.stock_state === 'out' ? 'out' : 'low'})`).join(', ')}.`);
  if (notInCatalog) out.push(`Customers asked for ${many(notInCatalog, 'thing', 'things')} you don't sell – see "Asked for, not in your catalog". Some may be worth adding.`);
  const idle = products.filter((p) => p.is_available && p.orders === 0 && p.shown === 0).length;
  if (idle && products.length > 5) out.push(`${many(idle, 'available product was', 'available products were')} not shown or ordered in this period – check their names and selling points so the bot can find them.`);
  if (!out.length) out.push('No product activity in this period yet.');
  return out;
}

@Injectable()
export class CustomerReportService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async customers(user: AuthenticatedUser, query: CustomerReportDto) {
    const companyId = Number(user.company_id);
    const days = query.days ?? 365;
    const search = String(query.search ?? '').trim();
    const rows: Array<Record<string, any>> = await this.dataSource.query(`
      WITH o AS (
        SELECT o.* FROM bot_order o
         WHERE o.company_id = $1 AND o.status::text <> 'Cancelled' AND o.created_at > NOW() - make_interval(days => $2)
           AND ($5::int IS NULL OR EXISTS (SELECT 1 FROM bot_order_item i WHERE i.order_id = o.id AND i.product_id = $5))
      )
      SELECT cu.id, COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS name, cu.external_user_id, cu.platform,
             (SELECT MAX(NULLIF(x.customer_phone, '')) FROM o x WHERE x.bot_channel_user_id = cu.id) AS phone,
             COUNT(o.id)::int AS orders, COALESCE(SUM(o.total_amount), 0)::float AS spent,
             MIN(o.created_at) AS first_order, MAX(o.created_at) AS last_order,
             ARRAY_AGG(o.created_at ORDER BY o.created_at) AS order_dates,
             (SELECT COALESCE(SUM(i.quantity), 0) FROM bot_order_item i JOIN o y ON y.id = i.order_id WHERE y.bot_channel_user_id = cu.id)::int AS items,
             (SELECT JSON_AGG(t) FROM (
                SELECT i.product_name AS name, SUM(i.quantity)::int AS qty FROM bot_order_item i JOIN o z ON z.id = i.order_id
                 WHERE z.bot_channel_user_id = cu.id GROUP BY i.product_name ORDER BY 2 DESC LIMIT 3) t) AS top_products,
             (SELECT c.id FROM bot_conversation c WHERE c.bot_channel_user_id = cu.id ORDER BY c.id DESC LIMIT 1) AS conversation_id
        FROM bot_channel_user cu JOIN o ON o.bot_channel_user_id = cu.id
       WHERE cu.company_id = $1
         AND ($3 = '' OR cu.display_name ILIKE '%' || $3 || '%' OR cu.external_user_id ILIKE '%' || $3 || '%')
         AND ($4::text IS NULL OR cu.platform = $4)
       GROUP BY cu.id
       LIMIT 5000`, [companyId, days, search, query.platform ?? null, query.product_id ?? null]);
    const customers = rows.map((r) => {
      const dates: Date[] = Array.isArray(r.order_dates) ? r.order_dates.map((d: string) => new Date(d)) : [];
      const gap = typicalGapDays(dates);
      return {
        id: num(r.id), name: String(r.name ?? ''), phone: r.phone || (r.platform === 'whatsapp' ? r.external_user_id : null), platform: r.platform,
        orders: num(r.orders), spent: Math.round(num(r.spent)), items: num(r.items), average_order: num(r.orders) ? Math.round(num(r.spent) / num(r.orders)) : 0,
        first_order: r.first_order, last_order: r.last_order, days_since_last: Math.floor((Date.now() - new Date(r.last_order).getTime()) / 86_400_000),
        orders_every_days: gap, top_products: Array.isArray(r.top_products) ? r.top_products : [],
        conversation_id: r.conversation_id == null ? null : num(r.conversation_id),
      };
    });
    const sort = query.sort ?? 'spent';
    customers.sort((a, b) => sort === 'orders' ? b.orders - a.orders || b.spent - a.spent
      : sort === 'recent' ? new Date(b.last_order).getTime() - new Date(a.last_order).getTime()
        : sort === 'name' ? a.name.localeCompare(b.name) : b.spent - a.spent);
    const buyers = customers.length;
    const repeat = customers.filter((c) => c.orders >= 2).length;
    const revenue = customers.reduce((s, c) => s + c.spent, 0);
    return {
      days,
      totals: {
        customers: buyers, repeat_customers: repeat, repeat_rate: pct(repeat, buyers), revenue,
        orders: customers.reduce((s, c) => s + c.orders, 0),
        average_order: customers.reduce((s, c) => s + c.orders, 0) ? Math.round(revenue / customers.reduce((s, c) => s + c.orders, 0)) : 0,
        // the top 20% of customers bring this share of sales
        top_20_share: buyers ? pct([...customers].sort((a, b) => b.spent - a.spent).slice(0, Math.max(1, Math.ceil(buyers * 0.2))).reduce((s, c) => s + c.spent, 0), revenue) : 0,
      },
      customers,
    };
  }

  /** One customer: every order with its items, and per product how often they buy it and when it is due again. */
  async customer(user: AuthenticatedUser, customerId: number) {
    const companyId = Number(user.company_id);
    const [cu] = await this.dataSource.query(`
      SELECT id, COALESCE(NULLIF(display_name, ''), external_user_id) AS name, external_user_id, platform,
             (SELECT c.id FROM bot_conversation c WHERE c.bot_channel_user_id = bot_channel_user.id ORDER BY c.id DESC LIMIT 1) AS conversation_id
        FROM bot_channel_user WHERE id = $1 AND company_id = $2`, [customerId, companyId]);
    if (!cu) throw new NotFoundException('Customer not found');
    const orders: Array<Record<string, any>> = await this.dataSource.query(`
      SELECT o.id, o.status::text AS status, o.total_amount::float AS total, o.delivery_fee::float AS delivery_fee, o.created_at, o.created_by,
             COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT('product_id', i.product_id, 'name', i.product_name, 'option', i.variant_text,
                       'quantity', i.quantity, 'unit_price', i.unit_price::float, 'total', i.total_price::float) ORDER BY i.id)
                        FROM bot_order_item i WHERE i.order_id = o.id), '[]') AS items
        FROM bot_order o WHERE o.company_id = $1 AND o.bot_channel_user_id = $2
       ORDER BY o.created_at DESC LIMIT 500`, [companyId, customerId]);
    const productRows: Array<Record<string, any>> = await this.dataSource.query(`
      SELECT i.product_id, MAX(i.product_name) AS name, MAX(p.reorder_days) AS reorder_days, COUNT(DISTINCT o.id)::int AS times,
             SUM(i.quantity)::int AS qty, SUM(i.total_price)::float AS spent, ARRAY_AGG(o.created_at ORDER BY o.created_at) AS dates
        FROM bot_order_item i JOIN bot_order o ON o.id = i.order_id LEFT JOIN product p ON p.id = i.product_id
       WHERE o.company_id = $1 AND o.bot_channel_user_id = $2 AND o.status::text <> 'Cancelled'
       GROUP BY i.product_id, CASE WHEN i.product_id IS NULL THEN i.product_name END
       ORDER BY 4 DESC, 6 DESC`, [companyId, customerId]);
    const products = productRows.map((r) => {
      const dates = (r.dates ?? []) as string[];
      const every = typicalGapDays(dates) ?? (r.reorder_days == null ? null : num(r.reorder_days));
      const last = dates[dates.length - 1];
      return {
        product_id: r.product_id == null ? null : num(r.product_id), name: r.name, times: num(r.times), qty: num(r.qty), spent: Math.round(num(r.spent)),
        last_bought: last, every_days: every, next: every && last ? reorderState(last, every) : null,
      };
    });
    const live = orders.filter((o) => o.status !== 'Cancelled');
    return {
      customer: { id: num(cu.id), name: cu.name, platform: cu.platform, phone: cu.platform === 'whatsapp' ? cu.external_user_id : null, conversation_id: cu.conversation_id == null ? null : num(cu.conversation_id) },
      totals: {
        orders: live.length, cancelled: orders.length - live.length, spent: Math.round(live.reduce((s, o) => s + num(o.total), 0)),
        first_order: live.length ? live[live.length - 1].created_at : null, last_order: live.length ? live[0].created_at : null,
        orders_every_days: typicalGapDays(live.map((o) => o.created_at)),
      },
      products,
      orders: orders.map((o) => ({ ...o, id: num(o.id), total: num(o.total) })),
    };
  }

  /** Customers who probably need a product again soon – a ready list for reminders. */
  async reorderDue(user: AuthenticatedUser, query: ReorderDto) {
    const companyId = Number(user.company_id);
    const window = query.window ?? 7;
    const maxOverdue = query.max_overdue ?? 60;
    const rows: Array<Record<string, any>> = await this.dataSource.query(`
      SELECT o.bot_channel_user_id AS customer_id, i.product_id, MAX(i.product_name) AS product_name, MAX(p.reorder_days) AS reorder_days,
             BOOL_AND(p.is_available) AS available,
             ARRAY_AGG(o.created_at ORDER BY o.created_at) AS dates,
             (ARRAY_AGG(i.quantity ORDER BY o.created_at DESC))[1] AS last_qty,
             (ARRAY_AGG(COALESCE(i.variant_text, '') ORDER BY o.created_at DESC))[1] AS last_option,
             COALESCE(NULLIF(MAX(cu.display_name), ''), MAX(cu.external_user_id)) AS name, MAX(cu.platform) AS platform, MAX(cu.external_user_id) AS external_user_id,
             (SELECT c.id FROM bot_conversation c WHERE c.bot_channel_user_id = o.bot_channel_user_id ORDER BY c.id DESC LIMIT 1) AS conversation_id
        FROM bot_order_item i
        JOIN bot_order o ON o.id = i.order_id
        JOIN product p ON p.id = i.product_id
        JOIN bot_channel_user cu ON cu.id = o.bot_channel_user_id
       WHERE o.company_id = $1 AND o.status::text <> 'Cancelled' AND i.product_id IS NOT NULL
         AND o.created_at > NOW() - INTERVAL '400 days' AND p.is_deleted = false
         AND ($2::int IS NULL OR i.product_id = $2)
       GROUP BY o.bot_channel_user_id, i.product_id
       LIMIT 20000`, [companyId, query.product_id ?? null]);
    const today = new Date();
    const items: Array<{
      customer_id: number; name: string; platform: string; phone: string | null; conversation_id: number | null;
      product_id: number; product_name: string; last_option: string; last_qty: number; last_bought: string; times: number;
      every_days: number; based_on: 'history' | 'product'; due_on: string; days_until: number; state: ReorderState; available: boolean;
    }> = [];
    for (const r of rows) {
      const dates = (r.dates ?? []) as string[];
      const fromHistory = typicalGapDays(dates);
      const every = fromHistory ?? (r.reorder_days == null ? null : num(r.reorder_days));
      if (!every || every < 1) continue;
      const last = dates[dates.length - 1];
      const due = reorderState(last, every, today, window);
      if (due.state === 'later') continue;
      if (due.days_until < -maxOverdue) continue;
      items.push({
        customer_id: num(r.customer_id), name: String(r.name ?? ''), platform: r.platform, phone: r.platform === 'whatsapp' ? r.external_user_id : null,
        conversation_id: r.conversation_id == null ? null : num(r.conversation_id),
        product_id: num(r.product_id), product_name: String(r.product_name), last_option: r.last_option || '', last_qty: num(r.last_qty),
        last_bought: last, times: dates.length, every_days: every, based_on: fromHistory ? 'history' : 'product',
        due_on: due.due_on, days_until: due.days_until, state: due.state, available: r.available !== false,
      });
    }
    items.sort((a, b) => a.days_until - b.days_until);
    const productsWithoutDays: Array<Record<string, any>> = await this.dataSource.query(`
      SELECT p.id, p.name, COUNT(DISTINCT o.bot_channel_user_id)::int AS buyers
        FROM product p JOIN bot_order_item i ON i.product_id = p.id JOIN bot_order o ON o.id = i.order_id
       WHERE p.company_id = $1 AND p.is_deleted = false AND p.reorder_days IS NULL AND o.status::text <> 'Cancelled'
         AND o.created_at > NOW() - INTERVAL '400 days'
       GROUP BY p.id, p.name ORDER BY 3 DESC LIMIT 10`, [companyId]);
    return {
      window,
      totals: {
        customers: new Set(items.map((i) => i.customer_id)).size,
        overdue: items.filter((i) => i.state === 'overdue').length,
        due: items.filter((i) => i.state === 'due').length,
        soon: items.filter((i) => i.state === 'soon').length,
      },
      items,
      // set "lasts about N days" on these so first-time buyers show up too
      products_without_days: productsWithoutDays.map((p) => ({ id: num(p.id), name: p.name, buyers: num(p.buyers) })),
    };
  }

  /** Puts a CRM tag on the chosen customers – then send a WhatsApp broadcast to that tag. */
  async tag(user: AuthenticatedUser, dto: ReorderTagDto) {
    const companyId = Number(user.company_id);
    const tag = dto.tag.trim().toLowerCase();
    if (!tag) throw new BadRequestException('Write a tag name.');
    const ids: Array<{ id: number }> = await this.dataSource.query(
      `SELECT id FROM bot_channel_user WHERE company_id = $1 AND id = ANY($2::int[])`, [companyId, dto.customer_ids]);
    const valid = ids.map((r) => num(r.id));
    if (!valid.length) return { tagged: 0, tag };
    await this.dataSource.query(
      `INSERT INTO crm_contact (bot_channel_user_id, company_id) SELECT UNNEST($1::int[]), $2 ON CONFLICT (bot_channel_user_id) DO NOTHING`, [valid, companyId]);
    await this.dataSource.query(
      `UPDATE crm_contact SET tags = ARRAY(SELECT DISTINCT t FROM UNNEST(COALESCE(tags, '{}') || ARRAY[$2]::text[]) AS t), updated_at = NOW()
        WHERE company_id = $3 AND bot_channel_user_id = ANY($1::int[])`, [valid, tag, companyId]);
    return { tagged: valid.length, tag };
  }
}

@Controller('reports')
@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly products: ProductReportService, private readonly customersReport: CustomerReportService) {}

  @Get('products') @ManagerOnly()
  productReport(@CurrentUser() user: AuthenticatedUser, @Query() query: ReportPeriodDto) { return this.products.report(user, query); }

  @Get('products/:id') @ManagerOnly()
  productDetail(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Query() query: ReportPeriodDto) { return this.products.product(user, id, query); }

  @Get('customers') @ManagerOnly()
  customerReport(@CurrentUser() user: AuthenticatedUser, @Query() query: CustomerReportDto) { return this.customersReport.customers(user, query); }

  @Get('customers/:id') @ManagerOnly()
  customerDetail(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.customersReport.customer(user, id); }

  @Get('reorder') @ManagerOnly()
  reorder(@CurrentUser() user: AuthenticatedUser, @Query() query: ReorderDto) { return this.customersReport.reorderDue(user, query); }

  @Post('reorder/tag') @ManagerOnly()
  tag(@CurrentUser() user: AuthenticatedUser, @Body() dto: ReorderTagDto) { return this.customersReport.tag(user, dto); }
}
