import { SalesBotEngineService } from './sales-bot-engine.service';

/** The bot must answer Messenger / Instagram chats through the Meta Page, never through WhatsApp. */
function build(platform: string, botResult: Record<string, unknown> = {}, packageFeatures: Record<string, boolean> = {}) {
  const saved: any[] = [];
  const qbQueue: any[][] = [];
  const qb: any = {
    where: () => qb, andWhere: () => qb, orderBy: () => qb, limit: () => qb,
    getMany: async () => qbQueue.shift() ?? [],
  };
  const channelUser: any = { id: 5, platform, external_user_id: 'CUST1', source_account_id: 'ACC1', display_name: 'Kamal', bot_enabled: false, manual_mode: false, session_state: null };
  const conversation: any = { id: 21, status: 'open', channelUser };
  const result = {
    reply: 'Hello! How can I help?', photo_product_ids: [], order: null, booking: null, lead: null, handoff: null,
    language: 'english', tools_used: [], parse_error: false,
    usage: { model: 'm', input_tokens: 1, cached_tokens: 0, output_tokens: 1, cost_usd: 0.001, latency_ms: 5 }, ...botResult,
  };
  const social = { sendText: jest.fn().mockResolvedValue('m.out.1'), sendImage: jest.fn() };
  const whatsapp = { getChannelForCompany: jest.fn().mockResolvedValue({ meta_access_token: 'x' }) };
  const adapter = { sendText: jest.fn().mockResolvedValue({ messageId: 'wa.1' }), sendMedia: jest.fn() };
  const reply = jest.fn().mockResolvedValue(result);
  const engine = new SalesBotEngineService(
    { findOne: async () => ({ id: 7, plan: 'free', bot_enabled: true }) } as never,
    { findOne: async () => conversation, update: jest.fn() } as never,
    { findOne: async () => ({ ...channelUser, bot_enabled: true }), update: jest.fn() } as never,
    { findOne: async () => null, createQueryBuilder: () => qb, create: (x: any) => x, save: async (x: any) => { saved.push(x); return x; } } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    { create: (x: any) => x, save: async (x: any) => x } as never,
    { create: (x: any) => x, save: async (x: any) => x } as never, // bot notifications
    { getSettings: async () => ({ auto_enable_new_customers: true }), build: async () => ({}) } as never,
    { reply } as never,
    {} as never,
    whatsapp as never,
    { getAdapterForChannel: () => adapter } as never,
    { trigger: jest.fn() } as never,
    { sendInvoiceForCompany: jest.fn() } as never, // bot-admin (invoices)
    { planAllowsBot: async () => true, hasFeature: async (_company: number, key: string) => packageFeatures[key] !== false } as never, // packages + limits
    { canBotReply: async () => true } as never, // token quota
    social as never,
  );
  qbQueue.push([{ id: 1, content: 'hi, price of the pram?', message_type: 'text', media_url: null, direction: 'inbound' }], []);
  return { engine, social, whatsapp, adapter, reply, saved, channelUser };
}

describe('SalesBotEngineService on Messenger / Instagram', () => {
  it.each(['messenger', 'instagram'])('replies on %s through the Page, not WhatsApp', async (platform) => {
    const t = build(platform);
    await (t.engine as any).turn(7, 21);
    expect(t.social.sendText).toHaveBeenCalledWith(7, platform, 'ACC1', 'CUST1', 'Hello! How can I help?');
    expect(t.whatsapp.getChannelForCompany).not.toHaveBeenCalled();
    expect(t.adapter.sendText).not.toHaveBeenCalled();
    expect(t.reply.mock.calls[0][0].session.channel).toBe(platform);
    const out = t.saved.find((row) => row.direction === 'outbound');
    expect(out).toEqual(expect.objectContaining({ platform, provider_message_id: 'm.out.1', delivery_status: 'sent', content: 'Hello! How can I help?' }));
  });

  it('marks the reply failed (not lost) when Meta rejects it', async () => {
    const t = build('messenger');
    t.social.sendText.mockRejectedValue(new Error('outside 24h window'));
    await (t.engine as any).turn(7, 21);
    const out = t.saved.find((row) => row.direction === 'outbound');
    expect(out).toEqual(expect.objectContaining({ provider_message_id: null, delivery_status: 'failed' }));
  });

  it.each(['messenger', 'instagram'])('does not reply on %s when the package does not include it', async (platform) => {
    const t = build(platform, {}, { [platform]: false });
    await (t.engine as any).turn(7, 21);
    expect(t.reply).not.toHaveBeenCalled(); // no AI call, no credits used
    expect(t.social.sendText).not.toHaveBeenCalled();
  });

  it('still replies on WhatsApp when Messenger / Instagram are not in the package', async () => {
    const t = build('whatsapp', {}, { messenger: false, instagram: false });
    await (t.engine as any).turn(7, 21);
    expect(t.adapter.sendText).toHaveBeenCalled();
  });

  it('still sends WhatsApp chats through the WhatsApp adapter', async () => {
    const t = build('whatsapp');
    await (t.engine as any).turn(7, 21);
    expect(t.adapter.sendText).toHaveBeenCalled();
    expect(t.social.sendText).not.toHaveBeenCalled();
    expect(t.reply.mock.calls[0][0].session.channel).toBe('whatsapp');
  });
});
