import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetaPageConnection } from '../../meta/entities/meta-page-connection.entity';

export type SocialPlatform = 'messenger' | 'instagram';

/** 'facebook' is what some older rows call Messenger. Returns null for WhatsApp and anything else. */
export function socialPlatformOf(value: string | null | undefined): SocialPlatform | null {
  const platform = String(value ?? '').trim().toLowerCase();
  if (platform.includes('instagram')) return 'instagram';
  if (platform.includes('messenger') || platform.includes('facebook')) return 'messenger';
  return null;
}

/**
 * Sends replies on Facebook Messenger and Instagram DMs through the connected Page.
 * Used by the sales bot (agents' replies still go through BotAdminService as before).
 */
@Injectable()
export class MetaSocialSenderService {
  constructor(
    @InjectRepository(MetaPageConnection)
    private readonly connectionRepository: Repository<MetaPageConnection>,
  ) {}

  private async target(companyId: number, platform: SocialPlatform, accountId: string | null) {
    if (!accountId) throw new Error('this conversation is not linked to a Meta account');
    const connection = await this.connectionRepository.findOne({
      where: platform === 'instagram'
        ? { company_id: companyId, instagram_business_account_id: accountId, status: 'CONNECTED' }
        : { company_id: companyId, page_id: accountId, status: 'CONNECTED' },
      order: { updated_at: 'DESC' },
    });
    if (!connection?.page_access_token) throw new Error('no connected Meta Page for this conversation');
    const sendAccountId = platform === 'instagram' ? connection.instagram_business_account_id : connection.page_id;
    if (!sendAccountId) throw new Error('the Meta channel is not fully connected');
    return { token: connection.page_access_token, sendAccountId };
  }

  private version(): string {
    return process.env.META_GRAPH_API_VERSION?.trim() || 'v22.0';
  }

  private async parse(response: Response): Promise<string | null> {
    const result = (await response.json().catch(() => ({}))) as { message_id?: string; error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message || `Meta rejected the message (${response.status})`);
    return result.message_id ?? null;
  }

  private post(sendAccountId: string, token: string, body: BodyInit, json: boolean) {
    return fetch(`https://graph.facebook.com/${this.version()}/${encodeURIComponent(sendAccountId)}/messages`, {
      method: 'POST',
      headers: json ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { Authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  }

  async sendText(companyId: number, platform: SocialPlatform, accountId: string | null, recipientId: string, text: string): Promise<string | null> {
    const t = await this.target(companyId, platform, accountId);
    // Messenger and Instagram both reject text longer than 2000 characters
    const safe = text.length > 1900 ? `${text.slice(0, 1900)}…` : text;
    const body = JSON.stringify({ recipient: { id: recipientId }, message: { text: safe }, messaging_type: 'RESPONSE' });
    return this.parse(await this.post(t.sendAccountId, t.token, body, true));
  }

  /**
   * Messenger: uploads the picture itself (works even when the image link is not public).
   * Instagram cannot take uploads, so it gets the public image link.
   */
  async sendImage(companyId: number, platform: SocialPlatform, accountId: string | null, recipientId: string,
    image: { url: string; buffer?: Buffer; mimetype?: string; fileName?: string }): Promise<string | null> {
    const t = await this.target(companyId, platform, accountId);
    if (platform === 'messenger' && image.buffer) {
      const form = new FormData();
      form.append('recipient', JSON.stringify({ id: recipientId }));
      form.append('messaging_type', 'RESPONSE');
      form.append('message', JSON.stringify({ attachment: { type: 'image', payload: { is_reusable: true } } }));
      form.append('filedata', new Blob([new Uint8Array(image.buffer)], { type: image.mimetype || 'image/jpeg' }), image.fileName || 'photo.jpg');
      return this.parse(await this.post(t.sendAccountId, t.token, form, false));
    }
    const body = JSON.stringify({
      recipient: { id: recipientId },
      message: { attachment: { type: 'image', payload: { url: image.url } } },
      messaging_type: 'RESPONSE',
    });
    return this.parse(await this.post(t.sendAccountId, t.token, body, true));
  }

  /**
   * Messenger: uploads the file (e.g. an invoice PDF) as a file attachment.
   * Instagram cannot receive files – it gets the link as text (when a public link exists).
   */
  async sendFile(companyId: number, platform: SocialPlatform, accountId: string | null, recipientId: string,
    file: { buffer: Buffer; mimetype: string; fileName: string; url?: string | null; caption?: string }): Promise<string | null> {
    if (platform === 'instagram') {
      const text = [file.caption, file.url].filter(Boolean).join('\n');
      return text ? this.sendText(companyId, platform, accountId, recipientId, text) : null;
    }
    const t = await this.target(companyId, platform, accountId);
    const form = new FormData();
    form.append('recipient', JSON.stringify({ id: recipientId }));
    form.append('messaging_type', 'RESPONSE');
    form.append('message', JSON.stringify({ attachment: { type: 'file', payload: { is_reusable: false } } }));
    form.append('filedata', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.fileName);
    const id = this.parse(await this.post(t.sendAccountId, t.token, form, false));
    if (file.caption) await this.sendText(companyId, platform, accountId, recipientId, file.caption);
    return id;
  }
}
