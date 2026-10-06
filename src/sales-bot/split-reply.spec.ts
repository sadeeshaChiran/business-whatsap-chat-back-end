import { splitReply } from './sales-bot-engine.service';

describe('splitReply – short WhatsApp messages', () => {
  it('sends each part (separated by an empty line) as its own message', () => {
    expect(splitReply('Rs 2,450i 😊\n\nColombo ta Rs 350.\n\nNama saha address eka ewanna.')).toEqual(['Rs 2,450i 😊', 'Colombo ta Rs 350.', 'Nama saha address eka ewanna.']);
  });
  it('keeps single line breaks (e.g. an order summary) in one message', () => {
    expect(splitReply('Red saree x1 Rs 8,500\nDelivery Rs 350\nTotal Rs 8,850')).toEqual(['Red saree x1 Rs 8,500\nDelivery Rs 350\nTotal Rs 8,850']);
  });
  it('never sends more than 3 messages and ignores empty parts', () => {
    expect(splitReply('a\n\nb\n \n\nc\n\nd\n\ne')).toEqual(['a', 'b', 'c\nd\ne']);
    expect(splitReply('  \n\n ')).toEqual([]);
  });
});
