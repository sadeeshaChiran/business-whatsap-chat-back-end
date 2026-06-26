import { Injectable } from '@nestjs/common';
import type { WhatsappChannel } from '../../../whatsapp/entities/whatsapp-channel.entity';
import type {
  NormalizedWhatsAppInbound,
  WhatsappServiceInterface,
} from '../interfaces/whatsapp-service.interface';

@Injectable()
export class MetaAdapter implements WhatsappServiceInterface {
  readonly provider = 'meta' as const;

  private graphVersion(): string {
    return (
      process.env.META_GRAPH_API_VERSION ??
      process.env.WHATSAPP_GRAPH_API_VERSION ??
      'v22.0'
    ).trim();
  }

  normalizeInboundWebhook(body: unknown): NormalizedWhatsAppInbound | null {
    const root = (body as Record<string, unknown>) ?? {};
    const payload = (root.body as Record<string, unknown>) ?? root;
    if (payload.object !== 'whatsapp_business_account') {
      return null;
    }

    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const changes = Array.isArray((entry as Record<string, unknown>).changes)
        ? ((entry as Record<string, unknown>).changes as unknown[])
        : [];
      for (const change of changes) {
        if (!change || typeof change !== 'object') {
          continue;
        }
        const value = (change as Record<string, unknown>).value as
          | Record<string, unknown>
          | undefined;
        if (!value) {
          continue;
        }
        const metadata = (value.metadata as Record<string, unknown>) ?? {};
        const phoneNumberId = String(metadata.phone_number_id ?? '').trim();
        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const rawMessage of messages) {
          if (!rawMessage || typeof rawMessage !== 'object') {
            continue;
          }
          const message = rawMessage as Record<string, unknown>;
          const phone = String(message.from ?? '').replace(/\D/g, '');
          const messageType = String(message.type ?? 'text').toLowerCase();
          const messageId = String(message.id ?? '').trim();
          if (!phone) {
            continue;
          }

          let text = '';
          let hasImage = false;
          let hasVoice = false;
          if (messageType === 'text') {
            text = String((message.text as Record<string, unknown>)?.body ?? '').trim();
          } else if (messageType === 'image') {
            hasImage = true;
            text =
              String((message.image as Record<string, unknown>)?.caption ?? '').trim() ||
              '[image]';
          } else if (messageType === 'audio') {
            hasVoice = true;
            text = '[voice note]';
          } else {
            text = `[${messageType}]`;
          }

          return {
            provider: 'meta',
            routing_key: phoneNumberId,
            phone,
            remote_jid: `${phone}@s.whatsapp.net`,
            message: text,
            message_id: messageId,
            from_me: false,
            input_type: hasVoice ? 'voice' : hasImage ? 'image' : 'text',
            message_type: messageType,
            timestamp: Number(message.timestamp ?? Math.floor(Date.now() / 1000)),
            meta_phone_number_id: phoneNumberId,
            has_image: hasImage,
            has_voice: hasVoice,
            image_caption: hasImage
              ? String((message.image as Record<string, unknown>)?.caption ?? '').trim() ||
                undefined
              : undefined,
          };
        }
      }
    }

    return null;
  }

  async resolveDisplayPhoneNumber(
    channel: WhatsappChannel,
  ): Promise<string | null> {
    const token = channel.meta_access_token?.trim() ?? '';
    const phoneNumberId = channel.meta_phone_number_id?.trim() ?? '';
    if (!token || !phoneNumberId) {
      return null;
    }

    try {
      const url = new URL(
        `https://graph.facebook.com/${this.graphVersion()}/${phoneNumberId}`,
      );
      url.searchParams.set('fields', 'display_phone_number');
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as { display_phone_number?: string };
      const display = String(data.display_phone_number ?? '').trim();
      return display || null;
    } catch {
      return null;
    }
  }

  async sendText(
    channel: WhatsappChannel,
    toPhone: string,
    text: string,
  ): Promise<void> {
    const token = channel.meta_access_token?.trim() ?? '';
    const phoneNumberId = channel.meta_phone_number_id?.trim() ?? '';
    const phone = toPhone.replace(/\D/g, '');
    if (!token || !phoneNumberId || !phone || !text.trim()) {
      throw new Error('Meta sendText missing token, phone number id, phone, or text.');
    }

    const res = await fetch(
      `https://graph.facebook.com/${this.graphVersion()}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text',
          text: { body: text.trim() },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Meta sendText failed (${res.status}): ${body}`);
    }
  }
}
