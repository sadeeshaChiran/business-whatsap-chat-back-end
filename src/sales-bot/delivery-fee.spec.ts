import { countedKg, orderDeliveryFee } from './delivery-fee';

describe('order delivery fee', () => {
  const zone = { fee: 350, included_kg: 2, per_extra_kg: 60 };
  it('zone fee with the weight rule', () => expect(orderDeliveryFee(zone, 3, 4000, null)).toBe(410));
  it('free from the shop amount', () => expect(orderDeliveryFee(zone, 3, 15000, 15000)).toBe(0));
  it('just below the amount pays', () => expect(orderDeliveryFee(zone, 1, 14999, 15000)).toBe(350));
  it('0 / empty = never free', () => expect(orderDeliveryFee(zone, 1, 99999, 0)).toBe(350));
});

describe('weight rounding', () => {
  // Rs 350 includes 1 kg, then Rs 100 per extra kg; the order weighs 2.3 kg
  const zone = (weight_rounding: string) => ({ area: 'Colombo', fee: 350, included_kg: 1, per_extra_kg: 100, weight_rounding });
  it('up (default): 2.3 kg counts as 3 kg', () => expect(orderDeliveryFee(zone('up'), 2.3, 0, null)).toBe(550));
  it('nearest: 2.3 kg counts as 2 kg', () => expect(orderDeliveryFee(zone('nearest'), 2.3, 0, null)).toBe(450));
  it('nearest: 2.5 kg counts as 3 kg', () => expect(orderDeliveryFee(zone('nearest'), 2.5, 0, null)).toBe(550));
  it('exact: 2.3 kg', () => expect(orderDeliveryFee(zone('exact'), 2.3, 0, null)).toBe(480));
  it('up: 2 kg exactly stays 2 kg (no float noise)', () => expect(countedKg(0.1 * 3 + 1.7, 'up')).toBe(2));
  it('up: 0.4 kg inside the included kg = base fee', () => expect(orderDeliveryFee(zone('up'), 0.4, 0, null)).toBe(350));
  it('no setting = up', () => expect(countedKg(2.3, undefined)).toBe(3));
});
