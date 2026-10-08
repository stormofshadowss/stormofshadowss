import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireAdmin, requireLogin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { bad, conflict, notFound, HttpError } from '../errors.js';
import { normalizeHandle, isValidHandle } from '../lib/handles.js';
import { resolveJoiner } from '../lib/joiner.js';
import { addFixed, removeFixed, changeFixed } from '../lib/fixed.js';

const FIXED_SELECT = `SELECT f.id, f.item_id AS itemId, f.member_name AS member, f.set_id AS setId, s.set_number AS setNumber, s.admin_decision AS setDecision,
    i.title AS itemTitle, go.id AS orderId, go.title AS orderTitle, IF(im.price IS NULL AND i.price_tbc = 1, NULL, COALESCE(im.price, i.price)) AS price,
    (SELECT IF(i.price_tbc = 1 AND SUM(m2.price IS NULL) > 0, NULL, COALESCE(SUM(COALESCE(m2.price, i.price)), 0)) FROM item_members m2 WHERE m2.item_id = i.id) AS wholeSetPrice,
    (SELECT COUNT(*) FROM item_members m4 WHERE m4.item_id = i.id) AS partCount,
    (SELECT COUNT(*) FROM item_members m3 WHERE m3.item_id = i.id AND m3.price IS NOT NULL AND m3.price <> i.price) > 0 AS mixed,
    c.id AS claimId, c.status AS claimStatus, j.instagram_handle AS handle
  FROM fixed_claims f JOIN item_sets s ON s.id = f.set_id JOIN items i ON i.id = f.item_id JOIN group_orders go ON go.id = i.order_id JOIN joiners j ON j.id = f.joiner_id
  LEFT JOIN item_members im ON im.item_id = i.id AND im.name = f.member_name
  LEFT JOIN claims c ON c.set_id = f.set_id AND c.member_name = f.member_name AND c.joiner_id = f.joiner_id AND c.is_fixed = 1 AND c.status <> 'cancelled'`;

