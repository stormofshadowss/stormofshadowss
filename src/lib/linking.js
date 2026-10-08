import { audit } from '../auth.js';

// Links a handle to an account (once). Returns true if it linked, false if the handle already belongs to someone.
// Caller is inside a transaction. The proofs are used up, so they can't be replayed against a later unlink.
export async function linkJoiner(conn, joinerId, accountId, via) {
  const [[j]] = await conn.query('SELECT account_id FROM joiners WHERE id = ? FOR UPDATE', [joinerId]);
  if (!j) return false;
  if (j.account_id === accountId) return true;
  if (j.account_id) return false;
  await conn.query('UPDATE joiners SET account_id = ?, account_deleted_at = NULL, linked_at = NOW(3), linked_via = ? WHERE id = ?', [accountId, via, joinerId]);
  await conn.query('DELETE FROM handle_proofs WHERE joiner_id = ?', [joinerId]);
  await audit(conn, accountId, 'handle.link', 'joiner', joinerId, { via });
  return true;
}
