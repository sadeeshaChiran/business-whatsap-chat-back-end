/**
 * super_admin = Metrocoding platform team · admin = company owner · agent = company employee
 * supervisor = team lead: every chat, order, CRM contact, report and agent – but no billing, packages, channels,
 * bot settings or company settings.
 */
export type UserRole = 'super_admin' | 'admin' | 'supervisor' | 'agent';

/** Owner or supervisor – sees and manages the whole team's work. */
export const isManager = (user: { role?: string } | null | undefined) => user?.role === 'admin' || user?.role === 'supervisor';

export interface AuthenticatedUser {
  id: number;
  name: string;
  email: string;
  company_id: number;
  role: UserRole;
  is_super_admin: boolean;
}
