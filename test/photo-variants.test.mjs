import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { api, createWorkspace, sql, closeDb } from './helpers.mjs';

/**
 * A product with a photo per colour: every photo the bot sends names ITS colour, a reply to the blue photo means
 * blue (not the first colour), and "show the blue one" sends the blue photo first.
 * Needs the fake bot (salesbot tests/contract_server.py) and the API in SALES_BOT_TEST_MODE.
 */
test.after(closeDb);

const FIX = new URL('./fixtures/photos/', import.meta.url);
const CAPTURED = process.env.BOT_CAPTURE_DIR || '/home/claude/src/salesbot/tests/captured';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let owner; let tee; const urls = {};

async function upload(name) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(new URL(name, FIX))], { type: 'image/jpeg' }), name);
  const r = await api('POST', '/products/images', { token: owner.token, form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.data.url;
}

async function customer(phone, { text, replyTo }, state) {
  const [{ last } = { last: 0 }] = state.conversationId
    ? await sql(`SELECT COALESCE(MAX(id), 0)::int AS last FROM bot_message WHERE conversation_id = $1`, [state.conversationId]) : [];
  const form = new FormData();
  form.append('phone', phone);
  form.append('name', 'Dilini');
  form.append('text', text);
  if (replyTo) form.append('reply_to_message_id', String(replyTo));
  const r = await api('POST', '/bot/sales-bot/simulate', { token: owner.token, form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  state.conversationId = r.data.conversation_id;
  for (let i = 0; i < 60; i++) {
    const rows = await sql(`SELECT id FROM bot_message WHERE conversation_id = $1 AND id > $2 AND direction = 'outbound' AND message_type = 'text' AND source = 'sales_bot'`, [state.conversationId, last]);
    if (rows.length) break;
    await wait(500);
  }
  return sql(`SELECT id, direction, message_type, content, media_url, media_note, reply_to_text FROM bot_message WHERE conversation_id = $1 AND id > $2 ORDER BY id`, [state.conversationId, last]);
}

function lastRequest() {
  const files = readdirSync(CAPTURED).filter((f) => /^request_\d+\.json$/.test(f))
    .map((f) => ({ f, t: statSync(`${CAPTURED}/${f}`).mtimeMs })).sort((a, b) => b.t - a.t);
  return JSON.parse(readFileSync(`${CAPTURED}/${files[0].f}`, 'utf8'));
}

test('setup: one T-shirt, a photo per colour (sizes share the colour photo), Black costs more', async () => {
  owner = await createWorkspace('photovariants');
  await sql(`UPDATE companies SET bot_enabled = true, plan = 'growth' WHERE id = $1`, [owner.companyId]);
  urls.red = await upload('watch_red.jpg');
  urls.blue = await upload('watch_blue.jpg');
  urls.black = await upload('watch_black.jpg');
  const cat = await api('POST', '/product-catergory', { token: owner.token, body: { name: `Tees ${Date.now()}` } });
  const r = await api('POST', '/products', { token: owner.token, body: { name: 'Basic Tee', price: 1490, quantity: 10, category_id: cat.data.id, image_url: urls.red } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  tee = r.data;
  const option = (colour, size, price, url) => ({ variant_name: 'Colour / Size', variant_value: `${colour} / ${size}`, price, quantity: 5, image_url: url });
  const variants = [
    option('Red', 'S', 1490, urls.red), option('Red', 'M', 1490, urls.red),
    option('Blue', 'S', 1490, urls.blue), option('Blue', 'M', 1490, urls.blue),
    option('Black', 'S', 1690, urls.black),
  ];
  await sql(`UPDATE product SET has_variants = true WHERE id = $1`, [tee.id]);
  await sql(`DELETE FROM product_variant WHERE product_id = $1`, [tee.id]);
  await sql(`INSERT INTO product_variant (product_id, variants) VALUES ($1, $2::jsonb)`, [tee.id, JSON.stringify(variants)]);
});

const chat = { conversationId: null };
const phone = `99944${String(Date.now()).slice(-7)}`;
let sentPhotos = [];

test('asked for all colours → every photo names its own colour (and that colour\'s price) – not just the first one', async () => {
  // a plain question sends ONE photo; all colours only when the customer asks for them
  const rows = await customer(phone, { text: 'tshirt eke okkoma paata balanna' }, chat);
  sentPhotos = rows.filter((r) => r.direction === 'outbound' && r.message_type === 'image');
  assert.equal(sentPhotos.length, 3, JSON.stringify(sentPhotos.map((p) => p.content)));
  assert.deepEqual(sentPhotos.map((p) => p.content), [
    '📷 Basic Tee – Colour: Red – Rs 1,490',
    '📷 Basic Tee – Colour: Blue – Rs 1,490',
    '📷 Basic Tee – Black / S – Rs 1,690', // black comes only in S, so its photo names the one real option
  ]);
  assert.match(sentPhotos[1].media_note, /Basic Tee \(Colour: Blue\) #\d+/);
  // a colour photo shared by S and M never claims a size
  assert.ok(sentPhotos.slice(0, 2).every((p) => !/\/ (S|M)\b/.test(p.content)));
});

test('the customer replies to the BLUE photo → the AI is told it is the blue one', async () => {
  const blue = sentPhotos.find((p) => /Blue/.test(p.content));
  const rows = await customer(phone, { text: 'meka ganna', replyTo: blue.id }, chat);
  assert.match(rows.find((r) => r.direction === 'inbound').reply_to_text, /Colour: Blue/);
  const message = lastRequest().message;
  assert.match(message, /\[replying to: "\[photo: bot sent a photo of our product Basic Tee \(Colour: Blue\)/);
  assert.doesNotMatch(message, /Colour: Red/);
});

test('chat history lists the colour of each photo', async () => {
  await customer(phone, { text: 'size mokadda thiyenne?' }, chat);
  const history = lastRequest().history.map((turn) => turn.text).join('\n');
  assert.match(history, /Basic Tee – Colour: Blue – Rs 1,490/);
  assert.match(history, /Basic Tee – Black \/ S – Rs 1,690/);
});

test('"show the blue one" (photo_variants) → only the blue photo', async () => {
  const other = { conversationId: null };
  const rows = await customer(`99933${String(Date.now()).slice(-7)}`, { text: 'show option 3' }, other); // variant 3 = Blue / S
  const photos = rows.filter((r) => r.direction === 'outbound' && r.message_type === 'image');
  assert.equal(photos.length, 1, JSON.stringify(photos.map((p) => p.content)));
  assert.equal(photos[0].media_url, urls.blue.startsWith('http') ? urls.blue : photos[0].media_url);
  assert.equal(photos[0].content, '📷 Basic Tee – Colour: Blue – Rs 1,490');
});
