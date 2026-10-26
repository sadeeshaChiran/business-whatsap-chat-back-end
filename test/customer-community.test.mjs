/**
 * Customer app part 2: business profile, News, Groups (public / private, announce / chat, member list, admins, add by CRM tags,
 * realtime channel auth), customer profile (photo, privacy, delete account). Run with the API (OTP_DEV_MODE=true):
 *   node --test test/customer-community.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, closeDb, createWorkspace, sql } from './helpers.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const rnd = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const intl = (local) => `94${local.slice(1)}`;
const as = (token) => ({ token });

let shop;
let stranger; // another business
const people = {}; // a: tagged grade10, b: tagged grade10, c: no tag, d: stranger (business does not know)

async function customer(label, local, knownBy, tags = []) {
  if (knownBy) {
    const [cu] = await sql(`INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name, language, language_locked, bot_enabled, manual_mode, created_at, updated_at)
      VALUES ($1, 'whatsapp', $2, $3, 'English', false, false, false, NOW(), NOW()) RETURNING id`, [knownBy.companyId, intl(local), label]);
    if (tags.length) await sql(`INSERT INTO crm_contact (bot_channel_user_id, company_id, tags, updated_at) VALUES ($1, $2, $3, NOW())`, [cu.id, knownBy.companyId, tags]);
  }
  // part 3: the business puts the number on its app list (a stranger is only on the other business's list)
  await api('POST', '/customer-app/members', { token: (knownBy ?? stranger).token, body: { phones: [local] } });
  const start = await api('POST', '/ca/auth/start', { body: { phone: local } });
  const v = await api('POST', '/ca/auth/verify', { body: { phone: local, code: start.data.dev_code, name: label } });
  assert.equal(v.status, 201, JSON.stringify(v.json));
  return { token: v.data.token, id: v.data.account.id, local };
}

test.before(async () => {
  shop = await createWorkspace('cc-class');
  stranger = await createWorkspace('cc-other');
  for (const ws of [shop, stranger]) {
    await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [ws.companyId]);
    await api('PUT', '/customer-app/settings', { token: ws.token, body: { enabled: true } });
  }
  people.a = await customer('Amaya', rnd(), shop, ['grade10']);
  people.b = await customer('Binura', rnd(), shop, ['grade10', 'saturday']);
  people.c = await customer('Chathu', rnd(), shop, []);
  people.d = await customer('Dilan', rnd(), null);
});
test.after(async () => { await closeDb(); });

test('business profile: saved by the owner, shown in the app; website checked', async () => {
  const bad = await api('PUT', '/customer-app/profile', { token: shop.token, body: { website: 'not a site' } });
  assert.equal(bad.status, 400);
  const r = await api('PUT', '/customer-app/profile', { token: shop.token, body: { about: 'Grade 10 & 11 Maths – Colombo 05', address: '12 Main St', phone: '0771234567', hours: 'Sat–Sun 8am–6pm', website: 'https://nimalsir.lk' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const logo = new FormData(); logo.append('logo', new Blob([PNG], { type: 'image/png' }), 'logo.png');
  assert.equal((await api('POST', '/customer-app/profile/logo', { token: shop.token, form: logo })).status, 201);
  const svg = new FormData(); svg.append('logo', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg');
  assert.equal((await api('POST', '/customer-app/profile/logo', { token: shop.token, form: svg })).status, 400);

  const p = await api('GET', `/ca/places/${shop.companyId}/profile`, as(people.a.token));
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.data.about, 'Grade 10 & 11 Maths – Colombo 05');
  assert.match(p.data.logo_url, /\/public\/chat-media\//);
  assert.equal((await api('GET', `/ca/places/${shop.companyId}/profile`, as(people.d.token))).status, 403, 'a stranger can not open it');
  assert.equal((await api('GET', '/customer-app/profile', as(people.a.token))).status, 401, 'customers can not use business pages');
});

test('news: posted with a photo, pinned first, "new" until seen, view counts for the business', async () => {
  const one = await api('POST', '/customer-app/news', { token: shop.token, body: { title: 'Welcome', body: 'Term starts 4 Nov.' } });
  assert.equal(one.status, 201, JSON.stringify(one.json));
  const form = new FormData(); form.append('photo', new Blob([PNG], { type: 'image/png' }), 'poster.png'); form.append('body', 'No class this Saturday (Poya).'); form.append('pinned', 'true');
  const two = await api('POST', '/customer-app/news', { token: shop.token, form });
  assert.equal(two.status, 201, JSON.stringify(two.json));
  assert.equal((await api('POST', '/customer-app/news', { token: shop.token, body: {} })).status, 400);

  const places = await api('GET', '/ca/places', as(people.a.token));
  assert.equal(places.data.find((p) => p.id === shop.companyId).news_unread, 2);
  const list = await api('GET', `/ca/places/${shop.companyId}/news`, as(people.a.token));
  assert.equal(list.data.items[0].id, two.data.id, 'pinned first');
  assert.equal(list.data.items[0].new, true);
  assert.match(list.data.items[0].image_url, /\/public\/chat-media\//);
  const again = await api('GET', `/ca/places/${shop.companyId}/news`, as(people.a.token));
  assert.equal(again.data.items[0].new, false, 'seen after opening');
  assert.equal((await api('GET', '/ca/places', as(people.a.token))).data.find((p) => p.id === shop.companyId).news_unread, 0);

  const biz = await api('GET', '/customer-app/news', as(shop.token));
  assert.equal(biz.data.find((n) => n.id === two.data.id).views, 1);
  assert.equal((await api('PATCH', `/customer-app/news/${one.data.id}`, { token: shop.token, body: { body: 'Term starts 5 Nov.' } })).status, 200);
  assert.equal((await api('DELETE', `/customer-app/news/${one.data.id}`, as(stranger.token))).status, 404, 'another business can not delete it');
  assert.equal((await api('DELETE', `/customer-app/news/${one.data.id}`, as(shop.token))).status, 200);
  assert.equal((await api('GET', `/ca/places/${shop.companyId}/news`, as(people.a.token))).data.items.length, 1);
});

let classGroup; // private, announce
let openGroup; // public, chat

test('groups: private announce group by CRM tag, public chat group anyone (who knows the business) can join', async () => {
  classGroup = (await api('POST', '/customer-app/groups', { token: shop.token, body: { name: 'Grade 10 – Saturday', description: 'Class updates', visibility: 'private', mode: 'announce' } })).data.id;
  openGroup = (await api('POST', '/customer-app/groups', { token: shop.token, body: { name: 'Parents corner', visibility: 'public', mode: 'chat', show_members: true } })).data.id;
  assert.equal((await api('POST', '/customer-app/groups', { token: shop.token, body: { name: ' ' } })).status, 400);

  const add = await api('POST', `/customer-app/groups/${classGroup}/members`, { token: shop.token, body: { tags: ['Grade10'] } });
  assert.equal(add.status, 201, JSON.stringify(add.json));
  assert.equal(add.data.added, 2, 'Amaya and Binura');
  const stranger = await api('POST', `/customer-app/groups/${classGroup}/members`, { token: shop.token, body: { account_ids: [people.d.id] } });
  assert.equal(stranger.data.added, 0, 'a person the business does not know can not be added');

  const aGroups = await api('GET', `/ca/places/${shop.companyId}/groups`, as(people.a.token));
  assert.deepEqual(aGroups.data.map((g) => [g.id, g.joined]).sort(), [[classGroup, true], [openGroup, false]].sort());
  const cGroups = await api('GET', `/ca/places/${shop.companyId}/groups`, as(people.c.token));
  assert.deepEqual(cGroups.data.map((g) => g.id), [openGroup], 'a private group is invisible to non-members');
  assert.equal((await api('POST', `/ca/groups/${classGroup}/join`, as(people.c.token))).status, 404);
  assert.equal((await api('GET', `/ca/groups/${classGroup}/messages`, as(people.c.token))).status, 404);
  assert.equal((await api('POST', `/ca/groups/${openGroup}/join`, as(people.c.token))).status, 201);
  assert.equal((await api('POST', `/ca/groups/${openGroup}/join`, as(people.d.token))).status, 404, 'not a customer of this business – not even told the group exists');
});

test('announce group: only the business (and group admins) post; members read; unread counts', async () => {
  const no = await api('POST', `/ca/groups/${classGroup}/messages`, { token: people.a.token, body: { text: 'hi all' } });
  assert.equal(no.status, 403);
  const post = await api('POST', `/customer-app/groups/${classGroup}/messages`, { token: shop.token, body: { text: 'Class is ON this Saturday, 2 pm.' } });
  assert.equal(post.status, 201, JSON.stringify(post.json));
  const photo = new FormData(); photo.append('file', new Blob([PNG], { type: 'image/png' }), 'paper.png');
  assert.equal((await api('POST', `/customer-app/groups/${classGroup}/messages`, { token: shop.token, form: photo })).status, 201);

  const groups = await api('GET', `/ca/places/${shop.companyId}/groups`, as(people.b.token));
  assert.equal(groups.data.find((g) => g.id === classGroup).unread, 2);
  assert.equal((await api('GET', '/ca/places', as(people.b.token))).data.find((p) => p.id === shop.companyId).groups_unread, 2);
  const msgs = await api('GET', `/ca/groups/${classGroup}/messages`, as(people.b.token));
  assert.equal(msgs.data.can_post, false);
  assert.equal(msgs.data.messages[0].sender.kind, 'business');
  assert.match(msgs.data.messages[0].sender.name, /^cc-class/);
  assert.equal(msgs.data.messages[1].type, 'image');
  assert.equal((await api('GET', `/ca/places/${shop.companyId}/groups`, as(people.b.token))).data.find((g) => g.id === classGroup).unread, 0);
  assert.equal((await api('GET', `/ca/groups/${classGroup}/members`, as(people.b.token))).status, 403, 'member list is private here');

  // a group admin may post
  assert.equal((await api('PATCH', `/customer-app/groups/${classGroup}/members/${people.a.id}`, { token: shop.token, body: { role: 'admin' } })).status, 200);
  assert.equal((await api('POST', `/ca/groups/${classGroup}/messages`, { token: people.a.token, body: { text: 'Bring your calculators 🙂' } })).status, 201);
  assert.equal((await api('GET', `/ca/groups/${classGroup}/members`, as(people.a.token))).status, 200, 'admins see members');
});

test('chat group: members talk, names only (never numbers), privacy setting, delete own message', async () => {
  await api('POST', `/ca/groups/${openGroup}/join`, as(people.a.token));
  assert.equal((await api('POST', `/ca/groups/${openGroup}/messages`, { token: people.c.token, body: { text: 'Hello parents!' } })).status, 201);
  const mine = await api('POST', `/ca/groups/${openGroup}/messages`, { token: people.a.token, body: { text: 'Hi Chathu' } });
  const seen = await api('GET', `/ca/groups/${openGroup}/messages`, as(people.a.token));
  assert.deepEqual(seen.data.messages.map((m) => m.sender.name), ['Chathu', 'You']);
  const raw = JSON.stringify(seen.json);
  for (const p of Object.values(people)) assert.ok(!raw.includes(intl(p.local)) && !raw.includes(p.local), 'no phone numbers');

  const members = await api('GET', `/ca/groups/${openGroup}/members`, as(people.a.token));
  assert.equal(members.status, 200);
  assert.ok(members.data.some((m) => m.name === 'Chathu'));
  assert.ok(!JSON.stringify(members.json).includes(intl(people.c.local)));

  // Chathu hides her name
  assert.equal((await api('PATCH', '/ca/profile', { token: people.c.token, body: { show_name: false } })).data.show_name, false);
  const hidden = await api('GET', `/ca/groups/${openGroup}/messages`, as(people.a.token));
  assert.match(hidden.data.messages[0].sender.name, /^Member #[A-Z2-9]{6}$/, 'hidden name → member ID, never the number');

  assert.equal((await api('DELETE', `/ca/groups/${openGroup}/messages/${mine.data.id}`, as(people.c.token))).status, 404, 'not her message');
  assert.equal((await api('DELETE', `/ca/groups/${openGroup}/messages/${mine.data.id}`, as(people.a.token))).status, 200);
  const after = await api('GET', `/ca/groups/${openGroup}/messages`, as(people.c.token));
  assert.equal(after.data.messages.at(-1).deleted, true);
  assert.equal(after.data.messages.at(-1).text, '');
});

test('business sees members (own customers with phone) and all messages; can delete any and remove people', async () => {
  const members = await api('GET', `/customer-app/groups/${classGroup}/members`, as(shop.token));
  assert.equal(members.data.length, 2);
  assert.ok(members.data.every((m) => m.phone.startsWith('+94')));
  const msgs = await api('GET', `/customer-app/groups/${classGroup}/messages`, as(shop.token));
  assert.equal(msgs.data.messages.length, 3);
  const last = msgs.data.messages.at(-1);
  assert.equal(last.sender, 'Amaya');
  assert.equal((await api('DELETE', `/customer-app/groups/${classGroup}/messages/${last.id}`, as(shop.token))).status, 200);
  assert.equal((await api('DELETE', `/customer-app/groups/${classGroup}/members/${people.b.id}`, as(shop.token))).status, 200);
  assert.equal((await api('GET', `/ca/groups/${classGroup}/messages`, as(people.b.token))).status, 404, 'removed');
  assert.equal((await api('GET', `/customer-app/groups/${classGroup}/members`, as(stranger.token))).status, 404, 'other businesses can not see it');
  const listed = await api('GET', '/customer-app/app-customers', as(shop.token));
  assert.ok(listed.data.some((c) => c.account_id === people.a.id));
  assert.ok(!listed.data.some((c) => c.account_id === people.d.id), 'only own customers');
});

test('removed from a public group: can not join again by themselves; the business can add them back', async () => {
  await api('POST', `/ca/groups/${openGroup}/join`, as(people.b.token));
  assert.equal((await api('DELETE', `/customer-app/groups/${openGroup}/members/${people.b.id}`, as(shop.token))).status, 200);
  const again = await api('POST', `/ca/groups/${openGroup}/join`, as(people.b.token));
  assert.equal(again.status, 403);
  assert.match(again.json.message, /removed you/);
  const back = await api('POST', `/customer-app/groups/${openGroup}/members`, { token: shop.token, body: { account_ids: [people.b.id] } });
  assert.equal(back.data.added, 1);
});

test('a CRM contact saved with a local 07… number can be added by tag', async () => {
  const local = rnd();
  const [cu] = await sql(`INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name, language, language_locked, bot_enabled, manual_mode, created_at, updated_at)
    VALUES ($1, 'messenger', $2, 'Eshani', 'English', false, false, false, NOW(), NOW()) RETURNING id`, [shop.companyId, `psid-${local}`]);
  await sql(`INSERT INTO crm_contact (bot_channel_user_id, company_id, phone, tags, updated_at) VALUES ($1, $2, $3, ARRAY['crmonly'], NOW())`, [cu.id, shop.companyId, `${local.slice(0, 3)} ${local.slice(3)}`]);
  const e = await customer('Eshani', local, null);
  // part 3: the shop puts its tagged contacts on its app list (the 07… CRM number matches the app login)
  const listed = await api('POST', '/customer-app/members', { token: shop.token, body: { tags: ['crmonly'] } });
  assert.equal(listed.data.added_now, 1, JSON.stringify(listed.data));
  await api('GET', '/ca/places', as(e.token)); // she opens the app → the shop now lists her as "has the app"
  const g = (await api('POST', '/customer-app/groups', { token: shop.token, body: { name: 'CRM group' } })).data.id;
  const add = await api('POST', `/customer-app/groups/${g}/members`, { token: shop.token, body: { tags: ['crmonly'] } });
  assert.equal(add.data.added, 1, JSON.stringify(add.data));
  const members = await api('GET', `/customer-app/groups/${g}/members`, as(shop.token));
  assert.equal(members.data[0].phone, `+${intl(local)}`, 'shown in full to the business that has the number');
  assert.equal((await api('GET', `/ca/places/${shop.companyId}/groups`, as(e.token))).data.some((x) => x.id === g), true);
});

test('realtime: a customer may listen to their own channel and their groups only', async () => {
  const own = await api('POST', '/ca/realtime/auth', { token: people.a.token, body: { socket_id: '1.1', channel_name: `private-customer-${people.a.id}` } });
  assert.notEqual(own.status, 403);
  assert.equal((await api('POST', '/ca/realtime/auth', { token: people.a.token, body: { socket_id: '1.1', channel_name: `private-customer-${people.b.id}` } })).status, 403);
  assert.notEqual((await api('POST', '/ca/realtime/auth', { token: people.a.token, body: { socket_id: '1.1', channel_name: `private-ca-group-${classGroup}` } })).status, 403);
  assert.equal((await api('POST', '/ca/realtime/auth', { token: people.d.token, body: { socket_id: '1.1', channel_name: `private-ca-group-${classGroup}` } })).status, 403);
});

test('profile: photo, mute, leave; delete account ends the login and removes the name', async () => {
  const photo = new FormData(); photo.append('photo', new Blob([PNG], { type: 'image/png' }), 'me.png');
  const r = await api('POST', '/ca/profile/photo', { token: people.c.token, form: photo });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.match(r.data.avatar_url, /\/public\/chat-media\//);
  assert.equal((await api('PUT', `/ca/places/${shop.companyId}/mute`, { token: people.c.token, body: { muted: true } })).data.muted, true);
  assert.equal((await api('GET', `/ca/places/${shop.companyId}/profile`, as(people.c.token))).data.muted, true);
  assert.equal((await api('POST', `/ca/groups/${openGroup}/leave`, as(people.a.token))).status, 201);

  await api('POST', `/ca/places/${shop.companyId}/messages`, { token: people.c.token, body: { text: 'Is there class today?' } });
  const del = await api('DELETE', '/ca/profile', as(people.c.token));
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.equal((await api('GET', '/ca/me', as(people.c.token))).status, 401);
  const [cu] = await sql(`SELECT display_name FROM bot_channel_user WHERE platform = 'app' AND external_user_id = $1`, [`ca:${people.c.id}`]);
  assert.equal(cu.display_name, 'Deleted customer');
  const msgs = await api('GET', `/customer-app/groups/${openGroup}/messages`, as(shop.token));
  assert.ok(msgs.data.messages.length >= 1, 'the business keeps its history');
});

test('archived group disappears for everyone', async () => {
  assert.equal((await api('DELETE', `/customer-app/groups/${classGroup}`, as(shop.token))).status, 200);
  assert.ok(!(await api('GET', `/ca/places/${shop.companyId}/groups`, as(people.a.token))).data.some((g) => g.id === classGroup));
  assert.equal((await api('GET', `/ca/groups/${classGroup}/messages`, as(people.a.token))).status, 404);
});
