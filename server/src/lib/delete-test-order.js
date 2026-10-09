import { conflict, notFound, bad } from '../errors.js';
import { lockJoiner } from './ledger.js';
import { round2 } from './money.js';
import { requireNotLive } from './launch.js';

const normal = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// Deleting a TEST order together with EVERYTHING on it — claims, the payments made towards them, the credit those moved, parcels, boxes, proxy payments, pictures.
// Only while the site is not live, and only for orders ticked as test. It refuses (naming why) when something on it is SHARED with other orders — a payment that also paid for another order,
// a parcel or box holding other orders' items, a proxy payment that covers other items — or when removing it would leave someone's credit negative: those can't be split safely.
export async function testDeletePlan(conn, orderId, { lock = false } = {}) {
  await requireNotLive(conn);
  const [[o]] = await conn.query('SELECT id, title, is_test FROM group_orders WHERE id = ?', [orderId]);
  if (!o) throw notFound('No such group order');
  if (!o.is_test) throw conflict('That order is not ticked as a test order.', 'not_test');
  const [its] = await conn.query('SELECT id FROM items WHERE order_id = ? ORDER BY id', [orderId]);
  const itemIds = its.map((i) => i.id), ids = itemIds.length ? itemIds : [0];
  if (lock) {
    await conn.query('SELECT id FROM items WHERE id IN (?) ORDER BY id FOR UPDATE', [ids]);              // items before the order (placing a claim locks the item first)
    await conn.query('SELECT id FROM group_orders WHERE id = ? FOR UPDATE', [orderId]);
    const [who] = await conn.query('SELECT DISTINCT joiner_id FROM claims WHERE order_id = ? ORDER BY joiner_id', [orderId]);
    for (const { joiner_id } of who) await lockJoiner(conn, joiner_id);
  }
  const [claims] = await conn.query('SELECT id, joiner_id FROM claims WHERE order_id = ?', [orderId]);
  const claimIds = claims.map((c) => c.id), cids = claimIds.length ? claimIds : [0];
  const blockers = [];
  // payments
  const [pays] = await conn.query('SELECT DISTINCT payment_id AS id FROM payment_allocations WHERE claim_id IN (?) UNION SELECT id FROM payments WHERE order_id = ?', [cids, orderId]);
  const paymentIds = pays.map((p) => p.id), pids = paymentIds.length ? paymentIds : [0];
  const [shared] = await conn.query('SELECT DISTINCT payment_id AS id FROM payment_allocations WHERE payment_id IN (?) AND claim_id NOT IN (?)', [pids, cids]);
  for (const s of shared) blockers.push({ kind: 'payment', id: s.id, message: `payment #${s.id} also paid for other orders — delete those test orders first, or use Reset for launch` });
  // parcels and boxes
  const [parcels] = await conn.query('SELECT DISTINCT parcel_id AS id FROM parcel_items WHERE claim_id IN (?)', [cids]); const parcelIds = parcels.map((p) => p.id);
  const [pMixed] = parcelIds.length ? await conn.query('SELECT DISTINCT parcel_id AS id FROM parcel_items WHERE parcel_id IN (?) AND claim_id NOT IN (?)', [parcelIds, cids]) : [[]];
  for (const m of pMixed) blockers.push({ kind: 'parcel', id: m.id, message: `parcel #${m.id} also holds items from other orders` });
  const [boxes] = await conn.query('SELECT DISTINCT box_id AS id FROM box_items WHERE claim_id IN (?)', [cids]); const boxIds = boxes.map((b) => b.id);
  const [bMixed] = boxIds.length ? await conn.query('SELECT DISTINCT box_id AS id FROM box_items WHERE box_id IN (?) AND claim_id NOT IN (?)', [boxIds, cids]) : [[]];
  for (const m of bMixed) blockers.push({ kind: 'box', id: m.id, message: `warehouse box #${m.id} also holds items from other orders` });
  // proxy payments
  const [pps] = await conn.query('SELECT DISTINCT proxy_payment_id AS id FROM proxy_payment_items WHERE item_id IN (?)', [ids]); const ppIds = pps.map((p) => p.id);
  const [ppMixed] = ppIds.length ? await conn.query('SELECT DISTINCT proxy_payment_id AS id FROM proxy_payment_items WHERE proxy_payment_id IN (?) AND item_id NOT IN (?)', [ppIds, ids]) : [[]];
  for (const m of ppMixed) blockers.push({ kind: 'proxy_payment', id: m.id, message: `proxy payment #${m.id} also covers items from other orders` });
  const [[money]] = await conn.query('SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE id IN (?)', [pids]);
  const [[ledger]] = await conn.query('SELECT COUNT(*) AS n FROM credit_ledger WHERE claim_id IN (?) OR payment_id IN (?)', [cids, pids]);
  return {
    orderId, title: o.title, itemIds, claimIds, paymentIds, parcelIds, boxIds, proxyPaymentIds: ppIds, joinerIds: [...new Set(claims.map((c) => c.joiner_id))], blockers,
    removes: { items: itemIds.length, claims: claimIds.length, people: new Set(claims.map((c) => c.joiner_id)).size, payments: paymentIds.length, money: round2(money.n), ledgerRows: ledger.n, parcels: parcelIds.length, boxes: boxIds.length, proxyPayments: ppIds.length },
  };
}

