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
import { releaseWhatsappNumberFromOtherCompanies } from '../../whatsapp/release-whatsapp-channel';

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

  async assertAdmin(user: Pick<AuthenticatedUser, 'id' | 'company_id'> & { role?: AuthenticatedUser['role'] }) {
    const company = await this.companyRepository.findOne({
      where: { id: user.company_id },
    });
    if (!company || (Number(company.admin_user_id) !== Number(user.id) && user.role !== 'supervisor')) {
      throw new ForbiddenException(
        'Only the company admin can manage channel connections.',
      );
    }
    return company;
  }

  /** Meta phone number ids already connected to other workspaces. */
  private async numbersOfOtherCompanies(companyId: number): Promise<string[]> {
    const rows: Array<{ id: string }> = await this.companyRepository.manager
      .query(`SELECT meta_phone_number_id AS id FROM whatsapp_channels WHERE company_id <> $1 AND COALESCE(meta_phone_number_id, '') <> ''`, [companyId])
      .catch(() => []);
    return rows.map((row) => String(row.id).trim()).filter(Boolean);
  }

  /**
   * Meta did not say which number was chosen: find it in the shared WhatsApp accounts.
   * A number of this workspace or a free one comes first. A number another workspace has is taken only when it is
   * the only one left (then it moves here) – never when the account also holds numbers of other businesses.
   */
  private async pickSharedNumber(companyId: number, accessToken: string, exclude: string[] = []) {
    const others = new Set(await this.numbersOfOtherCompanies(companyId));
    const all = (await this.metaGraphService.listSharedWhatsappNumbers(accessToken)).filter((n) => !exclude.includes(n.phone_number_id));
    const free = all.filter((n) => !others.has(n.phone_number_id));
    const pick = free.find((n) => n.fresh) ?? free[0] ?? (all.length === 1 ? all[0] : undefined);
    return pick ? { waba_id: pick.waba_id, phone_number_id: pick.phone_number_id } : null;
  }

  async connect(user: AuthenticatedUser, body: WhatsappConnectInput, addNumber?: { label?: string; purpose?: string }) {
    if (addNumber) return this.connectAnother(user, body, addNumber);
    const company = await this.assertAdmin(user);
    const existing = await this.whatsappChannelService.getForCompany(
      user.company_id,
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
      const found = await this.pickSharedNumber(Number(company.id), accessToken);
      if (!found)
        throw new BadRequestException(
          'Meta did not share a WhatsApp number. Run the setup again and choose (or add) a phone number.',
        );
      wabaId = found.waba_id;
      phoneNumberId = found.phone_number_id;
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
    // Meta confirmed this login owns the number: when another workspace still has it, it moves here
    await releaseWhatsappNumberFromOtherCompanies(this.companyRepository.manager, Number(company.id), phoneNumberId);
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
      added_number: false,
    };
  }

  /**
   * Adds another WhatsApp number to the company (sales, support, wholesale …). The main number, the company
   * settings and every existing chat stay as they are; customers are answered from the number they write to.
   */
  async connectAnother(user: AuthenticatedUser, body: WhatsappConnectInput, addNumber: { label?: string; purpose?: string }) {
    const company = await this.assertAdmin(user);
    const existing = await this.whatsappChannelService.listForCompany(Number(company.id));
    const taken = existing.map((channel) => String(channel.meta_phone_number_id ?? '').trim()).filter(Boolean);
    const accessToken = await this.metaGraphService.exchangeEmbeddedSignupCode(body.code, body.page_url, Boolean(body.via_redirect));
    let wabaId = body.waba_id?.trim() ?? '';
    let phoneNumberId = body.phone_number_id?.trim() ?? '';
    if (!wabaId || !phoneNumberId) {
      const found = await this.pickSharedNumber(Number(company.id), accessToken, taken);
      if (!found)
        throw new BadRequestException('Meta did not share a new WhatsApp number. Run the setup again and choose (or add) the new phone number.');
      wabaId = found.waba_id;
      phoneNumberId = found.phone_number_id;
    }
    if (taken.includes(phoneNumberId))
      throw new BadRequestException('This WhatsApp number is already connected to your workspace.');
    const phone = await this.metaGraphService.fetchWhatsappPhoneNumber(phoneNumberId, accessToken);
    await releaseWhatsappNumberFromOtherCompanies(this.companyRepository.manager, Number(company.id), phoneNumberId);
    await this.metaGraphService.subscribeWhatsappApp(wabaId, accessToken);
    const pin = /^\d{6}$/.test(String(process.env.WHATSAPP_REGISTRATION_PIN ?? ''))
      ? String(process.env.WHATSAPP_REGISTRATION_PIN)
      : String(Math.floor(100000 + Math.random() * 900000));
    const registration = await this.metaGraphService.registerWhatsappNumber(phoneNumberId, accessToken, pin);
    const main = existing[0] ?? null;
    await this.whatsappChannelService.addNumber(Number(company.id), String(company.name ?? ''), {
      meta_phone_number_id: phoneNumberId,
      meta_waba_id: wabaId,
      meta_access_token: accessToken,
      meta_verify_token: main?.meta_verify_token?.trim() || process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() || randomBytes(24).toString('hex'),
      meta_webhook_base_url: main?.meta_webhook_base_url?.trim() || process.env.PUBLIC_API_BASE_URL?.trim() || process.env.API_BASE_URL?.trim() || null,
      display_phone: phone.display_phone_number,
      verified_name: phone.verified_name || null,
      label: addNumber.label?.trim() || null,
      purpose: addNumber.purpose?.trim() || null,
    });
    return {
      company,
      display_phone_number: phone.display_phone_number,
      verified_name: phone.verified_name,
      subscribed: true,
      registered: registration.registered,
      registration_message: registration.registered ? null : `The number could not be registered for the Cloud API: ${registration.message}`,
      replaced_previous_number: false,
      added_number: true,
    };
  }
}
