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

/** true for an OTP / verification-code style message (a code plus the words around one). */
export function looksLikeServiceMessage(text: string | null | undefined): boolean {
  const t = String(text ?? '').trim();
  if (!t || t.length > 600) return false;
  return CODE.test(t) && WORDS.some((rule) => rule.test(t));
}
