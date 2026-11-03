import {
  daysLeft, findOption, looksLikeProductQuestion, normalQuestion, optionLabel, productStock, reorderState, saysNotAvailable,
  stockAlert, stockChanges, stockKey, stockState, typicalGapDays,
} from './stock-logic';

describe('stock logic', () => {
  const options = [
    { variant_name: 'Size', variant_value: 'M', quantity: 10 },
    { variant_name: 'Size', variant_value: 'L', quantity: 3 },
    { variant_name: 'Colour / Size', variant_value: 'White / XL', quantity: 1 },
  ];

  it('finds the option an order line means', () => {
    expect(optionLabel(options[0])).toBe('Size: M');
    expect(findOption(options, 'Size: M')).toBe(0);
    expect(findOption(options, 'L')).toBe(1);
    expect(findOption(options, 'xl white')).toBe(2);
    expect(findOption(options, 'XXL')).toBe(-1);
    expect(findOption(options, '')).toBe(-1);
  });

  it('moves only the difference between what the order needs and what it holds', () => {
    const a = stockKey(1, null);
    const b = stockKey(2, 'Size: M');
    // new order: take 2 and 1
    expect(stockChanges(new Map([[a, 2], [b, 1]]), new Map())).toEqual([
      { key: a, change: -2, desired: 2, held: 0 }, { key: b, change: -1, desired: 1, held: 0 },
    ]);
    // same again: nothing (running twice never takes stock twice)
    expect(stockChanges(new Map([[a, 2]]), new Map([[a, 2]]))).toEqual([]);
    // changed from 2 to 5: take 3 more; item removed: put back
    expect(stockChanges(new Map([[a, 5]]), new Map([[a, 2], [b, 1]]))).toEqual([
      { key: a, change: -3, desired: 5, held: 2 }, { key: b, change: 1, desired: 0, held: 1 },
    ]);
    // cancelled: everything back
    expect(stockChanges(new Map(), new Map([[a, 5]]))).toEqual([{ key: a, change: 5, desired: 0, held: 5 }]);
  });

  it('alerts only when a line is crossed', () => {
    expect(stockAlert(6, 5, 5)).toBe('low_stock');
    expect(stockAlert(5, 4, 5)).toBeNull();   // already low: no second alert
    expect(stockAlert(2, 0, 5)).toBe('out_of_stock');
    expect(stockAlert(1, -2, 5)).toBe('out_of_stock');
    expect(stockAlert(0, 10, 5)).toBe('back_in_stock');
    expect(stockAlert(20, 10, 5)).toBeNull();
    expect(stockAlert(3, 1, 0)).toBeNull();   // level 0 = no low alert
    expect(stockState(0, 5)).toBe('out');
    expect(stockState(5, 5)).toBe('low');
    expect(stockState(6, 5)).toBe('ok');
  });

  it('works out days of stock left', () => {
    expect(daysLeft(30, 30, 30)).toBe(30);
    expect(daysLeft(10, 60, 30)).toBe(5);
    expect(daysLeft(10, 0, 30)).toBeNull();
    expect(daysLeft(0, 9, 30)).toBe(0);
  });
});

describe('demand questions', () => {
  it('spots product questions in Singlish, Sinhala, Tamil and English', () => {
    expect(looksLikeProductQuestion('Huggies thiyenawada?')).toBe(true);
    expect(looksLikeProductQuestion('do you have adult wipes')).toBe(true);
    expect(looksLikeProductQuestion('ළමා කිරිපිටි තියෙනවද')).toBe(true);
    expect(looksLikeProductQuestion('குழந்தை சோப் இருக்கா')).toBe(true);
    expect(looksLikeProductQuestion('hi')).toBe(false);
    expect(looksLikeProductQuestion('delivery kiyada?')).toBe(false);
    expect(looksLikeProductQuestion('ok thanks')).toBe(false);
  });

  it('spots a reply that says the shop does not have it', () => {
    expect(saysNotAvailable("Sorry, we don't have Huggies right now.")).toBe(true);
    expect(saysNotAvailable('Huggies nam naha, Pretty Baby thiyenawa')).toBe(true);
    expect(saysNotAvailable('ඒක දැනට නැහැ')).toBe(true);
    expect(saysNotAvailable('Yes, M size is Rs 1,450')).toBe(false);
    expect(normalQuestion('  Huggies THIYENAWADA?? ')).toBe('huggies thiyenawada');
  });
});

describe('reorder due', () => {
  it('takes the middle gap between purchases', () => {
    expect(typicalGapDays(['2026-01-01', '2026-01-22', '2026-02-12', '2026-03-20'])).toBe(21);
    expect(typicalGapDays(['2026-01-01'])).toBeNull();
    expect(typicalGapDays(['2026-01-01T08:00:00', '2026-01-01T18:00:00'])).toBeNull();   // same day twice is one purchase
    expect(typicalGapDays(['2026-01-01', '2026-01-11', '2026-01-31'])).toBe(15);
  });

  it('says when the customer needs it again', () => {
    const today = new Date('2026-10-24T10:00:00');
    expect(reorderState('2026-10-01', 21, today)).toEqual({ due_on: '2026-10-22', days_until: -2, state: 'overdue' });
    expect(reorderState('2026-10-04', 21, today)).toEqual({ due_on: '2026-10-25', days_until: 1, state: 'due' });
    expect(reorderState('2026-10-10', 21, today).state).toBe('soon');
    expect(reorderState('2026-10-20', 21, today).state).toBe('later');
  });

  it('gives a product with options the worst option state', () => {
    expect(productStock(true, [{ quantity: 40 }, { quantity: 4 }], 0, 5)).toEqual({ stock: 44, state: 'low' });
    expect(productStock(true, [{ quantity: 0 }, { quantity: 4 }], 0, 5)).toEqual({ stock: 4, state: 'out' });
    expect(productStock(false, null, 12, 5)).toEqual({ stock: 12, state: 'ok' });
  });
});
