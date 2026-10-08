import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { bad, conflict, notFound } from '../errors.js';
import { distribute, lockJoiner, recordOverpayment, sweepCredit, creditBalance, addLedger } from '../lib/ledger.js';
import { applyFee, removeFees, markParcelReceived, queuePosition, personWeights, resplitFees, feeModeOf } from '../lib/parcels.js';
import { combineParcels, uncombineParcel, withdrawInvitation, feesSet, MAX_PEOPLE } from '../lib/combine.js';
import { normalizeHandle, isValidHandle } from '../lib/handles.js';
import { round2 } from '../lib/money.js';
import { storageCase } from '../lib/storage.js';

export function adminRoutes(app, { pool, notifier }) {
  const admin = [requireAdmin];

  // ── payments ──
  app.get('/api/admin/payments', admin, wrap(async (req, res) => {
    const status = ['pending', 'confirmed', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const [rows] = await pool.query(
      `SELECT p.id, j.instagram_handle AS handle, go.title AS orderTitle, p.amount, p.method, p.reference, p.payer_name AS payerName,
              p.payer_is_address_name AS payerIsAddressName, p.address_name_snapshot AS addressName,
              p.overpay_amount AS overpayAmount, p.overpay_choice AS overpayChoice, p.overpay_note AS overpayNote, p.status, p.created_at AS createdAt
         FROM payments p JOIN joiners j ON j.id = p.joiner_id LEFT JOIN group_orders go ON go.id = p.order_id
        ${status ? 'WHERE p.status = ?' : ''} ORDER BY p.id DESC LIMIT 500`, status ? [status] : []);
    res.json({ payments: rows.map((r) => ({ ...r, payerIsAddressName: r.payerIsAddressName === null ? null : !!r.payerIsAddressName })) });
  }));

  // Verifying splits the payment across whatever's owing (no category needed),
  // records exactly which lines it settled, and handles any extra the way the
  // JOINER said when they paid. Then any credit they hold is applied.
  app.post('/api/admin/payments/:id/verify', admin, wrap(async (req, res) => {
    const out = await withTx(pool, async (conn) => {
      const id = Number(req.params.id);
      const [[who]] = await conn.query('SELECT joiner_id FROM payments WHERE id = ?', [id]);
      if (!who) throw notFound('No such payment');
      await lockJoiner(conn, who.joiner_id);                    // person first, then the payment
      const [[p]] = await conn.query('SELECT * FROM payments WHERE id = ? FOR UPDATE', [id]);
      if (p.status !== 'pending') throw conflict('That payment has already been dealt with', 'not_pending');
      await conn.query("UPDATE payments SET status = 'confirmed', verified_at = NOW(3), verified_by = ? WHERE id = ?", [req.account.id, p.id]);
      const leftover = await distribute(conn, p.joiner_id, p.order_id, p.amount, p.id);
      if (leftover > 0.004) {
        await recordOverpayment(conn, { joinerId: p.joiner_id, amount: leftover, choice: p.overpay_choice, note: p.overpay_note, source: 'Payment verification overpayment', paymentId: p.id });
      }
      const spent = await sweepCredit(conn, p.joiner_id);
      await audit(conn, req.account.id, 'payment.verify', 'payment', p.id, { leftover });
      return { applied: round2(p.amount - leftover), leftover, creditApplied: spent, creditBalance: await creditBalance(conn, p.joiner_id) };
    });
    notifier.paymentDecided(Number(req.params.id));          // after it's saved; never holds up or breaks the response
    res.json({ ok: true, ...out });
  }));

  app.post('/api/admin/payments/:id/reject', admin, wrap(async (req, res) => {
    const [r] = await pool.query("UPDATE payments SET status = 'rejected', verified_at = NOW(3), verified_by = ? WHERE id = ? AND status = 'pending'", [req.account.id, Number(req.params.id)]);
    if (r.affectedRows !== 1) throw conflict('That payment has already been dealt with', 'not_pending');
    notifier.paymentDecided(Number(req.params.id));
    res.json({ ok: true });
  }));

  // ── credit ──
  app.get('/api/admin/ledger', admin, wrap(async (req, res) => {
    const handle = normalizeHandle(req.query.handle || '');
    const [rows] = await pool.query(
      `SELECT l.id, j.instagram_handle AS handle, l.kind, l.amount, l.balance_effect AS balanceEffect, l.reason, l.source, l.created_at AS createdAt
         FROM credit_ledger l JOIN joiners j ON j.id = l.joiner_id ${handle ? 'WHERE j.instagram_handle = ?' : ''} ORDER BY l.id DESC LIMIT 500`, handle ? [handle] : []);
    const [[tips]] = await pool.query("SELECT COALESCE(SUM(amount),0) AS total FROM credit_ledger WHERE kind = 'tip'");
    res.json({ entries: rows, tipsTotal: round2(tips.total) });
  }));

  app.post('/api/admin/credit/remove', admin, wrap(async (req, res) => {
    const b = z.object({ handle: z.string().min(1), amount: z.number().positive().max(100000), reason: z.string().trim().max(255).optional() }).parse(req.body);
    await withTx(pool, async (conn) => {
      const [[j]] = await conn.query('SELECT id FROM joiners WHERE instagram_handle = ?', [normalizeHandle(b.handle)]);
      if (!j) throw notFound('No such handle');
      await lockJoiner(conn, j.id);
      const balance = await creditBalance(conn, j.id);
      if (b.amount > balance + 0.004) throw bad(`They only have £${balance.toFixed(2)} unspent — credit already applied to costs can't be removed.`, 'credit_already_spent');
      await addLedger(conn, { joinerId: j.id, kind: 'removed', amount: b.amount, effect: -b.amount, reason: b.reason, source: 'Admin override' });
      await audit(conn, req.account.id, 'credit.remove', 'joiner', j.id, b);
    });
    res.json({ ok: true });
  }));

  // Turn unspent credit into a tip — only the GOM can, and only when the person has asked. Two rows keep the books honest: the credit
  // leaves their balance, and the same amount is recorded as a tip (which never touches a balance).
  app.post('/api/admin/credit/tip', admin, wrap(async (req, res) => {
    const b = z.object({
      handle: z.string().min(1), reason: z.string().trim().max(255).optional(),
      amount: z.number().positive().max(100000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At most 2 decimal places'),
    }).parse(req.body);
    await withTx(pool, async (conn) => {
      const [[j]] = await conn.query('SELECT id FROM joiners WHERE instagram_handle = ?', [normalizeHandle(b.handle)]);
      if (!j) throw notFound('No such handle');
      await lockJoiner(conn, j.id);
      const balance = await creditBalance(conn, j.id);
      if (b.amount > balance + 0.004) throw bad(`They only have £${balance.toFixed(2)} unspent credit, so £${b.amount.toFixed(2)} can't be turned into a tip.`, 'not_enough_credit');
      const reason = b.reason || 'Converted to a tip at their request';
      await addLedger(conn, { joinerId: j.id, kind: 'removed', amount: b.amount, effect: -b.amount, reason, source: 'Converted to tip' });
      await addLedger(conn, { joinerId: j.id, kind: 'tip', amount: b.amount, effect: 0, reason, source: 'Converted from credit' });
      await audit(conn, req.account.id, 'credit.tip', 'joiner', j.id, b);
    });
    res.json({ ok: true });
  }));

  // ── packing queue ──
  app.get('/api/admin/packing', admin, wrap(async (req, res) => {
    const status = ['requested', 'packed', 'shipped', 'received'].includes(req.query.status) ? req.query.status : 'requested';
    const [parcels] = await pool.query(
      `SELECT p.id, p.joiner_id AS joinerId, j.instagram_handle AS handle, (j.verified_at IS NOT NULL) AS handleVerified, p.method, p.declared_value AS declaredValue, p.notes, p.bias, p.lomo_name AS lomoName, p.lomo_source AS lomoSource, p.status,
              p.requested_at, p.doms_total AS domsTotal, p.packaging_total AS packagingTotal, p.packed_date AS packedDate, p.shipped_date AS shippedDate, p.received_date AS receivedDate,
              p.address_checked_at AS addressCheckedAt, p.lomo_checked_at AS lomoCheckedAt, p.bias_checked_at AS biasCheckedAt, p.fee_split AS feeSplitSetting, p.weight_g AS weightG,
              ad.full_name AS deliveryName, ad.address AS deliveryAddress, ad.phone AS deliveryPhone, ad.email AS deliveryEmail
         FROM parcels p JOIN joiners j ON j.id = p.joiner_id LEFT JOIN addresses ad ON ad.joiner_id = j.id
        WHERE p.status = ? ORDER BY p.requested_at, p.id`, [status]);
    const ids = parcels.map((p) => p.id);
    const items = ids.length ? (await pool.query(
      'SELECT pi.parcel_id, c.id AS claimId, c.joiner_id AS ownerId, c.label, pi.packed_at AS packedAt, jc.instagram_handle AS owner, pi.doms_share AS doms, pi.packaging_share AS packaging FROM parcel_items pi JOIN claims c ON c.id = pi.claim_id JOIN joiners jc ON jc.id = c.joiner_id WHERE pi.parcel_id IN (?) ORDER BY c.id', [ids]))[0] : [];
    const comps = ids.length ? (await pool.query(
      `SELECT pc.parcel_id, pc.joiner_id AS joinerId, pc.status, pc.how, pc.bias, pc.lomo_name AS lomoName, pc.lomo_source AS lomoSource, pc.notes, pc.lomo_checked_at AS lomoChecked, pc.bias_checked_at AS biasChecked, pc.weight_g AS weightG, jf.instagram_handle AS handle
         FROM parcel_companions pc JOIN joiners jf ON jf.id = pc.joiner_id WHERE pc.parcel_id IN (?) ORDER BY pc.id`, [ids]))[0] : [];
    for (const p of parcels) {
      p.handleVerified = !!p.handleVerified;
      p.queuePosition = await queuePosition(pool, p);
      const mine = items.filter((i) => i.parcel_id === p.id);
      p.items = mine.map((i) => ({ claimId: i.claimId, label: i.label, packed: !!i.packedAt, owner: i.owner }));
      p.addressChecked = !!p.addressCheckedAt; p.lomoChecked = !!p.lomoCheckedAt; p.biasChecked = !!p.biasCheckedAt;
      p.feesSet = feesSet({ doms_total: p.domsTotal, packaging_total: p.packagingTotal });
      p.companions = comps.filter((c) => c.parcel_id === p.id).map((c) => ({ handle: c.handle, status: c.status, how: c.how, bias: c.bias, lomoName: c.lomoName, lomoSource: c.lomoSource, notes: c.notes, lomoChecked: !!c.lomoChecked, biasChecked: !!c.biasChecked }));
      p.maxPeople = MAX_PEOPLE;
      // who is in it, what each person's things weigh, and what each owes of the fees — so the GOM can see how the split works out
      const live = p.companions.filter((c) => c.status === 'accepted');
      if (live.length) {
        const w = await personWeights(pool, p.id);
        const who = [{ handle: p.handle, role: 'recipient', joinerId: p.joinerId, explicit: p.weightG }, ...comps.filter((c) => c.parcel_id === p.id && c.status === 'accepted').map((c) => ({ handle: c.handle, role: 'friend', joinerId: c.joinerId, explicit: c.weightG }))];
        p.people = who.map((x) => ({ handle: x.handle, role: x.role, items: mine.filter((i) => i.ownerId === x.joinerId).length, weightG: x.explicit ?? null, estimatedG: w.get(x.joinerId)?.estimated ?? 0, usedG: w.get(x.joinerId)?.used ?? 0,
          doms: Math.round(mine.filter((i) => i.ownerId === x.joinerId).reduce((s, i) => s + Number(i.doms), 0) * 100) / 100, packaging: Math.round(mine.filter((i) => i.ownerId === x.joinerId).reduce((s, i) => s + Number(i.packaging), 0) * 100) / 100 }));
        p.feeSplit = { mode: feeModeOf({ fee_split: p.feeSplitSetting, method: p.method }), auto: !p.feeSplitSetting };
      } else { p.people = []; p.feeSplit = null; }
      for (const k of ['feeSplitSetting', 'weightG', 'joinerId']) delete p[k];
      p.requestedAt = p.requested_at; delete p.requested_at;
      delete p.addressCheckedAt; delete p.lomoCheckedAt; delete p.biasCheckedAt;
    }
    res.json({ parcels });
  }));

  const parcelAction = (name, from, apply) => app.post(`/api/admin/parcels/:id/${name}`, admin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[p]] = await conn.query('SELECT id, status FROM parcels WHERE id = ? FOR UPDATE', [id]);
      if (!p) throw notFound('No such parcel');
      if (!from.includes(p.status)) throw conflict(`That parcel is ${p.status}, so it can't be marked ${name}`, 'bad_state');
      await apply(conn, id, req);
      await audit(conn, req.account.id, `parcel.${name}`, 'parcel', id);
    });
    if (name === 'shipped') notifier.parcelShipped(id);
    res.json({ ok: true });
  }));
  // A parcel can only be marked packed once everything that applies is ticked off: every item, the address, and the
  // Lomo name / bias name when the parcel has them.
  async function requireChecklist(conn, id) {
    const [[p]] = await conn.query('SELECT lomo_name, bias, address_checked_at, lomo_checked_at, bias_checked_at FROM parcels WHERE id = ?', [id]);
    const [[t]] = await conn.query('SELECT COUNT(*) AS total, COALESCE(SUM(packed_at IS NOT NULL), 0) AS ticked FROM parcel_items WHERE parcel_id = ?', [id]);
    const missing = [];
    if (t.ticked < t.total) missing.push(`${t.total - t.ticked} item${t.total - t.ticked === 1 ? '' : 's'}`);
    if (!p.address_checked_at) missing.push('the delivery address');
    if (p.lomo_name && !p.lomo_checked_at) missing.push('the Lomo name');
    if (p.bias && !p.bias_checked_at) missing.push('the bias name');
    const [cs] = await conn.query('SELECT pc.status, pc.bias, pc.lomo_name, pc.lomo_checked_at, pc.bias_checked_at, j.instagram_handle AS handle FROM parcel_companions pc JOIN joiners j ON j.id = pc.joiner_id WHERE pc.parcel_id = ? ORDER BY pc.id', [id]);
    const waiting = cs.filter((c) => c.status === 'invited');
    if (waiting.length) throw conflict(`${waiting.map((c) => `@${c.handle}`).join(', ')} ${waiting.length === 1 ? "hasn't" : "haven't"} answered the invitation to share this parcel yet — wait for ${waiting.length === 1 ? 'them' : 'them'}, or remove the invitation${waiting.length === 1 ? '' : 's'}.`, 'companion_pending');
    for (const c of cs.filter((x) => x.status === 'accepted')) {
      if (c.lomo_name && !c.lomo_checked_at) missing.push(`the Lomo name for @${c.handle}`);
      if (c.bias && !c.bias_checked_at) missing.push(`the bias name for @${c.handle}`);
    }
    if (missing.length) throw conflict(`Not everything is ticked off yet: ${missing.join(', ')}.`, 'checklist_incomplete');
  }
  const setStage = (status, dateCol, pipeline) => async (conn, id) => {
    await conn.query(`UPDATE parcels SET status = ?, ${dateCol} = CURDATE() WHERE id = ?`, [status, id]);
    await conn.query('UPDATE claims SET pipeline = ? WHERE id IN (SELECT claim_id FROM parcel_items WHERE parcel_id = ?)', [pipeline, id]);
  };
  parcelAction('packed', ['requested'], async (conn, id) => { await requireChecklist(conn, id); await setStage('packed', 'packed_date', 'packed')(conn, id); });
  parcelAction('shipped', ['packed'], setStage('shipped', 'shipped_date', 'shipped'));
  parcelAction('received', ['shipped'], (conn, id) => markParcelReceived(conn, id)); // on the joiner's behalf
  parcelAction('cancel', ['requested'], async (conn, id) => {
    await removeFees(conn, id);
    await conn.query("UPDATE parcels SET status = 'cancelled' WHERE id = ?", [id]);
  });

  // ── combined shipping: two friends' items in one parcel, to one address ──
  // Which other parcels in the queue could be folded into this one (same postage method and customs value, someone else's, nothing shared, no fees yet).
  app.get('/api/admin/parcels/:id/combine-candidates', admin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const [[p]] = await pool.query('SELECT id, joiner_id, method, declared_value, status, doms_total, packaging_total FROM parcels WHERE id = ?', [id]);
    if (!p) throw notFound('No such parcel');
    const [rows] = await pool.query(
      `SELECT o.id, j.instagram_handle AS handle, o.method, o.requested_at AS requestedAt,
              (SELECT GROUP_CONCAT(c.label ORDER BY c.id SEPARATOR ' | ') FROM parcel_items pi JOIN claims c ON c.id = pi.claim_id WHERE pi.parcel_id = o.id) AS labels
         FROM parcels o JOIN joiners j ON j.id = o.joiner_id
        WHERE o.status = 'requested' AND o.id <> ? AND o.joiner_id <> ? AND LOWER(o.method) = LOWER(?) AND o.declared_value <=> ? AND COALESCE(o.doms_total, 0) = 0 AND COALESCE(o.packaging_total, 0) = 0
          AND NOT EXISTS (SELECT 1 FROM parcel_companions pc WHERE pc.parcel_id = o.id)
          AND o.joiner_id NOT IN (SELECT joiner_id FROM parcel_companions WHERE parcel_id = ?) ORDER BY o.requested_at, o.id`, [id, p.joiner_id, p.method, p.declared_value, id]);
    const [[people]] = await pool.query("SELECT 1 + COUNT(*) AS n FROM parcel_companions WHERE parcel_id = ? AND status <> 'declined'", [id]);
    const eligible = p.status === 'requested' && !feesSet(p) && people.n < MAX_PEOPLE;
    res.json({ eligible, candidates: eligible ? rows.map((r) => ({ id: r.id, handle: r.handle, method: r.method, requestedAt: r.requestedAt, items: (r.labels || '').split(' | ').filter(Boolean) })) : [] });
  }));
  app.post('/api/admin/parcels/:id/combine', admin, wrap(async (req, res) => {
    const b = z.object({ withParcelId: z.number().int().positive(), confirmed: z.literal(true, { errorMap: () => ({ message: "Please confirm that you've checked this with both people" }) }) }).parse(req.body);
    const out = await withTx(pool, (conn) => combineParcels(conn, { parcelId: Number(req.params.id), withParcelId: b.withParcelId, adminId: req.account.id }));
    res.json({ ok: true, ...out });
  }));
  app.post('/api/admin/parcels/:id/uncombine', admin, wrap(async (req, res) => {
    const b = z.object({ friend: z.string().max(60).optional() }).parse(req.body || {});
    const out = await withTx(pool, (conn) => uncombineParcel(conn, { parcelId: Number(req.params.id), adminId: req.account.id, handle: b.friend || null }));
    res.json({ ok: true, ...out });
  }));
  app.delete('/api/admin/parcels/:id/companion', admin, wrap(async (req, res) => {          // take back an invitation nobody has accepted
    await withTx(pool, async (conn) => { await withdrawInvitation(conn, { parcelId: Number(req.params.id), handle: req.query.friend || null }); await audit(conn, req.account.id, 'parcel.invitation_removed', 'parcel', Number(req.params.id)); });
    res.json({ ok: true });
  }));

  // How a shared parcel's fees are split between its people, and each person's weight. mode: "auto" (by weight for worldwide postage, equally for UK), "equal", or "weight".
  // weights: { handle: grams | null } — what you weighed for that person (blank = estimated from their items). Fees already on the parcel are shared out again.
  app.post('/api/admin/parcels/:id/split', admin, wrap(async (req, res) => {
    const b = z.object({ mode: z.enum(['auto', 'equal', 'weight']).optional(), weights: z.record(z.string().max(60), z.number().int().min(1).max(5_000_000).nullable()).optional() })
      .refine((v) => v.mode !== undefined || (v.weights && Object.keys(v.weights).length), 'Say how to split the fees or give a weight').parse(req.body);
    const id = Number(req.params.id);
    const out = await withTx(pool, async (conn) => {
      const [[p]] = await conn.query('SELECT id, joiner_id, status FROM parcels WHERE id = ? FOR UPDATE', [id]);
      if (!p) throw notFound('No such parcel');
      if (p.status !== 'requested') throw conflict("That parcel has already been packed, so how its fees are split can't change", 'bad_state');
      const [people] = await conn.query("SELECT j.instagram_handle AS handle, j.id AS joinerId FROM joiners j WHERE j.id = ? UNION SELECT j.instagram_handle, j.id FROM parcel_companions pc JOIN joiners j ON j.id = pc.joiner_id WHERE pc.parcel_id = ? AND pc.status = 'accepted'", [p.joiner_id, id]);
      if (b.mode !== undefined) await conn.query('UPDATE parcels SET fee_split = ? WHERE id = ?', [b.mode === 'auto' ? null : b.mode, id]);
      for (const [raw, grams] of Object.entries(b.weights || {})) {
        const who = people.find((x) => x.handle === normalizeHandle(raw));
        if (!who) throw bad(`@${normalizeHandle(raw)} isn't one of the people on this parcel`);
        if (who.joinerId === p.joiner_id) await conn.query('UPDATE parcels SET weight_g = ? WHERE id = ?', [grams, id]);
        else await conn.query('UPDATE parcel_companions SET weight_g = ? WHERE parcel_id = ? AND joiner_id = ?', [grams, id, who.joinerId]);
      }
      await resplitFees(conn, id);
      await audit(conn, req.account.id, 'parcel.split', 'parcel', id, b);
      return { ok: true };
    });
    res.json(out);
  }));

  // Set postage (Doms) and/or the packaging fee for a parcel — typed in by hand each time, before it's marked packed.
  // One request saves both, so a parcel never ends up with half its fees.
  app.post('/api/admin/parcels/:id/fees', admin, wrap(async (req, res) => {
    const fee = z.number().min(0).max(10000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At most 2 decimal places');
    const b = z.object({ doms: fee.optional(), packaging: fee.optional() }).refine((v) => v.doms !== undefined || v.packaging !== undefined, 'Give a postage and/or packaging amount').parse(req.body);
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[p]] = await conn.query('SELECT status FROM parcels WHERE id = ?', [id]);
      if (!p) throw notFound('No such parcel');
      if (p.status !== 'requested') throw conflict('Fees can only be set while the parcel is still in the queue, before it is marked packed', 'bad_state');
      if (b.doms !== undefined) await applyFee(conn, id, 'doms', round2(b.doms));
      if (b.packaging !== undefined) await applyFee(conn, id, 'packaging', round2(b.packaging));
      await audit(conn, req.account.id, 'parcel.fees', 'parcel', id, b);
    });
    res.json({ ok: true });
  }));

  // (older, postage-only form of the same thing)
  app.post('/api/admin/parcels/:id/doms', admin, wrap(async (req, res) => {
    const { total } = z.object({ total: z.number().min(0).max(10000) }).parse(req.body);
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[p]] = await conn.query('SELECT status FROM parcels WHERE id = ?', [id]);
      if (!p) throw notFound('No such parcel');
      if (p.status !== 'requested') throw conflict('Postage can only be set while the parcel is still in the queue', 'bad_state');
      await applyFee(conn, id, 'doms', round2(total));
      await audit(conn, req.account.id, 'parcel.doms', 'parcel', id, { total });
    });
    res.json({ ok: true });
  }));

  // ── blocked ("blacklisted") handles, and people who deleted their account ──
  const handleField = z.string().min(1).max(40);
  app.post('/api/admin/joiners/block', admin, wrap(async (req, res) => {
    const b = z.object({ handle: handleField, reason: z.string().trim().min(1).max(255) }).parse(req.body);
    const handle = normalizeHandle(b.handle);
    if (!isValidHandle(handle)) throw bad('That is not a valid Instagram handle');
    await withTx(pool, async (conn) => {
      // works on handles that have never claimed too, so you can block someone in advance
      await conn.query('INSERT INTO joiners (instagram_handle, is_blocked, blocked_reason, blocked_at) VALUES (?,1,?,NOW(3)) ON DUPLICATE KEY UPDATE is_blocked = 1, blocked_reason = VALUES(blocked_reason), blocked_at = NOW(3)', [handle, b.reason]);
      await audit(conn, req.account.id, 'joiner.block', 'joiner', null, { handle, reason: b.reason });
    });
    res.json({ ok: true });
  }));
  app.post('/api/admin/joiners/unblock', admin, wrap(async (req, res) => {
    const { handle } = z.object({ handle: handleField }).parse(req.body);
    const [r] = await pool.query('UPDATE joiners SET is_blocked = 0, blocked_reason = NULL, blocked_at = NULL WHERE instagram_handle = ?', [normalizeHandle(handle)]);
    if (r.affectedRows !== 1) throw notFound('No such handle');
    await audit(pool, req.account.id, 'joiner.unblock', 'joiner', null, { handle });
    res.json({ ok: true });
  }));
  // Who needs your attention: blocked handles, and handles whose owner deleted their account — with what's still owed or held.
  app.get('/api/admin/joiners/flagged', admin, wrap(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT j.instagram_handle AS handle, j.is_blocked AS blocked, j.blocked_reason AS blockedReason, j.account_deleted_at AS accountDeletedAt,
              (SELECT COALESCE(SUM(cc.cost - cc.paid), 0) FROM claim_costs cc JOIN claims c ON c.id = cc.claim_id
                WHERE c.joiner_id = j.id AND c.status = 'confirmed' AND cc.cost > cc.paid) AS owed,
              (SELECT COALESCE(SUM(balance_effect), 0) FROM credit_ledger WHERE joiner_id = j.id) AS credit,
              (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE joiner_id = j.id AND kind = 'forfeited') AS forfeited,
              (SELECT COUNT(*) FROM claims WHERE joiner_id = j.id AND status = 'confirmed' AND pipeline <> 'completed') AS openClaims
         FROM joiners j WHERE j.is_blocked = 1 OR j.account_deleted_at IS NOT NULL ORDER BY j.instagram_handle`);
    res.json({ joiners: rows.map((r) => ({ ...r, blocked: !!r.blocked, owed: round2(r.owed), credit: round2(r.credit), forfeited: round2(r.forfeited) })) });
  }));

  // Goodwill / correction: add credit by hand (e.g. putting back something forfeited when a person turns up).
  app.post('/api/admin/credit/add', admin, wrap(async (req, res) => {
    const b = z.object({ handle: handleField, amount: z.number().positive().max(100000), reason: z.string().trim().min(1).max(255) }).parse(req.body);
    await withTx(pool, async (conn) => {
      const [[j]] = await conn.query('SELECT id FROM joiners WHERE instagram_handle = ?', [normalizeHandle(b.handle)]);
      if (!j) throw notFound('No such handle');
      await lockJoiner(conn, j.id);
      await addLedger(conn, { joinerId: j.id, kind: 'credit', amount: b.amount, effect: b.amount, reason: b.reason, source: 'Admin credit' });
      await sweepCredit(conn, j.id);
      await audit(conn, req.account.id, 'credit.add', 'joiner', j.id, b);
    });
    res.json({ ok: true });
  }));

  // Tick (or untick) items as they go in the box. No claimIds = every item in the parcel. Saved straight away.
  app.post('/api/admin/parcels/:id/items-packed', admin, wrap(async (req, res) => {
    const b = z.object({ packed: z.boolean(), claimIds: z.array(z.number().int().positive()).max(200).optional() }).parse(req.body);
    const id = Number(req.params.id);
    const out = await withTx(pool, async (conn) => {
      const [[p]] = await conn.query('SELECT status FROM parcels WHERE id = ? FOR UPDATE', [id]);
      if (!p) throw notFound('No such parcel');
      if (p.status !== 'requested') throw conflict(`That parcel is ${p.status}, so its checklist can't be changed`, 'bad_state');
      if (b.claimIds?.length) {
        const [mine] = await conn.query('SELECT claim_id FROM parcel_items WHERE parcel_id = ? AND claim_id IN (?)', [id, b.claimIds]);
        if (mine.length !== new Set(b.claimIds).size) throw notFound('One of those items is not in this parcel');
      }
      await conn.query(`UPDATE parcel_items SET packed_at = ${b.packed ? 'COALESCE(packed_at, NOW(3))' : 'NULL'} WHERE parcel_id = ?${b.claimIds?.length ? ' AND claim_id IN (?)' : ''}`,
        b.claimIds?.length ? [id, b.claimIds] : [id]);
      const [[t]] = await conn.query('SELECT COUNT(*) AS total, COALESCE(SUM(packed_at IS NOT NULL), 0) AS ticked FROM parcel_items WHERE parcel_id = ?', [id]);
      return { ticked: Number(t.ticked), total: t.total };
    });
    res.json({ ok: true, ...out });
  }));

  // Confirm the delivery address / Lomo name / bias name for a parcel.
  app.post('/api/admin/parcels/:id/checks', admin, wrap(async (req, res) => {
    const b = z.object({ address: z.boolean().optional(), lomo: z.boolean().optional(), bias: z.boolean().optional(), friend: z.union([z.boolean(), z.string().max(60)]).optional() })
      .refine((v) => Object.keys(v).filter((k) => k !== 'friend').length > 0, 'Say which check to change').parse(req.body);
    if (b.friend && b.address !== undefined) throw bad("The delivery address belongs to the person it's posted to, not their friend");
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[p]] = await conn.query('SELECT status FROM parcels WHERE id = ? FOR UPDATE', [id]);
      if (!p) throw notFound('No such parcel');
      if (p.status !== 'requested') throw conflict(`That parcel is ${p.status}, so its checklist can't be changed`, 'bad_state');
      const set = [];
      for (const [key, col] of [['address', 'address_checked_at'], ['lomo', 'lomo_checked_at'], ['bias', 'bias_checked_at']]) {
        if (b[key] !== undefined) set.push(`${col} = ${b[key] ? 'COALESCE(' + col + ', NOW(3))' : 'NULL'}`);
      }
      if (b.friend) {                                                                   // a friend's own Lomo name / bias name — `true` = every friend, or one friend's handle
        const only = typeof b.friend === 'string' ? normalizeHandle(b.friend) : null;
        const [r] = await conn.query(`UPDATE parcel_companions SET ${set.join(', ')} WHERE parcel_id = ? AND status = 'accepted'${only ? ' AND joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)' : ''}`, only ? [id, only] : [id]);
        if (!r.affectedRows && !(await conn.query("SELECT 1 FROM parcel_companions WHERE parcel_id = ? AND status = 'accepted'", [id]))[0].length) throw notFound('That parcel is not shared with anyone');
        if (!r.affectedRows && only) throw notFound(`@${only} isn't sharing this parcel`);
      } else await conn.query(`UPDATE parcels SET ${set.join(', ')} WHERE id = ?`, [id]);
    });
    res.json({ ok: true });
  }));

  // ── what is overdue ──
  // Payments: confirmed claims still owing after their pay-by date (the item's own date, else its group order's). A date lives all day,
  // so something due today is not overdue until tomorrow. Storage: items sitting ready to pack past their keep-until date.
  app.get('/api/admin/overdue', admin, wrap(async (req, res) => {
    const [pay] = await pool.query(
      `SELECT c.id AS claimId, j.instagram_handle AS handle, c.label, COALESCE(go.title, 'Shop (on hand)') AS orderTitle,
              COALESCE(c.pay_by, i.payment_deadline, go.payment_deadline) AS due, (c.pay_by IS NOT NULL OR i.payment_deadline IS NOT NULL) AS ownDate,
              (SELECT COALESCE(SUM(cc.cost - cc.paid), 0) FROM claim_costs cc WHERE cc.claim_id = c.id AND cc.cost > cc.paid) AS owed,
              DATEDIFF(CURDATE(), COALESCE(c.pay_by, i.payment_deadline, go.payment_deadline)) AS daysOverdue,
              (SELECT n.sent_at FROM notification_log n WHERE n.kind = 'overdue_reminder' AND n.ref_id = c.id) AS remindedAt
         FROM claims c JOIN joiners j ON j.id = c.joiner_id LEFT JOIN items i ON i.id = c.item_id LEFT JOIN group_orders go ON go.id = c.order_id
        WHERE c.status = 'confirmed' AND COALESCE(c.pay_by, i.payment_deadline, go.payment_deadline) < CURDATE()
       HAVING owed > 0 ORDER BY daysOverdue DESC, handle, c.id LIMIT 1000`);
    const [sto] = await pool.query(
      `SELECT c.id AS claimId, j.instagram_handle AS handle, c.label, COALESCE(go.title, 'Shop (on hand)') AS orderTitle, c.size_bucket AS size,
              c.ready_to_pack_date AS readyDate, (c.storage_deadline_override IS NOT NULL) AS overridden,
              COALESCE(c.storage_deadline_override, DATE_ADD(c.ready_to_pack_date, INTERVAL ${storageCase()} DAY)) AS deadline,
              DATEDIFF(CURDATE(), COALESCE(c.storage_deadline_override, DATE_ADD(c.ready_to_pack_date, INTERVAL ${storageCase()} DAY))) AS daysOverdue
         FROM claims c JOIN joiners j ON j.id = c.joiner_id LEFT JOIN group_orders go ON go.id = c.order_id
        WHERE c.status = 'confirmed' AND c.pipeline NOT IN ('packed', 'shipped', 'completed')
          AND (c.ready_to_pack_date IS NOT NULL OR c.storage_deadline_override IS NOT NULL)
       HAVING deadline < CURDATE() ORDER BY daysOverdue DESC, handle, c.id LIMIT 1000`);
    const [prox] = await pool.query(
      `SELECT pp.id, p.name AS proxy, pp.summary, pp.deadline, DATEDIFF(CURDATE(), pp.deadline) AS daysOverdue
         FROM proxy_payments pp JOIN proxies p ON p.id = pp.proxy_id WHERE pp.is_paid = 0 AND pp.deadline < CURDATE() ORDER BY daysOverdue DESC, pp.id`);
    const payments = pay.map((r) => ({ ...r, owed: round2(r.owed), ownDate: !!r.ownDate }));
    res.json({
      payments, storage: sto.map((r) => ({ ...r, overridden: !!r.overridden })), proxy: prox,
      totals: { paymentsOwed: round2(payments.reduce((t, r) => t + r.owed, 0)), people: new Set(payments.map((r) => r.handle)).size, storageItems: sto.length, proxyPayments: prox.length },
    });
  }));
}
