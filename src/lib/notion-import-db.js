import { CATS, DEFAULT_GROUP, PARCEL_METHOD } from './notion-import.js';
import { lockJoiner } from './ledger.js';
import { conflict } from '../errors.js';

const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

// What the site already has, so a plan can tell new from existing and never import a spreadsheet row twice.
export async function loadExisting(conn) {
  const [orders] = await conn.query('SELECT title FROM group_orders');
  const [joiners] = await conn.query('SELECT instagram_handle AS h FROM joiners');
  const [keys] = await conn.query("SELECT source_key FROM import_records WHERE kind = 'claim' AND source_key IS NOT NULL");
  const [signed] = await conn.query('SELECT instagram_handle AS h FROM joiners WHERE account_id IS NOT NULL');
  return { orders: new Set(orders.map((o) => o.title.toLowerCase())), handles: new Set(joiners.map((j) => j.h)), signedUp: new Set(signed.map((j) => j.h)), keys: new Set(keys.map((k) => k.source_key)) };
}

// Does the whole import inside the caller's transaction, so it's all-or-nothing.
// Imported group orders are created CLOSED and PRIVATE: nobody can claim from them or see them in the shop, but everyone's claims show in their own My orders.
export async function runImport(conn, { batchId, plan, accountId }) {
  const records = [];
  const rec = (kind, id, key = null) => records.push([batchId, kind, id, key]);
  const made = { groups: 0, orders: 0, items: 0, people: 0, claims: 0, payments: 0, parcels: 0 }, reused = { orders: 0, people: 0 };

  const groupId = new Map();
  for (const name of new Set(plan.orders.map((o) => o.artistGroup))) {
    const [[g]] = await conn.query('SELECT id FROM artist_groups WHERE name = ?', [name]);
    if (g) { groupId.set(name, g.id); continue; }
    const [r] = await conn.query('INSERT INTO artist_groups (name, is_hidden) VALUES (?, ?)', [name, name === DEFAULT_GROUP ? 1 : 0]);
    groupId.set(name, r.insertId); rec('group', r.insertId); made.groups += 1;
  }
  const orderId = new Map(), itemId = new Map();
  for (const o of plan.orders) {
    const [[ex]] = await conn.query('SELECT id FROM group_orders WHERE title = ?', [o.title]);
    if (ex) { orderId.set(o.title, ex.id); reused.orders += 1; }
    else {
      const [r] = await conn.query("INSERT INTO group_orders (group_id, title, status, is_private) VALUES (?, ?, 'closed', 1)", [groupId.get(o.artistGroup), o.title]);
      orderId.set(o.title, r.insertId); rec('order', r.insertId); made.orders += 1;
    }
    for (const it of o.items) {
      const [r] = await conn.query("INSERT INTO items (order_id, item_type, title, description, price, size_bucket, sort_order) VALUES (?, 'normal', ?, ?, ?, 'M', ?)",
        [orderId.get(o.title), it.title, it.truncated ? it.full : null, it.price, it.sort]);
      itemId.set(`${o.title}\u0001${it.full}`, r.insertId); rec('item', r.insertId); made.items += 1;
    }
  }
  const joinerId = new Map();
  for (const p of plan.people) {
    const [[ex]] = await conn.query('SELECT id FROM joiners WHERE instagram_handle = ?', [p.handle]);
    if (ex) { joinerId.set(p.handle, ex.id); reused.people += 1; continue; }
    const [r] = await conn.query('INSERT INTO joiners (instagram_handle) VALUES (?)', [p.handle]);
    joinerId.set(p.handle, r.insertId); rec('joiner', r.insertId); made.people += 1;
  }
  const byPerson = new Map(), claimIdByKey = new Map();
  for (const c of plan.claims) {
    const [r] = await conn.query(
      `INSERT INTO claims (joiner_id, order_id, item_id, label, status, pipeline, size_bucket, ready_to_pack_date, storage_deadline_override, pay_by)
       VALUES (?, ?, ?, ?, ?, ?, 'M', ?, ?, ?)`,
      [joinerId.get(c.handle), orderId.get(c.goTitle), itemId.get(`${c.goTitle}\u0001${c.itemFull}`), c.label, c.status, c.pipeline, c.readyDate, c.storageDeadline, c.payBy]);
    await conn.query('INSERT INTO claim_costs (claim_id, category, cost, paid) VALUES ?', [CATS.map((cat) => [r.insertId, cat, c.costs[cat] || 0, c.alloc[cat] || 0])]);
    rec('claim', r.insertId, c.key); made.claims += 1; claimIdByKey.set(c.key, r.insertId);
    if (!byPerson.has(c.handle)) byPerson.set(c.handle, []);
    byPerson.get(c.handle).push({ claimId: r.insertId, alloc: c.alloc });
  }
  // Items that were already on their way: one shipped parcel per person, holding those claims — so "It's arrived" works and completes them.
  for (const p of plan.parcels || []) {
    const [r] = await conn.query("INSERT INTO parcels (joiner_id, method, status) VALUES (?, ?, 'shipped')", [joinerId.get(p.handle), PARCEL_METHOD]);
    await conn.query('INSERT INTO parcel_items (parcel_id, claim_id) VALUES ?', [p.keys.map((k) => [r.insertId, claimIdByKey.get(k)])]);
    rec('parcel', r.insertId); made.parcels += 1;
  }
  // What each person has paid so far becomes ONE verified payment ("Imported from Notion"), spread over their claims — so every figure reconciles and you can see where it came from.
  for (const [handle, list] of byPerson) {
    const amount = Math.round(list.reduce((s, c) => s + CATS.reduce((t, k) => t + (c.alloc[k] || 0), 0), 0) * 100) / 100;
    if (!(amount > 0)) continue;
    const [p] = await conn.query("INSERT INTO payments (joiner_id, order_id, amount, method, reference, status, verified_at, verified_by) VALUES (?, NULL, ?, 'Imported from Notion', ?, 'confirmed', NOW(3), ?)",
      [joinerId.get(handle), amount, `Notion import #${batchId}`, accountId]);
    const allocs = list.flatMap((c) => CATS.filter((k) => c.alloc[k] > 0).map((k) => [p.insertId, c.claimId, k, c.alloc[k]]));
    for (const part of chunk(allocs, 1000)) await conn.query('INSERT INTO payment_allocations (payment_id, claim_id, category, amount) VALUES ?', [part]);
    rec('payment', p.insertId); made.payments += 1;
  }
  for (const part of chunk(records, 1000)) await conn.query('INSERT INTO import_records (batch_id, kind, entity_id, source_key) VALUES ?', [part]);
  return { made, reused };
}

