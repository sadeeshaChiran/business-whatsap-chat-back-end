import { TokenQuotaService } from './token-quota.service';

const T = 15_000; // tokens per credit
function service(rows: { packs: number; lastEnd: string | null; grants?: number; used: number }, pkgTokens = 14_000 * T, extra: Record<string, unknown> = {}) {
  const inserts: unknown[][] = [];
  const self: any = {
    logger: { warn: jest.fn() },
    planService: { chargedTokensSql: jest.fn(async () => 'LEAST(input_tokens + output_tokens, 15000)') },
    packageRepository: { findOne: jest.fn(async () => ({ id: 5, tokens_per_month: pkgTokens, bot_days: null })) },
    dataSource: {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.startsWith('INSERT')) { inserts.push(params); return []; }
        if (sql.includes('MAX(expires_at)')) return [{ net: rows.packs, last_end: rows.lastEnd }];
        if (sql.includes('expires_at IS NULL')) return [{ t: rows.grants ?? 0 }];
        if (sql.includes('bot_ai_usage')) return [{ used: rows.used }];
        return [];
      }),
    },
    ...extra,
  };
  const sub: any = { company_id: 16, package_id: 5, token_period_start: new Date('2026-11-05T03:45:00Z'), bot_free_until: null };
  return { run: () => (TokenQuotaService.prototype as any).settlePacks.call(self, sub, new Date('2026-11-26T19:57:28Z')), inserts };
}

describe('bought credit packs are not counted again in the next credit month', () => {
  it('Chu.lk: Pro 14,000 + pack 1,500 all used → the pack is written off (-1,500)', async () => {
    const s = service({ packs: 1_500 * T, lastEnd: '2026-12-23T21:39:25Z', used: 15_500 * T });
    await s.run();
    expect(s.inserts).toHaveLength(1);
    expect(s.inserts[0][1]).toBe(-1_500 * T);
    expect(s.inserts[0][3]).toBe('2026-12-23T21:39:25Z');
  });

  it('only part of the pack used → only that part is written off', async () => {
    const s = service({ packs: 1_500 * T, lastEnd: '2026-12-23T21:39:25Z', used: 14_600 * T });
    await s.run();
    expect(s.inserts[0][1]).toBe(-600 * T);
  });

  it('the package credits were enough → the pack stays whole', async () => {
    const s = service({ packs: 1_500 * T, lastEnd: '2026-12-23T21:39:25Z', used: 9_000 * T });
    await s.run();
    expect(s.inserts).toHaveLength(0);
  });

  it('credits the super admin gave this month are used before the pack', async () => {
    const s = service({ packs: 1_500 * T, lastEnd: '2026-12-23T21:39:25Z', grants: 500 * T, used: 15_000 * T });
    await s.run();
    expect(s.inserts[0][1]).toBe(-500 * T);
  });

  it('no pack left → nothing written', async () => {
    const s = service({ packs: 0, lastEnd: null, used: 20_000 * T });
    await s.run();
    expect(s.inserts).toHaveLength(0);
  });
});
