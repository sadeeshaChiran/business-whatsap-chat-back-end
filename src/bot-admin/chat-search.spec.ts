import { chatSearch } from './bot-admin.service';

describe('chat search terms', () => {
  it('too short -> no search', () => {
    expect(chatSearch('')).toBeNull();
    expect(chatSearch(' a ')).toBeNull();
  });

  it('a name: ILIKE text, no digits', () => {
    expect(chatSearch('Nimali')).toEqual({ text: '%Nimali%', digits: null });
  });

  it('phone numbers in any form find the same digits', () => {
    expect(chatSearch('077 123 4567')?.digits).toBe('%771234567%');
    expect(chatSearch('0771234567')?.digits).toBe('%771234567%');
    expect(chatSearch('+94 77 123 4567')?.digits).toBe('%771234567%');
  });

  it('a name with a number in it is not a phone search', () => {
    expect(chatSearch('Room 101 booking')?.digits).toBeNull();
  });

  it('LIKE wildcards are escaped', () => {
    expect(chatSearch('50%_off')?.text).toBe('%50\\%\\_off%');
  });
});
