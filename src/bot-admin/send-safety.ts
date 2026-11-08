import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Ban safety for messages the TEAM sends from the inbox (the AI bot and broadcasts have their own rules).
 * Meta disables WhatsApp numbers for: normal messages outside the 24-hour customer window, the same promo pasted to
 * many chats, and Commerce Policy items (alcohol, drugs, weapons, adult, gambling, loans, digital accounts …).
 *
 * 1. WhatsApp (Meta Cloud API): a normal message needs the customer to have written in the last 24 hours, else
 *    a template is needed → 422, nothing is sent.
 * 2. The same text sent by hand to many different chats in a short time = bulk / spam → 422 (use Marketing → Broadcast).
 * 3. Risky words or a spam-looking message → 409 with the reasons; the team member can send it anyway after reading them.
 */
export type RiskLevel = 'ok' | 'warn';
export type RiskCheck = { level: RiskLevel; reasons: string[] };

/** Customer service window of WhatsApp / Messenger / Instagram (free-form messages). */
export const WINDOW_HOURS = 24;
/** Same text to this many different chats within BULK_MINUTES = bulk sending. */
export const BULK_CHATS = 5;
export const BULK_MINUTES = 30;

const POLICY_WORDS: Array<{ re: RegExp; why: string }> = [
  { re: /\b(arrack|whisk(?:e)?y|vodka|beer|liquor|alcohol|wine|rum|gin|brandy|toddy|kasippu|madyasara)\b|අරක්ක|බියර්|මත්පැන්/i, why: 'alcohol' },
  { re: /\b(cigarettes?|tobacco|vapes?|e-?cig|hookah|shisha|nicotine)\b|සිගරට්/i, why: 'tobacco / vapes' },
  { re: /\b(weed|ganja|cannabis|marijuana|cocaine|heroin|meth|kush|thc|cbd)\b|ගංජා|කුඩු/i, why: 'drugs' },
  { re: /\b(guns?|pistols?|rifles?|ammo|ammunition|bullets?|explosives?|airsoft)\b|තුවක්කු/i, why: 'weapons' },
  { re: /\b(sex|porn|xxx|adult toys?|escort|nude|18\+)\b/i, why: 'adult content' },
  { re: /\b(betting|casino|gambl\w*|lottery|jackpot|bet now|slot games?)\b/i, why: 'gambling' },
  { re: /\b(loans?|leasing|instant cash|credit facility|crypto|bitcoin|usdt|forex|trading signals?|investment plan|double your money)\b|ණය/i, why: 'loans / money / crypto' },
  { re: /\b(netflix|spotify|youtube premium|canva pro|chatgpt plus|prime video)\b.*\b(account|subscription|premium|sell|rs\.?|lkr)\b|\b(gift cards?|game accounts?|diamonds? top ?up)\b/i, why: 'digital accounts / subscriptions' },
  { re: /\b(replica|first copy|master copy|copy watch|fake (?:brand|shoes|bags?))\b/i, why: 'counterfeit (replica / first copy)' },
  { re: /\b(diet pills?|slimming (?:pills?|tea)|weight loss (?:pills?|capsules?)|steroids?|viagra|sex pills?)\b/i, why: 'pills / supplements' },
];

const PROMO = /\b(offer|discount|sale|limited time|today only|buy now|order now|click here|free|% ?off|deal|promo)\b|ඕෆර්|වට්ටම්|අද විතරයි/i;

