import { fillOrderNo, orderNo } from './order-number';

describe('shop order numbers', () => {
  it('shows the shop number, the internal id only for old rows', () => {
    expect(orderNo({ id: 5321, order_no: 12 })).toBe(12);
    expect(orderNo({ id: 5321, order_no: null })).toBe(5321);
    expect(orderNo({ id: '77', order_no: '3' })).toBe(3);
    expect(orderNo(null)).toBe(0);
  });

  it('fills the number of a new order from the database', async () => {
    const order: { id: number; order_no?: number | null } = { id: 9 };
    await fillOrderNo({ query: async () => [{ order_no: 41 }] }, order);
    expect(order.order_no).toBe(41);
  });

  it('a repository without query (tests) or a failing query does not break saving', async () => {
    const order: { id: number; order_no?: number | null } = { id: 9 };
    await fillOrderNo({} as never, order);
    await fillOrderNo({ query: async () => { throw new Error('x'); } }, order);
    expect(orderNo(order)).toBe(9);
  });
});
