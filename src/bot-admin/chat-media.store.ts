/**
 * Stores chat media (sent by agents or received from Messenger/Instagram) on this server.
 *
 * Why: Meta CDN links expire, WhatsApp media IDs disappear after ~30 days, and Instagram
 * can only send media from a PUBLIC https URL. Keeping our own copy fixes all three.
 *
 * Saved as  <CHAT_MEDIA_DIR>/<companyId>/<yyyy-mm>/<uuid>.<ext>
 * DB value  media_url = "local-media:<companyId>/<yyyy-mm>/<uuid>.<ext>"
 *
 * ENV:
 *   CHAT_MEDIA_DIR        folder on a persistent disk (default ./storage/chat-media)
 *   CHAT_MEDIA_SECRET     secret for signed public links (falls back to JWT_SECRET)
 *   PUBLIC_API_BASE_URL   e.g. https://api.yourdomain.com/v1/api  (needed for Instagram media)
 */
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { extname, join, resolve, sep } from 'path';

export const CHAT_MEDIA_PREFIX = 'local-media:';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/amr': 'amr', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip',
};
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]),
);
MIME_BY_EXT.jpeg = 'image/jpeg';

export function chatMediaRoot(): string {
  return resolve(process.env.CHAT_MEDIA_DIR?.trim() || join(process.cwd(), 'storage', 'chat-media'));
}

export function mimeFromName(name: string, fallback = 'application/octet-stream'): string {
  const ext = extname(name).replace('.', '').toLowerCase();
  return MIME_BY_EXT[ext] ?? fallback;
}

/** Save a file and return the value to store in bot_message.media_url. */
export function saveChatMedia(companyId: number, buffer: Buffer, mimetype: string, originalName?: string): string {
  const mime = (mimetype || '').split(';')[0].trim().toLowerCase();
  let ext = extname(originalName ?? '').replace('.', '').toLowerCase();
  if (!/^[a-z0-9]{1,5}$/.test(ext)) ext = EXT_BY_MIME[mime] ?? 'bin';
  const month = new Date().toISOString().slice(0, 7);
  const relative = `${Number(companyId)}/${month}/${randomUUID()}.${ext}`;
  const absolute = join(chatMediaRoot(), relative);
  mkdirSync(join(chatMediaRoot(), String(Number(companyId)), month), { recursive: true });
  writeFileSync(absolute, buffer);
  return `${CHAT_MEDIA_PREFIX}${relative}`;
}

export function isChatMediaKey(value: string | null | undefined): boolean {
  return String(value ?? '').startsWith(CHAT_MEDIA_PREFIX);
}

/** Company id that owns a stored file (first folder of the key). */
export function chatMediaCompanyId(key: string): number {
  return Number(key.slice(CHAT_MEDIA_PREFIX.length).split('/')[0] || 0);
}

/** Read a stored file. Returns null if missing or if the key tries to leave the media folder. */
export function readChatMedia(key: string): { buffer: Buffer; contentType: string; fileName: string } | null {
  if (!isChatMediaKey(key)) return null;
  const relative = key.slice(CHAT_MEDIA_PREFIX.length);
  const root = chatMediaRoot();
  const absolute = resolve(root, relative);
  if (!absolute.startsWith(root + sep) || !existsSync(absolute)) return null;
  const fileName = relative.split('/').pop() ?? 'file';
  return { buffer: readFileSync(absolute), contentType: mimeFromName(fileName), fileName };
}

/* ───────── signed public links (used for Instagram, which downloads media by URL) ───────── */

function secret(): string {
  const value = process.env.CHAT_MEDIA_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (!value) throw new Error('Set CHAT_MEDIA_SECRET (or JWT_SECRET) to create public media links.');
  return value;
}

const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');

/** Public URL Meta can download for the next `ttlSeconds`. Null when PUBLIC_API_BASE_URL is not set. */
export function publicChatMediaUrl(key: string, ttlSeconds = 3600): string | null {
  const base = (process.env.PUBLIC_API_BASE_URL ?? process.env.API_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!base || !isChatMediaKey(key)) return null;
  const token = Buffer.from(key.slice(CHAT_MEDIA_PREFIX.length)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const ext = extname(key) || '';
  // extension at the end helps Meta detect the file type
  return `${base}/public/chat-media/${token}${ext}?exp=${exp}&sig=${sign(`${token}.${exp}`)}`;
}

/** Validate a public link and return the stored key, or null. */
export function verifyPublicChatMedia(tokenWithExt: string, exp: string, sig: string): string | null {
  const token = tokenWithExt.replace(/\.[a-z0-9]{1,5}$/i, '');
  const expiry = Number(exp);
  if (!token || !Number.isFinite(expiry) || expiry < Date.now() / 1000 || !sig) return null;
  const expected = Buffer.from(sign(`${token}.${expiry}`));
  const supplied = Buffer.from(sig);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  return CHAT_MEDIA_PREFIX + Buffer.from(token, 'base64url').toString();
}
