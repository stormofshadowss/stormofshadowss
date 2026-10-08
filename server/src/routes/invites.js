import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { wrap, esc } from '../lib/http.js';
import { requireAdmin, requireLogin, createLoginToken } from '../auth.js';
import { withTx } from '../db.js';
import { bad, conflict, notFound } from '../errors.js';
import { normalizeHandle, isValidHandle } from '../lib/handles.js';
import { lockJoiner } from '../lib/ledger.js';
import { createInvite, findInvite, redeemInvite, inviteUrl } from '../lib/invites.js';

const MAX_PER_CALL = 1000;

// "Claim your orders": the GOM makes a one-time link for each person who has orders but hasn't signed in (everyone an import brought across) and sends it to them,
// e.g. by Instagram DM. Opening it and signing in links their handle straight away. The link lives in the #fragment, so it never reaches a server log.
export function inviteRoutes(app, { pool, cfg, mailer }) {
  const admin = [requireAdmin];
  const publicLimit = rateLimit({ windowMs: 3_600_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts from here — please try again later.' } });
  const linkLimit = rateLimit({ windowMs: 3_600_000, limit: cfg.rateLimits.requestLinkPerHourPerIp, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many sign-in requests from here — please try again later.' } });
  const GONE = 'This link is not valid any more — it may have expired or already been used. Ask for a new one.';

  // everyone who has orders but no account behind their handle (blocked and deleted people aren't invited)
  const ELIGIBLE = `FROM joiners j
      LEFT JOIN handle_invites inv ON inv.id = (SELECT MAX(i2.id) FROM handle_invites i2 WHERE i2.joiner_id = j.id)
     WHERE j.account_id IS NULL AND j.account_deleted_at IS NULL AND j.is_blocked = 0
       AND EXISTS (SELECT 1 FROM claims c WHERE c.joiner_id = j.id AND c.status <> 'cancelled')`;
  const statusOf = (r) => (!r.inviteId || r.revokedAt || r.usedAt ? 'none' : r.live ? 'active' : 'expired');

  app.get('/api/admin/invites', admin, wrap(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT j.id, j.instagram_handle AS handle,
              (SELECT COUNT(*) FROM claims c WHERE c.joiner_id = j.id AND c.status <> 'cancelled') AS claims,
              (SELECT COALESCE(SUM(GREATEST(cc.cost - cc.paid, 0)), 0) FROM claim_costs cc JOIN claims c ON c.id = cc.claim_id WHERE c.joiner_id = j.id AND c.status = 'confirmed') AS owed,
              inv.id AS inviteId, inv.created_at AS createdAt, inv.expires_at AS expiresAt, inv.used_at AS usedAt, inv.revoked_at AS revokedAt, (inv.expires_at > NOW(3)) AS live
         ${ELIGIBLE} ORDER BY j.instagram_handle LIMIT 3000`);
    const people = rows.map((r) => ({ handle: r.handle, claims: r.claims, owed: Math.round(r.owed * 100) / 100, status: statusOf(r), createdAt: r.createdAt, expiresAt: r.expiresAt }));
    const totals = { unlinked: people.length, none: 0, active: 0, expired: 0 };
    for (const p of people) totals[p.status] += 1;
    const [[l]] = await pool.query('SELECT COUNT(DISTINCT j.id) AS n FROM joiners j JOIN claims c ON c.joiner_id = j.id WHERE j.account_id IS NOT NULL');
    totals.linked = l.n;
    const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, ''), f = String(req.query.filter || 'all');
    res.json({ totals, days: cfg.inviteDays, people: people.filter((p) => (f === 'all' || p.status === f) && (!q || p.handle.includes(q))) });
  }));

  // Make links — for the handles given, or (mode "missing") for everyone who has no live link. A new link replaces any earlier one for that person.
  app.post('/api/admin/invites', admin, wrap(async (req, res) => {
    const b = z.object({ handles: z.array(z.string().max(60)).max(MAX_PER_CALL).optional(), mode: z.enum(['missing']).optional() }).parse(req.body);
    if (!b.handles?.length && b.mode !== 'missing') throw bad('Say who to make links for.');
    const links = [], skipped = [];
    await withTx(pool, async (conn) => {
      let wanted = [];
      if (b.mode === 'missing') {
        const [rows] = await conn.query(`SELECT j.instagram_handle AS handle, inv.id AS inviteId, inv.revoked_at AS revokedAt, inv.used_at AS usedAt, (inv.expires_at > NOW(3)) AS live ${ELIGIBLE} ORDER BY j.instagram_handle LIMIT ?`, [MAX_PER_CALL + 1]);
        wanted = rows.filter((r) => statusOf(r) !== 'active').map((r) => r.handle);
        if (wanted.length > MAX_PER_CALL) throw bad(`That's more than ${MAX_PER_CALL} people at once — make links for a smaller group first.`, 'too_many');
      } else wanted = [...new Set(b.handles.map(normalizeHandle))];
      for (const handle of wanted) {
        if (!isValidHandle(handle)) { skipped.push({ handle, reason: "isn't a valid handle" }); continue; }
        const [[j0]] = await conn.query('SELECT id FROM joiners WHERE instagram_handle = ?', [handle]);
        if (!j0) { skipped.push({ handle, reason: 'is not on the site' }); continue; }
        await lockJoiner(conn, j0.id);
        const [[j]] = await conn.query('SELECT account_id, is_blocked, account_deleted_at FROM joiners WHERE id = ?', [j0.id]);
        if (j.account_id) { skipped.push({ handle, reason: 'has already signed in' }); continue; }
        if (j.is_blocked) { skipped.push({ handle, reason: 'is blocked' }); continue; }
        const inv = await createInvite(conn, { joinerId: j0.id, accountId: req.account.id, days: cfg.inviteDays });
        links.push({ handle, url: inviteUrl(cfg, inv.token), expiresAt: inv.expiresAt });
      }
    });
    res.status(201).json({ ok: true, links, skipped, days: cfg.inviteDays });
  }));

  app.post('/api/admin/invites/revoke', admin, wrap(async (req, res) => {
    const { handle } = z.object({ handle: z.string().min(1).max(60) }).parse(req.body);
    const [r] = await pool.query(
      `UPDATE handle_invites SET revoked_at = NOW(3) WHERE used_at IS NULL AND revoked_at IS NULL AND joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)`, [normalizeHandle(handle)]);
    res.json({ ok: true, revoked: r.affectedRows });
  }));

  // ───────── the person opening their link ─────────
  app.get('/api/invites/:token', publicLimit, wrap(async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const inv = await findInvite(pool, req.params.token);
    if (!inv || inv.accountId) return res.status(404).json({ valid: false, error: GONE });
    res.json({ valid: true, handle: inv.handle, expiresAt: inv.expiresAt });
  }));

  // Not signed in yet: the usual sign-in email, but remembering which handle it is for. The handle is linked only when the emailed link is used.
  app.post('/api/invites/:token/request-link', linkLimit, wrap(async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const { email } = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).parse(req.body);
    const inv = await findInvite(pool, req.params.token);
    if (!inv || inv.accountId) throw notFound(GONE);
    const [[isAdminEmail]] = await pool.query('SELECT 1 AS x FROM accounts WHERE email = ? AND is_admin = 1', [email]);
    const token = isAdminEmail ? null : await createLoginToken(pool, cfg, email, req.ip, inv.joinerId, inv.id);
    if (token) {
      const url = `${cfg.publicUrl}/auth/confirm?token=${encodeURIComponent(token)}`;
      try {
        await mailer.send({
          to: email, subject: 'Your StormOfShadowss sign-in link — your orders are ready',
          text: `Here's your sign-in link (it works once and expires in ${cfg.loginLinkMinutes} minutes):\n\n${url}\n\nSigning in with it links @${inv.handle}'s orders to this email address.\n\nIf you didn't ask for this, you can ignore this email.`,
          html: `<p>Here's your sign-in link. It works once and expires in ${cfg.loginLinkMinutes} minutes.</p><p><a href="${esc(url)}">Sign in to StormOfShadowss</a></p><p>Signing in with it links <strong>@${esc(inv.handle)}</strong>'s orders to this email address.</p><p>If you didn't ask for this, you can ignore this email.</p>`,
        });
      } catch (err) {
        console.error('mail failed:', err.message);
        return res.status(503).json({ error: "We couldn't send the email just now — please try again in a minute." });
      }
    }
    res.json({ ok: true, message: `A sign-in link is on its way. It works once and expires in ${cfg.loginLinkMinutes} minutes.` });
  }));

  // Already signed in: link it straight away.
  app.post('/api/invites/:token/redeem', requireLogin, publicLimit, wrap(async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const out = await withTx(pool, async (conn) => {
      const inv = await findInvite(conn, req.params.token, { lock: true });
      if (!inv) throw notFound(GONE);
      if (inv.accountId && inv.accountId !== req.account.id) throw conflict(GONE, 'gone');
      const r = await redeemInvite(conn, inv.id, req.account.id);
      if (!r) throw conflict(GONE, 'gone');
      return { handle: inv.handle };
    });
    res.json({ ok: true, ...out });
  }));
}

