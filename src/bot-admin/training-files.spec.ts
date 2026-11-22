import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.CHAT_MEDIA_DIR = mkdtempSync(join(tmpdir(), 'kfiles-'));

import {
  cleanTrainingFiles, fileLinesForBot, readTrainingFile, saveTrainingFile, sniffTrainingFile, takeFileCodes,
} from './training-files';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 2)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64, 3)]);

describe('AI knowledge files', () => {
  it('knows photos, PDFs and MP4 videos by their bytes and refuses anything else', () => {
    expect(sniffTrainingFile(png)?.kind).toBe('image');
    expect(sniffTrainingFile(pdf)).toEqual({ mime: 'application/pdf', kind: 'document' });
    expect(sniffTrainingFile(mp4)).toEqual({ mime: 'video/mp4', kind: 'video' });
    expect(sniffTrainingFile(Buffer.from('<script>alert(1)</script>'))).toBeNull();
    expect(() => saveTrainingFile(37, { buffer: Buffer.from('MZ fake exe'), originalname: 'x.exe' })).toThrow();
  });

  it('saves a file with a public link and reads it back from disk', () => {
    const saved = saveTrainingFile(37, { buffer: png, originalname: 'Colour card.png' });
    expect(saved.kind).toBe('image');
    expect(saved.name).toBe('Colour card');
    expect(saved.url).toMatch(/\/public\/knowledge-files\/37-[a-z0-9]+\.png$/);
    expect(readTrainingFile(saved.url)?.buffer.equals(png)).toBe(true);
    expect(readTrainingFile('https://evil.example/x.png')).toBeNull();
  });

  it('keeps only this shop\'s own files (no other links, no other shop\'s files, at most 5)', () => {
    const mine = saveTrainingFile(37, { buffer: pdf, originalname: 'Price list.pdf' });
    const other = saveTrainingFile(12, { buffer: pdf, originalname: 'Other shop.pdf' });
    const cleaned = cleanTrainingFiles(37, [mine, other, { url: 'https://evil.example/a.pdf', name: 'a' }, mine]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toMatchObject({ kind: 'document', mime: 'application/pdf', name: 'Price list' });
    const many = Array.from({ length: 8 }, (_, i) => saveTrainingFile(37, { buffer: png, originalname: `p${i}.png` }));
    expect(cleanTrainingFiles(37, many)).toHaveLength(5);
    expect(cleanTrainingFiles(37, 'nope')).toEqual([]);
  });

  it('tells the bot each file and its code', () => {
    const line = fileLinesForBot(55, [
      { url: 'u1', kind: 'image', name: 'Colour card', mime: 'image/png', size: 1 },
      { url: 'u2', kind: 'document', name: 'Size guide', mime: 'application/pdf', size: 1 },
    ]);
    expect(line).toContain('[[file:55-1]] = "Colour card" (photo)');
    expect(line).toContain('[[file:55-2]] = "Size guide" (PDF)');
    expect(fileLinesForBot(55, [])).toBe('');
    expect(fileLinesForBot(55, null)).toBe('');
  });

  it('takes the codes out of a reply (each once) and leaves clean text', () => {
    const got = takeFileCodes('මිස්, ඔබ කැමති ඕනෑම ඩිසයින් එකක් වර්ණ 7න්ම ලබාගත හැකියි. ❤️ [[file:55-1]]\n\n[[ FILE : 55 - 1 ]] ඔබ කැමති වර්ණය තෝරන්න 😊 [[file:9-2]]');
    expect(got.codes).toEqual([{ trainingId: 55, n: 1 }, { trainingId: 9, n: 2 }]);
    expect(got.text).not.toContain('[[');
    expect(got.text).toBe('මිස්, ඔබ කැමති ඕනෑම ඩිසයින් එකක් වර්ණ 7න්ම ලබාගත හැකියි. ❤️\n\nඔබ කැමති වර්ණය තෝරන්න 😊');
    expect(takeFileCodes(null)).toEqual({ text: '', codes: [] });
    expect(takeFileCodes('no codes  here\n  kept').text).toBe('no codes  here\n  kept');
  });
});