// Removes everything a batch created — but only while nothing has happened to it since that the import can't account for: no payment, credit, parcel or box touching
// its claims, and no claim added to its items. Otherwise it explains what's in the way rather than half-deleting.
export async function undoImport(conn, batchId) {
  const [recs] = await conn.query('SELECT kind, entity_id FROM import_records WHERE batch_id = ?', [batchId]);
  const ids = (k) => recs.filter((r) => r.kind === k).map((r) => r.entity_id);
  const [claimIds, paymentIds, itemIds, orderIds, groupIds, joinerIds, parcelIds] = ['claim', 'payment', 'item', 'order', 'group', 'joiner', 'parcel'].map(ids);
  const [handedOn] = await conn.query("SELECT 1 FROM import_records WHERE batch_id = ? AND kind = 'claim' AND moved_at IS NOT NULL LIMIT 1", [batchId]);
  if (handedOn.length) throw conflict("This import can't be undone any more: some of its claims have since been moved to other people.", 'import_in_use');
  if (claimIds.length) {
    const [who] = await conn.query('SELECT DISTINCT joiner_id FROM claims WHERE id IN (?) ORDER BY joiner_id', [claimIds]);
    for (const { joiner_id } of who) await lockJoiner(conn, joiner_id);
    await conn.query('SELECT id FROM claims WHERE id IN (?) ORDER BY id FOR UPDATE', [claimIds]);
    const [moved] = await conn.query(
      `SELECT DISTINCT cc.claim_id FROM claim_costs cc
         LEFT JOIN (SELECT claim_id, category, SUM(amount) AS a FROM payment_allocations WHERE payment_id IN (?) GROUP BY claim_id, category) pa ON pa.claim_id = cc.claim_id AND pa.category = cc.category
        WHERE cc.claim_id IN (?) AND cc.paid <> COALESCE(pa.a, 0)`, [paymentIds.length ? paymentIds : [0], claimIds]);
    if (moved.length) throw conflict(`This import can't be undone any more: ${moved.length} of its claims have had payments or credit applied since (so removing them would lose money records).`, 'import_in_use');
    const [parcels] = await conn.query('SELECT 1 FROM parcel_items WHERE claim_id IN (?) AND parcel_id NOT IN (?) LIMIT 1', [claimIds, parcelIds.length ? parcelIds : [0]]);   // (the import's own parcels don't count)
    const [boxes] = await conn.query('SELECT 1 FROM box_items WHERE claim_id IN (?) LIMIT 1', [claimIds]);
    if (parcels.length || boxes.length) throw conflict("This import can't be undone any more: some of its claims are in a parcel or a box.", 'import_in_use');
    if (parcelIds.length) {
      const [moved] = await conn.query("SELECT 1 FROM parcels WHERE id IN (?) AND status <> 'shipped' LIMIT 1", [parcelIds]);
      if (moved.length) throw conflict("This import can't be undone any more: someone has already confirmed that one of its parcels arrived.", 'import_in_use');
    }
  }
  if (itemIds.length) {
    const [extra] = await conn.query('SELECT 1 FROM claims WHERE item_id IN (?) AND id NOT IN (?) LIMIT 1', [itemIds, claimIds.length ? claimIds : [0]]);
    if (extra.length) throw conflict("This import can't be undone any more: someone has since claimed one of its items.", 'import_in_use');
  }
  if (parcelIds.length) await conn.query('DELETE FROM parcels WHERE id IN (?)', [parcelIds]);           // and the claims inside them
  if (paymentIds.length) await conn.query('DELETE FROM payments WHERE id IN (?)', [paymentIds]);          // its allocations go with it
  if (claimIds.length) await conn.query('DELETE FROM claims WHERE id IN (?)', [claimIds]);               // and their costs
  if (itemIds.length) await conn.query('DELETE FROM items WHERE id IN (?)', [itemIds]);
  const kept = { orders: 0, groups: 0, people: 0 }, gone = { claims: claimIds.length, items: itemIds.length, orders: 0, groups: 0, people: 0, payments: paymentIds.length, parcels: parcelIds.length };
  for (const id of orderIds) {                                                                           // an order someone has since added to stays
    const [[n]] = await conn.query('SELECT (SELECT COUNT(*) FROM items WHERE order_id = ?) + (SELECT COUNT(*) FROM claims WHERE order_id = ?) AS n', [id, id]);
    if (n.n) kept.orders += 1; else { await conn.query('DELETE FROM group_orders WHERE id = ?', [id]); gone.orders += 1; }
  }
  for (const id of groupIds) {
    const [[n]] = await conn.query('SELECT COUNT(*) AS n FROM group_orders WHERE group_id = ?', [id]);
    if (n.n) kept.groups += 1; else { await conn.query('DELETE FROM artist_groups WHERE id = ?', [id]); gone.groups += 1; }
  }
  for (const id of joinerIds) {                                                                          // a person stays if they've signed in, been blocked, or have other claims
    const [[n]] = await conn.query('SELECT (SELECT COUNT(*) FROM claims WHERE joiner_id = ?) + (SELECT COUNT(*) FROM payments WHERE joiner_id = ?) + (SELECT COUNT(*) FROM credit_ledger WHERE joiner_id = ?) + (SELECT COUNT(*) FROM joiners WHERE id = ? AND (account_id IS NOT NULL OR is_blocked = 1)) AS n', [id, id, id, id]);
    if (n.n) kept.people += 1; else { await conn.query('DELETE FROM joiners WHERE id = ?', [id]); gone.people += 1; }
  }
  await conn.query('DELETE FROM import_records WHERE batch_id = ?', [batchId]);
  return { gone, kept };
}
