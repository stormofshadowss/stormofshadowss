import { addClaimCosts } from './ledger.js';

// Which set does each requested part go into? Pure: changes nothing, so the shop can preview it and the server can apply it.
//
// A set holds ONE of each part, so asking for the same part more than once spreads it across sets: 3 washi tapes -> 3 sets.
// "Together" goes round by round: one of each requested part in the same set, then the second of each in the next set, and so on.
//   itemMembers  every part of the item, in roster order
//   members      the parts asked for (repeat a name to ask for more than one)
//   held         for each set a claim may join (in order), the parts already taken in it
// Returns [{ member, setIdx }]; a setIdx past the end of `held` means "a new set".
export function planSetPlacement(itemMembers, members, together, held) {
  const taken = held.map((s) => new Set(s));
  const at = (i) => (taken[i] ||= new Set());
  const out = [];
  const place = (group) => {
    let i = 0;
    while (group.some((m) => at(i).has(m))) i++;
    group.forEach((m) => { at(i).add(m); out.push({ member: m, setIdx: i }); });
  };
  if (together && members.length > 1) {
    const qty = {};
    members.forEach((m) => { qty[m] = (qty[m] || 0) + 1; });
    const rounds = Math.max(...Object.values(qty));
    for (let r = 0; r < rounds; r++) place(itemMembers.filter((m) => qty[m] > r));
  } else {
    members.forEach((m) => place([m]));
  }
  return out;
}

// Applies the plan inside a transaction. The caller has already locked the item row, so only one person at a time can be
// placed into a given item's sets — which is what stops two people taking the same part of the same set.
// New claims only join sets the GOM hasn't yet secured or cancelled; if none have room, new sets open automatically.
export async function placeSetParts(conn, { joinerId, item, qtyByMember, together, status = 'requested', fixed = false }) {
  const [members] = await conn.query('SELECT name, price FROM item_members WHERE item_id = ? ORDER BY sort_order, id', [item.id]);
  const order = members.map((m) => m.name);
  const priceOf = Object.fromEntries(members.map((m) => [m.name, m.price ?? (item.price_tbc ? null : item.price)]));   // null = price still TBC
  const list = order.flatMap((n) => Array(qtyByMember[n] || 0).fill(n));

  const [sets] = await conn.query("SELECT id, set_number FROM item_sets WHERE item_id = ? AND admin_decision = 'none' ORDER BY set_number FOR UPDATE", [item.id]);
  const [taken] = sets.length ? await conn.query('SELECT set_id, member_name FROM set_slots WHERE set_id IN (?)', [sets.map((s) => s.id)]) : [[]];
  const held = sets.map((s) => taken.filter((t) => t.set_id === s.id).map((t) => t.member_name));
  const plan = planSetPlacement(order, list, together, held);

  const [[mx]] = await conn.query('SELECT COALESCE(MAX(set_number), 0) AS n FROM item_sets WHERE item_id = ?', [item.id]);
  let next = mx.n;
  const rows = [...sets];
  const need = Math.max(...plan.map((p) => p.setIdx)) + 1;
  while (rows.length < need) {
    next += 1;
    const [r] = await conn.query('INSERT INTO item_sets (item_id, set_number) VALUES (?, ?)', [item.id, next]);
    rows.push({ id: r.insertId, set_number: next });
  }

  const placed = [];
  for (const { member, setIdx } of plan) {
    const set = rows[setIdx];
    const [slot] = await conn.query("INSERT INTO set_slots (set_id, member_name, joiner_id, state, is_fixed) VALUES (?, ?, ?, 'held', ?)", [set.id, member, joinerId, fixed ? 1 : 0]);
    const label = `${item.title} — ${member} (Set ${set.set_number})`;
    const [c] = await conn.query(
      `INSERT INTO claims (joiner_id, order_id, item_id, set_id, slot_id, label, member_name, size_bucket, status, is_fixed, price_tbc)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [joinerId, item.order_id, item.id, set.id, slot.insertId, label, member, item.size_bucket, status, fixed ? 1 : 0, priceOf[member] === null ? 1 : 0]);
    await addClaimCosts(conn, c.insertId, priceOf[member] ?? 0);
    placed.push({ claimId: c.insertId, itemId: item.id, member, setId: set.id, setNumber: set.set_number, label, price: priceOf[member] });
  }
  return placed;
}
