/**
 * Shared helpers for the API test suites (node --test). They talk to a RUNNING API with a TEST database.
 *
 *   API_URL=http://localhost:3001/v1/api
 *   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/agentmetra_test   (same DB as the API)
 *   META_APP_SECRET=...   (same value as the API, used to sign test webhooks)
 *
 * Missing values are read from ../.env (the API's own settings), so usually nothing needs to be set.
 * The API must run with OTP_DEV_MODE=true (codes are returned in responses) and NODE_ENV != production.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

// fall back to the API's .env for the test settings
try {
  const { readFileSync } = require('node:fs');
  const env = Object.fromEntries(
    readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*['"]?(.*?)['"]?\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]),
  );
  process.env.META_APP_SECRET ??= env.META_APP_SECRET;
  process.env.TEST_DATABASE_URL ??= env.PRODUCT_DATABASE_URL;
} catch { /* no .env – use the environment */ }

export const API = (process.env.API_URL || 'http://localhost:3001/v1/api').replace(/\/+$/, '');
export const RUN = Date.now().toString(36) + randomBytes(2).toString('hex');
export const PASSWORD = 'Test1234pass';

const IP_BASE = randomBytes(1)[0] % 200 + 20; // different client addresses on every run (rate limits are per address)
let ipCounter = 1;
/** Every test client gets its own fake IP so rate limits of one test do not affect another. */
export const freshIp = () => `10.${IP_BASE}.${Math.floor(ipCounter / 250) % 250}.${(ipCounter++ % 250) + 1}`;

export async function api(method, path, { token, body, ip, headers = {}, raw = false, form } = {}) {
  const init = { method, headers: { 'X-Forwarded-For': ip || freshIp(), ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (form) init.body = form;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const started = performance.now();
  const response = await fetch(`${API}${path}`, init);
  const ms = performance.now() - started;
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, text: raw ? text : undefined, headers: response.headers, ms, data: json?.data };
}

let db;
export async function sql(query, params = []) {
  if (!db) {
    db = new Client({ connectionString: process.env.TEST_DATABASE_URL || 'postgresql://postgres@localhost:5432/agentmetra' });
    await db.connect();
  }
  return (await db.query(query, params)).rows;
}
export async function closeDb() { if (db) await db.end(); db = null; }

/** Sign-up with email + WhatsApp codes (dev mode), choose the Free package. */
export async function createWorkspace(label, { plan = 'free', category = 'product' } = {}) {
  const email = `${label}-${RUN}@test.agentmetra.lk`.toLowerCase();
  const phone = `9477${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const start = await api('POST', '/auth/register/start', {
    body: { name: `${label} Owner`, email, password: PASSWORD, whatsapp: phone, company: { name: `${label} Store ${RUN}`, category } },
  });
  if (start.status !== 201) throw new Error(`register/start failed: ${start.status} ${JSON.stringify(start.json)}`);
  const codes = start.data.dev_codes;
  const verify = await api('POST', '/auth/register/verify', {
    body: { registration_id: start.data.registration_id, email_code: codes.email, whatsapp_code: codes.whatsapp },
  });
  if (verify.status !== 201) throw new Error(`register/verify failed: ${verify.status} ${JSON.stringify(verify.json)}`);
  const token = verify.data.access_token;
  const user = verify.data.user;
  if (plan) {
    const r = await api('PATCH', `/company/${user.company_id}`, { token, body: { plan } });
    if (r.status !== 200) throw new Error(`choose plan failed: ${r.status} ${JSON.stringify(r.json)}`);
  }
  return { email, token, user, companyId: user.company_id };
}

export async function login(email, password = PASSWORD) {
  const r = await api('POST', '/auth/login', { body: { email, password } });
  return r;
}

export async function createAgent(admin, label) {
  const email = `${label}-${RUN}@test.agentmetra.lk`.toLowerCase();
  const r = await api('POST', '/users/agents', { token: admin.token, body: { name: `${label} Agent`, email, password: PASSWORD } });
  if (r.status !== 201) throw new Error(`create agent failed: ${r.status} ${JSON.stringify(r.json)}`);
  const session = await login(email);
  return { email, id: r.data.id, token: session.data.access_token, user: session.data.user };
}

export async function createSuperAdmin() {
  const ws = await createWorkspace('super', { plan: null });
  await sql('UPDATE app_user SET is_super_admin = TRUE WHERE id = $1', [ws.user.id]);
  const session = await login(ws.email);
  return { ...ws, token: session.data.access_token };
}

/** HS256 token signed with any secret (to prove forged tokens are refused). */
export function signJwt(payload, secret, header = { alg: 'HS256', typ: 'JWT' }) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const content = `${enc(header)}.${enc(payload)}`;
  return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`;
}

/** WhatsApp Cloud API style inbound message, signed with META_APP_SECRET. */
export async function sendInboundWhatsapp(phoneNumberId, from, text, name = 'Test Customer') {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba-test',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '94110000000', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name }, wa_id: from }],
          messages: [{ from, id: `wamid.${RUN}.${randomBytes(6).toString('hex')}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
        },
      }],
    }],
  });
  const secret = process.env.META_APP_SECRET || '';
  const signature = secret ? `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` : undefined;
  return api('POST', '/integrations/whatsapp/webhook/meta', {
    body,
    headers: signature ? { 'X-Hub-Signature-256': signature } : {},
  });
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
