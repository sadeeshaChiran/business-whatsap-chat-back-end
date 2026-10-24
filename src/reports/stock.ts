import { BadRequestException, Body, Controller, Get, Injectable, Logger, NotFoundException, Optional, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ManagerOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PusherService } from '../common/pusher.service';
import {
  daysLeft, findOption, optionLabel, stockAlert, stockChanges, stockKey, stockState,
  type StockAlert, type StockOption,
} from './stock-logic';

/**
 * Optional stock counting with low-stock alerts.
 *
 * Off for every product until the owner switches it on ("Count stock"). Then product.quantity – or the quantity of
 * each variant option – is the stock. Every order change goes through syncOrder(): the order takes out exactly what it
 * needs now (nothing when cancelled or deleted) and each change is kept in product_stock_movement, so running it twice
 * never takes stock twice. At 0 the product (or option) is switched to Unavailable automatically – the sales bot then
 * stops selling it, exactly like a manual "Unavailable" – and switched back on when stock is added.
 */

type ProductRow = {
  id: number; company_id: number; name: string; track_stock: boolean; quantity: number; low_stock_level: number;
  stock_auto_off: boolean; is_available: boolean; has_variants: boolean;
};
type VariantRow = { id: number; product_id: number; variants: StockOption[] };
type Alert = { companyId: number; productId: number; name: string; label: string | null; before: number; after: number; level: number; kind: StockAlert; orderId: number | null };

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export class StockSettingsDto {
  @IsOptional() @IsBoolean() track_stock?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) low_stock_level?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3650) reorder_days?: number | null;
}

export class StockAdjustDto {
  /** The variant option ("Red / M"); empty = the product itself */
  @IsOptional() @IsString() @MaxLength(255) option_label?: string | null;
  /** set = the stock is now exactly this · add = received (positive) or removed (negative) */
  @IsIn(['set', 'add']) mode!: 'set' | 'add';
  @Type(() => Number) @IsInt() @Min(-1000000) @Max(1000000) quantity!: number;
  @IsOptional() @IsString() @MaxLength(255) note?: string;
}

export class StockListDto {
  @IsOptional() @IsIn(['all', 'tracked', 'low', 'out', 'untracked']) filter?: 'all' | 'tracked' | 'low' | 'out' | 'untracked';
  @IsOptional() @IsString() @MaxLength(100) search?: string;
}

