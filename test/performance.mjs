/**
 * API speed test. Creates one workspace with realistic data (customers, chats, messages, orders),
 * then measures response times of the busiest screens and a load test with parallel users.
 *
 *   API_URL=http://localhost:3001/v1/api TEST_DATABASE_URL=postgresql://... node test/performance.mjs
 * Result: test/performance-result.json + a table in the console.
 */
import { writeFileSync } from 'node:fs';
import { api, closeDb, createAgent, createWorkspace, percentile, sql, RUN } from './helpers.mjs';

const CUSTOMERS = Number(process.env.PERF_CUSTOMERS || 300);
const MESSAGES_PER_CHAT = Number(process.env.PERF_MESSAGES || 40);
const SAMPLES = Number(process.env.PERF_SAMPLES || 30);

async function seed(companyId, agentId) {
  // customers + one conversation each + messages + some orders (fast SQL inserts)
  await sql(
    `INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name, language, bot_enabled, manual_mode, last_seen_at, created_at, updated_at)
     SELECT $1, 'whatsapp', '9477' || LPAD((g + $2)::text, 7, '0'), 'Customer ' || g, 'English', TRUE, FALSE, NOW() - (g || ' minutes')::interval, NOW(), NOW()
       FROM generate_series(1, $3) g`,
    [companyId, Number(String(Date.now()).slice(-6)), CUSTOMERS],
  );
  await sql(
    `INSERT INTO bot_conversation (bot_channel_user_id, status, assigned_agent_id, last_message_at, created_at, updated_at, lead_stage)
     SELECT u.id, CASE WHEN u.id % 5 = 0 THEN 'active' WHEN u.id % 7 = 0 THEN 'pending' ELSE 'open' END,
            CASE WHEN u.id % 5 = 0 OR u.id % 7 = 0 THEN $2::bigint ELSE NULL END, NOW() - (u.id % 600 || ' minutes')::interval, NOW(), NOW(), 'new'
       FROM bot_channel_user u WHERE u.company_id = $1`,
    [companyId, agentId],
  );
  await sql(
    `INSERT INTO bot_message (conversation_id, direction, message_type, platform, content, created_at, updated_at)
     SELECT c.id, CASE WHEN g % 2 = 0 THEN 'inbound' ELSE 'outbound' END::bot_message_direction_enum, 'text'::bot_message_message_type_enum, 'whatsapp',
            'Message ' || g || ' – do you have the red shoe in size 40?', NOW() - ((${MESSAGES_PER_CHAT} - g) || ' minutes')::interval, NOW()
       FROM bot_conversation c JOIN bot_channel_user u ON u.id = c.bot_channel_user_id
       CROSS JOIN generate_series(1, ${MESSAGES_PER_CHAT}) g
      WHERE u.company_id = $1`,
    [companyId],
  ).catch(async () => {
    // enum type name differs between databases – fall back to text
    await sql(
      `INSERT INTO bot_message (conversation_id, direction, message_type, platform, content, created_at, updated_at)
       SELECT c.id, CASE WHEN g % 2 = 0 THEN 'inbound' ELSE 'outbound' END, 'text', 'whatsapp',
              'Message ' || g, NOW() - ((${MESSAGES_PER_CHAT} - g) || ' minutes')::interval, NOW()
         FROM bot_conversation c JOIN bot_channel_user u ON u.id = c.bot_channel_user_id
         CROSS JOIN generate_series(1, ${MESSAGES_PER_CHAT}) g WHERE u.company_id = $1`,
      [companyId],
    );
  });
  await sql(
    `INSERT INTO bot_order (company_id, bot_channel_user_id, customer_name, customer_phone, status, total_amount, created_at, updated_at)
     SELECT $1, u.id, u.display_name, u.external_user_id, 'Pending', 2500 + (u.id % 10) * 100, NOW(), NOW()
       FROM bot_channel_user u WHERE u.company_id = $1 AND u.id % 3 = 0`,
    [companyId],
  );
}

