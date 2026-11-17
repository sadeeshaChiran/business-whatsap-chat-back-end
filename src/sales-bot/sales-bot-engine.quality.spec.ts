import { SalesBotEngineService, changedOrderMessage, orderFingerprint } from './sales-bot-engine.service';

const proto = SalesBotEngineService.prototype as any;

describe('sales bot quality fixes (Modlift chats)', () => {
  it('the same order sent again is not a change (no new invoice)', () => {
    const order = { total_amount: 3995, delivery_fee: 1015, customer_name: 'Imasha', address: 'Panadura', customer_phone: '0764264699' };
    const items = [{ product_id: 7193, product_name: 'Hi Full Kit', variant_text: 'Pant / Black / XXL', quantity: 1, unit_price: 1490 },
      { product_id: 7193, product_name: 'Hi Full Kit', variant_text: 'Pant / Navy Blue / XXL', quantity: 1, unit_price: 1490 }];
    expect(orderFingerprint(order, [...items].reverse())).toBe(orderFingerprint(order, items));
    expect(orderFingerprint({ ...order, total_amount: 3405 }, items)).not.toBe(orderFingerprint(order, items));
    expect(orderFingerprint(order, [{ ...items[0], quantity: 2 }])).not.toBe(orderFingerprint(order, items));
  });

  it('the bot steps back after the owner replied from the phone app (not for instant auto-replies)', async () => {
    const query = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    expect(await proto.ownerRepliedRecently.call({ messageRepository: { query } }, 3919)).toBe(true);
    expect(query.mock.calls[0][0]).toContain("'phone-app', 'meta-echo'");
    expect(query.mock.calls[0][0]).toContain("INTERVAL '15 seconds'");
    expect(await proto.ownerRepliedRecently.call({ messageRepository: { query: jest.fn().mockResolvedValue([]) } }, 1)).toBe(false);
    process.env.SALES_BOT_OWNER_PAUSE_MIN = '0';
    expect(await proto.ownerRepliedRecently.call({ messageRepository: { query } }, 1)).toBe(false);
    delete process.env.SALES_BOT_OWNER_PAUSE_MIN;
  });

  it('keeps the customer\'s own details message in the order note when the AI gave no details form', async () => {
    const rows = [
      { content: 'Hari thank you' },
      { content: 'Madushika Piumanthi\n\nNo 23/4/1 Koralawalla Road, Moratuwa\n\n0767122821\n\nAdvance 1000 ✅\nT Shirt 6\n8 XL' },
      { content: 'Oka namei' },
    ];
    const note = await proto.customerDetailsMessage.call({ messageRepository: { query: jest.fn().mockResolvedValue(rows) } }, 3521);
    expect(note).toContain('📋 Customer details');
    expect(note).toContain('Advance 1000');
    expect(note).not.toContain('Oka namei');
    expect(await proto.customerDetailsMessage.call({ messageRepository: { query: jest.fn().mockResolvedValue([{ content: 'ok' }]) } }, 1)).toBe('');
  });

  it('after an order change the customer sees the saved total, not a sum the AI worked out', () => {
    const text = changedOrderMessage('sinhala', 'හරි මිස්, Pant දෙකම XXL size එකෙන් update කළා. 😊\nමුළු එකතුව රු. 2,980 යි, delivery FREE!', {
      id: 415, fee: 425, total: 3405,
      items: [{ quantity: 1, product_name: 'Hi Full Kit (T-Shirt + Pant)', variant_text: 'Pant / Black / XXL', total_price: 1490 },
        { quantity: 1, product_name: 'Hi Full Kit (T-Shirt + Pant)', variant_text: 'Pant / Navy Blue / XXL', total_price: 1490 }],
    });
    expect(text).toContain('update කළා');
    expect(text).not.toContain('2,980');
    expect(text).toContain('Delivery: Rs 425');
    expect(text).toContain('Total: Rs 3,405');
  });
});
