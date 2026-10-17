import { conflict, notFound } from '../errors.js';
import { lockJoiner, siblingsOf, creditBalance, addLedger, sweepCredit, setPaid, distribute } from './ledger.js';
import { round2 } from './money.js';

// A payment the GOM VERIFIED can still fail days later (a bank transfer that bounces). Marking it failed puts things back as they were before it arrived:
//  1. what it paid off is OWED AGAIN (the allocations recorded when it was verified are undone);
//  2. any credit it created (an overpayment kept as credit) is taken back — from the payer's handle first, then their other handles; a tip is noted as not received;
//  3. if that credit has ALREADY BEEN SPENT on other items, those items are owed again too (newest first), so nobody is left better off by a payment that never arrived.
// The payment becomes 'reversed' (kept for the record). No email is sent — the GOM tells the person. Anything that could not be recovered is reported, never hidden.
export class DryRunDone extends Error { constructor(result) { super('dry run'); this.result = result; } }

export async function reversePayments(conn, paymentIds, { reason = null, adminId = null } = {}) {
  const ids = [...new Set(paymentIds)].sort((a, b) => a - b);
  const [owners] = await conn.query('SELECT id, joiner_id FROM payments WHERE id IN (?)', [ids]);
  if (owners.length !== ids.length) throw notFound('No such payment');
  for (const jid of [...new Set(owners.map((r) => r.joiner_id))].sort((a, b) => a - b)) await lockJoiner(conn, jid);          // people first (all their handles), then the payments
  const [pays] = await conn.query('SELECT p.id, p.joiner_id, p.amount, p.status, j.instagram_handle AS handle FROM payments p JOIN joiners j ON j.id = p.joiner_id WHERE p.id IN (?) ORDER BY p.id FOR UPDATE', [ids]);
  for (const p of pays) {
    if (p.status === 'reversed') throw conflict('That payment has already been marked as failed', 'already_reversed');
    if (p.status !== 'confirmed') throw conflict('Only a payment you have already verified can be marked as failed', 'not_confirmed');
  }
  const owedAgain = []; let shortfall = 0;
  // 1. undo what the payment paid off
  const [allocs] = await conn.query(
    'SELECT pa.claim_id, pa.category, pa.amount, c.label, c.leftover_item_id, j.instagram_handle AS handle FROM payment_allocations pa JOIN claims c ON c.id = pa.claim_id JOIN joiners j ON j.id = c.joiner_id WHERE pa.payment_id IN (?) ORDER BY pa.id', [ids]);
  for (const a of allocs) {
    const [[cc]] = await conn.query('SELECT cost, paid FROM claim_costs WHERE claim_id = ? AND category = ? FOR UPDATE', [a.claim_id, a.category]);
    const take = Math.min(Number(cc?.paid || 0), Number(a.amount));
    shortfall = round2(shortfall + Number(a.amount) - take);                                                          // paid was already lowered some other way (e.g. a cost was reduced)
    if (take > 0.004) {
      await setPaid(conn, a.claim_id, a.category, round2(Number(cc.paid) - take), cc.cost);
      owedAgain.push({ handle: a.handle, claimId: a.claim_id, label: a.label, category: a.category, amount: round2(take) });
      await unreadyShopClaim(conn, a);
    }
  }
  // 2. credit the payments created, and tips
  const [[made]] = await conn.query("SELECT COALESCE(SUM(CASE WHEN kind = 'credit' THEN balance_effect ELSE 0 END), 0) AS credit, COALESCE(SUM(CASE WHEN kind = 'tip' THEN amount ELSE 0 END), 0) AS tips FROM credit_ledger WHERE payment_id IN (?)", [ids]);
  let left = round2(Number(made.credit) + shortfall), creditRemoved = 0;
  const payerIds = [...new Set(pays.map((p) => p.joiner_id))];
  const people = [];                                                                                                  // the payer's handles first, then the rest of their handles
  for (const jid of payerIds) { const [[me]] = await conn.query('SELECT id, instagram_handle AS handle FROM joiners WHERE id = ?', [jid]); if (!people.some((x) => x.id === me.id)) people.push(me); for (const s of await siblingsOf(conn, jid)) if (!people.some((x) => x.id === s.id)) people.push(s); }
  const why = reason ? ` (${reason})` : '';
  for (const j of people) {
    if (left <= 0.004) break;
    const take = Math.min(await creditBalance(conn, j.id), left); if (take <= 0.004) continue;
    await addLedger(conn, { joinerId: j.id, kind: 'removed', amount: take, effect: -take, reason: `A payment failed after it was received — the credit it created is removed${why}`, source: 'payment reversal', paymentId: pays[0].id });
    left = round2(left - take); creditRemoved = round2(creditRemoved + take);
  }
  // 3. credit that has already been spent: those items are owed again, newest first
  let spentUndone = 0;
  if (left > 0.004) {
    const [applied] = await conn.query("SELECT joiner_id, claim_id, category, amount FROM credit_ledger WHERE joiner_id IN (?) AND kind = 'applied' AND claim_id IS NOT NULL ORDER BY id DESC", [people.map((x) => x.id)]);
    for (const e of applied) {
      if (left <= 0.004) break;
      const [[cc]] = await conn.query('SELECT cost, paid FROM claim_costs WHERE claim_id = ? AND category = ? FOR UPDATE', [e.claim_id, e.category]);
      const take = Math.min(Number(cc?.paid || 0), Number(e.amount), left); if (take <= 0.004) continue;
      const [[cl]] = await conn.query('SELECT c.label, c.leftover_item_id, j.instagram_handle AS handle FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE c.id = ?', [e.claim_id]);
      await setPaid(conn, e.claim_id, e.category, round2(Number(cc.paid) - take), cc.cost);
      owedAgain.push({ handle: cl.handle, claimId: e.claim_id, label: cl.label, category: e.category, amount: round2(take), creditHadBeenSpent: true });
      await addLedger(conn, { joinerId: e.joiner_id, kind: 'removed', amount: take, effect: 0, reason: `Credit from a failed payment had been spent on this — it is owed again${why}`, source: 'payment reversal', paymentId: pays[0].id, claimId: e.claim_id, category: e.category });
      await unreadyShopClaim(conn, { claim_id: e.claim_id, leftover_item_id: cl.leftover_item_id });
      left = round2(left - take); spentUndone = round2(spentUndone + take);
    }
  }
  // 4. record it, and let any credit the person still holds from elsewhere apply to what is now owed
  await conn.query("UPDATE payments SET status = 'reversed', reversed_at = NOW(3), reversed_by = ?, reverse_reason = ? WHERE id IN (?)", [adminId, reason, ids]);
  for (const jid of payerIds) await sweepCredit(conn, jid);
  return {
    payments: pays.map((p) => ({ id: p.id, handle: p.handle, amount: Number(p.amount) })), total: round2(pays.reduce((n, p) => n + Number(p.amount), 0)),
    owedAgain, owedAgainTotal: round2(owedAgain.reduce((n, o) => n + o.amount, 0)), creditRemoved, creditSpentUndone: spentUndone, tipsNotReceived: round2(Number(made.tips)), notRecovered: left > 0.004 ? left : 0,
  };
}

