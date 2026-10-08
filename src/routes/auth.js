import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { wrap, esc, simplePage } from '../lib/http.js';
import { createLoginToken, consumeLoginToken, startSession, sessionCookieOptions, COOKIE, requireLogin } from '../auth.js';
import { readDevice, deviceHasProof } from '../lib/device.js';
import { linkJoiner } from '../lib/linking.js';
import { redeemInvite } from '../lib/invites.js';
import { withTx } from '../db.js';
import { normalizeHandle } from '../lib/handles.js';

export default function authRoutes({ cfg, pool, mailer }) {
  const r = express.Router();
  const linkLimiter = rateLimit({
    windowMs: 3_600_000, limit: cfg.rateLimits.requestLinkPerHourPerIp,
    standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many sign-in requests from here — please try again later.' },
  });

  // 1) Ask for a link. Always answers the same, whoever the email belongs to.
  r.post('/api/auth/request-link', linkLimiter, wrap(async (req, res) => {
    const { email, handle } = z.object({ email: z.string().trim().toLowerCase().email().max(254), handle: z.string().max(40).optional() }).parse(req.body);
    const [[isAdminEmail]] = await pool.query('SELECT 1 AS x FROM accounts WHERE email = ? AND is_admin = 1', [email]);
    // Admin accounts sign in with a password. No link is sent — and the answer is the same as for anyone else.
    // "Add my email to my claim": if THIS browser made the claim for that handle (and nobody owns it yet),
    // the sign-in link will also link the handle — no waiting for the GOM.
    let linkJoinerId = null;
    if (handle && !isAdminEmail) {
      const [[j]] = await pool.query('SELECT id, account_id FROM joiners WHERE instagram_handle = ?', [normalizeHandle(handle)]);
      if (j && !j.account_id && await deviceHasProof(pool, readDevice(req), j.id)) linkJoinerId = j.id;
    }
    const token = isAdminEmail ? null : await createLoginToken(pool, cfg, email, req.ip, linkJoinerId);
    if (token) {
      const url = `${cfg.publicUrl}/auth/confirm?token=${encodeURIComponent(token)}`;
      try {
        await mailer.send({
          to: email,
          subject: 'Your StormOfShadowss sign-in link',
          text: `Here's your sign-in link (it works once and expires in ${cfg.loginLinkMinutes} minutes):\n\n${url}\n\nIf you didn't ask for this, you can ignore this email.`,
          html: `<p>Here's your sign-in link. It works once and expires in ${cfg.loginLinkMinutes} minutes.</p><p><a href="${esc(url)}">Sign in to StormOfShadowss</a></p><p>If you didn't ask for this, you can ignore this email.</p>`,
        });
      } catch (err) {
        console.error('mail failed:', err.message);
        return res.status(503).json({ error: "We couldn't send the email just now — please try again in a minute." });
      }
    }
    res.json({
      ok: true, message: `If that email is valid, a sign-in link is on its way. It works once and expires in ${cfg.loginLinkMinutes} minutes.`,
      ...(handle ? { willLinkHandle: !!linkJoinerId } : {}),
    });
  }));

  // 2) The emailed link opens this page. It does NOT sign anyone in by itself:
  //    mail scanners and link previewers fetch links automatically and would
  //    use the token up. Only the button (a POST) signs you in.
  r.get('/auth/confirm', (req, res) => {
    const token = String(req.query.token || '');
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.type('html').send(simplePage('Sign in',
      `<p>Tap the button to finish signing in on this device.</p>
       <form method="post" action="/auth/confirm"><input type="hidden" name="token" value="${esc(token)}">
       <button type="submit">Sign in</button></form>`));
  });

  r.post('/auth/confirm', express.urlencoded({ extended: false, limit: '4kb' }), wrap(async (req, res) => {
    const token = String(req.body?.token || '');
    const used = token ? await consumeLoginToken(pool, token) : null;
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (!used) {
      return res.status(400).type('html').send(simplePage('This link has expired',
        '<p>Sign-in links work once and expire quickly. <a href="/">Get a new one</a>.</p>'));
    }
    const { token: sessionToken, accountId } = await startSession(pool, cfg, used.email, req);
    let invited = false;
    if (used.linkJoinerId) await withTx(pool, async (conn) => {
      if (used.inviteId) invited = !!(await redeemInvite(conn, used.inviteId, accountId));        // an invite link: valid now? then it links, once
      else await linkJoiner(conn, used.linkJoinerId, accountId, 'claim_device');
    });
    res.cookie(COOKIE, sessionToken, sessionCookieOptions(cfg));
    res.redirect(303, invited ? '/my.html' : '/');
  }));

  r.post('/api/auth/logout', wrap(async (req, res) => {
    if (req.sessionId) await pool.query('DELETE FROM sessions WHERE id = ?', [req.sessionId]);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  }));

  r.get('/api/me', requireLogin, wrap(async (req, res) => {
    const [handles] = await pool.query('SELECT id, instagram_handle AS handle FROM joiners WHERE account_id = ? ORDER BY id', [req.account.id]);
    const [pending] = await pool.query(
      `SELECT l.id, j.instagram_handle AS handle FROM handle_link_requests l JOIN joiners j ON j.id = l.joiner_id
        WHERE l.account_id = ? AND l.status = 'pending' ORDER BY l.id`, [req.account.id]);
    res.json({ account: req.account, handles, pending });
  }));

  return r;
}
