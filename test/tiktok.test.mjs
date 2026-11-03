/**
 * TikTok channel: connect (OAuth), signed webhook, customer messages + photos in the inbox, replies from the team,
 * TikTok's own rules (48-hour window, 10 messages in a row – TikTok chats ONLY) and the package switch –
 * through a fake TikTok API.
 *
 * Run the API with
 *   TIKTOK_APP_ID=tt-test-app  TIKTOK_APP_SECRET=tt-test-secret
 *   TIKTOK_API_BASE_URL=http://127.0.0.1:4598  TIKTOK_AUTH_BASE_URL=http://127.0.0.1:4598  TIKTOK_ECHO_DELAY_MS=100
 *   PUBLIC_API_BASE_URL=https://localhost:3001/v1/api  APP_PUBLIC_URL=http://app.test
 * then:  node --test test/tiktok.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { API, api, closeDb, createWorkspace, freshIp, sql } from './helpers.mjs';

const SECRET = process.env.TIKTOK_APP_SECRET || 'tt-test-secret';
const BUSINESS = `tt-biz-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const TT_CHAT = `tt-conv-${randomBytes(4).toString('hex')}`;
const ID = randomBytes(3).toString('hex'); // message ids differ on every run
const mid = (name) => `${name}-${ID}`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const requests = [];
let sentCount = 0;

const tiktok = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const json = (() => { try { return JSON.parse(raw.toString()); } catch { return null; } })();
    requests.push({ method: req.method, path: url.pathname, body: json, query: Object.fromEntries(url.searchParams), headers: req.headers, size: raw.length });
    const send = (data, code = 0) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code, message: code ? 'error' : 'OK', data })); };
    if (url.pathname === '/photo.png') { res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
    if (url.pathname === '/tt_user/oauth2/token/') {
      if (json?.auth_code !== 'good-code') return send({}, 40001);
      return send({ open_id: BUSINESS, scope: 'user.info.basic,message.list.read,message.list.send,message.list.manage', access_token: 'act-1', refresh_token: 'rft-1', expires_in: 86400, refresh_token_expires_in: 2592000 });
    }
    if (url.pathname === '/business/get/') return send({ username: 'teststore', display_name: 'Test Store', profile_image: 'https://x/p.jpg' });
    if (url.pathname === '/business/webhook/list/') return send({ list: [] });
    if (url.pathname === '/business/webhook/update/') return send({});
    if (url.pathname === '/business/message/capabilities/get/') return send({ capability_infos: [{ capability_type: 'IMAGE_SEND', capability_result: true }] });
    if (url.pathname === '/business/message/media/upload/') return send({ media_id: 'media-up-1' });
    if (url.pathname === '/business/message/media/download/') return send({ download_url: 'http://127.0.0.1:4598/photo.png' });
    if (url.pathname === '/business/message/send/') { sentCount += 1; return send({ message: { message_id: `tt-out-${ID}-${sentCount}` } }); }
    return send({}, 40404);
  });
});

/** A signed TikTok webhook call. */
async function webhook(event, content, { age = 0, badSecret = false } = {}) {
  const body = JSON.stringify({ event, user_openid: BUSINESS, client_key: 'tt-test-app', create_time: Math.floor(Date.now() / 1000), content: JSON.stringify(content) });
  const t = Math.floor(Date.now() / 1000) - age;
  const s = createHmac('sha256', badSecret ? 'wrong' : SECRET).update(`${t}.${body}`).digest('hex');
  return api('POST', '/integrations/tiktok/webhook', { body, headers: { 'Tiktok-Signature': `t=${t},s=${s}` } });
}
const customerSays = (text, id = `tt-in-${randomBytes(4).toString('hex')}`) => webhook('im_receive_msg', {
  type: 'text', message_id: id, timestamp: Date.now(), conversation_id: TT_CHAT, text: { body: text },
  from: 'Nimal TikTok', from_user: { id: 'tt-user-77' }, to: 'teststore', to_user: { id: BUSINESS },
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value || Date.now() > end) return value;
    await wait(100);
  }
}

let owner;
let conversationId;

