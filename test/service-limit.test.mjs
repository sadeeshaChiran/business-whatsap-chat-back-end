/** Package limit on services (max_services). Run against a running API + TEST database: node --test test/service-limit.test.mjs */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { api, closeDb, createSuperAdmin, createWorkspace, sql } from './helpers.mjs';

let A; let S; let pkgId; let before0;
before(async () => {
  A = await createWorkspace('svc-limit', { category: 'service' });
  const [row] = await sql(`SELECT p.id, p.max_services FROM platform_package p JOIN companies c ON c.plan = p.code WHERE c.id = $1`, [A.companyId]);
  pkgId = row.id; before0 = row.max_services;
  S = await createSuperAdmin();
  const set = await api('PATCH', `/super-admin/packages/${pkgId}`, { token: S.token, body: { max_services: 2 } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(set.data.max_services, 2, 'super admin can set the services limit');
});
after(async () => { await api('PATCH', `/super-admin/packages/${pkgId}`, { token: S.token, body: { max_services: before0 } }); await closeDb(); });

test('services stop at the package limit with an upgrade message', async () => {
  for (const name of ['Haircut', 'Facial']) {
    const r = await api('POST', '/bot/services', { token: A.token, body: { name, price: 1500 } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
  }
  const third = await api('POST', '/bot/services', { token: A.token, body: { name: 'Manicure', price: 1200 } });
  assert.equal(third.status, 403);
  assert.match(third.json.message, /allows 2 services \(you have 2\)/);
  const me = await api('GET', '/billing/packages', { token: A.token });
  if (me.status === 200) assert.ok(JSON.stringify(me.json).includes('max_services'), 'packages show the services limit');
});
