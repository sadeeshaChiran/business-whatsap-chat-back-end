import { BrandingService } from '../branding.service';
import { resolveLimits } from '../package-limits';
import { offerFields, priceFor } from '../package-offer';
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
import type { BankDetailsDto, CheckoutDto, PaypalRateDto, TokenPackDto } from './billing.dto';
import { PaymentsLkError, lkrCents, paymentsLk, paymentsLkConfig, paymentsLkEnabled, verifyPaymentsLkSignature } from './paymentslk';
import { PaypalError, approveLink, marketUsdRate, paypal, paypalConfig, paypalEnabled, usd, verifyWebhook } from './paypal';
import { addSmsCredits } from '../../sms/sms-wallet';
import { buildInvoicePdf } from './invoice-pdf';
import { cancelPayhereSubscription, checkoutHash, payhereAmount, payhereConfig, payhereEnabled, payhereStatus, verifyNotifySignature } from './payhere';

type UploadedFile = { buffer: Buffer; mimetype: string; originalname: string; size: number };
const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const rs = (value: number) => `Rs ${num(value).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
type Row = Record<string, any>;
type PaypalSetting = { rate_mode: 'auto' | 'fixed'; fixed_rate: number | null; markup_percent: number; last_rate?: number | null; last_rate_at?: string | null; products?: Record<string, string>; plans?: Record<string, string> };

/**
 * Agent Metra billing.
 * Packages monthly / yearly and token packs, paid by PayHere (card, optional auto-renew), PayPal (US dollars at the
 * rate of the day, optional auto-renew) or bank transfer (slip upload → super admin approval). A paid payment activates the package / tokens and gets an invoice PDF.
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
    this.timer = setInterval(() => { void this.sendRenewalReminders(); void this.quota.sweepTrials(); void this.renewWithSavedCards(); }, 60 * 60 * 1000);
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
      amount_usd: payment.amount_usd != null ? num(payment.amount_usd) : null, usd_rate: payment.usd_rate != null ? num(payment.usd_rate) : null,
    };
  }

  async overview(user: AuthenticatedUser) {
    const companyId = Number(user.company_id);
    const [usage, sub, packages, packs, bank, payments] = await Promise.all([
      this.quota.usage(companyId),
      this.quota.ensure(companyId),
      // public packages + a custom package made for this company
      this.packageRepository.createQueryBuilder('p')
        .where('p.is_active = TRUE AND ((p.is_public = TRUE AND p.company_id IS NULL) OR p.company_id = :companyId)', { companyId })
        .orderBy('p.company_id IS NULL', 'ASC').addOrderBy('p.sort_order', 'ASC').addOrderBy('p.id', 'ASC').getMany(),
      this.packRepository.find({ where: { is_active: true }, order: { sort_order: 'ASC', id: 'ASC' } }),
      this.bankDetails(),
      this.paymentRepository.find({ where: { company_id: companyId }, order: { id: 'DESC' }, take: 50 }),
    ]);
    const [tpc, perReply] = await Promise.all([this.planService.tokensPerCredit(), this.planService.tokensPerReply()]);
    const credits = (tokens: number) => Math.round((num(tokens) / tpc) * 10) / 10;
    return {
      usage,
      subscription: { auto_renew: sub.auto_renew, period_end: sub.period_end, billing_cycle: sub.billing_cycle, status: sub.status, is_trial: sub.is_trial },
      packages: packages.map((pkg) => ({
        id: pkg.id, code: pkg.code, name: pkg.name, description: pkg.description, price_monthly: num(pkg.price_monthly),
        price_yearly: num(pkg.price_yearly), tokens_per_month: num(pkg.tokens_per_month), max_agents: pkg.max_agents, features: pkg.features ?? [],
        credits_per_month: credits(num(pkg.tokens_per_month)), custom: pkg.company_id != null, bot_days: pkg.bot_days ?? null,
        max_products: pkg.max_products, max_services: pkg.max_services ?? null, limits: resolveLimits(pkg), ...offerFields(pkg, perReply, num(pkg.tokens_per_month)),
      })),
      token_packs: packs.map((pack) => ({ id: pack.id, name: pack.name, tokens: num(pack.tokens), credits: credits(num(pack.tokens)), price: num(pack.price), valid_days: pack.valid_days })),
      sms_packs: await this.smsPacks(companyId),
      bank_details: bank,
      payhere_enabled: payhereEnabled(),
      paypal: await this.paypalOffer(),
      paymentslk_enabled: paymentsLkEnabled(),
      payments: payments.map((payment) => this.paymentView(payment)),
    };
  }

  /** Agent Metra SMS packs – only while Agent Metra SMS is switched on (Super admin → SMS) and SMS is switched on for this company. */
  private async smsPacks(companyId: number): Promise<Array<{ id: number; name: string; credits: number; price: number }>> {
    if (!(await this.planService.hasFeature(companyId, 'sms'))) return [];
    const [setting] = await this.dataSource.query(`SELECT value FROM platform_setting WHERE key = 'sms'`).catch(() => []);
    if (setting?.value?.enabled !== true) return [];
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(`SELECT id, name, credits, price FROM sms_pack WHERE is_active ORDER BY sort_order, id`).catch(() => []);
    return rows.map((row) => ({ id: num(row.id), name: String(row.name), credits: num(row.credits), price: num(row.price) }));
  }

  async checkout(user: AuthenticatedUser, dto: CheckoutDto) {
    const company = await this.adminCompany(user);
    const companyId = Number(company.id);
    let amount = 0;
    let description = '';
    let pkg: PlatformPackage | null = null;
    let pack: TokenPack | null = null;
    let smsPackId: number | null = null;
    let smsCredits: number | null = null;
    let offerUsed = false;
    const cycle = dto.billing_cycle ?? 'monthly';
    if (dto.kind === 'subscription') {
      pkg = dto.package_id ? await this.packageRepository.findOne({ where: { id: dto.package_id, is_active: true } }) : null;
      if (pkg && pkg.company_id != null && Number(pkg.company_id) !== companyId) pkg = null; // someone else's custom package
      if (!pkg) throw new BadRequestException('Choose a package.');
      const price = priceFor(pkg, cycle);
      amount = price.amount;
      offerUsed = price.offer !== null;
      description = `${pkg.name} package – ${cycle === 'yearly' ? '1 year' : '1 month'}${offerUsed ? ` (offer price, until ${price.offer!.until})` : ''}`;
    } else if (dto.kind === 'sms_pack') {
      const smsPack = (await this.smsPacks(companyId)).find((item) => item.id === Number(dto.sms_pack_id));
      if (!smsPack || !(smsPack.price > 0)) throw new BadRequestException('Choose an SMS pack.');
      smsPackId = smsPack.id;
      smsCredits = smsPack.credits;
      amount = smsPack.price;
      description = `${smsPack.name} – ${smsPack.credits.toLocaleString('en-US')} SMS credits`;
    } else {
      pack = dto.token_pack_id ? await this.packRepository.findOne({ where: { id: dto.token_pack_id, is_active: true } }) : null;
      if (!pack) throw new BadRequestException('Choose a token pack.');
      amount = num(pack.price);
      description = `${pack.name} – ${Math.round((num(pack.tokens) / (await this.planService.tokensPerCredit())) * 10) / 10} AI credits`;
    }
    if (dto.method === 'payhere' && !payhereEnabled()) throw new BadRequestException('Card payments are not available yet. Please use bank transfer.');
    if (dto.method === 'paypal' && !paypalEnabled()) throw new BadRequestException('PayPal is not available yet. Please use bank transfer.');
    if (dto.method === 'paymentslk' && !paymentsLkEnabled()) throw new BadRequestException('Card payments are not available yet. Please use bank transfer.');
    // An offer price is paid once: PayHere / PayPal would keep charging the same amount after the offer ends.
    const autoRenew = dto.kind === 'subscription' && (dto.method === 'payhere' || dto.method === 'paypal' || dto.method === 'paymentslk') && Boolean(dto.auto_renew) && !offerUsed;

    const payment = this.paymentRepository.create({
      company_id: companyId, kind: dto.kind, package_id: pkg?.id ?? null, billing_cycle: dto.kind === 'subscription' ? cycle : null,
      token_pack_id: pack?.id ?? null, sms_pack_id: smsPackId, sms_credits: smsCredits, description, amount, currency: 'LKR', method: dto.method, status: 'pending', auto_renew: autoRenew,
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
    if (dto.method === 'paypal') return this.paypalCheckout(saved, pkg, cycle, autoRenew);
    if (dto.method === 'paymentslk') return this.plkCheckout(saved, user, company, autoRenew);

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
    if (sub.paypal_subscription_id) {
      // PayPal must really stop it – otherwise it keeps charging, so nothing changes here and the owner tries again
      const result = await this.cancelPaypalSubscription(sub.paypal_subscription_id, 'Auto-renew switched off in the dashboard');
      if (!result.ok) throw new BadRequestException(`PayPal did not stop the auto-renew yet (${result.message}). Please try again in a minute.`);
      message = 'Auto-renew cancelled at PayPal.';
    }
    if (sub.plk_card_id) {
      message = 'Auto-renew switched off – your saved card will not be charged.';
      const card = sub.plk_card_id;
      void paymentsLk('DELETE', `/cards/${encodeURIComponent(card)}`, undefined, `card-delete-${card}`).catch(() => undefined); // forget the card at Payments.lk too
    }
    await this.subscriptionRepository.update(Number(company.id), { auto_renew: false, paypal_subscription_id: null, plk_card_id: null, plk_renew_attempts: 0 });
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
        if (sub.is_trial) {
          // paying during a free trial: the trial becomes a normal package (same package → paid time starts after the trial)
          await this.dataSource.query(`UPDATE company_trial SET converted = TRUE, ended_at = COALESCE(ended_at, NOW()) WHERE company_id = $1 AND ended_at IS NULL`, [companyId]);
          sub.is_trial = false;
          sub.fallback_package_id = null;
          sub.trial_note = null;
        }
        sub.package_id = pkg.id;
        sub.billing_cycle = (payment.billing_cycle ?? 'monthly') as 'monthly' | 'yearly';
        sub.status = 'active';
        sub.period_end = num(payment.amount) > 0 ? addMonths(start, months) : null;
        sub.auto_renew = payment.auto_renew;
        if (payment.payhere_subscription_id) sub.payhere_subscription_id = payment.payhere_subscription_id;
        // one PayPal subscription at a time: another package / way of paying ends the old one (no double charges)
        const paypalSub = payment.paypal_subscription_id ?? null;
        if (sub.paypal_subscription_id && sub.paypal_subscription_id !== paypalSub) {
          const old = sub.paypal_subscription_id;
          void this.cancelPaypalSubscription(old, 'Changed package').then((r) => { if (!r.ok) this.logger.warn(`PayPal subscription ${old} not cancelled: ${r.message}`); });
        }
        sub.paypal_subscription_id = paypalSub;
        // Payments.lk auto-renew = the saved card; any other way of paying stops it
        const card = payment.method === 'paymentslk' && payment.auto_renew ? payment.plk_card_id : null;
        sub.plk_card_id = card;
        sub.plk_renew_attempts = 0;
        sub.plk_renew_last_at = null;
        if (payment.method === 'paymentslk' && payment.auto_renew && !card) sub.auto_renew = false; // card not kept (yet) – card.saved switches it on
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
    if (payment.kind === 'sms_pack' && payment.sms_pack_id) {
      const [smsPack] = await this.dataSource.query(`SELECT name, credits FROM sms_pack WHERE id = $1`, [payment.sms_pack_id]);
      // the credits promised at checkout (the pack may have changed since)
      const smsCredits = payment.sms_credits != null ? num(payment.sms_credits) : num(smsPack?.credits);
      if (smsCredits > 0) {
        await addSmsCredits(this.dataSource, companyId, smsCredits, 'buy', `Bought: ${smsPack?.name ?? 'SMS pack'} (payment #${payment.id})`, `payment-${payment.id}`, payment.created_by_user_id);
      }
    }
    this.quota.forget(companyId);
    this.planService.forgetCompany(companyId);
    await this.createInvoice(payment).catch((error) => this.logger.warn(`invoice for payment ${payment.id} not made now (made on download): ${error instanceof Error ? error.message : String(error)}`));
    const paidUsd = payment.method === 'paypal' && payment.amount_usd != null ? ` (US$ ${usd(num(payment.amount_usd))} by PayPal)` : '';
    await this.notify(companyId, 'MEDIUM', 'Payment received – thank you', `${payment.description}: ${rs(num(payment.amount))}${paidUsd}. Your invoice is ready in Billing.`);
  }

  private async createInvoice(payment: PlatformPayment) {
    const company = await this.companyRepository.findOne({ where: { id: Number(payment.company_id) } });
    const year = new Date(payment.paid_at ?? Date.now()).getFullYear();
    payment.invoice_no = payment.invoice_no ?? `AM-${year}-${String(payment.id).padStart(6, '0')}`;
    const method = payment.method === 'payhere' ? 'Card (PayHere)' : payment.method === 'paymentslk' ? 'Card (Payments.lk)' : payment.method === 'paypal' ? 'PayPal' : payment.method === 'bank_transfer' ? 'Bank transfer' : 'Free / manual';
    const paypalLine = payment.method === 'paypal' && payment.amount_usd != null
      ? [{ text: `Paid: US$ ${usd(num(payment.amount_usd))} (1 USD = Rs ${num(payment.usd_rate).toFixed(2)})${payment.paypal_payment_id ? ` · PayPal ${payment.paypal_payment_id}` : ''}` }] : [];
    const brand = BrandingService.current();
    const seller = [brand.company_name, brand.address, [brand.support_email, brand.support_phone].filter(Boolean).join(' · '), brand.website].filter(Boolean);
    const pdf = buildInvoicePdf([
      { text: brand.name, size: 22, bold: true, gap: 10 },
      ...(brand.by_line ? [{ text: brand.by_line, size: 11 }] : []),
      ...seller.map((text) => ({ text, size: 9 })),
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
      ...paypalLine,
      { text: `Payment method: ${method}` },
      { text: 'Status: PAID', bold: true },
      { text: `Thank you for choosing ${brand.name}.`, gap: 40 },
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
        .where("s.status = 'active' AND s.auto_renew = FALSE AND s.is_trial = FALSE AND s.period_end IS NOT NULL")
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
      paypal_payment_id: row.paypal_payment_id, paypal_subscription_id: row.paypal_subscription_id, plk_payment_id: row.plk_payment_id,
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

  async billingSettings() {
    const config = payhereConfig();
    return {
      payhere_enabled: payhereEnabled(), payhere_mode: config.sandbox ? 'sandbox' : 'live',
      payhere_merchant_id: config.merchantId ? `${config.merchantId.slice(0, 3)}•••${config.merchantId.slice(-2)}` : '',
      payhere_cancel_api: Boolean(config.appId && config.appSecret),
      notify_url: config.apiBase ? `${config.apiBase}/public/payhere/notify` : '(set PUBLIC_API_BASE_URL)',
      app_public_url: config.appBase || '(set APP_PUBLIC_URL)',
      paypal: await this.paypalAdminView(),
      paymentslk: (() => {
        const c = paymentsLkConfig();
        return { enabled: paymentsLkEnabled(), mode: c.key ? (c.live ? 'live' : 'sandbox') : null, webhook_set: Boolean(c.webhookSecret),
          webhook_url: c.apiBase ? `${c.apiBase}/public/paymentslk/webhook` : '(set PUBLIC_API_BASE_URL)' };
      })(),
    };
  }

  /* ───────────────────────── PayPal ───────────────────────── */

  private async paypalSetting(): Promise<PaypalSetting> {
    const row = await this.settingRepository.findOne({ where: { key: 'paypal' } });
    const v = (row?.value ?? {}) as Partial<PaypalSetting>;
    return { rate_mode: v.rate_mode === 'fixed' ? 'fixed' : 'auto', fixed_rate: v.fixed_rate != null ? num(v.fixed_rate) : null, markup_percent: num(v.markup_percent),
      last_rate: v.last_rate != null ? num(v.last_rate) : null, last_rate_at: v.last_rate_at ?? null, products: v.products ?? {}, plans: v.plans ?? {} };
  }

  private async savePaypalSetting(patch: Partial<PaypalSetting>) {
    const current = await this.paypalSetting();
    await this.settingRepository.save({ key: 'paypal', value: { ...current, ...patch } });
  }

  private fx: { at: number; rate: number } | null = null;

  /** Rupees for one US dollar: the super admin rate, or the rate of the day (checked every 6 hours, last known rate if offline). */
  async usdRate(): Promise<{ rate: number; markup_percent: number; source: 'fixed' | 'today' | 'last' }> {
    const setting = await this.paypalSetting();
    if (setting.rate_mode === 'fixed' && setting.fixed_rate) return { rate: setting.fixed_rate, markup_percent: setting.markup_percent, source: 'fixed' };
    if (this.fx && Date.now() - this.fx.at < 6 * 3600_000) return { rate: this.fx.rate, markup_percent: setting.markup_percent, source: 'today' };
    try {
      const rate = await marketUsdRate();
      this.fx = { at: Date.now(), rate };
      await this.savePaypalSetting({ last_rate: rate, last_rate_at: new Date().toISOString() });
      return { rate, markup_percent: setting.markup_percent, source: 'today' };
    } catch {
      const fresh = setting.last_rate && setting.last_rate_at && Date.now() - new Date(setting.last_rate_at).getTime() < 7 * 86_400_000;
      if (fresh) return { rate: setting.last_rate as number, markup_percent: setting.markup_percent, source: 'last' };
      if (setting.fixed_rate) return { rate: setting.fixed_rate, markup_percent: setting.markup_percent, source: 'fixed' };
      throw new BadRequestException('PayPal is not available right now (no dollar rate). Please try again later or pay by bank transfer.');
    }
  }

  /** Rupees → US dollars (+ markup), rounded up to the cent. */
  private async toUsd(amountRs: number) {
    const { rate, markup_percent } = await this.usdRate();
    const value = Math.ceil(((amountRs / rate) * (1 + markup_percent / 100)) * 100 - 1e-6) / 100;
    return { rate, usdAmount: Math.max(0.01, value), markup_percent };
  }

  /** For Billing: is PayPal on, and the rate to show "≈ $" next to rupee prices. */
  private async paypalOffer() {
    if (!paypalEnabled()) return { enabled: false, rate: null, markup_percent: 0 };
    try {
      const { rate, markup_percent } = await this.usdRate();
      return { enabled: true, rate: Math.round((rate / (1 + markup_percent / 100)) * 10000) / 10000, markup_percent };
    } catch {
      return { enabled: false, rate: null, markup_percent: 0 };
    }
  }

  private async paypalAdminView() {
    const config = paypalConfig();
    const setting = await this.paypalSetting();
    let rate: number | null = null; let rateError: string | null = null; let source: string | null = null;
    try { const r = await this.usdRate(); rate = r.rate; source = r.source; } catch (error) { rateError = error instanceof Error ? error.message : String(error); }
    return {
      enabled: paypalEnabled(), mode: config.live ? 'live' : 'sandbox',
      client_id: config.clientId ? `${config.clientId.slice(0, 6)}•••${config.clientId.slice(-4)}` : '',
      webhook_set: Boolean(config.webhookId),
      webhook_url: config.apiBase ? `${config.apiBase}/public/paypal/webhook` : '(set PUBLIC_API_BASE_URL)',
      rate_mode: setting.rate_mode, fixed_rate: setting.fixed_rate, markup_percent: setting.markup_percent,
      rate, rate_source: source, rate_error: rateError, last_rate_at: setting.last_rate_at,
    };
  }

  async setPaypalRate(dto: PaypalRateDto) {
    if (dto.rate_mode === 'fixed' && !(num(dto.fixed_rate) > 0)) throw new BadRequestException('Enter the rate (rupees for 1 US dollar).');
    if (num(dto.markup_percent) > 50) throw new BadRequestException('Markup: up to 50 %.');
    await this.savePaypalSetting({ rate_mode: dto.rate_mode, fixed_rate: dto.fixed_rate != null ? num(dto.fixed_rate) : null, markup_percent: num(dto.markup_percent) });
    this.fx = null;
    return this.billingSettings();
  }

  /** A PayPal billing plan for this package / cycle / dollar price (made once, then reused). */
  private async paypalPlan(pkg: PlatformPackage, cycle: 'monthly' | 'yearly', usdAmount: number): Promise<string> {
    const config = paypalConfig();
    const mode = config.live ? 'live' : 'sandbox';
    const setting = await this.paypalSetting();
    const key = `${mode}:${pkg.id}:${cycle}:${usd(usdAmount)}`;
    if (setting.plans?.[key]) return setting.plans[key];
    let productId = setting.products?.[mode];
    if (!productId) {
      const brand = BrandingService.current().name || 'Agent Metra';
      const product = await paypal('POST', '/v1/catalogs/products', { name: `${brand} packages`.slice(0, 127), type: 'SERVICE', category: 'SOFTWARE' });
      productId = String(product.id);
      await this.savePaypalSetting({ products: { ...(setting.products ?? {}), [mode]: productId } });
    }
    const plan = await paypal('POST', '/v1/billing/plans', {
      product_id: productId, name: `${pkg.name} – ${cycle === 'yearly' ? 'yearly' : 'monthly'} US$ ${usd(usdAmount)}`.slice(0, 127), status: 'ACTIVE',
      billing_cycles: [{ frequency: { interval_unit: cycle === 'yearly' ? 'YEAR' : 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
        pricing_scheme: { fixed_price: { value: usd(usdAmount), currency_code: 'USD' } } }],
      payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CANCEL', payment_failure_threshold: 2 },
    });
    const fresh = await this.paypalSetting();
    await this.savePaypalSetting({ plans: { ...(fresh.plans ?? {}), [key]: String(plan.id) } });
    return String(plan.id);
  }

  /** Starts PayPal: an order (pay once) or a subscription (auto-renew). The dashboard opens the approve link. */
  private async paypalCheckout(payment: PlatformPayment, pkg: PlatformPackage | null, cycle: 'monthly' | 'yearly', autoRenew: boolean) {
    const config = paypalConfig();
    const { rate, usdAmount } = await this.toUsd(num(payment.amount));
    payment.amount_usd = usdAmount;
    payment.usd_rate = rate;
    const returnUrl = `${config.appBase}/billing?payment=${payment.id}&result=paypal`;
    const cancelUrl = `${config.appBase}/billing?payment=${payment.id}&result=cancel`;
    const brand = (BrandingService.current().name || 'Agent Metra').slice(0, 127);
    let link: string | null = null;
    try {
      if (autoRenew && pkg) {
        const planId = await this.paypalPlan(pkg, cycle, usdAmount);
        const subscription = await paypal('POST', '/v1/billing/subscriptions', {
          plan_id: planId, custom_id: String(payment.id),
          application_context: { brand_name: brand, user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING', return_url: returnUrl, cancel_url: cancelUrl },
        });
        payment.paypal_subscription_id = String(subscription.id);
        link = approveLink(subscription);
      } else {
        const order = await paypal('POST', '/v2/checkout/orders', {
          intent: 'CAPTURE',
          purchase_units: [{ reference_id: payment.order_id, custom_id: String(payment.id), invoice_id: payment.order_id, description: payment.description.slice(0, 127),
            amount: { currency_code: 'USD', value: usd(usdAmount) } }],
          payment_source: { paypal: { experience_context: { brand_name: brand, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: returnUrl, cancel_url: cancelUrl } } },
        });
        payment.paypal_order_id = String(order.id);
        link = approveLink(order);
      }
    } catch (error) {
      payment.status = 'failed';
      await this.paymentRepository.save(payment);
      this.logger.warn(`PayPal checkout failed for ${payment.order_id}: ${error instanceof Error ? error.message : String(error)}`);
      throw new BadRequestException(error instanceof PaypalError ? error.message : 'PayPal could not start the payment. Please try again.');
    }
    const saved = await this.paymentRepository.save(payment);
    if (!link) throw new BadRequestException('PayPal did not give a payment page. Please try again.');
    return { payment: this.paymentView(saved), next: 'paypal' as const, paypal: { approve_url: link, amount_usd: usdAmount, usd_rate: rate } };
  }

  /** Back from PayPal: take the money (order) or check the subscription is active, then switch the package / credits on. */
  async confirmPaypal(user: AuthenticatedUser, paymentId: number) {
    const company = await this.adminCompany(user);
    const payment = await this.paymentRepository.findOne({ where: { id: paymentId, company_id: Number(company.id) } });
    if (!payment || payment.method !== 'paypal') throw new NotFoundException('Payment not found.');
    if (payment.status !== 'paid') {
      try {
        await this.settlePaypal(payment);
      } catch (error) {
        this.logger.warn(`PayPal check failed for ${payment.order_id}: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof PaypalError && error.status === 422) throw new BadRequestException(`${error.message}. Please try again or choose another way to pay.`);
        // anything else: PayPal's webhook finishes it; the page shows "still confirming"
      }
    }
    return this.paymentView(await this.paymentRepository.findOneByOrFail({ id: paymentId }));
  }

  /** Marks a PayPal payment paid exactly once (the return page and the webhook can both arrive). */
  private async claimPaid(payment: PlatformPayment, paypalPaymentId: string | null) {
    const rows: Row[] = await this.dataSource.query(
      `UPDATE platform_payment SET status = 'paid', paid_at = NOW(), paypal_payment_id = COALESCE($2, paypal_payment_id) WHERE id = $1 AND status <> 'paid' RETURNING id`,
      [payment.id, paypalPaymentId]).then((r: unknown) => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as Row[]);
    if (!rows.length) return false;
    try {
      await this.markPaid(await this.paymentRepository.findOneByOrFail({ id: payment.id }), null);
    } catch (error) {
      // not switched on → back to waiting, so the next return page / PayPal webhook retry switches it on
      await this.dataSource.query(`UPDATE platform_payment SET status = 'pending', paid_at = NULL WHERE id = $1`, [payment.id]).catch(() => undefined);
      throw error;
    }
    return true;
  }

  /** Checks PayPal and switches the payment on when the money is really there. Throws when PayPal / the database fails. */
  private async settlePaypal(payment: PlatformPayment) {
    if (payment.paypal_subscription_id) {
      const sub = await paypal('GET', `/v1/billing/subscriptions/${encodeURIComponent(payment.paypal_subscription_id)}`);
      if (String(sub.custom_id ?? '') !== String(payment.id)) return;
      // ACTIVE alone is not enough (the first charge can still fail): the first payment must be there, for the right amount
      const last = sub.billing_info?.last_payment?.amount;
      if (sub.status === 'ACTIVE' && last?.currency_code === 'USD' && last?.value === usd(num(payment.amount_usd))) await this.claimPaid(payment, null);
      else if (['CANCELLED', 'EXPIRED'].includes(String(sub.status)) && payment.status === 'pending') await this.paymentRepository.update(payment.id, { status: 'cancelled' });
      return;
    }
    if (!payment.paypal_order_id) return;
    let order = await paypal('GET', `/v2/checkout/orders/${encodeURIComponent(payment.paypal_order_id)}`);
    if (order.status === 'APPROVED') {
      try {
        order = await paypal('POST', `/v2/checkout/orders/${encodeURIComponent(payment.paypal_order_id)}/capture`, {}, { 'PayPal-Request-Id': `capture-${payment.order_id}` });
      } catch (error) {
        if (!(error instanceof PaypalError) || !JSON.stringify(error.details ?? '').includes('ORDER_ALREADY_CAPTURED')) throw error;
        order = await paypal('GET', `/v2/checkout/orders/${encodeURIComponent(payment.paypal_order_id)}`);
      }
    }
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (order.status === 'COMPLETED' && capture?.status === 'COMPLETED') {
      if (capture.amount?.currency_code !== 'USD' || capture.amount?.value !== usd(num(payment.amount_usd))) {
        this.logger.warn(`PayPal amount mismatch for ${payment.order_id}: ${JSON.stringify(capture.amount)}`);
        return;
      }
      await this.claimPaid(payment, String(capture.id));
    } else if (order.status === 'VOIDED' && payment.status === 'pending') {
      await this.paymentRepository.update(payment.id, { status: 'cancelled' });
    }
  }

  async cancelPaypalSubscription(id: string, reason: string): Promise<{ ok: boolean; message: string }> {
    try {
      await paypal('POST', `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason: reason.slice(0, 127) });
      return { ok: true, message: 'Cancelled' };
    } catch (error) {
      // already cancelled / gone = fine
      if (error instanceof PaypalError && (error.status === 404 || JSON.stringify(error.details ?? '').includes('SUBSCRIPTION_STATUS_INVALID'))) return { ok: true, message: 'Already cancelled' };
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** PayPal webhook: checked with PayPal first; every charge of a subscription extends the package.
   *  'error' = something failed here → 500, so PayPal sends it again (safe: every step is counted once). */
  async paypalWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<'ok' | 'invalid' | 'error'> {
    if (!(await verifyWebhook(headers, rawBody))) {
      this.logger.warn('PayPal webhook rejected (not verified)');
      return 'invalid';
    }
    let event: Row;
    try { event = JSON.parse(rawBody) as Row; } catch { return 'invalid'; }
    const resource = (event.resource ?? {}) as Row;
    const type = String(event.event_type ?? '');
    try {
      if (type === 'CHECKOUT.ORDER.APPROVED' || type === 'PAYMENT.CAPTURE.COMPLETED') {
        const orderId = type === 'CHECKOUT.ORDER.APPROVED' ? resource.id : resource.supplementary_data?.related_ids?.order_id;
        const payment = orderId ? await this.paymentRepository.findOne({ where: { paypal_order_id: String(orderId) } }) : null;
        if (payment && payment.status !== 'paid') await this.settlePaypal(payment);
      } else if (type === 'BILLING.SUBSCRIPTION.ACTIVATED') {
        const payment = await this.firstPaypalPayment(String(resource.id));
        if (payment && payment.status !== 'paid') await this.settlePaypal(payment);
      } else if (type === 'PAYMENT.SALE.COMPLETED' && resource.billing_agreement_id) {
        await this.paypalSubscriptionCharge(resource);
      } else if (['BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.EXPIRED'].includes(type)) {
        const rows: Row[] = await this.dataSource.query(
          `UPDATE company_subscription SET auto_renew = FALSE WHERE paypal_subscription_id = $1 AND auto_renew RETURNING company_id`, [String(resource.id)])
          .then((r: unknown) => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as Row[]);
        for (const row of rows) {
          await this.notify(Number(row.company_id), 'HIGH', 'PayPal auto-renew stopped',
            type.endsWith('SUSPENDED') ? 'PayPal could not take the payment. Renew in Billing before your package ends.' : 'Your package will not renew by itself any more. Renew in Billing before it ends.');
        }
      } else if (/^PAYMENT\.(CAPTURE|SALE)\.(REFUNDED|REVERSED)$/.test(type)) {
        await this.paypalRefund(type, resource);
      } else if (type === 'PAYMENT.CAPTURE.DENIED') {
        this.logger.warn(`PayPal capture denied: ${resource.id}`);
      }
    } catch (error) {
      this.logger.error(`PayPal webhook ${type} failed (PayPal will send it again): ${error instanceof Error ? error.message : String(error)}`);
      return 'error';
    }
    return 'ok';
  }

  /** Money given back (refund / chargeback): the payment is marked refunded and what it bought is taken back (full refunds). */
  private async paypalRefund(type: string, resource: Row) {
    // capture refunded: the refund links "up" to the capture · capture reversed: the capture itself · sale: sale_id / the sale
    const upId = String((resource.links ?? []).find((l: Row) => l.rel === 'up')?.href ?? '').split('/').pop() || null;
    const moneyId = type === 'PAYMENT.CAPTURE.REFUNDED' ? upId : type === 'PAYMENT.SALE.REFUNDED' ? String(resource.sale_id ?? upId ?? '') : String(resource.id ?? '');
    const payment = moneyId ? await this.paymentRepository.findOne({ where: { paypal_payment_id: moneyId } }) : null;
    if (!payment) { this.logger.warn(`PayPal ${type} for unknown payment ${moneyId}`); return; }
    const back = num(resource.amount?.value ?? resource.amount?.total);
    const full = !back || back >= num(payment.amount_usd) - 0.001;
    await this.applyRefund(payment, full, `${full ? 'Refunded' : `Part refunded (US$ ${usd(back)})`} by PayPal`, type);
  }

  /** Money given back: payment → refunded; a full refund takes back what it bought (package time, AI credits, SMS credits). */
  private async applyRefund(payment: PlatformPayment, full: boolean, note: string, source: string) {
    const rows: Row[] = await this.dataSource.query(
      `UPDATE platform_payment SET status = 'refunded', reject_reason = $2 WHERE id = $1 AND status = 'paid' RETURNING id`,
      [payment.id, note]).then((r: unknown) => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as Row[]);
    if (!rows.length) return; // already handled
    const companyId = Number(payment.company_id);
    if (full && payment.kind === 'subscription') {
      const months = payment.billing_cycle === 'yearly' ? 12 : 1;
      await this.dataSource.query(`UPDATE company_subscription SET period_end = GREATEST(NOW(), period_end - make_interval(months => $2)) WHERE company_id = $1 AND period_end IS NOT NULL`, [companyId, months]);
    }
    if (full && payment.kind === 'token_pack' && payment.token_pack_id) {
      const pack = await this.packRepository.findOne({ where: { id: payment.token_pack_id } });
      if (pack) {
        await this.adjustmentRepository.save(this.adjustmentRepository.create({
          company_id: companyId, tokens: -num(pack.tokens), reason: `Refunded: ${pack.name} (payment #${payment.id})`,
          expires_at: new Date(Date.now() + pack.valid_days * 86_400_000), created_by_user_id: null,
        }));
      }
    }
    if (full && payment.kind === 'sms_pack' && payment.sms_credits) {
      await addSmsCredits(this.dataSource, companyId, -num(payment.sms_credits), 'adjust', `Refunded: payment #${payment.id}`, `refund-${payment.id}`, null).catch((e) => this.logger.warn(`SMS credits not taken back for payment ${payment.id}: ${e instanceof Error ? e.message : String(e)}`));
    }
    this.quota.forget(companyId);
    this.planService.forgetCompany(companyId);
    this.logger.warn(`${source}: payment ${payment.id} (${payment.order_id}) marked refunded`);
    await this.notify(companyId, 'HIGH', 'Payment refunded', `${payment.description}: the payment was ${full ? 'refunded' : 'partly refunded'}${full ? ', so it is no longer active' : ''}.`);
  }

  private firstPaypalPayment(subscriptionId: string) {
    return this.paymentRepository.findOne({ where: { paypal_subscription_id: subscriptionId }, order: { id: 'ASC' } });
  }

  /** One charge of a PayPal subscription: the first charge pays the first payment, later ones are renewals.
   *  A charge from a subscription that is no longer this company's renewal is recorded for a refund, never activated. */
  private async paypalSubscriptionCharge(sale: Row) {
    const saleId = String(sale.id);
    const subId = String(sale.billing_agreement_id);
    if (await this.paymentRepository.findOne({ where: { paypal_payment_id: saleId } })) return;
    const original = await this.firstPaypalPayment(subId);
    if (!original) return;
    if (String(sale.amount?.currency ?? '') !== 'USD' || String(sale.amount?.total ?? '') !== usd(num(original.amount_usd))) {
      this.logger.warn(`PayPal sale ${saleId} amount ${JSON.stringify(sale.amount)} does not match ${original.order_id}`);
      return;
    }
    const first = (r: unknown) => ((Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as Row[]).length > 0;
    // the first charge: pays the first payment (or is stored on it, when the return page was quicker)
    if (original.status !== 'paid' && (await this.claimPaid(original, saleId))) return;
    if (first(await this.dataSource.query(`UPDATE platform_payment SET paypal_payment_id = $1 WHERE id = $2 AND paypal_payment_id IS NULL RETURNING id`, [saleId, original.id]))) return;

    const sub = await this.quota.ensure(Number(original.company_id));
    const current = sub.paypal_subscription_id === subId;
    // a later charge: one renewal row per sale (the unique sale id stops a second webhook)
    let renewal: PlatformPayment;
    try {
      renewal = await this.paymentRepository.save(this.paymentRepository.create({
        ...original, id: undefined, order_id: `${original.order_id}-R${Date.now().toString(36).toUpperCase()}`, paypal_order_id: null, paypal_payment_id: saleId,
        status: current ? 'pending' : 'cancelled', paid_at: null, invoice_no: null, invoice_media_key: null, reject_reason: current ? null : 'Charged by an old PayPal subscription – refund it in PayPal',
        // keep auto-renew as the owner has it now (switched off stays off)
        auto_renew: current ? sub.auto_renew : false,
        description: `${original.description.replace(/ \(auto-renew\)$/, '')} (auto-renew)`, created_at: undefined, updated_at: undefined,
      }));
    } catch (error) {
      if (await this.paymentRepository.findOne({ where: { paypal_payment_id: saleId } })) return; // the same sale arrived twice at once
      throw error;
    }
    if (!current) {
      this.logger.error(`PayPal sale ${saleId} from old subscription ${subId} (company ${original.company_id}) – payment ${renewal.id} recorded, refund it in PayPal`);
      void this.cancelPaypalSubscription(subId, 'Replaced by another package');
      return;
    }
    if (!sub.auto_renew) void this.cancelPaypalSubscription(subId, 'Auto-renew switched off in the dashboard'); // paid, so it counts – but stop the next one
    await this.claimPaid(renewal, null);
  }

  /* ───────────────────────── Payments.lk ───────────────────────── */

  /** Hosted checkout (card, LKR). Auto-renew keeps the card (saveCard) – later renewals charge it. */
  private async plkCheckout(payment: PlatformPayment, user: AuthenticatedUser, company: Company, autoRenew: boolean) {
    const config = paymentsLkConfig();
    const admin: { name?: string; email?: string } | undefined = (await this.dataSource.query(`SELECT name, email FROM app_user WHERE id = $1`, [user.id]))[0];
    let checkout: Row;
    try {
      checkout = await paymentsLk('POST', '/checkouts', {
        amountCents: lkrCents(num(payment.amount)), description: payment.description.slice(0, 200), reference: payment.order_id,
        successUrl: `${config.appBase}/billing?payment=${payment.id}&result=paymentslk`, cancelUrl: `${config.appBase}/billing?payment=${payment.id}&result=cancel`,
        customer: { name: String(admin?.name ?? company.name ?? 'Customer').slice(0, 100), ...(admin?.email ? { email: admin.email } : {}) },
        ...(autoRenew ? { saveCard: true } : {}), locale: 'en', expiresInMinutes: 60,
      }, `checkout-${payment.order_id}`);
    } catch (error) {
      await this.paymentRepository.update(payment.id, { status: 'failed' });
      this.logger.warn(`Payments.lk checkout failed for ${payment.order_id}: ${error instanceof Error ? error.message : String(error)}`);
      throw new BadRequestException(error instanceof PaymentsLkError ? error.message : 'The card payment could not start. Please try again.');
    }
    if (!checkout?.id || !checkout?.url) throw new BadRequestException('Payments.lk did not give a payment page. Please try again.');
    payment.plk_checkout_id = String(checkout.id);
    const saved = await this.paymentRepository.save(payment);
    return { payment: this.paymentView(saved), next: 'paymentslk' as const, paymentslk: { url: String(checkout.url) } };
  }

  /** Back from the Payments.lk page: the server asks Payments.lk (the return address alone proves nothing). */
  async confirmPaymentsLk(user: AuthenticatedUser, paymentId: number) {
    const company = await this.adminCompany(user);
    const payment = await this.paymentRepository.findOne({ where: { id: paymentId, company_id: Number(company.id) } });
    if (!payment || payment.method !== 'paymentslk') throw new NotFoundException('Payment not found.');
    if (payment.status !== 'paid') {
      try { await this.settlePlk(payment); } catch (error) {
        this.logger.warn(`Payments.lk check failed for ${payment.order_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return this.paymentView(await this.paymentRepository.findOneByOrFail({ id: paymentId }));
  }

  /** The Payments.lk payment of one of our payments (from its checkout, or the saved-card charge). */
  private async plkPaymentOf(payment: PlatformPayment): Promise<{ plk: Row | null; checkoutStatus: string | null }> {
    if (payment.plk_payment_id) return { plk: await paymentsLk('GET', `/payments/${encodeURIComponent(payment.plk_payment_id)}`), checkoutStatus: null };
    if (!payment.plk_checkout_id) return { plk: null, checkoutStatus: null };
    const checkout = await paymentsLk('GET', `/checkouts/${encodeURIComponent(payment.plk_checkout_id)}`);
    let plk: Row | null = checkout.payment && typeof checkout.payment === 'object' ? checkout.payment as Row : null;
    const plkId = typeof checkout.payment === 'string' ? checkout.payment : checkout.paymentId;
    if (!plk && plkId) plk = await paymentsLk('GET', `/payments/${encodeURIComponent(String(plkId))}`);
    return { plk, checkoutStatus: checkout.status ? String(checkout.status) : null };
  }

  /** Switches the payment on when Payments.lk says it succeeded for exactly this amount. Throws on API / database errors. */
  private async settlePlk(payment: PlatformPayment) {
    const { plk, checkoutStatus } = await this.plkPaymentOf(payment);
    const status = String(plk?.status ?? '');
    if (plk && status === 'succeeded') {
      if (num(plk.amountCents) !== lkrCents(num(payment.amount))) {
        this.logger.warn(`Payments.lk amount mismatch for ${payment.order_id}: ${plk.amountCents}`);
        return;
      }
      const card = plk.savedCardId ? String(plk.savedCardId) : payment.plk_card_id;
      await this.claimPlk(payment, String(plk.id), card ?? null);
    } else if ((status === 'failed' || ['expired', 'canceled', 'cancelled', 'failed'].includes(String(checkoutStatus))) && payment.status === 'pending') {
      const rows: Row[] = await this.dataSource.query(`UPDATE platform_payment SET status = $2 WHERE id = $1 AND status = 'pending' RETURNING id`,
        [payment.id, status === 'failed' || checkoutStatus === 'failed' ? 'failed' : 'cancelled']).then((r: unknown) => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as Row[]);
      if (rows.length && payment.order_id.includes('-R')) await this.renewalFailed(Number(payment.company_id), String(plk?.failureMessage ?? plk?.failureReason ?? 'the card was declined'));
    }
  }

  /** Paid exactly once (return page and webhook can both arrive); undone when switching on fails, so a retry can finish it. */
  private async claimPlk(payment: PlatformPayment, plkPaymentId: string, cardId: string | null) {
    const rows: Row[] = await this.dataSource.query(
      `UPDATE platform_payment SET status = 'paid', paid_at = NOW(), plk_payment_id = COALESCE(plk_payment_id, $2), plk_card_id = COALESCE($3, plk_card_id)
        WHERE id = $1 AND status <> 'paid' RETURNING id`, [payment.id, plkPaymentId, cardId]).then((r: unknown) => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as Row[]);
    if (!rows.length) return false;
    try {
      await this.markPaid(await this.paymentRepository.findOneByOrFail({ id: payment.id }), null);
    } catch (error) {
      await this.dataSource.query(`UPDATE platform_payment SET status = 'pending', paid_at = NULL WHERE id = $1`, [payment.id]).catch(() => undefined);
      throw error;
    }
    return true;
  }

  /** Payments.lk webhook (signed). 'error' → 500 so Payments.lk sends it again (every step is counted once). */
  async paymentsLkWebhook(rawBody: string, signature: string | undefined): Promise<'ok' | 'invalid' | 'error'> {
    if (!verifyPaymentsLkSignature(rawBody, signature, paymentsLkConfig().webhookSecret)) {
      this.logger.warn('Payments.lk webhook rejected (bad signature)');
      return 'invalid';
    }
    let event: Row;
    try { event = JSON.parse(rawBody) as Row; } catch { return 'invalid'; }
    const type = String(event.type ?? '');
    const data = (event.data ?? {}) as Row;
    try {
      if (type === 'payment.succeeded' || type === 'payment.failed') {
        const payment = await this.plkFind(data);
        if (payment && payment.status !== 'paid') await this.settlePlk(payment);
      } else if (type === 'checkout.expired') {
        const payment = data.id ? await this.paymentRepository.findOne({ where: { plk_checkout_id: String(data.id) } }) : null;
        if (payment && payment.status === 'pending') await this.paymentRepository.update(payment.id, { status: 'cancelled' });
      } else if (type === 'card.saved') {
        await this.plkCardSaved(data);
      } else if (type === 'card.save_failed') {
        const payment = await this.plkFind((data.payment as Row) ?? { id: data.paymentId });
        if (payment?.auto_renew) await this.notify(Number(payment.company_id), 'HIGH', 'Card not saved for auto-renew', 'Your payment went through, but the card could not be kept for auto-renew. Renew in Billing before your package ends.');
      } else if (type === 'refund.succeeded') {
        const plkId = typeof data.payment === 'object' && data.payment ? data.payment.id : data.payment ?? data.paymentId;
        const payment = plkId ? await this.paymentRepository.findOne({ where: { plk_payment_id: String(plkId) } }) : null;
        if (payment) {
          const back = num(data.amountCents);
          const full = !back || back >= lkrCents(num(payment.amount));
          await this.applyRefund(payment, full, `${full ? 'Refunded' : `Part refunded (Rs ${(back / 100).toFixed(2)})`} by Payments.lk`, 'Payments.lk refund');
        }
      }
    } catch (error) {
      this.logger.error(`Payments.lk webhook ${type} failed (it will be sent again): ${error instanceof Error ? error.message : String(error)}`);
      return 'error';
    }
    return 'ok';
  }

  /** Our payment for a Payments.lk payment object (by its id, its checkout, or our reference). */
  private async plkFind(data: Row): Promise<PlatformPayment | null> {
    if (data.id) {
      const byPayment = await this.paymentRepository.findOne({ where: { plk_payment_id: String(data.id) } });
      if (byPayment) return byPayment;
    }
    const checkoutId = data.checkoutId ?? (typeof data.checkout === 'object' && data.checkout ? data.checkout.id : data.checkout);
    if (checkoutId) {
      const byCheckout = await this.paymentRepository.findOne({ where: { plk_checkout_id: String(checkoutId) } });
      if (byCheckout) return byCheckout;
    }
    if (data.reference) {
      const byRef = await this.paymentRepository.findOne({ where: { order_id: String(data.reference), method: 'paymentslk' } });
      if (byRef) return byRef;
    }
    return null;
  }

  /** The card was kept after the payment: auto-renew can start. */
  private async plkCardSaved(card: Row) {
    if (!card.id) return;
    const payment = await this.plkFind((card.payment as Row) ?? { id: card.paymentId, checkoutId: card.checkoutId, reference: card.reference });
    if (!payment || !payment.auto_renew || payment.kind !== 'subscription') return;
    await this.paymentRepository.update(payment.id, { plk_card_id: String(card.id) });
    if (payment.status !== 'paid') return; // markPaid picks the card up
    // only while this payment is still the package's latest one
    const [latest] = await this.dataSource.query(`SELECT id FROM platform_payment WHERE company_id = $1 AND kind = 'subscription' AND status = 'paid' ORDER BY paid_at DESC NULLS LAST, id DESC LIMIT 1`, [payment.company_id]);
    if (Number(latest?.id) !== Number(payment.id)) return;
    await this.subscriptionRepository.update(Number(payment.company_id), { plk_card_id: String(card.id), auto_renew: true, plk_renew_attempts: 0, plk_renew_last_at: null });
  }

  /**
   * Auto-renew with the saved card (every hour): a day before the package ends the card is charged for the package
   * again; a decline is tried again the next day, up to 3 times, then auto-renew stops and the owner is told.
   */
  async renewWithSavedCards() {
    if (!paymentsLkEnabled()) return;
    try {
      const due: Row[] = await this.dataSource.query(`
        SELECT company_id FROM company_subscription
         WHERE status = 'active' AND auto_renew AND plk_card_id IS NOT NULL AND NOT is_trial AND period_end IS NOT NULL
           AND period_end < NOW() + INTERVAL '1 day' AND (plk_renew_last_at IS NULL OR plk_renew_last_at < NOW() - INTERVAL '23 hours')`);
      for (const row of due) await this.renewOne(Number(row.company_id)).catch((e) => this.logger.warn(`card renewal for company ${row.company_id}: ${e instanceof Error ? e.message : String(e)}`));
    } catch (error) {
      this.logger.warn(`card renewals failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async renewOne(companyId: number) {
    // one server wins this try (several API servers run the same hour)
    const claimed: Row[] = await this.dataSource.query(`
      UPDATE company_subscription SET plk_renew_last_at = NOW(), plk_renew_attempts = plk_renew_attempts + 1
       WHERE company_id = $1 AND auto_renew AND plk_card_id IS NOT NULL AND (plk_renew_last_at IS NULL OR plk_renew_last_at < NOW() - INTERVAL '23 hours')
       RETURNING plk_card_id, package_id, billing_cycle, plk_renew_attempts`, [companyId]).then((r: unknown) => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as Row[]);
    const sub = claimed[0];
    if (!sub) return;
    const waiting = await this.paymentRepository.findOne({ where: { company_id: companyId, method: 'paymentslk', status: 'pending', kind: 'subscription' }, order: { id: 'DESC' } });
    if (waiting?.plk_payment_id && Date.now() - new Date(waiting.created_at).getTime() < 2 * 86_400_000) return; // a charge is still processing
    const pkg = await this.packageRepository.findOne({ where: { id: Number(sub.package_id) } });
    if (!pkg || !pkg.is_active) { await this.renewalFailed(companyId, 'the package is no longer offered', true); return; }
    const cycle = (sub.billing_cycle === 'yearly' ? 'yearly' : 'monthly') as 'monthly' | 'yearly';
    const amount = priceFor(pkg, cycle).amount;
    if (!(amount > 0)) return;
    const renewal = await this.paymentRepository.save(this.paymentRepository.create({
      company_id: companyId, kind: 'subscription', package_id: pkg.id, billing_cycle: cycle, description: `${pkg.name} package – ${cycle === 'yearly' ? '1 year' : '1 month'} (auto-renew)`,
      amount, currency: 'LKR', method: 'paymentslk', status: 'pending', auto_renew: true, plk_card_id: String(sub.plk_card_id),
      order_id: `AM${companyId}-R${Date.now().toString(36).toUpperCase()}`, created_by_user_id: null,
    }));
    let charge: Row;
    try {
      charge = await paymentsLk('POST', `/cards/${encodeURIComponent(String(sub.plk_card_id))}/charge`,
        { amountCents: lkrCents(amount), description: renewal.description.slice(0, 200), reference: renewal.order_id }, `renew-${renewal.order_id}`);
    } catch (error) {
      await this.paymentRepository.update(renewal.id, { status: 'failed', reject_reason: (error instanceof Error ? error.message : String(error)).slice(0, 250) });
      await this.renewalFailed(companyId, error instanceof Error ? error.message : String(error));
      return;
    }
    if (charge?.id) await this.paymentRepository.update(renewal.id, { plk_payment_id: String(charge.id) });
    const fresh = await this.paymentRepository.findOneByOrFail({ id: renewal.id });
    if (charge?.status === 'succeeded' || charge?.status === 'failed') await this.settlePlk(fresh); // else processing → payment.succeeded / payment.failed webhook
  }

  /** A renewal try failed: tell the owner; after the 3rd try (or when it cannot work) auto-renew stops. */
  private async renewalFailed(companyId: number, reason: string, final = false) {
    const [sub] = await this.dataSource.query(`SELECT plk_renew_attempts FROM company_subscription WHERE company_id = $1`, [companyId]);
    if (final || num(sub?.plk_renew_attempts) >= 3) {
      await this.subscriptionRepository.update(companyId, { auto_renew: false, plk_card_id: null, plk_renew_attempts: 0 });
      await this.notify(companyId, 'HIGH', 'Auto-renew stopped', `Your saved card could not be charged (${reason}). Renew in Billing to keep your package.`);
    } else {
      await this.notify(companyId, 'HIGH', 'Card renewal did not go through', `Your saved card could not be charged (${reason}). We try again tomorrow – or renew in Billing now.`);
    }
  }
}
