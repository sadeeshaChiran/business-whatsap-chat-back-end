import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createWorkspace, sql, closeDb } from './helpers.mjs';

/**
 * Booking times: a time held by another booking (with the service duration) is never booked twice.
 * Needs the fake bot (salesbot tests/contract_server.py) - it always tries to confirm "book <date> <time>".
 */
test.after(closeDb);

const DATE = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10); // inside the 90 days the bot sees
let owner;
let n = 0;

async function book(time) {
  const phone = `99977${String(Date.now()).slice(-6)}${n++}`;
  const before = await sql('SELECT COUNT(*)::int AS c FROM bot_booking WHERE company_id = $1', [owner.companyId]);
  const sent = await api('POST', '/bot/sales-bot/simulate', { token: owner.token, body: { phone, name: 'Nimal', text: `book ${DATE} ${time}` } });
  assert.equal(sent.status, 201, sent.text);
  const id = sent.data.conversation_id;
  for (let i = 0; i < 40; i++) {
    const [reply] = await sql(`SELECT content FROM bot_message WHERE conversation_id = $1 AND direction = 'outbound' ORDER BY id DESC LIMIT 1`, [id]);
    if (reply) {
      const after = await sql('SELECT COUNT(*)::int AS c FROM bot_booking WHERE company_id = $1', [owner.companyId]);
      return { reply: reply.content, saved: after[0].c > before[0].c };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('no bot reply');
}

test('a booked time (with duration) cannot be booked again; the customer is offered free times', async () => {
  owner = await createWorkspace('book', { category: 'service' });
  await sql('UPDATE companies SET bot_enabled = true WHERE id = $1', [owner.companyId]);
  const settings = await api('PATCH', '/bot/sales-bot/settings', { token: owner.token, body: { opening_hours: '9am - 6pm', sells: 'services' } });
  assert.equal(settings.status, 200, settings.text);
  assert.equal(settings.data.booking_block_status, 'requested'); // default
  const service = await api('POST', '/bot/services', { token: owner.token, body: { name: 'Facial', price: 4500, duration_min: 60 } });
  assert.equal(service.status, 201, service.text);

  const first = await book('10:00');
  assert.ok(first.saved, first.reply);
  const [row] = await sql('SELECT date, time, status FROM bot_booking WHERE company_id = $1', [owner.companyId]);
  assert.deepEqual(row, { date: DATE, time: '10:00', status: 'requested' });

  const same = await book('10:00');
  assert.equal(same.saved, false);
  assert.match(same.reply, /already booked|book karala/i);
  assert.match(same.reply, /09:00|11:00/);

  const overlap = await book('10.30am'); // 10:30-11:30 runs into 10:00-11:00
  assert.equal(overlap.saved, false, overlap.reply);
  const after = await book('11:00');
  assert.ok(after.saved, after.reply);
});

test('setting "confirmed": a requested time can be given to someone else, but two confirmed bookings cannot share it', async () => {
  const set = await api('PATCH', '/bot/sales-bot/settings', { token: owner.token, body: { booking_block_status: 'confirmed' } });
  assert.equal(set.data.booking_block_status, 'confirmed');
  const second = await book('10:00'); // the 10:00 booking is only requested
  assert.ok(second.saved, second.reply);

  const rows = await sql(`SELECT id FROM bot_booking WHERE company_id = $1 AND time = '10:00' ORDER BY id`, [owner.companyId]);
  assert.equal(rows.length, 2);
  const confirmA = await api('PATCH', `/bot/bookings/${rows[0].id}/status`, { token: owner.token, body: { status: 'confirmed' } });
  assert.equal(confirmA.status, 200, confirmA.text);
  const confirmB = await api('PATCH', `/bot/bookings/${rows[1].id}/status`, { token: owner.token, body: { status: 'confirmed' } });
  assert.equal(confirmB.status, 409);
  assert.match(confirmB.json.message, /already has a booking/);

  // now 10:00 is confirmed: the bot refuses it again
  const third = await book('10:00');
  assert.equal(third.saved, false, third.reply);

  // capacity 2 (two staff): the second one can be confirmed
  await api('PATCH', '/bot/sales-bot/settings', { token: owner.token, body: { booking_capacity: 2 } });
  const confirmB2 = await api('PATCH', `/bot/bookings/${rows[1].id}/status`, { token: owner.token, body: { status: 'confirmed' } });
  assert.equal(confirmB2.status, 200, confirmB2.text);
});
