import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SUPABASE_DATA_SOURCE } from '../common/supabase-database';
import { SupabaseCompanyService } from '../supabase/supabase-company.service';
import { mapSupabaseCompanyToApi } from '../supabase/supabase-company.mapper';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { Company } from './entities/company.entity';
import { Industry } from './industry/entities/industry.entity';

@Injectable()
export class CompanyService {
  constructor(
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(Industry)
    private readonly industryRepository: Repository<Industry>,
    @Optional()
    private readonly supabaseCompanyService?: SupabaseCompanyService,
  ) {}

  private async getIndustryOrFail(id: number): Promise<Industry> {
    const industry = await this.industryRepository.findOne({ where: { id } });

    if (!industry) {
      throw new NotFoundException('Industry not found');
    }

    return industry;
  }

  private async loadIndustry(industryId: number | null): Promise<Industry | null> {
    if (!industryId) {
      return null;
    }
    return this.industryRepository.findOne({ where: { id: industryId } });
  }

  private async findOwnedCompanyMysql(id: number) {
    const company = await this.companyRepository.findOne({
      where: { id },
      relations: { industry: true },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    return company;
  }

  async create(_createCompanyDto: CreateCompanyDto, _user: AuthenticatedUser) {
    throw new ConflictException(
      'Authenticated users already belong to one company. Use update instead.',
    );
  }

  async findCurrent(user: AuthenticatedUser) {
    if (SUPABASE_DATA_SOURCE && this.supabaseCompanyService) {
      const industry = await this.loadIndustry(
        (await this.supabaseCompanyService.findEntityById(user.company_id))
          .industry_id,
      );
      return this.supabaseCompanyService.findById(user.company_id, industry);
    }

    return this.companyRepository.findOne({
      where: { id: user.company_id },
      relations: { industry: true },
    });
  }

  async findOne(id: number, user: AuthenticatedUser) {
    if (id !== user.company_id) {
      throw new NotFoundException('Company not found');
    }

    if (SUPABASE_DATA_SOURCE && this.supabaseCompanyService) {
      const entity = await this.supabaseCompanyService.findEntityById(id);
      const industry = await this.loadIndustry(entity.industry_id);
      return mapSupabaseCompanyToApi(entity, industry);
    }

    return this.findOwnedCompanyMysql(id);
  }

  async update(
    id: number,
    updateCompanyDto: UpdateCompanyDto,
    user: AuthenticatedUser,
  ) {
    if (id !== user.company_id) {
      throw new NotFoundException('Company not found');
    }

    if (SUPABASE_DATA_SOURCE && this.supabaseCompanyService) {
      const company = await this.supabaseCompanyService.findEntityById(id);

      if (updateCompanyDto.industry_id !== undefined) {
        await this.getIndustryOrFail(updateCompanyDto.industry_id);
        company.industry_id = updateCompanyDto.industry_id;
      }

      if (updateCompanyDto.name !== undefined) {
        company.name = updateCompanyDto.name.trim();
      }
      if (updateCompanyDto.plan !== undefined) {
        company.plan = updateCompanyDto.plan.trim();
      }
      if (updateCompanyDto.email !== undefined) {
        company.email = updateCompanyDto.email.trim().toLowerCase();
      }
      if (updateCompanyDto.phone !== undefined) {
        company.phone = updateCompanyDto.phone.trim();
      }
      if (updateCompanyDto.address !== undefined) {
        company.address = updateCompanyDto.address.trim();
      }
      if (updateCompanyDto.is_email_nofications !== undefined) {
        company.is_email_nofications = updateCompanyDto.is_email_nofications;
      }
      if (updateCompanyDto.is_weekly_report !== undefined) {
        company.is_weekly_report = updateCompanyDto.is_weekly_report;
      }
      if (updateCompanyDto.is_monthly_report !== undefined) {
        company.is_monthly_report = updateCompanyDto.is_monthly_report;
      }

      const saved = await this.supabaseCompanyService.save(company);
      const industry = await this.loadIndustry(saved.industry_id);
      return mapSupabaseCompanyToApi(saved, industry);
    }

    const company = await this.findOwnedCompanyMysql(id);

    if (updateCompanyDto.industry_id !== undefined) {
      company.industry = await this.getIndustryOrFail(updateCompanyDto.industry_id);
    }

    this.companyRepository.merge(company, {
      ...(updateCompanyDto.name !== undefined
        ? { name: updateCompanyDto.name.trim() }
        : {}),
      ...(updateCompanyDto.plan !== undefined
        ? { plan: updateCompanyDto.plan.trim() }
        : {}),
      ...(updateCompanyDto.email !== undefined
        ? { email: updateCompanyDto.email.trim().toLowerCase() }
        : {}),
      ...(updateCompanyDto.phone !== undefined
        ? { phone: updateCompanyDto.phone.trim() }
        : {}),
      ...(updateCompanyDto.address !== undefined
        ? { address: updateCompanyDto.address.trim() }
        : {}),
      is_email_nofications: updateCompanyDto.is_email_nofications,
      is_weekly_report: updateCompanyDto.is_weekly_report,
      is_monthly_report: updateCompanyDto.is_monthly_report,
    });

    return this.companyRepository.save(company);
  }

  async remove(id: number, user: AuthenticatedUser) {
    if (id !== user.company_id) {
      throw new NotFoundException('Company not found');
    }

    if (SUPABASE_DATA_SOURCE && this.supabaseCompanyService) {
      const company = await this.supabaseCompanyService.findEntityById(id);
      await this.supabaseCompanyService.remove(company);
      return { id };
    }

    const company = await this.findOwnedCompanyMysql(id);
    await this.companyRepository.remove(company);
    return { id };
  }
}
