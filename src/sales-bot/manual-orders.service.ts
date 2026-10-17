import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { BotAdminService } from '../bot-admin/bot-admin.service';
import { BotConversation } from '../bot-admin/entities/bot-conversation.entity';
import { BotOrder } from '../bot-admin/entities/bot-order.entity';
import { BotOrderItem } from '../bot-admin/entities/bot-order-item.entity';
import { BotOrderStatusHistory } from '../bot-admin/entities/bot-order-status-history.entity';
import { Company } from '../company/entities/company.entity';
import { Product } from '../products/entities/product.entity';
import { bookingMinutes, formatMinutes, isFree, nearestFreeTimes, normalizeBookingDate } from './booking-slots';
import { findZone, orderDeliveryFee } from './delivery-fee';
import { BotBooking } from './entities/bot-booking.entity';
import { BotDeliveryZone } from './entities/bot-delivery-zone.entity';
import { BotService } from './entities/bot-service.entity';
import { SalesBotContextService } from './sales-bot-context.service';
import { SalesBotEngineService } from './sales-bot-engine.service';

export type ManualItem = { product_id: number; variant_id?: number | null; quantity: number };

/**
 * Orders and bookings the team adds from a chat (admin or the chat's agent). Only real catalog items: prices,
 * delivery fee (zone + weight + free delivery) and booking times are checked here, exactly like bot orders.
 * The invoice goes to the customer right away.
 */
@Injectable()
export class ManualOrdersService {
  constructor(
    @InjectRepository(Company) private readonly companyRepository: Repository<Company>,
    @InjectRepository(BotConversation) private readonly conversationRepository: Repository<BotConversation>,
    @InjectRepository(BotOrder) private readonly orderRepository: Repository<BotOrder>,
    @InjectRepository(BotOrderItem) private readonly orderItemRepository: Repository<BotOrderItem>,
    @InjectRepository(BotOrderStatusHistory) private readonly historyRepository: Repository<BotOrderStatusHistory>,
    @InjectRepository(BotBooking) private readonly bookingRepository: Repository<BotBooking>,
    @InjectRepository(BotService) private readonly serviceRepository: Repository<BotService>,
    @InjectRepository(BotDeliveryZone) private readonly zoneRepository: Repository<BotDeliveryZone>,
    @InjectRepository(Product) private readonly productRepository: Repository<Product>,
    private readonly engine: SalesBotEngineService,
    private readonly contextService: SalesBotContextService,
    private readonly botAdminService: BotAdminService,
  ) {}

  /** Company admin, or the agent who holds this chat. */
  private async access(user: AuthenticatedUser, conversationId: number) {
    const companyId = Number(user.company_id);
    const conversation = await this.conversationRepository.findOne({ where: { id: conversationId }, relations: ['channelUser'] });
    if (!conversation?.channelUser || Number(conversation.channelUser.company_id) !== companyId) throw new NotFoundException('Conversation not found.');
    const company = await this.companyRepository.findOne({ where: { id: companyId } });
    const isAdmin = Number(company?.admin_user_id) === Number(user.id);
    if (!isAdmin && user.role !== 'supervisor' && Number(conversation.assigned_agent_id) !== Number(user.id)) {
      throw new ForbiddenException('You can only add orders for your own customers.');
    }
    return { companyId, conversation, channelUser: conversation.channelUser, isAdmin };
  }

  private who(user: AuthenticatedUser, isAdmin: boolean, conversation: BotConversation) {
    return {
      created_by: isAdmin ? 'admin' : 'agent',
      created_by_user_id: Number(user.id),
      // an agent's order counts for them; the admin's order counts for the agent who holds the chat
      agent_id: !isAdmin ? Number(user.id) : conversation.assigned_agent_id && conversation.status === 'active' ? Number(conversation.assigned_agent_id) : null,
    };
  }

