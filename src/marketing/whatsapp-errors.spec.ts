import { explainWhatsAppError } from './whatsapp-errors';

describe('WhatsApp error explanations (broadcast failures)', () => {
  it('turns Meta codes into what to do', () => {
    const sample = explainWhatsAppError('(#131058) Hello World templates can only be sent from the Public Test Numbers');
    expect(sample.code).toBe(131058);
    expect(sample.text).toMatch(/sample template/);
    expect(sample.fix).toMatch(/Message templates/);
    expect(explainWhatsAppError('Meta: (#131026) Message undeliverable').text).toMatch(/cannot receive/);
    expect(explainWhatsAppError('(#131049) This message was not delivered').fix).toMatch(/few days/);
  });
  it('keeps unknown errors readable', () => {
    expect(explainWhatsAppError('Meta: something odd')).toEqual({ text: 'something odd', fix: null, code: null });
    expect(explainWhatsAppError(null).text).toMatch(/did not deliver/);
  });
});
