import { round2, splitAmount } from './money.js';
import { lockJoiner, sweepCredit, reduceCost } from './ledger.js';
import { SIZE_WEIGHTS } from './box.js';

// 1-based place in the packing queue: oldest request first, ties broken by id.
export async function queuePosition(conn, parcel) {
  if (parcel.status !== 'requested') return null;
  const [[r]] = await conn.query(
    `SELECT COUNT(*) AS ahead FROM parcels
      WHERE status = 'requested' AND (requested_at < ? OR (requested_at = ? AND id < ?))`,
    [parcel.requested_at, parcel.requested_at, parcel.id]);
  return r.ahead + 1;
}

// A parcel carries two fees the GOM types in by hand each time: postage (Doms) and packaging.
// Each is one figure for the whole parcel. How it is shared depends on who is in the parcel:
//   · one person: equally across their items;
//   · several people, UK postage: split equally PER PERSON, then each person's part across their own items (so someone sending five items doesn't pay more than a friend sending one);
//   · several people, worldwide postage ("WW …"), which is priced by weight: split in proportion to each person's WEIGHT, then across their own items.
// The GOM can override the choice on any parcel (parcels.fee_split). Re-saving a figure only moves each item by the DIFFERENCE, so it's safe to correct.
// (Column names come from this fixed list, never from input.)
const FEES = {
  doms: { total: 'doms_total', share: 'doms_share', reason: 'Postage' },
  packaging: { total: 'packaging_total', share: 'packaging_share', reason: 'Packaging' },
};
export const isWorldwide = (method) => /^ww\b/i.test(method || '');
export const feeModeOf = (parcel) => parcel.fee_split || (isWorldwide(parcel.method) ? 'weight' : 'equal');

// who owns each item in a parcel, lowest person first (the order every money flow locks people in)
async function parcelPeople(conn, parcelId) {
  const [rows] = await conn.query('SELECT pi.claim_id AS claimId, c.joiner_id AS joinerId FROM parcel_items pi JOIN claims c ON c.id = pi.claim_id WHERE pi.parcel_id = ? ORDER BY c.joiner_id, pi.claim_id', [parcelId]);
  const people = [...new Set(rows.map((r) => r.joinerId))];
  return { people, ownerOf: new Map(rows.map((r) => [r.claimId, r.joinerId])) };
}

// Each person's weight in grams: what the GOM weighed if they typed it in, otherwise the sum of their items' weights (an exact weight if known, else the size's usual weight).
export async function personWeights(conn, parcelId) {
  const [[parcel]] = await conn.query('SELECT joiner_id, weight_g FROM parcels WHERE id = ?', [parcelId]);
  const [comps] = await conn.query('SELECT joiner_id, weight_g FROM parcel_companions WHERE parcel_id = ?', [parcelId]);
  const explicit = new Map([[parcel.joiner_id, parcel.weight_g], ...comps.map((c) => [c.joiner_id, c.weight_g])]);
  const [items] = await conn.query('SELECT c.joiner_id AS joinerId, c.weight_g AS weight, c.size_bucket AS size FROM parcel_items pi JOIN claims c ON c.id = pi.claim_id WHERE pi.parcel_id = ?', [parcelId]);
  const estimate = new Map();
  for (const it of items) estimate.set(it.joinerId, (estimate.get(it.joinerId) || 0) + (it.weight ?? SIZE_WEIGHTS[it.size] ?? SIZE_WEIGHTS.M));
  const out = new Map();
  for (const [joinerId, est] of estimate) { const ex = explicit.get(joinerId); out.set(joinerId, { explicit: ex ?? null, estimated: est, used: ex > 0 ? ex : Math.max(1, est) }); }
  return out;
}

