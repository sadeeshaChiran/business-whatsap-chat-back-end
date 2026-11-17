import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetaPageConnection } from '../../meta/entities/meta-page-connection.entity';
import { TiktokHook } from '../../common/tiktok-hook';
import { TelegramHook } from '../../common/telegram-hook';
import { AppChatHook } from '../../common/app-chat-hook';
import { metaSendError } from '../../common/meta-error';

export type SocialPlatform = 'messenger' | 'instagram' | 'tiktok' | 'telegram' | 'app';

/** 'facebook' is what some older rows call Messenger. Returns null for WhatsApp and anything else. */
export function socialPlatformOf(value: string | null | undefined): SocialPlatform | null {
  const platform = String(value ?? '').trim().toLowerCase();
  if (platform === 'tiktok') return 'tiktok';
  if (platform === 'telegram') return 'telegram';
  if (platform === 'app') return 'app';
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

  private async target(companyId: number, platform: Exclude<SocialPlatform, 'tiktok' | 'telegram' | 'app'>, accountId: string | null) {
    if (!accountId) throw new Error('this conversation is not linked to a Meta account');
    const connection = await this.connectionRepository.findOne({
      where: platform === 'instagram'
        ? { company_id: companyId, instagram_business_account_id: accountId, status: 'CONNECTED' }
        : { company_id: companyId, page_id: accountId, status: 'CONNECTED' },
      order: { updated_at: 'DESC' },
    });
    if (!connection?.page_access_token) throw new Error('no connected Meta Page for this conversation');
    if (platform === 'instagram' && !connection.instagram_business_account_id) throw new Error('the Meta channel is not fully connected');
    // Instagram with Facebook Login is sent through the Messenger Send API of the linked Page (POST /{page-id}/messages).
    // /{ig-user-id}/messages belongs to the "Instagram login" API and fails with "(#3) does not have the capability".
    return { token: connection.page_access_token, sendAccountId: connection.page_id };
  }

  private version(): string {
    return process.env.META_GRAPH_API_VERSION?.trim() || 'v22.0';
  }

  private async parse(response: Response): Promise<string | null> {
    const result = (await response.json().catch(() => ({}))) as { message_id?: string; error?: { message?: string } };
    if (!response.ok) throw new Error(metaSendError(result, response.status, `Meta rejected the message (${response.status})`, { via: 'bot' }));
    return result.message_id ?? null;
  }

  /** last send time and queue per Page + customer, so a burst of bubbles and photos is spaced out */
  private readonly lanes = new Map<string, { last: number; chain: Promise<unknown> }>();

  /**
   * Meta treats many messages to one person within a second or two as spam and then blocks the
   * app's sends on that Page for a while ("Application does not have permission for this action").
   * Every Messenger / Instagram send to the same customer waits its turn and keeps a small gap.
   */
  private paced<T>(sendAccountId: string, recipientId: string, send: () => Promise<T>): Promise<T> {
    const gap = Math.max(0, Number(process.env.META_SEND_GAP_MS ?? 1200) || 0);
    const key = `${sendAccountId}:${recipientId}`;
    const lane = this.lanes.get(key) ?? { last: 0, chain: Promise.resolve() };
    const run = lane.chain.catch(() => undefined).then(async () => {
      const wait = lane.last + gap - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      try { return await send(); } finally { lane.last = Date.now(); }
    });
    lane.chain = run;
    this.lanes.set(key, lane);
    // forget quiet lanes so the map does not grow
    void run.catch(() => undefined).then(() => {
      setTimeout(() => { if (this.lanes.get(key) === lane && lane.chain === run) this.lanes.delete(key); }, gap + 60_000).unref?.();
    });
    return run;
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
    // TikTok chats go to the TikTok channel (its own rules: 48-hour window, 10 messages in a row)
    if (platform === 'tiktok') return TiktokHook.sendText({ companyId, businessId: accountId, conversationId: recipientId }, text);
    // Telegram chats go to the customer's chat with the business's bot
    if (platform === 'telegram') return TelegramHook.sendText({ companyId, botId: accountId, chatId: recipientId }, text);
    // customer app: the caller saves the message, which is what the app shows
    if (platform === 'app') return AppChatHook.send(companyId, recipientId);
    const t = await this.target(companyId, platform, accountId);
    // Messenger and Instagram both reject text longer than 2000 characters
    const safe = text.length > 1900 ? `${text.slice(0, 1900)}…` : text;
    const body = JSON.stringify({ recipient: { id: recipientId }, message: { text: safe }, messaging_type: 'RESPONSE' });
    return this.paced(t.sendAccountId, recipientId, async () => this.parse(await this.post(t.sendAccountId, t.token, body, true)));
  }

  /**
   * Messenger: uploads the picture itself (works even when the image link is not public).
   * Instagram cannot take uploads, so it gets the public image link.
   */
  async sendImage(companyId: number, platform: SocialPlatform, accountId: string | null, recipientId: string,
    image: { url: string; buffer?: Buffer; mimetype?: string; fileName?: string }): Promise<string | null> {
    if (platform === 'tiktok') return TiktokHook.sendImage({ companyId, businessId: accountId, conversationId: recipientId }, image);
    if (platform === 'telegram') return TelegramHook.sendFile({ companyId, botId: accountId, chatId: recipientId }, image);
    if (platform === 'app') return AppChatHook.send(companyId, recipientId);
    const t = await this.target(companyId, platform, accountId);
    if (platform === 'messenger' && image.buffer) {
      const form = new FormData();
      form.append('recipient', JSON.stringify({ id: recipientId }));
      form.append('messaging_type', 'RESPONSE');
      form.append('message', JSON.stringify({ attachment: { type: 'image', payload: { is_reusable: true } } }));
      form.append('filedata', new Blob([new Uint8Array(image.buffer)], { type: image.mimetype || 'image/jpeg' }), image.fileName || 'photo.jpg');
      return this.paced(t.sendAccountId, recipientId, async () => this.parse(await this.post(t.sendAccountId, t.token, form, false)));
    }
    const body = JSON.stringify({
      recipient: { id: recipientId },
      message: { attachment: { type: 'image', payload: { url: image.url } } },
      messaging_type: 'RESPONSE',
    });
    return this.paced(t.sendAccountId, recipientId, async () => this.parse(await this.post(t.sendAccountId, t.token, body, true)));
  }

  /**
   * Messenger: uploads the file (e.g. an invoice PDF) as a file attachment.
   * Instagram cannot receive files – it gets the link as text (when a public link exists).
   */
  async sendFile(companyId: number, platform: SocialPlatform, accountId: string | null, recipientId: string,
    file: { buffer: Buffer; mimetype: string; fileName: string; url?: string | null; caption?: string }): Promise<string | null> {
    // Telegram takes real files (e.g. the invoice PDF) with the caption
    if (platform === 'telegram') return TelegramHook.sendFile({ companyId, botId: accountId, chatId: recipientId }, file);
    // customer app: callers save the file message themselves (BotAdminService.sendCustomerFile does)
    if (platform === 'app') return AppChatHook.send(companyId, recipientId);
    if (platform === 'instagram' || platform === 'tiktok') {
      // Instagram and TikTok cannot receive files – the link goes as text
      const text = [file.caption, file.url].filter(Boolean).join('\n');
      return text ? this.sendText(companyId, platform, accountId, recipientId, text) : null;
    }
    const t = await this.target(companyId, platform, accountId);
    const form = new FormData();
    form.append('recipient', JSON.stringify({ id: recipientId }));
    form.append('messaging_type', 'RESPONSE');
    form.append('message', JSON.stringify({ attachment: { type: 'file', payload: { is_reusable: false } } }));
    form.append('filedata', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.fileName);
    const id = await this.paced(t.sendAccountId, recipientId, async () => this.parse(await this.post(t.sendAccountId, t.token, form, false)));
    if (file.caption) await this.sendText(companyId, platform, accountId, recipientId, file.caption);
    return id;
  }
}
