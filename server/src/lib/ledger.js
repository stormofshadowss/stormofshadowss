// The money core. Everything here takes a connection that is ALREADY inside a
// transaction, and every flow locks the joiner's row first — so two things
// touching the same person's money (a payment being verified while credit is
// auto-applied, say) wait for each other instead of double-spending.
import { CATS, round2 } from './money.js';

// Locking a person's handle locks ALL of that person's handles (lowest id first, so no two flows can wait on each other in a circle): their handles share credit, so two things
// touching any of them must wait for each other.
export async function lockJoiner(conn, joinerId) {
  const [[j]] = await conn.query('SELECT account_id FROM joiners WHERE id = ?', [joinerId]);
  return conn.query('SELECT id FROM joiners WHERE id = ? OR (account_id IS NOT NULL AND account_id = ?) ORDER BY id FOR UPDATE', [joinerId, j?.account_id ?? null]);
}

// The person's OTHER handles (not blocked, not deleted), lowest id first.
export async function siblingsOf(conn, joinerId) {
  const [[j]] = await conn.query('SELECT account_id FROM joiners WHERE id = ?', [joinerId]);
  if (!j?.account_id) return [];
  const [rows] = await conn.query('SELECT id, instagram_handle AS handle FROM joiners WHERE account_id = ? AND id <> ? AND is_blocked = 0 AND account_deleted_at IS NULL ORDER BY id', [j.account_id, joinerId]);
  return rows;
}

export async function creditBalance(conn, joinerId) {
  const [[r]] = await conn.query('SELECT COALESCE(SUM(balance_effect), 0) AS b FROM credit_ledger WHERE joiner_id = ?', [joinerId]);
  return round2(r.b);
}

// Cost lines still owing on a joiner's confirmed claims: oldest claim first,
// Initials -> EMS -> Customs -> Doms. Locked for the rest of the transaction.
export async function owingLines(conn, joinerId, orderId = null) {
  const params = [joinerId];
  let scope = '';
  if (orderId) { scope = 'AND c.order_id = ?'; params.push(orderId); }
  const [rows] = await conn.query(
    `SELECT cc.claim_id, cc.category, cc.cost, cc.paid
       FROM claim_costs cc JOIN claims c ON c.id = cc.claim_id
      WHERE c.joiner_id = ? AND c.status = 'confirmed' ${scope} AND cc.cost > cc.paid
      ORDER BY c.id, FIELD(cc.category, 'initials', 'ems', 'customs', 'doms', 'packaging')
      FOR UPDATE`, params);
  return rows;
}

export async function owedInScope(conn, joinerId, orderId = null) {
  const params = [joinerId];
  let scope = '';
  if (orderId) { scope = 'AND c.order_id = ?'; params.push(orderId); }
  const [[r]] = await conn.query(
    `SELECT COALESCE(SUM(cc.cost - cc.paid), 0) AS owed
       FROM claim_costs cc JOIN claims c ON c.id = cc.claim_id
      WHERE c.joiner_id = ? AND c.status = 'confirmed' ${scope} AND cc.cost > cc.paid`, params);
  return round2(r.owed);
}

async function setPaid(conn, claimId, category, newPaid, cost) {
  const fully = cost > 0 && newPaid >= cost - 0.0001;
  await conn.query(
    'UPDATE claim_costs SET paid = ?, paid_date = IF(?, COALESCE(paid_date, CURDATE()), NULL) WHERE claim_id = ? AND category = ?',
    [newPaid, fully ? 1 : 0, claimId, category]);
  // A shop (on hand) item is ready to pack the moment it's paid for — there's nothing left to wait for.
  if (fully && category === 'initials') {
    await conn.query(
      "UPDATE claims SET pipeline = 'ready to pack / on hand', ready_to_pack_date = COALESCE(ready_to_pack_date, CURDATE()) WHERE id = ? AND leftover_item_id IS NOT NULL AND status = 'confirmed' AND pipeline = 'awaiting fulfillment'", [claimId]);
  }
}

