import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { bad, conflict, notFound, HttpError } from '../errors.js';
import { normalizeHandle, isValidHandle } from '../lib/handles.js';
import { lockJoiner, sweepCredit } from '../lib/ledger.js';
import { cancelClaim } from '../lib/cancel.js';
import { addClaimCosts } from '../lib/ledger.js';
import { round2, splitAmount } from '../lib/money.js';

export function setRoutes(app, { pool, notifier }) {
  const admin = [requireAdmin];

  // Every set, with who holds each part.
  app.get('/api/admin/sets', admin, wrap(async (req, res) => {
    const where = ['1=1']; const params = [];
    if (req.query.order) { where.push('go.id = ?'); params.push(Number(req.query.order)); }
    if (req.query.decision) { where.push('s.admin_decision = ?'); params.push(String(req.query.decision)); }
    const [sets] = await pool.query(
      `SELECT s.id, s.set_number AS number, s.admin_decision AS decision, i.id AS itemId, i.title AS itemTitle, i.price, i.price_tbc AS itemTbc, i.requires_full_set AS requiresFullSet,
              go.id AS orderId, go.title AS orderTitle
         FROM item_sets s JOIN items i ON i.id = s.item_id JOIN group_orders go ON go.id = i.order_id
        WHERE ${where.join(' AND ')} AND i.cancelled_at IS NULL AND go.cancelled_at IS NULL ORDER BY go.id, i.id, s.set_number`, params);
    if (!sets.length) return res.json({ sets: [] });
    const itemIds = [...new Set(sets.map((s) => s.itemId))];
    const [members] = await pool.query('SELECT item_id, name, price FROM item_members WHERE item_id IN (?) ORDER BY sort_order, id', [itemIds]);
    const [slots] = await pool.query(
      `SELECT sl.set_id, sl.member_name, sl.is_fixed AS isFixed, sl.raffle_status AS raffleStatus, sl.raffle_share AS raffleShare, j.instagram_handle AS handle, c.id AS claimId, c.status, c.price_tbc AS tbc, EXISTS (SELECT 1 FROM cancel_requests cr WHERE cr.claim_id = c.id AND cr.status = 'pending') AS asked
         FROM set_slots sl LEFT JOIN joiners j ON j.id = sl.joiner_id LEFT JOIN claims c ON c.slot_id = sl.id WHERE sl.set_id IN (?)`, [sets.map((s) => s.id)]);
    res.json({
      sets: sets.map((s) => {
        const parts = members.filter((m) => m.item_id === s.itemId).map((m) => {
          const slot = slots.find((x) => x.set_id === s.id && x.member_name === m.name);
          return { member: m.name, price: m.price ?? (s.itemTbc ? null : s.price), priceTbc: !!slot?.tbc, cancelAsked: !!slot?.asked, handle: slot?.handle ?? null, claimId: slot?.claimId ?? null, status: slot?.status ?? null, fixed: !!slot?.isFixed,
            raffle: slot && slot.raffleStatus !== 'none' ? { status: slot.raffleStatus, share: slot.raffleShare } : null };
        });
        return { ...s, itemTbc: !!s.itemTbc, hasTbc: parts.some((p) => p.priceTbc), hasRequests: parts.some((p) => p.cancelAsked), requiresFullSet: !!s.requiresFullSet, parts, filled: parts.filter((p) => p.handle).length, total: parts.length };
      }),
    });
  }));

  // Secure a set: its claims become real (confirmed) and what each person owes starts to count.
  // A set that needs every part can't be secured until it's full. Any parts still open stay open.
  app.post('/api/admin/sets/:id/secure', admin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const out = await withTx(pool, async (conn) => {
      const [[exists]] = await conn.query('SELECT id FROM item_sets WHERE id = ?', [id]);
      if (!exists) throw notFound('No such set');
      // people first (lowest id first), then the set and its claims — the same order every money flow uses
      const [who] = await conn.query("SELECT DISTINCT joiner_id FROM claims WHERE set_id = ? AND status = 'requested' ORDER BY joiner_id", [id]);
      for (const { joiner_id } of who) await lockJoiner(conn, joiner_id);
      const [[s]] = await conn.query('SELECT s.admin_decision AS decision, i.requires_full_set AS full FROM item_sets s JOIN items i ON i.id = s.item_id WHERE s.id = ? FOR UPDATE', [id]);
      if (s.decision !== 'none') throw conflict(`That set is already ${s.decision}`, 'bad_state');
      const [[n]] = await conn.query('SELECT COUNT(*) AS filled, (SELECT COUNT(*) FROM item_members WHERE item_id = (SELECT item_id FROM item_sets WHERE id = ?)) AS total FROM set_slots WHERE set_id = ? AND joiner_id IS NOT NULL', [id, id]);
      if (n.filled === 0) throw bad('Nobody has claimed anything in this set yet', 'set_empty');
      if (s.full && n.filled < n.total) throw conflict(`Every part of this set has to be claimed before it can go ahead (${n.filled}/${n.total} so far).`, 'set_incomplete');
      const [claims] = await conn.query("SELECT id, joiner_id, price_tbc FROM claims WHERE set_id = ? AND status = 'requested' FOR UPDATE", [id]);
      const tbc = claims.filter((c) => c.price_tbc).length;
      if (tbc) throw conflict(`This set can't be secured yet — the price of ${tbc} of its parts is still TBC. Set the item's price first.`, 'price_tbc');
      if (claims.length) {
        const [[asked]] = await conn.query("SELECT COUNT(*) AS n FROM cancel_requests WHERE claim_id IN (?) AND status = 'pending'", [claims.map((c) => c.id)]);
        if (asked.n) throw conflict(`This set can't be secured yet — ${asked.n} of its parts ${asked.n === 1 ? 'has' : 'have'} a request to cancel waiting. Answer ${asked.n === 1 ? 'it' : 'them'} first (Claims tab).`, 'cancel_pending');
      }
      if (claims.length) await conn.query("UPDATE claims SET status = 'confirmed' WHERE id IN (?)", [claims.map((c) => c.id)]);
      for (const jid of [...new Set(claims.map((c) => c.joiner_id))].sort((a, b) => a - b)) await sweepCredit(conn, jid);
      await conn.query("UPDATE item_sets SET admin_decision = 'secured' WHERE id = ?", [id]);
      await audit(conn, req.account.id, 'set.secure', 'set', id, { claims: claims.length, open: n.total - n.filled });
      return { secured: claims.length, openParts: n.total - n.filled, claimIds: claims.map((c) => c.id) };
    });
    notifier.claimsSecured(out.claimIds);
    const { claimIds, ...pub } = out;
    res.json({ ok: true, ...pub });
  }));

  // Cancel a set: every claim in it is cancelled, anything already paid goes back as credit (unless the handle is blocked),
  // and the parts are free again.
  app.post('/api/admin/sets/:id/cancel', admin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const out = await withTx(pool, async (conn) => {
      const [[exists]] = await conn.query('SELECT id FROM item_sets WHERE id = ?', [id]);
      if (!exists) throw notFound('No such set');
      const [claims] = await conn.query("SELECT id, joiner_id FROM claims WHERE set_id = ? AND status <> 'cancelled' ORDER BY joiner_id, id", [id]);
      for (const jid of [...new Set(claims.map((c) => c.joiner_id))]) await lockJoiner(conn, jid);
      const [[s]] = await conn.query('SELECT admin_decision AS decision FROM item_sets WHERE id = ? FOR UPDATE', [id]);
      if (s.decision === 'cancelled') throw conflict('That set is already cancelled', 'bad_state');
      const results = [];
      for (const c of claims) results.push(await cancelClaim(conn, c.id, 'Set cancelled'));
      await conn.query('DELETE FROM set_slots WHERE set_id = ? AND joiner_id IS NULL', [id]);   // a pending raffle goes with the set
      await conn.query("UPDATE item_sets SET admin_decision = 'cancelled' WHERE id = ?", [id]);
      await audit(conn, req.account.id, 'set.cancel', 'set', id, { claims: claims.length });
      return { cancelled: results.filter((r) => r.cancelled).length, refunded: round2(results.reduce((t, r) => t + r.refunded, 0)), forfeited: round2(results.reduce((t, r) => t + r.forfeited, 0)) };
    });
    res.json({ ok: true, ...out });
  }));

  // Put someone into an open part by hand (e.g. to fill a gap). In a set that's already secured the claim is confirmed straight away.
  app.post('/api/admin/sets/:id/slots', admin, wrap(async (req, res) => {
    const b = z.object({ member: z.string().min(1).max(80), handle: z.string().min(1).max(40) }).parse(req.body);
    const id = Number(req.params.id);
    const handle = normalizeHandle(b.handle);
    if (!isValidHandle(handle)) throw bad('That is not a valid Instagram handle');
    const out = await withTx(pool, async (conn) => {
      const [[s0]] = await conn.query('SELECT s.id, s.item_id FROM item_sets s WHERE s.id = ?', [id]);
      if (!s0) throw notFound('No such set');
      await conn.query('INSERT IGNORE INTO joiners (instagram_handle) VALUES (?)', [handle]);
      const [[j]] = await conn.query('SELECT id, is_blocked FROM joiners WHERE instagram_handle = ?', [handle]);
      if (j.is_blocked) throw new HttpError(403, 'That handle is blocked', 'handle_blocked');
      await lockJoiner(conn, j.id);
      const [[s]] = await conn.query('SELECT s.admin_decision AS decision, i.id AS itemId, i.title, i.price, i.price_tbc AS itemTbc, i.order_id AS orderId, i.size_bucket AS sizeBucket FROM item_sets s JOIN items i ON i.id = s.item_id WHERE s.id = ? FOR UPDATE', [id]);
      if (s.decision === 'cancelled') throw conflict('That set is cancelled', 'bad_state');
      const [[m]] = await conn.query('SELECT price FROM item_members WHERE item_id = ? AND name = ?', [s.itemId, b.member]);
      if (!m) throw bad(`"${b.member}" isn't part of "${s.title}"`);
      const tbc = m.price === null && s.itemTbc;
      if (tbc && s.decision === 'secured') throw conflict("That part's price is still TBC, so it can't be added to a secured set yet. Set the item's price first.", 'price_tbc');
      const [taken] = await conn.query('SELECT joiner_id FROM set_slots WHERE set_id = ? AND member_name = ?', [id, b.member]);
      if (taken.length) throw taken[0].joiner_id ? conflict('Somebody already has that part', 'slot_taken') : conflict('A raffle is under way for that part — pick its winner instead', 'raffle_pending');
      const [slot] = await conn.query("INSERT INTO set_slots (set_id, member_name, joiner_id, state) VALUES (?, ?, ?, 'held')", [id, b.member, j.id]);
      const status = s.decision === 'secured' ? 'confirmed' : 'requested';
      const label = `${s.title} — ${b.member} (Set ${(await conn.query('SELECT set_number FROM item_sets WHERE id = ?', [id]))[0][0].set_number})`;
      const [c] = await conn.query(
        `INSERT INTO claims (joiner_id, order_id, item_id, set_id, slot_id, label, member_name, size_bucket, status, is_direct, price_tbc) VALUES (?,?,?,?,?,?,?,?,?,1,?)`,
        [j.id, s.orderId, s.itemId, id, slot.insertId, label, b.member, s.sizeBucket, status, tbc ? 1 : 0]);
      await addClaimCosts(conn, c.insertId, tbc ? 0 : m.price ?? s.price);
      if (status === 'confirmed') await sweepCredit(conn, j.id);
      await audit(conn, req.account.id, 'set.assign', 'set', id, { handle, member: b.member });
      return { claimId: c.insertId, status };
    });
    if (out.status === 'confirmed') notifier.claimsSecured([out.claimId]);
    res.status(201).json({ ok: true, ...out });
  }));

  // A part is still open in a secured set: share its cost across the claims in the set (to the penny). Each claim's item cost goes up
  // by its share (what's already paid is untouched, so it simply shows as owed), and the part is held for a raffle among those people.
  app.post('/api/admin/sets/:id/split', admin, wrap(async (req, res) => {
    const { member } = z.object({ member: z.string().min(1).max(80) }).parse(req.body);
    const id = Number(req.params.id);
    const out = await withTx(pool, async (conn) => {
      const [[exists]] = await conn.query('SELECT id FROM item_sets WHERE id = ?', [id]);
      if (!exists) throw notFound('No such set');
      const [who] = await conn.query("SELECT DISTINCT joiner_id FROM claims WHERE set_id = ? AND status <> 'cancelled' ORDER BY joiner_id", [id]);
      for (const { joiner_id } of who) await lockJoiner(conn, joiner_id);
      const [[s]] = await conn.query('SELECT s.admin_decision AS decision, i.id AS itemId, i.price, i.price_tbc AS itemTbc FROM item_sets s JOIN items i ON i.id = s.item_id WHERE s.id = ? FOR UPDATE', [id]);
      if (s.decision !== 'secured') throw conflict('Only a secured set can have an open part split', 'bad_state');
      const [[m]] = await conn.query('SELECT price FROM item_members WHERE item_id = ? AND name = ?', [s.itemId, member]);
      if (!m) throw bad(`"${member}" isn't part of this set`);
      if (m.price === null && s.itemTbc) throw conflict("That part's price is TBC, so its cost can't be shared out yet. Set the item's price first.", 'price_tbc');
      const [taken] = await conn.query('SELECT 1 FROM set_slots WHERE set_id = ? AND member_name = ?', [id, member]);
      if (taken.length) throw conflict('That part is already held, or a split is already under way for it', 'slot_taken');
      const [claims] = await conn.query("SELECT id, joiner_id FROM claims WHERE set_id = ? AND status <> 'cancelled' AND slot_id IS NOT NULL ORDER BY id FOR UPDATE", [id]);
      if (!claims.length) throw bad('Nobody is in this set to share the cost', 'set_empty');
      const price = m.price ?? s.price;
      const shares = splitAmount(price, claims.map(() => 1));
      for (const [i, c] of claims.entries()) {
        await conn.query("UPDATE claim_costs SET cost = ROUND(cost + ?, 2) WHERE claim_id = ? AND category = 'initials'", [shares[i], c.id]);
        await conn.query('UPDATE claims SET split_share = ROUND(split_share + ?, 2) WHERE id = ?', [shares[i], c.id]);
      }
      await conn.query("INSERT INTO set_slots (set_id, member_name, joiner_id, state, raffle_status, raffle_share) VALUES (?, ?, NULL, 'open', 'pending', ?)", [id, member, Math.max(...shares)]);
      for (const jid of [...new Set(claims.map((c) => c.joiner_id))].sort((a, b) => a - b)) await sweepCredit(conn, jid);
      await audit(conn, req.account.id, 'set.split', 'set', id, { member, price, holders: claims.length });
      return { price, holders: claims.length, share: Math.max(...shares) };
    });
    res.json({ ok: true, ...out });
  }));

  // Pick the raffle winner among the people in the set. They receive the raffled part at no further cost — they've already paid their share of it.
  app.post('/api/admin/sets/:id/raffle', admin, wrap(async (req, res) => {
    const b = z.object({ member: z.string().min(1).max(80), handle: z.string().min(1).max(40) }).parse(req.body);
    const id = Number(req.params.id);
    const handle = normalizeHandle(b.handle);
    const out = await withTx(pool, async (conn) => {
      const [[exists]] = await conn.query('SELECT id FROM item_sets WHERE id = ?', [id]);
      if (!exists) throw notFound('No such set');
      const [[j]] = await conn.query('SELECT id FROM joiners WHERE instagram_handle = ?', [handle]);
      if (!j) throw bad('Pick someone who is in this set', 'not_in_set');
      await lockJoiner(conn, j.id);
      const [[s]] = await conn.query('SELECT s.admin_decision AS decision, s.set_number AS setNumber, i.id AS itemId, i.title, i.order_id AS orderId, i.size_bucket AS sizeBucket FROM item_sets s JOIN items i ON i.id = s.item_id WHERE s.id = ? FOR UPDATE', [id]);
      if (s.decision !== 'secured') throw conflict('Only a secured set can have a raffle', 'bad_state');
      const [[ph]] = await conn.query('SELECT id, raffle_status FROM set_slots WHERE set_id = ? AND member_name = ? FOR UPDATE', [id, b.member]);
      if (!ph || ph.raffle_status !== 'pending') throw conflict('There is no raffle waiting for that part', 'no_raffle');
      const [in_set] = await conn.query("SELECT 1 FROM claims WHERE set_id = ? AND joiner_id = ? AND status <> 'cancelled' LIMIT 1", [id, j.id]);
      if (!in_set.length) throw bad('Pick someone who is in this set', 'not_in_set');
      await conn.query("UPDATE set_slots SET joiner_id = ?, state = 'held', raffle_status = 'resolved', raffle_winner_joiner_id = ? WHERE id = ?", [j.id, j.id, ph.id]);
      const label = `${s.title} — ${b.member} (Set ${s.setNumber}) — raffle win`;
      const [c] = await conn.query(
        "INSERT INTO claims (joiner_id, order_id, item_id, set_id, slot_id, label, member_name, size_bucket, status) VALUES (?,?,?,?,?,?,?,?, 'confirmed')",
        [j.id, s.orderId, s.itemId, id, ph.id, label, b.member, s.sizeBucket]);
      await addClaimCosts(conn, c.insertId, 0);            // already paid for, through the split
      await audit(conn, req.account.id, 'set.raffle', 'set', id, { member: b.member, winner: handle });
      return { claimId: c.insertId };
    });
    res.json({ ok: true, ...out });
  }));
}
