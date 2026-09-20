import type { UpdateCompanyDto } from '../company/dto/update-company.dto';
import type { WhatsappChannel } from './entities/whatsapp-channel.entity';

export function looksLikeMetaPhoneNumberId(value: string | null | undefined): boolean {
  const trimmed = String(value ?? '').trim();
  return trimmed.length >= 10 && /^\d+$/.test(trimmed);
}

function slugifyInstanceName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'whatsapp'
  );
}

// Legacy Evolution instance naming is retained for restoration, but is disabled for Meta-only settings.
// function defaultEvolutionInstanceName(
//   companyId: number,
//   companyName: string,
// ): string {
//   const slug = slugifyInstanceName(companyName);
//   return `${slug}-${companyId}`;
// }

/** Build whatsapp_channels patch from Settings save — one active provider at a time. */
export function buildWhatsappChannelPatch(
  companyId: number,
  companyName: string,
  updateCompanyDto: UpdateCompanyDto,
  existingChannel: WhatsappChannel | null,
): Partial<WhatsappChannel> {
  const whatsappPatch: Partial<WhatsappChannel> = {};

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
  // Evolution API base configuration is intentionally disabled.
  // if (updateCompanyDto.evolution_api_base !== undefined) {
  //   whatsappPatch.evolution_api_base =
  //     updateCompanyDto.evolution_api_base.trim() || null;
  // }
  if (updateCompanyDto.meta_webhook_base_url !== undefined) {
    whatsappPatch.meta_webhook_base_url =
      updateCompanyDto.meta_webhook_base_url.trim().replace(/\/+$/, '') || null;
  }

  const nextProvider =
    updateCompanyDto.whatsapp_provider_type ??
    existingChannel?.provider_type ??
    'meta';

  if (nextProvider === 'meta') {
    whatsappPatch.provider_type = 'meta';

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
    }

    const explicitInstance = updateCompanyDto.whatsapp_instance_name?.trim() || '';
    const existingInstance = existingChannel?.instance_name?.trim() || '';
    // Evolution alias preservation is intentionally disabled for Meta-only settings.
    // const rawEvolutionAlias = existingChannel?.evolution_instance_name?.trim() || '';
    // const existingEvolutionAlias =
    //   rawEvolutionAlias && rawEvolutionAlias !== metaPhoneNumberId &&
    //   !looksLikeMetaPhoneNumberId(rawEvolutionAlias) ? rawEvolutionAlias : '';
    // const evolutionAlias = explicitInstance || existingEvolutionAlias ||
    //   (existingInstance && existingInstance !== metaPhoneNumberId &&
    //   !looksLikeMetaPhoneNumberId(existingInstance) ? existingInstance : '');
    // whatsappPatch.evolution_instance_name = evolutionAlias ||
    //   defaultEvolutionInstanceName(companyId, companyName);
    whatsappPatch.instance_name = metaPhoneNumberId || existingInstance || `meta-${companyId}`;

    if (metaPhoneNumberId && metaAccessToken) {
      whatsappPatch.status = 'CONNECTED';
    } else if (updateCompanyDto.whatsapp_provider_type === 'meta') {
      whatsappPatch.status = 'DISCONNECTED';
    }
  // Legacy Evolution settings branch retained for restoration.
  // } else if (updateCompanyDto.whatsapp_provider_type === 'evolution') {
  //   whatsappPatch.provider_type = 'evolution';
  //   const evolutionInstance = whatsappPatch.instance_name?.trim() ||
  //     existingChannel?.instance_name?.trim() || '';
  //   if (evolutionInstance && !looksLikeMetaPhoneNumberId(evolutionInstance)) {
  //     whatsappPatch.instance_name = evolutionInstance;
  //     whatsappPatch.evolution_instance_name = evolutionInstance;
  //     whatsappPatch.status = existingChannel?.status === 'CONNECTED'
  //       ? 'CONNECTED' : 'DISCONNECTED';
  //   }
  }

  if (updateCompanyDto.name !== undefined) {
    whatsappPatch.company_name = companyName;
  }

  return whatsappPatch;
}
