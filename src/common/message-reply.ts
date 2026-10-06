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

/** Stores the quote on the saved message (found by its provider id in this chat). */
export async function linkQuotedReply(db: DataSource | EntityManager, conversationId: number, providerMessageId: string, quoted: QuotedRef) {
  if (!quoted.providerId || !providerMessageId) return;
  const [target] = await db.query(
    `SELECT id, content, message_type FROM bot_message
      WHERE conversation_id = $1 AND (provider_message_id = $2 OR provider_message_id LIKE $2 || ':%') ORDER BY id LIMIT 1`,
    [conversationId, quoted.providerId]);
  const text = clip(target?.content) ?? quoted.text ?? (target?.message_type === 'image' ? '[photo]' : null);
  await db.query(
    `UPDATE bot_message SET reply_to_message_id = $3, reply_to_provider_id = $4, reply_to_text = $5
      WHERE conversation_id = $1 AND provider_message_id = $2`,
    [conversationId, providerMessageId, target ? Number(target.id) : null, quoted.providerId, text]);
}

/** How a quoted message is shown to the AI: [replying to: "…"] text */
export function withQuote(row: { reply_to_text?: string | null }, content: string): string {
  const quote = clip(row.reply_to_text, 400);
  return quote ? `[replying to: "${quote}"] ${content}` : content;
}
