import { Injectable } from '@nestjs/common';
import type { WhatsappChannel } from '../../../whatsapp/entities/whatsapp-channel.entity';
import type {
  NormalizedWhatsAppInbound,
  WhatsappOutboundMedia,
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
          const isDeletedMessage =
            ['deleted', 'revoked', 'revoke'].includes(messageType) ||
            message.deleted === true ||
            message.is_deleted === true;
          const messageId = String(message.id ?? '').trim();
          if (!phone) {
            continue;
          }

          let text = '';
          let hasImage = false;
          let hasVoice = false;
          if (isDeletedMessage) {
            text = 'This message was deleted';
          } else if (messageType === 'text') {
            text = String((message.text as Record<string, unknown>)?.body ?? '').trim();
          } else if (messageType === 'image') {
            hasImage = true;
            const imagePayload = (message.image as Record<string, unknown>) ?? {};
            text =
              String(imagePayload.caption ?? '').trim() ||
              '[image]';
          } else if (messageType === 'audio') {
            hasVoice = true;
            text = '[voice note]';
          } else {
            text = `[${messageType}]`;
          }

          const imagePayload = hasImage
            ? ((message.image as Record<string, unknown>) ?? {})
            : {};
          const metaMediaId = String(imagePayload.id ?? '').trim();

          return {
            provider: 'meta',
            routing_key: phoneNumberId,
            phone,
            remote_jid: `${phone}@s.whatsapp.net`,
            message: text,
            message_id: messageId,
            from_me: false,
            input_type: isDeletedMessage
              ? 'system'
              : hasVoice
                ? 'voice'
                : hasImage
                  ? 'image'
                  : 'text',
            message_type: isDeletedMessage ? 'system' : messageType,
            timestamp: Number(message.timestamp ?? Math.floor(Date.now() / 1000)),
            meta_phone_number_id: phoneNumberId,
            has_image: hasImage,
            has_voice: hasVoice,
            meta_media_id: metaMediaId || undefined,
            image_caption: hasImage
              ? String(imagePayload.caption ?? '').trim() || undefined
              : undefined,
          };
        }
      }
    }

    return null;
  }

  normalizeInboundWebhooks(body: unknown): NormalizedWhatsAppInbound[] {
    const root = (body as Record<string, unknown>) ?? {};
    const payload = (root.body as Record<string, unknown>) ?? root;
    if (payload.object !== 'whatsapp_business_account') {
      return [];
    }

    const normalized: NormalizedWhatsAppInbound[] = [];
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const rawEntry of entries) {
      const entry = rawEntry as Record<string, unknown>;
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const rawChange of changes) {
        const change = rawChange as Record<string, unknown>;
        const value = change?.value as Record<string, unknown> | undefined;
        const messages = Array.isArray(value?.messages) ? value.messages : [];
        for (const message of messages) {
          const item = this.normalizeInboundWebhook({
            object: payload.object,
            entry: [{ ...entry, changes: [{ ...change, value: { ...value, messages: [message] } }] }],
          });
          if (item) normalized.push(item);
        }
      }
    }
    return normalized;
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

  async sendMedia(
    channel: WhatsappChannel,
    toPhone: string,
    media: WhatsappOutboundMedia,
  ): Promise<void> {
    const token = channel.meta_access_token?.trim() ?? '';
    const phoneNumberId = channel.meta_phone_number_id?.trim() ?? '';
    const phone = toPhone.replace(/\D/g, '');
    if (!token || !phoneNumberId || !phone || !media.buffer?.length) {
      throw new Error(
        'Meta sendMedia missing token, phone number id, phone, or media buffer.',
      );
    }

    const mediaId = await this.uploadMedia(token, phoneNumberId, media);
    const caption = media.caption?.trim() || undefined;
    const type = media.mediaType;
    const payloadBody: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type,
    };

    if (type === 'image') {
      payloadBody.image = { id: mediaId, ...(caption ? { caption } : {}) };
    } else if (type === 'document') {
      payloadBody.document = {
        id: mediaId,
        filename: media.fileName || 'file',
        ...(caption ? { caption } : {}),
      };
    } else if (type === 'audio') {
      payloadBody.audio = { id: mediaId };
    } else if (type === 'video') {
      payloadBody.video = { id: mediaId, ...(caption ? { caption } : {}) };
    } else {
      throw new Error(`Meta sendMedia unsupported media type: ${type}`);
    }

    const res = await fetch(
      `https://graph.facebook.com/${this.graphVersion()}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payloadBody),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(this.formatMetaError('send', res.status, body));
    }
  }

  private normalizeMimeType(media: WhatsappOutboundMedia): string {
    const mime = (media.mimetype || '').trim().toLowerCase();
    if (mime && mime !== 'application/octet-stream') {
      return mime;
    }
    const name = (media.fileName || '').toLowerCase();
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.gif')) return 'image/gif';
    if (name.endsWith('.pdf')) return 'application/pdf';
    if (media.mediaType === 'image') return 'image/jpeg';
    if (media.mediaType === 'video') return 'video/mp4';
    if (media.mediaType === 'audio') return 'audio/mpeg';
    return 'application/octet-stream';
  }

  private formatMetaError(kind: string, status: number, body: string): string {
    try {
      const json = JSON.parse(body) as {
        error?: { message?: string; code?: number; error_data?: { details?: string } };
      };
      const err = json?.error;
      if (err?.message) {
        const details = err.error_data?.details
          ? ` ${err.error_data.details}`
          : '';
        const code = err.code != null ? ` (#${err.code})` : '';
        return `WhatsApp ${kind} failed${code}: ${err.message}${details}`;
      }
    } catch {
      // fall through
    }
    return `WhatsApp ${kind} failed (${status}): ${body.slice(0, 400)}`;
  }

  private async uploadMedia(
    token: string,
    phoneNumberId: string,
    media: WhatsappOutboundMedia,
  ): Promise<string> {
    const mimetype = this.normalizeMimeType(media);
    const fileName = (media.fileName || 'upload.bin')
      .replace(/[^\w.\-()+ ]+/g, '_')
      .trim() || 'upload.bin';
    const buffer = Buffer.isBuffer(media.buffer)
      ? media.buffer
      : Buffer.from(media.buffer);

    // Build multipart manually — Node FormData/Blob uploads are unreliable with Meta.
    const boundary = `----BhsMediaBoundary${Date.now().toString(16)}`;
    const parts: Buffer[] = [];
    const pushText = (value: string) => parts.push(Buffer.from(value, 'utf8'));

    pushText(
      `--${boundary}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n`,
    );
    pushText(
      `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${mimetype}\r\n`,
    );
    pushText(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimetype}\r\n\r\n`,
    );
    parts.push(buffer);
    pushText(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat(parts);

    const res = await fetch(
      `https://graph.facebook.com/${this.graphVersion()}/${phoneNumberId}/media`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      },
    );
    if (!res.ok) {
      const responseBody = await res.text();
      throw new Error(this.formatMetaError('media upload', res.status, responseBody));
    }
    const json = (await res.json()) as { id?: string };
    const mediaId = String(json.id ?? '').trim();
    if (!mediaId) {
      throw new Error('Meta media upload returned no media id.');
    }
    return mediaId;
  }
}
