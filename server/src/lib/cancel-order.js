import { conflict, notFound, bad } from '../errors.js';
import { lockJoiner } from './ledger.js';
import { round2 } from './money.js';
import { cancelClaim } from './cancel.js';

const normal = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const ACTIVE_PARCEL = "('requested','packed','shipped')";

// What cancelling a whole group order (`orderId`) or one item (`itemId`) would do — shown to the GOM before anything happens, and re-checked (with everything locked) when they confirm.
// Every claim still alive on it (unconfirmed or confirmed, but NOT ones already received — the person has those) is cancelled; what was paid goes back to the person as credit (a blocked handle's is forfeited, as always).
// All-or-nothing: if any of those claims is inside a parcel or a warehouse box, NOTHING is cancelled and the plan says which.
export async function cancelPlan(conn, { orderId = null, itemId = null, lock = false }) {
  let kind, id, title, itemIds;
  if (itemId) {
    const [[it]] = await conn.query('SELECT i.id, i.title, i.cancelled_at, go.cancelled_at AS go_cancelled FROM items i JOIN group_orders go ON go.id = i.order_id WHERE i.id = ?', [itemId]);
    if (!it) throw notFound('No such item');
    if (it.cancelled_at || it.go_cancelled) throw conflict('That item has already been cancelled.', 'already_cancelled');
    kind = 'item'; id = it.id; title = it.title; itemIds = [it.id];
  } else {
    const [[o]] = await conn.query('SELECT id, title, cancelled_at FROM group_orders WHERE id = ?', [orderId]);
    if (!o) throw notFound('No such group order');
    if (o.cancelled_at) throw conflict('That group order has already been cancelled.', 'already_cancelled');
    const [its] = await conn.query('SELECT id FROM items WHERE order_id = ? ORDER BY id', [orderId]);
    kind = 'order'; id = o.id; title = o.title; itemIds = its.map((x) => x.id);
  }
  const ids = itemIds.length ? itemIds : [0];
  if (lock) {                                                                    // items first (like every claim placement), then people lowest-first, then claims
    await conn.query('SELECT id FROM items WHERE id IN (?) ORDER BY id FOR UPDATE', [ids]);                 // items BEFORE the order: placing a claim locks the item, then touches the order
    if (kind === 'order') await conn.query('SELECT id FROM group_orders WHERE id = ? FOR UPDATE', [id]);
    const [who] = await conn.query("SELECT DISTINCT joiner_id FROM claims WHERE item_id IN (?) AND status IN ('requested','confirmed') AND pipeline <> 'completed' ORDER BY joiner_id", [ids]);
    for (const { joiner_id } of who) await lockJoiner(conn, joiner_id);
    await conn.query("SELECT id FROM claims WHERE item_id IN (?) AND status IN ('requested','confirmed') AND pipeline <> 'completed' ORDER BY id FOR UPDATE", [ids]);
    // someone else may have cancelled it while we waited for the locks — look again now that nothing can change under us
    const [[fresh]] = kind === 'order' ? await conn.query('SELECT cancelled_at, NULL AS go FROM group_orders WHERE id = ?', [id])
      : await conn.query('SELECT i.cancelled_at, go.cancelled_at AS go FROM items i JOIN group_orders go ON go.id = i.order_id WHERE i.id = ?', [id]);
    if (fresh.cancelled_at || fresh.go) throw conflict(`That ${kind === 'order' ? 'group order' : 'item'} has already been cancelled.`, 'already_cancelled');
  }
  const [claims] = await conn.query(
    `SELECT c.id, c.joiner_id AS joinerId, j.instagram_handle AS handle, j.is_blocked AS blocked, c.status, c.label, c.box_id AS boxId,
            (SELECT COALESCE(SUM(paid), 0) FROM claim_costs WHERE claim_id = c.id) AS paid,
            (SELECT pi.parcel_id FROM parcel_items pi JOIN parcels p ON p.id = pi.parcel_id WHERE pi.claim_id = c.id AND p.status IN ${ACTIVE_PARCEL} LIMIT 1) AS parcelId
       FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE c.item_id IN (?) AND c.status IN ('requested', 'confirmed') AND c.pipeline <> 'completed' ORDER BY c.id`, [ids]);
  const blockers = [];
  for (const c of claims) {
    if (c.parcelId) blockers.push({ claimId: c.id, handle: c.handle, label: c.label, reason: `it is in parcel #${c.parcelId} — take it out of the parcel first` });
    else if (c.boxId) blockers.push({ claimId: c.id, handle: c.handle, label: c.label, reason: `it is in warehouse box #${c.boxId} — undo the box first` });
  }
  const paid = round2(claims.reduce((s, c) => s + Number(c.paid), 0));
  const forfeited = round2(claims.filter((c) => c.blocked).reduce((s, c) => s + Number(c.paid), 0));
  return {
    kind, id, title, itemIds, claims, blockers,
    summary: { claims: claims.length, requested: claims.filter((c) => c.status === 'requested').length, confirmed: claims.filter((c) => c.status === 'confirmed').length,
      people: new Set(claims.map((c) => c.joinerId)).size, items: itemIds.length, paid, credit: round2(paid - forfeited), forfeited },
  };
}

// Does it. The GOM must have typed the exact name (so a stray click can't do this). No emails are sent — the GOM tells people themselves.
export async function cancelNow(conn, { orderId = null, itemId = null, confirm, adminId }) {
  const plan = await cancelPlan(conn, { orderId, itemId, lock: true });
  if (normal(confirm) !== normal(plan.title)) throw bad(`To confirm, type the ${plan.kind === 'order' ? 'order' : 'item'} name exactly: ${plan.title}`, 'confirm_mismatch');
  if (plan.blockers.length) throw conflict(`Nothing was cancelled: ${plan.blockers.slice(0, 3).map((b) => `“${b.label}” (@${b.handle}) — ${b.reason}`).join('; ')}${plan.blockers.length > 3 ? `; and ${plan.blockers.length - 3} more` : ''}.`, 'cannot_cancel');
  let credit = 0, forfeited = 0;
  for (const c of plan.claims) {
    const r = await cancelClaim(conn, c.id, `Cancelled by the GOM (${plan.kind === 'order' ? 'the group order' : 'the item'} could not go ahead)`);
    credit = round2(credit + r.refunded); forfeited = round2(forfeited + r.forfeited);
  }
  await conn.query('UPDATE items SET cancelled_at = NOW(3) WHERE id IN (?)', [plan.itemIds.length ? plan.itemIds : [0]]);
  await conn.query('UPDATE fixed_claims SET ended_at = NOW(3) WHERE item_id IN (?) AND ended_at IS NULL', [plan.itemIds.length ? plan.itemIds : [0]]);   // standing claims on it end too
  if (plan.kind === 'order') await conn.query("UPDATE group_orders SET status = 'closed', cancelled_at = NOW(3) WHERE id = ?", [plan.id]);
  return { kind: plan.kind, id: plan.id, title: plan.title, claims: plan.claims.length, people: plan.summary.people, credit, forfeited };
}
