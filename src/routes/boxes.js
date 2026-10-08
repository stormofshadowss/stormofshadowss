import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { bad, conflict, notFound } from '../errors.js';
import { lockJoiner, sweepCredit, reduceCost } from '../lib/ledger.js';
import { boxSplit } from '../lib/box.js';
import { round2, splitAmount } from '../lib/money.js';

const ARRIVED = 'arrived at proxy / warehouse';
const money = z.number().min(0).max(100000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At most 2 decimal places');
const ids = z.array(z.number().int().positive()).min(1).max(200);
const PRICE = "(SELECT cost FROM claim_costs WHERE claim_id = c.id AND category = 'initials')";

export function boxRoutes(app, { pool }) {
  const admin = [requireAdmin];

  // Items that have reached the proxy/warehouse and can go into a box.
  app.get('/api/admin/boxes/candidates', admin, wrap(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT c.id AS claimId, j.instagram_handle AS handle, c.label, COALESCE(go.title, 'Shop (on hand)') AS orderTitle,
              c.weight_g AS weightG, c.size_bucket AS size, ${PRICE} AS price
         FROM claims c JOIN joiners j ON j.id = c.joiner_id LEFT JOIN group_orders go ON go.id = c.order_id
        WHERE c.status = 'confirmed' AND c.pipeline = ? AND c.box_id IS NULL ORDER BY go.id, j.instagram_handle, c.id`, [ARRIVED]);
    res.json({ candidates: rows });
  }));

  // Loads and checks the items for a box. Locks the people first, then the claims (the order every money flow uses).
  async function loadItems(conn, claimIds, lock) {
    const sorted = [...new Set(claimIds)].sort((a, b) => a - b);
    if (lock) {
      const [who] = await conn.query('SELECT DISTINCT joiner_id FROM claims WHERE id IN (?) ORDER BY joiner_id', [sorted]);
      for (const { joiner_id } of who) await lockJoiner(conn, joiner_id);
    }
    const [rows] = await conn.query(
      `SELECT c.id, c.joiner_id AS joinerId, c.status, c.pipeline, c.box_id AS boxId, c.weight_g AS weight, c.size_bucket AS size, c.label, ${PRICE} AS price
         FROM claims c WHERE c.id IN (?) ORDER BY c.id ${lock ? 'FOR UPDATE' : ''}`, [sorted]);
    if (rows.length !== sorted.length) throw notFound('One of those items doesn\'t exist');
    const notOk = rows.filter((r) => r.status !== 'confirmed' || r.pipeline !== ARRIVED || r.boxId);
    if (notOk.length) throw conflict(`Not ready to box (it must have arrived at the proxy and not be in a box already): ${notOk.map((r) => r.label).join(', ')}`, 'not_boxable');
    return rows;
  }
  const splitBody = z.object({ claimIds: ids, emsTotal: money, customsTotal: money.optional(), totalWeightG: z.number().int().min(0).max(1_000_000).optional() });
  const splitFor = (items, b) => boxSplit(items, { emsTotal: b.emsTotal, customsTotal: b.customsTotal || 0, boxTotal: b.totalWeightG || 0 });

  // What the split WOULD be, before anything is saved.
  app.post('/api/admin/boxes/preview', admin, wrap(async (req, res) => {
    const b = splitBody.parse(req.body);
    const items = await withTx(pool, (conn) => loadItems(conn, b.claimIds, false));
    const s = splitFor(items, b);
    res.json({ note: s.note, rows: items.map((it, i) => ({ claimId: it.id, label: it.label, weightUsedG: Math.round(s.weights[it.id]), estimated: !it.weight, emsShare: s.emsShares[i], customsShare: s.customsShares[i] })) });
  }));

  // Create a box: the EMS (and customs, if known) are added to each item's costs, and they all move to "shipping requested".
  app.post('/api/admin/boxes', admin, wrap(async (req, res) => {
    const b = splitBody.extend({ trackingId: z.string().trim().max(80).optional() }).parse(req.body);
    if (!(b.emsTotal > 0)) throw bad("Enter an EMS total — that's what creates the box.", 'ems_required');
    const out = await withTx(pool, async (conn) => {
      const items = await loadItems(conn, b.claimIds, true);
      const s = splitFor(items, b);
      const [box] = await conn.query('INSERT INTO boxes (tracking_id, ems_total, customs_total, total_weight_g, status) VALUES (?,?,?,?,?)',
        [b.trackingId || null, b.emsTotal, b.customsTotal || 0, b.totalWeightG || null, 'shipping_requested']);
      for (const [i, it] of items.entries()) {
        await conn.query('INSERT INTO box_items (box_id, claim_id, weight_used_g, ems_share, customs_share) VALUES (?,?,?,?,?)', [box.insertId, it.id, Math.round(s.weights[it.id]), s.emsShares[i], s.customsShares[i]]);
        await conn.query("UPDATE claim_costs SET cost = ROUND(cost + ?, 2) WHERE claim_id = ? AND category = 'ems'", [s.emsShares[i], it.id]);
        if (s.customsShares[i] > 0) await conn.query("UPDATE claim_costs SET cost = ROUND(cost + ?, 2) WHERE claim_id = ? AND category = 'customs'", [s.customsShares[i], it.id]);
        await conn.query("UPDATE claims SET pipeline = 'shipping requested', box_id = ? WHERE id = ?", [box.insertId, it.id]);
      }
      for (const jid of [...new Set(items.map((i) => i.joinerId))].sort((x, y) => x - y)) await sweepCredit(conn, jid);   // credit meets the new costs
      await audit(conn, req.account.id, 'box.create', 'box', box.insertId, { items: items.length, ems: b.emsTotal });
      return { id: box.insertId, items: items.length, note: s.note };
    });
    res.status(201).json({ ok: true, ...out });
  }));

  async function boxesWithItems(where, params) {
    const [boxes] = await pool.query(`SELECT id, tracking_id AS trackingId, ems_total AS emsTotal, customs_total AS customsTotal, total_weight_g AS totalWeightG, status, created_at AS createdAt FROM boxes ${where} ORDER BY id DESC LIMIT 500`, params);
    if (!boxes.length) return [];
    const [items] = await pool.query(
      `SELECT bi.box_id, bi.claim_id AS claimId, j.instagram_handle AS handle, c.label, c.pipeline, bi.weight_used_g AS weightUsedG, bi.ems_share AS emsShare, bi.customs_share AS customsShare, bi.item_status AS itemStatus
         FROM box_items bi JOIN claims c ON c.id = bi.claim_id JOIN joiners j ON j.id = c.joiner_id WHERE bi.box_id IN (?) ORDER BY bi.claim_id`, [boxes.map((x) => x.id)]);
    return boxes.map((x) => {
      const its = items.filter((i) => i.box_id === x.id).map(({ box_id, ...rest }) => rest);
      // done with once it has arrived and every item has been checked as ready
      return { ...x, items: its, archived: x.status === 'arrived' && its.length > 0 && its.every((i) => i.itemStatus === 'ready') };
    });
  }

  app.get('/api/admin/boxes', admin, wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
    let list = await boxesWithItems('', []);
    if (q) list = list.filter((x) => [String(x.id), x.trackingId || '', ...x.items.flatMap((i) => [i.handle, i.label])].join(' ').toLowerCase().includes(q));
    res.json({ boxes: list });
  }));

  app.patch('/api/admin/boxes/:id', admin, wrap(async (req, res) => {
    const { trackingId } = z.object({ trackingId: z.string().trim().max(80) }).parse(req.body);
    const [r] = await pool.query('UPDATE boxes SET tracking_id = ? WHERE id = ?', [trackingId || null, Number(req.params.id)]);
    if (r.affectedRows !== 1) throw notFound('No such box');
    res.json({ ok: true });
  }));

  // Moving a box along: its items follow.
  const advance = (name, from, to, itemPipeline) => app.post(`/api/admin/boxes/:id/${name}`, admin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[bx]] = await conn.query('SELECT status FROM boxes WHERE id = ? FOR UPDATE', [id]);
      if (!bx) throw notFound('No such box');
      if (bx.status !== from) throw conflict(`That box is ${bx.status.replace('_', ' ')}, so it can't be marked ${name === 'enroute' ? 'en route' : name}`, 'bad_state');
      await conn.query('UPDATE boxes SET status = ? WHERE id = ?', [to, id]);
      await conn.query('UPDATE claims SET pipeline = ? WHERE id IN (SELECT claim_id FROM box_items WHERE box_id = ?)', [itemPipeline, id]);
      if (to === 'arrived') await conn.query("UPDATE box_items SET item_status = 'pending' WHERE box_id = ?", [id]);
      await audit(conn, req.account.id, `box.${name}`, 'box', id);
    });
    res.json({ ok: true });
  }));
  advance('enroute', 'shipping_requested', 'enroute', 'enroute to GOM');
  advance('arrived', 'enroute', 'arrived', 'arrived at GOM');

  // After it arrives: tick what's actually fine (it becomes ready to pack, which starts its storage clock); anything you leave
  // unticked stays at "checking parcel". Can be run again later as problems get sorted.
  app.post('/api/admin/boxes/:id/ready', admin, wrap(async (req, res) => {
    const b = z.object({ ready: z.array(z.number().int().positive()).max(200), checking: z.array(z.number().int().positive()).max(200) }).parse(req.body);
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[bx]] = await conn.query('SELECT status FROM boxes WHERE id = ? FOR UPDATE', [id]);
      if (!bx) throw notFound('No such box');
      if (bx.status !== 'arrived') throw conflict('Mark the box as arrived before checking its items', 'bad_state');
      const [mine] = await conn.query('SELECT claim_id FROM box_items WHERE box_id = ?', [id]);
      const inBox = new Set(mine.map((m) => m.claim_id));
      if ([...b.ready, ...b.checking].some((c) => !inBox.has(c))) throw notFound('One of those items is not in this box');
      // never move something backwards once it has gone on to packing
      const live = "pipeline IN ('arrived at GOM', 'checking parcel', 'ready to pack / on hand')";
      if (b.ready.length) {
        await conn.query("UPDATE box_items SET item_status = 'ready' WHERE box_id = ? AND claim_id IN (?)", [id, b.ready]);
        await conn.query(`UPDATE claims SET pipeline = 'ready to pack / on hand', ready_to_pack_date = COALESCE(ready_to_pack_date, CURDATE()) WHERE id IN (?) AND ${live}`, [b.ready]);
      }
      if (b.checking.length) {
        await conn.query("UPDATE box_items SET item_status = 'checking' WHERE box_id = ? AND claim_id IN (?)", [id, b.checking]);
        await conn.query(`UPDATE claims SET pipeline = 'checking parcel' WHERE id IN (?) AND ${live}`, [b.checking]);
      }
      await audit(conn, req.account.id, 'box.ready', 'box', id, { ready: b.ready.length, checking: b.checking.length });
    });
    res.json({ ok: true });
  }));

  // Customs often arrives long after the box. Same value-based split as at creation, applied as a CHANGE from whatever was added
  // before — so it works the same five minutes or five months later, and correcting it later is safe.
  app.post('/api/admin/boxes/:id/customs', admin, wrap(async (req, res) => {
    const { customsTotal } = z.object({ customsTotal: money }).parse(req.body);
    if (!(customsTotal > 0)) throw bad('Enter a customs total first.', 'customs_required');
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[bx]] = await conn.query('SELECT id FROM boxes WHERE id = ?', [id]);
      if (!bx) throw notFound('No such box');
      const [who] = await conn.query('SELECT DISTINCT c.joiner_id FROM box_items bi JOIN claims c ON c.id = bi.claim_id WHERE bi.box_id = ? ORDER BY c.joiner_id', [id]);
      for (const { joiner_id } of who) await lockJoiner(conn, joiner_id);
      await conn.query('SELECT id FROM boxes WHERE id = ? FOR UPDATE', [id]);
      const [items] = await conn.query(`SELECT bi.claim_id AS id, bi.customs_share AS old, c.joiner_id AS joinerId, ${PRICE} AS price FROM box_items bi JOIN claims c ON c.id = bi.claim_id WHERE bi.box_id = ? ORDER BY bi.claim_id`, [id]);
      const prices = items.map((i) => i.price);
      const shares = splitAmount(customsTotal, prices.every((p) => !(p > 0)) ? prices.map(() => 1) : prices);
      for (const [i, it] of items.entries()) {
        const delta = round2(shares[i] - it.old);
        if (delta > 0) await conn.query("UPDATE claim_costs SET cost = ROUND(cost + ?, 2) WHERE claim_id = ? AND category = 'customs'", [delta, it.id]);
        else if (delta < 0) await reduceCost(conn, it.joinerId, it.id, 'customs', -delta, 'Customs reduced', 'Customs correction');   // paid beyond the new figure becomes credit
        await conn.query('UPDATE box_items SET customs_share = ? WHERE box_id = ? AND claim_id = ?', [shares[i], id, it.id]);
      }
      await conn.query('UPDATE boxes SET customs_total = ? WHERE id = ?', [customsTotal, id]);
      for (const jid of [...new Set(items.map((i) => i.joinerId))].sort((x, y) => x - y)) await sweepCredit(conn, jid);
      await audit(conn, req.account.id, 'box.customs', 'box', id, { customsTotal });
    });
    res.json({ ok: true });
  }));

  // Undo a box (until it has arrived): the EMS and customs it added come off again — anything already paid towards them returns as credit —
  // and its items go back to "arrived at proxy / warehouse".
  app.delete('/api/admin/boxes/:id', admin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[bx0]] = await conn.query('SELECT status FROM boxes WHERE id = ?', [id]);
      if (!bx0) throw notFound('No such box');
      const [who] = await conn.query('SELECT DISTINCT c.joiner_id FROM box_items bi JOIN claims c ON c.id = bi.claim_id WHERE bi.box_id = ? ORDER BY c.joiner_id', [id]);
      for (const { joiner_id } of who) await lockJoiner(conn, joiner_id);
      const [[bx]] = await conn.query('SELECT status FROM boxes WHERE id = ? FOR UPDATE', [id]);
      if (bx.status === 'arrived') throw conflict("A box that has arrived can't be undone — its items are already being checked.", 'bad_state');
      const [items] = await conn.query('SELECT bi.claim_id AS id, bi.ems_share AS ems, bi.customs_share AS customs, c.joiner_id AS joinerId FROM box_items bi JOIN claims c ON c.id = bi.claim_id WHERE bi.box_id = ? ORDER BY bi.claim_id', [id]);
      for (const it of items) {
        if (it.ems > 0) await reduceCost(conn, it.joinerId, it.id, 'ems', it.ems, 'EMS removed — box undone', 'Box undone');
        if (it.customs > 0) await reduceCost(conn, it.joinerId, it.id, 'customs', it.customs, 'Customs removed — box undone', 'Box undone');
        await conn.query("UPDATE claims SET pipeline = ?, box_id = NULL WHERE id = ?", [ARRIVED, it.id]);
      }
      await conn.query('DELETE FROM boxes WHERE id = ?', [id]);       // its box_items go with it
      await audit(conn, req.account.id, 'box.undo', 'box', id, { items: items.length });
    });
    res.json({ ok: true });
  }));
}
