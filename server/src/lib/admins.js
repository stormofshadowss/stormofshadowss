import { hashPassword, passwordProblem } from './password.js';

export class AdminError extends Error {}

const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function adminCount(pool) {
  const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 1 AND password_hash IS NOT NULL');
  return r.n;
}

export async function listAdmins(pool) {
  const [rows] = await pool.query(
    'SELECT username, email, created_at AS createdAt, last_login_at AS lastLoginAt, (locked_until > NOW(3)) AS locked FROM accounts WHERE is_admin = 1 ORDER BY id');
  return rows.map((r) => ({ ...r, locked: !!r.locked }));
}

export async function createAdmin(pool, { username, email, password }) {
  username = String(username || '').trim().toLowerCase();
  email = String(email || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw new AdminError('The username must be 3–40 characters: letters, numbers, dots, dashes or underscores.');
  if (!EMAIL_RE.test(email)) throw new AdminError('That doesn\'t look like an email address.');
  const problem = passwordProblem(password, username);
  if (problem) throw new AdminError(problem);

  const [[taken]] = await pool.query('SELECT 1 AS x FROM accounts WHERE username = ?', [username]);
  if (taken) throw new AdminError(`There is already an admin called "${username}".`);
  const [[mail]] = await pool.query('SELECT is_admin FROM accounts WHERE email = ?', [email]);
  if (mail) throw new AdminError('That email is already used by another account. Admin accounts can\'t double as joiner accounts — use a different email for the admin login (it is never used to sign in).');
  await pool.query('INSERT INTO accounts (email, is_admin, username, password_hash) VALUES (?, 1, ?, ?)', [email, username, await hashPassword(password)]);
  return { username, email };
}

// Changing a password signs that admin out everywhere and clears any lock.
export async function setAdminPassword(pool, username, password) {
  username = String(username || '').trim().toLowerCase();
  const problem = passwordProblem(password, username);
  if (problem) throw new AdminError(problem);
  const [[a]] = await pool.query('SELECT id FROM accounts WHERE username = ? AND is_admin = 1', [username]);
  if (!a) throw new AdminError(`There is no admin called "${username}".`);
  await pool.query('UPDATE accounts SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', [await hashPassword(password), a.id]);
  await pool.query('DELETE FROM sessions WHERE account_id = ?', [a.id]);
  return { username };
}

// Creates the very first admin from settings (INITIAL_ADMIN_USERNAME / _PASSWORD / optional _EMAIL) — ONLY when there is no admin at all, and never touches an existing one.
// So a brand-new install needs no terminal: fill in the settings, start it, sign in. Never throws and never logs the password; the result says what happened.
export async function bootstrapAdmin(pool, { username = '', email = '', password = '' } = {}, log = console) {
  if (!username && !password) return { created: false, reason: 'not_set' };
  if (!username || !password) { log.warn('INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD must be set together — no admin was created.'); return { created: false, reason: 'incomplete' }; }
  if ((await adminCount(pool)) > 0) { log.log('INITIAL_ADMIN_* is set but an admin already exists, so it was ignored. You can remove it from your settings.'); return { created: false, reason: 'exists' }; }
  const who = String(username).trim().toLowerCase();
  try {
    await createAdmin(pool, { username: who, email: email || `${who}@admin.local`, password });
  } catch (e) {
    if (!(e instanceof AdminError)) throw e;
    log.error(`Couldn't create the first admin from INITIAL_ADMIN_*: ${e.message}`);
    return { created: false, reason: 'invalid', error: e.message };
  }
  log.log(`Created the first admin "${who}". You can sign in now — and remove INITIAL_ADMIN_PASSWORD from your settings.`);
  return { created: true, username: who };
}
