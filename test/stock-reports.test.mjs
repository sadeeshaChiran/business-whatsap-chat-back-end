/**
 * Stock counting + low-stock alerts, and the product / customer / reorder-due reports.
 * Run against a running API + TEST database:  node --test test/stock-reports.test.mjs
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, closeDb, createAgent, createWorkspace, sql } from './helpers.mjs';

let owner; let other; let agent; let supervisor;
let plain; let sized; let conversationId; let customerId;
const ago = (days) => `NOW() - INTERVAL '${days} days'`;
const alertsOf = async (kind) => sql(`SELECT title, message, priority FROM bot_notification WHERE company_id = $1 AND kind = $2 ORDER BY id`, [owner.companyId, kind]);
const stockOf = async (id) => (await api('GET', `/stock/products/${id}`, { token: owner.token })).data;

before(async () => {
  owner = await createWorkspace('stock');
  other = await createWorkspace('stock-other');
  agent = await createAgent(owner, 'stockAgent');
  supervisor = await createAgent(owner, 'stockSuper', { teamRole: 'supervisor' });
  const cat = await api('POST', '/product-catergory', { token: owner.token, body: { name: `Diapers ${Date.now()}` } });
  const a = await api('POST', '/products', { token: owner.token, body: { name: 'Pretty Baby Tape M 30', price: 1450, quantity: 0, category_id: cat.data.id } });
  assert.equal(a.status, 201, a.text);
  plain = a.data;
  const b = await api('POST', '/products', {
    token: owner.token,
    body: {
      name: 'Pretty Baby Pants', price: 895, quantity: 0, category_id: cat.data.id, has_variants: true,
      variants: [{ variant_name: 'Size', variant_value: 'M', price: 895 }, { variant_name: 'Size', variant_value: 'L', price: 995 }],
    },
  });
  assert.equal(b.status, 201, b.text);
  sized = b.data;
  const [cu] = await sql(`INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name) VALUES ($1, 'whatsapp', $2, 'Kasuni') RETURNING id`,
    [owner.companyId, `9477${String(Date.now()).slice(-7)}`]);
  customerId = cu.id;
  const [cv] = await sql(`INSERT INTO bot_conversation (bot_channel_user_id) VALUES ($1) RETURNING id`, [cu.id]);
  conversationId = cv.id;
});
after(closeDb);

describe('stock counting', () => {
  test('is off until switched on; only the owner may change it', async () => {
    const list = await api('GET', '/stock/products', { token: owner.token });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.data.totals.tracked, 0);
    assert.equal(list.data.products.find((p) => p.id === plain.id).track_stock, false);
    assert.equal((await api('PATCH', `/stock/products/${plain.id}`, { token: agent.token, body: { track_stock: true } })).status, 403);
    // supervisors (team leads) may change stock settings too – e.g. the alert level
    assert.equal((await api('PATCH', `/stock/products/${plain.id}`, { token: supervisor.token, body: { low_stock_level: 5 } })).status, 200);
    assert.equal((await api('GET', '/stock/products', { token: supervisor.token })).status, 200);
    // another shop cannot touch it
    assert.equal((await api('PATCH', `/stock/products/${plain.id}`, { token: other.token, body: { track_stock: true } })).status, 404);
    // adjusting before counting is on is refused
    assert.equal((await api('POST', `/stock/products/${plain.id}/adjust`, { token: owner.token, body: { mode: 'set', quantity: 5 } })).status, 400);
  });

  test('switch on, count the shelf, set the alert level', async () => {
    let r = await api('PATCH', `/stock/products/${plain.id}`, { token: owner.token, body: { track_stock: true, low_stock_level: 3, reorder_days: 21 } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.track_stock, true);
    assert.equal(r.data.low_stock_level, 3);
    assert.equal(r.data.reorder_days, 21);
    r = await api('POST', `/stock/products/${plain.id}/adjust`, { token: owner.token, body: { mode: 'set', quantity: 5, note: 'first count' } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.data.stock, 5);
    assert.equal(r.data.state, 'ok');
    assert.equal(r.data.movements[0].reason, 'count');

    await api('PATCH', `/stock/products/${sized.id}`, { token: owner.token, body: { track_stock: true, low_stock_level: 1 } });
    assert.equal((await api('POST', `/stock/products/${sized.id}/adjust`, { token: owner.token, body: { mode: 'set', quantity: 2 } })).status, 400, 'an option must be chosen');
    await api('POST', `/stock/products/${sized.id}/adjust`, { token: owner.token, body: { mode: 'set', quantity: 2, option_label: 'Size: M' } });
    r = await api('POST', `/stock/products/${sized.id}/adjust`, { token: owner.token, body: { mode: 'add', quantity: 10, option_label: 'L' } });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(r.data.options.map((o) => [o.label, o.stock]), [['Size: M', 2], ['Size: L', 10]]);
    assert.equal(r.data.stock, 12);
  });

  test('an order takes stock out, alerts at low / 0 and turns the option Unavailable', async () => {
    const order = await api('POST', `/bot/conversations/${conversationId}/manual-order`, {
      token: owner.token,
      body: { items: [{ product_id: plain.id, quantity: 2 }, { product_id: sized.id, variant_id: 1, quantity: 2 }], customer_name: 'Kasuni', address: '12 Galle Rd', send_invoice: false },
    });
    assert.equal(order.status, 201, order.text);
    const orderId = order.data.order_id;

    const a = await stockOf(plain.id);
    assert.equal(a.stock, 3);
    assert.equal(a.state, 'low');
    assert.equal(a.movements[0].reason, 'order');
    assert.equal(a.movements[0].order_id, orderId);
    const b = await stockOf(sized.id);
    const m = b.options.find((o) => o.label === 'Size: M');
    assert.equal(m.stock, 0);
    assert.equal(m.available, false, 'at 0 the option is Unavailable for the bot');
    assert.equal(m.auto_off, true);
    assert.equal(b.state, 'out');

    const low = await alertsOf('low_stock');
    assert.equal(low.length, 1);
    assert.match(low[0].title, /Low stock: Pretty Baby Tape M 30/);
    const out = await alertsOf('out_of_stock');
    assert.equal(out.length, 1);
    assert.match(out[0].title, /Out of stock: Pretty Baby Pants \(Size: M\)/);
    assert.equal(out[0].priority, 'HIGH');
    const alerts = await api('GET', '/stock/alerts', { token: owner.token });
    assert.deepEqual([alerts.data.low, alerts.data.out], [1, 1]);
    // the notification bell opens the Stock page
    const feed = await api('GET', '/notifications', { token: owner.token });
    const item = (feed.data?.items ?? feed.data ?? []).find((n) => String(n.title).startsWith('Out of stock'));
    if (item) assert.equal(item.related_entity_type, 'stock');

    // cancelled → everything back, the option is Available again (it was switched off automatically)
    let s = await api('POST', `/bot/orders/${orderId}/status`, { token: owner.token, body: { status: 'Cancelled' } });
    assert.equal(s.status, 201, s.text);
    assert.equal((await stockOf(plain.id)).stock, 5);
    const back = (await stockOf(sized.id)).options.find((o) => o.label === 'Size: M');
    assert.equal(back.stock, 2);
    assert.equal(back.available, true);

    // back to Pending → taken again; no second alert for the same crossing is sent twice in a row
    s = await api('POST', `/bot/orders/${orderId}/status`, { token: owner.token, body: { status: 'Pending' } });
    assert.equal(s.status, 201, s.text);
    assert.equal((await stockOf(plain.id)).stock, 3);
    // the same status again changes nothing
    await api('POST', `/bot/orders/${orderId}/update`, { token: owner.token, body: { address: '14 Galle Rd' } });
    assert.equal((await stockOf(plain.id)).stock, 3);

    // deleted → back
    const del = await api('DELETE', `/bot/orders/${orderId}`, { token: owner.token });
    assert.equal(del.status, 200, del.text);
    assert.equal((await stockOf(plain.id)).stock, 5);
    const reasons = (await stockOf(plain.id)).movements.map((mv) => mv.reason);
    assert.deepEqual(reasons.slice(0, 4), ['order_deleted', 'order', 'order_cancelled', 'order']);
  });

  test('saving the product form never changes counted stock', async () => {
    const r = await api('PATCH', `/products/${sized.id}`, {
      token: owner.token,
      body: { name: 'Pretty Baby Pants', price: 895, quantity: 0, variants: [{ variant_name: 'Size', variant_value: 'M', price: 895, quantity: 0 }, { variant_name: 'Size', variant_value: 'L', price: 1000, quantity: 0 }] },
    });
    assert.equal(r.status, 200, r.text);
    const b = await stockOf(sized.id);
    assert.deepEqual(b.options.map((o) => [o.label, o.stock]), [['Size: M', 2], ['Size: L', 10]]);
    const p = await api('PATCH', `/products/${plain.id}`, { token: owner.token, body: { quantity: 0, price: 1450 } });
    assert.equal(p.status, 200, p.text);
    assert.equal((await stockOf(plain.id)).stock, 5);
  });

  test('received stock switches an automatic Unavailable back on; a manual one stays', async () => {
    await api('POST', `/stock/products/${plain.id}/adjust`, { token: owner.token, body: { mode: 'set', quantity: 0 } });
    let [row] = await sql('SELECT is_available, stock_auto_off FROM product WHERE id = $1', [plain.id]);
    assert.deepEqual([row.is_available, row.stock_auto_off], [false, true]);
    await api('POST', `/stock/products/${plain.id}/adjust`, { token: owner.token, body: { mode: 'add', quantity: 24 } });
    [row] = await sql('SELECT is_available, stock_auto_off, quantity FROM product WHERE id = $1', [plain.id]);
    assert.deepEqual([row.is_available, row.stock_auto_off, row.quantity], [true, false, 24]);
    // manual Unavailable, then stock added: stays Unavailable
    await api('PATCH', `/products/${plain.id}/availability`, { token: owner.token, body: { available: false } });
    await api('POST', `/stock/products/${plain.id}/adjust`, { token: owner.token, body: { mode: 'add', quantity: 1 } });
    [row] = await sql('SELECT is_available FROM product WHERE id = $1', [plain.id]);
    assert.equal(row.is_available, false);
    await api('PATCH', `/products/${plain.id}/availability`, { token: owner.token, body: { available: true } });
  });
});

describe('reports', () => {
  test('product report: views, summaries, orders, asked while unavailable, not in catalog', async () => {
    // orders: one old (for reorder), one recent
    for (const days of [42, 21]) {
      const [o] = await sql(`INSERT INTO bot_order (company_id, bot_channel_user_id, customer_name, status, total_amount, created_by, created_at)
        VALUES ($1, $2, 'Kasuni', 'Delivered', 2900, 'bot', ${ago(days)}) RETURNING id`, [owner.companyId, customerId]);
      await sql(`INSERT INTO bot_order_item (order_id, product_id, product_name, quantity, unit_price, total_price, created_at) VALUES ($1, $2, 'Pretty Baby Tape M 30', 2, 1450, 2900, ${ago(days)})`, [o.id, plain.id]);
    }
    const [cv2] = await sql(`INSERT INTO bot_conversation (bot_channel_user_id) VALUES ($1) RETURNING id`, [customerId]);
    for (const conv of [conversationId, cv2.id]) {
      await sql(`INSERT INTO product_demand_event (company_id, product_id, event, conversation_id, bot_channel_user_id) VALUES ($1, $2, 'shown', $3, $4)`, [owner.companyId, plain.id, conv, customerId]);
    }
    await sql(`INSERT INTO product_demand_event (company_id, product_id, event, conversation_id, bot_channel_user_id) VALUES ($1, $2, 'cart', $3, $4)`, [owner.companyId, plain.id, conversationId, customerId]);
    await sql(`INSERT INTO product_demand_event (company_id, product_id, event, option_label, query_text, conversation_id, bot_channel_user_id) VALUES ($1, $2, 'unavailable', 'Size: M', 'M size 2k one', $3, $4)`, [owner.companyId, sized.id, conversationId, customerId]);
    await sql(`INSERT INTO product_demand_event (company_id, event, query_text, conversation_id, bot_channel_user_id) VALUES ($1, 'no_match', 'Huggies thiyenawada?', $2, $3), ($1, 'no_match', 'huggies thiyenawada', $4, $3)`,
      [owner.companyId, conversationId, customerId, cv2.id]);
    // a test chat is not counted
    await sql(`INSERT INTO product_demand_event (company_id, product_id, event, conversation_id, is_test) VALUES ($1, $2, 'shown', 999999, true)`, [owner.companyId, plain.id]);

    const r = await api('GET', '/reports/products?days=30', { token: owner.token });
    assert.equal(r.status, 200, r.text);
    const a = r.data.products.find((p) => p.id === plain.id);
    assert.equal(a.shown, 2);
    assert.equal(a.cart, 1);
    assert.equal(a.orders, 1, 'only the order inside 30 days');
    assert.equal(a.qty, 2);
    assert.equal(a.revenue, 2900);
    assert.equal(a.conversion, 50);
    assert.equal(r.data.products.find((p) => p.id === sized.id).unavailable, 1);
    assert.equal(r.data.unavailable[0].option_label, 'Size: M');
    assert.equal(r.data.not_in_catalog.length, 1, 'the same question from two chats is one line');
    assert.equal(r.data.not_in_catalog[0].asks, 2);
    assert.ok(r.data.findings.some((line) => line.includes('Best seller: Pretty Baby Tape M 30')), r.data.findings.join(' | '));

    const detail = await api('GET', `/reports/products/${plain.id}?days=90`, { token: owner.token });
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.data.buyers[0].customer_id, customerId);
    assert.equal(detail.data.buyers[0].qty, 4);
    assert.equal(detail.data.daily.length, 90);
  });

  test('customer purchases: list, filter by product, one customer with what is due', async () => {
    const r = await api('GET', '/reports/customers?days=365', { token: owner.token });
    assert.equal(r.status, 200, r.text);
    const c = r.data.customers.find((row) => row.id === customerId);
    assert.equal(c.orders, 2);
    assert.equal(c.spent, 5800);
    assert.equal(c.orders_every_days, 21);
    assert.equal(c.top_products[0].name, 'Pretty Baby Tape M 30');
    assert.equal(r.data.totals.repeat_customers, 1);
    const none = await api('GET', `/reports/customers?days=365&product_id=${sized.id}`, { token: owner.token });
    assert.equal(none.data.customers.length, 0);

    const d = await api('GET', `/reports/customers/${customerId}`, { token: owner.token });
    assert.equal(d.status, 200, d.text);
    assert.equal(d.data.totals.orders, 2);
    assert.equal(d.data.products[0].every_days, 21);
    assert.equal(d.data.products[0].next.state, 'due');
    assert.equal((await api('GET', `/reports/customers/${customerId}`, { token: other.token })).status, 404);
  });

  test('reorder due: from the customer history, then a CRM tag for a broadcast', async () => {
    const r = await api('GET', '/reports/reorder?window=7', { token: owner.token });
    assert.equal(r.status, 200, r.text);
    const item = r.data.items.find((i) => i.customer_id === customerId && i.product_id === plain.id);
    assert.ok(item, JSON.stringify(r.data.items));
    assert.equal(item.every_days, 21);
    assert.equal(item.based_on, 'history');
    assert.equal(item.state, 'due');
    assert.equal(item.conversation_id > 0, true);

    const tag = await api('POST', '/reports/reorder/tag', { token: owner.token, body: { customer_ids: [customerId], tag: 'Reorder-Due' } });
    assert.equal(tag.status, 201, tag.text);
    assert.equal(tag.data.tagged, 1);
    const [contact] = await sql('SELECT tags FROM crm_contact WHERE bot_channel_user_id = $1', [customerId]);
    assert.ok(contact.tags.includes('reorder-due'));
    // another shop's customer ids are ignored
    const foreign = await api('POST', '/reports/reorder/tag', { token: other.token, body: { customer_ids: [customerId], tag: 'x' } });
    assert.equal(foreign.data.tagged, 0);
  });

  test('agents cannot open reports; supervisors can', async () => {
    for (const path of ['/reports/products', '/reports/customers', '/reports/reorder', '/stock/products']) {
      assert.equal((await api('GET', path, { token: agent.token })).status, 403, path);
      assert.equal((await api('GET', path, { token: supervisor.token })).status, 200, path);
    }
  });
});
