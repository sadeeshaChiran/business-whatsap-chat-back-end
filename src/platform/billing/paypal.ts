/**
 * PayPal (https://developer.paypal.com) – Orders v2 (one payment) and Subscriptions v1 (auto-renew), REST with OAuth.
 * Settings (.env):
 *   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET   (developer.paypal.com → Apps & Credentials, Live or Sandbox)
 *   PAYPAL_MODE=sandbox|live                 (default sandbox)
 *   PAYPAL_WEBHOOK_ID                        (the webhook made for PUBLIC_API_BASE_URL/public/paypal/webhook)
 *   APP_PUBLIC_URL (dashboard – return / cancel pages)   PUBLIC_API_BASE_URL (webhook)
 *   PAYPAL_API_BASE, PAYPAL_FX_URL           (tests only)
 */
const trim = (key: string) => String(process.env[key] ?? '').trim();

export function paypalConfig() {
  const live = trim('PAYPAL_MODE').toLowerCase() === 'live';
  return {
    clientId: trim('PAYPAL_CLIENT_ID'),
    secret: trim('PAYPAL_CLIENT_SECRET'),
    live,
    webhookId: trim('PAYPAL_WEBHOOK_ID'),
    base: (trim('PAYPAL_API_BASE') || (live ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com')).replace(/\/+$/, ''),
    apiBase: trim('PUBLIC_API_BASE_URL').replace(/\/+$/, ''),
    appBase: trim('APP_PUBLIC_URL').replace(/\/+$/, ''),
    fxUrl: trim('PAYPAL_FX_URL') || 'https://open.er-api.com/v6/latest/USD',
  };
}

export function paypalEnabled(): boolean {
  const config = paypalConfig();
  return Boolean(config.clientId && config.secret && config.appBase);
}

/** PayPal amount: 2 decimals as a string. */
export const usd = (value: number) => (Math.round(Number(value) * 100) / 100).toFixed(2);

let token: { key: string; value: string; until: number } | null = null;

async function accessToken(): Promise<string> {
  const config = paypalConfig();
  const key = `${config.base}|${config.clientId}`;
  if (token && token.key === key && token.until > Date.now()) return token.value;
  const response = await fetch(`${config.base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20000),
  });
  const json = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !json.access_token) throw new PaypalError(`PayPal login failed: ${json.error_description ?? response.status} – check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_MODE.`);
  token = { key, value: json.access_token, until: Date.now() + Math.max(60, Number(json.expires_in ?? 3000) - 120) * 1000 };
  return token.value;
}

export class PaypalError extends Error {
  constructor(message: string, readonly status = 0, readonly details: unknown = null) { super(message); }
}

/** One PayPal REST call; throws PaypalError with PayPal's own message. */
export async function paypal<T = Record<string, any>>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const config = paypalConfig();
  const response = await fetch(`${config.base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...extra },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 204) return {} as T;
  const json = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) {
    const detail = Array.isArray(json.details) && json.details[0] ? `${json.details[0].issue ?? ''} ${json.details[0].description ?? ''}`.trim() : '';
    throw new PaypalError(`PayPal: ${json.message ?? json.name ?? response.status}${detail ? ` (${detail})` : ''}`, response.status, json);
  }
  return json as T;
}

/** The link PayPal wants the buyer to open (approve / payer-action). */
export function approveLink(resource: { links?: Array<{ rel: string; href: string }> }): string | null {
  return resource.links?.find((link) => link.rel === 'approve' || link.rel === 'payer-action')?.href ?? null;
}

/** Today's rupees for one US dollar (market rate, no key needed). */
export async function marketUsdRate(): Promise<number> {
  const response = await fetch(paypalConfig().fxUrl, { signal: AbortSignal.timeout(15000) });
  const json = (await response.json().catch(() => ({}))) as { rates?: Record<string, number> };
  const rate = Number(json.rates?.LKR);
  if (!response.ok || !Number.isFinite(rate) || rate < 50 || rate > 5000) throw new Error('No LKR rate');
  return rate;
}

/** Webhook check: PayPal says whether this call really came from PayPal (needs PAYPAL_WEBHOOK_ID). */
export async function verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<boolean> {
  const config = paypalConfig();
  if (!config.webhookId || !rawBody) return false;
  const h = (name: string) => String(headers[name] ?? '');
  // the event goes back exactly as received (re-encoding it can break the signature)
  const body = `{"auth_algo":${JSON.stringify(h('paypal-auth-algo'))},"cert_url":${JSON.stringify(h('paypal-cert-url'))},`
    + `"transmission_id":${JSON.stringify(h('paypal-transmission-id'))},"transmission_sig":${JSON.stringify(h('paypal-transmission-sig'))},`
    + `"transmission_time":${JSON.stringify(h('paypal-transmission-time'))},"webhook_id":${JSON.stringify(config.webhookId)},"webhook_event":${rawBody}}`;
  try {
    const result = await paypal<{ verification_status?: string }>('POST', '/v1/notifications/verify-webhook-signature', body);
    return result.verification_status === 'SUCCESS';
  } catch {
    return false;
  }
}
