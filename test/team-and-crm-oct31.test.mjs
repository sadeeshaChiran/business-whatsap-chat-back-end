/**
 * 31 Oct round: supervisors work like the admin (not billing / package / agents' passwords), team emails are confirmed
 * at the first login (the first to confirm an email owns it), customer notes open the chat they were written in,
 * contacts import with a preview (rows), form answers as Excel + chat photos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { API, PASSWORD, RUN, api, closeDb, createWorkspace, login, sql } from './helpers.mjs';

let shop; let other;
const addTeam = async (owner, email, teamRole = 'agent') => {
  const r = await api('POST', '/users/agents', { token: owner.token, body: { name: `T ${email.split('@')[0]}`, email, password: PASSWORD, team_role: teamRole } });
  if (r.status === 400 && /package allows/.test(String(r.json?.message))) {
    await sql(`UPDATE companies SET plan = 'business' WHERE id = $1`, [owner.companyId]);
    return addTeam(owner, email, teamRole);
  }
  return r;
};
/** login → (confirm email with the dev code) → token */
const confirmLogin = async (email, newEmail) => {
  const first = await login(email);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  if (!first.data.email_verification_required) return first.data;
  const sent = await api('POST', '/auth/login/confirm-email/send', { body: { verify_token: first.data.verify_token, ...(newEmail ? { email: newEmail } : {}) } });
  if (sent.status !== 200) return { error: sent };
  const done = await api('POST', '/auth/login/confirm-email', { body: { verify_token: first.data.verify_token, code: sent.data.dev_code } });
  return done.status === 200 ? done.data : { error: done };
};

test.before(async () => {
  shop = await createWorkspace('oct31');
  other = await createWorkspace('oct31b');
  await sql(`UPDATE companies SET plan = 'business' WHERE id = ANY($1)`, [[shop.companyId, other.companyId]]);
});
test.after(async () => { await closeDb(); });

