/**
 * Turns one WhatsApp Cloud API message (from the raw webhook body) into a
 * bot_message row the inbox can display properly.
 *
 * Why: the adapter only keeps a short text like "[location]" or "[document]".
 * The raw webhook still has everything (map point, contact, file name, media id),
 * so we read it from there.
 *
 * Content formats (the inbox turns these into cards):
 *   location → "📍 Name\nAddress\nhttps://maps.google.com/?q=lat,lng"
 *   contact  → "Contact: Name\nPhone: +94…"
 *   document → "<file name>"          + media_url "meta-media:<id>"
 *   video    → "[video]\n<caption>"   + media_url "meta-media:<id>"
 *   audio    → "[audio]"              + media_url "meta-media:<id>"   (message_type voice)
 */

export type InboundRow = {
  content: string;
  message_type: 'text' | 'image' | 'voice' | 'system';
  media_url: string | null;
};

/** `skip` = don't save a chat message (e.g. reactions). */
export type InboundResult = InboundRow | { skip: string };

type MetaMedia = { id?: string; caption?: string; filename?: string; mime_type?: string; voice?: boolean };
type MetaMessage = {
  id?: string;
  type?: string;
  text?: { body?: string };
  image?: MetaMedia;
  video?: MetaMedia;
  audio?: MetaMedia;
  voice?: MetaMedia;
  document?: MetaMedia;
  sticker?: MetaMedia;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string; url?: string };
  contacts?: Array<{
    name?: { formatted_name?: string; first_name?: string; last_name?: string };
    phones?: Array<{ phone?: string; wa_id?: string }>;
    org?: { company?: string };
  }>;
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
    nfm_reply?: { name?: string; body?: string; response_json?: string };
  };
  button?: { text?: string; payload?: string };
  reaction?: { emoji?: string; message_id?: string };
  order?: { product_items?: Array<{ product_retailer_id?: string; quantity?: number; item_price?: number; currency?: string }>; text?: string };
  referral?: { headline?: string; body?: string; source_url?: string };
  system?: { body?: string };
  errors?: Array<{ title?: string; message?: string }>;
};

const mediaKey = (media?: MetaMedia) => (media?.id?.trim() ? `meta-media:${media.id.trim()}` : null);

/** Find the raw message in a Meta webhook body by its wamid (or the only message present). */
export function findMetaRawMessage(body: unknown, messageId?: string | null): MetaMessage | null {
  const all: MetaMessage[] = [];
  const entries = (body as { entry?: Array<{ changes?: Array<{ value?: { messages?: MetaMessage[] } }> }> })?.entry;
  for (const entry of entries ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) all.push(message);
    }
  }
  if (!all.length) return null;
  const id = messageId?.trim();
  if (id) {
    const match = all.find((message) => message.id === id);
    if (match) return match;
  }
  return all.length === 1 ? all[0] : null;
}

export function contentFromMetaMessage(message: MetaMessage): InboundResult {
  const type = String(message.type ?? '').toLowerCase();

  switch (type) {
    case 'text':
      return { content: message.text?.body?.trim() || '', message_type: 'text', media_url: null };

    case 'image':
      return { content: message.image?.caption?.trim() || '[image]', message_type: 'image', media_url: mediaKey(message.image) };

    case 'sticker':
      // shown as a picture (WebP)
      return { content: '[sticker]', message_type: 'image', media_url: mediaKey(message.sticker) };

    case 'audio':
    case 'voice': {
      const media = message.audio ?? message.voice;
      return { content: '[audio]', message_type: 'voice', media_url: mediaKey(media) };
    }

    case 'video': {
      const caption = message.video?.caption?.trim();
      return { content: caption ? `[video]\n${caption}` : '[video]', message_type: 'text', media_url: mediaKey(message.video) };
    }

    case 'document': {
      const doc = message.document;
      const name = doc?.filename?.trim() || guessFileName(doc?.mime_type);
      return { content: name, message_type: 'text', media_url: mediaKey(doc) };
    }

    case 'location': {
      const loc = message.location;
      if (loc?.latitude == null || loc?.longitude == null) {
        return { content: '[location]', message_type: 'text', media_url: null };
      }
      const lines = [
        `📍 ${loc.name?.trim() || 'Location'}`,
        loc.address?.trim(),
        `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`,
      ].filter(Boolean);
      return { content: lines.join('\n'), message_type: 'text', media_url: null };
    }

    case 'contacts': {
      const contacts = message.contacts ?? [];
      if (!contacts.length) return { content: '[contact]', message_type: 'text', media_url: null };
      const first = contacts[0];
      return { content: formatContact(first) + (contacts.length > 1 ? `\n(+${contacts.length - 1} more contacts)` : ''), message_type: 'text', media_url: null };
    }

    case 'interactive': {
      const it = message.interactive;
      const title =
        it?.button_reply?.title ??
        it?.list_reply?.title ??
        (it?.nfm_reply ? `Form submitted: ${it.nfm_reply.name ?? 'flow'}` : undefined);
      return { content: title?.trim() || '[button]', message_type: 'text', media_url: null };
    }

    case 'button':
      return { content: message.button?.text?.trim() || message.button?.payload?.trim() || '[button]', message_type: 'text', media_url: null };

    case 'reaction':
      // reactions are not chat messages
      return { skip: 'reaction' };

    case 'order': {
      const items = message.order?.product_items ?? [];
      const lines = items.map((item) => `- ${item.product_retailer_id ?? 'item'} x ${item.quantity ?? 1}${item.item_price != null ? ` (${item.item_price} ${item.currency ?? ''})`.trimEnd() : ''}`);
      return { content: ['🛒 Order from catalog', ...lines, message.order?.text?.trim()].filter(Boolean).join('\n'), message_type: 'text', media_url: null };
    }

    case 'system':
      return { content: message.system?.body?.trim() || 'System update', message_type: 'system', media_url: null };

    default: {
      // "unsupported" (polls, events, view-once…) or unknown types
      const reason = message.errors?.[0]?.title || message.errors?.[0]?.message;
      return { content: reason ? `[unsupported]\n${reason}` : '[unsupported]', message_type: 'text', media_url: null };
    }
  }
}

function formatContact(contact: NonNullable<MetaMessage['contacts']>[number]): string {
  const name =
    contact.name?.formatted_name?.trim() ||
    [contact.name?.first_name, contact.name?.last_name].filter(Boolean).join(' ').trim() ||
    'Contact';
  const phoneRaw = contact.phones?.[0]?.wa_id || contact.phones?.[0]?.phone || '';
  const digits = phoneRaw.replace(/[^\d+]/g, '');
  const phone = digits ? (digits.startsWith('+') ? digits : `+${digits}`) : '';
  const company = contact.org?.company?.trim();
  return `Contact: ${name}\nPhone: ${phone}${company ? `\nCompany: ${company}` : ''}`;
}

function guessFileName(mime?: string): string {
  const ext: Record<string, string> = {
    'application/pdf': 'pdf', 'text/plain': 'txt', 'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  };
  const key = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return `Document.${ext[key] ?? 'pdf'}`;
}
