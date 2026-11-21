import { SocialService } from './social.service';

describe('post card products for the comment AI', () => {
  const p = (id: number, name: string, price: number, sku: string | null = null) => ({ id, name, sku, price, image_url: null });

  it('one linked product goes first, then the card text', () => {
    expect(SocialService.postSummaryForAi([p(1, 'Table Cloth Clear', 595, '94273444')], 'Transparent table cloth.'))
      .toBe('PRODUCT: "Table Cloth Clear" (SKU 94273444) - Rs 595. Transparent table cloth.');
  });

  it('several products: all of them with prices', () => {
    const out = SocialService.postSummaryForAi([p(1, 'A', 595), p(2, 'B', 1795)], '');
    expect(out).toBe('PRODUCTS (2 in this post): "A" - Rs 595, "B" - Rs 1,795. Price question -> all of them, one per line.');
  });

  it('no products: the card text as before, max 600 characters', () => {
    expect(SocialService.postSummaryForAi([], 'Quiz post')).toBe('Quiz post');
    expect(SocialService.postSummaryForAi([], 'x'.repeat(900))).toHaveLength(600);
  });
});
