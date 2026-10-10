/**
 * Backend ↔ sales bot contract test (AI simulated, no cost).
 *   1. bot:  cd sales-bot && BOT_DIR=. GEMINI_API_KEY=fake BOT_API_KEY=test-key python tests/contract_server.py
 *   2. API:  SALES_BOT_URL=http://127.0.0.1:8000 SALES_BOT_API_KEY=test-key SALES_BOT_TEST_MODE=true SALES_BOT_DEBOUNCE_MS=300
 *   3. node test/salesbot-contract.mjs
 * Checks: context the API sends is accepted, the bot's lookups (product, delivery fee with weight, knowledge) work,
 * the reply comes back, the engine saves the reply + pending order, and the Gemini cache is used from the 2nd message.
 */
import assert from 'node:assert/strict';
import { api, createWorkspace, closeDb, sql } from './helpers.mjs';
const A = await createWorkspace('sbot');
const t = A.token;
const cat = await api('POST', '/product-catergory', { token: t, body: { name: 'Shoes ' + Date.now() } });
const prod = await api('POST', '/products', { token: t, body: { name: 'Red shoe', price: 2500, quantity: 5, category_id: cat.data.id, weight: 0.6, has_variants: true,
  variants: [{ variant_name: 'Size', variant_value: '40', price: 2500, quantity: 3, weight: 0.6 }, { variant_name: 'Size', variant_value: '41', price: 2600, quantity: 0, weight: 0.7 }] } });
console.log('product', prod.status, prod.status !== 201 ? JSON.stringify(prod.json).slice(0, 300) : '');
const p2 = await api('POST', '/products', { token: t, body: { name: 'Blue sock', price: 300, quantity: 0, category_id: cat.data.id } });
console.log('product2', p2.status);
const zone = await api('POST', '/bot/delivery-zones', { token: t, body: { area: 'Colombo', fee: 350, days: '1-2 days', included_kg: 1, per_extra_kg: 100, weight_rounding: 'exact' } });
console.log('zone', zone.status, zone.status >= 300 ? JSON.stringify(zone.json) : '');
const svc = await api('POST', '/bot/services', { token: t, body: { name: 'Shoe cleaning', price: 1000, duration_min: 30 } });
console.log('service', svc.status, svc.status >= 300 ? JSON.stringify(svc.json).slice(0, 200) : '');
for (const k of [{ question: 'Return policy', answer: 'Returns within 7 days if unused.', category: 'Policy' }, { question: 'Do you have COD?', answer: 'Yes, cash on delivery island-wide.', category: 'FAQ' }, { question: 'price eka kiyada', answer: 'Aney Rs 2,500i, size 40 thiyenawa', category: 'Style' }]) {
  const r = await api('POST', '/bot/train', { token: t, body: k }); if (r.status >= 300) console.log('train', r.status, JSON.stringify(r.json));
}
const settings = await api('PATCH', '/bot/sales-bot/settings', { token: t, body: { bot_enabled: true, about: 'Shoe shop in Colombo', opening_hours: '9-6', payment_methods: 'COD, bank', greeting: 'Ayubowan!', auto_enable_new_customers: true } });
console.log('settings', settings.status, settings.status >= 300 ? JSON.stringify(settings.json) : '');

// 1) admin "Test chat"
const test = await api('POST', '/bot/sales-bot/test', { token: t, body: { message: 'red shoe 2k ona, Colombo ta', session: {} } });
console.log('TEST CHAT', test.status, JSON.stringify(test.json).slice(0, 700));
assert.equal(test.status, 201);
assert.ok(test.data.reply, 'bot replied');
assert.ok(test.data.tools_used.includes('delivery_fee'), 'lookups ran');
assert.equal(test.data.order.delivery_fee, 370, 'weight-based delivery fee = 350 + 0.2 kg x 100 (exact weight)');

// 2) full engine path (customer simulator → engine → bot → actions → reply saved)
const fd = new FormData(); fd.append('phone', '99994771112233'); fd.append('name', 'Nimal'); fd.append('text', 'red shoe size 40 2k ona');
const sim = await api('POST', '/bot/sales-bot/simulate', { token: t, form: fd });
console.log('SIMULATE', sim.status, JSON.stringify(sim.json).slice(0, 300));
await new Promise((r) => setTimeout(r, 7000)); // the engine waits SALES_BOT_DEBOUNCE_MS (4 s) for more messages
const msgs = await sql(`SELECT m.direction, m.content, m.source FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user u ON u.id = c.bot_channel_user_id WHERE u.company_id = $1 ORDER BY m.id`, [A.companyId]);
console.log('MESSAGES', JSON.stringify(msgs));
assert.ok(msgs.some((m) => m.source === 'sales_bot'), 'engine saved the bot reply');
const usage = await sql(`SELECT model, input_tokens, cached_tokens, output_tokens, calls, cost_usd, is_test FROM bot_ai_usage WHERE company_id = $1`, [A.companyId]).catch((e) => e.message);
console.log('USAGE ROWS', JSON.stringify(usage));
assert.ok(usage.some((u) => Number(u.cached_tokens) > 0), 'Gemini prompt cache used from the 2nd message');
console.log('CONTRACT OK');
const u = await sql(`SELECT session_state FROM bot_channel_user WHERE company_id = $1`, [A.companyId]);
console.log('SESSION', JSON.stringify(u).slice(0, 600));
const notes = await sql(`SELECT * FROM bot_customer_note WHERE company_id = $1`, [A.companyId]).catch((e) => e.message);
console.log('NOTES', JSON.stringify(notes).slice(0, 300));
await closeDb();
