export type EvolutionInboxChat = {
  remote_jid: string;
  phone: string;
  display_name: string;
  last_message_preview: string;
  last_message_at: string | null;
  unread_count: number;
};

export type EvolutionInboxMessage = {
  id: string;
  remote_jid: string;
  direction: 'inbound' | 'outbound';
  message_type: 'text' | 'image' | 'voice' | 'system';
  content: string;
  created_at: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function normalizePhoneFromJid(jid: string): string {
  const base = jid.split('@')[0] ?? jid;
  return base.replace(/\D/g, '');
}

const NESTED_MESSAGE_PARTS = [
  'extendedTextMessage',
  'imageMessage',
  'videoMessage',
  'documentMessage',
  'audioMessage',
  'pttMessage',
  'stickerMessage',
  'buttonsResponseMessage',
  'listResponseMessage',
  'templateButtonReplyMessage',
  'reactionMessage',
] as const;

function extractMessageText(message: Record<string, unknown>): string {
  const nested = asRecord(message.message) ?? message;
  const direct =
    pickString(nested, [
      'conversation',
      'text',
      'caption',
      'content',
      'body',
    ]) || pickString(message, ['conversation', 'text', 'content']);
  if (direct) {
    return direct;
  }

  for (const part of NESTED_MESSAGE_PARTS) {
    const block = asRecord(nested[part]);
    if (!block) {
      continue;
    }
    const text = pickString(block, [
      'text',
      'caption',
      'conversation',
      'content',
      'selectedDisplayText',
      'title',
    ]);
    if (text) {
      return text;
    }
  }

  const messageType = pickString(message, ['messageType', 'message_type']);
  if (messageType && messageType !== 'conversation') {
    return `[${messageType}]`;
  }

  return '[media]';
}

function mapEvolutionMessageType(
  rawType: string,
  content: string,
): EvolutionInboxMessage['message_type'] {
  const type = rawType.toLowerCase();
  if (type.includes('image') || content.startsWith('http')) {
    return 'image';
  }
  if (type.includes('audio') || type.includes('ptt') || type === 'voicemessage') {
    return 'voice';
  }
  if (type.includes('conversation') || type.includes('text') || !type) {
    return 'text';
  }
  return 'text';
}

function extractMessageRecords(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const root = asRecord(payload);
  if (!root) {
    return [];
  }

  const messages = root.messages;
  if (Array.isArray(messages)) {
    return messages;
  }
  const messagesPage = asRecord(messages);
  if (messagesPage && Array.isArray(messagesPage.records)) {
    return messagesPage.records;
  }

  if (Array.isArray(root.data)) {
    return root.data;
  }
  const data = asRecord(root.data);
  if (data && Array.isArray(data.records)) {
    return data.records;
  }

  return [];
}

function extractTimestamp(raw: unknown): string | null {
  if (typeof raw === 'number' && raw > 0) {
    const ms = raw > 1_000_000_000_000 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof raw === 'string' && raw.trim()) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
      return new Date(ms).toISOString();
    }
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export function parseEvolutionFindChats(payload: unknown): EvolutionInboxChat[] {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { chats?: unknown })?.chats)
      ? ((payload as { chats: unknown[] }).chats ?? [])
      : Array.isArray((payload as { data?: unknown })?.data)
        ? ((payload as { data: unknown[] }).data ?? [])
        : [];

  const chats: EvolutionInboxChat[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const remoteJid =
      pickString(record, ['remoteJid', 'remote_jid', 'id', 'jid']) ||
      pickString(asRecord(record.key) ?? {}, ['remoteJid', 'id']);
    if (!remoteJid || remoteJid.includes('@g.us')) {
      continue;
    }

    const lastMessage = asRecord(record.lastMessage) ?? asRecord(record.last_message);
    const preview = lastMessage ? extractMessageText(lastMessage) : '';
    const updatedAt =
      extractTimestamp(record.updatedAt) ??
      extractTimestamp(record.last_message_at) ??
      (lastMessage
        ? extractTimestamp(lastMessage.messageTimestamp) ??
          extractTimestamp(lastMessage.message_timestamp)
        : null);

    chats.push({
      remote_jid: remoteJid,
      phone: normalizePhoneFromJid(remoteJid),
      display_name:
        pickString(record, ['pushName', 'push_name', 'name', 'subject']) ||
        normalizePhoneFromJid(remoteJid),
      last_message_preview: preview,
      last_message_at: updatedAt,
      unread_count: Number(record.unreadCount ?? record.unread_count ?? 0) || 0,
    });
  }

  return chats;
}

export function parseEvolutionFindMessages(
  payload: unknown,
  fallbackJid: string,
): EvolutionInboxMessage[] {
  const list = extractMessageRecords(payload);

  const messages: EvolutionInboxMessage[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const key = asRecord(record.key) ?? {};
    const remoteJid =
      pickString(key, ['remoteJid', 'remote_jid']) ||
      pickString(record, ['remoteJid', 'remote_jid']) ||
      fallbackJid;
    const fromMeRaw = key.fromMe ?? record.fromMe ?? record.from_me;
    const fromMe =
      fromMeRaw === true ||
      fromMeRaw === 1 ||
      fromMeRaw === 'true' ||
      fromMeRaw === '1';
    const id =
      pickString(key, ['id']) ||
      pickString(record, ['id']) ||
      `${remoteJid}-${messages.length}`;
    const createdAt =
      extractTimestamp(record.messageTimestamp) ??
      extractTimestamp(record.message_timestamp) ??
      extractTimestamp(record.created_at) ??
      new Date().toISOString();
    const content = extractMessageText(record);
    const rawType = pickString(record, ['messageType', 'message_type']);
    const isMedia =
      rawType.toLowerCase().includes('image') ||
      content.startsWith('http') ||
      content.startsWith('[image');
    if (!content.trim() && !isMedia) {
      continue;
    }

    messages.push({
      id,
      remote_jid: remoteJid,
      direction: fromMe ? 'outbound' : 'inbound',
      message_type: mapEvolutionMessageType(rawType, content),
      content,
      created_at: createdAt,
    });
  }

  messages.sort(
    (left, right) =>
      new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
  );

  return messages;
}
