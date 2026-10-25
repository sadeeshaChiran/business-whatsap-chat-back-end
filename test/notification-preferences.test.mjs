/**
 * Notification settings – run against a running API + TEST database:
 *   node --test test/notification-preferences.test.mjs
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, closeDb, createAgent, createWorkspace, sql } from './helpers.mjs';

let A; let agent;
before(async () => { A = await createWorkspace('notif'); agent = await createAgent(A, 'notif-agent'); });
after(closeDb);

describe('Notification settings', () => {
  test('defaults: everything on, quiet hours off', async () => {
    const r = await api('GET', '/notifications/preferences', { token: A.token });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.data.messages, 'all');
    assert.equal(r.data.orders, true);
    assert.equal(r.data.quiet_enabled, false);
    assert.equal(r.data.saved, false);
  });

  test('each person saves their own settings', async () => {
    const saved = await api('PUT', '/notifications/preferences', { token: A.token, body: { messages: 'off', order_changes: false, quiet_enabled: true, quiet_start: '21:30', quiet_end: '06:45' } });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.data.messages, 'off');
    assert.equal(saved.data.order_changes, false);
    assert.equal(saved.data.orders, true, 'untouched switches stay');
    assert.equal(saved.data.quiet_start, '21:30');
    const [row] = await sql('SELECT messages, company_id FROM notification_preference WHERE user_id = $1', [A.user.id]);
    assert.equal(row.messages, 'off');
    assert.equal(Number(row.company_id), Number(A.companyId));
    // the agent's settings are separate
    assert.equal((await api('GET', '/notifications/preferences', { token: agent.token })).data.messages, 'all');
    assert.equal((await api('PUT', '/notifications/preferences', { token: agent.token, body: { messages: 'attention' } })).data.messages, 'attention');
    assert.equal((await api('GET', '/notifications/preferences', { token: A.token })).data.messages, 'off');
  });

  test('bad values are refused', async () => {
    assert.equal((await api('PUT', '/notifications/preferences', { token: A.token, body: { messages: 'loud' } })).status, 400);
    assert.equal((await api('PUT', '/notifications/preferences', { token: A.token, body: { quiet_start: '25:00' } })).status, 400);
    assert.equal((await api('GET', '/notifications/preferences')).status, 401);
  });
});
