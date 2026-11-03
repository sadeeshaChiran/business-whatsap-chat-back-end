/**
 * Hidden features (Nov 2026): SMS and the Customer app are off for every business until a super admin switches them on
 * for that company. Off = the API refuses them (403, clear message), the menus are hidden (features.sms / customer_app
 * false), no SMS packs in Billing, the Inbox "Send SMS" check just says not ready. Switching the Customer app off also
 * closes the app link. Only super admins can switch them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, closeDb, createSuperAdmin, createWorkspace, sql } from './helpers.mjs';

let admin; let shop;
const limits = async () => (await api('GET', '/billing/usage', { token: shop.token })).data.limits.features;
const forget = () => new Promise((r) => setTimeout(r, 50));

test.before(async () => {
  admin = await createSuperAdmin();
  shop = await createWorkspace('hiddenfeat', { hidden: false });
});
test.after(async () => { await closeDb(); });

test('a new business does not get SMS or the Customer app', async () => {
  const f = await limits();
  assert.equal(f.sms, false);
  assert.equal(f.customer_app, false);
  const s = await api('GET', '/sms/settings', { token: shop.token });
  assert.equal(s.status, 403);
  assert.match(s.json.message, /not switched on for your business/);
  const ready = await api('GET', '/sms/ready', { token: shop.token });
  assert.equal(ready.status, 200);
  assert.equal(ready.data.connected, false);
  const app = await api('GET', '/customer-app/settings', { token: shop.token });
  assert.equal(app.status, 403);
  const enable = await api('PUT', '/customer-app/settings', { token: shop.token, body: { enabled: true } });
  assert.equal(enable.status, 403);
  const billing = await api('GET', '/billing/overview', { token: shop.token });
  if (billing.status === 200) assert.deepEqual(billing.data.sms_packs ?? [], []);
});

test('only a super admin can switch them', async () => {
  const r = await api('PUT', `/super-admin/companies/${shop.companyId}/hidden-features/sms`, { token: shop.token, body: { on: true } });
  assert.equal(r.status, 403);
  const bad = await api('PUT', `/super-admin/companies/${shop.companyId}/hidden-features/telegram`, { token: admin.token, body: { on: true } });
  assert.equal(bad.status, 400);
});

test('switched on: the business can use them; listed in the overview', async () => {
  for (const key of ['sms', 'customer_app']) {
    const r = await api('PUT', `/super-admin/companies/${shop.companyId}/hidden-features/${key}`, { token: admin.token, body: { on: true, note: 'pilot' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.data.find((x) => x.key === key).on, true);
  }
  await forget();
  const f = await limits();
  assert.equal(f.sms, true);
  assert.equal(f.customer_app, true);
  assert.equal((await api('GET', '/sms/settings', { token: shop.token })).status, 200);
  assert.equal((await api('GET', '/customer-app/settings', { token: shop.token })).status, 200);
  const on = await api('PUT', '/customer-app/settings', { token: shop.token, body: { enabled: true } });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  const all = await api('GET', '/super-admin/hidden-features', { token: admin.token });
  assert.equal(all.status, 200);
  const app = all.data.find((x) => x.key === 'customer_app');
  assert.ok(app.companies.some((c) => c.id === Number(shop.companyId) && c.note === 'pilot'));
});

test('switched off: refused again and the app link is closed', async () => {
  for (const key of ['sms', 'customer_app']) {
    const r = await api('PUT', `/super-admin/companies/${shop.companyId}/hidden-features/${key}`, { token: admin.token, body: { on: false } });
    assert.equal(r.status, 200);
  }
  await forget();
  assert.equal((await api('GET', '/sms/settings', { token: shop.token })).status, 403);
  assert.equal((await api('GET', '/customer-app/settings', { token: shop.token })).status, 403);
  const [row] = await sql(`SELECT enabled FROM ca_settings WHERE company_id = $1`, [shop.companyId]);
  assert.equal(row.enabled, false);
  const f = await limits();
  assert.equal(f.sms, false);
  assert.equal(f.customer_app, false);
});
