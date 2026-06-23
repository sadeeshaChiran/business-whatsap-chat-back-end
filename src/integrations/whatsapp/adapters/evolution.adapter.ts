import { Injectable } from '@nestjs/common';
import type { WhatsappChannel } from '../../../whatsapp/entities/whatsapp-channel.entity';
import type {
  NormalizedWhatsAppInbound,
  WhatsappServiceInterface,
} from '../interfaces/whatsapp-service.interface';

@Injectable()
export class EvolutionAdapter implements WhatsappServiceInterface {
  readonly provider = 'evolution' as const;

  private baseUrl(channel?: WhatsappChannel | null): string {
    const fromChannel = channel?.evolution_api_base?.trim();
    const fromEnv = (
      process.env.EVOLUTION_API_BASE ??
      process.env.EVOLUTION_BASE_URL ??
      ''
    ).trim();
    return (fromChannel || fromEnv).replace(/\/+$/, '');
  }

  normalizeInboundWebhook(body: unknown): NormalizedWhatsAppInbound | null {
    const root = (body as Record<string, unknown>) ?? {};
    const payload = (root.body as Record<string, unknown>) ?? root;
    const data = (payload.data as Record<string, unknown>) ?? payload;
    const firstEnvelope =
      (data.messages as unknown[])?.[0] ??
      (payload.messages as unknown[])?.[0] ??
      ((data.data as Record<string, unknown>)?.messages as unknown[])?.[0];

    const envelope =
      firstEnvelope && typeof firstEnvelope === 'object'
        ? (firstEnvelope as Record<string, unknown>)
        : null;
    const key = (envelope?.key as Record<string, unknown>) ??
      (data.key as Record<string, unknown>) ??
      (payload.key as Record<string, unknown>) ??
      {};
    const rawMessage =
      (envelope?.message as Record<string, unknown>) ??
      (data.message as Record<string, unknown>) ??
      (payload.message as Record<string, unknown>) ??
      {};
    const messageContainer =
      (rawMessage.ephemeralMessage as Record<string, unknown>)?.message ??
      (rawMessage.viewOnceMessage as Record<string, unknown>)?.message ??
      (rawMessage.documentWithCaptionMessage as Record<string, unknown>)
        ?.message ??
      rawMessage;

    const messageType = String(
      envelope?.messageType ?? data.messageType ?? payload.messageType ?? '',
    ).toLowerCase();

    const instanceName = String(
      payload.instance ??
        data.instance ??
        envelope?.instance ??
        payload.session ??
        '',
    ).trim();
    const instanceId = String(
      envelope?.instanceId ??
        payload.instanceId ??
        data.instanceId ??
        key.instanceId ??
        '',
    ).trim();
    const instance = instanceName || instanceId;

    let remoteJid = String(
      key.remoteJid ??
        envelope?.remoteJid ??
        data.remoteJid ??
        payload.remoteJid ??
        payload.sender ??
        payload.from ??
        '',
    ).trim();

    const fromMe = Boolean(
      key.fromMe ?? envelope?.fromMe ?? data.fromMe ?? payload.fromMe ?? false,
    );

    let phone = remoteJid.replace(/@.*$/, '').replace(/\D/g, '');
    if (!phone) {
      phone = String(payload.phone ?? data.phone ?? '').replace(/\D/g, '');
    }
    if (!remoteJid && phone) {
      remoteJid = `${phone}@s.whatsapp.net`;
    }

    const audioMessage =
      (messageContainer as Record<string, unknown>).audioMessage ??
      (messageContainer as Record<string, unknown>).pttMessage ??
      (messageContainer as Record<string, unknown>).voiceMessage;
    const imageMessage = (messageContainer as Record<string, unknown>)
      .imageMessage;

    const hasVoice = Boolean(
      audioMessage &&
        (messageType.includes('audio') ||
          messageType.includes('ptt') ||
          messageType.includes('voice')),
    );
    const hasImage = Boolean(
      imageMessage &&
        (messageType.includes('image') || Boolean(imageMessage)),
    );

    let message = this.extractText(messageContainer) || this.extractText(envelope);
    if (!message) {
      message = this.extractText(data) || this.extractText(payload);
    }
    if (hasVoice && !message) {
      message = '[voice note]';
    }
    if (hasImage && !message) {
      message = '[image]';
    }

    if (!phone && !message) {
      return null;
    }

    const messageId = String(
      key.id ?? envelope?.id ?? payload.messageId ?? payload.id ?? '',
    ).trim();

    return {
      provider: 'evolution',
      routing_key: instance,
      phone,
      remote_jid: remoteJid,
      message: message.trim(),
      message_id: messageId,
      from_me: fromMe,
      input_type: hasVoice ? 'voice' : hasImage ? 'image' : 'text',
      message_type: messageType || 'text',
      timestamp: Number(
        envelope?.messageTimestamp ??
          data.messageTimestamp ??
          payload.timestamp ??
          Math.floor(Date.now() / 1000),
      ),
      instance,
      has_image: hasImage,
      has_voice: hasVoice,
      image_url: imageMessage
        ? String(
            (imageMessage as Record<string, unknown>).url ??
              (imageMessage as Record<string, unknown>).directPath ??
              '',
          ).trim() || undefined
        : undefined,
      image_caption: imageMessage
        ? String((imageMessage as Record<string, unknown>).caption ?? '').trim() ||
          undefined
        : undefined,
      voice_url: audioMessage
        ? String(
            (audioMessage as Record<string, unknown>).url ??
              (audioMessage as Record<string, unknown>).directPath ??
              '',
          ).trim() || undefined
        : undefined,
    };
  }

  async sendText(
    channel: WhatsappChannel,
    toPhone: string,
    text: string,
  ): Promise<void> {
    const base = this.baseUrl(channel);
    const apiKey = channel.evaluation_whatsapp_key?.trim();
    const instance = channel.instance_name?.trim();
    const phone = toPhone.replace(/\D/g, '');
    if (!base || !apiKey || !instance || !phone || !text.trim()) {
      throw new Error('Evolution sendText missing base, api key, instance, phone, or text.');
    }

    const res = await fetch(
      `${base}/message/sendText/${encodeURIComponent(instance)}`,
      {
        method: 'POST',
        headers: {
          apikey: apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ number: phone, text: text.trim(), delay: 1200 }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Evolution sendText failed (${res.status}): ${body}`);
    }
  }

  private extractText(value: unknown, depth = 0): string {
    if (depth > 6 || value == null) {
      return '';
    }
    if (typeof value === 'string') {
      return value.trim();
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.extractText(item, depth + 1);
        if (found) {
          return found;
        }
      }
      return '';
    }
    if (typeof value !== 'object') {
      return '';
    }
    const record = value as Record<string, unknown>;
    for (const key of [
      'conversation',
      'text',
      'body',
      'caption',
      'contentText',
      'selectedDisplayText',
      'title',
    ]) {
      const direct = record[key];
      if (typeof direct === 'string' && direct.trim()) {
        return direct.trim();
      }
    }
    for (const key of [
      'extendedTextMessage',
      'imageMessage',
      'videoMessage',
      'buttonsResponseMessage',
      'templateButtonReplyMessage',
      'listResponseMessage',
      'documentWithCaptionMessage',
      'documentMessage',
      'message',
      'ephemeralMessage',
      'viewOnceMessage',
    ]) {
      const nested = this.extractText(record[key], depth + 1);
      if (nested) {
        return nested;
      }
    }
    return '';
  }
}