  /** Products (with options) and services to pick from, plus the delivery areas. */
  async catalog(user: AuthenticatedUser, search = '') {
    const companyId = Number(user.company_id);
    const term = search.trim().toLowerCase();
    const products = await this.productRepository.find({
      where: { company_id: companyId, is_deleted: false }, relations: ['category', 'variants'], order: { name: 'ASC' }, take: 3000,
    });
    const matched = products.filter((product) => !term || `${product.name} ${product.category?.name ?? ''}`.toLowerCase().includes(term)).slice(0, 60);
    const services = await this.serviceRepository.find({ where: { company_id: companyId, is_active: true }, order: { name: 'ASC' }, take: 500 });
    const zones = await this.zoneRepository.find({ where: { company_id: companyId }, order: { area: 'ASC' } });
    return {
      products: matched.map((product) => {
        const row = this.contextService.toContextProduct(product);
        return {
          id: row.id, name: row.name, category: row.category, price: row.price, stock: row.stock, available: row.available !== false,
          weight_kg: row.weight_kg, image_url: row.image_urls[0] ?? null,
          variants: row.variants.map((variant) => ({
            variant_id: variant.variant_id, name: variant.name, price: variant.price, stock: variant.stock, available: variant.available !== false,
          })),
        };
      }),
      services: services
        .filter((service) => !term || service.name.toLowerCase().includes(term))
        .map((service) => ({ id: service.id, name: service.name, price: Number(service.price), duration_min: service.duration_min, available: service.is_available !== false })),
      zones: zones.map((zone) => ({ area: zone.area, fee: Number(zone.fee), days: zone.days })),
    };
  }

  /** Prices + delivery fee for the order being built (the same numbers the order will get). */
  async quote(user: AuthenticatedUser, items: ManualItem[], area?: string | null) {
    const companyId = Number(user.company_id);
    const priced = await this.engine.priceItems(companyId, items, { anyProduct: true });
    if (priced.problem) throw new BadRequestException(this.problemText(priced.problem));
    const subtotal = priced.items.reduce((sum, item) => sum + item.total_price, 0);
    const weight = Math.round(priced.items.reduce((sum, item) => sum + item.weight_kg * item.quantity, 0) * 1000) / 1000;
    const zones = await this.zoneRepository.find({ where: { company_id: companyId } });
    const zone = String(area ?? '').trim() ? findZone(zones, String(area)) : null;
    const freeOver = (await this.contextService.getSettings(companyId)).free_delivery_over;
    const fee = zone ? orderDeliveryFee(zone, weight, subtotal, freeOver) : null;
    return {
      items: priced.items, subtotal, weight_kg: weight, area: zone?.area ?? null,
      delivery_fee: fee, free_delivery: fee === 0 && freeOver != null && subtotal >= Number(freeOver),
      total: subtotal + (fee ?? 0),
      note: !String(area ?? '').trim() ? 'Add the area to calculate the delivery fee.' : zone ? null : 'No delivery fee for this area – set it in Delivery zones, or the team confirms it.',
    };
  }

  private problemText(problem: string) {
    if (problem.startsWith('unavailable:')) return `${problem.slice(12)} is not available now.`;
    if (problem.startsWith('choose_variant_for_')) return `Choose an option (size / colour …) for ${problem.slice(19)}.`;
    if (problem.startsWith('unknown_product_')) return 'A product in the order is not in your catalog.';
    return 'Check the products in the order.';
  }

