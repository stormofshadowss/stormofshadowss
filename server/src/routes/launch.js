import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { bad } from '../errors.js';
import { removeFiles } from '../lib/images.js';
import { launchState, goLive, resetForLaunch } from '../lib/launch.js';
import { testDeletePlan, deleteTestOrder } from '../lib/delete-test-order.js';

const sameWords = (a, b) => String(a || '').trim().replace(/\s+/g, ' ').toLowerCase() === b;

// Launch controls: see what is test data, delete a test order with everything on it, reset everything for launch, and finally go live (which switches all of that off for good).
export function launchRoutes(app, { pool, cfg }) {
  app.get('/api/admin/launch', requireAdmin, wrap(async (req, res) => {
    const [orders] = await pool.query(
      `SELECT go.id, go.title, (SELECT COUNT(*) FROM claims c WHERE c.order_id = go.id) AS claims,
              (SELECT COUNT(DISTINCT pa.payment_id) FROM payment_allocations pa JOIN claims c ON c.id = pa.claim_id WHERE c.order_id = go.id) AS payments
         FROM group_orders go WHERE go.is_test = 1 ORDER BY go.id`);
    res.json({ ...(await launchState(pool)), testOrders: orders.map((o) => ({ id: o.id, title: o.title, claims: Number(o.claims), payments: Number(o.payments) })) });
  }));

  app.post('/api/admin/launch/go-live', requireAdmin, wrap(async (req, res) => {
    const { confirm } = z.object({ confirm: z.string().max(40) }).parse(req.body || {});
    if (!sameWords(confirm, 'go live')) throw bad('To confirm, type GO LIVE.', 'confirm_mismatch');
    await withTx(pool, async (conn) => { await goLive(conn, req.account.id); await audit(conn, req.account.id, 'launch.go_live', 'site', 1); });
    res.json({ ok: true, ...(await launchState(pool)) });
  }));

  app.post('/api/admin/launch/reset', requireAdmin, wrap(async (req, res) => {
    const b = z.object({ confirm: z.string().max(40), backupConfirmed: z.literal(true, { errorMap: () => ({ message: 'Take a backup first and tick the box to say you have.' }) }), keepPeople: z.boolean() }).parse(req.body || {});
    if (!sameWords(b.confirm, 'reset')) throw bad('To confirm, type RESET.', 'confirm_mismatch');
    const out = await withTx(pool, (conn) => resetForLaunch(conn, { keepPeople: b.keepPeople, adminId: req.account.id }));
    for (const f of out.files) await removeFiles(cfg.uploadsDir, f);                // the pictures' files go once the database has committed
    res.json({ ok: true, removed: out.removed });
  }));

  const planReply = (p) => ({ orderId: p.orderId, title: p.title, removes: p.removes, blockers: p.blockers });
  app.get('/api/admin/orders/:id/test-delete-plan', requireAdmin, wrap(async (req, res) => res.json(planReply(await withTx(pool, (conn) => testDeletePlan(conn, Number(req.params.id)))))));
  app.post('/api/admin/orders/:id/test-delete', requireAdmin, wrap(async (req, res) => {
    const { confirm } = z.object({ confirm: z.string().max(300) }).parse(req.body || {});
    const id = Number(req.params.id);
    const out = await withTx(pool, async (conn) => {
      const r = await deleteTestOrder(conn, { orderId: id, confirm });
      await audit(conn, req.account.id, 'order.test_delete', 'order', id, r.plan.removes);
      return r;
    });
    for (const f of out.files) await removeFiles(cfg.uploadsDir, f);
    res.json({ ok: true, title: out.plan.title, removes: out.plan.removes });
  }));
}
