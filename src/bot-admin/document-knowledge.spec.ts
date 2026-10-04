import { MAX_PIECES, PIECE_CHARS, readDocumentText, splitIntoPieces } from './document-knowledge';

describe('document knowledge', () => {
  it('splits long text into pieces the bot can read, capped in number', () => {
    const text = Array.from({ length: 600 }, (_, i) => `Paragraph ${i}. Delivery in Colombo takes two days and costs Rs 350.`).join('\n\n');
    const { pieces, truncated } = splitIntoPieces(text);
    expect(pieces.length).toBe(MAX_PIECES);
    expect(truncated).toBe(true);
    expect(pieces.every((p) => p.length <= PIECE_CHARS)).toBe(true);
  });
  it('keeps a short text as one piece', () => {
    expect(splitIntoPieces('Returns within 7 days.')).toEqual({ pieces: ['Returns within 7 days.'], truncated: false });
  });
  it('cuts one very long paragraph without losing text', () => {
    const long = 'x'.repeat(PIECE_CHARS * 2 + 10);
    expect(splitIntoPieces(long).pieces.join('')).toBe(long);
  });
  it('reads text files and refuses images', async () => {
    await expect(readDocumentText({ originalname: 'a.txt', buffer: Buffer.from('Hello\r\n\r\n\r\nWorld') })).resolves.toBe('Hello\n\nWorld');
    await expect(readDocumentText({ originalname: 'a.png', buffer: Buffer.from('x') })).rejects.toThrow('PDF, Word');
  });
});
