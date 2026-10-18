import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CompanyService } from '../../company/company.service';
import { Company } from '../../company/entities/company.entity';
import { WhatsappChannelService } from '../../whatsapp/whatsapp-channel.service';
import { MetaGraphService } from './meta-graph.service';

export type WhatsappConnectInput = {
  code: string;
  waba_id?: string;
  phone_number_id?: string;
  page_url?: string;
  /** the code came from the full-page redirect (not the popup) */
  via_redirect?: boolean;
};

/**
 * Connects a WhatsApp Business number from a Meta Embedded Signup code. Used by the popup flow (POST whatsapp/connect)
 * and by the redirect flow (Meta → /integrations/meta/callback), so both do exactly the same.
 */
@Injectable()
export class WhatsappConnectService {
  constructor(
    private readonly metaGraphService: MetaGraphService,
    private readonly companyService: CompanyService,
    private readonly whatsappChannelService: WhatsappChannelService,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
  ) {}

  async assertAdmin(user: Pick<AuthenticatedUser, 'id' | 'company_id'>) {
    const company = await this.companyRepository.findOne({
      where: { id: user.company_id },
    });
    if (!company || Number(company.admin_user_id) !== Number(user.id)) {
      throw new ForbiddenException(
        'Only the company admin can manage channel connections.',
      );
    }
    return company;
  }

  async connect(user: AuthenticatedUser, body: WhatsappConnectInput) {
    const company = await this.assertAdmin(user);
    const existing = await this.whatsappChannelService.getForCompany(
      user.company_id,
    );
    if (body.phone_number_id)
      await this.companyService.assertWhatsappNumberFree(
        Number(company.id),
        body.phone_number_id.trim(),
      );

    const accessToken = await this.metaGraphService.exchangeEmbeddedSignupCode(
      body.code,
      body.page_url,
      Boolean(body.via_redirect),
    );
    // the redirect flow (and a lost popup message) gives no ids: find the shared account + number from the token
    let wabaId = body.waba_id?.trim() ?? '';
    let phoneNumberId = body.phone_number_id?.trim() ?? '';
    if (!wabaId || !phoneNumberId) {
      const found =
        await this.metaGraphService.discoverSharedWhatsappNumber(accessToken);
      if (!found)
        throw new BadRequestException(
          'Meta did not share a WhatsApp number. Run the setup again and choose (or add) a phone number.',
        );
      wabaId = found.waba_id;
      phoneNumberId = found.phone_number_id;
      await this.companyService.assertWhatsappNumberFree(
        Number(company.id),
        phoneNumberId,
      );
    }
    const replaced =
      existing?.meta_phone_number_id &&
      existing.meta_phone_number_id !== phoneNumberId
        ? existing.meta_phone_number_id
        : null;
    const phone = await this.metaGraphService.fetchWhatsappPhoneNumber(
      phoneNumberId,
      accessToken,
    );
    await this.metaGraphService.subscribeWhatsappApp(wabaId, accessToken);
    // Cloud API numbers must be registered before they can send / receive (6-digit two-step PIN)
    const pin = /^\d{6}$/.test(
      String(process.env.WHATSAPP_REGISTRATION_PIN ?? ''),
    )
      ? String(process.env.WHATSAPP_REGISTRATION_PIN)
      : String(Math.floor(100000 + Math.random() * 900000));
    const registration = await this.metaGraphService.registerWhatsappNumber(
      phoneNumberId,
      accessToken,
      pin,
    );

    const verifyToken =
      existing?.meta_verify_token?.trim() ||
      process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() ||
      randomBytes(24).toString('hex');
    const webhookBase =
      existing?.meta_webhook_base_url?.trim() ||
      process.env.PUBLIC_API_BASE_URL?.trim() ||
      process.env.API_BASE_URL?.trim() ||
      '';
    const savedCompany = await this.companyService.update(
      Number(company.id),
      {
        phone: phone.display_phone_number.replace(/\D/g, ''),
        whatsapp_provider_type: 'meta',
        meta_phone_number_id: phoneNumberId,
        meta_waba_id: wabaId,
        meta_access_token: accessToken,
        meta_verify_token: verifyToken,
        meta_webhook_base_url: webhookBase,
      },
      user,
    );
    return {
      company: savedCompany,
      display_phone_number: phone.display_phone_number,
      verified_name: phone.verified_name,
      subscribed: true,
      registered: registration.registered,
      registration_message: registration.registered
        ? null
        : `The number could not be registered for the Cloud API: ${registration.message}`,
      replaced_previous_number: Boolean(replaced),
    };
  }
}
