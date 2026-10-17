import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { api, createWorkspace, sql, closeDb } from './helpers.mjs';

/**
 * Customer photos → the right product, product photos sent with their name, replies to a photo understood.
 * Needs the fake bot (salesbot tests/contract_server.py): real photo fingerprints, a stand-in for the AI look.
 * Photos: test/fixtures/photos (made with Pillow: red / blue watch of the SAME design, a black watch, a pink romper).
 */
test.after(closeDb);

const FIX = new URL('./fixtures/photos/', import.meta.url);
const CAPTURED = process.env.BOT_CAPTURE_DIR || '/home/claude/src/salesbot/tests/captured';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const photo = (name) => new Blob([readFileSync(new URL(name, FIX))], { type: 'image/jpeg' });
let owner; let products = {}; let conversationId;
const phone = `99955${String(Date.now()).slice(-7)}`;

async function upload(name) {
  const form = new FormData();
  form.append('file', photo(name), name);
  const r = await api('POST', '/products/images', { token: owner.token, form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.data.url;
}

/** Customer message from the simulator (text, photo, or a reply to an earlier message); waits for the bot. */
async function customer({ text, file, replyTo }) {
  const [{ last } = { last: 0 }] = conversationId
    ? await sql(`SELECT COALESCE(MAX(id), 0)::int AS last FROM bot_message WHERE conversation_id = $1`, [conversationId]) : [];
  const form = new FormData();
  form.append('phone', phone);
  form.append('name', 'Sanduni');
  if (text) form.append('text', text);
  if (file) form.append('file', photo(file), file);
  if (replyTo) form.append('reply_to_message_id', String(replyTo));
  const r = await api('POST', '/bot/sales-bot/simulate', { token: owner.token, form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  conversationId = r.data.conversation_id;
  for (let i = 0; i < 60; i++) {
    const rows = await sql(`SELECT id FROM bot_message WHERE conversation_id = $1 AND id > $2 AND direction = 'outbound' AND message_type = 'text' AND source = 'sales_bot'`, [conversationId, last]);
    if (rows.length) break;
    await wait(500);
  }
  return sql(`SELECT id, direction, message_type, content, media_url, media_note, media_match, reply_to_text FROM bot_message WHERE conversation_id = $1 AND id > $2 ORDER BY id`, [conversationId, last]);
}

function lastRequest() {
  const files = readdirSync(CAPTURED).filter((f) => /^request_\d+\.json$/.test(f))
    .map((f) => ({ f, t: statSync(`${CAPTURED}/${f}`).mtimeMs })).sort((a, b) => b.t - a.t);
  return JSON.parse(readFileSync(`${CAPTURED}/${files[0].f}`, 'utf8'));
}

test('setup: watch shop – red and blue watch (same design), black watch, pink romper; photos fingerprinted', async () => {
  owner = await createWorkspace('photomatch');
  await sql(`UPDATE companies SET bot_enabled = true, plan = 'growth' WHERE id = $1`, [owner.companyId]);
  const cat = await api('POST', '/product-catergory', { token: owner.token, body: { name: `Watches ${Date.now()}` } });
  for (const [key, name, file, price] of [
    ['red', 'Red Classic Watch', 'watch_red.jpg', 4500], ['blue', 'Blue Classic Watch', 'watch_blue.jpg', 4500],
    ['black', 'Black Sport Watch', 'watch_black.jpg', 6900], ['romper', 'Pink Star Romper', 'romper_pink.jpg', 2500],
  ]) {
    const url = await upload(file);
    const r = await api('POST', '/products', { token: owner.token, body: { name, price, quantity: 1, category_id: cat.data.id, image_url: url, gallery: [url] } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    products[key] = r.data;
  }
  for (let i = 0; i < 40; i++) {
    const [row] = await sql(`SELECT COUNT(*)::int AS n FROM product WHERE company_id = $1 AND jsonb_array_length(COALESCE(image_hashes, '[]'::jsonb)) > 0`, [owner.companyId]);
    if (row.n === 4) break;
    await wait(500);
  }
  const [row] = await sql(`SELECT COUNT(*)::int AS n FROM product WHERE company_id = $1 AND jsonb_array_length(COALESCE(image_hashes, '[]'::jsonb)) > 0`, [owner.companyId]);
  assert.equal(row.n, 4, 'every product photo has a fingerprint');
});

test('screenshot of OUR blue watch post → the blue watch for sure (not the red one), its photo sent with name and price', async () => {
  const rows = await customer({ file: 'customer_blue_screenshot.jpg' });
  const inbound = rows.find((r) => r.direction === 'inbound');
  assert.equal(inbound.media_match.status, 'exact', JSON.stringify(inbound.media_match));
  assert.equal(inbound.media_match.products.length, 1);
  assert.equal(inbound.media_match.products[0].product_id, products.blue.id);
  assert.match(inbound.media_note, /Blue Classic Watch/);
  const photos = rows.filter((r) => r.direction === 'outbound' && r.message_type === 'image');
  assert.ok(photos.length >= 1, 'a product photo is sent');
  assert.equal(photos[0].content, '📷 Blue Classic Watch – Rs 4,500', 'the first photo is the matched product, labelled');
  assert.match(photos[0].media_note, /Blue Classic Watch/);
  const request = lastRequest();
  assert.equal(request.context.photo_matches[0].status, 'exact');
  assert.equal(request.context.photo_matches[0].products[0].name, 'Blue Classic Watch');
});

test('a forwarded, smaller, blurry copy of the red watch photo → the red watch', async () => {
  const rows = await customer({ file: 'customer_red_forwarded.jpg' });
  const inbound = rows.find((r) => r.direction === 'inbound');
  assert.equal(inbound.media_match.status, 'exact');
  assert.equal(inbound.media_match.products[0].product_id, products.red.id);
});

test('a cut-out of the romper photo → the romper', async () => {
  const rows = await customer({ file: 'customer_romper_crop.jpg' });
  const inbound = rows.find((r) => r.direction === 'inbound');
  assert.equal(inbound.media_match.products[0].product_id, products.romper.id);
  assert.ok(['exact', 'likely'].includes(inbound.media_match.status));
});

test('a watch we do not sell → "not in our shop" (never claims it is ours)', async () => {
  const rows = await customer({ file: 'customer_green_other.jpg' });
  const inbound = rows.find((r) => r.direction === 'inbound');
  assert.equal(inbound.media_match.status, 'none', JSON.stringify(inbound.media_match));
  assert.match(inbound.media_note, /not in our shop/);
  assert.ok(lastRequest().context.photo_matches[0].status === 'none');
});

test('the customer replies to the bot\'s photo ("mekata kiyada?") → the bot knows which product that photo was', async () => {
  const [sent] = await sql(`SELECT id FROM bot_message WHERE conversation_id = $1 AND direction = 'outbound' AND message_type = 'image' AND content LIKE '%Blue Classic Watch%' ORDER BY id LIMIT 1`, [conversationId]);
  assert.ok(sent, 'the bot sent the blue watch photo earlier');
  const rows = await customer({ text: 'mekata kiyada?', replyTo: sent.id });
  const inbound = rows.find((r) => r.direction === 'inbound');
  assert.match(inbound.reply_to_text, /Blue Classic Watch/);
  assert.match(lastRequest().message, /\[replying to: "\[photo: bot sent a photo of our product Blue Classic Watch/);
});

test('the customer replies to their OWN earlier photo → the earlier match is used again (no new AI cost)', async () => {
  const [mine] = await sql(`SELECT id FROM bot_message WHERE conversation_id = $1 AND direction = 'inbound' AND message_type = 'image' ORDER BY id LIMIT 1`, [conversationId]);
  const [{ n: before }] = await sql(`SELECT COUNT(*)::int AS n FROM bot_ai_usage WHERE conversation_id = $1`, [conversationId]);
  const rows = await customer({ text: 'me eke thiyenawada?', replyTo: mine.id });
  const request = lastRequest();
  assert.equal(request.context.photo_matches?.[0]?.products?.[0]?.name, 'Blue Classic Watch');
  assert.match(rows.find((r) => r.direction === 'inbound').reply_to_text, /customer photo = our product Blue Classic Watch/);
  const [{ n: after }] = await sql(`SELECT COUNT(*)::int AS n FROM bot_ai_usage WHERE conversation_id = $1`, [conversationId]);
  assert.equal(after - before, 1, 'only the reply itself used AI (the photo match was reused)');
});

test('chat history tells the AI what every photo was', async () => {
  await customer({ text: 'thawa mokada thiyenne?' });
  const history = lastRequest().history.map((turn) => turn.text).join('\n');
  assert.match(history, /\[photo: customer photo = our product (Red|Blue) Classic Watch #\d+ \(our own photo\)\]/);
  assert.match(history, /\[photo\] 📷 (Red|Blue) Classic Watch – Rs 4,500/);
  assert.match(history, /\[photo: customer photo \(.*\) – not in our shop/);
});
