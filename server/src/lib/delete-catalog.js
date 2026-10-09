import { lockJoiner } from './ledger.js';
import { conflict, notFound } from '../errors.js';

// Deleting a group order or an item. The rule: you can delete freely when nothing REAL depends on it, and it explains clearly when it can't.
//   · Unconfirmed requests (and cancelled claims with no money history) are simply removed with it — they were never binding.
//   · It refuses if anyone has a CONFIRMED claim on it (those are real orders — cancel them first on the Claims tab), if any claim has money, a parcel or a box
//     behind it (those records must stay), or if the item was included in a proxy payment. For those, close the order and make it private instead.
// `itemIds` are the items going; `orderId` (when a whole order is going) also takes every claim recorded against the order.
export async function deletionPlan(conn, { itemIds, orderId = null, lock = false }) {
  if (itemIds.length) await conn.query('SELECT id FROM items WHERE id IN (?) ORDER BY id FOR UPDATE', [itemIds]);      // items BEFORE the order (placing a claim locks the item, then touches the order)
  if (orderId) await conn.query('SELECT id FROM group_orders WHERE id = ? FOR UPDATE', [orderId]);
  const where = orderId ? 'c.order_id = ?' : 'c.item_id IN (?)';
  const arg = orderId ? orderId : (itemIds.length ? itemIds : [0]);
  if (lock) {                                                  // the item first (like every placement), then the people lowest-first, then the claims
    const [who] = await conn.query(`SELECT DISTINCT c.joiner_id FROM claims c WHERE ${where} ORDER BY c.joiner_id`, [arg]);
    for (const { joiner_id } of who) await lockJoiner(conn, joiner_id);
    await conn.query(`SELECT c.id FROM claims c WHERE ${where} ORDER BY c.id FOR UPDATE`, [arg]);
  }
  const [claims] = await conn.query(
    `SELECT c.id, c.joiner_id AS joinerId, c.status,
            (SELECT COALESCE(SUM(paid), 0) FROM claim_costs WHERE claim_id = c.id) AS paid,
            EXISTS (SELECT 1 FROM payment_allocations WHERE claim_id = c.id) AS hasPayment,
            EXISTS (SELECT 1 FROM parcel_items WHERE claim_id = c.id) AS hasParcel,
            EXISTS (SELECT 1 FROM box_items WHERE claim_id = c.id) AS hasBox
       FROM claims c WHERE ${where}`, [arg]);
  const [[proxy]] = itemIds.length ? await conn.query('SELECT COUNT(DISTINCT item_id) AS n FROM proxy_payment_items WHERE item_id IN (?)', [itemIds]) : [[{ n: 0 }]];
  const people = (list) => new Set(list.map((c) => c.joinerId)).size;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const confirmed = claims.filter((c) => c.status === 'confirmed');
  const history = claims.filter((c) => c.paid > 0 || c.hasPayment || c.hasParcel || c.hasBox);
  const blockers = [];
  if (confirmed.length) blockers.push({ kind: 'confirmed', count: confirmed.length, message: `${plural(confirmed.length, 'confirmed claim', 'confirmed claims')} (${plural(people(confirmed), 'person', 'people')}) — those are real orders. Cancel them first on the Claims tab, then delete.` });
  if (history.length) blockers.push({ kind: 'history', count: history.length, message: `${plural(history.length, 'claim has', 'claims have')} payments, a parcel or a box behind ${history.length === 1 ? 'it' : 'them'}, and those records have to stay. Close it and make it private instead (Edit → close, tick private).` });
  if (proxy.n) blockers.push({ kind: 'proxy', count: proxy.n, message: `${plural(proxy.n, 'item was', 'items were')} included in a proxy payment, so it can't be deleted. Close it and make it private instead.` });
  const [[sets]] = itemIds.length ? await conn.query('SELECT COUNT(*) AS n FROM item_sets WHERE item_id IN (?)', [itemIds]) : [[{ n: 0 }]];
  const [[fixed]] = itemIds.length ? await conn.query('SELECT COUNT(*) AS n FROM fixed_claims WHERE item_id IN (?) AND ended_at IS NULL', [itemIds]) : [[{ n: 0 }]];
  const [pics] = await conn.query('SELECT image_id AS id FROM items WHERE id IN (?) AND image_id IS NOT NULL UNION SELECT cover_image_id FROM group_orders WHERE id = ? AND cover_image_id IS NOT NULL', [itemIds.length ? itemIds : [0], orderId || 0]);
  return {
    blockers, itemIds, orderId, claimIds: claims.map((c) => c.id), imageIds: pics.map((p) => p.id),
    removes: { items: itemIds.length, claims: claims.length, people: people(claims), sets: sets.n, fixed: fixed.n, pictures: pics.length },
  };
}

// Does the delete in the caller's transaction and returns the picture files to remove once it has committed.
export async function deleteCatalog(conn, { itemIds, orderId = null }) {
  const plan = await deletionPlan(conn, { itemIds, orderId, lock: true });
  if (plan.blockers.length) throw conflict(`This can't be deleted: ${plan.blockers.map((b) => b.message).join(' ')}`, 'cannot_delete');
  if (plan.claimIds.length) {
    await conn.query("DELETE FROM import_records WHERE kind = 'claim' AND entity_id IN (?)", [plan.claimIds]);   // an import's own bookkeeping goes with them
    await conn.query('DELETE FROM claims WHERE id IN (?)', [plan.claimIds]);                                    // their costs and any cancel requests go with them
  }
  if (itemIds.length) {
    await conn.query("DELETE FROM import_records WHERE kind = 'item' AND entity_id IN (?)", [itemIds]);
    await conn.query('DELETE FROM items WHERE id IN (?)', [itemIds]);                                           // members, sizes, sets, fixed claimers go with them
  }
  if (orderId) {
    await conn.query('UPDATE payments SET order_id = NULL WHERE order_id = ?', [orderId]);                      // a payment that was only "for" this order keeps existing, unattached
    await conn.query("DELETE FROM import_records WHERE kind = 'order' AND entity_id = ?", [orderId]);
    await conn.query('DELETE FROM group_orders WHERE id = ?', [orderId]);
  }
  let files = [];
  if (plan.imageIds.length) {
    [files] = await conn.query('SELECT filename FROM images WHERE id IN (?)', [plan.imageIds]);
    await conn.query('DELETE FROM images WHERE id IN (?)', [plan.imageIds]);
  }
  return { plan, files: files.map((f) => f.filename) };
}

export async function itemsOfOrder(conn, orderId) {
  const [[o]] = await conn.query('SELECT id FROM group_orders WHERE id = ?', [orderId]);
  if (!o) throw notFound('No such group order');
  const [items] = await conn.query('SELECT id FROM items WHERE order_id = ? ORDER BY id', [orderId]);
  return items.map((i) => i.id);
}
