import { STAGES, ARRIVED, CHASE_AFTER_DAYS } from './incoming.js';

// THE "ORDERED FROM" HISTORY: for every proxy payment you have logged — what it covered, and how much of that has reached the warehouse since, so you can see whom to chase.
// A payment records HOW MANY claims of an item it covered (not which), so they are worked out oldest-first: the first payment for an item covers that item's oldest confirmed claims, the next payment the ones after them
// (the same rule the claim preview uses). A member set is counted as one unit that has arrived when ALL its parts have. Only CONFIRMED claims count; a claim cancelled since drops out of both numbers.
const ARRIVED_AT = STAGES.indexOf(ARRIVED);
const daysSince = (d) => { const t = new Date(); t.setHours(0, 0, 0, 0); const x = new Date(d); x.setHours(0, 0, 0, 0); return Math.max(0, Math.round((t - x) / 86400000)); };

export async function proxyHistory(conn) {
  const [pays] = await conn.query(`SELECT pp.id, p.name AS proxy, pp.deadline, pp.summary, pp.is_paid AS paid, pp.created_at AS createdAt, pp.paid_at AS paidAt
                                     FROM proxy_payments pp JOIN proxies p ON p.id = pp.proxy_id ORDER BY pp.id DESC LIMIT 500`);
  if (!pays.length) return { proxies: [], totals: { payments: 0, waiting: 0, toChase: 0 } };
  const [ppis] = await conn.query(`SELECT ppi.proxy_payment_id AS pid, ppi.id, ppi.item_id AS itemId, ppi.set_id AS setId, ppi.claim_count AS claimCount, i.title, go.title AS orderTitle
                                     FROM proxy_payment_items ppi JOIN items i ON i.id = ppi.item_id JOIN group_orders go ON go.id = i.order_id
                                    WHERE ppi.item_id IN (SELECT item_id FROM proxy_payment_items WHERE proxy_payment_id IN (?)) ORDER BY ppi.proxy_payment_id, ppi.id`, [pays.map((x) => x.id)]);
  const itemIds = [...new Set(ppis.map((r) => r.itemId))];
  const [claims] = itemIds.length ? await conn.query("SELECT id, item_id AS itemId, set_id AS setId, pipeline FROM claims WHERE item_id IN (?) AND status = 'confirmed' ORDER BY id", [itemIds]) : [[]];
  const reached = (c) => STAGES.indexOf(c.pipeline) >= ARRIVED_AT;
  const offset = new Map();                                                    // item → how many of its (non-set) claims earlier payments have already covered
  const cover = new Map();                                                     // payment-item row id → { covered, arrived }
  for (const r of ppis) {
    if (r.setId) {                                                             // a set: one unit; it has arrived when every part has
      const parts = claims.filter((c) => c.setId === r.setId);
      cover.set(r.id, { covered: parts.length ? 1 : 0, arrived: parts.length && parts.every(reached) ? 1 : 0 });
    } else {
      const own = claims.filter((c) => c.itemId === r.itemId && !c.setId), from = offset.get(r.itemId) || 0, slice = own.slice(from, from + Number(r.claimCount || 0));
      offset.set(r.itemId, from + Number(r.claimCount || 0)); cover.set(r.id, { covered: slice.length, arrived: slice.filter(reached).length });
    }
  }
  const byProxy = new Map();
  for (const x of pays) {
    const rows = ppis.filter((r) => r.pid === x.id), items = new Map();
    for (const r of rows) { const c = cover.get(r.id), it = items.get(r.itemId) || { itemId: r.itemId, label: `${r.orderTitle} — ${r.title}`, covered: 0, arrived: 0 }; it.covered += c.covered; it.arrived += c.arrived; items.set(r.itemId, it); }
    const list = [...items.values()].map((i) => ({ ...i, waiting: i.covered - i.arrived })), covered = list.reduce((n, i) => n + i.covered, 0), arrived = list.reduce((n, i) => n + i.arrived, 0), waiting = covered - arrived;
    const since = x.paidAt || x.createdAt, days = daysSince(since), paid = !!x.paid;
    const pay = { id: x.id, summary: x.summary, paid, loggedOn: new Date(x.createdAt).toISOString(), paidOn: x.paidAt ? new Date(x.paidAt).toISOString() : null, days, covered, arrived, waiting, complete: covered > 0 && waiting === 0, chase: paid && waiting > 0 && days >= CHASE_AFTER_DAYS, items: list };
    if (!byProxy.has(x.proxy)) byProxy.set(x.proxy, []);
    byProxy.get(x.proxy).push(pay);
  }
  const proxies = [...byProxy.entries()].map(([name, payments]) => ({ name, payments, totals: { payments: payments.length, waiting: payments.reduce((n, p) => n + p.waiting, 0), toChase: payments.filter((p) => p.chase).length, unpaid: payments.filter((p) => !p.paid).length } }))
    .sort((a, b) => b.totals.toChase - a.totals.toChase || a.name.localeCompare(b.name));
  return { proxies, totals: { payments: pays.length, waiting: proxies.reduce((n, p) => n + p.totals.waiting, 0), toChase: proxies.reduce((n, p) => n + p.totals.toChase, 0) } };
}
