import { cancelPlan, cancelNow } from '../lib/cancel-order.js';
import { z } from 'zod';
import { deletionPlan, deleteCatalog, itemsOfOrder } from '../lib/delete-catalog.js';
import { imageOut, removeFiles } from '../lib/images.js';
import { wrap } from '../lib/http.js';
import { requireAdmin, requireLogin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { bad, notFound } from '../errors.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional();
const money = z.number().min(0).max(100000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At most 2 decimal places');

async function proxyIdFor(conn, name) {
  if (!name) return null;
  await conn.query('INSERT INTO proxies (name) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)', [name]);
  const [[r]] = await conn.query('SELECT LAST_INSERT_ID() AS id');
  return r.id;
}

async function loadOrders(pool, whereSql, params, { admin }) {
  const [orders] = await pool.query(
    `SELECT go.id, go.title, go.status, go.is_private, go.cancelled_at, go.close_date, go.payment_deadline, go.expected_ship_date,
            go.group_id, ag.name AS group_name, p.name AS proxy_name, oi.filename AS cover_file, oi.width AS cover_w, oi.height AS cover_h, gi.filename AS gcover_file, gi.width AS gcover_w, gi.height AS gcover_h
       FROM group_orders go JOIN artist_groups ag ON ag.id = go.group_id LEFT JOIN proxies p ON p.id = go.proxy_id
       LEFT JOIN images oi ON oi.id = go.cover_image_id LEFT JOIN images gi ON gi.id = ag.cover_image_id
      ${whereSql} ORDER BY go.id DESC`, params);
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const [items] = await pool.query(
    `SELECT i.id, i.order_id, i.item_type, i.title, i.cancelled_at, i.description, i.price, i.price_tbc, i.payment_deadline, i.requires_full_set, p.name AS proxy_name, im.filename AS image_file, im.width AS image_w, im.height AS image_h
       FROM items i LEFT JOIN proxies p ON p.id = i.proxy_id LEFT JOIN images im ON im.id = i.image_id WHERE i.order_id IN (?) ${admin ? '' : 'AND i.cancelled_at IS NULL'} ORDER BY i.sort_order, i.id`, [ids]);
  const itemIds = items.map((i) => i.id);
  const [members] = itemIds.length ? await pool.query('SELECT item_id, name, price FROM item_members WHERE item_id IN (?) ORDER BY sort_order, id', [itemIds]) : [[]];
  const [variants] = itemIds.length ? await pool.query('SELECT item_id, label FROM item_variants WHERE item_id IN (?) ORDER BY sort_order, id', [itemIds]) : [[]];
  const [counts] = itemIds.length ? await pool.query("SELECT item_id, COUNT(*) AS n FROM claims WHERE item_id IN (?) AND status <> 'cancelled' GROUP BY item_id", [itemIds]) : [[]];
  const countOf = Object.fromEntries(counts.map((c) => [c.item_id, c.n]));
  const setItemIds = items.filter((i) => i.item_type === 'set').map((i) => i.id);
  const [partCounts] = setItemIds.length ? await pool.query("SELECT item_id, member_name, COUNT(*) AS n FROM claims WHERE item_id IN (?) AND set_id IS NOT NULL AND status <> 'cancelled' GROUP BY item_id, member_name", [setItemIds]) : [[]];
  const [setRows] = setItemIds.length ? await pool.query('SELECT id, item_id, set_number, admin_decision FROM item_sets WHERE item_id IN (?) ORDER BY set_number', [setItemIds]) : [[]];
  const [takenRows] = setRows.length ? await pool.query('SELECT set_id, member_name FROM set_slots WHERE set_id IN (?)', [setRows.map((s) => s.id)]) : [[]];
  return orders.map((o) => ({
    id: o.id, title: o.title, groupId: o.group_id, group: o.group_name, cover: imageOut(o.cover_file, o.cover_w, o.cover_h), groupCover: imageOut(o.gcover_file, o.gcover_w, o.gcover_h), status: o.status, isPrivate: !!o.is_private, cancelled: !!o.cancelled_at,
    closeDate: o.close_date, paymentDeadline: o.payment_deadline, expectedShipDate: o.expected_ship_date,
    ...(admin ? { proxy: o.proxy_name } : {}),
    items: items.filter((i) => i.order_id === o.id).map((i) => {
      // each part carries its effective price: its own if it has one, else the item's
      const parts = members.filter((m) => m.item_id === i.id).map((m) => ({ name: m.name, price: m.price ?? (i.price_tbc ? null : i.price) }));   // null = price still TBC
      return {
      id: i.id, type: i.item_type, title: i.title, cancelled: !!i.cancelled_at, description: i.description || '', image: imageOut(i.image_file, i.image_w, i.image_h), price: i.price_tbc ? null : i.price, priceTbc: !!i.price_tbc,
      // an item's own pay-by date wins; otherwise the GO's applies
      payBy: i.payment_deadline || o.payment_deadline,
      members: parts,
      ...(i.item_type === 'set' ? {
        // how many of each part are claimed, and which parts each set has taken — never who by
        partsClaimed: Object.fromEntries(partCounts.filter((p) => p.item_id === i.id).map((p) => [p.member_name, p.n])),
        sets: setRows.filter((s) => s.item_id === i.id).map((s) => ({ number: s.set_number, decision: s.admin_decision, taken: takenRows.filter((t) => t.set_id === s.id).map((t) => t.member_name) })),
        requiresFullSet: !!i.requires_full_set, wholeSetPrice: parts.some((m) => m.price === null) ? null : Math.round(parts.reduce((s, m) => s + m.price, 0) * 100) / 100 } : {}),
      variants: variants.filter((v) => v.item_id === i.id).map((v) => v.label),
      claimed: countOf[i.id] || 0,
      ...(admin ? { proxy: i.proxy_name || o.proxy_name, ownPaymentDeadline: i.payment_deadline } : {}),
      };
    }),
  }));
}

export function catalogRoutes(app, { pool, cfg }) {
  // ───────── cancelling a group order (or one item) that can't be fulfilled ─────────
  // "cancel-plan" is the preview the screen shows first; "cancel" needs the exact name typed. No emails are sent.
  const planReply = (p) => ({ kind: p.kind, id: p.id, title: p.title, summary: p.summary, blockers: p.blockers,
    claims: p.claims.slice(0, 12).map((x) => ({ handle: x.handle, label: x.label, status: x.status, paid: Number(x.paid) })) });
  app.get('/api/admin/orders/:id/cancel-plan', requireAdmin, wrap(async (req, res) => res.json(planReply(await withTx(pool, (conn) => cancelPlan(conn, { orderId: Number(req.params.id) }))))));
  app.get('/api/admin/items/:id/cancel-plan', requireAdmin, wrap(async (req, res) => res.json(planReply(await withTx(pool, (conn) => cancelPlan(conn, { itemId: Number(req.params.id) }))))));
  const doCancel = (what) => wrap(async (req, res) => {
    const { confirm } = z.object({ confirm: z.string().max(300) }).parse(req.body || {});
    const id = Number(req.params.id);
    const out = await withTx(pool, async (conn) => {
      const r = await cancelNow(conn, { ...(what === 'order' ? { orderId: id } : { itemId: id }), confirm, adminId: req.account.id });
      await audit(conn, req.account.id, `${what}.cancel`, what, id, { claims: r.claims, people: r.people, credit: r.credit, forfeited: r.forfeited });
      return r;
    });
    res.json({ ok: true, ...out });
  });
  app.post('/api/admin/orders/:id/cancel', requireAdmin, doCancel('order'));
  app.post('/api/admin/items/:id/cancel', requireAdmin, doCancel('item'));

  // ───────── deleting an item or a whole group order ─────────
  // "check" says exactly what would be removed (and what stops it) — the screen shows that before you confirm. See lib/delete-catalog.js for the rules.
  const checkReply = (plan) => ({ canDelete: !plan.blockers.length, blockers: plan.blockers, removes: plan.removes });
  app.get('/api/admin/items/:id/delete-check', requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const [[it]] = await pool.query('SELECT id FROM items WHERE id = ?', [id]);
    if (!it) throw notFound('No such item');
    res.json(checkReply(await withTx(pool, (conn) => deletionPlan(conn, { itemIds: [id] }))));
  }));
  app.get('/api/admin/orders/:id/delete-check', requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    res.json(checkReply(await withTx(pool, async (conn) => deletionPlan(conn, { itemIds: await itemsOfOrder(conn, id), orderId: id }))));
  }));
  const doDelete = (what) => wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { plan, files } = await withTx(pool, async (conn) => {
      const itemIds = what === 'order' ? await itemsOfOrder(conn, id) : [id];
      if (what === 'item') { const [[it]] = await conn.query('SELECT id, title FROM items WHERE id = ?', [id]); if (!it) throw notFound('No such item'); }
      const [[t]] = what === 'order' ? await conn.query('SELECT title FROM group_orders WHERE id = ?', [id]) : await conn.query('SELECT title FROM items WHERE id = ?', [id]);
      const out = await deleteCatalog(conn, { itemIds, orderId: what === 'order' ? id : null });
      await audit(conn, req.account.id, `${what}.delete`, what, id, { title: t.title, ...out.plan.removes });
      return out;
    });
    for (const f of files) await removeFiles(cfg.uploadsDir, f);       // the pictures' files go once the database has committed
    res.json({ ok: true, removes: plan.removes });
  });
  app.delete('/api/admin/items/:id', requireAdmin, doDelete('item'));
  app.delete('/api/admin/orders/:id', requireAdmin, doDelete('order'));

  // What anyone can browse: open GOs that aren't private.
  // Each artist/group that is shown on the site, with how many public group orders it has open or closed (a group with none still has its page).
  app.get('/api/groups', wrap(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT g.id, g.name, im.filename AS file, im.width AS w, im.height AS h,
              (SELECT COUNT(*) FROM group_orders go WHERE go.group_id = g.id AND go.is_private = 0 AND go.cancelled_at IS NULL AND go.status = 'open') AS open_orders,
              (SELECT COUNT(*) FROM group_orders go WHERE go.group_id = g.id AND go.is_private = 0 AND go.cancelled_at IS NULL AND go.status <> 'open') AS closed_orders
         FROM artist_groups g LEFT JOIN images im ON im.id = g.cover_image_id WHERE g.is_hidden = 0 ORDER BY g.sort_order, g.name`);
    res.json({ groups: rows.map((g) => ({ id: g.id, name: g.name, cover: imageOut(g.file, g.w, g.h), openOrders: Number(g.open_orders), closedOrders: Number(g.closed_orders) })) });
  }));

  app.get('/api/orders', wrap(async (req, res) => {
    res.json({ orders: await loadOrders(pool, 'WHERE go.is_private = 0 AND ag.is_hidden = 0 AND go.cancelled_at IS NULL', [], { admin: false }) });
  }));

  app.get('/api/payment-methods', requireLogin, wrap(async (req, res) => {
    const [rows] = await pool.query('SELECT method, account_info AS accountInfo FROM payment_methods ORDER BY sort_order, id');
    res.json({ methods: rows });
  }));

  // ── GOM side ──
  app.get('/api/admin/groups', requireAdmin, wrap(async (req, res) => {
    const [groups] = await pool.query('SELECT g.id, g.name, g.is_hidden AS hidden, im.filename AS file, im.width AS w, im.height AS h FROM artist_groups g LEFT JOIN images im ON im.id = g.cover_image_id ORDER BY g.sort_order, g.name');
    const [members] = await pool.query('SELECT group_id, name FROM group_members ORDER BY sort_order, id');
    res.json({ groups: groups.map((g) => ({ id: g.id, name: g.name, cover: imageOut(g.file, g.w, g.h), hidden: !!g.hidden, members: members.filter((m) => m.group_id === g.id).map((m) => m.name) })) });
  }));

  app.get('/api/admin/orders', requireAdmin, wrap(async (req, res) => {
    res.json({ orders: await loadOrders(pool, '', [], { admin: true }) });
  }));

  app.put('/api/admin/payment-methods', requireAdmin, wrap(async (req, res) => {
    const { methods } = z.object({ methods: z.array(z.object({ method: z.string().trim().min(1).max(40), accountInfo: z.string().trim().min(1).max(255) })).max(10) }).parse(req.body);
    await withTx(pool, async (conn) => {
      await conn.query('DELETE FROM payment_methods');
      for (const [i, m] of methods.entries()) await conn.query('INSERT INTO payment_methods (method, account_info, sort_order) VALUES (?,?,?)', [m.method, m.accountInfo, i]);
      await audit(conn, req.account.id, 'payment_methods.update');
    });
    res.json({ ok: true });
  }));

  app.post('/api/admin/groups', requireAdmin, wrap(async (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(80), members: z.array(z.string().trim().min(1).max(80)).max(30).optional(), hidden: z.boolean().optional() }).parse(req.body);
    const id = await withTx(pool, async (conn) => {
      const [r] = await conn.query('INSERT INTO artist_groups (name, is_hidden) VALUES (?, ?)', [b.name, b.hidden ? 1 : 0]);
      for (const [i, m] of (b.members || []).entries()) await conn.query('INSERT INTO group_members (group_id, name, sort_order) VALUES (?,?,?)', [r.insertId, m, i]);
      return r.insertId;
    });
    res.status(201).json({ id });
  }));

  app.post('/api/admin/orders', requireAdmin, wrap(async (req, res) => {
    const b = z.object({
      groupId: z.number().int().positive(), title: z.string().trim().min(1).max(160),
      isPrivate: z.boolean().optional(), status: z.enum(['open', 'closed']).optional(),
      closeDate: date, paymentDeadline: date, expectedShipDate: date, proxy: z.string().trim().max(80).nullable().optional(),
    }).parse(req.body);
    const id = await withTx(pool, async (conn) => {
      const proxyId = await proxyIdFor(conn, b.proxy);
      const [r] = await conn.query(
        `INSERT INTO group_orders (group_id, title, status, is_private, close_date, payment_deadline, expected_ship_date, proxy_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [b.groupId, b.title, b.status || 'open', b.isPrivate ? 1 : 0, b.closeDate || null, b.paymentDeadline || null, b.expectedShipDate || null, proxyId]);
      await audit(conn, req.account.id, 'order.create', 'order', r.insertId);
      return r.insertId;
    });
    res.status(201).json({ id });
  }));

  app.patch('/api/admin/orders/:id', requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const b = z.object({
      title: z.string().trim().min(1).max(160).optional(), isPrivate: z.boolean().optional(), status: z.enum(['open', 'closed']).optional(),
      closeDate: date, paymentDeadline: date, expectedShipDate: date, proxy: z.string().trim().max(80).nullable().optional(),
    }).parse(req.body);
    await withTx(pool, async (conn) => {
      const [[o]] = await conn.query('SELECT id FROM group_orders WHERE id = ? FOR UPDATE', [id]);
      if (!o) throw notFound('No such order');
      const set = []; const vals = [];
      const add = (col, v) => { set.push(`${col} = ?`); vals.push(v); };
      if (b.title !== undefined) add('title', b.title);
      if (b.isPrivate !== undefined) add('is_private', b.isPrivate ? 1 : 0);
      if (b.status !== undefined) add('status', b.status);
      if (b.closeDate !== undefined) add('close_date', b.closeDate);
      if (b.paymentDeadline !== undefined) add('payment_deadline', b.paymentDeadline);
      if (b.expectedShipDate !== undefined) add('expected_ship_date', b.expectedShipDate);
      if (b.proxy !== undefined) add('proxy_id', await proxyIdFor(conn, b.proxy));
      if (set.length) await conn.query(`UPDATE group_orders SET ${set.join(', ')} WHERE id = ?`, [...vals, id]);
      await audit(conn, req.account.id, 'order.update', 'order', id, b);
    });
    res.json({ ok: true });
  }));

  app.post('/api/admin/orders/:id/items', requireAdmin, wrap(async (req, res) => {
    const orderId = Number(req.params.id);
    const b = z.object({
      type: z.enum(['set', 'independent', 'size', 'normal', 'random']), title: z.string().trim().min(1).max(160), price: money.optional(), priceTbc: z.boolean().optional(),
      description: z.string().trim().max(2000).optional(),
      // a member is a name, or { name, price } when that part costs something different (e.g. a Diary at £2 in a £3-a-card set)
      members: z.array(z.union([z.string().trim().min(1).max(80), z.object({ name: z.string().trim().min(1).max(80), price: money.optional() })])).max(30).optional(),
      requiresFullSet: z.boolean().optional(), variants: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
      sizeBucket: z.enum(['XS', 'S', 'M', 'L', 'XL']).optional(), paymentDeadline: date, proxy: z.string().trim().max(80).nullable().optional(),
    }).parse(req.body);
    if (b.priceTbc && b.price !== undefined) throw bad('Either enter a price or tick "price to be confirmed" — not both.');
    if (!b.priceTbc && b.price === undefined) throw bad('Enter a price, or tick "price to be confirmed".');
    const parts = (b.members || []).map((m) => (typeof m === 'string' ? { name: m, price: null } : { name: m.name, price: m.price ?? null }));
    if ((b.type === 'set' || b.type === 'independent') && !parts.length) throw bad('This item type needs a member list');
    if (new Set(parts.map((p) => p.name.toLowerCase())).size !== parts.length) throw bad('Each part needs its own name');
    if (parts.some((p) => p.price !== null) && b.type !== 'set') throw bad('Part prices only apply to sets');
    if (b.requiresFullSet && b.type !== 'set') throw bad('"Every part must be claimed" only applies to sets');
    if (b.type === 'size' && !(b.variants || []).length) throw bad('Size items need at least one size');
    const id = await withTx(pool, async (conn) => {
      const [[o]] = await conn.query('SELECT id FROM group_orders WHERE id = ?', [orderId]);
      if (!o) throw notFound('No such order');
      const proxyId = await proxyIdFor(conn, b.proxy);
      const [r] = await conn.query(
        'INSERT INTO items (order_id, item_type, title, description, price, price_tbc, size_bucket, payment_deadline, proxy_id, requires_full_set) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [orderId, b.type, b.title, b.description || null, b.priceTbc ? 0 : b.price, b.priceTbc ? 1 : 0, b.sizeBucket || 'M', b.paymentDeadline || null, proxyId, b.requiresFullSet ? 1 : 0]);
      for (const [i, m] of parts.entries()) await conn.query('INSERT INTO item_members (item_id, name, price, sort_order) VALUES (?,?,?,?)', [r.insertId, m.name, m.price, i]);
      for (const [i, v] of (b.variants || []).entries()) await conn.query('INSERT INTO item_variants (item_id, label, sort_order) VALUES (?,?,?)', [r.insertId, v, i]);
      await audit(conn, req.account.id, 'item.create', 'item', r.insertId);
      return r.insertId;
    });
    res.status(201).json({ id });
  }));

  // Per-item proxy and pay-by date (blank = use the GO's).
  app.patch('/api/admin/items/:id', requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    let repriced = 0;
    const b = z.object({ paymentDeadline: date, proxy: z.string().trim().max(80).nullable().optional(), price: money.optional(), priceTbc: z.boolean().optional(), title: z.string().trim().min(1).max(160).optional(), description: z.string().trim().max(2000).nullable().optional() }).parse(req.body);
    await withTx(pool, async (conn) => {
      const [[it]] = await conn.query('SELECT id, price, price_tbc FROM items WHERE id = ? FOR UPDATE', [id]);
      if (!it) throw notFound('No such item');
      if (b.paymentDeadline !== undefined) await conn.query('UPDATE items SET payment_deadline = ? WHERE id = ?', [b.paymentDeadline, id]);
      if (b.proxy !== undefined) await conn.query('UPDATE items SET proxy_id = ? WHERE id = ?', [await proxyIdFor(conn, b.proxy), id]);
      // Price states: a real price, or "to be confirmed" (stored as a placeholder 0 that is never used). Entering a price on a TBC item confirms it.
      if (b.priceTbc === true && b.price !== undefined) throw bad('Either enter a price or tick "price to be confirmed" — not both.');
      if (b.priceTbc === false && b.price === undefined) throw bad('Enter the price to finish confirming it.');
      if (b.priceTbc !== undefined || b.price !== undefined) {
        const nextTbc = b.priceTbc === true, nextPrice = nextTbc ? 0 : b.price ?? it.price;
        const changed = nextTbc !== !!it.price_tbc || Math.round(nextPrice * 100) !== Math.round(it.price * 100);
        await conn.query('UPDATE items SET price = ?, price_tbc = ? WHERE id = ?', [nextPrice, nextTbc ? 1 : 0, id]);
        // The price is confirmed when a claim is SECURED. Until then a claim is only a request, so it follows the listing (or goes back to TBC);
        // once secured it keeps the price it was secured at. (A part with its own price in a mixed-price set keeps that.)
        if (changed) repriced = await repriceUnsecured(conn, id, nextTbc ? null : nextPrice);
      }
      if (b.title !== undefined) await conn.query('UPDATE items SET title = ? WHERE id = ?', [b.title, id]);
      if (b.description !== undefined) await conn.query('UPDATE items SET description = ? WHERE id = ?', [b.description || null, id]);   // blank clears it
      await audit(conn, req.account.id, 'item.update', 'item', id, b);
    });
    res.json({ ok: true, repriced });
  }));
}