test.before(async () => {
  await new Promise((resolve) => tiktok.listen(4598, '127.0.0.1', resolve));
  owner = await createWorkspace('tiktok');
  await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [owner.companyId]);
});
test.after(async () => {
  await sql(`DELETE FROM tiktok_connection WHERE business_id = $1`, [BUSINESS]).catch(() => undefined);
  tiktok.close();
  await closeDb();
});

test('package: Free has no TikTok (like Instagram), Growth has it', async () => {
  const [free] = await sql(`SELECT limits FROM platform_package WHERE code = 'free'`);
  if (free && free.limits.instagram === false) assert.equal(free.limits.tiktok, false);
  const small = await createWorkspace('tiktok-free');
  const r = await api('GET', '/integrations/tiktok/status', { token: small.token });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  const ok = await api('GET', '/integrations/tiktok/status', { token: owner.token });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.data.connection, null);
  assert.equal(ok.data.rules.max_in_a_row, 10);
  assert.match(ok.data.redirect_uri, /\/integrations\/tiktok\/callback$/);
});

test('connect: TikTok login → callback saves the account and sets the webhook', async () => {
  const start = await api('POST', '/integrations/tiktok/connect', { token: owner.token });
  assert.equal(start.status, 201, JSON.stringify(start.json));
  const login = new URL(start.data.url);
  assert.equal(login.pathname, '/v2/auth/authorize');
  assert.equal(login.searchParams.get('client_key'), process.env.TIKTOK_APP_ID || 'tt-test-app');
  assert.match(login.searchParams.get('scope'), /message\.list\.send/);
  const state = login.searchParams.get('state');

  const bad = await fetch(`${API}/integrations/tiktok/callback?code=good-code&state=forged.state`, { redirect: 'manual', headers: { 'X-Forwarded-For': freshIp() } });
  assert.equal(bad.status, 302);
  assert.match(bad.headers.get('location'), /\/channels\/tiktok\?error=/);

  const back = await fetch(`${API}/integrations/tiktok/callback?code=good-code&state=${encodeURIComponent(state)}`, { redirect: 'manual', headers: { 'X-Forwarded-For': freshIp() } });
  assert.equal(back.status, 302);
  assert.match(back.headers.get('location'), /\/channels\/tiktok\?connected=teststore/);
  const hook = requests.find((r) => r.path === '/business/webhook/update/');
  assert.ok(hook, 'webhook was set');
  assert.match(hook.body.callback_url, /\/integrations\/tiktok\/webhook$/);
  assert.equal(hook.body.event_type, 'DIRECT_MESSAGE');

  const status = await api('GET', '/integrations/tiktok/status', { token: owner.token });
  assert.equal(status.data.connection.username, 'teststore');
  assert.equal(status.data.connection.status, 'CONNECTED');
  assert.equal(status.data.connection.token_ok, true);
});

test('webhook: wrong or old signatures are refused', async () => {
  assert.equal((await webhook('im_receive_msg', { type: 'text' }, { badSecret: true })).status, 403);
  assert.equal((await webhook('im_receive_msg', { type: 'text' }, { age: 3600 })).status, 403);
  const unsigned = await api('POST', '/integrations/tiktok/webhook', { body: { event: 'im_receive_msg' } });
  assert.equal(unsigned.status, 403);
});

