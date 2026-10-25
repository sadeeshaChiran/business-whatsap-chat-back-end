import { createHmac, timingSafeEqual } from 'crypto';

/**
 * TikTok API for Business – Business Messaging (direct messages of a TikTok Business account).
 *
 * ENV:
 *   TIKTOK_APP_ID / TIKTOK_APP_SECRET   the app from business-api.tiktok.com/portal/apps (Business Messaging approved)
 *   TIKTOK_API_VERSION                  default v1.3
 *   TIKTOK_API_BASE_URL / TIKTOK_AUTH_BASE_URL   only for automated tests (a fake TikTok server) – leave empty
 *
 * Every answer is { code, message, data }; code 0 = success.
 */
const env = (name: string) => String(process.env[name] ?? '').trim();
export const tiktokAppId = () => env('TIKTOK_APP_ID');
export const tiktokAppSecret = () => env('TIKTOK_APP_SECRET');
export const tiktokConfigured = () => Boolean(tiktokAppId() && tiktokAppSecret());
const apiBase = () => (env('TIKTOK_API_BASE_URL') || `https://business-api.tiktok.com/open_api/${env('TIKTOK_API_VERSION') || 'v1.3'}`).replace(/\/+$/, '');
const authBase = () => (env('TIKTOK_AUTH_BASE_URL') || 'https://www.tiktok.com').replace(/\/+$/, '');

/** What the app asks the business account for (messages + basic profile). */
export const TIKTOK_SCOPES = ['user.info.basic', 'user.info.username', 'user.info.profile', 'user.account.type', 'message.list.read', 'message.list.send', 'message.list.manage'];

export class TiktokError extends Error {
  constructor(message: string, readonly code?: number | string) { super(message); }
}

type Envelope<T> = { code?: number; message?: string; data?: T; request_id?: string };

async function read<T>(response: Response, what: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as Envelope<T>;
  if (!response.ok || (body.code !== undefined && body.code !== 0)) {
    throw new TiktokError(`TikTok: ${body.message || `${what} failed (${response.status})`}`, body.code ?? response.status);
  }
  return (body.data ?? {}) as T;
}

const json = (method: 'GET' | 'POST', token?: string): RequestInit => ({
  method,
  headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { 'Access-Token': token } : {}) },
  signal: AbortSignal.timeout(30_000),
});

/* ───────── OAuth (TikTok account → our app) ───────── */

export function tiktokAuthorizeUrl(redirectUri: string, state: string): string {
  const url = new URL(`${authBase()}/v2/auth/authorize`);
  url.searchParams.set('client_key', tiktokAppId());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', TIKTOK_SCOPES.join(','));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export type TiktokTokens = {
  businessId: string; scope: string; accessToken: string; refreshToken: string; expiresAt: Date; refreshExpiresAt: Date;
};

function tokens(data: Record<string, unknown>, businessId?: string): TiktokTokens {
  const now = Date.now();
  return {
    businessId: String(data.open_id ?? businessId ?? ''),
    scope: String(data.scope ?? ''),
    accessToken: String(data.access_token ?? ''),
    refreshToken: String(data.refresh_token ?? ''),
    expiresAt: new Date(now + Number(data.expires_in ?? 86_400) * 1000),
    refreshExpiresAt: new Date(now + Number(data.refresh_token_expires_in ?? 30 * 86_400) * 1000),
  };
}

export async function exchangeTiktokCode(code: string, redirectUri: string): Promise<TiktokTokens> {
  const data = await read<Record<string, unknown>>(await fetch(`${apiBase()}/tt_user/oauth2/token/`, {
    ...json('POST'),
    body: JSON.stringify({ client_id: tiktokAppId(), client_secret: tiktokAppSecret(), grant_type: 'authorization_code', auth_code: code, redirect_uri: redirectUri }),
  }), 'Connecting the account');
  const result = tokens(data);
  if (!result.businessId || !result.accessToken) throw new TiktokError('TikTok did not return an account. Try connecting again.');
  return result;
}

export async function refreshTiktokToken(refreshToken: string, businessId: string): Promise<TiktokTokens> {
  const data = await read<Record<string, unknown>>(await fetch(`${apiBase()}/tt_user/oauth2/refresh_token/`, {
    ...json('POST'),
    body: JSON.stringify({ client_id: tiktokAppId(), client_secret: tiktokAppSecret(), grant_type: 'refresh_token', refresh_token: refreshToken }),
  }), 'Renewing the access');
  return tokens(data, businessId);
}

/* ───────── account + webhook ───────── */

export async function tiktokBusinessProfile(businessId: string, token: string): Promise<{ username: string | null; display_name: string | null; profile_image: string | null }> {
  const url = new URL(`${apiBase()}/business/get/`);
  url.searchParams.set('business_id', businessId);
  url.searchParams.set('fields', JSON.stringify(['username', 'display_name', 'profile_image']));
  const data = await read<Record<string, unknown>>(await fetch(url, json('GET', token)), 'Reading the account');
  return {
    username: data.username ? String(data.username) : null,
    display_name: data.display_name ? String(data.display_name) : null,
    profile_image: data.profile_image ? String(data.profile_image) : null,
  };
}

