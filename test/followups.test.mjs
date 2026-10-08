/**
 * Follow-ups of interested customers who went quiet. Needs the contract bot and the API started with
 *   SALES_BOT_TEST_MODE=true SALES_BOT_FOLLOWUP_TICK_MS=1500 SALES_BOT_FOLLOWUP_ANY_TIME=true
 *   BOT_CAPTURE_DIR=<contract bot CAPTURE_DIR> node --test test/followups.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { api, closeDb, createAgent, createWorkspace, sql } from './helpers.mjs';

const ready = Boolean(process.env.BOT_CAPTURE_DIR);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let A; let agent; let conversationId; let channelUserId;
const phone = `9476${String(Date.now()).slice(-7)}`;

async function say(text) {
  const fd = new FormData(); fd.append('phone', phone); fd.append('name', 'Nimal'); fd.append('text', text);
  const sim = await api('POST', '/bot/sales-bot/simulate', { token: A.token, form: fd });
  assert.equal(sim.status, 201, JSON.stringify(sim.json));
  conversationId = sim.data.conversation_id;
  await wait(7000);
}
const conv = async () => (await sql(`SELECT * FROM bot_conversation WHERE id = $1`, [conversationId]))[0];
const due = () => sql(`UPDATE bot_conversation SET followup_due_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [conversationId]);
const botTexts = async () => sql(`SELECT content, intent FROM bot_message WHERE conversation_id = $1 AND direction::text = 'outbound' ORDER BY id`, [conversationId]);

before(async () => {
  if (!ready) return;
  A = await createWorkspace('fu');
  agent = await createAgent(A, 'fu-agent');
  const cat = await api('POST', '/product-catergory', { token: A.token, body: { name: `Shoes ${Date.now()}` } });
  const product = await api('POST', '/products', { token: A.token, body: { name: 'Red shoe', price: 2500, quantity: 5, category_id: cat.data.id, weight: 0.6 } });
  assert.equal(product.status, 201, JSON.stringify(product.json));
  await api('PATCH', '/bot/sales-bot/settings', { token: A.token, body: { bot_enabled: true, auto_enable_new_customers: true } });
});
after(closeDb);

describe('Follow-ups', { skip: !ready }, () => {
  test('settings: on by default, 3 h and 22 h; can be changed', async () => {
    const s = await api('GET', '/bot/sales-bot/settings', { token: A.token });
    assert.equal(s.data.followup_enabled, true);
    assert.equal(s.data.followup_first_hours, 3);
    assert.equal(s.data.followup_second_hours, 22);
    const bad = await api('PATCH', '/bot/sales-bot/settings', { token: A.token, body: { followup_second_hours: 30 } });
    assert.equal(bad.status, 400, 'never after the 24-hour window');
    const ok = await api('PATCH', '/bot/sales-bot/settings', { token: A.token, body: { followup_first_hours: 2 } });
    assert.equal(ok.data.followup_first_hours, 2);
  });

  test('an interested customer who goes quiet gets a follow-up planned', async () => {
    await say('red shoe size 40 2k ona');
    const c = await conv();
    channelUserId = c.bot_channel_user_id;
    assert.equal(c.followup_status, 'waiting');
    assert.equal(c.followup_interest, 'ready');
    assert.equal(c.followup_note, 'Red shoe size 40, 2 pairs - waiting to confirm');
    assert.ok(c.followup_due_at, 'due time set');
    const hours = (new Date(c.followup_due_at) - new Date(c.followup_quiet_since)) / 3_600_000;
    // the customer's message time is read correctly whatever time zone the server / database uses
    assert.ok(Math.abs(Date.now() - new Date(c.followup_quiet_since)) < 60_000, `quiet since ${c.followup_quiet_since}`);
    assert.ok(hours >= 2 - 0.01 && hours <= 23, `planned ${hours} h after the last message`);
    assert.ok(['qualified', 'proposal'].includes(c.lead_stage), c.lead_stage);
    const list = await api('GET', `/bot/conversations/${conversationId}`, { token: A.token });
    const view = list.data.conversation ?? list.data;
    assert.equal(JSON.stringify(list.json).includes('"followup_status":"waiting"'), true, 'inbox gets the follow-up state');
    void view;
  });

  test('follow-up 1 is sent when due; follow-up 2 is planned', async () => {
    const before = (await botTexts()).length;
    await due();
    await wait(5000);
    const texts = await botTexts();
    assert.equal(texts.length, before + 1, JSON.stringify(texts.slice(-2)));
    assert.equal(texts.at(-1).intent, 'followup_1');
    assert.match(texts.at(-1).content, /Order eka danna da\?/);
    const c = await conv();
    assert.equal(c.followup_count, 1);
    assert.ok(c.followup_last_at);
    if (c.followup_status === 'waiting') assert.ok(new Date(c.followup_due_at) - new Date(c.followup_last_at) >= 3_600_000 - 1000, 'at least 1 h later');
    else assert.equal(c.followup_status, 'sent');
    const [usage] = await sql(`SELECT COUNT(*)::int AS n FROM bot_ai_usage WHERE conversation_id = $1`, [conversationId]);
    assert.ok(usage.n >= 2, 'follow-up AI cost is recorded');
  });

  test('nothing is sent when the customer already answered', async () => {
    await sql(`INSERT INTO bot_message (conversation_id, direction, message_type, platform, content, source, provider_message_id)
      VALUES ($1, 'inbound', 'text', 'whatsapp', 'hmm', 'customer', 'sim-x')`, [conversationId]);
    await sql(`UPDATE bot_conversation SET followup_status = 'waiting' WHERE id = $1`, [conversationId]);
    const before = (await botTexts()).length;
    await due();
    await wait(4000);
    assert.equal((await botTexts()).length, before);
  });

  test('a reply starts a new round (count back to 0)', async () => {
    await say('size 40 thiyenawada?');
    const c = await conv();
    assert.equal(c.followup_count, 0);
    assert.equal(c.followup_status, 'waiting');
  });

  test('ordered after going quiet → converted, no message', async () => {
    await sql(`INSERT INTO bot_order (company_id, bot_channel_user_id, customer_name, customer_phone, address, status, total_amount)
      VALUES ($1, $2, 'Nimal', $3, '12 Main St', 'Pending', 5000)`, [A.companyId, channelUserId, phone]);
    const before = (await botTexts()).length;
    await due();
    await wait(4000);
    assert.equal((await botTexts()).length, before);
    assert.equal((await conv()).followup_status, 'converted');
    const stats = await api('GET', '/bot/sales-bot/followups/stats', { token: A.token });
    assert.equal(stats.status, 200);
    assert.ok(stats.data.followed_up >= 1 && stats.data.converted >= 1, JSON.stringify(stats.data));
    assert.ok(stats.data.conversion_rate > 0);
  });

  test('the team can stop and resume follow-ups for a chat', async () => {
    await say('blue one thiyenawada?');
    assert.equal((await conv()).followup_status, 'waiting');
    const stop = await api('POST', `/bot/sales-bot/followups/${conversationId}`, { token: A.token, body: { action: 'stop' } });
    assert.equal(stop.status, 201, JSON.stringify(stop.json));
    assert.equal(stop.data.followup_status, 'off');
    await say('ok size 41?');
    assert.equal((await conv()).followup_status, 'off', 'a new reply keeps it off');
    assert.equal((await conv()).followup_due_at, null);
    const resume = await api('POST', `/bot/sales-bot/followups/${conversationId}`, { token: A.token, body: { action: 'resume' } });
    assert.equal(resume.data.followup_status, 'waiting');
    assert.equal((await api('POST', `/bot/sales-bot/followups/${conversationId}`, { token: agent.token, body: { action: 'stop' } })).status, 403, 'agents cannot');
    const other = await createWorkspace('fu-b');
    assert.equal((await api('POST', `/bot/sales-bot/followups/${conversationId}`, { token: other.token, body: { action: 'stop' } })).status, 404, 'other company');
  });

  test('an agent wrote after the customer → stopped, nothing sent', async () => {
    await api('POST', `/bot/sales-bot/followups/${conversationId}`, { token: A.token, body: { action: 'resume' } });
    await sql(`INSERT INTO bot_message (conversation_id, direction, message_type, platform, content, source)
      VALUES ($1, 'outbound', 'text', 'whatsapp', 'Hi Nimal, this is Saman from the shop', 'agent')`, [conversationId]);
    const before = (await botTexts()).length;
    await due();
    await wait(4000);
    assert.equal((await botTexts()).length, before);
    assert.equal((await conv()).followup_status, 'stopped');
  });

  test('a new customer message cancels the planned follow-up at once', async () => {
    await say('green one thiyenawada?');
    assert.equal((await conv()).followup_status, 'waiting');
    const fd = new FormData(); fd.append('phone', phone); fd.append('name', 'Nimal'); fd.append('text', 'mm');
    await api('POST', '/bot/sales-bot/simulate', { token: A.token, form: fd });
    await wait(300);
    const c = await conv();
    assert.equal(c.followup_due_at, null, 'cancelled before the bot even answers');
    await wait(7000);
  });

  test('switched off in settings → nothing is sent', async () => {
    await say('red one size 42?');
    await api('PATCH', '/bot/sales-bot/settings', { token: A.token, body: { followup_enabled: false } });
    const before = (await botTexts()).length;
    await due();
    await wait(4000);
    assert.equal((await botTexts()).length, before);
    assert.equal((await conv()).followup_status, 'stopped');
  });

  test('the bot got the follow-up instruction', () => {
    const dir = process.env.BOT_CAPTURE_DIR;
    const requests = readdirSync(dir).filter((f) => f.startsWith('request_')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
    const fu = requests.find((r) => r.session?.followup && r.context?.company?.id === A.companyId);
    assert.ok(fu, 'follow-up request captured');
    assert.equal(fu.session.followup.number, 1);
    assert.equal(fu.session.followup.note, 'Red shoe size 40, 2 pairs - waiting to confirm');
    assert.equal(fu.message, '');
  });
});
