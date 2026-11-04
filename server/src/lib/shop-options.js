import { z } from 'zod';
import { bad, conflict } from '../errors.js';

// SHOP ITEMS WITH OPTIONS (see migration 037). An option has its own count in stock and, when it differs, its own price. The listing's own qty is the SUM of its options' counts.
export const OPTION_LABELS = ['Member', 'Size', 'Version', 'Option'];
const money = z.number().min(0.01, 'An option price must be at least 1p').max(100000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At most 2 decimal places');
export const optionIn = z.object({
  id: z.number().int().positive().optional(),                                  // an existing option (editing); none = a new one
  name: z.string().trim().min(1, 'An option needs a name').max(80),
  qty: z.number().int().min(0).max(10000),
  price: money.nullable().optional(),                                          // null = the listing's price; leaving it out = unchanged
});
export const optionFields = { optionLabel: z.enum(OPTION_LABELS).optional(), options: z.array(optionIn).min(1, 'Give at least one option').max(60).optional() };

// Names must be different (ignoring capitals).
export function checkNames(options) {
  const seen = new Set();
  for (const o of options) { const k = o.name.toLowerCase(); if (seen.has(k)) throw bad(`“${o.name}” is listed twice — each option needs its own name`, 'dup_option'); seen.add(k); }
}

const sumQty = async (conn, itemId) => { await conn.query('UPDATE leftover_items SET qty = (SELECT COALESCE(SUM(qty), 0) FROM leftover_options WHERE leftover_item_id = ?) WHERE id = ?', [itemId, itemId]); };

// A brand-new item: insert its options (in the order given) and set the item's total.
export async function insertOptions(conn, itemId, options) {
  checkNames(options);
  let order = 0;
  for (const o of options) await conn.query('INSERT INTO leftover_options (leftover_item_id, name, qty, price, sort_order) VALUES (?,?,?,?,?)', [itemId, o.name, o.qty, o.price ?? null, order++]);
  await sumQty(conn, itemId);
}

// Editing an item that has options (the item row is already locked): options with an id are renamed / re-counted / re-priced, options without one are added, options left out are removed (only if nobody holds one).
// A rename carries through to claims already made. A count can't go below what is already claimed. A new price only applies to claims made from now on (a claim keeps the price it was made at).
// Returns what changed, for the activity log: { added: [...], removed: [...], renamed: [[old, new]...] }.
export async function reconcileOptions(conn, itemId, itemTitle, incoming) {
  checkNames(incoming);
  const [cur] = await conn.query('SELECT id, name, qty, price FROM leftover_options WHERE leftover_item_id = ? ORDER BY sort_order, id FOR UPDATE', [itemId]);
  const [counts] = await conn.query("SELECT leftover_option_id AS id, COUNT(*) AS n FROM claims WHERE leftover_item_id = ? AND leftover_option_id IS NOT NULL AND status <> 'cancelled' GROUP BY leftover_option_id", [itemId]);
  const claimed = new Map(counts.map((c) => [c.id, Number(c.n)])), byId = new Map(cur.map((o) => [o.id, o]));
  for (const o of incoming) if (o.id && !byId.has(o.id)) throw bad("One of those options isn't on this item", 'no_such_option');
  const keep = new Set(incoming.filter((o) => o.id).map((o) => o.id)), out = { added: [], removed: [], renamed: [] };
  for (const o of cur) if (!keep.has(o.id) && (claimed.get(o.id) || 0) > 0) throw conflict(`“${o.name}” has ${claimed.get(o.id)} claimed — set its count to what is claimed (or cancel those claims) instead of removing it.`, 'option_has_claims');
  for (const o of incoming) if (o.id && o.qty < (claimed.get(o.id) || 0)) throw conflict(`${claimed.get(o.id)} of “${byId.get(o.id).name}” ${claimed.get(o.id) === 1 ? 'is' : 'are'} already claimed — set the count to at least ${claimed.get(o.id)}, or cancel some claims first.`, 'qty_below_claims');
  for (const o of cur) if (!keep.has(o.id)) { await conn.query('DELETE FROM leftover_options WHERE id = ?', [o.id]); out.removed.push(o.name); }
  // renames in two steps, so two options can swap names
  const renames = incoming.filter((o) => o.id && o.name !== byId.get(o.id).name);
  for (const o of renames) await conn.query('UPDATE leftover_options SET name = ? WHERE id = ?', [`\u0001${o.id}`, o.id]);
  for (const o of renames) {
    const was = byId.get(o.id).name; await conn.query('UPDATE leftover_options SET name = ? WHERE id = ?', [o.name, o.id]); out.renamed.push([was, o.name]);
    const [claims] = await conn.query('SELECT id, label FROM claims WHERE leftover_option_id = ?', [o.id]);
    for (const c of claims) await conn.query('UPDATE claims SET member_name = ?, label = ? WHERE id = ?', [o.name, c.label.endsWith(` — ${was}`) ? `${c.label.slice(0, c.label.length - was.length)}${o.name}` : c.label, c.id]);
  }
  let order = 0;
  for (const o of incoming) {
    if (o.id) await conn.query(`UPDATE leftover_options SET qty = ?, sort_order = ?${o.price !== undefined ? ', price = ?' : ''} WHERE id = ?`, o.price !== undefined ? [o.qty, order, o.price, o.id] : [o.qty, order, o.id]);
    else { await conn.query('INSERT INTO leftover_options (leftover_item_id, name, qty, price, sort_order) VALUES (?,?,?,?,?)', [itemId, o.name, o.qty, o.price ?? null, order]); out.added.push(o.name); }
    order += 1;
  }
  await sumQty(conn, itemId);
  return out;
}
