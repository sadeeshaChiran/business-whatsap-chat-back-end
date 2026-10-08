#!/usr/bin/env node
/**
 * REAL AI cost test – runs realistic customer chats through the real sales bot (real Gemini) and
 * prints the cost per reply for 2026 and 2027.
 *
 * Uses the customer simulator, so nothing is sent to WhatsApp. Costs a little real money (about Rs 20–40).
 *
 * On the API server (the API needs SALES_BOT_TEST_MODE=true while you test):
 *   cd backend
 *   COST_TEST_EMAIL=admin@yourshop.lk COST_TEST_PASSWORD='…' node scripts/cost-test.mjs
 *
 * Optional: API_URLscripts/cost-test.mjs (default http://localhost:3001/v1/api), USD_LKR (default 330.33),
 *           COST_TEST_CHATS=1,2 (only some chats). Use a TEST company with real products.
 * The database address is read from .env (PRODUCT_DATABASE_URL) to read bot_ai_usage.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const API = (process.env.PUBLIC_API_BASE_URL || 'http://localhost:3001/v1/api').replace(/\/+$/, '');
const USD_LKR = Number(process.env.USD_LKR || 330.33);
const env = (() => {
  try {
    return Object.fromEntries(readFileSync('.env', 'utf8').split('\n').map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, '')]));
  } catch { return {}; }
})();
const DATABASE_URL = process.env.PRODUCT_DATABASE_URL || env.PRODUCT_DATABASE_URL;

/** Realistic Sri Lankan chats. Each array = one customer; inner arrays = messages sent quickly together. */
const CHATS = [
  { name: 'Singlish – browse, burst, price, order', messages: [
    ['Hi'],
    ['Oyala ge laga', 'Mona thiyena', 'Products'],
    ['price list ekak ewanna puluwanda'],
    ['baby gift pack ekak ona', '3000-4000 athara', 'boy kenek'],
    ['Colombo ta delivery kiyada?', 'COD puluwanda?'],
    ['hari ganna. Nimal Perera, 12 Main Street, Colombo 05'],
    ['ow confirm karanna'],
    ['thanks'],
  ] },
  { name: 'English – questions and doubts', messages: [
    ['Hello'],
    ['Do you have diapers?'],
    ['What sizes do you have and the price for the large pack?'],
    ['Is it original? Can I return if it does not fit?'],
    ['ok I will think and tell you'],
  ] },
  { name: 'Sinhala script – short', messages: [
    ['ඔයාලගේ ළඟ මොනවද තියෙන්නේ?'],
    ['ගණන් කීයද?'],
    ['කොළඹට ඩිලිවරි කරනවද?'],
    ['හරි ස්තූතියි'],
  ] },
  { name: 'Quick buyer – everything at once', messages: [
    ['meka ganna ona, 2k. Kamal, 45 Temple Road, Kandy. COD'],
    ['ok'],
  ] },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, path, { token, body, form } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, data: json?.data ?? json };
}

/** bot messages of this chat (read from the database) */
async function botMessages(db, conversationId) {
  const { rows } = await db.query(`SELECT content FROM bot_message WHERE conversation_id = $1 AND direction::text = 'outbound' ORDER BY id`, [conversationId]);
  return rows;
}

async function main() {
  const email = process.env.COST_TEST_EMAIL; const password = process.env.COST_TEST_PASSWORD;
  if (!email || !password) throw new Error('Set COST_TEST_EMAIL and COST_TEST_PASSWORD (a company admin of a TEST company).');
  if (!DATABASE_URL) throw new Error('PRODUCT_DATABASE_URL not found (run from the backend folder with its .env).');
  const login = await call('POST', '/auth/login', { body: { email, password } });
  const token = login.data?.access_token;
  if (!token) throw new Error(`Login failed (${login.status}): ${JSON.stringify(login.json).slice(0, 200)}`);
  const mode = await call('GET', '/bot/sales-bot/simulate/status', { token });
  if (mode.data?.test_mode === false) throw new Error('Set SALES_BOT_TEST_MODE=true on the API (and restart) while testing.');

  const db = new pg.Client({ connectionString: DATABASE_URL, ssl: /supabase|sslmode=require/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined });
  await db.connect();
  const only = String(process.env.COST_TEST_CHATS || '').split(',').map(Number).filter(Boolean);
  const run = Date.now().toString().slice(-6);
  const conversations = [];
  for (const [index, chat] of CHATS.entries()) {
    if (only.length && !only.includes(index + 1)) continue;
    const phone = `9470${run}${index}`.slice(0, 11);
    console.log(`\n=== Chat ${index + 1}: ${chat.name} (${phone})`);
    let conversationId = null;
    let before = 0;
    for (const burst of chat.messages) {
      for (const text of burst) {
        const form = new FormData(); form.append('phone', phone); form.append('name', 'Cost Test'); form.append('text', text);
        const sent = await call('POST', '/bot/sales-bot/simulate', { token, form });
        if (sent.status >= 300) throw new Error(`simulate failed (${sent.status}): ${JSON.stringify(sent.json).slice(0, 200)}`);
        conversationId = sent.data?.conversation_id ?? conversationId;
        console.log(`  customer: ${text}`);
        await sleep(600);
      }
      // wait for the bot's answer (or no answer for "thanks" / 👍)
      let messages = [];
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        messages = await botMessages(db, conversationId);
        if (messages.length > before) { await sleep(3000); messages = await botMessages(db, conversationId); break; }
      }
      const after = messages.length;
      const replies = messages.slice(before);
      for (const reply of replies) console.log(`  bot:      ${String(reply.content).replace(/\n/g, ' / ').slice(0, 160)}`);
      if (!replies.length) console.log('  bot:      (no reply)');
      before = after;
    }
    if (conversationId) conversations.push(conversationId);
  }

  const { rows } = await db.query(
    `SELECT conversation_id, calls, cached_tokens, input_tokens, output_tokens, cost_usd FROM bot_ai_usage WHERE conversation_id = ANY($1::int[]) ORDER BY id`, [conversations]);
  await db.end();
  const total = rows.reduce((sum, row) => sum + Number(row.cost_usd), 0);
  const ai = rows.filter((row) => Number(row.calls) > 0);
  const free = rows.length - ai.length;
  const missed = ai.filter((row) => Number(row.cached_tokens) === 0).length;
  const rs = (usd) => `Rs ${(usd * USD_LKR).toFixed(2)}`;
  console.log('\n=== RESULT');
  console.log(`replies: ${rows.length} (AI: ${ai.length}, free welcome / skipped: ${free}), AI calls: ${ai.reduce((s, r) => s + Number(r.calls), 0)}, cache missed: ${missed}`);
  console.log(`total: $${total.toFixed(4)} = ${rs(total)}`);
  console.log(`per reply 2026: ${rs(total / Math.max(1, rows.length))}   (AI replies only: ${rs(total / Math.max(1, ai.length))})`);
  console.log(`per reply 2027 (Gemini price x2): ${rs((2 * total) / Math.max(1, rows.length))}`);
  console.log(`per customer chat 2026: ${rs(total / Math.max(1, conversations.length))}   2027: ${rs((2 * total) / Math.max(1, conversations.length))}`);
  console.log('\nSend this whole output to Claude for the review.');
}

main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exit(1); });
