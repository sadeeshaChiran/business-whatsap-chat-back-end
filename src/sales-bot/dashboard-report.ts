import type { DataSource } from 'typeorm';

/**
 * Home dashboard numbers for one company (Today / 7 days / 30 days, Sri Lanka days).
 * Some tables store "timestamp without time zone" (written in the database's own time zone), others timestamptz:
 * `::timestamptz` turns both into a real instant, then AT TIME ZONE 'Asia/Colombo' gives the Sri Lanka day.
 */
const TZ = 'Asia/Colombo';
const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const rate = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

export async function dashboardReport(ds: DataSource, companyId: number, daysRaw: number) {
  const days = [1, 7, 30, 90].includes(Number(daysRaw)) ? Number(daysRaw) : 7;
  // period = from Sri Lanka midnight (days - 1) days ago until now; previous = the same length just before
  const [range] = await ds.query(
    `SELECT (date_trunc('day', NOW() AT TIME ZONE '${TZ}') - make_interval(days => $1::int - 1)) AT TIME ZONE '${TZ}' AS start,
            (date_trunc('day', NOW() AT TIME ZONE '${TZ}') - make_interval(days => 2 * $1::int - 1)) AT TIME ZONE '${TZ}' AS prev_start,
            to_char(NOW() AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS today`,
    [days],
  ) as Array<{ start: Date; prev_start: Date; today: string }>;
  const params = [companyId, range.start, range.prev_start];

  const [messages] = await ds.query(
    `WITH m AS (
       SELECT m.direction::text AS direction, COALESCE(m.source, '') AS source, COALESCE(m.intent, '') AS intent,
              COALESCE(m.delivery_status, '') AS status, m.conversation_id, cu.id AS customer_id, m.created_at::timestamptz AS at
         FROM bot_message m
         JOIN bot_conversation c ON c.id = m.conversation_id
         JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
        WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.created_at::timestamptz >= $3)
     SELECT
       COUNT(*) FILTER (WHERE at >= $2)::int AS total,
       COUNT(*) FILTER (WHERE at >= $2 AND direction = 'inbound')::int AS received,
       COUNT(*) FILTER (WHERE at >= $2 AND direction = 'outbound')::int AS sent,
       COUNT(*) FILTER (WHERE at >= $2 AND direction = 'outbound' AND source = 'sales_bot' AND intent NOT LIKE 'followup%')::int AS ai,
       COUNT(*) FILTER (WHERE at >= $2 AND direction = 'outbound' AND source = 'sales_bot' AND intent LIKE 'followup%')::int AS followups,
       COUNT(*) FILTER (WHERE at >= $2 AND direction = 'outbound' AND source IN ('agent', 'admin'))::int AS manual,
       COUNT(*) FILTER (WHERE at >= $2 AND direction = 'outbound' AND source = 'broadcast')::int AS campaign,
       COUNT(*) FILTER (WHERE at >= $2 AND direction = 'outbound' AND source = 'template')::int AS template,
       COUNT(*) FILTER (WHERE at >= $2 AND direction = 'outbound' AND status IN ('sent', 'delivered', 'read'))::int AS st_sent,
       COUNT(*) FILTER (WHERE at >= $2 AND direction = 'outbound' AND status IN ('delivered', 'read'))::int AS st_delivered,
       COUNT(*) FILTER (WHERE at >= $2 AND direction = 'outbound' AND status = 'read')::int AS st_read,
       COUNT(*) FILTER (WHERE at >= $2 AND direction = 'outbound' AND status = 'failed')::int AS st_failed,
       COUNT(DISTINCT conversation_id) FILTER (WHERE at >= $2)::int AS conversations,
       COUNT(DISTINCT conversation_id) FILTER (WHERE at < $2)::int AS prev_conversations,
       COUNT(DISTINCT customer_id) FILTER (WHERE at >= $2 AND direction = 'inbound')::int AS customers,
       COUNT(*) FILTER (WHERE at < $2)::int AS prev_total
     FROM m`,
    params,
  ) as Array<Record<string, unknown>>;

  const [contacts] = await ds.query(
    `SELECT
       COUNT(*) FILTER (WHERE cu.created_at::timestamptz >= $2)::int AS new_contacts,
       COUNT(*) FILTER (WHERE cu.created_at::timestamptz >= $3 AND cu.created_at::timestamptz < $2)::int AS prev_new_contacts,
       COUNT(*)::int AS total_contacts,
       -- wrote in this period AND was a contact before it
       COUNT(*) FILTER (WHERE cu.created_at::timestamptz < $2 AND EXISTS (
         SELECT 1 FROM bot_conversation c JOIN bot_message m ON m.conversation_id = c.id
          WHERE c.bot_channel_user_id = cu.id AND m.direction::text = 'inbound' AND m.created_at::timestamptz >= $2))::int AS returning
     FROM bot_channel_user cu WHERE CAST(cu.company_id AS BIGINT) = $1`,
    params,
  ) as Array<Record<string, unknown>>;

  const channels = await ds.query(
    `WITH m AS (
       SELECT cu.platform, cu.id AS customer_id, m.direction::text AS direction, m.conversation_id
         FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
        WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.created_at::timestamptz >= $2)
     SELECT COALESCE(platform, 'whatsapp') AS platform, COUNT(*)::int AS messages, COUNT(DISTINCT customer_id)::int AS customers,
            COUNT(DISTINCT conversation_id) FILTER (WHERE direction = 'inbound')::int AS asked,
            COUNT(DISTINCT conversation_id) FILTER (WHERE direction = 'outbound' AND conversation_id IN (
              SELECT conversation_id FROM m m2 WHERE m2.direction = 'inbound'))::int AS answered
       FROM m GROUP BY 1 ORDER BY 2 DESC`,
    [companyId, range.start],
  ) as Array<Record<string, unknown>>;

  const [orders] = await ds.query(
    `SELECT
       COUNT(*) FILTER (WHERE (o.created_at::timestamptz AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date)::int AS today,
       COUNT(*) FILTER (WHERE o.created_at::timestamptz >= $2)::int AS period,
       COUNT(*) FILTER (WHERE o.created_at::timestamptz >= $3 AND o.created_at::timestamptz < $2)::int AS prev_period,
       COALESCE(SUM(o.total_amount) FILTER (WHERE o.created_at::timestamptz >= $2 AND o.status::text <> 'Cancelled'), 0) AS revenue,
       COALESCE(SUM(o.total_amount) FILTER (WHERE o.created_at::timestamptz >= $3 AND o.created_at::timestamptz < $2 AND o.status::text <> 'Cancelled'), 0) AS prev_revenue,
       COUNT(*) FILTER (WHERE o.created_at::timestamptz >= $2 AND o.status::text = 'Pending')::int AS pending,
       COUNT(*) FILTER (WHERE o.created_at::timestamptz >= $2 AND o.status::text = 'Confirmed')::int AS confirmed,
       COUNT(*) FILTER (WHERE o.created_at::timestamptz >= $2 AND o.status::text = 'Processing')::int AS processing,
       COUNT(*) FILTER (WHERE o.created_at::timestamptz >= $2 AND o.status::text = 'Shipped')::int AS shipped,
       COUNT(*) FILTER (WHERE o.created_at::timestamptz >= $2 AND o.status::text = 'Delivered')::int AS delivered,
       COUNT(*) FILTER (WHERE o.created_at::timestamptz >= $2 AND o.status::text = 'Cancelled')::int AS cancelled,
       COUNT(*) FILTER (WHERE o.status::text = 'Pending')::int AS all_pending
     FROM bot_order o WHERE CAST(o.company_id AS BIGINT) = $1 AND (o.created_at::timestamptz >= $3 OR o.status::text = 'Pending')`,
    params,
  ) as Array<Record<string, unknown>>;

  const [bookings] = await ds.query(
    `SELECT
       COUNT(*) FILTER (WHERE b.created_at >= $2)::int AS period,
       COUNT(*) FILTER (WHERE b.created_at >= $2 AND b.status = 'requested')::int AS requested,
       COUNT(*) FILTER (WHERE b.created_at >= $2 AND b.status = 'confirmed')::int AS confirmed,
       COUNT(*) FILTER (WHERE b.created_at >= $2 AND b.status = 'done')::int AS done,
       COUNT(*) FILTER (WHERE b.created_at >= $2 AND b.status = 'cancelled')::int AS cancelled,
       COUNT(*) FILTER (WHERE b.status = 'requested')::int AS all_requested,
       COUNT(*) FILTER (WHERE b.status IN ('requested', 'confirmed') AND b.date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                          AND b.date >= to_char(NOW() AT TIME ZONE '${TZ}', 'YYYY-MM-DD'))::int AS upcoming
     FROM bot_booking b WHERE b.company_id = $1`,
    [companyId, range.start],
  ) as Array<Record<string, unknown>>;

  const leadRows = await ds.query(
    `SELECT COALESCE(c.lead_stage, 'new') AS stage, COUNT(*)::int AS n
       FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
      WHERE CAST(cu.company_id AS BIGINT) = $1 AND c.created_at::timestamptz >= $2
      GROUP BY 1`,
    [companyId, range.start],
  ) as Array<{ stage: string; n: number }>;

  // needs attention now (not limited to the period)
  const [action] = await ds.query(
    `WITH last AS (
       SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.direction::text AS direction, m.created_at::timestamptz AS at
         FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
        WHERE CAST(cu.company_id AS BIGINT) = $1 AND c.status::text <> 'closed' AND m.created_at::timestamptz >= NOW() - INTERVAL '7 days'
        ORDER BY m.conversation_id, m.id DESC)
     SELECT
       (SELECT COUNT(*) FROM last l JOIN bot_conversation c ON c.id = l.conversation_id
         WHERE l.direction = 'inbound' AND GREATEST(COALESCE(c.agent_last_read_at, 'epoch'), COALESCE(c.admin_last_read_at, 'epoch')) < l.at)::int AS unread,
       (SELECT COUNT(*) FROM last WHERE direction = 'inbound' AND at < NOW() - INTERVAL '5 minutes')::int AS waiting,
       (SELECT COUNT(*) FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
         WHERE CAST(cu.company_id AS BIGINT) = $1 AND c.status::text = 'open' AND c.assigned_agent_id IS NULL AND c.queue_reason IS NOT NULL
           AND c.last_message_at::timestamptz >= NOW() - INTERVAL '7 days')::int AS queue,
       (SELECT COUNT(*) FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
         WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.delivery_status = 'failed' AND m.created_at::timestamptz >= NOW() - INTERVAL '7 days')::int AS failed`,
    [companyId],
  ) as Array<Record<string, unknown>>;

  // average time to answer a customer (bot and people separately): time from a customer message to the next reply
  const [speed] = await ds.query(
    `WITH m AS (
       SELECT m.direction::text AS direction, COALESCE(m.source, '') AS source, m.created_at::timestamptz AS at,
              LAG(m.direction::text) OVER w AS prev_direction, LAG(m.created_at::timestamptz) OVER w AS prev_at
         FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
        WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.created_at::timestamptz >= $2
       WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.id))
     SELECT
       AVG(EXTRACT(EPOCH FROM at - prev_at)) FILTER (WHERE direction = 'outbound' AND prev_direction = 'inbound' AND source = 'sales_bot') AS bot_sec,
       AVG(EXTRACT(EPOCH FROM at - prev_at)) FILTER (WHERE direction = 'outbound' AND prev_direction = 'inbound' AND source IN ('agent', 'admin')
                                                    AND at - prev_at < INTERVAL '24 hours') AS team_sec
     FROM m`,
    [companyId, range.start],
  ) as Array<Record<string, unknown>>;

  const daily = await ds.query(
    `WITH d AS (SELECT generate_series(($2::timestamptz AT TIME ZONE '${TZ}')::date, (NOW() AT TIME ZONE '${TZ}')::date, INTERVAL '1 day')::date AS day),
     m AS (
       SELECT (m.created_at::timestamptz AT TIME ZONE '${TZ}')::date AS day, m.direction::text AS direction, COALESCE(m.source, '') AS source,
              COALESCE(m.intent, '') AS intent
         FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
        WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.created_at::timestamptz >= $2),
     n AS (SELECT (cu.created_at::timestamptz AT TIME ZONE '${TZ}')::date AS day, COUNT(*)::int AS n FROM bot_channel_user cu
            WHERE CAST(cu.company_id AS BIGINT) = $1 AND cu.created_at::timestamptz >= $2 GROUP BY 1),
     o AS (SELECT (o.created_at::timestamptz AT TIME ZONE '${TZ}')::date AS day, COUNT(*)::int AS n, COALESCE(SUM(o.total_amount), 0) AS revenue
             FROM bot_order o WHERE CAST(o.company_id AS BIGINT) = $1 AND o.created_at::timestamptz >= $2 AND o.status::text <> 'Cancelled' GROUP BY 1)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            (SELECT COUNT(*) FROM m WHERE m.day = d.day AND direction = 'inbound')::int AS received,
            (SELECT COUNT(*) FROM m WHERE m.day = d.day AND direction = 'outbound' AND source = 'sales_bot')::int AS ai,
            (SELECT COUNT(*) FROM m WHERE m.day = d.day AND direction = 'outbound' AND source IN ('agent', 'admin'))::int AS manual,
            (SELECT COUNT(*) FROM m WHERE m.day = d.day AND direction = 'outbound' AND source IN ('broadcast', 'template'))::int AS campaign,
            COALESCE((SELECT n FROM n WHERE n.day = d.day), 0)::int AS new_contacts,
            COALESCE((SELECT n FROM o WHERE o.day = d.day), 0)::int AS orders,
            COALESCE((SELECT revenue FROM o WHERE o.day = d.day), 0) AS revenue
       FROM d ORDER BY d.day`,
    [companyId, days === 1 ? range.prev_start : range.start], // "today" still shows yesterday for comparison
  ) as Array<Record<string, unknown>>;

  const hours = await ds.query(
    `SELECT EXTRACT(HOUR FROM m.created_at::timestamptz AT TIME ZONE '${TZ}')::int AS hour, COUNT(*)::int AS n
       FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
      WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.direction::text = 'inbound' AND m.created_at::timestamptz >= $2
      GROUP BY 1`,
    [companyId, range.start],
  ) as Array<{ hour: number; n: number }>;

  const recent = await ds.query(
    `SELECT c.id AS conversation_id, COALESCE(NULLIF(cu.display_name, ''), cu.external_user_id) AS name, cu.platform,
            (SELECT LEFT(m.content, 120) FROM bot_message m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS preview,
            (SELECT m.direction::text FROM bot_message m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_direction,
            c.last_message_at::timestamptz AS at
       FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
      WHERE CAST(cu.company_id AS BIGINT) = $1 AND c.last_message_at IS NOT NULL
      ORDER BY c.last_message_at DESC LIMIT 6`,
    [companyId],
  ) as Array<Record<string, unknown>>;

  const m = messages ?? {};
  const sent = num(m.sent);
  const automated = num(m.ai) + num(m.followups) + num(m.campaign) + num(m.template);
  const conversations = num(m.conversations);
  const leadMap = Object.fromEntries(leadRows.map((row) => [row.stage, num(row.n)]));
  const leadTotal = leadRows.reduce((sum, row) => sum + num(row.n), 0);
  const o = orders ?? {};
  const periodOrders = num(o.period);
  const closed = num(o.delivered) + num(o.cancelled);
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, messages: num(hours.find((row) => num(row.hour) === hour)?.n) }));

  return {
    days, today: range.today,
    engagement: {
      conversations, prev_conversations: num(m.prev_conversations),
      messages: num(m.total), prev_messages: num(m.prev_total), received: num(m.received), sent,
      messages_per_conversation: conversations ? Math.round((num(m.total) / conversations) * 10) / 10 : 0,
      customers: num(m.customers),
      new_contacts: num(contacts?.new_contacts), prev_new_contacts: num(contacts?.prev_new_contacts),
      returning_customers: num(contacts?.returning), total_contacts: num(contacts?.total_contacts),
    },
    replies: {
      ai: num(m.ai), followups: num(m.followups), manual: num(m.manual), campaign: num(m.campaign), template: num(m.template),
      automation_rate: rate(automated, sent),
    },
    delivery: {
      sent: num(m.st_sent), delivered: num(m.st_delivered), read: num(m.st_read), failed: num(m.st_failed),
      delivery_rate: rate(num(m.st_delivered), num(m.st_sent) + num(m.st_failed)),
      read_rate: rate(num(m.st_read), num(m.st_delivered)),
      failure_rate: rate(num(m.st_failed), num(m.st_sent) + num(m.st_failed)),
    },
    channels: channels.map((row) => ({
      platform: String(row.platform), messages: num(row.messages), customers: num(row.customers),
      response_rate: rate(num(row.answered), num(row.asked)),
    })),
    orders: {
      today: num(o.today), period: periodOrders, prev_period: num(o.prev_period),
      revenue: num(o.revenue), prev_revenue: num(o.prev_revenue),
      average_value: periodOrders - num(o.cancelled) > 0 ? Math.round(num(o.revenue) / (periodOrders - num(o.cancelled))) : 0,
      pending: num(o.pending), confirmed: num(o.confirmed), processing: num(o.processing), shipped: num(o.shipped),
      delivered: num(o.delivered), cancelled: num(o.cancelled),
      completion_rate: rate(num(o.delivered), closed),
    },
    bookings: {
      period: num(bookings?.period), requested: num(bookings?.requested), confirmed: num(bookings?.confirmed),
      done: num(bookings?.done), cancelled: num(bookings?.cancelled), upcoming: num(bookings?.upcoming),
    },
    leads: {
      new: num(leadMap.new), contacted: num(leadMap.contacted), qualified: num(leadMap.qualified),
      proposal: num(leadMap.proposal), won: num(leadMap.won), lost: num(leadMap.lost),
      total: leadTotal, conversion_rate: rate(num(leadMap.won), leadTotal),
    },
    action: {
      unread: num(action?.unread), waiting: num(action?.waiting), queue: num(action?.queue), failed: num(action?.failed),
      pending_orders: num(o.all_pending), requested_bookings: num(bookings?.all_requested),
    },
    speed: {
      bot_seconds: speed?.bot_sec == null ? null : Math.round(num(speed.bot_sec)),
      team_seconds: speed?.team_sec == null ? null : Math.round(num(speed.team_sec)),
    },
    daily: daily.map((row) => ({
      day: String(row.day), received: num(row.received), ai: num(row.ai), manual: num(row.manual), campaign: num(row.campaign),
      new_contacts: num(row.new_contacts), orders: num(row.orders), revenue: num(row.revenue),
    })),
    hours: byHour,
    recent: recent.map((row) => ({
      conversation_id: num(row.conversation_id), name: String(row.name ?? ''), platform: String(row.platform ?? 'whatsapp'),
      preview: String(row.preview ?? ''), from_customer: row.last_direction === 'inbound', at: row.at,
    })),
  };
}

