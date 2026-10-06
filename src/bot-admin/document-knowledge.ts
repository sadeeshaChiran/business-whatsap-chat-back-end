import { BadRequestException } from '@nestjs/common';

/**
 * Turns an uploaded business document (PDF, Word .docx, text) into knowledge entries for the sales bot.
 * No AI call – the text is read here and cut into pieces the bot reads directly from the database,
 * so importing a document costs nothing.
 *
 * Every piece is at most PIECE_CHARS long (the bot reads up to 1 500 characters per entry) and a document
 * gives at most MAX_PIECES pieces, so one big file cannot blow up the bot's prompt (and the AI cost).
 */
export const PIECE_CHARS = 1400;
export const MAX_PIECES = 15;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

type UploadedFile = { originalname: string; mimetype?: string; buffer: Buffer; size?: number };

export async function readDocumentText(file: UploadedFile): Promise<string> {
  if (!file?.buffer?.length) throw new BadRequestException('Please choose a file.');
  if (file.buffer.length > MAX_DOCUMENT_BYTES) throw new BadRequestException('The file is larger than 10 MB.');
  const name = file.originalname.toLowerCase();
  let text = '';
  if (name.endsWith('.pdf') || file.mimetype === 'application/pdf') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PDFParse } = require('pdf-parse') as { PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }>; destroy(): Promise<void> } };
    const parser = new PDFParse({ data: file.buffer });
    try {
      text = (await parser.getText()).text.replace(/^-- \d+ of \d+ --$/gm, '');
    } catch {
      text = '';
    } finally {
      await parser.destroy().catch(() => undefined);
    }
    if (!text.trim()) throw new BadRequestException('No text found in this PDF. Scanned PDFs (photos of pages) cannot be read – please upload a text PDF or Word file.');
  } else if (name.endsWith('.docx')) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mammoth = require('mammoth') as { extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }> };
    text = (await mammoth.extractRawText({ buffer: file.buffer }).catch(() => ({ value: '' }))).value;
  } else if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv') || (file.mimetype ?? '').startsWith('text/')) {
    text = file.buffer.toString('utf8');
  } else {
    throw new BadRequestException('Please upload a PDF, Word (.docx) or text (.txt) file.');
  }
  text = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  if (!text) throw new BadRequestException('The file has no readable text.');
  return text;
}

/** Splits text into pieces on paragraph / sentence borders. */
export function splitIntoPieces(text: string, size = PIECE_CHARS, max = MAX_PIECES): { pieces: string[]; truncated: boolean } {
  const pieces: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) pieces.push(current.trim());
    current = '';
  };
  const units = text.split(/\n\n+/).flatMap((para) => (para.length <= size ? [para] : para.split(/(?<=[.!?])\s+/)));
  for (const unit of units) {
    const part = unit.length > size ? unit.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [] : [unit];
    for (const p of part) {
      if ((current + '\n\n' + p).length > size) push();
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  push();
  return { pieces: pieces.slice(0, max), truncated: pieces.length > max };
}
