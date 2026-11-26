import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { HttpError } from '../errors.js';
import { requireLogin, startSession, sessionCookieOptions, COOKIE, audit } from '../auth.js';
import { hashPassword, verifyPassword, dummyHash, joinerPasswordProblem } from '../lib/password.js';

// OPTIONAL PASSWORDS FOR JOINERS, alongside the emailed link (which always works — it is also how "I forgot my password" works).
// Admin accounts are never touched here: they sign in at the admin screen, with a username.
export default function joinerPasswordRoutes({ cfg, pool, mailer }) {
  const r = express.Router();
  const limiter = rateLimit({
    windowMs: 15 * 60_000, limit: cfg.rateLimits.joinerLoginPer15MinPerIp, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many sign-in attempts from here — please wait a few minutes. You can always use the email link instead.' },
  });
  // One message for every kind of failure, so it never reveals whether an email has an account, has a password, or is locked.
  const badLogin = () => new HttpError(401, "That email and password don't match — or there have been too many wrong tries, so it's paused for a few minutes. You can always use the email link instead.", 'bad_login');

  // A wrong password counts against the account; after adminMaxFailures in a row it is locked for adminLockMinutes (the same rule as the admin sign-in). The emailed link is never affected by the lock.
  async function countFailure(accountId, ip) {
    await pool.query('UPDATE accounts SET failed_logins = failed_logins + 1 WHERE id = ?', [accountId]);
    const [[{ n }]] = await pool.query('SELECT failed_logins AS n FROM accounts WHERE id = ?', [accountId]);
    if (n >= cfg.adminMaxFailures) { await pool.query('UPDATE accounts SET failed_logins = 0, locked_until = NOW(3) + INTERVAL ? MINUTE WHERE id = ?', [cfg.adminLockMinutes, accountId]); await audit(pool, accountId, 'password.locked', 'account', accountId, { ip }); }
  }
  // A security notice, always sent (like a sign-in link) and never containing the password.
  async function notice(email, what) {
    try { await mailer.send({ to: email, subject: `Your StormOfShadowss password was ${what}`, text: `The password you can use to sign in to your StormOfShadowss account was just ${what}.\n\nIf that was you, there's nothing to do. If it wasn't, sign in with an email link, change or remove the password, and tell the GOM.` }); }
    catch (err) { console.error('mail failed:', err.message); }
  }

  r.post('/api/auth/password-login', limiter, wrap(async (req, res) => {
    const { email, password } = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(200) }).parse(req.body);
    const [[acc]] = await pool.query('SELECT id, password_hash, (locked_until IS NOT NULL AND locked_until > NOW(3)) AS locked FROM accounts WHERE email = ? AND is_admin = 0', [email]);
    if (!acc || acc.locked || !acc.password_hash) { await verifyPassword(password, await dummyHash()); throw badLogin(); }          // unknown, locked or no password: still do the slow work, so timing gives nothing away
    if (!(await verifyPassword(password, acc.password_hash))) { await countFailure(acc.id, req.ip); throw badLogin(); }
    await pool.query('UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE id = ?', [acc.id]);
    const { token } = await startSession(pool, cfg, email, req, 'password');
    res.cookie(COOKIE, token, sessionCookieOptions(cfg)); await audit(pool, acc.id, 'login.password', 'account', acc.id, { ip: req.ip });
    res.set('Cache-Control', 'no-store').json({ ok: true });
  }));

  // Everything below is for the signed-in person, and never for an admin account (that would change the ADMIN password).
  const mine = async (req) => {
    if (req.account.isAdmin) throw new HttpError(403, 'Admin accounts sign in at the admin screen, with a username.', 'admin_account');
    const [[acc]] = await pool.query('SELECT id, email, password_hash, (locked_until IS NOT NULL AND locked_until > NOW(3)) AS locked FROM accounts WHERE id = ?', [req.account.id]);
    return acc;
  };
  // In a session that began with the PASSWORD the current one is needed to change or remove it; after an emailed link it isn't (they have just proved they own the email — that is "I forgot my password").
  async function checkCurrent(req, acc, current) {
    if (!acc.password_hash || req.sessionVia !== 'password') return;
    if (current === undefined || current === '') throw new HttpError(403, 'Enter your current password to do this.', 'current_password_needed');
    if (acc.locked || !(await verifyPassword(current, acc.password_hash))) { if (!acc.locked) await countFailure(acc.id, req.ip); throw new HttpError(403, "That isn't your current password.", 'wrong_current_password'); }
  }

  r.put('/api/my/password', requireLogin, wrap(async (req, res) => {
    const b = z.object({ newPassword: z.string().max(300), currentPassword: z.string().max(300).optional() }).parse(req.body);
    const acc = await mine(req); await checkCurrent(req, acc, b.currentPassword);
    const problem = joinerPasswordProblem(b.newPassword, acc.email); if (problem) throw new HttpError(400, problem, 'weak_password');
    const had = !!acc.password_hash;
    await pool.query('UPDATE accounts SET password_hash = ?, password_set_at = NOW(3), password_nudge_off = 1, failed_logins = 0, locked_until = NULL WHERE id = ?', [await hashPassword(b.newPassword), acc.id]);
    await audit(pool, acc.id, had ? 'password.change' : 'password.set', 'account', acc.id, { ip: req.ip });
    await notice(acc.email, had ? 'changed' : 'set');
    res.json({ ok: true, hasPassword: true });
  }));
  r.delete('/api/my/password', requireLogin, wrap(async (req, res) => {
    const b = z.object({ currentPassword: z.string().max(300).optional() }).parse(req.body || {});
    const acc = await mine(req); if (!acc.password_hash) throw new HttpError(409, "You haven't set a password.", 'no_password');
    await checkCurrent(req, acc, b.currentPassword);
    await pool.query('UPDATE accounts SET password_hash = NULL, password_set_at = NULL, failed_logins = 0, locked_until = NULL WHERE id = ?', [acc.id]);
    await audit(pool, acc.id, 'password.remove', 'account', acc.id, { ip: req.ip });
    await notice(acc.email, 'removed');
    res.json({ ok: true, hasPassword: false });
  }));
  r.post('/api/my/password/nudge-off', requireLogin, wrap(async (req, res) => {            // "No thanks": the card is not shown again
    const acc = await mine(req); await pool.query('UPDATE accounts SET password_nudge_off = 1 WHERE id = ?', [acc.id]); res.json({ ok: true });
  }));

  return r;
}
