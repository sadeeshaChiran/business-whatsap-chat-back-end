import { Injectable, NotFoundException } from '@nestjs/common';
import type { WhatsappChannel } from '../../whatsapp/entities/whatsapp-channel.entity';
import type {
  WhatsappProviderType,
  WhatsappServiceInterface,
} from './interfaces/whatsapp-service.interface';
import { EvolutionAdapter } from './adapters/evolution.adapter';
import { MetaAdapter } from './adapters/meta.adapter';

@Injectable()
export class WhatsappProviderFactory {
  constructor(
    private readonly evolutionAdapter: EvolutionAdapter,
    private readonly metaAdapter: MetaAdapter,
  ) {}

  getAdapter(provider: WhatsappProviderType): WhatsappServiceInterface {
    return provider === 'meta' ? this.metaAdapter : this.evolutionAdapter;
  }

  getAdapterForChannel(channel: WhatsappChannel): WhatsappServiceInterface {
    const provider = (channel.provider_type ?? 'evolution') as WhatsappProviderType;
    return this.getAdapter(provider);
  }

  detectProviderFromWebhook(body: unknown): WhatsappProviderType | null {
    const root = (body as Record<string, unknown>) ?? {};
    const payload = (root.body as Record<string, unknown>) ?? root;
    if (payload.object === 'whatsapp_business_account') {
      return 'meta';
    }
    if (
      payload.instance ||
      payload.data ||
      payload.message ||
      (payload.key as Record<string, unknown>)?.remoteJid
    ) {
      return 'evolution';
    }
    return null;
  }

  normalizeInboundWebhook(body: unknown) {
    const provider = this.detectProviderFromWebhook(body);
    if (!provider) {
      return null;
    }
    return this.getAdapter(provider).normalizeInboundWebhook(body);
  }
}

@Injectable()
export class WhatsappRoutingService {
  constructor(private readonly factory: WhatsappProviderFactory) {}

  resolveAdapterForInbound(
    body: unknown,
    channel?: WhatsappChannel | null,
  ): WhatsappServiceInterface {
    if (channel) {
      return this.factory.getAdapterForChannel(channel);
    }
    const provider = this.factory.detectProviderFromWebhook(body);
    if (!provider) {
      throw new NotFoundException('Unable to detect WhatsApp provider from webhook.');
    }
    return this.factory.getAdapter(provider);
  }
}
