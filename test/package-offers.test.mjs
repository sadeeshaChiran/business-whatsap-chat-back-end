/**
 * Package offer prices – run against a running API + TEST database:
 *   node --test test/package-offers.test.mjs
 * Uses its own temporary package (real packages are not changed).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { RUN, api, closeDb, createSuperAdmin, createWorkspace, sql } from './helpers.mjs';

const lkDate = (days) => new Date(Date.now() + 5.5 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);
let superAdmin;
let company;
let pkgId;
const code = `offer-${RUN}`.toLowerCase().replace(/[^a-z0-9_-]/g, '');

before(async () => {
  superAdmin = await createSuperAdmin();
  company = await createWorkspace('offer');
});

after(async () => {
  if (pkgId) await sql('DELETE FROM platform_payment WHERE package_id = $1', [pkgId]).catch(() => undefined);
  if (pkgId) await sql('DELETE FROM platform_package WHERE id = $1', [pkgId]).catch(() => undefined);
  await closeDb();
});

describe('Package offer prices', () => {
  test('super admin creates a package with an offer; bad offers are refused', async () => {
    const base = { code, name: 'Offer test', price_monthly: 10000, price_yearly: 100000, tokens_per_month: 18_750_000, sort_order: 99 };
    const tooHigh = await api('POST', '/super-admin/packages', { token: superAdmin.token, body: { ...base, offer_price_monthly: 10000, offer_until: lkDate(30) } });
    assert.equal(tooHigh.status, 400);
    const noDate = await api('POST', '/super-admin/packages', { token: superAdmin.token, body: { ...base, offer_price_monthly: 7490 } });
    assert.equal(noDate.status, 400);
    const badDate = await api('POST', '/super-admin/packages', { token: superAdmin.token, body: { ...base, offer_price_monthly: 7490, offer_until: '31/12/2026' } });
    assert.equal(badDate.status, 400);
    const notAdmin = await api('POST', '/super-admin/packages', { token: company.token, body: { ...base, offer_price_monthly: 7490, offer_until: lkDate(30) } });
    assert.equal(notAdmin.status, 403);

    const created = await api('POST', '/super-admin/packages', {
      token: superAdmin.token, body: { ...base, offer_price_monthly: 7490, offer_until: lkDate(30), offer_label: ' Launch offer ' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    pkgId = created.data.id;
    assert.equal(created.data.offer_price_monthly, 7490);
    assert.equal(created.data.offer_until, lkDate(30));
    assert.deepEqual(created.data.offer, { price_monthly: 7490, price_yearly: null, until: lkDate(30), label: 'Launch offer' });
  });

  test('pricing page shows the offer and the reply count', async () => {
    const list = await api('GET', '/public/packages');
    const pkg = list.data.find((p) => p.code === code);
    assert.ok(pkg, 'package listed');
    assert.equal(pkg.offer.price_monthly, 7490);
    assert.equal(pkg.offer.until, lkDate(30));
    assert.ok(pkg.approx_replies > 0);
  });

  test('checkout charges the offer price once (monthly) and the normal price for yearly', async () => {
    const monthly = await api('POST', '/billing/checkout', { token: company.token, body: { kind: 'subscription', package_id: pkgId, billing_cycle: 'monthly', method: 'bank_transfer' } });
    assert.equal(monthly.status, 201, JSON.stringify(monthly.json));
    assert.equal(Number(monthly.data.payment.amount), 7490);
    assert.match(monthly.data.payment.description, /offer price, until/);
    assert.equal(monthly.data.payment.auto_renew, false);
    const yearly = await api('POST', '/billing/checkout', { token: company.token, body: { kind: 'subscription', package_id: pkgId, billing_cycle: 'yearly', method: 'bank_transfer' } });
    assert.equal(Number(yearly.data.payment.amount), 100000);
  });

  test('after the last day the normal price is charged automatically', async () => {
    const ended = await api('PATCH', `/super-admin/packages/${pkgId}`, { token: superAdmin.token, body: { offer_until: lkDate(-1) } });
    assert.equal(ended.status, 200, JSON.stringify(ended.json));
    assert.equal(ended.data.offer, null);
    const list = await api('GET', '/public/packages');
    assert.equal(list.data.find((p) => p.code === code).offer, null);
    const checkout = await api('POST', '/billing/checkout', { token: company.token, body: { kind: 'subscription', package_id: pkgId, billing_cycle: 'monthly', method: 'bank_transfer' } });
    assert.equal(Number(checkout.data.payment.amount), 10000);
  });

  test('the offer can be removed', async () => {
    const cleared = await api('PATCH', `/super-admin/packages/${pkgId}`, { token: superAdmin.token, body: { offer_price_monthly: null, offer_until: null, offer_label: '' } });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
    assert.equal(cleared.data.offer_price_monthly, null);
    assert.equal(cleared.data.offer_until, null);
  });
});
