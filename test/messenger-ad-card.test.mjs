/**
 * Messenger / Instagram chats from ads when Meta sends NO ad details: the customer replies to the ad card Meta shows
 * ("You replied to <Page>"), we read that card from Meta and count the chat as a lead from it; Instagram story replies
 * show the story; a normal ad click (messaging_referrals) on an existing chat reopens a won customer as a new lead;
 * the connection check lists what Meta sent. Needs the fake Meta env (META_GRAPH_BASE_URL=http://127.0.0.1:4599).
 *   node --test test/messenger-ad-card.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { API, api, closeDb, createWorkspace, sql } from './helpers.mjs';

const PAGE = `page-card-${Date.now()}`;
const IG = `ig-card-${Date.now()}`;
const R = Date.now().toString(36);
const CARD = `m_adcard_${R}`;
const OWN = `m_own_${R}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const meta = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname.replace(/^\/v[\d.]+/, '');
  if (path === '/card.png') { res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
  res.setHeader('Content-Type', 'application/json');
  if (path === `/${CARD}`) {
    return res.end(JSON.stringify({ id: CARD, created_time: new Date(Date.now() - 3600_000).toISOString(), from: { id: PAGE, name: 'MetroCoding' },
      message: 'new one – AI future tech course', attachments: { data: [{ mime_type: 'image/png', image_data: { url: 'http://127.0.0.1:4599/card.png' } }] } }));
  }
  if (path === `/${OWN}`) return res.end(JSON.stringify({ id: OWN, from: { id: 'psid-someone' }, message: 'my own text' }));
  if (req.method === 'POST') return res.end(JSON.stringify({ recipient_id: 'x', message_id: `m.out.${Date.now()}` }));
  if (req.method === 'GET') return res.end(JSON.stringify({ id: 'x', name: 'Sadeesha Chiran', first_name: 'Sadeesha' }));
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: 'not faked' } }));
});

let owner;
const sign = (raw) => `sha256=${createHmac('sha256', 'new-secret').update(raw).digest('hex')}`;
const hook = async (object, entryId, event) => {
  const raw = JSON.stringify({ object, entry: [{ id: entryId, time: Date.now(), messaging: [{ recipient: { id: entryId }, timestamp: Date.now(), ...event }] }] });
  const r = await fetch(`${API}/integrations/meta/messages/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) }, body: raw });
  assert.equal(r.status, 200, await r.text());
};
const convOf = async (psid) => (await sql(`SELECT c.id, c.lead_stage, c.ad_source_id, c.ad_headline, cu.id AS uid FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
  WHERE cu.company_id = $1 AND cu.external_user_id = $2`, [owner.companyId, psid]))[0];

test.before(async () => {
  await new Promise((resolve) => meta.listen(4599, '127.0.0.1', resolve));
  owner = await createWorkspace('adcard');
  await sql(`UPDATE companies SET plan = 'growth', bot_enabled = false WHERE id = $1`, [owner.companyId]);
  await sql(`INSERT INTO meta_page_connections (company_id, page_id, page_name, page_access_token, instagram_business_account_id, status, created_at, updated_at)
    VALUES ($1, $2, 'MetroCoding', 'tok', $3, 'CONNECTED', NOW(), NOW())`, [owner.companyId, PAGE, IG]);
});
test.after(async () => { meta.close(); await closeDb(); });

test('Messenger: a reply to the ad card (no ad details from Meta) becomes a lead with the card, and the AI sees what "this" is', async () => {
  const psid = `psid-card-${R}`;
  await hook('page', PAGE, { sender: { id: psid }, message: { mid: `m_in1_${R}`, text: 'Mata meka gana wistharayk kiyanna', reply_to: { mid: CARD } } });
  const conv = await convOf(psid);
  assert.ok(conv, 'chat created');
  const [click] = await sql(`SELECT source_type, headline, media_url, provider_message_id FROM marketing_ad_click WHERE conversation_id = $1`, [conv.id]);
  assert.equal(click.source_type, 'card');
  assert.equal(click.headline, 'new one – AI future tech course');
  assert.equal(click.provider_message_id, `m_in1_${R}`);
  assert.match(conv.ad_source_id, /^card-/);
  const [msg] = await sql(`SELECT reply_to_text FROM bot_message WHERE provider_message_id = $1`, [`m_in1_${R}`]);
  assert.equal(msg.reply_to_text, 'new one – AI future tech course');

  const origin = await api('GET', `/bot/conversations/${conv.id}/origin`, { token: owner.token });
  assert.equal(origin.status, 200);
  assert.equal(origin.data.clicks.length, 1);
  assert.equal(origin.data.clicks[0].headline, 'new one – AI future tech course');
  assert.ok(origin.data.clicks[0].message_id, 'linked to the customer message');

  // a second customer replying to the same card is counted on the same row of Ads & leads
  await hook('page', PAGE, { sender: { id: `${psid}-2` }, message: { mid: `m_in2_${R}`, text: 'price?', reply_to: { mid: CARD } } });
  const report = await api('GET', '/marketing/ad-report?days=30', { token: owner.token });
  const row = report.data.ads.find((a) => a.headline === 'new one – AI future tech course');
  assert.equal(row.people, 2);
  assert.equal(row.type, 'card');
});

test('Messenger: replying to the customer\'s own old message is just a quote, not a lead', async () => {
  const psid = `psid-own-${R}`;
  await hook('page', PAGE, { sender: { id: psid }, message: { mid: `m_in3_${R}`, text: 'hello again', reply_to: { mid: OWN } } });
  const conv = await convOf(psid);
  const clicks = await sql(`SELECT 1 FROM marketing_ad_click WHERE conversation_id = $1`, [conv.id]);
  assert.equal(clicks.length, 0);
});

test('Messenger ad click on an existing chat (messaging_referrals): counted, and a past buyer starts again as a new lead', async () => {
  const psid = `psid-ref-${R}`;
  await hook('page', PAGE, { sender: { id: psid }, message: { mid: `m_in4_${R}`, text: 'hi' } });
  const conv = await convOf(psid);
  await sql(`UPDATE bot_conversation SET lead_stage = 'won' WHERE id = $1`, [conv.id]);
  await hook('page', PAGE, { sender: { id: psid }, referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: `${R}777`, ads_context_data: { ad_title: 'Websites from Rs 20,000', photo_url: 'http://127.0.0.1:4599/card.png' } } });
  const after = await convOf(psid);
  assert.equal(after.ad_source_id, `${R}777`);
  assert.equal(after.ad_headline, 'Websites from Rs 20,000');
  assert.equal(after.lead_stage, 'new');
  const [event] = await sql(`SELECT from_stage, to_stage FROM lead_stage_event WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`, [conv.id]);
  assert.deepEqual([event.from_stage, event.to_stage], ['won', 'new']);
});

test('Instagram: a story reply shows the story in the chat; the connection check lists what Meta sent', async () => {
  const igsid = `igsid-${R}`;
  await hook('instagram', IG, { sender: { id: igsid }, message: { mid: `ig_in1_${R}`, text: 'meka kiyada?', reply_to: { story: { url: 'http://127.0.0.1:4599/card.png', id: `st${R}` } } } });
  const conv = await convOf(igsid);
  const rows = await sql(`SELECT direction::text, source, content, reply_to_text FROM bot_message WHERE conversation_id = $1 ORDER BY id`, [conv.id]);
  assert.deepEqual(rows.map((r) => [r.direction, r.source]), [['outbound', 'meta-context'], ['inbound', 'meta-webhook']]);
  assert.equal(rows[0].content, '📖 Your story');
  assert.equal(rows[1].reply_to_text, '📖 Your story');

  const health = await api('GET', '/integrations/meta/health', { token: owner.token });
  assert.equal(health.status, 200, JSON.stringify(health.json));
  const events = health.data.messenger.find((c) => c.key === 'meta_events');
  assert.match(events.detail, /referral: ADS, OPEN_THREAD, ad /);
  assert.match(events.detail, /reply to an earlier message/);
  assert.doesNotMatch(events.detail, /Mata meka/, 'no message text');
  assert.match(health.data.instagram.find((c) => c.key === 'meta_events').detail, /reply to a story/);
});
