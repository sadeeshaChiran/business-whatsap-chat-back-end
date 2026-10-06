import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/** Only Metrocoding team accounts (app_user.is_super_admin). Use after JwtAuthGuard (which loads the account). */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>().user;
    if (user?.role !== 'super_admin') throw new ForbiddenException('Super admin only.');
    return true;
  }
}
