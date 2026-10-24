import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PusherService } from '../common/pusher.service';
import { isTestPhone } from '../common/test-phone';
import { graphRequest } from '../marketing/graph';
import { WhatsappService } from '../integrations/whatsapp/whatsapp.service';

export type Platform = 'whatsapp' | 'messenger' | 'instagram';
export type Target = {
  companyId: number;
  conversationId: number;
  channelUserId: number;
  platform: Platform;
  recipient: string;
  sourceAccountId: string | null;
  name: string;
};
export type Outgoing =
  | { kind: 'text'; text: string }
  | { kind: 'image' | 'video'; url: string; caption?: string }
  | { kind: 'buttons'; text: string; buttons: string[] };

/** Sends flow messages on the customer's own channel and saves them in the chat (so the inbox shows them). */
@Injectable()
export class FlowSenderService {
  private readonly logger = new Logger(FlowSenderService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly whatsappService: WhatsappService,
    private readonly pusherService: PusherService,
  ) {}

  async target(conversationId: number): Promise<Target | null> {
    const [row] = await this.dataSource.query(`
      SELECT c.id AS conversation_id, cu.id AS channel_user_id, cu.company_id, cu.platform, cu.external_user_id, cu.source_account_id, cu.display_name
        FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id WHERE c.id = $1`, [conversationId]);
    if (!row) return null;
    const platform = String(row.platform).toLowerCase();
    return {
      companyId: Number(row.company_id), conversationId: Number(row.conversation_id), channelUserId: Number(row.channel_user_id),
      platform: platform === 'messenger' || platform === 'facebook' ? 'messenger' : platform === 'instagram' ? 'instagram' : 'whatsapp',
      recipient: String(row.external_user_id), sourceAccountId: row.source_account_id ?? null, name: row.display_name || '',
    };
  }

  async send(target: Target, message: Outgoing, source: string): Promise<void> {
    let providerId: string | null = null;
    if (target.platform === 'whatsapp') providerId = await this.sendWhatsapp(target, message);
    else providerId = await this.sendMeta(target, message);
    await this.save(target, message, source, providerId);
  }

  /* ─────────── WhatsApp ─────────── */

