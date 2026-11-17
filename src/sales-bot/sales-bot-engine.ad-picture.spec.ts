import { SalesBotEngineService } from './sales-bot-engine.service';

/** The ad text does not name the product, the ad picture does: the bot is told which product the ad shows. */
describe('SalesBotEngineService – product from the ad picture', () => {
  const run = (status: string, products: Array<{ product_id: number; name: string; confidence: number }>, campaign: any, mediaType = 'image') => {
    const match = jest.fn().mockResolvedValue({ match: { status, method: 'ai', item: '', description: '', products }, usage: [] });
    const self: any = {
      photoMatcher: { match },
      adPictureProducts: new Map(),
      logger: { log: jest.fn(), warn: jest.fn() },
      usageRepository: { save: jest.fn(), create: (x: unknown) => x },
      messageRepository: { query: jest.fn().mockResolvedValue([{ ad_source_id: 'AD1', ad_media_url: 'data:image/jpeg;base64,AAAA', ad_media_type: mediaType }]) },
      loadMedia: async () => ({ mime_type: 'image/jpeg', data_b64: 'AAAA' }),
    };
    const fn = (SalesBotEngineService.prototype as any).productsFromAdPicture;
    return { self, match, done: fn.call(self, 7, 3977, campaign, null) };
  };

  it('links the product the ad picture shows', async () => {
    const campaign = { source: 'ad', product_ids: [], instructions: '' };
    const { done } = run('likely', [{ product_id: 12, name: 'Chérie Bow Oversized T-Shirt', confidence: 88 }, { product_id: 11, name: 'Hi Full Kit', confidence: 40 }], campaign);
    await done;
    expect(campaign.product_ids).toEqual([12]);
    expect(campaign.instructions).toContain('Chérie Bow Oversized T-Shirt');
  });

  it('matches one ad only once (cached for later chats)', async () => {
    const products = [{ product_id: 12, name: 'Chérie', confidence: 90 }];
    const first = run('exact', products, { source: 'ad', product_ids: [], instructions: '' });
    await first.done;
    const second = { source: 'ad', product_ids: [] as number[], instructions: '' };
    await (SalesBotEngineService.prototype as any).productsFromAdPicture.call(first.self, 7, 3978, second, null);
    expect(first.match).toHaveBeenCalledTimes(1);
    expect(second.product_ids).toEqual([12]);
  });

  it('keeps products the shop linked itself and ignores weak matches', async () => {
    const linked = { source: 'ad', product_ids: [5], instructions: 'x' };
    const a = run('likely', [{ product_id: 12, name: 'Chérie', confidence: 90 }], linked);
    await a.done;
    expect(linked.product_ids).toEqual([5]);
    expect(a.match).not.toHaveBeenCalled();
    const weak = { source: 'ad', product_ids: [] as number[], instructions: '' };
    await run('unsure', [{ product_id: 12, name: 'Chérie', confidence: 65 }], weak).done;
    expect(weak.product_ids).toEqual([]);
    expect(weak.instructions).toBe('');
  });
});
