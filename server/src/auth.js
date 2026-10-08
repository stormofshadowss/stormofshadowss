import crypto from 'node:crypto';
import { HttpError } from './errors.js';

export const COOKIE = 'sos_session';
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url'); // 256 bits

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const raw = part.slice(i + 1).trim();
      // A malformed value (bad %-encoding) must never throw — it just won't match any session.
      try { out[part.slice(0, i).trim()] = decodeURIComponent(raw); } catch { out[part.slice(0, i).trim()] = raw; }
    }
  }
  return out;
}

// Creates a one-time sign-in token. Returns null when this email has already
// asked for too many links this hour (the caller still answers "ok", so
// nobody can use the endpoint to learn anything about an email address).
export async function createLoginToken(pool, cfg, email, ip, linkJoinerId = null, inviteId = null) {
  const [[{ n }]] = await pool.query(
    'SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > (NOW(3) - INTERVAL 1 HOUR)', [email]);
  if (n >= cfg.loginLinksPerEmailPerHour) return null;
  const token = newToken();
  await pool.query(
    'INSERT INTO login_tokens (email, token_hash, ip, expires_at, link_joiner_id, invite_id) VALUES (?, ?, ?, NOW(3) + INTERVAL ? MINUTE, ?, ?)',
    [email, sha256(token), ip || null, cfg.loginLinkMinutes, linkJoinerId, inviteId]);
  return token;
}

// Single use: the UPDATE can only succeed once, even if two requests race.
// Admin accounts can never sign in this way (they use a password), even if a link somehow exists.
export async function consumeLoginToken(pool, token) {
  const hash = sha256(token);
  const [res] = await pool.query(
    'UPDATE login_tokens SET used_at = NOW(3) WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW(3)', [hash]);
  if (res.affectedRows !== 1) return null;
  const [[row]] = await pool.query('SELECT email, link_joiner_id, invite_id FROM login_tokens WHERE token_hash = ?', [hash]);
  const [[adm]] = await pool.query('SELECT 1 AS x FROM accounts WHERE email = ? AND is_admin = 1', [row.email]);
  return adm ? null : { email: row.email, linkJoinerId: row.link_joiner_id, inviteId: row.invite_id };
}

// Signs an admin in (after their password was checked). Admin sessions are shorter than joiner ones.
export async function startAdminSession(pool, cfg, accountId, req) {
  const token = newToken();
  await pool.query(
    'INSERT INTO sessions (account_id, token_hash, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, NOW(3) + INTERVAL ? HOUR)',
    [accountId, sha256(token), String(req.get('user-agent') || '').slice(0, 255), req.ip || null, cfg.adminSessionHours]);
  await pool.query('UPDATE accounts SET last_login_at = NOW(3) WHERE id = ?', [accountId]);
  return token;
}

export async function startSession(pool, cfg, email, req) {
  const [acc] = await pool.query(
    'INSERT INTO accounts (email, last_login_at) VALUES (?, NOW(3)) ON DUPLICATE KEY UPDATE last_login_at = NOW(3), id = LAST_INSERT_ID(id)', [email]);
  const accountId = acc.insertId;
  const token = newToken();
  await pool.query(
    'INSERT INTO sessions (account_id, token_hash, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, NOW(3) + INTERVAL ? DAY)',
    [accountId, sha256(token), String(req.get('user-agent') || '').slice(0, 255), req.ip || null, cfg.sessionDays]);
  return { token, accountId };
}

export const sessionCookieOptions = (cfg) => ({
  httpOnly: true, sameSite: 'lax', secure: cfg.cookieSecure, path: '/', maxAge: cfg.sessionDays * 86_400_000,
});

// Reads the session cookie and attaches req.account (or null).
export function attachAccount(pool, cfg) {
  return async (req, res, next) => {
    req.account = null;
    try {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) {
        const [rows] = await pool.query(
          `SELECT s.id AS sid, s.last_seen_at, a.id, a.email, a.is_admin, a.username FROM sessions s
             JOIN accounts a ON a.id = s.account_id
            WHERE s.token_hash = ? AND s.expires_at > NOW(3)`, [sha256(token)]);
        if (rows[0]) {
          req.account = { id: rows[0].id, email: rows[0].email, isAdmin: !!rows[0].is_admin, username: rows[0].username || null };
          req.sessionId = rows[0].sid;
          pool.query('UPDATE sessions SET last_seen_at = NOW(3) WHERE id = ? AND last_seen_at < NOW(3) - INTERVAL 1 HOUR', [rows[0].sid]).catch(() => {});
        }
      }
      next();
    } catch (e) { next(e); }
  };
}

export const requireLogin = (req, res, next) =>
  req.account ? next() : next(new HttpError(401, 'Please sign in', 'not_signed_in'));
export const requireAdmin = (req, res, next) =>
  !req.account ? next(new HttpError(401, 'Please sign in', 'not_signed_in'))
    : req.account.isAdmin ? next() : next(new HttpError(403, 'Admins only'));

export async function cleanupExpired(pool) {
  await pool.query('DELETE FROM login_tokens WHERE expires_at < NOW(3) - INTERVAL 1 DAY');
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW(3)');
}

export async function audit(conn, accountId, action, entity = null, entityId = null, detail = null) {
  await conn.query('INSERT INTO audit_log (account_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)',
    [accountId || null, action, entity, entityId, detail ? JSON.stringify(detail) : null]);
}
