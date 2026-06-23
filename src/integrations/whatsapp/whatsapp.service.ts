import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsappChannel } from '../../whatsapp/entities/whatsapp-channel.entity';
import { WhatsappChannelService } from '../../whatsapp/whatsapp-channel.service';
import type { NormalizedWhatsAppInbound } from './interfaces/whatsapp-service.interface';
import { WhatsappProviderFactory } from './whatsapp-provider.factory';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    @InjectRepository(WhatsappChannel)
    private readonly whatsappChannelRepository: Repository<WhatsappChannel>,
    private readonly whatsappChannelService: WhatsappChannelService,
    private readonly providerFactory: WhatsappProviderFactory,
  ) {}

  async getChannelForCompany(companyId: number) {
    return this.whatsappChannelService.getForCompany(companyId);
  }

  async resolveChannelForInbound(
    normalized: NormalizedWhatsAppInbound,
  ): Promise<WhatsappChannel | null> {
    if (normalized.provider === 'meta') {
      return this.whatsappChannelRepository
        .createQueryBuilder('wc')
        .where('wc.provider_type = :provider', { provider: 'meta' })
        .andWhere('wc.meta_phone_number_id = :phoneNumberId', {
          phoneNumberId: normalized.routing_key,
        })
        .orderBy('wc.id', 'ASC')
        .getOne();
    }

    return this.whatsappChannelRepository
      .createQueryBuilder('wc')
      .where('LOWER(TRIM(wc.instance_name)) = LOWER(TRIM(:instance))', {
        instance: normalized.routing_key,
      })
      .orderBy('wc.id', 'ASC')
      .getOne();
  }

  normalizeInboundWebhook(body: unknown): NormalizedWhatsAppInbound | null {
    return this.providerFactory.normalizeInboundWebhook(body);
  }

  async processInboundWebhook(body: unknown) {
    const normalized = this.normalizeInboundWebhook(body);
    if (!normalized) {
      return { accepted: false, reason: 'unsupported_payload' };
    }
    if (normalized.from_me || !normalized.phone) {
      return { accepted: true, ignored: true, normalized };
    }

    const channel = await this.resolveChannelForInbound(normalized);
    if (!channel) {
      this.logger.warn(
        `No WhatsApp channel matched provider=${normalized.provider} routing_key=${normalized.routing_key}`,
      );
      return { accepted: true, routed: false, normalized };
    }

    await this.whatsappChannelRepository.update(channel.id, {
      last_used_at: new Date(),
    });

    return {
      accepted: true,
      routed: true,
      company_id: Number(channel.company_id),
      provider: normalized.provider,
      normalized,
    };
  }

  async sendText(companyId: number, toPhone: string, text: string) {
    const channel = await this.whatsappChannelService.getForCompany(companyId);
    if (!channel) {
      throw new NotFoundException('WhatsApp channel not configured for this company.');
    }
    const adapter = this.providerFactory.getAdapterForChannel(channel);
    await adapter.sendText(channel, toPhone, text);
    return { provider: adapter.provider, sent: true };
  }

  async verifyMetaWebhookToken(verifyToken: string): Promise<boolean> {
    const token = verifyToken.trim();
    if (!token) {
      return false;
    }
    const match = await this.whatsappChannelRepository.findOne({
      where: {
        provider_type: 'meta',
        meta_verify_token: token,
      },
    });
    return Boolean(match);
  }

  getPublicWebhookUrls(apiBaseUrl: string) {
    const base = apiBaseUrl.replace(/\/+$/, '');
    return {
      meta_webhook_url: `${base}/integrations/whatsapp/webhook/meta`,
      evolution_webhook_url: `${base}/integrations/whatsapp/webhook/evolution`,
      unified_webhook_url: `${base}/integrations/whatsapp/webhook`,
    };
  }

  toRoutingContext(channel: WhatsappChannel | null) {
    const provider = (channel?.provider_type ?? 'evolution') as 'evolution' | 'meta';
    return {
      provider_type: provider,
      channel_instance: channel?.instance_name ?? '',
      evaluation_whatsapp_key: channel?.evaluation_whatsapp_key ?? '',
      meta_phone_number_id: channel?.meta_phone_number_id ?? '',
      meta_access_token: channel?.meta_access_token ?? '',
      meta_waba_id: channel?.meta_waba_id ?? '',
      meta_verify_token: channel?.meta_verify_token ?? '',
      evolution_api_base:
        channel?.evolution_api_base ??
        process.env.EVOLUTION_API_BASE ??
        process.env.EVOLUTION_BASE_URL ??
        '',
    };
  }
}
