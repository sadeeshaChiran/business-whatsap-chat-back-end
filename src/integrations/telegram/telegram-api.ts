/**
 * Telegram Bot API (https://core.telegram.org/bots/api) – free, no approval: a business makes a bot with @BotFather
 * and pastes its token. Every answer is { ok, result } or { ok: false, error_code, description }.
 *
 * ENV (optional): TELEGRAM_API_BASE_URL – only for automated tests (a fake Telegram server); leave empty.
 */
const apiBase = () => (String(process.env.TELEGRAM_API_BASE_URL ?? '').trim() || 'https://api.telegram.org').replace(/\/+$/, '');

export class TelegramError extends Error {
  constructor(message: string, readonly code?: number, readonly retryAfter?: number) { super(message); }
  /** the customer blocked the bot / deleted the account – messages to them can never arrive */
  get unreachable() { return this.code === 403; }
}

/** A bot token looks like 123456789:AA… (digits, colon, 30+ letters). */
export const looksLikeBotToken = (value: string) => /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(value.trim());

type Answer<T> = { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };

async function read<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as Answer<T>;
  if (!response.ok || !body.ok) {
    const text = body.description || `Telegram error ${response.status}`;
    throw new TelegramError(`Telegram: ${text.replace(/^(Bad Request|Forbidden|Unauthorized):\s*/i, '')}`, body.error_code ?? response.status, body.parameters?.retry_after);
  }
  return body.result as T;
}

export async function telegramCall<T>(token: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return read<T>(await fetch(`${apiBase()}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30_000),
  }));
}

/** multipart upload (photo / document / video / audio / voice from our own storage) */
export async function telegramUpload<T>(token: string, method: string, field: string, file: { buffer: Buffer; mimetype: string; fileName: string },
  params: Record<string, string | number | undefined> = {}): Promise<T> {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') form.append(key, String(value));
  form.append(field, new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.fileName);
  return read<T>(await fetch(`${apiBase()}/bot${token}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) }));
}

export type TelegramBot = { id: number; is_bot: boolean; first_name: string; username?: string };
export type TelegramChat = { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; username?: string; first_name?: string; last_name?: string };

export const getMe = (token: string) => telegramCall<TelegramBot>(token, 'getMe');

export function setWebhook(token: string, url: string, secret: string) {
  return telegramCall<boolean>(token, 'setWebhook', {
    url, secret_token: secret, drop_pending_updates: false, max_connections: 40,
    allowed_updates: ['message', 'edited_message', 'my_chat_member', 'chat_join_request', 'chat_member'],
  });
}
export const deleteWebhook = (token: string) => telegramCall<boolean>(token, 'deleteWebhook', { drop_pending_updates: false });
export const getWebhookInfo = (token: string) =>
  telegramCall<{ url: string; pending_update_count: number; last_error_date?: number; last_error_message?: string }>(token, 'getWebhookInfo');

/** A file the customer sent: getFile → download (max 20 MB through the Bot API). */
export async function downloadTelegramFile(token: string, fileId: string, maxBytes = 20 * 1024 * 1024): Promise<{ buffer: Buffer; path: string } | null> {
  const file = await telegramCall<{ file_path?: string; file_size?: number }>(token, 'getFile', { file_id: fileId });
  if (!file.file_path || (file.file_size ?? 0) > maxBytes) return null;
  const response = await fetch(`${apiBase()}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.length && buffer.length <= maxBytes ? { buffer, path: file.file_path } : null;
}

/** Which Telegram method sends this kind of file (Telegram shows each type in its own way). */
export function sendMethodFor(mimetype: string, fileName = ''): { method: string; field: string } {
  const type = mimetype.toLowerCase();
  if (/^image\/(jpe?g|png|webp)$/.test(type)) return { method: 'sendPhoto', field: 'photo' };
  if (type === 'video/mp4') return { method: 'sendVideo', field: 'video' };
  if (type === 'audio/ogg' || /\.(ogg|oga|opus)$/i.test(fileName)) return { method: 'sendVoice', field: 'voice' };
  if (/^audio\/(mpeg|mp3|mp4|m4a|x-m4a|aac)$/.test(type)) return { method: 'sendAudio', field: 'audio' };
  return { method: 'sendDocument', field: 'document' };
}
