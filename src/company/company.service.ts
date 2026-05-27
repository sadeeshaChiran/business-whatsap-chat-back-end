import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { Company } from './entities/company.entity';
import { Industry } from './industry/entities/industry.entity';
import { WhatsappChannel } from '../whatsapp/entities/whatsapp-channel.entity';

@Injectable()
export class CompanyService {
  constructor(
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(Industry)
    private readonly industryRepository: Repository<Industry>,
    @InjectRepository(WhatsappChannel)
    private readonly whatsappChannelsRepository: Repository<WhatsappChannel>,
  ) {}

  private async getIndustryOrFail(id: number): Promise<Industry> {
    const industry = await this.industryRepository.findOne({ where: { id } });
    if (!industry) {
      throw new NotFoundException('Industry not found');
    }
    return industry;
  }

  private async loadIndustry(industryId: number | null) {
    if (!industryId) {
      return null;
    }
    return this.industryRepository.findOne({ where: { id: industryId } });
  }

  private async upsertWhatsappChannel(
    companyId: number,
    companyName: string,
    patch: Partial<WhatsappChannel>,
  ) {
    if (!Object.keys(patch).length) {
      return;
    }

    const existing = await this.whatsappChannelsRepository.findOne({
      where: { company_id: companyId },
      order: { id: 'ASC' },
    });

    if (existing) {
      await this.whatsappChannelsRepository.save({
        ...existing,
        ...patch,
        company_name: companyName,
      });
      return;
    }

    const instanceName = patch.instance_name?.trim();
    const hasEvaluationKey = patch.evaluation_whatsapp_key !== undefined;

    if (!instanceName && !hasEvaluationKey) {
      return;
    }

    await this.whatsappChannelsRepository.save(
      this.whatsappChannelsRepository.create({
        company_id: companyId,
        company_name: companyName,
        instance_name: instanceName || `company-${companyId}`,
        evaluation_whatsapp_key: patch.evaluation_whatsapp_key ?? null,
        role_type: 'general',
        status: 'DISCONNECTED',
        weight: 1,
        created_at: new Date(),
      }),
    );
  }

  private async toApiCompany(company: Company) {
    const [industry, channel] = await Promise.all([
      this.loadIndustry(company.industry_id),
      this.whatsappChannelsRepository.findOne({
        where: { company_id: Number(company.id) },
        order: { id: 'ASC' },
      }),
    ]);
    return {
      id: Number(company.id),
      name: company.name,
      plan: company.plan ?? '',
      email: company.email ?? '',
      phone: company.phone ?? '',
      address: company.address ?? '',
      admin_user_id:
        company.admin_user_id != null ? Number(company.admin_user_id) : null,
      is_email_nofications: company.is_email_nofications,
      is_weekly_report: company.is_weekly_report,
      is_monthly_report: company.is_monthly_report,
      industry,
      whatsapp_instance_name: channel?.instance_name ?? null,
      whatsapp_evaluation_key: channel?.evaluation_whatsapp_key ?? null,
      created_at: company.created_at,
      updated_at: company.updated_at,
    };
  }

  async create(_createCompanyDto: CreateCompanyDto, _user: AuthenticatedUser) {
    throw new ConflictException(
      'Authenticated users already belong to one company. Use update instead.',
    );
  }

  async findCurrent(user: AuthenticatedUser) {
    const company = await this.companyRepository.findOne({
      where: { id: user.company_id },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return this.toApiCompany(company);
  }

  async findOne(id: number, user: AuthenticatedUser) {
    if (id !== user.company_id) {
      throw new NotFoundException('Company not found');
    }
    const company = await this.companyRepository.findOne({ where: { id } });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return this.toApiCompany(company);
  }

  async update(
    id: number,
    updateCompanyDto: UpdateCompanyDto,
    user: AuthenticatedUser,
  ) {
    if (id !== user.company_id) {
      throw new NotFoundException('Company not found');
    }

    const company = await this.companyRepository.findOne({ where: { id } });
    if (!company) {
      throw new NotFoundException('Company not found');
    }

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

    const nextCompanyName = company.name;
    const whatsappPatch: Partial<WhatsappChannel> = {};

    if (updateCompanyDto.whatsapp_instance_name !== undefined) {
      whatsappPatch.instance_name = updateCompanyDto.whatsapp_instance_name.trim();
    }
    if (updateCompanyDto.whatsapp_evaluation_key !== undefined) {
      whatsappPatch.evaluation_whatsapp_key =
        updateCompanyDto.whatsapp_evaluation_key.trim() || null;
    }
    if (updateCompanyDto.name !== undefined) {
      whatsappPatch.company_name = nextCompanyName;
    }

    const saved = await this.companyRepository.save(company);

    if (Object.keys(whatsappPatch).length > 0) {
      await this.upsertWhatsappChannel(Number(saved.id), nextCompanyName, whatsappPatch);
    }

    return this.toApiCompany(saved);
  }

  async remove(id: number, user: AuthenticatedUser) {
    if (id !== user.company_id) {
      throw new NotFoundException('Company not found');
    }
    const company = await this.companyRepository.findOne({ where: { id } });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    await this.companyRepository.remove(company);
    return { id };
  }
}
