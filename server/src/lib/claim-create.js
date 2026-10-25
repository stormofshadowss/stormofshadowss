import { bad, notFound } from '../errors.js';
import { addClaimCosts } from './ledger.js';
import { placeSetParts } from './sets.js';
import { closedReason } from './closing.js';
import { conflict } from '../errors.js';

// Making claims for ITEMS of a group order — one place, used both by a joiner claiming for themselves and by the GOM adding a claim for someone.
// The only difference is `asAdmin`: the GOM may add to a PRIVATE group order and to anything that has CLOSED — an order, or just one item (a joiner may do neither).

// Lock every item a request names (lowest id first, so two requests can never wait on each other in a circle). That also stops a price edit
// from landing between us reading the price and saving the claim — an unsecured claim must always carry the price listed at the time.
export async function lockLineItems(conn, lines) {
  const lockIds = [...new Set(lines.filter((l) => l.itemId).map((l) => l.itemId))].sort((x, y) => x - y);
  if (lockIds.length) await conn.query('SELECT id FROM items WHERE id IN (?) ORDER BY id FOR UPDATE', [lockIds]);
}

// Place one item line (not a shop item) for a joiner: returns the new claim ids, and where member-set parts went.
// A TOTAL purchase limit (a store limit, a bulky item): at most N claims across everyone, first come first served — requests count the moment they're made, cancelled claims free their place. It counts
// the whole item together, or each version / member / size on its own (limit_scope). The item row is already locked, so two people grabbing the last copy at once queue up and one is told it's gone.
// The GOM adding or fixing a claim may go past it, but only knowingly (overrideLimit) — a plain attempt is refused with code 'limit_reached' so the screen can ask.
// "You already have 1 × OT8 photocards — claim another?": what the person's handle ALREADY has (not cancelled) of what they are about to claim — the same item, and for members / sizes / set parts the same member or size
// (a different member of the same item is not a repeat). A repeat is usually someone unsure the first claim went through, so the public claim form asks first instead of silently adding a second.
// Run inside the claim's transaction AFTER the items are locked, so two near-simultaneous presses line up one after the other: the second sees the first.
export async function alreadyHas(conn, joinerId, lines) {
  const out = [], seen = new Map();
  const add = (label, n, ref) => { if (n > 0) { const e = seen.get(label) || { label, count: 0, ...ref }; e.count += n; seen.set(label, e); } };      // ref says which item (and member/size) it is, so a screen can match its basket lines
  for (const line of lines) {
    if (line.leftoverId) {
      const [[it]] = await conn.query('SELECT title FROM leftover_items WHERE id = ?', [line.leftoverId]); if (!it) continue;
      const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM claims WHERE joiner_id = ? AND leftover_item_id = ? AND status <> 'cancelled'", [joinerId, line.leftoverId]); add(it.title, Number(n), { leftoverId: line.leftoverId }); continue;
    }
    const [[it]] = await conn.query('SELECT title FROM items WHERE id = ?', [line.itemId]); if (!it) continue;                 // an unknown item is reported by placeItemLine
    const options = line.parts?.length ? line.parts.map((p) => p.member) : [line.member || line.variant || null];
    for (const opt of options) {
      const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM claims WHERE joiner_id = ? AND item_id = ? AND status <> 'cancelled' ${opt ? 'AND COALESCE(member_name, variant_label) = ?' : ''}`, opt ? [joinerId, line.itemId, opt] : [joinerId, line.itemId]);
      add(opt ? `${it.title} — ${opt}` : it.title, Number(n), { itemId: line.itemId, ...(opt ? { option: opt } : {}) });
    }
  }
  for (const e of seen.values()) out.push(e);
  return out;
}

export const hasOptions = (type) => ['set', 'independent', 'size'].includes(type);                    // item types where a person picks a member / size — the only ones a limit can count "each option" of
export async function checkPurchaseLimit(conn, item, wanted, { asAdmin = false, overrideLimit = false, excludeClaimId = null } = {}) {
  if (!item.purchase_limit || (asAdmin && overrideLimit)) return;
  const n = Number(item.purchase_limit), byOption = item.limit_scope === 'option' && hasOptions(item.item_type);
  const ask = byOption ? wanted : { '': Object.values(wanted).reduce((a, b) => a + b, 0) };                       // wanted: { optionName: qty } — what this request adds
  for (const [opt, qty] of Object.entries(ask)) {
    if (!(qty > 0)) continue;
    const [[{ used }]] = await conn.query(
      `SELECT COUNT(*) AS used FROM claims WHERE item_id = ? AND status <> 'cancelled' ${excludeClaimId ? 'AND id <> ?' : ''} ${byOption ? 'AND COALESCE(member_name, variant_label) = ?' : ''}`,
      [item.id, ...(excludeClaimId ? [excludeClaimId] : []), ...(byOption ? [opt] : [])]);
    const left = Math.max(0, n - Number(used));
    if (qty > left) {
      const what = byOption ? `“${item.title} — ${opt}”` : `“${item.title}”`, limit = byOption ? `limit ${n} of each` : `limit ${n} in total`;
      throw conflict(left === 0 ? `Sorry — ${what} has reached its purchase limit (${limit}).` : `Only ${left} left of ${what} (${limit}) — you asked for ${qty}.`, 'limit_reached');
    }
  }
}

export async function placeItemLine(conn, { joinerId, line, asAdmin = false, overrideLimit = false }) {
  const ids = [], placements = [];
  const [[item]] = await conn.query(
    `SELECT i.id, i.order_id, i.item_type, i.title, i.price, i.price_tbc, i.size_bucket, i.purchase_limit, i.limit_scope, i.cancelled_at, i.hidden_from_public, i.close_date AS item_close_date, i.closed_by_hand, go.status, go.close_date AS go_close_date, go.is_private
       FROM items i JOIN group_orders go ON go.id = i.order_id WHERE i.id = ?`, [line.itemId]);
  // Private orders look exactly like orders that don't exist.
  if (!item || ((item.is_private || item.hidden_from_public) && !asAdmin)) throw notFound('That item isn\'t available');                  // a hidden item looks like it doesn't exist to a joiner
  if (!asAdmin) {                                                                                  // closed by hand or by date — the order, or just this item
    const why = closedReason({ orderStatus: item.status, orderCloseDate: item.go_close_date, itemCloseDate: item.item_close_date, itemClosedByHand: item.closed_by_hand });
    if (why?.startsWith('order')) throw bad('That order has closed', 'order_closed');
    if (why) throw bad('That item has closed for claims', 'item_closed');
  }
  if (item.cancelled_at) throw bad("That item isn't available any more", 'item_cancelled');
  if (item.item_type === 'set') {
    const asked = {};
    for (const p of line.parts || []) asked[p.member] = (asked[p.member] || 0) + p.qty;
    if (!Object.keys(asked).length) throw bad(`Choose at least one part of "${item.title}"`);
    const [roster] = await conn.query('SELECT name FROM item_members WHERE item_id = ?', [item.id]);
    const known = new Set(roster.map((r) => r.name));
    for (const m of Object.keys(asked)) if (!known.has(m)) throw bad(`"${m}" isn't part of "${item.title}"`);
    if (Object.values(asked).some((n) => n > 20)) throw bad('That\'s more of one part than we can take in one go');
    await checkPurchaseLimit(conn, item, asked, { asAdmin, overrideLimit });
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
  await checkPurchaseLimit(conn, item, { [member || variant || '']: line.qty || 1 }, { asAdmin, overrideLimit });
  for (let n = 0; n < (line.qty || 1); n++) {
    const [r] = await conn.query(
      `INSERT INTO claims (joiner_id, order_id, item_id, label, member_name, variant_label, size_bucket, price_tbc)
       VALUES (?,?,?,?,?,?,?,?)`, [joinerId, item.order_id, item.id, label, member, variant, item.size_bucket, item.price_tbc ? 1 : 0]);
    await addClaimCosts(conn, r.insertId, item.price_tbc ? 0 : item.price);        // a TBC price costs nothing yet, and the claim can't be secured until it's set
    ids.push(r.insertId);
  }
  return { ids, placements };
}
