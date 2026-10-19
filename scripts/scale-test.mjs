#!/usr/bin/env node
/**
 * Sales bot QUALITY + PERFORMANCE test with the REAL AI (Gemini): real customer chats in several shops, through the
 * real API and bot. Prints, per shop: AI calls per reply, which lookups ran, tokens, thinking, Rs per reply (2026 / 2027),
 * reply speed (average + slowest) and PASS / FAIL quality checks.
 *
 *   Shops (skipped automatically when the login does not exist):
 *     small / medium / mediumlarge / large  – the 4 TEST shops (15 / 200 / 750 / 2000 products, test-shops.sql)
 *     vora   – clothing shop, 72 products with Colour / Size (set VORA_EMAIL and VORA_PASSWORD)
 *     salon  – Glow Beauty Salon demo (services + bookings, demo-accounts.sql)
 *
 *   cd backend      (the API needs SALES_BOT_TEST_MODE=true while you test – nothing is sent to WhatsApp)
 *   VORA_EMAIL=you@shop.lk VORA_PASSWORD=... node scripts/scale-test.mjs
 *
 * Optional: API_URL (default http://localhost:3001/v1/api), SCALE_TEST_SHOPS=vora,salon (only some shops),
 *   SCALE_TEST_PASSWORD (test shops, default ScaleTest-2026!), DEMO_PASSWORD (demo shops, default 12345678), USD_LKR.
 * Costs about Rs 80–150 of AI in total. The database address is read from .env (PRODUCT_DATABASE_URL).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:3001/v1/api').replace(/\/+$/, '');
const USD_LKR = Number(process.env.USD_LKR || 330.33);
const BUDGET_RS = Number(process.env.BUDGET_RS || 0.6);
const env = (() => {
  try {
    return Object.fromEntries(readFileSync('.env', 'utf8').split('\n').map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, '')]));
  } catch { return {}; }
})();
const DATABASE_URL = process.env.PRODUCT_DATABASE_URL || env.PRODUCT_DATABASE_URL;
const TEST_PW = process.env.SCALE_TEST_PASSWORD || 'ScaleTest-2026!';
const DEMO_PW = process.env.DEMO_PASSWORD || '12345678';

/** Shop-specific words for the meaning / budget / not-sold questions. */
const SHOPS = [
  { key: 'small', label: 'Small (15)', email: 'scale-small@agentmetra.test', password: TEST_PW,
    meaning: { text: 'kolla babata sellam ekak ona', category: 'Toys' }, budget: { text: 'baby gift ekak ona, 2000 witara budget', max: 2000 },
    missing: 'iPhone 16 Pro Max thiyenawada?' },
  { key: 'medium', label: 'Medium (200)', email: 'scale-medium@agentmetra.test', password: TEST_PW,
    meaning: { text: 'amma ta saree ekak ona', category: 'Sarees' }, budget: { text: 'gahanu kenekta dress ekak ona 4000ta adui', max: 4000 },
    missing: 'iPhone 16 Pro Max thiyenawada?' },
  { key: 'mediumlarge', label: 'Medium-large (750)', email: 'scale-mediumlarge@agentmetra.test', password: TEST_PW,
    meaning: { text: 'phone eka charge karanna adapter ekak ona', category: 'Chargers & Cables' }, budget: { text: 'earbuds ekak ona 5000 athara', max: 5000 },
    missing: 'washing machine thiyenawada?' },
  { key: 'large', label: 'Large (2000)', email: 'scale-large@agentmetra.test', password: TEST_PW,
    meaning: { text: 'kiri piti packet ekak ona', category: 'Milk Powder & Dairy' }, budget: { text: 'tea packet ekak ona 800ta adui', max: 800 },
    missing: 'iPhone 16 Pro Max thiyenawada?' },
  { key: 'vora', label: 'VORA clothing (72)', email: process.env.VORA_EMAIL || '', password: process.env.VORA_PASSWORD || DEMO_PW,
    meaning: { text: 'office yanna gahanu kenekta mokak hari ona', category: "Women's Tops" }, budget: { text: 'ammata saree ekak 10000ta adui', max: 10000 },
    missing: 'iPhone 16 Pro Max thiyenawada?' },
  { key: 'salon', label: 'Glow salon (services)', email: 'glow@demo.test', password: DEMO_PW, services: true },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rs = (usd) => (usd * USD_LKR).toFixed(2);

async function call(method, path, { token, body, form } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, data: json?.data ?? json };
}

