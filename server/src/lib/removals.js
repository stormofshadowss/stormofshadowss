import { audit } from '../auth.js';
import { bad, conflict, notFound } from '../errors.js';
import { lockJoiner, sweepCredit, reduceCost } from './ledger.js';
import { stampFeeDue } from './due.js';
import { boxSplit } from './box.js';
import { feesSet } from './combine.js';
import { resplitFees } from './parcels.js';
import { round2 } from './money.js';

// TAKING ONE ITEM OUT of an incoming box or a requested shipping list — for when something was marked "in the box" / "on hand" by mistake.
// Both put the claim back to a stage the GOM picks, share the money out again among what's left, return anything already paid beyond the new figure as credit, and say (in `changes`) what moved for whom.
// Run inside a transaction; a preview runs the same thing and rolls it back, so it can't disagree with what then happens.
export const READY = 'ready to pack / on hand';
export const BOX_STAGES = ['arrived at proxy / warehouse', 'ordered via proxy / warehouse', 'awaiting fulfillment'];
export const PARCEL_STAGES = [READY, 'awaiting fulfillment', 'ordered via proxy / warehouse', 'arrived at proxy / warehouse', 'arrived at GOM', 'checking parcel'];
const BEFORE_BOX = new Set(['awaiting fulfillment', 'ordered via proxy / warehouse', 'arrived at proxy / warehouse']);

// each person's fees of the given kinds (across all their claims) and how much of them they had PAID — before and after, so we can say what changed.
// What they had paid towards a fee that has come off is returned to their credit (and, as always, credit meets whatever else they owe).
async function snapshot(conn, joinerIds, categories) {
  const [fees] = await conn.query('SELECT j.id AS joinerId, j.instagram_handle AS handle, COALESCE(SUM(cc.cost), 0) AS fees, COALESCE(SUM(cc.paid), 0) AS paid FROM joiners j LEFT JOIN claims c ON c.joiner_id = j.id LEFT JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category IN (?) WHERE j.id IN (?) GROUP BY j.id, j.instagram_handle', [categories, joinerIds]);
  return new Map(fees.map((f) => [f.joinerId, { handle: f.handle, fees: Number(f.fees), paid: Number(f.paid) }]));
}
const changesBetween = (before, after) => [...before].map(([id, b]) => { const a = after.get(id) || b; return { handle: b.handle, feeChange: round2(a.fees - b.fees), creditBack: round2(Math.max(0, b.paid - a.paid)) }; }).filter((c) => c.feeChange !== 0 || c.creditBack > 0).sort((x, y) => x.handle.localeCompare(y.handle));

