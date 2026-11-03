/**
 * Telegram groups & channels only for invited customers: the bot is made admin → the group appears; invites by tag go out as
 * private messages with a join-request link; invited people are approved, others declined; removing someone kicks them;
 * posting into the group; group messages never reach the inbox. Through a fake Telegram Bot API.
 * Run the API with TELEGRAM_API_BASE_URL=http://127.0.0.1:4597, then:  node --test test/telegram-groups.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { api, closeDb, createWorkspace, sql } from './helpers.mjs';

const BOT_ID = 7_100_000_000 + Math.floor(Math.random() * 1e8);
const TOKEN = `${BOT_ID}:AA${randomBytes(18).toString('hex')}`;
const GROUP = -1_003_000_000_000 - Math.floor(Math.random() * 1e6);
const ALICE = 5_100_000_000 + Math.floor(Math.random() * 1e7);
const BOB = ALICE + 1;
const EVE = ALICE + 2;
const calls = [];
let webhook = null;
let messageId = 10;

const telegram = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const send = (result, ok = true, extra = {}) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(ok ? { ok, result } : { ok, ...extra })); };
    const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m || m[1] !== TOKEN) return send(null, false, { error_code: 401, description: 'Unauthorized' });
    const raw = Buffer.concat(chunks).toString();
    const body = String(req.headers['content-type'] || '').includes('json') ? JSON.parse(raw || '{}') : { multipart: true, raw };
    calls.push({ method: m[2], body });
    switch (m[2]) {
      case 'getMe': return send({ id: BOT_ID, is_bot: true, first_name: 'Class bot', username: 'classbot' });
      case 'setWebhook': webhook = body; return send(true);
      case 'getWebhookInfo': return send({ url: webhook?.url ?? '', pending_update_count: 0, allowed_updates: webhook?.allowed_updates ?? [] });
      case 'getChat': return Number(body.chat_id) === GROUP ? send({ id: GROUP, type: 'supergroup', title: 'Grade 10 – 2026' }) : send(null, false, { error_code: 400, description: 'Bad Request: chat not found' });
      case 'getChatMember': return send({ status: 'administrator', can_invite_users: true, can_restrict_members: true });
      case 'getChatMemberCount': return send(42);
      case 'createChatInviteLink': return send({ invite_link: 'https://t.me/+joinGrade10', creates_join_request: body.creates_join_request });
      case 'approveChatJoinRequest': case 'declineChatJoinRequest': case 'banChatMember': case 'unbanChatMember': return send(true);
      default:
        if (/^send/.test(m[2])) { messageId += 1; return send({ message_id: messageId, chat: { id: Number(body.chat_id ?? 0) } }); }
        return send(null, false, { error_code: 400, description: `Bad Request: ${m[2]}` });
    }
  });
});

let updateId = 1;
const update = (payload) => {
  const id = webhook?.url?.match(/webhook\/(\d+)$/)?.[1];
  return api('POST', `/integrations/telegram/webhook/${id}`, { body: { update_id: updateId++, ...payload }, headers: { 'X-Telegram-Bot-Api-Secret-Token': webhook?.secret_token } });
};
const person = (id, first) => ({ id, is_bot: false, first_name: first });
const startBot = (id, first) => update({ message: { message_id: updateId, date: 1, chat: { id, type: 'private', first_name: first }, from: person(id, first), text: '/start' } });
const of = (method) => calls.filter((c) => c.method === method);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = await check(); if (v || Date.now() > end) return v; await wait(100); }
}

let owner;
let spaceId;
const cu = {};

test.before(async () => {
  await new Promise((resolve) => telegram.listen(4597, '127.0.0.1', resolve));
  owner = await createWorkspace('tg-groups');
  await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [owner.companyId]);
  const r = await api('POST', '/integrations/telegram/connect', { token: owner.token, body: { token: TOKEN } });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.json));
  for (const [id, name] of [[ALICE, 'Alice'], [BOB, 'Bob'], [EVE, 'Eve']]) await startBot(id, name);
  for (const [key, id] of [['alice', ALICE], ['bob', BOB], ['eve', EVE]]) {
    cu[key] = Number((await sql(`SELECT id FROM bot_channel_user WHERE company_id = $1 AND platform = 'telegram' AND external_user_id = $2`, [owner.companyId, String(id)]))[0].id);
  }
  await sql(`INSERT INTO crm_contact (bot_channel_user_id, company_id, tags, updated_at) VALUES ($1, $2, ARRAY['grade10'], NOW()), ($3, $2, ARRAY['grade10'], NOW())`, [cu.alice, owner.companyId, cu.bob]);
});
test.after(async () => {
  await sql(`DELETE FROM telegram_connection WHERE bot_id = $1`, [String(BOT_ID)]).catch(() => undefined);
  telegram.close();
  await closeDb();
});

test('the webhook asks Telegram for join requests', async () => {
  assert.ok(webhook.allowed_updates.includes('chat_join_request'));
  assert.ok(webhook.allowed_updates.includes('chat_member'));
});

test('making the bot admin of a group makes it appear (members only by default)', async () => {
  const r = await update({ my_chat_member: { chat: { id: GROUP, type: 'supergroup', title: 'Grade 10 – 2026' }, from: person(ALICE, 'Owner'), new_chat_member: { status: 'administrator', user: { id: BOT_ID, is_bot: true }, can_invite_users: true, can_restrict_members: true } } });
  assert.equal(r.status, 200);
  const list = await api('GET', '/integrations/telegram/spaces', { token: owner.token });
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.equal(list.data.items.length, 1);
  const [space] = list.data.items;
  spaceId = space.id;
  assert.equal(space.title, 'Grade 10 – 2026');
  assert.equal(space.members_only, true);
  assert.equal(space.ready, true);
  assert.deepEqual(space.problems, []);
  const refreshed = await api('POST', `/integrations/telegram/spaces/${spaceId}/refresh`, { token: owner.token });
  assert.equal(refreshed.data.member_count, 42);
});

test('a message inside the group never becomes an inbox chat', async () => {
  const before = await sql(`SELECT COUNT(*)::int AS n FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user u ON u.id = c.bot_channel_user_id WHERE u.company_id = $1`, [owner.companyId]);
  await update({ message: { message_id: 999, date: 1, chat: { id: GROUP, type: 'supergroup', title: 'Grade 10' }, from: person(BOB, 'Bob'), text: 'hello class' } });
  const after = await sql(`SELECT COUNT(*)::int AS n FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user u ON u.id = c.bot_channel_user_id WHERE u.company_id = $1`, [owner.companyId]);
  assert.equal(after[0].n, before[0].n);
});

test('invite by tag: private message with a join-request link to each invited follower', async () => {
  assert.equal((await api('POST', `/integrations/telegram/spaces/${spaceId}/invite`, { token: owner.token, body: {} })).status, 400);
  const r = await api('POST', `/integrations/telegram/spaces/${spaceId}/invite`, { token: owner.token, body: { tags: ['grade10'], message: 'Hi {name}, our class group is ready.' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.data.invited, 2);
  assert.equal(of('createChatInviteLink')[0].body.creates_join_request, true, 'the link only asks to join');
  const sent = await until(() => of('sendMessage').filter((c) => c.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url === 'https://t.me/+joinGrade10').length === 2);
  assert.ok(sent);
  const toAlice = of('sendMessage').find((c) => String(c.body.chat_id) === String(ALICE) && c.body.reply_markup);
  assert.match(toAlice.body.text, /^Hi Alice, our class group is ready\./);
  assert.ok(!of('sendMessage').some((c) => String(c.body.chat_id) === String(EVE) && c.body.reply_markup), 'Eve was not invited');
  const candidates = await api('GET', `/integrations/telegram/spaces/${spaceId}/candidates`, { token: owner.token });
  assert.equal(candidates.data.find((c) => c.channel_user_id === cu.alice).status, 'invited');
});

test('join requests: invited people are approved, others declined and told why', async () => {
  await update({ chat_join_request: { chat: { id: GROUP, type: 'supergroup' }, from: person(ALICE, 'Alice'), user_chat_id: ALICE, date: 1 } });
  await update({ chat_join_request: { chat: { id: GROUP, type: 'supergroup' }, from: person(EVE, 'Eve'), user_chat_id: EVE, date: 1 } });
  const stranger = EVE + 50;
  await update({ chat_join_request: { chat: { id: GROUP, type: 'supergroup' }, from: person(stranger, 'X'), user_chat_id: stranger, date: 1 } });
  assert.deepEqual(of('approveChatJoinRequest').map((c) => c.body.user_id), [ALICE]);
  assert.deepEqual(of('declineChatJoinRequest').map((c) => c.body.user_id), [EVE, stranger]);
  assert.ok(of('sendMessage').some((c) => String(c.body.chat_id) === String(EVE) && /only for/.test(c.body.text)));
  const members = await api('GET', `/integrations/telegram/spaces/${spaceId}/members`, { token: owner.token });
  const status = Object.fromEntries(members.data.map((m) => [m.channel_user_id, m.status]));
  assert.equal(status[cu.alice], 'joined');
  assert.equal(status[cu.bob], 'invited');
  assert.equal(status[cu.eve], 'declined');
});

test('auto-allow by tag; "anyone can join" switch', async () => {
  await api('PUT', `/integrations/telegram/spaces/${spaceId}`, { token: owner.token, body: { audience_tags: ['vip'] } });
  await sql(`INSERT INTO crm_contact (bot_channel_user_id, company_id, tags, updated_at) VALUES ($1, $2, ARRAY['vip'], NOW())`, [cu.eve, owner.companyId]);
  await update({ chat_join_request: { chat: { id: GROUP, type: 'supergroup' }, from: person(EVE, 'Eve'), user_chat_id: EVE, date: 1 } });
  assert.ok(of('approveChatJoinRequest').some((c) => c.body.user_id === EVE), 'tagged vip → let in');
  const open = await api('PUT', `/integrations/telegram/spaces/${spaceId}`, { token: owner.token, body: { members_only: false, audience_tags: [] } });
  assert.equal(open.data.members_only, false);
  const nobody = EVE + 77;
  await update({ chat_join_request: { chat: { id: GROUP, type: 'supergroup' }, from: person(nobody, 'Y'), user_chat_id: nobody, date: 1 } });
  assert.ok(of('approveChatJoinRequest').some((c) => c.body.user_id === nobody));
  await api('PUT', `/integrations/telegram/spaces/${spaceId}`, { token: owner.token, body: { members_only: true } });
});

test('remove: kicked out, and the link no longer lets them back in', async () => {
  const r = await api('DELETE', `/integrations/telegram/spaces/${spaceId}/members/${cu.alice}`, { token: owner.token });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(of('banChatMember').at(-1).body.user_id, ALICE);
  assert.equal(of('unbanChatMember').at(-1).body.only_if_banned, true, 'a kick, not a lifetime ban');
  const approvals = of('approveChatJoinRequest').length;
  await update({ chat_join_request: { chat: { id: GROUP, type: 'supergroup' }, from: person(ALICE, 'Alice'), user_chat_id: ALICE, date: 1 } });
  assert.equal(of('approveChatJoinRequest').length, approvals, 'declined');
  const members = await api('GET', `/integrations/telegram/spaces/${spaceId}/members`, { token: owner.token });
  assert.equal(members.data.find((m) => m.channel_user_id === cu.alice).status, 'removed');
});

test('members only: someone who gets in without an invite (public @username) is taken out; "invite all" skips removed people', async () => {
  const stranger = EVE + 300;
  const bans = of('banChatMember').length;
  await update({ chat_member: { chat: { id: GROUP, type: 'supergroup' }, from: person(stranger, 'Z'), old_chat_member: { status: 'left', user: person(stranger, 'Z') }, new_chat_member: { status: 'member', user: person(stranger, 'Z') } } });
  assert.equal(of('banChatMember').length, bans + 1);
  assert.equal(of('banChatMember').at(-1).body.user_id, stranger);
  const r = await api('POST', `/integrations/telegram/spaces/${spaceId}/invite`, { token: owner.token, body: { all: true } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const members = await api('GET', `/integrations/telegram/spaces/${spaceId}/members`, { token: owner.token });
  assert.equal(members.data.find((m) => m.channel_user_id === cu.alice).status, 'removed', 'Alice stays removed');
  await until(async () => (await api('GET', '/integrations/telegram/spaces', { token: owner.token })).data.items[0].invite?.status === 'sent');
});

test('members leaving / joining inside Telegram are tracked', async () => {
  await update({ chat_member: { chat: { id: GROUP, type: 'supergroup' }, from: person(BOB, 'Bob'), old_chat_member: { status: 'left', user: person(BOB, 'Bob') }, new_chat_member: { status: 'member', user: person(BOB, 'Bob') } } });
  let members = await api('GET', `/integrations/telegram/spaces/${spaceId}/members`, { token: owner.token });
  assert.equal(members.data.find((m) => m.channel_user_id === cu.bob).status, 'joined');
  await update({ chat_member: { chat: { id: GROUP, type: 'supergroup' }, from: person(BOB, 'Bob'), old_chat_member: { status: 'member', user: person(BOB, 'Bob') }, new_chat_member: { status: 'left', user: person(BOB, 'Bob') } } });
  members = await api('GET', `/integrations/telegram/spaces/${spaceId}/members`, { token: owner.token });
  assert.equal(members.data.find((m) => m.channel_user_id === cu.bob).status, 'left');
});

test('post into the group; other businesses can not touch it; bot removed → shown as a problem', async () => {
  const post = await api('POST', `/integrations/telegram/spaces/${spaceId}/post`, { token: owner.token, body: { text: 'Papers are marked ✅' } });
  assert.equal(post.status, 201, JSON.stringify(post.json));
  assert.equal(String(of('sendMessage').at(-1).body.chat_id), String(GROUP));
  const other = await createWorkspace('tg-other');
  await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [other.companyId]);
  assert.ok([400, 404].includes((await api('GET', `/integrations/telegram/spaces/${spaceId}/members`, { token: other.token })).status));
  await update({ my_chat_member: { chat: { id: GROUP, type: 'supergroup', title: 'Grade 10 – 2026' }, from: person(ALICE, 'Owner'), new_chat_member: { status: 'left', user: { id: BOT_ID, is_bot: true } } } });
  const list = await api('GET', '/integrations/telegram/spaces', { token: owner.token });
  assert.equal(list.data.items[0].ready, false);
  assert.match(list.data.items[0].problems[0], /not an admin/);
  assert.equal((await api('POST', `/integrations/telegram/spaces/${spaceId}/invite`, { token: owner.token, body: { all: true } })).status, 400);
});
