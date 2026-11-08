import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Settings → Inbox privacy: some shops do not want the text of their WhatsApp / Messenger / Instagram chats shown in
 * another system. With the switch on, the inbox still lists the chat (name, time, labels, notes, orders, bot on/off) and
 * the AI bot still reads and answers - only the message text, photos and voice notes are not sent to the browser.
 * Default: everything is shown.
 */
export type PrivacyChannel = 'whatsapp' | 'messenger' | 'instagram';
export type MessagePrivacy = Record<PrivacyChannel, boolean>;

export const PRIVACY_CHANNELS: PrivacyChannel[] = ['whatsapp', 'messenger', 'instagram'];
export const NO_PRIVACY: MessagePrivacy = { whatsapp: false, messenger: false, instagram: false };

/** What the inbox shows instead of the text. */
export const HIDDEN_PREVIEW = '🔒 Message hidden';

const channelOf = (platform: unknown): PrivacyChannel | null => {
  const value = String(platform ?? '').toLowerCase();
  return (PRIVACY_CHANNELS as string[]).includes(value) ? (value as PrivacyChannel) : null;
};

export function isHidden(privacy: MessagePrivacy, platform: unknown): boolean {
  const channel = channelOf(platform);
  return channel ? privacy[channel] === true : false;
}

export function anyHidden(privacy: MessagePrivacy): boolean {
  return PRIVACY_CHANNELS.some((channel) => privacy[channel]);
}

/** One message of an open chat: keeps who / when / ticks / type, drops what was said. */
export function maskMessage<T extends Record<string, any>>(message: T): T {
  return {
    ...message,
    content: '',
    transcript: null,
    media_url: null,
    reply_to_text: message.reply_to_text ? '' : message.reply_to_text ?? null,
    media_note: null,
    hidden: true,
  };
}

/** The open chat (GET conversations/:id and the Evolution thread). */
export function maskThread<T extends { messages?: Array<Record<string, any>> }>(result: T, privacy: MessagePrivacy, platform: unknown): T {
  if (!result || !isHidden(privacy, platform) || !Array.isArray(result.messages)) return result;
  return { ...result, messages: result.messages.map((message) => maskMessage(message)), messages_hidden: true };
}

const rowPlatform = (row: Record<string, any>): unknown =>
  row?.channelUser?.platform ?? row?.channel_user?.platform ?? row?.contact?.platform ?? row?.platform ?? null;

/** Inbox list rows (company / agent inbox, contacts): no last-message text for a hidden channel. */
export function maskRows<T>(rows: T, privacy: MessagePrivacy): T {
  if (!anyHidden(privacy)) return rows;
  const maskOne = (row: Record<string, any>) =>
    isHidden(privacy, rowPlatform(row))
      ? { ...row, last_message_preview: row.last_message_preview ? HIDDEN_PREVIEW : row.last_message_preview ?? null, message_hidden: true }
      : row;
  if (Array.isArray(rows)) return rows.map((row) => maskOne(row)) as T;
  const box = rows as unknown as Record<string, any>;
  for (const key of ['rows', 'items', 'data', 'conversations']) {
    if (Array.isArray(box?.[key])) return { ...box, [key]: box[key].map((row: Record<string, any>) => maskOne(row)) } as T;
  }
  return rows;
}

@Injectable()
export class MessagePrivacyService {
  private readonly cache = new Map<number, { at: number; value: MessagePrivacy }>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async get(companyId: number): Promise<MessagePrivacy> {
    const id = Number(companyId);
    if (!id) return { ...NO_PRIVACY };
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const [row] = (await this.dataSource
      .query(`SELECT hide_whatsapp, hide_messenger, hide_instagram FROM company_message_privacy WHERE company_id = $1`, [id])
      .catch(() => [])) as Array<{ hide_whatsapp: boolean; hide_messenger: boolean; hide_instagram: boolean }>;
    const value: MessagePrivacy = {
      whatsapp: row?.hide_whatsapp === true,
      messenger: row?.hide_messenger === true,
      instagram: row?.hide_instagram === true,
    };
    this.cache.set(id, { at: Date.now(), value });
    return value;
  }

  /** True when the text of this chat must not be shown (its channel is hidden for the company). */
  async conversationHidden(companyId: number, conversationId: number): Promise<boolean> {
    const privacy = await this.get(companyId);
    if (!anyHidden(privacy)) return false;
    const [row] = (await this.dataSource
      .query(
        `SELECT cu.platform FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
          WHERE c.id = $1 AND CAST(cu.company_id AS BIGINT) = $2`,
        [Number(conversationId), Number(companyId)],
      )
      .catch(() => [])) as Array<{ platform: string }>;
    return isHidden(privacy, row?.platform);
  }

  async set(companyId: number, patch: Partial<MessagePrivacy>): Promise<MessagePrivacy> {
    const next = { ...(await this.get(companyId)) };
    for (const channel of PRIVACY_CHANNELS) if (typeof patch[channel] === 'boolean') next[channel] = patch[channel] as boolean;
    await this.dataSource.query(
      `INSERT INTO company_message_privacy (company_id, hide_whatsapp, hide_messenger, hide_instagram, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (company_id) DO UPDATE SET hide_whatsapp = $2, hide_messenger = $3, hide_instagram = $4, updated_at = NOW()`,
      [Number(companyId), next.whatsapp, next.messenger, next.instagram],
    );
    this.cache.set(Number(companyId), { at: Date.now(), value: next });
    return next;
  }
}
