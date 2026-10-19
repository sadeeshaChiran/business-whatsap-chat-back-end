import { SalesBotEngineService } from './sales-bot-engine.service';

/** Photo links the AI writes into its text are removed and turned into real photos. */
function engineWith(products: any[]) {
  const args: any[] = Array.from({ length: 24 }, () => ({}));
  args[8] = { // productRepository: find (optionally by id list) + the SQL name search
    find: async (options: any) => {
      const ids = options?.where?.id?.value;
      return Array.isArray(ids) ? products.filter((p) => ids.includes(p.id)) : products;
    },
    query: async (_sql: string, [, reply]: [number, string]) =>
      products.filter((p) => String(p.name).trim().length >= 4 && reply.toLowerCase().includes(String(p.name).trim().toLowerCase()))
        .sort((a, b) => String(b.name).length - String(a.name).length).map((p) => ({ id: p.id })),
  };
  return new (SalesBotEngineService as any)(...args) as SalesBotEngineService;
}

const romper = {
  id: 11, name: 'Cotton Romper Set (3 pcs)', image_url: 'https://placehold.co/600x600/png?text=Cotton+Romper+Set+(3+pcs)', gallery: [],
  has_variants: false, variants: [],
};
const frock = { id: 12, name: 'Party Frock', image_url: 'https://shop.example/frock.jpg', gallery: [], has_variants: false, variants: [] };
const plain = { id: 13, name: 'Gift Card', image_url: null, gallery: [], has_variants: false, variants: [] };

describe('SalesBotEngineService photos from the reply', () => {
  it('turns a photo link in the text into that product photo', async () => {
    const engine = engineWith([romper, frock, plain]);
    const out = await engine.photosFromReply(7, 'Here it is!\nhttps://placehold.co/600x600/png?text=Cotton+Romper+Set+(3+pcs)\nRs 2,500 only.', []);
    expect(out.text).toBe('Here it is!\nRs 2,500 only.');
    expect(out.productIds).toEqual([11]);
  });

  it('sends photos of a product named in the reply when the bot picked none', async () => {
    const engine = engineWith([romper, frock, plain]);
    const out = await engine.photosFromReply(7, 'Our Party Frock is Rs 4,200. Which size?', []);
    expect(out.productIds).toEqual([12]);
    expect(out.text).toBe('Our Party Frock is Rs 4,200. Which size?');
  });

  it('keeps the bot choice and ignores products without photos', async () => {
    const engine = engineWith([romper, frock, plain]);
    expect((await engine.photosFromReply(7, 'The Gift Card is Rs 1,000.', [])).productIds).toEqual([]);
    expect((await engine.photosFromReply(7, 'Party Frock and romper', [11])).productIds).toEqual([11]);
  });

  it('finds named products beyond the first 500 (big shops)', async () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({ id: 1000 + i, name: `Item number ${i}`, image_url: null, gallery: [], has_variants: false, variants: [] }));
    const late = { id: 9999, name: 'Kimrox Baby Pant (M) 20 Pcs', image_url: 'https://www.chu.lk/images/product/a.jpeg', gallery: [], has_variants: false, variants: [] };
    const engine = engineWith([...many, late]);
    expect((await engine.photosFromReply(7, 'Kimrox Baby Pant (M) 20 Pcs - Rs 1,450', [])).productIds).toEqual([9999]);
  });
});

import { asksForPhotos, withoutPhotoPointer } from './sales-bot-engine.service';

describe('photo requests and pointers', () => {
  it('knows when the customer asks for photos', () => {
    expect(asksForPhotos('Ewanna')).toBe(true);
    expect(asksForPhotos('photo ekak dannako')).toBe(true);
    expect(asksForPhotos('price kiyada')).toBe(false);
  });
  it('drops the pointing hand when no photo came', () => {
    expect(withoutPhotoPointer('Sure Madam, Navy saha Maroon ewa me thiyenne 👇 Polo eka dannada?'))
      .toBe('Sure Madam, Navy saha Maroon ewa me thiyenne Polo eka dannada?');
  });
});

import { looksFinished } from './sales-bot-engine.service';

describe('answer sooner when the message looks finished', () => {
  it('questions, photos and full sentences are finished; short pieces are not', () => {
    expect(looksFinished('Kimrox M size kiyada?')).toBe(true);
    expect(looksFinished('', 'image')).toBe(true);
    expect(looksFinished('mata baby ta diapers pack ekak one 6kg')).toBe(true);
    expect(looksFinished('hi')).toBe(false);
    expect(looksFinished('price')).toBe(false);
  });
});
