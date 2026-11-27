import { chatHistory, mergePhotoTurns } from './sales-bot-engine.service';

const row = (id: number, direction: string, content: string, extra: any = {}) =>
  ({ id, direction, content, source: direction === 'outbound' ? 'sales_bot' : 'customer', message_type: 'text', ...extra });
const repo = (rows: any[]) => ({
  createQueryBuilder: () => {
    const qb: any = { where: () => qb, andWhere: () => qb, orderBy: () => qb, limit: () => qb, getMany: async () => [...rows].reverse() };
    return qb;
  },
}) as any;

describe('chat history sent to the AI', () => {
  it('turns a run of photo bubbles into one line that still names every product and colour', () => {
    const turns = mergePhotoTurns([
      { role: 'customer', text: 'paata monada thiyenne?' },
      { role: 'bot', text: '[photo] 📷 Chérie Bow Oversized T-Shirt – Pink – Rs 1,590' },
      { role: 'bot', text: '[photo] 📷 Chérie Bow Oversized T-Shirt – Red – Rs 1,590' },
      { role: 'bot', text: '[photo] 📷 3d Massage Roller – Rs 495' },
      { role: 'bot', text: 'Miss kamathi paata kiyanna 😊' },
    ]);
    expect(turns).toEqual([
      { role: 'customer', text: 'paata monada thiyenne?' },
      { role: 'bot', text: '[photos sent ×3] 📷 Chérie Bow Oversized T-Shirt – Pink, Red – Rs 1,590 | 📷 3d Massage Roller – Rs 495' },
      { role: 'bot', text: 'Miss kamathi paata kiyanna 😊' },
    ]);
  });

  it('the merged line still starts with "[photo" (the bot skips it in its repeat check)', () => {
    const [turn] = mergePhotoTurns([{ role: 'bot', text: '📷 A – Rs 1' }, { role: 'bot', text: '📷 B – Rs 2' }]);
    expect(turn.text.startsWith('[photo')).toBe(true);
  });

  it('keeps a single photo as it is', () => {
    const one = [{ role: 'bot' as const, text: '[photo] 📷 Fridge Lock – Rs 395' }, { role: 'customer' as const, text: 'ok' }];
    expect(mergePhotoTurns(one)).toEqual(one);
  });

  it('keeps more real messages within the budget when the bot sent many photos', async () => {
    const rows = [row(1, 'inbound', 'Hi Full Kit eka ona')];
    for (let i = 0; i < 15; i += 1) rows.push(row(2 + i, 'outbound', `📷 Hi Full Kit – Colour ${i} – Rs 3,080`, { message_type: 'image' }));
    rows.push(row(20, 'inbound', 'Black M'));
    const history = await chatHistory(repo(rows), 1, 99);
    expect(history.map((t) => t.role)).toEqual(['customer', 'bot', 'customer']);
    expect(history[1].text).toContain('[photos sent ×15] 📷 Hi Full Kit – Colour 0, Colour 1');
  });

  it('cuts long chats to about 6,000 characters (newest kept, at least 8 messages)', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i + 1, i % 2 ? 'outbound' : 'inbound', `${i} ${'අ'.repeat(400)}`));
    const history = await chatHistory(repo(rows), 1, 99);
    const chars = history.reduce((sum, t) => sum + t.text.length, 0);
    expect(chars).toBeLessThanOrEqual(6000);
    expect(history[history.length - 1].text.startsWith('39 ')).toBe(true);
  });
});
