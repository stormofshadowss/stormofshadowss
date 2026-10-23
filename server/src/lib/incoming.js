import { round2 } from './money.js';

// ── "Incoming": what the GOM (or a proxy) has ordered from shops, and what has reached the warehouse ──
export const STAGES = ['awaiting fulfillment', 'ordered via proxy / warehouse', 'arrived at proxy / warehouse', 'shipping requested', 'enroute to GOM', 'arrived at GOM', 'checking parcel', 'ready to pack / on hand', 'packed', 'shipped', 'completed'];
export const ORDERED = 'ordered via proxy / warehouse', ARRIVED = 'arrived at proxy / warehouse';
export const CHASE_AFTER_DAYS = 14;                                                   // an outstanding order older than this is flagged "chase"
const stageIdx = (p) => Math.max(0, STAGES.indexOf(p));

// The "units" of an item that have to be sourced, oldest first. An ordinary / member item: each CONFIRMED claim is one copy. A set: each SECURED set is one unit (its parts move together).
export async function unitsOf(conn, itemId) {
  const [[it]] = await conn.query('SELECT item_type FROM items WHERE id = ?', [itemId]);
  if (!it) return null;
  if (it.item_type === 'set') {
    const [rows] = await conn.query(
      `SELECT s.id AS setId, s.set_number AS n, c.id AS claimId, c.pipeline, j.instagram_handle AS handle, c.label
         FROM item_sets s LEFT JOIN claims c ON c.set_id = s.id AND c.status = 'confirmed' LEFT JOIN joiners j ON j.id = c.joiner_id
        WHERE s.item_id = ? AND s.admin_decision = 'secured' ORDER BY s.set_number, c.id`, [itemId]);
    const by = new Map();
    for (const r of rows) { if (!by.has(r.setId)) by.set(r.setId, { key: `set:${r.setId}`, label: `Set ${r.n}`, claims: [] }); if (r.claimId) by.get(r.setId).claims.push({ id: r.claimId, pipeline: r.pipeline, handle: r.handle, label: r.label }); }
    return { type: 'set', units: [...by.values()].map((u) => ({ ...u, stage: u.claims.length ? Math.min(...u.claims.map((c) => stageIdx(c.pipeline))) : 0, firstId: u.claims.length ? u.claims[0].id : 0 })) };
  }
  const [rows] = await conn.query("SELECT c.id, c.pipeline, j.instagram_handle AS handle, c.label FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE c.item_id = ? AND c.status = 'confirmed' ORDER BY c.id", [itemId]);
  return { type: it.item_type, units: rows.map((c) => ({ key: `claim:${c.id}`, label: `@${c.handle}`, claims: [{ id: c.id, pipeline: c.pipeline, handle: c.handle, label: c.label }], stage: stageIdx(c.pipeline), firstId: c.id })) };
}

// Which claims SHOULD move on, given how many copies have been ordered / have arrived? The oldest ones that haven't reached that stage yet. The screen shows this and then hands the
// ids to the ordinary "move stage" action, which keeps all of its own safety rules (cancelled, in a parcel, in a box…).
export async function advancePlan(conn, itemId, to) {
  const u = await unitsOf(conn, itemId); if (!u) return null;
  const [[t]] = await conn.query(
    "SELECT COALESCE(SUM(l.qty), 0) AS ordered, COALESCE(SUM(l.arrived_qty), 0) AS arrived FROM store_order_lines l JOIN store_orders o ON o.id = l.store_order_id WHERE l.item_id = ? AND o.status = 'open'", [itemId]);
  const target = Math.min(Number(to === 'ordered' ? t.ordered : t.arrived), u.units.length), stage = to === 'ordered' ? ORDERED : ARRIVED, threshold = stageIdx(stage);
  const already = u.units.filter((x) => x.stage >= threshold).length;
  const moves = u.units.filter((x) => x.stage < threshold).sort((a, b) => a.firstId - b.firstId).slice(0, Math.max(0, target - already));
  return { type: u.type, stage, needed: u.units.length, ordered: Number(t.ordered), arrived: Number(t.arrived), target, already, moves: moves.map((m) => ({ unit: m.label, claimIds: m.claims.map((c) => c.id), handles: [...new Set(m.claims.map((c) => c.handle))], labels: m.claims.map((c) => c.label) })), claimIds: moves.flatMap((m) => m.claims.map((c) => c.id)) };
}

