import type { DataSource, EntityManager } from 'typeorm';

/**
 * Quoted replies ("reply to this message" in WhatsApp / Messenger).
 * The inbound webhook only gives the id of the quoted message; we look it up in the same chat
 * and keep a short copy of its text so the inbox can show it and the AI knows what "this one" means.
 */

export type QuotedRef = { providerId: string | null; text: string | null };

const clip = (value: string | null | undefined, max = 500) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : null;
};

/** WhatsApp Cloud API message → quoted message id (message.context.id). */
export function quotedFromMetaMessage(raw: { context?: { id?: string } } | null | undefined): QuotedRef | null {
  const id = String(raw?.context?.id ?? '').trim();
  return id ? { providerId: id, text: null } : null;
}

type EvolutionContext = { stanzaId?: string; quotedMessage?: Record<string, any> };

function quotedText(message: Record<string, any> | undefined): string | null {
  if (!message) return null;
  return clip(message.conversation ?? message.extendedTextMessage?.text ?? message.imageMessage?.caption
    ?? message.videoMessage?.caption ?? (message.imageMessage ? '[photo]' : message.audioMessage ? '[voice note]' : message.documentMessage ? '[document]' : null));
}

/** Evolution (QR WhatsApp) webhook → quoted message of the message with this id. */
export function quotedFromEvolutionBody(body: unknown, messageId: string | null | undefined): QuotedRef | null {
  const root = body as { data?: unknown } | null;
  const items = Array.isArray(root?.data) ? root?.data : root?.data ? [root.data] : [];
  for (const item of items as Array<Record<string, any>>) {
    if (messageId && String(item?.key?.id ?? '') !== String(messageId)) continue;
    const message = (item?.message ?? {}) as Record<string, any>;
    let context: EvolutionContext | undefined = item?.contextInfo;
    if (!context?.stanzaId) {
      for (const part of Object.values(message)) {
        if (part && typeof part === 'object' && (part as { contextInfo?: EvolutionContext }).contextInfo?.stanzaId) {
          context = (part as { contextInfo: EvolutionContext }).contextInfo;
          break;
        }
      }
    }
    if (context?.stanzaId) return { providerId: String(context.stanzaId), text: quotedText(context.quotedMessage) };
  }
  return null;
}

/** Messenger / Instagram: message.reply_to.mid */
export function quotedFromMessengerMessage(message: { reply_to?: { mid?: string } } | null | undefined): QuotedRef | null {
  const id = String(message?.reply_to?.mid ?? '').trim();
  return id ? { providerId: id, text: null } : null;
}

type QuoteTarget = { id: number | string; content: string | null; message_type: string | null; media_note: string | null };

/** The short text of a quoted message; a photo says what it is (the product the bot sent, or what the customer's photo matched). */
function quoteText(target: QuoteTarget | undefined, fallback: string | null): string | null {
  if (target?.message_type === 'image') {
    const raw = clip(target.content);
    const caption = raw && !/^\[[^\]]*\]$/.test(raw) ? raw : null;
    if (!target.media_note) return caption ?? fallback ?? '[photo]';
    return `[photo: ${target.media_note}]${caption ? ` ${caption}` : ''}`;
  }
  return clip(target?.content) ?? fallback;
}

/** Stores the quote on the saved message (found by its provider id in this chat). */
export async function linkQuotedReply(db: DataSource | EntityManager, conversationId: number, providerMessageId: string, quoted: QuotedRef) {
  if (!quoted.providerId || !providerMessageId) return;
  const [target] = await db.query(
    `SELECT id, content, message_type, media_note FROM bot_message
      WHERE conversation_id = $1 AND (provider_message_id = $2 OR provider_message_id LIKE $2 || ':%') ORDER BY id LIMIT 1`,
    [conversationId, quoted.providerId]) as QuoteTarget[];
  await db.query(
    `UPDATE bot_message SET reply_to_message_id = $3, reply_to_provider_id = $4, reply_to_text = $5
      WHERE conversation_id = $1 AND provider_message_id = $2`,
    [conversationId, providerMessageId, target ? Number(target.id) : null, quoted.providerId, quoteText(target, quoted.text)]);
}

/** Same, when we already know the quoted message (simulator, own tools). */
export async function linkQuotedReplyById(db: DataSource | EntityManager, conversationId: number, providerMessageId: string, targetId: number) {
  const [target] = await db.query(
    `SELECT id, content, message_type, media_note, provider_message_id FROM bot_message WHERE conversation_id = $1 AND id = $2`,
    [conversationId, targetId]) as Array<QuoteTarget & { provider_message_id: string | null }>;
  if (!target) return;
  await db.query(
    `UPDATE bot_message SET reply_to_message_id = $3, reply_to_provider_id = $4, reply_to_text = $5
      WHERE conversation_id = $1 AND provider_message_id = $2`,
    [conversationId, providerMessageId, Number(target.id), target.provider_message_id, quoteText(target, null)]);
}

/** How a quoted message is shown to the AI: [replying to: "…"] text */
export function withQuote(row: { reply_to_text?: string | null }, content: string): string {
  const quote = clip(row.reply_to_text, 400);
  return quote ? `[replying to: "${quote}"] ${content}` : content;
}
