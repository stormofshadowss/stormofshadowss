import { newToken, parseCookies, sha256 } from '../auth.js';

export const DEVICE_COOKIE = 'sos_device';
const SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function readDevice(req) {
  const t = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
  return t && SHAPE.test(t) ? t : null;
}

// Gives this browser a private, random "device" cookie if it doesn't have one yet.
export function ensureDevice(req, res, cfg) {
  let t = readDevice(req);
  if (!t) {
    t = newToken();
    res.cookie(DEVICE_COOKIE, t, { httpOnly: true, sameSite: 'lax', secure: cfg.cookieSecure, path: '/', maxAge: 365 * 86_400_000 });
  }
  return t;
}

export async function deviceHasProof(conn, deviceToken, joinerId) {
  if (!deviceToken) return false;
  const [rows] = await conn.query('SELECT 1 FROM handle_proofs WHERE joiner_id = ? AND device_hash = ? AND expires_at > NOW(3)', [joinerId, sha256(deviceToken)]);
  return rows.length > 0;
}

export const grantProof = (conn, cfg, deviceToken, joinerId) => conn.query(
  'INSERT INTO handle_proofs (joiner_id, device_hash, expires_at) VALUES (?, ?, NOW(3) + INTERVAL ? DAY) ON DUPLICATE KEY UPDATE expires_at = VALUES(expires_at)',
  [joinerId, sha256(deviceToken), cfg.claimProofDays]);
