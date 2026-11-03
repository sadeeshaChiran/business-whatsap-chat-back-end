import { existsSync } from 'fs';
import { join } from 'path';
import PDFDocument from 'pdfkit';

/**
 * Clean, printable A4 invoice / booking PDF (pdfkit). Sinhala and Tamil names and addresses are written with
 * Noto Sans Sinhala / Tamil (assets/fonts), everything else with Noto Sans.
 */

export type InvoiceDoc = {
  title: string;                          // "INVOICE" / "BOOKING"
  number: string;                         // "#123"
  date: string;
  status?: string;
  shop: { name: string; lines: string[] };
  billTo: { label: string; lines: string[] };
  side?: { label: string; lines: string[] };
  columns: [string, string, string, string];   // Item | Qty | Unit | Amount
  rows: Array<{ name: string; detail?: string; qty: string; unit: string; amount: string }>;
  totals: Array<{ label: string; value: string }>;
  total: { label: string; value: string };
  note?: string;
  footer: string;
};

const ACCENT = '#4F46E5';
const INK = '#111827';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';
const SOFT = '#F5F5FF';

const FONT_FILES = {
  latin: 'NotoSans_400Regular.ttf', latinBold: 'NotoSans_700Bold.ttf',
  sinhala: 'NotoSansSinhala_400Regular.ttf', sinhalaBold: 'NotoSansSinhala_700Bold.ttf',
  tamil: 'NotoSansTamil_400Regular.ttf', tamilBold: 'NotoSansTamil_700Bold.ttf',
} as const;

function fontDir(): string | null {
  const candidates = [join(process.cwd(), 'assets', 'fonts'), join(__dirname, '..', '..', 'assets', 'fonts'), join(__dirname, '..', '..', '..', 'assets', 'fonts')];
  return candidates.find((dir) => existsSync(join(dir, FONT_FILES.latin))) ?? null;
}

