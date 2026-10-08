/**
 * Customer simulator numbers start with 999 (not a real country code), so a test chat can never reach a
 * real person on WhatsApp - not from the bot, an agent reply, an invoice or a broadcast.
 */
export const TEST_PHONE_PREFIX = '999';

export function isTestPhone(phone: string | null | undefined): boolean {
  return String(phone ?? '').replace(/\D/g, '').startsWith(TEST_PHONE_PREFIX);
}

/** What a send to a test number returns instead of calling WhatsApp. */
export function testSendResult() {
  return { provider: 'test', sent: true, messageId: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
}
