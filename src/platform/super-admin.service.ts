import { LIMIT_CATALOG, cleanLimits, resolveLimits } from './package-limits';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Company } from '../company/entities/company.entity';
import type { ListQueryDto, PackageDto, TokenAdjustmentDto, UpdatePackageDto, UpdateSubscriptionDto } from './dto/platform.dto';
import { CompanySubscription } from './entities/company-subscription.entity';
import { PlatformPackage } from './entities/platform-package.entity';
import { TokenAdjustment } from './entities/token-adjustment.entity';
import { offerFields } from './package-offer';
import { DEFAULT_TOKENS_PER_REPLY, PlanService } from './plan.service';
import { TokenQuotaService, addMonths } from './token-quota.service';

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Agent Metra platform admin (Metrocoding team): companies, packages, tokens, usage and real AI cost. */
@Injectable()
export class SuperAdminService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Company) private readonly companyRepository: Repository<Company>,
    @InjectRepository(PlatformPackage) private readonly packageRepository: Repository<PlatformPackage>,
    @InjectRepository(CompanySubscription) private readonly subscriptionRepository: Repository<CompanySubscription>,
    @InjectRepository(TokenAdjustment) private readonly adjustmentRepository: Repository<TokenAdjustment>,
    private readonly planService: PlanService,
    private readonly quota: TokenQuotaService,
  ) {}

  /* ───────────── Overview ───────────── */

  async overview() {
    const [totals] = await this.dataSource.query(`
      SELECT
        (SELECT COUNT(*) FROM companies)::int AS companies,
        (SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM bot_ai_usage WHERE created_at >= date_trunc('month', NOW()))::bigint AS tokens_this_month,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM bot_ai_usage WHERE created_at >= date_trunc('month', NOW())) AS cost_this_month,
        (SELECT COUNT(*) FROM bot_ai_usage WHERE created_at >= date_trunc('month', NOW()))::int AS replies_this_month,
        (SELECT COUNT(DISTINCT company_id) FROM bot_ai_usage WHERE created_at >= NOW() - INTERVAL '7 days')::int AS active_companies_7d`);
    const companies = await this.companies({});
    const byPackage: Record<string, number> = {};
    for (const row of companies) byPackage[row.package_name ?? 'None'] = (byPackage[row.package_name ?? 'None'] ?? 0) + 1;
    return {
      companies: num(totals?.companies),
      active_companies_7d: num(totals?.active_companies_7d),
      tokens_this_month: num(totals?.tokens_this_month),
      replies_this_month: num(totals?.replies_this_month),
      cost_this_month_usd: num(totals?.cost_this_month),
      by_package: byPackage,
      blocked: companies.filter((row) => row.blocked).length,
      near_limit: companies.filter((row) => !row.blocked && row.percent >= 0.8).length,
    };
  }

  /* ───────────── Companies ───────────── */

  async companies(query: ListQueryDto) {
    const search = String(query.search ?? '').trim().toLowerCase();
    const rows: Array<{ id: number; name: string; plan: string; status: string; created_at: Date; admin_email: string | null; agents: number; last_active: Date | null }> =
      await this.dataSource.query(`
        SELECT c.id, c.company_name AS name, c.plan, c.status, c.created_at,
               (SELECT email FROM app_user u WHERE u.id = c.admin_user_id) AS admin_email,
               (SELECT COUNT(*) FROM app_user u WHERE u.company_id = c.id)::int AS agents,
               (SELECT MAX(created_at) FROM bot_ai_usage a WHERE a.company_id = c.id) AS last_active
          FROM companies c
         WHERE $1 = '' OR LOWER(c.company_name) LIKE '%' || $1 || '%' OR c.id::text = $1
            OR EXISTS (SELECT 1 FROM app_user u WHERE u.company_id = c.id AND LOWER(u.email) LIKE '%' || $1 || '%')
         ORDER BY c.id DESC LIMIT 500`, [search]);
    const out: Array<Record<string, any> & { package_name: string | null; blocked: boolean; percent: number }> = [];
    // usage per company, 8 at a time (was one by one – slow with many companies)
    for (let index = 0; index < rows.length; index += 8) {
      const chunk = rows.slice(index, index + 8);
      const usages = await Promise.all(chunk.map((row) => this.quota.usage(Number(row.id))));
      const costs: Array<{ company_id: number; cost: string }> = chunk.length
        ? await this.dataSource.query(
            `SELECT a.company_id, COALESCE(SUM(a.cost_usd), 0) AS cost
               FROM bot_ai_usage a
               JOIN UNNEST($1::bigint[], $2::timestamptz[]) AS p(company_id, since) ON p.company_id = a.company_id AND a.created_at >= p.since
              GROUP BY a.company_id`,
            [chunk.map((row) => Number(row.id)), usages.map((usage) => usage.token_period_start)],
          )
        : [];
      const costById = new Map(costs.map((row) => [Number(row.company_id), num(row.cost)]));
      chunk.forEach((row, i) => {
        const usage = usages[i];
        out.push({
          id: Number(row.id), name: row.name, admin_email: row.admin_email, agents: num(row.agents),
          created_at: row.created_at, last_active: row.last_active, company_status: row.status ?? 'ACTIVE',
          package_id: usage.package?.id ?? null, package_name: usage.package?.name ?? null, plan: row.plan,
          billing_cycle: usage.billing_cycle, status: usage.status, period_end: usage.period_end,
          tokens_used: usage.used, tokens_quota: usage.quota, tokens_extra: usage.extra, percent: usage.percent,
          token_period_end: usage.token_period_end, blocked: usage.blocked, blocked_reason: usage.blocked_reason,
          cost_this_period_usd: costById.get(Number(row.id)) ?? 0,
        });
      });
    }
    return out;
  }

  async company(id: number) {
    const company = await this.companyRepository.findOne({ where: { id } });
    if (!company) throw new NotFoundException('Company not found.');
    const usage = await this.quota.usage(id);
    const adjustments = await this.adjustmentRepository.find({ where: { company_id: id }, order: { id: 'DESC' }, take: 50 });
    const daily: Array<{ day: string; tokens: number; cost: number; replies: number }> = await this.dataSource.query(`
      SELECT to_char(d, 'YYYY-MM-DD') AS day,
             COALESCE((SELECT SUM(input_tokens + output_tokens) FROM bot_ai_usage a WHERE a.company_id = $1 AND a.created_at::date = d::date), 0)::bigint AS tokens,
             COALESCE((SELECT SUM(cost_usd) FROM bot_ai_usage a WHERE a.company_id = $1 AND a.created_at::date = d::date), 0) AS cost,
             (SELECT COUNT(*) FROM bot_ai_usage a WHERE a.company_id = $1 AND a.created_at::date = d::date)::int AS replies
        FROM generate_series(CURRENT_DATE - 29, CURRENT_DATE, INTERVAL '1 day') d ORDER BY d`, [id]);
    return {
      id: Number(company.id), name: company.name, plan: company.plan, business_category: company.business_category,
      status: company.status ?? 'ACTIVE',
      usage,
      adjustments: adjustments.map((row) => ({ ...row, tokens: num(row.tokens), active: !row.expires_at || new Date(row.expires_at) > new Date() })),
      daily: daily.map((row) => ({ day: row.day, tokens: num(row.tokens), cost_usd: num(row.cost), replies: num(row.replies) })),
    };
  }

  async updateSubscription(id: number, dto: UpdateSubscriptionDto) {
    const company = await this.companyRepository.findOne({ where: { id } });
    if (!company) throw new NotFoundException('Company not found.');
    const sub = await this.quota.ensure(id);
    const now = new Date();
    this.planService.forgetCompany(id);
    if (dto.package_id !== undefined) {
      const pkg = await this.packageRepository.findOne({ where: { id: dto.package_id } });
      if (!pkg) throw new BadRequestException('Package not found.');
      sub.package_id = pkg.id;
      company.plan = pkg.code; // companies.plan keeps the package code (old code paths use it)
      await this.companyRepository.update(id, { plan: pkg.code });
      if (dto.period_end === undefined) {
        const cycle = dto.billing_cycle ?? sub.billing_cycle;
        const paid = Number(cycle === 'yearly' ? pkg.price_yearly : pkg.price_monthly) > 0;
        sub.period_start = now;
        sub.period_end = paid ? addMonths(now, cycle === 'yearly' ? 12 : 1) : null;
      }
      if (sub.status === 'expired') sub.status = 'active';
    }
    if (dto.billing_cycle !== undefined) sub.billing_cycle = dto.billing_cycle;
    if (dto.status !== undefined) sub.status = dto.status;
    if (dto.period_end !== undefined) {
      if (dto.period_end === null || dto.period_end === '') sub.period_end = null;
      else {
        const date = new Date(dto.period_end);
        if (Number.isNaN(date.getTime())) throw new BadRequestException('period_end must be a date.');
        sub.period_end = date;
        if (date > now && sub.status === 'expired') sub.status = 'active';
      }
    }
    if (dto.reset_tokens) {
      sub.token_period_start = now;
      sub.token_period_end = addMonths(now, 1);
      sub.warned_80_at = null;
      sub.warned_100_at = null;
    }
    await this.subscriptionRepository.save(sub);
    this.quota.forget(id);
    return this.company(id);
  }

  async addAdjustment(id: number, dto: TokenAdjustmentDto, user: AuthenticatedUser) {
    const company = await this.companyRepository.findOne({ where: { id } });
    if (!company) throw new NotFoundException('Company not found.');
    if (!dto.tokens) throw new BadRequestException('tokens cannot be 0.');
    await this.adjustmentRepository.save(this.adjustmentRepository.create({
      company_id: id, tokens: dto.tokens, reason: dto.reason.trim(), created_by_user_id: Number(user.id),
      expires_at: dto.expires_in_days ? new Date(Date.now() + dto.expires_in_days * 86_400_000) : null,
    }));
    // new tokens: allow the 100% warning again later this month
    await this.subscriptionRepository.update(id, { warned_100_at: null, ...(dto.tokens > 0 ? { warned_80_at: null } : {}) });
    this.quota.forget(id);
    return this.company(id);
  }

  /* ───────────── Packages ───────────── */

  async listPackages() {
    const packages = await this.packageRepository.find({ order: { sort_order: 'ASC', id: 'ASC' } });
    this.perReply = await this.planService.tokensPerReply();
    const counts: Array<{ package_id: number; n: number }> = await this.dataSource.query(
      `SELECT package_id, COUNT(*)::int AS n FROM company_subscription GROUP BY package_id`);
    return packages.map((pkg) => ({ ...this.packageView(pkg), companies: counts.find((c) => c.package_id === pkg.id)?.n ?? 0 }));
  }

  /** tokens per reply for the "≈ N AI replies" text (refreshed when the package list loads) */
  private perReply = DEFAULT_TOKENS_PER_REPLY;

  packageView(pkg: PlatformPackage) {
    return {
      offer_price_monthly: pkg.offer_price_monthly === null || pkg.offer_price_monthly === undefined ? null : num(pkg.offer_price_monthly),
      offer_price_yearly: pkg.offer_price_yearly === null || pkg.offer_price_yearly === undefined ? null : num(pkg.offer_price_yearly),
      offer_until: pkg.offer_until ? String(pkg.offer_until).slice(0, 10) : null,
      offer_label: pkg.offer_label ?? '',
      ...offerFields(pkg, this.perReply, num(pkg.tokens_per_month)),
      id: pkg.id, code: pkg.code, name: pkg.name, description: pkg.description,
      price_monthly: num(pkg.price_monthly), price_yearly: num(pkg.price_yearly), tokens_per_month: num(pkg.tokens_per_month),
      max_agents: pkg.max_agents, max_products: pkg.max_products, max_services: pkg.max_services ?? null, features: pkg.features ?? [],
      limits: resolveLimits(pkg), raw_limits: pkg.limits ?? {},
      is_active: pkg.is_active, is_public: pkg.is_public, sort_order: pkg.sort_order,
    };
  }

  async createPackage(dto: PackageDto) {
    checkOffer({ price_monthly: dto.price_monthly, price_yearly: dto.price_yearly, offer_price_monthly: dto.offer_price_monthly ?? null, offer_price_yearly: dto.offer_price_yearly ?? null, offer_until: dto.offer_until ?? null });
    const code = dto.code.trim().toLowerCase();
    if (await this.packageRepository.findOne({ where: { code } })) throw new ConflictException(`Package code "${code}" already exists.`);
    const saved = await this.packageRepository.save(this.packageRepository.create({
      ...dto, code, name: dto.name.trim(), description: dto.description?.trim() ?? '', features: dto.features ?? [],
      limits: cleanLimits(dto.limits),
      max_agents: dto.max_agents ?? null, max_products: dto.max_products ?? null, max_services: dto.max_services ?? null,
    }));
    this.planService.forget();
    return this.packageView(saved);
  }

  async updatePackage(id: number, dto: UpdatePackageDto) {
    const pkg = await this.packageRepository.findOne({ where: { id } });
    if (!pkg) throw new NotFoundException('Package not found.');
    const { limits, ...rest } = dto;
    Object.assign(pkg, Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)));
    if (typeof pkg.offer_label === 'string') pkg.offer_label = pkg.offer_label.trim();
    checkOffer(pkg);
    // merge: keys the super admin did not send keep their value
    if (limits !== undefined) pkg.limits = { ...(pkg.limits ?? {}), ...cleanLimits(limits) };
    const saved = await this.packageRepository.save(pkg);
    this.planService.forget();
    return this.packageView(saved);
  }

  /** What a package can switch on / limit (for the package editor). */
  limitCatalog() {
    return LIMIT_CATALOG;
  }

  /* ───────────── Credits ───────────── */

  async creditSettings() {
    return { tokens_per_credit: await this.planService.tokensPerCredit(), tokens_per_reply: await this.planService.tokensPerReply() };
  }

  async setCreditSettings(tokensPerCredit: number, tokensPerReply?: number) {
    if (!Number.isInteger(tokensPerCredit) || tokensPerCredit < 1000) throw new BadRequestException('tokens_per_credit must be at least 1,000.');
    const perReply = tokensPerReply ?? (await this.planService.tokensPerReply());
    await this.dataSource.query(
      `INSERT INTO platform_setting (key, value) VALUES ('credits', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify({ tokens_per_credit: tokensPerCredit, tokens_per_reply: perReply })]);
    this.planService.forget();
    return this.creditSettings();
  }

  /* ───────────── Usage & cost ───────────── */

  async usage(daysRaw?: number) {
    const days = Math.min(Math.max(Number(daysRaw) || 30, 1), 365);
    const perCompany: Array<Record<string, unknown>> = await this.dataSource.query(`
      SELECT a.company_id, c.company_name AS name, COUNT(*)::int AS replies,
             SUM(a.input_tokens + a.output_tokens)::bigint AS tokens, SUM(a.cost_usd) AS cost,
             AVG(a.latency_ms)::int AS avg_latency_ms
        FROM bot_ai_usage a LEFT JOIN companies c ON c.id = a.company_id
       WHERE a.created_at > NOW() - make_interval(days => $1::int)
       GROUP BY a.company_id, c.company_name ORDER BY SUM(a.cost_usd) DESC`, [days]);
    const daily: Array<Record<string, unknown>> = await this.dataSource.query(`
      SELECT to_char(d, 'YYYY-MM-DD') AS day,
             COALESCE((SELECT SUM(input_tokens + output_tokens) FROM bot_ai_usage a WHERE a.created_at::date = d::date), 0)::bigint AS tokens,
             COALESCE((SELECT SUM(cost_usd) FROM bot_ai_usage a WHERE a.created_at::date = d::date), 0) AS cost
        FROM generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, INTERVAL '1 day') d ORDER BY d`, [days]);
    return {
      days,
      companies: perCompany.map((row) => ({
        company_id: num(row.company_id), name: row.name ?? `#${row.company_id}`, replies: num(row.replies),
        tokens: num(row.tokens), cost_usd: num(row.cost), avg_latency_ms: num(row.avg_latency_ms),
        cost_per_reply_usd: num(row.replies) ? num(row.cost) / num(row.replies) : 0,
      })),
      daily: daily.map((row) => ({ day: String(row.day), tokens: num(row.tokens), cost_usd: num(row.cost) })),
      total_tokens: perCompany.reduce((sum, row) => sum + num(row.tokens), 0),
      total_cost_usd: perCompany.reduce((sum, row) => sum + num(row.cost), 0),
    };
  }
}

/** An offer must be cheaper than the normal price and needs an end date. */
function checkOffer(pkg: { price_monthly: number; price_yearly: number; offer_price_monthly: number | null; offer_price_yearly: number | null; offer_until: string | null }) {
  const monthly = pkg.offer_price_monthly === null || pkg.offer_price_monthly === undefined ? null : Number(pkg.offer_price_monthly);
  const yearly = pkg.offer_price_yearly === null || pkg.offer_price_yearly === undefined ? null : Number(pkg.offer_price_yearly);
  if (monthly !== null && monthly >= Number(pkg.price_monthly)) throw new BadRequestException('The monthly offer price must be lower than the normal monthly price.');
  if (yearly !== null && yearly >= Number(pkg.price_yearly)) throw new BadRequestException('The yearly offer price must be lower than the normal yearly price.');
  if ((monthly !== null || yearly !== null) && !pkg.offer_until) throw new BadRequestException('Set the last day of the offer.');
}
