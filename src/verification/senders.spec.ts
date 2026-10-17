import { sendPhoneCode, sendSmsCode } from './senders';

/** Sign-up codes go by SMS through Notify.lk – no WhatsApp needed. */
describe('SMS codes (Notify.lk)', () => {
  const realFetch = global.fetch;
  const env = { ...process.env };
  afterEach(() => { global.fetch = realFetch; process.env = { ...env }; });

  it('sends the code to the number with the sender id and accepts only status "success"', async () => {
    process.env.NOTIFYLK_USER_ID = 'u1'; process.env.NOTIFYLK_API_KEY = 'k1'; process.env.NOTIFYLK_SENDER_ID = 'MetroCode';
    const calls: string[] = [];
    global.fetch = jest.fn(async (url: string) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ status: 'success', data: 'Sent' }) }; }) as never;
    expect(await sendSmsCode('94771234567', '123456')).toBe(true);
    const url = new URL(calls[0]);
    expect(url.origin + url.pathname).toBe('https://app.notify.lk/api/v1/send');
    expect(url.searchParams.get('to')).toBe('94771234567');
    expect(url.searchParams.get('sender_id')).toBe('MetroCode');
    expect(url.searchParams.get('message')).toMatch(/^123456 is your .+ code/);
    expect(await sendPhoneCode('94771234567', '123456')).toBe('sms');
  });

  it('an error answer (wrong key, no credit) is a failure, not a sent code', async () => {
    process.env.NOTIFYLK_USER_ID = 'u1'; process.env.NOTIFYLK_API_KEY = 'bad'; process.env.OTP_DEV_MODE = 'false';
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'error', message: 'Invalid API key' }) })) as never;
    expect(await sendSmsCode('94771234567', '123456')).toBe(false);
    expect(await sendPhoneCode('94771234567', '123456')).toBeNull();
  });

  it('without Notify.lk keys nothing is sent (dev mode only logs the code)', async () => {
    delete process.env.NOTIFYLK_USER_ID; delete process.env.NOTIFYLK_API_KEY;
    global.fetch = jest.fn() as never;
    process.env.OTP_DEV_MODE = 'false';
    expect(await sendPhoneCode('94771234567', '123456')).toBeNull();
    process.env.OTP_DEV_MODE = 'true'; process.env.NODE_ENV = 'test';
    expect(await sendPhoneCode('94771234567', '123456')).toBe('dev');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
