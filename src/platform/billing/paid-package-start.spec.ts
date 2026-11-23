import { BillingService } from './billing.service';

const DAY = 86_400_000;

function run(sub: Record<string, unknown>, paidBefore: boolean) {
  const saved: Record<string, unknown>[] = [];
  const self: any = {
    paymentRepository: { save: jest.fn(async (x: unknown) => x) },
    packageRepository: { findOne: jest.fn(async () => ({ id: 5, code: 'pro' })) },
    quota: { ensure: jest.fn(async () => sub), forget: jest.fn() },
    dataSource: { query: jest.fn(async (sql: string) => (sql.includes('FROM platform_payment') ? (paidBefore ? [{ '?column?': 1 }] : []) : [])) },
    subscriptionRepository: { save: jest.fn(async (x: Record<string, unknown>) => { saved.push({ ...x }); return x; }) },
    companyRepository: { update: jest.fn() },
    planService: { forgetCompany: jest.fn() },
    createInvoice: jest.fn(async () => undefined),
    notify: jest.fn(async () => undefined),
    cancelPaypalSubscription: jest.fn(async () => ({ ok: true })),
    logger: { warn: jest.fn() },
  };
  const payment: any = { id: 18, company_id: 16, kind: 'subscription', package_id: 5, billing_cycle: 'monthly', amount: '25000', method: 'bank_transfer', auto_renew: false, description: 'Pro' };
  return (BillingService.prototype as any).markPaid.call(self, payment, null, 1).then(() => saved[0]);
}

describe('a paid package starts at once when the current time was free', () => {
  const now = Date.now();
  const old = () => ({
    package_id: 5, status: 'active', is_trial: false,
    period_start: new Date(now - 17 * DAY), period_end: new Date(now + 14 * DAY),
    token_period_start: new Date(now - 5 * DAY), token_period_end: new Date(now + 25 * DAY),
  });

  it('super admin gave Pro free → paying Pro starts now, fresh credit month', async () => {
    const s = await run(old(), false);
    expect(Math.abs(new Date(s.period_start as Date).getTime() - now)).toBeLessThan(60_000);
    expect(new Date(s.period_end as Date).getTime()).toBeLessThan(now + 32 * DAY);
    expect(Math.abs(new Date(s.token_period_start as Date).getTime() - now)).toBeLessThan(60_000);
  });

  it('free trial of Pro → paying Pro ends the trial now, fresh credit month', async () => {
    const s = await run({ ...old(), is_trial: true, fallback_package_id: 1 }, true);
    expect(s.is_trial).toBe(false);
    expect(Math.abs(new Date(s.period_start as Date).getTime() - now)).toBeLessThan(60_000);
    expect(Math.abs(new Date(s.token_period_start as Date).getTime() - now)).toBeLessThan(60_000);
  });

  it('Pro already PAID → an early renewal still adds the month after the current one (credits unchanged)', async () => {
    const before = old();
    const s = await run(before, true);
    expect(new Date(s.period_end as Date).getTime()).toBeGreaterThan(now + 40 * DAY);
    expect(s.token_period_start).toEqual(before.token_period_start);
  });
});