  private async sendWhatsapp(target: Target, message: Outgoing): Promise<string | null> {
    if (isTestPhone(target.recipient)) return null; // customer simulator
    // the number this customer wrote to (several numbers per company), else the main number
    const [channel] = await this.dataSource.query(
      `SELECT w.provider_type, w.meta_phone_number_id, w.meta_access_token FROM whatsapp_channels w
        WHERE w.company_id = $1
        ORDER BY (w.id = (SELECT cu.whatsapp_channel_id FROM bot_channel_user cu WHERE cu.company_id = $1 AND cu.platform = 'whatsapp'
                          AND cu.external_user_id = $2 LIMIT 1)) DESC NULLS LAST,
                 w.is_primary DESC, w.id DESC
        LIMIT 1`, [target.companyId, String(target.recipient ?? '').replace(/\D/g, '')]);
    const cloud = channel?.provider_type === 'meta' && channel.meta_phone_number_id && channel.meta_access_token;
    if (!cloud) {
      // Evolution / other providers: plain text (buttons become numbered options), media downloaded and sent as a file
      if (message.kind === 'text') return (await this.whatsappService.sendText(target.companyId, target.recipient, message.text))?.messageId ?? null;
      if (message.kind === 'buttons') return (await this.whatsappService.sendText(target.companyId, target.recipient, numbered(message.text, message.buttons)))?.messageId ?? null;
      const res = await fetch(message.url, { signal: AbortSignal.timeout(30_000) });
      const buffer = Buffer.from(await res.arrayBuffer());
      const mimetype = (res.headers.get('content-type') ?? (message.kind === 'image' ? 'image/jpeg' : 'video/mp4')).split(';')[0];
      return (await this.whatsappService.sendMedia(target.companyId, target.recipient, {
        buffer, mimetype, fileName: message.kind === 'image' ? 'image.jpg' : 'video.mp4', caption: message.caption, mediaType: message.kind,
      }))?.messageId ?? null;
    }
    const to = target.recipient.replace(/\D/g, '');
    let body: Record<string, unknown>;
    if (message.kind === 'text') body = { type: 'text', text: { body: message.text.slice(0, 4096), preview_url: true } };
    else if (message.kind === 'image') body = { type: 'image', image: { link: message.url, ...(message.caption ? { caption: message.caption.slice(0, 1024) } : {}) } };
    else if (message.kind === 'video') body = { type: 'video', video: { link: message.url, ...(message.caption ? { caption: message.caption.slice(0, 1024) } : {}) } };
    else {
      const m = message as Extract<Outgoing, { kind: 'buttons' }>;
      body = m.buttons.length <= 3
        ? { type: 'interactive', interactive: { type: 'button', body: { text: m.text.slice(0, 1024) || '…' },
          action: { buttons: m.buttons.map((title, i) => ({ type: 'reply', reply: { id: `b${i}`, title: title.slice(0, 20) } })) } } }
        : { type: 'interactive', interactive: { type: 'list', body: { text: m.text.slice(0, 1024) || '…' },
          action: { button: 'Choose', sections: [{ title: 'Options', rows: m.buttons.slice(0, 10).map((title, i) => ({ id: `b${i}`, title: title.slice(0, 24) })) }] } } };
    }
    const sent = await graphRequest<{ messages?: Array<{ id: string }> }>('POST', `/${channel.meta_phone_number_id}/messages`, channel.meta_access_token,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...body });
    return sent.messages?.[0]?.id ?? null;
  }

  /* ─────────── Messenger / Instagram (both through the linked Page) ─────────── */

  private async sendMeta(target: Target, message: Outgoing): Promise<string | null> {
    const [page] = await this.dataSource.query(`
      SELECT page_id, page_access_token FROM meta_page_connections
       WHERE company_id = $1 AND status = 'CONNECTED' ${target.platform === 'instagram' ? 'AND instagram_business_account_id IS NOT NULL' : ''}
       ORDER BY updated_at DESC LIMIT 1`, [target.companyId]);
    if (!page?.page_access_token) throw new Error('no connected Facebook Page');
    let payload: Record<string, unknown>;
    if (message.kind === 'text') payload = { text: message.text.slice(0, 1900) };
    else if (message.kind === 'buttons') {
      payload = { text: message.text.slice(0, 1000) || '…', quick_replies: message.buttons.slice(0, 13).map((title, i) => ({ content_type: 'text', title: title.slice(0, 20), payload: `b${i}` })) };
    } else payload = { attachment: { type: message.kind, payload: { url: message.url, is_reusable: true } } };
    const sent = await graphRequest<{ message_id?: string }>('POST', `/${page.page_id}/messages`, page.page_access_token,
      { recipient: { id: target.recipient }, message: payload, messaging_type: 'RESPONSE' });
    // captions are a separate message on Messenger / Instagram
    if ((message.kind === 'image' || message.kind === 'video') && message.caption) {
      await graphRequest('POST', `/${page.page_id}/messages`, page.page_access_token,
        { recipient: { id: target.recipient }, message: { text: message.caption.slice(0, 1900) }, messaging_type: 'RESPONSE' });
    }
    return sent.message_id ?? null;
  }

  /* ─────────── chat history ─────────── */

  private async save(target: Target, message: Outgoing, source: string, providerId: string | null) {
    const content = message.kind === 'text' ? message.text
      : message.kind === 'buttons' ? `${message.text}\n${message.buttons.map((b) => `▸ ${b}`).join('\n')}`
        : message.caption || (message.kind === 'image' ? '[image]' : '[video]');
    await this.dataSource.query(`
      INSERT INTO bot_message (conversation_id, direction, message_type, platform, provider_message_id, delivery_status, content, media_url, source, created_at)
      VALUES ($1, 'outbound', $2, $3, $4, 'sent', $5, $6, $7, NOW())`,
      [target.conversationId, message.kind === 'image' ? 'image' : 'text', target.platform, providerId, content,
        message.kind === 'image' || message.kind === 'video' ? message.url : null, source]);
    await this.dataSource.query(`UPDATE bot_conversation SET last_message_at = NOW() WHERE id = $1`, [target.conversationId]);
    this.pusherService.trigger(`company-${target.companyId}`, 'conversation_updated', { conversation_id: target.conversationId, inbound: false });
  }
}

/** "Choose: 1. Red 2. Blue" for channels without buttons. */
export function numbered(text: string, buttons: string[]) {
  return `${text}\n\n${buttons.map((b, i) => `${i + 1}. ${b}`).join('\n')}\n\nReply with the number.`;
}
