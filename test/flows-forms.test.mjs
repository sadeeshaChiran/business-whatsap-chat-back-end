/**
 * Automation flows (keyword / first message / ad) and forms (asked in the chat, or filled on a link page),
 * through the customer simulator (999… numbers never reach WhatsApp).
 * Run the API with SALES_BOT_TEST_MODE=true, SALES_BOT_URL set and FLOW_TICK_MS=1000, then:
 *   node --test test/flows-forms.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, closeDb, createAgent, createWorkspace, sql } from './helpers.mjs';

let owner; let other; let agent; let formId; let flowId; let slug;
const say = (phone, text, extra = {}) => api('POST', '/bot/sales-bot/simulate', { token: owner.token, body: { phone, name: 'Nimal', text, ...extra } });
const outbound = async (conversationId) => (await sql(
  `SELECT content, source FROM bot_message WHERE conversation_id = $1 AND direction::text = 'outbound' ORDER BY id`, [conversationId])).map((r) => r.content);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  owner = await createWorkspace('flows');
  other = await createWorkspace('flows2');
  agent = await createAgent(owner, 'flows-agent');
  await sql(`UPDATE companies SET plan = 'growth', bot_enabled = false WHERE id = ANY($1)`, [[owner.companyId, other.companyId]]);
});
test.after(closeDb);

test('form: create, validation, only the admin of the same shop', async () => {
  const bad = await api('POST', '/flows/forms', { token: owner.token, body: { name: 'Size', fields: [{ label: 'Size', type: 'choice', options: ['S'] }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /at least 2 choices/);
  const created = await api('POST', '/flows/forms', { token: owner.token, body: {
    name: 'Order details', intro: 'A few quick questions:', add_tags: ['Form-Lead'], set_stage: 'qualified',
    fields: [
      { id: 'name', label: 'Your name?', type: 'text', required: true, maps_to: 'name' },
      { id: 'phone', label: 'Phone number?', type: 'phone', required: true, maps_to: 'phone' },
      { id: 'size', label: 'Which size?', type: 'choice', options: ['Small', 'Medium', 'Large'], required: true },
      { id: 'note', label: 'Anything else?', type: 'long_text' },
    ] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  formId = created.data.id; slug = created.data.slug;
  assert.deepEqual(created.data.add_tags, ['form-lead']);
  assert.equal((await api('GET', `/flows/forms/${formId}`, { token: other.token })).status, 404);
  assert.equal((await api('GET', `/flows/forms/${formId}`, { token: agent.token })).status, 403);
});

test('flow: keyword → text, buttons with a jump, chat form, tag, final message with answers', async () => {
  const bad = await api('POST', '/flows', { token: owner.token, body: { name: 'x', trigger_type: 'keyword', steps: [{ type: 'text', text: 'hi' }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /keyword/);
  const created = await api('POST', '/flows', { token: owner.token, body: {
    name: 'Price flow', status: 'active', trigger_type: 'keyword', trigger_config: { keywords: ['price', 'ganana'] },
    steps: [
      { type: 'text', text: 'Hi {{name}}! Thanks for asking.' },
      { type: 'buttons', text: 'What would you like?', save_as: 'choice', buttons: [{ label: 'Order now', tag: 'wants-order' }, { label: 'Just looking', goto: 4 }] },
      { type: 'form', form_id: formId, form_mode: 'chat' },
      { type: 'text', text: 'Great {{name}}, size {{size}} noted. We will call {{phone}}.' },
      { type: 'tag', tags: ['price-flow'] },
      { type: 'handoff', to: 'ai' },
    ] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  flowId = created.data.id;

  const phone = '999770001001';
  const first = await say(phone, 'price kiyada?');
  assert.equal(first.status, 201, first.text);
  const conv = first.data.conversation_id;
  let out = await outbound(conv);
  assert.equal(out[0], 'Hi Nimal! Thanks for asking.');
  assert.match(out[1], /What would you like\?\n▸ Order now\n▸ Just looking/);

  await say(phone, 'something else');               // not a button → asked again
  out = await outbound(conv);
  assert.match(out.at(-1), /Please choose one of these/);
  await say(phone, '1');                            // number picks the first button
  out = await outbound(conv);
  // one clean message: intro, what is coming, question 1 with the known name as a tap button
  assert.match(out.at(-1), /^A few quick questions:\n\n📝 \*[^*]+\* – 4 quick questions\. Send \*stop\* any time to cancel\.\n\n\*1\/4\* Your name\?\n_Tap your name or type it_\n▸ Nimal$/, out.at(-1));
  await say(phone, 'Nimal Perera');
  await say(phone, '12345');                         // bad phone → error, same question
  out = await outbound(conv);
  assert.match(out.at(-1), /^⚠️ Please send a valid phone number[\s\S]*\*2\/4\* Phone number\?/);
  await say(phone, '077 123 4567');
  out = await outbound(conv);
  assert.match(out.at(-1), /\*3\/4\* Which size\?[\s\S]*▸ Small\n▸ Medium/);
  await say(phone, 'medium');
  await say(phone, 'skip');
  out = await outbound(conv);
  assert.ok(out.some((o) => /^✅ Thank you! We received your details\.\n\n\*Your details\*\n• Your name: Nimal Perera\n• Phone number: \+94771234567\n• Which size: Medium$/.test(o)), out.join(' | '));
  assert.equal(out.at(-1), 'Great Nimal Perera, size Medium noted. We will call +94771234567.');

  const [sub] = await sql(`SELECT answers, source, conversation_id FROM chat_form_submission WHERE form_id = $1`, [formId]);
  assert.deepEqual(sub.answers, { name: 'Nimal Perera', phone: '+94771234567', size: 'Medium' });
  assert.equal(sub.source, 'chat');
  const [crm] = await sql(`SELECT tags, stage, phone FROM crm_contact c JOIN bot_conversation v ON v.bot_channel_user_id = c.bot_channel_user_id WHERE v.id = $1`, [conv]);
  assert.deepEqual([...crm.tags].sort(), ['form-lead', 'price-flow', 'wants-order']);
  assert.equal(crm.stage, 'qualified');
  assert.equal(crm.phone, '+94771234567');
  const [run] = await sql(`SELECT status FROM automation_run WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`, [conv]);
  assert.equal(run.status, 'handed_off');
  const [note] = await sql(`SELECT content FROM bot_customer_note WHERE bot_channel_user_id = (SELECT bot_channel_user_id FROM bot_conversation WHERE id = $1)`, [conv]);
  assert.match(note.content, /Order details[\s\S]*Which size\?: Medium/);

  // after the flow the next message is the AI's again (no flow handles it)
  const before = (await outbound(conv)).length;
  await say(phone, 'thanks');
  assert.equal((await outbound(conv)).length, before);

  const list = await api('GET', '/flows', { token: owner.token });
  const row = list.data.find((f) => f.id === flowId);
  assert.equal(row.runs, 1);
  assert.equal(row.completed, 1);
  const subs = await api('GET', `/flows/forms/${formId}/submissions`, { token: owner.token });
  assert.equal(subs.data.submissions.length, 1);
});

test('buttons jump, "stop" ends a flow, keyword "exact" and once-per-contact', async () => {
  const phone = '999770001002';
  const first = await say(phone, 'GANANA');
  const conv = first.data.conversation_id;
  await say(phone, 'Just looking');                  // goto step 5 (tag) → handoff ai
  const out = await outbound(conv);
  assert.ok(!out.includes('Your name?'), 'form skipped by the jump');
  const [crm] = await sql(`SELECT tags FROM crm_contact c JOIN bot_conversation v ON v.bot_channel_user_id = c.bot_channel_user_id WHERE v.id = $1`, [conv]);
  assert.deepEqual(crm.tags, ['price-flow']);

  const exact = await api('POST', '/flows', { token: owner.token, body: {
    name: 'Menu', status: 'active', trigger_type: 'keyword', trigger_config: { keywords: ['menu'], match: 'exact', once_per_contact: false },
    steps: [{ type: 'buttons', text: 'Menu', buttons: [{ label: 'A' }, { label: 'B' }] }, { type: 'text', text: 'You chose {{pick}}' }] } });
  assert.equal(exact.status, 201, JSON.stringify(exact.json));
  const p2 = '999770001003';
  const c2 = (await say(p2, 'show me the menu please')).data.conversation_id;
  assert.equal((await outbound(c2)).length, 0, 'exact match only');
  await say(p2, 'menu');
  await say(p2, 'stop');
  assert.match((await outbound(c2)).at(-1), /stopped/);
  const [run] = await sql(`SELECT status FROM automation_run WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`, [c2]);
  assert.equal(run.status, 'stopped');
  await say(p2, 'menu');                            // once_per_contact false → runs again
  assert.equal((await outbound(c2)).at(-1), 'Menu\n▸ A\n▸ B');
});

test('first message flow with a wait step; ad flow beats it for ad chats', async () => {
  const welcome = await api('POST', '/flows', { token: owner.token, body: {
    name: 'Welcome', status: 'active', trigger_type: 'first_message', channels: ['whatsapp'],
    steps: [{ type: 'text', text: 'Ayubowan!' }, { type: 'delay', seconds: 1 }, { type: 'text', text: 'Here is our catalogue.' }] } });
  assert.equal(welcome.status, 201, JSON.stringify(welcome.json));
  const ad = await api('POST', '/flows', { token: owner.token, body: {
    name: 'From ad', status: 'active', trigger_type: 'ad', trigger_config: { ad_ids: ['120000000001'] }, steps: [{ type: 'text', text: 'Thanks for clicking our ad!' }] } });
  assert.equal(ad.status, 201, JSON.stringify(ad.json));

  const c1 = (await say('999770001004', 'hello')).data.conversation_id;
  assert.deepEqual(await outbound(c1), ['Ayubowan!']);
  await wait(3500);
  assert.deepEqual(await outbound(c1), ['Ayubowan!', 'Here is our catalogue.']);
  await say('999770001004', 'hello again');          // not the first message any more
  assert.equal((await outbound(c1)).length, 2);

  const c2 = (await say('999770001005', 'hi', { ad_id: '120000000001' })).data.conversation_id;
  assert.deepEqual(await outbound(c2), ['Thanks for clicking our ad!']);
  const c3 = (await say('999770001006', 'hi', { ad_id: '999' })).data.conversation_id; // other ad → welcome
  assert.deepEqual(await outbound(c3), ['Ayubowan!']);
  await api('POST', `/flows/${welcome.data.id}/status`, { token: owner.token, body: { status: 'paused' } });
});

test('form link page: invite from a flow, prefill, validation, one answer per link, photo upload', async () => {
  const flow = await api('POST', '/flows', { token: owner.token, body: {
    name: 'Link form', status: 'active', trigger_type: 'keyword', trigger_config: { keywords: ['form'] },
    steps: [{ type: 'form', form_id: formId, form_mode: 'link', text: 'Please fill this:' }] } });
  assert.equal(flow.status, 201, JSON.stringify(flow.json));
  const conv = (await say('999770001007', 'form')).data.conversation_id;
  const link = (await outbound(conv))[0];
  const match = link.match(/\/f\/([a-z0-9x]+)\?t=([\w-]+)/);
  assert.ok(match, link);
  assert.equal(match[1], slug);
  const token = match[2];

  const page = await api('GET', `/public/forms/${slug}?t=${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.prefill.name, 'Nimal');
  assert.equal(page.data.prefill.phone, '+999770001007');
  assert.equal(page.data.fields.length, 4);

  const invalid = await api('POST', `/public/forms/${slug}`, { body: { token, answers: { name: '', phone: 'abc', size: 'XXL' } } });
  assert.equal(invalid.status, 400);
  assert.deepEqual(Object.keys(invalid.json.fields ?? {}).sort(), ['name', 'phone', 'size']);
  const ok = await api('POST', `/public/forms/${slug}`, { body: { token, answers: { name: 'Kasun', phone: '0711111111', size: 'Large', note: 'Gift wrap' } } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal((await outbound(conv)).at(-1), 'Thank you! We received your details.');
  const again = await api('POST', `/public/forms/${slug}`, { body: { token, answers: { name: 'Kasun', phone: '0711111111', size: 'Large' } } });
  assert.equal(again.status, 400);
  const [sub] = await sql(`SELECT answers, source, conversation_id FROM chat_form_submission WHERE form_id = $1 AND source = 'link'`, [formId]);
  assert.equal(sub.conversation_id, conv);
  assert.equal(sub.answers.phone, '+94711111111');

  // anonymous link (shared on a poster): no token
  const anon = await api('POST', `/public/forms/${slug}`, { body: { answers: { name: 'Walk-in', phone: '0722222222', size: 'Small' } } });
  assert.equal(anon.status, 201, JSON.stringify(anon.json));
  assert.equal((await api('GET', '/public/forms/nope')).status, 404);
  // a switched-off form is closed
  const f = (await api('GET', `/flows/forms/${formId}`, { token: owner.token })).data;
  const formRow = { name: f.name, title: f.title, intro: f.intro, fields: f.fields, thank_you: f.thank_you, add_tags: f.add_tags, set_stage: f.set_stage, notify: f.notify };
  const off = await api('PATCH', `/flows/forms/${formId}`, { token: owner.token, body: { ...formRow, active: false } });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.equal((await api('GET', `/public/forms/${slug}`)).status, 404);
  await api('PATCH', `/flows/forms/${formId}`, { token: owner.token, body: { ...formRow, active: true } });
  // used by a flow → cannot delete
  const del = await api('DELETE', `/flows/forms/${formId}`, { token: owner.token });
  assert.equal(del.status, 400);
  assert.match(del.json.message, /used in/);
});

test('flows are private to the shop and validated', async () => {
  assert.equal((await api('GET', `/flows/${flowId}`, { token: other.token })).status, 404);
  assert.equal((await api('PATCH', `/flows/${flowId}`, { token: other.token, body: { name: 'x', trigger_type: 'keyword', trigger_config: { keywords: ['a'] }, steps: [{ type: 'text', text: 'a' }] } })).status, 404);
  assert.equal((await api('GET', '/flows', { token: agent.token })).status, 403);
  const foreignForm = await api('POST', '/flows', { token: other.token, body: { name: 'steal', trigger_type: 'keyword', trigger_config: { keywords: ['a'] }, steps: [{ type: 'form', form_id: formId }] } });
  assert.equal(foreignForm.status, 400, 'cannot use another shop\'s form');
  const badJump = await api('POST', '/flows', { token: owner.token, body: { name: 'j', trigger_type: 'keyword', trigger_config: { keywords: ['a'] }, steps: [{ type: 'buttons', text: 'q', buttons: [{ label: 'a', goto: 9 }, { label: 'b' }] }] } });
  assert.equal(badJump.status, 400);
  const comment = await api('POST', '/flows', { token: owner.token, body: { name: 'c', trigger_type: 'comment', steps: [{ type: 'text', text: 'a' }] } });
  assert.equal(comment.status, 400);
  assert.match(comment.json.message, /every comment/);
});
