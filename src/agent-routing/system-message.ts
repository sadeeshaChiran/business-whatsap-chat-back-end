/**
 * Service messages that other companies send to a business WhatsApp number – one-time passwords, verification and login
 * codes, "do not share this code" notices. They are not customers: they are kept apart for admins, never given to an
 * agent and never answered by the AI.
 */
const CODE = /(?<![\d+])\d{4,8}(?!\d)|\b\d{3}[- ]\d{3}\b/;
const WORDS = [
  /\b(otp|one[-\s]?time\s*(pass(word|code)?|pin|code)|pass\s?code|passcode)\b/i,
  /\b(verification|verify|confirmation|security|login|log-in|sign[-\s]?in|authentication|auth|access|activation)\s+(code|pin|number)\b/i,
  /\b(code|pin)\s+(is|:)\s*\d/i,
  /\bis\s+your\s+.{0,40}\b(code|pin|otp)\b/i,
  /\b(do\s+not|don'?t|never)\s+share\b/i,
  /\byour\s+(whatsapp|facebook|instagram|meta|google|microsoft|apple|telegram)\s+(code|account)\b/i,
  // Sinhala / Tamil: "code", "OTP", "do not give anyone"
  /(කේතය|රහස්\s*අංකය|කිසිවෙකුට\s*(ලබා\s*)?නොදෙන්න|குறியீடு|கடவுச்சொல்|யாருடனும்\s*பகிர)/,
];

/** WhatsApp's / Meta's own accounts that write to a business number (setup steps, notices, verification). */
const OFFICIAL_NUMBERS = new Set(['16465894168', '16505551111', '16315555555']);
const OFFICIAL_NAMES = /^(whatsapp|whatsapp business|whatsapp support|meta|meta business|meta for business|meta verified|meta business suite|facebook|instagram)$/i;

/** true when the sender is WhatsApp / Meta itself (by its number or its exact profile name). */
export function isOfficialSender(phone?: string | null, name?: string | null): boolean {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits && OFFICIAL_NUMBERS.has(digits)) return true;
  return OFFICIAL_NAMES.test(String(name ?? '').trim());
}

/**
 * true for an OTP / verification-code style message (a code plus the words around one),
 * or any message from WhatsApp / Meta's own accounts.
 */
export function looksLikeServiceMessage(text: string | null | undefined, sender: { phone?: string | null; name?: string | null } = {}): boolean {
  if (isOfficialSender(sender.phone, sender.name)) return true;
  const t = String(text ?? '').trim();
  if (!t || t.length > 600) return false;
  return CODE.test(t) && WORDS.some((rule) => rule.test(t));
}
