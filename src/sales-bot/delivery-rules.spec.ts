import { orderDeliveryFee, ruleDeliveryFee, type DeliveryRules } from './delivery-fee';

/** Modlift: 1-2 T-shirts Rs 130, 3 or more free, pants Rs 425 (any number), Full Kit (T-shirt + pant) free. */
const modlift: DeliveryRules = {
  kinds: {
    cherie: { product_has: ['Chérie', 'Cherie'] },
    kit_tee: { product_has: ['Full Kit'], option_has: ['T-Shirt'] },
    pant: { product_has: ['Full Kit'], option_has: ['Pant'] },
  },
  rules: [
    { when: { 'cherie+kit_tee': '>=3' }, fee: 0 },
    { when: { kit_tee: '>=1', pant: '>=1' }, fee: 0 },
    { when: { pant: '>=1' }, fee: 425 },
    { when: { 'cherie+kit_tee': '>=1' }, fee: 130 },
  ],
};
const cherie = (n = 1, size = 'L') => ({ product_id: 7188, product_name: 'Chérie Bow Oversized T-Shirt', option: `Black / ${size}`, quantity: n });
const kitTee = (n = 1) => ({ product_id: 7193, product_name: 'Hi Full Kit (T-Shirt + Pant)', option: 'T-Shirt / Red / L', quantity: n });
const pant = (n = 1) => ({ product_id: 7193, product_name: 'Hi Full Kit (T-Shirt + Pant)', option: 'Pant / Red / L', quantity: n });
const zone = { area: '*', fee: 130, included_kg: 1, per_extra_kg: 295, weight_rounding: 'up' };

describe('delivery rules by item counts', () => {
  it('Modlift rules', () => {
    expect(ruleDeliveryFee(modlift, [cherie()])).toBe(130);
    expect(ruleDeliveryFee(modlift, [cherie(2)])).toBe(130);
    expect(ruleDeliveryFee(modlift, [cherie(1), cherie(1, '3XL')])).toBe(130);
    expect(ruleDeliveryFee(modlift, [cherie(3)])).toBe(0);
    expect(ruleDeliveryFee(modlift, [cherie(2), kitTee()])).toBe(0);
    expect(ruleDeliveryFee(modlift, [kitTee(), pant()])).toBe(0);
    expect(ruleDeliveryFee(modlift, [pant()])).toBe(425);
    expect(ruleDeliveryFee(modlift, [pant(2)])).toBe(425);
    expect(ruleDeliveryFee(modlift, [pant(3)])).toBe(425);
    expect(ruleDeliveryFee(modlift, [kitTee()])).toBe(130);
    expect(ruleDeliveryFee(modlift, [cherie(), pant()])).toBe(425);
  });

  it('shops without rules work exactly as before', () => {
    expect(ruleDeliveryFee(null, [cherie()])).toBeNull();
    expect(orderDeliveryFee(zone, 2.25, 3080, 3080)).toBe(0);
    expect(orderDeliveryFee(zone, 2.25, 2980, null)).toBe(130 + 2 * 295);
    expect(orderDeliveryFee(zone, 2.25, 2980, null, null, [pant(2)])).toBe(130 + 2 * 295);
  });

  it('rules win over "free delivery over"; no matching rule falls back to it', () => {
    expect(orderDeliveryFee(zone, 0.5, 3180, 3080, modlift, [cherie(2)])).toBe(130);
    expect(orderDeliveryFee(zone, 4, 2980, 3080, modlift, [pant(2)])).toBe(425);
    expect(orderDeliveryFee(zone, 0.3, 5000, 3080, modlift, [{ product_id: 1, product_name: 'Cap', option: '', quantity: 1 }])).toBe(0);
    expect(orderDeliveryFee(zone, 0.3, 1000, 3080, { ...modlift, rules: [{ when: { cherie: '>=1' }, fee: 'zone' }] }, [cherie()])).toBe(130);
  });
});
