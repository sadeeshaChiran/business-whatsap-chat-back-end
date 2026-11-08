import { createHmac } from 'crypto';
import { OpenApiKeysService, OpenApiWebhookService, signWebhook } from './open-api';

function fakeDb(handler: (sql: string, params: any[]) => any[] | Promise<any[]>) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return { calls, db: { query: async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return handler(sql, params); } } as any };
}

describe('Shop API keys', () => {
  it('a new key is shown once, only its hash is stored, and it opens the company as its owner', async () => {
    let stored: any = null;
    const { db } = fakeDb((sql, params) => {
      if (sql.includes('count(*)')) return [{ count: 0 }];
      if (sql.startsWith('INSERT INTO company_api_key')) { stored = { hash: params[4] }; return [{ id: 1, name: params[2], prefix: params[3] }]; }
      if (sql.includes('FROM company_api_key k')) return params[0] === stored.hash ? [{ id: 1, company_id: 16, admin_user_id: 7, name: 'Owner', email: 'o@x' }] : [];
      return [];
    });
    const keys = new OpenApiKeysService(db);
    const created = await keys.create(16, 7, 'POS');
    expect(created.key).toMatch(/^am_live_/);
    expect(stored.hash).not.toContain(created.key);
    const actor = await keys.verify(created.key);
    expect(actor).toMatchObject({ companyId: 16, user: { id: 7, role: 'admin', company_id: 16 } });
    await expect(keys.verify('am_live_wrongwrongwrongwrongwrong')).rejects.toThrow('Invalid API key');
  });
});

describe('Shop webhooks', () => {
  it('signature = hmac_sha256(secret, "<t>.<body>")', () => {
    const sig = signWebhook('whsec_x', '{"a":1}', 1700000000);
    expect(sig).toBe(`t=1700000000,v1=${createHmac('sha256', 'whsec_x').update('1700000000.{"a":1}').digest('hex')}`);
  });

  it('a new order goes out as order.created, a status change as order.status_changed; a failure is tried again later', async () => {
    const sent: string[] = [];
    let fail = false;
    const realFetch = global.fetch;
    (global as any).fetch = async (_url: string, init: any) => { sent.push(JSON.parse(init.body).event); return { ok: !fail, status: fail ? 500 : 200, text: async () => '' }; };
    const due = [{ id: 5, status: 'Pending', sent_status: null, attempts: 0 }, { id: 6, status: 'Shipped', sent_status: 'Confirmed', attempts: 0 }];
    const { db, calls } = fakeDb((sql) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('FROM company_webhook') && sql.includes('WHERE enabled')) return [{ company_id: 16, url: 'https://shop.lk/hook', secret: 's', events: ['order.created', 'order.status_changed'], enabled: true, enabled_since: '2026-11-06' }];
      if (sql.includes('FROM bot_order x')) return due.splice(0);
      return [];
    });
    const views: any = { orders: async (_: number, ids: number[]) => ids.map((id) => ({ id })), bookings: async () => [] };
    const hooks = new OpenApiWebhookService(db, views);
    await hooks.tick();
    expect(sent).toEqual(['order.created', 'order.status_changed']);
    expect(calls.filter((c) => c.sql.includes('INSERT INTO open_api_sent') && c.params[3] != null).map((c) => c.params[3])).toEqual(['Pending', 'Shipped']);

    fail = true;
    due.push({ id: 7, status: 'Pending', sent_status: null, attempts: 0 });
    await hooks.tick();
    const retry = calls.find((c) => c.sql.includes('make_interval'));
    expect(retry?.params.slice(2)).toEqual([7, 1, 1]);   // order 7, attempt 1, again in 1 min
    (global as any).fetch = realFetch;
  });
});
