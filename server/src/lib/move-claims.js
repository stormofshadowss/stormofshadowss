import { round2 } from './money.js';
import { lockJoiner } from './ledger.js';
import { audit } from '../auth.js';
import { HttpError, notFound } from '../errors.js';

const same = (a, b) => Math.abs(round2(a) - round2(b)) < 0.005;

// Moves claims from whoever holds them to another person — for example old claims that were imported under the wrong handle. Everything a claim carries goes with it:
// its costs, its stage, its dates, and the money paid on it (the payment records are moved or split so every person's books still add up).
// It is deliberately cautious: a claim it can't move SAFELY is left where it is, with the reason — it never half-moves anything.
//   dryRun: work it all out and report, change nothing.
export async function moveClaims(conn, { claimIds, handle, create = false, dryRun = false, accountId }) {
  const ids = [...new Set(claimIds)].sort((a, b) => a - b);
  const [[t0]] = await conn.query('SELECT id, account_id AS accountId, is_blocked AS blocked FROM joiners WHERE instagram_handle = ?', [handle]);
  if (!t0 && !create && !dryRun) throw new HttpError(404, `Nobody has the handle @${handle} on the site yet. Tick "create it" if that's the right handle.`, 'no_such_handle');
  const target = { handle, exists: !!t0, signedUp: !!t0?.accountId, blocked: !!t0?.blocked, willCreate: !t0 && create };

  if (!dryRun) {                                              // lock the people first (lowest id first, like every money flow), then the claims
    const [who] = await conn.query('SELECT DISTINCT joiner_id FROM claims WHERE id IN (?)', [ids]);
    const lockIds = [...new Set([...who.map((w) => w.joiner_id), ...(t0 ? [t0.id] : [])])].sort((a, b) => a - b);
    for (const id of lockIds) await lockJoiner(conn, id);
    await conn.query('SELECT id FROM claims WHERE id IN (?) ORDER BY id FOR UPDATE', [ids]);
  }
  const [rows] = await conn.query(
    `SELECT c.id, c.label, c.status, c.joiner_id AS joinerId, c.set_id AS setId, c.is_fixed AS fixed, j.instagram_handle AS handle,
            (SELECT COALESCE(SUM(cost), 0) FROM claim_costs WHERE claim_id = c.id) AS cost, (SELECT COALESCE(SUM(paid), 0) FROM claim_costs WHERE claim_id = c.id) AS paid,
            (SELECT COALESCE(SUM(amount), 0) FROM payment_allocations WHERE claim_id = c.id) AS allocated
       FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE c.id IN (?) ORDER BY c.id`, [ids]);
  const [asked] = await conn.query("SELECT claim_id FROM cancel_requests WHERE claim_id IN (?) AND status = 'pending'", [ids]);
  const askedSet = new Set(asked.map((a) => a.claim_id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const blocked = [], ok = new Map();
  for (const id of ids) {
    const r = byId.get(id);
    const no = (reason) => blocked.push({ id, label: r?.label || `#${id}`, from: r?.handle || null, reason });
    if (!r) no('no such claim');
    else if (target.blocked) no(`@${handle} is blocked`);
    else if (t0 && r.joinerId === t0.id) no(`it already belongs to @${handle}`);
    else if (askedSet.has(id)) no('the person has asked to cancel it — answer that request first')
    else if (r.setId || r.fixed) no("it's part of a member set (or a fixed claim) — set parts can't be moved");
    else if (!same(r.paid, r.allocated)) no("some of what's been paid on it isn't tied to a payment (for example credit was used), so it can't be moved safely");
    else ok.set(id, r);
  }
  // parcels: a claim in a parcel can only go if the WHOLE parcel goes with it, and only a parcel that is on its way or finished (not one being packed)
  const [pItems] = ok.size ? await conn.query("SELECT pi.claim_id AS claimId, pi.parcel_id AS parcelId, p.status FROM parcel_items pi JOIN parcels p ON p.id = pi.parcel_id WHERE pi.claim_id IN (?) AND p.status <> 'cancelled'", [[...ok.keys()]]) : [[]];
  const parcelIds = [...new Set(pItems.map((p) => p.parcelId))];
  const [allItems] = parcelIds.length ? await conn.query('SELECT parcel_id AS parcelId, claim_id AS claimId FROM parcel_items WHERE parcel_id IN (?)', [parcelIds]) : [[]];
  const movingParcels = new Set();
  for (const pid of parcelIds) {
    const status = pItems.find((p) => p.parcelId === pid).status;
    const members = allItems.filter((a) => a.parcelId === pid).map((a) => a.claimId);
    const reason = ['requested', 'packed'].includes(status) ? 'it is in a parcel that is being packed — use the Packing tab'
      : members.every((m) => ok.has(m)) ? null : "it is in a parcel with other items that aren't being moved";
    if (!reason) { movingParcels.add(pid); continue; }
    for (const m of members) if (ok.has(m)) { const r = ok.get(m); ok.delete(m); blocked.push({ id: m, label: r.label, from: r.handle, reason }); }
  }
  const movable = [...ok.values()].map((r) => ({ id: r.id, label: r.label, from: r.handle, paid: round2(r.paid), owed: round2(r.status === 'confirmed' ? Math.max(0, r.cost - r.paid) : 0) }));
  const result = { target, movable, blocked, parcels: [...movingParcels], money: { paid: round2(movable.reduce((s, m) => s + m.paid, 0)), owed: round2(movable.reduce((s, m) => s + m.owed, 0)) } };
  if (dryRun) return result;
  if (!movable.length) throw new HttpError(409, `Nothing could be moved: ${blocked.slice(0, 3).map((b) => `${b.label} — ${b.reason}`).join('; ')}${blocked.length > 3 ? '…' : ''}`, 'nothing_movable');

  let targetId = t0?.id;
  if (!targetId) { const [r] = await conn.query('INSERT INTO joiners (instagram_handle) VALUES (?)', [handle]); targetId = r.insertId; await lockJoiner(conn, targetId); }
  const moveIds = movable.map((m) => m.id);
  await conn.query('UPDATE claims SET joiner_id = ? WHERE id IN (?)', [targetId, moveIds]);
  if (movingParcels.size) await conn.query('UPDATE parcels SET joiner_id = ? WHERE id IN (?)', [targetId, [...movingParcels]]);

  // The money paid follows the claim. A payment that went wholly to moved claims simply changes hands; one that was shared with claims staying behind is SPLIT:
  // the original shrinks by what moved, and a new verified payment of that amount is recorded for the new owner. Either way each person's payments add up to what they paid.
  const [allocs] = await conn.query('SELECT payment_id AS paymentId, claim_id AS claimId, category, amount FROM payment_allocations WHERE claim_id IN (?)', [moveIds]);
  const byPayment = new Map();
  for (const a of allocs) { if (!byPayment.has(a.paymentId)) byPayment.set(a.paymentId, []); byPayment.get(a.paymentId).push(a); }
  const money = { reassigned: 0, split: 0 };
  for (const [paymentId, list] of byPayment) {
    const [[p]] = await conn.query('SELECT * FROM payments WHERE id = ? FOR UPDATE', [paymentId]);
    if (p.joiner_id === targetId) continue;
    const moved = round2(list.reduce((s, a) => s + Number(a.amount), 0));
    if (same(p.amount, moved)) { await conn.query('UPDATE payments SET joiner_id = ? WHERE id = ?', [targetId, paymentId]); money.reassigned += 1; continue; }
    await conn.query('UPDATE payments SET amount = amount - ? WHERE id = ?', [moved, paymentId]);
    await conn.query('DELETE FROM payment_allocations WHERE payment_id = ? AND claim_id IN (?)', [paymentId, moveIds]);
    const [np] = await conn.query(
      `INSERT INTO payments (joiner_id, order_id, amount, method, reference, payer_name, payer_is_address_name, address_name_snapshot, status, created_at, verified_at, verified_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
      [targetId, p.order_id, moved, p.method, `${p.reference ? `${p.reference} ` : ''}(moved from another handle)`.slice(0, 255), p.payer_name, p.payer_is_address_name, p.address_name_snapshot, p.created_at, p.verified_at, p.verified_by]);
    await conn.query('INSERT INTO payment_allocations (payment_id, claim_id, category, amount) VALUES ?', [list.map((a) => [np.insertId, a.claimId, a.category, a.amount])]);
    money.split += 1;
  }
  await conn.query("UPDATE import_records SET moved_at = NOW(3) WHERE kind = 'claim' AND entity_id IN (?)", [moveIds]);      // an import that made these can no longer be undone
  await audit(conn, accountId, 'claims.move', 'joiner', targetId, { to: handle, claims: moveIds.length, parcels: movingParcels.size, ...money });
  return { ...result, moved: moveIds.length, payments: money };
}
