import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SUPABASE_DATA_SOURCE } from '../common/supabase-database';
import { Industry } from '../company/industry/entities/industry.entity';
import { SupabaseCompany } from './entities/supabase-company.entity';
import { CompanyApiShape, mapSupabaseCompanyToApi } from './supabase-company.mapper';

@Injectable()
export class SupabaseCompanyService {
  constructor(
    @InjectRepository(SupabaseCompany, SUPABASE_DATA_SOURCE)
    private readonly companyRepository: Repository<SupabaseCompany>,
  ) {}

  get enabled(): boolean {
    return Boolean(SUPABASE_DATA_SOURCE);
  }

  async exists(companyId: number): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }
    return this.companyRepository.exist({ where: { id: companyId } });
  }

  async findById(
    companyId: number,
    industry: Industry | null = null,
  ): Promise<CompanyApiShape> {
    const company = await this.companyRepository.findOne({
      where: { id: companyId },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return mapSupabaseCompanyToApi(company, industry);
  }

  async createForRegistration(
    name: string,
    industryId: number | null,
  ): Promise<SupabaseCompany> {
    const company = this.companyRepository.create({
      name: name.trim(),
      status: 'ACTIVE',
      plan: '',
      email: '',
      phone: '',
      address: '',
      industry_id: industryId,
      is_email_nofications: true,
      is_weekly_report: true,
      is_monthly_report: true,
    });
    return this.companyRepository.save(company);
  }

  async save(company: SupabaseCompany): Promise<SupabaseCompany> {
    return this.companyRepository.save(company);
  }

  async findEntityById(companyId: number): Promise<SupabaseCompany> {
    const company = await this.companyRepository.findOne({
      where: { id: companyId },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }

  async remove(company: SupabaseCompany): Promise<void> {
    await this.companyRepository.remove(company);
  }
}
