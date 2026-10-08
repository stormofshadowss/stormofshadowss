import { bad, conflict, notFound } from '../errors.js';
import { lockJoiner } from './ledger.js';
import { cancelClaim } from './cancel.js';
import { placeSetParts } from './sets.js';

// Fixed claims: a regular's standing claim on one member of a set item. It's a reserved part: placed in the earliest set that is
// still undecided and has that part free, so two people fixed on the same member land in different sets, and fixed claimers on other
// members fill those same early sets. The reserved part is simply a held part, so everybody else's claims skip it automatically.

// The caller has locked the item row (so placement is serialised, exactly as for ordinary set claims).
export async function addFixed(conn, { itemId, joinerId, member }) {
  const [[item]] = await conn.query('SELECT id, order_id, item_type, title, price, price_tbc, size_bucket FROM items WHERE id = ?', [itemId]);
  if (!item) throw notFound('No such item');
  if (item.item_type !== 'set') throw bad('Fixed claims only apply to member sets', 'not_a_set');
  const [[known]] = await conn.query('SELECT 1 AS x FROM item_members WHERE item_id = ? AND name = ?', [itemId, member]);
  if (!known) throw bad(`"${member}" isn't part of "${item.title}"`);
  const [dup] = await conn.query('SELECT 1 FROM fixed_claims WHERE item_id = ? AND joiner_id = ? AND member_name = ? AND ended_at IS NULL', [itemId, joinerId, member]);
  if (dup.length) throw conflict(`They already have a fixed claim on ${member} for this item`, 'already_fixed');
  const [placed] = await placeSetParts(conn, { joinerId, item, qtyByMember: { [member]: 1 }, together: false, fixed: true });
  const [f] = await conn.query('INSERT INTO fixed_claims (item_id, joiner_id, member_name, set_id) VALUES (?,?,?,?)', [itemId, joinerId, member, placed.setId]);
  return { fixedId: f.insertId, setNumber: placed.setNumber, claimId: placed.claimId };
}

// Ends a fixed claim: its claim is cancelled (anything paid returns as credit, or is forfeited for a blocked handle) and the part reopens.
export async function removeFixed(conn, fixedId, via, reason = 'Fixed claim removed') {
  const [[f0]] = await conn.query('SELECT id, joiner_id FROM fixed_claims WHERE id = ?', [fixedId]);
  if (!f0) throw notFound('No such fixed claim');
  await lockJoiner(conn, f0.joiner_id);
  const [[f]] = await conn.query('SELECT * FROM fixed_claims WHERE id = ? FOR UPDATE', [fixedId]);
  if (f.ended_at) throw conflict('That fixed claim has already ended', 'fixed_ended');
  const [[claim]] = await conn.query(
    'SELECT id FROM claims WHERE set_id = ? AND member_name = ? AND joiner_id = ? AND is_fixed = 1 AND status <> \'cancelled\' LIMIT 1', [f.set_id, f.member_name, f.joiner_id]);
  const r = claim ? await cancelClaim(conn, claim.id, reason) : { refunded: 0, forfeited: 0 };
  await conn.query('UPDATE fixed_claims SET ended_at = NOW(3), ended_via = ? WHERE id = ?', [via, fixedId]);
  return { refunded: r.refunded, forfeited: r.forfeited, member: f.member_name, setId: f.set_id, itemId: f.item_id, joinerId: f.joiner_id };
}

// "Give it up" or "swap to the full set". Swapping removes the fixed claim, then takes one of EVERY part together in one set —
// the first undecided set where they're all free (so possibly the very set they were fixed in), or a new one.
export async function changeFixed(conn, fixedId, action) {
  const [[f0]] = await conn.query('SELECT item_id, set_id FROM fixed_claims WHERE id = ?', [fixedId]);
  if (!f0) throw notFound('No such fixed claim');
  await conn.query('SELECT id FROM items WHERE id = ? FOR UPDATE', [f0.item_id]);       // the item first, then the person: the order every placement uses
  const removed = await removeFixed(conn, fixedId, action === 'ot8' ? 'ot8' : 'giveup', action === 'ot8' ? 'Swapped to the full set' : 'Fixed claim given up');
  if (action !== 'ot8') return { action, setNumber: null, slotOpened: true, ...removed };
  const [[item]] = await conn.query('SELECT id, order_id, title, price, price_tbc, size_bucket FROM items WHERE id = ?', [f0.item_id]);
  const [members] = await conn.query('SELECT name FROM item_members WHERE item_id = ? ORDER BY sort_order, id', [f0.item_id]);
  const placed = await placeSetParts(conn, { joinerId: removed.joinerId, item, qtyByMember: Object.fromEntries(members.map((m) => [m.name, 1])), together: true });
  return { action, setNumber: placed[0].setNumber, slotOpened: placed[0].setId !== f0.set_id, ...removed };
}
