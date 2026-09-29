import { createHash } from 'crypto';

/**
 * PayHere (https://support.payhere.lk) – Checkout API + Recurring API + Subscription Manager API.
 * Settings (.env):
 *   PAYHERE_MERCHANT_ID, PAYHERE_MERCHANT_SECRET, PAYHERE_SANDBOX=true|false
 *   PAYHERE_APP_ID, PAYHERE_APP_SECRET   (optional – to cancel auto-renew from the app)
 *   PUBLIC_API_BASE_URL  (notify_url – PayHere calls it)   APP_PUBLIC_URL (dashboard, return / cancel pages)
 */
const md5 = (value: string) => createHash('md5').update(value).digest('hex').toUpperCase();

export function payhereConfig() {
  const sandbox = !['0', 'false', 'no'].includes(String(process.env.PAYHERE_SANDBOX ?? 'true').trim().toLowerCase());
  return {
    merchantId: String(process.env.PAYHERE_MERCHANT_ID ?? '').trim(),
    secret: String(process.env.PAYHERE_MERCHANT_SECRET ?? '').trim(),
    appId: String(process.env.PAYHERE_APP_ID ?? '').trim(),
    appSecret: String(process.env.PAYHERE_APP_SECRET ?? '').trim(),
    sandbox,
    base: sandbox ? 'https://sandbox.payhere.lk' : 'https://www.payhere.lk',
    apiBase: String(process.env.PUBLIC_API_BASE_URL ?? '').trim().replace(/\/+$/, ''),
    appBase: String(process.env.APP_PUBLIC_URL ?? '').trim().replace(/\/+$/, ''),
  };
}

export function payhereEnabled(): boolean {
  const config = payhereConfig();
  return Boolean(config.merchantId && config.secret && config.apiBase);
}

/** PayHere amount format: 2 decimals, no thousands separator. */
export const payhereAmount = (amount: number) => Number(amount).toFixed(2);

/** hash = UPPER(md5(merchant_id + order_id + amount + currency + UPPER(md5(merchant_secret)))) */
export function checkoutHash(merchantId: string, orderId: string, amount: number, currency: string, secret: string): string {
  return md5(`${merchantId}${orderId}${payhereAmount(amount)}${currency}${md5(secret)}`);
}

/** md5sig = UPPER(md5(merchant_id + order_id + payhere_amount + payhere_currency + status_code + UPPER(md5(merchant_secret)))) */
export function verifyNotifySignature(body: Record<string, string>, secret: string): boolean {
  const expected = md5(`${body.merchant_id}${body.order_id}${body.payhere_amount}${body.payhere_currency}${body.status_code}${md5(secret)}`);
  return Boolean(body.md5sig) && expected === String(body.md5sig).toUpperCase();
}

/** 2 = success, 0 = pending, -1 = cancelled, -2 = failed, -3 = charged back */
export function payhereStatus(code: string | number): 'paid' | 'pending' | 'cancelled' | 'failed' | 'chargedback' {
  const value = Number(code);
  return value === 2 ? 'paid' : value === 0 ? 'pending' : value === -1 ? 'cancelled' : value === -3 ? 'chargedback' : 'failed';
}

/** Subscription Manager API: cancel a recurring payment (needs PAYHERE_APP_ID / PAYHERE_APP_SECRET). */
export async function cancelPayhereSubscription(subscriptionId: string): Promise<{ ok: boolean; message: string }> {
  const config = payhereConfig();
  if (!config.appId || !config.appSecret) return { ok: false, message: 'PAYHERE_APP_ID / PAYHERE_APP_SECRET not set – cancel it in the PayHere portal.' };
  try {
    const tokenResponse = await fetch(`${config.base}/merchant/v1/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.appId}:${config.appSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15000),
    });
    const token = ((await tokenResponse.json()) as { access_token?: string }).access_token;
    if (!token) return { ok: false, message: 'PayHere did not give an access token.' };
    const cancel = await fetch(`${config.base}/merchant/v1/subscription/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription_id: subscriptionId }),
      signal: AbortSignal.timeout(15000),
    });
    const result = (await cancel.json().catch(() => ({}))) as { status?: number; msg?: string };
    return { ok: cancel.ok && Number(result.status ?? 1) === 1, message: result.msg ?? `PayHere answered ${cancel.status}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
