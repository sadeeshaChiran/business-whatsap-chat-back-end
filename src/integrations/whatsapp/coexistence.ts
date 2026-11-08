import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PusherService } from '../../common/pusher.service';

/**
 * WhatsApp Coexistence: the shop keeps using its number in the WhatsApp Business app on the phone AND the Cloud API
 * (inbox + AI bot) at the same time. Meta sends three extra webhook fields for such a number:
 *   smb_message_echoes  – a message the owner sent from the phone app  → saved as an outbound message ("from phone"),
 *                         and the AI bot steps back in that chat (same as when the team replies from the inbox)
 *   history             – up to 6 months of past chats, once, right after connecting → saved (no bot, no routing)
 *   smb_app_state_sync  – the phone's contacts → the customer's name in the inbox (no new chats are made)
 * Needs: Meta app → WhatsApp → Configuration → webhook fields history, smb_app_state_sync, smb_message_echoes.
 */
export type CoexMessage = {
  id: string;
  /** customer phone (digits) */
  customer: string;
  direction: 'inbound' | 'outbound';
  type: 'text' | 'image' | 'voice' | 'system';
  content: string;
  mediaId: string | null;
  /** unix seconds */
  at: number;
};
export type CoexContact = { phone: string; name: string; action: 'add' | 'remove' };
export type CoexChange = { phoneNumberId: string; field: 'smb_message_echoes' | 'history' | 'smb_app_state_sync'; messages: CoexMessage[]; contacts: CoexContact[] };

export const COEX_FIELDS = ['smb_message_echoes', 'history', 'smb_app_state_sync'] as const;
/** Source of a message the owner sent from the WhatsApp Business app (inbox shows "Sent from phone"). */
export const PHONE_APP_SOURCE = 'phone-app';
/** Source of a past message imported with the history sync. */
export const HISTORY_SOURCE = 'history';

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');
const obj = (value: unknown): Record<string, any> => (value && typeof value === 'object' ? (value as Record<string, any>) : {});

/** One WhatsApp message object (Cloud API shape) → what we save. */
export function toCoexMessage(raw: Record<string, any>, customer: string, direction: 'inbound' | 'outbound'): CoexMessage | null {
  const id = String(raw?.id ?? '').trim();
  if (!id || !customer) return null;
  const type = String(raw?.type ?? 'text');
  const at = Number(raw?.timestamp ?? 0) || Math.floor(Date.now() / 1000);
  const base = { id, customer, direction, at };
  switch (type) {
    case 'text':
      return { ...base, type: 'text', content: String(raw?.text?.body ?? ''), mediaId: null };
    case 'image':
    case 'sticker':
      return { ...base, type: 'image', content: String(raw?.[type]?.caption ?? '') || '[image]', mediaId: raw?.[type]?.id ? String(raw[type].id) : null };
    case 'audio':
      return { ...base, type: 'voice', content: '[voice]', mediaId: raw?.audio?.id ? String(raw.audio.id) : null };
    case 'video':
      return { ...base, type: 'text', content: String(raw?.video?.caption ?? '') ? `[video] ${raw.video.caption}` : '[video]', mediaId: raw?.video?.id ? String(raw.video.id) : null };
    case 'document':
      return { ...base, type: 'text', content: `[document] ${raw?.document?.filename ?? ''}`.trim(), mediaId: raw?.document?.id ? String(raw.document.id) : null };
    case 'location':
      return { ...base, type: 'text', content: '[location]', mediaId: null };
    case 'contacts':
      return { ...base, type: 'text', content: '[contact]', mediaId: null };
    case 'reaction':
    case 'unsupported':
    case 'errors':
      return null;
    default:
      return { ...base, type: 'text', content: '[unsupported]', mediaId: null };
  }
}

