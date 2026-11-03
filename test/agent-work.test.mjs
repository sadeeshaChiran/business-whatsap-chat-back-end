import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createAgent, createWorkspace, sql, closeDb } from './helpers.mjs';

/**
 * Agents: accepting a chat sends nothing and keeps the bot helping; the admin reading a chat does not clear the agent's
 * unread count; night bot orders count for the agent who accepts; team orders from the chat (catalog prices, delivery
 * fee, invoice); agents only see their own customers; the admin sees each agent's work.
 * Needs the fake bot (salesbot tests/contract_server.py).
 */
test.after(closeDb);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let owner; let agentA; let agentB; let conversationId; let channelUserId;
const phone = `99977${String(Date.now()).slice(-7)}`;

async function say(text) {
  const sent = await api('POST', '/bot/sales-bot/simulate', { token: owner.token, body: { phone, name: 'Nimal', text } });
  assert.equal(sent.status, 201, sent.text);
  return sent.data.conversation_id;
}
async function outbound() {
  return sql(`SELECT content, source FROM bot_message WHERE conversation_id = $1 AND direction = 'outbound' ORDER BY id`, [conversationId]);
}

test('setup: shop with a product, delivery zone, bot on, one agent online', async () => {
  owner = await createWorkspace('agentwork');
  // this test accepts chats by hand (Settings → Chat routing → automatic accept off)
  await sql('UPDATE companies SET bot_enabled = true, agent_auto_accept = false WHERE id = $1', [owner.companyId]);
  const cat = await api('POST', '/product-catergory', { token: owner.token, body: { name: `Shoes ${Date.now()}` } });
  const product = await api('POST', '/products', { token: owner.token, body: { name: 'Red shoe', price: 2500, quantity: 20, category_id: cat.data.id, weight: 0.6 } });
  assert.equal(product.status, 201, product.text);
  await api('POST', '/bot/delivery-zones', { token: owner.token, body: { area: 'Colombo', fee: 350, included_kg: 1, per_extra_kg: 100 } });
  agentA = await createAgent(owner, 'agentA');
  agentB = await createAgent(owner, 'agentB');
  const online = await api('POST', '/bot/agent/status/toggle', { token: agentA.token });
  assert.equal(online.status, 201, online.text);
});

test('a night bot order counts for the agent who accepts; accepting sends nothing and the bot keeps helping', async () => {
  conversationId = await say('red shoe 2k ona, Colombo');
  await wait(7000);
  const [conv] = await sql('SELECT assigned_agent_id, status, bot_channel_user_id FROM bot_conversation WHERE id = $1', [conversationId]);
  channelUserId = conv.bot_channel_user_id;
  assert.equal(Number(conv.assigned_agent_id), agentA.id);
  assert.equal(conv.status, 'pending');
  // the bot took an order before anyone accepted (like at night)
  await sql(`INSERT INTO bot_order (company_id, bot_channel_user_id, customer_name, status, total_amount, created_by) VALUES ($1, $2, 'Nimal', 'Pending', 5000, 'bot')`, [owner.companyId, channelUserId]);

  const before = (await outbound()).length;
  const accepted = await api('POST', `/bot/conversations/${conversationId}/accept`, { token: agentA.token });
  assert.equal(accepted.status, 201, accepted.text);
  assert.equal((await outbound()).length, before, 'no message to the customer on accept');
  const [order] = await sql('SELECT agent_id FROM bot_order WHERE bot_channel_user_id = $1', [channelUserId]);
  assert.equal(Number(order.agent_id), agentA.id);

  await say('mata size 40 ona');
  await wait(7000);
  const after = await outbound();
  assert.ok(after.length > before && after.at(-1).source === 'sales_bot', 'the bot still replies after accept');
});

test('the admin reading the chat does not clear the agent unread count', async () => {
  await say('hari, kawadda enne?');
  await wait(1500);
  assert.equal((await api('GET', `/bot/conversations/${conversationId}?page=1&limit=30`, { token: owner.token })).status, 200);
  await wait(800);
  const list = await api('GET', '/bot/agent/conversations', { token: agentA.token });
  const mine = (Array.isArray(list.data) ? list.data : list.data?.items ?? []).find((row) => Number(row.id) === conversationId);
  assert.ok(mine, JSON.stringify(list.data).slice(0, 300));
  assert.ok(Number(mine.unread_count) > 0, `agent still sees unread: ${mine.unread_count}`);
});

