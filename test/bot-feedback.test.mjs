/**
 * Owner 👍 / 👎 on AI replies, and the bot's chat memory. Run against a running API + TEST database:
 *   node --test test/bot-feedback.test.mjs
 * Optional (bot round trip): run the API with the contract bot and set BOT_CAPTURE_DIR to its CAPTURE_DIR.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { api, closeDb, createAgent, createWorkspace, sql } from './helpers.mjs';

let A; let B; let agent; let conversationId; let ids;

async function chat(owner, rows) {
  const [user] = await sql(`INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name)
    VALUES ($1, 'whatsapp', $2, 'Nimal') RETURNING id`, [owner.companyId, `9477${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 9)}`]);
  const [conv] = await sql(`INSERT INTO bot_conversation (bot_channel_user_id, status, last_message_at) VALUES ($1, 'open', NOW()) RETURNING id`, [user.id]);
  const out = [];
  for (const [direction, source, content] of rows) {
    const [m] = await sql(`INSERT INTO bot_message (conversation_id, direction, message_type, platform, content, source)
      VALUES ($1, $2, 'text', 'whatsapp', $3, $4) RETURNING id`, [conv.id, direction, content, source]);
    out.push(m.id);
  }
  return { conversationId: conv.id, channelUserId: user.id, ids: out };
}

const rate = (owner, id, body, conv = conversationId) =>
  api('POST', `/bot/conversations/${conv}/messages/${id}/feedback`, { token: owner.token, body });

before(async () => {
  A = await createWorkspace('fb-a');
  B = await createWorkspace('fb-b');
  agent = await createAgent(A, 'fb-agent');
  ({ conversationId, ids } = await chat(A, [
    ['inbound', 'customer', 'Colombo ta delivery kiyada?'],
    ['inbound', 'customer', 'COD puluwanda?'],
    ['outbound', 'sales_bot', 'Colombo ta Rs 350, dawas 1-2.'],
    ['outbound', 'sales_bot', 'Ow, COD puluwan.'],
    ['inbound', 'customer', 'hari'],
    ['outbound', 'agent', 'Thank you!'],
  ]));
});

after(closeDb);

describe('Owner feedback on AI replies', () => {
  test('👍 saves the whole reply (both parts) as a style example for the questions it answered', async () => {
    const r = await rate(A, ids[3], { rating: 'up' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const [row] = await sql(`SELECT category, question, answer FROM bot_training_data WHERE id = $1`, [r.data.training_id]);
    assert.equal(row.category, 'style');
    assert.equal(row.question, 'Colombo ta delivery kiyada?\nCOD puluwanda?');
    assert.equal(row.answer, 'Colombo ta Rs 350, dawas 1-2.\n\nOw, COD puluwan.');
    const detail = await api('GET', `/bot/conversations/${conversationId}`, { token: A.token });
    const messages = detail.data.messages ?? detail.data.conversation?.messages ?? [];
    const shown = messages.find((m) => m.id === ids[3]);
    assert.equal(shown.feedback, 'up');
    assert.equal(shown.source, 'sales_bot');
  });

  test('👎 with a better reply replaces the 👍 example', async () => {
    const before = await sql(`SELECT feedback_training_id FROM bot_message WHERE id = $1`, [ids[3]]);
    const r = await rate(A, ids[3], { rating: 'down', better_reply: 'Colombo ta Rs 350i, dawas 1-2. COD puluwan 😊' });
    assert.equal(r.status, 201);
    assert.equal((await sql(`SELECT id FROM bot_training_data WHERE id = $1`, [before[0].feedback_training_id])).length, 0, 'old example removed');
    const [row] = await sql(`SELECT category, answer FROM bot_training_data WHERE id = $1`, [r.data.training_id]);
    assert.deepEqual(row, { category: 'style', answer: 'Colombo ta Rs 350i, dawas 1-2. COD puluwan 😊' });
  });

  test('👎 alone keeps it as a wrong reply; removing the feedback removes it', async () => {
    const r = await rate(A, ids[2], { rating: 'down' });
    assert.equal(r.status, 201);
    const [row] = await sql(`SELECT category, answer FROM bot_training_data WHERE id = $1`, [r.data.training_id]);
    assert.equal(row.category, 'avoid');
    assert.equal(row.answer, 'Colombo ta Rs 350, dawas 1-2.\n\nOw, COD puluwan.');
    const off = await rate(A, ids[2], { rating: 'none' });
    assert.equal(off.status, 201);
    assert.equal(off.data.feedback, null);
    assert.equal((await sql(`SELECT id FROM bot_training_data WHERE id = $1`, [r.data.training_id])).length, 0);
  });

  test('only AI replies can be rated', async () => {
    assert.equal((await rate(A, ids[0], { rating: 'up' })).status, 400, 'customer message');
    assert.equal((await rate(A, ids[5], { rating: 'up' })).status, 400, 'agent message');
    assert.equal((await rate(A, ids[2], { rating: 'great' })).status, 400, 'bad rating');
  });

  test('other companies and agents cannot rate', async () => {
    assert.ok([403, 404].includes((await rate(B, ids[2], { rating: 'up' })).status), 'other company');
    assert.equal((await rate(agent, ids[2], { rating: 'up' })).status, 403, 'agent (admin only)');
    const other = await chat(B, [['inbound', 'customer', 'hi'], ['outbound', 'sales_bot', 'Hello!']]);
    assert.ok([400, 404].includes((await rate(A, other.ids[1], { rating: 'up' })).status), 'message of another chat');
  });

  test('the bot gets 👎 replies as "avoid" and keeps its chat memory (needs the contract bot)', { skip: !process.env.BOT_CAPTURE_DIR }, async () => {
    await rate(A, ids[2], { rating: 'down' });
    await api('PATCH', '/bot/sales-bot/settings', { token: A.token, body: { bot_enabled: true, auto_enable_new_customers: true } });
    const phone = `9475${String(Date.now()).slice(-7)}`;
    const send = async (text) => {
      const fd = new FormData(); fd.append('phone', phone); fd.append('name', 'Nimal'); fd.append('text', text);
      const sim = await api('POST', '/bot/sales-bot/simulate', { token: A.token, form: fd });
      assert.equal(sim.status, 201, JSON.stringify(sim.json));
      await new Promise((r) => setTimeout(r, 5000));
      const dir = process.env.BOT_CAPTURE_DIR;
      const files = readdirSync(dir).filter((f) => f.startsWith('request_')).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
      return JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    };
    const first = await send('Colombo ta delivery kiyada mallie');
    assert.ok(first.context.avoid.some((r) => r.answer.includes('Colombo ta Rs 350')), 'avoid list sent');
    const [user] = await sql(`SELECT session_state FROM bot_channel_user WHERE company_id = $1 AND external_user_id = $2`, [A.companyId, phone]);
    assert.equal(JSON.parse(user.session_state).sales_bot.memory, 'Name Nimal. Wants red shoes size 2k.');
    const second = await send('size eka 42 da?');
    assert.equal(second.session.memory, 'Name Nimal. Wants red shoes size 2k.', 'memory sent back to the bot');
  });
});
