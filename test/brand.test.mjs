import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { api, createWorkspace, sql, closeDb } from './helpers.mjs';

/** Product brand: saved, changed, listed, imported, and given to the AI bot (needs the fake bot for the last part). */
test.after(closeDb);
const CAPTURED = process.env.BOT_CAPTURE_DIR || '/home/claude/src/salesbot/tests/captured';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let owner; let cat; let watch;

test('brand is saved, trimmed, changed and cleared', async () => {
  owner = await createWorkspace('brand');
  await sql(`UPDATE companies SET bot_enabled = true, plan = 'growth' WHERE id = $1`, [owner.companyId]);
  cat = await api('POST', '/product-catergory', { token: owner.token, body: { name: `Watches ${Date.now()}` } });
  const created = await api('POST', '/products', { token: owner.token, body: { name: 'Classic Watch', brand: '  Casio  ', price: 8500, quantity: 1, category_id: cat.data.id } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.data.brand, 'Casio');
  watch = created.data;
  const plain = await api('POST', '/products', { token: owner.token, body: { name: 'Sport Watch', price: 4500, quantity: 1, category_id: cat.data.id } });
  assert.equal(plain.data.brand ?? null, null);
  const changed = await api('PATCH', `/products/${watch.id}`, { token: owner.token, body: { brand: 'CASIO' } });
  assert.equal(changed.data.brand, 'CASIO');
  const cleared = await api('PATCH', `/products/${plain.data.id}`, { token: owner.token, body: { brand: '' } });
  assert.equal(cleared.data.brand ?? null, null);
  const tooLong = await api('POST', '/products', { token: owner.token, body: { name: 'X', brand: 'b'.repeat(121), price: 1, quantity: 1, category_id: cat.data.id } });
  assert.equal(tooLong.status, 400);
});

test('brands list for suggestions (one per brand, any case)', async () => {
  await api('POST', '/products', { token: owner.token, body: { name: 'Gold Watch', brand: 'casio', price: 9900, quantity: 1, category_id: cat.data.id } });
  await api('POST', '/products', { token: owner.token, body: { name: 'Runner', brand: 'Nike', price: 15500, quantity: 1, category_id: cat.data.id } });
  const r = await api('GET', '/products/brands', { token: owner.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.map((b) => [b.brand.toLowerCase(), b.products]), [['casio', 2], ['nike', 1]]);
});

test('import reads the brand column; the sample file has it', async () => {
  const csv = 'name,brand,category,price\nBaby Shoes,Bata,Shoes,1800\n';
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'products.csv');
  const r = await api('POST', '/products/import', { token: owner.token, form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const [row] = await sql(`SELECT brand FROM product WHERE company_id = $1 AND name = 'Baby Shoes'`, [owner.companyId]);
  assert.equal(row.brand, 'Bata');
});

test('the AI bot gets the brand of every product', async () => {
  const ask = `casio watch thiyenawada ${Date.now().toString(36)}?`;
  const sent = await api('POST', '/bot/sales-bot/simulate', { token: owner.token, body: { phone: `99933${String(Date.now()).slice(-7)}`, name: 'Ruwan', text: ask } });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  let request = null;
  for (let i = 0; i < 40 && !request; i++) {
    await wait(500);
    const files = readdirSync(CAPTURED).filter((f) => /^request_\d+\.json$/.test(f)).map((f) => ({ f, t: statSync(`${CAPTURED}/${f}`).mtimeMs })).sort((a, b) => b.t - a.t);
    const latest = files[0] && JSON.parse(readFileSync(`${CAPTURED}/${files[0].f}`, 'utf8'));
    if (latest?.message?.includes(ask)) request = latest;
  }
  assert.ok(request, 'the bot was asked');
  const product = request.context.products.find((p) => p.id === watch.id);
  assert.equal(product.brand, 'CASIO');
});
