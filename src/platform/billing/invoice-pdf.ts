/** Tiny dependency-free PDF (A4, Helvetica) for Agent Metra payment invoices. */
const esc = (text: string) => text.replace(/[^\x20-\x7E]/g, '?').replace(/([\\()])/g, '\\$1');

export function buildInvoicePdf(lines: Array<{ text: string; size?: number; bold?: boolean; gap?: number }>): Buffer {
  let y = 800;
  const ops: string[] = [];
  for (const line of lines) {
    y -= line.gap ?? (line.size ?? 11) + 7;
    ops.push(`BT /${line.bold ? 'F2' : 'F1'} ${line.size ?? 11} Tf 50 ${y} Td (${esc(line.text)}) Tj ET`);
  }
  const content = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
