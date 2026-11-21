/** The number people see for an order: the shop's own number (1, 2, 3 per company); the internal id for old rows. */
export function orderNo(order: { id: number | string; order_no?: number | string | null } | null | undefined): number {
  if (!order) return 0;
  const no = Number(order.order_no);
  return Number.isInteger(no) && no > 0 ? no : Number(order.id);
}

/** After saving a NEW order: the number the database gave it (TypeORM normally returns it already). */
export async function fillOrderNo<T extends { id: number; order_no?: number | null }>(
  repo: { query: (sql: string, params: unknown[]) => Promise<unknown> }, order: T): Promise<T> {
  if (order && (order.order_no == null) && order.id) {
    const rows = (await Promise.resolve().then(() => repo.query('SELECT order_no FROM bot_order WHERE id = $1', [order.id])).catch(() => [])) as
      Array<{ order_no: number | null }> | undefined;
    order.order_no = Array.isArray(rows) ? rows[0]?.order_no ?? null : null;
  }
  return order;
}
