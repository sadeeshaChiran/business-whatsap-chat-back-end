import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../interfaces/authenticated-user.interface';

export const ROLES_KEY = 'agent_metra_roles';

/** Only these roles may call the route (checked by JwtAuthGuard after the login check). */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** Company owner only (agents get 403). */
export const AdminOnly = () => Roles('admin');
