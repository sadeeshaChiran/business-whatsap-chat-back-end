/**
 * Customer app (part 1): phone login with an SMS code, the businesses that know the number, the customer ↔ business chat
 * (an inbox chat with platform "app"), replies from the team, read status, files, and that customer and staff logins can
 * never be swapped. Nothing here may change any other channel.
 *
 * Run the API as usual (OTP_DEV_MODE=true so codes come back), then:  node --test test/customer-app.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { api, closeDb, createWorkspace, sql } from './helpers.mjs';

const local = `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`; // 07xxxxxxxx
const phone = `94${local.slice(1)}`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

let shop; // knows the number from WhatsApp
let other; // app on, does not know the number
let off; // knows the number, app off
let customer;
let conversationId;

async function login(number, name) {
  const start = await api('POST', '/ca/auth/start', { body: { phone: number } });
  assert.equal(start.status, 201, JSON.stringify(start.json));
  const verify = await api('POST', '/ca/auth/verify', { body: { phone: number, code: start.data.dev_code, name } });
  assert.equal(verify.status, 201, JSON.stringify(verify.json));
  return verify.data;
}
const as = (token) => ({ token });

test.before(async () => {
  shop = await createWorkspace('ca-shop');
  other = await createWorkspace('ca-other');
  off = await createWorkspace('ca-off');
  for (const ws of [shop, other, off]) await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [ws.companyId]);
  for (const ws of [shop, off]) {
    await sql(`INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name, language, language_locked, bot_enabled, manual_mode, created_at, updated_at)
      VALUES ($1, 'whatsapp', $2, 'WA customer', 'English', false, false, false, NOW(), NOW())`, [ws.companyId, phone]);
  }
});
test.after(async () => { await closeDb(); });

test('business: the app is off until the owner switches it on', async () => {
  const s = await api('GET', '/customer-app/settings', as(shop.token));
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.equal(s.data.enabled, false);
  const on = await api('PUT', '/customer-app/settings', { token: shop.token, body: { enabled: true, welcome_text: 'Welcome to our shop! Ask us anything.' } });
  assert.equal(on.data.enabled, true);
  await api('PUT', '/customer-app/settings', { token: other.token, body: { enabled: true } });
});

test('login: SMS code, wrong codes are counted, a code works once', async () => {
  const bad = await api('POST', '/ca/auth/start', { body: { phone: '123' } });
  assert.equal(bad.status, 400);
  const start = await api('POST', '/ca/auth/start', { body: { phone: local } });
  assert.equal(start.status, 201, JSON.stringify(start.json));
  assert.equal(start.data.phone, phone, '07… becomes 947…');
  assert.match(start.data.dev_code, /^\d{6}$/);
  const again = await api('POST', '/ca/auth/start', { body: { phone: local } });
  assert.equal(again.status, 429, 'one code a minute');
  const wrong = await api('POST', '/ca/auth/verify', { body: { phone: local, code: start.data.dev_code === '111111' ? '222222' : '111111' } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.message, /Wrong code/);
  const ok = await api('POST', '/ca/auth/verify', { body: { phone: `+${phone}`, code: start.data.dev_code, name: 'Nadeesha' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.match(ok.data.token, /^ca1\./);
  assert.equal(ok.data.account.name, 'Nadeesha');
  const reuse = await api('POST', '/ca/auth/verify', { body: { phone: local, code: start.data.dev_code } });
  assert.equal(reuse.status, 400);
  assert.equal((await api('POST', '/ca/auth/start', { body: { phone: '+44 7911 123456' } })).status, 400, 'only Sri Lankan numbers by default');
  customer = ok.data;
});

test('a code allows only 5 tries, even when guessed in parallel', async () => {
  const number = `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const start = await api('POST', '/ca/auth/start', { body: { phone: number } });
  const wrong = start.data.dev_code === '000000' ? '000001' : '000000';
  const results = await Promise.all(Array.from({ length: 12 }, () => api('POST', '/ca/auth/verify', { body: { phone: number, code: wrong } })));
  assert.ok(results.every((r) => r.status === 400 || r.status === 429));
  const [row] = await sql(`SELECT attempts FROM ca_login_code WHERE phone = $1`, [`94${number.slice(1)}`]);
  assert.ok(Number(row.attempts) <= 5, `attempts ${row.attempts}`);
  const right = await api('POST', '/ca/auth/verify', { body: { phone: number, code: start.data.dev_code } });
  assert.equal(right.status, 400, 'the right code no longer works after 5 wrong ones');
});

test('customer and staff logins can never be swapped', async () => {
  assert.equal((await api('GET', '/bot/conversations', as(customer.token))).status, 401, 'customer token on a staff page');
  assert.equal((await api('GET', '/customer-app/settings', as(customer.token))).status, 401);
  assert.equal((await api('GET', '/ca/me', as(shop.token))).status, 401, 'staff token in the customer app');
  assert.equal((await api('GET', '/ca/me')).status, 401);
  const tampered = customer.token.replace(/\.([^.]+)\./, (_, p) => `.${Buffer.from(JSON.stringify({ aid: 1, v: 0, exp: 9e9 })).toString('base64url')}.`);
  assert.equal((await api('GET', '/ca/me', as(tampered))).status, 401);
  const me = await api('GET', '/ca/me', as(customer.token));
  assert.equal(me.status, 200);
  assert.equal(me.data.account.phone, phone);
});

test('places: businesses with the app on that know the number; others only from their link', async () => {
  const places = await api('GET', '/ca/places', as(customer.token));
  assert.equal(places.status, 200, JSON.stringify(places.json));
  const ids = places.data.map((p) => p.id);
  assert.ok(ids.includes(shop.companyId), 'knows the number');
  assert.ok(!ids.includes(off.companyId), 'app switched off');
  assert.ok(!ids.includes(other.companyId), 'does not know the number');
  assert.equal((await api('GET', `/ca/places/${other.companyId}/messages`, as(customer.token))).status, 403);
  const otherLink = (await api('GET', '/customer-app/settings', as(other.token))).data.link_code;
  const offLink = (await api('GET', '/customer-app/settings', as(off.token))).data.link_code;
  assert.match(otherLink, new RegExp(`^${other.companyId}-[\\w-]{12}$`));
  assert.equal((await api('POST', '/ca/open', { token: customer.token, body: { link: offLink } })).status, 404, 'app switched off');
  assert.equal((await api('POST', '/ca/open', { token: customer.token, body: { link: `${other.companyId}-aaaaaaaaaaaa` } })).status, 404, 'a guessed link does not work');
  assert.equal((await api('POST', '/ca/open', { token: customer.token, body: { link: String(other.companyId) } })).status, 404);
  const open = await api('POST', '/ca/open', { token: customer.token, body: { link: otherLink } });
  assert.equal(open.status, 201, JSON.stringify(open.json));
  assert.ok((await api('GET', '/ca/places', as(customer.token))).data.some((p) => p.id === other.companyId), 'listed after opening the link');
});

test('chat: welcome message, customer writes, the inbox gets it as an "app" chat', async () => {
  const first = await api('GET', `/ca/places/${shop.companyId}/messages`, as(customer.token));
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.data.place.name.startsWith('ca-shop'), true);
  assert.equal(first.data.messages.length, 1);
  assert.equal(first.data.messages[0].text, 'Welcome to our shop! Ask us anything.');
  assert.equal(first.data.messages[0].mine, false);
  const before = await sql(`SELECT id FROM bot_channel_user WHERE platform = 'app' AND external_user_id = $1 AND company_id = $2`, [`ca:${customer.account.id}`, shop.companyId]);
  assert.equal(before.length, 0, 'only looking does not create a chat in the inbox');

  const sent = await api('POST', `/ca/places/${shop.companyId}/messages`, { token: customer.token, body: { text: 'Do you deliver to Kandy?' } });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  const [row] = await sql(`SELECT m.*, c.id AS cid, cu.display_name, cu.external_user_id FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id
    JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id WHERE m.id = $1`, [sent.data.id]);
  assert.equal(row.platform, 'app');
  assert.equal(row.direction, 'inbound');
  assert.equal(row.display_name, 'Nadeesha');
  assert.equal(row.external_user_id, `ca:${customer.account.id}`);
  conversationId = Number(row.cid);
  const crm = await sql(`SELECT phone FROM crm_contact WHERE bot_channel_user_id = (SELECT bot_channel_user_id FROM bot_conversation WHERE id = $1)`, [conversationId]);
  assert.ok(!crm.length || !crm[0].phone, 'the app does not put the number into CRM / marketing audiences');
  const inbox = await api('GET', '/bot/conversations', as(shop.token));
  assert.equal(inbox.status, 200);
  assert.ok(JSON.stringify(inbox.json).includes(`"conversation_id":${conversationId}`) || JSON.stringify(inbox.json).includes(`"id":${conversationId}`), 'listed in the inbox');
});

test('team reply: saved once, shown in the app with the agent name; unread → read both ways', async () => {
  const reply = await api('POST', `/bot/conversations/${conversationId}/messages`, { token: shop.token, body: { text: 'Yes! Kandy delivery is Rs 450.' } });
  assert.ok([200, 201].includes(reply.status), JSON.stringify(reply.json));
  const rows = await sql(`SELECT * FROM bot_message WHERE conversation_id = $1 AND content = 'Yes! Kandy delivery is Rs 450.'`, [conversationId]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].provider_message_id, /^app:/);
  assert.equal(rows[0].delivery_status, 'sent');

  const places = await api('GET', '/ca/places', as(customer.token));
  const place = places.data.find((p) => p.id === shop.companyId);
  assert.equal(place.unread, 2, 'welcome + reply');
  assert.equal(place.last.text, 'Yes! Kandy delivery is Rs 450.');

  const list = await api('GET', `/ca/places/${shop.companyId}/messages`, as(customer.token));
  const last = list.data.messages.at(-1);
  assert.equal(last.mine, false);
  assert.match(String(last.sender), /ca-shop Owner/);
  const mine = list.data.messages.find((m) => m.mine);
  assert.equal(mine.status, 'delivered');

  await api('POST', `/ca/places/${shop.companyId}/read`, as(customer.token));
  assert.equal((await api('GET', '/ca/places', as(customer.token))).data.find((p) => p.id === shop.companyId).unread, 0);
  const [after] = await sql(`SELECT delivery_status FROM bot_message WHERE id = $1`, [rows[0].id]);
  assert.equal(after.delivery_status, 'read', 'the team sees "read"');

  await sql(`UPDATE bot_conversation SET agent_last_read_at = NOW() + INTERVAL '1 second' WHERE id = $1`, [conversationId]);
  const seen = await api('GET', `/ca/places/${shop.companyId}/messages`, as(customer.token));
  assert.equal(seen.data.messages.find((m) => m.mine).status, 'read', 'the customer sees the team read it');
});

test('files: a photo from the customer, a photo from the team (signed links); unsafe types refused', async () => {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'shoe.png');
  form.append('text', 'this one?');
  const up = await api('POST', `/ca/places/${shop.companyId}/messages`, { token: customer.token, form });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  const team = new FormData();
  team.append('file', new Blob([PNG], { type: 'image/png' }), 'size-chart.png');
  const t = await api('POST', `/bot/conversations/${conversationId}/messages/media`, { token: shop.token, form: team });
  assert.ok([200, 201].includes(t.status), JSON.stringify(t.json));
  const list = await api('GET', `/ca/places/${shop.companyId}/messages`, as(customer.token));
  const photos = list.data.messages.filter((m) => m.type === 'image');
  assert.equal(photos.length, 2);
  for (const p of photos) assert.match(String(p.media_url), /\/public\/chat-media\//);
  assert.equal(photos[0].text, 'this one?');

  const html = new FormData();
  html.append('file', new Blob(['<script>x</script>'], { type: 'text/html' }), 'x.html');
  assert.equal((await api('POST', `/ca/places/${shop.companyId}/messages`, { token: customer.token, form: html })).status, 400);
});

test('order messages from the team reach the app chat (saved as a message)', async () => {
  const [cu] = await sql(`SELECT id FROM bot_channel_user WHERE platform = 'app' AND external_user_id = $1 AND company_id = $2`, [`ca:${customer.account.id}`, shop.companyId]);
  const note = await api('POST', '/bot/notes', { token: shop.token, body: { bot_channel_user_id: cu.id, content: 'Your order is packed and leaves today.' } });
  assert.ok([200, 201].includes(note.status), JSON.stringify(note.json));
  const noteId = note.data?.id ?? note.data?.note?.id;
  const send = await api('POST', `/bot/notes/${noteId}/send`, { token: shop.token });
  assert.ok([200, 201].includes(send.status), JSON.stringify(send.json));
  const saved = await sql(`SELECT * FROM bot_message WHERE conversation_id = $1 AND content = 'Your order is packed and leaves today.'`, [conversationId]);
  assert.equal(saved.length, 1, 'saved into the app chat once');
  const [msg] = saved;
  assert.equal(msg.platform, 'app');
  assert.equal(msg.direction, 'outbound');
  const list = await api('GET', `/ca/places/${shop.companyId}/messages`, as(customer.token));
  assert.ok(list.data.messages.some((m) => m.text === 'Your order is packed and leaves today.'));
});

test('privacy: one customer never sees another customer\'s chat', async () => {
  const second = `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const two = await login(second, 'Other person');
  const places = await api('GET', '/ca/places', as(two.token));
  assert.ok(!places.data.some((p) => p.id === shop.companyId), 'the shop does not know this number');
  const shopLink = (await api('GET', '/customer-app/settings', as(shop.token))).data.link_code;
  await api('POST', '/ca/open', { token: two.token, body: { link: shopLink } });
  const list = await api('GET', `/ca/places/${shop.companyId}/messages`, as(two.token));
  assert.ok(!JSON.stringify(list.data).includes('Kandy'), 'only their own chat');
});

test('profile name goes to the inbox; log out everywhere ends old logins', async () => {
  const r = await api('PATCH', '/ca/me', { token: customer.token, body: { name: 'Nadeesha Perera' } });
  assert.equal(r.data.name, 'Nadeesha Perera');
  const [cu] = await sql(`SELECT display_name FROM bot_channel_user WHERE platform = 'app' AND external_user_id = $1 AND company_id = $2`, [`ca:${customer.account.id}`, shop.companyId]);
  assert.equal(cu.display_name, 'Nadeesha Perera');
  await api('POST', '/ca/logout-everywhere', as(customer.token));
  assert.equal((await api('GET', '/ca/me', as(customer.token))).status, 401);
});

test('other channels are untouched: a WhatsApp chat of the same shop never goes through the app', async () => {
  const [wa] = await sql(`SELECT c.id FROM bot_channel_user cu JOIN bot_conversation c ON c.bot_channel_user_id = cu.id WHERE cu.company_id = $1 AND cu.platform = 'whatsapp' LIMIT 1`, [shop.companyId]);
  if (!wa) {
    const [cu] = await sql(`SELECT id FROM bot_channel_user WHERE company_id = $1 AND platform = 'whatsapp'`, [shop.companyId]);
    await sql(`INSERT INTO bot_conversation (bot_channel_user_id, status, assignment_mode, created_at, updated_at, last_message_at) VALUES ($1, 'open', 'unassigned', NOW(), NOW(), NOW())`, [cu.id]);
  }
  const [conv] = await sql(`SELECT c.id FROM bot_channel_user cu JOIN bot_conversation c ON c.bot_channel_user_id = cu.id WHERE cu.company_id = $1 AND cu.platform = 'whatsapp' LIMIT 1`, [shop.companyId]);
  const r = await api('POST', `/bot/conversations/${conv.id}/messages`, { token: shop.token, body: { text: `wa-${randomBytes(2).toString('hex')}` } });
  assert.notEqual(r.status, 201, 'no WhatsApp connected – it fails on WhatsApp, not silently in the app');
  const rows = await sql(`SELECT provider_message_id FROM bot_message WHERE conversation_id = $1 AND provider_message_id LIKE 'app:%'`, [conv.id]);
  assert.equal(rows.length, 0);
});
