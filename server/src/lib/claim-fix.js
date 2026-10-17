import { bad, notFound, conflict } from '../errors.js';
import { lockJoiner, setCost, sweepCredit, addLedger } from './ledger.js';
import { round2 } from './money.js';
import { checkPurchaseLimit } from './claim-create.js';

// Fixing mistakes in a claim (typically from an import): change WHAT it is, delete it outright, or turn a "filler" line into credit.
// A true delete is only allowed when nothing would be lost — no money paid, no parcel, no box, no applied payment, no credit history — and says why when it is not.
const money = (n) => `£${Number(n).toFixed(2)}`;

export async function deleteReasons(conn, claimId) {
  const [[c]] = await conn.query('SELECT c.id, c.label, c.status, c.joiner_id, c.set_id, c.box_id, j.instagram_handle AS handle FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE c.id = ?', [claimId]);
  if (!c) return null;
  const reasons = [];
  const [[p]] = await conn.query('SELECT COALESCE(SUM(paid), 0) AS paid FROM claim_costs WHERE claim_id = ?', [claimId]);
  if (p.paid > 0.004) reasons.push(`${money(p.paid)} has been paid towards it — cancel it instead (what was paid goes back to them as credit).`);
  const [par] = await conn.query('SELECT parcel_id FROM parcel_items WHERE claim_id = ? LIMIT 1', [claimId]);
  if (par.length) reasons.push(`It's in parcel #${par[0].parcel_id}.`);
  const [[bx]] = await conn.query('SELECT COUNT(*) AS n FROM box_items WHERE claim_id = ?', [claimId]);
  if (bx.n || c.box_id) reasons.push("It's in a box (Warehouse tab).");
  const [[al]] = await conn.query('SELECT COUNT(*) AS n FROM payment_allocations WHERE claim_id = ?', [claimId]);
  if (al.n) reasons.push('A payment has been applied to it.');
  const [[lg]] = await conn.query('SELECT COUNT(*) AS n FROM credit_ledger WHERE claim_id = ?', [claimId]);
  if (lg.n) reasons.push('It has credit or fee history, which has to be kept.');
  const [[cr]] = await conn.query("SELECT COUNT(*) AS n FROM cancel_requests WHERE claim_id = ? AND status = 'pending'", [claimId]);
  if (cr.n) reasons.push("They've asked to cancel it — answer that first (top of the Claims tab).");
  if (c.set_id) reasons.push("It's a member-set part — manage it on the Sets tab (Cancel set, or put people in and out there).");
  return { claim: c, reasons };
}

export async function changeReasons(conn, c) {
  const reasons = [];
  if (c.status === 'cancelled') reasons.push("It's cancelled.");
  if (c.leftover_item_id) reasons.push("On-hand Shop items can't be changed here.");
  if (c.set_id) reasons.push("It's a member-set part — manage it on the Sets tab.");
  const [par] = await conn.query('SELECT parcel_id FROM parcel_items WHERE claim_id = ? LIMIT 1', [c.id]);
  if (par.length) reasons.push(`It's in parcel #${par[0].parcel_id}.`);
  const [[bx]] = await conn.query('SELECT COUNT(*) AS n FROM box_items WHERE claim_id = ?', [c.id]);
  if (bx.n || c.box_id) reasons.push("It's in a box (Warehouse tab).");
  const [[cr]] = await conn.query("SELECT COUNT(*) AS n FROM cancel_requests WHERE claim_id = ? AND status = 'pending'", [c.id]);
  if (cr.n) reasons.push("They've asked to cancel it — answer that first (top of the Claims tab).");
  return reasons;
}

