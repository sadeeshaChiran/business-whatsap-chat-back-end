import type { DataSource } from 'typeorm';
import { type BotCampaign, COMMENT_SOURCE } from '../marketing/attribution';

/** How long after a comment the chat is still "about that post". */
const COMMENT_DAYS = 7;

/**
 * A chat that started from the customer's comment on our Facebook / Instagram post: the bot gets the post like an ad
 * (the post's AI card summary or text, its linked products, the comment), so "Ona 2k", "price?", "details" are about
 * that post – not a random product. Found from the comment we replied to privately, or from Meta's own
 * "You are responding to a user comment … comment_id=…" message in the chat. Null when the chat has no recent comment.
 */
export async function commentCampaign(ds: DataSource, conversationId: number, companyId: number): Promise<BotCampaign | null> {
  const [conv] = await ds.query(
    `SELECT comment_ref FROM bot_conversation WHERE id = $1 AND comment_ref IS NOT NULL AND comment_ref_at > NOW() - make_interval(days => $2::int)`,
    [conversationId, COMMENT_DAYS]).catch(() => []);
  let ref = String(conv?.comment_ref ?? '');
  if (!ref) {
    const [meta] = await ds.query(
      `SELECT content FROM bot_message WHERE conversation_id = $1 AND source = 'meta-context' AND content ~ 'comment_id=[0-9]+'
          AND created_at > NOW() - make_interval(days => $2::int) ORDER BY id DESC LIMIT 1`, [conversationId, COMMENT_DAYS]).catch(() => []);
    ref = /comment_id=(\d+)/.exec(String(meta?.content ?? ''))?.[1] ?? '';
  }
  let comment: { comment_id?: string; post_id?: string; message?: string; post_text?: string; post_link?: string } | undefined;
  if (ref) {
    const tail = ref.includes('_') ? ref.split('_').pop() as string : ref;
    [comment] = await ds.query(
      `SELECT comment_id, post_id, message, post_text, post_link FROM social_comment
        WHERE company_id = $1 AND (comment_id = $2 OR comment_id LIKE '%\\_' || $3) ORDER BY id DESC LIMIT 1`,
      [companyId, ref, tail]).catch(() => []);
  } else {
    // older chats: our private reply in the chat is the same text as the comment's private_reply
    const [sent] = await ds.query(
      `SELECT content FROM bot_message WHERE conversation_id = $1 AND source = 'social-private-reply'
          AND created_at > NOW() - make_interval(days => $2::int) ORDER BY id DESC LIMIT 1`, [conversationId, COMMENT_DAYS]).catch(() => []);
    if (sent?.content) {
      [comment] = await ds.query(
        `SELECT comment_id, post_id, message, post_text, post_link FROM social_comment
          WHERE company_id = $1 AND private_reply = $2 ORDER BY id DESC LIMIT 1`, [companyId, String(sent.content)]).catch(() => []);
    }
  }
  if (!comment?.post_id) return null;
  const [card] = await ds.query(
    `SELECT summary, product_ids FROM social_post_ai WHERE company_id = $1 AND post_id = $2 LIMIT 1`, [companyId, String(comment.post_id)]).catch(() => []);
  const summary = String(card?.summary ?? '').trim();
  const postText = String(comment.post_text ?? '').replace(/\s+/g, ' ').trim();
  const productIds = (Array.isArray(card?.product_ids) ? card.product_ids : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0).slice(0, 20);
  if (!summary && !postText && !productIds.length) return null;
  const said = String(comment.message ?? '').replace(/\s+/g, ' ').trim();
  return {
    source: COMMENT_SOURCE,
    name: '',
    ad_headline: said ? `Their comment: "${said.slice(0, 200)}"` : '',
    ad_body: (summary || postText).slice(0, 700),
    ad_type: 'post',
    ad_url: String(comment.post_link ?? '').slice(0, 300),
    offer: '',
    instructions: 'This chat started from their comment on this post. Short or general messages ("ona 2k", "price?", "details", "order") are about '
      + 'this post\'s product(s) - answer about them first, never about another product.',
    product_ids: productIds,
    ends_at: null,
  };
}
