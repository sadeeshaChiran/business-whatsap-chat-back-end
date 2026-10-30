/**
 * Agent Metra SMS credits: the super admin connects the Agent Metra Notify.lk account; businesses send without their own
 * account and pay with credits (1 credit = 1 SMS part). Free credits every month from the package first, then bought
 * credits; exact credits per person ({name} lengths differ); not enough credits = refused before sending; out of credits
 * while sending = the campaign stops; failed SMS give their credits back; own sender name after approval; an SMS pack
 * bought in Billing adds credits once; a business with its own Notify.lk account uses no credits.
 * Run the API with SMS_PROVIDER_BASE_URL=http://127.0.0.1:4596 (this file starts the fake Notify.lk there).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { api, closeDb, createAgent, createSuperAdmin, createWorkspace, sql } from './helpers.mjs';

const sent = [];
const fake = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  res.setHeader('content-type', 'application/json');
  if (!['good-key-123456', 'own-key-654321'].includes(q.api_key)) return res.end(JSON.stringify({ status: 'error', message: 'Invalid API key' }));
  if (url.pathname.endsWith('/status')) return res.end(JSON.stringify({ status: 'success', data: { active: true, acc_balance: 50000 } }));
  if (url.pathname.endsWith('/send')) {
    if (String(q.to).endsWith('0000')) return res.end(JSON.stringify({ status: 'error', message: 'Invalid number' }));
    sent.push(q);
    return res.end(JSON.stringify({ status: 'success', data: 'Sent' }));
  }
  res.statusCode = 404; res.end('{}');
});

const rnd = () => `9477${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}${Math.floor(Math.random() * 9) + 1}`;
const local = (p) => `0${p.slice(2)}`;
const until = async (fn, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 300)); }
};
let admin; let shop; let growthId; let growthOld;
const settings = async () => (await api('GET', '/sms/settings', { token: shop.token })).data;
const credits = async () => (await settings()).agent_metra.credits;
const done = (id) => until(async () => { const r = await api('GET', `/sms/campaigns/${id}`, { token: shop.token }); return ['done', 'stopped'].includes(r.data.status) ? r.data : null; });

test.before(async () => {
  await new Promise((r) => fake.listen(4596, '127.0.0.1', r));
  admin = await createSuperAdmin();
  shop = await createWorkspace('smscredits');
  const packages = (await api('GET', '/super-admin/packages', { token: admin.token })).data;
  const growth = packages.find((p) => p.code === 'growth');
  growthId = growth.id;
  growthOld = growth.limits?.numbers?.sms_free_per_month ?? growth.limits?.sms_free_per_month ?? null;
  const p = await api('PATCH', `/super-admin/packages/${growthId}`, { token: admin.token, body: { limits: { sms_free_per_month: 5 } } });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const s = await api('PATCH', `/super-admin/companies/${shop.companyId}/subscription`, { token: admin.token, body: { package_id: growthId, status: 'active' } });
  assert.equal(s.status, 200, JSON.stringify(s.json));
});
test.after(async () => {
  await api('PUT', '/super-admin/sms', { token: admin.token, body: { enabled: false } });
  await api('PATCH', `/super-admin/packages/${growthId}`, { token: admin.token, body: { limits: { sms_free_per_month: growthOld ?? 0 } } });
  await closeDb(); fake.close();
});

test('off until the super admin connects the Agent Metra account; only the super admin can', async () => {
  await api('PUT', '/super-admin/sms', { token: admin.token, body: { enabled: false } });
  const before = await settings();
  assert.equal(before.mode, 'off');
  assert.equal(before.agent_metra.available, false);
  assert.equal((await api('GET', '/sms/ready', { token: shop.token })).data.connected, false);
  assert.equal((await api('PUT', '/super-admin/sms', { token: shop.token, body: { enabled: true } })).status, 403);
  assert.equal((await api('PUT', '/super-admin/sms', { token: admin.token, body: { user_id: '999', api_key: 'bad-key-0000000', default_sender: 'AgentMetra', enabled: true } })).status, 400);
  const ok = await api('PUT', '/super-admin/sms', { token: admin.token, body: { user_id: '999', api_key: 'good-key-123456', default_sender: 'AgentMetra', enabled: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.data.account.ready, true);
  assert.equal(ok.data.account.balance, 50000);
  assert.equal(JSON.stringify(ok.data).includes('good-key-123456'), false, 'the key is never sent back');
  const after = await settings();
  assert.equal(after.mode, 'platform');
  assert.equal(after.agent_metra.sender_id, 'AgentMetra');
  assert.equal(after.agent_metra.credits.free_per_month, 5);
  assert.equal(after.agent_metra.credits.available, 5);
  assert.ok(after.agent_metra.packs.length >= 1);
});

test('free credits first, then bought ones; exact credits per person; not enough = refused before sending', async () => {
  const text = `Hi {name}, ${'our big weekend sale has 20% off every school shoe and bag in the shop. '.repeat(2)}`.slice(0, 150);
  const [a, b, c] = [rnd(), rnd(), rnd()];
  // "Hi Ab," fits one SMS, a long name pushes it over 160 → 2 SMS
  const numbers = `${local(a)}, Ab\n${local(b)}, Bartholomew-Alexander\n${local(c)}, Ab`;
  const preview = await api('POST', '/sms/preview', { token: shop.token, body: { text, audience: { numbers } } });
  assert.equal(preview.data.count, 3);
  assert.equal(preview.data.via, 'platform');
  assert.equal(preview.data.credits_needed, 4, JSON.stringify(preview.data));
  assert.equal(preview.data.credits_available, 5);
  // 4 parts × 2 = 8 > 5 → refused, nothing sent
  const big = await api('POST', '/sms/campaigns', { token: shop.token, body: { text: `${text}${text}`.slice(0, 300), audience: { numbers } } });
  assert.equal(big.status, 400);
  assert.match(big.json.message, /needs \d+ SMS credits – you have 5/);
  // the super admin gives 10 credits
  assert.equal((await api('POST', `/super-admin/sms/companies/${shop.companyId}/credits`, { token: admin.token, body: { credits: 10, note: 'Welcome' } })).status, 201);
  assert.equal((await credits()).available, 15);
  const before = sent.length;
  const c1 = await api('POST', '/sms/campaigns', { token: shop.token, body: { name: 'Sale', text, audience: { numbers } } });
  assert.equal(c1.status, 201, JSON.stringify(c1.json));
  const r = await done(c1.data.id);
  assert.equal(r.status, 'done');
  assert.equal(r.sent, 3);
  const batch = sent.slice(before);
  assert.ok(batch.every((m) => m.sender_id === 'AgentMetra' && m.user_id === '999'));
  const now = await credits();
  assert.equal(now.free_left, 1, 'the 5 free credits are used first');
  assert.equal(now.balance, 10);
  assert.equal(now.available, 11);
  const rows = await sql(`SELECT credits, via FROM sms_message WHERE campaign_id = $1 ORDER BY id`, [c1.data.id]);
  assert.deepEqual(rows.map((x) => x.credits).sort(), [1, 1, 2]);
  assert.ok(rows.every((x) => x.via === 'platform'));
  const history = (await api('GET', '/sms/credits/history', { token: shop.token })).data;
  assert.ok(history.some((h) => h.kind === 'adjust' && h.credits === 10));
  assert.ok(history.some((h) => h.kind === 'used' && h.credits === -4 && h.note === 'Sale'));
});

test('a failed SMS gives its credits back; out of credits while sending stops the campaign', async () => {
  const start = await credits();
  const good = rnd();
  const c = await api('POST', '/sms/campaigns', { token: shop.token, body: { text: 'Short note', audience: { numbers: `${local(good)}\n0771230000` } } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const r = await done(c.data.id);
  assert.equal(r.sent, 1);
  assert.equal(r.failed, 1);
  assert.equal((await credits()).available, start.available - 1, 'only the SMS that went out is paid');
  // credits run out between the check and the sending (e.g. two campaigns at once)
  const left = (await credits()).available;
  await sql(`UPDATE sms_wallet SET balance = 1, free_used = 5 WHERE company_id = $1`, [shop.companyId]);
  const [camp] = await sql(`INSERT INTO sms_campaign (company_id, name, text, status, total) VALUES ($1, 'race', 'Hi', 'sending', 3) RETURNING id`, [shop.companyId]);
  for (const p of [rnd(), rnd(), rnd()]) await sql(`INSERT INTO sms_message (company_id, campaign_id, phone, text) VALUES ($1, $2, $3, 'Hi')`, [shop.companyId, camp.id, p]);
  const stopped = await done(camp.id);
  assert.equal(stopped.status, 'stopped');
  assert.match(stopped.error, /Out of SMS credits/);
  assert.equal(stopped.sent, 1);
  assert.equal((await credits()).available, 0);
  await sql(`UPDATE sms_wallet SET balance = $2 WHERE company_id = $1`, [shop.companyId, Math.max(0, left - 1)]);
});

test('own sender name: asked → approved by the super admin → SMS go from it, with the line added to every SMS', async () => {
  assert.equal((await api('POST', '/sms/sender', { token: shop.token, body: { sender_id: 'x' } })).status, 400);
  const asked = await api('POST', '/sms/sender', { token: shop.token, body: { sender_id: 'VORAKIDS' } });
  assert.equal(asked.data.agent_metra.sender_status, 'requested');
  assert.equal(asked.data.agent_metra.sender_id, 'AgentMetra', 'the default name until it is approved');
  const list = (await api('GET', '/super-admin/sms/companies', { token: admin.token })).data;
  assert.equal(list[0].sender_status, 'requested', 'requests are listed first');
  await api('POST', `/super-admin/sms/companies/${shop.companyId}/sender`, { token: admin.token, body: { approve: true } });
  await api('PUT', '/sms/footer', { token: shop.token, body: { footer: 'Reply on WhatsApp 0771234567' } });
  const s = await settings();
  assert.equal(s.agent_metra.sender_id, 'VORAKIDS');
  assert.equal(s.agent_metra.footer, 'Reply on WhatsApp 0771234567');
  const to = rnd();
  assert.equal((await api('POST', '/sms/test', { token: shop.token, body: { to: local(to) } })).status, 201);
  assert.equal(sent.at(-1).sender_id, 'VORAKIDS');
  assert.match(sent.at(-1).message, /\nReply on WhatsApp 0771234567$/);
  // asking for another name keeps the approved one until the new one is approved
  const again = await api('POST', '/sms/sender', { token: shop.token, body: { sender_id: 'VORASHOES' } });
  assert.equal(again.data.agent_metra.sender_status, 'requested');
  assert.equal(again.data.agent_metra.sender_id, 'VORAKIDS');
  await api('POST', '/sms/test', { token: shop.token, body: { to: local(rnd()) } });
  assert.equal(sent.at(-1).sender_id, 'VORAKIDS');
});

test('one SMS from an Inbox chat takes credits; with its own Notify.lk account no credits are used', async () => {
  const phone = rnd();
  const [cu] = await sql(`INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name) VALUES ($1, 'whatsapp', $2, 'Nimal') RETURNING id`, [shop.companyId, phone]);
  const [conv] = await sql(`INSERT INTO bot_conversation (bot_channel_user_id, status) VALUES ($1, 'open') RETURNING id`, [cu.id]);
  await api('POST', `/super-admin/sms/companies/${shop.companyId}/credits`, { token: admin.token, body: { credits: 5 } });
  const before = (await credits()).available;
  const agent = await createAgent(shop, 'smscredit-agent');
  await sql(`UPDATE bot_conversation SET assigned_agent_id = $2 WHERE id = $1`, [conv.id, agent.id]);
  const info = await api('GET', `/sms/conversations/${conv.id}`, { token: agent.token });
  assert.equal(info.data.via, 'platform');
  assert.equal(info.data.credits_available, before);
  const r = await api('POST', `/sms/conversations/${conv.id}`, { token: agent.token, body: { text: 'Your order is on the way.' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.data.credits, 1);
  assert.equal((await credits()).available, before - 1);
  // own account: sent with its own key and sender, credits untouched
  const own = await api('PUT', '/sms/settings', { token: shop.token, body: { user_id: '555', api_key: 'own-key-654321', sender_id: 'OWNSHOP' } });
  assert.equal(own.status, 200, JSON.stringify(own.json));
  assert.equal(own.data.mode, 'own');
  const r2 = await api('POST', `/sms/conversations/${conv.id}`, { token: shop.token, body: { text: 'Delivered today.' } });
  assert.equal(r2.data.credits, 0);
  assert.equal(sent.at(-1).sender_id, 'OWNSHOP');
  assert.equal(sent.at(-1).user_id, '555');
  assert.equal((await credits()).available, before - 1);
  await api('DELETE', '/sms/settings', { token: shop.token });
  assert.equal((await settings()).mode, 'platform');
});

test('an SMS pack bought in Billing adds its credits once', async () => {
  const overview = (await api('GET', '/billing/overview', { token: shop.token })).data;
  const pack = overview.sms_packs.find((p) => p.credits === 1000);
  assert.ok(pack, JSON.stringify(overview.sms_packs));
  const before = (await credits()).balance;
  const co = await api('POST', '/billing/checkout', { token: shop.token, body: { kind: 'sms_pack', sms_pack_id: pack.id, method: 'bank_transfer' } });
  assert.equal(co.status, 201, JSON.stringify(co.json));
  assert.match(co.data.payment.description, /1,000 SMS credits/);
  // the pack changes while the slip waits: the payment still gets what it promised
  const all = (await api('GET', '/super-admin/sms/packs', { token: admin.token })).data;
  const full = all.find((p) => p.id === pack.id);
  assert.equal((await api('PATCH', `/super-admin/sms/packs/${pack.id}`, { token: admin.token, body: { ...full, credits: 500 } })).status, 200);
  assert.equal((await api('PATCH', `/super-admin/sms/packs/${pack.id}`, { token: admin.token, body: { ...full, price: 0 } })).status, 400, 'a free pack is refused');
  const paid = await api('POST', `/super-admin/billing/payments/${co.data.payment.id}/approve`, { token: admin.token });
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  assert.equal((await credits()).balance, before + 1000);
  await api('PATCH', `/super-admin/sms/packs/${pack.id}`, { token: admin.token, body: full });
  assert.equal((await api('POST', `/super-admin/billing/payments/${co.data.payment.id}/approve`, { token: admin.token })).status, 400);
  assert.equal((await credits()).balance, before + 1000);
  // packs are hidden while Agent Metra SMS is off
  await api('PUT', '/super-admin/sms', { token: admin.token, body: { enabled: false } });
  assert.deepEqual((await api('GET', '/billing/overview', { token: shop.token })).data.sms_packs, []);
  assert.equal((await api('POST', '/billing/checkout', { token: shop.token, body: { kind: 'sms_pack', sms_pack_id: pack.id, method: 'bank_transfer' } })).status, 400);
});
