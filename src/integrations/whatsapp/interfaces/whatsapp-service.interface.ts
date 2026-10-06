import type { WhatsappChannel } from '../../../whatsapp/entities/whatsapp-channel.entity';

export type WhatsappProviderType = 'evolution' | 'meta';

export type NormalizedWhatsAppInbound = {
  provider: WhatsappProviderType;
  routing_key: string;
  phone: string;
  display_name?: string;
  remote_jid: string;
  message: string;
  message_id: string;
  from_me: boolean;
  input_type: 'text' | 'image' | 'voice' | 'system';
  message_type: string;
  timestamp: number;
  instance?: string;
  meta_phone_number_id?: string;
  has_image: boolean;
  has_voice: boolean;
  image_url?: string;
  image_caption?: string;
  meta_media_id?: string;
  voice_url?: string;
};

export type WhatsappOutboundMedia = {
  buffer: Buffer;
  mimetype: string;
  fileName: string;
  caption?: string;
  /** WhatsApp media kind — images are primary; documents/audio/video supported when provider allows. */
  mediaType: 'image' | 'document' | 'audio' | 'video';
};

export type WhatsappSendResult = { messageId: string | null };

/** Optional: show the message as a reply to an earlier one (WhatsApp quote). */
export type WhatsappTextOptions = { replyTo?: { providerId: string; text?: string | null } | null };

export interface WhatsappServiceInterface {
  readonly provider: WhatsappProviderType;

  normalizeInboundWebhook(body: unknown): NormalizedWhatsAppInbound | null;

  normalizeInboundWebhooks(body: unknown): NormalizedWhatsAppInbound[];

  sendText(
    channel: WhatsappChannel,
    toPhone: string,
    text: string,
    options?: WhatsappTextOptions,
  ): Promise<WhatsappSendResult>;

  sendMedia(
    channel: WhatsappChannel,
    toPhone: string,
    media: WhatsappOutboundMedia,
  ): Promise<WhatsappSendResult>;
}
