import { SalesBotEngineService } from './sales-bot-engine.service';

/**
 * A customer message that arrives WHILE the bot writes has a smaller id than the bot's reply.
 * The engine must still answer it: it looks at bot_answered_inbound_id, not at the bot's last message.
 */
function build(marks: Record<string, unknown>) {
  const afters: number[] = [];
  const qb: any = {
    where: () => qb, orderBy: () => qb, limit: () => qb,
    andWhere: (_sql: string, params?: { after?: number }) => { if (params?.after !== undefined) afters.push(params.after); return qb; },
    getMany: async () => [],
  };
  const conversation: any = { id: 21, status: 'open', channelUser: { id: 5, platform: 'whatsapp', bot_enabled: true } };
  const args: any[] = Array.from({ length: 24 }, () => ({}));
  args[0] = { findOne: async () => ({ id: 7, plan: 'free', bot_enabled: true }) };
  args[1] = { findOne: async () => conversation };
  args[3] = { query: async () => [marks], createQueryBuilder: () => qb };
  const engine = new (SalesBotEngineService as any)(...args);
  engine.botMayReply = async () => true;
  return { engine, afters };
}

describe('SalesBotEngineService answered marker', () => {
  it('answers customer messages newer than the last answered one, even if the bot wrote after them', async () => {
    // customer 100 answered; customer 101 came while the bot wrote reply 102
    const t = build({ answered: 100, handled: null, last_out: 102 });
    await t.engine.turn(7, 21);
    expect(t.afters).toEqual([100]);
  });

  it('a reply by a person counts as answered', async () => {
    const t = build({ answered: 100, handled: 105, last_out: 106 });
    await t.engine.turn(7, 21);
    expect(t.afters).toEqual([105]);
  });

  it('older chats without the marker use the last outbound message', async () => {
    const t = build({ answered: null, handled: 90, last_out: 95 });
    await t.engine.turn(7, 21);
    expect(t.afters).toEqual([95]);
  });
});
