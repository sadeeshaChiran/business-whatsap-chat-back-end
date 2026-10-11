/**
 * CRM (overview, new contact, pipeline, bulk, tasks with priority / delete, agent scope),
 * WhatsApp template builder (create / list / delete through a fake Meta Graph API),
 * Social drafts / edit scheduled posts / saved replies.
 *
 * Run the API with META_GRAPH_BASE_URL=http://127.0.0.1:4599 (the fake Meta server below), then:
 *   node --test test/crm-marketing-social.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { api, closeDb, createAgent, createWorkspace, sql } from './helpers.mjs';

const templates = [];
const requests = [];
const meta = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: url.pathname, body: body ? JSON.parse(body) : null, query: Object.fromEntries(url.searchParams) });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/message_templates')) {
      if (req.method === 'GET') return res.end(JSON.stringify({ data: templates }));
      if (req.method === 'POST') {
        const input = JSON.parse(body);
        if (templates.some((t) => t.name === input.name)) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: { message: 'exists', error_user_msg: 'A template with this name already exists.' } }));
        }
        templates.push({ id: String(templates.length + 1), status: 'PENDING', ...input });
        return res.end(JSON.stringify({ id: String(templates.length), status: 'PENDING', category: input.category }));
      }
      if (req.method === 'DELETE') {
        const index = templates.findIndex((t) => t.name === url.searchParams.get('name'));
        if (index >= 0) templates.splice(index, 1);
        return res.end(JSON.stringify({ success: true }));
      }
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'not faked' } }));
  });
});

let owner; let agent; let other; let contactId;

test.before(async () => {
  await new Promise((resolve) => meta.listen(4599, '127.0.0.1', resolve));
  owner = await createWorkspace('crmx');
  other = await createWorkspace('crmy');
  for (const ws of [owner, other]) await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [ws.companyId]);
  agent = await createAgent(owner, 'crmx-agent');
  await new Promise((r) => setTimeout(r, 31_000)); // the API keeps a company's package 30 s
});
test.after(async () => { meta.close(); await closeDb(); });

test('CRM: add a contact by hand (number in any format), no duplicates', async () => {
  const created = await api('POST', '/crm/contacts', { token: owner.token, body: { name: 'Kamal Perera', phone: '077 123 4567', tags: ['VIP', 'kandy'], deal_value: 25000, lead_stage: 'qualified', note: 'Wants 20 shirts' } });
  assert.equal(created.status, 201, created.text);
  contactId = created.data.profile.id;
  assert.equal(created.data.profile.external_user_id, '94771234567');
  assert.deepEqual(created.data.profile.tags.sort(), ['kandy', 'vip']);
  assert.equal(created.data.profile.lead_stage, 'qualified', 'stage kept without a chat');
  assert.equal(created.data.notes.length, 1);
  const again = await api('POST', '/crm/contacts', { token: owner.token, body: { name: 'Kamal', phone: '94771234567' } });
  assert.equal(again.status, 400);
  const bad = await api('POST', '/crm/contacts', { token: owner.token, body: { name: 'X', phone: 'abc-not-a-number' } });
  assert.equal(bad.status, 400);
});

test('CRM: overview funnel, pipeline and bulk changes', async () => {
  const second = await api('POST', '/crm/contacts', { token: owner.token, body: { name: 'Sunil', phone: '0712223344', deal_value: 5000 } });
  assert.equal(second.status, 201, second.text);
  const overview = await api('GET', '/crm/overview', { token: owner.token });
  assert.equal(overview.status, 200, overview.text);
  const qualified = overview.data.funnel.find((row) => row.stage === 'qualified');
  assert.equal(qualified.contacts, 1);
  assert.equal(qualified.deal_value, 25000);
  assert.equal(overview.data.pipeline_value, 30000);
  assert.equal(overview.data.daily.length, 30);

  const bulk = await api('POST', '/crm/contacts/bulk', { token: owner.token, body: { ids: [contactId, second.data.profile.id], add_tags: ['wholesale'], remove_tags: ['vip'], lead_stage: 'proposal', owner_user_id: agent.id } });
  assert.equal(bulk.status, 201, bulk.text);
  assert.equal(bulk.data.updated, 2);
  const pipeline = await api('GET', '/crm/pipeline', { token: owner.token });
  const proposal = pipeline.data.find((column) => column.stage === 'proposal');
  assert.equal(proposal.count, 2);
  assert.equal(proposal.value, 30000);
  const card = proposal.contacts.find((c) => c.id === contactId);
  assert.deepEqual([...card.tags].sort(), ['kandy', 'wholesale']);
  assert.equal(Number(card.owner_user_id), agent.id);

  // the agent now owns both and sees them; another company sees nothing
  const agentList = await api('GET', '/crm/contacts', { token: agent.token });
  assert.equal(agentList.data.total, 2);
  const foreign = await api('POST', '/crm/contacts/bulk', { token: other.token, body: { ids: [contactId], add_tags: ['x'] } });
  assert.equal(foreign.status, 404);
  const agentOwner = await api('POST', '/crm/contacts/bulk', { token: agent.token, body: { ids: [contactId], owner_user_id: 0 } });
  assert.equal(agentOwner.status, 403, 'agents cannot change owners');
});

test('CRM tasks: new task without a customer, priority, filters, edit and delete', async () => {
  const made = await api('POST', '/crm/tasks', { token: owner.token, body: { title: 'Order fabric for Avurudu', priority: 'high', kind: 'other', due_at: new Date(Date.now() - 3600_000).toISOString() } });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.data.priority, 'high');
  assert.equal(made.data.bot_channel_user_id, null);
  const call = await api('POST', '/crm/tasks', { token: owner.token, body: { title: 'Call Kamal', contact_id: contactId, kind: 'call', assigned_user_id: agent.id } });
  assert.equal(call.status, 201, call.text);

  const overdue = await api('GET', '/crm/tasks?status=open&due=overdue', { token: owner.token });
  assert.deepEqual(overdue.data.map((t) => t.id), [made.data.id]);
  const high = await api('GET', '/crm/tasks?status=open&priority=high', { token: owner.token });
  assert.equal(high.data.length, 1);
  const search = await api('GET', '/crm/tasks?status=all&search=kamal', { token: owner.token });
  assert.equal(search.data.length, 1);

  const edited = await api('PATCH', `/crm/tasks/${made.data.id}`, { token: owner.token, body: { priority: 'low', contact_id: contactId, title: 'Order fabric' } });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.data.priority, 'low');
  assert.equal(Number(edited.data.bot_channel_user_id), contactId);

  // the agent sees the task assigned to them, but cannot delete one the admin made
  const agentTasks = await api('GET', '/crm/tasks?status=open&scope=mine', { token: agent.token });
  assert.ok(agentTasks.data.some((t) => t.id === call.data.id));
  assert.equal((await api('DELETE', `/crm/tasks/${call.data.id}`, { token: agent.token })).status, 403);
  assert.equal((await api('DELETE', `/crm/tasks/${call.data.id}`, { token: other.token })).status, 404);
  assert.equal((await api('DELETE', `/crm/tasks/${call.data.id}`, { token: owner.token })).status, 200);
  const overview = await api('GET', '/crm/overview', { token: owner.token });
  assert.equal(overview.data.tasks.open, 1);
});

test('Marketing: WhatsApp template builder checks the rules, sends to Meta, lists and deletes', async () => {
  await api('PATCH', `/company/${owner.companyId}`, { token: owner.token, body: { whatsapp_provider_type: 'meta', meta_phone_number_id: `pn-crmx-${Date.now()}`, meta_access_token: 'test-token', meta_waba_id: 'waba-crmx' } });
  const startsWithVariable = await api('POST', '/marketing/templates', { token: owner.token, body: { name: 'bad_one', language: 'en_US', category: 'MARKETING', body: '{{1}} new stock is here', body_examples: ['Nimal'] } });
  assert.equal(startsWithVariable.status, 400);
  assert.match(startsWithVariable.json.message, /start or end/);
  const gap = await api('POST', '/marketing/templates', { token: owner.token, body: { name: 'bad_two', language: 'en_US', category: 'MARKETING', body: 'Hi {{1}}, you get {{3}} off today only', body_examples: ['a', 'b'] } });
  assert.equal(gap.status, 400);
  const badName = await api('POST', '/marketing/templates', { token: owner.token, body: { name: 'New Offer', language: 'en_US', category: 'MARKETING', body: 'Hello' } });
  assert.equal(badName.status, 400);

  const good = await api('POST', '/marketing/templates', { token: owner.token, body: {
    name: 'avurudu_offer', language: 'en_US', category: 'MARKETING', header_text: 'Avurudu sale', body: 'Hi {{1}}, get {{2}} off all sarees this week. Reply YES to order.',
    body_examples: ['Nimal', '20%'], footer: 'Reply STOP to opt out',
    buttons: [{ type: 'URL', text: 'See the sale', url: 'https://shop.lk/sale' }, { type: 'QUICK_REPLY', text: 'YES' }],
  } });
  assert.equal(good.status, 201, good.text);
  assert.equal(good.data.status, 'PENDING');
  const sent = requests.find((r) => r.method === 'POST' && r.body?.name === 'avurudu_offer');
  assert.deepEqual(sent.body.components.map((c) => c.type), ['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);
  assert.deepEqual(sent.body.components[1].example, { body_text: [['Nimal', '20%']] });
  assert.equal(sent.body.components[3].buttons[0].type, 'QUICK_REPLY', 'quick replies first');

  const dup = await api('POST', '/marketing/templates', { token: owner.token, body: { name: 'avurudu_offer', language: 'en_US', category: 'MARKETING', body: 'Hello there' } });
  assert.equal(dup.status, 400);
  assert.match(dup.json.message, /already exists/);

  const all = await api('GET', '/marketing/templates/all', { token: owner.token });
  assert.equal(all.status, 200, all.text);
  assert.equal(all.data[0].status, 'PENDING');
  assert.equal(all.data[0].variables, 2);
  assert.equal(all.data[0].buttons.length, 2);
  const approved = await api('GET', '/marketing/templates', { token: owner.token });
  assert.equal(approved.data.length, 0, 'pending templates are not offered for broadcasts');

  assert.equal((await api('DELETE', '/marketing/templates/avurudu_offer', { token: owner.token })).status, 200);
  assert.equal(templates.length, 0);
  assert.equal((await api('POST', '/marketing/templates', { token: agent.token, body: { name: 'x_y', language: 'en_US', category: 'MARKETING', body: 'Hello' } })).status, 403);
});

test('Marketing overview', async () => {
  const overview = await api('GET', '/marketing/overview?days=30', { token: owner.token });
  assert.equal(overview.status, 200, overview.text);
  assert.equal(overview.data.whatsapp_cloud, true);
  assert.equal(overview.data.daily.length, 30);
  assert.ok(overview.data.audience.reachable >= 2);
});

test('Social: drafts, edit a draft, saved replies and hashtag sets', async () => {
  const draft = await api('POST', '/social/posts', { token: owner.token, body: { platforms: ['facebook'], message: 'New sarees this Friday', draft: true } });
  assert.equal(draft.status, 201, draft.text);
  assert.equal(draft.data.draft.status, 'draft');
  const edited = await api('PATCH', `/social/schedules/${draft.data.draft.id}`, { token: owner.token, body: { message: 'New sarees this Friday – 10% off', draft: true } });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.data.message, 'New sarees this Friday – 10% off');
  const list = await api('GET', '/social/schedules', { token: owner.token });
  assert.equal(list.data[0].status, 'draft');
  assert.equal((await api('PATCH', `/social/schedules/${draft.data.draft.id}`, { token: other.token, body: { message: 'x' } })).status, 404);

  const reply = await api('POST', '/social/saved', { token: owner.token, body: { kind: 'reply', title: 'Price in DM', text: 'Thank you! We sent the price to your inbox.' } });
  assert.equal(reply.status, 201, reply.text);
  const tags = await api('POST', '/social/saved', { token: owner.token, body: { kind: 'hashtags', title: 'Saree', text: '#saree #srilanka #fashion' } });
  assert.equal(tags.status, 201);
  const saved = await api('GET', '/social/saved', { token: owner.token });
  assert.equal(saved.data.length, 2);
  assert.equal((await api('GET', '/social/saved', { token: other.token })).data.length, 0);
  assert.equal((await api('DELETE', `/social/saved/${reply.data.id}`, { token: owner.token })).status, 200);

  const removed = await api('DELETE', `/social/schedules/${draft.data.draft.id}`, { token: owner.token });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.length, 0, 'a deleted draft is gone');
});