/** Words and shapes Meta's systems read as spam or as Commerce Policy items (no database, easy to test). */
export function checkMessageRisk(text: string): RiskCheck {
  const value = String(text ?? '');
  const reasons: string[] = [];
  const policy = [...new Set(POLICY_WORDS.filter((rule) => rule.re.test(value)).map((rule) => rule.why))];
  if (policy.length) reasons.push(`Talks about ${policy.join(', ')} – WhatsApp's Commerce Policy does not allow selling these, a number can be banned for it.`);
  const links = value.match(/https?:\/\/\S+|www\.\S+/gi) ?? [];
  if (links.length >= 3) reasons.push(`${links.length} links in one message look like spam – keep it to one link.`);
  if (/\b(bit\.ly|tinyurl\.com|t\.co|cutt\.ly|shorturl\.at|rb\.gy)\//i.test(value)) reasons.push('Short links (bit.ly …) are often blocked as spam – use your full website link.');
  const letters = value.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 40 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6) reasons.push('Mostly CAPITAL LETTERS looks like shouting / spam.');
  const emojis = value.match(/\p{Extended_Pictographic}/gu) ?? [];
  if (value.length > 600 && PROMO.test(value) && (links.length >= 1 || emojis.length >= 8)) {
    reasons.push('A long promotional message (offer + links / many emojis) – send promotions as an approved template from Marketing → Broadcast, not as a chat message.');
  }
  return { level: reasons.length ? 'warn' : 'ok', reasons };
}

@Injectable()
export class SendSafetyService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Hours since the customer last wrote to us (any chat of this customer); null = never wrote. */
  async hoursSinceCustomerWrote(conversationId: number): Promise<number | null> {
    const [row] = (await this.dataSource
      .query(
        `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(m.created_at::timestamptz))) / 3600.0 AS hours
           FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id
          WHERE c.bot_channel_user_id = (SELECT bot_channel_user_id FROM bot_conversation WHERE id = $1)
            AND m.direction::text = 'inbound'`,
        [conversationId],
      )
      .catch(() => [{ hours: 0 }])) as Array<{ hours: string | number | null }>;
    return row?.hours == null ? null : Number(row.hours);
  }

  /** Different chats of this company that got exactly this text from the team in the last BULK_MINUTES. */
  async sameTextChats(companyId: number, text: string, exceptConversationId: number): Promise<number> {
    const [row] = (await this.dataSource
      .query(
        `SELECT COUNT(DISTINCT m.conversation_id)::int AS n
           FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
          WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.direction::text = 'outbound' AND m.conversation_id <> $3
            AND COALESCE(m.source, '') NOT IN ('sales_bot', 'bot', 'broadcast', 'campaign', 'automation', 'template')
            AND m.created_at::timestamptz >= NOW() - make_interval(mins => $4)
            AND md5(btrim(m.content)) = md5(btrim($2))`,
        [Number(companyId), text, Number(exceptConversationId), BULK_MINUTES],
      )
      .catch(() => [])) as Array<{ n: number }>;
    return Number(row?.n ?? 0);
  }

  /**
   * Throws (nothing is sent) when the message would put the number at risk.
   * whatsappCloud = the chat is on a WhatsApp number connected through Meta (the 24-hour rule is checked by Meta there).
   */
  async assertSafe(params: { companyId: number; conversationId: number; text?: string | null; whatsappCloud: boolean; confirmRisk?: boolean; kind?: 'text' | 'media' }) {
    if (params.whatsappCloud) {
      const hours = await this.hoursSinceCustomerWrote(params.conversationId);
      if (hours === null || hours > WINDOW_HOURS) {
        throw new HttpException(
          {
            message: hours !== null
              ? `The customer last wrote ${Math.floor(hours)} hours ago. WhatsApp allows normal messages only within 24 hours of the customer's last message – send an approved template instead (the 📄 button). Sending normal messages after 24 hours can get the number banned.`
              : 'The customer has not written to you yet. Start the chat with an approved template (the 📄 button).',
            code: 'window_closed',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }
    const text = String(params.text ?? '').trim();
    if (!text) return;
    if (text.length >= 40) {
      const others = await this.sameTextChats(params.companyId, text, params.conversationId);
      if (others + 1 >= BULK_CHATS) {
        throw new HttpException(
          {
            message: `This same message was already sent to ${others} other chats in the last ${BULK_MINUTES} minutes. Sending one message to many people by hand looks like spam to WhatsApp – use Marketing → Broadcast with an approved template.`,
            code: 'bulk_blocked',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }
    if (params.confirmRisk) return;
    const risk = checkMessageRisk(text);
    if (risk.level === 'warn') {
      throw new HttpException(
        { message: `Check before sending: ${risk.reasons.join(' ')}`, code: 'risk_confirm' },
        HttpStatus.CONFLICT,
      );
    }
  }
}
