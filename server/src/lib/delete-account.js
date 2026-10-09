import { conflict, notFound } from '../errors.js';
import { lockJoiner } from './ledger.js';
import { round2 } from './money.js';
import { cancelClaim } from './cancel.js';

const ACTIVE = "('requested','packed','shipped')";
const pounds = (n) => `£${Number(n).toFixed(2)}`;

// What stops this person deleting their account (or removing a handle), plus what they should be warned about first.
// Blockers: a parcel of theirs still on its way, their items inside a friend's parcel still on its way, money they still owe on confirmed orders,
// a payment still waiting to be checked, or a request to cancel still waiting for the GOM.
export async function deletionCheck(conn, joinerIds) {
  const ids = joinerIds.length ? joinerIds : [0];
  const blockers = [];
  const [own] = await conn.query(`SELECT DISTINCT j.instagram_handle AS handle FROM parcels p JOIN joiners j ON j.id = p.joiner_id WHERE p.joiner_id IN (?) AND p.status IN ${ACTIVE}`, [ids]);
  for (const p of own) blockers.push({ kind: 'parcel', message: `A parcel for @${p.handle} is still on its way — you can delete your account once it has arrived.` });
  const [friend] = await conn.query(
    `SELECT 1 FROM parcel_items pi JOIN parcels p ON p.id = pi.parcel_id JOIN claims c ON c.id = pi.claim_id WHERE c.joiner_id IN (?) AND p.joiner_id NOT IN (?) AND p.status IN ${ACTIVE} LIMIT 1`, [ids, ids]);
  if (friend.length) blockers.push({ kind: 'friend_parcel', message: "Some of your items are in a friend's parcel that hasn't arrived yet — you can delete your account once it has." });
  const [[owed]] = await conn.query("SELECT COALESCE(SUM(cc.cost - cc.paid), 0) AS n FROM claim_costs cc JOIN claims c ON c.id = cc.claim_id WHERE c.joiner_id IN (?) AND c.status = 'confirmed' AND cc.cost > cc.paid", [ids]);
  if (round2(owed.n) > 0) blockers.push({ kind: 'owed', amount: round2(owed.n), message: `You still owe ${pounds(owed.n)}. Pay it — or ask the GOM to cancel those orders — and then you can delete your account.` });
  const [pay] = await conn.query("SELECT 1 FROM payments WHERE joiner_id IN (?) AND status = 'pending' LIMIT 1", [ids]);
  if (pay.length) blockers.push({ kind: 'pending_payment', message: 'A payment you sent is still waiting for the GOM to check it. Once it has been checked you can delete your account.' });
  const [ask] = await conn.query("SELECT 1 FROM cancel_requests WHERE joiner_id IN (?) AND status = 'pending' LIMIT 1", [ids]);
  if (ask.length) blockers.push({ kind: 'pending_cancel', message: "You've asked to cancel an item and the GOM hasn't answered yet. Once they have, you can delete your account." });
  const [[credit]] = await conn.query('SELECT COALESCE(SUM(balance_effect), 0) AS n FROM credit_ledger WHERE joiner_id IN (?)', [ids]);
  const [[flight]] = await conn.query("SELECT COUNT(*) AS n FROM claims WHERE joiner_id IN (?) AND status = 'confirmed' AND pipeline <> 'completed'", [ids]);
  return { blockers, warnings: { credit: round2(credit.n), inFlight: flight.n } };
}

const rx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The GOM's activity log must not keep naming someone who asked to be forgotten (only exact "handle" values are replaced, never parts of other words).
async function forgetHandleInLog(conn, handle, id) {
  await conn.query('UPDATE audit_log SET detail = REPLACE(detail, ?, ?) WHERE INSTR(detail, ?) > 0', [`"${handle}"`, `"deleted-${id}"`, `"${handle}"`]);
}
// A payment's reference is kept (it is the financial identifier), but people sometimes type their name or handle into it: those words are replaced. Best effort — it can't know what else they typed.
async function scrubReferences(conn, joinerId, terms) {
  for (const term of [...new Set(terms.map((t) => String(t || '').trim()).filter((t) => t.length >= 3))])
    await conn.query("UPDATE payments SET reference = REGEXP_REPLACE(reference, ?, '[removed]') WHERE joiner_id = ? AND reference IS NOT NULL AND reference REGEXP ?", [rx(term), joinerId, rx(term)]);
}

