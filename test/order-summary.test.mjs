import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createWorkspace, sql, closeDb } from './helpers.mjs';

/**
 * The summary turn shows the server's EXACT summary (real price, delivery fee from the zone, total) after the AI's
 * short line – the AI no longer types prices/totals (fewer output tokens, never a wrong total).
 * Needs the fake bot (salesbot tests/contract_server.py): it sends the first product x2 to "12 Main St, Colombo"
 * with summary_shown=true.
 */
test.after(closeDb);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('summary turn: short AI line + exact server summary', async () => {
  const owner = await createWorkspace('ordersummary');
  await sql(`UPDATE companies SET bot_enabled = true, plan = 'growth' WHERE id = $1`, [owner.companyId]);
  const [{ id: cat }] = await sql(`INSERT INTO product_catergory (name, company_id, is_active) VALUES ('Shoes', $1, TRUE) RETURNING id`, [owner.companyId]);
  await sql(`INSERT INTO product (name, description, sku, price, quantity, status, company_id, category_id, created_by, has_variants, is_available, show_to_bot)
    VALUES ('Red Shoe', 'Shoe', $2, 2500, 10, 'In Stock', $1, $3, $4, FALSE, TRUE, TRUE)`, [owner.companyId, `SH-${Date.now()}`, cat, owner.user.id]);
  await sql(`INSERT INTO bot_delivery_zone (company_id, area, fee, days) VALUES ($1, 'Colombo', 350, '1-2 days')`, [owner.companyId]);

  const [{ last }] = await sql(`SELECT COALESCE(MAX(id), 0)::int AS last FROM bot_message`);
  const r = await api('POST', '/bot/sales-bot/simulate', { token: owner.token, body: { phone: `99946${String(Date.now()).slice(-7)}`, name: 'Nimal', text: 'red shoe 2k danna' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  let rows = [];
  for (let i = 0; i < 60 && !rows.length; i++) {
    rows = await sql(`SELECT content FROM bot_message WHERE conversation_id = $1 AND id > $2 AND message_type = 'text' AND source = 'sales_bot'`, [r.data.conversation_id, last]);
    if (!rows.length) await wait(400);
  }
  const text = rows.map((row) => row.content).join('\n');
  assert.match(text, /^Hari, red shoe 2k danna gana balamu\./, 'the AI line comes first');
  assert.match(text, /2 x Red Shoe – Rs 5,000/);
  assert.match(text, /Delivery \(Colombo\): Rs 350/);
  assert.match(text, /Total: Rs 5,350/);
  assert.match(text, /Order eka confirm karannada\?$/);
});