export class StockMovementsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) product_id?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() private readonly pusher?: PusherService,
  ) {}

  /** Never throws – a stock problem must never stop an order. */
  async syncOrderSafe(orderId: number | null | undefined): Promise<void> {
    if (!orderId) return;
    await this.syncOrder(Number(orderId)).catch((error: unknown) =>
      this.logger.warn(`stock sync for order ${orderId} failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Makes the stock match what the order needs now (also after a change, cancel or delete). */
  async syncOrder(orderId: number): Promise<void> {
    const alerts = await this.dataSource.transaction(async (m) => {
      const [order] = await m.query(`SELECT id, company_id, status::text AS status FROM bot_order WHERE id = $1`, [orderId]);
      const lines: Array<{ product_id: number; variant_text: string | null; quantity: number }> = order && order.status !== 'Cancelled'
        ? await m.query(`SELECT product_id, variant_text, quantity FROM bot_order_item WHERE order_id = $1 AND product_id IS NOT NULL`, [orderId])
        : [];
      const heldRows: Array<{ company_id: string; product_id: number; option_label: string | null; held: string }> = await m.query(
        `SELECT company_id, product_id, option_label, SUM(-change)::int AS held FROM product_stock_movement WHERE order_id = $1 GROUP BY 1, 2, 3`, [orderId]);
      const companyId = num(order?.company_id ?? heldRows[0]?.company_id);
      if (!companyId) return [] as Alert[];
      const productIds = [...new Set([...lines.map((l) => num(l.product_id)), ...heldRows.map((h) => num(h.product_id))])].filter(Boolean);
      if (!productIds.length) return [] as Alert[];
      const { products, variants } = await this.lockProducts(m, companyId, productIds);

      const desired = new Map<string, number>();
      for (const line of lines) {
        const product = products.get(num(line.product_id));
        if (!product?.track_stock) continue;
        const options = product.has_variants ? variants.get(product.id)?.variants ?? [] : [];
        let label: string | null = null;
        if (options.length) {
          const index = findOption(options, line.variant_text);
          if (index < 0) continue;   // an option we cannot find is not counted (the team sees the order as usual)
          label = optionLabel(options[index]);
        }
        const key = stockKey(product.id, label);
        desired.set(key, (desired.get(key) ?? 0) + Math.max(0, num(line.quantity)));
      }
      const held = new Map<string, number>();
      for (const row of heldRows) held.set(stockKey(num(row.product_id), row.option_label || null), num(row.held));

      const out: Alert[] = [];
      for (const change of stockChanges(desired, held)) {
        const [pid, ...rest] = change.key.split('|');
        const product = products.get(num(pid));
        if (!product?.track_stock) continue;   // counting switched off since: leave it as it is
        const label = rest.join('|') || null;
        const reason = change.desired === 0 ? (order ? 'order_cancelled' : 'order_deleted') : change.held === 0 ? 'order' : 'order_changed';
        const alert = await this.applyChange(m, product, variants.get(product.id) ?? null, label, change.change, {
          reason, orderId, userId: null, note: order ? `Order #${orderId}` : `Order #${orderId} (deleted)`,
        });
        if (alert) out.push(alert);
      }
      return out;
    });
    await this.sendAlerts(alerts);
  }

  private async lockProducts(m: EntityManager, companyId: number, ids: number[]) {
    const productRows: ProductRow[] = await m.query(
      `SELECT id, company_id, name, track_stock, quantity, low_stock_level, stock_auto_off, is_available, has_variants
         FROM product WHERE id = ANY($1::int[]) AND company_id = $2 FOR UPDATE`, [ids, companyId]);
    // FOR UPDATE cannot be combined with DISTINCT: lock every row, then use each product's first row (like the bot does)
    const variantRows: VariantRow[] = await m.query(
      `SELECT id, product_id, variants FROM product_variant WHERE product_id = ANY($1::int[]) ORDER BY product_id, id FOR UPDATE`, [ids]);
    const variants = new Map<number, VariantRow>();
    for (const v of variantRows) {
      if (!variants.has(num(v.product_id))) variants.set(num(v.product_id), { ...v, id: num(v.id), product_id: num(v.product_id), variants: Array.isArray(v.variants) ? v.variants : [] });
    }
    return {
      products: new Map(productRows.map((p) => [num(p.id), { ...p, id: num(p.id), company_id: num(p.company_id), quantity: num(p.quantity), low_stock_level: num(p.low_stock_level) }])),
      variants,
    };
  }

  /** Moves the stock of a product (label = null) or one option, keeps the movement, and switches Unavailable on / off at 0. */
  private async applyChange(m: EntityManager, product: ProductRow, variantRow: VariantRow | null, label: string | null, change: number,
    meta: { reason: string; orderId: number | null; userId: number | null; note?: string; setTo?: number }): Promise<Alert | null> {
    let before: number;
    let after: number;
    if (label) {
      const options = variantRow?.variants ?? [];
      const index = options.findIndex((o) => optionLabel(o) === label);
      if (!variantRow || index < 0) return null;
      const option = options[index];
      before = num(option.quantity);
      after = meta.setTo !== undefined ? meta.setTo : before + change;
      option.quantity = after;
      if (after <= 0 && option.available !== false) { option.available = false; option.auto_off = true; }
      if (after > 0 && option.auto_off) { delete option.available; delete option.auto_off; }
      await m.query(`UPDATE product_variant SET variants = $1::jsonb WHERE id = $2`, [JSON.stringify(options), variantRow.id]);
      const total = options.reduce((sum, o) => sum + Math.max(0, num(o.quantity)), 0);
      await m.query(`UPDATE product SET quantity = $1, updated_at = NOW() WHERE id = $2`, [total, product.id]);
      product.quantity = total;
    } else {
      before = num(product.quantity);
      after = meta.setTo !== undefined ? meta.setTo : before + change;
      let available = product.is_available;
      let autoOff = product.stock_auto_off;
      if (after <= 0 && available) { available = false; autoOff = true; }
      if (after > 0 && autoOff) { available = true; autoOff = false; }
      await m.query(`UPDATE product SET quantity = $1, is_available = $2, stock_auto_off = $3, updated_at = NOW() WHERE id = $4`,
        [after, available, autoOff, product.id]);
      Object.assign(product, { quantity: after, is_available: available, stock_auto_off: autoOff });
    }
    await m.query(
      `INSERT INTO product_stock_movement (company_id, product_id, option_label, order_id, change, stock_after, reason, note, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [product.company_id, product.id, label, meta.orderId, after - before, after, meta.reason, meta.note?.slice(0, 255) ?? null, meta.userId]);
    const kind = stockAlert(before, after, product.low_stock_level);
    return kind ? { companyId: product.company_id, productId: product.id, name: product.name, label, before, after, level: product.low_stock_level, kind, orderId: meta.orderId } : null;
  }

  private async sendAlerts(alerts: Alert[]) {
    for (const a of alerts) {
      if (a.kind === 'back_in_stock') continue;
      const item = a.label ? `${a.name} (${a.label})` : a.name;
      const title = a.kind === 'out_of_stock' ? `Out of stock: ${item}` : `Low stock: ${item}`;
      const message = a.kind === 'out_of_stock'
        ? `${item} is ${a.after < 0 ? `oversold by ${-a.after}` : 'at 0'}. It is now Unavailable, so the AI bot stops selling it. Add stock to switch it back on.`
        : `Only ${a.after} left of ${item} (alert level ${a.level}). Order more soon.`;
      const priority = a.kind === 'out_of_stock' ? 'HIGH' : 'MEDIUM';
      await this.dataSource.query(
        `INSERT INTO bot_notification (company_id, kind, priority, title, message, conversation_id, order_id) VALUES ($1, $2, $3, $4, $5, NULL, $6)`,
        [a.companyId, a.kind, priority, title.slice(0, 255), message, a.orderId]).catch((error: unknown) =>
        this.logger.warn(`stock alert not saved: ${error instanceof Error ? error.message : String(error)}`));
      this.pusher?.trigger(`company-${a.companyId}`, 'bot_notification', { kind: a.kind, priority, title, message, conversation_id: null, order_id: a.orderId });
    }
  }

  // ---------------------------------------------------------------- owner actions

  async settings(user: AuthenticatedUser, productId: number, dto: StockSettingsDto) {
    const companyId = Number(user.company_id);
    await this.dataSource.transaction(async (m) => {
      const { products, variants } = await this.lockProducts(m, companyId, [productId]);
      const product = products.get(productId);
      if (!product) throw new NotFoundException('Product not found');
      const sets: string[] = [];
      const values: unknown[] = [];
      const put = (column: string, value: unknown) => { values.push(value); sets.push(`${column} = $${values.length}`); };
      if (dto.track_stock !== undefined) put('track_stock', dto.track_stock);
      if (dto.low_stock_level !== undefined) put('low_stock_level', dto.low_stock_level);
      if (dto.reorder_days !== undefined) put('reorder_days', dto.reorder_days || null);
      if (dto.track_stock === false && product.track_stock) {
        // counting off: an automatic "Unavailable" (set at 0 stock) goes back to Available – a manual one stays
        if (product.stock_auto_off) { put('is_available', true); put('stock_auto_off', false); }
        const row = variants.get(productId);
        if (row?.variants.some((o) => o.auto_off)) {
          for (const option of row.variants) if (option.auto_off) { delete option.available; delete option.auto_off; }
          await m.query(`UPDATE product_variant SET variants = $1::jsonb WHERE id = $2`, [JSON.stringify(row.variants), row.id]);
        }
      }
      if (!sets.length) return;
      values.push(productId, companyId);
      await m.query(`UPDATE product SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length - 1} AND company_id = $${values.length}`, values);
    });
    return this.product(user, productId);
  }

  /** "Received 50" (add) or "I counted 37" (set). */
  async adjust(user: AuthenticatedUser, productId: number, dto: StockAdjustDto) {
    const companyId = Number(user.company_id);
    const alerts = await this.dataSource.transaction(async (m) => {
      const { products, variants } = await this.lockProducts(m, companyId, [productId]);
      const product = products.get(productId);
      if (!product) throw new NotFoundException('Product not found');
      if (!product.track_stock) throw new BadRequestException('Switch on "Count stock" for this product first.');
      const options = product.has_variants ? variants.get(productId)?.variants ?? [] : [];
      let label: string | null = null;
      if (options.length) {
        const index = findOption(options, dto.option_label);
        if (index < 0) throw new BadRequestException('Choose the option (for example the size or colour) to change.');
        label = optionLabel(options[index]);
      }
      const current = label ? num(options.find((o) => optionLabel(o) === label)?.quantity) : num(product.quantity);
      const target = dto.mode === 'set' ? dto.quantity : current + dto.quantity;
      if (target === current) return [] as Alert[];
      const reason = dto.mode === 'set' ? 'count' : dto.quantity > 0 ? 'received' : 'removed';
      const alert = await this.applyChange(m, product, variants.get(productId) ?? null, label, target - current,
        { reason, orderId: null, userId: Number(user.id), note: dto.note?.trim() || undefined, setTo: target });
      return alert ? [alert] : [];
    });
    await this.sendAlerts(alerts);
    return this.product(user, productId);
  }

  // ---------------------------------------------------------------- lists

  /** Every product with its stock, selling speed and days left. */
  async list(user: AuthenticatedUser, query: StockListDto) {
    const companyId = Number(user.company_id);
    const search = String(query.search ?? '').trim();
    const rows: Array<Record<string, any>> = await this.dataSource.query(`
      SELECT p.id, p.name, p.sku, p.brand, p.image_url, p.price, p.track_stock, p.quantity, p.low_stock_level, p.stock_auto_off,
             p.is_available, p.has_variants, p.reorder_days,
             (SELECT v.variants FROM product_variant v WHERE v.product_id = p.id ORDER BY v.id LIMIT 1) AS options,
             COALESCE(s.sold_30, 0)::int AS sold_30,
             (SELECT MAX(created_at) FROM product_stock_movement mv WHERE mv.product_id = p.id AND mv.reason IN ('received', 'count')) AS last_restock
        FROM product p
        LEFT JOIN (
          SELECT i.product_id, SUM(i.quantity) AS sold_30 FROM bot_order_item i JOIN bot_order o ON o.id = i.order_id
           WHERE o.company_id = $1 AND o.status::text <> 'Cancelled' AND o.created_at > NOW() - INTERVAL '30 days' GROUP BY i.product_id
        ) s ON s.product_id = p.id
       WHERE p.company_id = $1 AND p.is_deleted = false
         AND ($2 = '' OR p.name ILIKE '%' || $2 || '%' OR p.sku ILIKE '%' || $2 || '%' OR COALESCE(p.brand, '') ILIKE '%' || $2 || '%')
       ORDER BY p.track_stock DESC, p.name ASC
       LIMIT 2000`, [companyId, search]);
    const soldByOption = await this.soldByOption(companyId);
    const items = rows.map((r) => this.shape(r, soldByOption));
    const filter = query.filter ?? 'all';
    const filtered = items.filter((p) => filter === 'all' ? true : filter === 'tracked' ? p.track_stock : filter === 'untracked' ? !p.track_stock
      : filter === 'low' ? p.track_stock && p.state === 'low' : p.track_stock && p.state === 'out');
    const tracked = items.filter((p) => p.track_stock);
    return {
      totals: {
        products: items.length,
        tracked: tracked.length,
        low: tracked.filter((p) => p.state === 'low').length,
        out: tracked.filter((p) => p.state === 'out').length,
        stock_value: Math.round(tracked.reduce((sum, p) => sum + Math.max(0, p.stock) * num(p.price), 0)),
      },
      products: filtered,
    };
  }

  async product(user: AuthenticatedUser, productId: number) {
    const list = await this.list(user, {});
    const found = list.products.find((p) => p.id === productId);
    if (!found) throw new NotFoundException('Product not found');
    const movements = await this.movements(user, { product_id: productId, limit: 50 });
    return { ...found, movements };
  }

  async movements(user: AuthenticatedUser, query: StockMovementsDto) {
    const rows: Array<Record<string, any>> = await this.dataSource.query(`
      SELECT m.id, m.product_id, p.name AS product_name, m.option_label, m.order_id, m.change, m.stock_after, m.reason, m.note,
             m.created_at, u.name AS by_name
        FROM product_stock_movement m
        JOIN product p ON p.id = m.product_id
        LEFT JOIN app_user u ON u.id = m.created_by_user_id
       WHERE m.company_id = $1 AND ($2::int IS NULL OR m.product_id = $2)
       ORDER BY m.id DESC LIMIT $3`, [Number(user.company_id), query.product_id ?? null, query.limit ?? 100]);
    return rows.map((r) => ({ ...r, id: num(r.id), product_id: num(r.product_id), order_id: r.order_id == null ? null : num(r.order_id), change: num(r.change), stock_after: num(r.stock_after) }));
  }

  /** Counts for the menu badge and the dashboard. */
  async alerts(user: AuthenticatedUser) {
    const rows: Array<Record<string, any>> = await this.dataSource.query(`
      SELECT p.id, p.name, p.quantity, p.low_stock_level, p.has_variants,
             (SELECT v.variants FROM product_variant v WHERE v.product_id = p.id ORDER BY v.id LIMIT 1) AS options
        FROM product p WHERE p.company_id = $1 AND p.is_deleted = false AND p.track_stock = true`, [Number(user.company_id)]);
    const items = rows.map((r) => this.shape({ ...r, track_stock: true }, new Map()));
    const low = items.filter((p) => p.state === 'low');
    const out = items.filter((p) => p.state === 'out');
    return { low: low.length, out: out.length, items: [...out, ...low].slice(0, 20).map((p) => ({ id: p.id, name: p.name, state: p.state, stock: p.stock, alert_options: p.alert_options })) };
  }

  private async soldByOption(companyId: number): Promise<Map<string, number>> {
    const rows: Array<{ product_id: number; variant_text: string | null; sold: string }> = await this.dataSource.query(`
      SELECT i.product_id, i.variant_text, SUM(i.quantity) AS sold FROM bot_order_item i JOIN bot_order o ON o.id = i.order_id
       WHERE o.company_id = $1 AND o.status::text <> 'Cancelled' AND o.created_at > NOW() - INTERVAL '30 days' AND i.product_id IS NOT NULL
       GROUP BY 1, 2`, [companyId]);
    const map = new Map<string, number>();
    for (const r of rows) map.set(`${num(r.product_id)}|${String(r.variant_text ?? '').toLowerCase()}`, num(r.sold));
    return map;
  }

  private shape(r: Record<string, any>, soldByOption: Map<string, number>) {
    const options: StockOption[] = r.has_variants && Array.isArray(r.options) ? r.options : [];
    const level = num(r.low_stock_level);
    const optionRows = options.map((o) => {
      const label = optionLabel(o);
      const stock = num(o.quantity);
      const sold = [...soldByOption.entries()].filter(([key]) => key.startsWith(`${num(r.id)}|`) && findOption([o], key.slice(String(r.id).length + 1)) === 0)
        .reduce((sum, [, value]) => sum + value, 0);
      return { label, stock, state: stockState(stock, level), available: o.available !== false, auto_off: Boolean(o.auto_off), sold_30: sold, days_left: daysLeft(stock, sold, 30) };
    });
    const stock = options.length ? optionRows.reduce((sum, o) => sum + Math.max(0, o.stock), 0) : num(r.quantity);
    // a product with options is "low" / "out" when any option is
    const worst = options.length
      ? (optionRows.some((o) => o.state === 'out') ? 'out' : optionRows.some((o) => o.state === 'low') ? 'low' : 'ok')
      : stockState(stock, level);
    return {
      id: num(r.id), name: String(r.name ?? ''), sku: r.sku ?? '', brand: r.brand ?? null, image_url: r.image_url ?? null, price: num(r.price),
      track_stock: Boolean(r.track_stock), stock, low_stock_level: level, state: worst as 'out' | 'low' | 'ok',
      is_available: r.is_available !== false, stock_auto_off: Boolean(r.stock_auto_off), reorder_days: r.reorder_days == null ? null : num(r.reorder_days),
      sold_30: num(r.sold_30), days_left: daysLeft(stock, num(r.sold_30), 30),
      last_restock: r.last_restock ?? null,
      options: optionRows,
      alert_options: optionRows.filter((o) => o.state !== 'ok').map((o) => `${o.label}: ${o.stock}`),
    };
  }
}

@Controller('stock')
@ApiTags('Stock')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Get('products') @ManagerOnly()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: StockListDto) { return this.stock.list(user, query); }

  @Get('alerts') @ManagerOnly()
  alerts(@CurrentUser() user: AuthenticatedUser) { return this.stock.alerts(user); }

  @Get('movements') @ManagerOnly()
  movements(@CurrentUser() user: AuthenticatedUser, @Query() query: StockMovementsDto) { return this.stock.movements(user, query); }

  @Get('products/:id') @ManagerOnly()
  product(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.stock.product(user, id); }

  @Patch('products/:id') @ManagerOnly()
  settings(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: StockSettingsDto) { return this.stock.settings(user, id, dto); }

  @Post('products/:id/adjust') @ManagerOnly()
  adjust(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: StockAdjustDto) { return this.stock.adjust(user, id, dto); }
}
