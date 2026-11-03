/**
 * Super admin → Billing & credits → Ways to pay: Card (Payments.lk), PayPal, Bank transfer, PayHere switched on / off.
 * Businesses see (and can use) only the ways that are on AND set up. At least one must stay usable.
 * Run with the PayPal + Payments.lk test settings (see paypal.test.mjs / paymentslk.test.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { api, closeDb, createSuperAdmin, createWorkspace, sql } from './helpers.mjs';

// a tiny Payments.lk: just enough to open a checkout
let n = 0;
const fake = createServer((req, res) => { res.setHeader('content-type', 'application/json'); const id = `chk_pm_${Date.now()}_${++n}`; res.statusCode = 201; res.end(JSON.stringify({ id, url: `https://pay.test/c/${id}` })); });

let admin; let shop; let pack;
const set = (body, token = admin.token) => api('PUT', '/super-admin/billing/settings/methods', { token, body });
const overview = async () => (await api('GET', '/billing/overview', { token: shop.token })).data;
const buy = (method) => api('POST', '/billing/checkout', { token: shop.token, body: { kind: 'token_pack', token_pack_id: pack.id, method } });

test.before(async () => {
  await new Promise((r) => fake.listen(4598, '127.0.0.1', r));
  admin = await createSuperAdmin();
  shop = await createWorkspace('paymethods');
  [pack] = await sql(`SELECT id FROM token_pack WHERE is_active AND price > 0 ORDER BY price LIMIT 1`);
});
test.after(async () => { await set({ paymentslk: true, paypal: true, bank_transfer: true, payhere: true }); await closeDb(); fake.close(); });

test('all on by default; the super admin sees each way with on / set up', async () => {
  await set({ paymentslk: true, paypal: true, bank_transfer: true, payhere: true });
  const o = await overview();
  assert.equal(o.paymentslk_enabled, true);
  assert.equal(o.paypal.enabled, true);
  assert.equal(o.bank_transfer_enabled, true);
  const s = await api('GET', '/super-admin/billing/settings', { token: admin.token });
  const m = Object.fromEntries(s.data.payment_methods.map((x) => [x.key, x]));
  assert.equal(m.paymentslk.shown, true);
  assert.equal(m.payhere.ready, false); // no PayHere keys here
  assert.equal(m.payhere.shown, false);
});

test('switched off = hidden and refused; only super admins can switch', async () => {
  assert.equal((await set({ paypal: false }, shop.token)).status, 403);
  let r = await set({ paypal: false, bank_transfer: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const o = await overview();
  assert.equal(o.paypal.enabled, false);
  assert.equal(o.bank_transfer_enabled, false);
  assert.equal(o.paymentslk_enabled, true);
  assert.equal((await buy('paypal')).status, 400);
  assert.equal((await buy('bank_transfer')).status, 400);
  assert.equal((await buy('paymentslk')).status, 201);
  // nothing usable left → refused
  r = await set({ paymentslk: false, payhere: true });
  assert.equal(r.status, 400);
  r = await set({ paypal: true, bank_transfer: true });
  assert.equal(r.status, 200);
  assert.equal((await buy('bank_transfer')).status, 201);
});
