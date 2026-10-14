import { bad, notFound } from '../errors.js';
import { addClaimCosts } from './ledger.js';
import { placeSetParts } from './sets.js';

// Making claims for ITEMS of a group order — one place, used both by a joiner claiming for themselves and by the GOM adding a claim for someone.
// The only difference is `asAdmin`: the GOM may add to a PRIVATE group order and to one that has CLOSED (a joiner may do neither).

// Lock every item a request names (lowest id first, so two requests can never wait on each other in a circle). That also stops a price edit
// from landing between us reading the price and saving the claim — an unsecured claim must always carry the price listed at the time.
export async function lockLineItems(conn, lines) {
  const lockIds = [...new Set(lines.filter((l) => l.itemId).map((l) => l.itemId))].sort((x, y) => x - y);
  if (lockIds.length) await conn.query('SELECT id FROM items WHERE id IN (?) ORDER BY id FOR UPDATE', [lockIds]);
}

// Place one item line (not a shop item) for a joiner: returns the new claim ids, and where member-set parts went.
export async function placeItemLine(conn, { joinerId, line, asAdmin = false }) {
  const ids = [], placements = [];
  const [[item]] = await conn.query(
    `SELECT i.id, i.order_id, i.item_type, i.title, i.price, i.price_tbc, i.size_bucket, i.cancelled_at, go.status, go.is_private
       FROM items i JOIN group_orders go ON go.id = i.order_id WHERE i.id = ?`, [line.itemId]);
  // Private orders look exactly like orders that don't exist.
  if (!item || (item.is_private && !asAdmin)) throw notFound('That item isn\'t available');
  if (item.status !== 'open' && !asAdmin) throw bad('That order has closed', 'order_closed');
  if (item.cancelled_at) throw bad("That item isn't available any more", 'item_cancelled');
  if (item.item_type === 'set') {
    const asked = {};
    for (const p of line.parts || []) asked[p.member] = (asked[p.member] || 0) + p.qty;
    if (!Object.keys(asked).length) throw bad(`Choose at least one part of "${item.title}"`);
    const [roster] = await conn.query('SELECT name FROM item_members WHERE item_id = ?', [item.id]);
    const known = new Set(roster.map((r) => r.name));
    for (const m of Object.keys(asked)) if (!known.has(m)) throw bad(`"${m}" isn't part of "${item.title}"`);
    if (Object.values(asked).some((n) => n > 20)) throw bad('That\'s more of one part than we can take in one go');
    for (const p of await placeSetParts(conn, { joinerId, item, qtyByMember: asked, together: !!line.together })) { ids.push(p.claimId); placements.push(p); }
    return { ids, placements };
  }
  let member = null, variant = null;
  if (item.item_type === 'independent') {
    const [[m]] = await conn.query('SELECT name FROM item_members WHERE item_id = ? AND name = ?', [item.id, line.member || '']);
    if (!m) throw bad(`Choose a member for "${item.title}"`);
    member = m.name;
  } else if (item.item_type === 'size') {
    const [[v]] = await conn.query('SELECT label FROM item_variants WHERE item_id = ? AND label = ?', [item.id, line.variant || '']);
    if (!v) throw bad(`Choose a size for "${item.title}"`);
    variant = v.label;
  }
  const label = `${item.title}${member ? ` — ${member}` : ''}${variant ? ` (${variant})` : ''}`;
  for (let n = 0; n < (line.qty || 1); n++) {
    const [r] = await conn.query(
      `INSERT INTO claims (joiner_id, order_id, item_id, label, member_name, variant_label, size_bucket, price_tbc)
       VALUES (?,?,?,?,?,?,?,?)`, [joinerId, item.order_id, item.id, label, member, variant, item.size_bucket, item.price_tbc ? 1 : 0]);
    await addClaimCosts(conn, r.insertId, item.price_tbc ? 0 : item.price);        // a TBC price costs nothing yet, and the claim can't be secured until it's set
    ids.push(r.insertId);
  }
  return { ids, placements };
}
