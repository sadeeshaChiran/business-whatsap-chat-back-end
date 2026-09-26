import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentRoutingService } from '../../agent-routing/agent-routing.service';
import { WhatsappChannel } from '../../whatsapp/entities/whatsapp-channel.entity';
import { BotMessage } from '../../bot-admin/entities/bot-message.entity';
import { WhatsappChannelService } from '../../whatsapp/whatsapp-channel.service';
import type { NormalizedWhatsAppInbound } from './interfaces/whatsapp-service.interface';
import { MetaAdapter } from './adapters/meta.adapter';
import { WhatsappProviderFactory } from './whatsapp-provider.factory';
import { contentFromMetaMessage, findMetaRawMessage, type InboundRow } from './meta-inbound-content.util';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    @InjectRepository(WhatsappChannel)
    private readonly whatsappChannelRepository: Repository<WhatsappChannel>,
    @InjectRepository(BotMessage)
    private readonly messageRepository: Repository<BotMessage>,
    private readonly whatsappChannelService: WhatsappChannelService,
    private readonly providerFactory: WhatsappProviderFactory,
    private readonly metaAdapter: MetaAdapter,
    private readonly agentRoutingService: AgentRoutingService,
  ) {}

  async resolveMetaDisplayPhoneNumber(
    channel: WhatsappChannel | null,
  ): Promise<string | null> {
    if (!channel || channel.provider_type !== 'meta') {
      return null;
    }
    return this.metaAdapter.resolveDisplayPhoneNumber(channel);
  }

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
      .where(
        `(LOWER(TRIM(wc.instance_name)) = LOWER(TRIM(:instance))
          OR LOWER(TRIM(COALESCE(wc.evolution_instance_name, ''))) = LOWER(TRIM(:instance)))`,
        { instance: normalized.routing_key },
      )
      .orderBy('wc.id', 'ASC')
      .getOne();
  }

  normalizeInboundWebhook(body: unknown): NormalizedWhatsAppInbound | null {
    return this.providerFactory.normalizeInboundWebhook(body);
  }

  async processInboundWebhook(body: unknown) {
    const statusResult = await this.processMetaStatusCallbacks(body);
    const normalizedMessages = this.providerFactory.normalizeInboundWebhooks(body);
    if (!normalizedMessages.length) {
      return statusResult ?? { accepted: false, reason: 'unsupported_payload' };
    }

    const results: Awaited<ReturnType<WhatsappService['processNormalizedInbound']>>[] = [];
    for (const [index, normalized] of normalizedMessages.entries()) {
      results.push(await this.processNormalizedInbound(body, normalized, index === 0));
    }

    return results.length === 1
      ? results[0]
      : { accepted: true, processed: results.length, results };
  }

  private async processMetaStatusCallbacks(body: unknown) {
    const payload = ((body as Record<string, unknown>)?.body as Record<string, unknown>) ?? (body as Record<string, unknown>) ?? {};
    if (payload.object !== 'whatsapp_business_account') return null;
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    let updated = 0;
    for (const rawEntry of entries) {
      const entry = rawEntry as Record<string, unknown>;
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const rawChange of changes) {
        const value = (rawChange as Record<string, unknown>)?.value as Record<string, unknown> | undefined;
        const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
        for (const rawStatus of statuses) {
          const item = rawStatus as Record<string, unknown>;
          const messageId = String(item.id ?? '').trim();
          const nextStatus = this.normalizeDeliveryStatus(String(item.status ?? '').trim());
          if (!messageId || !nextStatus) continue;
          const result = await this.messageRepository
            .createQueryBuilder()
            .update(BotMessage)
            .set({ delivery_status: nextStatus })
            .where('provider_message_id = :messageId', { messageId })
            .andWhere("platform = 'whatsapp'")
            .andWhere("direction::text = 'outbound'")
            .execute();
          updated += Number(result.affected ?? 0);
        }
      }
    }
    return updated > 0 ? { accepted: true, status_updates: updated } : null;
  }

  private normalizeDeliveryStatus(status: string): 'sent' | 'delivered' | 'read' | 'failed' | null {
    const normalized = status.toLowerCase();
    if (normalized === 'sent') return 'sent';
    if (normalized === 'delivered') return 'delivered';
    if (normalized === 'read') return 'read';
    if (normalized === 'failed') return 'failed';
    return null;
  }
  /**
   * Builds the chat row for an inbound message.
   * Meta: read the full message from the raw webhook (location, contact, document name,
   * video, sticker…) – the adapter alone only gives "[location]" / "[document]".
   */
  private buildInboundRow(body: unknown, normalized: NormalizedWhatsAppInbound): InboundRow | { skip: string } | null {
    const adapterText = normalized.message?.trim() ?? '';
    const adapterMediaUrl = normalized.meta_media_id?.trim() ? `meta-media:${normalized.meta_media_id.trim()}` : null;

    if (normalized.provider === 'meta') {
      const raw = findMetaRawMessage(body, normalized.message_id);
      if (raw) {
        const rich = contentFromMetaMessage(raw);
        if ('skip' in rich) return rich;
        return {
          // voice notes: keep the adapter's text only if it is a real transcript,
          // not a placeholder like "[voice note]" (those show as a voice player anyway)
          content:
            rich.message_type === 'voice' && adapterText && !/^\[[^\]]*\]$/.test(adapterText)
              ? adapterText
              : rich.content || adapterText,
          message_type: rich.message_type,
          media_url: rich.media_url ?? adapterMediaUrl,
        };
      }
    }

    if (!adapterText) return null;
    return {
      content: adapterText,
      message_type:
        normalized.input_type === 'voice'
          ? 'voice'
          : normalized.input_type === 'image'
            ? 'image'
            : normalized.input_type === 'system'
              ? 'system'
              : 'text',
      media_url: adapterMediaUrl,
    };
  }

  private async processNormalizedInbound(
    body: unknown,
    normalized: NormalizedWhatsAppInbound,
    forwardMeta: boolean,
  ) {
    if (normalized.from_me || !normalized.phone) {
      return { accepted: true, ignored: true, normalized };
    }

    const row = this.buildInboundRow(body, normalized);
    if (row && 'skip' in row) {
      // e.g. a reaction – nothing to show in the chat, and nothing for the bot to answer
      return { accepted: true, ignored: true, reason: row.skip, normalized };
    }

    const channel = await this.resolveChannelForInbound(normalized);
    if (!channel) {
      this.logger.warn(
        `No WhatsApp channel matched provider=${normalized.provider} routing_key=${normalized.routing_key}`,
      );
      return { accepted: true, routed: false, normalized };
    }

    await this.whatsappChannelRepository.update(channel.id, { last_used_at: new Date() });
    const routing = await this.agentRoutingService.handleWhatsAppInboundForRouting(
      Number(channel.company_id),
      normalized.phone,
      normalized.display_name,
      row?.content
        ? {
            content: row.content,
            message_type: row.message_type,
            media_url: row.media_url,
            source: 'customer',
            provider_message_id: normalized.message_id?.trim() || undefined,
          }
        : undefined,
    );

    if (
      normalized.provider === 'meta' &&
      forwardMeta &&
      normalized.input_type !== 'system'
    ) {
      void this.forwardMetaInboundToN8nBot(body, {
        companyId: Number(channel.company_id),
        conversationId: routing.conversationId,
      });
    }

    return {
      accepted: true,
      routed: true,
      company_id: Number(channel.company_id),
      provider: normalized.provider,
      normalized,
      agent_routing: routing,
      n8n_forwarded:
        normalized.provider === 'meta' &&
        forwardMeta &&
        normalized.input_type !== 'system',
    };
  }
  /** Meta webhook hits Nest first; forward raw payload to n8n AI workflow. */
  private async forwardMetaInboundToN8nBot(
    body: unknown,
    context: { companyId: number; conversationId: number | null },
  ): Promise<void> {
    const forwardEnabled =
      String(process.env.N8N_FORWARD_META_INBOUND ?? 'true').toLowerCase() !==
      'false';
    if (!forwardEnabled) {
      return;
    }

    const url = (
      process.env.N8N_WHATSAPP_WEBHOOK_URL ??
      process.env.EVOLUTION_WEBHOOK_URL ??
      ''
    ).trim();
    if (!url) {
      this.logger.debug('N8N_WHATSAPP_WEBHOOK_URL not set; skipping Meta n8n forward');
      return;
    }

    const timeoutMs = Math.max(
      15000,
      Number(process.env.META_N8N_FORWARD_TIMEOUT_MS ?? 120000) || 120000,
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        this.logger.warn(
          `Meta n8n forward failed: ${response.status} ${response.statusText}`,
        );
        return;
      }

      const conversationId = Number(context.conversationId ?? 0);
      if (conversationId <= 0) {
        return;
      }

      let rawPayload: unknown = null;
      try {
        rawPayload = await response.json();
      } catch {
        return;
      }

      const payload = this.extractN8nWebhookPayload(rawPayload);
      const reply = String(payload?.reply ?? '').trim();
      if (reply) {
        await this.agentRoutingService.persistOutboundBotReply(
          context.companyId,
          conversationId,
          reply,
          { source: 'meta_bot' },
        );
      }

      const imageUrls = Array.isArray(payload?.product_image_urls)
        ? payload.product_image_urls
            .map((item) => String(item ?? '').trim())
            .filter(Boolean)
        : [];
      if (imageUrls.length) {
        await this.agentRoutingService.persistOutboundProductImages(
          context.companyId,
          conversationId,
          imageUrls,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Meta n8n forward error: ${message}`);
    }
  }

  private extractN8nWebhookPayload(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    if (Array.isArray(raw)) {
      const first = raw[0];
      if (first && typeof first === 'object' && 'json' in first) {
        const nested = (first as { json?: unknown }).json;
        return nested && typeof nested === 'object'
          ? (nested as Record<string, unknown>)
          : null;
      }
      return null;
    }
    const record = raw as Record<string, unknown>;
    if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
      return record.data as Record<string, unknown>;
    }
    return record;
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

  async sendMedia(
    companyId: number,
    toPhone: string,
    media: {
      buffer: Buffer;
      mimetype: string;
      fileName: string;
      caption?: string;
      mediaType: 'image' | 'document' | 'audio' | 'video';
    },
  ) {
    const channel = await this.whatsappChannelService.getForCompany(companyId);
    if (!channel) {
      throw new NotFoundException('WhatsApp channel not configured for this company.');
    }
    const adapter = this.providerFactory.getAdapterForChannel(channel);
    await adapter.sendMedia(channel, toPhone, media);
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