// "Delete my account". Always: the login, email, sessions and delivery details go; their unconfirmed requests are removed (set parts are freed for others).
//  · Nothing financial on record (no confirmed order, confirmed payment or credit movement): everything about them is erased, including the handle's record.
//  · A financial record exists: the record stays (orders, amounts, dates) but every personal detail is stripped, and the person becomes "deleted-<id>" —
//    unless they hold credit or are blocked, in which case the handle stays so the GOM can settle the credit / the block can't be shed by deleting.
// The person never sees any of this; the screen just says their account and details are deleted.
export async function deleteAccount(conn, { accountId, email }) {
  const [js] = await conn.query('SELECT id, instagram_handle AS handle, is_blocked AS blocked FROM joiners WHERE account_id = ? ORDER BY id', [accountId]);
  for (const j of js) await lockJoiner(conn, j.id);                                // lowest id first, like every money flow
  const ids = js.map((j) => j.id);
  const check = await deletionCheck(conn, ids);
  if (check.blockers.length) throw conflict(check.blockers.map((b) => b.message).join(' '), 'cannot_delete');
  const out = { erased: [], kept: [], anonymised: [] };

  for (const j of js) {
    const [[fin]] = await conn.query(
      `SELECT (EXISTS (SELECT 1 FROM claims WHERE joiner_id = ? AND status = 'confirmed')
            OR EXISTS (SELECT 1 FROM payments WHERE joiner_id = ? AND status = 'confirmed')
            OR EXISTS (SELECT 1 FROM credit_ledger WHERE joiner_id = ?)) AS financial`, [j.id, j.id, j.id]);
    const [[addr]] = await conn.query('SELECT full_name, email, phone FROM addresses WHERE joiner_id = ?', [j.id]);
    const [payers] = await conn.query('SELECT DISTINCT payer_name AS n FROM payments WHERE joiner_id = ? AND payer_name IS NOT NULL UNION SELECT DISTINCT address_name_snapshot FROM payments WHERE joiner_id = ? AND address_name_snapshot IS NOT NULL', [j.id, j.id]);
    const words = [j.handle, addr?.full_name, addr?.email, addr?.phone, ...payers.map((p) => p.n)];
    // requests that were never confirmed: freed (set parts too) and removed
    const [reqs] = await conn.query("SELECT id FROM claims WHERE joiner_id = ? AND status = 'requested' ORDER BY id FOR UPDATE", [j.id]);
    for (const c of reqs) await cancelClaim(conn, c.id, 'Account deleted');
    await conn.query('DELETE FROM fixed_requests WHERE joiner_id = ?', [j.id]);
    await conn.query('DELETE FROM fixed_claims WHERE joiner_id = ?', [j.id]);
    await conn.query('DELETE FROM handle_invites WHERE joiner_id = ?', [j.id]);
    await conn.query('DELETE FROM handle_proofs WHERE joiner_id = ?', [j.id]);
    await conn.query('DELETE FROM notification_log WHERE joiner_id = ?', [j.id]);
    await conn.query('DELETE FROM addresses WHERE joiner_id = ?', [j.id]);
    await conn.query('DELETE FROM joiner_defaults WHERE joiner_id = ?', [j.id]);
    await conn.query("DELETE FROM parcel_companions WHERE joiner_id = ? AND status <> 'accepted'", [j.id]);    // open or declined invitations to share a parcel

    if (!fin.financial) {                                                           // ── erase everything ──
      const [gone] = await conn.query('SELECT id FROM claims WHERE joiner_id = ?', [j.id]);
      if (gone.length) await conn.query("DELETE FROM import_records WHERE kind = 'claim' AND entity_id IN (?)", [gone.map((c) => c.id)]);
      await conn.query('DELETE FROM payments WHERE joiner_id = ?', [j.id]);         // only rejected ones can exist here
      await conn.query('DELETE FROM parcel_companions WHERE joiner_id = ?', [j.id]);
      await conn.query('DELETE FROM claims WHERE joiner_id = ?', [j.id]);
      await conn.query("DELETE FROM import_records WHERE kind = 'joiner' AND entity_id = ?", [j.id]);
      await forgetHandleInLog(conn, j.handle, j.id);
      await conn.query('DELETE FROM joiners WHERE id = ?', [j.id]);
      out.erased.push(j.id);
      continue;
    }
    // ── the financial record stays; the personal details do not ──
    await conn.query('UPDATE parcels SET notes = NULL, bias = NULL, lomo_name = NULL WHERE joiner_id = ?', [j.id]);
    await conn.query('UPDATE parcel_companions SET notes = NULL, bias = NULL, lomo_name = NULL WHERE joiner_id = ?', [j.id]);
    await scrubReferences(conn, j.id, words);
    await conn.query('UPDATE payments SET payer_name = NULL, address_name_snapshot = NULL, overpay_note = NULL WHERE joiner_id = ?', [j.id]);
    await conn.query(                                                                 // cancelled claims with no money history are just clutter
      `DELETE FROM claims WHERE joiner_id = ? AND status = 'cancelled'
          AND NOT EXISTS (SELECT 1 FROM payment_allocations WHERE claim_id = claims.id) AND NOT EXISTS (SELECT 1 FROM parcel_items WHERE claim_id = claims.id)
          AND NOT EXISTS (SELECT 1 FROM box_items WHERE claim_id = claims.id) AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE claim_id = claims.id)`, [j.id]);
    const [[bal]] = await conn.query('SELECT COALESCE(SUM(balance_effect), 0) AS n FROM credit_ledger WHERE joiner_id = ?', [j.id]);
    if (round2(bal.n) > 0 || j.blocked) {
      await conn.query('UPDATE joiners SET account_id = NULL, linked_at = NULL, linked_via = NULL, verified_at = NULL, account_deleted_at = NOW(3) WHERE id = ?', [j.id]);
      out.kept.push(j.id);
    } else {
      await conn.query(
        "UPDATE joiners SET instagram_handle = CONCAT('deleted-', id), account_id = NULL, linked_at = NULL, linked_via = NULL, verified_at = NULL, blocked_reason = NULL, account_deleted_at = NOW(3), anonymised_at = NOW(3) WHERE id = ?", [j.id]);
      await forgetHandleInLog(conn, j.handle, j.id);
      out.anonymised.push(j.id);
    }
  }
  await conn.query('DELETE FROM login_tokens WHERE email = ?', [email]);
  await conn.query('DELETE FROM accounts WHERE id = ?', [accountId]);              // sessions and pending handle requests go with it
  return out;
}

