import { splitOrderPhones } from './order-phones';

describe('order phone numbers', () => {
  it('two numbers given together stay two numbers', () => {
    expect(splitOrderPhones('0717273834, 0723472123')).toEqual({ phone: '0717273834', others: ['0723472123'] });
    expect(splitOrderPhones('071 727 3834 / 072-347-2123')).toEqual({ phone: '0717273834', others: ['0723472123'] });
    expect(splitOrderPhones('+94717273834 and 0723472123')).toEqual({ phone: '+94717273834', others: ['0723472123'] });
  });

  it('one number as before', () => {
    expect(splitOrderPhones('0717273834')).toEqual({ phone: '0717273834', others: [] });
    expect(splitOrderPhones('94717273834')).toEqual({ phone: '94717273834', others: [] });
    expect(splitOrderPhones('')).toEqual({ phone: '', others: [] });
  });

  it('the same number twice is one number; a foreign number is kept as it was', () => {
    expect(splitOrderPhones('0717273834 0717273834')).toEqual({ phone: '0717273834', others: [] });
    expect(splitOrderPhones('+44 20 7946 0958')).toEqual({ phone: '+442079460958', others: [] });
  });
});
