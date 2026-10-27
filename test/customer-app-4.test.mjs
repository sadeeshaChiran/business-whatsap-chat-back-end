/**
 * Customer app part 4: roles and role rules for member messages, the "new message" people list, online / last seen,
 * sent / delivered / read ticks, read counts in groups, and group chats in the business Inbox (both ways).
 * Run with the API (OTP_DEV_MODE=true):  node --test test/customer-app-4.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { api, closeDb, createWorkspace, sql } from './helpers.mjs';
import { phone, sendDm } from './e2ee.mjs';

const rnd = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const intl = (local) => `94${local.slice(1)}`;
const as = (token) => ({ token });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) { const v = await check(); if (v || Date.now() > end) return v; await wait(150); }
}

let shop;
let slug;
const p = {};

async function login(local, name) {
  const start = await api('POST', '/ca/auth/start', { body: { phone: local, app: slug } });
  assert.equal(start.status, 201, JSON.stringify(start.json));
  const v = await api('POST', '/ca/auth/verify', { body: { phone: local, code: start.data.dev_code, name, app: slug } });
  return { token: v.data.token, id: v.data.account.id, local };
}

test.before(async () => {
  shop = await createWorkspace('ca4-school');
  await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [shop.companyId]);
  slug = `ca4-${randomBytes(3).toString('hex')}`;
  await api('PUT', '/customer-app/settings', { token: shop.token, body: { enabled: true, slug } });
  const locals = { t: rnd(), a: rnd(), b: rnd(), c: rnd() };
  await api('POST', '/customer-app/members', { token: shop.token, body: { phones: Object.values(locals).join(',') } });
  p.t = await login(locals.t, 'Mr Perera');
  p.a = await login(locals.a, 'Amaya');
  p.b = await login(locals.b, 'Binura');
  p.c = await login(locals.c, 'Chathu');
});
test.after(async () => { await closeDb(); });

test('roles: given by the business, filterable, shown next to members', async () => {
  const r = await api('PATCH', '/customer-app/members/roles', { token: shop.token, body: { phones: [intl(p.t.local)], roles: ['Teacher'] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await api('PATCH', '/customer-app/members/roles', { token: shop.token, body: { phones: [intl(p.a.local), intl(p.b.local)], add: ['parent'] } });
  await api('PATCH', '/customer-app/members/roles', { token: shop.token, body: { phones: [intl(p.c.local)], add: ['parent', 'vip'] } });
  await api('PATCH', '/customer-app/members/roles', { token: shop.token, body: { phones: [intl(p.c.local)], remove: ['vip'] } });
  const list = await api('GET', '/customer-app/members?role=parent', as(shop.token));
  assert.equal(list.data.total, 3);
  assert.deepEqual(list.data.roles.map((x) => x.role).sort(), ['parent', 'teacher']);
  assert.equal((await api('PATCH', '/customer-app/members/roles', { token: shop.token, body: { roles: ['x'] } })).status, 400);
  const me = await api('GET', `/ca/places/${shop.companyId}/profile`, as(p.a.token));
  assert.deepEqual(me.data.my_roles, ['parent']);
});

test('role rules: parents may message the teacher, not each other; people list follows the rules', async () => {
  await api('PUT', '/customer-app/settings', { token: shop.token, body: { member_dm: true, dm_mode: 'roles', dm_rules: [['Parent', 'teacher'], ['bad']] } });
  const s = await api('GET', '/customer-app/settings', as(shop.token));
  assert.deepEqual(s.data.dm_rules, [['parent', 'teacher']]);
  assert.equal(s.data.dm_mode, 'roles');

  const people = await api('GET', `/ca/places/${shop.companyId}/people`, as(p.a.token));
  assert.equal(people.status, 200, JSON.stringify(people.json));
  assert.deepEqual(people.data.items.map((x) => x.name), ['Mr Perera'], 'a parent only sees the teacher');
  assert.ok(!JSON.stringify(people.json).includes(intl(p.t.local)), 'no numbers');
  const teacher = await api('GET', `/ca/places/${shop.companyId}/people`, as(p.t.token));
  assert.equal(teacher.data.items.length, 3, 'the teacher sees all parents');

  assert.equal((await api('POST', `/ca/places/${shop.companyId}/dms`, { token: p.a.token, body: { member: `m${p.b.id}` } })).status, 403, 'parent → parent not allowed');
  const dm = await api('POST', `/ca/places/${shop.companyId}/dms`, { token: p.a.token, body: { member: `m${p.t.id}` } });
  assert.equal(dm.status, 201, JSON.stringify(dm.json));
  p.dm = dm.data.id;

  // "*" = anyone: VIP may message everybody
  await api('PATCH', '/customer-app/members/roles', { token: shop.token, body: { phones: [intl(p.b.local)], add: ['vip'] } });
  await api('PUT', '/customer-app/settings', { token: shop.token, body: { dm_rules: [['parent', 'teacher'], ['vip', '*']] } });
  assert.equal((await api('POST', `/ca/places/${shop.companyId}/dms`, { token: p.b.token, body: { member: `m${p.c.id}` } })).status, 201);
});

test('ticks and presence: sent → delivered (the other opened the app) → read; online / last seen; hiding last seen', async () => {
  // the teacher has not used the app since → "sent"
  p.phoneA = await phone(api, p.a.token);
  p.phoneT = await phone(api, p.t.token);
  await sql(`UPDATE ca_account SET last_active_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [p.t.id]);
  const sent = await sendDm(api, p.phoneA, p.dm, 'Hello sir, is class on tomorrow?');
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  let view = await api('GET', `/ca/dms/${p.dm}/messages`, as(p.a.token));
  assert.equal(view.data.messages.at(-1).status, 'sent');
  assert.equal(view.data.chat.online, false);
  assert.ok(view.data.chat.last_seen, 'last seen time');

  await api('GET', '/ca/me', as(p.t.token)); // the teacher's app is open → delivered
  await sql(`UPDATE ca_account SET last_active_at = NOW() WHERE id = $1`, [p.t.id]);
  view = await api('GET', `/ca/dms/${p.dm}/messages`, as(p.a.token));
  assert.equal(view.data.messages.at(-1).status, 'delivered');
  assert.equal(view.data.chat.online, true);

  await api('GET', `/ca/dms/${p.dm}/messages`, as(p.t.token)); // opened → read
  view = await api('GET', `/ca/dms/${p.dm}/messages`, as(p.a.token));
  assert.equal(view.data.messages.at(-1).status, 'read');

  await api('PATCH', '/ca/profile', { token: p.t.token, body: { show_last_seen: false } });
  view = await api('GET', `/ca/dms/${p.dm}/messages`, as(p.a.token));
  assert.equal(view.data.chat.online, false);
  assert.equal(view.data.chat.last_seen, null, 'hidden');
  const back = await api('GET', `/ca/dms/${p.dm}/messages`, as(p.t.token));
  assert.equal(back.data.chat.last_seen, null, 'who hides theirs does not see others either');
  await api('PATCH', '/ca/profile', { token: p.t.token, body: { show_last_seen: true } });
});

let group;
let inboxConversation;

test('groups: my messages show how many got and read them', async () => {
  group = (await api('POST', '/customer-app/groups', { token: shop.token, body: { name: 'Grade 10 parents', mode: 'chat' } })).data.id;
  await api('POST', `/customer-app/groups/${group}/members`, { token: shop.token, body: { account_ids: [p.a.id, p.b.id, p.c.id] } });
  const mine = await api('POST', `/ca/groups/${group}/messages`, { token: p.a.token, body: { text: 'Who has the maths paper?' } });
  assert.equal(mine.status, 201);
  let view = await api('GET', `/ca/groups/${group}/messages`, as(p.a.token));
  let seen = view.data.messages.at(-1).seen;
  assert.equal(seen.total, 2);
  assert.equal(seen.read, 0);
  await api('GET', `/ca/groups/${group}/messages`, as(p.b.token));
  view = await api('GET', `/ca/groups/${group}/messages`, as(p.a.token));
  seen = view.data.messages.at(-1).seen;
  assert.equal(seen.read, 1, 'Binura read it');
  assert.ok(seen.delivered >= 1);
  assert.equal(view.data.messages.at(-1).sender.kind, 'me');
  const other = await api('GET', `/ca/groups/${group}/messages`, as(p.b.token));
  assert.equal(other.data.messages.at(-1).seen, undefined, 'only for my own messages');
});

test('group chats are in the Inbox: member messages arrive with name + ID; an Inbox reply is posted in the group', async () => {
  const [cu] = await sql(`SELECT * FROM bot_channel_user WHERE company_id = $1 AND platform = 'app' AND external_user_id = $2`, [shop.companyId, `cag:${group}`]);
  assert.ok(cu, 'the group has an Inbox chat');
  assert.equal(cu.display_name, 'Grade 10 parents · group');
  assert.equal(cu.bot_enabled, false, 'the AI bot never answers a group');
  const rows = await until(async () => {
    const r = await sql(`SELECT m.*, c.id AS cid FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id WHERE c.bot_channel_user_id = $1 ORDER BY m.id`, [cu.id]);
    return r.length ? r : null;
  });
  assert.match(rows.at(-1).content, /^Amaya \(#[A-Z2-9]{6}\): Who has the maths paper\?$/);
  assert.equal(rows.at(-1).direction, 'inbound');
  inboxConversation = Number(rows.at(-1).cid);

  const reply = await api('POST', `/bot/conversations/${inboxConversation}/messages`, { token: shop.token, body: { text: 'I will share it tonight 📄' } });
  assert.ok([200, 201].includes(reply.status), JSON.stringify(reply.json));
  const posted = await until(async () => (await api('GET', `/ca/groups/${group}/messages`, as(p.c.token))).data.messages.find((m) => m.text === 'I will share it tonight 📄'));
  assert.ok(posted, 'the reply reached the group');
  assert.equal(posted.sender.kind, 'business');
  await wait(800);
  const copies = await sql(`SELECT COUNT(*)::int AS n FROM ca_group_message WHERE group_id = $1 AND text = 'I will share it tonight 📄'`, [group]);
  assert.equal(copies[0].n, 1, 'posted once');

  // a post from Channels → Customer app → Groups also shows in the Inbox (as the business)
  await api('POST', `/customer-app/groups/${group}/messages`, { token: shop.token, body: { text: 'Class at 3 pm' } });
  const out = await until(async () => (await sql(`SELECT * FROM bot_message WHERE conversation_id = $1 AND content = 'Class at 3 pm'`, [inboxConversation]))[0]);
  assert.equal(out.direction, 'outbound');
  await wait(800);
  assert.equal((await sql(`SELECT COUNT(*)::int AS n FROM ca_group_message WHERE group_id = $1 AND text = 'Class at 3 pm'`, [group]))[0].n, 1, 'not posted twice');
  // nobody can read the group's Inbox chat from the customer app
  assert.ok(!(await api('GET', '/ca/places', as(p.a.token))).data.some((x) => x.last?.text?.includes('maths paper')));
});

test('business chat shows when the team is online', async () => {
  await sql(`UPDATE app_user SET is_agent_active = TRUE WHERE company_id = $1`, [shop.companyId]);
  assert.equal((await api('GET', `/ca/places/${shop.companyId}/profile`, as(p.a.token))).data.team_online, true);
  await sql(`UPDATE app_user SET is_agent_active = FALSE WHERE company_id = $1`, [shop.companyId]);
  assert.equal((await api('GET', `/ca/places/${shop.companyId}/profile`, as(p.a.token))).data.team_online, false);
});
