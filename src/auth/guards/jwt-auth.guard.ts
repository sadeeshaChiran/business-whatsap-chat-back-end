import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from '../auth.service';
import { OWNER_ONLY_KEY, ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedRequest } from '../interfaces/auth-request.interface';
import type { UserRole } from '../interfaces/authenticated-user.interface';

/**
 * Checks the Bearer token, then the account in the database (removed access, password changed,
 * suspended workspace) and the route roles from @Roles()/@AdminOnly().
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException('Please log in to continue.');
    }

    request.user = await this.authService.authenticate(token);

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // a supervisor works like the admin, except on owner-only routes (billing, agents' passwords)
    const ownerOnly = this.reflector.getAllAndOverride<boolean | undefined>(OWNER_ONLY_KEY, [context.getHandler(), context.getClass()]);
    const supervisorAsAdmin = request.user.role === 'supervisor' && Boolean(roles?.includes('admin')) && !ownerOnly;
    if (roles?.length && !roles.includes(request.user.role) && !supervisorAsAdmin) {
      throw new ForbiddenException(
        roles.includes('admin') ? 'Only the company admin can do this.' : 'You do not have access to this.',
      );
    }
    return true;
  }

  private extractBearerToken(authorization?: string): string | null {
    if (!authorization) return null;
    const [type, token] = authorization.split(' ');
    if (type !== 'Bearer' || !token) return null;
    return token;
  }
}
