/**
 * End-to-end encrypted member chats: the server only stores encrypted text and files, plain text is refused, each phone has
 * its own key, a new phone gets older messages once a phone that can read them re-wraps the key, a device id can't be taken
 * over, "log out everywhere" retires all keys. Run with the API (OTP_DEV_MODE=true): node --test test/customer-app-e2ee.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { api, closeDb, createWorkspace, sql } from './helpers.mjs';
import { decrypt, encrypt, newDevice, phone, readDm, rewrap, sendDm } from './e2ee.mjs';

const rnd = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
let shop; let slug; let dm;
const p = {};

async function login(local, name) {
  const start = await api('POST', '/ca/auth/start', { body: { phone: local, app: slug } });
  const v = await api('POST', '/ca/auth/verify', { body: { phone: local, code: start.data.dev_code, name, app: slug } });
  return { token: v.data.token, id: v.data.account.id };
}

test.before(async () => {
  shop = await createWorkspace('ca-e2ee');
  await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [shop.companyId]);
  slug = `e2e-${randomBytes(3).toString('hex')}`;
  await api('PUT', '/customer-app/settings', { token: shop.token, body: { enabled: true, slug, member_dm: true, dm_mode: 'roles', dm_rules: [['*', '*']] } });
  const a = rnd(); const b = rnd();
  await api('POST', '/customer-app/members', { token: shop.token, body: { phones: `${a},${b}` } });
  p.a = await login(a, 'Amaya'); p.b = await login(b, 'Binura');
  dm = (await api('POST', `/ca/places/${shop.companyId}/dms`, { token: p.a.token, body: { member: `m${p.b.id}` } })).data.id;
});
test.after(async () => { await closeDb(); });

test('keys: each phone registers a public key; both sides see the same security code; a device id cannot be taken over', async () => {
  p.a1 = await phone(api, p.a.token);
  p.b1 = await phone(api, p.b.token);
  const ka = await api('GET', `/ca/dms/${dm}/keys`, { token: p.a.token });
  const kb = await api('GET', `/ca/dms/${dm}/keys`, { token: p.b.token });
  assert.equal(ka.data.devices.length, 2);
  assert.equal(ka.data.security_code, kb.data.security_code);
  assert.match(ka.data.security_code, /^(\d{5} ){11}\d{5}$/);
  const thief = await newDevice();
  const takeover = await api('POST', '/ca/keys', { token: p.b.token, body: { device_id: p.a1.device_id, public_key: thief.public_key } });
  assert.equal(takeover.status, 201, 'another account may use the same id for its own key');
  const again = await api('POST', '/ca/keys', { token: p.a.token, body: { device_id: p.a1.device_id, public_key: thief.public_key } });
  assert.equal(again.status, 400, 'but nobody can swap the key of an existing device');
  await api('DELETE', `/ca/keys/${p.a1.device_id}`, { token: p.b.token });
  assert.equal((await api('POST', '/ca/keys', { token: p.a.token, body: { device_id: 'x', public_key: 'y' } })).status, 400);
});

test('messages: plain text refused; the server stores only ciphertext; the other phone decrypts', async () => {
  assert.equal((await api('POST', `/ca/dms/${dm}/messages`, { token: p.a.token, body: { text: 'hello' } })).status, 400);
  const secret = `Meet at the gate at 4 – ${randomBytes(3).toString('hex')}`;
  const sent = await sendDm(api, p.a1, dm, secret);
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  const [row] = await sql(`SELECT text, cipher::text AS cipher FROM ca_dm_message WHERE id = $1`, [sent.data.id]);
  assert.equal(row.text, '');
  assert.ok(!row.cipher.includes(secret) && !row.cipher.includes(Buffer.from(secret).toString('base64url')), 'nothing readable in the database');
  const read = await readDm(api, p.b1, dm);
  assert.equal(read.data.messages.at(-1).plain, secret);
  const list = await api('GET', `/ca/places/${shop.companyId}/dms`, { token: p.b.token });
  assert.equal(list.data.items[0].last, '🔒 Message', 'the server can not make a preview');
  assert.ok(list.data.items[0].last_cipher, 'the phone makes the preview itself');
  // a wrap for a device that is not part of the chat is dropped
  const outsider = await newDevice();
  const keys = (await api('GET', `/ca/dms/${dm}/keys`, { token: p.a.token })).data.devices;
  const { cipher } = await encrypt(p.a1, [...keys, outsider], { t: 'x' });
  const r = await api('POST', `/ca/dms/${dm}/messages`, { token: p.a.token, body: { cipher } });
  const [saved] = await sql(`SELECT cipher FROM ca_dm_message WHERE id = $1`, [r.data.id]);
  assert.ok(!(outsider.device_id in saved.cipher.keys));
  const onlyOutsider = await encrypt(p.a1, [outsider], { t: 'x' });
  assert.equal((await api('POST', `/ca/dms/${dm}/messages`, { token: p.a.token, body: { cipher: onlyOutsider.cipher } })).status, 400);
});

test('photos are encrypted on the phone: the stored file is unreadable, the other phone opens it', async () => {
  const keys = (await api('GET', `/ca/dms/${dm}/keys`, { token: p.a.token })).data.devices;
  const { cipher, file } = await encrypt(p.a1, keys, { name: 'photo.png', mime: 'image/png', caption: 'look' }, PNG);
  const form = new FormData();
  form.append('file', new Blob([file], { type: 'application/octet-stream' }), 'encrypted.bin');
  form.append('cipher', JSON.stringify(cipher));
  form.append('kind', 'image');
  const up = await api('POST', `/ca/dms/${dm}/messages`, { token: p.a.token, form });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  const read = await api('GET', `/ca/dms/${dm}/messages`, { token: p.b.token });
  const m = read.data.messages.find((x) => x.id === up.data.id);
  assert.equal(m.type, 'image');
  const bytes = new Uint8Array(await (await fetch(m.media_url.replace('https://localhost:3001', 'http://localhost:3001'))).arrayBuffer());
  assert.notDeepEqual(Buffer.from(bytes).subarray(0, 8), PNG.subarray(0, 8), 'the server copy is not a PNG');
  const opened = await decrypt(p.b1, m.cipher, bytes);
  assert.deepEqual(Buffer.from(opened.file), PNG);
  assert.equal(opened.payload.caption, 'look');
});

test('a new phone: can not read old messages until a phone that can read them wraps the key for it', async () => {
  const b2 = await phone(api, p.b.token);
  let read = await readDm(api, b2, dm);
  const firstText = read.data.messages.find((m) => m.cipher && m.type === 'text');
  assert.equal(firstText.plain, null, 'not readable yet');
  // Amaya's phone opens the chat, sees a new device and wraps the keys for it
  const a = await api('GET', `/ca/dms/${dm}/messages`, { token: p.a.token });
  const messages = [];
  for (const m of a.data.messages.filter((x) => x.cipher && !(b2.device_id in x.cipher.keys))) {
    const wrap = await rewrap(p.a1, m.cipher, b2);
    if (wrap) messages.push({ id: m.id, keys: { [b2.device_id]: wrap } });
  }
  const w = await api('POST', `/ca/dms/${dm}/wraps`, { token: p.a.token, body: { messages } });
  assert.equal(w.status, 201, JSON.stringify(w.json));
  assert.ok(w.data.updated >= 1);
  read = await readDm(api, b2, dm);
  assert.ok(read.data.messages.find((m) => m.id === firstText.id).plain, 'readable now');
  // an existing wrap can not be overwritten
  const fake = await newDevice();
  const evil = await rewrap(p.a1, a.data.messages.find((m) => m.cipher).cipher, fake);
  await api('POST', `/ca/dms/${dm}/wraps`, { token: p.a.token, body: { messages: [{ id: firstText.id, keys: { [p.b1.device_id]: evil } }] } });
  assert.ok((await readDm(api, p.b1, dm)).data.messages.find((m) => m.id === firstText.id).plain, 'the old wrap still works');
  assert.equal((await api('POST', `/ca/dms/${dm}/wraps`, { token: (await login(rnd(), 'x').catch(() => ({ token: 'x' }))).token, body: { messages } })).status >= 400, true);
});

test('log out everywhere retires every key; the business never sees member chats', async () => {
  await api('POST', '/ca/logout-everywhere', { token: p.b.token });
  const [n] = await sql(`SELECT COUNT(*)::int AS n FROM ca_device_key WHERE account_id = $1 AND revoked_at IS NULL`, [p.b.id]);
  assert.equal(n.n, 0);
  const inbox = await api('GET', '/bot/conversations', { token: shop.token });
  assert.ok(!JSON.stringify(inbox.json).includes('Meet at the gate'));
});
