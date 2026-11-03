import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SignupHook } from '../common/signup-hook';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Company } from '../company/entities/company.entity';
import { CompanySubscription } from './entities/company-subscription.entity';
import { PlatformPackage } from './entities/platform-package.entity';
import { PlanService } from './plan.service';

export type TokenUsage = {
  package: { id: number; code: string; name: string; tokens_per_month: number; max_agents: number | null } | null;
  billing_cycle: string;
  status: string;
  period_end: Date | null;
  token_period_start: Date;
  token_period_end: Date;
  quota: number;
  extra: number;
  used: number;
  remaining: number;
  /** 0..1 (can be above 1 when a reply went over) */
  percent: number;
  /** the bot is stopped: tokens used up, package expired or suspended */
  blocked: boolean;
  blocked_reason: 'tokens' | 'expired' | 'suspended' | 'free_ended' | null;
  /** package with free AI-bot days (Free): the bot uses the package credits until this date, then only bought credits */
  free_bot_until: Date | null;
  free_bot_ended: boolean;
  /** bought / given credits that have not expired (they also open Messenger, Instagram and comment replies on Free) */
  has_active_credits: boolean;
  /** free trial of this package */
  trial: { ends_at: Date | null; note: string | null; back_to: string | null } | null;
  /** What companies see: credits (1 credit = tokens_per_credit tokens) */
  tokens_per_credit: number;
  credits: { quota: number; extra: number; used: number; remaining: number; per_month: number };
};

export function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  const day = next.getDate();
  next.setMonth(next.getMonth() + months);
  if (next.getDate() < day) next.setDate(0); // 31 Jan + 1 month → end of Feb
  return next;
}

/**
 * Token quota per company. Tokens = input + output tokens of every sales-bot reply (bot_ai_usage).
 * Tokens reset every month. When they run out (or the package expired / is suspended) the bot stops
 * and chats stay with the agents; the company gets warnings at 80% and 100%.
 */
@Injectable()
export class TokenQuotaService implements OnModuleInit {
  private readonly logger = new Logger(TokenQuotaService.name);
  private readonly cache = new Map<number, { at: number; allowed: boolean }>();

  constructor(
    @InjectRepository(CompanySubscription) private readonly subscriptionRepository: Repository<CompanySubscription>,
    @InjectRepository(PlatformPackage) private readonly packageRepository: Repository<PlatformPackage>,
    @InjectRepository(Company) private readonly companyRepository: Repository<Company>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly planService: PlanService,
  ) {}

  onModuleInit() {
    SignupHook.register((companyId) => this.startNewCompany(companyId));
  }

  forget(companyId: number) {
    this.cache.delete(Number(companyId));
  }

  /** The company's subscription, created from companies.plan the first time, with the token month rolled forward. */
  async ensure(companyId: number): Promise<CompanySubscription> {
    let sub = await this.subscriptionRepository.findOne({ where: { company_id: companyId } });
    const now = new Date();
    let changed = false;
    if (!sub) {
      const company = await this.companyRepository.findOne({ where: { id: companyId } });
      const pkg = (await this.planService.byCode(company?.plan)) ?? (await this.planService.byCode('free'));
      sub = this.subscriptionRepository.create({
        company_id: companyId,
        package_id: pkg?.id ?? 0,
        billing_cycle: 'monthly',
        status: 'active',
        period_start: now,
        period_end: pkg && Number(pkg.price_monthly) > 0 ? addMonths(now, 1) : null,
        token_period_start: now,
        token_period_end: addMonths(now, 1),
      });
      changed = true;
    }
    if (new Date(sub.token_period_end) <= now) {
      let start = new Date(sub.token_period_end);
      let end = addMonths(start, 1);
      while (end <= now) { start = end; end = addMonths(start, 1); }
      sub.token_period_start = start;
      sub.token_period_end = end;
      sub.warned_80_at = null;
      sub.warned_100_at = null;
      changed = true;
    }
    if (sub.period_end && new Date(sub.period_end) < now && sub.status === 'active') {
      if (sub.is_trial && (await this.moveToFallback(sub, 'ended'))) return sub;
      sub.status = 'expired';
      changed = true;
    }
    if (changed) sub = await this.subscriptionRepository.save(sub);
    return sub;
  }

  /* ───────────────────────── free trials ───────────────────────── */

