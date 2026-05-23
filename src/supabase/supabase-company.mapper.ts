import { Industry } from '../company/industry/entities/industry.entity';
import { SupabaseCompany } from './entities/supabase-company.entity';

export type CompanyApiShape = {
  id: number;
  name: string;
  plan: string;
  email: string;
  phone: string;
  address: string;
  admin_user_id: number | null;
  is_email_nofications: boolean;
  is_weekly_report: boolean;
  is_monthly_report: boolean;
  status?: string;
  industry: Industry | null;
  created_at?: Date;
  updated_at?: Date;
};

export function mapSupabaseCompanyToApi(
  company: SupabaseCompany,
  industry: Industry | null = null,
): CompanyApiShape {
  return {
    id: Number(company.id),
    name: company.name,
    plan: company.plan ?? '',
    email: company.email ?? '',
    phone: company.phone ?? '',
    address: company.address ?? '',
    admin_user_id: company.admin_user_id,
    is_email_nofications: company.is_email_nofications,
    is_weekly_report: company.is_weekly_report,
    is_monthly_report: company.is_monthly_report,
    status: company.status,
    industry,
    created_at: company.created_at,
    updated_at: company.updated_at,
  };
}
