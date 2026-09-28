import { createHmac } from 'crypto';
import { SalesBotHook } from '../../common/sales-bot-hook';
import { MetaMessagesController } from './meta-messages.controller';

describe('MetaMessagesController', () => {
  const previousSecret = process.env.META_APP_SECRET;
  const previousVerify = process.env.META_MESSAGING_VERIFY_TOKEN;

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = previousSecret;
    if (previousVerify === undefined) delete process.env.META_MESSAGING_VERIFY_TOKEN;
    else process.env.META_MESSAGING_VERIFY_TOKEN = previousVerify;
  });

  it('requires the configured verification token', () => {
    process.env.META_MESSAGING_VERIFY_TOKEN = 'known-token';
    const controller = new MetaMessagesController({} as never, {} as never, {} as never, {} as never, {} as never);
    expect(controller.verify('subscribe', 'known-token', 'challenge')).toBe('challenge');
    expect(() => controller.verify('subscribe', 'wrong', 'challenge')).toThrow();
  });

  it('rejects unsigned webhooks without writing contacts', async () => {
    process.env.META_APP_SECRET = 'secret';
    const connectionRepository = { findOne: jest.fn() };
    const controller = new MetaMessagesController(connectionRepository as never, {} as never, {} as never, {} as never, {} as never);
    await expect(controller.receive({ object: 'page', entry: [] }, { rawBody: Buffer.from('{}') } as never, undefined)).rejects.toThrow();
    expect(connectionRepository.findOne).not.toHaveBeenCalled();
  });

  it('stores an inbound message under the saved Meta contact name', async () => {
    process.env.META_APP_SECRET = 'secret';
    const body = { object: 'page', entry: [{ id: 'page-1', messaging: [{
      sender: { id: 'sender-1' }, recipient: { id: 'page-1' },
      message: { mid: 'mid-1', text: 'Hello' },
    }] }] };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = 'sha256=' + createHmac('sha256', 'secret').update(rawBody).digest('hex');
    const connectionRepository = { findOne: jest.fn().mockResolvedValue({
      company_id: 7, page_id: 'page-1', page_access_token: 'token',
    }) };
    const userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 11, platform: 'messenger', external_user_id: 'sender-1', display_name: 'Saved Customer' }),
      save: jest.fn().mockImplementation(async (item) => item),
    };
    const conversationRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 21, status: 'open' }),
      save: jest.fn().mockImplementation(async (item) => item),
    };
    const messageRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((item) => item),
      save: jest.fn().mockImplementation(async (item) => item),
    };
    const controller = new MetaMessagesController(
      connectionRepository as never, userRepository as never,
      conversationRepository as never, messageRepository as never, {} as never,
    );
    await expect(controller.receive(body, { rawBody } as never, signature)).resolves.toEqual({ ok: true, saved: 1 });
    expect(userRepository.save).toHaveBeenCalledWith(expect.objectContaining({ display_name: 'Saved Customer' }));
    expect(messageRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'messenger', content: 'Hello', provider_message_id: 'mid-1',
    }));
  });
  it('hands new Messenger / Instagram messages to the sales bot and lets new customers follow the auto-enable rule', async () => {
    process.env.META_APP_SECRET = 'secret';
    const notified: unknown[] = [];
    SalesBotHook.register(async (event) => { notified.push(event); return true; });
    const body = { object: 'instagram', entry: [{ id: 'ig-1', messaging: [{
      sender: { id: 'cust-1' }, recipient: { id: 'ig-1' }, message: { mid: 'mid-9', text: 'price?' },
    }] }] };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = 'sha256=' + createHmac('sha256', 'secret').update(rawBody).digest('hex');
    const savedUsers: any[] = [];
    const controller = new MetaMessagesController(
      { findOne: jest.fn().mockResolvedValue({ company_id: 7, instagram_business_account_id: 'ig-1', page_access_token: 't' }) } as never,
      { findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockImplementation((x) => x),
        save: jest.fn().mockImplementation(async (x) => { const row = { id: 5, ...x }; savedUsers.push(row); return row; }) } as never,
      { findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockImplementation((x) => x),
        save: jest.fn().mockImplementation(async (x) => ({ id: 31, ...x })) } as never,
      { findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockImplementation((x) => x),
        save: jest.fn().mockImplementation(async (x) => x) } as never,
      { fetchMessagingProfile: jest.fn().mockResolvedValue({ username: 'kamal_ig' }) } as never,
    );
    await controller.receive(body, { rawBody } as never, signature);
    expect(notified).toEqual([{ companyId: 7, conversationId: 31, phone: 'cust-1', provider: 'instagram' }]);
    expect(savedUsers[0]).toEqual(expect.objectContaining({ platform: 'instagram', manual_mode: false, bot_enabled: false, display_name: 'kamal_ig' }));
    SalesBotHook.register(undefined as never);
  });
});