/** The app's direct-message webhook (one per app, for every connected account). */
export async function setTiktokWebhook(callbackUrl: string): Promise<void> {
  await read(await fetch(`${apiBase()}/business/webhook/update/`, {
    ...json('POST'),
    body: JSON.stringify({ app_id: tiktokAppId(), secret: tiktokAppSecret(), event_type: 'DIRECT_MESSAGE', callback_url: callbackUrl }),
  }), 'Setting the webhook');
}

export async function getTiktokWebhook(): Promise<string | null> {
  const url = new URL(`${apiBase()}/business/webhook/list/`);
  url.searchParams.set('app_id', tiktokAppId());
  url.searchParams.set('secret', tiktokAppSecret());
  url.searchParams.set('event_type', 'DIRECT_MESSAGE');
  const data = await read<Record<string, unknown>>(await fetch(url, json('GET')), 'Reading the webhook');
  const list = (data.list ?? data.webhooks ?? (Array.isArray(data) ? data : [])) as Array<Record<string, unknown>>;
  const found = Array.isArray(list) ? list.find((row) => row.callback_url) : null;
  return String(found?.callback_url ?? data.callback_url ?? '') || null;
}

/* ───────── messages ───────── */

export async function sendTiktokMessage(businessId: string, token: string, conversationId: string,
  message: { text: string } | { mediaId: string }, referencedMessageId?: string | null): Promise<string | null> {
  const body: Record<string, unknown> = { business_id: businessId, recipient_type: 'CONVERSATION', recipient: conversationId };
  if ('text' in message) {
    body.message_type = 'TEXT';
    body.text = { body: message.text };
  } else {
    body.message_type = 'IMAGE';
    body.image = { media_id: message.mediaId };
  }
  if (referencedMessageId) body.referenced_message_info = { referenced_message_id: referencedMessageId };
  const data = await read<{ message?: { message_id?: string } }>(await fetch(`${apiBase()}/business/message/send/`, {
    ...json('POST', token), body: JSON.stringify(body),
  }), 'Sending the message');
  return data.message?.message_id ?? null;
}

export async function uploadTiktokImage(businessId: string, token: string, file: { buffer: Buffer; mimetype: string; fileName: string }): Promise<string> {
  const form = new FormData();
  form.append('business_id', businessId);
  form.append('media_type', 'IMAGE');
  form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.fileName);
  const data = await read<{ media_id?: string }>(await fetch(`${apiBase()}/business/message/media/upload/`, {
    method: 'POST', headers: { 'Access-Token': token }, body: form, signal: AbortSignal.timeout(60_000),
  }), 'Uploading the photo');
  if (!data.media_id) throw new TiktokError('TikTok did not accept the photo.');
  return data.media_id;
}

/** A photo the customer sent: a short-lived download link, fetched with the account's token. */
export async function downloadTiktokMedia(businessId: string, token: string, conversationId: string, messageId: string, mediaId: string,
  maxBytes = 25 * 1024 * 1024): Promise<{ buffer: Buffer; mimetype: string } | null> {
  const data = await read<{ download_url?: string }>(await fetch(`${apiBase()}/business/message/media/download/`, {
    ...json('POST', token),
    body: JSON.stringify({ business_id: businessId, conversation_id: conversationId, message_id: messageId, media_id: mediaId, media_type: 'IMAGE' }),
  }), 'Reading the photo');
  if (!data.download_url) return null;
  const response = await fetch(data.download_url, { headers: { 'x-user': token }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > maxBytes) return null;
  return { buffer, mimetype: (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim() };
}

/** Can this chat receive photos? (TikTok allows photos only in some countries) – unknown = true. */
export async function tiktokCanSendImage(businessId: string, token: string, conversationId: string): Promise<boolean> {
  const url = new URL(`${apiBase()}/business/message/capabilities/get/`);
  url.searchParams.set('business_id', businessId);
  url.searchParams.set('conversation_id', conversationId);
  url.searchParams.set('conversation_type', 'SINGLE');
  url.searchParams.set('capability_types', JSON.stringify(['IMAGE_SEND']));
  const data = await read<{ capability_infos?: Array<{ capability_type?: string; capability_result?: boolean }> }>(await fetch(url, json('GET', token)), 'Checking photos');
  const found = (data.capability_infos ?? []).find((row) => row.capability_type === 'IMAGE_SEND');
  return found ? found.capability_result !== false : true;
}

/* ───────── webhook signature ───────── */

/**
 * Header "Tiktok-Signature: t=<unix seconds>,s=<hex HMAC-SHA256 of "<t>.<raw body>" with the app secret>".
 * Requests older than TIKTOK_WEBHOOK_MAX_AGE_S (default 300 s) are refused (replays).
 */
export function verifyTiktokSignature(header: string | undefined, rawBody: Buffer | string | undefined, secret = tiktokAppSecret(), now = Date.now()): boolean {
  if (!header || !rawBody || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((part) => part.trim().split('=')).filter((pair) => pair.length === 2)) as Record<string, string>;
  const t = Number(parts.t);
  const s = parts.s;
  if (!Number.isFinite(t) || !s || !/^[0-9a-f]+$/i.test(s)) return false;
  const maxAge = Number(process.env.TIKTOK_WEBHOOK_MAX_AGE_S ?? 300);
  if (Math.abs(now / 1000 - t) > maxAge) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')}`).digest();
  const supplied = Buffer.from(s, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
