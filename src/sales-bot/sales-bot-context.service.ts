import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BotOrder } from '../bot-admin/entities/bot-order.entity';
import { BotTrainingData } from '../bot-admin/entities/bot-training-data.entity';
import { Company } from '../company/entities/company.entity';
import { Product } from '../products/entities/product.entity';
import type { ProductVariantOption } from '../products/entities/product-variant.entity';
import { BotDeliveryZone } from './entities/bot-delivery-zone.entity';
import { BotService } from './entities/bot-service.entity';
import { SalesBotSettings } from './entities/sales-bot-settings.entity';

export type ContextVariant = { variant_id: number; name: string; price: number; stock: number | null; available?: boolean; image_url: string | null; weight_kg: number | null };
export type ContextProduct = {
  id: number;
  name: string;
  category: string;
  price: number;
  stock: number | null;
  available?: boolean;
  photo_count: number;
  image_urls: string[];
  description: string;
  selling_points: string;
  /** kg, null = not set */
  weight_kg: number | null;
  variants: ContextVariant[];
  related_product_ids: number[];
};
export type SalesBotContext = {
  company: {
    id: number; name: string; business_type: 'shop' | 'service' | 'both'; about: string; opening_hours: string;
    payment_methods: string; tone: string; greeting: string; default_language: string; bot_name: string;
  };
  products: ContextProduct[];
  services: Array<{ service_id: number; name: string; description: string; price: number; price_note: string; duration_min: number | null; available: boolean }>;
  /** included_kg + per_extra_kg set = weight rule (fee = fee + extra kg × per_extra_kg) */
  delivery_zones: Array<{ area: string; fee: number; days: string; included_kg: number | null; per_extra_kg: number | null }>;
  policies: Array<{ question: string; answer: string }>;
  styles: Array<{ question: string; answer: string }>;
  faqs: Array<{ question: string; answer: string }>;
  last_order: Record<string, unknown> | null;
  /** The customer's orders that are not delivered or cancelled (newest first) – for changes and cancellations */
  open_orders: Array<Record<string, unknown>>;
  /** whatsapp | messenger | instagram */
  channel: string;
};

const MAX_PRODUCTS = 400;

/** products | services | both ("auto" follows the company's business category). */
export function effectiveSellsOf(company: Pick<Company, 'business_category'> | null, settings: Pick<SalesBotSettings, 'sells'>): 'products' | 'services' | 'both' {
  const sells = String(settings.sells ?? 'auto');
  if (sells === 'products' || sells === 'services' || sells === 'both') return sells;
  const category = String(company?.business_category ?? '').toLowerCase();
  return category === 'both' ? 'both' : category === 'service' ? 'services' : 'products';
}
const toNumber = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Label shown to customers for one variant option, e.g. "Red / M". */
export function variantLabel(option: ProductVariantOption): string {
  const name = String(option.variant_name ?? '').trim();
  const value = String(option.variant_value ?? '').trim();
  if (!value) return name;
  if (!name || name === value || name.includes('/') || value.toLowerCase().startsWith(name.toLowerCase())) return value;
  return `${name}: ${value}`;
}

/** Real price of a variant: its own price, else the price-match table, else the product price. */
export function variantPrice(product: Product, option: ProductVariantOption): number {
  if (option.price !== undefined && option.price !== null && Number.isFinite(Number(option.price))) {
    return Number(option.price);
  }
  const prices = product.variant_price_match?.prices ?? {};
  const value = String(option.variant_value ?? '').trim();
  const fromMatch = prices[value] ?? prices[variantLabel(option)];
  if (fromMatch !== undefined && Number.isFinite(Number(fromMatch))) return Number(fromMatch);
  return toNumber(product.price);
}

export function productOptions(product: Product): ProductVariantOption[] {
  const row = product.variants?.[0];
  return product.has_variants && Array.isArray(row?.variants) ? row.variants : [];
}

