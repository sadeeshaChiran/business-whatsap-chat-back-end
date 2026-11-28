import { commentCampaign } from './comment-campaign';
import { SalesBotEngineService, WANTS_NEW_ORDER, alreadyPlacedMessage, changeNotedMessage, itemsKey, photoPicks, sameOrderMessage } from './sales-bot-engine.service';

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

describe('after an order is placed (bug 4) – never a second order by mistake', () => {
  const recent = (rows: unknown[] | Error) => ({
    orderRepository: { query: jest.fn(async (sql: string) => {
      if (rows instanceof Error) throw rows;
      // the old check used COALESCE(status, '') on the enum column → a SQL error → "no duplicate" every time
      expect(sql).toContain('status::text');
      return rows;
    }) },
  });
  const run = (self: unknown) => (SalesBotEngineService.prototype as any).recentOpenOrder.call(self, 16, 5686);

  it('the newest open order of the last 24 hours, with its items', async () => {
    const got = await run(recent([{ id: 671, order_no: 166, status: 'Processing', items: [{ product_id: 7199, variant: null, quantity: 1 }, { product_id: 5701, variant: null, quantity: 1 }] }]));
    expect(got).toMatchObject({ id: 671, no: 166, status: 'Processing' });
    expect(itemsKey(got.items)).toBe(itemsKey([{ product_id: 5701, quantity: 1 }, { product_id: 7199, quantity: 1 }]));
  });

  it('no open order, or the check fails → null (the order goes on)', async () => {
    expect(await run(recent([]))).toBeNull();
    expect(await run(recent(new Error('db')))).toBeNull();
  });

  it('a different quantity / option is not the same order', () => {
    expect(itemsKey([{ product_id: 3452, quantity: 4 }])).not.toBe(itemsKey([{ product_id: 3452, quantity: 5 }]));
    expect(itemsKey([{ product_id: 7193, variant: 'M', quantity: 1 }])).not.toBe(itemsKey([{ product_id: 7193, variant: 'L', quantity: 1 }]));
  });

  it('the customer asks for a second order in so many words', () => {
    for (const text of ['aluth order ekak danna', 'තව එකක් ඕනේ', 'wenama order ekak', 'another one please', 'අලුත් order එකක්']) expect(WANTS_NEW_ORDER.test(text)).toBe(true);
    for (const text of ['ow', 'මේ ඔර්ඩර් එක තමයි', 'ok thanks', 'ඔව්. Dr', 'Ektama add krnn']) expect(WANTS_NEW_ORDER.test(text)).toBe(false);
  });

  it('messages', () => {
    expect(alreadyPlacedMessage('sinhala', 166)).toContain('#166');
    expect(changeNotedMessage('sinhala', '125')).toContain('#125');
    expect(sameOrderMessage('sinhala_latin', '120', '1 x Lunch Box Set')).toContain('order #120');
  });

  it('a customer photo that is exactly our photo gets no photo back', () => {
    const exact = photoPicks([{ status: 'exact', products: [{ product_id: 7270, variant: null }] } as never], [], []);
    const likely = photoPicks([{ status: 'likely', products: [{ product_id: 7270, variant: null }] } as never], [], []);
    expect(exact).toEqual([]);
    expect(likely[0]).toMatchObject({ id: 7270, skipIfSentWithinMin: 180 });
  });
});

describe('the "here is your order" line always gets the summary (Moodlift 27 Nov)', () => {
  it('knows the lines that promise the order summary', () => {
    const { SUMMARY_WORDS } = require('./sales-bot-engine.service');
    for (const line of ['හරි මිස්, order එකේ විස්තර මෙන්න 😊', 'ඇණවුමේ විස්තර මෙන්න.', 'Thank you Sihana, here is your order:',
      'හරි මිස්, සම්පූර්ණ විස්තර මෙන්න. මේ ටික බලලා confirm කරන්න.', 'ඔබේ ඇණවුම මෙන්න:', 'Order eke wisthara mehemai', 'හරි සර්, order එක මෙහෙමයි.']) {
      expect(SUMMARY_WORDS.test(line)).toBe(true);
    }
    for (const line of ['Chérie Bow T-Shirt එකේ විස්තර මෙන්න:', 'ඇණවුම දාන්න මෙන්න මේ විස්තර ටික එවන්න:', 'බැංකු විස්තර මෙන්න:', 'මෙන්න size විස්තර:']) {
      expect(SUMMARY_WORDS.test(line)).toBe(false);
    }
  });
});

describe('Full Kit options: the AI left out a word (Moodlift 28 Nov: "size / colour" asked 7 times)', () => {
  const { looseOptionIndex } = require('./sales-bot-engine.service');
  const labels = ['T-Shirt / Navy Blue / 2XL', 'T-Shirt / Navy Blue / XL', 'Pant / Navy Blue / XL', 'Pant / Navy Blue / XXL', 'T-Shirt / Red / M'];
  it('finds the one option that has every word', () => {
    expect(looseOptionIndex(labels, 'Navy Blue / 2XL T-Shirt')).toBe(0);
    expect(looseOptionIndex(labels, 'Pant Navy Blue 2XL')).toBe(3);   // 2XL = XXL
    expect(looseOptionIndex(labels, 'Red M')).toBe(4);
  });
  it('does not guess when two options fit', () => {
    expect(looseOptionIndex(labels, 'Navy Blue / XL')).toBe(-1);
    expect(looseOptionIndex(labels, 'Green M')).toBe(-1);
  });
});
