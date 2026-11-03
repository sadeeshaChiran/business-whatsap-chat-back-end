/**
 * Lets the WhatsApp / Messenger / Instagram webhook handlers hand every inbound customer message to the
 * automation flows (first message, keyword, ad, comment) before the AI sales bot, without importing the flows module.
 * When a flow takes the message (it started, or it was waiting for this answer), the AI does not reply to it.
 */
export type FlowInboundEvent = {
  companyId: number;
  conversationId: number;
  platform: 'whatsapp' | 'messenger' | 'instagram';
  text: string;
  /** Click-to-chat ad id of this message (Meta referral), when the chat came from an ad */
  adId?: string | null;
  /** Messenger / Instagram quick-reply or postback payload (a tap on a button a comment flow sent) */
  payload?: string | null;
};
export type FlowCommentEvent = {
  companyId: number;
  platform: 'facebook' | 'instagram';
  commentId: string;
  postId: string | null;
  text: string;
  authorId: string | null;
  authorName: string | null;
};

type InboundHandler = (event: FlowInboundEvent) => Promise<boolean>;
type CommentHandler = (event: FlowCommentEvent) => Promise<boolean>;
let inbound: InboundHandler | null = null;
let comment: CommentHandler | null = null;

export const FlowHook = {
  register(handlers: { inbound: InboundHandler; comment: CommentHandler }) {
    inbound = handlers.inbound;
    comment = handlers.comment;
  },
  /** true = a flow handled this message (the AI must not answer it) */
  async inbound(event: FlowInboundEvent): Promise<boolean> {
    if (!inbound || !event.conversationId) return false;
    try {
      return await inbound(event);
    } catch (error) {
      console.error('[flows] inbound failed:', error);
      return false;
    }
  },
  /** true = a comment flow answered it (the AI comment auto-reply stays quiet) */
  async comment(event: FlowCommentEvent): Promise<boolean> {
    if (!comment) return false;
    try {
      return await comment(event);
    } catch (error) {
      console.error('[flows] comment trigger failed:', error);
      return false;
    }
  },
};
