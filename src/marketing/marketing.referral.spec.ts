import { MarketingService } from './marketing.service';

/** The ad referral that Meta sends with the first message after an ad click is stored on the conversation. */
describe('MarketingService.captureReferrals', () => {
  const setup = (conversationId: number | null) => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const seen = new Set<string>();
    const dataSource = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('FROM bot_message m JOIN bot_conversation')) return conversationId ? [{ id: conversationId, company_id: 5 }] : [];
        if (sql.includes('FROM bot_conversation c JOIN bot_channel_user')) return conversationId ? [{ id: conversationId, company_id: 5 }] : [];
        if (sql.includes('INSERT INTO marketing_ad_click')) return seen.has(String(params[11])) ? [] : (seen.add(String(params[11])), [{ id: 1 }]);
        return [];
      }),
    };
    const service = new MarketingService(dataSource as never, {} as never, {} as never);
    return { service, calls };
  };

  it('stores a Click-to-WhatsApp referral with ctwa_clid', async () => {
    const { service, calls } = setup(42);
    await service.captureReferrals({
      entry: [{ changes: [{ value: { messages: [{ id: 'wamid.1', referral: { source_id: '120210', source_type: 'ad', headline: 'Baby shoes -20%', source_url: 'https://fb.me/x', ctwa_clid: 'CLID123', media_type: 'image', image_url: 'https://cdn/x.jpg' } }] } }] }],
    }, 'whatsapp');
    const update = calls.find((c) => c.sql.includes('UPDATE bot_conversation SET ad_source_id'));
    expect(update?.params).toEqual([42, '120210', 'ad', 'Baby shoes -20%', 'https://fb.me/x', 'CLID123', 'whatsapp', '', 'https://cdn/x.jpg', 'image']);
    const click = calls.find((c) => c.sql.includes('INSERT INTO marketing_ad_click'));
    expect(click?.params.slice(3, 12)).toEqual(['whatsapp', '120210', 'ad', 'Baby shoes -20%', null, 'https://fb.me/x', 'https://cdn/x.jpg', 'image', 'wamid.1']);
    // then the campaign that lists this ad is looked up for company 5
    expect(calls.some((c) => c.sql.includes('FROM marketing_campaign') && c.params[0] === 5 && c.params[1] === '120210')).toBe(true);
  });

  it('stores a Click-to-Messenger referral found by the sender', async () => {
    const { service, calls } = setup(7);
    await service.captureReferrals({
      entry: [{ messaging: [{ sender: { id: 'PSID9' }, referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '555', ads_context_data: { ad_title: 'Sale' } } }] }],
    }, 'messenger');
    const update = calls.find((c) => c.sql.includes('UPDATE bot_conversation SET ad_source_id'));
    expect(update?.params.slice(0, 4)).toEqual([7, '555', 'ad', 'Sale']);
  });

  it('the same webhook message is counted once (it is captured before the AI and again for retries)', async () => {
    const { service, calls } = setup(42);
    const body = { entry: [{ changes: [{ value: { messages: [{ id: 'wamid.9', referral: { source_id: '777', source_type: 'post', headline: 'Shared post' } }] } }] }] };
    await service.captureReferrals(body, 'whatsapp');
    await service.captureReferrals(body, 'whatsapp');
    expect(calls.filter((c) => c.sql.includes('UPDATE bot_conversation SET ad_source_id')).length).toBe(1);
  });

  it('QR WhatsApp (Evolution): the ad comes as externalAdReply', async () => {
    const { service, calls } = setup(11);
    await service.captureReferrals({ event: 'messages.upsert', data: { key: { id: 'EV1', fromMe: false }, message: { extendedTextMessage: { text: 'Hello! Can I get more info on this?',
      contextInfo: { externalAdReply: { title: 'Websites from Rs 20,000', body: 'Get your business online', sourceId: '1202', sourceType: 'ad', sourceUrl: 'https://fb.me/ci8', thumbnailUrl: 'https://cdn/t.jpg', mediaType: 1 } } } } } }, 'whatsapp');
    const update = calls.find((c) => c.sql.includes('UPDATE bot_conversation SET ad_source_id'));
    expect(update?.params.slice(0, 4)).toEqual([11, '1202', 'ad', 'Websites from Rs 20,000']);
    expect(update?.params[7]).toBe('Get your business online');
    expect(update?.params.slice(8)).toEqual(['https://cdn/t.jpg', 'image']);
  });

  it('ignores messages without a referral', async () => {
    const { service, calls } = setup(42);
    await service.captureReferrals({ entry: [{ changes: [{ value: { messages: [{ id: 'wamid.2', text: { body: 'hi' } }] } }] }] }, 'whatsapp');
    expect(calls.some((c) => c.sql.includes('UPDATE bot_conversation'))).toBe(false);
  });
});

describe('MarketingService.captureReferrals – short links', () => {
  it('a Messenger ref before the first message is kept until the chat exists', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const dataSource = { query: jest.fn(async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; }) };
    const service = new MarketingService(dataSource as never, {} as never, {} as never);
    await service.captureReferrals({ entry: [{ messaging: [{ sender: { id: 'PSID1' }, referral: { ref: 'avurudu', source: 'SHORTLINK', type: 'OPEN_THREAD' } }] }] }, 'messenger');
    const saved = calls.find((c) => c.sql.includes('INSERT INTO marketing_pending_ref'));
    expect(saved?.params.slice(0, 2)).toEqual(['messenger', 'PSID1']);
    expect(JSON.parse(String(saved?.params[2]))).toEqual({ kind: 'ref', value: 'avurudu' });
  });
});