test('team email: confirmed at the first login; a wrong email does not lock it; the first to confirm owns it', async () => {
  const shared = `shared-${RUN}@test.agentmetra.lk`;
  assert.equal((await addTeam(shop, shared)).status, 201);
  // another business can add the same (unconfirmed) email
  const second = await addTeam(other, shared);
  assert.equal(second.status, 201, JSON.stringify(second.json));
  // but not twice in one company
  assert.equal((await addTeam(shop, shared)).status, 409);
  const first = await login(shared);
  assert.equal(first.data.email_verification_required, true);
  assert.equal(first.data.access_token, undefined, 'no session before the email is confirmed');
  const sent = await api('POST', '/auth/login/confirm-email/send', { body: { verify_token: first.data.verify_token } });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal((await api('POST', '/auth/login/confirm-email', { body: { verify_token: first.data.verify_token, code: '000000' } })).status, 400);
  const ok = await api('POST', '/auth/login/confirm-email', { body: { verify_token: first.data.verify_token, code: sent.data.dev_code } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.ok(ok.data.access_token);
  // the next login is a normal one, and the old token can't be used again (e.g. to move the email away)
  assert.ok((await login(shared)).data.access_token);
  assert.equal((await api('POST', '/auth/login/confirm-email/send', { body: { verify_token: first.data.verify_token, email: `evil-${RUN}@test.agentmetra.lk` } })).status, 401);
  // the other account with that email: same password → logs into the confirmed one; it can't take the email any more
  const [row] = await sql(`SELECT id FROM app_user WHERE LOWER(email) = $1 AND company_id = $2`, [shared, other.companyId]);
  await sql(`UPDATE app_user SET password_hash = (SELECT password_hash FROM app_user WHERE id = $1) WHERE id = $1`, [row.id]);
  const token = (await api('POST', '/auth/login', { body: { email: shared, password: PASSWORD } })).data;
  assert.equal(Number(token.user.company_id), Number(shop.companyId), 'the confirmed account wins');
  // its owner can't add that email again, and the unconfirmed person moves to their own email
  const third = await addTeam(other, shared);
  assert.equal(third.status, 409);
  // a password change makes a waiting token useless
  const tvEmail = `tv-${RUN}@test.agentmetra.lk`;
  const made = await addTeam(shop, tvEmail);
  const pending = (await login(tvEmail)).data;
  await api('POST', `/users/agents/${made.data.id}/reset-password`, { token: shop.token, body: { password: 'Changed12345' } });
  assert.equal((await api('POST', '/auth/login/confirm-email/send', { body: { verify_token: pending.verify_token } })).status, 401);
  // a forged / old token is refused
  assert.equal((await api('POST', '/auth/login/confirm-email/send', { body: { verify_token: 'x'.repeat(40) } })).status, 401);
});

test('team email: the person types their real email when the admin typed a wrong one', async () => {
  const wrong = `typo-${RUN}@test.agentmetra.lk`;
  const real = `real-${RUN}@test.agentmetra.lk`;
  assert.equal((await addTeam(shop, wrong)).status, 201);
  const done = await confirmLogin(wrong, real);
  assert.ok(done.access_token, JSON.stringify(done.error?.json));
  assert.equal(done.user.email, real);
  assert.ok((await login(real)).data.access_token);
  assert.equal((await login(wrong)).status, 401, 'the wrong email is gone');
  // someone else can't move to an email another account confirmed
  const third = `third-${RUN}@test.agentmetra.lk`;
  await addTeam(other, third);
  const res = await confirmLogin(third, real);
  assert.equal(res.error?.status, 409);
  // an owner signs up with an email an agent never confirmed
  const loose = `loose-${RUN}@test.agentmetra.lk`;
  await addTeam(shop, loose);
  const start = await api('POST', '/auth/register/start', { body: { name: 'Owner', email: loose, password: PASSWORD, phone: '0779998877', company: { name: `Loose ${RUN}` } } });
  assert.equal(start.status, 201, JSON.stringify(start.json));
});

test('supervisor works like the admin, except billing / package / agents passwords and the owner account', async () => {
  const email = `sup-${RUN}@test.agentmetra.lk`;
  const created = await addTeam(shop, email, 'supervisor');
  assert.equal(created.status, 201);
  const sup = await confirmLogin(email);
  const t = sup.access_token;
  assert.equal((await api('GET', '/flows/forms', { token: t })).status, 200, 'forms');
  assert.equal((await api('GET', '/bot/sales-bot/settings', { token: t })).status, 200, 'sales bot');
  assert.equal((await api('GET', '/billing/overview', { token: t })).status, 403, 'billing is the owner\'s');
  assert.equal((await api('PATCH', `/company/${shop.companyId}`, { token: t, body: { plan: 'free' } })).status, 403, 'package');
  const agent = await addTeam(shop, `ag-${RUN}@test.agentmetra.lk`);
  assert.equal((await api('PATCH', `/users/agents/${agent.data.id}`, { token: t, body: { name: 'Renamed by sup' } })).status, 200);
  assert.equal((await api('POST', `/users/agents/${agent.data.id}/reset-password`, { token: t, body: { password: 'Another1234' } })).status, 403);
  assert.equal((await api('PATCH', `/users/agents/${shop.user.id}`, { token: t, body: { name: 'Hacked' } })).status, 403, 'not the owner');
});

test('a customer note opens the chat it was written in', async () => {
  const phone = `9477${String(Date.now()).slice(-7)}`;
  const [cu] = await sql(`INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name) VALUES ($1, 'whatsapp', $2, 'Note Test') RETURNING id`, [shop.companyId, phone]);
  const [c1] = await sql(`INSERT INTO bot_conversation (bot_channel_user_id, status, created_at) VALUES ($1, 'closed', NOW() - INTERVAL '3 days') RETURNING id`, [cu.id]);
  await sql(`INSERT INTO bot_customer_note (company_id, bot_channel_user_id, content, created_at) VALUES ($1, $2, 'old note', NOW() - INTERVAL '2 days')`, [shop.companyId, cu.id]);
  const [c2] = await sql(`INSERT INTO bot_conversation (bot_channel_user_id, status) VALUES ($1, 'open') RETURNING id`, [cu.id]);
  await sql(`INSERT INTO bot_customer_note (company_id, bot_channel_user_id, content) VALUES ($1, $2, 'new note')`, [shop.companyId, cu.id]);
  const notes = (await api('GET', '/bot/notes', { token: shop.token })).data.filter((n) => n.bot_channel_user_id === cu.id);
  assert.equal(notes.find((n) => n.content === 'old note').conversation_id, c1.id);
  assert.equal(notes.find((n) => n.content === 'new note').conversation_id, c2.id);
});

test('contacts import: rows from the preview – added, updated, skipped with reasons; sample file', async () => {
  const p1 = `0778${String(Date.now()).slice(-6)}`;
  const r = await api('POST', '/crm/contacts/import/rows', { token: shop.token, body: { rows: [
    { name: 'Imp One', phone: p1, email: 'one@example.com', tags: 'vip; colombo', stage: 'contacted', deal_value: 'Rs 15,000', note: 'Wants shoes' },
    { name: 'Bad', phone: '12' },
    { name: 'Dup', phone: p1 },
    { name: 'Bad stage', phone: '0771112223', stage: 'maybe' },
    { name: 'Bad deal', phone: '0771112224', deal_value: '1..2' },
  ] } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.data.created, 1);
  assert.deepEqual(r.data.skipped.map((s) => s.row), [2, 3, 4, 5]);
  const again = await api('POST', '/crm/contacts/import/rows', { token: shop.token, body: { rows: [{ name: 'Imp One Renamed', phone: `94${p1.slice(1)}`, tags: 'wholesale' }] } });
  assert.equal(again.data.updated, 1);
  const [c] = await sql(`SELECT cc.tags, cc.stage, cc.deal_value, cu.display_name FROM crm_contact cc JOIN bot_channel_user cu ON cu.id = cc.bot_channel_user_id WHERE cu.company_id = $1 AND cu.external_user_id = $2`, [shop.companyId, `94${p1.slice(1)}`]);
  assert.deepEqual([...c.tags].sort(), ['colombo', 'vip', 'wholesale']);
  assert.equal(c.stage, 'contacted');
  assert.equal(Number(c.deal_value), 15000);
  assert.equal(c.display_name, 'Imp One Renamed');
  const tpl = await fetch(`${API}/crm/contacts/import/template`, { headers: { Authorization: `Bearer ${shop.token}` } });
  assert.equal(tpl.status, 200);
  assert.match(tpl.headers.get('content-type'), /spreadsheetml/);
  const form = new FormData();
  form.append('file', new Blob(['Full Name,Mobile,Tags\nNimal,0771234567,vip\n'], { type: 'text/csv' }), 'c.csv');
  const read = await fetch(`${API}/crm/contacts/import/read`, { method: 'POST', headers: { Authorization: `Bearer ${shop.token}` }, body: form });
  const body = await read.json();
  assert.deepEqual(body.data.headers, ['Full Name', 'Mobile', 'Tags']);
  assert.deepEqual(body.data.rows, [['Nimal', '0771234567', 'vip']]);
});

test('form answers: Excel download and chat photos linked to their message', async () => {
  const f = await api('POST', '/flows/forms', { token: shop.token, body: { name: 'Details', fields: [{ id: 'name', label: 'Your name', type: 'text' }, { id: 'pic', label: 'Image', type: 'photo' }] } });
  assert.equal(f.status, 201, JSON.stringify(f.json));
  const [cu] = await sql(`INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name) VALUES ($1, 'whatsapp', $2, 'Sadee') RETURNING id`, [shop.companyId, `9471${String(Date.now()).slice(-7)}`]);
  const [conv] = await sql(`INSERT INTO bot_conversation (bot_channel_user_id, status) VALUES ($1, 'open') RETURNING id`, [cu.id]);
  const [msg] = await sql(`INSERT INTO bot_message (conversation_id, direction, message_type, platform, content, media_url) VALUES ($1, 'inbound', 'image', 'whatsapp', '[image]', 'meta-media:1659271932514582') RETURNING id`, [conv.id]);
  await sql(`INSERT INTO chat_form_submission (form_id, company_id, bot_channel_user_id, conversation_id, answers, source, channel) VALUES ($1, $2, $3, $4, $5::jsonb, 'chat', 'whatsapp')`,
    [f.data.id, shop.companyId, cu.id, conv.id, JSON.stringify({ name: 'Sadee', pic: 'meta-media:1659271932514582' })]);
  const subs = await api('GET', `/flows/forms/${f.data.id}/submissions`, { token: shop.token });
  assert.deepEqual(subs.data.submissions[0].photos.pic, { conversation_id: conv.id, message_id: msg.id });
  const x = await fetch(`${API}/flows/forms/${f.data.id}/answers.xlsx`, { headers: { Authorization: `Bearer ${shop.token}` } });
  assert.equal(x.status, 200);
  assert.ok((await x.arrayBuffer()).byteLength > 1000);
});
