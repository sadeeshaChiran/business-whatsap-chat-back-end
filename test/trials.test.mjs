/**
 * Free trials, sign-up trial, Free package "AI bot only the first month", credits that open Messenger / Instagram / comments,
 * and custom packages for one company. Run against a running API + TEST database:
 *   node --test test/trials.test.mjs
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, closeDb, createSuperAdmin, createWorkspace, sql } from './helpers.mjs';

let superAdmin;
let shop;
let growth;
let free;
let signupBefore;

const usage = async (ws) => (await api('GET', '/billing/usage', { token: ws.token })).data;

before(async () => {
  superAdmin = await createSuperAdmin();
  [growth] = await sql(`SELECT id, code, name FROM platform_package WHERE code = 'growth'`);
  [free] = await sql(`SELECT id, code FROM platform_package WHERE code = 'free'`);
  signupBefore = (await api('GET', '/super-admin/signup-trial', { token: superAdmin.token })).data;
});

after(async () => {
  if (signupBefore) await api('PUT', '/super-admin/signup-trial', { token: superAdmin.token, body: signupBefore });
  await closeDb();
});

describe('New sign-ups', () => {
  test('start on Free right away (no "choose a package" wall) with 30 free AI-bot days', async () => {
    const ws = await createWorkspace('trial-new', { plan: null });
    const [company] = await sql(`SELECT plan FROM companies WHERE id = $1`, [ws.companyId]);
    assert.equal(company.plan, 'free');
    assert.equal(ws.user.company_plan ?? 'free', 'free');
    const u = await usage(ws);
    assert.equal(u.package.code, 'free');
    assert.ok(u.free_bot_until, 'free bot days set');
    const days = (new Date(u.free_bot_until) - Date.now()) / 86_400_000;
    assert.ok(days > 29 && days <= 30, `about 30 days, got ${days}`);
    assert.equal(u.blocked, false);
  });

  test('sign-up trial: when switched on, a new company gets Growth free for 14 days', async () => {
    const off = await api('PUT', '/super-admin/signup-trial', { token: superAdmin.token, body: { enabled: true, package_id: null, days: 14 } });
    assert.equal(off.status, 400, 'enabled needs a package');
    const on = await api('PUT', '/super-admin/signup-trial', { token: superAdmin.token, body: { enabled: true, package_id: growth.id, days: 14 } });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    const ws = await createWorkspace('trial-signup', { plan: null });
    const u = await usage(ws);
    assert.equal(u.package.code, 'growth');
    assert.ok(u.trial, 'trial info');
    assert.equal(u.trial.back_to, 'Free');
    const days = (new Date(u.trial.ends_at) - Date.now()) / 86_400_000;
    assert.ok(days > 13.9 && days <= 14);
    const [row] = await sql(`SELECT source FROM company_trial WHERE company_id = $1`, [ws.companyId]);
    assert.equal(row.source, 'signup');
    await api('PUT', '/super-admin/signup-trial', { token: superAdmin.token, body: { enabled: false, package_id: growth.id, days: 14 } });
  });
});

describe('Trials given by the super admin', () => {
  before(async () => { shop = await createWorkspace('trial-shop'); });

  test('only the super admin can give trials', async () => {
    const r = await api('POST', `/super-admin/companies/${shop.companyId}/trial`, { token: shop.token, body: { package_id: growth.id, days: 30 } });
    assert.equal(r.status, 403);
  });

  test('Growth free for 30 days: features open, notification sent; when it ends the company is back on Free', async () => {
    const r = await api('POST', `/super-admin/companies/${shop.companyId}/trial`, { token: superAdmin.token, body: { package_id: growth.id, days: 30, note: 'Facebook promo' } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    let u = await usage(shop);
    assert.equal(u.package.code, 'growth');
    assert.equal(u.trial.note, 'Facebook promo');
    const [note] = await sql(`SELECT title FROM bot_notification WHERE company_id = $1 ORDER BY id DESC LIMIT 1`, [shop.companyId]);
    assert.match(note.title, /Growth free for 30 days/);
    // the trial date passes
    await sql(`UPDATE company_subscription SET period_end = NOW() - INTERVAL '1 minute' WHERE company_id = $1`, [shop.companyId]);
    u = await usage(shop);
    assert.equal(u.package.code, 'free');
    assert.equal(u.status, 'active', 'not "expired" – back to Free');
    assert.equal(u.trial, null);
    const [company] = await sql(`SELECT plan FROM companies WHERE id = $1`, [shop.companyId]);
    assert.equal(company.plan, 'free');
    const [ended] = await sql(`SELECT title FROM bot_notification WHERE company_id = $1 ORDER BY id DESC LIMIT 1`, [shop.companyId]);
    assert.match(ended.title, /trial has ended/);
    const [t] = await sql(`SELECT ended_at, converted FROM company_trial WHERE company_id = $1`, [shop.companyId]);
    assert.ok(t.ended_at);
    assert.equal(t.converted, false);
  });

  test('bulk trial for many companies; a company that pays now is skipped; stop a trial early', async () => {
    const a = await createWorkspace('trial-bulk-a');
    const b = await createWorkspace('trial-bulk-b');
    const [starter] = await sql(`SELECT id FROM platform_package WHERE code = 'starter'`);
    await api('PATCH', `/super-admin/companies/${b.companyId}/subscription`, { token: superAdmin.token, body: { package_id: starter.id } });
    const r = await api('POST', '/super-admin/trials', { token: superAdmin.token, body: { company_ids: [a.companyId, b.companyId], package_id: growth.id, days: 60 } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.data.given, 1);
    assert.equal(r.data.skipped[0].id, b.companyId);
    assert.match(r.data.skipped[0].reason, /pays for/);
    const stop = await api('DELETE', `/super-admin/companies/${a.companyId}/trial`, { token: superAdmin.token });
    assert.equal(stop.status, 200);
    assert.equal((await usage(a)).package.code, 'free');
    const report = await api('GET', '/super-admin/trials', { token: superAdmin.token });
    assert.ok(report.data.totals.given >= 2);
  });

  test('paying for the package during the trial keeps it: paid month starts after the trial', async () => {
    const ws = await createWorkspace('trial-pay');
    await api('POST', `/super-admin/companies/${ws.companyId}/trial`, { token: superAdmin.token, body: { package_id: growth.id, days: 10 } });
    const pay = await api('POST', '/billing/checkout', { token: ws.token, body: { kind: 'subscription', package_id: growth.id, method: 'bank_transfer' } });
    assert.equal(pay.status, 201, JSON.stringify(pay.json));
    const approve = await api('POST', `/super-admin/billing/payments/${pay.data.payment.id}/approve`, { token: superAdmin.token });
    assert.ok([200, 201].includes(approve.status), JSON.stringify(approve.json));
    const u = await usage(ws);
    assert.equal(u.package.code, 'growth');
    assert.equal(u.trial, null);
    const days = (new Date(u.period_end) - Date.now()) / 86_400_000;
    assert.ok(days > 38 && days < 42, `trial 10 days + 1 month, got ${days}`);
    const [t] = await sql(`SELECT converted FROM company_trial WHERE company_id = $1`, [ws.companyId]);
    assert.equal(t.converted, true);
  });
});

describe('Free package: AI bot only for the first month, credits open the bot and Messenger / Instagram / comments', () => {
  let ws;
  before(async () => {
    ws = await createWorkspace('trial-free');
    await sql(`UPDATE platform_package SET limits = limits || '{"messenger": false, "instagram": false, "social": false}'::jsonb WHERE code = 'free'`);
    await api('PATCH', `/super-admin/packages/${free.id}`, { token: superAdmin.token, body: { name: 'Free' } }); // clears the package cache
  });
  after(async () => {
    await sql(`UPDATE platform_package SET limits = limits - 'messenger' - 'instagram' - 'social' WHERE code = 'free'`);
    await api('PATCH', `/super-admin/packages/${free.id}`, { token: superAdmin.token, body: { name: 'Free' } });
  });

  test('after the free days the bot stops (free_ended), inbox features stay; Messenger is locked', async () => {
    await sql(`UPDATE company_subscription SET bot_free_until = NOW() - INTERVAL '1 hour' WHERE company_id = $1`, [ws.companyId]);
    const u = await usage(ws);
    assert.equal(u.free_bot_ended, true);
    assert.equal(u.blocked, true);
    assert.equal(u.blocked_reason, 'free_ended');
    assert.equal(u.quota, 0);
    assert.equal(u.limits.features.messenger, false);
    const locked = await api('GET', '/social/posts?platform=facebook', { token: ws.token });
    assert.equal(locked.status, 403);
    assert.match(locked.json.message, /buy AI credits/i);
  });

  test('buying credits switches the bot back on and opens Messenger, Instagram and Social', async () => {
    const [pack] = await sql(`SELECT id FROM token_pack WHERE is_active ORDER BY price LIMIT 1`);
    const pay = await api('POST', '/billing/checkout', { token: ws.token, body: { kind: 'token_pack', token_pack_id: pack.id, method: 'bank_transfer' } });
    assert.equal(pay.status, 201, JSON.stringify(pay.json));
    await api('POST', `/super-admin/billing/payments/${pay.data.payment.id}/approve`, { token: superAdmin.token });
    const u = await usage(ws);
    assert.equal(u.blocked, false);
    assert.equal(u.has_active_credits, true);
    assert.ok(u.remaining > 0);
    assert.equal(u.limits.features.messenger, true);
    assert.equal(u.limits.features.instagram, true);
    assert.equal(u.limits.features.social, true);
    assert.deepEqual(u.limits.unlocked_by_credits.sort(), ['instagram', 'messenger', 'social']);
  });

  test('when the bought credits expire, Messenger / Instagram lock again', async () => {
    await sql(`UPDATE token_adjustment SET expires_at = NOW() - INTERVAL '1 minute' WHERE company_id = $1`, [ws.companyId]);
    await api('PATCH', `/super-admin/packages/${free.id}`, { token: superAdmin.token, body: { name: 'Free' } });
    const u = await usage(ws);
    assert.equal(u.limits.features.messenger, false);
    assert.equal(u.blocked_reason, 'free_ended');
  });
});

describe('Custom package for one company', () => {
  test('made from Growth with own price and credits, assigned at once, only that company sees it', async () => {
    const ws = await createWorkspace('trial-custom');
    const other = await createWorkspace('trial-other');
    const r = await api('POST', `/super-admin/companies/${ws.companyId}/custom-package`, {
      token: superAdmin.token, body: { name: 'Saree House deal', base_package_id: growth.id, price_monthly: 9500, tokens_per_month: 45_000_000, max_agents: 8 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const pkg = r.data.package;
    assert.equal(pkg.company_id, ws.companyId);
    assert.equal(pkg.is_public, false);
    const u = await usage(ws);
    assert.equal(u.package.name, 'Saree House deal');
    assert.ok(u.period_end, 'paid custom package runs 1 month');
    const mine = await api('GET', '/billing/overview', { token: ws.token });
    assert.ok(mine.data.packages.some((p) => p.id === pkg.id && p.custom));
    const theirs = await api('GET', '/billing/overview', { token: other.token });
    assert.ok(!theirs.data.packages.some((p) => p.id === pkg.id));
    const steal = await api('POST', '/billing/checkout', { token: other.token, body: { kind: 'subscription', package_id: pkg.id, method: 'bank_transfer' } });
    assert.equal(steal.status, 400);
    const pub = await api('GET', '/public/packages');
    assert.ok(!pub.data.some((p) => p.code === pkg.code));
    const renew = await api('POST', '/billing/checkout', { token: ws.token, body: { kind: 'subscription', package_id: pkg.id, method: 'bank_transfer' } });
    assert.equal(renew.status, 201);
    assert.equal(renew.data.payment.amount, 9500);
    const assignOther = await api('PATCH', `/super-admin/companies/${other.companyId}/subscription`, { token: superAdmin.token, body: { package_id: pkg.id } });
    assert.equal(assignOther.status, 400);
  });
});

describe('Team handbook', () => {
  test('only super admins can read it, and it holds no secret values', async () => {
    const r = await api('GET', '/super-admin/handbook', { token: superAdmin.token });
    assert.equal(r.status, 200);
    const chapters = r.data.chapters;
    assert.ok(chapters.length >= 5, 'chapters loaded');
    for (const c of chapters) assert.ok(c.slug && c.title && c.markdown.length > 200, `chapter ${c.slug}`);
    const all = chapters.map((c) => c.markdown).join('\n');
    assert.doesNotMatch(all, /(EAA[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|postgres(ql)?:\/\/[^\s`]*:[^\s`]*@|sk_live_)/, 'no tokens / keys / DB passwords');
    const owner = await createWorkspace('handbook-owner');
    assert.equal((await api('GET', '/super-admin/handbook', { token: owner.token })).status, 403);
    assert.equal((await api('GET', '/super-admin/handbook')).status, 401);
  });
});
