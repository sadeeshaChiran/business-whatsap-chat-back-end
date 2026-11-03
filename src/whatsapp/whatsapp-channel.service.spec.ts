import { WhatsappChannelService } from './whatsapp-channel.service';

/** Which number answers a customer when a company has several WhatsApp numbers. */
describe('WhatsappChannelService.getForCustomer', () => {
  const main = { id: 1, company_id: 7, is_primary: true };
  const wholesale = { id: 2, company_id: 7, is_primary: false };
  const make = (customerChannel: number | null) => {
    const repo = {
      query: jest.fn(async () => (customerChannel ? [{ id: customerChannel }] : [])),
      findOne: jest.fn(async ({ where }: { where: { id?: number; company_id: number } }) =>
        where.id ? [main, wholesale].find((c) => c.id === where.id && c.company_id === where.company_id) ?? null : main),
    };
    return { service: new WhatsappChannelService(repo as never, {} as never), repo };
  };

  it('answers from the number the customer wrote to', async () => {
    const { service, repo } = make(2);
    expect(await service.getForCustomer(7, '+94 77 123 4567')).toBe(wholesale);
    expect(repo.query.mock.calls[0][1]).toEqual([7, '94771234567']);
  });

  it('falls back to the main number for new customers and without a phone', async () => {
    expect(await make(null).service.getForCustomer(7, '94771234567')).toBe(main);
    expect(await make(2).service.getForCustomer(7, '')).toBe(main);
  });

  it('never uses another company\'s number', async () => {
    const { service } = make(2);
    expect(await service.getForCustomer(8, '94771234567')).toBe(main);
  });
});
