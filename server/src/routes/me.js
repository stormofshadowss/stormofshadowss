import { NOTIFY_EVENTS, EVENT_KEYS, offSet, offString } from '../lib/notify-events.js';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { wrap } from '../lib/http.js';
import { requireLogin } from '../auth.js';
import { withTx } from '../db.js';
import { shareAddress } from '../lib/address-share.js';
import { bad, conflict, forbidden, notFound, HttpError } from '../errors.js';
import { resolveJoiner } from '../lib/joiner.js';
import { owedInScope, lockJoiner, creditBalance } from '../lib/ledger.js';
import { queuePosition, markParcelReceived } from '../lib/parcels.js';
import { validateShippable, inviteCompanions, acceptCompanion, declineCompanion, withdrawInvitation, leaveParcel } from '../lib/combine.js';
import { feeModeOf } from '../lib/parcels.js';
import { CATS, round2 } from '../lib/money.js';

const READY = 'ready to pack / on hand';
const twoDp = (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

// "@a, @b @c" or ["@a", "@b"] → the handles named
const handlesOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((h) => h.trim()).filter(Boolean);

export function meRoutes(app, { pool }) {
  const auth = [requireLogin];

  // The landing page numbers: what you owe by category, credit, and each GO's claims.
  // A person's handles: all of them, or the one asked for (?handle=@x). ?handle=all means every handle together (read-only views).
  const accountHandles = async (accountId) => (await pool.query('SELECT id, instagram_handle AS handle, is_blocked AS blocked FROM joiners WHERE account_id = ? AND account_deleted_at IS NULL ORDER BY id', [accountId]))[0];
  const scopeOf = async (req) => {
    const all = await accountHandles(req.account.id);
    if (!all.length) throw new HttpError(403, 'Link your Instagram handle first', 'no_handle');
    if (String(req.query.handle || '').trim().toLowerCase() === 'all' && !all.some((h) => h.handle === 'all')) return { all: true, joiners: all };
    return { all: false, joiners: [await resolveJoiner(pool, req)] };
  };

  async function summaryOf(joiner, today) {
    const [claims] = await pool.query(
      `SELECT c.id, c.label, c.status, c.pipeline, c.order_id, c.is_fixed, c.received_date, c.split_share, c.price_tbc,
              go.title AS order_title, COALESCE(c.pay_by, i.payment_deadline, go.payment_deadline) AS pay_by
         FROM claims c LEFT JOIN group_orders go ON go.id = c.order_id LEFT JOIN items i ON i.id = c.item_id
        WHERE c.joiner_id = ? AND c.status <> 'cancelled' ORDER BY c.id`, [joiner.id]);
    const costs = claims.length ? (await pool.query('SELECT claim_id, category, cost, paid, paid_date FROM claim_costs WHERE claim_id IN (?)', [claims.map((c) => c.id)]))[0] : [];
    const asks = claims.length ? (await pool.query('SELECT id, claim_id, status, reason, decision_note, requested_at, decided_at FROM cancel_requests WHERE claim_id IN (?) ORDER BY id', [claims.map((c) => c.id)]))[0] : [];
    const owed = Object.fromEntries(CATS.map((c) => [c, 0]));
    const orders = new Map();
    for (const c of claims) {
      const lines = Object.fromEntries(costs.filter((x) => x.claim_id === c.id).map((x) => [x.category, { cost: x.cost, paid: x.paid, paidDate: x.paid_date }]));
      const claimOwed = c.status === 'confirmed' ? round2(CATS.reduce((s, cat) => s + Math.max(0, (lines[cat]?.cost || 0) - (lines[cat]?.paid || 0)), 0)) : 0;
      if (c.status === 'confirmed') for (const cat of CATS) owed[cat] = round2(owed[cat] + Math.max(0, (lines[cat]?.cost || 0) - (lines[cat]?.paid || 0)));
      const key = c.order_id || 0;
      if (!orders.has(key)) orders.set(key, { id: c.order_id, title: c.order_title || 'Shop (on hand)', owed: 0, claims: [] });
      const o = orders.get(key);
      o.owed = round2(o.owed + claimOwed);
      o.claims.push({
        id: c.id, handle: joiner.handle, label: c.label, status: c.status, pipeline: c.pipeline, isFixed: !!c.is_fixed, receivedDate: c.received_date, splitShare: c.split_share, priceTbc: !!c.price_tbc,
        payBy: claimOwed > 0 ? c.pay_by : null, overdue: !!(claimOwed > 0 && c.pay_by && c.pay_by < today), owed: claimOwed, costs: lines,
        cancelRequest: (() => { const last = asks.filter((a) => a.claim_id === c.id).at(-1); return last && ['pending', 'declined'].includes(last.status) ? { id: last.id, status: last.status, reason: last.reason, note: last.decision_note, requestedAt: last.requested_at, decidedAt: last.decided_at } : null; })(),
      });
    }
    return { handle: joiner.handle, owed: { ...owed, total: round2(CATS.reduce((s, c) => s + owed[c], 0)) }, credit: await creditBalance(pool, joiner.id), orders: [...orders.values()] };
  }

  app.get('/api/my/summary', auth, wrap(async (req, res) => {
    const scope = await scopeOf(req);
    const [[{ today }]] = await pool.query('SELECT CURDATE() AS today');
    const parts = []; for (const j of scope.joiners) parts.push(await summaryOf(j, today));
    if (!scope.all) return res.json(parts[0]);
    // every handle together: the totals are the sums, the orders are merged (each claim still says which handle it belongs to), and each handle's own figures are listed
    const owed = Object.fromEntries(CATS.map((c) => [c, round2(parts.reduce((n, p) => n + p.owed[c], 0))]));
    const orders = new Map();
    for (const p of parts) for (const o of p.orders) {
      const key = o.id || 0; if (!orders.has(key)) orders.set(key, { id: o.id, title: o.title, owed: 0, claims: [] });
      const m = orders.get(key); m.owed = round2(m.owed + o.owed); m.claims.push(...o.claims);
    }
    for (const o of orders.values()) o.claims.sort((a, b) => a.id - b.id);
    res.json({ handle: 'all', handles: parts.map((p) => ({ handle: p.handle, owed: p.owed.total, credit: p.credit })), owed: { ...owed, total: round2(CATS.reduce((n, c) => n + owed[c], 0)) },
      credit: round2(parts.reduce((n, p) => n + p.credit, 0)), orders: [...orders.values()] });
  }));

  // ── delivery details ──
  app.get('/api/my/address', auth, wrap(async (req, res) => {
    const joiner = await resolveJoiner(pool, req);
    await withTx(pool, (conn) => shareAddress(conn, req.account.id));                          // a person with several handles has ONE address: bring them into line
    const [[a]] = await pool.query('SELECT full_name AS fullName, address, email, phone, confirmed_at AS confirmedAt FROM addresses WHERE joiner_id = ?', [joiner.id]);
    res.json({ address: a || null });
  }));
  app.put('/api/my/address', auth, wrap(async (req, res) => {
    const b = z.object({ fullName: z.string().trim().min(1).max(120), address: z.string().trim().min(5).max(600), email: z.string().trim().email().max(254), phone: z.string().trim().min(3).max(40) }).parse(req.body);
    const joiner = await resolveJoiner(pool, req);
    await withTx(pool, async (conn) => {
      await conn.query(
        `INSERT INTO addresses (joiner_id, full_name, address, email, phone, confirmed_at) VALUES (?,?,?,?,?, NOW(3))
         ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), address = VALUES(address), email = VALUES(email), phone = VALUES(phone), confirmed_at = NOW(3)`,
        [joiner.id, b.fullName, b.address, b.email, b.phone]);
      await shareAddress(conn, req.account.id);                                                // …and all their handles get it
    });
    res.json({ ok: true });
  }));

  // ── payments ──
  app.post('/api/my/payments', auth, wrap(async (req, res) => {
    const b = z.object({
      orderId: z.number().int().positive().nullable().optional(),
      amount: z.number().positive().max(100000).refine(twoDp, 'At most 2 decimal places'),
      method: z.string().trim().min(1).max(40),
      reference: z.string().trim().max(255).optional(),
      payerChoice: z.enum(['address', 'other']).optional(),
      payerName: z.string().trim().max(120).optional(),
      overpay: z.object({ choice: z.enum(['credit', 'tip']), note: z.string().trim().max(255).optional() }).optional(),
    }).parse(req.body);
    const scope = await scopeOf(req);
    const payers = scope.joiners.filter((j) => !j.blocked);                                  // a blocked handle is not paid for
    if (scope.all && payers.length > 1) return payCombined(req, res, b, payers);
    const joiner = scope.all ? payers[0] : scope.joiners[0];                                    // all handles but one are blocked: the one that isn't
    if (!joiner) throw forbidden("Payments can't be made for your handles right now — please message the GOM.", 'blocked');
    const orderId = b.orderId || null;

    const [methods] = await pool.query('SELECT method FROM payment_methods');
    if (methods.length && !methods.some((m) => m.method === b.method)) throw bad('Choose one of the listed payment methods', 'bad_method');

    const owed = await owedInScope(pool, joiner.id, orderId);
    if (owed <= 0.004) throw bad('Nothing is owing right now', 'nothing_owed');

    // Whose name was it paid under? Their delivery-address name, or someone else's.
    const [[addr]] = await pool.query('SELECT full_name FROM addresses WHERE joiner_id = ?', [joiner.id]);
    const addrName = addr?.full_name?.trim() || null;
    let payerName = null, payerIsAddr = null;
    if (addrName) {
      if ((b.payerChoice || 'address') === 'address') { payerName = addrName; payerIsAddr = true; }
      else {
        if (!b.payerName) throw bad('Type the name the payment was made under.', 'payer_name_required');
        payerName = b.payerName; payerIsAddr = b.payerName.toLowerCase() === addrName.toLowerCase();
      }
    } else if (b.payerName) payerName = b.payerName;
    // The reference can be blank once the payer is named; otherwise something has to identify the payment.
    if (!b.reference && !payerName) throw bad("Add a transaction ID or the payer's name so it can be matched.", 'reference_required');

    // Paying more than is owing: the JOINER decides credit or tip.
    const extra = round2(b.amount - owed);
    if (extra > 0.004 && !b.overpay) throw bad(`You're paying £${extra.toFixed(2)} more than you owe — choose whether that's credit for next time or a tip.`, 'overpay_choice_required');

    // A double-tap or a retry must not record the same payment twice: look for an exact repeat (and wait our turn, so two taps at once can't both slip past the look).
    const out = await withTx(pool, async (conn) => {
      await lockJoiner(conn, joiner.id);
      const [[dup]] = await conn.query(
        `SELECT id, status FROM payments WHERE joiner_id = ? AND batch_key IS NULL AND status NOT IN ('rejected', 'reversed') AND method = ? AND order_id <=> ? AND ABS(amount - ?) < 0.005
            AND ((? IS NOT NULL AND reference = ? AND created_at > NOW() - INTERVAL 7 DAY) OR (reference <=> ? AND payer_name <=> ? AND created_at > NOW() - INTERVAL 2 MINUTE)) ORDER BY id DESC LIMIT 1`,
        [joiner.id, b.method, orderId, b.amount, b.reference || null, b.reference || null, b.reference || null, payerName]);
      if (dup) return { id: dup.id, status: dup.status, extra: 0, duplicate: true };
      const [ins] = await conn.query(
        `INSERT INTO payments (joiner_id, order_id, amount, method, reference, payer_name, payer_is_address_name, address_name_snapshot,
                               overpay_amount, overpay_choice, overpay_note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [joiner.id, orderId, b.amount, b.method, b.reference || null, payerName, payerIsAddr, addrName,
          extra > 0.004 ? extra : null, extra > 0.004 ? b.overpay.choice : null, extra > 0.004 ? (b.overpay.note || null) : null]);
      return { id: ins.insertId, status: 'pending', extra: extra > 0.004 ? extra : 0 };
    });
    res.status(out.duplicate ? 200 : 201).json(out);
  }));

  // ONE payment for all of a person's handles: it is split across the handles in proportion to what each owes (oldest handle first), stored as one row per handle tied together
  // by a batch key — so the GOM verifies it as one payment, and each handle's own books still balance. Any extra over what they owe is an overpayment on the first row,
  // handled the way the person chose (credit is shared across their handles anyway).
  async function payCombined(req, res, b, payers) {
    const orderId = b.orderId || null;
    const [methods] = await pool.query('SELECT method FROM payment_methods');
    if (methods.length && !methods.some((m) => m.method === b.method)) throw bad('Choose one of the listed payment methods', 'bad_method');
    const owes = []; for (const j of payers) owes.push({ j, owed: await owedInScope(pool, j.id, orderId) });
    const total = round2(owes.reduce((n, x) => n + x.owed, 0));
    if (total <= 0.004) throw bad('Nothing is owing right now', 'nothing_owed');
    const [[addr]] = await pool.query('SELECT full_name FROM addresses WHERE joiner_id IN (?) ORDER BY confirmed_at DESC LIMIT 1', [payers.map((p) => p.id)]);
    const addrName = addr?.full_name?.trim() || null;
    let payerName = null, payerIsAddr = null;
    if (addrName) {
      if ((b.payerChoice || 'address') === 'address') { payerName = addrName; payerIsAddr = true; }
      else { if (!b.payerName) throw bad('Type the name the payment was made under.', 'payer_name_required'); payerName = b.payerName; payerIsAddr = b.payerName.toLowerCase() === addrName.toLowerCase(); }
    } else if (b.payerName) payerName = b.payerName;
    if (!b.reference && !payerName) throw bad("Add a transaction ID or the payer's name so it can be matched.", 'reference_required');
    const extra = round2(b.amount - total);
    if (extra > 0.004 && !b.overpay) throw bad(`You're paying £${extra.toFixed(2)} more than you owe — choose whether that's credit for next time or a tip.`, 'overpay_choice_required');
    let remaining = round2(Math.min(b.amount, total)); const parts = [];
    for (const x of owes) { if (x.owed <= 0.004 || remaining <= 0.004) continue; const a = round2(Math.min(x.owed, remaining)); remaining = round2(remaining - a); parts.push({ j: x.j, amount: a }); }
    if (extra > 0.004) parts[0].amount = round2(parts[0].amount + extra);
    const batchKey = randomBytes(8).toString('hex');
    const made = await withTx(pool, async (conn) => {
      await lockJoiner(conn, payers[0].id);                                                   // all their handles are locked together: two taps at once wait their turn
      const [cands] = await conn.query(
        `SELECT batch_key, SUM(amount) AS total FROM payments WHERE joiner_id IN (?) AND batch_key IS NOT NULL AND status NOT IN ('rejected', 'reversed') AND method = ? AND order_id <=> ?
            AND ((? IS NOT NULL AND reference = ? AND created_at > NOW() - INTERVAL 7 DAY) OR (reference <=> ? AND payer_name <=> ? AND created_at > NOW() - INTERVAL 2 MINUTE)) GROUP BY batch_key ORDER BY MAX(id) DESC`,
        [payers.map((p) => p.id), b.method, orderId, b.reference || null, b.reference || null, b.reference || null, payerName]);
      const same = cands.find((c) => Math.abs(Number(c.total) - b.amount) < 0.005);
      if (same) {
        const [rows] = await conn.query('SELECT p.id, p.amount, j.instagram_handle AS handle FROM payments p JOIN joiners j ON j.id = p.joiner_id WHERE p.batch_key = ? ORDER BY p.id', [same.batch_key]);
        return { duplicate: true, batchKey: same.batch_key, ids: rows.map((r) => r.id), split: rows.map((r) => ({ handle: r.handle, amount: Number(r.amount) })) };
      }
      const out = [];
      for (const [i, p] of parts.entries()) {
        const over = i === 0 && extra > 0.004;
        const [ins] = await conn.query(
          `INSERT INTO payments (joiner_id, order_id, amount, method, reference, payer_name, payer_is_address_name, address_name_snapshot, overpay_amount, overpay_choice, overpay_note, batch_key)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [p.j.id, orderId, p.amount, b.method, b.reference || null, payerName, payerIsAddr, addrName, over ? extra : null, over ? b.overpay.choice : null, over ? (b.overpay.note || null) : null, batchKey]);
        out.push(ins.insertId);
      }
      return { ids: out, batchKey, split: parts.map((p) => ({ handle: p.j.handle, amount: p.amount })) };
    });
    res.status(made.duplicate ? 200 : 201).json({ id: made.ids[0], ids: made.ids, batchKey: made.batchKey, status: 'pending', extra: made.duplicate ? 0 : (extra > 0.004 ? extra : 0), split: made.split, ...(made.duplicate ? { duplicate: true } : {}) });
  }

  app.get('/api/my/payments', auth, wrap(async (req, res) => {
    const scope = await scopeOf(req);
    const [rows] = await pool.query(
      `SELECT p.id, jo.instagram_handle AS handle, p.amount, p.method, p.reference, p.payer_name AS payerName, p.status, p.order_id AS orderId, p.created_at AS createdAt, go.title AS orderTitle
         FROM payments p JOIN joiners jo ON jo.id = p.joiner_id LEFT JOIN group_orders go ON go.id = p.order_id WHERE p.joiner_id IN (?) ORDER BY p.id DESC`, [scope.joiners.map((j) => j.id)]);
    res.json({ payments: rows });
  }));

  // ── parcels: request shipping, see the queue, confirm it arrived ──
  app.post('/api/my/parcels', auth, wrap(async (req, res) => {
    const b = z.object({
      claimIds: z.array(z.number().int().positive()).min(1).max(50), method: z.string().trim().min(1).max(60),
      declaredValue: z.enum(['true', 'reduced']).optional(), notes: z.string().trim().max(1000).optional(), bias: z.string().trim().max(80).optional(),
      lomoName: z.string().trim().max(80).optional(), shareWith: z.union([z.string().trim().max(400), z.array(z.string().trim().max(60)).max(4)]).optional(),
      addressConfirmed: z.literal(true, { errorMap: () => ({ message: 'Please confirm your address is still correct' }) }),
    }).parse(req.body);
    if (/^ww\b/i.test(b.method) && !b.declaredValue) throw bad('Choose a declared value for customs', 'declared_value_required');
    // A person's items from ALL their handles can go in one parcel: it is posted as one handle (the one asked for, or — viewing all — the owner of the first item) and their other handles join it automatically.
    const scope = await scopeOf(req), handlesAll = await accountHandles(req.account.id), handleIds = new Set(handlesAll.map((h) => h.id));
    const ids = [...new Set(b.claimIds)];
    const [owned] = await pool.query('SELECT id, joiner_id FROM claims WHERE id IN (?)', [ids]);
    const ownerOf = new Map(owned.map((c) => [c.id, c.joiner_id]));
    if (ids.some((id) => !handleIds.has(ownerOf.get(id)))) throw forbidden("One of those items isn't yours");
    const joiner = scope.all ? handlesAll.find((h) => h.id === ownerOf.get(ids[0])) : scope.joiners[0];
    if (joiner.blocked) throw forbidden("A parcel can't be sent to a blocked handle.", 'blocked');

    const out = await withTx(pool, async (conn) => {
      await lockJoiner(conn, joiner.id);
      await shareAddress(conn, req.account.id);
      const [[addr]] = await conn.query('SELECT joiner_id, full_name FROM addresses WHERE joiner_id = ?', [joiner.id]);
      if (!addr) throw bad('Add your delivery details first', 'address_required');
      // Personalised Lomo: the name they typed; otherwise the name from their delivery details; otherwise none.
      const deliveryName = (addr.full_name || '').trim();
      const lomoName = b.lomoName || deliveryName || null;
      const lomoSource = !lomoName ? null : (!b.lomoName || b.lomoName.toLowerCase() === deliveryName.toLowerCase()) ? 'delivery' : 'custom';
      const byHandle = new Map();                                                                  // the items, grouped by which of their handles owns each
      for (const id of ids) { const j = ownerOf.get(id); if (!byHandle.has(j)) byHandle.set(j, []); byHandle.get(j).push(id); }
      const own = byHandle.get(joiner.id) || [];
      if (own.length) await validateShippable(conn, joiner.id, own);
      await conn.query('UPDATE addresses SET confirmed_at = NOW(3) WHERE joiner_id = ?', [joiner.id]);
      const [ins] = await conn.query('INSERT INTO parcels (joiner_id, method, declared_value, notes, bias, lomo_name, lomo_source) VALUES (?,?,?,?,?,?,?)',
        [joiner.id, b.method, b.declaredValue || null, b.notes || null, b.bias || null, lomoName, lomoSource]);
      for (const id of own) await conn.query('INSERT INTO parcel_items (parcel_id, claim_id) VALUES (?,?)', [ins.insertId, id]);
      // their OTHER handles with items in it join automatically (no invitation to answer): the same mechanism as a friend sharing, with how = 'own'
      for (const [jid, claimIds] of byHandle) {
        if (jid === joiner.id) continue;
        const sib = handlesAll.find((h) => h.id === jid);
        await inviteCompanions(conn, { parcelId: ins.insertId, recipientId: joiner.id, handles: [sib.handle], how: 'own', createdBy: req.account.id });
        await acceptCompanion(conn, { parcelId: ins.insertId, friendId: jid, claimIds, bias: b.bias, lomoName: b.lomoName, notes: b.notes });
        // it is the same person: their Lomo name and bias are the parcel's (the owner's), so there is nothing separate for the GOM to check for this handle
        await conn.query('UPDATE parcel_companions SET bias = NULL, lomo_name = NULL, lomo_source = NULL, notes = NULL WHERE parcel_id = ? AND joiner_id = ?', [ins.insertId, jid]);
      }
      // optionally: share this parcel with a friend (they must say yes before it can be packed)
      const friends = handlesOf(b.shareWith);
      const companions = friends.length ? await inviteCompanions(conn, { parcelId: ins.insertId, recipientId: joiner.id, handles: friends, createdBy: req.account.id }) : [];
      const [[parcel]] = await conn.query('SELECT id, status, requested_at FROM parcels WHERE id = ?', [ins.insertId]);
      return { id: ins.insertId, queuePosition: await queuePosition(conn, parcel), companions: companions.map((c) => ({ handle: c.handle, status: 'invited' })) };
    });
    if (out.companions.length) app.locals.notifier?.companionInvited(out.id);
    res.status(201).json(out);
  }));

  // Your parcels: the ones you asked for AND the ones you share with friends, plus any invitations to share someone else's.
  app.get('/api/my/parcels', auth, wrap(async (req, res) => {
    const scope = await scopeOf(req), mine_ids = new Set(scope.joiners.map((j) => j.id)), idList = [...mine_ids];
    const [parcels] = await pool.query(
      `SELECT p.id, p.joiner_id AS ownerId, jo.instagram_handle AS ownerHandle, p.method, p.status, p.requested_at, p.lomo_name AS ownLomoName, p.lomo_source AS ownLomoSource, p.fee_split,
              p.doms_total AS domsTotal, p.packaging_total AS packagingTotal, p.packed_date AS packedDate, p.shipped_date AS shippedDate, p.received_date AS receivedDate
         FROM parcels p JOIN joiners jo ON jo.id = p.joiner_id
        WHERE p.status <> 'cancelled' AND (p.joiner_id IN (?) OR EXISTS (SELECT 1 FROM parcel_companions pc WHERE pc.parcel_id = p.id AND pc.joiner_id IN (?) AND pc.status = 'accepted')) ORDER BY p.id DESC`, [idList, idList]);
    const ids = parcels.map((p) => p.id);
    const items = ids.length ? (await pool.query(
      'SELECT pi.parcel_id, c.id AS claimId, c.label, c.joiner_id AS ownerId, jc.instagram_handle AS owner, pi.doms_share AS doms, pi.packaging_share AS packaging FROM parcel_items pi JOIN claims c ON c.id = pi.claim_id JOIN joiners jc ON jc.id = c.joiner_id WHERE pi.parcel_id IN (?) ORDER BY c.id', [ids]))[0] : [];
    const comps = ids.length ? (await pool.query(
      'SELECT pc.parcel_id AS parcelId, pc.joiner_id AS joinerId, pc.status, pc.how, pc.lomo_name AS lomoName, pc.lomo_source AS lomoSource, j.instagram_handle AS handle FROM parcel_companions pc JOIN joiners j ON j.id = pc.joiner_id WHERE pc.parcel_id IN (?) ORDER BY pc.id', [ids]))[0] : [];
    for (const p of parcels) {
      const mine = mine_ids.has(p.ownerId), all = items.filter((i) => i.parcel_id === p.id), cs = comps.filter((c) => c.parcelId === p.id);
      p.queuePosition = await queuePosition(pool, p);
      p.items = all.map((i) => ({ claimId: i.claimId, label: i.label, mine: mine_ids.has(i.ownerId), owner: i.owner }));
      p.myDoms = Math.round(all.filter((i) => mine_ids.has(i.ownerId)).reduce((s, i) => s + Number(i.doms), 0) * 100) / 100;
      p.myPackaging = Math.round(all.filter((i) => mine_ids.has(i.ownerId)).reduce((s, i) => s + Number(i.packaging), 0) * 100) / 100;
      p.role = mine ? 'recipient' : 'friend';
      p.recipient = p.ownerHandle;                                                       // whose address it goes to (for tagging in the all-handles view)
      const me = cs.find((c) => mine_ids.has(c.joinerId));
      p.lomoName = mine ? p.ownLomoName : me?.lomoName; p.lomoSource = mine ? p.ownLomoSource : me?.lomoSource;
      // everyone else on the parcel, as seen from here: the recipient sees all their friends (with how each answered); a friend sees the recipient and the other friends who joined
      const people = mine ? cs.filter((c) => !mine_ids.has(c.joinerId)).map((c) => ({ handle: c.handle, status: c.status, how: c.how }))
        : [{ handle: p.ownerHandle, status: 'recipient' }, ...cs.filter((c) => !mine_ids.has(c.joinerId) && c.status === 'accepted').map((c) => ({ handle: c.handle, status: 'accepted', how: c.how }))];
      p.shared = cs.some((c) => !mine_ids.has(c.joinerId)) || !mine ? { active: cs.some((c) => c.status === 'accepted' && !mine_ids.has(c.joinerId)) || !mine, people } : null;
      p.feeSplit = cs.some((c) => c.status === 'accepted') ? feeModeOf(p) : null;
      p.canConfirm = mine;                                  // only the person it is posted to presses "It's arrived" — for everyone in it
      p.requestedAt = p.requested_at;
      for (const k of ['requested_at', 'ownLomoName', 'ownLomoSource', 'fee_split', 'ownerId', 'ownerHandle']) delete p[k];
    }
    // invitations to share someone else's parcel — for every handle linked to this account
    const [invites] = await pool.query(
      `SELECT pc.parcel_id AS parcelId, p.method, p.requested_at AS requestedAt, jr.instagram_handle AS fromHandle, jf.instagram_handle AS forHandle
         FROM parcel_companions pc JOIN parcels p ON p.id = pc.parcel_id JOIN joiners jr ON jr.id = p.joiner_id JOIN joiners jf ON jf.id = pc.joiner_id
        WHERE jf.account_id = ? AND pc.status = 'invited' AND p.status = 'requested' ORDER BY pc.created_at`, [req.account.id]);
    res.json({ parcels, invites });
  }));

  // ── sharing a parcel with friends ──
  app.post('/api/my/parcels/:id/companion/accept', auth, wrap(async (req, res) => {
    const b = z.object({ claimIds: z.array(z.number().int().positive()).min(1, 'Choose at least one of your items to put in the parcel').max(50), bias: z.string().trim().max(80).optional(), lomoName: z.string().trim().max(80).optional(), notes: z.string().trim().max(1000).optional() }).parse(req.body);
    const joiner = await resolveJoiner(pool, req);
    await withTx(pool, (conn) => acceptCompanion(conn, { parcelId: Number(req.params.id), friendId: joiner.id, ...b }));
    res.json({ ok: true });
  }));
  app.post('/api/my/parcels/:id/companion/decline', auth, wrap(async (req, res) => {
    const joiner = await resolveJoiner(pool, req);
    await withTx(pool, (conn) => declineCompanion(conn, { parcelId: Number(req.params.id), friendId: joiner.id }));
    res.json({ ok: true });
  }));
  app.post('/api/my/parcels/:id/companion/leave', auth, wrap(async (req, res) => {
    const joiner = await resolveJoiner(pool, req);
    await withTx(pool, (conn) => leaveParcel(conn, { parcelId: Number(req.params.id), friendId: joiner.id }));
    res.json({ ok: true });
  }));
  // the recipient asks more friends to join (up to the limit), or takes back an invitation nobody has accepted — `friend` says which when there are several
  app.post('/api/my/parcels/:id/companion/invite', auth, wrap(async (req, res) => {
    const b = z.object({ handles: z.union([z.string().trim().max(400), z.array(z.string().trim().max(60)).max(4)]) }).parse(req.body);
    const joiner = await resolveJoiner(pool, req);
    const out = await withTx(pool, (conn) => inviteCompanions(conn, { parcelId: Number(req.params.id), recipientId: joiner.id, handles: handlesOf(b.handles), createdBy: req.account.id }));
    app.locals.notifier?.companionInvited(Number(req.params.id), out.map((o) => o.joinerId));
    res.status(201).json({ ok: true, invited: out.map((o) => o.handle) });
  }));
  app.delete('/api/my/parcels/:id/companion', auth, wrap(async (req, res) => {
    const joiner = await resolveJoiner(pool, req);
    const out = await withTx(pool, (conn) => withdrawInvitation(conn, { parcelId: Number(req.params.id), recipientId: joiner.id, handle: req.query.friend || null }));
    res.json({ ok: true, ...out });
  }));

  // The joiner confirms it arrived: its items become Completed (archived).
  app.post('/api/my/parcels/:id/received', auth, wrap(async (req, res) => {
    const joiner = await resolveJoiner(pool, req);
    await withTx(pool, async (conn) => {
      const [[p]] = await conn.query('SELECT id, status FROM parcels WHERE id = ? AND joiner_id = ? FOR UPDATE', [Number(req.params.id), joiner.id]);
      if (!p) throw notFound('No such parcel');
      if (p.status === 'received') return;
      if (p.status !== 'shipped') throw bad('That parcel hasn\'t been shipped yet', 'not_shipped');
      await markParcelReceived(conn, p.id);
    });
    res.json({ ok: true });
  }));

  // Email notifications are OFF until the person turns them on. One setting per account (all the handles linked to it).
  const eventsOut = (offStr) => { const off = offSet(offStr); return NOTIFY_EVENTS.map((e) => ({ ...e, enabled: !off.has(e.key) })); };
  app.get('/api/my/notifications', auth, wrap(async (req, res) => {
    const [[a]] = await pool.query('SELECT email, notify_email, notify_off FROM accounts WHERE id = ?', [req.account.id]);
    res.json({ enabled: !!a.notify_email, email: a.email, events: eventsOut(a.notify_off) });
  }));
  // `enabled` is the master switch; `events` switches individual kinds of email on/off ({ parcelShipped: false }). Either or both can be sent.
  app.put('/api/my/notifications', auth, wrap(async (req, res) => {
    const b = z.object({ enabled: z.boolean().optional(), events: z.record(z.string(), z.boolean()).optional() }).refine((x) => x.enabled !== undefined || x.events, 'Nothing to change').parse(req.body);
    for (const k of Object.keys(b.events || {})) if (!EVENT_KEYS.includes(k)) throw bad(`Unknown kind of email: ${k}`, 'unknown_event');
    await withTx(pool, async (conn) => {
      const [[a]] = await conn.query('SELECT notify_off FROM accounts WHERE id = ? FOR UPDATE', [req.account.id]);
      const off = offSet(a.notify_off);
      for (const [k, on] of Object.entries(b.events || {})) on ? off.delete(k) : off.add(k);
      await conn.query('UPDATE accounts SET notify_email = COALESCE(?, notify_email), notify_off = ? WHERE id = ?', [b.enabled === undefined ? null : (b.enabled ? 1 : 0), offString(off), req.account.id]);
    });
    const [[a]] = await pool.query('SELECT notify_email, notify_off FROM accounts WHERE id = ?', [req.account.id]);
    res.json({ ok: true, enabled: !!a.notify_email, events: eventsOut(a.notify_off) });
  }));
}
