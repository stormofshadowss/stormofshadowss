import { HttpError, notFound, bad } from '../errors.js';
import { round2 } from './money.js';
import { addLedger, lockJoiner, sweepCredit } from './ledger.js';

// Cancels one claim. Whatever has been paid towards it goes back to the joiner as CREDIT —
// unless their handle is blocked, in which case it is recorded as forfeited instead.
// `keep` is a cancellation fee the GOM keeps out of what was paid (never more than was paid): it is recorded as kept, not credited.
// If the joiner had a pending cancellation request for it, that request is settled as approved (with `note`, or "Cancelled by the GOM" if the GOM cancelled directly).
// Locks the person first (like every money flow), so it can run alongside payments safely.
export async function cancelClaim(conn, claimId, reason = 'Claim cancelled', { keep = 0, decidedBy = null, note = null } = {}) {
  const [[peek]] = await conn.query('SELECT joiner_id FROM claims WHERE id = ?', [claimId]);
  if (!peek) throw notFound('No such claim');
  await lockJoiner(conn, peek.joiner_id);
  const [[c]] = await conn.query('SELECT id, joiner_id, status, label, slot_id FROM claims WHERE id = ? FOR UPDATE', [claimId]);
  if (c.status === 'cancelled') return { claimId, cancelled: false, refunded: 0, forfeited: 0, kept: 0 };

  const [busy] = await conn.query(
    "SELECT 1 FROM parcel_items pi JOIN parcels p ON p.id = pi.parcel_id WHERE pi.claim_id = ? AND p.status IN ('requested','packed','shipped') LIMIT 1", [claimId]);
  if (busy.length) throw new HttpError(409, 'That item is in a parcel — cancel or finish the parcel first', 'in_parcel');

  const [[j]] = await conn.query('SELECT is_blocked FROM joiners WHERE id = ?', [c.joiner_id]);
  const [lines] = await conn.query('SELECT category, paid FROM claim_costs WHERE claim_id = ? FOR UPDATE', [claimId]);
  const paid = round2(lines.reduce((s, l) => s + l.paid, 0));
  const wanted = round2(Math.max(0, keep || 0));
  if (wanted > paid + 0.004) throw bad(`They have only paid ${'£' + paid.toFixed(2)} towards this, so you can't keep ${'£' + wanted.toFixed(2)}.`, 'keep_too_much');
  let refunded = 0, forfeited = 0, kept = 0;
  if (paid > 0) {
    if (j.is_blocked) {
      forfeited = paid;
      await addLedger(conn, { joinerId: c.joiner_id, kind: 'forfeited', amount: paid, effect: 0, reason: `${reason}: "${c.label}" (handle is blocked — not credited)`, source: 'Cancelled claim', claimId });
    } else {
      kept = Math.min(wanted, paid); refunded = round2(paid - kept);
      if (kept > 0) await addLedger(conn, { joinerId: c.joiner_id, kind: 'forfeited', amount: kept, effect: 0, reason: `Cancellation fee kept: "${c.label}"`, source: 'Cancelled claim', claimId });
      if (refunded > 0) await addLedger(conn, { joinerId: c.joiner_id, kind: 'credit', amount: refunded, effect: refunded, reason: `${reason}: "${c.label}"`, source: 'Cancelled claim', claimId });
    }
  }
  await conn.query('UPDATE claim_costs SET paid = 0, paid_date = NULL WHERE claim_id = ?', [claimId]);
  if (c.slot_id) await conn.query('DELETE FROM set_slots WHERE id = ?', [c.slot_id]);   // the part becomes free for someone else
  await conn.query("UPDATE claims SET status = 'cancelled', slot_id = NULL WHERE id = ?", [claimId]);
  await conn.query(
    "UPDATE cancel_requests SET status = 'approved', open_flag = NULL, decided_at = NOW(3), decided_by = ?, decision_note = COALESCE(?, 'Cancelled by the GOM'), paid_at_decision = ?, kept = ?, refunded = ? WHERE claim_id = ? AND status = 'pending'",
    [decidedBy, note, paid, kept + forfeited, refunded, claimId]);
  if (refunded > 0) await sweepCredit(conn, c.joiner_id); // credit meets anything else they owe, as always
  return { claimId, cancelled: true, refunded, forfeited, kept };
}
