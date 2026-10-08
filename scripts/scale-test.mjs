#!/usr/bin/env node
/**
 * Sales bot SCALE test: the same kind of customer chats in 4 test shops of different size
 * (15 / 200 / 750 / 2000 products, made with scripts/make-test-shops.py → test-shops.sql),
 * through the real bot (real Gemini). Prints cost, tokens, speed and quality checks per shop.
 *
 *   cd backend      (the API needs SALES_BOT_TEST_MODE=true while you test – nothing is sent to WhatsApp)
 *   API_URL=https://api.example.com/v1/api node scripts/scale-test.mjs
 *
 * Optional: SCALE_TEST_PASSWORD (default ScaleTest-2026!), SCALE_TEST_SHOPS=small,large (only some shops),
 *           USD_LKR (default 330.33). Costs about Rs 40–80 of AI in total.
 * The database address is read from .env (PRODUCT_DATABASE_URL) to read replies and AI usage.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:3001/v1/api').replace(/\/+$/, '');
const PASSWORD = process.env.SCALE_TEST_PASSWORD || 'ScaleTest-2026!';
const USD_LKR = Number(process.env.USD_LKR || 330.33);
const env = (() => {
  try {
    return Object.fromEntries(readFileSync('.env', 'utf8').split('\n').map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, '')]));
  } catch { return {}; }
})();
const DATABASE_URL = process.env.PRODUCT_DATABASE_URL || env.PRODUCT_DATABASE_URL;

/** Shop-specific words for the meaning / budget questions. */
const SHOPS = [
  { key: 'small', label: 'Small (15)', email: 'scale-small@agentmetra.test',
    meaning: { text: 'kolla babata sellam ekak ona', category: 'Toys' }, budget: { text: 'baby gift ekak ona, 2000 witara budget', max: 2000 },
    missing: 'iPhone 16 Pro Max thiyenawada?' },
  { key: 'medium', label: 'Medium (200)', email: 'scale-medium@agentmetra.test',
    meaning: { text: 'amma ta saree ekak ona', category: 'Sarees' }, budget: { text: 'gahanu kenekta dress ekak ona 4000ta adui', max: 4000 },
    missing: 'iPhone 16 Pro Max thiyenawada?' },
  { key: 'mediumlarge', label: 'Medium-large (750)', email: 'scale-mediumlarge@agentmetra.test',
    meaning: { text: 'phone eka charge karanna adapter ekak ona', category: 'Chargers & Cables' }, budget: { text: 'earbuds ekak ona 5000 athara', max: 5000 },
    missing: 'washing machine thiyenawada?' },
  { key: 'large', label: 'Large (2000)', email: 'scale-large@agentmetra.test',
    meaning: { text: 'kiri piti packet ekak ona', category: 'Milk Powder & Dairy' }, budget: { text: 'tea packet ekak ona 800ta adui', max: 800 },
    missing: 'iPhone 16 Pro Max thiyenawada?' },
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
  `SELECT content, intent FROM bot_message WHERE conversation_id = $1 AND direction::text = 'outbound' ORDER BY id`, [id])).rows;

/** One customer chat (each inner array = messages sent quickly together). Returns the conversation id and bot replies. */
async function chat(db, token, phone, bursts, log) {
  let conversationId = null;
  let seen = 0;
  const replies = [];
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
      if (messages.length > seen) { await sleep(3000); messages = await botMessages(db, conversationId); break; }
    }
    const fresh = messages.slice(seen);
    seen = messages.length;
    for (const reply of fresh) log(`  bot:      ${String(reply.content).replace(/\n/g, ' / ').slice(0, 170)}`);
    if (!fresh.length) log('  bot:      (no reply)');
    replies.push(...fresh);
  }
  return { conversationId, replies, text: replies.map((r) => String(r.content)).join(' \n ') };
}

const money = (text) => [...String(text).matchAll(/Rs\.?\s?([\d,]+)/gi)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => n > 0);
const words = (name) => String(name).toLowerCase().split(/\s+/).slice(0, 2).join(' ');
const mentions = (text, product) => String(text).toLowerCase().includes(words(product.name)) || money(text).includes(Math.round(Number(product.price)));