export function renderInvoicePdf(data: InvoiceDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${data.title} ${data.number}`, Author: data.shop.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const dir = fontDir();
    if (dir) for (const [name, file] of Object.entries(FONT_FILES)) doc.registerFont(name, join(dir, file));
    // the right font for the letters in the text (Helvetica when the font files are missing)
    const font = (text: string, bold = false) => {
      if (!dir) return bold ? 'Helvetica-Bold' : 'Helvetica';
      if (/[඀-෿]/.test(text)) return bold ? 'sinhalaBold' : 'sinhala';
      if (/[஀-௿]/.test(text)) return bold ? 'tamilBold' : 'tamil';
      return bold ? 'latinBold' : 'latin';
    };
    const write = (text: string, x: number, y: number, opts: { size?: number; bold?: boolean; color?: string; width?: number; align?: 'left' | 'right' | 'center' } = {}) => {
      doc.font(font(text, opts.bold)).fontSize(opts.size ?? 10).fillColor(opts.color ?? INK)
        .text(text, x, y, { width: opts.width, align: opts.align ?? 'left', lineGap: 1 });
      return doc.y;
    };
    const heightOf = (text: string, width: number, size = 10, bold = false) =>
      doc.font(font(text, bold)).fontSize(size).heightOfString(text, { width, lineGap: 1 });

    const left = 48;
    const right = doc.page.width - 48;
    const width = right - left;

    // ── header ──
    doc.rect(0, 0, doc.page.width, 8).fill(ACCENT);
    let y = 40;
    const shopBottom = (() => {
      let sy = write(data.shop.name, left, y, { size: 18, bold: true, width: width * 0.55 });
      for (const line of data.shop.lines) sy = write(line, left, sy + 2, { size: 9, color: MUTED, width: width * 0.55 });
      return sy;
    })();
    write(data.title, left, y - 2, { size: 22, bold: true, color: ACCENT, width, align: 'right' });
    write(data.number, left, y + 28, { size: 11, bold: true, width, align: 'right' });
    write(data.date, left, y + 44, { size: 9, color: MUTED, width, align: 'right' });
    let headBottom = y + 58;
    if (data.status) {
      doc.font(font(data.status, true)).fontSize(8);
      const pill = doc.widthOfString(data.status) + 16;
      doc.roundedRect(right - pill, y + 60, pill, 16, 8).fill(SOFT);
      write(data.status, right - pill, y + 63.5, { size: 8, bold: true, color: ACCENT, width: pill, align: 'center' });
      headBottom = y + 78;
    }
    y = Math.max(shopBottom, headBottom) + 18;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(LINE).stroke();
    y += 16;

    // ── bill to / payment ──
    const block = (label: string, lines: string[], x: number, w: number) => {
      let by = write(label.toUpperCase(), x, y, { size: 8, bold: true, color: MUTED, width: w });
      lines.forEach((line, i) => { by = write(line, x, by + 3, { size: i === 0 ? 11 : 9.5, bold: i === 0, color: i === 0 ? INK : '#374151', width: w }); });
      return by;
    };
    const colW = width / 2 - 12;
    const billBottom = block(data.billTo.label, data.billTo.lines, left, colW);
    const sideBottom = data.side ? block(data.side.label, data.side.lines, left + width / 2 + 12, colW) : y;
    y = Math.max(billBottom, sideBottom) + 22;

    // ── items table ──
    const cols = { name: left + 12, qty: left + width * 0.56, unit: left + width * 0.66, amount: left + width * 0.82 };
    const nameW = cols.qty - cols.name - 10;
    const tableHeader = () => {
      doc.roundedRect(left, y, width, 24, 4).fill(SOFT);
      write(data.columns[0], cols.name, y + 7, { size: 8.5, bold: true, color: ACCENT });
      write(data.columns[1], cols.qty, y + 7, { size: 8.5, bold: true, color: ACCENT, width: cols.unit - cols.qty - 8, align: 'center' });
      write(data.columns[2], cols.unit, y + 7, { size: 8.5, bold: true, color: ACCENT, width: cols.amount - cols.unit - 8, align: 'right' });
      write(data.columns[3], cols.amount, y + 7, { size: 8.5, bold: true, color: ACCENT, width: right - 12 - cols.amount, align: 'right' });
      y += 30;
    };
    tableHeader();
    for (const row of data.rows) {
      const rowH = heightOf(row.name, nameW, 10, true) + (row.detail ? heightOf(row.detail, nameW, 8.5) + 2 : 0) + 14;
      if (y + rowH > doc.page.height - 170) { doc.addPage(); doc.rect(0, 0, doc.page.width, 8).fill(ACCENT); y = 40; tableHeader(); }
      let ny = write(row.name, cols.name, y, { size: 10, bold: true, width: nameW });
      if (row.detail) ny = write(row.detail, cols.name, ny + 1, { size: 8.5, color: MUTED, width: nameW });
      write(row.qty, cols.qty, y, { size: 10, width: cols.unit - cols.qty - 8, align: 'center' });
      write(row.unit, cols.unit, y, { size: 10, color: '#374151', width: cols.amount - cols.unit - 8, align: 'right' });
      write(row.amount, cols.amount, y, { size: 10, bold: true, width: right - 12 - cols.amount, align: 'right' });
      y = Math.max(ny, y + 14) + 8;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(LINE).stroke();
      y += 8;
    }

    // ── totals ──
    if (y > doc.page.height - 200) { doc.addPage(); doc.rect(0, 0, doc.page.width, 8).fill(ACCENT); y = 40; }
    const tx = left + width * 0.52;
    const tw = right - tx;
    y += 4;
    for (const row of data.totals) {
      write(row.label, tx, y, { size: 9.5, color: MUTED, width: tw * 0.6 });
      write(row.value, tx, y, { size: 9.5, width: tw - 12, align: 'right' });
      y += 18;
    }
    doc.roundedRect(tx - 8, y, tw + 8, 34, 6).fill(ACCENT);
    write(data.total.label, tx + 4, y + 10, { size: 11, bold: true, color: '#FFFFFF', width: tw * 0.5 });
    write(data.total.value, tx, y + 8.5, { size: 14, bold: true, color: '#FFFFFF', width: tw - 12, align: 'right' });
    y += 54;

    if (data.note) {
      write(data.note, left, y, { size: 9, color: '#374151', width: width * 0.5 });
    }

    // ── footer ── (inside the bottom margin: no automatic new page)
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 78;
    doc.moveTo(left, fy).lineTo(right, fy).lineWidth(1).strokeColor(LINE).stroke();
    write(data.footer, left, fy + 12, { size: 10, bold: true, color: ACCENT, width, align: 'center' });
    const contact = data.shop.lines.filter((line) => /phone|@/i.test(line)).join('  ·  ');
    if (contact) write(contact, left, fy + 30, { size: 8.5, color: MUTED, width, align: 'center' });
    doc.end();
  });
}
