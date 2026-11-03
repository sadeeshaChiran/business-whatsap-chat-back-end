import { SalesBotEngineService, SUMMARY_WORDS } from './sales-bot-engine.service';

/** The AI says "here is the summary 👇" but a detail is missing: the customer must be asked, never left without a summary. */
function engine() {
  const args: any[] = Array.from({ length: 24 }, () => ({}));
  args[8] = { findOne: async () => ({ id: 5, name: 'Vacuum Cleaner', price: 3200, is_available: true, variants: [], weight: 1 }) }; // products
  args[10] = { find: async () => [{ area: '*', fee: 350, included_kg: 1, per_extra_kg: 200, weight_rounding: 'up' }] };       // zones
  args[14] = { getSettings: async () => ({ free_delivery_over: null }) };                                                    // context
  const service = new (SalesBotEngineService as any)(...args);
  service.advanceLead = async () => undefined;
  return service as any;
}
const whatsappUser = { platform: 'whatsapp', external_user_id: '94771234567' };

describe('summary turn with missing details', () => {
  it('asks for the address instead of sending the summary line alone', async () => {
    const session: any = {};
    const out = await engine().handleOrder(16, { id: 1 }, whatsappUser,
      { items: [{ product_id: 5, quantity: 1 }], customer_name: 'Sadisha', address: '', summary_shown: true }, session);
    expect(out).toBe('cart:address');   // the items so far + total, then 'please send your address'
    expect(session.pending_order.summary_shown).toBe(false);
  });

  it('shows the summary when everything is there', async () => {
    const session: any = {};
    const out = await engine().handleOrder(16, { id: 1 }, whatsappUser,
      { items: [{ product_id: 5, quantity: 1 }], customer_name: 'Sadisha', address: '12 Galle Road, Colombo', delivery_area: '*', summary_shown: true }, session);
    expect(out).toBe('summary_shown');
    expect(session.pending_order.summary_shown).toBe(true);
  });

  it('"ok" after the summary saves the order the customer saw, even when the AI left out the address', async () => {
    const service = engine();
    const saved: any[] = [];
    const repo = { create: (row: any) => row, save: async (row: any) => { saved.push(row); return { id: 77, ...row }; } };
    Object.assign(service, { orderRepository: repo, orderItemRepository: repo, orderHistoryRepository: repo,
      channelUserRepository: { update: async () => undefined }, pusherService: { trigger: () => undefined },
      notifyTeam: async () => undefined, customerAgent: async () => null });
    const session: any = {};
    await service.handleOrder(16, { id: 1 }, whatsappUser,
      { items: [{ product_id: 5, quantity: 2 }], customer_name: 'Sunil', address: '22 Lake Road, Colombo', delivery_area: '*', summary_shown: true }, session);
    const out = await service.handleOrder(16, { id: 1 }, whatsappUser, { confirm_order: true, customer_name: 'Sunil' }, session);
    expect(out).toBe('saved:77');
    expect(saved[0]).toMatchObject({ address: '22 Lake Road, Colombo', customer_name: 'Sunil', total_amount: 6400 + 550 });
  });

  it('the same order again (the customer asked a question): no second summary', async () => {
    const service = engine();
    const session: any = {};
    const order = { items: [{ product_id: 5, quantity: 1 }], customer_name: 'Sadee', address: 'No. 07, Kurunegala', delivery_area: '*', summary_shown: true };
    expect(await service.handleOrder(16, { id: 1 }, whatsappUser, order, session)).toBe('summary_shown');
    expect(await service.handleOrder(16, { id: 1 }, whatsappUser, order, session)).toBe('unchanged');
    expect(await service.handleOrder(16, { id: 1 }, whatsappUser, { ...order, items: [{ product_id: 5, quantity: 2 }] }, session)).toBe('summary_shown');
  });

  it('the AI says "here is the summary" without the flag: the summary still comes in the same reply', async () => {
    const session: any = {};
    const out = await engine().handleOrder(16, { id: 1 }, whatsappUser,
      { items: [{ product_id: 5, quantity: 1 }], customer_name: 'Sadeesha', address: '462 Thorava', delivery_area: '*' }, session, true);
    expect(out).toBe('summary_shown');
    expect(session.pending_order.summary_shown).toBe(true);
    for (const said of ['මෙන්න order summary එක', 'Here is your order summary', 'Hari Nimal, order eka mehemai.']) expect(SUMMARY_WORDS.test(said)).toBe(true);
    expect(SUMMARY_WORDS.test('Order එක දාන්නද?')).toBe(false);
  });
});

