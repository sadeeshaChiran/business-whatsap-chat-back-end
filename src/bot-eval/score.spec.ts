import { COMMENT_SOURCE } from '../marketing/attribution';
import { compareRuns, knownPrice, pricesInText, productsShown, scoreCase, summarize, type EvalCase, type RunRow } from './score';

const context: any = {
  company: { free_delivery_over: 5000 },
  products: [
    { id: 1, name: 'Glass Oil Control Pot 500ml', price: 325, stock: 5, available: true, variants: [] },
    { id: 2, name: 'Baby Diaper Pack', price: 1200, stock: 0, available: true, variants: [] },
    { id: 3, name: 'Storage Box', sku: 'JR-402028', price: 990, stock: null, available: false, variants: [] },
  ],
  services: [],
  delivery_zones: [{ area: 'All island', fee: 425, days: '2-3', included_kg: 1, per_extra_kg: 100 }],
  policies: [], faqs: [], styles: [], open_orders: [], last_order: null, campaign: null,
};
const result = (over: any = {}): any => ({ reply: '', photo_product_ids: [], photo_variants: [], size_chart_product_ids: [], order: null, handoff: null, usage: { cost_usd: 0.002, input_tokens: 1000, output_tokens: 100, thinking_tokens: 0 }, ...over });
const testCase = (checks: EvalCase['checks']): EvalCase => ({ id: 't', shop: 'chu', company_id: 16, conversation_id: 1, channel_user_id: 1, platform: 'messenger', before_message_id: 9, message: 'Ona 2 k', kind: 'known', checks });

describe('bot-eval scoring', () => {
  it('finds products by photo, order item and name in the text', () => {
    const shown = productsShown(result({ reply: 'Glass oil control pot eka thiyenawa', photo_product_ids: [3] }), context);
    expect([...shown].sort()).toEqual([1, 3]);
  });

  it('reads rupee amounts', () => {
    expect(pricesInText('Rs. 1,250 + ඩිලිවරි රු. 425, total 1675/-')).toEqual([1250, 425, 1675]);
  });

  it('accepts prices, qty × price + delivery, extra kg fees; rejects made-up prices', () => {
    expect(knownPrice(650, context, '')).toBe(true); // 2 × 325
    expect(knownPrice(1075, context, '')).toBe(true); // 650 + 425
    expect(knownPrice(525, context, '')).toBe(true); // 425 + 1 extra kg
    expect(knownPrice(350, context, '')).toBe(false); // the old delivery fee
    expect(knownPrice(350, context, 'old price was 350')).toBe(true); // written by the shop / customer
  });

  it('passes a good answer and fails a wrong product, handoff, long reply and sold-out photo', () => {
    const c = testCase({ expect_products_any: [1], forbid_products: [2], max_chars: 60, no_handoff: true, prices_known: true });
    expect(scoreCase(c, result({ reply: 'Oil control pot 2k Rs 650 😊', photo_product_ids: [1] }), context, []).pass).toBe(true);
    const bad = scoreCase(c, result({ reply: 'Baby diaper pack eka Rs 999 '.repeat(4), photo_product_ids: [2], handoff: { needed: true, reason: 'x' } }), context, []);
    expect(bad.pass).toBe(false);
    expect(Object.entries(bad.checks).filter(([, ok]) => !ok).map(([k]) => k).sort())
      .toEqual(['expect_products', 'forbid_products', 'no_handoff', 'no_sold_out', 'prices_known', 'short']);
  });

  it('fails a confirmed order of the same items as the order just placed', () => {
    const c = testCase({ no_duplicate_order_of: [77] });
    const again = result({ reply: 'ok', order: { confirm_order: true, items: [{ product_id: 1, quantity: 1 }] } });
    expect(scoreCase(c, again, context, [], { 77: [1] }).checks.no_duplicate_order).toBe(false);
    expect(scoreCase(c, result({ reply: 'ok' }), context, [], { 77: [1] }).checks.no_duplicate_order).toBe(true);
  });

  it('checks the comment chat got its post', () => {
    const c = testCase({ campaign_from_comment: true });
    expect(scoreCase(c, result({ reply: 'ok' }), context, []).checks.comment_post).toBe(false);
    expect(scoreCase(c, result({ reply: 'ok' }), { ...context, campaign: { source: COMMENT_SOURCE } }, []).checks.comment_post).toBe(true);
  });

  it('summarizes and compares runs', () => {
    const row = (id: string, pass: boolean): RunRow => ({ id, shop: 'chu', kind: 'photo', pass, checks: { short: pass }, fails: pass ? [] : ['short: 900 chars'], reply: 'r', usage: { cost_usd: 0.002 } as any, ms: 1 });
    const s = summarize([row('a', true), row('b', false)]);
    expect(s.pass_pct).toBe(50);
    expect(s.cost_per_reply_usd).toBe(0.002);
    const cmp = compareRuns([row('a', true), row('b', false)], [row('a', false), row('b', true)]);
    expect(cmp.newly_failing.map((r) => r.id)).toEqual(['a']);
    expect(cmp.newly_passing).toEqual(['b']);
  });
});

describe('bot-eval scoring – fair checks', () => {
  it('a sold-out product named only to say it is sold out is not "offered"', () => {
    const c = testCase({ forbid_products: [2] });
    const said = result({ reply: 'Baby Diaper Pack eka iwarai 🙏 Oil control pot eka thiyenawa.' });
    expect(scoreCase(c, said, context, []).checks.forbid_products).toBe(true);
    const offered = result({ reply: 'Baby Diaper Pack eka Rs 1200, order karannada?' });
    expect(scoreCase(c, offered, context, []).checks.forbid_products).toBe(false);
  });

  it("the shop's own long price list in the reply is allowed", () => {
    const list = ['👕 T-Shirt: XS / S / M – Rs 1,590', '3XL – Rs 1,690', '4XL – Rs 1,790', '5XL / 6XL – Rs 2,090', '👖 Pant – Rs 1,490']
      .map((l) => `${l} ${'.'.repeat(40)}`).join('\n');
    const ctx = { ...context, styles: [{ question: 'price', answer: list }] };
    const c = testCase({ max_chars: 100 });
    expect(scoreCase(c, result({ reply: `Ow miss 😍\n${list}` }), ctx, []).checks.short).toBe(true);
    expect(scoreCase(c, result({ reply: 'x'.repeat(400) }), ctx, []).checks.short).toBe(false);
  });

  it('a handoff for a bank slip or an upset customer is right', () => {
    const c = testCase({ no_handoff: true });
    expect(scoreCase(c, result({ reply: 'ok', handoff: { needed: true, reason: 'Customer paid by bank transfer, verify receipt' } }), context, []).checks.no_handoff).toBe(true);
    expect(scoreCase(c, result({ reply: 'ok', handoff: { needed: true, reason: 'Customer asks the size' } }), context, []).checks.no_handoff).toBe(false);
  });

  it('a photo of a switched-off product is dropped by the backend, a sold-out order item is not', () => {
    const ctx = { ...context, products: [...context.products, { id: 4, name: 'Old Mat', price: 500, stock: 3, available: false, variants: [] }] };
    expect(scoreCase(testCase({}), result({ reply: 'ok', photo_product_ids: [4] }), ctx, []).checks.no_sold_out).toBe(true);
    expect(scoreCase(testCase({}), result({ reply: 'ok', order: { items: [{ product_id: 4, quantity: 1 }] } }), ctx, []).checks.no_sold_out).toBe(false);
  });
});
