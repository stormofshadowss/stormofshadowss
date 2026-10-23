import { todayUK, datePassed } from './closing.js';

// ARCHIVING a group order. Allowed only when the order is CLOSED (closed by hand, past its closing date, or cancelled) and — unless it was cancelled — EVERY claim in it is "completed":
// a claim that is cancelled is ignored; one that is still a request (not secured), or at any stage before "completed", blocks it and is listed so the GOM knows what's left.
export const isClosedNow = (o, today = todayUK()) => !!o.cancelled_at || o.status === 'closed' || datePassed(o.close_date, today);

// what is not completed yet, grouped for reading: [{ item, stage, count }]
export async function outstandingClaims(conn, orderId) {
  const [rows] = await conn.query(
    `SELECT i.title AS item, CASE WHEN c.status <> 'confirmed' THEN 'requested (not secured yet)' ELSE c.pipeline END AS stage, COUNT(*) AS count
       FROM claims c JOIN items i ON i.id = c.item_id
      WHERE c.order_id = ? AND c.status <> 'cancelled' AND NOT (c.status = 'confirmed' AND c.pipeline = 'completed')
      GROUP BY i.id, i.title, stage ORDER BY i.sort_order, i.id, stage`, [orderId]);
  return rows.map((r) => ({ item: r.item, stage: r.stage, count: Number(r.count) }));
}

export const outstandingMessage = (title, list) => {
  const total = list.reduce((n, r) => n + r.count, 0), shown = list.slice(0, 6).map((r) => `${r.item} — ${r.count} × ${r.stage}`).join('; ');
  return `Can't archive “${title}” yet — ${total} claim${total === 1 ? '' : 's'} ${total === 1 ? "isn't" : "aren't"} completed: ${shown}${list.length > 6 ? `; …and ${list.length - 6} more` : ''}.`;
};
