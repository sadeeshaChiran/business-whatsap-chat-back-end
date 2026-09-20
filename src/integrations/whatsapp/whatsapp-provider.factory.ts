import { Injectable, NotFoundException } from '@nestjs/common';
import type { WhatsappChannel } from '../../whatsapp/entities/whatsapp-channel.entity';
import type {
  WhatsappProviderType,
  WhatsappServiceInterface,
} from './interfaces/whatsapp-service.interface';
// Evolution remains available for legacy webhook/runtime support, but is disabled as a selectable provider.
import { EvolutionAdapter } from './adapters/evolution.adapter';
import { MetaAdapter } from './adapters/meta.adapter';

@Injectable()
export class WhatsappProviderFactory {
  constructor(
    private readonly evolutionAdapter: EvolutionAdapter,
    private readonly metaAdapter: MetaAdapter,
  ) {}

  getAdapter(provider: WhatsappProviderType): WhatsappServiceInterface {
    // Evolution provider selection is intentionally disabled; Meta is the only active provider.
    // return provider === 'meta' ? this.metaAdapter : this.evolutionAdapter;
    return this.metaAdapter;
  }

  getAdapterForChannel(channel: WhatsappChannel): WhatsappServiceInterface {
    const provider = (channel.provider_type ?? 'meta') as WhatsappProviderType;
    return this.getAdapter(provider);
  }

  detectProviderFromWebhook(body: unknown): WhatsappProviderType | null {
    const root = (body as Record<string, unknown>) ?? {};
    const payload = (root.body as Record<string, unknown>) ?? root;
    if (payload.object === 'whatsapp_business_account') {
      return 'meta';
    }
    // Evolution webhook detection is disabled while Meta Cloud API is the only active provider.
    // if (
    //   payload.instance ||
    //   payload.data ||
    //   payload.message ||
    //   (payload.key as Record<string, unknown>)?.remoteJid
    // ) {
    //   return 'evolution';
    // }
    return null;
  }

  normalizeInboundWebhook(body: unknown) {
    return this.normalizeInboundWebhooks(body)[0] ?? null;
  }

  normalizeInboundWebhooks(body: unknown) {
    const provider = this.detectProviderFromWebhook(body);
    if (!provider) {
      return [];
    }
    return this.getAdapter(provider).normalizeInboundWebhooks(body);
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
