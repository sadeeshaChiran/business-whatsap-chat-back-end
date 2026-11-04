import { isOfficialSender, looksLikeServiceMessage } from './system-message';

describe('looksLikeServiceMessage', () => {
  it.each([
    '123456 is your WhatsApp code. Do not share it.',
    'Your OTP is 4821. It expires in 5 minutes.',
    'Use 739 201 as your Facebook login code',
    'Your verification code is: 902114',
    'G-528341 is your Google verification code.',
    'ඔබගේ කේතය 4521 යි. කිසිවෙකුට නොදෙන්න.',
    'Dear customer, your one time password for the transaction is 552190',
  ])('service: %s', (text) => expect(looksLikeServiceMessage(text)).toBe(true));

  it.each([
    'Hi, price of the blue dress?',
    'I want 2 of item 1234',
    'My order number is 558812, when will it come?',
    'Can you send the code for the discount?',
    'Call me on 0771234567',
    '',
  ])('customer: %s', (text) => expect(looksLikeServiceMessage(text)).toBe(false));

  it('treats WhatsApp / Meta accounts as service senders, whatever they write', () => {
    expect(looksLikeServiceMessage('Continue setting up your account. Go to your Setup guidance on desktop.', { phone: '16465894168', name: 'WhatsApp Business' })).toBe(true);
    expect(looksLikeServiceMessage('Welcome!', { phone: '94771234567', name: 'WhatsApp' })).toBe(true);
    expect(looksLikeServiceMessage('I want to set up my WhatsApp Business account', { phone: '94771234567', name: 'Kasun' })).toBe(false);
    expect(isOfficialSender('+1 646 589 4168', '')).toBe(true);
  });
});
