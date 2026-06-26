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
import { WhatsappChannelService } from '../whatsapp/whatsapp-channel.service';
import { MetaPageConnection } from '../meta/entities/meta-page-connection.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class CompanyService {
  constructor(
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(Industry)
    private readonly industryRepository: Repository<Industry>,
    @InjectRepository(WhatsappChannel)
    private readonly whatsappChannelsRepository: Repository<WhatsappChannel>,
    @InjectRepository(MetaPageConnection)
    private readonly metaPageConnectionsRepository: Repository<MetaPageConnection>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly whatsappChannelService: WhatsappChannelService,
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
    await this.whatsappChannelService.upsertForCompany(
      companyId,
      companyName,
      patch,
    );
  }

  private async resolveLoginEmail(user: AuthenticatedUser): Promise<string> {
    const account = await this.userRepository.findOne({
      where: { id: user.id },
    });
    return account?.email?.trim().toLowerCase() ?? '';
  }

  /** Business contact email only — never expose login email as contact. */
  private resolveContactEmail(
    company: Company,
    loginEmail: string,
  ): string {
    const stored = (company.email ?? '').trim();
    const login = loginEmail.trim().toLowerCase();
    if (!stored) {
      return '';
    }
    if (login && stored.toLowerCase() === login) {
      return '';
    }
    return stored;
  }

  private async toApiCompany(company: Company, loginEmail?: string) {
    const [industry, channel, metaConnection] = await Promise.all([
      this.loadIndustry(company.industry_id),
      this.whatsappChannelsRepository.findOne({
        where: { company_id: Number(company.id) },
        order: { id: 'ASC' },
      }),
      this.metaPageConnectionsRepository.findOne({
        where: { company_id: Number(company.id), status: 'CONNECTED' },
        order: { id: 'DESC' },
      }),
    ]);
    const login = loginEmail ?? '';
    const contactEmail = this.resolveContactEmail(company, login);
    const businessAddress = (company.address ?? '').trim();
    return {
      id: Number(company.id),
      name: company.name,
      plan: company.plan ?? '',
      /** Business contact email — stored on companies.email, not app_user.email */
      email: contactEmail,
      contact_email: contactEmail,
      login_email: login,
      phone: company.phone ?? '',
      address: businessAddress,
      admin_user_id:
        company.admin_user_id != null ? Number(company.admin_user_id) : null,
      is_email_nofications: company.is_email_nofications,
      is_weekly_report: company.is_weekly_report,
      is_monthly_report: company.is_monthly_report,
      industry,
      whatsapp_instance_name: channel?.instance_name ?? null,
      whatsapp_evaluation_key: channel?.evaluation_whatsapp_key ?? null,
      whatsapp_status: channel?.status ?? null,
      whatsapp_provider_type: channel?.provider_type ?? 'evolution',
      meta_phone_number_id: channel?.meta_phone_number_id ?? null,
      meta_waba_id: channel?.meta_waba_id ?? null,
      meta_verify_token: channel?.meta_verify_token ?? null,
      evolution_api_base: channel?.evolution_api_base ?? null,
      meta_webhook_base_url: channel?.meta_webhook_base_url ?? null,
      facebook_page_id: metaConnection?.page_id ?? null,
      facebook_page_name: metaConnection?.page_name ?? null,
      facebook_connection_status: metaConnection?.status ?? null,
      instagram_business_account_id:
        metaConnection?.instagram_business_account_id ?? null,
      created_at: company.created_at,
      updated_at: company.updated_at,
    };
  }

  private async reloadCompany(id: number): Promise<Company> {
    const company = await this.companyRepository.findOne({ where: { id } });
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

  private async clearContactEmailIfMatchesLogin(
    company: Company,
    loginEmail: string,
  ): Promise<Company> {
    const stored = (company.email ?? '').trim();
    const login = loginEmail.trim().toLowerCase();
    if (!stored || !login || stored.toLowerCase() !== login) {
      return company;
    }
    company.email = '';
    return this.companyRepository.save(company);
  }

  async findCurrent(user: AuthenticatedUser) {
    let company = await this.companyRepository.findOne({
      where: { id: user.company_id },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    const loginEmail = await this.resolveLoginEmail(user);
    company = await this.clearContactEmailIfMatchesLogin(company, loginEmail);
    return this.toApiCompany(company, loginEmail);
  }

  async findOne(id: number, user: AuthenticatedUser) {
    if (id !== user.company_id) {
      throw new NotFoundException('Company not found');
    }
    let company = await this.companyRepository.findOne({ where: { id } });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    const loginEmail = await this.resolveLoginEmail(user);
    company = await this.clearContactEmailIfMatchesLogin(company, loginEmail);
    return this.toApiCompany(company, loginEmail);
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
      const loginEmail = await this.resolveLoginEmail(user);
      let nextEmail = updateCompanyDto.email.trim().toLowerCase();
      if (loginEmail && nextEmail === loginEmail) {
        nextEmail = '';
      }
      company.email = nextEmail;
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
    const existingChannel = await this.whatsappChannelService.getForCompany(
      Number(company.id),
    );

    if (updateCompanyDto.whatsapp_instance_name !== undefined) {
      whatsappPatch.instance_name = updateCompanyDto.whatsapp_instance_name.trim();
    }
    if (updateCompanyDto.whatsapp_evaluation_key !== undefined) {
      whatsappPatch.evaluation_whatsapp_key =
        updateCompanyDto.whatsapp_evaluation_key.trim() || null;
    }
    if (updateCompanyDto.whatsapp_provider_type !== undefined) {
      whatsappPatch.provider_type = updateCompanyDto.whatsapp_provider_type;
    }
    if (updateCompanyDto.meta_phone_number_id !== undefined) {
      whatsappPatch.meta_phone_number_id =
        updateCompanyDto.meta_phone_number_id.trim() || null;
    }
    if (updateCompanyDto.meta_access_token !== undefined) {
      whatsappPatch.meta_access_token =
        updateCompanyDto.meta_access_token.trim() || null;
    }
    if (updateCompanyDto.meta_waba_id !== undefined) {
      whatsappPatch.meta_waba_id = updateCompanyDto.meta_waba_id.trim() || null;
    }
    if (updateCompanyDto.meta_verify_token !== undefined) {
      whatsappPatch.meta_verify_token =
        updateCompanyDto.meta_verify_token.trim() || null;
    }
    if (updateCompanyDto.evolution_api_base !== undefined) {
      whatsappPatch.evolution_api_base =
        updateCompanyDto.evolution_api_base.trim() || null;
    }
    if (updateCompanyDto.meta_webhook_base_url !== undefined) {
      whatsappPatch.meta_webhook_base_url =
        updateCompanyDto.meta_webhook_base_url.trim().replace(/\/+$/, '') || null;
    }

    const nextProvider =
      updateCompanyDto.whatsapp_provider_type ??
      existingChannel?.provider_type ??
      'evolution';

    if (nextProvider === 'meta') {
      const metaPhoneNumberId =
        whatsappPatch.meta_phone_number_id?.trim() ||
        existingChannel?.meta_phone_number_id?.trim() ||
        '';
      const metaAccessToken =
        whatsappPatch.meta_access_token?.trim() ||
        existingChannel?.meta_access_token?.trim() ||
        '';

      if (metaPhoneNumberId) {
        whatsappPatch.meta_phone_number_id = metaPhoneNumberId;
        const explicitInstance = updateCompanyDto.whatsapp_instance_name?.trim() || '';
        const existingInstance = existingChannel?.instance_name?.trim() || '';
        const existingEvolutionAlias =
          existingChannel?.evolution_instance_name?.trim() || '';
        const evolutionAlias =
          explicitInstance ||
          existingEvolutionAlias ||
          (existingInstance && existingInstance !== metaPhoneNumberId
            ? existingInstance
            : '');
        if (evolutionAlias) {
          whatsappPatch.evolution_instance_name = evolutionAlias;
        }
        if (explicitInstance) {
          whatsappPatch.instance_name = explicitInstance;
        }
      }
      if (metaPhoneNumberId && metaAccessToken) {
        whatsappPatch.status = 'CONNECTED';
      } else if (updateCompanyDto.whatsapp_provider_type === 'meta') {
        whatsappPatch.status = 'DISCONNECTED';
      }
    } else if (updateCompanyDto.whatsapp_provider_type === 'evolution') {
      // Switching back to Evolution: Meta credentials stay stored but provider is Evolution-only.
      const evolutionInstance =
        whatsappPatch.instance_name?.trim() ||
        existingChannel?.instance_name?.trim();
      if (evolutionInstance) {
        whatsappPatch.evolution_instance_name = evolutionInstance;
        whatsappPatch.status =
          existingChannel?.status === 'CONNECTED' ? 'CONNECTED' : 'DISCONNECTED';
      }
    }
    if (updateCompanyDto.name !== undefined) {
      whatsappPatch.company_name = nextCompanyName;
    }

    await this.companyRepository.save(company);

    if (Object.keys(whatsappPatch).length > 0) {
      await this.upsertWhatsappChannel(Number(company.id), nextCompanyName, whatsappPatch);
    }

    const refreshed = await this.reloadCompany(Number(company.id));
    const loginEmail = await this.resolveLoginEmail(user);
    return this.toApiCompany(refreshed, loginEmail);
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
