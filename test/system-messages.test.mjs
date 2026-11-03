/**
 * System messages (Nov 2026): OTP / verification codes that other companies send to the business WhatsApp number are
 * kept apart for admins (Inbox → System messages): no agent, not in the inbox, queue or contacts, no AI reply.
 * A real customer who later sends a code stays a normal chat. Admins can move a chat in or out.
 *   node --test test/system-messages.test.mjs   (999… simulator numbers – nothing is sent)
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { RUN, api, closeDb, createAgent, createWorkspace, sendInboundWhatsapp, sql } from './helpers.mjs';

const PHONE_ID = `pn-sys-${RUN}`;
const OTP_SENDER = `999${String(Date.now()).slice(-8)}`;
const CUSTOMER = `998${String(Date.now()).slice(-8)}`;
let A; let agent;
const has = (r, phone) => JSON.stringify(r.json ?? {}).includes(phone);
const lists = async () => ({
  inbox: await api('GET', '/bot/conversations?page=1&limit=100', { token: A.token }),
  queue: await api('GET', '/bot/conversations/unassigned', { token: A.token }),
  contacts: await api('GET', '/bot/conversations', { token: A.token }),
  agent: await api('GET', '/bot/agent/conversations', { token: agent.token }),
});

before(async () => {
  A = await createWorkspace('sysmsg');
  await api('PATCH', `/company/${A.companyId}`, { token: A.token, body: { whatsapp_provider_type: 'meta', meta_phone_number_id: PHONE_ID, meta_access_token: 'test-token', meta_waba_id: 'waba-s' } });
  agent = await createAgent(A, 'sys-agent');
});
after(async () => { await closeDb(); });

test('an OTP from a new sender goes to System messages – nobody else sees it', async () => {
  assert.equal((await sendInboundWhatsapp(PHONE_ID, OTP_SENDER, '482913 is your WhatsApp code. Do not share it.', 'WhatsApp')).status, 200);
  assert.equal((await sendInboundWhatsapp(PHONE_ID, OTP_SENDER, 'Hello from our service', 'WhatsApp')).status, 200); // later messages too
  const [cu] = await sql(`SELECT id, system_kind FROM bot_channel_user WHERE company_id = $1 AND external_user_id = $2`, [A.companyId, OTP_SENDER]);
  assert.equal(cu.system_kind, 'system');
  const [c] = await sql(`SELECT assigned_agent_id FROM bot_conversation WHERE bot_channel_user_id = $1`, [cu.id]);
  assert.equal(c.assigned_agent_id, null);
  const l = await lists();
  for (const [name, r] of Object.entries(l)) { assert.equal(r.status, 200, name); assert.equal(has(r, OTP_SENDER), false, `${name} shows it`); }

  const sys = await api('GET', '/bot/system-messages', { token: A.token });
  assert.equal(sys.status, 200);
  const row = sys.data.find((x) => x.phone === OTP_SENDER);
  assert.ok(row);
  assert.equal(row.messages, 2);
  const msgs = await api('GET', `/bot/system-messages/${row.channel_user_id}`, { token: A.token });
  assert.match(msgs.data.messages[0].content, /482913/);
  assert.equal((await api('GET', '/bot/system-messages', { token: agent.token })).status, 403);
  // the AI never answered it
  const [out] = await sql(`SELECT COUNT(*)::int AS n FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id WHERE c.bot_channel_user_id = $1 AND m.direction = 'outbound'`, [cu.id]);
  assert.equal(out.n, 0);
});

test('a real customer who sends a code later stays a normal chat; admins can move chats in and out', async () => {
  await sendInboundWhatsapp(PHONE_ID, CUSTOMER, 'Hi, price of the blue dress?');
  await sendInboundWhatsapp(PHONE_ID, CUSTOMER, 'My OTP is 552190 do not share – is that from you?');
  let [cu] = await sql(`SELECT id, system_kind FROM bot_channel_user WHERE company_id = $1 AND external_user_id = $2`, [A.companyId, CUSTOMER]);
  assert.equal(cu.system_kind, null);
  assert.equal(has(await api('GET', '/bot/conversations?page=1&limit=100', { token: A.token }), CUSTOMER), true);

  const [{ id: conv }] = await sql(`SELECT id FROM bot_conversation WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 1`, [cu.id]);
  assert.equal((await api('PUT', `/bot/conversations/${conv}/system`, { token: agent.token, body: { system: true } })).status, 403);
  assert.equal((await api('PUT', `/bot/conversations/${conv}/system`, { token: A.token, body: { system: true } })).status, 200);
  assert.equal(has(await api('GET', '/bot/conversations?page=1&limit=100', { token: A.token }), CUSTOMER), false);
  assert.ok((await api('GET', '/bot/system-messages', { token: A.token })).data.some((x) => x.phone === CUSTOMER));

  // back: a normal chat again, and new codes from it stay normal
  assert.equal((await api('PUT', `/bot/conversations/${conv}/system`, { token: A.token, body: { system: false } })).status, 200);
  [cu] = await sql(`SELECT system_kind FROM bot_channel_user WHERE id = $1`, [cu.id]);
  assert.equal(cu.system_kind, 'normal');
  await sendInboundWhatsapp(PHONE_ID, CUSTOMER, 'Your verification code is 112233');
  assert.equal(has(await api('GET', '/bot/conversations?page=1&limit=100', { token: A.token }), CUSTOMER), true);
});
