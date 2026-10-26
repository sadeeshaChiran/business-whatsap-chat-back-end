/**
 * Telegram channel: connect a bot (token), webhook secret, customer messages / files / location in the inbox, /start + welcome,
 * replies from the team (text and files), blocked bots, linking a channel and announcements (channel + subscribers by tag) –
 * through a fake Telegram Bot API. Nothing here may change WhatsApp, Messenger, Instagram or TikTok.
 *
 * Run the API with
 *   TELEGRAM_API_BASE_URL=http://127.0.0.1:4597  PUBLIC_API_BASE_URL=https://localhost:3001/v1/api (any value works with the fake)
 * then:  node --test test/telegram.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { api, closeDb, createWorkspace, sql } from './helpers.mjs';

const BOT_ID = 7_000_000_000 + Math.floor(Math.random() * 1e8);
const TOKEN = `${BOT_ID}:AA${randomBytes(18).toString('hex')}`;
const CHAT = 5_000_000_000 + Math.floor(Math.random() * 1e8);
const CHAT2 = CHAT + 1;
const CHANNEL = -1_002_000_000_000 - Math.floor(Math.random() * 1e6);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%test\n');
const calls = [];
let messageId = 100;
let webhook = null;
const blockedChats = new Set();

const telegram = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const send = (result, ok = true, extra = {}) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(ok ? { ok, result } : { ok, ...extra })); };
    if (url.pathname.startsWith('/file/')) { res.end(url.pathname.endsWith('.pdf') ? PDF : PNG); return; }
    const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m) return send(null, false, { error_code: 404, description: 'Not Found' });
    const [, token, method] = m;
    const isJson = String(req.headers['content-type'] || '').includes('json');
    const body = isJson ? JSON.parse(raw.toString() || '{}') : { multipart: true, size: raw.length, text: raw.toString('latin1') };
    calls.push({ method, body });
    if (token !== TOKEN) return send(null, false, { error_code: 401, description: 'Unauthorized' });
    const chatOf = () => String(body.chat_id ?? (body.text?.match(/name="chat_id"\r\n\r\n(-?\d+)/)?.[1] ?? ''));
    switch (method) {
      case 'getMe': return send({ id: BOT_ID, is_bot: true, first_name: 'Vora Kids', username: 'vorakids_bot' });
      case 'setWebhook': webhook = body; return send(true);
      case 'deleteWebhook': webhook = null; return send(true);
      case 'getWebhookInfo': return send({ url: webhook?.url ?? '', pending_update_count: 0 });
      case 'getFile': return send({ file_id: body.file_id, file_size: 70, file_path: body.file_id === 'doc1' ? 'documents/price.pdf' : 'photos/p.jpg' });
      case 'getChat': return String(body.chat_id) === '@vorakidsupdates' || Number(body.chat_id) === CHANNEL
        ? send({ id: CHANNEL, type: 'channel', title: 'VORA Kids Updates', username: 'vorakidsupdates' }) : send(null, false, { error_code: 400, description: 'Bad Request: chat not found' });
      case 'getChatMember': return send({ status: 'administrator', can_post_messages: true });
      default:
        if (/^send/.test(method)) {
          if (blockedChats.has(chatOf())) return send(null, false, { error_code: 403, description: 'Forbidden: bot was blocked by the user' });
          messageId += 1;
          return send({ message_id: messageId, chat: { id: Number(chatOf()) }, ...(method === 'sendPhoto' ? { photo: [{ file_id: 'small' }, { file_id: 'uploaded-photo-id' }] } : {}) });
        }
        return send(null, false, { error_code: 400, description: `Bad Request: ${method}` });
    }
  });
});

let updateId = 1;
async function update(payload, secret = webhook?.secret_token) {
  const id = webhook?.url?.match(/webhook\/(\d+)$/)?.[1];
  return api('POST', `/integrations/telegram/webhook/${id}`, { body: { update_id: updateId++, ...payload }, headers: secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {} });
}
let mid = 1;
const from = (chat, first = 'Kasuni', last = 'Perera') => ({ id: chat, is_bot: false, first_name: first, last_name: last });
const say = (extra, chat = CHAT) => update({ message: { message_id: mid++, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: 'private', first_name: 'Kasuni' }, from: from(chat), ...extra } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = await check(); if (v || Date.now() > end) return v; await wait(100); }
}
const rows = (chat = CHAT) => sql(`SELECT m.*, c.id AS cid FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
  WHERE cu.platform = 'telegram' AND cu.external_user_id = $1 ORDER BY m.id`, [String(chat)]);

let owner;
let conversationId;

test.before(async () => {
  await new Promise((resolve) => telegram.listen(4597, '127.0.0.1', resolve));
  owner = await createWorkspace('telegram');
  await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [owner.companyId]);
});
test.after(async () => {
  await sql(`DELETE FROM telegram_connection WHERE bot_id = $1`, [String(BOT_ID)]).catch(() => undefined);
  telegram.close();
  await closeDb();
});

test('package: Free has no Telegram (like Instagram); Growth has it', async () => {
  const [free] = await sql(`SELECT limits FROM platform_package WHERE code = 'free'`);
  if (free && free.limits.instagram === false) assert.equal(free.limits.telegram, false);
  const small = await createWorkspace('telegram-free');
  assert.equal((await api('GET', '/integrations/telegram/status', { token: small.token })).status, 403);
  const ok = await api('GET', '/integrations/telegram/status', { token: owner.token });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.data.connection, null);
});

test('connect: a wrong token is refused; the real one is saved and the webhook is set with a secret', async () => {
  const bad = await api('POST', '/integrations/telegram/connect', { token: owner.token, body: { token: 'hello' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /BotFather/);
  const unknown = await api('POST', '/integrations/telegram/connect', { token: owner.token, body: { token: `${BOT_ID}:AA${'x'.repeat(34)}` } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.message, /does not know this token/);

  const r = await api('POST', '/integrations/telegram/connect', { token: owner.token, body: { token: ` ${TOKEN} ` } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.data.connection.bot_username, 'vorakids_bot');
  assert.equal(r.data.connection.start_link, 'https://t.me/vorakids_bot');
  assert.ok(!JSON.stringify(r.data).includes(TOKEN), 'the token never goes back to the browser');
  assert.match(webhook.url, /\/integrations\/telegram\/webhook\/\d+$/);
  assert.ok(webhook.secret_token?.length >= 32);
  assert.deepEqual(webhook.allowed_updates, ['message', 'edited_message', 'my_chat_member']);

  const other = await createWorkspace('telegram-other');
  await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [other.companyId]);
  const taken = await api('POST', '/integrations/telegram/connect', { token: other.token, body: { token: TOKEN } });
  assert.equal(taken.status, 400);
  assert.match(taken.json.message, /another business/);
});

test('webhook: a wrong or missing secret is refused', async () => {
  assert.equal((await update({ message: { message_id: 1, chat: { id: CHAT, type: 'private' }, text: 'x' } }, 'wrong')).status, 403);
  const id = webhook.url.match(/(\d+)$/)[1];
  assert.equal((await api('POST', `/integrations/telegram/webhook/${id}`, { body: { update_id: 1 } })).status, 403);
});

test('/start: the customer appears with a welcome message; no AI reply', async () => {
  const r = await say({ text: '/start class10' });
  assert.equal(r.status, 200);
  const list = await until(async () => { const l = await rows(); return l.length >= 2 ? l : null; });
  assert.ok(list, 'start + welcome saved');
  assert.equal(list[0].message_type, 'system');
  assert.equal(list[0].content, '👋 Started the bot · class10');
  assert.equal(list[1].direction, 'outbound');
  assert.equal(list[1].source, 'telegram-welcome');
  assert.match(list[1].content, /^Hi Kasuni! 👋/);
  const [cu] = await sql(`SELECT * FROM bot_channel_user WHERE platform = 'telegram' AND external_user_id = $1`, [String(CHAT)]);
  assert.equal(cu.display_name, 'Kasuni Perera');
  assert.equal(cu.source_account_id, String(BOT_ID));
  conversationId = Number(list[0].cid);
});

test('customer messages: text, photo, document, location, contact – each once', async () => {
  const before = (await rows()).length;
  const textId = mid;
  await say({ text: 'Do you have size M?' });
  await update({ message: { message_id: textId, date: 1, chat: { id: CHAT, type: 'private' }, from: from(CHAT), text: 'Do you have size M?' } }); // Telegram retry
  await say({ photo: [{ file_id: 'p-small', file_size: 10 }, { file_id: 'p-big', file_size: 70 }], caption: 'this one' });
  await say({ document: { file_id: 'doc1', file_name: 'price.pdf', mime_type: 'application/pdf' } });
  await say({ location: { latitude: 6.9271, longitude: 79.8612 } });
  await say({ contact: { phone_number: '+94771234567', first_name: 'Amma' } });
  const list = await until(async () => { const l = await rows(); return l.length >= before + 5 ? l : null; });
  assert.ok(list, 'all saved');
  await wait(300);
  const now = (await rows()).slice(before);
  assert.equal(now.length, 5, 'the retried update was saved once');
  assert.equal(now[0].content, 'Do you have size M?');
  assert.equal(now[1].message_type, 'image');
  assert.equal(now[1].content, 'this one');
  assert.match(now[1].media_url, /^local-media:|\.jpg$/);
  assert.equal(now[2].content, 'price.pdf');
  assert.match(now[2].media_url, /\.pdf$/);
  assert.match(now[3].content, /^📍 Location\nhttps:\/\/maps\.google\.com\/\?q=6\.9271,79\.8612$/);
  assert.equal(now[4].content, 'Contact: Amma\nPhone: +94771234567');
  assert.ok(calls.some((c) => c.method === 'getFile' && c.body.file_id === 'p-big'), 'the largest photo size is downloaded');
});

test('team replies: text (long text split) and files go to the customer\'s chat', async () => {
  const r = await api('POST', `/bot/conversations/${conversationId}/messages`, { token: owner.token, body: { text: 'Yes, size M is in stock!' } });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.json));
  const sent = calls.filter((c) => c.method === 'sendMessage').pop();
  assert.equal(String(sent.body.chat_id), String(CHAT));
  assert.equal(sent.body.text, 'Yes, size M is in stock!');
  const [row] = (await rows()).slice(-1);
  assert.equal(row.provider_message_id, `${CHAT}:${messageId}`);

  const before = calls.length;
  const long = await api('POST', `/bot/conversations/${conversationId}/messages`, { token: owner.token, body: { text: 'a'.repeat(4096) } });
  assert.ok([200, 201].includes(long.status), JSON.stringify(long.json));
  assert.equal(calls.slice(before).filter((c) => c.method === 'sendMessage').length, 1);

  const photo = new FormData();
  photo.append('file', new Blob([PNG], { type: 'image/png' }), 'chart.png');
  photo.append('caption', 'Size chart');
  const p = await api('POST', `/bot/conversations/${conversationId}/messages/media`, { token: owner.token, form: photo });
  assert.ok([200, 201].includes(p.status), JSON.stringify(p.json));
  const up = calls.filter((c) => c.method === 'sendPhoto').pop();
  assert.ok(up.body.multipart && up.body.text.includes('Size chart'), 'photo uploaded with its caption');

  const doc = new FormData();
  doc.append('file', new Blob([PDF], { type: 'application/pdf' }), 'invoice.pdf');
  const d = await api('POST', `/bot/conversations/${conversationId}/messages/media`, { token: owner.token, form: doc });
  assert.ok([200, 201].includes(d.status), JSON.stringify(d.json));
  assert.equal(calls.at(-1).method, 'sendDocument');
});

test('a customer who blocked the bot: clear message, remembered, unblocked when they write again', async () => {
  blockedChats.add(String(CHAT));
  const r = await api('POST', `/bot/conversations/${conversationId}/messages`, { token: owner.token, body: { text: 'Hello?' } });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /blocked your Telegram bot/);
  const [state] = await sql(`SELECT s.blocked_at FROM telegram_subscriber_state s JOIN bot_channel_user cu ON cu.id = s.channel_user_id WHERE cu.external_user_id = $1`, [String(CHAT)]);
  assert.ok(state.blocked_at);
  blockedChats.delete(String(CHAT));
  await say({ text: 'sorry, back' });
  const unblocked = await until(async () => !(await sql(`SELECT s.blocked_at FROM telegram_subscriber_state s JOIN bot_channel_user cu ON cu.id = s.channel_user_id WHERE cu.external_user_id = $1`, [String(CHAT)]))[0].blocked_at);
  assert.ok(unblocked);
  // Telegram also tells us when someone blocks the bot
  await update({ my_chat_member: { chat: { id: CHAT, type: 'private' }, from: from(CHAT), new_chat_member: { status: 'kicked', user: { id: BOT_ID } } } });
  assert.ok(await until(async () => (await sql(`SELECT s.blocked_at FROM telegram_subscriber_state s JOIN bot_channel_user cu ON cu.id = s.channel_user_id WHERE cu.external_user_id = $1`, [String(CHAT)]))[0].blocked_at));
  await update({ my_chat_member: { chat: { id: CHAT, type: 'private' }, from: from(CHAT), new_chat_member: { status: 'member', user: { id: BOT_ID } } } });
  await wait(300);
});

test('channel: link by @username (bot must be admin), shown in status; settings; check', async () => {
  const wrong = await api('POST', '/integrations/telegram/channel', { token: owner.token, body: { channel: '@nothere' } });
  assert.equal(wrong.status, 400);
  const r = await api('POST', '/integrations/telegram/channel', { token: owner.token, body: { channel: 'https://t.me/vorakidsupdates' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.data.connection.channel.title, 'VORA Kids Updates');
  assert.equal(r.data.connection.channel.link, 'https://t.me/vorakidsupdates');
  const s = await api('PUT', '/integrations/telegram/settings', { token: owner.token, body: { welcome_text: 'Welcome {name} to {business}!' } });
  assert.equal(s.data.connection.welcome_text, 'Welcome {name} to {business}!');
  const c = await api('POST', '/integrations/telegram/check', { token: owner.token });
  assert.equal(c.status, 201);
  assert.equal(c.data.ok, true, JSON.stringify(c.data));
  assert.deepEqual(c.data.steps.map((x) => x.name), ['Bot', 'Webhook', 'Channel']);
});

test('announcements: to the channel and to subscribers with a tag; blocked ones counted as failed', async () => {
  await update({ message: { message_id: mid++, date: 1, chat: { id: CHAT2, type: 'private' }, from: from(CHAT2, 'Ravi', ''), text: '/start' } });
  await until(async () => (await rows(CHAT2)).length >= 2);
  const [cu1] = await sql(`SELECT id FROM bot_channel_user WHERE platform = 'telegram' AND external_user_id = $1`, [String(CHAT)]);
  await sql(`INSERT INTO crm_contact (company_id, bot_channel_user_id, tags, updated_at) VALUES ($1, $2, ARRAY['grade10'], NOW())
    ON CONFLICT (bot_channel_user_id) DO UPDATE SET tags = ARRAY['grade10']`, [owner.companyId, cu1.id]);
  const aud = await api('GET', '/integrations/telegram/audience?tags=Grade10', { token: owner.token });
  assert.equal(aud.data.subscribers, 1);
  assert.equal((await api('GET', '/integrations/telegram/audience', { token: owner.token })).data.subscribers, 2);

  const none = await api('POST', '/integrations/telegram/announcements', { token: owner.token, body: { text: 'x' } });
  assert.equal(none.status, 400);

  const before = calls.length;
  const r = await api('POST', '/integrations/telegram/announcements', { token: owner.token, body: { text: 'No class this Saturday, {name}.', to_channel: true, to_subscribers: true, tags: ['grade10'] } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const done = await until(async () => { const [a] = await sql(`SELECT * FROM telegram_announcement WHERE id = $1`, [r.data.id]); return a.status === 'sent' ? a : null; });
  assert.ok(done, 'finished');
  assert.equal(done.channel_ok, true);
  assert.equal(done.total, 1);
  assert.equal(done.sent, 1);
  const sends = calls.slice(before).filter((c) => c.method === 'sendMessage');
  assert.equal(String(sends[0].body.chat_id), String(CHANNEL));
  assert.equal(sends[0].body.text, 'No class this Saturday, everyone.', 'the channel gets "everyone" for {name}');
  assert.equal(sends[1].body.text, 'No class this Saturday, Kasuni.', 'each subscriber gets their own name');
  const [inChat] = (await rows()).slice(-1);
  assert.equal(inChat.source, 'telegram-announcement');

  // with a photo: uploaded once, then sent by its Telegram id; a blocked subscriber fails
  blockedChats.add(String(CHAT2));
  const form = new FormData();
  form.append('photo', new Blob([PNG], { type: 'image/png' }), 'poster.png');
  form.append('text', 'New batch starts Monday');
  form.append('to_subscribers', 'true');
  const before2 = calls.length;
  const p = await api('POST', '/integrations/telegram/announcements', { token: owner.token, form });
  assert.equal(p.status, 201, JSON.stringify(p.json));
  const done2 = await until(async () => { const [a] = await sql(`SELECT * FROM telegram_announcement WHERE id = $1`, [p.data.id]); return a.status === 'sent' ? a : null; });
  assert.equal(done2.total, 2);
  assert.equal(done2.sent + done2.failed, 2);
  const photos = calls.slice(before2).filter((c) => c.method === 'sendPhoto');
  assert.ok(photos.some((c) => c.body.multipart) && photos.some((c) => c.body.photo === 'uploaded-photo-id') || done2.failed === 1);
  const list = await api('GET', '/integrations/telegram/announcements', { token: owner.token });
  assert.equal(list.data.length, 2);
  blockedChats.delete(String(CHAT2));
});

test('only Telegram: other platforms do not get Telegram behaviour', async () => {
  // a Messenger chat of the same shop still goes to Meta (and fails here because no Page is connected) – never to Telegram
  const [cu] = await sql(`INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name, language, language_locked, bot_enabled, manual_mode, created_at, updated_at)
    VALUES ($1, 'messenger', $2, 'FB customer', 'English', false, false, false, NOW(), NOW()) RETURNING id`, [owner.companyId, `psid-${randomBytes(3).toString('hex')}`]);
  const [conv] = await sql(`INSERT INTO bot_conversation (bot_channel_user_id, status, assignment_mode, created_at, updated_at, last_message_at) VALUES ($1, 'open', 'unassigned', NOW(), NOW(), NOW()) RETURNING id`, [cu.id]);
  const before = calls.length;
  const r = await api('POST', `/bot/conversations/${conv.id}/messages`, { token: owner.token, body: { text: 'hi' } });
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.json.message, /Telegram/);
  assert.equal(calls.length, before, 'nothing went to Telegram');
});

test('disconnect: the webhook is removed and new updates are ignored', async () => {
  const id = webhook.url.match(/(\d+)$/)[1];
  const secret = webhook.secret_token;
  const r = await api('POST', '/integrations/telegram/disconnect', { token: owner.token });
  assert.equal(r.status, 201);
  assert.equal(webhook, null);
  const count = (await rows()).length;
  await api('POST', `/integrations/telegram/webhook/${id}`, { body: { update_id: 9, message: { message_id: mid++, date: 1, chat: { id: CHAT, type: 'private' }, from: from(CHAT), text: 'after' } }, headers: { 'X-Telegram-Bot-Api-Secret-Token': secret } });
  await wait(300);
  assert.equal((await rows()).length, count);
});
