/**
 * Size charts: gallery photos the owner marked "Size chart". The bot sends them when the customer asks about sizes
 * (never as a normal product photo). The AI names the products (size_chart_product_ids); when it forgot but the
 * customer clearly asked for the chart ("size chart eka ewanna", "size table"), the products in the chat are used.
 */

/** The customer clearly asked to SEE the size chart / table (not just "L size ekak"). */
export function asksForSizeChart(text: string): boolean {
  const t = String(text ?? '').toLowerCase();
  return /size\s*(chart|char|table|tabel|list|details?|wistharay?a?|ewanna|ewa|pennanna|balanna)|size\s*(eka\s*)?(kohomada|mokakda|monawada|thoranne|hariyanne|wenne|danne)|sizes?\s+(monada|monda|monawada|mokakda|mona)\s*(thiyenne|thiyenawa|tiyenne)?|size\s*[ea]ka\s*(kohomada|mokakda|thoranne|danne)|(chart|table)\s*[ea]ka|mona\s*size|sizes?\s*(mokakda|monawada|thiyenne)|measurements?|chest\s*size|සයිස්|ප්‍රමාණ|size\s*එක\s*(කොහොමද|තෝරන්නේ)|அளவு|size\s*chart/.test(t);
}

/** Product ids whose size charts go out this turn (max 2). */
export function sizeChartPicks(input: {
  aiIds: number[];
  customerText: string;
  /** products in this turn's photos / the open order / photos sent earlier in the chat (newest first) */
  inChat: number[];
  /** products that have a size chart */
  withChart: Set<number>;
}): number[] {
  const ai = input.aiIds.filter((id) => input.withChart.has(id));
  if (ai.length) return [...new Set(ai)].slice(0, 2);
  if (!asksForSizeChart(input.customerText)) return [];
  const inChat = [...new Set(input.inChat)].filter((id) => input.withChart.has(id));
  if (inChat.length) return inChat.slice(0, 2);
  // a shop with ONE product that has a chart: that one
  return input.withChart.size === 1 ? [...input.withChart] : [];
}
