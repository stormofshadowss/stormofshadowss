import { wrap } from '../lib/http.js';
import { requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { isClosedNow, outstandingClaims, outstandingMessage } from '../lib/archive.js';

// GOM → Group Orders → Archive: tuck away a closed group order that is truly finished (see lib/archive.js). By hand, one order at a time; reversible.
export function archiveRoutes(app, { pool }) {
  app.post('/api/admin/orders/:id/archive', requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[o]] = await conn.query('SELECT id, title, status, close_date, cancelled_at, archived_at FROM group_orders WHERE id = ? FOR UPDATE', [id]);
      if (!o) throw notFound('No such group order');
      if (o.archived_at) throw conflict(`“${o.title}” is already archived.`, 'already_archived');
      if (!isClosedNow(o)) throw conflict(`“${o.title}” is still open — close it first. Only closed (or cancelled) group orders can be archived.`, 'still_open');
      if (!o.cancelled_at) {
        const list = await outstandingClaims(conn, id);
        if (list.length) throw conflict(outstandingMessage(o.title, list), 'not_completed', { outstanding: list, total: list.reduce((n, r) => n + r.count, 0) });
      }
      await conn.query('UPDATE group_orders SET archived_at = NOW() WHERE id = ?', [id]);
      await audit(conn, req.account.id, 'order.archive', 'order', id, { cancelled: !!o.cancelled_at });
    });
    res.json({ ok: true });
  }));

  app.post('/api/admin/orders/:id/unarchive', requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[o]] = await conn.query('SELECT id, title, archived_at FROM group_orders WHERE id = ? FOR UPDATE', [id]);
      if (!o) throw notFound('No such group order');
      if (!o.archived_at) throw conflict(`“${o.title}” isn't archived.`, 'not_archived');
      await conn.query('UPDATE group_orders SET archived_at = NULL WHERE id = ?', [id]);
      await audit(conn, req.account.id, 'order.unarchive', 'order', id, null);
    });
    res.json({ ok: true });
  }));
}
