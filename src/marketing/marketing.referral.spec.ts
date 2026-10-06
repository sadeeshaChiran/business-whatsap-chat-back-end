import { MarketingService } from './marketing.service';

/** The ad referral that Meta sends with the first message after an ad click is stored on the conversation. */
describe('MarketingService.captureReferrals', () => {
  const setup = (conversationId: number | null) => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const dataSource = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('FROM bot_message m JOIN bot_conversation')) return conversationId ? [{ id: conversationId, company_id: 5 }] : [];
        if (sql.includes('FROM bot_conversation c JOIN bot_channel_user')) return conversationId ? [{ id: conversationId, company_id: 5 }] : [];
        return [];
      }),
    };
    const service = new MarketingService(dataSource as never, {} as never, {} as never);
    return { service, calls };
  };

  it('stores a Click-to-WhatsApp referral with ctwa_clid', async () => {
    const { service, calls } = setup(42);
    await service.captureReferrals({
      entry: [{ changes: [{ value: { messages: [{ id: 'wamid.1', referral: { source_id: '120210', source_type: 'ad', headline: 'Baby shoes -20%', source_url: 'https://fb.me/x', ctwa_clid: 'CLID123' } }] } }] }],
    }, 'whatsapp');
    const update = calls.find((c) => c.sql.includes('UPDATE bot_conversation SET ad_source_id'));
    expect(update?.params).toEqual([42, '120210', 'ad', 'Baby shoes -20%', 'https://fb.me/x', 'CLID123', 'whatsapp', '']);
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
