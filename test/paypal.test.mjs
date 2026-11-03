/**
 * PayPal: prices stay in rupees; PayPal is charged in US dollars at the rate of the day (+ markup), or a fixed rate.
 * Pay once = PayPal order → back on the return page the money is taken (capture) and the package / credits switch on.
 * Auto-renew = PayPal subscription; every later charge (webhook) extends the package; switching auto-renew off cancels
 * it at PayPal. Webhooks are checked with PayPal; the return page and the webhook never count a payment twice.
 * Run the API with:
 *   PAYPAL_CLIENT_ID=test-id PAYPAL_CLIENT_SECRET=test-secret PAYPAL_WEBHOOK_ID=WH-TEST APP_PUBLIC_URL=http://localhost:5173
 *   PAYPAL_API_BASE=http://127.0.0.1:4597 PAYPAL_FX_URL=http://127.0.0.1:4597/fx
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { API, api, closeDb, createSuperAdmin, createWorkspace, sql } from './helpers.mjs';

let n = 0; const R = Date.now().toString(36);
const orders = new Map(); const subs = new Map(); const plans = new Map();
let fxRate = 300;
const send = (res, status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(body === undefined ? '' : JSON.stringify(body)); };
const fake = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  const url = new URL(req.url, 'http://x'); const p = url.pathname;
  if (p === '/fx') return send(res, 200, { result: 'success', rates: { USD: 1, LKR: fxRate } });
  if (p === '/v1/oauth2/token') return req.headers.authorization === `Basic ${Buffer.from('test-id:test-secret').toString('base64')}` ? send(res, 200, { access_token: 'tok', expires_in: 3600 }) : send(res, 401, { error_description: 'bad' });
  if (req.headers.authorization !== 'Bearer tok') return send(res, 401, { message: 'no token' });
  if (p === '/v2/checkout/orders' && req.method === 'POST') {
    const id = `O-${R}-${++n}`; const order = { id, status: 'PAYER_ACTION_REQUIRED', purchase_units: body.purchase_units, links: [{ rel: 'payer-action', href: `https://paypal.test/checkoutnow?token=${id}` }] };
    orders.set(id, order); return send(res, 200, order);
  }
  let m = p.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
  if (m) {
    const order = orders.get(m[1]); if (!order) return send(res, 404, { message: 'not found' });
    if (!m[2]) return send(res, 200, order);
    if (order.status === 'COMPLETED') return send(res, 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
    if (order.status !== 'APPROVED') return send(res, 422, { name: 'UNPROCESSABLE_ENTITY', message: 'not approved', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
    order.status = 'COMPLETED';
    order.purchase_units[0].payments = { captures: [{ id: `CAP-${R}-${++n}`, status: 'COMPLETED', amount: order.purchase_units[0].amount }] };
    return send(res, 201, order);
  }
  if (p === '/v1/catalogs/products') return send(res, 201, { id: 'PROD-1' });
  if (p === '/v1/billing/plans') { const id = `P-${R}-${++n}`; plans.set(id, body); return send(res, 201, { id, status: 'ACTIVE' }); }
  if (p === '/v1/billing/subscriptions' && req.method === 'POST') {
    const id = `I-${R}-${++n}`; const sub = { id, status: 'APPROVAL_PENDING', plan_id: body.plan_id, custom_id: body.custom_id, links: [{ rel: 'approve', href: `https://paypal.test/subscribe?ba=${id}` }] };
    subs.set(id, sub); return send(res, 201, sub);
  }
  m = p.match(/^\/v1\/billing\/subscriptions\/([^/]+)(\/cancel)?$/);
  if (m) {
    const sub = subs.get(m[1]); if (!sub) return send(res, 404, { message: 'not found' });
    if (m[2]) { if (sub.failCancel) return send(res, 500, { message: 'try later' }); sub.status = 'CANCELLED'; return send(res, 204); }
    return send(res, 200, sub);
  }
  if (p === '/v1/notifications/verify-webhook-signature') {
    return send(res, 200, { verification_status: body.transmission_sig === 'good' && body.webhook_id === 'WH-TEST' && body.webhook_event?.event_type ? 'SUCCESS' : 'FAILURE' });
  }
  send(res, 404, { message: `fake: ${req.method} ${p}` });
});

const hook = async (event, sig = 'good') => {
  const r = await fetch(`${API}/public/paypal/webhook`, {
    method: 'POST', body: JSON.stringify(event),
    headers: { 'content-type': 'application/json', 'paypal-transmission-id': 't1', 'paypal-transmission-time': new Date().toISOString(), 'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-transmission-sig': sig },
  });
  return r.status;
};
const cents = (rs, rate, markup = 0) => (Math.ceil((rs / rate) * (1 + markup / 100) * 100 - 1e-6) / 100);

let admin; let shop; let pack; let pkg;
test.before(async () => {
  await new Promise((r) => fake.listen(4597, '127.0.0.1', r));
  admin = await createSuperAdmin();
  shop = await createWorkspace('paypal');
  [pack] = await sql(`SELECT id, price, tokens FROM token_pack WHERE is_active AND price > 0 ORDER BY price LIMIT 1`);
  [pkg] = await sql(`SELECT id, price_monthly FROM platform_package WHERE is_active AND company_id IS NULL AND price_monthly > 0
                       AND (offer_until IS NULL OR offer_until < NOW()) ORDER BY price_monthly LIMIT 1`);
  assert.ok(pack && pkg, 'needs a token pack and a paid package');
  // plans are reused by design – this fake PayPal starts empty
  await sql(`UPDATE platform_setting SET value = value - 'plans' - 'products' WHERE key = 'paypal'`);
  await api('PUT', '/super-admin/billing/settings/paypal', { token: admin.token, body: { rate_mode: 'auto', markup_percent: 0 } });
});
test.after(async () => {
  await api('PUT', '/super-admin/billing/settings/paypal', { token: admin.token, body: { rate_mode: 'auto', markup_percent: 0 } });
  await closeDb(); fake.close();
});

test('Billing shows PayPal with the rate of the day; the super admin sees the setup', async () => {
  const o = await api('GET', '/billing/overview', { token: shop.token });
  assert.equal(o.status, 200);
  assert.equal(o.data.paypal.enabled, true);
  assert.equal(o.data.paypal.rate, 300);
  const s = await api('GET', '/super-admin/billing/settings', { token: admin.token });
  assert.equal(s.data.paypal.enabled, true);
  assert.equal(s.data.paypal.webhook_set, true);
  assert.equal(s.data.paypal.rate, 300);
  assert.ok(!JSON.stringify(s.data).includes('test-secret'));
});

test('pay once: dollars at the rate, money taken on return, credits added once', async () => {
  const c = await api('POST', '/billing/checkout', { token: shop.token, body: { kind: 'token_pack', token_pack_id: pack.id, method: 'paypal' } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.equal(c.data.next, 'paypal');
  assert.match(c.data.paypal.approve_url, /checkoutnow\?token=O-/);
  const usd = cents(Number(pack.price), 300);
  assert.equal(c.data.paypal.amount_usd, usd);
  assert.equal(c.data.payment.amount, Number(pack.price)); // rupees stay the price
  const id = c.data.payment.id;
  const orderId = c.data.paypal.approve_url.split('token=')[1];
  assert.equal(orders.get(orderId).purchase_units[0].amount.value, usd.toFixed(2));

  // back too early (not approved) – still waiting, nothing added
  const early = await api('POST', `/billing/payments/${id}/paypal`, { token: shop.token });
  assert.equal(early.data.status, 'pending');

  orders.get(orderId).status = 'APPROVED';
  const before = await sql(`SELECT COUNT(*)::int AS n FROM token_adjustment WHERE company_id = $1`, [shop.companyId]);
  const [a, b] = await Promise.all([
    api('POST', `/billing/payments/${id}/paypal`, { token: shop.token }),
    api('POST', `/billing/payments/${id}/paypal`, { token: shop.token }),
  ]);
  assert.equal(a.data.status, 'paid'); assert.equal(b.data.status, 'paid');
  // the webhook for the same capture changes nothing
  const capId = orders.get(orderId).purchase_units[0].payments.captures[0].id;
  assert.equal(await hook({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: capId, supplementary_data: { related_ids: { order_id: orderId } } } }), 200);
  const after = await sql(`SELECT COUNT(*)::int AS n FROM token_adjustment WHERE company_id = $1`, [shop.companyId]);
  assert.equal(after[0].n - before[0].n, 1);
  const [row] = await sql(`SELECT paypal_payment_id, amount_usd, usd_rate, invoice_no FROM platform_payment WHERE id = $1`, [id]);
  assert.equal(row.paypal_payment_id, capId);
  assert.equal(Number(row.amount_usd), usd);
  assert.ok(row.invoice_no);
  const inv = await api('GET', `/billing/payments/${id}/invoice`, { token: shop.token, raw: true });
  assert.equal(inv.status, 200);
});

test('a buyer who never comes back: the webhook takes the money', async () => {
  const c = await api('POST', '/billing/checkout', { token: shop.token, body: { kind: 'token_pack', token_pack_id: pack.id, method: 'paypal' } });
  const orderId = c.data.paypal.approve_url.split('token=')[1];
  orders.get(orderId).status = 'APPROVED';
  assert.equal(await hook({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: orderId } }), 200);
  const [row] = await sql(`SELECT status FROM platform_payment WHERE id = $1`, [c.data.payment.id]);
  assert.equal(row.status, 'paid');
});

test('webhooks not confirmed by PayPal are refused', async () => {
  const c = await api('POST', '/billing/checkout', { token: shop.token, body: { kind: 'token_pack', token_pack_id: pack.id, method: 'paypal' } });
  const orderId = c.data.paypal.approve_url.split('token=')[1];
  orders.get(orderId).status = 'APPROVED';
  assert.equal(await hook({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: orderId } }, 'forged'), 400);
  const [row] = await sql(`SELECT status FROM platform_payment WHERE id = $1`, [c.data.payment.id]);
  assert.equal(row.status, 'pending');
});

test('markup and fixed rate (super admin)', async () => {
  let r = await api('PUT', '/super-admin/billing/settings/paypal', { token: shop.token, body: { rate_mode: 'fixed', fixed_rate: 310 } });
  assert.equal(r.status, 403);
  r = await api('PUT', '/super-admin/billing/settings/paypal', { token: admin.token, body: { rate_mode: 'fixed', fixed_rate: 310, markup_percent: 4 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const c = await api('POST', '/billing/checkout', { token: shop.token, body: { kind: 'token_pack', token_pack_id: pack.id, method: 'paypal' } });
  assert.equal(c.data.paypal.amount_usd, cents(Number(pack.price), 310, 4));
  r = await api('PUT', '/super-admin/billing/settings/paypal', { token: admin.token, body: { rate_mode: 'fixed' } });
  assert.equal(r.status, 400);
  await api('PUT', '/super-admin/billing/settings/paypal', { token: admin.token, body: { rate_mode: 'auto', markup_percent: 0 } });
});

test('auto-renew: PayPal subscription; each later charge extends the package; switching off cancels it at PayPal', async () => {
  const c = await api('POST', '/billing/checkout', { token: shop.token, body: { kind: 'subscription', package_id: pkg.id, billing_cycle: 'monthly', method: 'paypal', auto_renew: true } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.match(c.data.paypal.approve_url, /subscribe\?ba=I-/);
  const subId = c.data.paypal.approve_url.split('ba=')[1];
  const usd = cents(Number(pkg.price_monthly), 300);
  assert.equal(plans.get(subs.get(subId).plan_id).billing_cycles[0].pricing_scheme.fixed_price.value, usd.toFixed(2));
  assert.equal(plans.get(subs.get(subId).plan_id).billing_cycles[0].frequency.interval_unit, 'MONTH');
  const id = c.data.payment.id;

  // ACTIVE but PayPal has not taken the first payment yet → not paid
  subs.get(subId).status = 'ACTIVE';
  const wait = await api('POST', `/billing/payments/${id}/paypal`, { token: shop.token });
  assert.equal(wait.data.status, 'pending');
  // first payment for a wrong amount → still not paid
  subs.get(subId).billing_info = { last_payment: { amount: { currency_code: 'USD', value: '0.50' } } };
  assert.equal((await api('POST', `/billing/payments/${id}/paypal`, { token: shop.token })).data.status, 'pending');
  subs.get(subId).billing_info = { last_payment: { amount: { currency_code: 'USD', value: usd.toFixed(2) } } };
  const ok = await api('POST', `/billing/payments/${id}/paypal`, { token: shop.token });
  assert.equal(ok.data.status, 'paid');
  let o = await api('GET', '/billing/overview', { token: shop.token });
  assert.equal(o.data.subscription.auto_renew, true);
  const end1 = new Date(o.data.subscription.period_end).getTime();

  // the first charge (same days) belongs to the first payment – no extra month
  const sale = (sid, total = usd.toFixed(2)) => ({ event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: sid, billing_agreement_id: subId, amount: { total, currency: 'USD' }, create_time: new Date().toISOString() } });
  assert.equal(await hook(sale(`SALE-${R}-1`)), 200);
  o = await api('GET', '/billing/overview', { token: shop.token });
  assert.equal(new Date(o.data.subscription.period_end).getTime(), end1);

  // next month's charge → a renewal payment, one more month
  assert.equal(await hook(sale(`SALE-${R}-2`)), 200);
  assert.equal(await hook(sale(`SALE-${R}-2`)), 200); // PayPal sends again – counted once
  assert.equal(await hook(sale(`SALE-${R}-3`, '0.01')), 200); // wrong amount – ignored
  o = await api('GET', '/billing/overview', { token: shop.token });
  const end2 = new Date(o.data.subscription.period_end).getTime();
  assert.ok(end2 - end1 > 27 * 86_400_000, 'extended by a month');
  const renewals = await sql(`SELECT status, description FROM platform_payment WHERE paypal_subscription_id = $1 ORDER BY id`, [subId]);
  assert.equal(renewals.length, 2);
  assert.match(renewals[1].description, /\(auto-renew\)$/);

  // PayPal fails to cancel → nothing changes here (else PayPal keeps charging silently)
  subs.get(subId).failCancel = true;
  const fail = await api('POST', '/billing/auto-renew', { token: shop.token, body: { enabled: false } });
  assert.equal(fail.status, 400);
  o = await api('GET', '/billing/overview', { token: shop.token });
  assert.equal(o.data.subscription.auto_renew, true);
  subs.get(subId).failCancel = false;
  const off = await api('POST', '/billing/auto-renew', { token: shop.token, body: { enabled: false } });
  assert.equal(off.status, 201, JSON.stringify(off.json));
  assert.match(off.data.message, /PayPal/);
  assert.equal(subs.get(subId).status, 'CANCELLED');
  o = await api('GET', '/billing/overview', { token: shop.token });
  assert.equal(o.data.subscription.auto_renew, false);
});

test('PayPal stops a subscription → auto-renew off and the owner is told', async () => {
  const c = await api('POST', '/billing/checkout', { token: shop.token, body: { kind: 'subscription', package_id: pkg.id, billing_cycle: 'monthly', method: 'paypal', auto_renew: true } });
  const subId = c.data.paypal.approve_url.split('ba=')[1];
  subs.get(subId).status = 'ACTIVE';
  subs.get(subId).billing_info = { last_payment: { amount: { currency_code: 'USD', value: cents(Number(pkg.price_monthly), 300).toFixed(2) } } };
  assert.equal(await hook({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: subId } }), 200);
  let o = await api('GET', '/billing/overview', { token: shop.token });
  assert.equal(o.data.subscription.auto_renew, true);
  assert.equal(await hook({ event_type: 'BILLING.SUBSCRIPTION.SUSPENDED', resource: { id: subId } }), 200);
  o = await api('GET', '/billing/overview', { token: shop.token });
  assert.equal(o.data.subscription.auto_renew, false);
  const [note] = await sql(`SELECT title FROM bot_notification WHERE company_id = $1 AND kind = 'billing' ORDER BY id DESC LIMIT 1`, [shop.companyId]);
  assert.match(note.title, /PayPal auto-renew stopped/);
});

test('first charge only by webhook (no return page) pays the first payment; an old subscription never switches anything on', async () => {
  const usdA = cents(Number(pkg.price_monthly), 300).toFixed(2);
  const startSub = async () => {
    const c = await api('POST', '/billing/checkout', { token: shop.token, body: { kind: 'subscription', package_id: pkg.id, billing_cycle: 'monthly', method: 'paypal', auto_renew: true } });
    return { id: c.data.payment.id, subId: c.data.paypal.approve_url.split('ba=')[1] };
  };
  const sale = (subId, sid) => ({ event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: sid, billing_agreement_id: subId, amount: { total: usdA, currency: 'USD' }, create_time: new Date().toISOString() } });
  const a = await startSub();
  assert.equal(await hook(sale(a.subId, `SA-${Date.now()}`)), 200);
  let [row] = await sql(`SELECT status FROM platform_payment WHERE id = $1`, [a.id]);
  assert.equal(row.status, 'paid');

  // a new subscription B replaces A; A still charges once → recorded for a refund, B stays, period unchanged
  const b = await startSub();
  assert.equal(await hook(sale(b.subId, `SB-${Date.now()}`)), 200);
  let o = await api('GET', '/billing/overview', { token: shop.token });
  const end = o.data.subscription.period_end;
  subs.get(a.subId).status = 'ACTIVE'; // pretend the cancel of A did not happen
  assert.equal(await hook(sale(a.subId, `SA2-${Date.now()}`)), 200);
  o = await api('GET', '/billing/overview', { token: shop.token });
  assert.equal(o.data.subscription.period_end, end);
  const [stray] = await sql(`SELECT status, reject_reason FROM platform_payment WHERE paypal_subscription_id = $1 ORDER BY id DESC LIMIT 1`, [a.subId]);
  assert.equal(stray.status, 'cancelled');
  assert.match(stray.reject_reason, /refund/);
  assert.equal(subs.get(b.subId).status !== 'CANCELLED', true);
  [row] = await sql(`SELECT paypal_subscription_id FROM company_subscription WHERE company_id = $1`, [shop.companyId]);
  assert.equal(row.paypal_subscription_id, b.subId);
  await api('POST', '/billing/auto-renew', { token: shop.token, body: { enabled: false } });
});

test('a PayPal refund marks the payment refunded and takes the credits back', async () => {
  const c = await api('POST', '/billing/checkout', { token: shop.token, body: { kind: 'token_pack', token_pack_id: pack.id, method: 'paypal' } });
  const orderId = c.data.paypal.approve_url.split('token=')[1];
  orders.get(orderId).status = 'APPROVED';
  await api('POST', `/billing/payments/${c.data.payment.id}/paypal`, { token: shop.token });
  const capId = orders.get(orderId).purchase_units[0].payments.captures[0].id;
  const refund = { event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: `R-${capId}`, amount: { value: c.data.paypal.amount_usd.toFixed(2), currency_code: 'USD' }, links: [{ rel: 'up', href: `https://api.paypal.com/v2/payments/captures/${capId}` }] } };
  assert.equal(await hook(refund), 200);
  assert.equal(await hook(refund), 200); // twice – handled once
  const [row] = await sql(`SELECT status FROM platform_payment WHERE id = $1`, [c.data.payment.id]);
  assert.equal(row.status, 'refunded');
  const back = await sql(`SELECT tokens FROM token_adjustment WHERE company_id = $1 AND reason LIKE 'Refunded:%'`, [shop.companyId]);
  assert.equal(back.length, 1);
  assert.equal(Number(back[0].tokens), -Number(pack.tokens));
});
