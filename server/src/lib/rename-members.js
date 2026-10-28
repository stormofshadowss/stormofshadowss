import { bad, conflict } from '../errors.js';

// RENAMING A MEMBER of a member item or a member set (fixing a spelling). A member's name is not stored once — it is copied into the item's roster, every claim made on it (and the claim's label), the set slots and
// the fixed claims — so a rename has to be carried through ALL of them in one transaction, or the new name would no longer match the claims already made.
// Safety: a name can't be blank or the same as another member (case ignored, and swapping two names is refused — it would need a temporary name). Prices, sets and who holds what are untouched.

// "Title — Han (Set 2)" → "Title — Hann (Set 2)": only the member part changes (the title may itself contain " — ", and may since have been renamed, so find the LAST " — <old>").
export function relabel(label, from, to) {
  const needle = ` — ${from}`;
  let at = label.lastIndexOf(needle);
  while (at >= 0) {                                                                                  // the member part ends the label, or is followed by " (Set 2)" / " (M)" — never part of a longer name
    const rest = label.slice(at + needle.length); if (rest === '' || rest.startsWith(' (')) break;
    at = at === 0 ? -1 : label.lastIndexOf(needle, at - 1);
  }
  return at < 0 ? label : `${label.slice(0, at)} — ${to}${label.slice(at + needle.length)}`;
}

// renames: [{ id, name }] (the member's id and the new name). Returns what actually changed: [{ id, from, to, claims }]. Run inside the item's transaction (the item row is already locked).
export async function renameMembers(conn, itemId, renames) {
  const [roster] = await conn.query('SELECT id, name FROM item_members WHERE item_id = ? ORDER BY sort_order, id', [itemId]);
  const byId = new Map(roster.map((m) => [m.id, m]));
  const changes = [];
  for (const r of renames) {
    const cur = byId.get(r.id); if (!cur) throw bad("That member isn't on this item.", 'no_such_member');
    const to = r.name.trim(); if (!to) throw bad("A member's name can't be blank.", 'member_name_blank');
    if (to !== cur.name) changes.push({ id: cur.id, from: cur.name, to });
  }
  const seen = new Set();
  for (const c of changes) {
    const key = c.to.toLowerCase();
    if (seen.has(key)) throw conflict(`Two members can't both be called “${c.to}”.`, 'member_name_taken'); seen.add(key);
    const clash = roster.find((m) => m.id !== c.id && m.name.toLowerCase() === key);                          // even if that member is also being renamed: no swaps
    if (clash) throw conflict(`Another member is already called “${clash.name}” — pick a different name.`, 'member_name_taken');
  }
  const out = [];
  for (const c of changes) {
    await conn.query('UPDATE item_members SET name = ? WHERE id = ?', [c.to, c.id]);
    await conn.query('UPDATE set_slots ss JOIN item_sets s ON s.id = ss.set_id SET ss.member_name = ? WHERE s.item_id = ? AND ss.member_name = ?', [c.to, itemId, c.from]);
    await conn.query('UPDATE fixed_claims SET member_name = ? WHERE item_id = ? AND member_name = ?', [c.to, itemId, c.from]);
    const [claims] = await conn.query('SELECT id, label FROM claims WHERE item_id = ? AND member_name = ?', [itemId, c.from]);
    for (const cl of claims) await conn.query('UPDATE claims SET member_name = ?, label = ? WHERE id = ?', [c.to, relabel(cl.label, c.from, c.to), cl.id]);
    out.push({ ...c, claims: claims.length });
  }
  return out;
}
