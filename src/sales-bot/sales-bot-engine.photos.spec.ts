import { SalesBotEngineService } from './sales-bot-engine.service';

/** Photo links the AI writes into its text are removed and turned into real photos. */
function engineWith(products: any[]) {
  const args: any[] = Array.from({ length: 24 }, () => ({}));
  args[8] = { find: async () => products }; // productRepository
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
});
