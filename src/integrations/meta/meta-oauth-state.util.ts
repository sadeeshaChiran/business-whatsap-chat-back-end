import { createHmac, timingSafeEqual } from 'crypto';

export type MetaOAuthStatePayload = {
  c: number;
  u: number;
  t: number;
};

const STATE_TTL_MS = 15 * 60 * 1000;

function secret(): string {
  return (
    process.env.META_OAUTH_STATE_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    'meta-oauth-state-secret'
  );
}

function signPayload(encoded: string): string {
  return createHmac('sha256', secret()).update(encoded).digest('base64url');
}

export function buildMetaOAuthState(
  companyId: number,
  userId: number,
): string {
  const payload: MetaOAuthStatePayload = {
    c: companyId,
    u: userId,
    t: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = signPayload(encoded);
  return `${encoded}.${signature}`;
}

export function parseMetaOAuthState(state: string): MetaOAuthStatePayload {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) {
    throw new Error('Invalid OAuth state');
  }
  const expected = signPayload(encoded);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid OAuth state signature');
  }
  const payload = JSON.parse(
    Buffer.from(encoded, 'base64url').toString('utf8'),
  ) as MetaOAuthStatePayload;
  if (!payload.c || !payload.u || !payload.t) {
    throw new Error('Invalid OAuth state payload');
  }
  if (Date.now() - payload.t > STATE_TTL_MS) {
    throw new Error('OAuth state expired');
  }
  return payload;
}
