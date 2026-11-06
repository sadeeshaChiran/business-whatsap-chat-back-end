import { orderToHandle } from './sales-bot-engine.service';

/** "ow confirm" after the summary: a confirm without items must still reach handleOrder (it was dropped – nothing saved). */
describe('confirm without items', () => {
  const pending: any = { items: [{ product_id: 7, variant_id: null, variant_name: null, quantity: 2, product_name: 'X', unit_price: 1, total_price: 2 },
    { product_id: 9, variant_id: 3, variant_name: 'M', quantity: 1 }], summary_shown: true, address: 'Kandy', customer_name: 'Nimali' };

  it('uses the items of the order in progress', () => {
    const order = orderToHandle({ reply: 'ස්තූතියි!', order: { confirm_order: true, items: [] } as any }, pending);
    expect(order).toMatchObject({ confirm_order: true, items: [{ product_id: 7, quantity: 2 }, { product_id: 9, variant_id: 3, quantity: 1 }] });
  });

  it('items sent by the AI stay as they are; nothing open -> nothing', () => {
    const own: any = { confirm_order: true, items: [{ product_id: 5, quantity: 1 }] };
    expect(orderToHandle({ order: own }, pending)).toBe(own);
    expect(orderToHandle({ order: { confirm_order: true, items: [] } as any }, null)).toBeNull();
    expect(orderToHandle({ reply: 'Hari', order: null }, pending)).toBeNull();
  });
});
