import webpush from 'web-push';
import { WebPushService } from './web-push';

jest.mock('web-push', () => ({ __esModule: true, default: { sendNotification: jest.fn(), generateVAPIDKeys: jest.fn(() => ({ publicKey: 'pub', privateKey: 'priv' })) } }));

/** Phone / desktop notifications: who gets what, and dead browsers are removed. */
describe('WebPushService.sendToUsers', () => {
  const subs = [
    { id: 1, endpoint: 'https://push.example/owner', p256dh: 'k1', auth: 'a1', mode: 'all' },
    { id: 2, endpoint: 'https://push.example/owner-quiet', p256dh: 'k2', auth: 'a2', mode: 'attention' },
    { id: 3, endpoint: 'https://push.example/gone', p256dh: 'k3', auth: 'a3', mode: 'all' },
  ];
  let queries: Array<[string, unknown[]]>;
  const service = () => new WebPushService({
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      queries.push([sql, params]);
      if (sql.includes('FROM web_push_subscription WHERE user_id = ANY')) return subs;
      if (sql.includes("key = 'web_push_vapid'")) return [{ value: { publicKey: 'pub', privateKey: 'priv' } }];
      return [];
    }),
  } as never);
  const send = webpush.sendNotification as jest.Mock;

  beforeEach(() => {
    queries = [];
    send.mockReset();
    send.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith('/gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      return { statusCode: 201 };
    });
  });

  it('a new message reaches "all" browsers; "only chats that need a person" browsers only when a person is needed', async () => {
    const sent = await service().sendToUsers([7], { title: 'Kasuni · WhatsApp', body: 'Price kiyada?', url: '/inbox/5', kind: 'message', needsPerson: false });
    expect(sent).toBe(1);
    expect(send.mock.calls.map((c) => c[0].endpoint)).toEqual(['https://push.example/owner', 'https://push.example/gone']);
    const payload = JSON.parse(send.mock.calls[0][1]);
    expect(payload).toEqual({ title: 'Kasuni · WhatsApp', body: 'Price kiyada?', url: '/inbox/5', tag: '/inbox/5' });
    expect(send.mock.calls[0][2]).toEqual(expect.objectContaining({ urgency: 'high', vapidDetails: expect.objectContaining({ publicKey: 'pub' }) }));
  });

  it('chats that need a person and alerts go to every browser', async () => {
    expect(await service().sendToUsers([7], { title: 'x', body: 'y', url: '/inbox/5', kind: 'message', needsPerson: true })).toBe(2);
    expect(await service().sendToUsers([7], { title: 'New order', body: 'Rs 4,000', url: '/orders', kind: 'alert' })).toBe(2);
  });

  it('a browser that unsubscribed (410) is removed', async () => {
    await service().sendToUsers([7], { title: 'x', body: 'y', url: '/', kind: 'alert' });
    expect(queries.some(([sql, params]) => sql.startsWith('DELETE FROM web_push_subscription') && params[0] === 3)).toBe(true);
  });

  it('nobody to notify → nothing sent', async () => {
    expect(await service().sendToUsers([], { title: 'x', body: 'y', url: '/', kind: 'alert' })).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
