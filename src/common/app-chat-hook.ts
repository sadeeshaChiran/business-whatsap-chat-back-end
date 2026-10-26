/**
 * Bridge to the customer app (src/customer-app) so the code that already sends replies (agents, the AI sales bot, order
 * messages) can "send" to a customer-app chat. Nothing leaves the server: the reply is the saved inbox message, which
 * the customer's app reads; the hook only wakes the customer's app up. Used ONLY for chats whose platform is "app".
 */
type Handlers = { delivered(companyId: number, externalUserId: string): void };

let handlers: Handlers | null = null;
let counter = 0;

export const AppChatHook = {
  register(next: Handlers) {
    handlers = next;
  },
  /** Returns the provider id for the saved message and tells the customer's app a moment later (after the row is saved). */
  send(companyId: number, externalUserId: string): string {
    if (!handlers) throw new Error('The customer app is not available on this server.');
    const notify = handlers;
    setTimeout(() => notify.delivered(companyId, externalUserId), 400);
    counter = (counter + 1) % 1_000_000;
    return `app:${Date.now().toString(36)}${counter.toString(36)}`;
  },
};
