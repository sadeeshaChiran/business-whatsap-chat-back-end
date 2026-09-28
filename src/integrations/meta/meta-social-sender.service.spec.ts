import { MetaSocialSenderService, socialPlatformOf } from './meta-social-sender.service';

describe('socialPlatformOf', () => {
  it('maps platform names', () => {
    expect(socialPlatformOf('instagram')).toBe('instagram');
    expect(socialPlatformOf('messenger')).toBe('messenger');
    expect(socialPlatformOf('Facebook')).toBe('messenger');
    expect(socialPlatformOf('whatsapp')).toBeNull();
    expect(socialPlatformOf(null)).toBeNull();
  });
});

describe('MetaSocialSenderService', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  const repo = (row: unknown) => ({ findOne: jest.fn().mockResolvedValue(row) });
  const connection = { page_id: 'PAGE1', instagram_business_account_id: 'IG1', page_access_token: 'tok' };

  it('sends Messenger text from the Page id', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'm.1' }) });
    global.fetch = fetchMock as never;
    const svc = new MetaSocialSenderService(repo(connection) as never);
    await expect(svc.sendText(7, 'messenger', 'PAGE1', 'USER9', 'hello')).resolves.toBe('m.1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/PAGE1/messages');
    expect(JSON.parse(init.body)).toEqual({ recipient: { id: 'USER9' }, message: { text: 'hello' }, messaging_type: 'RESPONSE' });
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('sends Instagram text from the Instagram account id', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'm.2' }) });
    global.fetch = fetchMock as never;
    const svc = new MetaSocialSenderService(repo(connection) as never);
    await svc.sendText(7, 'instagram', 'IG1', 'USER9', 'hi');
    expect(fetchMock.mock.calls[0][0]).toContain('/IG1/messages');
  });

  it('cuts text over the 2000-character limit', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'm.3' }) });
    global.fetch = fetchMock as never;
    const svc = new MetaSocialSenderService(repo(connection) as never);
    await svc.sendText(7, 'messenger', 'PAGE1', 'U', 'x'.repeat(5000));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message.text.length).toBeLessThanOrEqual(1901);
  });

  it('uploads the picture on Messenger but sends a link on Instagram', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'm.4' }) });
    global.fetch = fetchMock as never;
    const svc = new MetaSocialSenderService(repo(connection) as never);
    await svc.sendImage(7, 'messenger', 'PAGE1', 'U', { url: 'https://x/y.jpg', buffer: Buffer.from('img'), mimetype: 'image/jpeg' });
    expect(fetchMock.mock.calls[0][1].body).toBeInstanceOf(FormData);
    await svc.sendImage(7, 'instagram', 'IG1', 'U', { url: 'https://x/y.jpg' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).message.attachment.payload.url).toBe('https://x/y.jpg');
  });

  it('throws Meta\'s error message and fails clearly with no connection', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'outside 24h window' } }) }) as never;
    await expect(new MetaSocialSenderService(repo(connection) as never).sendText(7, 'messenger', 'PAGE1', 'U', 'a')).rejects.toThrow('outside 24h window');
    await expect(new MetaSocialSenderService(repo(null) as never).sendText(7, 'messenger', 'PAGE1', 'U', 'a')).rejects.toThrow('no connected Meta Page');
    await expect(new MetaSocialSenderService(repo(connection) as never).sendText(7, 'messenger', null, 'U', 'a')).rejects.toThrow('not linked');
  });
});