const botMessages = async (db, id) => (await db.query(
  `SELECT id, content, message_type, media_url FROM bot_message WHERE conversation_id = $1 AND direction::text = 'outbound' ORDER BY id`, [id])).rows;

/** One customer chat (each inner array = messages sent quickly together). Returns the conversation id and bot replies. */
async function chat(db, token, phone, bursts, log) {
  let conversationId = null;
  let seen = 0;
  const replies = [];
  const turns = [];
  for (const burst of bursts) {
    for (const text of burst) {
      const form = new FormData(); form.append('phone', phone); form.append('name', 'Scale Test'); form.append('text', text);
      const sent = await call('POST', '/bot/sales-bot/simulate', { token, form });
      if (sent.status >= 300) throw new Error(`simulate failed (${sent.status}): ${JSON.stringify(sent.json).slice(0, 200)}`);
      conversationId = sent.data?.conversation_id ?? conversationId;
      log(`  customer: ${text}`);
      await sleep(500);
    }
    let messages = [];
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      messages = await botMessages(db, conversationId);
      if (messages.some((m, idx) => idx >= seen && m.message_type === 'text')) { await sleep(2500); messages = await botMessages(db, conversationId); break; }
    }
    const fresh = messages.slice(seen);
    seen = messages.length;
    for (const reply of fresh) log(`  bot:      ${reply.message_type === 'image' ? '[photo] ' : ''}${String(reply.content).replace(/\n/g, ' / ').slice(0, 190)}`);
    if (!fresh.length) log('  bot:      (no reply)');
    replies.push(...fresh);
    turns.push(fresh);
  }
  const texts = replies.filter((r) => r.message_type !== 'image');
  return { conversationId, replies, turns, photos: replies.filter((r) => r.message_type === 'image'), text: texts.map((r) => String(r.content)).join(' \n ') };
}

const money = (text) => [...String(text).matchAll(/Rs\.?\s?([\d,]+)/gi)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => n > 0);
const words = (name) => String(name).toLowerCase().split(/\s+/).slice(0, 2).join(' ');
const mentions = (text, product) => String(text).toLowerCase().includes(words(product.name)) || money(text).includes(Math.round(Number(product.price)));
const notAvailable = (text) => /\bna\b|\bnaa\b|naha|nehe|nathi|not available|out of stock|sold out|don't have|do not have|samawenna|sorry|ivara|iwara|නැ|නෑ|ඉවර/i.test(text);
const toolsOf = async (db, conversationId) => (await db.query(`SELECT tools_used FROM bot_ai_usage WHERE conversation_id = $1 ORDER BY id`, [conversationId]).catch(() => ({ rows: [] }))).rows.map((r) => r.tools_used || '');

