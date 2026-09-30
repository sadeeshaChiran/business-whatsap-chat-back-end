/**
 * Lets the webhook handlers pass the raw Meta payload to the marketing module after the messages are saved
 * (ad referrals), without importing the marketing module.
 */
type Handler = (body: unknown, platform: 'whatsapp' | 'messenger' | 'instagram') => Promise<void>;
let handler: Handler | null = null;

export const MarketingHook = {
  register(next: Handler) { handler = next; },
  capture(body: unknown, platform: 'whatsapp' | 'messenger' | 'instagram') {
    if (!handler) return;
    void handler(body, platform).catch((error) => console.warn('[marketing] referral capture failed:', error));
  },
};
