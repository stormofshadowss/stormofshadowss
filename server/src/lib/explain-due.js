import { daysBetweenYMD } from './due.js';
import { CATS, round2 } from './money.js';
import { creditBalance } from './ledger.js';
import { ukDate } from './closing.js';

// "What is due and why" for the GOM, when a joiner questions what their dashboard shows. It is worked out from the SAME rules and numbers the dashboard uses (confirmed claims only; a cost line's
// owed = cost − paid; overdue = owed and past the pay-by date), and it says in plain words what is NOT counted (requests, payments still waiting, failed or rejected payments) and why.
const money = (n) => `£${Number(n).toFixed(2)}`;
const LABEL = { initials: 'item cost', ems: 'EMS', customs: 'customs', doms: 'postage', packaging: 'packaging' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const dayWord = (n) => (n === 0 ? 'today' : n === 1 ? '1 day ago' : `${n} days ago`);

export async function explainDue(pool, handle) {
  const [[j]] = await pool.query('SELECT id, instagram_handle AS handle, account_id AS accountId, is_blocked AS blocked FROM joiners WHERE instagram_handle = ?', [handle]);
  if (!j) return null;
  const [people] = j.accountId
    ? (await pool.query('SELECT id, instagram_handle AS handle, is_blocked AS blocked FROM joiners WHERE account_id = ? AND account_deleted_at IS NULL ORDER BY id', [j.accountId]))
    : [[{ id: j.id, handle: j.handle, blocked: j.blocked }]];
  const ids = people.map((p) => p.id), many = people.length > 1, nameOf = new Map(people.map((p) => [p.id, p.handle]));
  const [[acct]] = j.accountId ? await pool.query('SELECT email FROM accounts WHERE id = ?', [j.accountId]) : [[null]];
  const [[{ today }]] = await pool.query('SELECT CURDATE() AS today');

  const [claims] = await pool.query(
    `SELECT c.id, c.joiner_id AS joinerId, c.label, c.status, c.order_id AS orderId, go.title AS orderTitle, COALESCE(c.pay_by, i.payment_deadline, go.payment_deadline) AS payBy,
            DATEDIFF(CURDATE(), COALESCE(c.pay_by, i.payment_deadline, go.payment_deadline)) AS daysLate
       FROM claims c LEFT JOIN group_orders go ON go.id = c.order_id LEFT JOIN items i ON i.id = c.item_id WHERE c.joiner_id IN (?) AND c.status <> 'cancelled' ORDER BY c.id`, [ids]);
  const costs = claims.length ? (await pool.query('SELECT claim_id AS claimId, category, cost, paid, due_date AS dueDate FROM claim_costs WHERE claim_id IN (?)', [claims.map((c) => c.id)]))[0] : [];
  const byCat = Object.fromEntries(CATS.map((c) => [c, 0]));
  const items = [], handleTotals = new Map(people.map((p) => [p.id, { handle: p.handle, owed: 0, paid: 0 }]));
  let requested = { count: 0, total: 0 };
  for (const c of claims) {
    const lines = Object.fromEntries(costs.filter((x) => x.claimId === c.id).map((x) => [x.category, { cost: Number(x.cost), paid: Number(x.paid), due: x.category === 'initials' ? (c.payBy ? String(c.payBy).slice(0, 10) : null) : (x.dueDate ? String(x.dueDate).slice(0, 10) : null) }]));          // each line's own due date
    if (c.status !== 'confirmed') { requested.count += 1; requested.total = round2(requested.total + (lines.initials?.cost || 0)); continue; }
    const owedBy = Object.fromEntries(CATS.map((k) => [k, round2(Math.max(0, (lines[k]?.cost || 0) - (lines[k]?.paid || 0)))]));
    const owed = round2(CATS.reduce((n, k) => n + owedBy[k], 0)), paid = round2(CATS.reduce((n, k) => n + (lines[k]?.paid || 0), 0));
    handleTotals.get(c.joinerId).paid = round2(handleTotals.get(c.joinerId).paid + paid);
    if (owed <= 0.004) continue;
    for (const k of CATS) byCat[k] = round2(byCat[k] + owedBy[k]);
    handleTotals.get(c.joinerId).owed = round2(handleTotals.get(c.joinerId).owed + owed);
    // overdue LINE by LINE: a fee has its own due date, so one added today is not overdue because of an old item date
    const todayStr = String(today).slice(0, 10), lateCats = CATS.filter((k) => owedBy[k] > 0.004 && lines[k]?.due && lines[k].due < todayStr);
    const overdueOwed = round2(lateCats.reduce((n, k) => n + owedBy[k], 0)), overdue = overdueOwed > 0;
    const dues = CATS.filter((k) => owedBy[k] > 0.004 && lines[k]?.due).map((k) => lines[k].due).sort(), lateDues = lateCats.map((k) => lines[k].due).sort();
    items.push({ claimId: c.id, handle: nameOf.get(c.joinerId), label: c.label, order: c.orderTitle || 'Shop (on hand)', owedBy, owed, paid, payBy: lateDues[0] || dues[0] || null, overdue, overdueOwed, daysLate: overdue ? daysBetweenYMD(lateDues[0], todayStr) : 0 });
  }
  const owedTotal = round2(items.reduce((n, i) => n + i.owed, 0)), overdueItems = items.filter((i) => i.overdue), overdueTotal = round2(overdueItems.reduce((n, i) => n + i.overdueOwed, 0));

  const [pays] = await pool.query('SELECT id, joiner_id AS joinerId, amount, method, reference, status, created_at AS createdAt, reversed_at AS reversedAt, reverse_reason AS reason, batch_key AS batchKey FROM payments WHERE joiner_id IN (?) ORDER BY id DESC LIMIT 60', [ids]);
  const day = (v) => String(v).slice(0, 10), pay = (p) => ({ id: p.id, handle: nameOf.get(p.joinerId), amount: Number(p.amount), method: p.method, reference: p.reference || null, status: p.status, date: day(p.createdAt), reversedDate: p.reversedAt ? day(p.reversedAt) : null, reason: p.reason || null });
  const waiting = pays.filter((p) => p.status === 'pending').map(pay), failed = pays.filter((p) => p.status === 'reversed').slice(0, 5).map(pay), rejected = pays.filter((p) => p.status === 'rejected').slice(0, 5).map(pay), recent = pays.filter((p) => p.status === 'confirmed').slice(0, 5).map(pay);
  const waitingTotal = round2(waiting.reduce((n, p) => n + p.amount, 0));
  const credit = []; for (const p of people) credit.push({ handle: p.handle, balance: await creditBalance(pool, p.id) });
  const creditTotal = round2(credit.reduce((n, c) => n + c.balance, 0));
  const [ledger] = await pool.query('SELECT joiner_id AS joinerId, kind, amount, balance_effect AS effect, reason, created_at AS createdAt FROM credit_ledger WHERE joiner_id IN (?) ORDER BY id DESC LIMIT 8', [ids]);

  // ── the plain-words explanation ──
  const who = many ? 'Across their handles they owe' : `@${j.handle} owes`, lines = [];
  const orders = [...new Set(items.map((i) => i.order))];
  lines.push(owedTotal > 0 ? `${who} ${money(owedTotal)} now, across ${plural(items.length, 'item', 'items')} on ${plural(orders.length, 'group order', 'group orders')}.` : `${many ? 'They owe' : `@${j.handle} owes`} nothing right now.`);
  if (owedTotal > 0) {
    const parts = CATS.filter((k) => byCat[k] > 0.004).map((k) => `${money(byCat[k])} ${LABEL[k]}`);
    if (parts.length > 1) lines.push(`That is made up of ${parts.join(', ')}.`);
    if (overdueItems.length) {
      for (const o of [...new Set(overdueItems.map((i) => i.order))]) {
        const mine = overdueItems.filter((i) => i.order === o), late = Math.max(...mine.map((i) => i.daysLate));
        lines.push(`${money(round2(mine.reduce((n, i) => n + i.overdueOwed, 0)))} is overdue on “${o}”: it was due ${ukDate(mine[0].payBy)} (${dayWord(late)}).`);
      }
    } else {
      const next = items.filter((i) => i.payBy).map((i) => i.payBy).sort()[0];
      lines.push(next ? `Nothing is overdue yet — the earliest due date is ${ukDate(next)}.` : 'Nothing is overdue — none of it has a due date.');
    }
  }
  for (const p of waiting) lines.push(`A ${money(p.amount)} payment sent ${ukDate(p.date)} (${p.method}${p.reference ? `, ref ${p.reference}` : ''}) is still waiting for you to verify, so it is NOT counted yet.`);
  if (waiting.length && owedTotal > 0) lines.push(`Once ${waiting.length === 1 ? 'it is' : 'they are'} verified they would owe about ${money(Math.max(0, round2(owedTotal - waitingTotal)))}.`);
  for (const p of failed) lines.push(`A ${money(p.amount)} payment from ${ukDate(p.date)} was marked as failed on ${ukDate(p.reversedDate)}${p.reason ? ` (${p.reason})` : ''} — what it paid is owed again.`);
  for (const p of rejected) lines.push(`A ${money(p.amount)} payment from ${ukDate(p.date)} was rejected, so it was never counted.`);
  if (creditTotal > 0.004) lines.push(`${money(creditTotal)} credit is held${many ? ` (${credit.filter((c) => c.balance > 0.004).map((c) => `@${c.handle} ${money(c.balance)}`).join(', ')})` : ''} — it is applied automatically to anything they owe.`);
  if (requested.count) lines.push(`${plural(requested.count, 'item', 'items')} they have only requested (${money(requested.total)}) ${requested.count === 1 ? "isn't" : "aren't"} owed yet — a request only counts once you've secured it.`);
  const blocked = people.filter((p) => p.blocked); if (blocked.length) lines.push(`${blocked.map((p) => `@${p.handle}`).join(', ')} ${blocked.length === 1 ? 'is' : 'are'} blocked.`);
  if (!j.accountId) lines.push("They haven't signed in yet, so there is no dashboard to view — this is what they would see.");

  return {
    handle: j.handle, accountId: j.accountId || null, email: acct?.email || null, handles: people.map((p) => ({ handle: p.handle, blocked: !!p.blocked })), many,
    owedTotal, overdueTotal, byCategory: byCat, perHandle: [...handleTotals.values()].map((h) => ({ ...h, credit: credit.find((c) => c.handle === h.handle)?.balance || 0 })),
    items, requested, payments: { waiting, failed, rejected, recent }, credit: { total: creditTotal, byHandle: credit, recent: ledger.map((l) => ({ handle: nameOf.get(l.joinerId), kind: l.kind, amount: Number(l.amount), effect: Number(l.effect), reason: l.reason || null, date: day(l.createdAt) })) }, explanation: lines,
  };
}
