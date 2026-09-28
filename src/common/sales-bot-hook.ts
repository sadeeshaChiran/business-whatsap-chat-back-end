/**
 * Tiny bridge so WhatsappService can hand inbound messages to the sales bot
 * without importing the SalesBot module (which itself needs the WhatsApp module).
 * The SalesBot engine registers itself on startup.
 */
export type SalesBotInboundEvent = {
  companyId: number;
  conversationId: number;
  phone: string;
  provider: 'meta' | 'evolution' | 'simulator' | 'messenger' | 'instagram';
};

type Handler = (event: SalesBotInboundEvent) => Promise<boolean>;

let handler: Handler | null = null;

export const SalesBotHook = {
  register(next: Handler) {
    handler = next;
  },
  /** True when the Python sales bot is configured (SALES_BOT_URL) and owns bot replies. */
  isActive(): boolean {
    return handler !== null;
  },
  /** Returns true when the sales bot took the message (so n8n must not reply too). */
  async notify(event: SalesBotInboundEvent): Promise<boolean> {
    if (!handler) return false;
    try {
      return await handler(event);
    } catch (error) {
      console.error('[sales-bot] inbound hook failed:', error);
      return true; // the engine owns replies even if this one failed
    }
  },
};
