import { looksLikeServiceMessage } from './system-message';

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
});
