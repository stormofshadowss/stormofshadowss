import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireLogin, requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { resolveJoiner } from '../lib/joiner.js';
import { requestCancel, withdrawCancel, approveCancel, declineCancel, MAX_REASON } from '../lib/cancel-requests.js';

const money = z.number().min(0).max(100000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At most 2 decimal places');

// "Ask to cancel": the joiner asks, the GOM decides — and chooses how much of what was paid to keep as a cancellation fee.
export function cancelRequestRoutes(app, { pool }) {
  const auth = [requireLogin];

  app.post('/api/my/claims/:id/cancel-request', auth, wrap(async (req, res) => {
    const b = z.object({ reason: z.string().trim().max(MAX_REASON).optional() }).parse(req.body || {});
    const joiner = await resolveJoiner(pool, req);
    const out = await withTx(pool, (conn) => requestCancel(conn, { joinerId: joiner.id, claimId: Number(req.params.id), reason: b.reason }));
    res.status(201).json({ ok: true, ...out });
  }));
  app.delete('/api/my/cancel-requests/:id', auth, wrap(async (req, res) => {
    const joiner = await resolveJoiner(pool, req);
    await withTx(pool, (conn) => withdrawCancel(conn, { joinerId: joiner.id, requestId: Number(req.params.id) }));
    res.json({ ok: true });
  }));

  // the GOM's list: pending ones (oldest first), or recently decided ones
  app.get('/api/admin/cancel-requests', requireAdmin, wrap(async (req, res) => {
    const decided = req.query.status === 'decided';
    const [rows] = await pool.query(
      `SELECT r.id, r.status, r.reason, r.stage, r.requested_at AS requestedAt, r.decided_at AS decidedAt, r.decision_note AS decisionNote, r.paid_at_decision AS paidAtDecision, r.kept, r.refunded,
              j.instagram_handle AS handle, j.is_blocked AS blocked, c.id AS claimId, c.label, c.status AS claimStatus, c.pipeline, c.set_id AS setId, c.box_id AS boxId, go.title AS orderTitle,
              (SELECT COALESCE(SUM(cost), 0) FROM claim_costs WHERE claim_id = c.id) AS cost, (SELECT COALESCE(SUM(paid), 0) FROM claim_costs WHERE claim_id = c.id) AS paid,
              (SELECT p.id FROM parcel_items pi JOIN parcels p ON p.id = pi.parcel_id WHERE pi.claim_id = c.id AND p.status IN ('requested','packed','shipped') LIMIT 1) AS parcelId
         FROM cancel_requests r JOIN claims c ON c.id = r.claim_id JOIN joiners j ON j.id = r.joiner_id LEFT JOIN group_orders go ON go.id = c.order_id
        WHERE ${decided ? "r.status <> 'pending'" : "r.status = 'pending'"} ORDER BY ${decided ? 'r.decided_at DESC, r.id DESC LIMIT 30' : 'r.requested_at, r.id'}`);
    res.json({ requests: rows.map((r) => ({ ...r, blocked: !!r.blocked, setPart: !!r.setId, cost: Number(r.cost), paid: Number(r.paid),
      problem: r.parcelId ? `It's in parcel ${r.parcelId} — cancel or finish the parcel first.` : r.pipeline === 'completed' ? 'It has already been received.' : null })) });
  }));
  app.post('/api/admin/cancel-requests/:id/approve', requireAdmin, wrap(async (req, res) => {
    const b = z.object({ keep: money.optional(), note: z.string().trim().max(MAX_REASON).optional() }).parse(req.body || {});
    const id = Number(req.params.id);
    const out = await withTx(pool, async (conn) => {
      const r = await approveCancel(conn, { requestId: id, keep: b.keep || 0, note: b.note, adminId: req.account.id });
      await audit(conn, req.account.id, 'cancel_request.approve', 'cancel_request', id, { refunded: r.refunded, kept: r.kept, forfeited: r.forfeited });
      return r;
    });
    app.locals.notifier?.cancelDecided(id);
    res.json({ ok: true, ...out });
  }));
  app.post('/api/admin/cancel-requests/:id/decline', requireAdmin, wrap(async (req, res) => {
    const b = z.object({ note: z.string().trim().max(MAX_REASON).optional() }).parse(req.body || {});
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => { await declineCancel(conn, { requestId: id, note: b.note, adminId: req.account.id }); await audit(conn, req.account.id, 'cancel_request.decline', 'cancel_request', id); });
    app.locals.notifier?.cancelDecided(id);
    res.json({ ok: true });
  }));
}
