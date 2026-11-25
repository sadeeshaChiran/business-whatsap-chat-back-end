import { SalesBotEngineService } from './sales-bot-engine.service';

const product = (id: number, name: string, available: boolean, variants?: unknown[]) => ({
  id, name, company_id: 16, is_deleted: false, is_available: available, price: 1495,
  image_url: `https://shop.lk/${id}.jpg`, gallery: [], has_variants: Boolean(variants), variants: variants ? [{ variants }] : [],
});

function engine(products: unknown[]) {
  const sent: string[] = [];
  const self: any = {
    productRepository: { find: jest.fn(async () => products) },
    messageRepository: { query: jest.fn(async () => []), create: (x: unknown) => x, save: jest.fn(async (x: unknown) => x) },
    deliverImage: jest.fn(async (_c: unknown, _v: unknown, _u: unknown, _ch: unknown, _s: unknown, _sim: unknown, args: { url: string }) => { sent.push(args.url); return { messageId: 'm1', failed: false }; }),
    photoFile: jest.fn(async () => ({ buffer: Buffer.from('x'), mimetype: 'image/jpeg' })),
    touch: jest.fn(), logger: { warn: jest.fn() },
  };
  const send = (picks: Array<{ id: number; variantId?: number }>) =>
    (SalesBotEngineService.prototype as any).sendPhotos.call(self, 16, { id: 1 }, { platform: 'messenger', external_user_id: 'u' }, null, picks, true, {});
  return { send, sent };
}

describe('sold-out products never get a photo', () => {
  it('skips a product that is not available (the reply may still name it to say it is over)', async () => {
    const t = engine([product(1, 'Table Cloth', false), product(2, 'Table Cloth Golden Desing', true)]);
    const result = await t.send([{ id: 1 }, { id: 2 }]);
    expect(t.sent).toEqual(['https://shop.lk/2.jpg']);
    expect(result.sent).toBe(1);
  });

  it('skips a chosen option that is not available', async () => {
    const t = engine([product(3, 'Frock', true, [{ values: { Colour: 'Red' }, available: false }, { values: { Colour: 'Blue' } }])]);
    await t.send([{ id: 3, variantId: 1 }]);
    expect(t.sent).toEqual([]);
  });
});
