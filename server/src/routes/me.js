import { NOTIFY_EVENTS, EVENT_KEYS, offSet, offString } from '../lib/notify-events.js';
import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireLogin } from '../auth.js';
import { withTx } from '../db.js';
import { bad, conflict, forbidden, notFound } from '../errors.js';
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
  app.get('/api/my/summary', auth, wrap(async (req, res) => {
    const joiner = await resolveJoiner(pool, req);
    const [[{ today }]] = await pool.query('SELECT CURDATE() AS today');
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
        id: c.id, label: c.label, status: c.status, pipeline: c.pipeline, isFixed: !!c.is_fixed, receivedDate: c.received_date, splitShare: c.split_share, priceTbc: !!c.price_tbc,
        payBy: claimOwed > 0 ? c.pay_by : null, overdue: !!(claimOwed > 0 && c.pay_by && c.pay_by < today), owed: claimOwed, costs: lines,
        cancelRequest: (() => { const last = asks.filter((a) => a.claim_id === c.id).at(-1); return last && ['pending', 'declined'].includes(last.status) ? { id: last.id, status: last.status, reason: last.reason, note: last.decision_note, requestedAt: last.requested_at, decidedAt: last.decided_at } : null; })(),
      });
    }
    res.json({
      handle: joiner.handle,
      owed: { ...owed, total: round2(CATS.reduce((s, c) => s + owed[c], 0)) },
      credit: await creditBalance(pool, joiner.id),
      orders: [...orders.values()],
    });
  }));

  // ── delivery details ──
  app.get('/api/my/address', auth, wrap(async (req, res) => {
    const joiner = await resolveJoiner(pool, req);
    const [[a]] = await pool.query('SELECT full_name AS fullName, address, email, phone, confirmed_at AS confirmedAt FROM addresses WHERE joiner_id = ?', [joiner.id]);
    res.json({ address: a || null });
  }));
  app.put('/api/my/address', auth, wrap(async (req, res) => {
    const b = z.object({ fullName: z.string().trim().min(1).max(120), address: z.string().trim().min(5).max(600), email: z.string().trim().email().max(254), phone: z.string().trim().min(3).max(40) }).parse(req.body);
    const joiner = await resolveJoiner(pool, req);
    await pool.query(
      `INSERT INTO addresses (joiner_id, full_name, address, email, phone, confirmed_at) VALUES (?,?,?,?,?, NOW(3))
       ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), address = VALUES(address), email = VALUES(email), phone = VALUES(phone), confirmed_at = NOW(3)`,
      [joiner.id, b.fullName, b.address, b.email, b.phone]);
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
    const joiner = await resolveJoiner(pool, req);
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

    const [ins] = await pool.query(
      `INSERT INTO payments (joiner_id, order_id, amount, method, reference, payer_name, payer_is_address_name, address_name_snapshot,
                             overpay_amount, overpay_choice, overpay_note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [joiner.id, orderId, b.amount, b.method, b.reference || null, payerName, payerIsAddr, addrName,
        extra > 0.004 ? extra : null, extra > 0.004 ? b.overpay.choice : null, extra > 0.004 ? (b.overpay.note || null) : null]);
    res.status(201).json({ id: ins.insertId, status: 'pending', extra: extra > 0.004 ? extra : 0 });
  }));

  app.get('/api/my/payments', auth, wrap(async (req, res) => {
    const joiner = await resolveJoiner(pool, req);
    const [rows] = await pool.query(
      `SELECT p.id, p.amount, p.method, p.reference, p.payer_name AS payerName, p.status, p.created_at AS createdAt, go.title AS orderTitle
         FROM payments p LEFT JOIN group_orders go ON go.id = p.order_id WHERE p.joiner_id = ? ORDER BY p.id DESC`, [joiner.id]);
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
    const joiner = await resolveJoiner(pool, req);
    const ids = [...new Set(b.claimIds)];

    const out = await withTx(pool, async (conn) => {
      await lockJoiner(conn, joiner.id);
      const [[addr]] = await conn.query('SELECT joiner_id, full_name FROM addresses WHERE joiner_id = ?', [joiner.id]);
      if (!addr) throw bad('Add your delivery details first', 'address_required');
      // Personalised Lomo: the name they typed; otherwise the name from their delivery details; otherwise none.
      const deliveryName = (addr.full_name || '').trim();
      const lomoName = b.lomoName || deliveryName || null;
      const lomoSource = !lomoName ? null : (!b.lomoName || b.lomoName.toLowerCase() === deliveryName.toLowerCase()) ? 'delivery' : 'custom';
      await validateShippable(conn, joiner.id, ids);
      await conn.query('UPDATE addresses SET confirmed_at = NOW(3) WHERE joiner_id = ?', [joiner.id]);
      const [ins] = await conn.query('INSERT INTO parcels (joiner_id, method, declared_value, notes, bias, lomo_name, lomo_source) VALUES (?,?,?,?,?,?,?)',
        [joiner.id, b.method, b.declaredValue || null, b.notes || null, b.bias || null, lomoName, lomoSource]);
      for (const id of ids) await conn.query('INSERT INTO parcel_items (parcel_id, claim_id) VALUES (?,?)', [ins.insertId, id]);
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
    const joiner = await resolveJoiner(pool, req);
    const [parcels] = await pool.query(
      `SELECT p.id, p.joiner_id AS ownerId, jo.instagram_handle AS ownerHandle, p.method, p.status, p.requested_at, p.lomo_name AS ownLomoName, p.lomo_source AS ownLomoSource, p.fee_split,
              p.doms_total AS domsTotal, p.packaging_total AS packagingTotal, p.packed_date AS packedDate, p.shipped_date AS shippedDate, p.received_date AS receivedDate
         FROM parcels p JOIN joiners jo ON jo.id = p.joiner_id
        WHERE p.status <> 'cancelled' AND (p.joiner_id = ? OR EXISTS (SELECT 1 FROM parcel_companions pc WHERE pc.parcel_id = p.id AND pc.joiner_id = ? AND pc.status = 'accepted')) ORDER BY p.id DESC`, [joiner.id, joiner.id]);
    const ids = parcels.map((p) => p.id);
    const items = ids.length ? (await pool.query(
      'SELECT pi.parcel_id, c.id AS claimId, c.label, c.joiner_id AS ownerId, jc.instagram_handle AS owner, pi.doms_share AS doms, pi.packaging_share AS packaging FROM parcel_items pi JOIN claims c ON c.id = pi.claim_id JOIN joiners jc ON jc.id = c.joiner_id WHERE pi.parcel_id IN (?) ORDER BY c.id', [ids]))[0] : [];
    const comps = ids.length ? (await pool.query(
      'SELECT pc.parcel_id AS parcelId, pc.joiner_id AS joinerId, pc.status, pc.how, pc.lomo_name AS lomoName, pc.lomo_source AS lomoSource, j.instagram_handle AS handle FROM parcel_companions pc JOIN joiners j ON j.id = pc.joiner_id WHERE pc.parcel_id IN (?) ORDER BY pc.id', [ids]))[0] : [];
    for (const p of parcels) {
      const mine = p.ownerId === joiner.id, all = items.filter((i) => i.parcel_id === p.id), cs = comps.filter((c) => c.parcelId === p.id);
      p.queuePosition = await queuePosition(pool, p);
      p.items = all.map((i) => ({ claimId: i.claimId, label: i.label, mine: i.ownerId === joiner.id, owner: i.owner }));
      p.myDoms = Math.round(all.filter((i) => i.ownerId === joiner.id).reduce((s, i) => s + Number(i.doms), 0) * 100) / 100;
      p.myPackaging = Math.round(all.filter((i) => i.ownerId === joiner.id).reduce((s, i) => s + Number(i.packaging), 0) * 100) / 100;
      p.role = mine ? 'recipient' : 'friend';
      const me = cs.find((c) => c.joinerId === joiner.id);
      p.lomoName = mine ? p.ownLomoName : me?.lomoName; p.lomoSource = mine ? p.ownLomoSource : me?.lomoSource;
      // everyone else on the parcel, as seen from here: the recipient sees all their friends (with how each answered); a friend sees the recipient and the other friends who joined
      const people = mine ? cs.map((c) => ({ handle: c.handle, status: c.status, how: c.how }))
        : [{ handle: p.ownerHandle, status: 'recipient' }, ...cs.filter((c) => c.joinerId !== joiner.id && c.status === 'accepted').map((c) => ({ handle: c.handle, status: 'accepted', how: c.how }))];
      p.shared = cs.length ? { active: cs.some((c) => c.status === 'accepted'), people } : null;
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
