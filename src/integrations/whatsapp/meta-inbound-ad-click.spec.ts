import { adLine, contentFromMetaMessage } from './meta-inbound-content.util';

describe('WhatsApp message from an ad that WhatsApp hides', () => {
  it('an unsupported message WITH the ad becomes the ad question (the bot answers about that ad)', () => {
    const out = contentFromMetaMessage({
      type: 'unsupported', errors: [{ title: 'Message type unknown' }],
      referral: { source_type: 'ad', source_id: '120214', source_url: 'https://fb.me/56keGy6DE', headline: 'Moodlift Clothing', body: 'Dear Customer, Chérie T-shirt' },
    } as any);
    expect(out).toEqual({ message_type: 'text', media_url: null,
      content: 'Hello! Can I get more info on this?\n[from the ad: Moodlift Clothing – Dear Customer, Chérie T-shirt https://fb.me/56keGy6DE]' });
  });

  it('from a boosted post: says post', () => {
    expect(adLine({ source_type: 'post', source_url: 'https://fb.com/p/1' })).toBe('[from the post https://fb.com/p/1]');
  });

  it('without the ad it stays unsupported (as before)', () => {
    expect(contentFromMetaMessage({ type: 'unsupported', errors: [{ title: 'This message is unavailable.' }] } as any))
      .toEqual({ content: '[unsupported]\nThis message is unavailable.', message_type: 'text', media_url: null });
    expect(adLine({})).toBeNull();
  });
});
