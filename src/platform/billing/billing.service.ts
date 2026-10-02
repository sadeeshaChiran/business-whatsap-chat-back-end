import { resolveLimits } from '../package-limits';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { publicChatMediaUrl, readChatMedia, saveChatMedia } from '../../bot-admin/chat-media.store';
import { Company } from '../../company/entities/company.entity';
import { CompanySubscription } from '../entities/company-subscription.entity';
import { PlatformPackage } from '../entities/platform-package.entity';
import { PlatformPayment } from '../entities/platform-payment.entity';
import { PlatformSetting } from '../entities/platform-setting.entity';
import { TokenAdjustment } from '../entities/token-adjustment.entity';
import { TokenPack } from '../entities/token-pack.entity';
import { PlanService } from '../plan.service';
import { TokenQuotaService, addMonths } from '../token-quota.service';
import type { BankDetailsDto, CheckoutDto, TokenPackDto } from './billing.dto';
import { buildInvoicePdf } from './invoice-pdf';
import { cancelPayhereSubscription, checkoutHash, payhereAmount, payhereConfig, payhereEnabled, payhereStatus, verifyNotifySignature } from './payhere';

type UploadedFile = { buffer: Buffer; mimetype: string; originalname: string; size: number };
const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const rs = (value: number) => `Rs ${num(value).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Agent Metra billing.
 * Packages monthly / yearly and token packs, paid by PayHere (card, optional auto-renew) or bank transfer
 * (slip upload → super admin approval). A paid payment activates the package / tokens and gets an invoice PDF.
 */
@Injectable()
export class BillingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(PlatformPayment) private readonly paymentRepository: Repository<PlatformPayment>,
    @InjectRepository(TokenPack) private readonly packRepository: Repository<TokenPack>,
    @InjectRepository(PlatformSetting) private readonly settingRepository: Repository<PlatformSetting>,
    @InjectRepository(PlatformPackage) private readonly packageRepository: Repository<PlatformPackage>,
    @InjectRepository(CompanySubscription) private readonly subscriptionRepository: Repository<CompanySubscription>,
    @InjectRepository(TokenAdjustment) private readonly adjustmentRepository: Repository<TokenAdjustment>,
    @InjectRepository(Company) private readonly companyRepository: Repository<Company>,
    private readonly planService: PlanService,
    private readonly quota: TokenQuotaService,
  ) {}

  onModuleInit() {
    // renewal reminders once an hour
    this.timer = setInterval(() => void this.sendRenewalReminders(), 60 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async adminCompany(user: AuthenticatedUser): Promise<Company> {
    const company = await this.companyRepository.findOne({ where: { id: Number(user.company_id) } });
    if (!company || Number(company.admin_user_id) !== Number(user.id)) throw new ForbiddenException('Only the company admin can manage billing.');
    return company;
  }

  /* ───────────────────────── Company side ───────────────────────── */

  async bankDetails(): Promise<Record<string, string>> {
    const row = await this.settingRepository.findOne({ where: { key: 'bank_details' } });
    return (row?.value ?? {}) as Record<string, string>;
  }

  paymentView(payment: PlatformPayment) {
    return {
      id: payment.id, kind: payment.kind, description: payment.description, amount: num(payment.amount), currency: payment.currency,
      method: payment.method, status: payment.status, auto_renew: payment.auto_renew, billing_cycle: payment.billing_cycle,
      order_id: payment.order_id, has_slip: Boolean(payment.slip_media_key), reject_reason: payment.reject_reason,
      paid_at: payment.paid_at, invoice_no: payment.invoice_no, created_at: payment.created_at,
    };
  }

  async overview(user: AuthenticatedUser) {
    const companyId = Number(user.company_id);
    const [usage, sub, packages, packs, bank, payments] = await Promise.all([
      this.quota.usage(companyId),
      this.quota.ensure(companyId),
      this.packageRepository.find({ where: { is_active: true, is_public: true }, order: { sort_order: 'ASC', id: 'ASC' } }),
      this.packRepository.find({ where: { is_active: true }, order: { sort_order: 'ASC', id: 'ASC' } }),
      this.bankDetails(),
      this.paymentRepository.find({ where: { company_id: companyId }, order: { id: 'DESC' }, take: 50 }),
    ]);
    const tpc = await this.planService.tokensPerCredit();
    const credits = (tokens: number) => Math.round((num(tokens) / tpc) * 10) / 10;
    return {
      usage,
      subscription: { auto_renew: sub.auto_renew, period_end: sub.period_end, billing_cycle: sub.billing_cycle, status: sub.status },
      packages: packages.map((pkg) => ({
        id: pkg.id, code: pkg.code, name: pkg.name, description: pkg.description, price_monthly: num(pkg.price_monthly),
        price_yearly: num(pkg.price_yearly), tokens_per_month: num(pkg.tokens_per_month), max_agents: pkg.max_agents, features: pkg.features ?? [],
        credits_per_month: credits(num(pkg.tokens_per_month)),
        max_products: pkg.max_products, limits: resolveLimits(pkg),
      })),
      token_packs: packs.map((pack) => ({ id: pack.id, name: pack.name, tokens: num(pack.tokens), credits: credits(num(pack.tokens)), price: num(pack.price), valid_days: pack.valid_days })),
      bank_details: bank,
      payhere_enabled: payhereEnabled(),
      payments: payments.map((payment) => this.paymentView(payment)),
    };
  }

  async checkout(user: AuthenticatedUser, dto: CheckoutDto) {
    const company = await this.adminCompany(user);
    const companyId = Number(company.id);
    let amount = 0;
    let description = '';
    let pkg: PlatformPackage | null = null;
    let pack: TokenPack | null = null;
    const cycle = dto.billing_cycle ?? 'monthly';
    if (dto.kind === 'subscription') {
      pkg = dto.package_id ? await this.packageRepository.findOne({ where: { id: dto.package_id, is_active: true } }) : null;
      if (!pkg) throw new BadRequestException('Choose a package.');
      amount = num(cycle === 'yearly' ? pkg.price_yearly : pkg.price_monthly);
      description = `${pkg.name} package – ${cycle === 'yearly' ? '1 year' : '1 month'}`;
    } else {
      pack = dto.token_pack_id ? await this.packRepository.findOne({ where: { id: dto.token_pack_id, is_active: true } }) : null;
      if (!pack) throw new BadRequestException('Choose a token pack.');
      amount = num(pack.price);
      description = `${pack.name} – ${Math.round((num(pack.tokens) / (await this.planService.tokensPerCredit())) * 10) / 10} AI credits`;
    }
    if (dto.method === 'payhere' && !payhereEnabled()) throw new BadRequestException('Card payments are not available yet. Please use bank transfer.');
    const autoRenew = dto.kind === 'subscription' && dto.method === 'payhere' && Boolean(dto.auto_renew);

    const payment = this.paymentRepository.create({
      company_id: companyId, kind: dto.kind, package_id: pkg?.id ?? null, billing_cycle: dto.kind === 'subscription' ? cycle : null,
      token_pack_id: pack?.id ?? null, description, amount, currency: 'LKR', method: dto.method, status: 'pending', auto_renew: autoRenew,
      order_id: `AM${companyId}-${Date.now().toString(36).toUpperCase()}`, created_by_user_id: Number(user.id),
    });

    // Free package: nothing to pay
    if (amount <= 0) {
      payment.method = 'manual';
      const saved = await this.paymentRepository.save(payment);
      await this.markPaid(saved, null);
      return { payment: this.paymentView((await this.paymentRepository.findOneByOrFail({ id: saved.id }))), next: 'done' as const };
    }
    const saved = await this.paymentRepository.save(payment);
    if (dto.method === 'bank_transfer') {
      return { payment: this.paymentView(saved), next: 'upload_slip' as const, bank_details: await this.bankDetails() };
    }

    // PayHere checkout form (the dashboard posts it to PayHere)
    const config = payhereConfig();
    const admin: { name?: string; email?: string } | undefined = (await this.dataSource.query(`SELECT name, email FROM app_user WHERE id = $1`, [user.id]))[0];
    const [firstName, ...rest] = String(admin?.name ?? company.name ?? 'Customer').trim().split(/\s+/);
    const appBase = config.appBase || '';
    const fields: Record<string, string> = {
      merchant_id: config.merchantId,
      return_url: `${appBase}/billing?payment=${saved.id}&result=return`,
      cancel_url: `${appBase}/billing?payment=${saved.id}&result=cancel`,
      notify_url: `${config.apiBase}/public/payhere/notify`,
      first_name: firstName || 'Customer',
      last_name: rest.join(' ') || String(company.name ?? '-'),
      email: String(admin?.email ?? company.email ?? ''),
      phone: String(company.phone ?? '0000000000'),
      address: String(company.address ?? 'Sri Lanka'),
      city: 'Colombo',
      country: 'Sri Lanka',
      order_id: saved.order_id,
      items: description,
      currency: 'LKR',
      amount: payhereAmount(amount),
      custom_1: String(saved.id),
      hash: checkoutHash(config.merchantId, saved.order_id, amount, 'LKR', config.secret),
    };
    if (autoRenew) {
      fields.recurrence = cycle === 'yearly' ? '1 Year' : '1 Month';
      fields.duration = 'Forever';
    }
    return { payment: this.paymentView(saved), next: 'payhere' as const, payhere: { action: `${config.base}/pay/checkout`, fields } };
  }

  async uploadSlip(user: AuthenticatedUser, paymentId: number, file?: UploadedFile) {
    const company = await this.adminCompany(user);
    const payment = await this.paymentRepository.findOne({ where: { id: paymentId, company_id: Number(company.id) } });
    if (!payment) throw new NotFoundException('Payment not found.');
    if (payment.method !== 'bank_transfer' || !['pending', 'rejected'].includes(payment.status)) throw new BadRequestException('This payment does not need a bank slip.');
    if (!file?.buffer?.length) throw new BadRequestException('Upload the bank slip (photo or PDF).');
    if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.mimetype)) throw new BadRequestException('The slip must be a JPG, PNG, WEBP or PDF.');
    payment.slip_media_key = saveChatMedia(Number(company.id), file.buffer, file.mimetype, file.originalname || 'bank-slip');
    payment.slip_file_name = file.originalname || 'bank-slip';
    payment.status = 'awaiting_approval';
    payment.reject_reason = null;
    return this.paymentView(await this.paymentRepository.save(payment));
  }

  async setAutoRenew(user: AuthenticatedUser, enabled: boolean) {
    const company = await this.adminCompany(user);
    const sub = await this.quota.ensure(Number(company.id));
    if (enabled) throw new BadRequestException('Auto-renew is switched on by paying with a card and ticking "Renew automatically".');
    let message = 'Auto-renew switched off.';
    if (sub.payhere_subscription_id) {
      const result = await cancelPayhereSubscription(sub.payhere_subscription_id);
      message = result.ok ? 'Auto-renew cancelled at PayHere.' : `Switched off here. PayHere: ${result.message}`;
    }
    await this.subscriptionRepository.update(Number(company.id), { auto_renew: false });
    return { auto_renew: false, message };
  }

  async invoiceFile(companyId: number | null, paymentId: number) {
    const payment = await this.paymentRepository.findOne({ where: companyId ? { id: paymentId, company_id: companyId } : { id: paymentId } });
    if (!payment || payment.status !== 'paid') throw new NotFoundException('Invoice not found.');
    if (!payment.invoice_media_key || !readChatMedia(payment.invoice_media_key)) await this.createInvoice(payment);
    const file = readChatMedia(payment.invoice_media_key as string);
    if (!file) throw new NotFoundException('Invoice file missing.');
    return { buffer: file.buffer, fileName: `${payment.invoice_no ?? `invoice-${payment.id}`}.pdf` };
  }

  /* ───────────────────────── PayHere notify (public) ───────────────────────── */

  async payhereNotify(body: Record<string, string>): Promise<string> {
    const config = payhereConfig();
    if (!config.secret || body.merchant_id !== config.merchantId || !verifyNotifySignature(body, config.secret)) {
      this.logger.warn(`PayHere notify rejected (bad signature) for order ${body.order_id}`);
      return 'INVALID';
    }
    const payment = await this.paymentRepository.findOne({ where: { order_id: String(body.order_id) } });
    if (!payment) return 'UNKNOWN';
    if (payhereAmount(num(payment.amount)) !== String(body.payhere_amount) || String(body.payhere_currency) !== payment.currency) {
      this.logger.warn(`PayHere notify amount mismatch for order ${body.order_id}`);
      return 'AMOUNT_MISMATCH';
    }
    const status = payhereStatus(body.status_code);
    if (body.subscription_id && !payment.payhere_subscription_id) payment.payhere_subscription_id = String(body.subscription_id);

    if (status === 'paid') {
      // a later recurring charge on the same order → a new renewal payment
      if (payment.status === 'paid' && payment.payhere_payment_id && payment.payhere_payment_id !== String(body.payment_id)) {
        const exists = await this.paymentRepository.findOne({ where: { payhere_payment_id: String(body.payment_id) } });
        if (exists) return 'OK';
        const renewal = await this.paymentRepository.save(this.paymentRepository.create({
          ...payment, id: undefined, order_id: `${payment.order_id}-R${Date.now().toString(36).toUpperCase()}`,
          status: 'pending', paid_at: null, invoice_no: null, invoice_media_key: null, description: `${payment.description} (auto-renew)`,
          created_at: undefined, updated_at: undefined,
        }));
        await this.markPaid(renewal, String(body.payment_id));
        return 'OK';
      }
      if (payment.status !== 'paid') await this.markPaid(payment, String(body.payment_id ?? ''));
      else await this.paymentRepository.save(payment);
      return 'OK';
    }
    if (payment.status === 'pending') {
      payment.status = status === 'pending' ? 'pending' : status === 'cancelled' ? 'cancelled' : 'failed';
      await this.paymentRepository.save(payment);
    }
    if (status === 'chargedback') this.logger.warn(`PayHere charge back for order ${payment.order_id}`);
    return 'OK';
  }

  /* ───────────────────────── Activation ───────────────────────── */

  /** Marks a payment paid, activates the package / tokens and makes the invoice. */
  async markPaid(payment: PlatformPayment, payherePaymentId: string | null, reviewerId: number | null = null) {
    payment.status = 'paid';
    payment.paid_at = new Date();
    if (payherePaymentId) payment.payhere_payment_id = payherePaymentId;
    if (reviewerId) { payment.reviewed_by_user_id = reviewerId; payment.reviewed_at = new Date(); }
    await this.paymentRepository.save(payment);
    const companyId = Number(payment.company_id);

    if (payment.kind === 'subscription' && payment.package_id) {
      const pkg = await this.packageRepository.findOne({ where: { id: payment.package_id } });
      if (pkg) {
        const sub = await this.quota.ensure(companyId);
        const now = new Date();
        const months = payment.billing_cycle === 'yearly' ? 12 : 1;
        const samePackageStillValid = sub.package_id === pkg.id && sub.status === 'active' && sub.period_end && new Date(sub.period_end) > now;
        const start = samePackageStillValid ? new Date(sub.period_end as Date) : now;
        if (!samePackageStillValid) {
          sub.period_start = now;
          if (sub.package_id !== pkg.id) {
            // new package → fresh token month with the new quota
            sub.token_period_start = now;
            sub.token_period_end = addMonths(now, 1);
            sub.warned_80_at = null;
            sub.warned_100_at = null;
          }
        }
        sub.package_id = pkg.id;
        sub.billing_cycle = (payment.billing_cycle ?? 'monthly') as 'monthly' | 'yearly';
        sub.status = 'active';
        sub.period_end = num(payment.amount) > 0 ? addMonths(start, months) : null;
        sub.auto_renew = payment.auto_renew;
        if (payment.payhere_subscription_id) sub.payhere_subscription_id = payment.payhere_subscription_id;
        sub.reminded_7_at = null;
        sub.reminded_1_at = null;
        await this.subscriptionRepository.save(sub);
        await this.companyRepository.update(companyId, { plan: pkg.code });
      }
    }
    if (payment.kind === 'token_pack' && payment.token_pack_id) {
      const pack = await this.packRepository.findOne({ where: { id: payment.token_pack_id } });
      if (pack) {
        await this.adjustmentRepository.save(this.adjustmentRepository.create({
          company_id: companyId, tokens: num(pack.tokens), reason: `Bought: ${pack.name} (payment #${payment.id})`,
          expires_at: new Date(Date.now() + pack.valid_days * 86_400_000), created_by_user_id: payment.created_by_user_id,
        }));
        await this.subscriptionRepository.update(companyId, { warned_100_at: null, warned_80_at: null });
      }
    }
    this.quota.forget(companyId);
    this.planService.forgetCompany(companyId);
    await this.createInvoice(payment);
    await this.notify(companyId, 'MEDIUM', 'Payment received – thank you', `${payment.description}: ${rs(num(payment.amount))}. Your invoice is ready in Billing.`);
  }

  private async createInvoice(payment: PlatformPayment) {
    const company = await this.companyRepository.findOne({ where: { id: Number(payment.company_id) } });
    const year = new Date(payment.paid_at ?? Date.now()).getFullYear();
    payment.invoice_no = payment.invoice_no ?? `AM-${year}-${String(payment.id).padStart(6, '0')}`;
    const method = payment.method === 'payhere' ? 'Card (PayHere)' : payment.method === 'bank_transfer' ? 'Bank transfer' : 'Free / manual';
    const pdf = buildInvoicePdf([
      { text: 'Agent Metra', size: 22, bold: true, gap: 10 },
      { text: 'by Metrocoding', size: 11 },
      { text: 'INVOICE', size: 16, bold: true, gap: 40 },
      { text: `Invoice no: ${payment.invoice_no}` },
      { text: `Date: ${new Date(payment.paid_at ?? Date.now()).toISOString().slice(0, 10)}` },
      { text: `Order: ${payment.order_id}` },
      { text: 'Billed to', bold: true, gap: 30 },
      { text: String(company?.name ?? `Company #${payment.company_id}`) },
      { text: String(company?.email ?? '') },
      { text: 'Description', bold: true, gap: 30 },
      { text: payment.description },
      { text: `Amount: ${rs(num(payment.amount))} (${payment.currency})`, bold: true, gap: 24 },
      { text: `Payment method: ${method}` },
      { text: 'Status: PAID', bold: true },
      { text: 'Thank you for choosing Agent Metra.', gap: 40 },
    ]);
    payment.invoice_media_key = saveChatMedia(Number(payment.company_id), pdf, 'application/pdf', `${payment.invoice_no}.pdf`);
    await this.paymentRepository.save(payment);
  }

  private async notify(companyId: number, priority: 'MEDIUM' | 'HIGH', title: string, message: string) {
    await this.dataSource.query(`INSERT INTO bot_notification (company_id, kind, priority, title, message) VALUES ($1, 'billing', $2, $3, $4)`,
      [companyId, priority, title, message]).catch(() => undefined);
  }

  /** 7 and 1 days before a package ends (when it does not renew automatically). */
  async sendRenewalReminders() {
    try {
      const subs = await this.subscriptionRepository
        .createQueryBuilder('s')
        .where("s.status = 'active' AND s.auto_renew = FALSE AND s.period_end IS NOT NULL")
        .andWhere("s.period_end > NOW() AND s.period_end < NOW() + INTERVAL '7 days'")
        .getMany();
      for (const sub of subs) {
        const daysLeft = (new Date(sub.period_end as Date).getTime() - Date.now()) / 86_400_000;
        const date = new Date(sub.period_end as Date).toISOString().slice(0, 10);
        if (daysLeft <= 1 && !sub.reminded_1_at) {
          await this.notify(Number(sub.company_id), 'HIGH', 'Your package ends tomorrow', `Renew in Billing before ${date} to keep the AI bot working.`);
          await this.subscriptionRepository.update(Number(sub.company_id), { reminded_1_at: new Date(), reminded_7_at: sub.reminded_7_at ?? new Date() });
        } else if (!sub.reminded_7_at) {
          await this.notify(Number(sub.company_id), 'MEDIUM', 'Your package ends in 7 days', `Renew in Billing before ${date}.`);
          await this.subscriptionRepository.update(Number(sub.company_id), { reminded_7_at: new Date() });
        }
      }
    } catch (error) {
      this.logger.warn(`renewal reminders failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /* ───────────────────────── Super admin ───────────────────────── */

  async adminPayments(status?: string) {
    const rows = await this.paymentRepository.find({
      where: status ? { status: status as PlatformPayment['status'] } : {}, order: { id: 'DESC' }, take: 200,
    });
    const names = new Map<number, string>();
    for (const row of rows) {
      if (!names.has(Number(row.company_id))) {
        const company = await this.companyRepository.findOne({ where: { id: Number(row.company_id) } });
        names.set(Number(row.company_id), company?.name ?? `#${row.company_id}`);
      }
    }
    return rows.map((row) => ({
      ...this.paymentView(row), company_id: Number(row.company_id), company_name: names.get(Number(row.company_id)),
      slip_url: row.slip_media_key ? publicChatMediaUrl(row.slip_media_key, 3600) : null,
      slip_file_name: row.slip_file_name, payhere_payment_id: row.payhere_payment_id,
    }));
  }

  async slipFile(paymentId: number) {
    const payment = await this.paymentRepository.findOne({ where: { id: paymentId } });
    const file = payment?.slip_media_key ? readChatMedia(payment.slip_media_key) : null;
    if (!file) throw new NotFoundException('No slip.');
    return { buffer: file.buffer, contentType: file.contentType, fileName: payment?.slip_file_name ?? 'slip' };
  }

  async approve(paymentId: number, reviewer: AuthenticatedUser) {
    const payment = await this.paymentRepository.findOne({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found.');
    if (payment.status === 'paid') throw new BadRequestException('Already paid.');
    await this.markPaid(payment, null, Number(reviewer.id));
    return this.paymentView((await this.paymentRepository.findOneByOrFail({ id: paymentId })));
  }

  async reject(paymentId: number, reason: string, reviewer: AuthenticatedUser) {
    const payment = await this.paymentRepository.findOne({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found.');
    if (payment.status === 'paid') throw new BadRequestException('A paid payment cannot be rejected.');
    payment.status = 'rejected';
    payment.reject_reason = reason.trim();
    payment.reviewed_by_user_id = Number(reviewer.id);
    payment.reviewed_at = new Date();
    await this.paymentRepository.save(payment);
    await this.notify(Number(payment.company_id), 'HIGH', 'Bank slip not accepted', `${payment.description}: ${payment.reject_reason}. Please upload a new slip in Billing.`);
    return this.paymentView(payment);
  }

  async setBankDetails(dto: BankDetailsDto) {
    await this.settingRepository.save({ key: 'bank_details', value: { ...dto } });
    return this.bankDetails();
  }

  async listPacks() {
    return (await this.packRepository.find({ order: { sort_order: 'ASC', id: 'ASC' } }))
      .map((pack) => ({ ...pack, tokens: num(pack.tokens), price: num(pack.price) }));
  }

  async savePack(dto: TokenPackDto, id?: number) {
    const pack = id ? await this.packRepository.findOne({ where: { id } }) : this.packRepository.create({ valid_days: 30, is_active: true, sort_order: 0 });
    if (!pack) throw new NotFoundException('Token pack not found.');
    Object.assign(pack, Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined)));
    const saved = await this.packRepository.save(pack);
    return { ...saved, tokens: num(saved.tokens), price: num(saved.price) };
  }

  billingSettings() {
    const config = payhereConfig();
    return {
      payhere_enabled: payhereEnabled(), payhere_mode: config.sandbox ? 'sandbox' : 'live',
      payhere_merchant_id: config.merchantId ? `${config.merchantId.slice(0, 3)}•••${config.merchantId.slice(-2)}` : '',
      payhere_cancel_api: Boolean(config.appId && config.appSecret),
      notify_url: config.apiBase ? `${config.apiBase}/public/payhere/notify` : '(set PUBLIC_API_BASE_URL)',
      app_public_url: config.appBase || '(set APP_PUBLIC_URL)',
    };
  }
}
