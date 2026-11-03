import { TelegramService } from './telegram.service';

/** Web links (e.g. a product photo URL an admin typed) are never downloaded by this server – Telegram fetches them itself. */
describe('TelegramService.sendFile', () => {
  const row = { id: 1, company_id: 7, bot_id: '123', bot_token: '123:AAtoken', status: 'CONNECTED' };
  let calls: Array<{ url: string; body: unknown }>;
  let service: TelegramService;

  beforeEach(() => {
    calls = [];
    process.env.TELEGRAM_API_BASE_URL = 'http://tg.test';
    (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 55 } }) } as Response;
    });
    service = new TelegramService({ query: jest.fn(async () => [row]) } as never, {} as never, {} as never, {} as never);
  });

  it('sends an https photo link by its address – the server itself never fetches it', async () => {
    const id = await service.sendFile({ companyId: 7, botId: '123', chatId: '900' }, { url: 'https://shop.example/p/dress.jpg', caption: 'Dress' });
    expect(id).toBe('900:55');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://tg.test/bot123:AAtoken/sendPhoto');
    expect(calls[0].body).toEqual(expect.objectContaining({ chat_id: '900', photo: 'https://shop.example/p/dress.jpg', caption: 'Dress' }));
  });

  it('an internal / plain http address is only sent as text', async () => {
    await service.sendFile({ companyId: 7, botId: '123', chatId: '900' }, { url: 'http://169.254.169.254/latest/meta-data/' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://tg.test/bot123:AAtoken/sendMessage');
    expect(calls[0].body).toEqual(expect.objectContaining({ text: 'http://169.254.169.254/latest/meta-data/' }));
  });

  it('splits long text by characters, never inside an emoji', async () => {
    await service.sendText({ companyId: 7, botId: '123', chatId: '900' }, `${'a'.repeat(4095)}😀b`);
    expect(calls).toHaveLength(2);
    expect((calls[0].body as { text: string }).text.endsWith('😀')).toBe(true);
    expect((calls[1].body as { text: string }).text).toBe('b');
  });
});
