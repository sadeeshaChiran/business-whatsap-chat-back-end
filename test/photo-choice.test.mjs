import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createWorkspace, sql, closeDb } from './helpers.mjs';

/**
 * Which product photos the bot sends (needs the fake bot: salesbot tests/contract_server.py, which always talks
 * about the first product): one photo normally, ONLY the named colour's photo ("black ... eka"), every photo when asked.
 */
test.after(closeDb);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const img = (name) => `https://shop.example/vora/${name}.jpg`;
let owner;

async function customer(phone, text) {
  const [{ last }] = await sql(`SELECT COALESCE(MAX(id), 0)::int AS last FROM bot_message`);
  const r = await api('POST', '/bot/sales-bot/simulate', { token: owner.token, body: { phone, name: 'Dilini', text } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const conversationId = r.data.conversation_id;
  for (let i = 0; i < 60; i++) {
    const done = await sql(`SELECT id FROM bot_message WHERE conversation_id = $1 AND id > $2 AND message_type = 'text' AND source = 'sales_bot'`, [conversationId, last]);
    if (done.length) break;
    await wait(400);
  }
  return sql(`SELECT media_url, content FROM bot_message WHERE conversation_id = $1 AND id > $2 AND message_type = 'image' ORDER BY id`, [conversationId, last]);
}

test('setup: clothing shop with a tee in 4 colours (one photo per colour)', async () => {
  owner = await createWorkspace('photochoice');
  await sql(`UPDATE companies SET bot_enabled = true, plan = 'growth' WHERE id = $1`, [owner.companyId]);
  const variants = ['White', 'Black', 'Navy', 'Sky Blue'].flatMap((colour) => ['S', 'M', 'L'].map((size) => ({
    variant_name: 'Colour / Size', variant_value: `${colour} / ${size}`, price: 1490, quantity: 5,
    image_url: img(`tee-${colour.toLowerCase().replace(' ', '-')}`),
  })));
  const [{ id: cat }] = await sql(`INSERT INTO product_catergory (name, company_id, is_active) VALUES ('T-Shirts', $1, TRUE) RETURNING id`, [owner.companyId]);
  const [{ id }] = await sql(`INSERT INTO product (name, description, sku, price, quantity, status, company_id, category_id, created_by, has_variants, is_available, show_to_bot, image_url, gallery)
    VALUES ('Basic Cotton Tee', 'Everyday tee', $2, 1490, 60, 'In Stock', $1, ${cat}, ${owner.user.id}, TRUE, TRUE, TRUE, $3, $4::jsonb) RETURNING id`,
  [owner.companyId, `TEE-${Date.now()}`, img('tee-white'), JSON.stringify([img('tee-back')])]);
  await sql(`INSERT INTO product_variant (product_id, variants) VALUES ($1, $2::jsonb)`, [id, JSON.stringify(variants)]);
});

test('asking about the shirt → ONE photo (the main one), labelled', async () => {
  const photos = await customer(`99941${String(Date.now()).slice(-7)}`, 'Basic Cotton Tee thiyenawada?');
  assert.deepEqual(photos.map((p) => p.media_url), [img('tee-white')]);
  assert.match(photos[0].content, /Basic Cotton Tee/);
});

test('naming a colour ("kalu" = black) → only the black photo, labelled Black – not the first colour', async () => {
  const phone = `99942${String(Date.now()).slice(-7)}`;
  const photos = await customer(phone, 'kalu Basic Cotton Tee eka balanna puluwanda?');
  assert.deepEqual(photos.map((p) => p.media_url), [img('tee-black')]);
  assert.match(photos[0].content, /Black/);
  // then "all colours" → the other photos, each with its colour; nothing sent twice
  const rest = await customer(phone, 'okkoma paata balanna');
  const urls = rest.map((p) => p.media_url);
  assert.deepEqual(urls.sort(), [img('tee-back'), img('tee-navy'), img('tee-sky-blue'), img('tee-white')].sort());
  assert.ok(rest.find((p) => p.media_url === img('tee-navy')).content.includes('Navy'));
});

test("the AI's chosen option (variant 8 = Navy / L) → the navy photo only; its 'all photos' flag → every photo", async () => {
  const navy = await customer(`99943${String(Date.now()).slice(-7)}`, 'show option 8');
  assert.deepEqual(navy.map((p) => p.media_url), [img('tee-navy')]);
  const all = await customer(`99944${String(Date.now()).slice(-7)}`, 'flag all photos');
  assert.equal(all.length, 5);
  assert.deepEqual(all.map((p) => p.content.match(/(Sky Blue|White|Black|Navy)/)?.[1] ?? 'main'),
    ['White', 'main', 'Black', 'Navy', 'Sky Blue']);
});
