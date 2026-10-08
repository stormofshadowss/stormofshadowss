import crypto from 'node:crypto';
import { linkJoiner } from './linking.js';
import { audit } from '../auth.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
export const inviteUrl = (cfg, token) => `${cfg.publicUrl}/claim.html#t=${token}`;      // in the #fragment: browsers never send it to a server, a log or another site

// One live link per person: making a new one switches any earlier one off. Only a hash is stored, so a link can't be recovered later — only replaced.
export async function createInvite(conn, { joinerId, accountId, days }) {
  await conn.query('UPDATE handle_invites SET revoked_at = NOW(3) WHERE joiner_id = ? AND used_at IS NULL AND revoked_at IS NULL', [joinerId]);
  const token = newToken();
  const [r] = await conn.query('INSERT INTO handle_invites (joiner_id, token_hash, created_by, expires_at) VALUES (?, ?, ?, NOW(3) + INTERVAL ? DAY)', [joinerId, sha256(token), accountId, days]);
  const [[row]] = await conn.query('SELECT expires_at AS expiresAt FROM handle_invites WHERE id = ?', [r.insertId]);
  return { id: r.insertId, token, expiresAt: row.expiresAt };
}

// An invite is usable while it is unused, not switched off, not expired, and its person is still unlinked.
export async function findInvite(conn, token, { lock = false } = {}) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const [[inv]] = await conn.query(
    `SELECT i.id, i.joiner_id AS joinerId, i.expires_at AS expiresAt, j.instagram_handle AS handle, j.account_id AS accountId
       FROM handle_invites i JOIN joiners j ON j.id = i.joiner_id
      WHERE i.token_hash = ? AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW(3) ${lock ? 'FOR UPDATE' : ''}`, [sha256(token)]);
  return inv || null;
}

// Links the invite's handle to this account. Done in the caller's transaction; the invite can only ever be used once, even if two people race.
// Using one also marks the handle as checked — the GOM sent the link to the real owner, which is exactly the check the packing queue wants.
export async function redeemInvite(conn, inviteId, accountId) {
  const [[inv]] = await conn.query(
    `SELECT i.id, i.joiner_id AS joinerId FROM handle_invites i WHERE i.id = ? AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW(3) FOR UPDATE`, [inviteId]);
  if (!inv) return null;
  if (!(await linkJoiner(conn, inv.joinerId, accountId, 'invite'))) return null;                  // someone else owns the handle now
  await conn.query('UPDATE handle_invites SET used_at = NOW(3), used_by = ? WHERE id = ?', [accountId, inv.id]);
  await conn.query('UPDATE joiners SET verified_at = COALESCE(verified_at, NOW(3)) WHERE id = ?', [inv.joinerId]);
  await audit(conn, accountId, 'invite.use', 'joiner', inv.joinerId, { inviteId: inv.id });
  return { joinerId: inv.joinerId };
}
