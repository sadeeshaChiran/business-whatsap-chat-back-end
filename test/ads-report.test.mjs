/**
 * Ad chats: a Click-to-WhatsApp ad (Cloud API) and a Click-to-Messenger ad are stored BEFORE the bot / flows run, shown on the chat
 * (origin banner + list chip), counted once per webhook message, and reported ad by ad (people, replied, orders, lost, revenue).
 * Run the API with the fake Meta env (see flows-meta.test.mjs), then: node --test test/ads-report.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { API, api, closeDb, createWorkspace, sql } from './helpers.mjs';

const PN = `pn-ads-${Date.now()}`;
const PAGE = `page-ads-${Date.now()}`;
const AD = `${Date.now()}31`;
const R = Date.now().toString(36);
const meta = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/v[\d.]+/, '');
    if (req.method === 'POST' && /\/messages$/.test(path)) return res.end(JSON.stringify({ messages: [{ id: `wamid.out.${Date.now()}` }], message_id: `m.${Date.now()}` }));
    if (req.method === 'GET') return res.end(JSON.stringify({ id: 'x', name: 'Customer' }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: `not faked ${req.method} ${path}` } }));
  });
});

let owner;
const sign = (raw) => `sha256=${createHmac('sha256', 'new-secret').update(raw).digest('hex')}`;
const post = async (path, body) => {
  const raw = JSON.stringify(body);
  return fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) }, body: raw });
};
const waMessage = (from, id, text, referral) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '94781128220', phone_number_id: PN },
    contacts: [{ profile: { name: 'Kasuni' }, wa_id: from }],
    messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...(referral ? { referral } : {}) }],
  } }] }],
});

test.before(async () => {
  await new Promise((resolve) => meta.listen(4599, '127.0.0.1', resolve));
  owner = await createWorkspace('adsreport');
  await sql(`UPDATE companies SET plan = 'growth', bot_enabled = false WHERE id = $1`, [owner.companyId]);
  const r = await api('PATCH', `/company/${owner.companyId}`, { token: owner.token, body: { whatsapp_provider_type: 'meta', meta_phone_number_id: PN, meta_access_token: 'tok', meta_waba_id: 'waba' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await sql(`INSERT INTO meta_page_connections (company_id, page_id, page_name, page_access_token, status, created_at, updated_at) VALUES ($1, $2, 'Shop', 'tok', 'CONNECTED', NOW(), NOW())`, [owner.companyId, PAGE]);
});
test.after(async () => { meta.close(); await closeDb(); });

test('Click-to-WhatsApp: the ad is on the chat before the bot runs, shown in the inbox, counted once', async () => {
  const referral = { source_id: AD, source_type: 'ad', headline: 'Websites from Rs 20,000', body: 'Get your business online this month',
    source_url: 'https://fb.me/ci8RRmRLe', media_type: 'image', image_url: 'https://cdn.example/ad.jpg', ctwa_clid: 'CLID1' };
  const res = await post('/integrations/whatsapp/webhook/meta', waMessage('94771230001', `wamid.ad.1.${R}`, 'Hello! Can I get more info on this?', referral));
  assert.equal(res.status, 200);
  // the webhook answered → the ad is already saved (the AI reads it for its first reply)
  const [conv] = await sql(`SELECT c.id, c.campaign_source, c.ad_source_id, c.ad_media_url FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
    WHERE cu.company_id = $1 AND cu.external_user_id = '94771230001'`, [owner.companyId]);
  assert.equal(conv.campaign_source, 'ad');
  assert.equal(conv.ad_source_id, AD);
  assert.equal(conv.ad_media_url, 'https://cdn.example/ad.jpg');

  await post('/integrations/whatsapp/webhook/meta', waMessage('94771230001', `wamid.ad.1.${R}`, 'Hello! Can I get more info on this?', referral)); // Meta retry
  const clicks = await sql(`SELECT COUNT(*)::int AS n FROM marketing_ad_click WHERE conversation_id = $1`, [conv.id]);
  assert.equal(clicks[0].n, 1);

  const origin = await api('GET', `/bot/conversations/${conv.id}/origin`, { token: owner.token });
  assert.equal(origin.status, 200, JSON.stringify(origin.json));
  assert.equal(origin.data.origin.source, 'ad');
  assert.equal(origin.data.ad.headline, 'Websites from Rs 20,000');
  assert.equal(origin.data.ad.body, 'Get your business online this month');
  assert.equal(origin.data.ad.url, 'https://fb.me/ci8RRmRLe');
  const list = await api('GET', '/bot/conversations?page=1&limit=20', { token: owner.token });
  const row = list.data.find((r) => r.conversation?.id === conv.id);
  assert.deepEqual([row.origin.source, row.origin.label], ['ad', 'Websites from Rs 20,000']);

  // a second person from the same ad, a third from a shared post
  await post('/integrations/whatsapp/webhook/meta', waMessage('94771230002', `wamid.ad.2.${R}`, 'price?', referral));
  await post('/integrations/whatsapp/webhook/meta', waMessage('94771230003', `wamid.post.1.${R}`, 'details', { source_id: `post-77-${R}`, source_type: 'post', headline: 'New arrivals', source_url: 'https://fb.me/p' }));
  const [post3] = await sql(`SELECT c.ad_source_type FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id WHERE cu.external_user_id = '94771230003' AND cu.company_id = $1`, [owner.companyId]);
  assert.equal(post3.ad_source_type, 'post');
});

test('Click-to-Messenger: "opened from the ad" before the first message is linked when the chat starts', async () => {
  const send = (messaging) => post('/integrations/meta/messages/webhook', { object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging }] });
  await send([{ sender: { id: `psid-ads-${R}` }, recipient: { id: PAGE }, timestamp: Date.now(), referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: `9988${R}`, ads_context_data: { ad_title: 'Avurudu sale', photo_url: 'https://cdn.example/m.jpg' } } }]);
  await send([{ sender: { id: `psid-ads-${R}` }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: `m.ads.1.${R}`, text: 'hi' } }]);
  const [conv] = await sql(`SELECT c.id, c.ad_source_id, c.ad_headline, c.ad_media_url FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
    WHERE cu.external_user_id = $2 AND cu.company_id = $1`, [owner.companyId, `psid-ads-${R}`]);
  assert.deepEqual([conv.ad_source_id, conv.ad_headline, conv.ad_media_url], [`9988${R}`, 'Avurudu sale', 'https://cdn.example/m.jpg']);
  const [click] = await sql(`SELECT platform FROM marketing_ad_click WHERE conversation_id = $1`, [conv.id]);
  assert.equal(click.platform, 'messenger');
});

test('Ads & leads: ad by ad – people, replied, orders, lost, revenue; ad page lists each person with the outcome', async () => {
  const [p1] = await sql(`SELECT cu.id, c.id AS conv FROM bot_channel_user cu JOIN bot_conversation c ON c.bot_channel_user_id = cu.id WHERE cu.external_user_id = '94771230001' AND cu.company_id = $1`, [owner.companyId]);
  const [p2] = await sql(`SELECT cu.id, c.id AS conv FROM bot_channel_user cu JOIN bot_conversation c ON c.bot_channel_user_id = cu.id WHERE cu.external_user_id = '94771230002' AND cu.company_id = $1`, [owner.companyId]);
  await sql(`INSERT INTO bot_order (company_id, bot_channel_user_id, customer_name, status, total_amount, created_by) VALUES ($1, $2, 'Kasuni', 'Pending', 20000, 'bot')`, [owner.companyId, p1.id]);
  await sql(`INSERT INTO bot_message (conversation_id, direction, message_type, platform, content, source) VALUES ($1, 'outbound', 'text', 'whatsapp', 'Here are the details', 'bot')`, [p1.conv]);
  await sql(`UPDATE bot_conversation SET lead_stage = 'lost' WHERE id = $1`, [p2.conv]);

  const report = await api('GET', '/marketing/ad-report?days=30', { token: owner.token });
  assert.equal(report.status, 200, JSON.stringify(report.json));
  const ad = report.data.ads.find((a) => a.ad_id === AD);
  assert.equal(ad.headline, 'Websites from Rs 20,000');
  assert.deepEqual([ad.clicks, ad.people, ad.new_contacts, ad.replied, ad.won, ad.lost, ad.orders, ad.revenue], [2, 2, 2, 1, 1, 1, 1, 20000]);
  assert.equal(ad.conversion_rate, 50);
  assert.ok(report.data.ads.some((a) => a.ad_id === `post-77-${R}` && a.type === 'post'));
  assert.ok(report.data.ads.some((a) => a.ad_id === `9988${R}` && a.platforms.includes('messenger')));
  assert.equal(report.data.totals.people, 4);

  const one = await api('GET', `/marketing/ad-report/${AD}?days=30`, { token: owner.token });
  assert.equal(one.status, 200);
  assert.equal(one.data.ad.media_url, 'https://cdn.example/ad.jpg');
  const outcomes = Object.fromEntries(one.data.people.map((p) => [p.external_user_id, p.outcome]));
  assert.deepEqual(outcomes, { '94771230001': 'ordered', '94771230002': 'lost' });
  assert.equal(one.data.totals.revenue, 20000);
  assert.ok(one.data.daily.length >= 30);
  assert.equal((await api('GET', '/marketing/ad-report/nope?days=30', { token: owner.token })).status, 404);

  // Marketing overview: sources, the ads funnel and the best ads
  const overview = await api('GET', '/marketing/overview?days=30', { token: owner.token });
  assert.equal(overview.status, 200, JSON.stringify(overview.json));
  assert.deepEqual([overview.data.sources.ads.people, overview.data.sources.ads.orders, overview.data.sources.ads.revenue, overview.data.sources.ads.lost], [4, 1, 20000, 1]);
  assert.equal(overview.data.top_ads[0].ad_id, AD);
  assert.equal(overview.data.ad_leads.won, 1);
  assert.equal(overview.data.setup.whatsapp_cloud, true);
});

test('broadcasts: Meta\'s hello_world sample is refused with a clear message; failures are explained', async () => {
  const [b] = await sql(`INSERT INTO marketing_broadcast (company_id, name, template_name, template_language, body_params, audience, status, total)
    VALUES ($1, 'Test', 'hello_world', 'en_US', '[]'::jsonb, '{}'::jsonb, 'done', 2) RETURNING id`, [owner.companyId]);
  const [cu] = await sql(`SELECT id FROM bot_channel_user WHERE company_id = $1 LIMIT 1`, [owner.companyId]);
  await sql(`INSERT INTO marketing_broadcast_recipient (broadcast_id, bot_channel_user_id, phone, name, status, error) VALUES ($1, $2, '94771230001', 'Kasuni', 'failed', '(#131058) Hello World templates can only be sent from the Public Test Numbers'),
    ($1, $2, '94771230002', 'Amal', 'failed', 'Meta: (#131058) Hello World templates can only be sent from the Public Test Numbers')`, [b.id, cu.id]);
  const one = await api('GET', `/marketing/broadcasts/${b.id}`, { token: owner.token });
  assert.equal(one.status, 200, JSON.stringify(one.json));
  assert.match(one.data.main_problem.text, /sample template/);
  assert.equal(one.data.main_problem.count, 2);
  assert.match(one.data.failures[0].fix, /Message templates/);
});
