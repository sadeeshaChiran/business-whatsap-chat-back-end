import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.CHAT_MEDIA_DIR = mkdtempSync(join(tmpdir(), 'kfsend-'));

import { saveTrainingFile } from '../bot-admin/training-files';
import { SalesBotEngineService } from './sales-bot-engine.service';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32, 2)]);

function engine(rows: unknown[], recentUrls: string[] = []) {
  const saved: any[] = [];
  const sendMedia = jest.fn().mockResolvedValue({ messageId: 'wamid.DOC' });
  const self: any = {
    logger: { warn: jest.fn() },
    messageRepository: {
      query: jest.fn(async (sql: string, params: any[]) => {
        if (sql.includes('FROM bot_training_data')) return rows;
        return recentUrls.includes(params[1]) ? [{ '?column?': 1 }] : [];
      }),
      create: (x: unknown) => x,
      save: jest.fn(async (x: unknown) => { saved.push(x); return x; }),
    },
    deliverImage: jest.fn().mockResolvedValue({ messageId: 'wamid.IMG', failed: false }),
    providerFactory: { getAdapterForChannel: () => ({ sendMedia }) },
    socialSender: { sendFile: jest.fn().mockResolvedValue('mid.1') },
    touch: jest.fn(),
  };
  const send = (codes: Array<{ trainingId: number; n: number }>, platform = 'whatsapp', simulated = false) =>
    (SalesBotEngineService.prototype as any).sendKnowledgeFiles.call(self, 37, { id: 9 },
      { platform, external_user_id: '9477', source_account_id: 'p1' }, { id: 1 }, simulated, codes);
  return { self, saved, sendMedia, send };
}

describe('sending files from the AI knowledge', () => {
  const card = saveTrainingFile(37, { buffer: png, originalname: 'Colour card.png' });
  const guide = saveTrainingFile(37, { buffer: pdf, originalname: 'Size guide.pdf' });
  const rows = [{ id: 55, question: 'Colour card', files: [card, guide] }];

  it('sends the photo like a product photo and the PDF as a document on WhatsApp', async () => {
    const t = engine(rows);
    expect(await t.send([{ trainingId: 55, n: 1 }, { trainingId: 55, n: 2 }])).toBe(2);
    expect(t.self.deliverImage).toHaveBeenCalledTimes(1);
    expect(t.sendMedia).toHaveBeenCalledWith({ id: 1 }, '9477', expect.objectContaining({ mediaType: 'document', mimetype: 'application/pdf', fileName: 'Size guide.pdf' }));
    expect(t.saved.map((m) => m.message_type)).toEqual(['image', 'text']);
    expect(t.saved[1].media_url).toBe(guide.url);
  });

  it('only this shop\'s active entries – the query is limited to the company', async () => {
    const t = engine([]);
    expect(await t.send([{ trainingId: 55, n: 1 }])).toBe(0);
    expect(t.self.messageRepository.query.mock.calls[0][1]).toEqual([37, [55]]);
  });

  it('skips a file number that does not exist and a file already sent to this chat in the last 3 hours', async () => {
    const t = engine(rows, [card.url]);
    expect(await t.send([{ trainingId: 55, n: 1 }, { trainingId: 55, n: 7 }])).toBe(0);
    expect(t.self.deliverImage).not.toHaveBeenCalled();
  });

  it('Messenger / Instagram get the PDF through the social sender', async () => {
    const t = engine(rows);
    expect(await t.send([{ trainingId: 55, n: 2 }], 'instagram')).toBe(1);
    expect(t.self.socialSender.sendFile).toHaveBeenCalled();
    expect(t.sendMedia).not.toHaveBeenCalled();
  });

  it('the simulator sends nothing but keeps a note', async () => {
    const t = engine(rows);
    expect(await t.send([{ trainingId: 55, n: 2 }], 'whatsapp', true)).toBe(1);
    expect(t.sendMedia).not.toHaveBeenCalled();
    expect(t.saved).toHaveLength(1);
  });
});
