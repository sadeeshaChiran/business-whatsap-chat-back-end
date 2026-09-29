import { Injectable, Logger } from '@nestjs/common';
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
  blocked_reason: 'tokens' | 'expired' | 'suspended' | null;
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
export class TokenQuotaService {
  private readonly logger = new Logger(TokenQuotaService.name);
  private readonly cache = new Map<number, { at: number; allowed: boolean }>();

  constructor(
    @InjectRepository(CompanySubscription) private readonly subscriptionRepository: Repository<CompanySubscription>,
    @InjectRepository(PlatformPackage) private readonly packageRepository: Repository<PlatformPackage>,
    @InjectRepository(Company) private readonly companyRepository: Repository<Company>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly planService: PlanService,
  ) {}

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
      sub.status = 'expired';
      changed = true;
    }
    if (changed) sub = await this.subscriptionRepository.save(sub);
    return sub;
  }

  async usage(companyId: number): Promise<TokenUsage> {
    const sub = await this.ensure(companyId);
    const pkg = sub.package_id ? await this.packageRepository.findOne({ where: { id: sub.package_id } }) : null;
    const [usedRow] = await this.dataSource.query(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS used
         FROM bot_ai_usage WHERE company_id = $1 AND created_at >= $2`,
      [companyId, sub.token_period_start],
    ).catch(() => [{ used: 0 }]);
    const [extraRow] = await this.dataSource.query(
      `SELECT COALESCE(SUM(tokens), 0)::bigint AS extra
         FROM token_adjustment
        WHERE company_id = $1
          AND ((expires_at IS NOT NULL AND expires_at > NOW()) OR (expires_at IS NULL AND created_at >= $2))`,
      [companyId, sub.token_period_start],
    ).catch(() => [{ extra: 0 }]);
    const quota = Number(pkg?.tokens_per_month ?? 0);
    const extra = Number(extraRow?.extra ?? 0);
    const used = Number(usedRow?.used ?? 0);
    const total = Math.max(0, quota + extra);
    const remaining = total - used;
    const blockedReason = sub.status === 'suspended' ? 'suspended' : sub.status === 'expired' ? 'expired' : remaining <= 0 ? 'tokens' : null;
    return {
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
      await this.notify(companyId, 'HIGH', 'AI tokens used up – the bot has stopped',
        `All ${(usage.quota + usage.extra).toLocaleString()} tokens of this month are used. Chats go to your agents. Renew or buy more tokens to switch the bot back on.`);
      await this.subscriptionRepository.update(companyId, { warned_100_at: new Date(), warned_80_at: sub.warned_80_at ?? new Date() });
    } else if (usage.percent >= 0.8 && !sub.warned_80_at) {
      await this.notify(companyId, 'MEDIUM', 'AI tokens 80% used',
        `${usage.used.toLocaleString()} of ${(usage.quota + usage.extra).toLocaleString()} tokens used this month. The bot stops when they run out.`);
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
