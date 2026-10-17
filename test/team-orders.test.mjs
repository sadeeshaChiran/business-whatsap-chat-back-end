import test from 'node:test';
import assert from 'node:assert/strict';
import { API, api, createAgent, createWorkspace, sql, closeDb, freshIp } from './helpers.mjs';

/**
 * October 17 batch: SMS sign-up codes, supervisor (team lead) role, agents change only their own orders,
 * the activity log, automatic accept, the manual pipeline stage, product photos as files with full links,
 * optional weight + own SKU, and the import sample file.
 * The simulator part needs the fake bot (salesbot tests/contract_server.py).
 */
test.after(closeDb);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let owner; let agent; let supervisor;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('sign-up sends the mobile code by SMS (no WhatsApp needed)', async () => {
  const phone = `9477${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const start = await api('POST', '/auth/register/start', {
    body: { name: 'Sms Owner', email: `sms-${Date.now()}@test.agentmetra.lk`, password: 'Test1234pass', phone, company: { name: `Sms Store ${Date.now()}`, category: 'product' } },
  });
  assert.equal(start.status, 201, start.text);
  assert.ok(start.data.dev_codes.phone, 'a phone code is issued');
  assert.equal(start.data.phone.replace(/\D/g, '').slice(-9), phone.slice(-9));
  const wrong = await api('POST', '/auth/register/verify', { body: { registration_id: start.data.registration_id, email_code: start.data.dev_codes.email, phone_code: '000000' } });
  assert.notEqual(wrong.status, 201);
});

test('setup: owner, an agent and a supervisor', async () => {
  owner = await createWorkspace('teamorders');
  await sql(`UPDATE companies SET bot_enabled = true, plan = 'growth' WHERE id = $1`, [owner.companyId]);
  agent = await createAgent(owner, 'toAgent');
  supervisor = await createAgent(owner, 'toSuper', { teamRole: 'supervisor' });
  assert.equal(supervisor.user.role, 'supervisor');
  assert.equal(agent.user.role, 'agent');
  const team = await api('GET', '/users/agents', { token: owner.token });
  assert.equal(team.data.find((m) => m.id === supervisor.id).team_role, 'supervisor');
});

test('supervisor: whole team work yes, settings / billing / channels no', async () => {
  for (const path of ['/bot/orders', '/bot/dashboard', '/bot/team/performance', '/users/agents', '/crm/contacts', '/activity-log', '/bot/conversations']) {
    const r = await api('GET', path, { token: supervisor.token });
    assert.equal(r.status, 200, `${path}: ${r.status} ${r.text ?? JSON.stringify(r.json)}`);
  }
  const settings = await api('PATCH', '/bot/sales-bot/settings', { token: supervisor.token, body: { tone: 'friendly' } });
  assert.equal(settings.status, 403);
  const company = await api('PATCH', `/company/${owner.companyId}`, { token: supervisor.token, body: { name: 'Hacked' } });
  assert.equal(company.status, 403);
  const addAgent = await api('POST', '/users/agents', { token: supervisor.token, body: { name: 'X', email: `x-${Date.now()}@t.lk`, password: 'Test1234pass' } });
  assert.equal(addAgent.status, 403);
  // agents do not see the log
  assert.equal((await api('GET', '/activity-log', { token: agent.token })).status, 403);
});

test('agents change only their own orders; every change and delete is in the activity log', async () => {
  const [customer] = await sql(`INSERT INTO bot_channel_user (company_id, external_user_id, display_name, platform) VALUES ($1, $2, 'Kasun', 'whatsapp') RETURNING id`,
    [owner.companyId, `9471${String(Date.now()).slice(-7)}`]);
  const [mine] = await sql(`INSERT INTO bot_order (company_id, bot_channel_user_id, customer_name, status, total_amount, created_by, agent_id) VALUES ($1, $2, 'Kasun', 'Pending', 3000, 'agent', $3) RETURNING id`,
    [owner.companyId, customer.id, agent.id]);
  const [other] = await sql(`INSERT INTO bot_order (company_id, bot_channel_user_id, customer_name, status, total_amount, created_by) VALUES ($1, $2, 'Kasun', 'Pending', 4500, 'bot') RETURNING id`,
    [owner.companyId, customer.id]);

  assert.equal((await api('DELETE', `/bot/orders/${other.id}`, { token: agent.token })).status, 403);
  assert.equal((await api('POST', `/bot/orders/${other.id}/update`, { token: agent.token, body: { address: 'x' } })).status, 403);

  const edit = await api('POST', `/bot/orders/${mine.id}/update`, { token: agent.token, body: { address: '12 Lake Road, Kandy' } });
  assert.equal(edit.status, 201, edit.text);
  const status = await api('POST', `/bot/orders/${mine.id}/status`, { token: agent.token, body: { status: 'Confirmed' } });
  assert.equal(status.status, 201, status.text);
  const del = await api('DELETE', `/bot/orders/${mine.id}`, { token: agent.token });
  assert.equal(del.status, 200, del.text);
  // a supervisor may change any order
  assert.equal((await api('POST', `/bot/orders/${other.id}/update`, { token: supervisor.token, body: { customer_name: 'Kasun P' } })).status, 201);

  const log = await api('GET', '/activity-log', { token: owner.token });
  assert.equal(log.status, 200);
  const actions = log.data.items.map((row) => `${row.action}:${row.entity_id}:${row.user_role}`);
  assert.ok(actions.includes(`order_edit:${mine.id}:agent`), actions.join(' '));
  assert.ok(actions.includes(`order_status:${mine.id}:agent`));
  assert.ok(actions.includes(`order_delete:${mine.id}:agent`));
  assert.ok(actions.includes(`order_edit:${other.id}:supervisor`));
  const deleted = log.data.items.find((row) => row.action === 'order_delete');
  assert.equal(Number(deleted.details.total), 3000);
  assert.match(deleted.summary, /deleted/);
});

test('new chats are accepted automatically (setting on by default); the agent picks the pipeline stage by hand', async () => {
  const [company] = await sql('SELECT agent_auto_accept FROM companies WHERE id = $1', [owner.companyId]);
  assert.equal(company.agent_auto_accept, true);
  await api('POST', '/bot/agent/status/toggle', { token: agent.token });
  const phone = `99988${String(Date.now()).slice(-7)}`;
  const sent = await api('POST', '/bot/sales-bot/simulate', { token: owner.token, body: { phone, name: 'Nimal', text: 'hi' } });
  assert.equal(sent.status, 201, sent.text);
  const conversationId = sent.data.conversation_id;
  let conv;
  for (let i = 0; i < 20; i++) {
    [conv] = await sql('SELECT assigned_agent_id, status, accepted_at FROM bot_conversation WHERE id = $1', [conversationId]);
    if (conv?.assigned_agent_id) break;
    await wait(500);
  }
  assert.equal(Number(conv.assigned_agent_id), agent.id);
  assert.equal(conv.status, 'active', 'accepted automatically');
  assert.ok(conv.accepted_at);

  const stage = await api('PATCH', `/bot/conversations/${conversationId}/lead-stage`, { token: agent.token, body: { lead_stage: 'lost' } });
  assert.equal(stage.status, 200, stage.text);
  const [row] = await sql('SELECT lead_stage, lead_stage_manual FROM bot_conversation WHERE id = $1', [conversationId]);
  assert.deepEqual([row.lead_stage, row.lead_stage_manual], ['lost', true]);

  const otherAgent = await createAgent(owner, 'toAgent2');
  assert.equal((await api('PATCH', `/bot/conversations/${conversationId}/lead-stage`, { token: otherAgent.token, body: { lead_stage: 'won' } })).status, 403);

  // the owner can switch automatic accept off
  const off = await api('PATCH', `/company/${owner.companyId}`, { token: owner.token, body: { agent_auto_accept: false } });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.data.agent_auto_accept, false);
});

test('product photos are files with a short full link; weight is optional; own SKU', async () => {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'photo.png');
  const up = await api('POST', '/products/images', { token: owner.token, form });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  assert.match(up.data.url, /\/public\/product-images\/\d+-[a-z0-9]{8,16}\.png$/);
  assert.ok(up.data.url.length < 120, 'short link');
  const name = up.data.url.split('/').pop();
  const photo = await fetch(`${API}/public/product-images/${name}`, { headers: { 'X-Forwarded-For': freshIp() } });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/png');

  const fake = new FormData();
  fake.append('file', new Blob([Buffer.from('MZ not an image at all')], { type: 'image/png' }), 'evil.png');
  assert.equal((await api('POST', '/products/images', { token: owner.token, form: fake })).status, 400);
  assert.equal((await fetch(`${API}/public/product-images/..%2F..%2Fetc%2Fpasswd`)).status, 404);

  const cat = await api('POST', '/product-catergory', { token: owner.token, body: { name: `Kids ${Date.now()}` } });
  const sku = `ROMP-${Date.now().toString(36).toUpperCase()}`;
  const product = await api('POST', '/products', {
    token: owner.token,
    body: { name: 'Cotton Romper Set (3 pcs)', price: 2500, quantity: 5, category_id: cat.data.id, sku, image_url: up.data.url, gallery: [up.data.url] },
  });
  assert.equal(product.status, 201, product.text ?? JSON.stringify(product.json));
  assert.equal(product.data.sku, sku);
  assert.equal(product.data.weight ?? null, null);
  assert.equal(product.data.image_url, up.data.url);
  const dup = await api('POST', '/products', { token: owner.token, body: { name: 'Other', price: 100, quantity: 1, category_id: cat.data.id, sku } });
  assert.ok([400, 409].includes(dup.status), `duplicate SKU refused (${dup.status})`);

  // an old-style inline photo is stored as a file
  const inline = await api('POST', '/products', {
    token: owner.token,
    body: { name: 'Inline photo', price: 100, quantity: 1, category_id: cat.data.id, image_url: `data:image/png;base64,${PNG.toString('base64')}` },
  });
  assert.equal(inline.status, 201);
  assert.match(inline.data.image_url, /\/public\/product-images\//);
});

test('import sample file downloads (owner only)', async () => {
  const response = await fetch(`${API}/products/import/template`, { headers: { Authorization: `Bearer ${owner.token}`, 'X-Forwarded-For': freshIp() } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /spreadsheetml/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  assert.equal((await api('GET', '/products/import/template', { token: agent.token })).status, 403);
});
