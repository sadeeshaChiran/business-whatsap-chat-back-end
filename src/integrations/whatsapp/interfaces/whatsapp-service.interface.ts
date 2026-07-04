import type { WhatsappChannel } from '../../../whatsapp/entities/whatsapp-channel.entity';

export type WhatsappProviderType = 'evolution' | 'meta';

export type NormalizedWhatsAppInbound = {
  provider: WhatsappProviderType;
  routing_key: string;
  phone: string;
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

export interface WhatsappServiceInterface {
  readonly provider: WhatsappProviderType;

  normalizeInboundWebhook(body: unknown): NormalizedWhatsAppInbound | null;

  sendText(
    channel: WhatsappChannel,
    toPhone: string,
    text: string,
  ): Promise<void>;

  sendMedia(
    channel: WhatsappChannel,
    toPhone: string,
    media: WhatsappOutboundMedia,
  ): Promise<void>;
}
