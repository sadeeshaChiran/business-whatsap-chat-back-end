import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createWorkspace, sql, closeDb } from './helpers.mjs';

/** Customer simulator: messages show even when the shop's WhatsApp is Evolution, and a silent bot says why. */
test.after(closeDb);

test('simulator chat shows its messages with an Evolution channel and explains a silent bot', async () => {
  const owner = await createWorkspace('sim');
  await sql(`INSERT INTO whatsapp_channels (company_id, role_type, instance_name, evolution_instance_name, status, weight, created_at, evaluation_whatsapp_key, provider_type, evolution_api_base)
    VALUES ($1, 'sales', 'sim-test', 'sim-test', 'active', 1, NOW(), 'k', 'evolution', 'http://127.0.0.1:9')`, [owner.companyId]);
  await sql('UPDATE companies SET bot_enabled = false WHERE id = $1', [owner.companyId]);
  const sent = await api('POST', '/bot/sales-bot/simulate', { token: owner.token, body: { phone: '94770001122', name: 'Sim', text: 'romper kiyada?' } });
  assert.equal(sent.status, 201, sent.text);
  assert.match(sent.data.bot_note, /switched off/);
  const thread = await api('GET', `/bot/conversations/${sent.data.conversation_id}?page=1&limit=60`, { token: owner.token });
  assert.equal(thread.status, 200);
  assert.deepEqual(thread.data.messages.map((m) => m.content), ['romper kiyada?']);
});