// An item that is NOT in this box after all. Its EMS and customs come off; the box's totals stay fully charged, so they are shared out again among the items still in it (anyone ticked "no EMS" / "no customs" stays out).
// If it was the last item, the box goes too. It can't be in a shipping request (take it out of that first).
export async function removeFromBox(conn, { boxId, claimId, stage = BOX_STAGES[0], adminId }) {
  if (!BOX_STAGES.includes(stage)) throw bad('Choose where the item should go back to.', 'bad_stage');
  const [[bx0]] = await conn.query('SELECT id FROM boxes WHERE id = ?', [boxId]); if (!bx0) throw notFound('No such box');
  const [who] = await conn.query('SELECT DISTINCT c.joiner_id FROM box_items bi JOIN claims c ON c.id = bi.claim_id WHERE bi.box_id = ? ORDER BY c.joiner_id', [boxId]);
  for (const { joiner_id } of who) await lockJoiner(conn, joiner_id);                                       // the people first, lowest id first
  const [[bx]] = await conn.query('SELECT id, status, ems_total, customs_total, total_weight_g FROM boxes WHERE id = ? FOR UPDATE', [boxId]);
  const [items] = await conn.query(
    `SELECT bi.claim_id AS id, bi.ems_share AS ems, bi.customs_share AS customs, bi.ems_excluded AS emsExcluded, bi.customs_excluded AS customsExcluded, c.joiner_id AS joinerId, COALESCE(c.weight_g, it.weight_g) AS weight, c.size_bucket AS size, c.label, j.instagram_handle AS handle, (SELECT cost FROM claim_costs WHERE claim_id = c.id AND category = 'initials') AS price
       FROM box_items bi JOIN claims c ON c.id = bi.claim_id LEFT JOIN items it ON it.id = c.item_id JOIN joiners j ON j.id = c.joiner_id WHERE bi.box_id = ? ORDER BY bi.claim_id`, [boxId]);
  const gone = items.find((i) => i.id === claimId); if (!gone) throw notFound("That item isn't in this box");
  const [[par]] = await conn.query("SELECT p.id FROM parcel_items pi JOIN parcels p ON p.id = pi.parcel_id WHERE pi.claim_id = ? AND p.status IN ('requested', 'packed', 'shipped') LIMIT 1", [claimId]);
  if (par) throw conflict(`“${gone.label}” (@${gone.handle}) is already in shipping request #${par.id} — take it out of the request first (Packing tab), then out of the box.`, 'in_parcel');
  const people = [...new Set(items.map((i) => i.joinerId))].sort((a, b) => a - b), before = await snapshot(conn, people, ['ems', 'customs']);
  const rest = items.filter((i) => i.id !== claimId);
  if (gone.ems > 0) await reduceCost(conn, gone.joinerId, gone.id, 'ems', gone.ems, 'EMS removed — taken out of the box', 'Taken out of box');
  if (gone.customs > 0) await reduceCost(conn, gone.joinerId, gone.id, 'customs', gone.customs, 'Customs removed — taken out of the box', 'Taken out of box');
  await conn.query('DELETE FROM box_items WHERE box_id = ? AND claim_id = ?', [boxId, claimId]);
  await conn.query('UPDATE claims SET pipeline = ?, box_id = NULL, ready_to_pack_date = NULL WHERE id = ?', [stage, claimId]);
  let boxRemoved = false;
  if (!rest.length) { await conn.query('DELETE FROM boxes WHERE id = ?', [boxId]); boxRemoved = true; }
  else {
    const s = boxSplit(rest.map((i) => ({ id: i.id, weight: i.weight, size: i.size, price: Number(i.price), noEms: !!i.emsExcluded, noCustoms: !!i.customsExcluded })), { emsTotal: Number(bx.ems_total), customsTotal: Number(bx.customs_total || 0), boxTotal: bx.total_weight_g || 0 });
    for (const [k, it] of rest.entries()) {
      for (const [cat, col, shares] of [['ems', 'ems_share', s.emsShares], ['customs', 'customs_share', s.customsShares]]) {
        const delta = round2(shares[k] - Number(cat === 'ems' ? it.ems : it.customs));
        if (delta > 0) { await conn.query('UPDATE claim_costs SET cost = ROUND(cost + ?, 2) WHERE claim_id = ? AND category = ?', [delta, it.id, cat]); await stampFeeDue(conn, it.id, cat, null); }
        else if (delta < 0) await reduceCost(conn, it.joinerId, it.id, cat, -delta, `${cat === 'ems' ? 'EMS' : 'Customs'} reduced — an item was taken out of the box`, 'Box item removed');
        await conn.query(`UPDATE box_items SET ${col} = ? WHERE box_id = ? AND claim_id = ?`, [shares[k], boxId, it.id]);
      }
      await conn.query('UPDATE box_items SET weight_used_g = ? WHERE box_id = ? AND claim_id = ?', [Math.round(s.weights[it.id]), boxId, it.id]);
    }
  }
  for (const id of people) await sweepCredit(conn, id);
  const after = await snapshot(conn, people, ['ems', 'customs']);
  await audit(conn, adminId, 'box.remove_item', 'box', boxId, { claimId, stage, boxRemoved });
  return { label: gone.label, handle: gone.handle, stage, boxRemoved, left: rest.length, changes: changesBetween(before, after) };
}

