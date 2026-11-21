import { SalesBotEngineService } from './sales-bot-engine.service';

/** Setting "switch the bot back on by itself" (bot_auto_on_hours). */
function build(rows: any[]) {
  const query = jest.fn().mockResolvedValue(rows);
  const update = jest.fn().mockResolvedValue(undefined);
  const args: any[] = Array.from({ length: 25 }, () => ({}));
  args[1] = { query }; // conversations
  args[2] = { update }; // channel users
  const engine = new (SalesBotEngineService as any)(...args) as SalesBotEngineService;
  const schedule = jest.spyOn(engine as any, 'schedule').mockImplementation(() => undefined);
  return { engine, query, update, schedule };
}

describe('bot back on after no reply', () => {
  const now = new Date('2026-11-22T10:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

  it('under 24 hours: switches the bot on and answers the waiting message', async () => {
    const t = build([{ conversation_id: 101, channel_user_id: 11, company_id: 7, hours: 5, last_in: hoursAgo(5.1) }]);
    expect(await t.engine.runBotBackOn(now)).toEqual([101]);
    expect(t.update).toHaveBeenCalledWith(11, { bot_enabled: true, manual_mode: false });
    expect(t.schedule).toHaveBeenCalledWith(7, 101, 500, true);
    expect(t.query.mock.calls[0][1]).toEqual([now.toISOString()]);
  });

  it('24 hours or more: switches the bot on, no reply (WhatsApp / Messenger window closed)', async () => {
    const t = build([{ conversation_id: 102, channel_user_id: 12, company_id: 7, hours: 24, last_in: hoursAgo(24.05) }]);
    await t.engine.runBotBackOn(now);
    expect(t.update).toHaveBeenCalledWith(12, { bot_enabled: true, manual_mode: false });
    expect(t.schedule).not.toHaveBeenCalled();
  });

  it('nothing waiting: nothing changes', async () => {
    const t = build([]);
    expect(await t.engine.runBotBackOn(now)).toEqual([]);
    expect(t.update).not.toHaveBeenCalled();
  });
});
