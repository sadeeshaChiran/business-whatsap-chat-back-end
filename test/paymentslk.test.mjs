/**
 * Payments.lk (PAYable): card payments in rupees on the hosted checkout. Paid only when Payments.lk says the payment
 * succeeded for exactly the amount (return page or signed webhook, counted once). Auto-renew keeps the card; a day
 * before the package ends the saved card is charged; declines are tried again (3 times) then auto-renew stops.
 * Refunds take back what was bought. Run the API with:
 *   PAYMENTSLK_SECRET_KEY=sk_test_am PAYMENTSLK_WEBHOOK_SECRET=whsec_am PAYMENTSLK_API_BASE=http://127.0.0.1:4598 APP_PUBLIC_URL=http://localhost:5173
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { API, api, closeDb, createSuperAdmin, createWorkspace, sql } from './helpers.mjs';

const R = Date.now().toString(36); let n = 0;
const checkouts = new Map(); const payments = new Map(); const charges = []; const deleted = []; const keys = [];
let nextCharge = 'processing';
const send = (res, s, b) => { res.statusCode = s; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b ?? {})); };
const fake = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c; let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
  if (req.headers.authorization !== 'Bearer sk_test_am') return send(res, 401, { error: { code: 'unauthorized', message: 'bad key' } });
  if (req.method !== 'GET') keys.push(req.headers['idempotency-key']);
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/checkouts' && req.method === 'POST') {
    const id = `chk_${R}_${++n}`; const pay = { id: `pay_${R}_${++n}`, status: 'pending', amountCents: body.amountCents, reference: body.reference, checkoutId: id, savedCardId: null };
    payments.set(pay.id, pay);
    const chk = { id, url: `https://pay.test/c/${id}`, status: 'open', body, payment: pay }; checkouts.set(id, chk); return send(res, 201, chk);
  }
  let m = p.match(/^\/checkouts\/([^/]+)$/); if (m) { const c = checkouts.get(m[1]); return c ? send(res, 200, c) : send(res, 404, {}); }
  m = p.match(/^\/payments\/([^/]+)$/); if (m) { const x = payments.get(m[1]); return x ? send(res, 200, x) : send(res, 404, {}); }
  m = p.match(/^\/cards\/([^/]+)\/charge$/);
  if (m) {
    charges.push({ card: m[1], ...body });
    if (nextCharge === 'error') return send(res, 402, { error: { code: 'card_declined', message: 'Card declined' } });
    const pay = { id: `pay_${R}_${++n}`, status: nextCharge, amountCents: body.amountCents, reference: body.reference, savedCardId: m[1] };
    payments.set(pay.id, pay); return send(res, 201, pay);
  }
  m = p.match(/^\/cards\/([^/]+)$/); if (m && req.method === 'DELETE') { deleted.push(m[1]); return send(res, 200, { id: m[1], deleted: true }); }
  send(res, 404, { error: { message: `fake ${req.method} ${p}` } });
});

const hook = async (type, data, { secret = 'whsec_am', t = Math.floor(Date.now() / 1000) } = {}) => {
  const raw = JSON.stringify({ id: `evt_${R}_${++n}`, type, data });
  const sig = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  const r = await fetch(`${API}/public/paymentslk/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'payments-signature': `t=${t},v1=${sig}` } });
  return r.status;
};
const paid = (chkId, extra = {}) => { const c = checkouts.get(chkId); Object.assign(c.payment, { status: 'succeeded', ...extra }); c.status = 'succeeded'; return c.payment; };

let admin; let shop; let pack; let pkg;
test.before(async () => {
  await new Promise((r) => fake.listen(4598, '127.0.0.1', r));
  admin = await createSuperAdmin();
  shop = await createWorkspace('paymentslk');
  [pack] = await sql(`SELECT id, price, tokens FROM token_pack WHERE is_active AND price > 0 ORDER BY price LIMIT 1`);
  [pkg] = await sql(`SELECT id, price_monthly FROM platform_package WHERE is_active AND company_id IS NULL AND price_monthly > 0 AND (offer_until IS NULL OR offer_until < NOW()) ORDER BY price_monthly LIMIT 1`);
  assert.ok(pack && pkg);
});
test.after(async () => { await closeDb(); fake.close(); });

const buyPack = () => api('POST', '/billing/checkout', { token: shop.token, body: { kind: 'token_pack', token_pack_id: pack.id, method: 'paymentslk' } });
const chkOf = (c) => c.data.paymentslk.url.split('/c/')[1];

test('Billing offers the card payment; super admin sees sandbox + webhook', async () => {
  const o = await api('GET', '/billing/overview', { token: shop.token });
  assert.equal(o.data.paymentslk_enabled, true);
  const s = await api('GET', '/super-admin/billing/settings', { token: admin.token });
  assert.equal(s.data.paymentslk.enabled, true);
  assert.equal(s.data.paymentslk.mode, 'sandbox');
  assert.equal(s.data.paymentslk.webhook_set, true);
  assert.ok(!JSON.stringify(s.data).includes('sk_test_am') && !JSON.stringify(s.data).includes('whsec_am'));
});

test('pay once: rupees in cents, paid on return only after Payments.lk confirms, counted once', async () => {
  const c = await buyPack();
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.equal(c.data.next, 'paymentslk');
  const chk = checkouts.get(chkOf(c));
  assert.equal(chk.body.amountCents, Math.round(Number(pack.price) * 100));
  assert.equal(chk.body.reference, c.data.payment.order_id);
  assert.match(chk.body.successUrl, /result=paymentslk/);
  assert.ok(keys.at(-1));
  const id = c.data.payment.id;
  assert.equal((await api('POST', `/billing/payments/${id}/paymentslk`, { token: shop.token })).data.status, 'pending');
  const pay = paid(chk.id);
  const before = await sql(`SELECT COUNT(*)::int AS n FROM token_adjustment WHERE company_id = $1`, [shop.companyId]);
  const [a, b] = await Promise.all([
    api('POST', `/billing/payments/${id}/paymentslk`, { token: shop.token }),
    api('POST', `/billing/payments/${id}/paymentslk`, { token: shop.token }),
  ]);
  assert.equal(a.data.status, 'paid'); assert.equal(b.data.status, 'paid');
  assert.equal(await hook('payment.succeeded', pay), 200);
  const after = await sql(`SELECT COUNT(*)::int AS n FROM token_adjustment WHERE company_id = $1`, [shop.companyId]);
  assert.equal(after[0].n - before[0].n, 1);
  const [row] = await sql(`SELECT plk_payment_id, invoice_no FROM platform_payment WHERE id = $1`, [id]);
  assert.equal(row.plk_payment_id, pay.id);
  assert.ok(row.invoice_no);
});

test('webhook alone pays; bad / old signatures and wrong amounts are refused', async () => {
  const c = await buyPack();
  const pay = paid(chkOf(c));
  assert.equal(await hook('payment.succeeded', pay, { secret: 'wrong' }), 400);
  assert.equal(await hook('payment.succeeded', pay, { t: Math.floor(Date.now() / 1000) - 3600 }), 400);
  let [row] = await sql(`SELECT status FROM platform_payment WHERE id = $1`, [c.data.payment.id]);
  assert.equal(row.status, 'pending');
  assert.equal(await hook('payment.succeeded', { id: pay.id, checkoutId: pay.checkoutId }), 200);
  [row] = await sql(`SELECT status FROM platform_payment WHERE id = $1`, [c.data.payment.id]);
  assert.equal(row.status, 'paid');

  const c2 = await buyPack();
  paid(chkOf(c2), { amountCents: 100 });
  assert.equal((await api('POST', `/billing/payments/${c2.data.payment.id}/paymentslk`, { token: shop.token })).data.status, 'pending');

  const c3 = await buyPack();
  assert.equal(await hook('checkout.expired', { object: 'checkout', id: chkOf(c3) }), 200);
  [row] = await sql(`SELECT status FROM platform_payment WHERE id = $1`, [c3.data.payment.id]);
  assert.equal(row.status, 'cancelled');
});

test('refund takes the credits back', async () => {
  const c = await buyPack();
  const pay = paid(chkOf(c));
  await api('POST', `/billing/payments/${c.data.payment.id}/paymentslk`, { token: shop.token });
  const refund = { id: `re_${R}`, status: 'succeeded', amountCents: pay.amountCents, payment: { id: pay.id } };
  assert.equal(await hook('refund.succeeded', refund), 200);
  assert.equal(await hook('refund.succeeded', refund), 200);
  const [row] = await sql(`SELECT status FROM platform_payment WHERE id = $1`, [c.data.payment.id]);
  assert.equal(row.status, 'refunded');
  const back = await sql(`SELECT tokens FROM token_adjustment WHERE company_id = $1 AND reason LIKE 'Refunded:%'`, [shop.companyId]);
  assert.equal(back.length, 1);
});

test('auto-renew: card kept, charged a day before the end, renewal extends the package; one charge per day', async () => {
  const c = await api('POST', '/billing/checkout', { token: shop.token, body: { kind: 'subscription', package_id: pkg.id, billing_cycle: 'monthly', method: 'paymentslk', auto_renew: true } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.equal(checkouts.get(chkOf(c)).body.saveCard, true);
  // paid, but the card arrives a moment later (card.saved)
  const pay = paid(chkOf(c));
  await api('POST', `/billing/payments/${c.data.payment.id}/paymentslk`, { token: shop.token });
  let o = await api('GET', '/billing/overview', { token: shop.token });
  assert.equal(o.data.subscription.auto_renew, false);
  const card = `card_${R}`;
  assert.equal(await hook('card.saved', { id: card, last4: '0008', paymentId: pay.id }), 200);
  o = await api('GET', '/billing/overview', { token: shop.token });
  assert.equal(o.data.subscription.auto_renew, true);

  await sql(`UPDATE company_subscription SET period_end = NOW() + INTERVAL '12 hours' WHERE company_id = $1`, [shop.companyId]);
  const end1 = new Date((await sql(`SELECT period_end FROM company_subscription WHERE company_id = $1`, [shop.companyId]))[0].period_end).getTime();
  nextCharge = 'processing';
  await api('POST', '/super-admin/billing/renewals/run', { token: admin.token });
  await api('POST', '/super-admin/billing/renewals/run', { token: admin.token }); // same day – no second charge
  const mine = charges.filter((x) => x.card === card);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].amountCents, Math.round(Number(pkg.price_monthly) * 100));
  const [renewal] = await sql(`SELECT id, plk_payment_id, status FROM platform_payment WHERE company_id = $1 AND description LIKE '%(auto-renew)' ORDER BY id DESC LIMIT 1`, [shop.companyId]);
  assert.equal(renewal.status, 'pending');
  const charged = payments.get(renewal.plk_payment_id); charged.status = 'succeeded';
  assert.equal(await hook('payment.succeeded', charged), 200);
  const [after] = await sql(`SELECT period_end, plk_card_id, auto_renew FROM company_subscription WHERE company_id = $1`, [shop.companyId]);
  assert.ok(new Date(after.period_end).getTime() - end1 > 27 * 86_400_000);
  assert.equal(after.plk_card_id, card);
  assert.equal(after.auto_renew, true);
});

test('declined renewals: tried 3 days, then auto-renew stops and the owner is told; switching off forgets the card', async () => {
  const [{ plk_card_id: card }] = await sql(`SELECT plk_card_id FROM company_subscription WHERE company_id = $1`, [shop.companyId]);
  await sql(`UPDATE company_subscription SET period_end = NOW() + INTERVAL '6 hours' WHERE company_id = $1`, [shop.companyId]);
  nextCharge = 'error';
  for (let i = 0; i < 3; i += 1) {
    await sql(`UPDATE company_subscription SET plk_renew_last_at = NULL WHERE company_id = $1`, [shop.companyId]);
    await api('POST', '/super-admin/billing/renewals/run', { token: admin.token });
  }
  const [s] = await sql(`SELECT auto_renew, plk_card_id FROM company_subscription WHERE company_id = $1`, [shop.companyId]);
  assert.equal(s.auto_renew, false);
  assert.equal(s.plk_card_id, null);
  const notes = await sql(`SELECT title FROM bot_notification WHERE company_id = $1 AND kind = 'billing' ORDER BY id DESC LIMIT 3`, [shop.companyId]);
  assert.equal(notes[0].title, 'Auto-renew stopped');
  assert.equal(charges.filter((x) => x.card === card).length, 4);

  // a new paid package with auto-renew, then switched off → card deleted at Payments.lk
  nextCharge = 'processing';
  const c = await api('POST', '/billing/checkout', { token: shop.token, body: { kind: 'subscription', package_id: pkg.id, billing_cycle: 'monthly', method: 'paymentslk', auto_renew: true } });
  paid(chkOf(c), { savedCardId: `card2_${R}` });
  await api('POST', `/billing/payments/${c.data.payment.id}/paymentslk`, { token: shop.token });
  let o = await api('GET', '/billing/overview', { token: shop.token });
  assert.equal(o.data.subscription.auto_renew, true);
  const off = await api('POST', '/billing/auto-renew', { token: shop.token, body: { enabled: false } });
  assert.equal(off.status, 201);
  o = await api('GET', '/billing/overview', { token: shop.token });
  assert.equal(o.data.subscription.auto_renew, false);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(deleted.includes(`card2_${R}`));
});
