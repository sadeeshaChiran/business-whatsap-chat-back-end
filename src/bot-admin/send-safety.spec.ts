import { HttpStatus } from '@nestjs/common';
import { SendSafetyService, checkMessageRisk } from './send-safety';

describe('ban safety for messages the team sends', () => {
  describe('checkMessageRisk', () => {
    it('normal shop replies are fine', () => {
      for (const text of [
        'Hari, Blue dress M size Rs 3,500. Delivery Rs 350. Order karannada?',
        'Ice cream 1L Rs 1,200 – Colombo delivery tomorrow.',
        'ආයුබෝවන්! ඔබගේ order එක හෙට deliver කරනවා.',
        'Our website: https://www.agentmetra.lk',
      ]) expect(checkMessageRisk(text)).toEqual({ level: 'ok', reasons: [] });
    });

    it('Commerce Policy items ask to confirm', () => {
      expect(checkMessageRisk('Arrack bottle Rs 4500 delivery').reasons[0]).toMatch(/alcohol/);
      expect(checkMessageRisk('Vape pods available').reasons[0]).toMatch(/vapes/);
      expect(checkMessageRisk('Netflix premium account Rs 900 a month').reasons[0]).toMatch(/digital accounts/);
      expect(checkMessageRisk('Instant cash loans approved today').reasons[0]).toMatch(/loans/);
      expect(checkMessageRisk('Rolex first copy watches').reasons[0]).toMatch(/counterfeit/);
    });

    it('spam shapes ask to confirm', () => {
      expect(checkMessageRisk('a https://a.lk b https://b.lk c https://c.lk').reasons.join(' ')).toMatch(/3 links/);
      expect(checkMessageRisk('see bit.ly/abc').reasons.join(' ')).toMatch(/Short links/);
      expect(checkMessageRisk('HUGE SALE TODAY ONLY EVERYTHING HALF PRICE COME NOW').reasons.join(' ')).toMatch(/CAPITAL/);
      const promo = `🌟 Big offer! ${'Manage everything in one place. '.repeat(25)} https://www.agentmetra.lk`;
      expect(checkMessageRisk(promo).reasons.join(' ')).toMatch(/approved template/);
    });
  });

  describe('assertSafe', () => {
    const service = (hours: number | null, sameTextChats = 0) => {
      const s = new SendSafetyService({
        query: async (sql: string) => (sql.includes('EXTRACT(EPOCH') ? [{ hours }] : [{ n: sameTextChats }]),
      } as never);
      return s;
    };
    const status = async (promise: Promise<unknown>) => promise.then(() => 200, (error: { getStatus?: () => number }) => error.getStatus?.());

    it('WhatsApp (Meta): inside 24 hours a normal message goes', async () => {
      expect(await status(service(3).assertSafe({ companyId: 1, conversationId: 2, text: 'Hari', whatsappCloud: true }))).toBe(200);
    });

    it('WhatsApp (Meta): after 24 hours (or never wrote) → template needed, nothing sent', async () => {
      expect(await status(service(30).assertSafe({ companyId: 1, conversationId: 2, text: 'Hari', whatsappCloud: true }))).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(await status(service(null).assertSafe({ companyId: 1, conversationId: 2, text: 'Hari', whatsappCloud: true }))).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    });

    it('Messenger / Evolution: no 24-hour check here', async () => {
      expect(await status(service(30).assertSafe({ companyId: 1, conversationId: 2, text: 'Hari', whatsappCloud: false }))).toBe(200);
    });

    it('the same long text to many chats by hand is blocked', async () => {
      const text = 'Agent Metra packages from Rs 4,500 – one place for all your customer messages.';
      expect(await status(service(1, 4).assertSafe({ companyId: 1, conversationId: 2, text, whatsappCloud: true }))).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(await status(service(1, 2).assertSafe({ companyId: 1, conversationId: 2, text, whatsappCloud: true }))).toBe(200);
    });

    it('risky words: 409 first, then sends when the team confirms', async () => {
      expect(await status(service(1).assertSafe({ companyId: 1, conversationId: 2, text: 'Vape pods Rs 2500', whatsappCloud: true }))).toBe(HttpStatus.CONFLICT);
      expect(await status(service(1).assertSafe({ companyId: 1, conversationId: 2, text: 'Vape pods Rs 2500', whatsappCloud: true, confirmRisk: true }))).toBe(200);
    });
  });
});
