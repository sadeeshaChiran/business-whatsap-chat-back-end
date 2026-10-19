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
    expect(out).toBe('ask:address');
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
