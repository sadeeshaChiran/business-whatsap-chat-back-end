/**
 * Security tests – run against a running API + TEST database:
 *   npm run build && npm run start:prod   (with the test .env)
 *   npm run test:security
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import {
  API, PASSWORD, RUN, api, closeDb, createAgent, createSuperAdmin, createWorkspace, login, sendInboundWhatsapp, signJwt, sql,
} from './helpers.mjs';

const routes = JSON.parse(execFileSync(process.execPath, ['scripts/list-routes.js', '--json'], { encoding: 'utf8' }));
const fill = (path) => path.replace(/:[a-zA-Z_]+/g, '1').replace(/\*path/, 'x');

let A; // workspace A admin
let B; // workspace B admin (attacker)
let agentA;
let superAdmin;
let productA;
let conversationA;
let orderA;
const PHONE_ID_A = `pn-a-${RUN}`;

before(async () => {
  A = await createWorkspace('sec-a');
  B = await createWorkspace('sec-b');
  agentA = await createAgent(A, 'sec-agent-a');
  superAdmin = await createSuperAdmin();

  // workspace A data: category, product, WhatsApp (fake Meta number), one customer chat
  const category = await api('POST', '/product-catergory', { token: A.token, body: { name: `Shoes ${RUN}` } });
  assert.equal(category.status, 201, JSON.stringify(category.json));
  const product = await api('POST', '/products', {
    token: A.token,
    body: { name: 'Red shoe', price: 2500, quantity: 5, category_id: category.data.id, weight: 0.5 },
  });
  assert.equal(product.status, 201, JSON.stringify(product.json));
  productA = product.data;

  const wa = await api('PATCH', `/company/${A.companyId}`, {
    token: A.token,
    body: { whatsapp_provider_type: 'meta', meta_phone_number_id: PHONE_ID_A, meta_access_token: 'test-token', meta_waba_id: 'waba-a' },
  });
  assert.equal(wa.status, 200, JSON.stringify(wa.json));
  const inbound = await sendInboundWhatsapp(PHONE_ID_A, '94770000001', 'Hello, is the red shoe available?');
  assert.equal(inbound.status, 200, JSON.stringify(inbound.json));
  const [conv] = await sql(
    `SELECT c.id FROM bot_conversation c JOIN bot_channel_user u ON u.id = c.bot_channel_user_id WHERE u.company_id = $1 ORDER BY c.id DESC LIMIT 1`,
    [A.companyId],
  );
  conversationA = conv?.id;
  assert.ok(conversationA, 'inbound WhatsApp message created a conversation');
  const [channelUser] = await sql(`SELECT id FROM bot_channel_user WHERE company_id = $1 LIMIT 1`, [A.companyId]);
  const order = await api('POST', '/bot/orders', {
    token: A.token,
    body: { bot_channel_user_id: channelUser.id, customer_name: 'Test Customer', items: [{ product_name: 'Red shoe', quantity: 1, unit_price: 2500 }] },
  });
  orderA = order.status === 201 ? order.data.order : null;
  assert.ok(orderA?.id, `order created: ${JSON.stringify(order.json)}`);
});

after(closeDb);

describe('1. Authentication', () => {
  test('every protected route refuses requests without a token (401)', async () => {
    const protectedRoutes = routes.filter((r) => r.auth);
    assert.ok(protectedRoutes.length > 150, `found ${protectedRoutes.length} protected routes`);
    const failures = [];
    for (const route of protectedRoutes) {
      const r = await api(route.method === 'ALL' ? 'GET' : route.method, fill(route.path).replace('/v1/api', ''), { body: route.method === 'GET' ? undefined : {} });
      if (r.status !== 401) failures.push(`${route.method} ${route.path} → ${r.status}`);
    }
    assert.deepEqual(failures, []);
  });

  test('only the expected routes are public', () => {
    const allowed = [
      /^\/v1\/api$/, /^\/v1\/api\/auth\/(login|google|register|register\/start|register\/resend|register\/verify|password\/forgot|password\/reset)$/,
      /^\/v1\/api\/integrations\/meta\/callback$/, /^\/v1\/api\/integrations\/meta\/messages\/webhook$/,
      /^\/v1\/api\/integrations\/whatsapp\/(n8n\/send|webhook|webhook\/evolution|webhook\/meta)$/, /^\/v1\/api\/public\//,
      // short links (/l/:slug – served outside the /v1/api prefix; the route lister adds the prefix)
      /^\/v1\/api\/l\/:slug$/,
    ];
    const unexpected = routes.filter((r) => !r.auth && !allowed.some((re) => re.test(r.path))).map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(unexpected, []);
  });

  test('token signed with the old built-in secret is refused', async () => {
    const now = Math.floor(Date.now() / 1000);
    const forged = signJwt({ sub: A.user.id, company_id: A.companyId, iat: now, exp: now + 3600 }, 'business-health-scanner-secret');
    assert.equal((await api('GET', '/auth/me', { token: forged })).status, 401);
    const forged2 = signJwt({ sub: A.user.id, company_id: A.companyId, iat: now, exp: now + 3600 }, 'change-me');
    assert.equal((await api('GET', '/auth/me', { token: forged2 })).status, 401);
  });

  test('alg "none" and tampered tokens are refused', async () => {
    const [h, p] = A.token.split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`;
    assert.equal((await api('GET', '/auth/me', { token: none })).status, 401);
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.company_id = B.companyId;
    const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${A.token.split('.')[2]}`;
    assert.equal((await api('GET', '/auth/me', { token: tampered })).status, 401);
  });

  test('wrong password → 401 with a generic message (no account enumeration)', async () => {
    const wrong = await login(A.email, 'WrongPass999');
    const unknown = await login(`nobody-${RUN}@test.agentmetra.lk`, 'WrongPass999');
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.json.message, unknown.json.message);
  });

  test('account locks after 8 wrong passwords (429), then works again after the lock', async () => {
    const victim = await createWorkspace('sec-lock');
    for (let i = 0; i < 8; i += 1) await login(victim.email, `Wrong${i}pass1`);
    const locked = await login(victim.email, PASSWORD);
    assert.equal(locked.status, 429);
    await sql('UPDATE app_user SET locked_until = NULL WHERE LOWER(email) = $1', [victim.email]);
    assert.equal((await login(victim.email, PASSWORD)).status, 200);
  });

  test('login is rate limited per IP (429 after 10/min)', async () => {
    const ip = '203.0.113.77';
    const statuses = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await api('POST', '/auth/login', { ip, body: { email: `rl-${i}@x.lk`, password: 'Abcdefg1' } })).status);
    assert.ok(statuses.includes(429), `statuses: ${statuses.join(',')}`);
  });

  test('change password signs out other sessions', async () => {
    const ws = await createWorkspace('sec-pass');
    const second = (await login(ws.email)).data.access_token;
    const changed = await api('POST', '/auth/change-password', { token: ws.token, body: { current_password: PASSWORD, new_password: 'NewPass12345' } });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    assert.equal((await api('GET', '/auth/me', { token: second })).status, 401, 'old session ended');
    assert.equal((await api('GET', '/auth/me', { token: changed.data.access_token })).status, 200, 'new token works');
    assert.equal((await login(ws.email, PASSWORD)).status, 401);
    assert.equal((await login(ws.email, 'NewPass12345')).status, 200);
  });

  test('forgot password: code by email, then reset (and same answer for unknown emails)', async () => {
    const ws = await createWorkspace('sec-forgot');
    const unknown = await api('POST', '/auth/password/forgot', { body: { email: `nobody-${RUN}@x.lk` } });
    const known = await api('POST', '/auth/password/forgot', { body: { email: ws.email } });
    assert.equal(unknown.status, 200);
    assert.equal(known.status, 200);
    assert.equal(unknown.json.data.message, known.json.data.message);
    const badCode = await api('POST', '/auth/password/reset', { body: { email: ws.email, code: '000000', new_password: 'Reset12345x' } });
    assert.equal(badCode.status, 400);
    const reset = await api('POST', '/auth/password/reset', { body: { email: ws.email, code: known.data.dev_code, new_password: 'Reset12345x' } });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    assert.equal((await api('GET', '/auth/me', { token: ws.token })).status, 401, 'sessions ended after reset');
    assert.equal((await login(ws.email, 'Reset12345x')).status, 200);
  });

  test('weak passwords are refused on sign-up and agent creation', async () => {
    const r = await api('POST', '/auth/register/start', {
      body: { name: 'Weak', email: `weak-${RUN}@x.lk`, password: 'short', whatsapp: '94771112223', company: { name: 'Weak Co' } },
    });
    assert.equal(r.status, 400);
    const agent = await api('POST', '/users/agents', { token: A.token, body: { name: 'Weak Agent', email: `weak-agent-${RUN}@x.lk`, password: 'password' } });
    assert.equal(agent.status, 400);
    const noPassword = await api('POST', '/users/agents', { token: A.token, body: { name: 'No Pass', email: `nopass-${RUN}@x.lk` } });
    assert.equal(noPassword.status, 400, 'no default password any more');
  });
});

describe('2. Company admin vs agent permissions', () => {
  const adminOnly = [
    ['PATCH', () => `/company/${A.companyId}`, { name: 'Hacked by agent' }],
    ['POST', () => '/products', { name: 'x', category_id: 1, weight: 1 }],
    ['DELETE', () => `/products/${productA.id}`],
    ['PATCH', () => `/products/${productA.id}`, { name: 'x' }],
    ['POST', () => '/product-catergory', { name: 'x' }],
    ['GET', () => '/users/agents'],
    ['POST', () => '/users/agents', { name: 'x', email: 'x@y.lk', password: 'Abcdefg123' }],
    ['POST', () => `/users/agents/${agentA.id}/reset-password`, { password: 'Abcdefg123' }],
    ['POST', () => `/users/agents/${agentA.id}/disable`],
    ['GET', () => '/bot/stats'],
    ['GET', () => '/bot/users'],
    ['GET', () => '/bot/conversations'],
    ['GET', () => '/bot/orders'],
    ['POST', () => '/bot/train', { question: 'q', answer: 'a' }],
    ['GET', () => '/bot/train/history'],
    ['GET', () => '/bot/sales-bot/settings'],
    ['PATCH', () => '/bot/sales-bot/settings', {}],
    ['GET', () => '/automation/flows'],
    ['GET', () => '/billing/overview'],
    ['GET', () => '/integrations/whatsapp/config'],
    ['GET', () => '/integrations/meta/health'],
    ['POST', () => '/bot/train/upload'],
  ];
  for (const [method, path, body] of adminOnly) {
    test(`agent gets 403 on ${method} ${path.toString().match(/`(.*)`|'(.*)'/)?.slice(1).find(Boolean)}`, async () => {
      const r = await api(method, path(), { token: agentA.token, body });
      assert.equal(r.status, 403, `${method} ${path()} → ${r.status} ${JSON.stringify(r.json)}`);
    });
  }

  test('agent CAN use agent features (own chats, orders, labels, notes, team board, products list)', async () => {
    for (const path of ['/bot/agent/conversations', '/bot/agent/orders', '/bot/labels', '/bot/notes', '/users/agents/stats', '/products', '/company', '/notifications', '/bot/sales-bot/sells']) {
      const r = await api('GET', path, { token: agentA.token });
      assert.equal(r.status, 200, `${path} → ${r.status} ${JSON.stringify(r.json)}`);
    }
  });

  test('agent sees the company without integration secrets', async () => {
    const admin = await api('GET', '/company', { token: A.token });
    const agent = await api('GET', '/company', { token: agentA.token });
    assert.equal(agent.status, 200);
    assert.equal(agent.data.meta_verify_token, null);
    assert.equal(agent.data.whatsapp_evaluation_key, null);
    assert.equal(admin.data.meta_phone_number_id, PHONE_ID_A);
  });

  test('company cannot be deleted through the API', async () => {
    const r = await api('DELETE', `/company/${A.companyId}`, { token: A.token });
    assert.equal(r.status, 404);
  });

  test('team lists never contain password hashes', async () => {
    const list = await api('GET', '/users/agents', { token: A.token });
    const stats = await api('GET', '/users/agents/stats', { token: agentA.token });
    const text = JSON.stringify([list.json, stats.json]);
    for (const secret of ['password_hash', 'token_version', 'failed_login_count', 'locked_until']) assert.ok(!text.includes(secret), `${secret} leaked`);
  });

  test('agent cannot open a chat that is not assigned to them', async () => {
    const r = await api('GET', `/bot/conversations/${conversationA}`, { token: agentA.token });
    assert.equal(r.status, 403);
  });

  test('removed agent: refused at login and the existing session ends; restore works', async () => {
    const agent = await createAgent(A, 'sec-agent-remove');
    const off = await api('POST', `/users/agents/${agent.id}/disable`, { token: A.token });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.equal((await api('GET', '/auth/me', { token: agent.token })).status, 401);
    assert.equal((await login(agent.email)).status, 403);
    assert.equal((await api('POST', `/users/agents/${agent.id}/enable`, { token: A.token })).status, 200);
    assert.equal((await login(agent.email)).status, 200);
  });

  test('admin resets an agent password → agent signed out, new password works', async () => {
    const agent = await createAgent(A, 'sec-agent-reset');
    const r = await api('POST', `/users/agents/${agent.id}/reset-password`, { token: A.token, body: { password: 'Brandnew123' } });
    assert.equal(r.status, 200);
    assert.equal((await api('GET', '/auth/me', { token: agent.token })).status, 401);
    assert.equal((await login(agent.email, 'Brandnew123')).status, 200);
  });

  test('admin cannot remove themselves through agent management', async () => {
    const r = await api('POST', `/users/agents/${A.user.id}/disable`, { token: A.token });
    assert.equal(r.status, 400);
  });

  test('Free package agent limit (3) is enforced', async () => {
    const ws = await createWorkspace('sec-limit');
    for (let i = 0; i < 3; i += 1) await createAgent(ws, `sec-limit-${i}`);
    const fourth = await api('POST', '/users/agents', { token: ws.token, body: { name: 'Fourth', email: `fourth-${RUN}@x.lk`, password: PASSWORD } });
    assert.equal(fourth.status, 400);
    assert.match(fourth.json.message, /allows 3 agents/);
  });
});

describe('3. Tenant isolation (workspace B attacking workspace A)', () => {
  test('cannot read or change workspace A company', async () => {
    assert.equal((await api('GET', `/company/${A.companyId}`, { token: B.token })).status, 404);
    assert.equal((await api('PATCH', `/company/${A.companyId}`, { token: B.token, body: { name: 'pwned' } })).status, 404);
  });

  test('cannot read, change or delete workspace A product', async () => {
    assert.equal((await api('GET', `/products/${productA.id}`, { token: B.token })).status, 404);
    assert.equal((await api('PATCH', `/products/${productA.id}`, { token: B.token, body: { name: 'pwned' } })).status, 404);
    assert.equal((await api('DELETE', `/products/${productA.id}`, { token: B.token })).status, 404);
    const list = await api('GET', '/products', { token: B.token });
    assert.ok(!JSON.stringify(list.json).includes('Red shoe'));
  });

  test('cannot open, message or assign workspace A conversation', async () => {
    const read = await api('GET', `/bot/conversations/${conversationA}`, { token: B.token });
    assert.ok([403, 404].includes(read.status), `read → ${read.status}`);
    const send = await api('POST', `/bot/conversations/${conversationA}/messages`, { token: B.token, body: { text: 'spam' } });
    assert.ok([403, 404].includes(send.status), `send → ${send.status}`);
    const assign = await api('POST', `/bot/conversations/${conversationA}/assign`, { token: B.token, body: { agent_id: agentA.id } });
    assert.ok([400, 403, 404].includes(assign.status), `assign → ${assign.status}`);
    const labels = await api('POST', `/bot/conversations/${conversationA}/labels`, { token: B.token, body: { label_ids: [] } });
    assert.ok([403, 404].includes(labels.status), `labels → ${labels.status}`);
  });

  test('cannot see or change workspace A orders', async () => {
    const list = await api('GET', '/bot/orders', { token: B.token });
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.json).includes('Test Customer'));
    if (orderA) {
      const update = await api('POST', `/bot/orders/${orderA.id}/status`, { token: B.token, body: { status: 'Cancelled' } });
      assert.ok([403, 404].includes(update.status), `status → ${update.status}`);
      const del = await api('DELETE', `/bot/orders/${orderA.id}`, { token: B.token });
      assert.ok([403, 404].includes(del.status), `delete → ${del.status}`);
    }
  });

  test('cannot manage workspace A agents', async () => {
    assert.equal((await api('POST', `/users/agents/${agentA.id}/reset-password`, { token: B.token, body: { password: 'Pwned12345' } })).status, 404);
    assert.equal((await api('POST', `/users/agents/${agentA.id}/disable`, { token: B.token })).status, 404);
    assert.equal((await api('PATCH', `/users/agents/${agentA.id}/work-status`, { token: B.token, body: { status: 'offline' } })).status, 404);
  });

  test('cannot create shared (all-workspace) product categories', async () => {
    const r = await api('POST', '/product-catergory', { token: B.token, body: { name: `Global ${RUN}`, is_common: true } });
    assert.equal(r.status, 403);
  });

  test('cannot listen to workspace A real-time channel', async () => {
    const r = await api('POST', '/realtime/auth', { token: B.token, body: { socket_id: '123.456', channel_name: `private-company-${A.companyId}` } });
    assert.equal(r.status, 403);
  });

  test('cannot read workspace A invoices or bot training', async () => {
    const invoice = await api('GET', '/billing/payments/1/invoice', { token: B.token });
    assert.ok([403, 404].includes(invoice.status));
    const training = await api('GET', '/bot/train/history', { token: B.token });
    assert.equal(training.status, 200);
    assert.ok(!JSON.stringify(training.json).includes(`sec-a`));
  });
});

describe('4. Super admin', () => {
  test('company admin and agent cannot use super admin APIs', async () => {
    const superRoutes = routes.filter((r) => r.super_admin && r.method === 'GET' && !r.path.includes(':'));
    assert.ok(superRoutes.length >= 10);
    for (const route of superRoutes) {
      const path = route.path.replace('/v1/api', '');
      assert.equal((await api('GET', path, { token: A.token })).status, 403, `admin → ${path}`);
      assert.equal((await api('GET', path, { token: agentA.token })).status, 403, `agent → ${path}`);
    }
  });

  test('super admin can open every super admin page API', async () => {
    const superRoutes = routes.filter((r) => r.super_admin && r.method === 'GET' && !r.path.includes(':') && !r.path.includes('export'));
    for (const route of superRoutes) {
      const r = await api('GET', route.path.replace('/v1/api', ''), { token: superAdmin.token });
      assert.equal(r.status, 200, `${route.path} → ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
    }
    const detail = await api('GET', `/super-admin/companies/${A.companyId}/360`, { token: superAdmin.token });
    assert.equal(detail.status, 200);
  });

  test('suspending a workspace signs its users out and blocks login; re-activating restores', async () => {
    const ws = await createWorkspace('sec-suspend');
    const agent = await createAgent(ws, 'sec-suspend-agent');
    const off = await api('PATCH', `/super-admin/companies/${ws.companyId}/status`, { token: superAdmin.token, body: { status: 'SUSPENDED' } });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.equal((await api('GET', '/auth/me', { token: ws.token })).status, 401);
    assert.equal((await api('GET', '/auth/me', { token: agent.token })).status, 401);
    assert.equal((await login(ws.email)).status, 403);
    await api('PATCH', `/super-admin/companies/${ws.companyId}/status`, { token: superAdmin.token, body: { status: 'ACTIVE' } });
    assert.equal((await login(ws.email)).status, 200);
  });

  test('branding: only the super admin can change it; the website reads it without login', async () => {
    const before = (await api('GET', '/public/branding')).data;
    assert.ok(before?.name, 'public branding has a name');
    for (const token of [A.token, agentA.token]) {
      assert.equal((await api('PATCH', '/super-admin/branding', { token, body: { name: 'Hacked' } })).status, 403);
    }
    assert.equal((await api('PATCH', '/super-admin/branding', { token: superAdmin.token, body: { primary_color: 'red' } })).status, 400);
    assert.equal((await api('PATCH', '/super-admin/branding', { token: superAdmin.token, body: { website: 'javascript:alert(1)' } })).status, 400);
    const saved = await api('PATCH', '/super-admin/branding', { token: superAdmin.token, body: { tagline: `Test ${RUN}`, primary_color: '#0D9488', support_email: 'help@example.com' } });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const after = (await api('GET', '/public/branding')).data;
    assert.equal(after.tagline, `Test ${RUN}`);
    assert.equal(after.primary_color, '#0d9488');
    // SVG logo with a script is refused; a PNG works and is served with a locked-down content policy
    const svg = new FormData();
    svg.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: 'image/svg+xml' }), 'logo.svg');
    assert.equal((await api('POST', '/super-admin/branding/logo', { token: superAdmin.token, form: svg })).status, 400);
    const png = new FormData();
    png.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'logo.png');
    const logo = await api('POST', '/super-admin/branding/logo', { token: superAdmin.token, form: png });
    assert.equal(logo.status, 201, JSON.stringify(logo.json));
    const file = await fetch(`${API}${logo.data.logo_url}`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-security-policy') ?? '', /sandbox/);
    await api('PATCH', '/super-admin/branding', { token: superAdmin.token, body: { tagline: before.tagline, primary_color: before.primary_color, support_email: before.support_email } });
    await api('DELETE', '/super-admin/branding/logo', { token: superAdmin.token });
  });
});

describe('5. Webhooks, input and transport', () => {
  test('WhatsApp webhook without a valid signature is refused', async () => {
    if (!process.env.META_APP_SECRET) return;
    const body = { object: 'whatsapp_business_account', entry: [] };
    assert.equal((await api('POST', '/integrations/whatsapp/webhook/meta', { body })).status, 403);
    assert.equal((await api('POST', '/integrations/whatsapp/webhook/meta', { body, headers: { 'X-Hub-Signature-256': 'sha256=deadbeef' } })).status, 403);
  });

  test('n8n send endpoint needs the internal key', async () => {
    const r = await api('POST', '/integrations/whatsapp/n8n/send', { body: { company_id: A.companyId, phone: '94770000001', text: 'x' } });
    assert.equal(r.status, 401);
  });

  test('unknown fields are refused with a readable message', async () => {
    const r = await api('PATCH', `/company/${A.companyId}`, { token: A.token, body: { is_super_admin: true } });
    assert.equal(r.status, 400);
    assert.match(r.json.message, /not allowed/i);
  });

  test('SQL injection text in search is treated as text', async () => {
    for (const q of ["' OR 1=1 --", "'; DROP TABLE app_user; --", '%']) {
      const r = await api('GET', `/bot/users?search=${encodeURIComponent(q)}`, { token: A.token });
      assert.ok([200, 400].includes(r.status), `search ${q} → ${r.status}`);
    }
    const [row] = await sql('SELECT COUNT(*)::int AS n FROM app_user');
    assert.ok(row.n > 0, 'app_user table still there');
  });

  test('errors have one shape and never leak internals', async () => {
    const notFound = await api('GET', '/does-not-exist', { token: A.token });
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.success, false);
    assert.equal(typeof notFound.json.message, 'string');
    const badJson = await api('POST', '/auth/login', { body: '{"email":', headers: {} });
    assert.equal(badJson.status, 400);
    assert.ok(!/stack|at \w+ \(|QueryFailedError|SELECT /i.test(JSON.stringify(badJson.json)));
  });

  test('security headers are set and CORS refuses unknown sites', async () => {
    const response = await fetch(`${API}/public/packages`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('strict-transport-security'));
    assert.equal(response.headers.get('x-powered-by'), null);
    const acao = response.headers.get('access-control-allow-origin');
    assert.ok(acao !== '*' && acao !== 'https://evil.example', `ACAO=${acao}`);
  });

  test('responses are compressed', async () => {
    const response = await fetch(`${API}/public/packages`, { headers: { 'Accept-Encoding': 'gzip' } });
    const length = Number(response.headers.get('content-length') || 0);
    assert.ok(response.headers.get('content-encoding') === 'gzip' || length < 1024);
  });
});
