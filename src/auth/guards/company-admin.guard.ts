import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthenticatedRequest } from '../interfaces/auth-request.interface';

/** Company owner only. Use after JwtAuthGuard: @UseGuards(JwtAuthGuard, CompanyAdminGuard). */
@Injectable()
export class CompanyAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (user?.role !== 'admin') throw new ForbiddenException('Only the company admin can do this.');
    return true;
  }
}
