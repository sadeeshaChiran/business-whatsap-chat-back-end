/**
 * Several WhatsApp numbers per company – run against a running API + TEST database:
 *   node --test test/whatsapp-numbers.test.mjs
 * The Meta login that adds a number cannot run here, so the second number is inserted the way connectAnother() saves it.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { RUN, api, closeDb, createAgent, createWorkspace, sendInboundWhatsapp, sql } from './helpers.mjs';

const MAIN = `pn-main-${RUN}`;
const EXTRA = `pn-extra-${RUN}`;
const C1 = `9471${String(Date.now()).slice(-7)}`;
const C2 = `9472${String(Date.now()).slice(-7)}`;
let A; let agent; let mainId; let extraId;

const customer = async (phone) => (await sql(
  `SELECT id, whatsapp_channel_id, first_whatsapp_channel_id FROM bot_channel_user WHERE company_id = $1 AND platform = 'whatsapp' AND external_user_id = $2`,
  [A.companyId, phone]))[0];

before(async () => {
  A = await createWorkspace('wanum');
  const r = await api('PATCH', `/company/${A.companyId}`, { token: A.token, body: { whatsapp_provider_type: 'meta', meta_phone_number_id: MAIN, meta_access_token: 'test-token', meta_waba_id: 'waba-n' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  [{ id: mainId }] = await sql(`SELECT id FROM whatsapp_channels WHERE company_id = $1`, [A.companyId]);
  [{ id: extraId }] = await sql(
    `INSERT INTO whatsapp_channels (company_id, company_name, instance_name, provider_type, role_type, status, weight, created_at,
       meta_phone_number_id, meta_access_token, meta_waba_id, label, purpose, display_phone, bot_enabled, is_primary)
     VALUES ($1, 'x', $2, 'meta', 'general', 'CONNECTED', 1, NOW(), $3, 'test-token-2', 'waba-n', 'Wholesale', 'wholesale', '+94 77 000 0002', TRUE, FALSE)
     RETURNING id`, [A.companyId, EXTRA, EXTRA]);
  mainId = Number(mainId); extraId = Number(extraId);
  agent = await createAgent(A, 'wanum-agent');
});

after(closeDb);

describe('Several WhatsApp numbers', () => {
  test('the existing number is the main number', async () => {
    const [row] = await sql(`SELECT is_primary FROM whatsapp_channels WHERE id = $1`, [mainId]);
    // set by the migration for numbers that existed before; a number saved from Settings later is the first row
    const list = await api('GET', '/whatsapp-numbers', { token: A.token });
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.equal(list.data.numbers.length, 2);
    assert.equal(list.data.numbers[0].id, mainId, 'main number first');
    assert.ok(row.is_primary || list.data.numbers[0].id === mainId);
  });

  test('a customer is remembered on the number they wrote to', async () => {
    assert.equal((await sendInboundWhatsapp(EXTRA, C1, 'wholesale price list please')).status, 200);
    assert.equal((await sendInboundWhatsapp(MAIN, C2, 'Hi')).status, 200);
    const c1 = await customer(C1);
    const c2 = await customer(C2);
    assert.equal(Number(c1.whatsapp_channel_id), extraId);
    assert.equal(Number(c1.first_whatsapp_channel_id), extraId);
    assert.equal(Number(c2.whatsapp_channel_id), mainId);
    const [msg] = await sql(`SELECT m.whatsapp_channel_id FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id
      WHERE c.bot_channel_user_id = $1 AND m.direction::text = 'inbound' ORDER BY m.id DESC LIMIT 1`, [c1.id]);
    assert.equal(Number(msg.whatsapp_channel_id), extraId, 'inbound message keeps its number');

    // the same customer later writes to the main number: replies follow, the first number stays
    assert.equal((await sendInboundWhatsapp(MAIN, C1, 'retail eka kiyada?')).status, 200);
    const again = await customer(C1);
    assert.equal(Number(again.whatsapp_channel_id), mainId);
    assert.equal(Number(again.first_whatsapp_channel_id), extraId);
    assert.equal((await sendInboundWhatsapp(EXTRA, C1, 'ok wholesale 20 packs')).status, 200);
  });

  test('an order takes the number the customer is using', async () => {
    const c1 = await customer(C1);
    const [order] = await sql(`INSERT INTO bot_order (company_id, bot_channel_user_id, customer_name, customer_phone, status, total_amount)
      VALUES ($1, $2, 'Wholesale buyer', $3, 'Pending', 25000) RETURNING whatsapp_channel_id`, [A.companyId, c1.id, C1]);
    assert.equal(Number(order.whatsapp_channel_id), extraId);
  });

  test('the numbers page shows results per number', async () => {
    const list = await api('GET', '/whatsapp-numbers', { token: A.token });
    const extra = list.data.numbers.find((n) => n.id === extraId);
    const main = list.data.numbers.find((n) => n.id === mainId);
    assert.equal(extra.label, 'Wholesale');
    assert.equal(extra.purpose, 'wholesale');
    assert.equal(extra.stats.customers, 1, 'C1 came through the wholesale number');
    assert.equal(extra.stats.orders, 1);
    assert.equal(extra.stats.sales, 25000);
    assert.ok(extra.stats.chats >= 1);
    assert.equal(main.stats.customers, 1, 'C2 came through the main number');
    assert.deepEqual(list.data.purposes.includes('support'), true);
  });

  test('owner edits a number; team sees the names but cannot manage numbers', async () => {
    const saved = await api('PATCH', `/whatsapp-numbers/${extraId}`, { token: A.token, body: { label: 'Wholesale LK', bot_note: 'Minimum 10 packs', bot_enabled: false } });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const extra = saved.data.numbers.find((n) => n.id === extraId);
    assert.equal(extra.label, 'Wholesale LK');
    assert.equal(extra.bot_note, 'Minimum 10 packs');
    assert.equal(extra.bot_enabled, false);
    assert.equal((await api('PATCH', `/whatsapp-numbers/${extraId}`, { token: A.token, body: { purpose: 'spam' } })).status, 400);

    const labels = await api('GET', '/whatsapp-numbers/labels', { token: agent.token });
    assert.equal(labels.status, 200);
    assert.equal(labels.data.length, 2);
    assert.equal(labels.data.find((n) => n.id === extraId).label, 'Wholesale LK');
    assert.equal((await api('GET', '/whatsapp-numbers', { token: agent.token })).status, 403);
    assert.equal((await api('PATCH', `/whatsapp-numbers/${extraId}`, { token: agent.token, body: { label: 'x' } })).status, 403);

    // another company cannot touch it
    const B = await createWorkspace('wanum-b');
    assert.equal((await api('PATCH', `/whatsapp-numbers/${extraId}`, { token: B.token, body: { label: 'stolen' } })).status, 404);
    assert.deepEqual((await api('GET', '/whatsapp-numbers/labels', { token: B.token })).data, []);
  });

  test('the inbox gets the number of each WhatsApp customer', async () => {
    const c1 = await customer(C1);
    const [conv] = await sql(`SELECT id FROM bot_conversation WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 1`, [c1.id]);
    const detail = await api('GET', `/bot/conversations/${conv.id}`, { token: A.token });
    assert.equal(detail.status, 200);
    const channelUser = detail.data.channelUser ?? detail.data.conversation?.channelUser;
    assert.equal(Number(channelUser.whatsapp_channel_id), extraId);
  });

  test('main number can be moved; the main number cannot be disconnected', async () => {
    const moved = await api('PATCH', `/whatsapp-numbers/${extraId}`, { token: A.token, body: { is_primary: true } });
    assert.equal(moved.status, 200);
    assert.equal(moved.data.numbers[0].id, extraId);
    assert.equal(moved.data.numbers.filter((n) => n.is_primary).length, 1);
    assert.equal((await api('DELETE', `/whatsapp-numbers/${extraId}`, { token: A.token })).status, 400);
    await api('PATCH', `/whatsapp-numbers/${mainId}`, { token: A.token, body: { is_primary: true } });
  });

  test('disconnecting an extra number moves its customers to the main number', async () => {
    const removed = await api('DELETE', `/whatsapp-numbers/${extraId}`, { token: A.token });
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.equal(removed.data.numbers.length, 1);
    const c1 = await customer(C1);
    assert.equal(c1.whatsapp_channel_id, null, 'replies fall back to the main number');
    assert.deepEqual((await api('GET', '/whatsapp-numbers/labels', { token: A.token })).data, [], 'one number: no badges');
    // the last number is the main number and stays
    assert.equal((await api('DELETE', `/whatsapp-numbers/${mainId}`, { token: A.token })).status, 400);
  });
});