const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
const daysSince = (d) => { const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((t - new Date(`${day(d)}T00:00:00`)) / 86400000); };

// Everything the Incoming view needs in one go.
export async function incomingSnapshot(conn) {
  const [orders] = await conn.query('SELECT o.id, o.store, o.order_ref AS orderRef, o.order_url AS orderUrl, o.ordered_on AS orderedOn, o.notes, o.status, o.last_chased_on AS lastChasedOn, p.name AS proxy FROM store_orders o LEFT JOIN proxies p ON p.id = o.proxy_id ORDER BY o.ordered_on DESC, o.id DESC');
  const ids = orders.map((o) => o.id), idq = ids.length ? ids : [0];
  const [lines] = await conn.query('SELECT l.id, l.store_order_id AS orderId, l.item_id AS itemId, l.qty, l.arrived_qty AS arrived, l.note, i.title AS item, go.title AS groupOrder, (i.cancelled_at IS NOT NULL) AS itemCancelled FROM store_order_lines l JOIN items i ON i.id = l.item_id JOIN group_orders go ON go.id = i.order_id WHERE l.store_order_id IN (?) ORDER BY l.id', [idq]);
  const [ships] = await conn.query('SELECT id, store_order_id AS orderId, carrier, tracking_no AS trackingNo, shipped_on AS shippedOn, arrived_on AS arrivedOn, notes FROM store_shipments WHERE store_order_id IN (?) ORDER BY id', [idq]);
  const out = orders.map((o) => {
    const ls = lines.filter((l) => l.orderId === o.id).map((l) => ({ ...l, itemCancelled: !!l.itemCancelled })), sh = ships.filter((s) => s.orderId === o.id).map((s) => ({ ...s, shippedOn: day(s.shippedOn), arrivedOn: day(s.arrivedOn) }));
    const qty = ls.reduce((n, l) => n + l.qty, 0), arrived = ls.reduce((n, l) => n + l.arrived, 0);
    const state = o.status === 'cancelled' ? 'cancelled' : ls.length && arrived >= qty ? 'arrived' : arrived > 0 ? 'part' : 'waiting';
    const waiting = state === 'waiting' || state === 'part', days = waiting ? daysSince(o.orderedOn) : null, chased = o.lastChasedOn ? daysSince(o.lastChasedOn) : null;
    return { ...o, orderedOn: day(o.orderedOn), lastChasedOn: day(o.lastChasedOn), lines: ls, shipments: sh, qty, arrived, missing: qty - arrived, state, daysWaiting: days,
      chase: waiting && days >= CHASE_AFTER_DAYS && (chased === null || chased >= 7), noTracking: waiting && sh.length === 0 };
  });
  // per item: copies needed / ordered / arrived
  const [needA] = await conn.query("SELECT c.item_id AS itemId, COUNT(*) AS n FROM claims c JOIN items i ON i.id = c.item_id WHERE c.status = 'confirmed' AND i.item_type <> 'set' AND i.cancelled_at IS NULL GROUP BY c.item_id");
  const [needB] = await conn.query("SELECT s.item_id AS itemId, COUNT(*) AS n FROM item_sets s JOIN items i ON i.id = s.item_id WHERE s.admin_decision = 'secured' AND i.cancelled_at IS NULL GROUP BY s.item_id");
  const [tot] = await conn.query("SELECT l.item_id AS itemId, SUM(l.qty) AS ordered, SUM(l.arrived_qty) AS arrived FROM store_order_lines l JOIN store_orders o ON o.id = l.store_order_id WHERE o.status = 'open' GROUP BY l.item_id");
  const need = new Map([...needA, ...needB].map((r) => [r.itemId, Number(r.n)])), got = new Map(tot.map((r) => [r.itemId, r]));
  const wanted = [...new Set([...need.keys(), ...got.keys()])];
  const [items] = wanted.length ? await conn.query('SELECT i.id, i.title, i.item_type AS type, go.title AS groupOrder, (i.cancelled_at IS NOT NULL) AS cancelled FROM items i JOIN group_orders go ON go.id = i.order_id WHERE i.id IN (?) ORDER BY go.id DESC, i.sort_order, i.id', [wanted]) : [[]];
  const counts = items.map((i) => { const g = got.get(i.id), needed = need.get(i.id) || 0, ordered = Number(g?.ordered || 0), arrived = Number(g?.arrived || 0); return { itemId: i.id, item: i.title, type: i.type, groupOrder: i.groupOrder, cancelled: !!i.cancelled, needed, ordered, arrived, toOrder: Math.max(0, needed - ordered), missing: Math.max(0, ordered - arrived), over: Math.max(0, ordered - needed) }; });
  // The item picker on the store-order form. 'waiting' = how many SECURED claims are still at 'awaiting fulfillment' (what still needs ordering — counted exactly as the To order list counts them, test orders
  // left out); the form offers only items with something waiting unless "Show all items" is ticked.
  const [optionRows] = await conn.query(
    `SELECT i.id AS itemId, i.title AS item, go.title AS groupOrder, COALESCE(w.waiting, 0) AS waiting
       FROM items i JOIN group_orders go ON go.id = i.order_id
       LEFT JOIN (SELECT c.item_id, COUNT(*) AS waiting FROM claims c JOIN group_orders g ON g.id = c.order_id
                   WHERE c.status = 'confirmed' AND c.pipeline = 'awaiting fulfillment' AND g.is_test = 0 GROUP BY c.item_id) w ON w.item_id = i.id
      WHERE i.cancelled_at IS NULL AND go.cancelled_at IS NULL AND go.archived_at IS NULL ORDER BY go.id DESC, i.sort_order, i.id LIMIT 3000`);
  const options = optionRows.map((o) => ({ ...o, waiting: Number(o.waiting) }));
  const [[addr]] = await conn.query("SELECT v FROM gom_settings WHERE k = 'warehouse_address'").then((r) => (r[0].length ? r : [[{ v: '' }]]));
  const chase = out.filter((o) => o.state === 'waiting' || o.state === 'part').sort((a, b) => String(a.orderedOn).localeCompare(String(b.orderedOn)));
  const [prox] = await conn.query('SELECT name FROM proxies ORDER BY name');
  return { warehouseAddress: addr?.v || '', proxies: prox.map((p) => p.name), orders: out, chase: chase.map((o) => o.id), counts, options, chaseAfterDays: CHASE_AFTER_DAYS, totals: { waiting: chase.length, toChase: chase.filter((o) => o.chase).length, missingCopies: round2(chase.reduce((n, o) => n + o.missing, 0)) } };
}