// "Remove this handle from my account": allowed only when it has no open business (so nothing is stranded). The handle goes back to being unlinked,
// and its delivery details and saved defaults are removed so a future owner can never see them.
export async function unlinkHandle(conn, accountId, handle) {
  const [[j]] = await conn.query('SELECT id, instagram_handle AS handle FROM joiners WHERE account_id = ? AND instagram_handle = ?', [accountId, handle]);
  if (!j) throw notFound('That handle is not linked to your account');
  await lockJoiner(conn, j.id);
  const check = await deletionCheck(conn, [j.id]);
  const [[open]] = await conn.query("SELECT COUNT(*) AS n FROM claims WHERE joiner_id = ? AND (status = 'requested' OR (status = 'confirmed' AND pipeline <> 'completed'))", [j.id]);
  const problems = [];
  if (open.n) problems.push('orders that are still in progress');
  for (const b of check.blockers) problems.push({ parcel: 'a parcel on its way', friend_parcel: 'items in a parcel on its way', owed: 'money owed', pending_payment: 'a payment waiting to be checked', pending_cancel: 'a request waiting for the GOM' }[b.kind]);
  if (round2(check.warnings.credit) !== 0) problems.push('credit on it');
  if (problems.length) throw conflict(`@${j.handle} can't be removed yet — it still has ${[...new Set(problems)].join(', ')}. Once those are finished, or the GOM has sorted them, you can remove it.`, 'handle_busy');
  await conn.query('UPDATE joiners SET account_id = NULL, linked_at = NULL, linked_via = NULL, verified_at = NULL WHERE id = ?', [j.id]);
  await conn.query('DELETE FROM handle_link_requests WHERE joiner_id = ? AND account_id = ?', [j.id, accountId]);
  await conn.query('DELETE FROM addresses WHERE joiner_id = ?', [j.id]);
  await conn.query('DELETE FROM joiner_defaults WHERE joiner_id = ?', [j.id]);
  await conn.query('DELETE FROM handle_proofs WHERE joiner_id = ?', [j.id]);
  return { joinerId: j.id };
}
