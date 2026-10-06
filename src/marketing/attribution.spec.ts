import { linkTags, normaliseText } from './attribution';
import { CampaignsService } from './campaigns.service';

describe('campaign attribution helpers', () => {
  it('finds short-link codes in a message', () => {
    expect(linkTags('Hi! I saw the offer. #k7p2qx')).toEqual(['k7p2qx']);
    expect(linkTags('#Avurudu-25 please')).toEqual(['avurudu-25']);
    expect(linkTags('price? no code')).toEqual([]);
  });

  it('compares the ready text without the code, case, emoji and punctuation', () => {
    expect(normaliseText('Hi! I saw the Avurudu offer. #k7p2qx')).toBe(normaliseText('hi i saw the avurudu offer'));
    expect(normaliseText('ආයුබෝවන්! 🙏')).toBe('ආයුබෝවන්');
  });

  it('builds the chat links', () => {
    expect(CampaignsService.targetUrl({ channel: 'whatsapp', target: '94771234567', prefill_text: 'Hi!', slug: 'abc123' })).toBe('https://wa.me/94771234567?text=Hi!%20%23abc123');
    expect(CampaignsService.targetUrl({ channel: 'whatsapp', target: '94771234567', prefill_text: 'Hi #abc123', slug: 'abc123' })).toBe('https://wa.me/94771234567?text=Hi%20%23abc123');
    expect(CampaignsService.targetUrl({ channel: 'messenger', target: 'myshop', prefill_text: '', slug: 'abc123' })).toBe('https://m.me/myshop?ref=abc123');
    expect(CampaignsService.targetUrl({ channel: 'instagram', target: '@myshop', prefill_text: '', slug: 'abc123' })).toBe('https://ig.me/m/myshop?ref=abc123');
  });
});
