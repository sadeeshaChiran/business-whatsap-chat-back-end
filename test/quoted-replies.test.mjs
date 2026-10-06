/**
 * Quoted replies – run against a running API + TEST database:
 *   node --test test/quoted-replies.test.mjs
 * Optional (AI check): run the API with the contract bot and set BOT_CAPTURE_DIR to its CAPTURE_DIR.
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { RUN, api, closeDb, createWorkspace, sql } from './helpers.mjs';

const PHONE_ID = `pn-q-${RUN}`;
const CUSTOMER = `9477${String(Date.now()).slice(-7)}`;
let A; let B; let conversationId; let botMessageId;
const QUOTE = 'Soft Stacking Blocks eka (Rs 1,990) nathnam Teething Toy (Rs 690) + Baby Lotion (Rs 890) + Wipes (Rs 390) set ekak';

async function inbound(text, extra = {}) {
  const id = `wamid.${RUN}.${randomBytes(6).toString('hex')}`;
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '94110000000', phone_number_id: PHONE_ID },
    contacts: [{ profile: { name: 'Nimal' }, wa_id: CUSTOMER }],
    messages: [{ from: CUSTOMER, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...extra }],
  } }] }] });
  const secret = process.env.META_APP_SECRET || '';
  const headers = secret ? { 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } : {};
  const response = await api('POST', '/integrations/whatsapp/webhook/meta', { body, headers });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return id;
}

before(async () => {
  A = await createWorkspace('q-a');
  B = await createWorkspace('q-b');
  await api('PATCH', `/company/${A.companyId}`, { token: A.token, body: { whatsapp_provider_type: 'meta', meta_phone_number_id: PHONE_ID, meta_access_token: 'test-token', meta_waba_id: 'waba-q' } });
  await inbound('Hi');
  const [conv] = await sql(`SELECT c.id FROM bot_conversation c JOIN bot_channel_user u ON u.id = c.bot_channel_user_id WHERE u.company_id = $1 AND u.external_user_id = $2`, [A.companyId, CUSTOMER]);
  conversationId = conv.id;
  // an earlier bot message the customer will quote
  const [row] = await sql(`INSERT INTO bot_message (conversation_id, direction, message_type, platform, content, source, provider_message_id)
    VALUES ($1, 'outbound', 'text', 'whatsapp', $2, 'sales_bot', $3) RETURNING id`, [conversationId, QUOTE, `wamid.bot.${RUN}`]);
  botMessageId = row.id;
});

after(closeDb);

describe('Quoted replies', () => {
  test('a customer reply to an earlier message keeps the quote', async () => {
    const id = await inbound('Mata me pack eka danna', { context: { from: '94110000000', id: `wamid.bot.${RUN}` } });
    const [row] = await sql(`SELECT reply_to_message_id, reply_to_provider_id, reply_to_text FROM bot_message WHERE provider_message_id = $1`, [id]);
    assert.equal(Number(row.reply_to_message_id), Number(botMessageId));
    assert.equal(row.reply_to_provider_id, `wamid.bot.${RUN}`);
    assert.equal(row.reply_to_text, QUOTE);
    // the inbox gets it
    const detail = await api('GET', `/bot/conversations/${conversationId}`, { token: A.token });
    assert.equal(detail.status, 200);
    const messages = detail.data.messages ?? detail.data.conversation?.messages ?? [];
    const shown = messages.find((m) => m.content === 'Mata me pack eka danna');
    assert.ok(shown, 'message listed');
    assert.equal(Number(shown.reply_to_message_id), Number(botMessageId));
    assert.equal(shown.reply_to_text, QUOTE);
  });

  test('a quote of an unknown message is still stored (id only)', async () => {
    const id = await inbound('meka', { context: { id: 'wamid.unknown' } });
    const [row] = await sql(`SELECT reply_to_message_id, reply_to_provider_id FROM bot_message WHERE provider_message_id = $1`, [id]);
    assert.equal(row.reply_to_message_id, null);
    assert.equal(row.reply_to_provider_id, 'wamid.unknown');
  });

  test('agents can only quote messages of the same chat', async () => {
    const other = await api('POST', `/bot/conversations/${conversationId}/messages`, { token: B.token, body: { text: 'hi', reply_to_message_id: botMessageId } });
    assert.ok([403, 404].includes(other.status), `other company → ${other.status}`);
    const [otherMessage] = await sql(`SELECT m.id FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id WHERE c.id <> $1 ORDER BY m.id DESC LIMIT 1`, [conversationId]);
    const wrong = await api('POST', `/bot/conversations/${conversationId}/messages`, { token: A.token, body: { text: 'hi', reply_to_message_id: otherMessage.id } });
    assert.equal(wrong.status, 400);
  });

  test('the AI sees what the customer quoted (needs the contract bot)', { skip: !process.env.BOT_CAPTURE_DIR }, async () => {
    await api('PATCH', '/bot/sales-bot/settings', { token: A.token, body: { bot_enabled: true, auto_enable_new_customers: true } });
    await sql(`UPDATE bot_channel_user SET bot_enabled = TRUE, manual_mode = FALSE WHERE company_id = $1`, [A.companyId]);
    await sql(`UPDATE bot_conversation SET status = 'open' WHERE id = $1`, [conversationId]);
    await inbound('Na me set eka danna', { context: { id: `wamid.bot.${RUN}` } });
    await new Promise((r) => setTimeout(r, 4500));
    const dir = process.env.BOT_CAPTURE_DIR;
    const files = readdirSync(dir).filter((f) => f.startsWith('request_')).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    const request = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    assert.ok(request.message.includes(`[replying to: "${QUOTE}"] Na me set eka danna`), request.message);
  });
});
