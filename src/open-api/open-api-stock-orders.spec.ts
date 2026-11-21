import { OpenApiController } from './open-api';

const actor = { companyId: 16, keyId: 1, user: { id: 7, company_id: 16, role: 'admin', name: 'Owner', email: '', is_super_admin: false } };
const req = { openApi: actor } as any;

function build(opts: { orders?: Record<number, any>; byNumber?: Record<number, number>; skus?: Record<string, { id: number; variantValue?: string }> } = {}) {
  const db = { query: jest.fn(async (sql: string, params: any[]) => {
    if (sql.includes('FROM bot_order WHERE company_id = $1 AND order_no = $2')) return opts.byNumber?.[params[1]] ? [{ id: opts.byNumber[params[1]] }] : [];
    return [];
  }) };
  const products = {
    findBySkuForApi: jest.fn(async (_c: number, sku: string) => (opts.skus?.[sku] ? { product: { id: opts.skus[sku].id }, variantValue: opts.skus[sku].variantValue } : null)),
    upsertFromApi: jest.fn(),
  };
  const botAdmin = { updateOrderStatus: jest.fn(async () => ({ message: 'Your order is shipped' })) };
  const views = { orders: jest.fn(async (_c: number, ids: number[]) => ids.map((id) => opts.orders?.[id]).filter(Boolean)) };
  const stock = { apiStock: jest.fn(async (_u: any, id: number, option: string | undefined, mode: string, q: number) => ({ product_id: id, option: option ?? null, stock: q, available: q > 0, changed: true, mode })) };
  const api = new OpenApiController(db as any, products as any, botAdmin as any, {} as any, views as any, stock as any);
  return { api, db, products, botAdmin, views, stock };
}

describe('Shop API – stock', () => {
  it('bulk: each SKU is set, a variant SKU changes only its option, an unknown SKU is reported, the rest go on', async () => {
    const t = build({ skus: { A1: { id: 10 }, 'SHOE-M': { id: 11, variantValue: '6-12 months' } } });
    const out = await t.api.setStockBulk(req, { items: [{ sku: 'A1', quantity: 5 }, { sku: 'NOPE', quantity: 1 }, { sku: 'SHOE-M', quantity: 0 }] } as any);
    expect(out).toMatchObject({ updated: 2, errors: 1 });
    expect(t.stock.apiStock).toHaveBeenCalledWith(actor.user, 10, undefined, 'set', 5, undefined);
    expect(t.stock.apiStock).toHaveBeenCalledWith(actor.user, 11, '6-12 months', 'set', 0, undefined);
    expect(out.results[1]).toMatchObject({ sku: 'NOPE', ok: false });
  });

  it('one SKU: "add" for stock received', async () => {
    const t = build({ skus: { A1: { id: 10 } } });
    await t.api.setStock(req, 'A1', { quantity: 12, mode: 'add' } as any);
    expect(t.stock.apiStock).toHaveBeenCalledWith(actor.user, 10, undefined, 'add', 12, undefined);
  });
});

describe('Shop API – order status', () => {
  it('by the shop number; the same status again changes nothing and sends no second message', async () => {
    const t = build({ byNumber: { 12: 5301 }, orders: { 5301: { id: 5301, order_no: 12, status: 'Shipped' } } });
    const out = await t.api.orderStatusByNumber(req, 12, { status: 'Shipped' } as any);
    expect(out).toMatchObject({ changed: false, customer_message: null });
    expect(t.botAdmin.updateOrderStatus).not.toHaveBeenCalled();
  });

  it('a new status: changed, and notify_customer=false is passed on', async () => {
    const t = build({ orders: { 5301: { id: 5301, order_no: 12, status: 'Pending' } } });
    const out = await t.api.orderStatus(req, 5301, { status: 'Shipped', notify_customer: false } as any);
    expect(t.botAdmin.updateOrderStatus).toHaveBeenCalledWith(actor.user, 5301, { status: 'Shipped', notify_customer: false });
    expect(out.changed).toBe(true);
  });

  it('an unknown shop number is a 404', async () => {
    const t = build();
    await expect(t.api.orderByNumber(req, 99)).rejects.toThrow('No order #99');
  });
});
