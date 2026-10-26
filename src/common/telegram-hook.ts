/**
 * Bridge to the Telegram channel (src/integrations/telegram) so the code that already sends Messenger / Instagram
 * replies (sales bot, order messages, invoices, agents) can send to a Telegram chat without importing the Telegram
 * module. The Telegram service registers itself on startup. Used ONLY for chats whose platform is "telegram".
 */
export type TelegramSendTarget = { companyId: number; botId: string | null; chatId: string };
export type TelegramFile = { url?: string | null; buffer?: Buffer; mimetype?: string; fileName?: string; caption?: string };

type Handlers = {
  sendText(target: TelegramSendTarget, text: string): Promise<string | null>;
  sendFile(target: TelegramSendTarget, file: TelegramFile): Promise<string | null>;
};

let handlers: Handlers | null = null;

export const TelegramHook = {
  register(next: Handlers) {
    handlers = next;
  },
  async sendText(target: TelegramSendTarget, text: string): Promise<string | null> {
    if (!handlers) throw new Error('The Telegram channel is not available on this server.');
    return handlers.sendText(target, text);
  },
  /** photo, video, voice, audio or document – chosen from the file type */
  async sendFile(target: TelegramSendTarget, file: TelegramFile): Promise<string | null> {
    if (!handlers) throw new Error('The Telegram channel is not available on this server.');
    return handlers.sendFile(target, file);
  },
};
