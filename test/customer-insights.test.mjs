/**
 * Customer insights (visits → results → groups) and the per-click result of Ads & leads:
 * a customer who bought before and comes back from an ad without ordering is NOT counted as a win for that ad.
 * Run against a running API + TEST database:  node --test test/customer-insights.test.mjs
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, closeDb, createAgent, createWorkspace, sql } from './helpers.mjs';

let owner;
const ago = (days) => `NOW() - INTERVAL '${days} days'`;
const people = {};

/** A customer with visits: each visit = an inbound message (+ optional bot reply) at that day. */
async function customer(key, platform, name) {
  const [cu] = await sql(`INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name, created_at)
    VALUES ($1, $2, $3, $4, NOW() - INTERVAL '90 days') RETURNING id`, [owner.companyId, platform, `ins-${key}-${Date.now()}`, name]);
  const [cv] = await sql(`INSERT INTO bot_conversation (bot_channel_user_id, created_at) VALUES ($1, NOW() - INTERVAL '90 days') RETURNING id`, [cu.id]);
  people[key] = { uid: cu.id, conv: cv.id, platform };
  return people[key];
}
async function visit(p, days, { reply = true, order = 0, lost = false, ad = null } = {}) {
  if (ad) {
    await sql(`INSERT INTO marketing_ad_click (company_id, conversation_id, bot_channel_user_id, platform, ad_id, source_type, headline, clicked_at)
      VALUES ($1, $2, $3, $4, $5, 'ad', $6, ${ago(days)} - INTERVAL '1 minute')`, [owner.companyId, p.conv, p.uid, p.platform, ad.id, ad.headline]);
  }
  await sql(`INSERT INTO bot_message (conversation_id, direction, message_type, platform, content, created_at) VALUES ($1, 'inbound', 'text', $2, 'hi', ${ago(days)})`, [p.conv, p.platform]);
  if (reply) await sql(`INSERT INTO bot_message (conversation_id, direction, message_type, platform, content, created_at) VALUES ($1, 'outbound', 'text', $2, 'hello!', ${ago(days)} + INTERVAL '1 minute')`, [p.conv, p.platform]);
  if (order) await sql(`INSERT INTO bot_order (company_id, bot_channel_user_id, customer_name, status, total_amount, created_by, created_at) VALUES ($1, $2, 'x', 'Pending', $3, 'bot', ${ago(days)} + INTERVAL '5 minutes')`, [owner.companyId, p.uid, order]);
  if (lost) await sql(`INSERT INTO lead_stage_event (conversation_id, bot_channel_user_id, from_stage, to_stage, changed_at) VALUES ($1, $2, 'contacted', 'lost', ${ago(days)} + INTERVAL '10 minutes')`, [p.conv, p.uid]);
}

before(async () => {
  owner = await createWorkspace('insights');
  await sql(`UPDATE companies SET plan = 'growth', bot_enabled = false WHERE id = $1`, [owner.companyId]);
  const AD = { id: `ins-ad-${Date.now()}`, headline: 'Logo design Rs 5,000' };
  people.ad = AD;
  // slipping: bought twice, then came back from an ad and did not buy (stage still "won" from the old order)
  const a = await customer('slipping', 'whatsapp', 'Kasuni');
  await visit(a, 60, { order: 4000 }); await visit(a, 30, { order: 6000 }); await visit(a, 10, { ad: AD });
  await sql(`UPDATE bot_conversation SET lead_stage = 'won' WHERE id = $1`, [a.conv]);
  // the stage became "won" with the second order (30 days ago), not now
  await sql(`UPDATE lead_stage_event SET changed_at = NOW() - INTERVAL '30 days' + INTERVAL '6 minutes' WHERE conversation_id = $1`, [a.conv]);
  // loyal
  const b = await customer('loyal', 'whatsapp', 'Amal');
  await visit(b, 40, { order: 3000 }); await visit(b, 5, { order: 2500 });
  // lost again and again
  const c = await customer('lostrepeat', 'whatsapp', 'Nimal');
  await visit(c, 50, { lost: true }); await visit(c, 20, { lost: true });
  // in talks now (Messenger)
  const d = await customer('pending', 'messenger', 'Sadeesha');
  await visit(d, 2);
  // went quiet (Instagram)
  const e = await customer('quiet', 'instagram', 'Dilini');
  await visit(e, 20, { reply: false });
  // came many times, never bought
  const f = await customer('browsers', 'whatsapp', 'Ruwan');
  await visit(f, 30); await visit(f, 15);
  // bought once before, not this time
  const g = await customer('lapsed', 'whatsapp', 'Saman');
  await visit(g, 40, { order: 1500 }); await visit(g, 9);
  // two messages 1 day apart = the same visit (not a return)
  const h = await customer('onetime', 'messenger', 'Chamari');
  await visit(h, 12); await visit(h, 11, { order: 2000 });
});
after(closeDb);