// What still needs ORDERING: claims that are SECURED (confirmed) and still at 'awaiting fulfillment' — counted per group order → item → OPTION (a member of a set or of a member
// item, or a size). Pressing "Mark ordered…" moves claims on, so they drop off this list. Cancelled items/orders and test orders are left out; private orders are included
// (an order that came by message still has to be ordered). 'proxy' is the item's own proxy, else its group order's (null = you order it yourself).
export async function toOrderList(conn) {
  const [rows] = await conn.query(
    `SELECT go.id AS orderId, go.title AS \`order\`, COALESCE(ipx.name, opx.name) AS proxy, i.id AS itemId, i.title AS item, i.item_type AS type,
            COALESCE(c.member_name, c.variant_label) AS option_name, COUNT(*) AS qty
       FROM claims c JOIN items i ON i.id = c.item_id JOIN group_orders go ON go.id = c.order_id
       LEFT JOIN proxies ipx ON ipx.id = i.proxy_id LEFT JOIN proxies opx ON opx.id = go.proxy_id
      WHERE c.status = 'confirmed' AND c.pipeline = 'awaiting fulfillment' AND i.cancelled_at IS NULL AND go.cancelled_at IS NULL AND go.is_test = 0
      GROUP BY go.id, go.title, COALESCE(ipx.name, opx.name), i.id, i.title, i.item_type, i.sort_order, COALESCE(c.member_name, c.variant_label)
      ORDER BY go.id DESC, i.sort_order, i.id, option_name`);
  const out = rows.map((r) => ({ orderId: r.orderId, order: r.order, proxy: r.proxy || null, itemId: r.itemId, item: r.item, type: r.type, option: r.option_name || null, qty: Number(r.qty) }));
  return { rows: out, total: out.reduce((n, r) => n + r.qty, 0) };
}
