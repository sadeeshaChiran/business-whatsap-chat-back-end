import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Payments.lk (https://payments.lk/developers, by PAYable) – hosted checkout in LKR, saved cards, signed webhooks.
 * Settings (.env):
 *   PAYMENTSLK_SECRET_KEY      sk_test_… (sandbox) or sk_live_… (live) – dashboard → Developers
 *   PAYMENTSLK_WEBHOOK_SECRET  the signing secret of the webhook endpoint PUBLIC_API_BASE_URL/public/paymentslk/webhook
 *   APP_PUBLIC_URL (dashboard – success / cancel pages)   PUBLIC_API_BASE_URL (webhook)
 *   PAYMENTSLK_API_BASE        (tests only; default https://api.payments.lk/v1)
 */
const env = (key: string) => String(process.env[key] ?? '').trim();

export function paymentsLkConfig() {
  const key = env('PAYMENTSLK_SECRET_KEY');
  return {
    key,
    live: key.startsWith('sk_live_'),
    webhookSecret: env('PAYMENTSLK_WEBHOOK_SECRET'),
    base: (env('PAYMENTSLK_API_BASE') || 'https://api.payments.lk/v1').replace(/\/+$/, ''),
    apiBase: env('PUBLIC_API_BASE_URL').replace(/\/+$/, ''),
    appBase: env('APP_PUBLIC_URL').replace(/\/+$/, ''),
  };
}

export function paymentsLkEnabled(): boolean {
  const config = paymentsLkConfig();
  return Boolean(config.key && config.appBase);
}

/** Rupees → whole LKR cents (Rs 3,500 = 350000). */
export const lkrCents = (rupees: number) => Math.round(Number(rupees) * 100);

export class PaymentsLkError extends Error {
  constructor(message: string, readonly status = 0, readonly code: string | null = null) { super(message); }
}

/** One Payments.lk API call. Every write carries an Idempotency-Key (same key = same answer for 24 h). */
export async function paymentsLk<T = Record<string, any>>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const config = paymentsLkConfig();
  const headers: Record<string, string> = { Authorization: `Bearer ${config.key}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['Idempotency-Key'] = idempotencyKey ?? `am-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await fetch(`${config.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const json = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) {
    const error = (json.error ?? json) as Record<string, any>;
    throw new PaymentsLkError(`Payments.lk: ${error.message ?? error.reason ?? error.code ?? response.status}`, response.status, error.code ?? null);
  }
  return json as T;
}

/**
 * Webhook signature: header Payments-Signature = "t=<unix seconds>,v1=<hex>[,v1=<hex>…]",
 * v1 = HMAC-SHA256(secret, t + "." + raw body) in hex; any v1 may match; t within 5 minutes.
 */
export function verifyPaymentsLkSignature(rawBody: string, header: string | undefined, secret: string, toleranceSeconds = 300, now = Date.now()): boolean {
  if (!secret || !header || !rawBody) return false;
  let t = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, ...rest] = part.trim().split('=');
    const v = rest.join('=');
    if (k === 't') t = v;
    else if (k === 'v1' && v) signatures.push(v);
  }
  const ts = Number(t);
  if (!t || !Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSeconds || !signatures.length) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'), 'utf8');
  return signatures.some((sig) => {
    const given = Buffer.from(sig, 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
