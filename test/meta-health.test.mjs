/**
 * Channels connection check: token made for another Meta app / temporary token, number not registered,
 * WhatsApp Business Account subscribed to the wrong (old) app, "Fix it" buttons, webhook delivery status,
 * signatures from a second app secret, platform verify token.
 *
 * Run the API with:
 *   META_GRAPH_BASE_URL=http://127.0.0.1:4599 META_APP_ID=new-app META_APP_SECRET=new-secret META_APP_SECRETS_EXTRA=old-secret
 *   META_OAUTH_REDIRECT_URI=http://localhost/cb META_WEBHOOK_VERIFY_TOKEN=platform-verify META_MESSAGING_VERIFY_TOKEN=msg-verify
 * then: node --test test/meta-health.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { API, api, closeDb, createWorkspace, sql } from './helpers.mjs';

const state = { subscribed: ['old-app'], registered: false, tokenApp: 'old-app', expires: 1_900_000_000, pageFields: [], pageScopes: ['pages_messaging'] };
const calls = [];
const meta = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^\/v[\d.]+/, '');
    calls.push(`${req.method} ${path}`);
    res.setHeader('Content-Type', 'application/json');
    const send = (data) => res.end(JSON.stringify(data));
    if (path === '/debug_token') {
      if (url.searchParams.get('input_token') === 'page-token') return send({ data: { app_id: 'new-app', is_valid: true, expires_at: 0, scopes: state.pageScopes } });
      return send({ data: { app_id: state.tokenApp, is_valid: true, expires_at: state.expires, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'] } });
    }
    if (path === '/pn-health') return send({ id: 'pn-health', display_phone_number: '+94 78 112 8220', verified_name: 'Shop', quality_rating: 'GREEN', platform_type: state.registered ? 'CLOUD_API' : 'NOT_APPLICABLE', status: state.registered ? 'CONNECTED' : 'PENDING' });
    if (path === '/pn-health/register' && req.method === 'POST') {
      if (JSON.parse(body).pin !== '123456') { res.statusCode = 400; return send({ error: { message: 'Two-step verification PIN mismatch' } }); }
      state.registered = true;
      return send({ success: true });
    }
    if (path === '/waba-health/subscribed_apps') {
      if (req.method === 'POST') { state.subscribed.push('new-app'); return send({ success: true }); }
      return send({ data: state.subscribed.map((id) => ({ whatsapp_business_api_data: { id, name: id === 'new-app' ? 'Agent Metra' : 'Old app' } })) });
    }
    if (path === '/page-health') return send({ id: 'page-health', name: 'Health Page' });
    if (path === '/page-health/subscribed_apps') {
      if (req.method === 'POST') { state.pageFields = url.searchParams.get('subscribed_fields').split(','); return send({ success: true }); }
      return send({ data: [{ id: 'old-app', name: 'Old app', subscribed_fields: ['messages'] }, ...(state.pageFields.length ? [{ id: 'new-app', name: 'Agent Metra', subscribed_fields: state.pageFields }] : [])] });
    }
    res.statusCode = 404;
    send({ error: { message: `not faked: ${req.method} ${path}` } });
  });
});

let owner;
const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const post = (path, body, signature) => fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Hub-Signature-256': signature } : {}) }, body });
const check = (list, key) => list.find((c) => c.key === key);

test.before(async () => {
  await new Promise((resolve) => meta.listen(4599, '127.0.0.1', resolve));
  // earlier runs used the same fake number / Page
  await sql(`UPDATE whatsapp_channels SET meta_phone_number_id = NULL WHERE meta_phone_number_id = 'pn-health'`);
  await sql(`DELETE FROM meta_page_connections WHERE page_id = 'page-health'`);
  owner = await createWorkspace('mhealth');
  await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [owner.companyId]);
  const saved = await api('PATCH', `/company/${owner.companyId}`, { token: owner.token, body: { whatsapp_provider_type: 'meta', meta_phone_number_id: 'pn-health', meta_access_token: 'manual-token', meta_waba_id: 'waba-health' } });
  assert.ok(saved.status < 300, JSON.stringify(saved.json));
  await sql(`INSERT INTO meta_page_connections (company_id, page_id, page_name, page_access_token, status, created_at, updated_at) VALUES ($1, 'page-health', 'Health Page', 'page-token', 'CONNECTED', NOW(), NOW())`, [owner.companyId]);
});
test.after(async () => { meta.close(); await closeDb(); });

test('connection check finds the old app, a temporary token and an unregistered number', async () => {
  const res = await api('GET', '/integrations/meta/health', { token: owner.token });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const wa = res.data.whatsapp;
  assert.equal(check(wa, 'token').ok, true);
  const token = check(wa, 'token_app');
  assert.equal(token.ok, false);
  assert.match(token.detail, /made for Meta app old-app/);
  assert.match(token.detail, /expires/);
  assert.equal(check(wa, 'registered').ok, false);
  assert.equal(check(wa, 'registered').fix, 'whatsapp_register');
  const hook = check(wa, 'webhook');
  assert.equal(hook.ok, false);
  assert.equal(hook.fix, 'whatsapp_subscribe');
  assert.match(hook.tech_detail, /Old app \(old-app\) – not this platform's Meta app/);
  assert.equal(hook.label, 'New messages come to your Inbox', 'plain words for the shop owner');
  assert.equal(check(wa, 'token_app').tech, true, 'platform checks are marked technical');
  const messenger = res.data.messenger;
  assert.equal(check(messenger, 'webhook').ok, false);
  assert.equal(check(messenger, 'webhook').fix, 'messenger_subscribe', 'another app subscribed does not count');
  assert.match(check(messenger, 'webhook').tech_detail, /Old app \(old-app\)/);
});

test('"Fix it": subscribe WhatsApp + Page, register the number with the PIN', async () => {
  const sub = await api('POST', '/integrations/meta/health/fix', { token: owner.token, body: { action: 'whatsapp_subscribe' } });
  assert.equal(sub.status, 201, JSON.stringify(sub.json));
  const wrongPin = await api('POST', '/integrations/meta/health/fix', { token: owner.token, body: { action: 'whatsapp_register', pin: '000000' } });
  assert.equal(wrongPin.status, 400);
  assert.match(JSON.stringify(wrongPin.json), /PIN mismatch/);
  const badPin = await api('POST', '/integrations/meta/health/fix', { token: owner.token, body: { action: 'whatsapp_register', pin: '12' } });
  assert.equal(badPin.status, 400);
  const reg = await api('POST', '/integrations/meta/health/fix', { token: owner.token, body: { action: 'whatsapp_register', pin: '123456' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const page = await api('POST', '/integrations/meta/health/fix', { token: owner.token, body: { action: 'messenger_subscribe' } });
  assert.equal(page.status, 201, JSON.stringify(page.json));
  assert.ok(state.pageFields.includes('messages'));
  const unknown = await api('POST', '/integrations/meta/health/fix', { token: owner.token, body: { action: 'drop_tables' } });
  assert.equal(unknown.status, 400);

  state.tokenApp = 'new-app';
  state.expires = 0;
  const res = await api('GET', '/integrations/meta/health', { token: owner.token });
  for (const key of ['token_app', 'registered', 'webhook']) assert.equal(check(res.data.whatsapp, key).ok, true, key);
  assert.equal(check(res.data.messenger, 'webhook').ok, true);
});

test('webhook delivery: refused signature is shown, the old app secret is accepted, verify token from env', async () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  assert.equal((await post('/integrations/whatsapp/webhook/meta', body, sign('someone-else', body))).status, 403);
  let res = await api('GET', '/integrations/meta/health', { token: owner.token });
  assert.equal(check(res.data.whatsapp, 'delivery').ok, false);
  assert.match(check(res.data.whatsapp, 'delivery').detail, /not the secret of the Meta app/);

  assert.equal((await post('/integrations/whatsapp/webhook/meta', body, sign('old-secret', body))).status, 200);
  assert.equal((await post('/integrations/whatsapp/webhook/meta', body, sign('new-secret', body))).status, 200);
  res = await api('GET', '/integrations/meta/health', { token: owner.token });
  assert.equal(check(res.data.whatsapp, 'delivery').ok, true);

  const page = JSON.stringify({ object: 'page', entry: [] });
  assert.equal((await post('/integrations/meta/messages/webhook', page, sign('wrong', page))).status, 403);
  assert.equal((await post('/integrations/meta/messages/webhook', page, sign('old-secret', page))).status, 200);
  res = await api('GET', '/integrations/meta/health', { token: owner.token });
  assert.equal(check(res.data.messenger, 'delivery').ok, true);

  const verify = await fetch(`${API}/integrations/whatsapp/webhook/meta?hub.mode=subscribe&hub.verify_token=platform-verify&hub.challenge=42`);
  assert.equal(await verify.text(), '42');
  const wrong = await fetch(`${API}/integrations/whatsapp/webhook/meta?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`);
  assert.notEqual(await wrong.text(), '42');
});

test('only the shop admin may press "Fix it"', async () => {
  const stranger = await createWorkspace('mhealth2');
  const res = await api('POST', '/integrations/meta/health/fix', { token: stranger.token, body: { action: 'whatsapp_subscribe' } });
  assert.equal(res.status, 400, 'a shop without WhatsApp cannot subscribe anything');
  assert.ok(!calls.some((c) => c.includes('undefined')));
});

test('Social: the "new permissions" bar uses what Meta really granted, not the saved list', async () => {
  await sql(`UPDATE meta_page_connections SET scopes = 'pages_show_list,pages_messaging' WHERE company_id = $1`, [owner.companyId]);
  let res = await api('GET', '/social/overview', { token: owner.token });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.data.missing_permissions.length, 7, 'token really lacks them → bar shown');
  state.pageScopes = ['pages_messaging', 'pages_manage_engagement', 'pages_read_user_content', 'pages_manage_posts', 'read_insights', 'instagram_manage_comments', 'instagram_content_publish', 'instagram_manage_insights'];
  res = await api('GET', '/social/overview', { token: owner.token });
  assert.deepEqual(res.data.missing_permissions, [], 'granted after reconnect → bar gone');
  const [row] = await sql(`SELECT scopes FROM meta_page_connections WHERE company_id = $1 AND status = 'CONNECTED'`, [owner.companyId]);
  assert.match(row.scopes, /instagram_content_publish/, 'real list saved');
});
