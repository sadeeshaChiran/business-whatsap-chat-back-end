/**
 * Campaigns, short links / QR and campaign attribution – run against a running API + TEST database:
 *   node --test test/marketing-campaigns.test.mjs
 * Optional (AI context check): run the API with the contract bot (backend/test/salesbot-contract.mjs header)
 * and set BOT_CAPTURE_DIR to its CAPTURE_DIR.
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { API, RUN, api, closeDb, createAgent, createWorkspace, sql } from './helpers.mjs';

const ROOT = API.replace(/\/v1\/api$/, '');
const PHONE_ID = `pn-mk-${RUN}`;
let A; let B; let agent; let product; let campaign; let link; let adCampaign;

async function metaWebhook(message) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba-test', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '94110000000', phone_number_id: PHONE_ID },
      contacts: [{ profile: { name: message.name ?? 'Nimal' }, wa_id: message.from }],
      messages: [{ from: message.from, id: `wamid.${RUN}.${randomBytes(6).toString('hex')}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: message.text }, ...(message.referral ? { referral: message.referral } : {}) }],
    } }] }],
  });
  const secret = process.env.META_APP_SECRET || '';
  const headers = secret ? { 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } : {};
  return api('POST', '/integrations/whatsapp/webhook/meta', { body, headers });
}

async function conversationOf(phone, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const [row] = await sql(`SELECT c.* FROM bot_conversation c JOIN bot_channel_user u ON u.id = c.bot_channel_user_id
      WHERE u.company_id = $1 AND u.external_user_id = $2 ORDER BY c.id DESC LIMIT 1`, [A.companyId, phone]);
    if (row?.campaign_id || row?.campaign_source) return row;
    await new Promise((r) => setTimeout(r, 500));
  }
  const [row] = await sql(`SELECT c.* FROM bot_conversation c JOIN bot_channel_user u ON u.id = c.bot_channel_user_id WHERE u.company_id = $1 AND u.external_user_id = $2 ORDER BY c.id DESC LIMIT 1`, [A.companyId, phone]);
  return row;
}

before(async () => {
  A = await createWorkspace('mk-a');
  B = await createWorkspace('mk-b');
  agent = await createAgent(A, 'mk-agent');
  const category = await api('POST', '/product-catergory', { token: A.token, body: { name: `Saree ${RUN}` } });
  product = (await api('POST', '/products', { token: A.token, body: { name: 'Red saree', price: 8500, quantity: 5, category_id: category.data.id, weight: 0.5 } })).data;
  assert.ok(product?.id, 'product created');
  const wa = await api('PATCH', `/company/${A.companyId}`, { token: A.token, body: { whatsapp_provider_type: 'meta', meta_phone_number_id: PHONE_ID, meta_access_token: 'test-token', meta_waba_id: 'waba-mk' } });
  assert.equal(wa.status, 200, JSON.stringify(wa.json));
});

after(closeDb);

describe('Campaigns and short links', () => {
  test('admin creates a campaign; agents and other companies cannot', async () => {
    const created = await api('POST', '/marketing/chat-campaigns', { token: A.token, body: {
      name: 'Avurudu sale', offer_text: '20% off sarees', bot_instructions: 'Show the red saree first.', product_ids: [product.id, 999999],
      ends_at: '2099-12-31', tag: 'Avurudu 2027!',
    } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    campaign = created.data;
    assert.deepEqual(campaign.product_ids, [product.id], 'unknown / other company products are dropped');
    assert.equal(campaign.tag, 'avurudu 2027');
    assert.equal((await api('GET', '/marketing/chat-campaigns', { token: agent.token })).status, 403);
    assert.equal((await api('PATCH', `/marketing/chat-campaigns/${campaign.id}`, { token: B.token, body: { name: 'hack' } })).status, 404);
    const bad = await api('POST', '/marketing/chat-campaigns', { token: A.token, body: { name: 'x2', starts_at: '2026-10-10', ends_at: '2026-10-01' } });
    assert.equal(bad.status, 400);
  });

  test('short link: redirect to WhatsApp with the tracking code, counts clicks, other companies cannot see it', async () => {
    const created = await api('POST', '/marketing/links', { token: A.token, body: {
      name: 'Shop window QR', channel: 'whatsapp', target: '+94 77 123 4567', prefill_text: 'Hi! I saw the Avurudu offer.', campaign_id: campaign.id,
    } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    link = created.data;
    assert.match(link.slug, /^[a-z0-9]{6}$/);
    assert.equal(link.short_url, `${ROOT}/l/${link.slug}`);
    const response = await fetch(`${ROOT}/l/${link.slug}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const location = response.headers.get('location');
    assert.ok(location.startsWith('https://wa.me/94771234567?text='), location);
    assert.ok(decodeURIComponent(location).endsWith(`Hi! I saw the Avurudu offer. #${link.slug}`), location);
    const [row] = await sql(`SELECT clicks FROM marketing_link WHERE id = $1`, [link.id]);
    assert.equal(Number(row.clicks), 1);
    assert.equal((await api('GET', '/marketing/links', { token: B.token })).data.length, 0);
    assert.equal((await api('PATCH', `/marketing/links/${link.id}`, { token: B.token, body: { name: 'hacked' } })).status, 404);
    // own short name must be unique; bad numbers refused
    const custom = await api('POST', '/marketing/links', { token: A.token, body: { name: 'Poster', channel: 'messenger', target: 'myshop.lk', slug: `ps${RUN.slice(-6)}` } });
    assert.equal(custom.status, 201, JSON.stringify(custom.json));
    assert.ok(custom.data.target_url.startsWith('https://m.me/myshop.lk?ref='));
    assert.equal((await api('POST', '/marketing/links', { token: B.token, body: { name: 'Copy', channel: 'messenger', target: 'x.lk', slug: custom.data.slug } })).status, 409);
    assert.equal((await api('POST', '/marketing/links', { token: A.token, body: { name: 'Bad', channel: 'whatsapp', target: '123' } })).status, 400);
  });

  test('a switched-off link shows "not active"', async () => {
    const off = await api('POST', '/marketing/links', { token: A.token, body: { name: 'Old flyer', channel: 'whatsapp', target: '94771234567' } });
    assert.equal((await api('DELETE', `/marketing/links/${off.data.id}`, { token: A.token })).status, 200);
    const response = await fetch(`${ROOT}/l/${off.data.slug}`, { redirect: 'manual' });
    assert.equal(response.status, 404);
    assert.equal((await fetch(`${ROOT}/l/nope-${RUN}`, { redirect: 'manual' })).status, 404);
  });

  test('a customer who sends the link message is linked to the campaign and tagged', async () => {
    const phone = `9477${String(Date.now()).slice(-7)}`;
    const inbound = await metaWebhook({ from: phone, text: `Hi! I saw the Avurudu offer. #${link.slug}` });
    assert.equal(inbound.status, 200, JSON.stringify(inbound.json));
    const conv = await conversationOf(phone);
    assert.equal(Number(conv.campaign_id), campaign.id);
    assert.equal(conv.campaign_source, 'link');
    assert.equal(Number(conv.link_id), link.id);
    const [contact] = await sql(`SELECT c.source, c.tags FROM crm_contact c JOIN bot_channel_user u ON u.id = c.bot_channel_user_id WHERE u.external_user_id = $1 AND u.company_id = $2`, [phone, A.companyId]);
    assert.equal(contact.source, 'link');
    assert.ok(contact.tags.includes('avurudu 2027'), JSON.stringify(contact));
    const list = await api('GET', '/marketing/chat-campaigns', { token: A.token });
    assert.equal(list.data.find((c) => c.id === campaign.id).chats, 1);
    const chats = await api('GET', `/marketing/chat-campaigns/${campaign.id}/chats`, { token: A.token });
    assert.equal(chats.data[0].link_name, 'Shop window QR');
  });

  test('the ready text without the code still matches the link', async () => {
    const phone = `9476${String(Date.now()).slice(-7)}`;
    await metaWebhook({ from: phone, text: 'hi! i saw the avurudu offer' });
    // the background scan (15 s) links it; the AI context does it at once – wait for the scan
    let conv;
    for (let i = 0; i < 40; i++) { conv = await conversationOf(phone, 1); if (conv?.link_id) break; await new Promise((r) => setTimeout(r, 1000)); }
    assert.equal(Number(conv.link_id), link.id);
  });

  test('a Click-to-WhatsApp ad is linked to the campaign that lists the ad id', async () => {
    const adId = `1202${Date.now()}`;
    adCampaign = (await api('POST', '/marketing/chat-campaigns', { token: A.token, body: { name: 'Ad campaign', meta_ad_ids: [adId, 'not-an-id'] } })).data;
    assert.deepEqual(adCampaign.meta_ad_ids, [adId]);
    const phone = `9475${String(Date.now()).slice(-7)}`;
    const inbound = await metaWebhook({ from: phone, text: 'price?', referral: { source_url: 'https://fb.me/x', source_id: adId, source_type: 'ad', headline: 'Red saree 20% off', body: 'Only this week' } });
    assert.equal(inbound.status, 200, JSON.stringify(inbound.json));
    const conv = await conversationOf(phone);
    assert.equal(Number(conv.campaign_id), adCampaign.id);
    assert.equal(conv.campaign_source, 'ad');
    assert.equal(conv.ad_headline, 'Red saree 20% off');
    assert.equal(conv.ad_body, 'Only this week');
  });

  test('the AI gets the campaign (needs the contract bot)', { skip: !process.env.BOT_CAPTURE_DIR }, async () => {
    await api('PATCH', '/bot/sales-bot/settings', { token: A.token, body: { bot_enabled: true, auto_enable_new_customers: true } });
    const fd = new FormData(); fd.append('phone', `9474${String(Date.now()).slice(-7)}`); fd.append('name', 'Kamal'); fd.append('text', `price? #${link.slug}`);
    const sim = await api('POST', '/bot/sales-bot/simulate', { token: A.token, form: fd });
    assert.equal(sim.status, 201, JSON.stringify(sim.json));
    await new Promise((r) => setTimeout(r, 7000)); // engine debounce (4 s) + reply
    const dir = process.env.BOT_CAPTURE_DIR;
    const files = readdirSync(dir).filter((f) => f.startsWith('request_')).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    const request = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    assert.equal(request.context.campaign.name, 'Avurudu sale');
    assert.equal(request.context.campaign.source, 'link');
    assert.equal(request.context.campaign.offer, '20% off sarees');
    assert.deepEqual(request.context.campaign.product_ids, [product.id]);
  });

  test('deleting a campaign keeps its links', async () => {
    assert.equal((await api('DELETE', `/marketing/chat-campaigns/${campaign.id}`, { token: A.token })).status, 200);
    const [row] = await sql(`SELECT campaign_id, is_active FROM marketing_link WHERE id = $1`, [link.id]);
    assert.equal(row.campaign_id, null);
    assert.equal(row.is_active, true);
  });
});
