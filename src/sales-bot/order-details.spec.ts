import { cleanOrderDetails, mergeOrderDetails, orderDetailsNote } from './order-details';

describe("the shop's own order details form", () => {
  it('Modlift form: Name / Address / Two phone numbers / Nearest city', () => {
    const details = cleanOrderDetails([
      { label: 'Name', value: 'Sadeesha' },
      { label: 'Address', value: 'No.133, Thoraya, Kurunegala' },
      { label: 'Two phone numbers', value: '0717457162 / 0717723823' },
      { label: 'Nearest city', value: 'Kurunegala' },
    ]);
    expect(orderDetailsNote(details)).toBe(
      '📋 Customer details:\nName: Sadeesha\nAddress: No.133, Thoraya, Kurunegala\nTwo phone numbers: 0717457162 / 0717723823\nNearest city: Kurunegala');
  });

  it('AVORA form labels lose the markdown, emojis and ":"', () => {
    const details = cleanOrderDetails([
      { label: '- **Full Name:**', value: 'Nimali Perera' },
      { label: '**Mobile Number 1:** 📞', value: '0771234567' },
      { label: '**Nearby City:** 🏙️', value: 'Gampaha' },
      { label: 'District', value: '' },
      { label: 'x', value: 'y' }, { label: 'X', value: 'dup' },
    ]);
    expect(details).toEqual([
      { label: 'Full Name', value: 'Nimali Perera' }, { label: 'Mobile Number 1', value: '0771234567' },
      { label: 'Nearby City', value: 'Gampaha' }, { label: 'x', value: 'y' },
    ]);
  });

  it('no form → no note; later answers update the earlier ones', () => {
    expect(orderDetailsNote(cleanOrderDetails(undefined))).toBe('');
    expect(orderDetailsNote([])).toBe('');
    const merged = mergeOrderDetails([{ label: 'Name', value: 'A' }, { label: 'Address', value: 'Old' }], [{ label: 'address', value: 'New' }, { label: 'Nearest city', value: 'Galle' }]);
    expect(merged).toEqual([{ label: 'Name', value: 'A' }, { label: 'address', value: 'New' }, { label: 'Nearest city', value: 'Galle' }]);
  });
});