export function productImages(product: Product): string[] {
  const urls = [product.image_url ?? '', ...(Array.isArray(product.gallery) ? product.gallery : [])]
    .map((url) => String(url ?? '').trim())
    .filter((url) => /^https?:\/\//i.test(url));
  return [...new Set(urls)];
}

/** Product weight in kg (null when not set). */
export function productWeight(product: Pick<Product, 'weight'>): number | null {
  const kg = Number(product.weight);
  return product.weight != null && Number.isFinite(kg) && kg > 0 ? kg : null;
}

/** Variant weight in kg from the variant JSON (null when not set). */
export function optionWeight(option: ProductVariantOption): number | null {
  const kg = Number(option.weight);
  return option.weight != null && Number.isFinite(kg) && kg > 0 ? kg : null;
}

/** Availability → what the Python bot reads as stock: 0 = not available now, null = available (no counts). */
function productStock(product: Product): number | null {
  return product.is_available === false ? 0 : null;
}

/**
 * Builds everything the Python sales bot needs for one reply.
 * The bot keeps the fixed part cached with Gemini, so sending it every time is cheap.
 */
@Injectable()
export class SalesBotContextService {
  constructor(
    @InjectRepository(Company) private readonly companyRepository: Repository<Company>,
    @InjectRepository(SalesBotSettings) private readonly settingsRepository: Repository<SalesBotSettings>,
    @InjectRepository(Product) private readonly productRepository: Repository<Product>,
    @InjectRepository(BotService) private readonly serviceRepository: Repository<BotService>,
    @InjectRepository(BotDeliveryZone) private readonly zoneRepository: Repository<BotDeliveryZone>,
    @InjectRepository(BotTrainingData) private readonly trainingRepository: Repository<BotTrainingData>,
    @InjectRepository(BotOrder) private readonly orderRepository: Repository<BotOrder>,
  ) {}

  async getSettings(companyId: number): Promise<SalesBotSettings> {
    const existing = await this.settingsRepository.findOne({ where: { company_id: companyId } });
    return existing ?? this.settingsRepository.create({
      company_id: companyId, bot_name: '', tone: 'friendly, short, helpful', default_language: 'auto',
      greeting: '', about: '', opening_hours: '', payment_methods: '', auto_enable_new_customers: true,
      sells: 'auto', auto_send_invoice: true, bot_off_on_handoff: false,
    });
  }

  async loadProducts(companyId: number): Promise<Product[]> {
    return this.productRepository.find({
      where: { company_id: companyId, is_deleted: false, show_to_bot: true },
      relations: ['category', 'variants'],
      order: { name: 'ASC' },
      take: MAX_PRODUCTS,
    });
  }

  async build(companyId: number, channelUserId: number | null, channel = 'whatsapp'): Promise<SalesBotContext> {
    const [company, settings, products, services, zones, knowledge, lastOrder, openOrders] = await Promise.all([
      this.companyRepository.findOne({ where: { id: companyId } }),
      this.getSettings(companyId),
      this.loadProducts(companyId),
      this.serviceRepository.find({ where: { company_id: companyId, is_active: true }, order: { name: 'ASC' }, take: 100 }),
      this.zoneRepository.find({ where: { company_id: companyId }, order: { area: 'ASC' } }),
      this.trainingRepository.find({ where: { company_id: companyId, is_active: true }, order: { id: 'DESC' }, take: 800 }),
      channelUserId
        ? this.orderRepository.findOne({ where: { company_id: companyId, bot_channel_user_id: channelUserId }, relations: ['items'], order: { id: 'DESC' } })
        : Promise.resolve(null),
      channelUserId
        ? this.orderRepository
            .createQueryBuilder('o')
            .leftJoinAndSelect('o.items', 'items')
            .where('o.company_id = :companyId AND o.bot_channel_user_id = :channelUserId', { companyId, channelUserId })
            .andWhere("o.status::text NOT IN ('Delivered', 'Cancelled')")
            .orderBy('o.id', 'DESC')
            .take(3)
            .getMany()
        : Promise.resolve([] as BotOrder[]),
    ]);

    const policies: SalesBotContext['policies'] = [];
    const styles: SalesBotContext['styles'] = [];
    const faqs: SalesBotContext['faqs'] = [];
    for (const row of knowledge) {
      const entry = { question: String(row.question ?? '').trim(), answer: String(row.answer ?? '').trim().slice(0, 1500) };
      if (!entry.answer) continue;
      const category = String(row.category ?? '').trim().toLowerCase();
      if (category === 'policy' || category === 'policies') policies.push(entry);
      else if (category === 'style') styles.push(entry);
      else faqs.push(entry);
    }

    return {
      company: {
        id: companyId,
        name: company?.name ?? '',
        business_type: ({ products: 'shop', services: 'service', both: 'both' } as const)[effectiveSellsOf(company, settings)],
        about: settings.about,
        opening_hours: settings.opening_hours,
        payment_methods: settings.payment_methods,
        tone: settings.tone,
        greeting: settings.greeting,
        default_language: settings.default_language || 'auto',
        bot_name: settings.bot_name,
      },
      products: products.map((product) => this.toContextProduct(product, new Set(products.map((p) => p.id)))),
      services: services.map((service) => ({
        service_id: service.id, name: service.name, description: service.description,
        price: toNumber(service.price), price_note: service.price_note, duration_min: service.duration_min,
        available: service.is_available !== false,
      })),
      delivery_zones: zones.map((zone) => ({
        area: zone.area, fee: toNumber(zone.fee), days: zone.days,
        included_kg: zone.included_kg == null ? null : toNumber(zone.included_kg),
        per_extra_kg: zone.per_extra_kg == null ? null : toNumber(zone.per_extra_kg),
      })),
      policies: policies.slice(0, 40),
      styles: styles.slice(0, 300),
      faqs: faqs.slice(0, 300),
      last_order: lastOrder
        ? {
            order_id: lastOrder.id,
            status: lastOrder.status,
            total: toNumber(lastOrder.total_amount),
            delivery_fee: lastOrder.delivery_fee == null ? null : toNumber(lastOrder.delivery_fee),
            address: lastOrder.address,
            date: lastOrder.created_at ? new Date(lastOrder.created_at).toISOString().slice(0, 10) : null,
            items: (lastOrder.items ?? []).map((item) => ({
              name: item.product_name, variant: item.variant_text, qty: item.quantity, price: toNumber(item.total_price),
            })),
          }
        : null,
      open_orders: openOrders.map((order) => ({
        order_id: order.id,
        status: order.status,
        date: order.created_at ? new Date(order.created_at).toISOString().slice(0, 10) : null,
        total: toNumber(order.total_amount),
        delivery_fee: order.delivery_fee == null ? null : toNumber(order.delivery_fee),
        delivery_area: order.delivery_area,
        address: order.address,
        customer_name: order.customer_name,
        customer_phone: order.customer_phone,
        // pending = the bot may change or cancel it; other statuses = only a request for the team
        can_change: order.status === 'Pending',
        items: (order.items ?? []).map((item) => ({
          product_id: item.product_id, name: item.product_name, variant: item.variant_text,
          qty: item.quantity, price: toNumber(item.total_price),
        })),
      })),
      channel,
    };
  }

  toContextProduct(product: Product, visibleIds?: Set<number>): ContextProduct {
    const images = productImages(product);
    const options = productOptions(product);
    return {
      id: product.id,
      name: product.name,
      category: product.category?.name ?? '',
      price: toNumber(product.price),
      stock: productStock(product),
      available: product.is_available !== false,
      photo_count: images.length,
      image_urls: images,
      description: String(product.description ?? '').slice(0, 600),
      selling_points: String(product.selling_points ?? '').slice(0, 1000),
      weight_kg: productWeight(product),
      variants: options.map((option, index) => ({
        variant_id: index + 1,
        name: variantLabel(option),
        price: variantPrice(product, option),
        stock: product.is_available === false || option.available === false ? 0 : null,
        available: product.is_available !== false && option.available !== false,
        image_url: option.image_url?.trim() || null,
        weight_kg: optionWeight(option) ?? productWeight(product),
      })),
      // only add-ons the bot can actually sell
      related_product_ids: (product.related_product_ids ?? []).map(Number).filter((id) => !visibleIds || visibleIds.has(id)),
    };
  }
}
