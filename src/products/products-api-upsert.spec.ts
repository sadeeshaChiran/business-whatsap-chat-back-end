import { ProductsService } from './products.service';

/** Shop API: products come from the shop's own system by SKU – fields left out keep their value. */
describe('upsertFromApi', () => {
  function service(existing: any) {
    const s: any = Object.create(ProductsService.prototype);
    const groups: any[] = [];
    s.assertProductBusiness = async () => undefined;
    s.assertProductRoom = jest.fn(async () => undefined);
    s.photoJobSoon = () => undefined;
    s.productRepository = { findOne: async ({ where }: any) => (where.sku === existing?.sku ? existing : null) };
    s.persistImportGroup = async (group: any) => { groups.push(group); return { product: { id: 9 }, updated: Boolean(existing && group.sku === existing.sku) }; };
    return { s, groups };
  }
  const user: any = { id: 7, company_id: 16, role: 'admin' };

  it('a price / availability change keeps the name and the category', async () => {
    const { s, groups } = service({ id: 9, sku: '94272848', name: '04 Jeep Toy', category: { name: 'Toys & Games' } });
    const out = await s.upsertFromApi([{ sku: '94272848', price: 450, available: false }], user);
    expect(out).toMatchObject({ updated: 1, created: 0, errors: 0 });
    expect(groups[0]).toMatchObject({ name: '04 Jeep Toy', categoryName: 'Toys & Games', price: 450, available: false, sku: '94272848' });
    expect(groups[0].description).toBe('');
    expect(groups[0].sellingPoints).toBeUndefined();
  });

  it('a new product with options; a new one without a name is an error, the others still go in', async () => {
    const { s, groups } = service(null);
    const out = await s.upsertFromApi([
      { sku: 'SHOE-1', name: 'Baby Shoes', category: 'Shoes', price: 1800, variants: [{ name: 'Size', value: '0-6 months' }, { name: 'Size', value: '6-12 months', price: 1950 }] },
      { sku: 'X-1', price: 100 },
    ], user);
    expect(out).toMatchObject({ created: 1, errors: 1 });
    expect(groups[0].variants.map((v: any) => v.variant_value)).toEqual(['0-6 months', '6-12 months']);
    expect(groups[0].hasVariants).toBe(true);
    expect(out.results[1]).toMatchObject({ sku: 'X-1', action: 'error' });
    expect(s.assertProductRoom).toHaveBeenCalledWith(16, 2);
  });
});
