import { PlanService } from './plan.service';

const plan = (value: Record<string, unknown> | null) =>
  new PlanService({ manager: { query: async () => (value ? [{ value }] : []) } } as never);

describe('1 AI reply = at most 1 credit', () => {
  it('caps each reply at one credit by default, and N credits show as N replies', async () => {
    const service = plan({ tokens_per_credit: 15000, tokens_per_reply: 18000 });
    expect(await service.capPerReply()).toBe(true);
    expect(await service.chargedTokensSql('u')).toBe('LEAST((u.input_tokens + u.output_tokens), 15000)');
    expect(await service.tokensPerReply()).toBe(15000);
    expect(await service.savedTokensPerReply()).toBe(18000);
  });

  it('charges real tokens when the cap is switched off', async () => {
    const service = plan({ tokens_per_credit: 15000, tokens_per_reply: 18000, cap_per_reply: false });
    expect(await service.chargedTokensSql()).toBe('(input_tokens + output_tokens)');
    expect(await service.tokensPerReply()).toBe(18000);
  });
});
