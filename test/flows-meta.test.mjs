/**
 * Flows on Messenger / Instagram (quick replies through the Page) and the comment trigger (private reply + public reply),
 * against a fake Meta Graph API. Run the API with:
 *   META_GRAPH_BASE_URL=http://127.0.0.1:4599 META_APP_ID=new-app META_APP_SECRET=new-secret META_OAUTH_REDIRECT_URI=http://localhost/cb
 * then: node --test test/flows-meta.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { API, api, closeDb, createWorkspace, sql } from './helpers.mjs';

const PAGE = `fpage${Date.now()}`;
const IG = `${Date.now()}77`;
const sent = [];
const meta = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/v[\d.]+/, '');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') sent.push({ path, body: body ? JSON.parse(body) : {} });
    if (path === `/${PAGE}/messages`) return res.end(JSON.stringify({ message_id: `m.${sent.length}` }));
    if (/\/(comments|replies)$/.test(path)) return res.end(JSON.stringify({ id: `r${sent.length}` }));
    if (req.method === 'GET') return res.end(JSON.stringify({ id: 'x', name: 'Customer' }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: `not faked ${req.method} ${path}` } }));
  });
});

let owner;
const hook = async (body) => {
  const raw = JSON.stringify(body);
  return fetch(`${API}/integrations/meta/messages/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', 'new-secret').update(raw).digest('hex')}` }, body: raw });
};
const dm = (sender, text, extra = {}) => hook({ object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [{ sender: { id: sender }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: `mid.${Math.random()}`, text, ...extra } }] }] });
const toSender = (id) => sent.filter((s) => s.path === `/${PAGE}/messages` && s.body.recipient?.id === id).map((s) => s.body.message);

test.before(async () => {
  await new Promise((resolve) => meta.listen(4599, '127.0.0.1', resolve));
  owner = await createWorkspace('flowmeta');
  await sql(`UPDATE companies SET plan = 'growth', bot_enabled = false WHERE id = $1`, [owner.companyId]);
  await sql(`INSERT INTO meta_page_connections (company_id, page_id, page_name, page_access_token, instagram_business_account_id, status, created_at, updated_at) VALUES ($1, $2, 'Shop', 'tok', $3, 'CONNECTED', NOW(), NOW())`, [owner.companyId, PAGE, IG]);
});
test.after(async () => { meta.close(); await closeDb(); });

test('Messenger: keyword flow sends text and quick replies through the Page, answer by tap', async () => {
  const flow = await api('POST', '/flows', { token: owner.token, body: {
    name: 'Sizes', status: 'active', trigger_type: 'keyword', channels: ['messenger', 'instagram'], trigger_config: { keywords: ['size'] },
    steps: [
      { type: 'text', text: 'Hello!' },
      { type: 'buttons', text: 'Which size?', save_as: 'size', buttons: [{ label: 'S' }, { label: 'M' }, { label: 'L' }, { label: 'XL' }] },
      { type: 'text', text: 'Size {{size}} – noted.' },
    ] } });
  assert.equal(flow.status, 201, JSON.stringify(flow.json));
  const r = await dm('user1', 'size chart?');
  assert.equal(r.status, 200);
  let msgs = toSender('user1');
  assert.equal(msgs[0].text, 'Hello!');
  assert.equal(msgs[1].text, 'Which size?');
  assert.deepEqual(msgs[1].quick_replies.map((q) => q.title), ['S', 'M', 'L', 'XL']);
  await dm('user1', 'XL', { quick_reply: { payload: 'b3' } });
  msgs = toSender('user1');
  assert.equal(msgs.at(-1).text, 'Size XL – noted.');
  const [conv] = await sql(`SELECT c.id FROM bot_conversation c JOIN bot_channel_user u ON u.id = c.bot_channel_user_id WHERE u.external_user_id = 'user1' AND u.company_id = $1`, [owner.companyId]);
  const rows = await sql(`SELECT content, source FROM bot_message WHERE conversation_id = $1 ORDER BY id`, [conv.id]);
  assert.deepEqual(rows.map((x) => x.content), ['size chart?', 'Hello!', 'Which size?\n▸ S\n▸ M\n▸ L\n▸ XL', 'XL', 'Size XL – noted.']);
  assert.ok(rows.filter((x) => x.source?.startsWith('flow:')).length === 3);
});

test('comment trigger: keyword comment → private reply with buttons + public reply, once per comment, never the Page itself', async () => {
  const flow = await api('POST', '/flows', { token: owner.token, body: {
    name: 'Comment price', status: 'active', trigger_type: 'comment', trigger_config: { keywords: ['price'], comment_reply: 'Sent you a message {{name}} 📩' },
    steps: [
      { type: 'buttons', text: 'Hi {{name}}! Price is Rs 2500. Order?', save_as: 'want', buttons: [{ label: 'Yes' }, { label: 'No', goto: -1 }] },
      { type: 'text', text: 'Great, answer: {{want}}. Send your address please.' },
    ] } });
  assert.equal(flow.status, 201, JSON.stringify(flow.json));
  const feed = (from, id, message) => hook({ object: 'page', entry: [{ id: PAGE, time: Date.now(), changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: id, post_id: `${PAGE}_1`, from, message, created_time: Math.floor(Date.now() / 1000) } }] }] });
  sent.length = 0;
  await feed({ id: 'fan1', name: 'Kamal' }, `${PAGE}_1_c1`, 'price?');
  await new Promise((r) => setTimeout(r, 500));
  const privateReply = sent.find((s) => s.path === `/${PAGE}/messages` && s.body.recipient?.comment_id === `${PAGE}_1_c1`);
  assert.ok(privateReply, JSON.stringify(sent));
  assert.equal(privateReply.body.message.text, 'Hi Kamal! Price is Rs 2500. Order?');
  assert.deepEqual(privateReply.body.message.quick_replies.map((q) => q.title), ['Yes', 'No']);
  assert.equal(privateReply.body.message.quick_replies[0].payload, `cf${flow.data.id}_0_b0`);
  const publicReply = sent.find((s) => s.path === `/${PAGE}_1_c1/comments`);
  assert.equal(publicReply.body.message, 'Sent you a message Kamal 📩');

  const before = sent.length;
  await feed({ id: 'fan1', name: 'Kamal' }, `${PAGE}_1_c1`, 'price?');   // same comment again (webhook retry)
  await feed({ id: 'fan2', name: 'Nuwan' }, `${PAGE}_1_c2`, 'nice photo'); // no keyword
  await feed({ id: PAGE, name: 'Shop' }, `${PAGE}_1_c3`, 'price is in the post'); // the Page itself
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(sent.filter((s, i) => i >= before && s.path === `/${PAGE}/messages`).length, 0);
  let [row] = await sql(`SELECT runs, completed FROM automation_flow WHERE id = $1`, [flow.data.id]);
  assert.equal(row.runs, 1);
  assert.equal(row.completed, 0);

  // the commenter taps “Yes” in Messenger → the flow goes on in the chat
  await dm('fan1psid', 'Yes', { quick_reply: { payload: `cf${flow.data.id}_0_b0` } });
  assert.equal(toSender('fan1psid').at(-1).text, 'Great, answer: Yes. Send your address please.');
  [row] = await sql(`SELECT runs, completed FROM automation_flow WHERE id = $1`, [flow.data.id]);
  assert.deepEqual([row.runs, row.completed], [1, 1]);
});
