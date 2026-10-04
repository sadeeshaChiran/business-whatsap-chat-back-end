import { ForbiddenException, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

const logger = new Logger('WebhookAuth');
const env = (name: string) => String(process.env[name] ?? '').trim();
let warnedMetaUnsigned = false;
let warnedEvolutionOpen = false;

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Meta (WhatsApp Cloud API) signs every webhook with the app secret: X-Hub-Signature-256: sha256=<hmac>.
 * Secrets: META_APP_SECRET plus optional META_APP_SECRETS_EXTRA (comma separated, for extra Meta apps).
 * WHATSAPP_WEBHOOK_REQUIRE_SIGNATURE=false turns the check off (not recommended).
 */
export function assertMetaSignature(rawBody: Buffer | undefined, signature: string | undefined) {
  const secrets = [env('META_APP_SECRET'), ...env('META_APP_SECRETS_EXTRA').split(',')].map((s) => s.trim()).filter(Boolean);
  const required = env('WHATSAPP_WEBHOOK_REQUIRE_SIGNATURE').toLowerCase() !== 'false';
  if (!secrets.length) {
    if (required && process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('Webhook signature cannot be checked: META_APP_SECRET is not set.');
    }
    if (!warnedMetaUnsigned) {
      warnedMetaUnsigned = true;
      logger.warn('META_APP_SECRET is not set – WhatsApp Meta webhooks are accepted without a signature check.');
    }
    return;
  }
  if (!required) return;
  if (!rawBody || !signature?.startsWith('sha256=')) {
    throw new ForbiddenException('Missing webhook signature.');
  }
  const supplied = signature.slice(7);
  const valid = secrets.some((secret) => safeEqual(createHmac('sha256', secret).update(rawBody).digest('hex'), supplied));
  if (!valid) {
    logger.warn('WhatsApp Meta webhook rejected: signature does not match META_APP_SECRET');
    throw new ForbiddenException('Invalid webhook signature.');
  }
}

/**
 * Evolution API webhooks. With EVOLUTION_WEBHOOK_TOKEN set, the webhook URL must carry ?token=<value>
 * (added automatically when the API configures an instance) – or the body "apikey" must match EVOLUTION_API_KEY.
 */
export function assertEvolutionToken(queryToken: string | undefined, body: unknown) {
  const token = env('EVOLUTION_WEBHOOK_TOKEN');
  if (!token) {
    if (!warnedEvolutionOpen) {
      warnedEvolutionOpen = true;
      logger.warn('EVOLUTION_WEBHOOK_TOKEN is not set – Evolution webhooks are accepted without a token.');
    }
    return;
  }
  if (queryToken && safeEqual(queryToken, token)) return;
  const apiKey = env('EVOLUTION_API_KEY');
  const bodyKey = String((body as { apikey?: unknown })?.apikey ?? '').trim();
  if (apiKey && bodyKey && safeEqual(bodyKey, apiKey)) return;
  throw new ForbiddenException('Invalid webhook token.');
}

/** Adds ?token=EVOLUTION_WEBHOOK_TOKEN to the Evolution webhook URL. */
export function withEvolutionWebhookToken(url: string): string {
  const token = env('EVOLUTION_WEBHOOK_TOKEN');
  if (!token || /[?&]token=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export function isMetaPayload(body: unknown): boolean {
  const payload = ((body as Record<string, unknown>)?.body as Record<string, unknown>) ?? (body as Record<string, unknown>);
  return payload?.object === 'whatsapp_business_account';
}
