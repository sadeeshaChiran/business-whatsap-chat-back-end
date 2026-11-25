import { commentCampaign } from './comment-campaign';
import { SalesBotEngineService, photoPicks, sameOrderMessage } from './sales-bot-engine.service';

const ds = (tables: Record<string, unknown[]>) => ({
  query: jest.fn(async (sql: string) => {
    if (sql.includes('FROM bot_conversation')) return tables.conv ?? [];
    if (sql.includes("source = 'meta-context'")) return tables.meta ?? [];
    if (sql.includes("source = 'social-private-reply'")) return tables.sent ?? [];
    if (sql.includes('FROM social_comment')) return tables.comment ?? [];
    if (sql.includes('FROM social_post_ai')) return tables.card ?? [];
    return [];
  }),
});

describe('chat that started from a comment gets the post (bug 1)', () => {
  const comment = [{ comment_id: '122267826908270568_959102060617224', post_id: '262804616922693_122267826908270568', message: 'Ok', post_text: 'oil pot', post_link: 'https://facebook.com/reel/1' }];
  const card = [{ summary: 'The post features an oil pot for Rs. 325.', product_ids: [3558] }];

  it('from Meta\'s "comment_id=" message', async () => {
    const got = await commentCampaign(ds({ meta: [{ content: 'View comment.(https://facebook.com/reel/1/?comment_id=959102060617224)' }], comment, card }) as never, 8295, 16);
    expect(got).toMatchObject({ ad_type: 'post', ad_body: 'The post features an oil pot for Rs. 325.', product_ids: [3558], ad_headline: 'Their comment: "Ok"' });
  });

  it('from our own private reply (saved comment ref, or the same reply text)', async () => {
    expect(await commentCampaign(ds({ conv: [{ comment_ref: comment[0].comment_id }], comment, card }) as never, 1, 16)).not.toBeNull();
    expect(await commentCampaign(ds({ sent: [{ content: 'Hello, oil pot Rs 325' }], comment, card }) as never, 1, 16)).not.toBeNull();
  });

  it('no comment, or a post with nothing to say → null (nothing changes)', async () => {
    expect(await commentCampaign(ds({}) as never, 1, 16)).toBeNull();
    expect(await commentCampaign(ds({ meta: [{ content: 'comment_id=1' }], comment: [{ ...comment[0], post_text: '' }], card: [] }) as never, 1, 16)).toBeNull();
  });
});

describe('after an order is placed (bug 4)', () => {
  const engine = (orders: unknown[], items: Record<number, unknown[]>) => ({
    messageRepository: { query: jest.fn(async () => orders) },
    orderItemRepository: { find: jest.fn(async ({ where }: { where: { order_id: number } }) => items[where.order_id] ?? []) },
  });
  const run = (self: unknown, ids: number[], asked?: number) =>
    (SalesBotEngineService.prototype as any).sameAsRecentOrder.call(self, 9, ids.map((id) => ({ product_id: id })), asked);
  const placed = { 120: [{ product_id: 7270, quantity: 1, product_name: 'Lunch Box Set' }, { product_id: 5870, quantity: 1, product_name: 'Drawing Pad' }] };

  it('the same products again within 24 hours → ask once which they mean', async () => {
    const got = await run(engine([{ id: 120, order_no: 120 }], placed), [7270]);
    expect(got).toEqual({ id: 120, no: 120, items: '1 x Lunch Box Set, 1 x Drawing Pad' });
    expect(sameOrderMessage('sinhala_latin', '120', got.items)).toContain('order #120');
  });

  it('already asked, a new product, or no recent order → the order goes on', async () => {
    expect(await run(engine([{ id: 120, order_no: 120 }], placed), [7270], 120)).toBeNull();
    expect(await run(engine([{ id: 120, order_no: 120 }], placed), [7270, 999])).toBeNull();
    expect(await run(engine([], placed), [7270])).toBeNull();
    expect(await run({ messageRepository: { query: async () => { throw new Error('db'); } } }, [7270])).toBeNull();
  });

  it('a customer photo that is exactly our photo gets no photo back', () => {
    const exact = photoPicks([{ status: 'exact', products: [{ product_id: 7270, variant: null }] } as never], [], []);
    const likely = photoPicks([{ status: 'likely', products: [{ product_id: 7270, variant: null }] } as never], [], []);
    expect(exact).toEqual([]);
    expect(likely[0]).toMatchObject({ id: 7270, skipIfSentWithinMin: 180 });
  });
});
