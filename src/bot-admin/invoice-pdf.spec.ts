import { renderInvoicePdf } from './invoice-pdf';

describe('invoice PDF', () => {
  it('renders an A4 PDF with Sinhala names and many items (new page when needed)', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ name: `Item ${i + 1}`, detail: i % 2 ? 'Size: M' : undefined, qty: '1', unit: 'Rs 100', amount: 'Rs 100' }));
    const pdf = await renderInvoicePdf({
      title: 'INVOICE', number: '#1', date: '20 Oct 2026', status: 'Pending',
      shop: { name: 'Chu.lk', lines: ['Panadura', 'Phone: 072 508 6953'] },
      billTo: { label: 'Bill to', lines: ['සදීෂා', '0771234567', 'No 462, තොරව'] },
      columns: ['ITEM', 'QTY', 'UNIT PRICE', 'AMOUNT'], rows,
      totals: [{ label: 'Subtotal', value: 'Rs 3,000' }], total: { label: 'Total', value: 'Rs 3,350' }, footer: 'Thank you!',
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });
});
