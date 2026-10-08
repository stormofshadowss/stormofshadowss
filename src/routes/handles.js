import express from 'express';
import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireLogin, requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { bad, conflict, notFound } from '../errors.js';
import { normalizeHandle, isValidHandle } from '../lib/handles.js';
import { readDevice, deviceHasProof } from '../lib/device.js';
import { linkJoiner } from '../lib/linking.js';

// Does this handle already have anything attached to it (orders, money, an address…)?
// If so, a new sign-in can't just take it over — the GOM has to say yes once.
async function joinerHasStake(conn, joinerId) {
  const [[r]] = await conn.query(
    `SELECT (SELECT COUNT(*) FROM claims WHERE joiner_id = ?)
          + (SELECT COUNT(*) FROM payments WHERE joiner_id = ?)
          + (SELECT COUNT(*) FROM addresses WHERE joiner_id = ?)
          + (SELECT COUNT(*) FROM fixed_claims WHERE joiner_id = ?)
          + (SELECT COUNT(*) FROM credit_ledger WHERE joiner_id = ?) AS n`,
    [joinerId, joinerId, joinerId, joinerId, joinerId]);
  return r.n > 0;
}

export default function handleRoutes({ pool }) {
  const r = express.Router();

  // "This Instagram handle is mine."
  r.post('/me/handles', requireLogin, wrap(async (req, res) => {
    const { handle: raw } = z.object({ handle: z.string().min(1).max(40) }).parse(req.body);
    const handle = normalizeHandle(raw);
    if (!isValidHandle(handle)) throw bad('Instagram handles use letters, numbers, full stops and underscores (up to 30 characters).');

    const out = await withTx(pool, async (conn) => {
      let [[joiner]] = await conn.query('SELECT id, account_id FROM joiners WHERE instagram_handle = ? FOR UPDATE', [handle]).then(([rows]) => [rows]);
      if (!joiner) {
        const [ins] = await conn.query("INSERT INTO joiners (instagram_handle, account_id, linked_at, linked_via) VALUES (?, ?, NOW(3), 'self_new')", [handle, req.account.id]);
        return { status: 'linked', handle, joinerId: ins.insertId };
      }
      if (joiner.account_id === req.account.id) return { status: 'already_linked', handle, joinerId: joiner.id };
      if (joiner.account_id) throw conflict('That handle is already linked to another account. Message the GOM if it should be yours.', 'handle_taken');
      if (!(await joinerHasStake(conn, joiner.id))) {
        await linkJoiner(conn, joiner.id, req.account.id, 'self_new');
        return { status: 'linked', handle, joinerId: joiner.id };
      }
      // This browser is the one that made the first claim for the handle: that's proof enough, no GOM approval needed.
      if (await deviceHasProof(conn, readDevice(req), joiner.id)) {
        await linkJoiner(conn, joiner.id, req.account.id, 'claim_device');
        return { status: 'linked', handle, joinerId: joiner.id };
      }
      const [[existing]] = await conn.query(
        "SELECT id FROM handle_link_requests WHERE account_id = ? AND joiner_id = ? AND status = 'pending'", [req.account.id, joiner.id]).then(([rows]) => [rows]);
      if (!existing) await conn.query('INSERT INTO handle_link_requests (account_id, joiner_id) VALUES (?, ?)', [req.account.id, joiner.id]);
      return { status: 'pending_approval', handle, joinerId: joiner.id };
    });
    res.status(out.status === 'pending_approval' ? 202 : 200).json(out);
  }));

  // "Delete my account": removes the login and the personal details (address, phone, email on file).
  // The order history stays, because it's the GOM's financial record. If money is still owed or held
  // the handle shows up in the GOM's "flagged" list so they can decide what to do.
  r.delete('/me', requireLogin, wrap(async (req, res) => {
    z.object({ confirm: z.literal(true) }).parse(req.body);
    const handles = await withTx(pool, async (conn) => {
      const [js] = await conn.query('SELECT id, instagram_handle FROM joiners WHERE account_id = ? ORDER BY id FOR UPDATE', [req.account.id]);
      for (const j of js) {
        const [busy] = await conn.query(
          "SELECT 1 FROM parcels WHERE joiner_id = ? AND status IN ('requested','packed','shipped') LIMIT 1", [j.id]);
        if (busy.length) throw conflict(`A parcel for @${j.instagram_handle} is still on its way — you can delete your account once it has arrived.`, 'parcel_in_progress');
      }
      for (const j of js) {
        await conn.query('DELETE FROM addresses WHERE joiner_id = ?', [j.id]);
        await conn.query('UPDATE joiners SET account_deleted_at = NOW(3) WHERE id = ?', [j.id]);
      }
      await conn.query('DELETE FROM login_tokens WHERE email = ?', [req.account.email]);
      await conn.query('DELETE FROM accounts WHERE id = ?', [req.account.id]);   // sessions and link requests go with it; handles are unlinked
      await audit(conn, null, 'account.delete', 'joiner', null, { handles: js.map((j) => j.instagram_handle) });
      return js.map((j) => j.instagram_handle);
    });
    res.clearCookie('sos_session', { path: '/' });
    res.json({ ok: true, handles });
  }));

  // ── GOM side ──
  r.get('/admin/handle-requests', requireAdmin, wrap(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT l.id, l.created_at, a.email, j.instagram_handle AS handle,
              (SELECT COUNT(*) FROM claims WHERE joiner_id = j.id) AS claims
         FROM handle_link_requests l JOIN accounts a ON a.id = l.account_id JOIN joiners j ON j.id = l.joiner_id
        WHERE l.status = 'pending' ORDER BY l.id`);
    res.json({ requests: rows });
  }));

  const resolve = (approve) => wrap(async (req, res) => {
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[reqRow]] = await conn.query("SELECT * FROM handle_link_requests WHERE id = ? AND status = 'pending' FOR UPDATE", [id]).then(([rows]) => [rows]);
      if (!reqRow) throw notFound('No pending request with that id');
      if (approve) {
        const [[j]] = await conn.query('SELECT account_id FROM joiners WHERE id = ? FOR UPDATE', [reqRow.joiner_id]).then(([rows]) => [rows]);
        if (j.account_id && j.account_id !== reqRow.account_id) throw conflict('That handle has since been linked to someone else.');
        await linkJoiner(conn, reqRow.joiner_id, reqRow.account_id, 'approved');
        await conn.query("UPDATE handle_link_requests SET status='declined', resolved_at = NOW(3) WHERE joiner_id = ? AND status='pending' AND id <> ?", [reqRow.joiner_id, id]);
      }
      await conn.query('UPDATE handle_link_requests SET status = ?, resolved_at = NOW(3) WHERE id = ?', [approve ? 'approved' : 'declined', id]);
      await audit(conn, req.account.id, approve ? 'handle.approve' : 'handle.decline', 'joiner', reqRow.joiner_id);
    });
    res.json({ ok: true });
  });
  r.post('/admin/handle-requests/:id/approve', requireAdmin, resolve(true));
  r.post('/admin/handle-requests/:id/decline', requireAdmin, resolve(false));

  // Who linked an email lately, how, and whether you've checked them. (Review after the fact — nothing waits on you.)
  r.get('/admin/joiners/recent-links', requireAdmin, wrap(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const [rows] = await pool.query(
      `SELECT j.id AS joinerId, j.instagram_handle AS handle, a.email, j.linked_at AS linkedAt, j.linked_via AS linkedVia, j.verified_at AS verifiedAt,
              (SELECT COUNT(*) FROM claims WHERE joiner_id = j.id AND status <> 'cancelled') AS claims
         FROM joiners j JOIN accounts a ON a.id = j.account_id
        WHERE j.linked_at > NOW(3) - INTERVAL ? DAY ORDER BY j.linked_at DESC LIMIT 500`, [days]);
    res.json({ links: rows.map((r2) => ({ ...r2, verified: !!r2.verifiedAt })) });
  }));
  // "I've checked this person is who they say" (e.g. over Instagram DMs). Unverified handles are flagged in the packing queue.
  for (const [name, sql] of [['verify', 'verified_at = NOW(3)'], ['unverify', 'verified_at = NULL']]) {
    r.post(`/admin/joiners/${name}`, requireAdmin, wrap(async (req, res) => {
      const { handle } = z.object({ handle: z.string().min(1).max(40) }).parse(req.body);
      const [r2] = await pool.query(`UPDATE joiners SET ${sql} WHERE instagram_handle = ?`, [normalizeHandle(handle)]);
      if (r2.affectedRows !== 1) throw notFound('No such handle');
      await audit(pool, req.account.id, `joiner.${name}`, 'joiner', null, { handle });
      res.json({ ok: true });
    }));
  }

  // Detach a handle from its account (e.g. someone changed email).
  r.delete('/admin/joiners/:id/account', requireAdmin, wrap(async (req, res) => {
    await pool.query('UPDATE joiners SET account_id = NULL, linked_at = NULL, linked_via = NULL WHERE id = ?', [Number(req.params.id)]);
    res.json({ ok: true });
  }));

  return r;
}