describe('Customer insights', () => {
  test('visits, results and groups per customer', async () => {
    const r = await api('GET', '/crm/insights?days=365', { token: owner.token });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const byId = new Map(r.data.customers.map((c) => [c.id, c]));
    const seg = (key) => byId.get(people[key].uid)?.segment;
    assert.equal(seg('slipping'), 'slipping');
    assert.equal(seg('loyal'), 'loyal');
    assert.equal(seg('lostrepeat'), 'lost_repeat');
    assert.equal(seg('pending'), 'pending');
    assert.equal(seg('quiet'), 'quiet');
    assert.equal(seg('browsers'), 'browsers');
    assert.equal(seg('lapsed'), 'lapsed');
    assert.equal(seg('onetime'), 'one_time');

    const kasuni = byId.get(people.slipping.uid);
    assert.deepEqual([kasuni.visits, kasuni.wins, kasuni.losses, kasuni.orders, kasuni.revenue], [3, 2, 0, 2, 10000]);
    assert.equal(kasuni.history[0].from_ad, true);
    assert.equal(kasuni.history[0].ad_headline, 'Logo design Rs 5,000');
    assert.equal(kasuni.history[0].result, 'open');
    assert.equal(byId.get(people.onetime.uid).visits, 1, 'messages a day apart are one visit');

    const wa = r.data.channels.find((c) => c.platform === 'whatsapp');
    assert.equal(wa.customers, 5);
    assert.ok(r.data.segments.find((s) => s.key === 'pending').by_platform.messenger >= 1);
    assert.ok(r.data.assessment.length >= 3);
    assert.ok(r.data.assessment.some((line) => /bought before but did not buy/.test(line)));

    const wonly = await api('GET', '/crm/insights?days=365&platform=instagram', { token: owner.token });
    assert.deepEqual(wonly.data.customers.map((c) => c.platform), ['instagram']);
  });

  test('a group can be saved as a tag (for broadcasts and audiences)', async () => {
    const r = await api('POST', '/crm/insights/tag', { token: owner.token, body: { segment: 'slipping', tag: 'Come-back', days: 365 } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.data.tagged, 1);
    const [row] = await sql(`SELECT tags FROM crm_contact WHERE bot_channel_user_id = $1`, [people.slipping.uid]);
    assert.deepEqual(row.tags, ['come-back']);
  });

  test('agents cannot open it', async () => {
    const agent = await createAgent(owner, 'insights-agent');
    assert.equal((await api('GET', '/crm/insights', { token: agent.token })).status, 403);
  });
});

describe('Ads & leads: result per click', () => {
  test('a returning buyer who clicked an ad and did not order is "talking", marked as bought before', async () => {
    const r = await api('GET', `/marketing/ad-report/${encodeURIComponent(people.ad.id)}?days=90`, { token: owner.token });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const kasuni = r.data.people.find((p) => p.contact_user_id === people.slipping.uid);
    assert.equal(kasuni.outcome, 'talking');
    assert.equal(kasuni.bought_before, true);
    assert.equal(kasuni.prior_orders, 2);
    assert.equal(r.data.totals.won, 0);
    assert.equal(r.data.totals.returning_buyers, 1);
  });

  test('every stage change is recorded with its time (trigger)', async () => {
    const p = people.loyal;
    await sql(`UPDATE bot_conversation SET lead_stage = 'proposal' WHERE id = $1`, [p.conv]);
    const [e] = await sql(`SELECT from_stage, to_stage FROM lead_stage_event WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`, [p.conv]);
    assert.deepEqual([e.from_stage, e.to_stage], ['new', 'proposal']);
  });
});