test('the agent adds an order in the chat: catalog prices, delivery fee by weight, invoice sent', async () => {
  const catalog = await api('GET', '/bot/manual/catalog?search=red', { token: agentA.token });
  assert.equal(catalog.status, 200, catalog.text);
  const product = catalog.data.products[0];
  const quote = await api('POST', '/bot/manual/quote', { token: agentA.token, body: { items: [{ product_id: product.id, quantity: 3 }], delivery_area: 'colombo' } });
  assert.equal(quote.status, 201, quote.text);
  assert.equal(quote.data.subtotal, 7500);
  assert.equal(quote.data.delivery_fee, 450); // 1.8 kg -> 2 kg: Rs 350 + 1 x Rs 100
  const order = await api('POST', `/bot/conversations/${conversationId}/manual-order`, {
    token: agentA.token, body: { items: [{ product_id: product.id, quantity: 3 }], delivery_area: 'Colombo', address: '12 Lake Rd, Colombo', payment_method: 'COD' },
  });
  assert.equal(order.status, 201, order.text);
  assert.equal(order.data.total, 7950);
  assert.equal(order.data.invoice_sent, true);
  const [row] = await sql('SELECT created_by, created_by_user_id, agent_id, delivery_fee FROM bot_order WHERE id = $1', [order.data.order_id]);
  assert.equal(row.created_by, 'agent');
  assert.equal(Number(row.agent_id), agentA.id);
  // agent B (not their customer) cannot
  const other = await api('POST', `/bot/conversations/${conversationId}/manual-order`, { token: agentB.token, body: { items: [{ product_id: product.id, quantity: 1 }] } });
  assert.equal(other.status, 403);
});

test('agents only see their own customers (orders, notes, CRM)', async () => {
  const added = await api('POST', '/bot/notes', { token: agentA.token, body: { bot_channel_user_id: channelUserId, content: 'Prefers evening delivery' } });
  assert.equal(added.status, 201, added.text);
  const notesA = await api('GET', '/bot/notes', { token: agentA.token });
  const notesB = await api('GET', '/bot/notes', { token: agentB.token });
  assert.ok((notesA.data ?? []).some((note) => note.content === 'Prefers evening delivery' && note.author_role === 'agent' && note.assigned_agent?.id === agentA.id),
    JSON.stringify(notesA.data).slice(0, 400));
  assert.equal((notesB.data ?? []).length, 0);
  assert.equal(((await api('GET', '/bot/agent/orders', { token: agentB.token })).data ?? []).length, 0);
  assert.ok(((await api('GET', '/bot/agent/orders', { token: agentA.token })).data ?? []).length >= 2);
  const crmB = await api('GET', '/crm/contacts', { token: agentB.token });
  if (crmB.status === 200) assert.equal(crmB.data.contacts.length, 0);
});

test('the admin sees each agent\'s work', async () => {
  const report = await api('GET', '/bot/team/performance?days=7', { token: owner.token });
  assert.equal(report.status, 200, report.text);
  const a = report.data.agents.find((row) => row.id === agentA.id);
  assert.equal(a.chats.accepted, 1);
  assert.equal(a.orders.count, 2);
  assert.equal(a.orders.by_agent, 1);
  assert.equal(a.orders.by_bot, 1);
  assert.ok(a.replies.bot_helped >= 1);
  assert.equal((await api('GET', '/bot/team/performance', { token: agentA.token })).status, 403);
});

test('an agent hands an accepted chat back; the admin can move any chat', async () => {
  await api('POST', '/bot/agent/status/toggle', { token: agentB.token });
  const back = await api('POST', `/bot/conversations/${conversationId}/reject`, { token: agentA.token });
  assert.equal(back.status, 201, back.text);
  assert.equal(back.data.assigned_agent_id, agentB.id);
  const move = await api('POST', `/bot/conversations/${conversationId}/assign`, { token: owner.token, body: { agent_id: agentA.id } });
  assert.ok([200, 201].includes(move.status), move.text);
});
