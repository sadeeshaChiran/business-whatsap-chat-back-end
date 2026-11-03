/**
 * SMS with the business's own Notify.lk account: connect (keys checked, key never shown again), campaigns to tags /
 * all contacts / typed numbers with {name}, Sinhala as Unicode, the do-not-SMS list, stop on "no credit", the SMS saved
 * in the customer's chat (not shown inside the customer app), one SMS from an Inbox chat, agents only for their chats.
 * Run the API with SMS_PROVIDER_BASE_URL=http://127.0.0.1:4596 (this file starts the fake Notify.lk there).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { api, closeDb, createAgent, createWorkspace, sql } from './helpers.mjs';

const sent = [];
let credit = true;
const fake = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  res.setHeader('content-type', 'application/json');
  if (q.api_key !== 'good-key-123456') return res.end(JSON.stringify({ status: 'error', message: 'Invalid API key' }));
  if (url.pathname.endsWith('/status')) return res.end(JSON.stringify({ status: 'success', data: { active: true, acc_balance: 1234.5 } }));
  if (url.pathname.endsWith('/send')) {
    if (!credit) return res.end(JSON.stringify({ status: 'error', message: 'Insufficient balance' }));
    sent.push(q);
    return res.end(JSON.stringify({ status: 'success', data: 'Sent' }));
  }
  res.statusCode = 404; res.end('{}');
});

const rnd = () => `9477${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
let shop;
const people = {};
const until = async (fn, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 400)); }
};

async function contact(name, phone, tags = []) {
  const [cu] = await sql(`INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name) VALUES ($1, 'whatsapp', $2, $3) RETURNING id`, [shop.companyId, phone, name]);
  await sql(`INSERT INTO crm_contact (bot_channel_user_id, company_id, tags) VALUES ($1, $2, $3)`, [cu.id, shop.companyId, tags]);
  const [conv] = await sql(`INSERT INTO bot_conversation (bot_channel_user_id, status) VALUES ($1, 'open') RETURNING id`, [cu.id]);
  return { id: cu.id, phone, conversation: conv.id };
}

test.before(async () => {
  await new Promise((r) => fake.listen(4596, '127.0.0.1', r));
  shop = await createWorkspace('sms');
  people.a = await contact('Nimal Perera', rnd(), ['grade10']);
  people.b = await contact('Kamala Silva', rnd(), ['grade10', 'vip']);
  people.c = await contact('Sunil Fernando', rnd(), ['grade11']);
});
test.after(async () => { await closeDb(); fake.close(); });

test('connect: wrong keys are refused; the key is never sent back', async () => {
  const bad = await api('PUT', '/sms/settings', { token: shop.token, body: { user_id: '12345', api_key: 'wrong-key-99999', sender_id: 'VORAKIDS' } });
  assert.equal(bad.status, 400);
  assert.equal((await api('PUT', '/sms/settings', { token: shop.token, body: { user_id: '12345', api_key: 'good-key-123456', sender_id: 'x' } })).status, 400, 'sender name too short');
  const ok = await api('PUT', '/sms/settings', { token: shop.token, body: { user_id: '12345', api_key: 'good-key-123456', sender_id: 'VORAKIDS' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.data.connected, true);
  assert.equal(ok.data.balance, 1234.5);
  assert.equal(JSON.stringify(ok.data).includes('good-key-123456'), false);
  assert.equal(ok.data.api_key_hint, '••••3456');
  const test1 = await api('POST', '/sms/test', { token: shop.token, body: { to: '0771234567' } });
  assert.equal(test1.status, 201, JSON.stringify(test1.json));
  assert.equal(sent.at(-1).to, '94771234567');
  assert.equal(sent.at(-1).sender_id, 'VORAKIDS');
});

test('campaign to a tag + typed numbers: {name}, opted-out numbers skipped, saved in each chat', async () => {
  await api('PUT', '/sms/optouts', { token: shop.token, body: { phone: `0${people.b.phone.slice(2)}` } });
  const typed = rnd();
  const preview = await api('POST', '/sms/preview', { token: shop.token, body: { text: 'Hi {name}, class at 4 pm', audience: { tags: ['grade10'], numbers: `0${typed.slice(2)}, Ruwan\nnot-a-number` } } });
  assert.equal(preview.data.count, 2, JSON.stringify(preview.data));
  assert.equal(preview.data.segments, 1);
  const before = sent.length;
  const c = await api('POST', '/sms/campaigns', { token: shop.token, body: { name: 'Class', text: 'Hi {name}, class at 4 pm', audience: { tags: ['grade10'], numbers: `0${typed.slice(2)}, Ruwan` } } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const done = await until(async () => { const r = await api('GET', `/sms/campaigns/${c.data.id}`, { token: shop.token }); return r.data.status === 'done' ? r.data : null; });
  assert.equal(done.sent, 2);
  const batch = sent.slice(before);
  assert.deepEqual(batch.map((m) => m.to).sort(), [people.a.phone, typed].sort());
  assert.equal(batch.find((m) => m.to === people.a.phone).message, 'Hi Nimal, class at 4 pm');
  assert.equal(batch.find((m) => m.to === typed).message, 'Hi Ruwan, class at 4 pm');
  const [logged] = await sql(`SELECT content, source, direction FROM bot_message WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`, [people.a.conversation]);
  assert.deepEqual(logged, { content: 'Hi Nimal, class at 4 pm', source: 'sms', direction: 'outbound' });
  const [none] = await sql(`SELECT COUNT(*)::int AS n FROM bot_message WHERE conversation_id = $1 AND source = 'sms'`, [people.b.conversation]);
  assert.equal(none.n, 0, 'opted out');
});

test('typed numbers: several on one line, landlines / foreign skipped, WhatsApp STOP respected', async () => {
  const x = rnd(); const y = rnd();
  await sql(`INSERT INTO marketing_optout (company_id, bot_channel_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [shop.companyId, people.c.id]);
  const p = await api('POST', '/sms/preview', { token: shop.token, body: { audience: { numbers: `0${x.slice(2)},0${y.slice(2)}\n0112345678\n971501234567\n0${people.c.phone.slice(2)}` } } });
  assert.equal(p.data.count, 2, JSON.stringify(p.data));
  assert.deepEqual(p.data.sample.map((s) => s.phone).sort(), [x, y].sort());
  assert.equal(p.data.sample[0].name, '', 'a number is never used as a name');
  await sql(`DELETE FROM marketing_optout WHERE company_id = $1 AND bot_channel_user_id = $2`, [shop.companyId, people.c.id]);
});

test('a row left "sending" by a restart is closed, and the campaign finishes', async () => {
  const [c] = await sql(`INSERT INTO sms_campaign (company_id, name, text, status, total) VALUES ($1, 'x', 'x', 'sending', 1) RETURNING id`, [shop.companyId]);
  await sql(`INSERT INTO sms_message (company_id, campaign_id, phone, text, status, claimed_at) VALUES ($1, $2, '94770000000', 'x', 'sending', NOW() - INTERVAL '10 minutes')`, [shop.companyId, c.id]);
  const done = await until(async () => { const r = await api('GET', `/sms/campaigns/${c.id}`, { token: shop.token }); return r.data.status === 'done' ? r.data : null; });
  assert.equal(done.failed, 1);
});

test('Sinhala goes as Unicode and counts 70 per SMS', async () => {
  const text = 'ආයුබෝවන් {name}! '.repeat(6);
  const p = await api('POST', '/sms/preview', { token: shop.token, body: { text, audience: { tags: ['grade11'] } } });
  assert.equal(p.data.unicode, true);
  assert.ok(p.data.segments >= 2);
  const before = sent.length;
  const c = await api('POST', '/sms/campaigns', { token: shop.token, body: { text, audience: { tags: ['grade11'] } } });
  await until(async () => (await api('GET', `/sms/campaigns/${c.data.id}`, { token: shop.token })).data.status === 'done');
  assert.equal(sent[before].type, 'unicode');
});

test('no credit: the campaign stops instead of failing everyone', async () => {
  credit = false;
  const c = await api('POST', '/sms/campaigns', { token: shop.token, body: { text: 'Sale!', audience: { all: true } } });
  const r = await until(async () => { const x = await api('GET', `/sms/campaigns/${c.data.id}`, { token: shop.token }); return x.data.status === 'stopped' ? x.data : null; });
  assert.match(r.error, /balance/i);
  assert.equal(r.failed, 1);
  credit = true;
});

test('one SMS from an Inbox chat; agents only for their own chats; groups have no number', async () => {
  const info = await api('GET', `/sms/conversations/${people.c.conversation}`, { token: shop.token });
  assert.equal(info.data.phone, people.c.phone);
  assert.equal(info.data.connected, true);
  const r = await api('POST', `/sms/conversations/${people.c.conversation}`, { token: shop.token, body: { text: 'Your order is ready.' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(sent.at(-1).to, people.c.phone);
  const [m] = await sql(`SELECT content, source FROM bot_message WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`, [people.c.conversation]);
  assert.deepEqual(m, { content: 'Your order is ready.', source: 'sms' });
  const agent = await createAgent(shop, 'sms-agent');
  assert.equal((await api('POST', `/sms/conversations/${people.c.conversation}`, { token: agent.token, body: { text: 'x' } })).status, 403);
  assert.equal((await api('POST', '/sms/campaigns', { token: agent.token, body: { text: 'x', audience: { all: true } } })).status, 403);
  assert.equal((await api('GET', '/sms/settings', { token: agent.token })).status, 403, 'no account details for agents');
  assert.equal((await api('GET', '/sms/ready', { token: agent.token })).data.connected, true);
  await sql(`UPDATE bot_conversation SET assigned_agent_id = $2 WHERE id = $1`, [people.c.conversation, agent.id]);
  assert.equal((await api('POST', `/sms/conversations/${people.c.conversation}`, { token: agent.token, body: { text: 'On the way!' } })).status, 201);
  assert.equal((await api('POST', `/sms/conversations/${people.c.conversation}`, { token: agent.token, body: { text: 'On the way!' } })).status, 400, 'the same SMS twice in a row');
  const opted = await api('POST', `/sms/conversations/${people.b.conversation}`, { token: shop.token, body: { text: 'x' } });
  assert.equal(opted.status, 400, 'asked not to get SMS');
  const other = await createWorkspace(`sms-other-${randomBytes(2).toString('hex')}`);
  assert.equal((await api('GET', `/sms/conversations/${people.c.conversation}`, { token: other.token })).status, 404, 'other businesses can\'t see it');
});

test('disconnect removes the account', async () => {
  assert.equal((await api('DELETE', '/sms/settings', { token: shop.token })).data.connected, false);
  assert.equal((await api('GET', '/sms/settings', { token: shop.token })).data.connected, false);
  assert.equal((await api('POST', '/sms/campaigns', { token: shop.token, body: { text: 'x', audience: { all: true } } })).status, 400);
});