/** Reads the coexistence fields of a WhatsApp webhook (no database – easy to test). */
export function parseCoexistence(body: unknown): CoexChange[] {
  const payload = obj(obj(body).body ?? body);
  if (payload.object !== 'whatsapp_business_account') return [];
  const out: CoexChange[] = [];
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const field = String(change?.field ?? '');
      if (!(COEX_FIELDS as readonly string[]).includes(field)) continue;
      const value = obj(change?.value);
      const phoneNumberId = String(value?.metadata?.phone_number_id ?? '').trim();
      const own = digits(value?.metadata?.display_phone_number);
      const item: CoexChange = { phoneNumberId, field: field as CoexChange['field'], messages: [], contacts: [] };
      if (field === 'smb_message_echoes') {
        for (const echo of Array.isArray(value.message_echoes) ? value.message_echoes : []) {
          const message = toCoexMessage(echo, digits(echo?.to), 'outbound');
          if (message) item.messages.push(message);
        }
      } else if (field === 'history') {
        for (const chunk of Array.isArray(value.history) ? value.history : []) {
          for (const thread of Array.isArray(chunk?.threads) ? chunk.threads : []) {
            const customer = digits(thread?.id);
            for (const raw of Array.isArray(thread?.messages) ? thread.messages : []) {
              const from = digits(raw?.from);
              const outbound = from ? from !== customer || (own !== '' && from === own) : false;
              const message = toCoexMessage(raw, customer, outbound ? 'outbound' : 'inbound');
              if (message) item.messages.push(message);
            }
          }
        }
      } else {
        for (const sync of Array.isArray(value.state_sync) ? value.state_sync : []) {
          if (sync?.type !== 'contact') continue;
          const phone = digits(sync?.contact?.phone_number);
          const name = String(sync?.contact?.full_name ?? sync?.contact?.first_name ?? '').trim();
          if (phone) item.contacts.push({ phone, name, action: sync?.action === 'remove' ? 'remove' : 'add' });
        }
      }
      out.push(item);
    }
  }
  return out;
}

@Injectable()
export class CoexistenceService {
  private readonly logger = new Logger(CoexistenceService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() private readonly pusher?: PusherService,
  ) {}

