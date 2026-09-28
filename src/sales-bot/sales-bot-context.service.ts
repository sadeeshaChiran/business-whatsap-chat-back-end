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

export type ContextVariant = { variant_id: number; name: string; price: number; stock: number | null; image_url: string | null };
export type ContextProduct = {
  id: number;
  name: string;
  category: string;
  price: number;
  stock: number | null;
  photo_count: number;
  image_urls: string[];
  description: string;
  selling_points: string;
  variants: ContextVariant[];
  related_product_ids: number[];
};
export type SalesBotContext = {
  company: {
    id: number; name: string; business_type: 'shop' | 'service'; about: string; opening_hours: string;
    payment_methods: string; tone: string; greeting: string; default_language: string; bot_name: string;
  };
  products: ContextProduct[];
  services: Array<{ service_id: number; name: string; description: string; price: number; price_note: string; duration_min: number | null }>;
  delivery_zones: Array<{ area: string; fee: number; days: string }>;
  policies: Array<{ question: string; answer: string }>;
  styles: Array<{ question: string; answer: string }>;
  faqs: Array<{ question: string; answer: string }>;
  last_order: Record<string, unknown> | null;
};

const MAX_PRODUCTS = 400;
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

function productStock(product: Product): number | null {
  if (/out\s*of\s*stock/i.test(product.status ?? '')) return 0;
  const quantity = toNumber(product.quantity);
  return quantity > 0 ? quantity : null; // 0 usually means "not tracked"
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
    });
  }

  async loadProducts(companyId: number): Promise<Product[]> {
    return this.productRepository.find({
      where: { company_id: companyId, is_deleted: false },
      relations: ['category', 'variants'],
      order: { name: 'ASC' },
      take: MAX_PRODUCTS,
    });
  }

  async build(companyId: number, channelUserId: number | null): Promise<SalesBotContext> {
    const [company, settings, products, services, zones, knowledge, lastOrder] = await Promise.all([
      this.companyRepository.findOne({ where: { id: companyId } }),
      this.getSettings(companyId),
      this.loadProducts(companyId),
      this.serviceRepository.find({ where: { company_id: companyId, is_active: true }, order: { name: 'ASC' }, take: 100 }),
      this.zoneRepository.find({ where: { company_id: companyId }, order: { area: 'ASC' } }),
      this.trainingRepository.find({ where: { company_id: companyId, is_active: true }, order: { id: 'DESC' }, take: 800 }),
      channelUserId
        ? this.orderRepository.findOne({ where: { company_id: companyId, bot_channel_user_id: channelUserId }, relations: ['items'], order: { id: 'DESC' } })
        : Promise.resolve(null),
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
        business_type: String(company?.business_category ?? '').toLowerCase() === 'service' ? 'service' : 'shop',
        about: settings.about,
        opening_hours: settings.opening_hours,
        payment_methods: settings.payment_methods,
        tone: settings.tone,
        greeting: settings.greeting,
        default_language: settings.default_language || 'auto',
        bot_name: settings.bot_name,
      },
      products: products.map((product) => this.toContextProduct(product)),
      services: services.map((service) => ({
        service_id: service.id, name: service.name, description: service.description,
        price: toNumber(service.price), price_note: service.price_note, duration_min: service.duration_min,
      })),
      delivery_zones: zones.map((zone) => ({ area: zone.area, fee: toNumber(zone.fee), days: zone.days })),
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
    };
  }

  toContextProduct(product: Product): ContextProduct {
    const images = productImages(product);
    const options = productOptions(product);
    return {
      id: product.id,
      name: product.name,
      category: product.category?.name ?? '',
      price: toNumber(product.price),
      stock: productStock(product),
      photo_count: images.length,
      image_urls: images,
      description: String(product.description ?? '').slice(0, 600),
      selling_points: '',
      variants: options.map((option, index) => ({
        variant_id: index + 1,
        name: variantLabel(option),
        price: variantPrice(product, option),
        stock: typeof option.quantity === 'number' && option.quantity > 0 ? option.quantity : null,
        image_url: option.image_url?.trim() || null,
      })),
      related_product_ids: [],
    };
  }
}
