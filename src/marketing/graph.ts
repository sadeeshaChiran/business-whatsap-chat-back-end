import { createHash, createHmac } from 'crypto';

/**
 * Small Meta Graph API client for the marketing tools.
 * Uses META_APP_ID, META_APP_SECRET, META_GRAPH_API_VERSION (default v22.0), PUBLIC_API_BASE_URL, APP_PUBLIC_URL.
 */
const env = (name: string) => String(process.env[name] ?? '').trim();
export const graphVersion = () => env('META_GRAPH_API_VERSION') || 'v22.0';
/** META_GRAPH_BASE_URL is only for automated tests (a local fake Meta server) – leave it empty in production. */
const graphBase = () => (env('META_GRAPH_BASE_URL') || 'https://graph.facebook.com').replace(/\/+$/, '');
const graph = (path: string) => `${graphBase()}/${graphVersion()}${path.startsWith('/') ? path : `/${path}`}`;

export class GraphError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}

export async function graphRequest<T>(method: 'GET' | 'POST' | 'DELETE', path: string, token: string, params: Record<string, unknown> = {}): Promise<T> {
  const url = new URL(graph(path));
  let body: string | undefined;
  if (method === 'GET' || method === 'DELETE') {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  } else {
    body = JSON.stringify(params);
  }
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number; error_user_msg?: string } };
  if (!response.ok || payload.error) {
    throw new GraphError(payload.error?.error_user_msg || payload.error?.message || `Meta answered ${response.status}`, payload.error?.code);
  }
  return payload;
}

/* ───── Login for ads (separate from the Page / WhatsApp login) ───── */

/** ads_management (pause, budget, Custom Audiences) is not approved for the Meta app yet: read only. */
export const ADS_SCOPES = 'ads_read,business_management';

function sign(text: string) {
  const secret = env('META_OAUTH_STATE_SECRET') || env('JWT_SECRET');
  if (!secret) throw new Error('JWT_SECRET is required');
  return createHmac('sha256', secret).update(text).digest('base64url');
}

export function adsState(companyId: number, userId: number) {
  const payload = `${companyId}.${userId}.${Date.now()}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

export function readAdsState(state: string): { companyId: number; userId: number } | null {
  const [encoded, signature] = String(state ?? '').split('.');
  if (!encoded || !signature) return null;
  const payload = Buffer.from(encoded, 'base64url').toString();
  if (sign(payload) !== signature) return null;
  const [companyId, userId, ts] = payload.split('.').map(Number);
  if (!companyId || Date.now() - ts > 30 * 60 * 1000) return null; // 30 minutes
  return { companyId, userId };
}

export const adsRedirectUri = () => `${env('PUBLIC_API_BASE_URL').replace(/\/+$/, '')}/public/marketing/meta/callback`;

export function adsLoginUrl(companyId: number, userId: number) {
  if (!env('META_APP_ID') || !env('PUBLIC_API_BASE_URL')) throw new GraphError('META_APP_ID and PUBLIC_API_BASE_URL must be set.');
  const url = new URL(`https://www.facebook.com/${graphVersion()}/dialog/oauth`);
  url.searchParams.set('client_id', env('META_APP_ID'));
  url.searchParams.set('redirect_uri', adsRedirectUri());
  url.searchParams.set('scope', ADS_SCOPES);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', adsState(companyId, userId));
  return url.toString();
}

/** code → long-lived user token (about 60 days) */
export async function exchangeAdsCode(code: string): Promise<{ token: string; expiresAt: Date | null }> {
  const short = new URL(graph('/oauth/access_token'));
  short.searchParams.set('client_id', env('META_APP_ID'));
  short.searchParams.set('client_secret', env('META_APP_SECRET'));
  short.searchParams.set('redirect_uri', adsRedirectUri());
  short.searchParams.set('code', code);
  const first = (await (await fetch(short, { signal: AbortSignal.timeout(20000) })).json()) as { access_token?: string; error?: { message?: string } };
  if (!first.access_token) throw new GraphError(first.error?.message ?? 'Meta did not return a token.');
  const long = new URL(graph('/oauth/access_token'));
  long.searchParams.set('grant_type', 'fb_exchange_token');
  long.searchParams.set('client_id', env('META_APP_ID'));
  long.searchParams.set('client_secret', env('META_APP_SECRET'));
  long.searchParams.set('fb_exchange_token', first.access_token);
  const second = (await (await fetch(long, { signal: AbortSignal.timeout(20000) })).json()) as { access_token?: string; expires_in?: number };
  return {
    token: second.access_token ?? first.access_token,
    expiresAt: second.expires_in ? new Date(Date.now() + second.expires_in * 1000) : null,
  };
}

/* ───── Custom audiences: Meta needs SHA-256 of normalised values ───── */

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** phone → digits with country code (Sri Lanka 07… → 947…), email → lowercase */
export function normalisePhone(value: string | null | undefined): string {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('0')) digits = `94${digits.slice(1)}`;
  return digits.length >= 10 ? digits : '';
}

/** Meta budgets are in the currency's minor unit (cents); LKR, USD, EUR … use 100. */
export const toMinorUnits = (amount: number) => Math.round(Number(amount) * 100);
export const fromMinorUnits = (value: unknown) => (value == null || value === '' ? null : Number(value) / 100);

/**
 * The permissions Meta really granted to a (user or Page) token – from debug_token with the app token.
 * null when the app is not configured or Meta does not answer.
 */
export async function tokenScopes(token: string): Promise<string[] | null> {
  const appId = env('META_APP_ID');
  const secret = env('META_APP_SECRET');
  if (!appId || !secret || !token) return null;
  try {
    const result = await graphRequest<{ data?: { scopes?: string[]; is_valid?: boolean } }>('GET', '/debug_token', `${appId}|${secret}`, { input_token: token });
    return Array.isArray(result.data?.scopes) ? result.data!.scopes! : null;
  } catch {
    return null;
  }
}