async function testShop(db, shop, log) {
  const login = await call('POST', '/auth/login', { body: { email: shop.email, password: PASSWORD } });
  const token = login.data?.access_token;
  if (!token) throw new Error(`${shop.email}: login failed (${login.status}) – did you run test-shops.sql?`);
  const { rows: [company] } = await db.query(`SELECT company_id FROM app_user WHERE email = $1`, [shop.email]);
  const { rows: products } = await db.query(
    `SELECT p.id, p.name, p.price, p.has_variants, p.is_available, c.name AS category FROM product p JOIN product_catergory c ON c.id = p.category_id
      WHERE p.company_id = $1 AND NOT p.is_deleted ORDER BY p.name`, [company.company_id]);
  const run = Date.now().toString().slice(-5);
  let n = 0;
  const phone = () => `9471${run}${String(n++).padStart(2, '0')}`.slice(0, 11);
  const conversations = [];
  const checks = [];

  if (products.length > 300) {
    log('  (warm-up: the first message starts the meaning-search index for a big shop – waiting 60 s)');
    await chat(db, token, phone(), [['mona mona badu thiyenawada?']], () => {});
    await sleep(Number(process.env.SCALE_TEST_WARMUP_MS ?? 60_000));
  }

  // 1) browse
  log('\n  [browse]');
  const browse = await chat(db, token, phone(), [['Hi'], ['mona mona badu thiyenawada?', 'price list ekak ewanna']], log);
  conversations.push(browse.conversationId);

  // 2) a product deep in the catalog (after the first 400 by name)
  const deep = products[Math.floor(products.length * 0.9)];
  log(`\n  [exact product: ${deep.name} – Rs ${Number(deep.price)}]`);
  const exact = await chat(db, token, phone(), [[`${deep.name} thiyenawada? kiyada?`]], log);
  conversations.push(exact.conversationId);
  checks.push(['Finds a product by name', mentions(exact.text, deep), deep.name]);

  // 3) by meaning, Singlish
  const inCategory = products.filter((p) => p.category === shop.meaning.category);
  log(`\n  [meaning: "${shop.meaning.text}" → ${shop.meaning.category}]`);
  const meaning = await chat(db, token, phone(), [[shop.meaning.text]], log);
  conversations.push(meaning.conversationId);
  checks.push(['Understands Singlish meaning', inCategory.some((p) => mentions(meaning.text, p)), shop.meaning.category]);

  // 4) budget
  log(`\n  [budget: ${shop.budget.text}]`);
  const budget = await chat(db, token, phone(), [[shop.budget.text]], log);
  conversations.push(budget.conversationId);
  const prices = money(budget.text);
  checks.push(['Suggests items within budget', prices.some((p) => p <= shop.budget.max), prices.join(', ') || 'no prices']);

  // 5) something the shop does not sell
  log(`\n  [not sold: ${shop.missing}]`);
  const missing = await chat(db, token, phone(), [[shop.missing]], log);
  conversations.push(missing.conversationId);
  checks.push(['Says "not available" (no made-up item)', /naha|nehe|nathi|not available|don't have|do not have|no,|sorry|samawenna|නැ|නෑ/i.test(missing.text), '']);

  // 6) quick order: product without sizes, then "ok" to the summary
  const simple = products.find((p, i) => !p.has_variants && p.is_available && i > products.length / 3) ?? products.find((p) => !p.has_variants && p.is_available);
  log(`\n  [order: ${simple.name}]`);
  const order = await chat(db, token, phone(), [[`${simple.name} ekak ona. Sunil Silva, 22 Lake Road, Colombo 05. COD`], ['ok'], ['ok']], log);
  conversations.push(order.conversationId);
  const { rows: [ordered] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM bot_order o JOIN bot_conversation c ON c.bot_channel_user_id = o.bot_channel_user_id WHERE c.id = $1`, [order.conversationId]);
  checks.push(['Takes an order (ok = confirm)', ordered.n === 1, `${ordered.n} order(s)`]);

  const { rows: usage } = await db.query(
    `SELECT calls, input_tokens, cached_tokens, output_tokens, cost_usd, latency_ms FROM bot_ai_usage WHERE conversation_id = ANY($1::int[])`,
    [conversations.filter(Boolean)]);
  const ai = usage.filter((u) => Number(u.calls) > 0);
  const sum = (key, rows = usage) => rows.reduce((s, u) => s + Number(u[key] || 0), 0);
  const avg = (key) => (ai.length ? sum(key, ai) / ai.length : 0);
  return {
    shop: shop.label, products: products.length, replies: usage.length, aiReplies: ai.length,
    callsPerReply: ai.length ? sum('calls', ai) / ai.length : 0,
    input: avg('input_tokens'), cached: avg('cached_tokens'), output: avg('output_tokens'),
    cost: sum('cost_usd'), perReply: usage.length ? sum('cost_usd') / usage.length : 0, latency: avg('latency_ms') / 1000,
    checks,
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
    console.log(`\n=================== ${shop.label} ===================`);
    const login = await call('POST', '/auth/login', { body: { email: shop.email, password: PASSWORD } });
    const status = await call('GET', '/bot/sales-bot/simulate/status', { token: login.data?.access_token });
    if (status.data?.test_mode === false) throw new Error('Set SALES_BOT_TEST_MODE=true on the API (and restart) while testing.');
    results.push(await testShop(db, shop, (line) => console.log(line)));
  }
  await db.end();

  console.log('\n\n=================== RESULT ===================');
  const table = results.map((r) => ({
    Shop: r.shop, Replies: r.replies, 'AI calls/reply': r.callsPerReply.toFixed(2),
    'Input tok': Math.round(r.input), 'Cached tok': Math.round(r.cached), 'Output tok': Math.round(r.output),
    'Rs/reply 2026': rs(r.perReply), 'Rs/reply 2027': rs(r.perReply * 2), 'Avg sec': r.latency.toFixed(1),
    Quality: `${r.checks.filter((c) => c[1]).length}/${r.checks.length}`,
  }));
  console.table(table);
  console.log('\n=================== QUALITY CHECKS ===================');
  for (const r of results) {
    console.log(`\n${r.shop}`);
    for (const [name, ok, detail] of r.checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  }
  const csv = ['shop,products,replies,ai_calls_per_reply,input_tokens,cached_tokens,output_tokens,rs_per_reply_2026,rs_per_reply_2027,avg_seconds,quality',
    ...results.map((r) => [r.shop, r.products, r.replies, r.callsPerReply.toFixed(2), Math.round(r.input), Math.round(r.cached), Math.round(r.output),
      rs(r.perReply), rs(r.perReply * 2), r.latency.toFixed(1), `${r.checks.filter((c) => c[1]).length}/${r.checks.length}`].join(','))].join('\n');
  writeFileSync('scale-test-results.csv', csv);
  console.log('\nSaved scale-test-results.csv. Send this whole output to Claude for the review.');
  console.log('Afterwards set SALES_BOT_TEST_MODE=false again.');
}

main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exit(1); });
