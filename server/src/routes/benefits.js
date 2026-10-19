import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { bad, conflict, notFound } from '../errors.js';
import { lockJoiner } from '../lib/ledger.js';
import { placeItemLine } from '../lib/claim-create.js';
import { benefitStatus } from '../lib/benefits.js';
import { secureClaims } from './claims.js';

// GOM → a group order → Purchase benefits: "spend £X on these items and get N photocards". The GOM defines the offer; the site shows who qualifies; pressing Add puts the bonus claims on their accounts.
export function benefitRoutes(app, { pool }) {
  const admin = requireAdmin;
  const body = z.object({
    title: z.string().trim().min(1).max(120), threshold: z.number().min(0.01).max(100000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At most 2 decimal places'),
    quantity: z.number().int().min(1).max(99), bonusItemId: z.number().int().positive(), itemIds: z.array(z.number().int().positive()).min(1).max(200),
  });

  // The bonus is a plain, FREE item in the same group order; the items that count toward the spend are other items of that order.
  async function check(conn, orderId, b) {
    const [[bonus]] = await conn.query('SELECT i.id, i.order_id, i.item_type, i.price, i.price_tbc, i.cancelled_at FROM items i WHERE i.id = ?', [b.bonusItemId]);
    if (!bonus || bonus.order_id !== orderId || bonus.cancelled_at) throw bad('The bonus item must be an item in this group order.', 'bad_bonus');
    if (!['normal', 'random'].includes(bonus.item_type)) throw bad('The bonus item must be a plain item (not sizes, members or a set), so everyone just gets it.', 'bad_bonus');
    if (bonus.price_tbc || Number(bonus.price) !== 0) throw bad('The bonus item must be free — give it a price of £0.', 'bonus_not_free');
    const ids = [...new Set(b.itemIds)];
    if (ids.includes(b.bonusItemId)) throw bad('The bonus item itself can’t count toward the spend.', 'bad_items');
    const [rows] = await conn.query('SELECT id FROM items WHERE id IN (?) AND order_id = ? AND cancelled_at IS NULL', [ids, orderId]);
    if (rows.length !== ids.length) throw bad('Every item that counts toward the spend must be an item in this group order.', 'bad_items');
    return ids;
  }

  const offerRow = async (offerId) => {
    const st = await benefitStatus(pool, offerId); if (!st) return null;
    const [items] = await pool.query('SELECT i.id, i.title FROM benefit_offer_items oi JOIN items i ON i.id = oi.item_id WHERE oi.offer_id = ? ORDER BY i.sort_order, i.id', [offerId]);
    return { ...st.offer, items, qualifying: st.totals.qualifying, toAdd: st.totals.toAdd, over: st.totals.over };
  };

  app.get('/api/admin/orders/:id/benefits', admin, wrap(async (req, res) => {
    const [offers] = await pool.query('SELECT id FROM benefit_offers WHERE order_id = ? ORDER BY id', [Number(req.params.id)]);
    res.json({ offers: await Promise.all(offers.map((o) => offerRow(o.id))) });
  }));

  app.post('/api/admin/orders/:id/benefits', admin, wrap(async (req, res) => {
    const b = body.parse(req.body); const orderId = Number(req.params.id);
    const id = await withTx(pool, async (conn) => {
      const [[go]] = await conn.query('SELECT id FROM group_orders WHERE id = ?', [orderId]); if (!go) throw notFound('No such group order');
      const ids = await check(conn, orderId, b);
      const [r] = await conn.query('INSERT INTO benefit_offers (order_id, title, spend_threshold, quantity, bonus_item_id) VALUES (?,?,?,?,?)', [orderId, b.title, b.threshold, b.quantity, b.bonusItemId]);
      await conn.query('INSERT INTO benefit_offer_items (offer_id, item_id) VALUES ?', [ids.map((i) => [r.insertId, i])]);
      await audit(conn, req.account.id, 'benefit.create', 'benefit_offer', r.insertId, { orderId, threshold: b.threshold, quantity: b.quantity });
      return r.insertId;
    });
    res.status(201).json({ ok: true, id, offer: await offerRow(id) });
  }));

  app.patch('/api/admin/benefits/:id', admin, wrap(async (req, res) => {
    const id = Number(req.params.id); const patch = body.partial().parse(req.body);
    await withTx(pool, async (conn) => {
      const [[o]] = await conn.query('SELECT id, order_id, bonus_item_id FROM benefit_offers WHERE id = ? FOR UPDATE', [id]); if (!o) throw notFound('No such offer');
      const [cur] = await conn.query('SELECT item_id FROM benefit_offer_items WHERE offer_id = ?', [id]);
      const merged = { title: patch.title, threshold: patch.threshold, quantity: patch.quantity, bonusItemId: patch.bonusItemId ?? o.bonus_item_id, itemIds: patch.itemIds ?? cur.map((r) => r.item_id) };
      const ids = await check(conn, o.order_id, merged);
      const sets = [], vals = [];
      if (patch.title !== undefined) { sets.push('title = ?'); vals.push(patch.title); } if (patch.threshold !== undefined) { sets.push('spend_threshold = ?'); vals.push(patch.threshold); }
      if (patch.quantity !== undefined) { sets.push('quantity = ?'); vals.push(patch.quantity); } if (patch.bonusItemId !== undefined) { sets.push('bonus_item_id = ?'); vals.push(patch.bonusItemId); }
      if (sets.length) await conn.query(`UPDATE benefit_offers SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
      if (patch.itemIds) { await conn.query('DELETE FROM benefit_offer_items WHERE offer_id = ?', [id]); await conn.query('INSERT INTO benefit_offer_items (offer_id, item_id) VALUES ?', [ids.map((i) => [id, i])]); }
      await audit(conn, req.account.id, 'benefit.update', 'benefit_offer', id, patch);
    });
    res.json({ ok: true, offer: await offerRow(id) });
  }));

  app.delete('/api/admin/benefits/:id', admin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[o]] = await conn.query('SELECT id FROM benefit_offers WHERE id = ? FOR UPDATE', [id]); if (!o) throw notFound('No such offer');
      const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM claims WHERE benefit_offer_id = ? AND status <> 'cancelled'", [id]);
      if (n > 0) throw conflict(`${n} bonus claim${n === 1 ? ' was' : 's were'} already added from this offer — cancel ${n === 1 ? 'it' : 'them'} first, or keep the offer.`, 'has_grants');
      await conn.query('DELETE FROM benefit_offers WHERE id = ?', [id]);
      await audit(conn, req.account.id, 'benefit.delete', 'benefit_offer', id, null);
    });
    res.json({ ok: true });
  }));

  // who qualifies: everyone who owes a bonus (or has been given more than they now qualify for) first; ?all=1 for everyone with any spend
  app.get('/api/admin/benefits/:id', admin, wrap(async (req, res) => {
    const st = await benefitStatus(pool, Number(req.params.id)); if (!st) throw notFound('No such offer');
    const people = req.query.all ? st.people : st.people.filter((p) => p.toAdd > 0 || p.over > 0);
    res.json({ offer: await offerRow(st.offer.id), people, totals: st.totals, everyone: st.people.length });
  }));

  // Add the bonus: one person at a time, each in its own locked step that RECOMPUTES what they are owed first — so pressing twice, or from two screens, can never add it twice.
  app.post('/api/admin/benefits/:id/grant', admin, wrap(async (req, res) => {
    const b = z.object({ people: z.union([z.literal('all'), z.array(z.string().regex(/^[aj]\d+$/)).min(1).max(500)]) }).parse(req.body); const id = Number(req.params.id);
    const first = await benefitStatus(pool, id); if (!first) throw notFound('No such offer');
    const wanted = b.people === 'all' ? first.people.filter((p) => p.toAdd > 0) : b.people.map((k) => first.people.find((p) => p.key === k)).filter(Boolean);
    const granted = [], failed = []; let skipped = 0;
    for (const p of wanted) {
      try {
        const out = await withTx(pool, async (conn) => {
          await lockJoiner(conn, p.intoId);                                                                 // locks all of this person's handles
          const now = (await benefitStatus(conn, id)).people.find((x) => x.key === p.key);
          if (!now || now.toAdd <= 0) return null;                                                          // already given (another press, another screen)
          if (now.blocked) throw conflict(`@${now.intoHandle} is blocked — unblock them on the People tab first.`, 'handle_blocked');
          const r = await placeItemLine(conn, { joinerId: now.intoId, line: { itemId: first.offer.bonusItemId, qty: now.toAdd }, asAdmin: true });
          await secureClaims(conn, { claimIds: r.ids }, req.account.id);
          await conn.query('UPDATE claims SET benefit_offer_id = ? WHERE id IN (?)', [id, r.ids]);
          await audit(conn, req.account.id, 'benefit.grant', 'benefit_offer', id, { handle: now.intoHandle, count: r.ids.length, spend: now.spend });
          return { handle: now.intoHandle, count: r.ids.length };
        });
        if (out) granted.push(out); else skipped += 1;
      } catch (e) { failed.push({ handle: p.intoHandle, error: e.message }); }
    }
    res.json({ ok: true, granted, skipped, failed, added: granted.reduce((n, g) => n + g.count, 0) });
  }));
}