test('customer messages arrive in the inbox as a TikTok chat (text, photo, same message twice once)', async () => {
  const r = await customerSays('Hi, is this dress available?', mid('tt-in-first'));
  assert.equal(r.status, 200);
  await customerSays('Hi, is this dress available?', mid('tt-in-first')); // TikTok retry
  const rows = await until(async () => {
    const found = await sql(`SELECT m.*, c.id AS cid, cu.display_name, cu.source_account_id FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id
      JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id WHERE cu.platform = 'tiktok' AND cu.external_user_id = $1`, [TT_CHAT]);
    return found.length ? found : null;
  });
  assert.ok(rows, 'message saved');
  await wait(300);
  const again = await sql(`SELECT id FROM bot_message WHERE provider_message_id = $1`, [mid('tt-in-first')]);
  assert.equal(again.length, 1, 'duplicate skipped');
  assert.equal(rows[0].platform, 'tiktok');
  assert.equal(rows[0].direction, 'inbound');
  assert.equal(rows[0].display_name, 'Nimal TikTok');
  assert.equal(rows[0].source_account_id, BUSINESS);
  conversationId = Number(rows[0].cid);

  await webhook('im_receive_msg', {
    type: 'image', message_id: mid('tt-in-photo'), timestamp: Date.now(), conversation_id: TT_CHAT, image: { media_id: 'm-77' },
    from: 'Nimal TikTok', from_user: { id: 'tt-user-77' }, to_user: { id: BUSINESS },
  });
  const photo = await until(async () => (await sql(`SELECT * FROM bot_message WHERE provider_message_id = $1`, [mid('tt-in-photo')]))[0]);
  assert.equal(photo.message_type, 'image');
  assert.ok(photo.media_url, 'photo stored with the chat media');

  const list = await api('GET', '/bot/conversations?platform=tiktok', { token: owner.token });
  assert.equal(list.status, 200);
});

test('team reply goes to TikTok; the echo is not saved twice', async () => {
  const r = await api('POST', `/bot/conversations/${conversationId}/messages`, { token: owner.token, body: { text: 'Yes! Size M and L in stock.' } });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.json));
  const sent = requests.filter((x) => x.path === '/business/message/send/');
  const last = sent[sent.length - 1];
  assert.equal(last.body.recipient, TT_CHAT);
  assert.equal(last.body.recipient_type, 'CONVERSATION');
  assert.equal(last.body.business_id, BUSINESS);
  assert.equal(last.body.text.body, 'Yes! Size M and L in stock.');
  assert.equal(last.headers['access-token'], 'act-1');
  const providerId = `tt-out-${ID}-${sentCount}`;

  await webhook('im_send_msg', { type: 'text', message_id: providerId, timestamp: Date.now(), conversation_id: TT_CHAT, text: { body: 'Yes! Size M and L in stock.' }, from_user: { id: BUSINESS }, to_user: { id: 'tt-user-77' } });
  await wait(600);
  const out = await sql(`SELECT id FROM bot_message WHERE conversation_id = $1 AND direction::text = 'outbound'`, [conversationId]);
  assert.equal(out.length, 1, 'echo skipped');

  // a reply typed in the TikTok app itself shows in the inbox
  await webhook('im_send_msg', { type: 'text', message_id: mid('tt-app-1'), timestamp: Date.now(), conversation_id: TT_CHAT, text: { body: 'From the TikTok app' }, from_user: { id: BUSINESS }, to_user: { id: 'tt-user-77' } });
  const fromApp = await until(async () => (await sql(`SELECT * FROM bot_message WHERE provider_message_id = $1`, [mid('tt-app-1')]))[0]);
  assert.equal(fromApp.direction, 'outbound');
  assert.equal(fromApp.source, 'tiktok-app');
});

test('photo reply: uploaded then sent; only JPG / PNG', async () => {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'size-chart.png');
  form.append('caption', 'Size chart');
  const r = await api('POST', `/bot/conversations/${conversationId}/messages/media`, { token: owner.token, form });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.json));
  assert.ok(requests.some((x) => x.path === '/business/message/media/upload/'));
  const sent = requests.filter((x) => x.path === '/business/message/send/');
  assert.equal(sent[sent.length - 2].body.message_type, 'IMAGE');
  assert.equal(sent[sent.length - 2].body.image.media_id, 'media-up-1');
  assert.equal(sent[sent.length - 1].body.text.body, 'Size chart');

  const pdf = new FormData();
  pdf.append('file', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), 'a.pdf');
  const no = await api('POST', `/bot/conversations/${conversationId}/messages/media`, { token: owner.token, form: pdf });
  assert.equal(no.status, 400);
  assert.match(no.json.message, /JPG or PNG/);
});

