import { FlowsService, keywordMatch, type FormField } from './flows.service';

describe('flow keywords', () => {
  it('contains matches whole words, Sinhala / Singlish too, and ignores punctuation and case', () => {
    expect(keywordMatch({ keywords: ['price'] }, 'PRICE?')).toBe(true);
    expect(keywordMatch({ keywords: ['price'] }, 'what is the price of this')).toBe(true);
    expect(keywordMatch({ keywords: ['ganana'] }, 'meke gananа kiyada')).toBe(false);
    expect(keywordMatch({ keywords: ['ganana'] }, 'meke ganana kiyada')).toBe(true);
    expect(keywordMatch({ keywords: ['මිල'] }, 'මේකේ මිල කීයද?')).toBe(true);
    expect(keywordMatch({ keywords: ['hi'] }, 'this')).toBe(false);
  });
  it('exact and starts', () => {
    expect(keywordMatch({ keywords: ['menu'], match: 'exact' }, 'Menu!')).toBe(true);
    expect(keywordMatch({ keywords: ['menu'], match: 'exact' }, 'the menu')).toBe(false);
    expect(keywordMatch({ keywords: ['order'], match: 'starts' }, 'order 2 shirts')).toBe(true);
    expect(keywordMatch({ keywords: ['order'], match: 'starts' }, 'my order')).toBe(false);
  });
});

describe('form answers', () => {
  const service = new FlowsService({} as never, {} as never, {} as never);
  const field = (f: Partial<FormField>): FormField => ({ id: 'x', label: 'X', type: 'text', ...f });
  it('phone numbers become +94…', () => {
    expect(service.checkAnswer(field({ type: 'phone' }), '077 123 4567')).toEqual({ value: '+94771234567' });
    expect(service.checkAnswer(field({ type: 'phone' }), '+94 77 123 4567')).toEqual({ value: '+94771234567' });
    expect(service.checkAnswer(field({ type: 'phone' }), '123').error).toBeTruthy();
  });
  it('choices by number or text, several for multi', () => {
    const options = ['Small', 'Medium', 'Large'];
    expect(service.checkAnswer(field({ type: 'choice', options }), '2')).toEqual({ value: 'Medium' });
    expect(service.checkAnswer(field({ type: 'choice', options }), 'large please')).toEqual({ value: 'Large' });
    expect(service.checkAnswer(field({ type: 'choice', options }), 'XL').error).toMatch(/Small, Medium, Large/);
    expect(service.checkAnswer(field({ type: 'multi', options }), '1,3')).toEqual({ value: ['Small', 'Large'] });
    expect(service.checkAnswer(field({ type: 'multi', options }), ['Medium'])).toEqual({ value: ['Medium'] });
  });
  it('required, skip, email, number', () => {
    expect(service.checkAnswer(field({ required: true }), '', false, true).error).toBeTruthy();
    expect(service.checkAnswer(field({}), 'skip', false, true)).toEqual({ value: undefined });
    expect(service.checkAnswer(field({ type: 'email' }), 'A@B.lk')).toEqual({ value: 'a@b.lk' });
    expect(service.checkAnswer(field({ type: 'email' }), 'nope').error).toBeTruthy();
    expect(service.checkAnswer(field({ type: 'number' }), '1,500')).toEqual({ value: 1500 });
  });
  it('a photo from the link page must be one we stored', () => {
    expect(service.checkAnswer(field({ type: 'photo' }), 'https://evil.example/x.jpg', true).error).toBeTruthy();
  });
});
