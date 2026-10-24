import type { DataSource } from 'typeorm';

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Agent performance for the company admin: chats, speed, replies, and the orders / bookings that count for each
 * agent (made by the agent, or by the bot for the agent's customer). period = last N days.
 */
export async function teamReport(ds: DataSource, companyId: number, daysRaw: number) {
  const days = [1, 7, 30, 90].includes(Number(daysRaw)) ? Number(daysRaw) : 30;
  const since = `NOW() - make_interval(days => $2::int)`;
  const agents = await ds.query(
    `SELECT u.id, u.name, u.email, u.is_agent_active AS online, u.is_active, u.last_login_at
       FROM app_user u JOIN companies co ON co.id = u.company_id
      WHERE u.company_id = $1 AND u.id <> co.admin_user_id AND u.is_super_admin IS NOT TRUE
      ORDER BY u.name`, [companyId]) as Array<Record<string, unknown>>;
  if (!agents.length) return { days, agents: [], totals: null };
  const ids = agents.map((agent) => Number(agent.id));

  const chats = await ds.query(
    `SELECT c.assigned_agent_id AS id,
            COUNT(*) FILTER (WHERE c.assigned_at::timestamptz > ${since})::int AS assigned,
            COUNT(*) FILTER (WHERE c.accepted_at > ${since})::int AS accepted,
            AVG(EXTRACT(EPOCH FROM c.accepted_at - c.assigned_at::timestamptz)) FILTER (WHERE c.accepted_at > ${since} AND c.assigned_at IS NOT NULL) AS accept_sec,
            COUNT(*) FILTER (WHERE c.status = 'pending')::int AS waiting_now,
            COUNT(*) FILTER (WHERE c.status = 'active')::int AS active_now,
            COUNT(*) FILTER (WHERE c.status IN ('pending', 'active') AND EXISTS (
              SELECT 1 FROM bot_message m WHERE m.conversation_id = c.id AND m.direction::text = 'inbound'
                AND m.created_at::timestamptz > COALESCE(c.agent_last_read_at, c.assigned_at::timestamptz, 'epoch')))::int AS unread_now
       FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
      WHERE CAST(cu.company_id AS BIGINT) = $1 AND c.assigned_agent_id = ANY($3::int[])
      GROUP BY 1`, [companyId, days, ids]) as Array<Record<string, unknown>>;

  // replies sent by each agent, and how fast (customer message -> that agent's next reply, within 24 hours)
  const replies = await ds.query(
    `WITH m AS (
       SELECT m.sender_user_id, m.conversation_id, m.direction::text AS direction, m.created_at::timestamptz AS at,
              LAG(m.direction::text) OVER w AS prev_direction, LAG(m.created_at::timestamptz) OVER w AS prev_at
         FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
        WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.created_at::timestamptz > ${since} - INTERVAL '1 day'
       WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.id))
     SELECT sender_user_id AS id, COUNT(*)::int AS replies, COUNT(DISTINCT conversation_id)::int AS customers,
            AVG(EXTRACT(EPOCH FROM at - prev_at)) FILTER (WHERE prev_direction = 'inbound' AND at - prev_at < INTERVAL '24 hours') AS reply_sec
       FROM m WHERE sender_user_id = ANY($3::int[]) AND direction = 'outbound' AND at > ${since}
      GROUP BY 1`, [companyId, days, ids]) as Array<Record<string, unknown>>;

  // the bot's help in each agent's chats
  const bot = await ds.query(
    `SELECT c.assigned_agent_id AS id, COUNT(*)::int AS bot_replies
       FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
      WHERE CAST(cu.company_id AS BIGINT) = $1 AND c.assigned_agent_id = ANY($3::int[]) AND m.source = 'sales_bot'
        AND m.direction::text = 'outbound' AND m.created_at::timestamptz > ${since}
      GROUP BY 1`, [companyId, days, ids]) as Array<Record<string, unknown>>;

  const orders = await ds.query(
    `SELECT o.agent_id AS id, COUNT(*)::int AS orders,
            COUNT(*) FILTER (WHERE o.created_by = 'agent')::int AS by_agent,
            COUNT(*) FILTER (WHERE o.created_by = 'bot')::int AS by_bot,
            COUNT(*) FILTER (WHERE o.created_by = 'admin')::int AS by_admin,
            COUNT(*) FILTER (WHERE o.status::text = 'Delivered')::int AS delivered,
            COUNT(*) FILTER (WHERE o.status::text = 'Cancelled')::int AS cancelled,
            COALESCE(SUM(o.total_amount) FILTER (WHERE o.status::text <> 'Cancelled'), 0) AS revenue
       FROM bot_order o
      WHERE CAST(o.company_id AS BIGINT) = $1 AND o.agent_id = ANY($3::int[]) AND o.created_at::timestamptz > ${since}
      GROUP BY 1`, [companyId, days, ids]) as Array<Record<string, unknown>>;

  const bookings = await ds.query(
    `SELECT b.agent_id AS id, COUNT(*)::int AS bookings, COUNT(*) FILTER (WHERE b.status <> 'cancelled')::int AS kept,
            COALESCE(SUM(b.price) FILTER (WHERE b.status <> 'cancelled'), 0) AS value
       FROM bot_booking b WHERE b.company_id = $1 AND b.agent_id = ANY($3::int[]) AND b.created_at > ${since}
      GROUP BY 1`, [companyId, days, ids]) as Array<Record<string, unknown>>;

  const notes = await ds.query(
    `SELECT n.created_by_user_id AS id, COUNT(*)::int AS notes FROM bot_customer_note n
      WHERE n.company_id = $1 AND n.created_by_user_id = ANY($3::int[]) AND n.created_at > ${since} GROUP BY 1`,
    [companyId, days, ids]).catch(() => []) as Array<Record<string, unknown>>;

  const by = (rows: Array<Record<string, unknown>>) => new Map(rows.map((row) => [Number(row.id), row]));
  const [c, r, b, o, k, n] = [by(chats), by(replies), by(bot), by(orders), by(bookings), by(notes)];
  const list = agents.map((agent) => {
    const id = Number(agent.id);
    const cc = c.get(id) ?? {}; const rr = r.get(id) ?? {}; const oo = o.get(id) ?? {}; const kk = k.get(id) ?? {};
    const orderCount = num(oo.orders);
    return {
      id, name: String(agent.name ?? ''), email: String(agent.email ?? ''), online: Boolean(agent.online), active: agent.is_active !== false,
      last_login_at: agent.last_login_at ?? null,
      chats: {
        assigned: num(cc.assigned), accepted: num(cc.accepted), waiting_now: num(cc.waiting_now), active_now: num(cc.active_now), unread_now: num(cc.unread_now),
        accept_seconds: cc.accept_sec == null ? null : Math.round(num(cc.accept_sec)),
      },
      replies: {
        sent: num(rr.replies), customers: num(rr.customers), reply_seconds: rr.reply_sec == null ? null : Math.round(num(rr.reply_sec)),
        bot_helped: num(b.get(id)?.bot_replies),
      },
      orders: {
        count: orderCount, by_agent: num(oo.by_agent), by_bot: num(oo.by_bot), by_admin: num(oo.by_admin),
        delivered: num(oo.delivered), cancelled: num(oo.cancelled), revenue: num(oo.revenue),
        average: orderCount - num(oo.cancelled) > 0 ? Math.round(num(oo.revenue) / (orderCount - num(oo.cancelled))) : 0,
      },
      bookings: { count: num(kk.bookings), kept: num(kk.kept), value: num(kk.value) },
      notes: num(n.get(id)?.notes),
      // chats accepted that ended in an order or booking
      conversion: num(cc.accepted) ? Math.min(100, Math.round(((orderCount + num(kk.bookings)) / num(cc.accepted)) * 1000) / 10) : 0,
    };
  });
  const sum = (pick: (row: (typeof list)[number]) => number) => list.reduce((total, row) => total + pick(row), 0);
  return {
    days,
    agents: list,
    totals: {
      assigned: sum((row) => row.chats.assigned), accepted: sum((row) => row.chats.accepted), replies: sum((row) => row.replies.sent),
      orders: sum((row) => row.orders.count), revenue: sum((row) => row.orders.revenue), bookings: sum((row) => row.bookings.count),
      unread_now: sum((row) => row.chats.unread_now), waiting_now: sum((row) => row.chats.waiting_now), online: list.filter((row) => row.online).length,
    },
  };
}
