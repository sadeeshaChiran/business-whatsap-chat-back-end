/**
 * Customer app part 3: every business's own app (address, name, colour, icon, install manifest), only the numbers the business
 * added can log in (or anyone with its link when it allows that), the "has the app / not yet" list, member IDs, member-to-member
 * messages (off by default), block, report, broadcasts and phone notifications.
 * Run with the API (OTP_DEV_MODE=true):  node --test test/customer-app-3.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { api, closeDb, createWorkspace, sql } from './helpers.mjs';
import { phone, readDm, sendDm } from './e2ee.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const rnd = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const intl = (local) => `94${local.slice(1)}`;
const as = (token) => ({ token });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) { const v = await check(); if (v || Date.now() > end) return v; await wait(150); }
}

let shop; // invite-only app
let club; // "anyone with the link"
let slug;
const people = {};

async function contact(ws, label, local, tags = []) {
  const [cu] = await sql(`INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name, language, language_locked, bot_enabled, manual_mode, created_at, updated_at)
    VALUES ($1, 'whatsapp', $2, $3, 'English', false, false, false, NOW(), NOW()) RETURNING id`, [ws.companyId, intl(local), label]);
  if (tags.length) await sql(`INSERT INTO crm_contact (bot_channel_user_id, company_id, tags, updated_at) VALUES ($1, $2, $3, NOW())`, [cu.id, ws.companyId, tags]);
  return Number(cu.id);
}
async function login(local, name, app) {
  const start = await api('POST', '/ca/auth/start', { body: { phone: local, app } });
  assert.equal(start.status, 201, JSON.stringify(start.json));
  const v = await api('POST', '/ca/auth/verify', { body: { phone: local, code: start.data.dev_code, name, app } });
  assert.equal(v.status, 201, JSON.stringify(v.json));
  return { token: v.data.token, id: v.data.account.id, local };
}

test.before(async () => {
  shop = await createWorkspace('ca3-shop');
  club = await createWorkspace('ca3-club');
  for (const ws of [shop, club]) await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [ws.companyId]);
  for (const key of ['a', 'b', 'c', 'n']) people[key] = { local: rnd() };
  people.a.contact = await contact(shop, 'Amaya', people.a.local, ['grade10']);
  people.b.contact = await contact(shop, 'Binura', people.b.local, ['grade10']);
  people.c.contact = await contact(shop, 'Chathu', people.c.local, []);
  people.n.contact = await contact(shop, 'Nimal (no app)', people.n.local, ['grade10']);
});
test.after(async () => { await closeDb(); });

test('own app: an address is made from the name; owner sets name, colour, address; public page shows only the face', async () => {
  const s = await api('GET', '/customer-app/settings', as(shop.token));
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.match(s.data.slug, /^ca3-shop/);
  assert.equal(s.data.access, 'invited', 'only added numbers by default');
  assert.equal(s.data.member_dm, false, 'member messages are off by default');
  slug = `ca3-${randomBytes(3).toString('hex')}`;
  assert.equal((await api('PUT', '/customer-app/settings', { token: shop.token, body: { slug: 'Bad Address!' } })).status, 400);
  assert.equal((await api('PUT', '/customer-app/settings', { token: shop.token, body: { slug: 'chat' } })).status, 400, 'reserved');
  assert.equal((await api('PUT', '/customer-app/settings', { token: shop.token, body: { theme_color: 'red' } })).status, 400);
  const saved = await api('PUT', '/customer-app/settings', { token: shop.token, body: { enabled: true, slug, app_name: 'Nimal Sir Maths', theme_color: '#0f766e', welcome_text: 'Welcome!' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.data.slug, slug);
  const clubSlug = (await api('GET', '/customer-app/settings', as(club.token))).data.slug;
  assert.equal((await api('PUT', '/customer-app/settings', { token: club.token, body: { slug } })).status, 400, 'taken by another business');
  await api('PUT', '/customer-app/settings', { token: club.token, body: { enabled: true, access: 'link', slug: clubSlug } });

  const info = await api('GET', `/ca/app/${slug}`);
  assert.equal(info.status, 200, JSON.stringify(info.json));
  assert.equal(info.data.name, 'Nimal Sir Maths');
  assert.equal(info.data.theme_color, '#0f766e');
  assert.equal(info.data.company_id, shop.companyId);
  assert.ok(!JSON.stringify(info.json).includes('94'), 'no numbers on the public page');
  assert.equal((await api('GET', '/ca/app/no-such-app-here')).status, 404);
});

test('home-screen icon and install manifest: own name, colour and icon, opens straight into the app', async () => {
  const bad = new FormData(); bad.append('icon', new Blob(['x'], { type: 'image/jpeg' }), 'x.jpg');
  assert.equal((await api('POST', '/customer-app/icon', { token: shop.token, form: bad })).status, 400, 'PNG only');
  const icon = new FormData(); icon.append('icon', new Blob([PNG], { type: 'image/png' }), 'icon.png');
  const up = await api('POST', '/customer-app/icon', { token: shop.token, form: icon });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  const m = await api('GET', `/ca/app/${slug}/manifest.webmanifest?o=http://app.test`, { raw: true });
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /manifest\+json/);
  const manifest = JSON.parse(m.text);
  assert.equal(manifest.name, 'Nimal Sir Maths');
  assert.equal(manifest.start_url, `http://app.test/app/${slug}/`);
  assert.equal(manifest.scope, `http://app.test/app/${slug}/`);
  assert.equal(manifest.theme_color, '#0f766e');
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.icons[0].src, /^icon\.png\?v=/, 'icon next to the manifest');
  const evil = JSON.parse((await api('GET', `/ca/app/${slug}/manifest.webmanifest?o=https://evil.example`, { raw: true })).text);
  assert.ok(!evil.start_url.includes('evil'), 'only our own web address');
  const png = await fetch(`${process.env.API_URL || 'http://localhost:3001/v1/api'}/ca/app/${slug}/icon.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG);
});

test('only added numbers: no SMS for others; add by tag / chosen contacts / typed number; who has the app', async () => {
  const no = await api('POST', '/ca/auth/start', { body: { phone: people.a.local, app: slug } });
  assert.equal(no.status, 403);
  assert.match(no.json.message, /not on Nimal Sir Maths's list/);
  assert.equal((await sql(`SELECT 1 FROM ca_login_code WHERE phone = $1`, [intl(people.a.local)])).length, 0, 'no SMS was sent');

  const contacts = await api('GET', '/customer-app/contacts', as(shop.token));
  assert.equal(contacts.status, 200, JSON.stringify(contacts.json));
  assert.equal(contacts.data.total, 4);
  assert.ok(contacts.data.tags.some((t) => t.tag === 'grade10'));
  assert.ok(contacts.data.items.every((c) => !c.added));

  const byTag = await api('POST', '/customer-app/members', { token: shop.token, body: { tags: ['grade10'] } });
  assert.equal(byTag.status, 201, JSON.stringify(byTag.json));
  assert.equal(byTag.data.added_now, 3, 'Amaya, Binura, Nimal');
  const picked = await api('POST', '/customer-app/members', { token: shop.token, body: { contact_ids: [people.c.contact, people.a.contact] } });
  assert.equal(picked.data.added_now, 1, 'Chathu (Amaya was already added)');
  const typed = await api('POST', '/customer-app/members', { token: shop.token, body: { phones: '0771234, 077 999 8888' } });
  assert.deepEqual(typed.data.invalid, ['0771234']);
  assert.equal(typed.data.added_now, 1);
  assert.equal((await api('POST', '/customer-app/members', { token: shop.token, body: {} })).status, 400);

  people.a = { ...people.a, ...(await login(people.a.local, 'Amaya', slug)) };
  people.b = { ...people.b, ...(await login(people.b.local, 'Binura', slug)) };
  people.c = { ...people.c, ...(await login(people.c.local, 'Chathu', slug)) };
  const list = await api('GET', '/customer-app/members', as(shop.token));
  assert.equal(list.data.counts.added, 5);
  assert.equal(list.data.counts.on_app, 3);
  assert.equal(list.data.counts.not_on_app, 2, 'Nimal and the typed number');
  const notYet = await api('GET', '/customer-app/members?status=not_on_app', as(shop.token));
  assert.ok(notYet.data.items.some((m) => m.phone === `+${intl(people.n.local)}`));
  assert.ok(notYet.data.items.every((m) => !m.on_app));
  const [row] = await sql(`SELECT joined_at FROM ca_app_member WHERE company_id = $1 AND phone = $2`, [shop.companyId, intl(people.a.local)]);
  assert.ok(row.joined_at, 'marked "has the app"');
});

test('opening apps: own app opens; another business that did not add the number says so', async () => {
  assert.equal((await api('POST', `/ca/app/${slug}/open`, as(people.a.token))).status, 201);
  const other = await api('GET', '/customer-app/settings', as(club.token));
  // the club lets anyone with its link in → opening it adds the number
  const opened = await api('POST', `/ca/app/${other.data.slug}/open`, as(people.a.token));
  assert.equal(opened.status, 201, JSON.stringify(opened.json));
  assert.equal((await sql(`SELECT source FROM ca_app_member WHERE company_id = $1 AND phone = $2`, [club.companyId, intl(people.a.local)]))[0].source, 'link');
  // a brand-new number can log in to the club app straight away
  const freshLocal = rnd();
  const fresh = await login(freshLocal, 'New person', other.data.slug);
  assert.ok((await api('GET', '/ca/places', as(fresh.token))).data.some((p) => p.id === club.companyId));
  assert.equal((await api('POST', `/ca/app/${slug}/open`, as(fresh.token))).status, 403, 'not on the shop list');
  assert.equal((await api('GET', `/ca/places/${shop.companyId}/messages`, as(fresh.token))).status, 403);
  // the shop types that number: it does not learn that the person uses another business's app, nor their name there
  await api('POST', '/customer-app/members', { token: shop.token, body: { phones: [freshLocal] } });
  const seen = (await api('GET', `/customer-app/members?q=${freshLocal}`, as(shop.token))).data.items[0];
  assert.equal(seen.on_app, false);
  assert.equal(seen.name, null);
  await api('DELETE', `/customer-app/members/${intl(freshLocal)}`, as(shop.token));
  // the club removes the person → the link does not bring them back
  assert.equal((await api('DELETE', `/customer-app/members/${intl(freshLocal)}`, as(club.token))).status, 200);
  assert.equal((await api('POST', `/ca/app/${other.data.slug}/open`, as(fresh.token))).status, 403, 'removed stays removed');
  assert.equal((await api('POST', '/ca/auth/start', { body: { phone: freshLocal, app: other.data.slug } })).status, 403);
  await api('POST', '/customer-app/members', { token: club.token, body: { phones: [freshLocal] } });
  assert.equal((await api('POST', `/ca/app/${other.data.slug}/open`, as(fresh.token))).status, 201, 'added back by the business');
  people.fresh = fresh;
});

let group;
let dmId;
let dmMessage;

test('member IDs: hidden names show an ID, never a number', async () => {
  group = (await api('POST', '/customer-app/groups', { token: shop.token, body: { name: 'Grade 10 chat', mode: 'chat', show_members: true } })).data.id;
  const add = await api('POST', `/customer-app/groups/${group}/members`, { token: shop.token, body: { tags: ['grade10'] } });
  assert.equal(add.data.added, 2, 'Amaya and Binura (Nimal has no app yet)');
  assert.equal(add.data.not_on_app, 1);
  await api('PATCH', '/ca/profile', { token: people.b.token, body: { show_name: false } });
  const members = await api('GET', `/ca/groups/${group}/members`, as(people.a.token));
  const b = members.data.find((m) => m.id === `m${people.b.id}`);
  assert.match(b.name, /^Member #[A-Z2-9]{6}$/);
  assert.equal(b.code, b.name.slice(8));
  assert.equal(b.can_message, false, 'member messages are off');
  const raw = JSON.stringify(members.json);
  for (const p of [people.a, people.b]) assert.ok(!raw.includes(intl(p.local)));
  const profile = await api('GET', `/ca/places/${shop.companyId}/profile`, as(people.b.token));
  assert.equal(profile.data.member_code, b.code, 'the same ID on my profile');
});

test('member messages: off by default; on → only with group members; block; "don\'t message me"; report goes to the business', async () => {
  assert.equal((await api('POST', `/ca/places/${shop.companyId}/dms`, { token: people.a.token, body: { member: `m${people.b.id}` } })).status, 403, 'off by default');
  await api('PUT', '/customer-app/settings', { token: shop.token, body: { member_dm: true } });
  const members = await api('GET', `/ca/groups/${group}/members`, as(people.a.token));
  assert.equal(members.data.find((m) => m.id === `m${people.b.id}`).can_message, true);

  assert.equal((await api('POST', `/ca/places/${shop.companyId}/dms`, { token: people.a.token, body: { member: `m${people.c.id}` } })).status, 403, 'Chathu is in none of my groups');
  const start = await api('POST', `/ca/places/${shop.companyId}/dms`, { token: people.a.token, body: { member: `m${people.b.id}` } });
  assert.equal(start.status, 201, JSON.stringify(start.json));
  dmId = start.data.id;
  const again = await api('POST', `/ca/places/${shop.companyId}/dms`, { token: people.b.token, body: { member: `m${people.a.id}` } });
  assert.equal(again.data.id, dmId, 'one chat per pair');
  // member chats are end-to-end encrypted: each phone has its own key
  const phoneA = await phone(api, people.a.token);
  const phoneB = await phone(api, people.b.token);
  assert.equal((await api('POST', `/ca/dms/${dmId}/messages`, { token: people.a.token, body: { text: 'plain text' } })).status, 400, 'plain text is refused');
  const sent = await sendDm(api, phoneA, dmId, 'Hi! Do you have the maths paper?');
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  dmMessage = sent.data.id;

  const bList = await api('GET', `/ca/places/${shop.companyId}/dms`, as(people.b.token));
  assert.equal(bList.data.items[0].unread, 1);
  assert.equal(bList.data.items[0].name, 'Amaya');
  assert.equal((await api('GET', '/ca/places', as(people.b.token))).data.find((p) => p.id === shop.companyId).dms_unread, 1);
  const aList = await api('GET', `/ca/places/${shop.companyId}/dms`, as(people.a.token));
  assert.match(aList.data.items[0].name, /^Member #/, 'Binura hides her name');
  const read = await readDm(api, phoneB, dmId);
  assert.equal(read.data.messages[0].plain, 'Hi! Do you have the maths paper?');
  assert.equal(read.data.messages[0].text, '', 'the server only has the encrypted message');
  assert.equal(read.data.can_send, true);
  assert.ok(!JSON.stringify(read.json).includes(intl(people.a.local)), 'no numbers');
  assert.equal((await api('GET', `/ca/dms/${dmId}/messages`, as(people.c.token))).status, 404, 'others can not read it');
  assert.equal((await api('GET', `/ca/dms/${dmId}/messages`, as(people.a.token))).data.messages[0].status, 'read');

  // block
  assert.equal((await api('PUT', `/ca/blocks/m${people.a.id}`, { token: people.b.token, body: { blocked: true } })).status, 200);
  const blocked = await sendDm(api, phoneA, dmId, 'hello?');
  assert.equal(blocked.status, 403);
  assert.match(blocked.json.message, /does not take messages/);
  assert.equal((await api('GET', `/ca/groups/${group}/members`, as(people.a.token))).data.find((m) => m.id === `m${people.b.id}`).can_message, false);
  await api('PUT', `/ca/blocks/m${people.a.id}`, { token: people.b.token, body: { blocked: false } });
  // "don't message me"
  await api('PATCH', '/ca/profile', { token: people.b.token, body: { allow_dm: false } });
  assert.equal((await sendDm(api, phoneA, dmId, 'hello?')).status, 403);
  await api('PATCH', '/ca/profile', { token: people.b.token, body: { allow_dm: true } });

  // reports can't be used to look up other businesses' customers or groups
  assert.equal((await api('POST', `/ca/places/${shop.companyId}/report`, { token: people.b.token, body: { member: `m${people.fresh.id}`, reason: 'x' } })).status, 404);
  const clubGroup = (await api('POST', '/customer-app/groups', { token: club.token, body: { name: 'Club secret group' } })).data.id;
  assert.equal((await api('POST', `/ca/places/${shop.companyId}/report`, { token: people.b.token, body: { group_id: clubGroup, reason: 'x' } })).status, 404);
  // report → the business sees it with a copy of the message
  assert.equal((await api('POST', `/ca/places/${shop.companyId}/report`, { token: people.b.token, body: { dm_message_id: dmMessage } })).status, 400, 'a reason is needed');
  const rep = await api('POST', `/ca/places/${shop.companyId}/report`, { token: people.b.token, body: { dm_message_id: dmMessage, reason: 'Spam', excerpt: 'Hi! Do you have the maths paper?' } });
  assert.equal(rep.status, 201, JSON.stringify(rep.json));
  assert.equal((await api('POST', `/ca/places/${shop.companyId}/report`, { token: people.c.token, body: { dm_message_id: dmMessage, reason: 'x' } })).status, 404, 'only people in that chat');
  const reports = await api('GET', '/customer-app/reports', as(shop.token));
  assert.equal(reports.data[0].excerpt, '(as reported) Hi! Do you have the maths paper?', "encrypted: the reporter's phone shares the text");
  assert.equal(reports.data[0].target.phone, `+${intl(people.a.local)}`, 'the business sees who it was');
  assert.equal((await api('PATCH', `/customer-app/reports/${reports.data[0].id}`, as(shop.token))).status, 200);
  assert.equal((await api('GET', '/customer-app/reports', as(shop.token))).data.length, 0);
  assert.equal((await api('GET', '/customer-app/reports', as(club.token))).data.length, 0, 'other businesses see nothing');

  // switched off again → the chat stays readable, sending stops
  await api('PUT', '/customer-app/settings', { token: shop.token, body: { member_dm: false } });
  const off = await api('GET', `/ca/dms/${dmId}/messages`, as(people.a.token));
  assert.equal(off.data.can_send, false);
  assert.equal((await sendDm(api, phoneA, dmId, 'x')).status, 403);
});

test('broadcast: only to people on the list who have the app; counts who does not; lands in their chat; read count', async () => {
  const preview = await api('GET', '/customer-app/broadcasts/audience?tags=grade10', as(shop.token));
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.deepEqual(preview.data, { on_app: 2, not_on_app: 1 });
  assert.equal((await api('POST', '/customer-app/broadcasts', { token: shop.token, body: { tags: 'grade10' } })).status, 400, 'empty');
  const sent = await api('POST', '/customer-app/broadcasts', { token: shop.token, body: { text: '50% off the revision pack this week!', tags: 'grade10' } });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  assert.equal(sent.data.total, 2);
  assert.equal(sent.data.not_on_app, 1);
  const done = await until(async () => (await api('GET', '/customer-app/broadcasts', as(shop.token))).data.find((c) => c.id === sent.data.id && c.status === 'sent'));
  assert.ok(done, 'finished');
  assert.equal(done.sent, 2);

  const chat = await api('GET', `/ca/places/${shop.companyId}/messages`, as(people.b.token));
  assert.ok(chat.data.messages.some((m) => m.text === '50% off the revision pack this week!' && !m.mine));
  assert.ok(!chat.data.messages.some((m) => m.text === 'Welcome!'), 'no welcome message pushed in with a broadcast');
  const [conv] = await sql(`SELECT c.status FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
    WHERE cu.company_id = $1 AND cu.platform = 'app' AND cu.external_user_id = $2`, [shop.companyId, `ca:${people.b.id}`]);
  assert.equal(conv.status, 'closed', 'a customer who never wrote does not get an open chat in the Inbox');
  assert.equal((await api('GET', `/ca/places/${shop.companyId}/messages`, as(people.c.token))).data.messages.some((m) => m.text?.includes('revision pack')), false, 'not tagged');

  await api('POST', `/ca/places/${shop.companyId}/read`, as(people.b.token));
  const after = (await api('GET', '/customer-app/broadcasts', as(shop.token))).data.find((c) => c.id === sent.data.id);
  assert.equal(after.read, 1);
});

test('notifications: subscribe on this phone; a group message notifies members (not muted ones); log out removes it', async () => {
  const key = createECDH('prime256v1'); key.generateKeys();
  const sub = (n) => ({ endpoint: `https://127.0.0.1:4591/push/${n}-${randomBytes(4).toString('hex')}`, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }, company_id: shop.companyId });
  assert.equal((await api('POST', '/ca/push', { token: people.a.token, body: { endpoint: 'http://x', keys: {} } })).status, 400);
  const status = await api('GET', '/ca/push', as(people.a.token));
  assert.match(status.data.public_key, /^[\w-]{80,}$/);
  const a = sub('a'); const b = sub('b');
  assert.equal((await api('POST', '/ca/push', { token: people.a.token, body: a })).status, 201);
  assert.equal((await api('POST', '/ca/push', { token: people.b.token, body: b })).status, 201);
  assert.equal((await api('GET', `/ca/push?endpoint=${encodeURIComponent(a.endpoint)}`, as(people.a.token))).data.this_device, true);
  await api('PUT', `/ca/groups/${group}/mute`, { token: people.b.token, body: { muted: true } });

  await api('POST', `/customer-app/groups/${group}/messages`, { token: shop.token, body: { text: 'Class moved to 3 pm' } });
  // the fake address can not be reached → the try is recorded as an error (= a notification was attempted)
  const tried = await until(async () => (await sql(`SELECT last_error FROM ca_push_sub WHERE endpoint = $1`, [a.endpoint]))[0]?.last_error);
  assert.ok(tried, 'Amaya was notified');
  await wait(500);
  assert.equal((await sql(`SELECT last_error FROM ca_push_sub WHERE endpoint = $1`, [b.endpoint]))[0].last_error, null, 'Binura muted the group');
  const members = await api('GET', '/customer-app/members', as(shop.token));
  assert.ok(members.data.counts.notifications >= 2);

  await api('POST', '/ca/logout-everywhere', as(people.a.token));
  assert.equal((await sql(`SELECT 1 FROM ca_push_sub WHERE endpoint = $1`, [a.endpoint])).length, 0);
  people.a = { ...people.a, ...(await login(people.a.local, 'Amaya', slug)) };
});

test('taking a number off the list: no more access, out of the groups', async () => {
  assert.equal((await api('DELETE', `/customer-app/members/${intl(people.c.local)}`, as(shop.token))).status, 200);
  assert.ok(!(await api('GET', '/ca/places', as(people.c.token))).data.some((p) => p.id === shop.companyId));
  assert.equal((await api('POST', `/ca/app/${slug}/open`, as(people.c.token))).status, 403);
  assert.equal((await api('DELETE', `/customer-app/members/${intl(people.b.local)}`, as(shop.token))).status, 200);
  assert.equal((await sql(`SELECT 1 FROM ca_group_member WHERE group_id = $1 AND account_id = $2`, [group, people.b.id])).length, 0, 'left the groups');
  assert.equal((await api('GET', `/ca/dms/${dmId}/messages`, as(people.b.token))).status, 404);
  assert.equal((await api('DELETE', `/customer-app/members/${intl(people.b.local)}`, as(shop.token))).status, 404);
  assert.equal((await api('GET', '/customer-app/members', as(people.a.token))).status, 401, 'customers can not use business pages');
});