export async function addLedger(conn, e) {
  await conn.query(
    `INSERT INTO credit_ledger (joiner_id, kind, amount, balance_effect, reason, source, payment_id, claim_id, category)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [e.joinerId, e.kind, round2(e.amount), round2(e.effect), e.reason || null, e.source || null, e.paymentId || null, e.claimId || null, e.category || null]);
}

// Spends `amount` on what the joiner owes (inside one GO, or everything when
// orderId is null) and records exactly which lines it settled. Returns what's left.
export async function distribute(conn, joinerId, orderId, amount, paymentId) {
  let remaining = round2(amount);
  for (const line of await owingLines(conn, joinerId, orderId)) {
    if (remaining <= 0) break;
    const owed = round2(line.cost - line.paid);
    const applied = Math.min(remaining, owed);
    await setPaid(conn, line.claim_id, line.category, round2(line.paid + applied), line.cost);
    await conn.query('INSERT INTO payment_allocations (payment_id, claim_id, category, amount) VALUES (?,?,?,?)',
      [paymentId, line.claim_id, line.category, applied]);
    remaining = round2(remaining - applied);
  }
  return remaining;
}

// The JOINER chose credit or tip when they paid. If there's no choice on
// record (e.g. an amount typed in by hand), it defaults to credit — safe and
// reversible — rather than the GOM deciding for them.
export async function recordOverpayment(conn, { joinerId, amount, choice, note, source, paymentId = null }) {
  if (choice === 'tip') {
    await addLedger(conn, { joinerId, kind: 'tip', amount, effect: 0, reason: note ? `Tip: ${note}` : 'Tip', source, paymentId });
  } else {
    await addLedger(conn, {
      joinerId, kind: 'credit', amount, effect: amount, source, paymentId,
      reason: note || (choice ? null : "Joiner didn't choose — defaulted to credit"),
    });
  }
}

// Credit applies by itself to whatever is owing on confirmed claims — nobody
// has to decide where a joiner's money goes.
async function sweepOwn(conn, joinerId) {
  let balance = await creditBalance(conn, joinerId);
  if (balance <= 0) return 0;
  let used = 0;
  for (const line of await owingLines(conn, joinerId)) {
    if (balance <= 0) break;
    const owed = round2(line.cost - line.paid);
    const applied = Math.min(balance, owed);
    await setPaid(conn, line.claim_id, line.category, round2(line.paid + applied), line.cost);
    await addLedger(conn, { joinerId, kind: 'applied', amount: applied, effect: -applied, source: 'auto-applied', claimId: line.claim_id, category: line.category });
    balance = round2(balance - applied);
    used = round2(used + applied);
  }
  return used;
}

// Move credit from one of a person's handles to another (a matching pair of entries, so each handle's own books balance).
async function moveCredit(conn, from, to, amount) {
  await addLedger(conn, { joinerId: from.id, kind: 'transfer_out', amount, effect: -amount, reason: `Credit moved to @${to.handle} to pay for their items`, source: 'moved between handles' });
  await addLedger(conn, { joinerId: to.id, kind: 'transfer_in', amount, effect: amount, reason: `Credit moved from @${from.handle}`, source: 'moved between handles' });
}

// A person's handles share their credit. Credit applies to what its own handle owes first (as always); then what is STILL owing is paid from their other handles' credit,
// and any credit left over goes to what their other handles owe. (Blocked or deleted handles are left out.)
export async function sweepCredit(conn, joinerId) {
  let used = await sweepOwn(conn, joinerId);
  const sibs = await siblingsOf(conn, joinerId);
  if (!sibs.length) return used;
  const [[me]] = await conn.query('SELECT id, instagram_handle AS handle FROM joiners WHERE id = ?', [joinerId]);
  let need = await owedInScope(conn, joinerId);
  for (const s of sibs) {                                                          // 1. still owing here → pull in credit held on their other handles
    if (need <= 0.004) break;
    const bal = await creditBalance(conn, s.id); if (bal <= 0.004) continue;
    const x = Math.min(bal, need); await moveCredit(conn, s, me, x); need = round2(need - x);
  }
  used = round2(used + await sweepOwn(conn, joinerId));
  let left = await creditBalance(conn, joinerId);
  for (const s of sibs) {                                                          // 2. credit left over → pay what their other handles owe
    if (left <= 0.004) break;
    const owes = await owedInScope(conn, s.id); if (owes <= 0.004) continue;
    const x = Math.min(left, owes); await moveCredit(conn, me, s, x); left = round2(left - x); await sweepOwn(conn, s.id);
  }
  return used;
}

// GOM edits a cost line (e.g. an exchange-rate adjustment) and/or its paid
// amount. Changing the COST never touches what's already been paid — it just
// changes what's left. A paid amount above the cost becomes credit.
export async function setCost(conn, claimId, category, patch, source = 'Claims edit overpayment') {
  const [[c]] = await conn.query('SELECT joiner_id FROM claims WHERE id = ?', [claimId]);
  if (!c) return null;
  await lockJoiner(conn, c.joiner_id);
  const [[line]] = await conn.query('SELECT cost, paid FROM claim_costs WHERE claim_id = ? AND category = ? FOR UPDATE', [claimId, category]);
  const cost = patch.cost === undefined ? line.cost : round2(patch.cost);
  let paid = patch.paid === undefined ? line.paid : round2(patch.paid);
  if (cost > 0 && paid > cost) {
    await recordOverpayment(conn, { joinerId: c.joiner_id, amount: round2(paid - cost), choice: null, source });
    paid = cost;
  }
  await conn.query('UPDATE claim_costs SET cost = ? WHERE claim_id = ? AND category = ?', [cost, claimId, category]);
  await setPaid(conn, claimId, category, paid, cost);
  await sweepCredit(conn, c.joiner_id);
  return { claimId, category, cost, paid };
}

// Lowers a cost line. If more has already been paid than the new cost, the
// excess becomes credit instead of leaving the line overpaid. (Caller holds the joiner lock.)
export async function reduceCost(conn, joinerId, claimId, category, delta, reason, source) {
  const [[line]] = await conn.query('SELECT cost, paid FROM claim_costs WHERE claim_id = ? AND category = ? FOR UPDATE', [claimId, category]);
  const cost = Math.max(0, round2(line.cost - delta));
  let paid = line.paid;
  if (paid > cost) {
    await addLedger(conn, { joinerId, kind: 'credit', amount: round2(paid - cost), effect: round2(paid - cost), reason, source, claimId, category });
    paid = cost;
  }
  await conn.query('UPDATE claim_costs SET cost = ? WHERE claim_id = ? AND category = ?', [cost, claimId, category]);
  await setPaid(conn, claimId, category, paid, cost);
}

export async function addClaimCosts(conn, claimId, initials) {
  await conn.query('INSERT INTO claim_costs (claim_id, category, cost) VALUES ?', [CATS.map((cat) => [claimId, cat, cat === 'initials' ? round2(initials) : 0])]);
}
