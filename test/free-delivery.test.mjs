/**
 * Free delivery from an amount: the setting, and the order total the bot builds (needs the contract bot):
 *   BOT_CAPTURE_DIR=<contract bot CAPTURE_DIR> node --test test/free-delivery.test.mjs
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { api, closeDb, createWorkspace, sql } from './helpers.mjs';

let A;
before(async () => { A = await createWorkspace('free-del'); });
after(closeDb);

test('setting: saved, cleared, never negative', async () => {
  const set = await api('PATCH', '/bot/sales-bot/settings', { token: A.token, body: { free_delivery_over: 15000 } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(set.data.free_delivery_over, 15000);
  assert.equal((await api('PATCH', '/bot/sales-bot/settings', { token: A.token, body: { free_delivery_over: -5 } })).status, 400);
  const cleared = await api('PATCH', '/bot/sales-bot/settings', { token: A.token, body: { free_delivery_over: null } });
  assert.equal(cleared.data.free_delivery_over, null);
});

test('the order total uses free delivery (needs the contract bot)', { skip: !process.env.BOT_CAPTURE_DIR }, async () => {
  const cat = await api('POST', '/product-catergory', { token: A.token, body: { name: `Shoes ${Date.now()}` } });
  await api('POST', '/products', { token: A.token, body: { name: 'Red shoe', price: 2500, quantity: 5, category_id: cat.data.id, weight: 0.6 } });
  await api('POST', '/bot/delivery-zones', { token: A.token, body: { area: 'Colombo', fee: 350, days: '1-2 days' } });
  await api('PATCH', '/bot/sales-bot/settings', { token: A.token, body: { bot_enabled: true, auto_enable_new_customers: true, free_delivery_over: 4000 } });
  const phone = `9999478${String(Date.now()).slice(-7)}`;
  const fd = new FormData(); fd.append('phone', phone); fd.append('name', 'Nimal'); fd.append('text', 'red shoe 2k ona, Colombo');
  assert.equal((await api('POST', '/bot/sales-bot/simulate', { token: A.token, form: fd })).status, 201);
  await new Promise((r) => setTimeout(r, 7000));
  const [user] = await sql(`SELECT session_state FROM bot_channel_user WHERE company_id = $1 AND external_user_id = $2`, [A.companyId, phone]);
  const pending = JSON.parse(user.session_state).sales_bot.pending_order;
  assert.equal(pending.subtotal, 5000);
  assert.equal(pending.delivery_fee, 0, 'free: 5,000 ≥ 4,000');
  assert.equal(pending.total, 5000);
});
