import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformPackage } from './entities/platform-package.entity';
import { LIMIT_CATALOG, limitLabel, resolveLimits, type ResolvedLimits } from './package-limits';

/**
 * Package rules in one place (replaces the old hard-coded "Free only / max 3 agents").
 * companies.plan holds the package code.
 */
@Injectable()
export class PlanService {
  private cache: { at: number; packages: PlatformPackage[] } | null = null;

  constructor(@InjectRepository(PlatformPackage) private readonly packageRepository: Repository<PlatformPackage>) {}

  async packages(): Promise<PlatformPackage[]> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.packages;
    const packages = await this.packageRepository.find({ order: { sort_order: 'ASC', id: 'ASC' } }).catch(() => [] as PlatformPackage[]);
    this.cache = { at: Date.now(), packages };
    return packages;
  }

  forget() {
    this.cache = null;
    this.creditCache = null;
    this.companyPlans.clear();
  }

  private creditCache: { at: number; value: number } | null = null;

  /** 1 credit = this many AI tokens (super admin setting, default 50,000). Companies only see credits. */
  async tokensPerCredit(): Promise<number> {
    if (this.creditCache && Date.now() - this.creditCache.at < 30_000) return this.creditCache.value;
    const rows: Array<{ value: { tokens_per_credit?: number } }> = await this.packageRepository.manager
      .query(`SELECT value FROM platform_setting WHERE key = 'credits'`).catch(() => []);
    const value = Math.max(1, Number(rows[0]?.value?.tokens_per_credit) || 50_000);
    this.creditCache = { at: Date.now(), value };
    return value;
  }

  /** tokens → credits, 1 decimal */
  static credits(tokens: number, tokensPerCredit: number): number {
    return Math.round((Number(tokens || 0) / tokensPerCredit) * 10) / 10;
  }

  async byCode(code: string | null | undefined): Promise<PlatformPackage | null> {
    const wanted = String(code ?? '').trim().toLowerCase();
    if (!wanted) return null;
    return (await this.packages()).find((item) => item.code.toLowerCase() === wanted) ?? null;
  }

  /** A company may use the AI bot when it has an active package (any package, not only Free). */
  async planAllowsBot(plan: string | null | undefined): Promise<boolean> {
    const found = await this.byCode(plan);
    if (found) return found.is_active;
    // before the packages table exists: keep the old rule
    const value = String(plan ?? '').trim().toLowerCase();
    return value === 'free' || value.startsWith('free ');
  }

  /** null = unlimited */
  async maxAgents(plan: string | null | undefined): Promise<number | null> {
    const found = await this.byCode(plan);
    if (found) return found.max_agents;
    return String(plan ?? '').trim().toLowerCase() === 'free' ? 3 : 0;
  }

  /* ───────────── package limits ───────────── */

  private companyPlans = new Map<number, { at: number; plan: string }>();

  private async companyPlan(companyId: number): Promise<string> {
    const hit = this.companyPlans.get(companyId);
    if (hit && Date.now() - hit.at < 30_000) return hit.plan;
    const rows: Array<{ plan: string }> = await this.packageRepository.manager.query(`SELECT plan FROM companies WHERE id = $1`, [companyId]).catch(() => []);
    const plan = String(rows[0]?.plan ?? '');
    this.companyPlans.set(companyId, { at: Date.now(), plan });
    return plan;
  }

  /** Called when a company's package changes (so the new limits apply at once). */
  forgetCompany(companyId: number) {
    this.companyPlans.delete(companyId);
  }

  async limitsForCompany(companyId: number): Promise<ResolvedLimits & { package: PlatformPackage | null }> {
    const pkg = await this.byCode(await this.companyPlan(companyId));
    return { ...resolveLimits(pkg), package: pkg };
  }

  /** Cheapest active public package that has this feature (for "available from the X package"). */
  async upgradeFor(key: string, currentPrice = 0): Promise<string | null> {
    const packages = (await this.packages()).filter((p) => p.is_active && p.is_public && Number(p.price_monthly) >= currentPrice);
    const found = packages
      .sort((a, b) => Number(a.price_monthly) - Number(b.price_monthly))
      .find((p) => resolveLimits(p).features[key]);
    return found?.name ?? null;
  }

  async hasFeature(companyId: number, key: string): Promise<boolean> {
    return (await this.limitsForCompany(companyId)).features[key] === true;
  }

  /** 403 with a clear upgrade message when the company's package does not include the feature. */
  async assertFeature(companyId: number, keys: string | string[], mode: 'all' | 'any' = 'all') {
    const list = Array.isArray(keys) ? keys : [keys];
    const limits = await this.limitsForCompany(companyId);
    const ok = mode === 'any' ? list.some((k) => limits.features[k]) : list.every((k) => limits.features[k]);
    if (ok) return;
    const missing = list.find((k) => !limits.features[k]) ?? list[0];
    const upgrade = await this.upgradeFor(missing, Number(limits.package?.price_monthly ?? 0));
    const names = list.map(limitLabel).join(mode === 'any' ? ' or ' : ' and ');
    throw new ForbiddenException({
      statusCode: 403, error: 'Forbidden', code: 'FEATURE_LOCKED', feature: missing, upgrade_to: upgrade,
      message: `${names} ${list.length > 1 ? 'are' : 'is'} not included in your ${limits.package?.name ?? 'current'} package.` +
        (upgrade ? ` It is available from the ${upgrade} package – upgrade in Billing.` : ' Contact Agent Metra to upgrade.'),
    });
  }

  /** Limits for the Billing page / website / app: switches, numbers and upgrade hints. */
  async limitsView(companyId: number) {
    const limits = await this.limitsForCompany(companyId);
    const upgrade_for: Record<string, string | null> = {};
    for (const item of LIMIT_CATALOG) {
      if (item.kind === 'feature' && !limits.features[item.key]) upgrade_for[item.key] = await this.upgradeFor(item.key, Number(limits.package?.price_monthly ?? 0));
    }
    return { features: limits.features, numbers: limits.numbers, max_agents: limits.max_agents, max_products: limits.max_products, upgrade_for };
  }
}
