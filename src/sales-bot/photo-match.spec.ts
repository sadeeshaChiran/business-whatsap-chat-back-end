import { PhotoMatchService, photoMatchNote, wordScore, colourDiff } from './photo-match';
import { photoLabel, photoPicks } from './sales-bot-engine.service';

const product = (id: number, name: string, hashes: Array<{ p: string; d: string; c: string }> = [], extra: Record<string, unknown> = {}) => ({
  id, name, price: 4500, is_available: true, has_variants: false, variants: [], category: { name: 'Watches' }, description: '', image_notes: '',
  image_url: `https://shop.example/${id}.jpg`, gallery: [], variant_image_match: null, image_hashes: hashes.length ? [{ url: `https://shop.example/${id}.jpg`, hashes }] : [],
  ...extra,
});
const grid = (value: number) => Buffer.alloc(192, value).toString('hex');
const H = (p: string, d: string, colour = 120) => ({ p, d, c: grid(colour) });

function service(products: unknown[], replies: Record<string, unknown>) {
  const qb: any = { leftJoinAndSelect: () => qb, addSelect: () => qb, where: () => qb, andWhere: () => qb, getMany: async () => products };
  const svc = new PhotoMatchService({ createQueryBuilder: () => qb } as never);
  const calls: string[] = [];
  (svc as any).post = async (path: string) => { calls.push(path); return replies[path]; };
  (svc as any).photoB64 = async () => 'aW1n';
  return { svc, calls };
}
const analysis = (extra: Record<string, unknown> = {}) => ({
  analysis: { is_product: true, item: 'wrist watch', colours: ['blue'], pattern: '', material: '', text_on_item: '', pieces: 1, screenshot: false,
    search_words: ['watch', 'blue', 'analog'], description: 'blue strap analog watch', ...extra },
  hashes: [H('ffff0000ffff0000', '00ff00ff00ff00ff')],
  usage: { input_tokens: 300, output_tokens: 50, calls: 1, cost_usd: 0.0001, latency_ms: 10 },
});
const media = { mime_type: 'image/jpeg', data_b64: 'aW1n' };
const OLD = process.env.SALES_BOT_URL;

describe('PhotoMatchService', () => {
  beforeAll(() => { process.env.SALES_BOT_URL = 'http://bot'; });
  afterAll(() => { process.env.SALES_BOT_URL = OLD; });

  it('our own photo (same fingerprint and colours) → exact, no AI compare', async () => {
    const { svc, calls } = service([
      product(1, 'Red Classic Watch', [H('ffff0000ffff0000', '00ff00ff00ff00ff', 40)]),
      product(2, 'Blue Classic Watch', [H('ffff0000ffff0001', '00ff00ff00ff00ff', 120)]),
    ], { '/photos/fingerprint': { hashes: [analysis().hashes] }, '/photos/analyze': analysis() });
    const result = await svc.match(7, media);
    expect(result?.match.status).toBe('exact');
    expect(result?.match.products.map((p) => p.product_id)).toEqual([2]); // same shape, but only blue has the same colours
    expect(calls).toEqual(['/photos/fingerprint']); // no AI at all
    expect(result?.usage).toEqual([]);
  });

  it('the same photo used for two products → unsure, both offered', async () => {
    const same = H('ffff0000ffff0000', '00ff00ff00ff00ff');
    const { svc } = service([product(1, 'Watch size S', [same]), product(2, 'Watch size L', [same])],
      { '/photos/fingerprint': { hashes: [analysis().hashes] }, '/photos/analyze': analysis() });
    const result = await svc.match(7, media);
    expect(result?.match.status).toBe('unsure');
    expect(result?.match.products.map((p) => p.product_id).sort()).toEqual([1, 2]);
  });

  it('AI says same item with 90% and nothing else close → likely', async () => {
    const { svc, calls } = service([product(1, 'Blue Classic Watch'), product(2, 'Black Sport Watch'), product(3, 'Pink Romper')], {
      '/photos/analyze': analysis(),
      '/photos/compare': { results: [
        { key: '1:0', same_item: true, similarity: 92, differences: '' },
        { key: '2:0', same_item: false, similarity: 55, differences: 'black dial' },
      ], usage: { input_tokens: 2000, output_tokens: 80, calls: 1, cost_usd: 0.0005, latency_ms: 900 } },
    });
    const result = await svc.match(7, media);
    expect(result?.match.status).toBe('likely');
    expect(result?.match.products[0]).toMatchObject({ product_id: 1, confidence: 92 });
    expect(calls).toEqual(['/photos/analyze', '/photos/compare']);
    expect(result?.usage).toHaveLength(2);
  });

  it('two products both look the same to the AI → unsure (never guesses)', async () => {
    const { svc } = service([product(1, 'Blue Classic Watch'), product(2, 'Navy Classic Watch')], {
      '/photos/analyze': analysis(),
      '/photos/compare': { results: [
        { key: '1:0', same_item: true, similarity: 90, differences: '' },
        { key: '2:0', same_item: true, similarity: 86, differences: '' },
      ], usage: null },
    });
    const result = await svc.match(7, media);
    expect(result?.match.status).toBe('unsure');
    expect(result?.match.products.map((p) => p.product_id)).toEqual([1, 2]);
  });

  it('same type, different design (70%) → unsure with the difference; below 60 → none', async () => {
    const close = service([product(1, 'Blue Classic Watch')], {
      '/photos/analyze': analysis(),
      '/photos/compare': { results: [{ key: '1:0', same_item: false, similarity: 70, differences: 'different dial' }], usage: null },
    });
    const a = await close.svc.match(7, media);
    expect(a?.match.status).toBe('unsure');
    expect(a?.match.products[0].differences).toBe('different dial');
    const far = service([product(1, 'Blue Classic Watch')], {
      '/photos/analyze': analysis(),
      '/photos/compare': { results: [{ key: '1:0', same_item: false, similarity: 40, differences: 'different item' }], usage: null },
    });
    const b = await far.svc.match(7, media);
    expect(b?.match.status).toBe('none');
    expect(b?.match.products[0].product_id).toBe(1); // offered as the closest we have
  });

  it('a payment slip / selfie → not_product, no compare', async () => {
    const { svc, calls } = service([product(1, 'Blue Classic Watch')], { '/photos/analyze': analysis({ is_product: false, description: 'bank deposit slip' }) });
    const result = await svc.match(7, media);
    expect(result?.match.status).toBe('not_product');
    expect(calls).toEqual(['/photos/analyze']);
  });

  it('nothing in the shop shares a word with the photo (big catalog) → none without compare', async () => {
    const many = Array.from({ length: 12 }, (_, i) => product(i + 1, `Saree ${i}`, [], { category: { name: 'Sarees' } }));
    const { svc, calls } = service(many, { '/photos/analyze': analysis() });
    const result = await svc.match(7, media);
    expect(result?.match.status).toBe('none');
    expect(calls).toEqual(['/photos/analyze']);
  });
});

