import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformPackage } from './entities/platform-package.entity';
import { LIMIT_CATALOG, limitLabel, resolveLimits, type ResolvedLimits } from './package-limits';
import { tiktokConfigured } from '../integrations/tiktok/tiktok-api';

/** Tokens per bot reply (shop data mostly cached + chat + answer). */
export const DEFAULT_TOKENS_PER_REPLY = 12_500; // measured 24 Oct 2026 on 3,180 replies: ≈ 12,500 tokens per AI reply incl. the cached prompt
/** 1 credit ≈ ONE average customer chat (≈ 8 bot replies). Super admin can change it (platform_setting "credits"). */
export const DEFAULT_TOKENS_PER_CREDIT = 100_000;

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
    this.creditHolders.clear();
  }

  private creditCache: { at: number; value: number; perReply: number; cap: boolean } | null = null;

  private async creditSetting(): Promise<{ value: number; perReply: number; cap: boolean }> {
    if (this.creditCache && Date.now() - this.creditCache.at < 30_000) return this.creditCache;
    const rows: Array<{ value: { tokens_per_credit?: number; tokens_per_reply?: number; cap_per_reply?: boolean } }> = await this.packageRepository.manager
      .query(`SELECT value FROM platform_setting WHERE key = 'credits'`).catch(() => []);
    const perReply = Math.max(1, Number(rows[0]?.value?.tokens_per_reply) || DEFAULT_TOKENS_PER_REPLY);
    // default: 1 credit = 1 average customer chat (easy to explain to shops)
    const value = Math.max(1, Number(rows[0]?.value?.tokens_per_credit) || DEFAULT_TOKENS_PER_CREDIT);
    // default ON: one AI reply never uses more than 1 credit (a short one uses less)
    const cap = rows[0]?.value?.cap_per_reply !== false;
    this.creditCache = { at: Date.now(), value, perReply, cap };
    return this.creditCache;
  }

  /** 1 credit = this many AI tokens (super admin setting, default = one average customer chat). Companies only see credits. */
  async tokensPerCredit(): Promise<number> {
    return (await this.creditSetting()).value;
  }

  /** Average AI tokens one bot reply uses (super admin setting) - only for the "≈ N AI replies" text. */
  async tokensPerReply(): Promise<number> {
    const setting = await this.creditSetting();
    // with the 1-credit cap every reply uses at most 1 credit, so N credits = at least N replies
    return setting.cap ? setting.value : setting.perReply;
  }

  /** The saved "1 AI reply ≈ tokens" value (super admin form), whatever the cap. */
  async savedTokensPerReply(): Promise<number> {
    return (await this.creditSetting()).perReply;
  }

  /** true = one AI reply (one bot_ai_usage row) counts at most 1 credit. */
  async capPerReply(): Promise<boolean> {
    return (await this.creditSetting()).cap;
  }

  /** SQL for the tokens a company is charged for one usage row (capped at 1 credit when the cap is on). */
  async chargedTokensSql(alias = ''): Promise<string> {
    const setting = await this.creditSetting();
    const a = alias ? `${alias}.` : '';
    const raw = `(${a}input_tokens + ${a}output_tokens)`;
    return setting.cap ? `LEAST(${raw}, ${Math.floor(setting.value)})` : raw;
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
    this.creditHolders.delete(companyId);
    this.hiddenAccess.delete(companyId);
  }

  /** Hidden features: off for every business unless the Agent Metra team switched them on for it (not part of packages). */
  static readonly HIDDEN_FEATURES: Record<string, string> = { sms: 'SMS', customer_app: 'Customer app' };
  private hiddenAccess = new Map<number, { at: number; keys: string[] }>();

  async hiddenFeaturesOn(companyId: number): Promise<string[]> {
    const hit = this.hiddenAccess.get(companyId);
    if (hit && Date.now() - hit.at < 30_000) return hit.keys;
    const rows: Array<{ feature: string }> = await this.packageRepository.manager.query(
      `SELECT feature FROM company_feature_access WHERE company_id = $1`, [companyId]).catch(() => []);
    const keys = rows.map((r) => r.feature).filter((k) => k in PlanService.HIDDEN_FEATURES);
    this.hiddenAccess.set(companyId, { at: Date.now(), keys });
    return keys;
  }

  private creditHolders = new Map<number, { at: number; active: boolean }>();

  /** The company has bought / been given credits that are still valid. */
  async hasActiveCredits(companyId: number): Promise<boolean> {
    const hit = this.creditHolders.get(companyId);
    if (hit && Date.now() - hit.at < 30_000) return hit.active;
    const rows: Array<{ active: boolean }> = await this.packageRepository.manager.query(
      `SELECT EXISTS (SELECT 1 FROM token_adjustment WHERE company_id = $1 AND tokens > 0 AND expires_at > NOW()) AS active`, [companyId]).catch(() => []);
    const active = Boolean(rows[0]?.active);
    this.creditHolders.set(companyId, { at: Date.now(), active });
    return active;
  }

  /** Features the company gets only because it has valid bought credits (Free + top-up). */
  static readonly CREDIT_FEATURES = ['messenger', 'instagram', 'social', 'tiktok', 'telegram'];

  async limitsForCompany(companyId: number): Promise<ResolvedLimits & { package: PlatformPackage | null; unlocked_by_credits: string[] }> {
    const pkg = await this.byCode(await this.companyPlan(companyId));
    const limits = resolveLimits(pkg);
    const unlocked: string[] = [];
    const locked = PlanService.CREDIT_FEATURES.filter((key) => !limits.features[key]);
    if (pkg && limits.features.credits_unlock && locked.length && (await this.hasActiveCredits(companyId))) {
      for (const key of locked) { limits.features[key] = true; if (key !== 'tiktok' || tiktokConfigured()) unlocked.push(key); } // TikTok listed only when set up
    }
    const hiddenOn = await this.hiddenFeaturesOn(companyId);
    for (const key of Object.keys(PlanService.HIDDEN_FEATURES)) limits.features[key] = hiddenOn.includes(key);
    return { ...limits, package: pkg, unlocked_by_credits: unlocked };
  }

  /** Cheapest active public package that has this feature (for "available from the X package"). */
  async upgradeFor(key: string, currentPrice = 0): Promise<string | null> {
    const packages = (await this.packages()).filter((p) => p.is_active && p.is_public && !p.company_id && Number(p.price_monthly) >= currentPrice);
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
    if (missing in PlanService.HIDDEN_FEATURES) {
      throw new ForbiddenException({
        statusCode: 403, error: 'Forbidden', code: 'FEATURE_LOCKED', feature: missing, upgrade_to: null,
        message: `${PlanService.HIDDEN_FEATURES[missing]} is not switched on for your business yet. Contact Agent Metra to use it.`,
      });
    }
    const upgrade = await this.upgradeFor(missing, Number(limits.package?.price_monthly ?? 0));
    const names = list.map(limitLabel).join(mode === 'any' ? ' or ' : ' and ');
    throw new ForbiddenException({
      statusCode: 403, error: 'Forbidden', code: 'FEATURE_LOCKED', feature: missing, upgrade_to: upgrade,
      message: `${names} ${list.length > 1 ? 'are' : 'is'} not included in your ${limits.package?.name ?? 'current'} package.` +
        (upgrade ? ` It is available from the ${upgrade} package – upgrade in Billing.` : ' Contact Agent Metra to upgrade.') +
        (PlanService.CREDIT_FEATURES.includes(missing) && limits.features.credits_unlock ? ' Or buy AI credits in Billing – they switch it on.' : ''),
    });
  }

  /** Limits for the Billing page / website / app: switches, numbers and upgrade hints. */
  async limitsView(companyId: number) {
    const limits = await this.limitsForCompany(companyId);
    const upgrade_for: Record<string, string | null> = {};
    for (const item of LIMIT_CATALOG) {
      if (item.kind === 'feature' && !limits.features[item.key]) upgrade_for[item.key] = await this.upgradeFor(item.key, Number(limits.package?.price_monthly ?? 0));
    }
    return { features: limits.features, numbers: limits.numbers, max_agents: limits.max_agents, max_products: limits.max_products, max_services: limits.max_services, upgrade_for, unlocked_by_credits: limits.unlocked_by_credits };
  }
}
