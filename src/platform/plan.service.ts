import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformPackage } from './entities/platform-package.entity';

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
}