async function testShop(db, shop, log) {
  const login = await call('POST', '/auth/login', { body: { email: shop.email, password: shop.password } });
  const token = login.data?.access_token;
  if (!token) throw new Error(`${shop.email}: login failed (${login.status})`);
  const { rows: [company] } = await db.query(`SELECT company_id FROM app_user WHERE email = $1`, [shop.email]);
  const companyId = company.company_id;
  const { rows: products } = await db.query(
    `SELECT p.id, p.name, p.price, p.has_variants, p.is_available, c.name AS category, v.variants
       FROM product p JOIN product_catergory c ON c.id = p.category_id LEFT JOIN product_variant v ON v.product_id = p.id
      WHERE p.company_id = $1 AND NOT p.is_deleted ORDER BY p.name`, [companyId]);
  const { rows: zones } = await db.query(`SELECT area, fee, included_kg, per_extra_kg FROM bot_delivery_zone WHERE company_id = $1 ORDER BY id`, [companyId]);
  const { rows: faqs } = await db.query(`SELECT question, answer FROM bot_training_data WHERE company_id = $1 AND is_active AND category = 'faq' ORDER BY id`, [companyId]);
  const run = Date.now().toString().slice(-5);
  let n = 0;
  const phone = () => `999471${run}${String(n++).padStart(2, '0')}`.slice(0, 14);
  const conversations = [];
  const checks = [];
  const small = products.length <= 100;
  const check = (name, ok, detail = '') => { checks.push([name, Boolean(ok), detail]); };

  // warm-up (not counted): the first AI message builds the prompt cache (and the meaning-search index for big shops)
  log(`  (warm-up, not counted${products.length > 100 ? ': building the meaning-search index, waiting 60 s' : ''})`);
  await chat(db, token, phone(), [[shop.services ? 'mona mona services thiyenawada?' : 'mona mona badu thiyenawada?']], () => {});
  await sleep(products.length > 100 ? Number(process.env.SCALE_TEST_WARMUP_MS ?? 60_000) : 5000);

  const step = async (label, bursts) => {
    log(`\n  [${label}]`);
    const result = await chat(db, token, phone(), bursts, log);
    conversations.push(result.conversationId);
    return result;
  };

  if (shop.services) {
    const { rows: services } = await db.query(`SELECT name, price FROM bot_service WHERE company_id = $1 AND is_active ORDER BY id`, [companyId]);
    const svc = services[0];
    const list = await step('services list', [['Hi'], ['mona mona services thiyenawada? price list ekak denna']]);
    check('Lists real services with prices', services.filter((s) => list.text.toLowerCase().includes(words(s.name))).length >= 2, `${services.length} services`);
    const price = await step(`price: ${svc.name}`, [[`${svc.name} kiyada?`]]);
    check('Exact service price', money(price.text).includes(Math.round(Number(svc.price))), `Rs ${Number(svc.price)}`);
    // earlier test runs booked times too – cancel those test bookings so the same time is free again
    await db.query(`UPDATE bot_booking SET status = 'cancelled' WHERE company_id = $1 AND bot_channel_user_id IN
      (SELECT id FROM bot_channel_user WHERE company_id = $1 AND external_user_id LIKE '999%')`, [companyId]).catch(() => undefined);
    const book = await step('booking', [[`heta udee 10ta ${svc.name} ekak book karanna puluwanda? mage nama Sunil, 0771234567`], ['ow hari, confirm karanna'], ['ok']]);
    const { rows: [booked] } = await db.query(`SELECT COUNT(*)::int AS n FROM bot_booking WHERE conversation_id = $1`, [book.conversationId]);
    check('Takes a booking', booked.n >= 1, `${booked.n} booking(s)`);
    const sinhala = await step('Sinhala script', [['ඔයාලා ඉරිදා විවෘතද?']]);
    check('Answers in Sinhala script', /[඀-෿]/.test(sinhala.text));
  } else {
    // 1) browse
    const browse = await step('browse', [['Hi'], ['mona mona badu thiyenawada?', 'price list ekak ewanna']]);
    // big shops answer with categories + prices (the prompt has a category index, not every product)
    const categories = [...new Set(products.map((p) => String(p.category)))];
    const namedCategories = categories.filter((c) => browse.text.toLowerCase().includes(c.toLowerCase().split(/[ &]+/)[0]));
    check('Browse shows real products / categories with prices', products.some((p) => mentions(browse.text, p))
      || (products.length > 100 && namedCategories.length >= 2 && money(browse.text).length >= 2), `${namedCategories.length} categories, ${money(browse.text).length} prices`);

    // 2) a product deep in the catalog
    const deep = products[Math.floor(products.length * 0.9)];
    const exact = await step(`exact product: ${deep.name} – Rs ${Number(deep.price)}`, [[`${deep.name} thiyenawada? kiyada?`]]);
    check('Finds a product by name', mentions(exact.text, deep), deep.name);

    // 3) one option (colour / size) with its own price, and a sold-out option
    const withOptions = products.filter((p) => p.has_variants && Array.isArray(p.variants) && p.variants.length > 1);
    const priced = withOptions.flatMap((p) => p.variants.map((v) => ({ p, v }))).find(({ p, v }) => v.available !== false && Number(v.price) > 0 && Number(v.price) !== Number(p.price));
    if (priced) {
      const ask = `${priced.p.name} ${String(priced.v.variant_value).replace(' / ', ' ')} ekak kiyada?`;
      const option = await step(`option price: ${priced.p.name} ${priced.v.variant_value} – Rs ${Number(priced.v.price)}`, [[ask]]);
      check('Exact price of an option (bigger size / pack)', money(option.text).includes(Math.round(Number(priced.v.price))), `Rs ${Number(priced.v.price)}`);
      if (small) check('No product lookup needed (one call)', !(await toolsOf(db, option.conversationId)).some((t) => t.includes('get_product')), (await toolsOf(db, option.conversationId)).join(' | ') || 'no lookups');
    }
    const soldOut = withOptions.flatMap((p) => p.variants.map((v) => ({ p, v }))).find(({ p, v }) => v.available === false && p.is_available);
    if (soldOut) {
      const out = await step(`sold-out option: ${soldOut.p.name} ${soldOut.v.variant_value}`, [[`${soldOut.p.name} ${String(soldOut.v.variant_value).replace(' / ', ' ')} thiyenawada?`]]);
      check('Says a sold-out option is not available', notAvailable(out.text), soldOut.v.variant_value);
    }

    // 4) the named colour's photo (only when the product has a photo per colour)
    const coloured = withOptions.find((p) => new Set(p.variants.filter((v) => v.image_url).map((v) => v.image_url)).size >= 2);
    if (coloured) {
      const target = coloured.variants.filter((v) => v.image_url)[1];
      const colour = String(target.variant_value).split(' / ')[0];
      const photo = await step(`colour photo: ${coloured.name} ${colour}`, [[`${coloured.name} ${colour} eka photo ekak ewanna`]]);
      const urls = photo.photos.map((m) => m.media_url);
      check('Sends the named colour\'s photo only', urls.length >= 1 && urls.every((u) => String(u).includes(String(target.image_url).split('/').pop())), `${colour}: ${urls.length} photo(s)`);
    }

    // 5) Singlish meaning + budget
    if (shop.meaning) {
      const inCategory = products.filter((p) => p.category === shop.meaning.category);
      const meaning = await step(`meaning: "${shop.meaning.text}" → ${shop.meaning.category}`, [[shop.meaning.text]]);
      check('Understands Singlish meaning', inCategory.some((p) => mentions(meaning.text, p)), shop.meaning.category);
      const budget = await step(`budget: ${shop.budget.text}`, [[shop.budget.text]]);
      const prices = money(budget.text);
      check('Suggests items within budget', prices.some((p) => p <= shop.budget.max), prices.join(', ') || 'no prices');
      const missing = await step(`not sold: ${shop.missing}`, [[shop.missing]]);
      check('Says "not available" (no made-up item)', notAvailable(missing.text));
    }

    // 6) delivery fee (flat zone → exact fee, no lookup) and an FAQ (in the prompt → no search)
    const flat = zones.find((z) => z.area !== '*' && (z.included_kg == null || !Number(z.per_extra_kg)));
    if (flat) {
      const area = String(flat.area).split(',')[0].replace(/\s*\d+-\d+$/, '').trim();
      const delivery = await step(`delivery: ${area} – Rs ${Number(flat.fee)}`, [[`${area} ta delivery kiyada? kochchara dawas yanawada?`]]);
      check('Exact delivery fee', money(delivery.text).includes(Math.round(Number(flat.fee))), `Rs ${Number(flat.fee)}`);
      check('No delivery lookup for a flat fee', !(await toolsOf(db, delivery.conversationId)).some((t) => t.includes('delivery_fee')), (await toolsOf(db, delivery.conversationId)).join(' | ') || 'no lookups');
    }
    if (faqs.length) {
      const faq = faqs[0];
      const answer = await step(`FAQ: ${faq.question}`, [[faq.question]]);
      const key = String(faq.answer).toLowerCase().match(/[a-z]{5,}/g) ?? [];
      check('Answers an FAQ from the shop', key.some((w) => answer.text.toLowerCase().includes(w)), faq.question);
      if (faqs.length <= 30) check('No FAQ search needed', !(await toolsOf(db, answer.conversationId)).some((t) => t.includes('search_knowledge')), (await toolsOf(db, answer.conversationId)).join(' | ') || 'no lookups');
    }

    // 7) Sinhala script
    const sinhala = await step('Sinhala script', [['ඔයාලා cash on delivery කරනවද?']]);
    check('Answers in Sinhala script', /[඀-෿]/.test(sinhala.text));

    // 7a) Sinhala / Tamil written in English letters → the reply comes in Sinhala / Tamil letters
    const singlish = await step('Singlish → Sinhala letters', [['cash on delivery puluwanda? kochchara dawasin enawada?']]);
    check('Singlish gets Sinhala letters', /[඀-෿]{4}/.test(singlish.text), singlish.text.slice(0, 40));
    const tanglish = await step('Tanglish → Tamil letters', [['cash on delivery irukka? evlo naal aagum?']]);
    check('Tanglish gets Tamil letters', /[஀-௿]{4}/.test(tanglish.text), tanglish.text.slice(0, 40));

    // 7b) the customer switches language: English -> Sinhala letters -> English (the reply follows every time)
    const sw = await step('language switch', [['Hi, do you deliver to Kandy?'], ['ඔයාලගේ ලඟ මොනවද තියෙන්නේ?'], ['ok, how much is delivery?']]);
    const [en1, si, en2] = sw.turns.map((t) => t.filter((r) => r.message_type !== 'image').map((r) => String(r.content)).join(' '));
    const isEnglish = (t) => !/[\u0D80-\u0DFF]/.test(t ?? '') && /\b(the|is|we|you|to|for|delivery|yes)\b/i.test(t ?? '');
    check('Follows English, then Sinhala letters, then English', isEnglish(en1) && /[\u0D80-\u0DFF]/.test(si ?? '') && isEnglish(en2),
      `${(en1 ?? '').slice(0, 25)} | ${(si ?? '').slice(0, 25)} | ${(en2 ?? '').slice(0, 25)}`);

    // 8) order: an option product when there is one (exact variant + total), else a simple product; then "ok"
    const orderProduct = (priced?.p) ?? products.find((p, i) => !p.has_variants && p.is_available && i > products.length / 3) ?? products.find((p) => !p.has_variants && p.is_available);
    const orderOption = priced?.v ?? null;
    const what = `${orderProduct.name}${orderOption ? ` ${String(orderOption.variant_value).replace(' / ', ' ')}` : ''}`;
    const unit = Number(orderOption?.price ?? orderProduct.price);
    const zone = flat ?? zones[0];
    const areaWord = zone ? String(zone.area).split(',')[0].replace(/\s*\d+-\d+$/, '').trim() : 'Colombo';
    const order = await step(`order: 2 x ${what} → ${areaWord}`, [[`${what} 2k ona. Sunil Silva, 22 Lake Road, ${areaWord}. COD`], ['ok'], ['ok']]);
    const { rows: [saved] } = await db.query(
      `SELECT o.id, o.total_amount, o.delivery_fee FROM bot_order o JOIN bot_conversation c ON c.bot_channel_user_id = o.bot_channel_user_id WHERE c.id = $1 ORDER BY o.id DESC LIMIT 1`, [order.conversationId]);
    check('Takes an order (ok = confirm)', Boolean(saved), saved ? `order #${saved.id}` : 'no order');
    if (saved) {
      const { rows: items } = await db.query(`SELECT product_name, variant_text, quantity, unit_price FROM bot_order_item WHERE order_id = $1`, [saved.id]);
      const right = items.length === 1 && Number(items[0].quantity) === 2 && Number(items[0].unit_price) === unit
        && (!orderOption || String(items[0].variant_text ?? '').toLowerCase().includes(String(orderOption.variant_value).split(' / ')[0].toLowerCase()));
      check('Order has the right item, option, quantity and price', right, items.map((i) => `${i.quantity} x ${i.product_name} ${i.variant_text ?? ''} @ ${Number(i.unit_price)}`).join('; '));
      const summaryTotal = money(order.text.match(/Total:[^\n]*/i)?.[0] ?? '')[0];
      check('Summary total = saved order total', summaryTotal === Math.round(Number(saved.total_amount)), `summary Rs ${summaryTotal ?? '?'} / saved Rs ${Number(saved.total_amount)}`);
    }

    // 8b) after the summary the customer asks about ANOTHER product, then says "ok" to that answer:
    //     no order yet (that "ok" was not a yes to the summary), the other product is not added; then a clear yes saves it
    const other = products.find((p) => p.id !== orderProduct.id && !p.has_variants && p.is_available && p.category !== orderProduct.category)
      ?? products.find((p) => p.id !== orderProduct.id && !p.has_variants && p.is_available);
    if (other) {
      const browse = await step(`asks about another product after the summary: ${other.name}`,
        [[`${what} 1k ona. Nimal Perera, 10 Temple Road, ${areaWord}. COD`], [`${other.name} kiyada?`], ['ok'], ['ow confirm karanna']]);
      const orderRows = async () => (await db.query(
        `SELECT o.id, o.created_at FROM bot_order o JOIN bot_conversation c ON c.bot_channel_user_id = o.bot_channel_user_id WHERE c.id = $1 ORDER BY o.id`, [browse.conversationId])).rows;
      const rows = await orderRows();
      const okTurn = (browse.turns[2] ?? []).map((r) => String(r.content)).join(' ');
      check('"ok" to another answer does not confirm the order', !/invoice for order/i.test(okTurn), okTurn.slice(0, 50));
      check('Asked-about product is not added to the order', rows.length === 1 && !(await db.query(
        `SELECT 1 FROM bot_order_item WHERE order_id = $1 AND product_id = $2`, [rows[0].id, other.id])).rows.length,
        rows.length ? `order #${rows[0].id}` : 'no order after the clear yes');
    }
  }

  const { rows: usage } = await db.query(
    `SELECT calls, input_tokens, cached_tokens, output_tokens, cost_usd, latency_ms,
            COALESCE(thinking_tokens, 0) AS thinking_tokens, COALESCE(tools_used, '') AS tools_used
       FROM bot_ai_usage WHERE conversation_id = ANY($1::int[])`, [conversations.filter(Boolean)])
    .catch(() => db.query(`SELECT calls, input_tokens, cached_tokens, output_tokens, cost_usd, latency_ms, 0 AS thinking_tokens, '' AS tools_used
       FROM bot_ai_usage WHERE conversation_id = ANY($1::int[])`, [conversations.filter(Boolean)]));
  const ai = usage.filter((u) => Number(u.calls) > 0);
  const sum = (key, rows = usage) => rows.reduce((s, u) => s + Number(u[key] || 0), 0);
  const avg = (key) => (ai.length ? sum(key, ai) / ai.length : 0);
  const latencies = ai.map((u) => Number(u.latency_ms) / 1000).sort((a, b) => a - b);
  const lookups = {};
  for (const u of ai) for (const t of String(u.tools_used).split(',').filter(Boolean)) lookups[t] = (lookups[t] ?? 0) + 1;
  const perReply = usage.length ? sum('cost_usd') / usage.length : 0;
  return {
    shop: shop.label, products: products.length, replies: usage.length, aiReplies: ai.length,
    callsPerReply: ai.length ? sum('calls', ai) / ai.length : 0, oneCall: ai.length ? ai.filter((u) => Number(u.calls) === 1).length / ai.length : 0,
    input: avg('input_tokens'), cached: avg('cached_tokens'), output: avg('output_tokens'), thinking: avg('thinking_tokens'),
    cost: sum('cost_usd'), perReply, latency: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    slowest: latencies.at(-1) ?? 0, lookups, checks, conversations: conversations.filter(Boolean),
  };
}

