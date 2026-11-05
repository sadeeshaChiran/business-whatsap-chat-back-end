/** Anything that runs SQL: DataSource, EntityManager, a transaction manager. */
type Db = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

/**
 * Takes one WhatsApp number off a workspace completely – as if it was never connected. Chats, customers and orders stay.
 * When it was the main number and another number is left, that one becomes the main number.
 */
export async function releaseWhatsappChannel(db: Db, companyId: number, channelId: number): Promise<void> {
  const rows = (await db.query(
    `SELECT id, is_primary FROM whatsapp_channels WHERE company_id = $1 ORDER BY is_primary DESC, id ASC`,
    [companyId])) as Array<{ id: number | string; is_primary: boolean }>;
  const row = rows.find((r) => Number(r.id) === Number(channelId));
  if (!row) return;
  const others = rows.filter((r) => Number(r.id) !== Number(channelId));
  await db.query(`UPDATE bot_channel_user SET whatsapp_channel_id = NULL WHERE company_id = $1 AND whatsapp_channel_id = $2`, [companyId, channelId]);
  await db.query(`DELETE FROM whatsapp_channels WHERE id = $1 AND company_id = $2`, [channelId, companyId]);
  if (others.length && (row.is_primary || !others.some((r) => r.is_primary))) {
    await db.query(`UPDATE whatsapp_channels SET is_primary = (id = $1) WHERE company_id = $2`, [Number(others[0].id), companyId]);
  }
}

/** Connecting a number that another workspace still has: Meta just confirmed this login owns it, so it moves here. */
export async function releaseWhatsappNumberFromOtherCompanies(db: Db, companyId: number, phoneNumberId: string): Promise<number> {
  const id = String(phoneNumberId ?? '').trim();
  if (!id) return 0;
  const rows = (await db.query(
    `SELECT id, company_id FROM whatsapp_channels WHERE meta_phone_number_id = $1 AND company_id <> $2`,
    [id, companyId])) as Array<{ id: number | string; company_id: number | string }>;
  for (const row of rows) await releaseWhatsappChannel(db, Number(row.company_id), Number(row.id));
  return rows.length;
}
