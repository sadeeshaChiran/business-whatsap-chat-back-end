/**
 * Calls and meetings (LiveKit tokens): customer → business (any team member answers), business → customer, member ↔ member
 * only when they may message each other (with an end-to-end media key sealed for their phones), ringing → missed / answered
 * → ended with a line in the business chat, meetings for everyone / groups / roles, joining only when invited, host roles.
 * Run the API with LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET set (any values) and OTP_DEV_MODE=true.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { api, closeDb, createAgent, createWorkspace, sql } from './helpers.mjs';
import { encrypt, phone } from './e2ee.mjs';

const rnd = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const intl = (local) => `94${local.slice(1)}`;
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
let shop; let slug;
const p = {};

async function login(local, name) {
  const start = await api('POST', '/ca/auth/start', { body: { phone: local, app: slug } });
  const v = await api('POST', '/ca/auth/verify', { body: { phone: local, code: start.data.dev_code, name, app: slug } });
  return { token: v.data.token, id: v.data.account.id, local };
}

test.before(async () => {
  shop = await createWorkspace('ca-calls');
  await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [shop.companyId]);
  slug = `call-${randomBytes(3).toString('hex')}`;
  await api('PUT', '/customer-app/settings', { token: shop.token, body: { enabled: true, slug, member_dm: true, dm_mode: 'roles', dm_rules: [['parent', 'teacher']] } });
  const l = { a: rnd(), b: rnd(), t: rnd() };
  await api('POST', '/customer-app/members', { token: shop.token, body: { phones: Object.values(l).join(',') } });
  p.a = await login(l.a, 'Amaya'); p.b = await login(l.b, 'Binura'); p.t = await login(l.t, 'Mr Perera');
  await api('PATCH', '/customer-app/members/roles', { token: shop.token, body: { phones: [intl(l.a), intl(l.b)], roles: ['parent'] } });
  await api('PATCH', '/customer-app/members/roles', { token: shop.token, body: { phones: [intl(l.t)], roles: ['teacher'] } });
});
test.after(async () => { await closeDb(); });

test('customer calls the business: rings for the team, one member answers, both get tokens for the same room; a line in the chat', async () => {
  const cfg = await api('GET', '/ca/calls/config', { token: p.a.token });
  assert.equal(cfg.data.enabled, true);
  const call = await api('POST', `/ca/places/${shop.companyId}/call`, { token: p.a.token, body: { video: true } });
  assert.equal(call.status, 201, JSON.stringify(call.json));
  const c = claims(call.data.token);
  assert.equal(c.sub, `ca-${p.a.id}`);
  assert.equal(c.video.room, call.data.room);
  assert.equal(c.video.roomJoin, true);
  assert.notEqual(c.video.roomAdmin, true);
  const ringing = await api('GET', '/customer-app/calls/ringing', { token: shop.token });
  assert.equal(ringing.data[0].id, call.data.call.id);
  assert.equal(ringing.data[0].from, 'Amaya');
  const ans = await api('POST', `/customer-app/calls/${call.data.call.id}/answer`, { token: shop.token });
  assert.equal(ans.status, 201, JSON.stringify(ans.json));
  assert.equal(claims(ans.data.token).video.room, call.data.room);
  assert.equal((await api('GET', `/ca/calls/${call.data.call.id}`, { token: p.a.token })).data.status, 'active');
  assert.equal((await api('GET', `/ca/calls/${call.data.call.id}`, { token: p.b.token })).status, 404, 'other customers can not see it');
  await api('POST', `/ca/calls/${call.data.call.id}/end`, { token: p.a.token });
  const chat = await api('GET', `/ca/places/${shop.companyId}/messages`, { token: p.a.token });
  assert.match(chat.data.messages.at(-1).text, /^📹 Video call · \d+:\d\d$/);
});

test('the business calls a customer: it rings in their app; a missed call is logged', async () => {
  const r = await api('POST', '/customer-app/calls', { token: shop.token, body: { account_id: p.b.id } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const incoming = await api('GET', '/ca/calls/incoming', { token: p.b.token });
  assert.equal(incoming.data[0].id, r.data.call.id);
  assert.equal(incoming.data[0].from.startsWith('ca-calls'), true);
  assert.equal((await api('GET', '/ca/calls/incoming', { token: p.a.token })).data.length, 0);
  await api('POST', `/customer-app/calls/${r.data.call.id}/end`, { token: shop.token });
  const chat = await api('GET', `/ca/places/${shop.companyId}/messages`, { token: p.b.token });
  assert.equal(chat.data.messages.at(-1).text, '📞 Voice call · missed');
  assert.equal((await api('POST', '/customer-app/calls', { token: shop.token, body: { account_id: 999999999 } })).status, 404);
  // another team member can not join a colleague's call with a customer
  const own = await api('POST', '/customer-app/calls', { token: shop.token, body: { account_id: p.b.id } });
  const colleague = await createAgent(shop, 'ca-calls-b');
  assert.equal((await api('POST', `/customer-app/calls/${own.data.call.id}/answer`, { token: colleague.token })).status, 400);
  await api('POST', `/customer-app/calls/${own.data.call.id}/end`, { token: shop.token });
  assert.equal((await api('POST', `/customer-app/calls/${own.data.call.id}/answer`, { token: shop.token })).status, 400, 'an ended call can not be rejoined');
  // from the Inbox: the call button sends the chat (conversation) id
  const ringing = await api('GET', '/customer-app/calls/ringing', { token: shop.token });
  assert.equal(ringing.data.length, 0);
  await api('POST', `/ca/places/${shop.companyId}/call`, { token: p.a.token, body: { video: false } });
  const [rang] = (await api('GET', '/customer-app/calls/ringing', { token: shop.token })).data;
  const conversation_id = rang.conversation_id;
  assert.ok(conversation_id, 'ringing calls carry the Inbox chat id');
  await api('POST', `/customer-app/calls/${rang.id}/end`, { token: shop.token });
  const byChat = await api('POST', '/customer-app/calls', { token: shop.token, body: { conversation_id, video: true } });
  assert.equal(byChat.status, 201, JSON.stringify(byChat.json));
  assert.equal((await api('GET', '/ca/calls/incoming', { token: p.a.token })).data[0].id, byChat.data.call.id);
  await api('POST', `/customer-app/calls/${byChat.data.call.id}/end`, { token: shop.token });
});

test('member calls follow the message rules and carry a sealed media key', async () => {
  const a = await phone(api, p.a.token); await phone(api, p.t.token);
  const dm = (await api('POST', `/ca/places/${shop.companyId}/dms`, { token: p.a.token, body: { member: `m${p.t.id}` } })).data.id;
  assert.equal((await api('POST', `/ca/dms/${dm}/call`, { token: p.a.token, body: {} })).status, 400, 'no media key → refused');
  const keys = (await api('GET', `/ca/dms/${dm}/keys`, { token: p.a.token })).data.devices;
  const { cipher } = await encrypt(a, keys, { t: 'media-key' });
  const e2ee = { v: 1, sender_pub: cipher.sender_pub, sender_device: cipher.sender_device, keys: cipher.keys };
  const call = await api('POST', `/ca/dms/${dm}/call`, { token: p.a.token, body: { video: false, e2ee } });
  assert.equal(call.status, 201, JSON.stringify(call.json));
  const ring = await api('GET', '/ca/calls/incoming', { token: p.t.token });
  assert.equal(ring.data[0].id, call.data.call.id);
  assert.deepEqual(Object.keys(ring.data[0].e2ee.keys).sort(), Object.keys(e2ee.keys).sort());
  const ans = await api('POST', `/ca/calls/${call.data.call.id}/answer`, { token: p.t.token });
  assert.equal(claims(ans.data.token).video.room, call.data.room);
  assert.equal((await api('POST', `/ca/calls/${call.data.call.id}/answer`, { token: p.b.token })).status, 404);
  // two parents may not message → may not call either
  const bad = await api('POST', `/ca/places/${shop.companyId}/dms`, { token: p.a.token, body: { member: `m${p.b.id}` } });
  assert.equal(bad.status, 403);
});

let meeting;

test('a call nobody answers is closed as missed by itself and noted in the chat', async () => {
  const c = await api('POST', `/ca/places/${shop.companyId}/call`, { token: p.b.token, body: { video: false } });
  await sql(`UPDATE ca_call SET created_at = NOW() - INTERVAL '2 minutes' WHERE id = $1`, [c.data.call.id]);
  await api('GET', '/customer-app/calls/ringing', { token: shop.token });
  const [row] = await sql(`SELECT status, ended_at FROM ca_call WHERE id = $1`, [c.data.call.id]);
  assert.equal(row.status, 'missed');
  assert.ok(row.ended_at);
  const chat = await api('GET', `/ca/places/${shop.companyId}/messages`, { token: p.b.token });
  assert.equal(chat.data.messages.at(-1).text, '📞 Voice call · missed');
  assert.equal((await api('POST', `/customer-app/calls/${c.data.call.id}/answer`, { token: shop.token })).status, 400);
});

test('meetings: the team schedules one for a role; invited people join, others can not; host roles; share to a group', async () => {
  const m = await api('POST', '/customer-app/meetings', { token: shop.token, body: { title: 'Parents meeting', minutes: 45, audience: { roles: ['parent'] } } });
  assert.equal(m.status, 201, JSON.stringify(m.json));
  meeting = m.data;
  assert.equal(meeting.state, 'open');
  const list = await api('GET', `/ca/places/${shop.companyId}/meetings`, { token: p.a.token });
  assert.ok(list.data.items.some((x) => x.code === meeting.code));
  assert.ok(!(await api('GET', `/ca/places/${shop.companyId}/meetings`, { token: p.t.token })).data.items.some((x) => x.code === meeting.code), 'not for teachers');
  const join = await api('POST', `/ca/meetings/${meeting.code}/join`, { token: p.a.token });
  assert.equal(join.status, 201, JSON.stringify(join.json));
  assert.equal(claims(join.data.token).video.room, `ca-${shop.companyId}-meet-${meeting.code}`);
  assert.equal((await api('POST', `/ca/meetings/${meeting.code}/join`, { token: p.t.token })).status, 403);
  const staff = await api('POST', `/customer-app/meetings/${meeting.id}/join`, { token: shop.token });
  assert.equal(claims(staff.data.token).video.roomAdmin, true, 'the business hosts');

  // share into a group → its members (the teacher) may join too
  const g = (await api('POST', '/customer-app/groups', { token: shop.token, body: { name: 'Staff room', mode: 'chat' } })).data.id;
  await api('POST', `/customer-app/groups/${g}/members`, { token: shop.token, body: { account_ids: [p.t.id] } });
  const shared = await api('POST', `/customer-app/meetings/${meeting.id}/share`, { token: shop.token, body: { group_ids: [g] } });
  assert.equal(shared.data.shared, 1);
  const posted = await api('GET', `/ca/groups/${g}/messages`, { token: p.t.token });
  assert.match(posted.data.messages.at(-1).text, new RegExp(`/app/${slug}/meet/${meeting.code}`));
  assert.equal((await api('POST', `/ca/meetings/${meeting.code}/join`, { token: p.t.token })).status, 201);

  // customers start meetings only with a host role
  assert.equal((await api('POST', `/ca/places/${shop.companyId}/meetings`, { token: p.t.token, body: { title: 'Extra class', audience: { group_ids: [g] } } })).status, 403);
  await api('PUT', '/customer-app/meetings/hosts', { token: shop.token, body: { roles: ['teacher'] } });
  const own = await api('POST', `/ca/places/${shop.companyId}/meetings`, { token: p.t.token, body: { title: 'Extra class', audience: { group_ids: [g], all: true } } });
  assert.equal(own.status, 201, JSON.stringify(own.json));
  assert.equal(own.data.audience, undefined, 'customers never see the invite list');
  const [saved] = await sql(`SELECT audience FROM ca_meeting WHERE id = $1`, [own.data.id]);
  assert.equal(saved.audience.all, false, 'a customer host can only invite their own groups / people');
  const hostJoin = await api('POST', `/ca/meetings/${own.data.code}/join`, { token: p.t.token });
  assert.equal(hostJoin.status, 201);
  assert.notEqual(claims(hostJoin.data.token).video.roomAdmin, true, 'a customer host can not mute or remove the business team');
  assert.ok(claims(hostJoin.data.token).exp - Date.now() / 1000 < 3 * 3600, 'meeting tokens end an hour after the meeting');
  assert.equal((await api('POST', `/ca/meetings/${own.data.code}/join`, { token: p.b.token })).status, 403);
  await api('DELETE', `/customer-app/meetings/${meeting.id}`, { token: shop.token });
  assert.equal((await api('POST', `/ca/meetings/${meeting.code}/join`, { token: p.a.token })).status, 404, 'cancelled');
});
