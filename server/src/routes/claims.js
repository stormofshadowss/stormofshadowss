import { z } from 'zod';
import { wrap } from '../lib/http.js';
import rateLimit from 'express-rate-limit';
import { requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { bad, notFound, conflict } from '../errors.js';
import { normalizeHandle, isValidHandle } from '../lib/handles.js';
import { addClaimCosts, lockJoiner, setCost, sweepCredit } from '../lib/ledger.js';
import { cancelClaim } from '../lib/cancel.js';
import { ensureDevice, deviceHasProof, grantProof } from '../lib/device.js';
import { placeSetParts } from '../lib/sets.js';
import { placeItemLine, lockLineItems, alreadyHas } from '../lib/claim-create.js';
import { moveClaims } from '../lib/move-claims.js';
import { HttpError } from '../errors.js';
import { CATS, round2 } from '../lib/money.js';

const READY = 'ready to pack / on hand';
const PIPELINE = ['awaiting fulfillment', 'ordered via proxy / warehouse', 'arrived at proxy / warehouse', 'shipping requested',
  'enroute to GOM', 'arrived at GOM', 'checking parcel', READY, 'packed', 'shipped', 'completed'];

// the stages the GOM can set by hand (the others — shipping requested, packed, shipped — follow from a parcel)
const BULK_STAGES = ['awaiting fulfillment', 'ordered via proxy / warehouse', 'arrived at proxy / warehouse', 'arrived at GOM', 'checking parcel', READY];

const maxList = () => Number(process.env.CLAIMS_LIST_MAX) || 20000;          // most claims the admin list returns in one go (an env override exists for tests)

// Confirm requested claims (a GO's, or just the listed ones) and start what they owe. Used by the Secure buttons AND when the GOM adds a claim for someone as "confirmed",
// so both follow exactly the same rules (TBC prices and pending cancel requests are left alone; set parts wait for their set; credit is applied).
export async function secureClaims(conn, b, accountId) {
  // set parts are secured a whole set at a time (Sets tab) — except a new request that joined a set ALREADY secured, which is confirmed here like any other claim
  const where = ["status = 'requested'", "(set_id IS NULL OR set_id IN (SELECT id FROM item_sets WHERE admin_decision = 'secured'))"]; const params = [];
  if (b.orderId) { where.push('order_id = ?'); params.push(b.orderId); }
  if (b.claimIds?.length) { where.push('id IN (?)'); params.push(b.claimIds); }
  // A claim whose price is still TBC can't be confirmed — leave those alone, and say how many.
  const [[tbc]] = await conn.query(`SELECT COUNT(*) AS n FROM claims WHERE ${where.join(' AND ')} AND price_tbc = 1`, params);
  where.push('price_tbc = 0');
  // Something a joiner has asked to cancel isn't confirmed behind their back — leave those too, and say how many.
  const ASKED = "EXISTS (SELECT 1 FROM cancel_requests cr WHERE cr.claim_id = claims.id AND cr.status = 'pending')";
  const [[asked]] = await conn.query(`SELECT COUNT(*) AS n FROM claims WHERE ${where.join(' AND ')} AND ${ASKED}`, params);
  where.push(`NOT ${ASKED}`);
  // Lock order matters: people first (lowest id first), claims second. Every
  // flow that touches someone's money does the same, so none can wait on each other in a circle.
  const [who] = await conn.query(`SELECT DISTINCT joiner_id FROM claims WHERE ${where.join(' AND ')} ORDER BY joiner_id`, params);
  for (const { joiner_id } of who) await lockJoiner(conn, joiner_id);
  const [rows] = await conn.query(`SELECT id, joiner_id FROM claims WHERE ${where.join(' AND ')} FOR UPDATE`, params);
  if (rows.length) await conn.query("UPDATE claims SET status = 'confirmed' WHERE id IN (?)", [rows.map((r) => r.id)]);
  // Newly confirmed costs can now be met by any credit the joiner already has.
  for (const joinerId of [...new Set(rows.map((r) => r.joiner_id))].sort((a, b2) => a - b2)) {
    await sweepCredit(conn, joinerId);
  }
  await audit(conn, accountId, 'claims.secure', 'order', b.orderId || null, { count: rows.length, skippedTbc: tbc.n, skippedCancel: asked.n });
  return { ids: rows.map((r) => r.id), skippedTbc: tbc.n, skippedCancel: asked.n };
}

export function claimRoutes(app, { pool, cfg, notifier }) {
  const claimLimiter = rateLimit({
    windowMs: 600_000, limit: cfg.rateLimits.claimsPer10MinPerIp, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many claims from here — please wait a few minutes.' },
  });

  // Claiming needs no sign-in: just an Instagram handle. Nothing is committed
  // until the GOM secures it, so a mistaken or mischievous claim costs nobody anything.
  // (Full member-set claiming is the next piece to port; sets need their own slot-placement rules.)
  app.post('/api/claims', claimLimiter, wrap(async (req, res) => {
    const b = z.object({
      handle: z.string().min(1).max(40),
      lines: z.array(z.object({
        itemId: z.number().int().positive().optional(), leftoverId: z.number().int().positive().optional(), qty: z.number().int().min(1).max(20).optional(),
        member: z.string().max(80).optional(), variant: z.string().max(40).optional(),
        // member sets: which parts, and how many of each. "together" keeps one of each part in the same set.
        parts: z.array(z.object({ member: z.string().max(80), qty: z.number().int().min(1).max(20) })).max(40).optional(), together: z.boolean().optional(),
      }).refine((l) => !!l.itemId !== !!l.leftoverId, { message: 'Each line needs an item, or a shop item' })).min(1).max(30),
      allowDuplicates: z.boolean().optional(),                 // the person saw "you already have this — claim another?" and said yes
    }).parse(req.body);
    const handle = normalizeHandle(b.handle);
    if (!isValidHandle(handle)) throw bad('Instagram handles use letters, numbers, full stops and underscores (up to 30 characters).');

    const deviceToken = ensureDevice(req, res, cfg);
    let isNew = false, joinerId = null;
    const created = await withTx(pool, async (conn) => {
      const [[blocked]] = await conn.query('SELECT is_blocked FROM joiners WHERE instagram_handle = ?', [handle]);
      if (blocked && blocked.is_blocked) throw new HttpError(403, "This handle can't place orders right now. Please message the GOM.", 'handle_blocked');
      // First time we've seen this handle? Exactly one of any simultaneous first claims gets to be "new".
      const [ins] = await conn.query('INSERT IGNORE INTO joiners (instagram_handle) VALUES (?)', [handle]);
      isNew = ins.affectedRows === 1;
      const [[row]] = await conn.query('SELECT id FROM joiners WHERE instagram_handle = ?', [handle]);
      joinerId = row.id;
      if (isNew) await grantProof(conn, cfg, deviceToken, joinerId);   // this browser made the first claim
      const ids = [], placements = [], shopIds = [];
      // Sets: lock the set items (lowest id first, so two requests can never wait on each other in a circle). While we hold it,
      // nobody else is placed into these items' sets, so two people can't take the same part of the same set.
      // Every item named in the request is locked (lowest id first, so two requests can never wait on each other in a circle). That also stops a price
      // edit from landing between us reading the price and saving the claim — an unsecured claim must always carry the price listed at the time.
      await lockLineItems(conn, b.lines);
      // Shop (on hand) stock: lock each shop item (lowest id first) so the last unit can't be sold to two people at once.
      const shopLocks = [...new Set(b.lines.filter((l) => l.leftoverId).map((l) => l.leftoverId))].sort((x, y) => x - y);
      if (shopLocks.length) await conn.query('SELECT id FROM leftover_items WHERE id IN (?) ORDER BY id FOR UPDATE', [shopLocks]);
      // A repeat of something this handle already has (usually someone unsure the first claim went through): ask first. (Items are locked by now, so a second press waits for the first and then sees it.)
      if (!isNew && !b.allowDuplicates) {
        const have = await alreadyHas(conn, joinerId, b.lines);
        if (have.length) throw conflict(`You already have ${have.map((h) => `${h.count} × ${h.label}`).join(', ')} — claim another?`, 'already_claimed', { have });
      }
      for (const line of b.lines) {
        if (line.leftoverId) {
          const qty = line.qty || 1;
          const [[it]] = await conn.query('SELECT id, title, price, qty AS stock, pay_days, size_bucket, is_active FROM leftover_items WHERE id = ?', [line.leftoverId]);
          if (!it || !it.is_active) throw notFound("That shop item isn't available");
          const [[taken]] = await conn.query("SELECT COUNT(*) AS n FROM claims WHERE leftover_item_id = ? AND status <> 'cancelled'", [it.id]);
          const left = it.stock - taken.n;
          if (qty > left) throw conflict(left <= 0 ? `"${it.title}" has sold out.` : `Only ${left} of "${it.title}" left.`, 'sold_out');
          for (let k = 0; k < qty; k++) {
            const [r] = await conn.query(
              "INSERT INTO claims (joiner_id, order_id, item_id, leftover_item_id, label, size_bucket, status, pay_by) VALUES (?, NULL, NULL, ?, ?, ?, 'confirmed', DATE_ADD(CURDATE(), INTERVAL ? DAY))",
              [joinerId, it.id, it.title, it.size_bucket, it.pay_days]);
            await addClaimCosts(conn, r.insertId, it.price);
            ids.push(r.insertId); shopIds.push(r.insertId);
          }
          continue;
        }
        const r = await placeItemLine(conn, { joinerId, line });
        ids.push(...r.ids); placements.push(...r.placements);
      }
      return { ids, placements, shopIds };
    });
    notifier.claimsSecured(created.shopIds);                  // shop claims are confirmed at once, so they're told what they owe
    // What should the page offer next? (Claiming never needed an account; this is about seeing orders and paying.)
    const [[who]] = await pool.query('SELECT account_id FROM joiners WHERE id = ?', [joinerId]);
    const hasAccount = !!who.account_id;
    const canLinkEmail = !hasAccount && await deviceHasProof(pool, deviceToken, joinerId);
    res.status(201).json({ ok: true, claimIds: created.ids, placements: created.placements.map(({ claimId, member, setNumber, label, price }) => ({ claimId, member, setNumber, label, price })), status: 'requested', handle: { name: handle, isNew, hasAccount, canLinkEmail } });
  }));

  // ── GOM side ──
  app.get('/api/admin/claims', requireAdmin, wrap(async (req, res) => {
    const where = ['1=1']; const params = [];
    if (req.query.order) { where.push('c.order_id = ?'); params.push(Number(req.query.order)); }
    if (req.query.status) { where.push('c.status = ?'); params.push(String(req.query.status)); }
    if (req.query.handle) { where.push('j.instagram_handle = ?'); params.push(normalizeHandle(req.query.handle)); }
    const [rows] = await pool.query(
      `SELECT c.id, c.joiner_id AS joinerId, c.price_tbc AS priceTbc, c.label, c.status, c.pipeline, c.order_id, go.title AS orderTitle, c.set_id AS setId, (SELECT admin_decision FROM item_sets WHERE id = c.set_id) AS setDecision, c.is_direct, c.is_fixed, c.ready_to_pack_date, c.received_date, j.instagram_handle AS handle
         FROM claims c JOIN joiners j ON j.id = c.joiner_id LEFT JOIN group_orders go ON go.id = c.order_id WHERE ${where.join(' AND ')} ORDER BY j.instagram_handle, c.id LIMIT ${maxList() + 1}`, params);
    const truncated = rows.length > maxList(); if (truncated) rows.length = maxList();          // the screen says so, so nothing is ever cut off silently
    const costs = rows.length ? (await pool.query('SELECT claim_id, category, cost, paid, paid_date FROM claim_costs WHERE claim_id IN (?)', [rows.map((r) => r.id)]))[0] : [];
    // What each person owes, has paid, and holds as credit — across ALL their claims, not just the ones this list is showing.
    const who = [...new Set(rows.map((r) => r.joinerId))];
    const [tot] = who.length ? await pool.query(
      `SELECT c.joiner_id AS joinerId, COALESCE(SUM(CASE WHEN c.status = 'confirmed' THEN GREATEST(cc.cost - cc.paid, 0) ELSE 0 END), 0) AS owed, COALESCE(SUM(cc.paid), 0) AS paid
         FROM claims c JOIN claim_costs cc ON cc.claim_id = c.id WHERE c.joiner_id IN (?) AND c.status <> 'cancelled' GROUP BY c.joiner_id`, [who]) : [[]];
    const [cred] = who.length ? await pool.query('SELECT joiner_id AS joinerId, COALESCE(SUM(balance_effect), 0) AS credit FROM credit_ledger WHERE joiner_id IN (?) GROUP BY joiner_id', [who]) : [[]];
    const people = {}, handleOf = new Map();
    for (const r of rows) { people[r.handle] ||= { owed: 0, paid: 0, credit: 0 }; handleOf.set(r.joinerId, r.handle); }
    for (const t of tot) { const h = handleOf.get(t.joinerId); if (h) { people[h].owed = round2(t.owed); people[h].paid = round2(t.paid); } }
    for (const k of cred) { const h = handleOf.get(k.joinerId); if (h) people[h].credit = round2(k.credit); }
    const costsOf = new Map();
    for (const c of costs) { if (!costsOf.has(c.claim_id)) costsOf.set(c.claim_id, {}); costsOf.get(c.claim_id)[c.category] = { cost: c.cost, paid: c.paid, paidDate: c.paid_date }; }
    res.json({
      people, truncated,
      claims: rows.map((r) => ({ ...r, priceTbc: !!r.priceTbc, is_direct: !!r.is_direct, is_fixed: !!r.is_fixed, costs: costsOf.get(r.id) || {} })),
    });
  }));

  // Secure everything still "requested" in a GO (or just the listed claims).
  app.post('/api/admin/claims/secure', requireAdmin, wrap(async (req, res) => {
    const b = z.object({ orderId: z.number().int().positive().optional(), claimIds: z.array(z.number().int().positive()).max(500).optional() })
      .refine((v) => v.orderId || v.claimIds?.length, 'Give an orderId or claimIds').parse(req.body);
    const out = await withTx(pool, async (conn) => {
      return secureClaims(conn, b, req.account.id);
    });
    notifier.claimsSecured(out.ids);
    res.json({ ok: true, secured: out.ids.length, skippedTbc: out.skippedTbc, skippedCancel: out.skippedCancel });
  }));

  // Who exists? (for the "Add a claim" panel: suggestions as you type, and whether the exact handle is already on the site). Prefix match; '_' and '%' are literal characters.
  app.get('/api/admin/joiners/lookup', requireAdmin, wrap(async (req, res) => {
    const q = normalizeHandle(String(req.query.q || ''));
    if (!q) return res.json({ matches: [], exact: false, blocked: false });
    const [rows] = await pool.query("SELECT instagram_handle AS handle, is_blocked AS blocked FROM joiners WHERE instagram_handle LIKE ? ESCAPE '\\\\' ORDER BY (instagram_handle = ?) DESC, instagram_handle LIMIT 15", [`${q.replace(/[\\%_]/g, '\\$&')}%`, q]);
    const me = rows.find((r) => r.handle === q);
    res.json({ matches: rows.map((r) => r.handle), exact: !!me, blocked: !!me?.blocked });
  }));

  // The GOM adds a claim FOR someone: to fill a gap in an import, or to take an order that came by DM (often on a PRIVATE group order). It goes through exactly the
  // same placement as a joiner's own claim (lib/claim-create.js) — same prices, same TBC rule, same set placement — but the GOM may add to a private or a closed order.
  // The status is CHOSEN EVERY TIME (no default): "requested" waits for a Secure like any request; "confirmed" goes through the ordinary secure logic, so what they
  // owe starts and any credit they hold is applied. The person sees it in My orders like any other claim. No email is sent.
  app.post('/api/admin/claims/add', requireAdmin, wrap(async (req, res) => {
    const b = z.object({
      handle: z.string().min(1).max(40), createHandle: z.boolean().optional(), overrideLimit: z.boolean().optional(),          // overrideLimit: go past an item's purchase limit knowingly
      status: z.enum(['requested', 'confirmed']),
      pipeline: z.enum(BULK_STAGES).optional(),
      lines: z.array(z.object({
        itemId: z.number().int().positive(), qty: z.number().int().min(1).max(20).optional(),
        member: z.string().max(80).optional(), variant: z.string().max(40).optional(),
        parts: z.array(z.object({ member: z.string().max(80), qty: z.number().int().min(1).max(20) })).max(40).optional(), together: z.boolean().optional(),
      })).min(1).max(30),
    }).parse(req.body);
    const handle = normalizeHandle(b.handle);
    if (!isValidHandle(handle)) throw bad('Instagram handles use letters, numbers, full stops and underscores (up to 30 characters).');
    if (b.pipeline && b.status !== 'confirmed') throw bad('A stage only makes sense for a confirmed claim.', 'stage_needs_confirmed');
    const out = await withTx(pool, async (conn) => {
      await lockLineItems(conn, b.lines);                                                  // items first, then the person — the same order every other flow uses
      const [[existing]] = await conn.query('SELECT id, is_blocked FROM joiners WHERE instagram_handle = ?', [handle]);
      if (existing?.is_blocked) throw conflict(`@${handle} is blocked — unblock them on the People tab first.`, 'handle_blocked');
      if (!existing && !b.createHandle) throw bad(`There's no @${handle} on the site yet — tick “New person” to create them.`, 'unknown_handle');
      let joinerId = existing?.id;
      if (!existing) joinerId = (await conn.query('INSERT INTO joiners (instagram_handle) VALUES (?)', [handle]))[0].insertId;
      await lockJoiner(conn, joinerId);
      const ids = [], placements = [];
      for (const line of b.lines) { const r = await placeItemLine(conn, { joinerId, line, asAdmin: true, overrideLimit: !!b.overrideLimit }); ids.push(...r.ids); placements.push(...r.placements); }
      let confirmed = [], skippedTbc = 0;
      if (b.status === 'confirmed') {
        const sec = await secureClaims(conn, { claimIds: ids }, req.account.id);
        confirmed = sec.ids; skippedTbc = sec.skippedTbc;
        if (b.pipeline && confirmed.length) {
          await conn.query(`UPDATE claims SET pipeline = ?${b.pipeline === READY ? ', ready_to_pack_date = COALESCE(ready_to_pack_date, CURDATE())' : ''} WHERE id IN (?)`, [b.pipeline, confirmed]);
        }
      }
      await audit(conn, req.account.id, 'claims.add', 'joiner', joinerId, { count: ids.length, status: b.status, confirmed: confirmed.length, newHandle: !existing, stage: b.pipeline || null });
      return { ids, placements, confirmed, skippedTbc, newHandle: !existing };
    });
    res.status(201).json({ ok: true, handle, newHandle: out.newHandle, claimIds: out.ids, confirmed: out.confirmed.length, leftAsRequests: out.ids.length - out.confirmed.length, skippedTbc: out.skippedTbc,
      placements: out.placements.map(({ claimId, member, setNumber, label, price }) => ({ claimId, member, setNumber, label, price })) });
  }));

  // Edit one claim: cost lines, pipeline stage, size, or cancel it.
  app.patch('/api/admin/claims/:id', requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const line = z.object({ cost: z.number().min(0).max(100000).optional(), paid: z.number().min(0).max(100000).optional() });
    const b = z.object({
      costs: z.object(Object.fromEntries(CATS.map((c) => [c, line.optional()]))).partial().optional(),
      pipeline: z.enum(PIPELINE).optional(), status: z.enum(['confirmed', 'cancelled']).optional(),
      sizeBucket: z.enum(['XS', 'S', 'M', 'L', 'XL']).optional(), weightG: z.number().int().min(1).max(100000).nullable().optional(), storageDeadlineOverride: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    }).parse(req.body);
    await withTx(pool, async (conn) => {
      const [[c]] = await conn.query('SELECT id, joiner_id, pipeline, ready_to_pack_date, set_id, price_tbc FROM claims WHERE id = ?', [id]);
      if (!c) throw notFound('No such claim');
      if (b.status === 'confirmed' && (await conn.query("SELECT 1 FROM cancel_requests WHERE claim_id = ? AND status = 'pending' LIMIT 1", [id]))[0].length) throw conflict('The person has asked to cancel that claim — answer the request first (top of the Claims tab).', 'cancel_pending');
      if (b.status === 'confirmed' && c.price_tbc) throw conflict("That claim's price is still TBC — set the item's price first, then secure it.", 'price_tbc');
      if (b.status === 'confirmed' && c.set_id && (await conn.query("SELECT admin_decision FROM item_sets WHERE id = ?", [c.set_id]))[0][0]?.admin_decision !== 'secured') throw bad('That claim is part of a member set — secure the whole set instead.', 'set_part');
      for (const [cat, v] of Object.entries(b.costs || {})) if (v) await setCost(conn, id, cat, v);
      const set = []; const vals = [];
      if (b.pipeline) {
        set.push('pipeline = ?'); vals.push(b.pipeline);
        // the storage clock starts the first time it's ready to pack
        if (b.pipeline === READY && !c.ready_to_pack_date) set.push('ready_to_pack_date = CURDATE()');
        if (b.pipeline === 'completed') set.push('received_date = COALESCE(received_date, CURDATE())');
      }
      if (b.status === 'confirmed') { set.push('status = ?'); vals.push('confirmed'); }
      if (b.sizeBucket) { set.push('size_bucket = ?'); vals.push(b.sizeBucket); }
      if (b.weightG !== undefined) { set.push('weight_g = ?'); vals.push(b.weightG); }
      if (b.storageDeadlineOverride !== undefined) { set.push('storage_deadline_override = ?'); vals.push(b.storageDeadlineOverride); }
      if (set.length) await conn.query(`UPDATE claims SET ${set.join(', ')} WHERE id = ?`, [...vals, id]);
      if (b.status === 'confirmed') { await lockJoiner(conn, c.joiner_id); await sweepCredit(conn, c.joiner_id); }
      if (b.status === 'cancelled') await cancelClaim(conn, id, 'Cancelled by the GOM');
      await audit(conn, req.account.id, 'claim.update', 'claim', id, b);
    });
    res.json({ ok: true });
  }));

  // Move claims to another person (e.g. old claims imported under the wrong handle). dryRun reports what would happen and changes nothing.
  app.post('/api/admin/claims/move', requireAdmin, wrap(async (req, res) => {
    const b = z.object({ claimIds: z.array(z.number().int().positive()).min(1).max(500), handle: z.string().min(1).max(60), create: z.boolean().optional(), dryRun: z.boolean().optional() }).parse(req.body);
    const handle = normalizeHandle(b.handle);
    if (!isValidHandle(handle)) throw bad("That isn't a valid Instagram handle — use letters, numbers, dots and underscores, up to 30.", 'bad_handle');
    const out = await withTx(pool, (conn) => moveClaims(conn, { claimIds: b.claimIds, handle, create: !!b.create, dryRun: !!b.dryRun, accountId: req.account.id }));
    res.json({ ok: true, dryRun: !!b.dryRun, ...out });
  }));

  // Move many claims to a new stage in one go (e.g. a whole order to "ordered via proxy"). Safer than changing them one at a time: it only
  // touches confirmed claims, and leaves alone anything whose stage is driven by another screen (boxes, packing), saying so for each one.

  app.post('/api/admin/claims/pipeline', requireAdmin, wrap(async (req, res) => {
    const b = z.object({ claimIds: z.array(z.number().int().positive()).min(1).max(500), pipeline: z.enum(BULK_STAGES) }).parse(req.body);
    const ids = [...new Set(b.claimIds)].sort((x, y) => x - y);
    const out = await withTx(pool, async (conn) => {
      const [rows] = await conn.query('SELECT id, label, status, pipeline, ready_to_pack_date, box_id FROM claims WHERE id IN (?) ORDER BY id FOR UPDATE', [ids]);
      const boxIds = [...new Set(rows.map((r) => r.box_id).filter(Boolean))];
      const [boxes] = boxIds.length ? await conn.query('SELECT id, status FROM boxes WHERE id IN (?)', [boxIds]) : [[]];
      const [inParcel] = rows.length ? await conn.query("SELECT DISTINCT pi.claim_id AS id FROM parcel_items pi JOIN parcels p ON p.id = pi.parcel_id WHERE pi.claim_id IN (?) AND p.status IN ('requested', 'packed', 'shipped')", [rows.map((r) => r.id)]) : [[]];
      const parcelled = new Set(inParcel.map((r) => r.id)), boxStatus = Object.fromEntries(boxes.map((x) => [x.id, x.status]));
      const skipped = [], move = []; let unchanged = 0;
      for (const id of ids) {
        const r = rows.find((x) => x.id === id);
        if (!r) { skipped.push({ claimId: id, label: `#${id}`, reason: 'no such claim' }); continue; }
        if (r.status !== 'confirmed') skipped.push({ claimId: id, label: r.label, reason: r.status === 'cancelled' ? 'it is cancelled' : "it isn't confirmed yet" });
        else if (parcelled.has(id)) skipped.push({ claimId: id, label: r.label, reason: "it is in a parcel that hasn't been received — use the Packing tab" });
        else if (r.box_id && ['shipping_requested', 'enroute'].includes(boxStatus[r.box_id])) skipped.push({ claimId: id, label: r.label, reason: "it is in a box that hasn't arrived yet — use the Warehouse tab" });
        else if (r.pipeline === b.pipeline) unchanged += 1;
        else move.push(r);
      }
      if (move.length) {
        await conn.query(`UPDATE claims SET pipeline = ?${b.pipeline === READY ? ', ready_to_pack_date = COALESCE(ready_to_pack_date, CURDATE())' : ''} WHERE id IN (?)`, [b.pipeline, move.map((r) => r.id)]);
        // a claim that came in a box keeps the box's own checklist in step
        const itemStatus = b.pipeline === READY ? 'ready' : b.pipeline === 'checking parcel' ? 'checking' : null;
        if (itemStatus) await conn.query("UPDATE box_items SET item_status = ? WHERE claim_id IN (?) AND box_id IN (SELECT id FROM boxes WHERE status = 'arrived')", [itemStatus, move.map((r) => r.id)]);
      }
      await audit(conn, req.account.id, 'claims.pipeline', 'claims', null, { pipeline: b.pipeline, changed: move.length, skipped: skipped.length });
      return { changed: move.length, unchanged, skipped };
    });
    res.json({ ok: true, ...out });
  }));

  // Cancel several claims at once (e.g. every claim in a set that won't proceed).
  // Paid money returns to each joiner as credit — except blocked handles, whose payments are recorded as forfeited.
  app.post('/api/admin/claims/cancel', requireAdmin, wrap(async (req, res) => {
    const b = z.object({ claimIds: z.array(z.number().int().positive()).min(1).max(500), reason: z.string().trim().max(200).optional() }).parse(req.body);
    const out = await withTx(pool, async (conn) => {
      // people in a fixed order, then their claims, so concurrent cancels can never wait on each other in a circle
      const [rows] = await conn.query('SELECT id FROM claims WHERE id IN (?) ORDER BY joiner_id, id', [b.claimIds]);
      const results = [];
      for (const r of rows) results.push(await cancelClaim(conn, r.id, b.reason || 'Claim cancelled'));
      await audit(conn, req.account.id, 'claims.cancel', 'claim', null, { count: results.filter((x) => x.cancelled).length });
      return results;
    });
    res.json({
      ok: true, cancelled: out.filter((x) => x.cancelled).length,
      refunded: round2(out.reduce((s, x) => s + x.refunded, 0)), forfeited: round2(out.reduce((s, x) => s + x.forfeited, 0)),
    });
  }));
}