  /**
   * Gives a company a package free for some days (marketing). When it ends the company moves back to Free
   * (agents, inbox, WhatsApp keep working; the AI bot needs credits). A company that pays for a package now cannot get a trial.
   */
  async grantTrial(companyId: number, packageId: number, days: number, options: { source?: 'admin' | 'signup'; note?: string | null; userId?: number | null } = {}) {
    const pkg = await this.packageRepository.findOne({ where: { id: packageId } });
    if (!pkg) throw new BadRequestException('Package not found.');
    if (!(days >= 1 && days <= 366)) throw new BadRequestException('A trial is 1 to 366 days.');
    const sub = await this.ensure(companyId);
    const now = new Date();
    const current = sub.package_id ? await this.packageRepository.findOne({ where: { id: sub.package_id } }) : null;
    const paying = !sub.is_trial && sub.status === 'active' && current && Number(current.price_monthly) > 0 && sub.period_end && new Date(sub.period_end) > now;
    if (paying) throw new BadRequestException(`This company pays for ${current!.name} until ${new Date(sub.period_end as Date).toISOString().slice(0, 10)}. Give extra credits instead.`);
    const free = await this.planService.byCode('free');
    const end = new Date(now.getTime() + days * 86_400_000);
    await this.dataSource.query(`UPDATE company_trial SET ended_at = NOW() WHERE company_id = $1 AND ended_at IS NULL`, [companyId]);
    Object.assign(sub, {
      package_id: pkg.id, billing_cycle: 'monthly', status: 'active', period_start: now, period_end: end,
      is_trial: true, trial_note: options.note?.trim().slice(0, 200) || null, fallback_package_id: free?.id ?? null, trial_reminded_at: null,
      token_period_start: now, token_period_end: addMonths(now, 1), warned_80_at: null, warned_100_at: null,
      auto_renew: false, reminded_7_at: null, reminded_1_at: null,
    });
    await this.subscriptionRepository.save(sub);
    await this.companyRepository.update(companyId, { plan: pkg.code });
    await this.dataSource.query(
      `INSERT INTO company_trial (company_id, package_id, days, source, note, starts_at, ends_at, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [companyId, pkg.id, days, options.source ?? 'admin', sub.trial_note, now, end, options.userId ?? null]);
    this.planService.forgetCompany(companyId);
    this.forget(companyId);
    await this.notify(companyId, 'MEDIUM', `🎁 ${pkg.name} free for ${days} days`,
      `You can use everything in the ${pkg.name} package free until ${end.toISOString().slice(0, 10)}. After that you go back to the Free package – nothing is lost. Choose a package in Billing any time to keep ${pkg.name}.`);
    return sub;
  }

  /** Super admin: stop a trial now (company goes back to Free). */
  async endTrial(companyId: number) {
    const sub = await this.ensure(companyId);
    if (!sub.is_trial) throw new BadRequestException('This company has no free trial running.');
    await this.moveToFallback(sub, 'stopped');
    return sub;
  }

  /** Trial over → back to the fallback package (Free). false when there is no package to go back to. */
  private async moveToFallback(sub: CompanySubscription, why: 'ended' | 'stopped'): Promise<boolean> {
    const companyId = Number(sub.company_id);
    const trialPkg = await this.packageRepository.findOne({ where: { id: sub.package_id } });
    const fallback = (sub.fallback_package_id ? await this.packageRepository.findOne({ where: { id: sub.fallback_package_id } }) : null) ?? (await this.planService.byCode('free'));
    if (!fallback) return false;
    const now = new Date();
    Object.assign(sub, {
      package_id: fallback.id, status: 'active', period_start: now, period_end: Number(fallback.price_monthly) > 0 ? addMonths(now, 1) : null,
      is_trial: false, fallback_package_id: null, trial_note: null,
      token_period_start: now, token_period_end: addMonths(now, 1), warned_80_at: null, warned_100_at: null,
    });
    await this.subscriptionRepository.save(sub);
    await this.companyRepository.update(companyId, { plan: fallback.code });
    await this.dataSource.query(`UPDATE company_trial SET ended_at = NOW() WHERE company_id = $1 AND ended_at IS NULL`, [companyId]);
    this.planService.forgetCompany(companyId);
    this.forget(companyId);
    await this.notify(companyId, 'HIGH', `Your free ${trialPkg?.name ?? ''} trial ${why === 'ended' ? 'has ended' : 'was stopped'}`.replace('  ', ' '),
      `You are on the ${fallback.name} package now. Your chats, contacts, agents and WhatsApp keep working. Choose a package or buy credits in Billing to keep the AI bot replying.`);
    return true;
  }

  /** Hourly: reminders 3 days before a trial / the free bot days end, and moves finished trials back to Free. */
  async sweepTrials() {
    try {
      const ending: Array<{ company_id: number; period_end: Date; name: string }> = await this.dataSource.query(`
        SELECT s.company_id, s.period_end, p.name FROM company_subscription s JOIN platform_package p ON p.id = s.package_id
         WHERE s.is_trial AND s.status = 'active' AND s.trial_reminded_at IS NULL AND s.period_end > NOW() AND s.period_end < NOW() + INTERVAL '3 days'`);
      for (const row of ending) {
        await this.notify(Number(row.company_id), 'HIGH', `Your free ${row.name} trial ends on ${new Date(row.period_end).toISOString().slice(0, 10)}`,
          `Choose ${row.name} in Billing to keep everything. If you do nothing you go back to the Free package (the AI bot then needs credits).`);
        await this.subscriptionRepository.update(Number(row.company_id), { trial_reminded_at: new Date() });
      }
      const botEnding: Array<{ company_id: number; bot_free_until: Date }> = await this.dataSource.query(`
        SELECT s.company_id, s.bot_free_until FROM company_subscription s JOIN platform_package p ON p.id = s.package_id
         WHERE p.bot_days IS NOT NULL AND NOT s.is_trial AND s.bot_free_reminded_at IS NULL AND s.bot_free_until > NOW() AND s.bot_free_until < NOW() + INTERVAL '3 days'`);
      for (const row of botEnding) {
        await this.notify(Number(row.company_id), 'HIGH', `Your free AI bot month ends on ${new Date(row.bot_free_until).toISOString().slice(0, 10)}`,
          'After that the AI bot stops replying. Your inbox, agents and WhatsApp keep working. Buy credits or choose a package in Billing to keep the bot on.');
        await this.subscriptionRepository.update(Number(row.company_id), { bot_free_reminded_at: new Date() });
      }
      const over: Array<{ company_id: number }> = await this.dataSource.query(
        `SELECT company_id FROM company_subscription WHERE is_trial AND status = 'active' AND period_end < NOW()`);
      for (const row of over) await this.ensure(Number(row.company_id));
    } catch (error) {
      this.logger.warn(`trial sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /* ───────────────────────── new sign-ups ───────────────────────── */

  async signupTrialSetting(): Promise<{ enabled: boolean; package_id: number | null; days: number }> {
    const [row] = await this.dataSource.query(`SELECT value FROM platform_setting WHERE key = 'signup_trial'`).catch(() => []);
    const v = (row?.value ?? {}) as { enabled?: boolean; package_id?: number; days?: number };
    return { enabled: Boolean(v.enabled && v.package_id), package_id: v.package_id ? Number(v.package_id) : null, days: Math.min(Math.max(Number(v.days) || 30, 1), 366) };
  }

  async setSignupTrial(value: { enabled: boolean; package_id: number | null; days: number }) {
    if (value.enabled) {
      const pkg = value.package_id ? await this.packageRepository.findOne({ where: { id: value.package_id } }) : null;
      if (!pkg || !pkg.is_active) throw new BadRequestException('Choose an active package for the sign-up trial.');
    }
    const clean = { enabled: Boolean(value.enabled), package_id: value.package_id ?? null, days: Math.min(Math.max(Math.trunc(Number(value.days) || 30), 1), 366) };
    await this.dataSource.query(
      `INSERT INTO platform_setting (key, value) VALUES ('signup_trial', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(clean)]);
    return this.signupTrialSetting();
  }

  /** A new company: start on Free (no "choose a package" wall), plus the sign-up trial when the super admin switched it on. */
  async startNewCompany(companyId: number) {
    const free = await this.planService.byCode('free');
    if (free?.is_active) await this.companyRepository.update(companyId, { plan: free.code });
    this.planService.forgetCompany(companyId);
    await this.ensure(companyId);
    const setting = await this.signupTrialSetting();
    if (setting.enabled && setting.package_id) {
      await this.grantTrial(companyId, setting.package_id, setting.days, { source: 'signup', note: 'Welcome trial' })
        .catch((error) => this.logger.warn(`sign-up trial for ${companyId}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  async usage(companyId: number): Promise<TokenUsage> {
    const sub = await this.ensure(companyId);
    const pkg = sub.package_id ? await this.packageRepository.findOne({ where: { id: sub.package_id } }) : null;
    // Free-style package: the AI bot uses the package credits only for the first bot_days days
    if (pkg?.bot_days != null && !sub.bot_free_until) {
      sub.bot_free_until = new Date(Date.now() + Number(pkg.bot_days) * 86_400_000);
      await this.subscriptionRepository.update(companyId, { bot_free_until: sub.bot_free_until });
    }
    const freeEnded = pkg?.bot_days != null && sub.bot_free_until != null && new Date(sub.bot_free_until) <= new Date();
    // after the free days only bought credits count – earlier free use this month does not eat them
    const usedSince = freeEnded && new Date(sub.bot_free_until as Date) > new Date(sub.token_period_start) ? sub.bot_free_until : sub.token_period_start;
    const [usedRow] = await this.dataSource.query(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS used
         FROM bot_ai_usage WHERE company_id = $1 AND created_at >= $2`,
      [companyId, usedSince],
    ).catch(() => [{ used: 0 }]);
    const [activeRow] = await this.dataSource.query(
      `SELECT EXISTS (SELECT 1 FROM token_adjustment WHERE company_id = $1 AND tokens > 0 AND expires_at > NOW()) AS active`, [companyId],
    ).catch(() => [{ active: false }]);
    const [extraRow] = await this.dataSource.query(
      `SELECT COALESCE(SUM(tokens), 0)::bigint AS extra
         FROM token_adjustment
        WHERE company_id = $1
          AND ((expires_at IS NOT NULL AND expires_at > NOW()) OR (expires_at IS NULL AND created_at >= $2))`,
      [companyId, sub.token_period_start],
    ).catch(() => [{ extra: 0 }]);
    const quota = freeEnded ? 0 : Number(pkg?.tokens_per_month ?? 0);
    const extra = Number(extraRow?.extra ?? 0);
    const used = Number(usedRow?.used ?? 0);
    const total = Math.max(0, quota + extra);
    const remaining = total - used;
    const blockedReason = sub.status === 'suspended' ? 'suspended' : sub.status === 'expired' ? 'expired'
      : remaining <= 0 ? (freeEnded && extra <= 0 ? 'free_ended' : 'tokens') : null;
    let backTo: string | null = null;
    if (sub.is_trial) {
      const fallback = sub.fallback_package_id ? await this.packageRepository.findOne({ where: { id: sub.fallback_package_id } }) : await this.planService.byCode('free');
      backTo = fallback?.name ?? null;
    }
    const tpc = await this.planService.tokensPerCredit();
    const c = (value: number) => PlanService.credits(value, tpc);
    return {
      tokens_per_credit: tpc,
      credits: { quota: c(quota), extra: c(extra), used: c(used), remaining: c(Math.max(0, remaining)), per_month: c(quota) },
      package: pkg ? { id: pkg.id, code: pkg.code, name: pkg.name, tokens_per_month: Number(pkg.tokens_per_month), max_agents: pkg.max_agents } : null,
      billing_cycle: sub.billing_cycle,
      status: sub.status,
      period_end: sub.period_end,
      token_period_start: sub.token_period_start,
      token_period_end: sub.token_period_end,
      quota,
      extra,
      used,
      remaining: Math.max(0, remaining),
      percent: total > 0 ? used / total : used > 0 ? 1 : 0,
      blocked: blockedReason !== null,
      blocked_reason: blockedReason,
      free_bot_until: pkg?.bot_days != null ? sub.bot_free_until : null,
      free_bot_ended: freeEnded,
      has_active_credits: Boolean(activeRow?.active),
      trial: sub.is_trial ? { ends_at: sub.period_end, note: sub.trial_note, back_to: backTo } : null,
    };
  }

  /** Called before every bot reply (cached 30 s). Sends the 80% / 100% warnings once per month. */
  async canBotReply(companyId: number): Promise<boolean> {
    const hit = this.cache.get(companyId);
    if (hit && Date.now() - hit.at < 30_000) return hit.allowed;
    try {
      const usage = await this.usage(companyId);
      await this.warnIfNeeded(companyId, usage);
      this.cache.set(companyId, { at: Date.now(), allowed: !usage.blocked });
      return !usage.blocked;
    } catch (error) {
      // never stop the bot because the quota check itself failed
      this.logger.warn(`token quota check failed for company ${companyId}: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
  }

  private async warnIfNeeded(companyId: number, usage: TokenUsage) {
    if (usage.blocked_reason === 'expired' || usage.blocked_reason === 'suspended') return;
    const sub = await this.subscriptionRepository.findOne({ where: { company_id: companyId } });
    if (!sub) return;
    if (usage.percent >= 1 && !sub.warned_100_at) {
      await this.notify(companyId, 'HIGH', 'AI credits used up – the bot has stopped',
        `All ${(usage.credits.quota + usage.credits.extra).toLocaleString()} credits of this month are used. Chats go to your agents. Renew or buy more credits to switch the bot back on.`);
      await this.subscriptionRepository.update(companyId, { warned_100_at: new Date(), warned_80_at: sub.warned_80_at ?? new Date() });
    } else if (usage.percent >= 0.8 && !sub.warned_80_at) {
      await this.notify(companyId, 'MEDIUM', 'AI credits 80% used',
        `${usage.credits.used.toLocaleString()} of ${(usage.credits.quota + usage.credits.extra).toLocaleString()} credits used this month. The bot stops when they run out.`);
      await this.subscriptionRepository.update(companyId, { warned_80_at: new Date() });
    }
  }

  private async notify(companyId: number, priority: 'MEDIUM' | 'HIGH', title: string, message: string) {
    await this.dataSource.query(
      `INSERT INTO bot_notification (company_id, kind, priority, title, message) VALUES ($1, 'tokens', $2, $3, $4)`,
      [companyId, priority, title, message],
    ).catch(() => undefined);
  }
}
