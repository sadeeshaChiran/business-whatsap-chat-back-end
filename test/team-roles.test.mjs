/**
 * Team roles (Oct 2026 fixes) – run against a running API + TEST database:
 *   node --test test/team-roles.test.mjs
 * Customers use 999… simulator numbers, so nothing is sent to WhatsApp.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { RUN, api, closeDb, createAgent, createWorkspace, sendInboundWhatsapp, sql } from './helpers.mjs';

const PHONE_ID = `pn-roles-${RUN}`;
const CUSTOMER = `999${String(Date.now()).slice(-8)}`;
let A; let supervisor; let agent; let other; let conversationId; let channelUserId;

before(async () => {
  A = await createWorkspace('roles');
  await api('PATCH', `/company/${A.companyId}`, { token: A.token, body: { whatsapp_provider_type: 'meta', meta_phone_number_id: PHONE_ID, meta_access_token: 'test-token', meta_waba_id: 'waba-r' } });
  supervisor = await createAgent(A, 'roles-sup', { teamRole: 'supervisor' });
  agent = await createAgent(A, 'roles-agent');
  other = await createAgent(A, 'roles-other');
  assert.equal((await sendInboundWhatsapp(PHONE_ID, CUSTOMER, 'Hi, price list?')).status, 200);
  [{ id: conversationId, channel_user_id: channelUserId }] = await sql(
    `SELECT c.id, cu.id AS channel_user_id FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
      WHERE cu.company_id = $1 AND cu.external_user_id = $2 ORDER BY c.id DESC LIMIT 1`, [A.companyId, CUSTOMER]);
  // the chat belongs to "agent", not to the supervisor
  await sql(`UPDATE bot_conversation SET assigned_agent_id = $2, status = 'active' WHERE id = $1`, [conversationId, agent.id]);
});

after(closeDb);

describe('Team roles', () => {
  test('a supervisor can reply in a chat that is not assigned to them', async () => {
    const sent = await api('POST', `/bot/conversations/${conversationId}/messages`, { token: supervisor.token, body: { text: 'Hari, mama balannam' } });
    assert.notEqual(sent.status, 403, JSON.stringify(sent.json));
    assert.ok([200, 201].includes(sent.status), `status ${sent.status}: ${JSON.stringify(sent.json)}`);
  });

  test('another agent still cannot reply in that chat', async () => {
    const sent = await api('POST', `/bot/conversations/${conversationId}/messages`, { token: other.token, body: { text: 'x' } });
    assert.equal(sent.status, 403);
  });

  test('location and contact cards can be sent from the chat', async () => {
    const location = await api('POST', `/bot/conversations/${conversationId}/messages/location`, { token: agent.token, body: { latitude: 6.9271, longitude: 79.8612, name: 'Shop' } });
    assert.ok([200, 201].includes(location.status), `location: ${location.status} ${JSON.stringify(location.json)}`);
    const contact = await api('POST', `/bot/conversations/${conversationId}/messages/contact`, { token: agent.token, body: { name: 'Delivery', phone: '+94771234567' } });
    assert.ok([200, 201].includes(contact.status), `contact: ${contact.status} ${JSON.stringify(contact.json)}`);
    assert.equal((await api('POST', `/bot/conversations/${conversationId}/messages/location`, { token: other.token, body: { latitude: 1, longitude: 1 } })).status, 403);
  });

  test('an agent sends only their own notes to the customer', async () => {
    const [ownerNote] = await sql(`INSERT INTO bot_customer_note (company_id, bot_channel_user_id, content, created_by_user_id) VALUES ($1, $2, 'Owner internal note', $3) RETURNING id`,
      [A.companyId, channelUserId, A.user.id]);
    const refused = await api('POST', `/bot/notes/${ownerNote.id}/send`, { token: agent.token });
    assert.ok([403, 404].includes(refused.status), `agent sending owner's note: ${refused.status}`);
  });

  test('an agent who goes offline does not keep a waiting customer', async () => {
    // the customer wrote last and the agent is offline -> the chat is in the queue for the team
    await sql(`UPDATE app_user SET is_agent_active = FALSE WHERE id = $1`, [agent.id]);
    await sendInboundWhatsapp(PHONE_ID, CUSTOMER, 'hello? anyone there');
    const queue = await api('GET', '/bot/conversations/unassigned', { token: A.token });
    assert.equal(queue.status, 200, JSON.stringify(queue.json));
    const list = Array.isArray(queue.data) ? queue.data : queue.data?.conversations ?? queue.data?.results ?? [];
    assert.ok(list.some((row) => Number(row.id ?? row.conversation_id ?? row.conversation?.id) === Number(conversationId)), 'waiting chat listed in the queue');
  });
});