// What can be done with this claim, and what stops each? (for the panel)
export async function fixPlan(conn, claimId) {
  const d = await deleteReasons(conn, claimId); if (!d) return null;
  const [[c]] = await conn.query('SELECT c.id, c.status, c.label, c.set_id, c.box_id, c.leftover_item_id, c.item_id, c.order_id, c.member_name AS member, c.variant_label AS variant, go.title AS orderTitle FROM claims c LEFT JOIN group_orders go ON go.id = c.order_id WHERE c.id = ?', [claimId]);
  const [[t]] = await conn.query('SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(paid), 0) AS paid FROM claim_costs WHERE claim_id = ?', [claimId]);
  const ch = await changeReasons(conn, c);
  return { id: c.id, label: c.label, handle: d.claim.handle, orderTitle: c.orderTitle, status: c.status, itemId: c.item_id, orderId: c.order_id, member: c.member, variant: c.variant, cost: round2(t.cost), paid: round2(t.paid),
    delete: { ok: !d.reasons.length, reasons: d.reasons }, change: { ok: !ch.length, reasons: ch }, credit: { ok: !d.reasons.length, reasons: d.reasons, amount: round2(t.cost) } };
}

// Delete claims for good (those that can be); the rest are returned with their reasons. dryRun only reports. People are locked first (lowest id first), then claims — like every money flow.
export async function deleteClaims(conn, claimIds, { dryRun = false } = {}) {
  const ids = [...new Set(claimIds)].sort((a, b) => a - b);
  if (!dryRun) {
    const [rows] = await conn.query('SELECT id, joiner_id FROM claims WHERE id IN (?)', [ids]);
    for (const jid of [...new Set(rows.map((r) => r.joiner_id))].sort((a, b) => a - b)) await lockJoiner(conn, jid);
    await conn.query('SELECT id FROM claims WHERE id IN (?) ORDER BY id FOR UPDATE', [ids]);
  }
  const deleted = [], refused = [];
  for (const id of ids) {
    const d = await deleteReasons(conn, id);
    if (!d) { refused.push({ id, label: null, handle: null, reasons: ['There is no such claim.'] }); continue; }
    if (d.reasons.length) { refused.push({ id, label: d.claim.label, handle: d.claim.handle, reasons: d.reasons }); continue; }
    if (!dryRun) {
      try { await conn.query('DELETE FROM claims WHERE id = ?', [id]); }
      catch (e) { if (e.errno === 1451) { refused.push({ id, label: d.claim.label, handle: d.claim.handle, reasons: ['It was just put in a parcel or box — try again.'] }); continue; } throw e; }
    }
    deleted.push({ id, label: d.claim.label, handle: d.claim.handle });
  }
  return { deleted, refused };
}

// A "filler" line that stands for credit: add that credit to the person's account and remove the line, in one go. (Only when nothing has been paid on it — if something has, cancel it: that returns the money as credit.)
export async function claimToCredit(conn, claimId, { amount, reason }, accountId, audit) {
  const [[peek]] = await conn.query('SELECT joiner_id FROM claims WHERE id = ?', [claimId]); if (!peek) throw notFound('No such claim');
  await lockJoiner(conn, peek.joiner_id);
  await conn.query('SELECT id FROM claims WHERE id = ? FOR UPDATE', [claimId]);
  const d = await deleteReasons(conn, claimId); if (d.reasons.length) throw conflict(d.reasons[0], 'cannot_delete');
  await addLedger(conn, { joinerId: peek.joiner_id, kind: 'credit', amount, effect: amount, reason, source: 'Admin credit' });
  await conn.query('DELETE FROM claims WHERE id = ?', [claimId]);
  await sweepCredit(conn, peek.joiner_id);
  await audit(conn, accountId, 'claim.to_credit', 'joiner', peek.joiner_id, { claimId, amount });
  return { handle: d.claim.handle, label: d.claim.label, amount };
}