export async function deleteTestOrder(conn, { orderId, confirm }) {
  const plan = await testDeletePlan(conn, orderId, { lock: true });
  if (normal(confirm) !== normal(plan.title)) throw bad(`To confirm, type the order name exactly: ${plan.title}`, 'confirm_mismatch');
  if (plan.blockers.length) throw conflict(`Nothing was deleted: ${plan.blockers.slice(0, 3).map((b) => b.message).join('; ')}${plan.blockers.length > 3 ? `; and ${plan.blockers.length - 3} more` : ''}.`, 'cannot_delete');
  const cids = plan.claimIds.length ? plan.claimIds : [0], pids = plan.paymentIds.length ? plan.paymentIds : [0], ids = plan.itemIds.length ? plan.itemIds : [0];
  await conn.query('DELETE FROM credit_ledger WHERE claim_id IN (?) OR payment_id IN (?)', [cids, pids]);          // the credit these moved goes back to how it was before this order existed
  await conn.query('DELETE FROM payment_allocations WHERE payment_id IN (?) OR claim_id IN (?)', [pids, cids]);
  await conn.query('DELETE FROM payments WHERE id IN (?)', [pids]);
  if (plan.parcelIds.length) { await conn.query('DELETE FROM parcel_companions WHERE parcel_id IN (?)', [plan.parcelIds]); await conn.query('DELETE FROM parcel_items WHERE parcel_id IN (?)', [plan.parcelIds]); await conn.query('DELETE FROM parcels WHERE id IN (?)', [plan.parcelIds]); }
  if (plan.boxIds.length) { await conn.query('DELETE FROM box_items WHERE box_id IN (?)', [plan.boxIds]); await conn.query('DELETE FROM boxes WHERE id IN (?)', [plan.boxIds]); }
  if (plan.proxyPaymentIds.length) { await conn.query('DELETE FROM proxy_payment_items WHERE proxy_payment_id IN (?)', [plan.proxyPaymentIds]); await conn.query('DELETE FROM proxy_payments WHERE id IN (?)', [plan.proxyPaymentIds]); }
  await conn.query("DELETE FROM import_records WHERE (kind = 'claim' AND entity_id IN (?)) OR (kind = 'item' AND entity_id IN (?)) OR (kind = 'order' AND entity_id = ?)", [cids, ids, orderId]);
  if (plan.claimIds.length) await conn.query('DELETE FROM claims WHERE id IN (?)', [plan.claimIds]);
  const [pics] = await conn.query('SELECT image_id AS id FROM items WHERE id IN (?) AND image_id IS NOT NULL UNION SELECT cover_image_id FROM group_orders WHERE id = ? AND cover_image_id IS NOT NULL', [ids, orderId]);
  if (plan.itemIds.length) await conn.query('DELETE FROM items WHERE id IN (?)', [plan.itemIds]);
  await conn.query('DELETE FROM group_orders WHERE id = ?', [orderId]);
  let files = [];
  if (pics.length) { [files] = await conn.query('SELECT filename FROM images WHERE id IN (?)', [pics.map((p) => p.id)]); await conn.query('DELETE FROM images WHERE id IN (?)', [pics.map((p) => p.id)]); }
  // nobody's credit may end up negative: that would mean it was tied up with something we didn't remove — so undo everything
  for (const jid of plan.joinerIds) {
    const [[b]] = await conn.query('SELECT COALESCE(SUM(balance_effect), 0) AS n FROM credit_ledger WHERE joiner_id = ?', [jid]);
    if (b.n < -0.004) throw conflict("Nothing was deleted: removing this would leave someone's credit negative — it's tied up with another order. Use Reset for launch instead.", 'credit_tied_up');
  }
  return { plan, files: files.map((f) => f.filename) };
}
