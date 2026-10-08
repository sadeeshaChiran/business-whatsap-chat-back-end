import { orderDeliveryFee } from './delivery-fee';

describe('order delivery fee', () => {
  const zone = { fee: 350, included_kg: 2, per_extra_kg: 60 };
  it('zone fee with the weight rule', () => expect(orderDeliveryFee(zone, 3, 4000, null)).toBe(410));
  it('free from the shop amount', () => expect(orderDeliveryFee(zone, 3, 15000, 15000)).toBe(0));
  it('just below the amount pays', () => expect(orderDeliveryFee(zone, 1, 14999, 15000)).toBe(350));
  it('0 / empty = never free', () => expect(orderDeliveryFee(zone, 1, 99999, 0)).toBe(350));
});
