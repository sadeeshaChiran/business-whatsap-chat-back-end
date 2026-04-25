export interface AuthenticatedUser {
  id: number;
  name: string;
  email: string;
  company_id: number;
  is_admin: boolean;
}
