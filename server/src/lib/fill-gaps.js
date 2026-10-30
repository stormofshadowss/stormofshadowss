import { audit } from '../auth.js';
import { lockJoiner, sweepCredit } from './ledger.js';

// FILL THE GAP. When someone drops out of an UNSECURED set, their part is a spot for a specific MEMBER (say Han). If a LATER set (also unsecured) has someone holding that same member, they move up into the spot — and
// that leaves a gap in THEIR set, which is filled the same way from the next set after it, and so on down the sets. Earlier sets fill first; the later sets are the ones left incomplete.
// The gap can be in an UNSECURED set or a SECURED one; the people who move always come from later UNSECURED sets (a person moved into a SECURED set is secured straight away, like "Add someone" — quietly, no email).
// Only an unsecured REQUEST moves: never a secured claim, a fixed claimer, anyone who asked to keep their parts together in one set (claims.keep_together), a claim with a cancel request waiting, or a blocked / deleted handle.
// Nothing about price or payment changes — it's the same claim in a different set (its "(Set N)" label follows). Quiet: nobody is emailed; it's recorded in the activity log.
export const relabelSet = (label, setNumber) => label.replace(/\(Set \d+\)$/, `(Set ${setNumber})`);

// itemId / setId / member: the spot that just became free. Run inside the cancel's transaction. Returns what moved: [{ claimId, handle, member, fromSet, toSet }].
export async function fillVacancy(conn, { itemId, setId, member, accountId = null }) {
  await conn.query('SELECT id FROM items WHERE id = ? FOR UPDATE', [itemId]);                                 // the item first, then its sets — the order every set action and placement uses
  const moves = [];
  let at = setId;
  for (let guard = 0; guard < 100; guard++) {
    const [[set]] = await conn.query('SELECT id, set_number AS setNumber, admin_decision AS decision FROM item_sets WHERE id = ? FOR UPDATE', [at]);
    if (!set || !['none', 'secured'].includes(set.decision)) break;                                          // a cancelled / split / otherwise decided set is left as it is
    const securedTarget = set.decision === 'secured';
    const [[taken]] = await conn.query('SELECT 1 AS x FROM set_slots WHERE set_id = ? AND member_name = ?', [at, member]);
    if (taken) break;                                                                                         // it is no longer vacant
    const [[next]] = await conn.query(
      `SELECT ss.id AS slotId, s.id AS setId, s.set_number AS setNumber, c.id AS claimId, c.joiner_id AS joinerId, c.label, j.instagram_handle AS handle
         FROM set_slots ss JOIN item_sets s ON s.id = ss.set_id JOIN claims c ON c.slot_id = ss.id JOIN joiners j ON j.id = c.joiner_id
        WHERE s.item_id = ? AND s.set_number > ? AND s.admin_decision = 'none' AND ss.member_name = ? AND ss.joiner_id IS NOT NULL AND ss.is_fixed = 0
          AND c.status = 'requested' AND c.is_fixed = 0 AND c.keep_together = 0 AND j.is_blocked = 0 AND j.account_deleted_at IS NULL
          AND (? = 0 OR c.price_tbc = 0)                                                                      -- a claim whose price is still TBC can't be secured, so it can't move into a secured set
          AND NOT EXISTS (SELECT 1 FROM cancel_requests cr WHERE cr.claim_id = c.id AND cr.status = 'pending')
        ORDER BY s.set_number, ss.id LIMIT 1 FOR UPDATE`, [itemId, set.setNumber, member, securedTarget ? 1 : 0]);
    if (!next) break;                                                                                         // nobody later can move up: the spot stays open
    await conn.query('UPDATE set_slots SET set_id = ? WHERE id = ?', [at, next.slotId]);                      // the same slot (and claim) now sits in the earlier set
    await conn.query('UPDATE claims SET set_id = ?, label = ? WHERE id = ?', [at, relabelSet(next.label, set.setNumber), next.claimId]);
    if (securedTarget) { await lockJoiner(conn, next.joinerId); await conn.query("UPDATE claims SET status = 'confirmed' WHERE id = ?", [next.claimId]); await sweepCredit(conn, next.joinerId); }          // secured straight away, as "Add someone" does
    moves.push({ claimId: next.claimId, handle: next.handle, member, fromSet: next.setNumber, toSet: set.setNumber, secured: securedTarget });
    await audit(conn, accountId, 'set.fill_gap', 'item', itemId, { claimId: next.claimId, handle: next.handle, member, fromSet: next.setNumber, toSet: set.setNumber, secured: securedTarget });
    at = next.setId;                                                                                          // …and now THEIR old set has the gap
  }
  return moves;
}

// FILL EVERY EXISTING GAP (the "Fill gaps" button): for each member set item, go through its sets from the first, and fill every open spot the same way a drop-out would (so the gap cascades down).
// Items in a cancelled or archived group order are left alone. Returns every move, with the item and group order it belongs to.
export async function fillAllGaps(conn, { accountId = null } = {}) {
  const [items] = await conn.query(
    `SELECT i.id, i.title, o.title AS orderTitle FROM items i JOIN group_orders o ON o.id = i.order_id
      WHERE i.item_type = 'set' AND i.cancelled_at IS NULL AND o.cancelled_at IS NULL AND o.archived_at IS NULL AND EXISTS (SELECT 1 FROM item_sets s WHERE s.item_id = i.id) ORDER BY i.id`);
  const all = [];
  for (const item of items) {
    const [members] = await conn.query('SELECT name FROM item_members WHERE item_id = ? ORDER BY sort_order, id', [item.id]);
    const [sets] = await conn.query('SELECT id FROM item_sets WHERE item_id = ? ORDER BY set_number', [item.id]);
    for (const set of sets) {
      for (const m of members) {
        const [[taken]] = await conn.query('SELECT 1 AS x FROM set_slots WHERE set_id = ? AND member_name = ?', [set.id, m.name]);
        if (taken) continue;
        for (const mv of await fillVacancy(conn, { itemId: item.id, setId: set.id, member: m.name, accountId })) all.push({ ...mv, itemId: item.id, itemTitle: item.title, orderTitle: item.orderTitle });
      }
    }
  }
  return all;
}