export async function applyFee(conn, parcelId, fee, total) {
  const f = FEES[fee];
  const [[parcel]] = await conn.query('SELECT id, method, fee_split FROM parcels WHERE id = ? FOR UPDATE', [parcelId]);
  const { people, ownerOf } = await parcelPeople(conn, parcelId);
  for (const id of people) await lockJoiner(conn, id);
  const [items] = await conn.query(`SELECT claim_id, ${f.share} AS share FROM parcel_items WHERE parcel_id = ? ORDER BY claim_id FOR UPDATE`, [parcelId]);
  const weights = feeModeOf(parcel) === 'weight' && people.length > 1 ? await personWeights(conn, parcelId) : null;
  const perPerson = splitAmount(total, people.map((id) => (weights ? weights.get(id).used : 1)));
  const newShare = new Map();
  people.forEach((person, i) => {
    const mine = items.filter((it) => ownerOf.get(it.claim_id) === person);
    const parts = splitAmount(perPerson[i], mine.map(() => 1));
    mine.forEach((it, k) => newShare.set(it.claim_id, parts[k]));
  });
  for (const it of items) {
    const share = newShare.get(it.claim_id), owner = ownerOf.get(it.claim_id), delta = round2(share - it.share);
    if (delta > 0) {
      await conn.query('UPDATE claim_costs SET cost = ROUND(cost + ?, 2) WHERE claim_id = ? AND category = ?', [delta, it.claim_id, fee]);
    } else if (delta < 0) {
      // the figure came down: anything already paid beyond the new amount goes to credit
      await reduceCost(conn, owner, it.claim_id, fee, -delta, `${f.reason} reduced`, `${f.reason} correction`);
    }
    await conn.query(`UPDATE parcel_items SET ${f.share} = ? WHERE parcel_id = ? AND claim_id = ?`, [share, parcelId, it.claim_id]);
  }
  await conn.query(`UPDATE parcels SET ${f.total} = ? WHERE id = ?`, [round2(total), parcelId]);
  for (const id of people) await sweepCredit(conn, id);
}
export const applyDoms = (conn, parcelId, total) => applyFee(conn, parcelId, 'doms', total);

// After the split rule or someone's weight changes: share the fees already on the parcel out again (only the differences move; refunds go to credit).
export async function resplitFees(conn, parcelId) {
  const [[p]] = await conn.query('SELECT doms_total, packaging_total FROM parcels WHERE id = ? FOR UPDATE', [parcelId]);
  if (p.doms_total != null) await applyFee(conn, parcelId, 'doms', Number(p.doms_total));
  if (p.packaging_total != null) await applyFee(conn, parcelId, 'packaging', Number(p.packaging_total));
}

// Cancelling a parcel takes both fees off again (returning anything already paid as credit) — from every person who had items in it.
export async function removeFees(conn, parcelId) {
  const { people, ownerOf } = await parcelPeople(conn, parcelId);
  for (const id of people) await lockJoiner(conn, id);
  for (const [fee, f] of Object.entries(FEES)) {
    const [items] = await conn.query(`SELECT claim_id, ${f.share} AS share FROM parcel_items WHERE parcel_id = ? FOR UPDATE`, [parcelId]);
    for (const it of items) {
      if (it.share > 0) await reduceCost(conn, ownerOf.get(it.claim_id), it.claim_id, fee, it.share, `${f.reason} refunded — parcel cancelled`, 'Parcel cancelled');
      await conn.query(`UPDATE parcel_items SET ${f.share} = 0 WHERE parcel_id = ? AND claim_id = ?`, [parcelId, it.claim_id]);
    }
    await conn.query(`UPDATE parcels SET ${f.total} = NULL WHERE id = ?`, [parcelId]);
  }
}
export const removeDoms = removeFees;

export async function markParcelReceived(conn, parcelId) {
  await conn.query("UPDATE parcels SET status = 'received', received_date = CURDATE() WHERE id = ?", [parcelId]);
  await conn.query(
    "UPDATE claims SET pipeline = 'completed', received_date = CURDATE() WHERE id IN (SELECT claim_id FROM parcel_items WHERE parcel_id = ?)", [parcelId]);
}
