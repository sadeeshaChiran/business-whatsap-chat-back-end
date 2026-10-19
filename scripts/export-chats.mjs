#!/usr/bin/env node
/**
 * Real customer chats of one shop as a readable text file, for a quality review (send the file to Claude).
 *
 *   node scripts/export-chats.mjs <company_id> [hours=48] [max_chats=40]
 *   e.g. node scripts/export-chats.mjs 16 48 > chats.txt
 *
 * Shows every message (customer / bot / team), what the customer's photos were matched to, the AI lookups and
 * cost per reply, and the orders. Scale-test chats (999471… numbers) are left out. Phone numbers are shortened.
 * The database address is read from .env (PRODUCT_DATABASE_URL).
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const env = (() => {
  try {
    return Object.fromEntries(readFileSync('.env', 'utf8').split('\n').map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, '')]));
  } catch { return {}; }
})();
const DATABASE_URL = process.env.PRODUCT_DATABASE_URL || env.PRODUCT_DATABASE_URL;
const USD_LKR = Number(process.env.USD_LKR || 330.33);
const [companyId, hours = '48', maxChats = '40'] = process.argv.slice(2);
if (!companyId || !DATABASE_URL) {
  console.error('Usage: node scripts/export-chats.mjs <company_id> [hours=48] [max_chats=40]   (run from the backend folder with its .env)');
  process.exit(1);
}
const hidePhone = (value) => String(value ?? '').replace(/\d{6,}/g, (d) => `${d.slice(0, 3)}…${d.slice(-2)}`);
const time = (value) => new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });

const db = new pg.Client({ connectionString: DATABASE_URL, ssl: /supabase|sslmode=require/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined });
await db.connect();
const { rows: chats } = await db.query(
  `SELECT c.id, c.bot_channel_user_id, u.platform, u.external_user_id, u.display_name, MAX(m.created_at) AS last_at, COUNT(m.id)::int AS n
     FROM bot_conversation c
     JOIN bot_channel_user u ON u.id = c.bot_channel_user_id
     JOIN bot_message m ON m.conversation_id = c.id
    WHERE u.company_id = $1 AND m.created_at > NOW() - ($2 || ' hours')::interval AND u.external_user_id NOT LIKE '999471%'
    GROUP BY c.id, u.id ORDER BY MAX(m.created_at) DESC LIMIT $3`, [Number(companyId), String(Number(hours)), Number(maxChats)]);

let totalRs = 0;
let replies = 0;
for (const chat of chats) {
  console.log(`\n==================== chat ${chat.id} · ${chat.platform} · ${hidePhone(chat.display_name || chat.external_user_id)} · ${chat.n} messages ====================`);
  const { rows: messages } = await db.query(
    `SELECT id, direction::text AS direction, message_type::text AS type, content, transcript, source, intent, created_at
       FROM bot_message WHERE conversation_id = $1 AND created_at > NOW() - ($2 || ' hours')::interval ORDER BY id`, [chat.id, String(Number(hours) + 24)]);
  const { rows: usage } = await db.query(
    `SELECT model, calls, cost_usd, tools_used, latency_ms, created_at FROM bot_ai_usage WHERE conversation_id = $1 ORDER BY id`, [chat.id]);
  let u = 0;
  for (const m of messages) {
    const who = m.direction === 'inbound' ? 'CUSTOMER' : m.source === 'sales_bot' ? 'BOT     ' : 'TEAM    ';
    const kind = m.type === 'text' ? '' : `[${m.type}] `;
    const extra = m.transcript ? `  (heard: ${m.transcript})` : '';
    console.log(`${time(m.created_at)}  ${who} ${kind}${hidePhone(String(m.content ?? '')).replace(/\n/g, '\n                        ')}${extra}${m.intent ? `   {${m.intent}}` : ''}`);
    // the AI cost / lookups of the bot reply right after the customer's message(s)
    if (m.direction === 'outbound' && m.source === 'sales_bot' && usage[u] && new Date(usage[u].created_at) <= new Date(m.created_at.getTime() + 60_000)) {
      const row = usage[u++];
      const rs = Number(row.cost_usd) * USD_LKR;
      totalRs += rs;
      replies++;
      console.log(`                        ↳ ${row.model} · ${row.calls} call(s) · Rs ${rs.toFixed(2)} · ${(Number(row.latency_ms) / 1000).toFixed(1)} s${row.tools_used ? ` · ${row.tools_used}` : ''}`);
    }
  }
  const { rows: orders } = await db.query(
    `SELECT o.id, o.status, o.total_amount, o.created_at, string_agg(i.quantity || ' x ' || i.product_name || COALESCE(' (' || i.variant_text || ')', ''), '; ') AS items
       FROM bot_order o LEFT JOIN bot_order_item i ON i.order_id = o.id
      WHERE o.bot_channel_user_id = $1 AND o.created_at > NOW() - ($2 || ' hours')::interval GROUP BY o.id ORDER BY o.id`, [chat.bot_channel_user_id, String(Number(hours) + 24)]);
  for (const o of orders) console.log(`ORDER #${o.id} · ${o.status} · Rs ${Number(o.total_amount)} · ${o.items}`);
}
console.log(`\n${chats.length} chats · ${replies} AI replies · Rs ${totalRs.toFixed(2)} AI cost (Rs ${(replies ? totalRs / replies : 0).toFixed(2)} per reply)`);
await db.end();