/** Extra detail for the Bot reports page: what the bot did, follow-ups, owner feedback, handoff reasons, languages, products. */
export async function botReportDetails(ds: DataSource, companyId: number, days: number) {
  const since = `NOW() - make_interval(days => $2::int)`;
  const actions = await ds.query(
    `SELECT TRIM(a) AS action, COUNT(*)::int AS n
       FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id,
            unnest(string_to_array(COALESCE(m.intent, ''), ',')) a
      WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.source = 'sales_bot' AND m.created_at::timestamptz > ${since} AND TRIM(a) <> ''
      GROUP BY 1`,
    [companyId, days],
  ) as Array<{ action: string; n: number }>;
  const count = (test: (action: string) => boolean) => actions.filter((row) => test(row.action)).reduce((sum, row) => sum + num(row.n), 0);

  const [followups] = await ds.query(
    `WITH fu AS (
       SELECT m.conversation_id, c.bot_channel_user_id, MIN(m.created_at::timestamptz) AS first_at, COUNT(*)::int AS n
         FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
        WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.intent LIKE 'followup_%' AND m.created_at::timestamptz > ${since}
        GROUP BY 1, 2)
     SELECT COUNT(*)::int AS customers, COALESCE(SUM(n), 0)::int AS messages,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM bot_message r WHERE r.conversation_id = fu.conversation_id
              AND r.direction::text = 'inbound' AND r.created_at::timestamptz > fu.first_at))::int AS replied,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM bot_order o WHERE CAST(o.company_id AS BIGINT) = $1 AND o.bot_channel_user_id = fu.bot_channel_user_id
              AND o.created_at::timestamptz >= fu.first_at AND o.created_at::timestamptz <= fu.first_at + INTERVAL '7 days'))::int AS ordered
       FROM fu`,
    [companyId, days],
  ) as Array<Record<string, unknown>>;

  const [feedback] = await ds.query(
    `SELECT COUNT(*) FILTER (WHERE m.feedback = 'up')::int AS good, COUNT(*) FILTER (WHERE m.feedback = 'down')::int AS bad
       FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
      WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.source = 'sales_bot' AND m.created_at::timestamptz > ${since}`,
    [companyId, days],
  ) as Array<Record<string, unknown>>;

  const handoffReasons = await ds.query(
    `SELECT LEFT(regexp_replace(n.message, '\\s*\\((bot switched off|bot keeps replying)[^)]*\\)\\s*$', ''), 90) AS reason, COUNT(*)::int AS n
       FROM bot_notification n WHERE n.company_id = $1 AND n.kind = 'handoff' AND n.created_at > ${since}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
    [companyId, days],
  ) as Array<{ reason: string; n: number }>;

  const languages = await ds.query(
    `SELECT COALESCE(substring(cu.session_state from '"language"\\s*:\\s*"([a-z_]+)"'), 'unknown') AS language, COUNT(DISTINCT cu.id)::int AS n
       FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
      WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.source = 'sales_bot' AND m.created_at::timestamptz > ${since}
      GROUP BY 1 ORDER BY 2 DESC`,
    [companyId, days],
  ) as Array<{ language: string; n: number }>;

  const channels = await ds.query(
    `SELECT COALESCE(cu.platform, 'whatsapp') AS platform, COUNT(*)::int AS replies, COUNT(DISTINCT cu.id)::int AS customers
       FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
      WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.source = 'sales_bot' AND m.created_at::timestamptz > ${since}
      GROUP BY 1 ORDER BY 2 DESC`,
    [companyId, days],
  ) as Array<Record<string, unknown>>;

  const products = await ds.query(
    `SELECT i.product_name AS name, SUM(i.quantity)::int AS quantity, COALESCE(SUM(i.total_price), 0) AS revenue, COUNT(DISTINCT o.id)::int AS orders
       FROM bot_order_item i JOIN bot_order o ON o.id = i.order_id
      WHERE CAST(o.company_id AS BIGINT) = $1 AND o.created_at::timestamptz > ${since} AND o.status::text <> 'Cancelled'
      GROUP BY 1 ORDER BY 3 DESC LIMIT 8`,
    [companyId, days],
  ) as Array<Record<string, unknown>>;

  const [speed] = await ds.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY u.latency_ms) AS p50, percentile_cont(0.9) WITHIN GROUP (ORDER BY u.latency_ms) AS p90,
            COALESCE(AVG(u.input_tokens + u.output_tokens), 0) AS tokens_per_reply
       FROM bot_ai_usage u WHERE u.company_id = $1 AND NOT u.is_test AND u.created_at > ${since}`,
    [companyId, days],
  ) as Array<Record<string, unknown>>;

  const hours = await ds.query(
    `SELECT EXTRACT(HOUR FROM m.created_at::timestamptz AT TIME ZONE '${TZ}')::int AS hour, COUNT(*)::int AS n
       FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
      WHERE CAST(cu.company_id AS BIGINT) = $1 AND m.source = 'sales_bot' AND m.created_at::timestamptz > ${since}
      GROUP BY 1`,
    [companyId, days],
  ) as Array<{ hour: number; n: number }>;
  const nightReplies = hours.filter((row) => num(row.hour) >= 21 || num(row.hour) < 8).reduce((sum, row) => sum + num(row.n), 0);

  const fu = followups ?? {};
  return {
    actions: {
      orders: count((a) => a === 'order'),
      order_changes: count((a) => a === 'order_changed' || a === 'change_request'),
      order_cancels: count((a) => a === 'cancelled' || a === 'cancel_request'),
      bookings: count((a) => a === 'booking'),
      booking_changes: count((a) => a === 'booking_changed'),
      booking_cancels: count((a) => a === 'booking_cancelled'),
      invoices: count((a) => a === 'invoice'),
      notes: count((a) => a === 'note'),
      handoffs: count((a) => a === 'handoff'),
    },
    followups: {
      customers: num(fu.customers), messages: num(fu.messages), replied: num(fu.replied), ordered: num(fu.ordered),
      reply_rate: rate(num(fu.replied), num(fu.customers)), order_rate: rate(num(fu.ordered), num(fu.customers)),
    },
    feedback: { good: num(feedback?.good), bad: num(feedback?.bad) },
    handoff_reasons: handoffReasons.map((row) => ({ reason: String(row.reason ?? '').trim() || '—', count: num(row.n) })),
    languages: languages.map((row) => ({ language: String(row.language), customers: num(row.n) })),
    channels: channels.map((row) => ({ platform: String(row.platform), replies: num(row.replies), customers: num(row.customers) })),
    top_products: products.map((row) => ({ name: String(row.name), quantity: num(row.quantity), orders: num(row.orders), revenue: num(row.revenue) })),
    speed: {
      p50_ms: speed?.p50 == null ? null : Math.round(num(speed.p50)),
      p90_ms: speed?.p90 == null ? null : Math.round(num(speed.p90)),
      tokens_per_reply: Math.round(num(speed?.tokens_per_reply)),
    },
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, replies: num(hours.find((row) => num(row.hour) === hour)?.n) })),
    night_replies: nightReplies,
  };
}
