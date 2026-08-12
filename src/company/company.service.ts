import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { Company } from './entities/company.entity';
import { Industry } from './industry/entities/industry.entity';
import { WhatsappChannel } from '../whatsapp/entities/whatsapp-channel.entity';
import { WhatsappChannelService } from '../whatsapp/whatsapp-channel.service';
import { buildWhatsappChannelPatch } from '../whatsapp/whatsapp-channel-settings.util';
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
    private readonly dataSource: DataSource,
  ) {}

  private whatsappAccountIdentity(provider: 'evolution' | 'meta', channel: WhatsappChannel | null, update?: UpdateCompanyDto): string {
    return provider === 'meta'
      ? (update?.meta_phone_number_id ?? channel?.meta_phone_number_id ?? '').trim()
      : (update?.whatsapp_instance_name ?? channel?.evolution_instance_name ?? channel?.instance_name ?? '').trim();
  }

  private async deleteCompanyWhatsappConversationHistory(companyId: number) {
    await this.dataSource.transaction(async (manager) => {
      const conversationIds = `SELECT c.id FROM bot_conversation c INNER JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id WHERE cu.company_id = $1 AND LOWER(TRIM(COALESCE(cu.platform, ''))) = 'whatsapp'`;
      await manager.query(`DELETE FROM bot_conversation_label WHERE conversation_id IN (${conversationIds})`, [companyId]);
      await manager.query(`DELETE FROM bot_flag WHERE conversation_id IN (${conversationIds})`, [companyId]);
      await manager.query(`DELETE FROM bot_message WHERE conversation_id IN (${conversationIds})`, [companyId]);
      await manager.query(`DELETE FROM bot_conversation WHERE id IN (${conversationIds})`, [companyId]);

      const remaining = await manager.query(
        `SELECT COUNT(*)::int AS count FROM bot_conversation c INNER JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id WHERE cu.company_id = $1 AND LOWER(TRIM(COALESCE(cu.platform, ''))) = 'whatsapp'`,
        [companyId],
      );
      if (Number(remaining?.[0]?.count ?? 0) > 0) {
        throw new BadRequestException(
          'WhatsApp provider was not changed because previous Admin/Agent conversations could not be completely removed.',
        );
      }
    });
  }

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
      whatsapp_instance_name:
        channel?.provider_type === 'meta'
          ? (channel?.evolution_instance_name?.trim() ||
              (channel?.instance_name &&
              channel.instance_name !== channel.meta_phone_number_id
                ? channel.instance_name
                : null))
          : (channel?.instance_name ?? null),
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
      business_category: company.business_category ?? 'product',
      order_collect_customer_info: company.order_collect_customer_info ?? true,
      order_collect_products: company.order_collect_products ?? true,
      order_allow_note: company.order_allow_note ?? true,
      bot_enabled: false,
      agent_assignment_timeout_minutes:
        company.agent_assignment_timeout_minutes ?? 1440,
      agent_offline_shift_minutes: company.agent_offline_shift_minutes ?? 0,
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
      const nextPlan = updateCompanyDto.plan.trim().toLowerCase();
      if (nextPlan && nextPlan !== 'free') {
        throw new BadRequestException('This package is coming soon. Select Free to continue.');
      }
      company.plan = nextPlan;
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
    if (updateCompanyDto.business_category !== undefined) {
      company.business_category = updateCompanyDto.business_category;
    }
    if (updateCompanyDto.order_collect_customer_info !== undefined) {
      company.order_collect_customer_info = updateCompanyDto.order_collect_customer_info;
    }
    if (updateCompanyDto.order_collect_products !== undefined) {
      company.order_collect_products = updateCompanyDto.order_collect_products;
    }
    if (updateCompanyDto.order_allow_note !== undefined) {
      company.order_allow_note = updateCompanyDto.order_allow_note;
    }
    if (updateCompanyDto.bot_enabled !== undefined) {
      company.bot_enabled = false;
    }
    if (updateCompanyDto.agent_assignment_timeout_minutes !== undefined) {
      company.agent_assignment_timeout_minutes = updateCompanyDto.agent_assignment_timeout_minutes;
    }
    if (updateCompanyDto.agent_offline_shift_minutes !== undefined) {
      company.agent_offline_shift_minutes = updateCompanyDto.agent_offline_shift_minutes;
    }

    company.bot_enabled = false;

    const nextCompanyName = company.name;
    const existingChannel = await this.whatsappChannelService.getForCompany(
      Number(company.id),
    );
    const previousProvider = existingChannel?.provider_type ?? 'evolution';
    const nextProvider = updateCompanyDto.whatsapp_provider_type ?? previousProvider;
    const whatsappAccountChanged =
      nextProvider !== previousProvider ||
      this.whatsappAccountIdentity(previousProvider, existingChannel) !==
        this.whatsappAccountIdentity(nextProvider, existingChannel, updateCompanyDto);
    const whatsappPatch = buildWhatsappChannelPatch(
      Number(company.id),
      nextCompanyName,
      updateCompanyDto,
      existingChannel,
    );

    if (whatsappAccountChanged) {
      if (updateCompanyDto.delete_previous_whatsapp_chats !== true) {
        throw new BadRequestException(
          'Confirm removal of the previous WhatsApp setup and conversations before changing the provider or account.',
        );
      }

      whatsappPatch.status = 'DISCONNECTED';
      if (nextProvider === 'meta') {
        whatsappPatch.instance_name = `meta-${company.id}`;
        whatsappPatch.evolution_instance_name = null;
        whatsappPatch.evaluation_whatsapp_key = null;
        whatsappPatch.evolution_api_base = null;
        whatsappPatch.evolution_read_messages = null;
        whatsappPatch.meta_phone_number_id = updateCompanyDto.meta_phone_number_id?.trim() || null;
        whatsappPatch.meta_access_token = updateCompanyDto.meta_access_token?.trim() || null;
        whatsappPatch.meta_waba_id = updateCompanyDto.meta_waba_id?.trim() || null;
        whatsappPatch.meta_verify_token = updateCompanyDto.meta_verify_token?.trim() || null;
        whatsappPatch.meta_webhook_base_url =
          updateCompanyDto.meta_webhook_base_url?.trim().replace(/\/+$/, '') || null;
        if (whatsappPatch.meta_phone_number_id && whatsappPatch.meta_access_token) {
          whatsappPatch.status = 'CONNECTED';
        }
      } else {
        whatsappPatch.instance_name =
          updateCompanyDto.whatsapp_instance_name?.trim() || `company-${company.id}`;
        whatsappPatch.evolution_instance_name = whatsappPatch.instance_name;
        whatsappPatch.evaluation_whatsapp_key = null;
        whatsappPatch.evolution_api_base = updateCompanyDto.evolution_api_base?.trim() || null;
        whatsappPatch.evolution_read_messages = null;
        whatsappPatch.meta_phone_number_id = null;
        whatsappPatch.meta_access_token = null;
        whatsappPatch.meta_waba_id = null;
        whatsappPatch.meta_verify_token = null;
        whatsappPatch.meta_webhook_base_url = null;
      }
    }

    if (whatsappAccountChanged && updateCompanyDto.delete_previous_whatsapp_chats === true) {
      await this.deleteCompanyWhatsappConversationHistory(Number(company.id));
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
