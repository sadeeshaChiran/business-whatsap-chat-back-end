import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Company } from '../company/entities/company.entity';
import { WhatsappChannel } from './entities/whatsapp-channel.entity';

export type WhatsappChannelSnapshot = {
  instance_name: string | null;
  evaluation_whatsapp_key: string | null;
  status: string | null;
  provider_type: 'evolution' | 'meta' | null;
  meta_phone_number_id: string | null;
  meta_waba_id: string | null;
  evolution_api_base: string | null;
};

@Injectable()
export class WhatsappChannelService {
  constructor(
    @InjectRepository(WhatsappChannel)
    private readonly whatsappChannelRepository: Repository<WhatsappChannel>,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
  ) {}

  normalizePhone(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const digits = value.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) {
      return null;
    }
    return digits;
  }

  /** One company phone per company; no other company may use the same digits. */
  async assertUniqueCompanyPhone(companyId: number, phoneDigits: string) {
    const companies = await this.companyRepository.find();
    const conflict = companies.find((row) => {
      if (Number(row.id) === Number(companyId)) {
        return false;
      }
      return this.normalizePhone(row.phone) === phoneDigits;
    });
    if (conflict) {
      throw new ConflictException(
        'This phone number is already used by another company.',
      );
    }
  }

  async getForCompany(companyId: number) {
    return this.whatsappChannelRepository.findOne({
      where: { company_id: companyId },
      order: { id: 'ASC' },
    });
  }

  mapEvolutionState(state: string | null | undefined): string {
    const normalized = (state ?? '').trim().toLowerCase();
    if (normalized === 'open') {
      return 'CONNECTED';
    }
    if (normalized === 'connecting') {
      return 'CONNECTING';
    }
    return 'DISCONNECTED';
  }

  async upsertForCompany(
    companyId: number,
    companyName: string,
    patch: Partial<WhatsappChannel>,
  ): Promise<WhatsappChannel> {
    const existing = await this.getForCompany(companyId);

    if (existing) {
      return this.whatsappChannelRepository.save({
        ...existing,
        ...patch,
        company_name: companyName,
      });
    }

    const instanceName = patch.instance_name?.trim();
    const metaPhoneNumberId = patch.meta_phone_number_id?.trim();
    if (!instanceName && !metaPhoneNumberId) {
      throw new BadRequestException(
        'WhatsApp instance name or Meta phone number id is required before saving.',
      );
    }

    return this.whatsappChannelRepository.save(
      this.whatsappChannelRepository.create({
        company_id: companyId,
        company_name: companyName,
        instance_name: instanceName || metaPhoneNumberId || `company-${companyId}`,
        evaluation_whatsapp_key: patch.evaluation_whatsapp_key ?? null,
        provider_type: patch.provider_type ?? 'evolution',
        meta_phone_number_id: patch.meta_phone_number_id ?? null,
        meta_access_token: patch.meta_access_token ?? null,
        meta_waba_id: patch.meta_waba_id ?? null,
        meta_verify_token: patch.meta_verify_token ?? null,
        evolution_api_base: patch.evolution_api_base ?? null,
        role_type: 'general',
        status: patch.status ?? 'DISCONNECTED',
        weight: 1,
        created_at: new Date(),
      }),
    );
  }

  toSnapshot(channel: WhatsappChannel | null): WhatsappChannelSnapshot {
    return {
      instance_name: channel?.instance_name ?? null,
      evaluation_whatsapp_key: channel?.evaluation_whatsapp_key ?? null,
      status: channel?.status ?? null,
      provider_type: (channel?.provider_type as 'evolution' | 'meta' | null) ?? 'evolution',
      meta_phone_number_id: channel?.meta_phone_number_id ?? null,
      meta_waba_id: channel?.meta_waba_id ?? null,
      evolution_api_base: channel?.evolution_api_base ?? null,
    };
  }
}
