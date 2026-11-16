/**
 * The phone number(s) a customer gave for an order. Many shops ask for TWO numbers (for the courier), and customers
 * write them together ("0717273834, 0723472123", "071 727 3834 / 072-347-2123"). Removing every non-digit glued them
 * into one 20-digit "number". The first number is the order phone; the others are kept for the shop.
 */
const PHONE = /(?:\+?94|0)(?:[\s.-]?\d){9}/g;

export function splitOrderPhones(raw: string | null | undefined): { phone: string; others: string[] } {
  const text = String(raw ?? '');
  const found = [...text.matchAll(PHONE)].map((m) => m[0].replace(/[^\d+]/g, ''));
  const unique = [...new Set(found)];
  if (!unique.length) return { phone: text.replace(/[^\d+]/g, ''), others: [] };   // not a Sri Lankan number: as before
  return { phone: unique[0], others: unique.slice(1, 3) };
}
