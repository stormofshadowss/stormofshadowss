import { lockJoiner } from './ledger.js';
import { bad, conflict, forbidden, notFound } from '../errors.js';
import { cancelClaim } from './cancel.js';

export const MAX_REASON = 500;

// A joiner asks to cancel one of their items — at ANY stage, confirmed or not (so nobody can remove a part from a set behind your back). Nothing changes until the GOM approves; an item with a pending request can't be sent out in a parcel or moved to someone else.
export async function requestCancel(conn, { joinerId, claimId, reason }) {
  await lockJoiner(conn, joinerId);
  const [[c]] = await conn.query('SELECT id, joiner_id, status, pipeline, is_fixed FROM claims WHERE id = ? FOR UPDATE', [claimId]);
  if (!c || c.joiner_id !== joinerId) throw forbidden("That item isn't yours");
  if (c.status === 'cancelled') throw bad('That item is already cancelled.', 'already_cancelled');
  if (c.pipeline === 'completed') throw conflict("That item has already been received, so it can't be cancelled.", 'already_received');
  if (c.is_fixed) throw bad("That's one of your fixed claims — change or stop it under Fixed claims instead.", 'fixed_claim');
  const [busy] = await conn.query("SELECT 1 FROM parcel_items pi JOIN parcels p ON p.id = pi.parcel_id WHERE pi.claim_id = ? AND p.status IN ('requested','packed','shipped') LIMIT 1", [claimId]);
  if (busy.length) throw conflict("That item is in a parcel. Ask the GOM to take it out first, then you can ask to cancel it.", 'in_parcel');
  const [open] = await conn.query("SELECT 1 FROM cancel_requests WHERE claim_id = ? AND status = 'pending' LIMIT 1", [claimId]);
  if (open.length) throw conflict("You've already asked to cancel this — the GOM hasn't answered yet.", 'already_requested');
  const [r] = await conn.query('INSERT INTO cancel_requests (claim_id, joiner_id, reason, stage) VALUES (?, ?, ?, ?)', [claimId, joinerId, reason || null, c.status === 'requested' ? 'not confirmed yet' : c.pipeline]);
  return { id: r.insertId };
}

// The joiner takes a pending request back.
export async function withdrawCancel(conn, { joinerId, requestId }) {
  await lockJoiner(conn, joinerId);
  const [[r]] = await conn.query('SELECT id, joiner_id, status FROM cancel_requests WHERE id = ? FOR UPDATE', [requestId]);
  if (!r || r.joiner_id !== joinerId) throw notFound('No such request');
  if (r.status !== 'pending') throw conflict(`That request has already been ${r.status}.`, 'bad_state');
  await conn.query("UPDATE cancel_requests SET status = 'withdrawn', open_flag = NULL, decided_at = NOW(3) WHERE id = ?", [requestId]);
}

// The GOM approves: the claim is cancelled (the same code as when the GOM cancels one), and `keep` — a cancellation fee, never more than was paid — is kept out of what is returned as credit.
// The person is locked FIRST, then the request, so it can't tangle with the joiner withdrawing at the same moment.
export async function approveCancel(conn, { requestId, keep = 0, note = null, adminId }) {
  const [[peek]] = await conn.query('SELECT joiner_id FROM cancel_requests WHERE id = ?', [requestId]);
  if (!peek) throw notFound('No such request');
  await lockJoiner(conn, peek.joiner_id);
  const [[r]] = await conn.query('SELECT id, status, claim_id FROM cancel_requests WHERE id = ? FOR UPDATE', [requestId]);
  if (r.status !== 'pending') throw conflict(`That request has already been ${r.status}.`, 'bad_state');
  const [[c]] = await conn.query('SELECT pipeline FROM claims WHERE id = ?', [r.claim_id]);
  if (c.pipeline === 'completed') throw conflict('That item has already been received — decline the request instead.', 'already_received');
  return cancelClaim(conn, r.claim_id, 'Cancelled at your request', { keep, decidedBy: adminId, note: note || '' });   // '' = no message (not the "cancelled by the GOM" default)
}

export async function declineCancel(conn, { requestId, note = null, adminId }) {
  const [[peek]] = await conn.query('SELECT joiner_id FROM cancel_requests WHERE id = ?', [requestId]);
  if (!peek) throw notFound('No such request');
  await lockJoiner(conn, peek.joiner_id);
  const [[r]] = await conn.query('SELECT id, status FROM cancel_requests WHERE id = ? FOR UPDATE', [requestId]);
  if (r.status !== 'pending') throw conflict(`That request has already been ${r.status}.`, 'bad_state');
  await conn.query("UPDATE cancel_requests SET status = 'declined', open_flag = NULL, decided_at = NOW(3), decided_by = ?, decision_note = ? WHERE id = ?", [adminId, note || null, requestId]);
}