// Re-prices every claim on this item that is still only a request. Claims are locked first (lowest id first) — the same order securing uses —
// so a price edit and a "secure" at the same moment can't tangle: whichever goes first wins cleanly, and a secured claim is never touched.
async function repriceUnsecured(conn, itemId, itemPrice) {          // itemPrice null = the item is now "to be confirmed"
  const [claims] = await conn.query("SELECT id, member_name FROM claims WHERE item_id = ? AND status = 'requested' ORDER BY id FOR UPDATE", [itemId]);
  if (!claims.length) return 0;
  const [parts] = await conn.query('SELECT name, price FROM item_members WHERE item_id = ?', [itemId]);
  const own = new Map(parts.filter((p) => p.price !== null).map((p) => [p.name, p.price]));
  const byPrice = new Map();
  for (const c of claims) { const price = own.get(c.member_name) ?? itemPrice; if (!byPrice.has(price)) byPrice.set(price, []); byPrice.get(price).push(c.id); }
  for (const [price, ids] of byPrice) {
    await conn.query("UPDATE claim_costs SET cost = ? WHERE category = 'initials' AND claim_id IN (?)", [price ?? 0, ids]);
    await conn.query('UPDATE claims SET price_tbc = ? WHERE id IN (?)', [price === null ? 1 : 0, ids]);
  }
  return claims.length;
}