describe('order item names double-check the product id', () => {
  it('a look-alike id is replaced by the product with the name the AI wrote', async () => {
    const { nameMatch } = require('./sales-bot-engine.service');
    expect(nameMatch('Water Mat', '2 CUP Juicer')).toBe(0);
    expect(nameMatch('Kimrox Baby Pant (M) 20 Pcs', 'Kimrox Baby Pant (M) 20 Pcs')).toBe(1);
    const juicer = { id: 9, name: '2 CUP Juicer', price: 1495, is_available: true, variants: [], weight: 1 };
    const mat = { id: 2, name: 'Water Mat', price: 695, is_available: true, variants: [], weight: 1 };
    const round = { id: 3, name: 'Water Mat Round', price: 695, is_available: true, variants: [], weight: 1 };
    const qb: any = { leftJoinAndSelect: () => qb, where: () => qb, andWhere: () => qb, take: () => qb, getMany: async () => [round, mat] };
    const service = new (SalesBotEngineService as any)(...Array.from({ length: 24 }, () => ({})));
    service.productRepository = { findOne: async () => juicer, createQueryBuilder: () => qb };
    const out = await service.priceItems(16, [{ product_id: 9, product_name: 'Water Mat', quantity: 3 }]);
    expect(out.problem).toBe('');
    expect(out.items[0]).toMatchObject({ product_id: 2, product_name: 'Water Mat', quantity: 3, total_price: 2085 });
    // a premium product named, a normal one's id: the premium one is used
    const normal = { id: 20, name: 'Farlin Baby Diaper Pants (L) 24 Pcs', price: 1725, is_available: true, variants: [], weight: 1 };
    const premium = { id: 21, name: 'Farlin Baby Premium Diaper Pants (M) 80 Pcs', price: 5750, is_available: true, variants: [], weight: 1 };
    const qb2: any = { leftJoinAndSelect: () => qb2, where: () => qb2, andWhere: () => qb2, take: () => qb2, getMany: async () => [premium] };
    service.productRepository = { findOne: async () => normal, createQueryBuilder: () => qb2 };
    const fixed = await service.priceItems(16, [{ product_id: 20, product_name: 'Farlin Baby Premium Diaper Pants (M) 80 Pcs', quantity: 1 }]);
    expect(fixed.items[0].product_id).toBe(21);
    service.productRepository = { findOne: async () => juicer, createQueryBuilder: () => qb };
    const same = await service.priceItems(16, [{ product_id: 9, product_name: '2 CUP Juicer', quantity: 1 }]);
    expect(same.items[0].product_id).toBe(9);   // the name fits the id: nothing changes
  });
});

describe('general matching rules', () => {
  it('option names match in any word order, product names despite typos / plurals', () => {
    const { optionKey, nameMatch } = require('./sales-bot-engine.service');
    expect(optionKey('XL / White')).toBe(optionKey('white xl'));
    expect(optionKey('Colour: White / Size: XL')).toBe(optionKey('XL White'));
    expect(optionKey('XL / Pink')).not.toBe(optionKey('XL White'));
    expect(nameMatch('Washable Diaper Plain', 'Washable Diapper PLAIN (two Inserts)')).toBe(1);
  });
});
