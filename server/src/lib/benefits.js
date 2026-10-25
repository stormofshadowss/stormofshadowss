import { round2 } from './money.js';

// PURCHASE BENEFITS: who qualifies for an offer ("spend £X on these items, get N bonus copies — repeating"), worked out from the database every time.
// A PERSON is all of an account's handles together (a person with several handles is one person); spend = the ITEM COST (not postage or fees) of their SECURED claims on the ticked items.
// Entitled = whole multiples of the amount × the quantity. Given = the bonus claims already added for this offer that are not cancelled. The bonus is added to the handle that spent most.
const cents = (n) => Math.round(Number(n) * 100);

export async function benefitStatus(conn, offerId) {
  const [[o]] = await conn.query('SELECT o.id, o.order_id AS orderId, o.title, o.spend_threshold AS threshold, o.quantity, o.bonus_item_id AS bonusItemId, bi.title AS bonusTitle, bi.hidden_from_public AS bonusHidden FROM benefit_offers o JOIN items bi ON bi.id = o.bonus_item_id WHERE o.id = ?', [offerId]);
  if (!o) return null;
  const thresholdC = cents(o.threshold);
  const [spend] = await conn.query(
    `SELECT c.joiner_id AS joinerId, SUM(cc.cost) AS spend FROM claims c JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category = 'initials'
       JOIN benefit_offer_items oi ON oi.item_id = c.item_id AND oi.offer_id = ? WHERE c.status = 'confirmed' GROUP BY c.joiner_id`, [offerId]);
  const [given] = await conn.query("SELECT joiner_id AS joinerId, COUNT(*) AS n FROM claims WHERE benefit_offer_id = ? AND status <> 'cancelled' GROUP BY joiner_id", [offerId]);
  const ids = [...new Set([...spend.map((r) => r.joinerId), ...given.map((r) => r.joinerId)])];
  const people = [];
  if (ids.length) {
    const [js] = await conn.query('SELECT id, instagram_handle AS handle, account_id AS accountId, is_blocked AS blocked FROM joiners WHERE id IN (?)', [ids]);
    const by = new Map();
    for (const j of js) { const key = j.accountId ? `a${j.accountId}` : `j${j.id}`; if (!by.has(key)) by.set(key, []); by.get(key).push(j); }
    for (const [key, hs] of by) {
      const spendOf = (j) => cents(spend.find((r) => r.joinerId === j.id)?.spend || 0), givenOf = (j) => Number(given.find((r) => r.joinerId === j.id)?.n || 0);
      const totalC = hs.reduce((n, j) => n + spendOf(j), 0), givenN = hs.reduce((n, j) => n + givenOf(j), 0);
      const target = [...hs].sort((a, b) => spendOf(b) - spendOf(a) || a.id - b.id)[0];                      // the bonus goes to the handle that spent most (ties: the oldest handle)
      const multiples = Math.floor(totalC / thresholdC), entitled = multiples * o.quantity;
      people.push({
        key, handles: [...hs].sort((a, b) => spendOf(b) - spendOf(a) || a.id - b.id).map((j) => j.handle), intoHandle: target.handle, intoId: target.id, blocked: !!target.blocked,
        spend: round2(totalC / 100), multiples, entitled, given: givenN, toAdd: Math.max(0, entitled - givenN), over: Math.max(0, givenN - entitled), toGo: round2((thresholdC - (totalC % thresholdC)) / 100),
      });
    }
  }
  people.sort((a, b) => b.toAdd - a.toAdd || b.over - a.over || b.spend - a.spend || a.intoHandle.localeCompare(b.intoHandle));
  return { offer: { id: o.id, orderId: o.orderId, title: o.title, threshold: Number(o.threshold), quantity: o.quantity, bonusItemId: o.bonusItemId, bonusTitle: o.bonusTitle, bonusHidden: !!o.bonusHidden }, people,
    totals: { qualifying: people.filter((p) => p.toAdd > 0).length, toAdd: people.reduce((n, p) => n + p.toAdd, 0), over: people.filter((p) => p.over > 0).length } };
}
