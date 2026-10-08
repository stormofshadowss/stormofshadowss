import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { HttpError } from '../errors.js';
import { startAdminSession, sessionCookieOptions, COOKIE, audit } from '../auth.js';
import { verifyPassword, dummyHash } from '../lib/password.js';

export default function adminAuthRoutes({ cfg, pool }) {
  const r = express.Router();
  const limiter = rateLimit({
    windowMs: 15 * 60_000, limit: cfg.rateLimits.adminLoginPer15MinPerIp, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many sign-in attempts from here — please wait a few minutes.' },
  });
  // One message for every kind of failure, so it never reveals whether a username exists or is locked.
  const bad = () => new HttpError(401, 'Wrong username or password — or this account is locked for a few minutes after repeated mistakes.', 'bad_login');

  r.post('/api/admin/login', limiter, wrap(async (req, res) => {
    const { username, password } = z.object({
      username: z.string().trim().toLowerCase().min(1).max(40),
      password: z.string().min(1).max(200),
    }).parse(req.body);

    const [[acc]] = await pool.query(
      'SELECT id, password_hash, (locked_until IS NOT NULL AND locked_until > NOW(3)) AS locked FROM accounts WHERE username = ? AND is_admin = 1', [username]);
    if (!acc || acc.locked) {                       // unknown or locked: still do the slow work, so timing gives nothing away
      await verifyPassword(password, await dummyHash());
      throw bad();
    }
    if (!(await verifyPassword(password, acc.password_hash))) {
      await pool.query('UPDATE accounts SET failed_logins = failed_logins + 1 WHERE id = ?', [acc.id]);
      const [[{ n }]] = await pool.query('SELECT failed_logins AS n FROM accounts WHERE id = ?', [acc.id]);
      if (n >= cfg.adminMaxFailures) {
        await pool.query('UPDATE accounts SET failed_logins = 0, locked_until = NOW(3) + INTERVAL ? MINUTE WHERE id = ?', [cfg.adminLockMinutes, acc.id]);
        await audit(pool, acc.id, 'admin.locked', 'account', acc.id, { ip: req.ip });
      }
      throw bad();
    }
    await pool.query('UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE id = ?', [acc.id]);
    const token = await startAdminSession(pool, cfg, acc.id, req);
    res.cookie(COOKIE, token, { ...sessionCookieOptions(cfg), maxAge: cfg.adminSessionHours * 3_600_000 });
    await audit(pool, acc.id, 'admin.login', 'account', acc.id, { ip: req.ip });
    res.set('Cache-Control', 'no-store').json({ ok: true, username });
  }));

  return r;
}
