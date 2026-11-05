import { WhatsappConnectService } from './whatsapp-connect.service';

function service(numbers: Array<{ waba_id: string; phone_number_id: string; fresh: boolean; onboarded_at: number }>, otherIds: string[]) {
  const graph = { listSharedWhatsappNumbers: jest.fn().mockResolvedValue(numbers) };
  const repo = { manager: { query: jest.fn().mockResolvedValue(otherIds.map((id) => ({ id }))) } };
  const s = new WhatsappConnectService(graph as never, {} as never, {} as never, repo as never);
  return (exclude: string[] = []) => (s as unknown as { pickSharedNumber: (c: number, t: string, e: string[]) => Promise<unknown> }).pickSharedNumber(36, 'tok', exclude);
}

describe('pickSharedNumber', () => {
  const now = Date.now();
  it('takes the number chosen in the Meta window just now, also when another workspace has it', async () => {
    const pick = service([
      { waba_id: 'W', phone_number_id: 'DEMO', fresh: false, onboarded_at: now - 3_600_000 },
      { waba_id: 'W', phone_number_id: 'VORA', fresh: false, onboarded_at: now - 60_000 },
    ], ['VORA']);
    await expect(pick()).resolves.toEqual({ waba_id: 'W', phone_number_id: 'VORA' });
  });
  it('without a recent choice never takes another workspace\'s number when a free one is there', async () => {
    const pick = service([
      { waba_id: 'W', phone_number_id: 'VORA', fresh: false, onboarded_at: 0 },
      { waba_id: 'W', phone_number_id: 'DEMO', fresh: false, onboarded_at: 0 },
    ], ['VORA']);
    await expect(pick()).resolves.toEqual({ waba_id: 'W', phone_number_id: 'DEMO' });
  });
  it('a single number of another workspace moves; several do not', async () => {
    await expect(service([{ waba_id: 'W', phone_number_id: 'X', fresh: false, onboarded_at: 0 }], ['X'])()).resolves.toEqual({ waba_id: 'W', phone_number_id: 'X' });
    await expect(service([
      { waba_id: 'W', phone_number_id: 'X', fresh: false, onboarded_at: 0 },
      { waba_id: 'W', phone_number_id: 'Y', fresh: false, onboarded_at: 0 },
    ], ['X', 'Y'])()).resolves.toBeNull();
  });
});
