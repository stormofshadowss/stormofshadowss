import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { bad, conflict, notFound } from '../errors.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const KEY = /^(set|item):(\d+)$/;

// What you owe your proxies, as a log: "I paid / need to pay this proxy for these sets and items, by this date".
// A set (or an item) can be logged once, so nothing is paid for twice; ticking a payment as paid files it away.
export function proxyRoutes(app, { pool }) {
  const admin = [requireAdmin];
  const EFFECTIVE = `COALESCE(pi.name, po.name) AS proxy, COALESCE(i.payment_deadline, go.payment_deadline) AS deadline`;
  const JOINS = `JOIN group_orders go ON go.id = i.order_id LEFT JOIN proxies pi ON pi.id = i.proxy_id LEFT JOIN proxies po ON po.id = go.proxy_id`;

  // One row per member-set item that has secured sets not yet logged, and one per ordinary item with confirmed claims not yet logged.
  app.get('/api/admin/proxy/candidates', admin, wrap(async (req, res) => {
    const [sets] = await pool.query(
      `SELECT i.id AS itemId, i.title, go.title AS orderTitle, ${EFFECTIVE}, (SELECT COUNT(*) FROM item_members m WHERE m.item_id = i.id) AS roster, COUNT(s.id) AS count
         FROM items i JOIN item_sets s ON s.item_id = i.id AND s.admin_decision = 'secured' AND s.included_in_proxy_payment = 0 ${JOINS}
        WHERE i.item_type = 'set' AND i.cancelled_at IS NULL AND COALESCE(pi.is_self, po.is_self, 0) = 0 GROUP BY i.id, i.title, go.id, go.title, pi.name, po.name, i.payment_deadline, go.payment_deadline ORDER BY go.id, i.id`);
    const [items] = await pool.query(
      `SELECT i.id AS itemId, i.title, go.title AS orderTitle, ${EFFECTIVE}, COUNT(c.id) AS confirmed,
              (SELECT COALESCE(SUM(x.claim_count), 0) FROM proxy_payment_items x WHERE x.item_id = i.id AND x.set_id IS NULL) AS covered
         FROM items i JOIN claims c ON c.item_id = i.id AND c.status = 'confirmed' AND c.set_id IS NULL ${JOINS}
        WHERE i.item_type <> 'set' AND i.cancelled_at IS NULL AND COALESCE(pi.is_self, po.is_self, 0) = 0 AND NOT EXISTS (SELECT 1 FROM import_records ir WHERE ir.kind = 'item' AND ir.entity_id = i.id)   -- imported history isn't something to pay a proxy for
        GROUP BY i.id, i.title, go.id, go.title, pi.name, po.name, i.payment_deadline, go.payment_deadline
       HAVING confirmed > covered ORDER BY go.id, i.id`);
    res.json({
      candidates: [
        ...sets.map((r) => ({ key: `set:${r.itemId}`, kind: 'set', itemId: r.itemId, title: r.title, label: `${r.orderTitle} — ${r.title} — ${r.count} secured set${r.count === 1 ? '' : 's'}`, proxy: r.proxy, deadline: r.deadline, count: r.count, roster: r.roster })),
        ...items.map((r) => {
          const count = r.confirmed - r.covered;            // only the claims not yet paid for
          return { key: `item:${r.itemId}`, kind: 'item', itemId: r.itemId, title: r.title, count, covered: Number(r.covered), roster: null, proxy: r.proxy, deadline: r.deadline,
            label: `${r.orderTitle} — ${r.title} — ${count} ${r.covered > 0 ? 'more ' : ''}confirmed claim${count === 1 ? '' : 's'}${r.covered > 0 ? ` (${r.covered} already paid for)` : ''}` };
        }),
      ],
    });
  }));

  app.get('/api/admin/proxy/names', admin, wrap(async (req, res) => {
    const [rows] = await pool.query('SELECT id, name, is_self FROM proxies ORDER BY name');
    res.json({ names: rows.map((r) => r.name), proxies: rows.map((r) => ({ id: r.id, name: r.name, isSelf: !!r.is_self })) });
  }));
  // "This proxy is me": orders using it are left out of the proxy-payment lists.
  app.patch('/api/admin/proxies/:id', admin, wrap(async (req, res) => {
    const { isSelf } = z.object({ isSelf: z.boolean() }).parse(req.body);
    const [r] = await pool.query('UPDATE proxies SET is_self = ? WHERE id = ?', [isSelf ? 1 : 0, Number(req.params.id)]);
    if (!r.affectedRows) throw notFound('No such proxy');
    res.json({ ok: true, isSelf });
  }));

  app.post('/api/admin/proxy/payments', admin, wrap(async (req, res) => {
    const b = z.object({ proxy: z.string().trim().min(1, "Who's the proxy for this payment?").max(80), deadline: date, summary: z.string().trim().max(255).optional(), keys: z.array(z.string().regex(KEY)).min(1, 'Tick which sets/items this payment covers.').max(100), paid: z.boolean().optional() }).parse(req.body);
    const wanted = [...new Set(b.keys)].map((k) => { const [, kind, id] = KEY.exec(k); return { kind, id: Number(id) }; }).sort((x, y) => x.id - y.id);
    const out = await withTx(pool, async (conn) => {
      const plan = [];
      for (const w of wanted) {                         // lowest item first, locking each, so two people logging at once can't deadlock or both succeed
        const [[it]] = await conn.query('SELECT id, title, item_type FROM items WHERE id = ? FOR UPDATE', [w.id]);
        if (!it) throw notFound('One of those items no longer exists');
        const [[me]] = await conn.query('SELECT COALESCE(pi.is_self, po.is_self, 0) AS self FROM items i JOIN group_orders go ON go.id = i.order_id LEFT JOIN proxies pi ON pi.id = i.proxy_id LEFT JOIN proxies po ON po.id = go.proxy_id WHERE i.id = ?', [w.id]);
        if (me?.self) throw bad(`"${it.title}" uses a proxy you've marked as yourself, so there's no proxy payment to log for it.`, 'self_proxy');
        if (w.kind === 'set') {
          if (it.item_type !== 'set') throw bad(`"${it.title}" isn't a member set`);
          const [sets] = await conn.query("SELECT id FROM item_sets WHERE item_id = ? AND admin_decision = 'secured' AND included_in_proxy_payment = 0 FOR UPDATE", [w.id]);
          if (!sets.length) throw conflict(`"${it.title}" has no secured sets waiting — it may already be in a proxy payment.`, 'already_included');
          plan.push({ item: it, setIds: sets.map((s) => s.id) });
        } else {
          if (it.item_type === 'set') throw bad(`"${it.title}" is a member set — log its secured sets instead`);
          const [[n]] = await conn.query("SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND status = 'confirmed' AND set_id IS NULL", [w.id]);
          const [[cov]] = await conn.query('SELECT COALESCE(SUM(claim_count), 0) AS n FROM proxy_payment_items WHERE item_id = ? AND set_id IS NULL', [w.id]);
          const fresh = n.n - Number(cov.n);                // claims confirmed since the last payment for it (all of them, the first time)
          if (fresh <= 0) throw conflict(`"${it.title}" is already in a proxy payment, with no new confirmed claims since.`, 'already_included');
          plan.push({ item: it, setIds: null, claims: fresh });
        }
      }
      await conn.query('INSERT IGNORE INTO proxies (name) VALUES (?)', [b.proxy]);
      const [[px]] = await conn.query('SELECT id FROM proxies WHERE name = ?', [b.proxy]);
      const [pp] = await conn.query('INSERT INTO proxy_payments (proxy_id, deadline, summary, is_paid) VALUES (?,?,?,?)', [px.id, b.deadline || null, b.summary || `${plan.length} item${plan.length === 1 ? '' : 's'}`, b.paid ? 1 : 0]);
      for (const p of plan) {
        if (p.setIds) {
          for (const sid of p.setIds) await conn.query('INSERT INTO proxy_payment_items (proxy_payment_id, item_id, set_id) VALUES (?,?,?)', [pp.insertId, p.item.id, sid]);
          await conn.query('UPDATE item_sets SET included_in_proxy_payment = 1 WHERE id IN (?)', [p.setIds]);
        } else await conn.query('INSERT INTO proxy_payment_items (proxy_payment_id, item_id, set_id, claim_count) VALUES (?,?,NULL,?)', [pp.insertId, p.item.id, p.claims]);
      }
      await audit(conn, req.account.id, 'proxy.log', 'proxy_payment', pp.insertId, { proxy: b.proxy, items: plan.length });
      return { id: pp.insertId };
    });
    res.status(201).json({ ok: true, ...out });
  }));

  app.get('/api/admin/proxy/payments', admin, wrap(async (req, res) => {
    const [pays] = await pool.query(
      `SELECT pp.id, p.name AS proxy, pp.deadline, pp.summary, pp.is_paid AS paid, pp.created_at AS createdAt,
              (pp.is_paid = 0 AND pp.deadline IS NOT NULL AND pp.deadline < CURDATE()) AS overdue, IF(pp.deadline IS NULL, NULL, DATEDIFF(CURDATE(), pp.deadline)) AS daysFromDeadline
         FROM proxy_payments pp JOIN proxies p ON p.id = pp.proxy_id ORDER BY pp.id DESC LIMIT 500`);
    const [rows] = pays.length ? await pool.query(
      `SELECT ppi.proxy_payment_id AS pid, i.id AS itemId, i.title, go.title AS orderTitle, COUNT(ppi.set_id) AS sets, SUM(ppi.claim_count) AS claims
         FROM proxy_payment_items ppi JOIN items i ON i.id = ppi.item_id JOIN group_orders go ON go.id = i.order_id
        WHERE ppi.proxy_payment_id IN (?) GROUP BY ppi.proxy_payment_id, i.id, i.title, go.title ORDER BY i.id`, [pays.map((x) => x.id)]) : [[]];
    const q = String(req.query.q || '').trim().toLowerCase();
    let list = pays.map((x) => ({
      ...x, paid: !!x.paid, overdue: !!x.overdue, daysOverdue: x.overdue ? x.daysFromDeadline : 0,
      items: rows.filter((r) => r.pid === x.id).map((r) => ({ itemId: r.itemId, label: `${r.orderTitle} — ${r.title}${r.sets ? ` — ${r.sets} set${r.sets === 1 ? '' : 's'}` : r.claims ? ` — ${r.claims} claim${Number(r.claims) === 1 ? '' : 's'}` : ''}` })),
    })).map(({ daysFromDeadline, ...rest }) => rest);
    if (q) list = list.filter((x) => [x.proxy, x.summary || '', ...x.items.map((i) => i.label)].join(' ').toLowerCase().includes(q));
    res.json({ payments: list });
  }));

  app.patch('/api/admin/proxy/payments/:id', admin, wrap(async (req, res) => {
    const b = z.object({ paid: z.boolean().optional(), deadline: date, summary: z.string().trim().max(255).optional() }).parse(req.body);
    const sets = [], vals = [];
    if (b.paid !== undefined) { sets.push('is_paid = ?'); vals.push(b.paid ? 1 : 0); }
    if (b.deadline !== undefined) { sets.push('deadline = ?'); vals.push(b.deadline); }
    if (b.summary !== undefined) { sets.push('summary = ?'); vals.push(b.summary || null); }
    if (!sets.length) throw bad('Nothing to change');
    const [r] = await pool.query(`UPDATE proxy_payments SET ${sets.join(', ')} WHERE id = ?`, [...vals, Number(req.params.id)]);
    if (r.affectedRows !== 1) throw notFound('No such proxy payment');
    res.json({ ok: true });
  }));

  // Logged by mistake: remove it, and its sets and items become available to log again.
  app.delete('/api/admin/proxy/payments/:id', admin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[pp]] = await conn.query('SELECT id FROM proxy_payments WHERE id = ? FOR UPDATE', [id]);
      if (!pp) throw notFound('No such proxy payment');
      await conn.query('UPDATE item_sets SET included_in_proxy_payment = 0 WHERE id IN (SELECT set_id FROM proxy_payment_items WHERE proxy_payment_id = ? AND set_id IS NOT NULL)', [id]);
      await conn.query('DELETE FROM proxy_payments WHERE id = ?', [id]);          // its rows go with it
      await audit(conn, req.account.id, 'proxy.delete', 'proxy_payment', id);
    });
    res.json({ ok: true });
  }));
}