test('TikTok rule: 10 messages in a row, then the customer must write again', async () => {
  const w = await api('GET', `/integrations/tiktok/window/${conversationId}`, { token: owner.token });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  assert.equal(w.data.max, 10);
  const already = w.data.sent; // reply + app reply + photo + caption
  assert.equal(already, 4);
  for (let i = already; i < 10; i += 1) {
    const r = await api('POST', `/bot/conversations/${conversationId}/messages`, { token: owner.token, body: { text: `Message ${i + 1}` } });
    assert.ok([200, 201].includes(r.status), `message ${i + 1}: ${JSON.stringify(r.json)}`);
  }
  const before = sentCount;
  const eleventh = await api('POST', `/bot/conversations/${conversationId}/messages`, { token: owner.token, body: { text: 'Message 11' } });
  assert.equal(eleventh.status, 400);
  assert.match(eleventh.json.message, /10 messages in a row/);
  assert.equal(sentCount, before, 'nothing sent to TikTok');
  const full = await api('GET', `/integrations/tiktok/window/${conversationId}`, { token: owner.token });
  assert.equal(full.data.messages_left, 0);
  assert.equal(full.data.open, false);

  await customerSays('Ok send the price');
  await until(async () => (await api('GET', `/integrations/tiktok/window/${conversationId}`, { token: owner.token })).data.sent === 0);
  const after = await api('POST', `/bot/conversations/${conversationId}/messages`, { token: owner.token, body: { text: 'Rs. 3,500' } });
  assert.ok([200, 201].includes(after.status), JSON.stringify(after.json));
});

test('TikTok rule: no replies 48 hours after the customer\'s last message', async () => {
  await sql(`UPDATE bot_message SET created_at = created_at - INTERVAL '49 hours' WHERE conversation_id = $1`, [conversationId]);
  const w = await api('GET', `/integrations/tiktok/window/${conversationId}`, { token: owner.token });
  assert.equal(w.data.hours_left, 0);
  assert.equal(w.data.open, false);
  const r = await api('POST', `/bot/conversations/${conversationId}/messages`, { token: owner.token, body: { text: 'Still there?' } });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /48 hours/);
});

test('read receipts from TikTok mark our messages as read', async () => {
  await customerSays('back again');
  await until(async () => (await api('GET', `/integrations/tiktok/window/${conversationId}`, { token: owner.token })).data.open);
  await api('POST', `/bot/conversations/${conversationId}/messages`, { token: owner.token, body: { text: 'Welcome back' } });
  await wait(200);
  await webhook('im_mark_read_msg', { conversation_id: TT_CHAT, read: { last_read_timestamp: Date.now() + 1000 }, from_user: { id: 'tt-user-77' } });
  const read = await until(async () => (await sql(`SELECT delivery_status FROM bot_message WHERE conversation_id = $1 AND content = 'Welcome back'`, [conversationId]))[0]?.delivery_status === 'read');
  assert.ok(read, 'marked read');
});

test('TikTok rules are TikTok only: the window endpoint refuses other chats; other channels have no 10-message limit', async () => {
  const [cu] = await sql(`INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name, language, language_locked, bot_enabled, manual_mode, created_at, updated_at)
    VALUES ($1, 'instagram', $2, 'IG customer', 'English', false, false, false, NOW(), NOW()) RETURNING id`, [owner.companyId, `ig-${randomBytes(3).toString('hex')}`]);
  const [conv] = await sql(`INSERT INTO bot_conversation (bot_channel_user_id, status, assignment_mode, created_at, updated_at, last_message_at)
    VALUES ($1, 'open', 'unassigned', NOW(), NOW(), NOW()) RETURNING id`, [cu.id]);
  const r = await api('GET', `/integrations/tiktok/window/${conv.id}`, { token: owner.token });
  assert.equal(r.status, 403);
  // other businesses cannot read this TikTok chat either
  const other = await createWorkspace('tiktok-other');
  await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [other.companyId]);
  assert.equal((await api('GET', `/integrations/tiktok/window/${conversationId}`, { token: other.token })).status, 403);
});

test('disconnect: new events are ignored, replies refused', async () => {
  const r = await api('POST', '/integrations/tiktok/disconnect', { token: owner.token });
  assert.equal(r.status, 201);
  await customerSays('after disconnect', mid('tt-in-after'));
  await wait(400);
  assert.equal((await sql(`SELECT id FROM bot_message WHERE provider_message_id = $1`, [mid('tt-in-after')])).length, 0);
});
