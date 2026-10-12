import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { bad, notFound } from '../errors.js';
import { incomingSnapshot, advancePlan } from '../lib/incoming.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-31').refine((s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }, 'That is not a real date');
const optText = (n) => z.string().trim().max(n).nullish().transform((v) => v || null);
const url = z.string().trim().max(500).nullish().transform((v) => v || null).refine((v) => v === null || /^https?:\/\/[^\s]+$/i.test(v), 'The link must start with http:// or https://');
const tracking = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 -]{3,39}$/, 'A tracking number is letters, numbers, spaces and dashes (4–40 characters)');
const line = z.object({ itemId: z.number().int().positive(), qty: z.number().int().min(1).max(9999), note: optText(200) });
const shipment = z.object({ carrier: optText(40), trackingNo: tracking, shippedOn: date.nullish().transform((v) => v || null), notes: optText(200) });

async function proxyIdFor(conn, name) {
  if (!name) return null;
  await conn.query('INSERT INTO proxies (name) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)', [name]);
  return (await conn.query('SELECT LAST_INSERT_ID() AS id'))[0][0].id;
}

// Orders placed with shops (by the GOM or a proxy) and their tracking numbers to the warehouse — see lib/incoming.js.
export function incomingRoutes(app, { pool }) {
  const admin = requireAdmin;
  app.get('/api/admin/incoming', admin, wrap(async (req, res) => res.json(await incomingSnapshot(pool))));

  app.post('/api/admin/store-orders', admin, wrap(async (req, res) => {
    const b = z.object({ store: z.string().trim().min(1).max(120), orderRef: optText(120), orderUrl: url, orderedOn: date, proxy: optText(80), notes: optText(2000), lines: z.array(line).max(60).default([]), shipments: z.array(shipment).max(30).default([]) }).parse(req.body);
    const id = await withTx(pool, async (conn) => {
      const proxyId = await proxyIdFor(conn, b.proxy);
      const [r] = await conn.query('INSERT INTO store_orders (store, order_ref, order_url, ordered_on, proxy_id, notes) VALUES (?,?,?,?,?,?)', [b.store, b.orderRef, b.orderUrl, b.orderedOn, proxyId, b.notes]);
      for (const l of b.lines) await addLine(conn, r.insertId, l);
      for (const s of b.shipments) await conn.query('INSERT INTO store_shipments (store_order_id, carrier, tracking_no, shipped_on, notes) VALUES (?,?,?,?,?)', [r.insertId, s.carrier, s.trackingNo, s.shippedOn, s.notes]);
      await audit(conn, req.account.id, 'store_order.create', 'store_order', r.insertId, { lines: b.lines.length, shipments: b.shipments.length });
      return r.insertId;
    });
    res.status(201).json({ id });
  }));

  async function addLine(conn, orderId, l) {
    const [[it]] = await conn.query('SELECT id FROM items WHERE id = ?', [l.itemId]);
    if (!it) throw bad('One of those items no longer exists', 'no_item');
    const [r] = await conn.query('INSERT INTO store_order_lines (store_order_id, item_id, qty, note) VALUES (?,?,?,?)', [orderId, l.itemId, l.qty, l.note]);
    return r.insertId;
  }

  app.patch('/api/admin/store-orders/:id', admin, wrap(async (req, res) => {
    const b = z.object({ store: z.string().trim().min(1).max(120).optional(), orderRef: optText(120).optional(), orderUrl: url.optional(), orderedOn: date.optional(), proxy: optText(80).optional(), notes: optText(2000).optional(),
      status: z.enum(['open', 'cancelled']).optional(), lastChasedOn: date.nullable().optional() }).parse(req.body);
    await withTx(pool, async (conn) => {
      const [[o]] = await conn.query('SELECT id FROM store_orders WHERE id = ? FOR UPDATE', [Number(req.params.id)]); if (!o) throw notFound('No such store order');
      const set = [], vals = []; const add = (c, v) => { set.push(`${c} = ?`); vals.push(v); };
      if (b.store !== undefined) add('store', b.store); if (b.orderRef !== undefined) add('order_ref', b.orderRef); if (b.orderUrl !== undefined) add('order_url', b.orderUrl); if (b.orderedOn !== undefined) add('ordered_on', b.orderedOn);
      if (b.notes !== undefined) add('notes', b.notes); if (b.status !== undefined) add('status', b.status); if (b.lastChasedOn !== undefined) add('last_chased_on', b.lastChasedOn);
      if (b.proxy !== undefined) add('proxy_id', await proxyIdFor(conn, b.proxy));
      if (set.length) await conn.query(`UPDATE store_orders SET ${set.join(', ')} WHERE id = ?`, [...vals, o.id]);
      await audit(conn, req.account.id, 'store_order.update', 'store_order', o.id, { fields: set.length });
    });
    res.json({ ok: true });
  }));

  app.delete('/api/admin/store-orders/:id', admin, wrap(async (req, res) => {
    await withTx(pool, async (conn) => {
      const [r] = await conn.query('DELETE FROM store_orders WHERE id = ?', [Number(req.params.id)]); if (!r.affectedRows) throw notFound('No such store order');
      await audit(conn, req.account.id, 'store_order.delete', 'store_order', Number(req.params.id));
    });
    res.json({ ok: true });
  }));

  // everything on it arrived: every line fully, every tracking number dated today (a shortcut for the common case of one parcel that came complete)
  app.post('/api/admin/store-orders/:id/arrived-all', admin, wrap(async (req, res) => {
    await withTx(pool, async (conn) => {
      const [[o]] = await conn.query('SELECT id FROM store_orders WHERE id = ? FOR UPDATE', [Number(req.params.id)]); if (!o) throw notFound('No such store order');
      await conn.query('UPDATE store_order_lines SET arrived_qty = qty WHERE store_order_id = ?', [o.id]);
      await conn.query('UPDATE store_shipments SET arrived_on = COALESCE(arrived_on, CURDATE()) WHERE store_order_id = ?', [o.id]);
      await audit(conn, req.account.id, 'store_order.arrived_all', 'store_order', o.id);
    });
    res.json({ ok: true });
  }));

  // lines
  app.post('/api/admin/store-orders/:id/lines', admin, wrap(async (req, res) => {
    const b = line.parse(req.body);
    const id = await withTx(pool, async (conn) => { const [[o]] = await conn.query('SELECT id FROM store_orders WHERE id = ? FOR UPDATE', [Number(req.params.id)]); if (!o) throw notFound('No such store order'); return addLine(conn, o.id, b); });
    res.status(201).json({ id });
  }));
  app.patch('/api/admin/store-order-lines/:id', admin, wrap(async (req, res) => {
    const b = z.object({ qty: z.number().int().min(1).max(9999).optional(), arrivedQty: z.number().int().min(0).max(9999).optional(), note: optText(200).optional() }).parse(req.body);
    await withTx(pool, async (conn) => {
      const [[l]] = await conn.query('SELECT id, qty, arrived_qty FROM store_order_lines WHERE id = ? FOR UPDATE', [Number(req.params.id)]); if (!l) throw notFound('No such line');
      const qty = b.qty ?? l.qty, arrived = b.arrivedQty ?? l.arrived_qty;
      if (arrived > qty) throw bad(`${arrived} can't have arrived when only ${qty} were ordered.`, 'too_many_arrived');
      await conn.query('UPDATE store_order_lines SET qty = ?, arrived_qty = ?, note = COALESCE(?, note) WHERE id = ?', [qty, arrived, b.note === undefined ? null : b.note, l.id]);
    });
    res.json({ ok: true });
  }));
  app.delete('/api/admin/store-order-lines/:id', admin, wrap(async (req, res) => { const [r] = await pool.query('DELETE FROM store_order_lines WHERE id = ?', [Number(req.params.id)]); if (!r.affectedRows) throw notFound('No such line'); res.json({ ok: true }); }));

  // tracking numbers
  app.post('/api/admin/store-orders/:id/shipments', admin, wrap(async (req, res) => {
    const b = shipment.parse(req.body);
    const id = await withTx(pool, async (conn) => {
      const [[o]] = await conn.query('SELECT id FROM store_orders WHERE id = ? FOR UPDATE', [Number(req.params.id)]); if (!o) throw notFound('No such store order');
      return (await conn.query('INSERT INTO store_shipments (store_order_id, carrier, tracking_no, shipped_on, notes) VALUES (?,?,?,?,?)', [o.id, b.carrier, b.trackingNo, b.shippedOn, b.notes]))[0].insertId;
    });
    res.status(201).json({ id });
  }));
  app.patch('/api/admin/store-shipments/:id', admin, wrap(async (req, res) => {
    const b = z.object({ carrier: optText(40).optional(), trackingNo: tracking.optional(), shippedOn: date.nullable().optional(), arrivedOn: date.nullable().optional(), notes: optText(200).optional() }).parse(req.body);
    const set = [], vals = []; const add = (c, v) => { set.push(`${c} = ?`); vals.push(v); };
    if (b.carrier !== undefined) add('carrier', b.carrier); if (b.trackingNo !== undefined) add('tracking_no', b.trackingNo); if (b.shippedOn !== undefined) add('shipped_on', b.shippedOn); if (b.arrivedOn !== undefined) add('arrived_on', b.arrivedOn); if (b.notes !== undefined) add('notes', b.notes);
    if (!set.length) return res.json({ ok: true });
    const [r] = await pool.query(`UPDATE store_shipments SET ${set.join(', ')} WHERE id = ?`, [...vals, Number(req.params.id)]); if (!r.affectedRows) throw notFound('No such tracking number');
    res.json({ ok: true });
  }));
  app.delete('/api/admin/store-shipments/:id', admin, wrap(async (req, res) => { const [r] = await pool.query('DELETE FROM store_shipments WHERE id = ?', [Number(req.params.id)]); if (!r.affectedRows) throw notFound('No such tracking number'); res.json({ ok: true }); }));

  // which claims should move on, given what has been ordered / has arrived (a preview; the screen then uses the ordinary "move stage" action)
  app.get('/api/admin/incoming/items/:id/advance-plan', admin, wrap(async (req, res) => {
    const to = z.enum(['ordered', 'arrived']).parse(req.query.to);
    const plan = await advancePlan(pool, Number(req.params.id), to); if (!plan) throw notFound('No such item');
    res.json(plan);
  }));

  app.put('/api/admin/settings/warehouse-address', admin, wrap(async (req, res) => {
    const { address } = z.object({ address: z.string().max(600) }).parse(req.body);
    await pool.query("INSERT INTO gom_settings (k, v) VALUES ('warehouse_address', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [address.trim()]);
    res.json({ ok: true });
  }));
}
