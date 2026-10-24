import { DemandService } from './reports';

/** What the sales bot hook writes after a reply (the database is faked: only the inserts are checked). */
describe('DemandService.recordTurn', () => {
  const make = (productRows: Array<{ id: number }> = []) => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const dataSource = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return sql.startsWith('SELECT id FROM product') ? productRows : [];
      }),
    };
    return { service: new DemandService(dataSource as never), calls };
  };
  const inserts = (calls: Array<{ sql: string; params: unknown[] }>) =>
    calls.filter((c) => c.sql.includes('INSERT INTO product_demand_event')).map((c) => ({ product: c.params[4], event: c.params[5], option: c.params[6], text: c.params[7] }));
  const base = { companyId: 7, conversationId: 11, channelUserId: 3, isTest: false, customerText: '', reply: '', shownProductIds: [], cartProductIds: [] };

  it('records shown and summary products once each', async () => {
    const { service, calls } = make();
    await service.recordTurn({ ...base, shownProductIds: [5, 5, 9], cartProductIds: [5] });
    expect(inserts(calls)).toEqual([
      { product: 5, event: 'shown', option: null, text: null },
      { product: 9, event: 'shown', option: null, text: null },
      { product: 5, event: 'cart', option: null, text: null },
    ]);
  });

  it('records an unavailable product with its option, matched by name', async () => {
    const { service, calls } = make([{ id: 42 }]);
    await service.recordTurn({ ...base, unavailableItem: 'Pretty Baby Pants (Size: M)', customerText: 'M size 2k one' });
    expect(inserts(calls)).toEqual([{ product: 42, event: 'unavailable', option: 'Size: M', text: 'M size 2k one' }]);
  });

  it('keeps the name when the unavailable product is not found', async () => {
    const { service, calls } = make([]);
    await service.recordTurn({ ...base, unavailableItem: 'Old Soap' });
    expect(inserts(calls)).toEqual([{ product: null, event: 'unavailable', option: 'Old Soap', text: null }]);
  });

  it('records a question for something the shop does not sell only when the bot said no', async () => {
    const asked = make();
    await asked.service.recordTurn({ ...base, customerText: 'Huggies thiyenawada?', reply: "Sorry, we don't have Huggies. Pretty Baby thiyenawa 👇" });
    expect(inserts(asked.calls)).toEqual([{ product: null, event: 'no_match', option: null, text: 'Huggies thiyenawada?' }]);

    const answered = make();
    await answered.service.recordTurn({ ...base, customerText: 'Pretty Baby thiyenawada?', reply: 'Ow, M size Rs 1,450' });
    expect(inserts(answered.calls)).toEqual([]);

    const notAProduct = make();
    await notAProduct.service.recordTurn({ ...base, customerText: 'delivery kiyada?', reply: 'Sorry, we do not have delivery on Sunday' });
    expect(inserts(notAProduct.calls)).toEqual([]);
  });

  it('never throws from the safe version', async () => {
    const service = new DemandService({ query: jest.fn(async () => { throw new Error('db down'); }) } as never);
    await expect(service.recordTurnSafe({ ...base, shownProductIds: [1] })).resolves.toBeUndefined();
  });
});
