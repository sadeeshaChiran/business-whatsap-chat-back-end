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
  voice_url?: string;
};

export interface WhatsappServiceInterface {
  readonly provider: WhatsappProviderType;

  normalizeInboundWebhook(body: unknown): NormalizedWhatsAppInbound | null;

  sendText(
    channel: WhatsappChannel,
    toPhone: string,
    text: string,
  ): Promise<void>;
}
