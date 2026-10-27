/**
 * Customer app part 5: the business's own team inside its app (owner by the account's mobile number, agents by the
 * number the owner saved – confirmed with the SMS login), Inbox app chats + replies from the app, agents only their
 * chats; members of a group with a private member list may still message each other when the business allows it;
 * the install head script (own name / manifest for "Add to Home Screen").
 * Run the API with OTP_DEV_MODE=true.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { api, closeDb, createAgent, createWorkspace, sql } from './helpers.mjs';

const rnd = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const local = (intl) => `0${intl.slice(2)}`;
let shop; let slug; let other;
const p = {};

async function login(phone, name, app = slug) {
  const start = await api('POST', '/ca/auth/start', { body: { phone, app } });
  if (start.status !== 201) return { status: start.status, message: start.json?.message };
  const v = await api('POST', '/ca/auth/verify', { body: { phone, code: start.data.dev_code, name, app } });
  return { status: v.status, token: v.data.token, id: v.data.account.id, phone };
}

test.before(async () => {
  shop = await createWorkspace('ca-team');
  await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [shop.companyId]);
  slug = `team-${randomBytes(3).toString('hex')}`;
  await api('PUT', '/customer-app/settings', { token: shop.token, body: { enabled: true, slug, member_dm: true, dm_mode: 'groups' } });
  const l = { a: rnd(), b: rnd() };
  await api('POST', '/customer-app/members', { token: shop.token, body: { phones: Object.values(l).join(',') } });
  p.a = await login(l.a, 'Amaya'); p.b = await login(l.b, 'Binura');
  other = await createWorkspace('ca-team-other');
});
test.after(async () => { await closeDb(); });

test('same group, private member list: members still see and message each other when the business allows it', async () => {
  const g = (await api('POST', '/customer-app/groups', { token: shop.token, body: { name: 'Class 5', mode: 'chat', show_members: false } })).data.id;
  await api('POST', `/customer-app/groups/${g}/members`, { token: shop.token, body: { account_ids: [p.a.id, p.b.id] } });
  const list = await api('GET', `/ca/groups/${g}/members`, { token: p.a.token });
  assert.equal(list.status, 200, JSON.stringify(list.json));
  const b = list.data.find((m) => m.id === `m${p.b.id}`);
  assert.ok(b?.can_message, 'the other member is listed with a Message button');
  const people = await api('GET', `/ca/places/${shop.companyId}/people`, { token: p.a.token });
  assert.ok(people.data.items.some((x) => x.member === `m${p.b.id}`));
  const dm = await api('POST', `/ca/places/${shop.companyId}/dms`, { token: p.a.token, body: { member: `m${p.b.id}` } });
  assert.equal(dm.status, 201, JSON.stringify(dm.json));
  // member messages off → the private list stays private
  await api('PUT', '/customer-app/settings', { token: shop.token, body: { member_dm: false } });
  assert.equal((await api('GET', `/ca/groups/${g}/members`, { token: p.a.token })).status, 403);
  await api('PUT', '/customer-app/settings', { token: shop.token, body: { member_dm: true } });
});

test('the owner logs into the app with the account mobile: works as the business (chats, reply, read)', async () => {
  const ownerPhone = shop.user.whatsapp_number ?? (await sql(`SELECT whatsapp_number FROM app_user WHERE id = $1`, [shop.user.id]))[0].whatsapp_number;
  const owner = await login(local(ownerPhone), 'Owner');
  assert.equal(owner.status, 201, 'not on the customer list, still allowed in');
  const place = await api('GET', `/ca/places/${shop.companyId}/messages`, { token: owner.token });
  assert.equal(place.data.place.team.role, 'admin');
  const me = await api('GET', `/ca/team/${shop.companyId}`, { token: owner.token });
  assert.equal(me.data.role, 'admin');
  assert.equal(me.data.can_meet, true);

  await api('POST', `/ca/places/${shop.companyId}/messages`, { token: p.a.token, body: { text: 'Is the shop open today?' } });
  const chats = await api('GET', `/ca/team/${shop.companyId}/chats`, { token: owner.token });
  const chat = chats.data.find((c) => c.kind === 'customer' && c.last.text === 'Is the shop open today?');
  assert.ok(chat, JSON.stringify(chats.data));
  assert.ok(chat.unread >= 1);
  const thread = await api('GET', `/ca/team/${shop.companyId}/chats/${chat.id}`, { token: owner.token });
  assert.equal(thread.data.chat.kind, 'customer');
  assert.equal(thread.data.messages.at(-1).mine, false);
  const sent = await api('POST', `/ca/team/${shop.companyId}/chats/${chat.id}/messages`, { token: owner.token, body: { text: 'Yes, until 8 pm.' } });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  await api('POST', `/ca/team/${shop.companyId}/chats/${chat.id}/read`, { token: owner.token });
  const seen = await api('GET', `/ca/places/${shop.companyId}/messages`, { token: p.a.token });
  assert.equal(seen.data.messages.at(-1).text, 'Yes, until 8 pm.');
  assert.equal(seen.data.messages.find((m) => m.text === 'Is the shop open today?').status, 'read');
  assert.equal((await api('GET', `/ca/team/${shop.companyId}/chats`, { token: owner.token })).data.find((c) => c.id === chat.id).unread, 0);
  p.chat = chat.id;
});

test('group chats show who wrote each message', async () => {
  const g = (await api('POST', '/customer-app/groups', { token: shop.token, body: { name: 'Parents', mode: 'chat' } })).data.id;
  await api('POST', `/customer-app/groups/${g}/members`, { token: shop.token, body: { account_ids: [p.a.id] } });
  await api('POST', `/ca/groups/${g}/messages`, { token: p.a.token, body: { text: 'Hello all' } });
  const owner = await login(local(shop.user.whatsapp_number ?? (await sql(`SELECT whatsapp_number FROM app_user WHERE id = $1`, [shop.user.id]))[0].whatsapp_number));
  const chats = await api('GET', `/ca/team/${shop.companyId}/chats`, { token: owner.token });
  const gc = chats.data.find((c) => c.kind === 'group' && c.name === 'Parents');
  assert.ok(gc, JSON.stringify(chats.data.map((c) => c.name)));
  assert.equal(gc.last.text, 'Hello all');
  assert.equal(gc.last.sender.name, 'Amaya');
  const thread = await api('GET', `/ca/team/${shop.companyId}/chats/${gc.id}`, { token: owner.token });
  const last = thread.data.messages.at(-1);
  assert.equal(last.text, 'Hello all');
  assert.match(last.sender, /^Amaya · #/);
  assert.equal(thread.data.chat.group_id, g);
});

test('agents: the owner saves their mobile, they log in with the SMS code and see only their chats', async () => {
  const agent = await createAgent(shop, 'ca-team-agent');
  const mobile = rnd();
  assert.equal((await api('PUT', `/customer-app/team/${agent.id}/mobile`, { token: agent.token, body: { mobile } })).status, 403, 'only the owner');
  const saved = await api('PUT', `/customer-app/team/${agent.id}/mobile`, { token: shop.token, body: { mobile } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  let team = (await api('GET', '/customer-app/team', { token: shop.token })).data;
  assert.equal(team.find((m) => m.id === agent.id).verified, false);
  assert.equal(team.find((m) => m.owner).editable, false);
  const dup = await api('PUT', `/customer-app/team/${agent.id}/mobile`, { token: shop.token, body: { mobile: local(team.find((m) => m.owner).mobile) } });
  assert.equal(dup.status, 409, 'not the owner\'s number');

  const app = await login(mobile, 'Agent');
  assert.equal(app.status, 201);
  team = (await api('GET', '/customer-app/team', { token: shop.token })).data;
  assert.equal(team.find((m) => m.id === agent.id).verified, true, 'the SMS login confirmed it');
  const me = await api('GET', `/ca/team/${shop.companyId}`, { token: app.token });
  assert.equal(me.data.role, 'agent');
  assert.equal(me.data.can_meet, false);
  assert.equal((await api('GET', `/ca/team/${shop.companyId}/chats`, { token: app.token })).data.length, 0, 'nothing assigned yet');
  assert.equal((await api('GET', `/ca/team/${shop.companyId}/chats/${p.chat}`, { token: app.token })).status, 403);
  await sql(`UPDATE bot_conversation SET assigned_agent_id = $2 WHERE id = $1`, [p.chat, agent.id]);
  const mine = await api('GET', `/ca/team/${shop.companyId}/chats`, { token: app.token });
  assert.deepEqual(mine.data.map((c) => c.id), [p.chat]);
  assert.equal((await api('POST', `/ca/team/${shop.companyId}/meetings`, { token: app.token, body: { title: 'x' } })).status, 403);
  // a customer's number can't become a team login
  assert.equal((await api('PUT', `/customer-app/team/${agent.id}/mobile`, { token: shop.token, body: { mobile: p.b.phone } })).status, 409);
  // meetings: agents join as participants, never as host
  const m = await api('POST', '/customer-app/meetings', { token: shop.token, body: { title: 'Team sync', minutes: 30, audience: { all: true } } });
  const joined = await api('POST', `/ca/team/${shop.companyId}/meetings/${m.data.id}/join`, { token: app.token });
  assert.equal(joined.status, 201, JSON.stringify(joined.json));
  const claims = JSON.parse(Buffer.from(joined.data.token.split('.')[1], 'base64url').toString());
  assert.notEqual(claims.video.roomAdmin, true);
  // calls: an agent only sees / answers calls of chats that are theirs
  await api('POST', `/ca/places/${shop.companyId}/messages`, { token: p.b.token, body: { text: 'Hello' } });
  const fromB = await api('POST', `/ca/places/${shop.companyId}/call`, { token: p.b.token, body: { video: false } });
  const bChat = (await sql(`SELECT bc.id FROM bot_conversation bc JOIN bot_channel_user cu ON cu.id = bc.bot_channel_user_id WHERE cu.external_user_id = $1 ORDER BY bc.id DESC LIMIT 1`, [`ca:${p.b.id}`]))[0];
  assert.ok(bChat);
  await sql(`UPDATE bot_conversation SET assigned_agent_id = $2 WHERE id = $1`, [bChat.id, shop.user.id]);
  const ring = await api('GET', `/ca/team/${shop.companyId}/calls/ringing`, { token: app.token });
  assert.ok(!ring.data.some((c) => c.id === fromB.data.call.id), 'not the agent\'s chat');
  assert.equal((await api('POST', `/ca/team/${shop.companyId}/calls/${fromB.data.call.id}/answer`, { token: app.token })).status, 404);
  await api('POST', `/ca/calls/${fromB.data.call.id}/end`, { token: p.b.token });

  // access removed in the dashboard → out of the app's team too
  await sql(`UPDATE app_user SET access_disabled = TRUE WHERE id = $1`, [agent.id]);
  await new Promise((r) => setTimeout(r, 21_000));
  assert.equal((await api('GET', `/ca/team/${shop.companyId}`, { token: app.token })).status, 403);
});

test('customers and other businesses\' teams are not the team', async () => {
  assert.equal((await api('GET', `/ca/team/${shop.companyId}`, { token: p.a.token })).status, 403);
  assert.equal((await api('GET', `/ca/team/${shop.companyId}/chats`, { token: p.b.token })).status, 403);
  const otherOwner = (await sql(`SELECT whatsapp_number FROM app_user WHERE id = $1`, [other.user.id]))[0].whatsapp_number;
  const r = await login(local(otherOwner), 'Other');
  assert.equal(r.status, 403, 'not on this app\'s list and not its team');
});

test('"Add to Home Screen": the head script writes the app\'s own name and manifest', async () => {
  const r = await api('GET', `/ca/app/${slug}/head.js?o=${encodeURIComponent('http://localhost:5173')}`, { raw: true });
  assert.equal(r.status, 200);
  assert.match(r.text, /window\.__caApp=/);
  assert.match(r.text, /manifest\.webmanifest/);
  assert.match(r.text, /apple-mobile-web-app-title/);
  assert.doesNotMatch(r.text, /<\/script/i);
  const m = await api('GET', `/ca/app/${slug}/manifest.webmanifest?o=${encodeURIComponent('http://localhost:5173')}`, { raw: true });
  const manifest = JSON.parse(m.text);
  assert.equal(manifest.start_url, `http://localhost:5173/app/${slug}/`);
  const none = await api('GET', '/ca/app/no-such-app/head.js', { raw: true });
  assert.equal(none.status, 200);
  assert.doesNotMatch(none.text, /document\.write/);
});