async function main() {
  if (!DATABASE_URL) throw new Error('PRODUCT_DATABASE_URL not found (run from the backend folder with its .env).');
  const db = new pg.Client({ connectionString: DATABASE_URL, ssl: /supabase|sslmode=require/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined });
  await db.connect();
  const only = String(process.env.SCALE_TEST_SHOPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const results = [];
  for (const shop of SHOPS) {
    if (only.length && !only.includes(shop.key)) continue;
    if (!shop.email) { console.log(`\n(skipped ${shop.label}: set VORA_EMAIL and VORA_PASSWORD to test it)`); continue; }
    const login = await call('POST', '/auth/login', { body: { email: shop.email, password: shop.password } });
    if (!login.data?.access_token) { console.log(`\n(skipped ${shop.label}: cannot log in as ${shop.email})`); continue; }
    const status = await call('GET', '/bot/sales-bot/simulate/status', { token: login.data.access_token });
    if (status.data?.test_mode === false) throw new Error('Set SALES_BOT_TEST_MODE=true on the API (and restart) while testing.');
    console.log(`\n=================== ${shop.label} ===================`);
    try {
      results.push(await testShop(db, shop, (line) => console.log(line)));
    } catch (error) {
      console.log(`  ERROR in ${shop.label}: ${error.message}`);
    }
  }
  // 2027: only Gemini 3.6 / 3.7 / 3.8 Flash have a promotional price that doubles on 1 Jan 2027; other models keep their price
  // the models this test used (main model + the small one for "ok" / address turns)
  const { rows: usedModels } = await db.query(
    `SELECT model, COUNT(*)::int AS n FROM bot_ai_usage WHERE conversation_id = ANY($1::int[]) GROUP BY model ORDER BY n DESC`,
    [results.flatMap((r) => r.conversations)]).catch(() => ({ rows: [] }));
  const model = usedModels.map((row) => row.model).join(' + ') || 'unknown model';
  const y2027 = usedModels.some((row) => /gemini-3\.[678]-flash/.test(String(row.model))) ? 2 : 1;
  await db.end();

  console.log('\n\n=================== PERFORMANCE & COST ===================');
  console.table(results.map((r) => ({
    Shop: r.shop, Products: r.products, Replies: r.replies, 'AI calls/reply': r.callsPerReply.toFixed(2), '1-call replies': `${Math.round(r.oneCall * 100)}%`,
    'Cached tok': Math.round(r.cached), 'Fresh tok': Math.round(r.input - r.cached), 'Output tok': Math.round(r.output), 'Thinking tok': Math.round(r.thinking),
    'Rs/reply 2026': rs(r.perReply), 'Rs/reply 2027': rs(r.perReply * y2027), Budget: Number(rs(r.perReply)) <= BUDGET_RS ? 'OK' : 'OVER',
    'Avg sec': r.latency.toFixed(1), 'Slowest sec': r.slowest.toFixed(1),
  })));
  console.log('\nLookups (each = one more AI call):');
  for (const r of results) console.log(`  ${r.shop}: ${Object.entries(r.lookups).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}`);
  console.log('\n=================== QUALITY CHECKS ===================');
  let pass = 0; let total = 0;
  for (const r of results) {
    const ok = r.checks.filter((c) => c[1]).length;
    pass += ok; total += r.checks.length;
    console.log(`\n${r.shop}  –  ${ok}/${r.checks.length}`);
    for (const [name, good, detail] of r.checks) console.log(`  ${good ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  }
  const all = results.reduce((s, r) => s + r.cost, 0) / Math.max(1, results.reduce((s, r) => s + r.replies, 0));
  console.log(`\nTOTAL: quality ${pass}/${total} · average Rs ${rs(all)} per reply (2026), Rs ${rs(all * y2027)} (2027${y2027 === 1 ? ', no price change announced for ' + model : ', promo price doubles'}) · budget Rs ${BUDGET_RS}`);
  const csv = ['shop,products,replies,ai_calls_per_reply,one_call_pct,cached_tokens,fresh_tokens,output_tokens,thinking_tokens,rs_per_reply_2026,rs_per_reply_2027,avg_seconds,slowest_seconds,quality',
    ...results.map((r) => [r.shop, r.products, r.replies, r.callsPerReply.toFixed(2), Math.round(r.oneCall * 100), Math.round(r.cached), Math.round(r.input - r.cached),
      Math.round(r.output), Math.round(r.thinking), rs(r.perReply), rs(r.perReply * y2027), r.latency.toFixed(1), r.slowest.toFixed(1),
      `${r.checks.filter((c) => c[1]).length}/${r.checks.length}`].join(','))].join('\n');
  writeFileSync('scale-test-results.csv', csv);
  console.log('\nSaved scale-test-results.csv. Send this whole output to Claude for the review.');
  console.log('Afterwards set SALES_BOT_TEST_MODE=false again.');
}

main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exit(1); });
