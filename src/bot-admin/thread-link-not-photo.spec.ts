import { BotAdminService } from './bot-admin.service';

/** A web page link in a message ("Catalog: https://shop.lk") stayed a broken photo in the inbox. */
describe('thread messages: links vs photos', () => {
  const service = Object.create(BotAdminService.prototype) as { hydrateThreadMessage: (m: Record<string, unknown>) => Record<string, unknown> };
  const hydrate = (content: string, extra: Record<string, unknown> = {}) =>
    service.hydrateThreadMessage({ direction: 'outbound', message_type: 'text', content, media_url: null, ...extra });

  it('keeps a page link as text', () => {
    const out = hydrate('තව මොනවා හරි අවශ්‍ය නම් Catalog එකෙනුත් බලන්න: https://www.chu.lk');
    expect(out.message_type).toBe('text');
    expect(out.media_url).toBeNull();
    expect(hydrate('Post: https://www.facebook.com/123/posts/456').message_type).toBe('text');
  });

  it('still shows a picture link as a photo', () => {
    const out = hydrate('Photo https://shop.lk/public/product-images/a.jpg');
    expect(out.message_type).toBe('image');
    expect(out.media_url).toBe('https://shop.lk/public/product-images/a.jpg');
    expect(hydrate('https://cdn.x.com/p/shoe.png?v=2').message_type).toBe('image');
  });

  it('keeps stored media as it was', () => {
    const out = hydrate('[image]', { message_type: 'image', media_url: 'local-media:abc' });
    expect(out.media_url).toBe('local-media:abc');
    expect(out.message_type).toBe('image');
  });
});