export function fixedRoutes(app, { pool }) {
  const me = [requireLogin], admin = [requireAdmin];

  // ───────── the joiner's own fixed claims ─────────
  app.get('/api/my/fixed', me, wrap(async (req, res) => {
    const j = await resolveJoiner(pool, req);
    const [fixed] = await pool.query(`${FIXED_SELECT} WHERE f.joiner_id = ? AND f.ended_at IS NULL ORDER BY go.id, i.id, s.set_number`, [j.id]);
    const [reqs] = await pool.query(
      `SELECT r.id, r.fixed_claim_id AS fixedClaimId, r.action, r.status, r.created_at AS createdAt, r.resolved_at AS resolvedAt, i.title AS itemTitle, f.member_name AS member, s.set_number AS setNumber
         FROM fixed_requests r JOIN fixed_claims f ON f.id = r.fixed_claim_id JOIN items i ON i.id = f.item_id JOIN item_sets s ON s.id = f.set_id
        WHERE r.joiner_id = ? ORDER BY r.id DESC LIMIT 50`, [j.id]);
    res.json({
      fixed: fixed.map((f) => ({ ...f, priceTbc: f.price === null, mixed: !!f.mixed, canChangeNow: f.setDecision !== 'secured', pending: reqs.find((r) => r.fixedClaimId === f.id && r.status === 'pending') || null })),
      requests: reqs,
    });
  }));

  // Give up / swap to the full set. Instant until THAT set is secured; after that it's a request for the GOM to approve.
  app.post('/api/my/fixed/:id/change', me, wrap(async (req, res) => {
    const { action } = z.object({ action: z.enum(['giveup', 'ot8']) }).parse(req.body);
    const j = await resolveJoiner(pool, req);
    const id = Number(req.params.id);
    const out = await withTx(pool, async (conn) => {
      const [[f]] = await conn.query('SELECT f.id, f.set_id, s.admin_decision AS decision FROM fixed_claims f JOIN item_sets s ON s.id = f.set_id WHERE f.id = ? AND f.joiner_id = ? AND f.ended_at IS NULL', [id, j.id]);
      if (!f) throw notFound('No such fixed claim');
      const [pending] = await conn.query("SELECT id FROM fixed_requests WHERE fixed_claim_id = ? AND status = 'pending'", [id]);
      if (pending.length) throw conflict('You already have a request waiting for the GOM on this one', 'request_pending');
      if (f.decision !== 'secured') return { instant: true, ...(await changeFixed(conn, id, action)) };
      const [r] = await conn.query('INSERT INTO fixed_requests (joiner_id, fixed_claim_id, action) VALUES (?,?,?)', [j.id, id, action]);
      return { instant: false, requestId: r.insertId };
    });
    res.status(out.instant ? 200 : 202).json({ ok: true, ...out });
  }));

  app.post('/api/my/fixed/requests/:id/withdraw', me, wrap(async (req, res) => {
    const j = await resolveJoiner(pool, req);
    const [r] = await pool.query("UPDATE fixed_requests SET status = 'withdrawn', resolved_at = NOW(3) WHERE id = ? AND joiner_id = ? AND status = 'pending'", [Number(req.params.id), j.id]);
    if (r.affectedRows !== 1) throw notFound('No such waiting request');
    res.json({ ok: true });
  }));

  // ───────── the GOM ─────────
  app.get('/api/admin/items/:id/fixed', admin, wrap(async (req, res) => {
    const [rows] = await pool.query(`${FIXED_SELECT} WHERE f.item_id = ? AND f.ended_at IS NULL ORDER BY f.member_name, s.set_number`, [Number(req.params.id)]);
    res.json({ fixed: rows });
  }));

  app.post('/api/admin/items/:id/fixed', admin, wrap(async (req, res) => {
    const b = z.object({ handle: z.string().min(1).max(40), member: z.string().min(1).max(80) }).parse(req.body);
    const handle = normalizeHandle(b.handle);
    if (!isValidHandle(handle)) throw bad('That is not a valid Instagram handle');
    const itemId = Number(req.params.id);
    const out = await withTx(pool, async (conn) => {
      const [[it]] = await conn.query('SELECT id, item_type FROM items WHERE id = ? FOR UPDATE', [itemId]);
      if (!it) throw notFound('No such item');
      if (it.item_type !== 'set') throw bad('Fixed claims only apply to member sets', 'not_a_set');
      await conn.query('INSERT IGNORE INTO joiners (instagram_handle) VALUES (?)', [handle]);
      const [[j]] = await conn.query('SELECT id, is_blocked FROM joiners WHERE instagram_handle = ?', [handle]);
      if (j.is_blocked) throw new HttpError(403, 'That handle is blocked', 'handle_blocked');
      const r = await addFixed(conn, { itemId, joinerId: j.id, member: b.member });
      await audit(conn, req.account.id, 'fixed.add', 'item', itemId, { handle, member: b.member });
      return r;
    });
    res.status(201).json({ ok: true, ...out });
  }));

  app.delete('/api/admin/fixed/:id', admin, wrap(async (req, res) => {
    const out = await withTx(pool, async (conn) => {
      const r = await removeFixed(conn, Number(req.params.id), 'removed', 'Fixed claim removed by the GOM');
      await audit(conn, req.account.id, 'fixed.remove', 'fixed', Number(req.params.id), { member: r.member });
      return r;
    });
    res.json({ ok: true, refunded: out.refunded, forfeited: out.forfeited });
  }));

  // "Copy from another comeback": give this item the same regulars (same people, same members) as an earlier one.
  app.post('/api/admin/items/:id/fixed/copy', admin, wrap(async (req, res) => {
    const { fromItemId } = z.object({ fromItemId: z.number().int().positive() }).parse(req.body);
    const itemId = Number(req.params.id);
    if (fromItemId === itemId) throw bad('Pick a different item to copy from');
    const out = await withTx(pool, async (conn) => {
      const [[it]] = await conn.query('SELECT id, item_type FROM items WHERE id = ? FOR UPDATE', [itemId]);
      if (!it) throw notFound('No such item');
      if (it.item_type !== 'set') throw bad('Fixed claims only apply to member sets', 'not_a_set');
      const [src] = await conn.query('SELECT DISTINCT joiner_id, member_name FROM fixed_claims WHERE item_id = ? AND ended_at IS NULL ORDER BY id', [fromItemId]);
      let added = 0; const skipped = [];
      for (const s of src) {
        const [[j]] = await conn.query('SELECT instagram_handle, is_blocked FROM joiners WHERE id = ?', [s.joiner_id]);
        if (j.is_blocked) { skipped.push(`@${j.instagram_handle} (blocked)`); continue; }
        try { await addFixed(conn, { itemId, joinerId: s.joiner_id, member: s.member_name }); added++; }
        catch (e) { if (e instanceof HttpError && (e.status === 400 || e.status === 409)) skipped.push(`@${j.instagram_handle} — ${s.member_name}: ${e.message}`); else throw e; }
      }
      await audit(conn, req.account.id, 'fixed.copy', 'item', itemId, { fromItemId, added });
      return { added, skipped };
    });
    res.json({ ok: true, ...out });
  }));

  // Requests waiting for you: someone whose set is already secured wants to give up or swap.
  app.get('/api/admin/fixed-requests', admin, wrap(async (req, res) => {
    const status = ['pending', 'approved', 'declined', 'withdrawn', 'void'].includes(req.query.status) ? req.query.status : 'pending';
    const [rows] = await pool.query(
      `SELECT r.id, r.action, r.status, r.created_at AS createdAt, j.instagram_handle AS handle, f.member_name AS member, s.set_number AS setNumber, s.admin_decision AS setDecision,
              i.title AS itemTitle, go.title AS orderTitle
         FROM fixed_requests r JOIN fixed_claims f ON f.id = r.fixed_claim_id JOIN joiners j ON j.id = r.joiner_id JOIN items i ON i.id = f.item_id JOIN group_orders go ON go.id = i.order_id JOIN item_sets s ON s.id = f.set_id
        WHERE r.status = ? ORDER BY r.id`, [status]);
    res.json({ requests: rows });
  }));

  const resolve = (approve) => wrap(async (req, res) => {
    const id = Number(req.params.id);
    const out = await withTx(pool, async (conn) => {
      const [[r]] = await conn.query('SELECT r.fixed_claim_id, r.action, f.ended_at FROM fixed_requests r JOIN fixed_claims f ON f.id = r.fixed_claim_id WHERE r.id = ?', [id]);
      if (!r) throw notFound('No such request');
      // claim the request first, so approving twice at once can only ever do the work once
      const [u] = await conn.query("UPDATE fixed_requests SET status = ?, resolved_at = NOW(3) WHERE id = ? AND status = 'pending'", [approve ? (r.ended_at ? 'void' : 'approved') : 'declined', id]);
      if (u.affectedRows !== 1) throw conflict('That request has already been dealt with', 'not_pending');
      let result = {};
      if (approve && !r.ended_at) result = await changeFixed(conn, r.fixed_claim_id, r.action);
      await audit(conn, req.account.id, approve ? 'fixed.approve' : 'fixed.decline', 'fixed_request', id, { action: r.action });
      return { voided: approve && !!r.ended_at, ...result };
    });
    res.json({ ok: true, ...out });
  });
  app.post('/api/admin/fixed-requests/:id/approve', admin, resolve(true));
  app.post('/api/admin/fixed-requests/:id/decline', admin, resolve(false));
}