// Change WHAT a claim is: another item (and so possibly another group order), size or member. If the item changes, the GOM chooses each time whether to re-price it or keep the old price.
export async function changeClaim(conn, claimId, b, accountId, audit) {
  const [[peek]] = await conn.query('SELECT joiner_id, item_id FROM claims WHERE id = ?', [claimId]); if (!peek) throw notFound('No such claim');
  const itemIds = [...new Set([peek.item_id, b.itemId].filter(Boolean))].sort((x, y) => x - y);
  if (itemIds.length) await conn.query('SELECT id FROM items WHERE id IN (?) ORDER BY id FOR UPDATE', [itemIds]);       // items first, then the person, then the claim
  await lockJoiner(conn, peek.joiner_id);
  const [[c]] = await conn.query('SELECT id, joiner_id, status, label, item_id, order_id, set_id, box_id, leftover_item_id, price_tbc, size_bucket FROM claims WHERE id = ? FOR UPDATE', [claimId]);
  const why = await changeReasons(conn, c); if (why.length) throw conflict(why[0], 'cannot_change');
  const [[item]] = await conn.query('SELECT i.id, i.order_id, i.item_type, i.title, i.price, i.price_tbc, i.size_bucket, i.purchase_limit, i.limit_scope, i.cancelled_at, go.cancelled_at AS go_cancelled FROM items i JOIN group_orders go ON go.id = i.order_id WHERE i.id = ?', [b.itemId]);
  if (!item) throw notFound("That item doesn't exist");
  if (item.cancelled_at || item.go_cancelled) throw bad("That item isn't available any more", 'item_cancelled');
  if (item.item_type === 'set') throw bad("A claim can't be changed into a member-set part — use the Sets tab (Add someone) for that.", 'is_set');
  if (item.price_tbc && c.status === 'confirmed') throw conflict("That item's price is still TBC — a confirmed claim can't move to it until it has a price.", 'price_tbc');
  let member = null, variant = null;
  if (item.item_type === 'independent') {
    const [[m]] = await conn.query('SELECT name FROM item_members WHERE item_id = ? AND name = ?', [item.id, b.member || '']); if (!m) throw bad(`Choose a member for "${item.title}"`);
    member = m.name;
  } else if (item.item_type === 'size') {
    const [[v]] = await conn.query('SELECT label FROM item_variants WHERE item_id = ? AND label = ?', [item.id, b.variant || '']); if (!v) throw bad(`Choose a size for "${item.title}"`);
    variant = v.label;
  }
  const label = `${item.title}${member ? ` — ${member}` : ''}${variant ? ` (${variant})` : ''}`;
  const changedItem = item.id !== c.item_id;
  const [[prev]] = await conn.query('SELECT member_name, variant_label FROM claims WHERE id = ?', [claimId]);
  if (!changedItem && member === prev.member_name && variant === prev.variant_label) throw bad("That's what it already is.", 'no_change');
  // moving a claim onto an item (or option) that has a purchase limit takes one of its places — refused unless you knowingly go past it (the claim's own current place doesn't count against it)
  await checkPurchaseLimit(conn, item, { [member || variant || '']: 1 }, { asAdmin: true, overrideLimit: !!b.overrideLimit, excludeClaimId: claimId });
  if (changedItem && !b.pricing) throw bad('Choose whether to re-price it or keep the old price.', 'pricing_needed');
  const [[pd]] = await conn.query('SELECT COALESCE(SUM(paid), 0) AS paid FROM claim_costs WHERE claim_id = ?', [claimId]);
  if (changedItem && b.pricing === 'reprice' && item.price_tbc && pd.paid > 0.004) throw conflict(`That item's price is TBC, so it can't be re-priced while ${money(pd.paid)} is paid on this claim — choose "keep the old price".`, 'price_tbc');
  await conn.query('UPDATE claims SET item_id = ?, order_id = ?, label = ?, member_name = ?, variant_label = ?, size_bucket = ?, price_tbc = ? WHERE id = ?',
    [item.id, item.order_id, label, member, variant, changedItem ? item.size_bucket : c.size_bucket, item.price_tbc ? 1 : 0, claimId]);       // the size band follows the item only when the item changes
  let repriced = false;
  if (changedItem && b.pricing === 'reprice') { await setCost(conn, claimId, 'initials', { cost: item.price_tbc ? 0 : item.price }); repriced = true; }
  await audit(conn, accountId, 'claim.change', 'claim', claimId, { fromItem: c.item_id, toItem: item.id, from: c.label, to: label, pricing: changedItem ? b.pricing : null });
  return { label, repriced, changedItem };
}
