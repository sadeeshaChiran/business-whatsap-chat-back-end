/**
 * Bridge to the TikTok channel (src/integrations/tiktok) so the code that already sends Messenger / Instagram
 * replies (sales bot, order messages, invoices, agents) can send to a TikTok chat without importing the TikTok
 * module. The TikTok service registers itself on startup. Used ONLY for chats whose platform is "tiktok".
 */
export type TiktokSendTarget = { companyId: number; businessId: string | null; conversationId: string };
export type TiktokImage = { url?: string | null; buffer?: Buffer; mimetype?: string; fileName?: string };

type Handlers = {
  sendText(target: TiktokSendTarget, text: string): Promise<string | null>;
  sendImage(target: TiktokSendTarget, image: TiktokImage): Promise<string | null>;
};

let handlers: Handlers | null = null;

export const TiktokHook = {
  register(next: Handlers) {
    handlers = next;
  },
  async sendText(target: TiktokSendTarget, text: string): Promise<string | null> {
    if (!handlers) throw new Error('The TikTok channel is not available on this server.');
    return handlers.sendText(target, text);
  },
  async sendImage(target: TiktokSendTarget, image: TiktokImage): Promise<string | null> {
    if (!handlers) throw new Error('The TikTok channel is not available on this server.');
    return handlers.sendImage(target, image);
  },
};