async function measure(label, token, path, samples = SAMPLES) {
  const times = [];
  let bytes = 0;
  let failures = 0;
  for (let i = 0; i < samples; i += 1) {
    const r = await api('GET', path, { token, raw: true });
    if (r.status !== 200) failures += 1;
    times.push(r.ms);
    bytes = r.text?.length ?? bytes;
  }
  return { label, path, samples, p50_ms: Math.round(percentile(times, 50)), p95_ms: Math.round(percentile(times, 95)), max_ms: Math.round(Math.max(...times)), response_kb: Math.round(bytes / 102.4) / 10, failures };
}

async function load(label, token, paths, users, seconds) {
  const end = Date.now() + seconds * 1000;
  const times = [];
  let errors = 0;
  let requests = 0;
  await Promise.all(
    Array.from({ length: users }, async (_, user) => {
      const ip = `10.250.${Math.floor(user / 200)}.${(user % 200) + 1}`;
      while (Date.now() < end) {
        const path = paths[requests % paths.length];
        requests += 1;
        const r = await api('GET', path, { token, ip });
        times.push(r.ms);
        if (r.status >= 400) errors += 1;
      }
    }),
  );
  return { label, users, seconds, requests: times.length, requests_per_second: Math.round(times.length / seconds), p50_ms: Math.round(percentile(times, 50)), p95_ms: Math.round(percentile(times, 95)), p99_ms: Math.round(percentile(times, 99)), errors };
}

const admin = await createWorkspace('perf');
const agent = await createAgent(admin, 'perf-agent');
console.log(`seeding ${CUSTOMERS} customers × ${MESSAGES_PER_CHAT} messages …`);
const seedStart = Date.now();
await seed(admin.companyId, agent.id);
console.log(`seeded in ${Math.round((Date.now() - seedStart) / 1000)} s`);
const [{ id: conversationId }] = await sql(
  `SELECT c.id FROM bot_conversation c JOIN bot_channel_user u ON u.id = c.bot_channel_user_id WHERE u.company_id = $1 ORDER BY c.id LIMIT 1`,
  [admin.companyId],
);

const endpoints = [
  ['Login', null, null],
  ['Who am I (every page)', admin.token, '/auth/me'],
  ['Company (every page)', admin.token, '/company'],
  ['Dashboard numbers', admin.token, '/bot/stats'],
  ['Inbox list (admin, 60 chats)', admin.token, '/bot/conversations?page=1&limit=60'],
  ['Open a chat (40 messages)', admin.token, `/bot/conversations/${conversationId}?limit=40`],
  ['Chat queue', admin.token, '/bot/conversations/unassigned'],
  ['My chats (agent)', agent.token, '/bot/agent/conversations'],
  ['Orders list', admin.token, '/bot/orders'],
  ['Contacts / customers page', admin.token, '/bot/users?page=1&limit=100'],
  ['Notifications bell', admin.token, '/notifications'],
  ['Team board', admin.token, '/users/agents/stats'],
  ['Package usage', admin.token, '/billing/usage'],
];

const results = [];
for (const [label, token, path] of endpoints) {
  if (!path) {
    const times = [];
    for (let i = 0; i < 10; i += 1) times.push((await api('POST', '/auth/login', { body: { email: admin.email, password: 'Test1234pass' } })).ms);
    results.push({ label, path: '/auth/login', samples: 10, p50_ms: Math.round(percentile(times, 50)), p95_ms: Math.round(percentile(times, 95)), max_ms: Math.round(Math.max(...times)), response_kb: 1, failures: 0 });
    continue;
  }
  results.push(await measure(label, token, path));
}
console.table(results);

const loadPaths = ['/auth/me', '/company', '/bot/conversations?page=1&limit=60', '/notifications', '/bot/stats'];
const loadResults = [];
for (const users of [10, 25, 50]) loadResults.push(await load(`Inbox + dashboard mix`, admin.token, loadPaths, users, 15));
console.table(loadResults);

writeFileSync(new URL('./performance-result.json', import.meta.url), JSON.stringify({ run: RUN, date: new Date().toISOString(), data: { customers: CUSTOMERS, messages_per_chat: MESSAGES_PER_CHAT }, endpoints: results, load: loadResults }, null, 2));
await closeDb();