  /** Handles the coexistence fields of a webhook. null = the webhook had none (normal messages go on as before). */
  async handle(body: unknown): Promise<{ accepted: true; coexistence: Record<string, number> } | null> {
    const changes = parseCoexistence(body);
    if (!changes.length) return null;
    const counts: Record<string, number> = {};
    for (const change of changes) {
      const channel = await this.channelOf(change.phoneNumberId);
      if (!channel) {
        this.logger.warn(`coexistence ${change.field}: no WhatsApp number ${change.phoneNumberId}`);
        continue;
      }
      try {
        if (change.field === 'smb_app_state_sync') counts.contacts = (counts.contacts ?? 0) + (await this.saveContacts(channel.company_id, change.contacts));
        else counts[change.field] = (counts[change.field] ?? 0) + (await this.saveMessages(channel, change));
      } catch (error) {
        this.logger.warn(`coexistence ${change.field} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { accepted: true, coexistence: counts };
  }

  private async channelOf(phoneNumberId: string): Promise<{ id: number; company_id: number } | null> {
    if (!phoneNumberId) return null;
    const [row] = (await this.dataSource.query(
      `SELECT id, company_id FROM whatsapp_channels WHERE provider_type = 'meta' AND meta_phone_number_id = $1 ORDER BY id ASC LIMIT 1`,
      [phoneNumberId],
    )) as Array<{ id: number; company_id: number }>;
    return row ? { id: Number(row.id), company_id: Number(row.company_id) } : null;
  }

  /** The customer's chat (made when the owner writes first from the phone, like an inbound message would). */
  private async chatOf(companyId: number, channelId: number, phone: string): Promise<{ channelUserId: number; conversationId: number }> {
    let [user] = (await this.dataSource.query(
      `SELECT id FROM bot_channel_user WHERE company_id = $1 AND platform = 'whatsapp' AND external_user_id = $2 ORDER BY id ASC LIMIT 1`,
      [companyId, phone],
    )) as Array<{ id: number }>;
    if (!user) {
      [user] = (await this.dataSource.query(
        `INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name, bot_enabled, manual_mode, last_seen_at,
                                       whatsapp_channel_id, first_whatsapp_channel_id, created_at, updated_at)
         VALUES ($1, 'whatsapp', $2, $2, FALSE, FALSE, NOW(), $3, $3, NOW(), NOW()) RETURNING id`,
        [companyId, phone, channelId],
      )) as Array<{ id: number }>;
    }
    let [conversation] = (await this.dataSource.query(
      `SELECT id FROM bot_conversation WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 1`,
      [user.id],
    )) as Array<{ id: number }>;
    if (!conversation) {
      [conversation] = (await this.dataSource.query(
        `INSERT INTO bot_conversation (bot_channel_user_id, status, last_message_at, created_at, updated_at)
         VALUES ($1, 'open', NOW(), NOW(), NOW()) RETURNING id`,
        [user.id],
      )) as Array<{ id: number }>;
    }
    return { channelUserId: Number(user.id), conversationId: Number(conversation.id) };
  }

  private async saveMessages(channel: { id: number; company_id: number }, change: CoexChange): Promise<number> {
    const echo = change.field === 'smb_message_echoes';
    let saved = 0;
    const touched = new Map<number, number>();
    for (const message of change.messages) {
      const { channelUserId, conversationId } = await this.chatOf(channel.company_id, channel.id, message.customer);
      const rows = (await this.dataSource.query(
        `INSERT INTO bot_message (conversation_id, direction, message_type, platform, content, media_url, provider_message_id, source,
                                  delivery_status, whatsapp_channel_id, created_at)
         SELECT $1, $2, $3, 'whatsapp', $4, $5, $6, $7, $8, $9, (to_timestamp($10) AT TIME ZONE 'UTC')
          WHERE NOT EXISTS (SELECT 1 FROM bot_message WHERE platform = 'whatsapp' AND provider_message_id = $6)
         RETURNING id`,
        [conversationId, message.direction, message.type, message.content, message.mediaId ? `meta-media:${message.mediaId}` : null,
          message.id, echo ? PHONE_APP_SOURCE : message.direction === 'outbound' ? HISTORY_SOURCE : 'customer',
          message.direction === 'outbound' ? 'sent' : null, channel.id, message.at],
      )) as Array<{ id: number }>;
      if (!rows.length) continue;
      saved += 1;
      touched.set(conversationId, Math.max(touched.get(conversationId) ?? 0, message.at));
      if (echo) {
        // the owner answered from the phone: the AI bot steps back in this chat (same as a reply from the inbox)
        await this.dataSource.query(`UPDATE bot_channel_user SET manual_mode = TRUE, last_seen_at = NOW() WHERE id = $1`, [channelUserId]);
      }
    }
    for (const [conversationId, at] of touched) {
      await this.dataSource.query(
        `UPDATE bot_conversation SET last_message_at = GREATEST(COALESCE(last_message_at, 'epoch'::timestamp), (to_timestamp($2) AT TIME ZONE 'UTC')) WHERE id = $1`,
        [conversationId, at],
      );
      this.pusher?.trigger(`company-${channel.company_id}`, 'conversation_updated', { conversation_id: conversationId, inbound: false, message_saved: true, from_phone: echo });
    }
    return saved;
  }

  /** Names from the phone's contacts – only for customers already in the inbox, and only when we have no real name yet. */
  private async saveContacts(companyId: number, contacts: CoexContact[]): Promise<number> {
    let updated = 0;
    for (const contact of contacts) {
      if (contact.action !== 'add' || !contact.name) continue;
      const result = (await this.dataSource.query(
        `UPDATE bot_channel_user SET display_name = $3, updated_at = NOW()
          WHERE company_id = $1 AND platform = 'whatsapp' AND external_user_id = $2
            AND (COALESCE(display_name, '') = '' OR display_name = external_user_id)
          RETURNING id`,
        [companyId, contact.phone, contact.name.slice(0, 255)],
      )) as Array<{ id: number }>;
      updated += result.length;
    }
    return updated;
  }
}