// An item that shouldn't be in this request (e.g. marked "on hand" by mistake). Its postage and packaging come off, the parcel's totals are shared out again among what's left, and the claim goes back to the stage you pick
// (or stays "ready to pack" if it really is on hand). A friend whose last item goes is taken out of the parcel; if it was the only item the request is removed. Only while the parcel hasn't been packed.
export async function removeFromParcel(conn, { parcelId, claimId, stage = BOX_STAGES[0], adminId }) {
  if (!PARCEL_STAGES.includes(stage)) throw bad('Choose where the item should go back to.', 'bad_stage');
  const [[p0]] = await conn.query('SELECT id FROM parcels WHERE id = ?', [parcelId]); if (!p0) throw notFound('No such shipping request');
  const [who] = await conn.query('SELECT DISTINCT c.joiner_id FROM parcel_items pi JOIN claims c ON c.id = pi.claim_id WHERE pi.parcel_id = ? ORDER BY c.joiner_id', [parcelId]);
  for (const { joiner_id } of who) await lockJoiner(conn, joiner_id);                                       // the people first, lowest id first — then the parcel
  const [[p]] = await conn.query('SELECT id, joiner_id, status, doms_total, packaging_total FROM parcels WHERE id = ? FOR UPDATE', [parcelId]);
  if (p.status !== 'requested') throw conflict("That request has already been packed, so an item can't be taken out of it here.", 'too_late');
  const [items] = await conn.query(
    `SELECT pi.claim_id AS id, pi.doms_share AS doms, pi.packaging_share AS packaging, c.joiner_id AS joinerId, c.label, c.box_id AS boxId, j.instagram_handle AS handle
       FROM parcel_items pi JOIN claims c ON c.id = pi.claim_id JOIN joiners j ON j.id = c.joiner_id WHERE pi.parcel_id = ? ORDER BY pi.claim_id`, [parcelId]);
  const gone = items.find((i) => i.id === claimId); if (!gone) throw notFound("That item isn't in this request");
  const rest = items.filter((i) => i.id !== claimId), theirs = items.filter((i) => i.joinerId === gone.joinerId);
  if (gone.joinerId === p.joiner_id && theirs.length === 1 && rest.length) throw conflict(`That is all of @${gone.handle}'s items, and the parcel is posted to their address while others share it — split the others off first, or take everything out.`, 'owner_last_item');
  if (gone.boxId && BEFORE_BOX.has(stage)) throw conflict(`“${gone.label}” is recorded as being in box #${gone.boxId} — take it out of the box first (Warehouse tab), or choose a later stage here.`, 'in_box');
  const people = [...new Set(items.map((i) => i.joinerId))].sort((a, b) => a - b), before = await snapshot(conn, people, ['doms', 'packaging']);
  if (gone.doms > 0) await reduceCost(conn, gone.joinerId, gone.id, 'doms', gone.doms, 'Postage removed — item taken out of the request', 'Taken out of request');
  if (gone.packaging > 0) await reduceCost(conn, gone.joinerId, gone.id, 'packaging', gone.packaging, 'Packaging removed — item taken out of the request', 'Taken out of request');
  await conn.query('DELETE FROM parcel_items WHERE parcel_id = ? AND claim_id = ?', [parcelId, claimId]);
  if (stage === READY) await conn.query('UPDATE claims SET pipeline = ?, ready_to_pack_date = COALESCE(ready_to_pack_date, CURDATE()) WHERE id = ?', [READY, claimId]);
  else await conn.query('UPDATE claims SET pipeline = ?, ready_to_pack_date = NULL WHERE id = ?', [stage, claimId]);          // it wasn't on hand, so its storage clock goes too
  let companionRemoved = null, parcelRemoved = false;
  if (!rest.length) { await conn.query('DELETE FROM parcels WHERE id = ?', [parcelId]); parcelRemoved = true; }
  else {
    if (theirs.length === 1 && gone.joinerId !== p.joiner_id) { await conn.query('DELETE FROM parcel_companions WHERE parcel_id = ? AND joiner_id = ?', [parcelId, gone.joinerId]); companionRemoved = gone.handle; }
    if (feesSet(p)) { await resplitFees(conn, parcelId); await conn.query('UPDATE parcels SET fees_check_needed = 1 WHERE id = ?', [parcelId]); }
  }
  for (const id of people) await sweepCredit(conn, id);
  const after = await snapshot(conn, people, ['doms', 'packaging']);
  await audit(conn, adminId, 'parcel.remove_item', 'parcel', parcelId, { claimId, stage, parcelRemoved, companionRemoved });
  return { label: gone.label, handle: gone.handle, stage, parcelRemoved, companionRemoved, left: rest.length, changes: changesBetween(before, after) };
}
