import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlanService } from './plan.service';

const FEATURE_KEY = 'agent_metra_features';
type Requirement = { keys: string[]; mode: 'all' | 'any' };

/** The route needs these package features (all of them). */
export const RequiresFeature = (...keys: string[]) => SetMetadata(FEATURE_KEY, { keys, mode: 'all' } satisfies Requirement);
/** The route needs at least one of these package features. */
export const RequiresAnyFeature = (...keys: string[]) => SetMetadata(FEATURE_KEY, { keys, mode: 'any' } satisfies Requirement);

/** Checks the company's package (after JwtAuthGuard). Super admins without a company are not limited. */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly planService: PlanService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<Requirement | undefined>(FEATURE_KEY, [context.getHandler(), context.getClass()]);
    if (!requirement?.keys.length) return true;
    const user = context.switchToHttp().getRequest<{ user?: { company_id?: number | null } }>().user;
    const companyId = Number(user?.company_id ?? 0);
    if (!companyId) return true;
    await this.planService.assertFeature(companyId, requirement.keys, requirement.mode);
    return true;
  }
}
