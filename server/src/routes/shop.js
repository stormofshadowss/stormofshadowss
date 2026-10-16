import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { bad, conflict, notFound } from '../errors.js';
import { imageOut } from '../lib/images.js';

const price = z.number().min(0.01, 'A shop item needs a price').max(100000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At most 2 decimal places');
const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const body = z.object({
  title: z.string().trim().min(1, 'Give the item a name').max(160), price, qty: z.number().int().min(0).max(10000),
  notes: z.string().trim().max(255).optional(), payDays: z.number().int().min(1).max(60).optional(), size: z.enum(SIZES).optional(),
  groupId: z.number().int().positive().nullable().optional(),                      // the artist group it belongs to (null = none: shown under "Other")
});

// Shop (on hand) stock: things you already have, claimed straight away and paid like anything else. A claim holds a unit at once; it
// becomes "ready to pack" when it's paid, and shows in Overdue if it isn't paid within the item's pay-by days (you cancel it yourself to free the unit).
export function shopRoutes(app, { pool }) {
  const admin = [requireAdmin];
  const CLAIMED = "(SELECT COUNT(*) FROM claims c WHERE c.leftover_item_id = li.id AND c.status <> 'cancelled')";

  const checkGroup = async (groupId) => { if (!groupId) return; const [[g]] = await pool.query('SELECT id FROM artist_groups WHERE id = ?', [groupId]); if (!g) throw bad('That artist or group does not exist', 'no_group'); };

  // what joiners see: no quantities in stock, only how many are left
  app.get('/api/shop', wrap(async (req, res) => {
    // an item in a group that is hidden from the home page is shown under "Other", like an item with no group
    const [rows] = await pool.query(`SELECT li.id, li.title, li.price, li.notes, li.pay_days AS payDays, g.id AS groupId, li.qty - ${CLAIMED} AS remaining, im.filename AS file, im.width AS w, im.height AS h FROM leftover_items li LEFT JOIN images im ON im.id = li.image_id LEFT JOIN artist_groups g ON g.id = li.group_id AND g.is_hidden = 0 WHERE li.is_active = 1 ORDER BY li.id DESC`);
    const [groups] = await pool.query(`SELECT g.id, g.name, gi.filename AS file, gi.width AS w, gi.height AS h FROM artist_groups g LEFT JOIN images gi ON gi.id = g.cover_image_id WHERE g.is_hidden = 0 AND EXISTS (SELECT 1 FROM leftover_items li WHERE li.group_id = g.id AND li.is_active = 1) ORDER BY g.sort_order, g.name`);
    res.json({ items: rows.map((r) => ({ id: r.id, title: r.title, price: r.price, notes: r.notes || '', payDays: r.payDays, groupId: r.groupId || null, image: imageOut(r.file, r.w, r.h), left: Math.max(0, Number(r.remaining)) })),
      groups: groups.map((g) => ({ id: g.id, name: g.name, cover: imageOut(g.file, g.w, g.h) })) });
  }));

  app.get('/api/admin/shop', admin, wrap(async (req, res) => {
    const [items] = await pool.query(
      `SELECT li.id, li.title, li.price, li.qty, li.notes, li.is_active AS active, li.pay_days AS payDays, li.size_bucket AS size, li.group_id AS groupId, ${CLAIMED} AS claimed, im.filename AS file, im.width AS w, im.height AS h FROM leftover_items li LEFT JOIN images im ON im.id = li.image_id ORDER BY li.id DESC`);
    const [claims] = items.length ? await pool.query(
      `SELECT c.leftover_item_id AS itemId, c.id AS claimId, j.instagram_handle AS handle, c.status, c.pipeline, c.pay_by AS payBy, c.created_at AS createdAt,
              (SELECT cc.paid >= cc.cost FROM claim_costs cc WHERE cc.claim_id = c.id AND cc.category = 'initials') AS paid,
              (c.pay_by < CURDATE() AND NOT COALESCE((SELECT cc.paid >= cc.cost FROM claim_costs cc WHERE cc.claim_id = c.id AND cc.category = 'initials'), 0)) AS overdue
         FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE c.leftover_item_id IN (?) AND c.status <> 'cancelled' ORDER BY c.id`, [items.map((i) => i.id)]) : [[]];
    res.json({ items: items.map(({ file, w, h, ...i }) => ({ ...i, image: imageOut(file, w, h), notes: i.notes || '', active: !!i.active, left: Math.max(0, i.qty - Number(i.claimed)), claimed: Number(i.claimed),
      claims: claims.filter((c) => c.itemId === i.id).map(({ itemId, ...c }) => ({ ...c, paid: !!c.paid, overdue: !!c.overdue })) })) });
  }));

  app.post('/api/admin/shop', admin, wrap(async (req, res) => {
    const b = body.parse(req.body);
    await checkGroup(b.groupId);
    const [r] = await pool.query('INSERT INTO leftover_items (title, price, qty, notes, pay_days, size_bucket, group_id) VALUES (?,?,?,?,?,?,?)', [b.title, b.price, b.qty, b.notes || null, b.payDays ?? 5, b.size ?? 'M', b.groupId || null]);
    res.status(201).json({ ok: true, id: r.insertId });
  }));

  // Sort several items into an artist group at once (groupId null = take them out of any group)
  app.post('/api/admin/shop/group', admin, wrap(async (req, res) => {
    const b = z.object({ itemIds: z.array(z.number().int().positive()).min(1).max(500), groupId: z.number().int().positive().nullable() }).parse(req.body);
    await checkGroup(b.groupId);
    const out = await withTx(pool, async (conn) => {
      const [r] = await conn.query('UPDATE leftover_items SET group_id = ? WHERE id IN (?)', [b.groupId, b.itemIds]);
      await audit(conn, req.account.id, 'shop.group', 'leftover_item', null, { count: r.affectedRows, groupId: b.groupId });
      return r.affectedRows;
    });
    res.json({ ok: true, updated: out });
  }));

  // Changing the price only affects claims made from now on; claims already made keep the price they were made at.
  app.patch('/api/admin/shop/:id', admin, wrap(async (req, res) => {
    const b = body.partial().extend({ active: z.boolean().optional() }).parse(req.body);
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[it]] = await conn.query('SELECT id FROM leftover_items WHERE id = ? FOR UPDATE', [id]);   // the same lock a claim takes, so stock can't change under a claim
      if (!it) throw notFound('No such shop item');
      if (b.qty !== undefined) {
        const [[n]] = await conn.query("SELECT COUNT(*) AS n FROM claims WHERE leftover_item_id = ? AND status <> 'cancelled'", [id]);
        if (b.qty < n.n) throw conflict(`${n.n} ${n.n === 1 ? 'is' : 'are'} already claimed — set the quantity to at least ${n.n}, or cancel some claims first.`, 'qty_below_claims');
      }
      const sets = [], vals = [];
      const map = { title: 'title', price: 'price', qty: 'qty', payDays: 'pay_days', size: 'size_bucket' };
      for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col} = ?`); vals.push(b[k]); }
      if (b.notes !== undefined) { sets.push('notes = ?'); vals.push(b.notes || null); }
      if (b.groupId !== undefined) { await checkGroup(b.groupId); sets.push('group_id = ?'); vals.push(b.groupId || null); }
      if (b.active !== undefined) { sets.push('is_active = ?'); vals.push(b.active ? 1 : 0); }
      if (sets.length) await conn.query(`UPDATE leftover_items SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
      await audit(conn, req.account.id, 'shop.edit', 'leftover_item', id, Object.keys(b));
    });
    res.json({ ok: true });
  }));
}
