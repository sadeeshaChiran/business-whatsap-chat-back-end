import { activeOffer, offerFields, priceFor, sriLankaToday } from './package-offer';

const pkg = (over: Record<string, unknown> = {}) => ({
  price_monthly: 10000, price_yearly: 100000, offer_price_monthly: 7490 as number | null, offer_price_yearly: null as number | null,
  offer_until: '2026-12-31' as string | null, offer_label: ' Launch offer ', ...over,
});

describe('package offers', () => {
  it('uses the Sri Lanka date (UTC+5:30)', () => {
    expect(sriLankaToday(new Date('2026-12-31T18:29:00Z'))).toBe('2026-12-31');
    expect(sriLankaToday(new Date('2026-12-31T18:31:00Z'))).toBe('2027-01-01');
  });

  it('charges the offer price until the end of the last day, then the normal price', () => {
    expect(priceFor(pkg(), 'monthly', new Date('2026-10-06T10:00:00Z'))).toMatchObject({ amount: 7490, offer: { until: '2026-12-31', label: 'Launch offer' } });
    expect(priceFor(pkg(), 'monthly', new Date('2026-12-31T18:00:00Z')).amount).toBe(7490);
    expect(priceFor(pkg(), 'monthly', new Date('2026-12-31T18:31:00Z'))).toEqual({ amount: 10000, offer: null });
  });

  it('yearly without an offer price stays at the normal yearly price', () => {
    expect(priceFor(pkg(), 'yearly', new Date('2026-10-06T10:00:00Z'))).toEqual({ amount: 100000, offer: null });
    expect(priceFor(pkg({ offer_price_yearly: 80000 }), 'yearly', new Date('2026-10-06T10:00:00Z')).amount).toBe(80000);
  });

  it('ignores offers without a date, with a price not lower than normal, or already ended', () => {
    const now = new Date('2026-10-06T10:00:00Z');
    expect(activeOffer(pkg({ offer_until: null }), now)).toBeNull();
    expect(activeOffer(pkg({ offer_price_monthly: 10000 }), now)).toBeNull();
    expect(activeOffer(pkg({ offer_until: '2026-10-05' }), now)).toBeNull();
    expect(activeOffer(pkg({ offer_until: new Date('2026-12-31T00:00:00Z') as unknown as string }), now)?.until).toBe('2026-12-31');
  });

  it('shows a rounded reply count', () => {
    expect(offerFields(pkg({ offer_until: null }), 7500, 18_750_000)).toEqual({ offer: null, approx_replies: 2500 });
  });
});