describe('photo helpers', () => {
  it('word score prefers the item type', () => {
    const a = { item: 'wrist watch', search_words: ['watch', 'blue'], colours: ['blue'], pattern: '', text_on_item: '' };
    expect(wordScore(a, 'Blue Classic Watch Watches')).toBeGreaterThan(wordScore(a, 'Blue Saree Sarees'));
  });

  it('colour difference looks at the most different cells', () => {
    const base = Buffer.alloc(192, 100);
    const strap = Buffer.from(base);
    for (let i = 0; i < 24; i++) strap[i] = 220; // 8 cells changed (a strap)
    expect(colourDiff(base.toString('hex'), base.toString('hex'))).toBe(0);
    expect(colourDiff(base.toString('hex'), strap.toString('hex'))).toBeGreaterThan(60);
  });

  it('labels and picks: matched product first, unsure → one photo each, AI choice, then named products', () => {
    expect(photoLabel({ name: 'Blue Classic Watch', price: 4500 } as never, null)).toBe('📷 Blue Classic Watch – Rs 4,500');
    expect(photoLabel({ name: 'Romper', price: 2500 } as never, 'Pink / 6M')).toBe('📷 Romper – Pink / 6M – Rs 2,500');
    const picks = photoPicks([
      { status: 'likely', method: 'ai', item: '', description: '', products: [{ product_id: 5, name: 'A', price: 1, variant: 'Red', confidence: 90, available: true }] },
      { status: 'unsure', method: 'ai', item: '', description: '', products: [
        { product_id: 6, name: 'B', price: 1, variant: null, confidence: 70, available: true },
        { product_id: 7, name: 'C', price: 1, variant: null, confidence: 65, available: true }] },
    ], [9, 10], [10]);
    expect(picks.map((p) => p.id)).toEqual([5, 6, 7, 9, 10]);
    expect(picks[0].variant).toBe('Red');
  });

  it('notes for the history', () => {
    const base = { method: 'ai' as const, item: 'watch', description: 'blue watch' };
    expect(photoMatchNote({ ...base, status: 'exact', products: [{ product_id: 3, name: 'Blue Watch', price: 1, variant: null, confidence: 100, available: true }] }))
      .toBe('customer photo = our product Blue Watch #3 (our own photo)');
    expect(photoMatchNote({ ...base, status: 'none', products: [] })).toBe('customer photo (blue watch) – not in our shop');
  });
});
