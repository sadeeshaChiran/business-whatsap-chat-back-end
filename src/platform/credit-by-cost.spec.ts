import { PlanService } from './plan.service';

const plan = (value: Record<string, unknown> | null) =>
  new PlanService({ manager: { query: async () => (value ? [{ value }] : []) } } as never);

describe('credits charged by the real AI cost (same value for every company)', () => {
  const on = { tokens_per_credit: 15000, tokens_per_reply: 18000, cap_per_reply: true, charge_by_cost: true, weighted_tokens_per_credit: 8800 };

  it('is off by default – nothing changes until the super admin switches it on', async () => {
    const service = plan({ tokens_per_credit: 15000 });
    expect((await service.costCharging()).on).toBe(false);
    expect(await service.chargedTokens({ input_tokens: 20000, output_tokens: 300, cost_usd: 0.01 })).toBe(15000);
  });

  it('1 credit = 8,800 weighted tokens = US$ 0.0044 of AI cost, whatever the company', async () => {
    const service = plan(on);
    // a reply that cost exactly 1 credit of AI money is charged exactly 1 credit (15,000 credit units)
    expect(await service.chargedTokens({ input_tokens: 99999, output_tokens: 1, cost_usd: 0.0044 })).toBe(15000);
    // a cheap "ok" reply (US$ 0.0011) = 0.25 credit, an expensive order reply (US$ 0.011) = 2.5 credits – no cap
    expect(await service.chargedTokens({ input_tokens: 8000, output_tokens: 50, cost_usd: 0.0011 })).toBe(3750);
    expect(await service.chargedTokens({ input_tokens: 20000, output_tokens: 150, cost_usd: 0.011 })).toBe(37500);
  });

  it('the same rule in SQL for the monthly credit count', async () => {
    const sql = await plan(on).chargedTokensSql('u');
    expect(sql).toBe(`ROUND(COALESCE(u.cost_usd, 0) * ${(2_000_000 * 15000) / 8800})`);
    expect(await plan(on).tokensPerReply()).toBe(15000);
  });
});