// An on-hand shop item becomes "ready to pack" the moment it is paid for; if that payment fails and it isn't in a parcel yet, it goes back to waiting.
async function unreadyShopClaim(conn, a) {
  if (!a.leftover_item_id) return;
  const [[inParcel]] = await conn.query('SELECT COUNT(*) AS n FROM parcel_items WHERE claim_id = ?', [a.claimId ?? a.claim_id]);
  if (inParcel.n) return;
  await conn.query("UPDATE claims SET pipeline = 'awaiting fulfillment', ready_to_pack_date = NULL WHERE id = ? AND leftover_item_id IS NOT NULL AND pipeline = 'ready to pack / on hand'", [a.claimId ?? a.claim_id]);
}

// RE-APPLY a verified payment: it paid the wrong items (before payments were ordered by due date, one could clear a NEW item while older ones stayed overdue). This undoes where its money went and puts
// the SAME money where it would go now — what is due first. What the person owes IN TOTAL does not change; only which lines are marked paid. Credit or tips the payment made are left alone.
// If part of what it paid has since been changed (a cost edited, a claim cancelled) it refuses rather than guess. Returns exactly which lines lose and gain money, so the GOM can see it first.
export async function reapplyPayments(conn, paymentIds) {
  const ids = [...new Set(paymentIds)].sort((a, b) => a - b);
  const [owners] = await conn.query('SELECT id, joiner_id FROM payments WHERE id IN (?)', [ids]);
  if (owners.length !== ids.length) throw notFound('No such payment');
  for (const jid of [...new Set(owners.map((r) => r.joiner_id))].sort((a, b) => a - b)) await lockJoiner(conn, jid);
  const [pays] = await conn.query('SELECT id, joiner_id, order_id, amount, status FROM payments WHERE id IN (?) ORDER BY id FOR UPDATE', [ids]);
  for (const p of pays) if (p.status !== 'confirmed') throw conflict('Only a payment you have already verified can be re-applied', 'not_confirmed');
  const key = (a) => `${a.claim_id}|${a.category}`, gone = new Map(), came = new Map(), info = new Map();
  for (const p of pays) {
    await conn.query('SAVEPOINT reapply_one');
    const [allocs] = await conn.query(
      'SELECT pa.claim_id, pa.category, pa.amount, c.label, c.leftover_item_id, j.instagram_handle AS handle FROM payment_allocations pa JOIN claims c ON c.id = pa.claim_id JOIN joiners j ON j.id = c.joiner_id WHERE pa.payment_id = ? ORDER BY pa.id', [p.id]);
    if (!allocs.length) { await conn.query('RELEASE SAVEPOINT reapply_one'); continue; }
    let applied = 0; const g = new Map(), c = new Map(), inf = new Map();
    for (const a of allocs) {                                                                                         // 1. take it back off the lines it paid
      const [[cc]] = await conn.query('SELECT cost, paid FROM claim_costs WHERE claim_id = ? AND category = ? FOR UPDATE', [a.claim_id, a.category]);
      if (!cc || Number(cc.paid) + 0.004 < Number(a.amount)) throw conflict("Part of what this payment paid has since been changed (a cost was edited, or a claim cancelled), so it can't be re-applied automatically.", 'cannot_reapply');
      await setPaid(conn, a.claim_id, a.category, round2(Number(cc.paid) - Number(a.amount)), cc.cost);
      g.set(key(a), round2((g.get(key(a)) || 0) + Number(a.amount))); inf.set(key(a), { handle: a.handle, claimId: a.claim_id, label: a.label, category: a.category, shop: a.leftover_item_id });
      applied = round2(applied + Number(a.amount));
    }
    await conn.query('DELETE FROM payment_allocations WHERE payment_id = ?', [p.id]);
    const left = await distribute(conn, p.joiner_id, p.order_id, applied, p.id);                                       // 2. put the same money where it goes NOW
    if (left > 0.004) throw conflict("Part of what this payment paid can no longer be placed on anything they owe, so it can't be re-applied automatically.", 'cannot_reapply');
    const [now] = await conn.query('SELECT pa.claim_id, pa.category, pa.amount, c.label, c.leftover_item_id, j.instagram_handle AS handle FROM payment_allocations pa JOIN claims c ON c.id = pa.claim_id JOIN joiners j ON j.id = c.joiner_id WHERE pa.payment_id = ?', [p.id]);
    for (const a of now) { c.set(key(a), round2((c.get(key(a)) || 0) + Number(a.amount))); inf.set(key(a), { handle: a.handle, claimId: a.claim_id, label: a.label, category: a.category, shop: a.leftover_item_id }); }
    const same = g.size === c.size && [...g].every(([k, v]) => Math.abs((c.get(k) || 0) - v) < 0.005);
    if (same) { await conn.query('ROLLBACK TO SAVEPOINT reapply_one'); await conn.query('RELEASE SAVEPOINT reapply_one'); continue; }          // already where it belongs: leave every row exactly as it was
    await conn.query('RELEASE SAVEPOINT reapply_one');
    for (const [k, v] of g) gone.set(k, round2((gone.get(k) || 0) + v)); for (const [k, v] of c) came.set(k, round2((came.get(k) || 0) + v)); for (const [k, v] of inf) info.set(k, v);
  }
  const moves = [];
  for (const k of new Set([...gone.keys(), ...came.keys()])) {
    const delta = round2((came.get(k) || 0) - (gone.get(k) || 0)); if (Math.abs(delta) < 0.005) continue;
    const i = info.get(k); moves.push({ ...i, change: delta });
    if (delta < 0 && i.shop) { const [[cc]] = await conn.query("SELECT cost, paid FROM claim_costs WHERE claim_id = ? AND category = 'initials'", [i.claimId]); if (cc && Number(cc.paid) + 0.004 < Number(cc.cost)) await unreadyShopClaim(conn, { claim_id: i.claimId, leftover_item_id: i.shop }); }
  }
  moves.sort((a, b) => (a.change < 0 ? 0 : 1) - (b.change < 0 ? 0 : 1) || (a.change < 0 ? a.change - b.change : a.claimId - b.claimId));          // what loses money first, then what gains (in the order it is paid)
  const total = round2(pays.reduce((n, p) => n + Number(p.amount), 0));
  return { payments: pays.map((p) => ({ id: p.id, amount: Number(p.amount) })), total, changed: moves.length > 0, movedTotal: round2(moves.filter((m) => m.change > 0).reduce((n, m) => n + m.change, 0)), moves: moves.map(({ shop, ...m }) => m) };
}
