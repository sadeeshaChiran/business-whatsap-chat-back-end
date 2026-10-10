import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createWorkspace, sql, closeDb } from './helpers.mjs';

/**
 * Bookings like orders: the customer changes or cancels a booking in chat (no second booking), notes record it,
 * and a booking invoice PDF goes out. Needs the fake bot (salesbot tests/contract_server.py).
 */
test.after(closeDb);

const DATE = new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10);
let owner;
let n = 0;
const phoneA = `99977${String(Date.now()).slice(-6)}1`;
const phoneB = `99977${String(Date.now()).slice(-6)}2`;

async function say(phone, text) {
  const [last] = await sql(`SELECT COALESCE(MAX(m.id), 0) AS id FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id
    JOIN bot_channel_user u ON u.id = c.bot_channel_user_id WHERE u.company_id = $1 AND u.external_user_id = $2`, [owner.companyId, phone]);
  const sent = await api('POST', '/bot/sales-bot/simulate', { token: owner.token, body: { phone, name: `Customer ${n++}`, text } });
  assert.equal(sent.status, 201, sent.text);
  for (let i = 0; i < 40; i++) {
    const rows = await sql(`SELECT content FROM bot_message WHERE conversation_id = $1 AND direction = 'outbound' AND id > $2 ORDER BY id`, [sent.data.conversation_id, last.id]);
    if (rows.length) { await new Promise((r) => setTimeout(r, 600)); return (await sql(`SELECT content FROM bot_message WHERE conversation_id = $1 AND direction = 'outbound' AND id > $2 ORDER BY id`, [sent.data.conversation_id, last.id])).map((r) => r.content); }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('no bot reply');
}
const bookingsOf = () => sql('SELECT id, date, time, status, notes, price, duration_min, bot_channel_user_id FROM bot_booking WHERE company_id = $1 ORDER BY id', [owner.companyId]);

test('change and cancel a booking in chat, with notes and a booking invoice', async () => {
  owner = await createWorkspace('bookchg', { category: 'service' });
  await sql('UPDATE companies SET bot_enabled = true WHERE id = $1', [owner.companyId]);
  await api('PATCH', '/bot/sales-bot/settings', { token: owner.token, body: { opening_hours: '9am - 6pm', sells: 'services' } });
  await api('POST', '/bot/services', { token: owner.token, body: { name: 'Facial', price: 4500, duration_min: 60 } });

  const booked = await say(phoneA, `book ${DATE} 10:00`);
  let [mine] = await bookingsOf();
  assert.equal(mine.price, '4500.00');
  assert.equal(mine.duration_min, 60);
  assert.ok(booked.some((t) => t.includes(`booking invoice #${mine.id}`)), booked.join(' | ')); // the PDF (not sent in the simulator)

  // 10:00 -> 10:30 overlaps only its own old time: allowed, the same booking is changed (no second booking)
  await say(phoneA, `move booking ${mine.id} ${DATE} 10:30`);
  let rows = await bookingsOf();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].time, '10:30');
  assert.match(rows[0].notes, /Changed by the customer: Facial .* 10:00 → Facial .* 10:30/);
  const [alert] = await sql(`SELECT kind FROM bot_notification WHERE company_id = $1 AND kind = 'booking_changed'`, [owner.companyId]);
  assert.ok(alert);

  // another customer has 12:00: moving there is refused, nothing changes
  await say(phoneB, `book ${DATE} 12:00`);
  const refused = await say(phoneA, `move booking ${mine.id} ${DATE} 12:00`);
  assert.match(refused.join(' '), /already booked/);
  [mine] = await bookingsOf();
  assert.equal(mine.time, '10:30');

  // a confirmed booking that is changed goes back to "requested" (the team confirms the new time)
  assert.equal((await api('PATCH', `/bot/bookings/${mine.id}/status`, { token: owner.token, body: { status: 'confirmed' } })).status, 200);
  await say(phoneA, `move booking ${mine.id} ${DATE} 14:00`);
  [mine] = await bookingsOf();
  assert.equal(mine.time, '14:00');
  assert.equal(mine.status, 'requested');
  assert.match(mine.notes, /was confirmed, please confirm the new time/);

  const bill = await say(phoneA, `booking bill ${mine.id}`);
  assert.ok(bill.some((t) => t.includes(`booking invoice #${mine.id}`)), bill.join(' | '));

  await say(phoneA, `cancel booking ${mine.id}`);
  [mine] = await bookingsOf();
  assert.equal(mine.status, 'cancelled');
  assert.match(mine.notes, /Cancelled by the customer: cannot come/);
  // the time is free again
  await say(phoneB, `book ${DATE} 14:00`);
  assert.equal((await bookingsOf()).filter((r) => r.time === '14:00' && r.status === 'requested').length, 1);
});

test('Bookings page: edit notes and send the booking invoice', async () => {
  const [row] = await bookingsOf();
  const notes = await api('PATCH', `/bot/bookings/${row.id}/notes`, { token: owner.token, body: { notes: 'Customer prefers Nimali' } });
  assert.equal(notes.status, 200, notes.text);
  assert.equal(notes.data.notes, 'Customer prefers Nimali');
  const invoice = await api('POST', `/bot/bookings/${row.id}/invoice`, { token: owner.token });
  assert.equal(invoice.status, 201, invoice.text);
  assert.equal(invoice.data.booking_id, row.id);
  assert.equal(invoice.data.sent, true); // 999 test number: saved, never sent to WhatsApp
  const list = await api('GET', '/bot/bookings', { token: owner.token });
  assert.equal(list.data.find((b) => b.id === row.id).price, 4500);
});

test('delivery zone weight rounding: new zones round up, the setting is saved', async () => {
  const zone = await api('POST', '/bot/delivery-zones', { token: owner.token, body: { area: 'Kandy', fee: 350, included_kg: 1, per_extra_kg: 100 } });
  assert.equal(zone.status, 201, zone.text);
  assert.equal(zone.data.weight_rounding, 'up');
  const changed = await api('PATCH', `/bot/delivery-zones/${zone.data.id}`, { token: owner.token, body: { weight_rounding: 'nearest' } });
  assert.equal(changed.data.weight_rounding, 'nearest');
  assert.equal((await api('PATCH', `/bot/delivery-zones/${zone.data.id}`, { token: owner.token, body: { weight_rounding: 'half' } })).status, 400);
});
