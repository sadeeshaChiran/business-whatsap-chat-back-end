#!/usr/bin/env node
/**
 * Bot test for ONE client company, with marks. Works for any shop (products or services) – no code change.
 *
 *   SALES_BOT_TEST_MODE=true on the API (restart), then from the backend folder:
 *   API_URL=http://localhost:6001/v1/api CLIENT_EMAIL=owner@shop.lk CLIENT_PASSWORD='***' \
 *     node scripts/client-test.mjs [scripts/bot-training/clients/<client>.json] | tee client-test.log
 *
 * 1. Standard checks made from the client's OWN data: browse with prices, a product by name, an option price,
 *    "not sold" item, an FAQ, Sinhala / Singlish / Tamil letters, language switch, order + summary total,
 *    "ok" to another answer, only-asked product not added (or services: list, price, booking).
 * 2. The client's own test cases from the JSON ("tests"; "auto_test" adds meaning / budget / not-sold checks):
 *      { "name": "...", "send": ["msg 1", "msg 2"],             each message is answered before the next
 *        "expect": { "letters": "sinhala|tamil|english", "contains_any": [...], "contains_all": [...],
 *                    "not_contains": [...], "price": 2450, "order": true|false, "photo": true } }
 * Test orders / bookings it made are deleted at the end (CLIENT_TEST_KEEP=1 keeps them). Chats use 999… numbers,
 * so nothing reaches a real WhatsApp customer.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { testShop, chat, call, DATABASE_URL } from './scale-test.mjs';

const email = process.env.CLIENT_EMAIL;
const password = process.env.CLIENT_PASSWORD;
const file = process.argv[2];
const spec = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
if (!email || !password) { console.error('Set CLIENT_EMAIL and CLIENT_PASSWORD (the company admin login).'); process.exit(1); }
if (!DATABASE_URL) { console.error('PRODUCT_DATABASE_URL not found (run from the backend folder with its .env).'); process.exit(1); }

const SI = /[඀-෿]/;
const TA = /[஀-௿]/;
const lettersOf = (t) => (SI.test(t) ? 'sinhala' : TA.test(t) ? 'tamil' : 'english');
const money = (text) => [...String(text).matchAll(/Rs\.?\s?([\d,]+)/gi)].map((m) => Number(m[1].replace(/,/g, '')));
const has = (text, word) => String(text).toLowerCase().includes(String(word).toLowerCase());

async function main() {
  const db = new pg.Client({ connectionString: DATABASE_URL, ssl: /supabase|sslmode=require/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined });
  await db.connect();
  const login = await call('POST', '/auth/login', { body: { email, password } });
  const token = login.data?.access_token;
  if (!token) throw new Error(`cannot log in as ${email} (${login.status})`);
  const status = await call('GET', '/bot/sales-bot/simulate/status', { token });
  if (status.data?.test_mode === false) throw new Error('Set SALES_BOT_TEST_MODE=true on the API (and restart) while testing.');
  const { rows: [{ company_id: companyId }] } = await db.query('SELECT company_id FROM app_user WHERE LOWER(email) = LOWER($1)', [email]);
  const { rows: [settings] } = await db.query('SELECT bot_name, sells FROM bot_sales_settings WHERE company_id = $1', [companyId]);
  const name = settings?.bot_name || email;
  const started = new Date();

  console.log(`\n=================== ${name} – standard checks ===================`);
  const auto = spec.auto_test ?? {};
  const result = await testShop(db, {
    key: 'client', label: name, email, password, services: settings?.sells === 'services',
    meaning: auto.meaning, budget: auto.budget, missing: auto.missing ?? (auto.meaning ? 'iPhone 16 Pro Max thiyenawada?' : undefined),
  }, (line) => console.log(line));
  const checks = [...result.checks];

  const own = spec.tests ?? [];
  if (own.length) console.log(`\n=================== ${name} – the client's own test cases ===================`);
  let n = 0;
  for (const t of own) {
    console.log(`\n  [${t.name}]`);
    const phone = `999471${Date.now().toString().slice(-5)}${String(90 + (n++ % 10))}`.slice(0, 14);
    const res = await chat(db, token, phone, (t.send ?? []).map((m) => [m]), (line) => console.log(line));
    const last = (res.turns.at(-1) ?? []).filter((r) => r.message_type !== 'image').map((r) => String(r.content)).join('\n');
    const all = res.text;
    const e = t.expect ?? {};
    if (e.letters) checks.push([`${t.name}: reply in ${e.letters} letters`, lettersOf(last) === e.letters, last.slice(0, 50)]);
    if (e.contains_any) checks.push([`${t.name}: mentions ${e.contains_any.join(' / ')}`, e.contains_any.some((w) => has(all, w)), all.slice(0, 60)]);
    for (const w of e.contains_all ?? []) checks.push([`${t.name}: mentions ${w}`, has(all, w), '']);
    for (const w of e.not_contains ?? []) checks.push([`${t.name}: never says "${w}"`, !has(all, w), '']);
    if (e.price != null) checks.push([`${t.name}: price Rs ${e.price}`, money(all).includes(Number(e.price)), money(all).join(', ')]);
    if (e.photo) checks.push([`${t.name}: sends a photo`, res.photos.length > 0, `${res.photos.length} photo(s)`]);
    if (e.order != null) {
      const { rows } = await db.query('SELECT o.id FROM bot_order o JOIN bot_conversation c ON c.bot_channel_user_id = o.bot_channel_user_id WHERE c.id = $1', [res.conversationId]);
      checks.push([`${t.name}: ${e.order ? 'order saved' : 'no order saved'}`, e.order ? rows.length > 0 : rows.length === 0, `${rows.length} order(s)`]);
    }
    if (!e || !Object.keys(e).length) checks.push([`${t.name}: got a reply`, all.trim().length > 0, all.slice(0, 50)]);
  }

  // clean up: orders / bookings made by the test customers (999… numbers) during this run
  if (process.env.CLIENT_TEST_KEEP !== '1') {
    const users = `SELECT id FROM bot_channel_user WHERE company_id = $1 AND external_user_id LIKE '999471%'`;
    const orders = `SELECT id FROM bot_order WHERE company_id = $1 AND created_at >= $2 AND bot_channel_user_id IN (${users})`;
    await db.query(`DELETE FROM bot_order_item WHERE order_id IN (${orders})`, [companyId, started]).catch(() => undefined);
    await db.query(`DELETE FROM bot_order_status_history WHERE order_id IN (${orders})`, [companyId, started]).catch(() => undefined);
    const del = await db.query(`DELETE FROM bot_order WHERE id IN (${orders})`, [companyId, started]).catch(() => ({ rowCount: 0 }));
    const delB = await db.query(`DELETE FROM bot_booking WHERE company_id = $1 AND created_at >= $2 AND bot_channel_user_id IN (${users})`, [companyId, started]).catch(() => ({ rowCount: 0 }));
    console.log(`\n(cleaned up ${del.rowCount} test order(s) and ${delB.rowCount} test booking(s))`);
  }
  await db.end();

  const pass = checks.filter((c) => c[1]).length;
  const pct = Math.round((pass / Math.max(1, checks.length)) * 100);
  const grade = pct >= 95 ? 'A – ready' : pct >= 85 ? 'B – good, fix the FAILs' : pct >= 70 ? 'C – needs training' : 'D – not ready';
  console.log(`\n=================== ${name} – MARKS ===================`);
  for (const [label, good, detail] of checks) console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${String(detail).replace(/\n/g, ' ')})` : ''}`);
  console.log(`\nSCORE: ${pass}/${checks.length} = ${pct}%  →  ${grade}`);
  console.log(`Cost: Rs ${(result.perReply * Number(process.env.USD_LKR || 330.33)).toFixed(2)} per reply · avg ${result.latency.toFixed(1)} s · slowest ${result.slowest.toFixed(1)} s`);
  const out = `client-test-${String(name).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`;
  writeFileSync(out, ['check,result,detail', ...checks.map(([l, g, d]) => [l, g ? 'PASS' : 'FAIL', String(d ?? '')].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','))].join('\n'));
  console.log(`Saved ${out}. Afterwards set SALES_BOT_TEST_MODE=false again.`);
  if (pct < 85) process.exitCode = 2;   // full-test.sh shows it as FAIL
}

main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exit(1); });
