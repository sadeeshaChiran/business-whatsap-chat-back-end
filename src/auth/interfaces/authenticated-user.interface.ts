/** super_admin = Metrocoding platform team · admin = company owner · agent = company employee */
export type UserRole = 'super_admin' | 'admin' | 'agent';

export interface AuthenticatedUser {
  id: number;
  name: string;
  email: string;
  company_id: number;
  role: UserRole;
  is_super_admin: boolean;
}
