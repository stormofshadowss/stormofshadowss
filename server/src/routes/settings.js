import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { wrap, esc } from '../lib/http.js';
import { requireLogin, createLoginToken } from '../auth.js';
import { bad, conflict, forbidden, HttpError } from '../errors.js';
import { resolveJoiner } from '../lib/joiner.js';

// A joiner's own settings: changing their sign-in email, and their saved shipping defaults (bias / Lomo name).
// (Handles, deleting the account and the per-kind email choices live with the routes they extend: handles.js and me.js.)
export function settingsRoutes(app, { pool, cfg, mailer }) {
  // Public, tiny: what the privacy notice needs from the server.
  app.get('/api/site-info', (req, res) => res.json({ contactEmail: cfg.contactEmail || null }));

  const limiter = rateLimit({
    windowMs: 3_600_000, limit: cfg.rateLimits.requestLinkPerHourPerIp, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many requests from here — please try again later.' },
  });

  // 1) Ask to change the sign-in email. A confirmation link goes to the NEW address; nothing changes until it is opened there
  //    (so nobody can point an account at an address they don't control). Only the newest link works.
  app.post('/api/my/email/change', requireLogin, limiter, wrap(async (req, res) => {
    const { email } = z.object({ email: z.string().trim().toLowerCase().email('That doesn\'t look like an email address').max(254) }).parse(req.body);
    if (req.account.isAdmin) throw forbidden('Admin accounts sign in with a password, not an email link.');
    if (email === req.account.email) throw bad("That's already your sign-in email.", 'same_email');
    const [[clash]] = await pool.query('SELECT 1 AS x FROM accounts WHERE email = ?', [email]);
    if (clash) throw conflict('That email is already used by another account.', 'email_taken');
    await pool.query('UPDATE login_tokens SET used_at = NOW(3) WHERE change_account_id = ? AND used_at IS NULL', [req.account.id]);
    const token = await createLoginToken(pool, cfg, email, req.ip, null, null, req.account.id);
    if (!token) throw new HttpError(429, 'Too many links requested for that address — please try again later.', 'rate_limited');
    const url = `${cfg.publicUrl}/auth/confirm?token=${encodeURIComponent(token)}`;
    try {
      await mailer.send({
        to: email, subject: 'Confirm your new StormOfShadowss sign-in email',
        text: `Someone (hopefully you) asked to use this address as the sign-in email for a StormOfShadowss account.\n\nTo confirm, open this link (it works once and expires in ${cfg.loginLinkMinutes} minutes):\n\n${url}\n\nIf it wasn't you, ignore this email and nothing will change.`,
        html: `<p>Someone (hopefully you) asked to use this address as the sign-in email for a StormOfShadowss account.</p><p><a href="${esc(url)}">Confirm my new email</a> — it works once and expires in ${cfg.loginLinkMinutes} minutes.</p><p>If it wasn't you, ignore this email and nothing will change.</p>`,
      });
    } catch (err) {
      console.error('mail failed:', err.message);
      return res.status(503).json({ error: "We couldn't send the email just now — please try again in a minute." });
    }
    res.json({ ok: true, message: `We've sent a confirmation link to ${email}. Your sign-in email changes when you open it there (it expires in ${cfg.loginLinkMinutes} minutes), and you'll be signed out on your other devices.` });
  }));

  // 2) Saved shipping defaults for one handle: pre-filled (never forced) when they ask for shipping.
  app.get('/api/my/defaults', requireLogin, wrap(async (req, res) => {
    const j = await resolveJoiner(pool, req);
    const [[d]] = await pool.query('SELECT bias, lomo_name FROM joiner_defaults WHERE joiner_id = ?', [j.id]);
    res.json({ handle: j.handle, bias: d?.bias || '', lomoName: d?.lomo_name || '' });
  }));
  app.put('/api/my/defaults', requireLogin, wrap(async (req, res) => {
    const b = z.object({ handle: z.string().max(40).optional(), bias: z.string().trim().max(80).optional(), lomoName: z.string().trim().max(80).optional() }).parse(req.body);
    const j = await resolveJoiner(pool, req);
    if (!b.bias && !b.lomoName) await pool.query('DELETE FROM joiner_defaults WHERE joiner_id = ?', [j.id]);
    else await pool.query('INSERT INTO joiner_defaults (joiner_id, bias, lomo_name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE bias = VALUES(bias), lomo_name = VALUES(lomo_name)', [j.id, b.bias || null, b.lomoName || null]);
    res.json({ ok: true, handle: j.handle, bias: b.bias || '', lomoName: b.lomoName || '' });
  }));
}