  async createOrder(user: AuthenticatedUser, conversationId: number, dto: {
    items: ManualItem[]; customer_name?: string; customer_phone?: string; address?: string; delivery_area?: string;
    payment_method?: string; note?: string; send_invoice?: boolean;
  }) {
    const { companyId, conversation, channelUser, isAdmin } = await this.access(user, conversationId);
    if (!dto.items?.length) throw new BadRequestException('Add at least one product.');
    const quote = await this.quote(user, dto.items, dto.delivery_area);
    const name = (dto.customer_name ?? '').trim() || channelUser.display_name || '';
    const phone = (dto.customer_phone ?? '').replace(/[^\d+]/g, '') || (channelUser.platform === 'whatsapp' ? channelUser.external_user_id : '');
    const author = user.name || 'Team';
    const order = await this.orderRepository.save(this.orderRepository.create({
      company_id: companyId, bot_channel_user_id: channelUser.id, customer_name: name.slice(0, 255), customer_phone: phone.slice(0, 50),
      address: (dto.address ?? '').trim() || null, status: 'Pending', total_amount: quote.total, delivery_fee: quote.delivery_fee,
      delivery_area: quote.area, total_weight_kg: quote.weight_kg || null, payment_method: (dto.payment_method ?? '').trim() || null,
      admin_note: [`Added in the chat by ${author} (${isAdmin ? 'admin' : 'agent'}).`, (dto.note ?? '').trim() ? `📝 ${dto.note!.trim()}` : ''].filter(Boolean).join('\n'),
      ...this.who(user, isAdmin, conversation),
    }));
    for (const item of quote.items) {
      await this.orderItemRepository.save(this.orderItemRepository.create({
        order_id: order.id, product_id: item.product_id, product_name: item.product_name, variant_text: item.variant_name || null,
        quantity: item.quantity, unit_price: item.unit_price, total_price: item.total_price,
      }));
    }
    await this.historyRepository.save(this.historyRepository.create({
      order_id: order.id, status: 'Pending', message: `Order added in the chat by ${author}.`,
    }));
    const invoice = dto.send_invoice === false ? null
      : await this.botAdminService.sendInvoiceForCompany(companyId, order.id).catch((error: unknown) => ({ sent: false, message: error instanceof Error ? error.message : 'Invoice failed.' }));
    return { order_id: order.id, total: quote.total, delivery_fee: quote.delivery_fee, invoice_sent: Boolean(invoice?.sent), invoice_message: invoice?.message ?? null };
  }

  async createBooking(user: AuthenticatedUser, conversationId: number, dto: {
    service_id: number; date: string; time: string; customer_name?: string; notes?: string; send_invoice?: boolean;
  }) {
    const { companyId, conversation, channelUser, isAdmin } = await this.access(user, conversationId);
    const service = await this.serviceRepository.findOne({ where: { id: Number(dto.service_id), company_id: companyId } });
    if (!service) throw new BadRequestException('Choose a service from your list.');
    const date = normalizeBookingDate(dto.date);
    const start = bookingMinutes(dto.time);
    if (!date || start == null) throw new BadRequestException('Choose a date and a time.');
    const author = user.name || 'Team';
    const row = this.bookingRepository.create({
      company_id: companyId, bot_channel_user_id: channelUser.id, conversation_id: conversation.id,
      service_id: service.id, service_name: service.name, date, time: formatMinutes(start),
      customer_name: (dto.customer_name ?? '').trim() || channelUser.display_name || '',
      customer_phone: channelUser.platform === 'whatsapp' ? channelUser.external_user_id : null,
      notes: [`Added in the chat by ${author}.`, (dto.notes ?? '').trim()].filter(Boolean).join('\n'),
      status: 'requested', price: Number(service.price) || null, duration_min: service.duration_min ?? null,
      ...this.who(user, isAdmin, conversation),
    });
    const taken = await this.bookingRepository.manager.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [companyId, date]);
      const day = await this.contextService.bookingDay(companyId, date);
      const duration = day.durationOf(service.id);
      if (!isFree(day.busy, start, start + duration, day.capacity)) return nearestFreeTimes(day.busy, start, duration, day.capacity, 3, day.window);
      await manager.save(row);
      return null;
    });
    if (taken) {
      throw new BadRequestException(`${date} ${formatMinutes(start)} is already booked.${taken.length ? ` Free times: ${taken.join(', ')}.` : ' Choose another day.'}`);
    }
    const invoice = dto.send_invoice === false ? null
      : await this.botAdminService.sendBookingInvoiceForCompany(companyId, row.id).catch((error: unknown) => ({ sent: false, message: error instanceof Error ? error.message : 'Invoice failed.' }));
    return { booking_id: row.id, invoice_sent: Boolean(invoice?.sent), invoice_message: invoice?.message ?? null };
  }
}
