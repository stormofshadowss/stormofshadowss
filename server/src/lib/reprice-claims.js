import { bad, notFound, conflict } from '../errors.js';
import { lockJoiner, setCost, sweepCredit } from './ledger.js';
import { round2 } from './money.js';

const gbp = (n) => `£${Number(n).toFixed(2)}`;

// CHANGE THE PRICE OF SEVERAL CLAIMS AT ONCE (e.g. last-minute service fees were found after a set was secured): mode 'set' makes each claim's ITEM COST the amount; mode 'adjust' adds the amount (negative takes some off).
// It changes the claims' own item cost only (fees such as EMS / customs are untouched) and NOT the item's price for future claims. Whatever stage a claim is at. It uses the same cost change as editing one claim: anyone who has already
// paid more than the new cost has the difference returned as credit; anyone who has paid less simply owes more. All or nothing: if any claim can't be changed (cancelled, would go below £0, a TBC price in 'adjust' mode) nothing is.
// Run it inside a transaction (the preview runs it and rolls it back, so a preview can't disagree with what then happens).
export async function changeClaimPrices(conn, { claimIds, mode, amount }) {
  const ids = [...new Set(claimIds)].sort((a, b) => a - b);
  const [who] = await conn.query('SELECT DISTINCT joiner_id FROM claims WHERE id IN (?) ORDER BY joiner_id', [ids]);
  for (const { joiner_id } of who) await lockJoiner(conn, joiner_id);                                        // the people first, lowest id first — the order every money flow uses
  const [rows] = await conn.query(
    `SELECT c.id, c.joiner_id AS joinerId, c.label, c.status, c.pipeline, c.price_tbc AS tbc, j.instagram_handle AS handle, cc.cost, cc.paid
       FROM claims c JOIN joiners j ON j.id = c.joiner_id JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category = 'initials' WHERE c.id IN (?) ORDER BY c.id FOR UPDATE`, [ids]);
  if (rows.length !== ids.length) throw notFound("One of those claims doesn't exist");
  const cancelled = rows.filter((r) => r.status === 'cancelled'); if (cancelled.length) throw conflict(`Cancelled claims can't be re-priced: ${cancelled.slice(0, 3).map((r) => `@${r.handle} — ${r.label}`).join(', ')}${cancelled.length > 3 ? '…' : ''}`, 'claim_cancelled');
  const changes = []; let unchanged = 0;
  for (const r of rows) {
    const from = Number(r.cost), paid = Number(r.paid);
    if (mode === 'adjust' && r.tbc) throw bad(`“${r.label}” (@${r.handle}) is still price TBC, so there's no price to add to — use “Set a new price” for those.`, 'tbc_claim');
    const to = mode === 'set' ? round2(amount) : round2(from + amount);
    if (to < 0) throw bad(`That would take “${r.label}” (@${r.handle}) below £0 (it is ${gbp(from)} now).`, 'negative_price');
    if (to === from && !(mode === 'set' && r.tbc)) { unchanged += 1; continue; }
    await setCost(conn, r.id, 'initials', { cost: to }, 'Price change');                                       // anything paid beyond the new cost becomes credit
    if (r.tbc) await conn.query('UPDATE claims SET price_tbc = 0 WHERE id = ?', [r.id]);                       // it has a price now
    changes.push({ claimId: r.id, joinerId: r.joinerId, handle: r.handle, label: r.label, status: r.status, pipeline: r.pipeline, from, to, diff: round2(to - from), paid, creditBack: round2(Math.max(0, paid - to)) });
  }
  for (const jid of [...new Set(changes.map((c) => c.joinerId))].sort((a, b) => a - b)) await sweepCredit(conn, jid);   // credit they already had meets what they now owe
  return { changes, unchanged, total: round2(changes.reduce((s, c) => s + c.diff, 0)), people: new Set(changes.map((c) => c.joinerId)).size };
}
