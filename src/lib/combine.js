import { lockJoiner } from './ledger.js';
import { bad, conflict, forbidden, notFound } from '../errors.js';
import { normalizeHandle, isValidHandle } from './handles.js';
import { audit } from '../auth.js';

// Combined shipping: two friends' items go in ONE parcel to ONE address (the recipient's). The parcel stays the recipient's; the friend is its "companion" —
// their items sit in the same parcel and they keep their own bias / Lomo name / notes. Fees are split equally per person (see lib/parcels.js).
export const READY = 'ready to pack / on hand';

// "Fees are set" means real money has been put on the parcel. Joining or leaving after that would change what two people owe, so it has to happen BEFORE the GOM saves fees.
export const feesSet = (p) => Number(p.doms_total || 0) > 0 || Number(p.packaging_total || 0) > 0;
const FEES_MSG = "The GOM has already put postage or a packaging fee on this parcel, so who is in it can't change now. Ask them to set those fees back to £0 first (or cancel the parcel).";

// The same checks for anyone adding items to a parcel — the recipient asking for shipping, or a friend accepting an invitation.
export async function validateShippable(conn, joinerId, ids) {
  const [claims] = await conn.query('SELECT id, status, pipeline FROM claims WHERE id IN (?) AND joiner_id = ? FOR UPDATE', [ids, joinerId]);
  if (claims.length !== ids.length) throw forbidden("One of those items isn't yours");
  if (claims.some((c) => c.status !== 'confirmed' || c.pipeline !== READY)) throw bad('Only items that are ready to ship can be requested', 'not_ready');
  const [busy] = await conn.query("SELECT pi.claim_id FROM parcel_items pi JOIN parcels p ON p.id = pi.parcel_id WHERE pi.claim_id IN (?) AND p.status IN ('requested','packed','shipped')", [ids]);
  if (busy.length) throw conflict('One of those items is already in a parcel', 'already_requested');
  const [asked] = await conn.query("SELECT 1 FROM cancel_requests WHERE claim_id IN (?) AND status = 'pending' LIMIT 1", [ids]);
  if (asked.length) throw conflict("You've asked to cancel one of those items — wait for the GOM's answer (or withdraw the request) before shipping it.", 'cancel_pending');
}

// Personalised Lomo: the name they typed; otherwise the name from their delivery details; otherwise none.
export async function lomoFor(conn, joinerId, typed) {
  const [[addr]] = await conn.query('SELECT full_name FROM addresses WHERE joiner_id = ?', [joinerId]);
  const deliveryName = (addr?.full_name || '').trim();
  const name = typed || deliveryName || null;
  return { name, source: !name ? null : (!typed || typed.toLowerCase() === deliveryName.toLowerCase()) ? 'delivery' : 'custom' };
}

// How many people can share one parcel (the person it is posted to plus their friends). Declined invitations don't count.
export const MAX_PEOPLE = 5;
const capMsg = `A parcel can be shared by up to ${MAX_PEOPLE} people.`;
async function headcount(conn, parcelId) {
  const [[r]] = await conn.query("SELECT COUNT(*) AS n FROM parcel_companions WHERE parcel_id = ? AND status <> 'declined'", [parcelId]);
  return 1 + r.n;
}

// The recipient asks one or more friends to share their parcel. Everything is checked first, so either all of them are invited or none are.
// A friend must be signed in (so they can say yes) and can't be the recipient or a blocked person.
export async function inviteCompanions(conn, { parcelId, recipientId, handles, how = 'joiner', createdBy }) {
  const wanted = [...new Set(handles.map((h) => normalizeHandle(h)))];
  if (!wanted.length) throw bad('Say who to invite.', 'no_friend');
  const [[p]] = await conn.query('SELECT status, joiner_id, doms_total, packaging_total FROM parcels WHERE id = ? FOR UPDATE', [parcelId]);
  if (!p || p.joiner_id !== recipientId) throw notFound('No such parcel');
  if (p.status !== 'requested') throw conflict("That parcel has already been packed, so it's too late to share it.", 'bad_state');
  if (feesSet(p)) throw conflict(FEES_MSG, 'fees_set');
  const people = [];
  for (const handle of wanted) {
    if (!isValidHandle(handle)) throw bad(`"${handle}" isn't a valid Instagram handle.`, 'bad_handle');
    const [[friend]] = await conn.query('SELECT id, account_id AS accountId, is_blocked AS blocked, account_deleted_at AS deleted FROM joiners WHERE instagram_handle = ?', [handle]);
    if (!friend) throw bad(`@${handle} isn't on the site yet. They need to sign in here first — or ask the GOM to combine your parcels.`, 'friend_unknown');
    if (friend.id === recipientId) throw bad("You can't share a parcel with yourself.", 'friend_is_you');
    if (friend.blocked || friend.deleted) throw bad(`A parcel can't be shared with @${handle}.`, 'friend_blocked');
    if (!friend.accountId) throw bad(`@${handle} hasn't signed in to the site yet, so they can't be asked. Ask them to sign in first — or ask the GOM to combine your parcels.`, 'friend_not_signed_in');
    const [[ex]] = await conn.query('SELECT status FROM parcel_companions WHERE parcel_id = ? AND joiner_id = ? FOR UPDATE', [parcelId, friend.id]);
    if (ex && ex.status !== 'declined') throw conflict(ex.status === 'accepted' ? `@${handle} is already sharing this parcel.` : `You've already invited @${handle} to share this parcel.`, 'companion_exists');
    people.push({ handle, id: friend.id, hadDeclined: !!ex });
  }
  if (await headcount(conn, parcelId) + people.length > MAX_PEOPLE) throw conflict(capMsg, 'too_many_people');
  for (const f of people) {
    if (f.hadDeclined) await conn.query('DELETE FROM parcel_companions WHERE parcel_id = ? AND joiner_id = ?', [parcelId, f.id]);
    await conn.query("INSERT INTO parcel_companions (parcel_id, joiner_id, status, how, created_by) VALUES (?, ?, 'invited', ?, ?)", [parcelId, f.id, how, createdBy || null]);
  }
  return people.map((f) => ({ handle: f.handle, joinerId: f.id }));
}

// The friend says yes: chooses their own ready items, and gives their own bias / Lomo name / notes.
export async function acceptCompanion(conn, { parcelId, friendId, claimIds, bias, lomoName, notes }) {
  const [[p]] = await conn.query('SELECT id, status, doms_total, packaging_total FROM parcels WHERE id = ? FOR UPDATE', [parcelId]);
  const [[c]] = p ? await conn.query('SELECT status FROM parcel_companions WHERE parcel_id = ? AND joiner_id = ? FOR UPDATE', [parcelId, friendId]) : [[]];
  if (!p || !c) throw notFound('No such invitation');
  if (c.status !== 'invited') throw conflict(c.status === 'accepted' ? "You've already joined this parcel." : 'You turned this invitation down.', 'bad_state');
  if (p.status !== 'requested') throw conflict("That parcel has already been packed, so it's too late to add your items.", 'too_late');
  if (feesSet(p)) throw conflict(FEES_MSG, 'fees_set');
  await lockJoiner(conn, friendId);
  const ids = [...new Set(claimIds)];
  await validateShippable(conn, friendId, ids);
  const lomo = await lomoFor(conn, friendId, lomoName);
  for (const id of ids) await conn.query('INSERT INTO parcel_items (parcel_id, claim_id) VALUES (?, ?)', [parcelId, id]);
  await conn.query("UPDATE parcel_companions SET status = 'accepted', bias = ?, lomo_name = ?, lomo_source = ?, notes = ?, responded_at = NOW(3) WHERE parcel_id = ? AND joiner_id = ?", [bias || null, lomo.name, lomo.source, notes || null, parcelId, friendId]);
}

export async function declineCompanion(conn, { parcelId, friendId }) {
  const [[c]] = await conn.query('SELECT status FROM parcel_companions WHERE parcel_id = ? AND joiner_id = ? FOR UPDATE', [parcelId, friendId]);
  if (!c) throw notFound('No such invitation');
  if (c.status !== 'invited') throw conflict(c.status === 'accepted' ? "You've already joined this parcel — use \"leave\" instead." : 'You already turned this down.', 'bad_state');
  await conn.query("UPDATE parcel_companions SET status = 'declined', responded_at = NOW(3) WHERE parcel_id = ? AND joiner_id = ?", [parcelId, friendId]);
}

// Picks the one person a "which friend?" action is about: the named handle, or the only candidate; several candidates and no name is a question for the caller.
async function pickCompanion(conn, parcelId, handle, statuses) {
  const [rows] = await conn.query('SELECT pc.joiner_id AS joinerId, pc.status, j.instagram_handle AS handle FROM parcel_companions pc JOIN joiners j ON j.id = pc.joiner_id WHERE pc.parcel_id = ? AND pc.status IN (?) FOR UPDATE', [parcelId, statuses]);
  const want = handle ? normalizeHandle(handle) : null;
  const found = want ? rows.filter((r) => r.handle === want) : rows;
  if (!found.length) throw notFound(want ? `@${want} isn't one of the people on this parcel` : 'Nobody matches');
  if (found.length > 1) throw bad(`Say which friend: ${found.map((r) => `@${r.handle}`).join(', ')}.`, 'which_friend');
  return found[0];
}

// Takes back an invitation that has not been accepted (the recipient, or the GOM). `handle` says which friend when there are several.
export async function withdrawInvitation(conn, { parcelId, recipientId = null, handle = null }) {
  const [[p]] = await conn.query('SELECT joiner_id FROM parcels WHERE id = ? FOR UPDATE', [parcelId]);
  if (!p || (recipientId && p.joiner_id !== recipientId)) throw notFound('No such parcel');
  let c;
  try { c = await pickCompanion(conn, parcelId, handle, ['invited', 'declined']); }
  catch (e) {
    const want = handle ? normalizeHandle(handle) : null;
    const [joined] = await conn.query("SELECT j.instagram_handle AS handle FROM parcel_companions pc JOIN joiners j ON j.id = pc.joiner_id WHERE pc.parcel_id = ? AND pc.status = 'accepted'", [parcelId]);
    if (e.status === 404 && joined.some((x) => !want || x.handle === want)) throw conflict('They have already joined this parcel — to take them out, split them apart instead.', 'bad_state');
    throw e;
  }
  await conn.query('DELETE FROM parcel_companions WHERE parcel_id = ? AND joiner_id = ?', [parcelId, c.joinerId]);
  return { handle: c.handle };
}

// The friend changes their mind after joining: their items leave the parcel (back to "ready to pack") and it carries on without them.
export async function leaveParcel(conn, { parcelId, friendId }) {
  const [[p]] = await conn.query('SELECT status, doms_total, packaging_total FROM parcels WHERE id = ? FOR UPDATE', [parcelId]);
  const [[c]] = p ? await conn.query('SELECT status FROM parcel_companions WHERE parcel_id = ? AND joiner_id = ? FOR UPDATE', [parcelId, friendId]) : [[]];
  if (!p || !c || c.status !== 'accepted') throw notFound('You are not part of that parcel');
  if (p.status !== 'requested') throw conflict("That parcel has already been packed, so your items can't be taken out now.", 'too_late');
  if (feesSet(p)) throw conflict(FEES_MSG, 'fees_set');
  await lockJoiner(conn, friendId);
  await conn.query('DELETE pi FROM parcel_items pi JOIN claims c ON c.id = pi.claim_id WHERE pi.parcel_id = ? AND c.joiner_id = ?', [parcelId, friendId]);
  await conn.query('DELETE FROM parcel_companions WHERE parcel_id = ? AND joiner_id = ?', [parcelId, friendId]);
}

// ── the GOM combines two parcels that were requested separately ──
// `parcelId` is the one whose ADDRESS is used (the recipient); `withParcelId` is folded into it. The GOM has confirmed with both people.
export async function combineParcels(conn, { parcelId, withParcelId, adminId }) {
  if (parcelId === withParcelId) throw bad("Pick a different parcel to combine it with.");
  const ids = [parcelId, withParcelId].sort((a, b) => a - b);
  const [rows] = await conn.query('SELECT * FROM parcels WHERE id IN (?) ORDER BY id FOR UPDATE', [ids]);
  const P = rows.find((r) => r.id === parcelId), F = rows.find((r) => r.id === withParcelId);
  if (!P || !F) throw notFound('No such parcel');
  if (P.status !== 'requested' || F.status !== 'requested') throw conflict('Only parcels still waiting in the queue can be combined.', 'bad_state');
  if (P.joiner_id === F.joiner_id) throw bad('Both parcels belong to the same person.');
  for (const id of [P.joiner_id, F.joiner_id].sort((a, b) => a - b)) await lockJoiner(conn, id);
  const [[theirs]] = await conn.query('SELECT COUNT(*) AS n FROM parcel_companions WHERE parcel_id = ?', [F.id]);
  if (theirs.n) throw conflict("The other parcel is already being shared with someone, so it can't be folded into this one.", 'companion_exists');
  const [[dupe]] = await conn.query('SELECT COUNT(*) AS n FROM parcel_companions WHERE parcel_id = ? AND joiner_id = ?', [P.id, F.joiner_id]);
  if (dupe.n) throw conflict('That person is already on this parcel.', 'companion_exists');
  if (await headcount(conn, P.id) + 1 > MAX_PEOPLE) throw conflict(capMsg, 'too_many_people');
  if (P.method.toLowerCase() !== F.method.toLowerCase()) throw conflict(`They asked for different postage methods (${P.method} and ${F.method}), so they can't go in one parcel.`, 'different_method');
  if ((P.declared_value || null) !== (F.declared_value || null)) throw conflict('Their customs declared values differ, so they would need to be agreed first.', 'different_declared_value');
  if (feesSet(P) || feesSet(F)) throw conflict(FEES_MSG, 'fees_set');
  await conn.query('UPDATE parcel_items SET parcel_id = ? WHERE parcel_id = ?', [P.id, F.id]);
  await conn.query(
    "INSERT INTO parcel_companions (parcel_id, joiner_id, status, how, bias, lomo_name, lomo_source, notes, lomo_checked_at, bias_checked_at, weight_g, created_by, responded_at) VALUES (?, ?, 'accepted', 'gom', ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))",
    [P.id, F.joiner_id, F.bias, F.lomo_name, F.lomo_source, F.notes, F.lomo_checked_at, F.bias_checked_at, F.weight_g, adminId]);
  await conn.query('UPDATE parcels SET requested_at = LEAST(requested_at, ?) WHERE id = ?', [F.requested_at, P.id]);      // the combined parcel keeps the earlier place in the queue
  await conn.query('DELETE FROM parcels WHERE id = ?', [F.id]);
  await audit(conn, adminId, 'parcel.combine', 'parcel', P.id, { absorbed: F.id, friend: F.joiner_id });
  return { parcelId: P.id, friendId: F.joiner_id };
}

// Undoes one person's place in a combined parcel: their items go back into a parcel of their own (keeping their place in the queue and their own bias / Lomo / notes).
// `handle` says which friend when there are several.
export async function uncombineParcel(conn, { parcelId, adminId, handle = null }) {
  const [[P]] = await conn.query('SELECT * FROM parcels WHERE id = ? FOR UPDATE', [parcelId]);
  if (!P) throw notFound('No such parcel');
  const [accepted] = await conn.query("SELECT COUNT(*) AS n FROM parcel_companions WHERE parcel_id = ? AND status = 'accepted'", [parcelId]);
  if (!accepted[0].n) throw conflict('That parcel is not combined with anyone.', 'bad_state');
  const who = await pickCompanion(conn, parcelId, handle, ['accepted']);
  const [[c]] = await conn.query('SELECT * FROM parcel_companions WHERE parcel_id = ? AND joiner_id = ? FOR UPDATE', [parcelId, who.joinerId]);
  if (P.status !== 'requested') throw conflict("That parcel has already been packed, so it can't be split now.", 'bad_state');
  if (feesSet(P)) throw conflict(FEES_MSG, 'fees_set');
  for (const id of [P.joiner_id, c.joiner_id].sort((a, b) => a - b)) await lockJoiner(conn, id);
  const [ins] = await conn.query(
    'INSERT INTO parcels (joiner_id, method, declared_value, notes, bias, lomo_name, lomo_source, requested_at, lomo_checked_at, bias_checked_at, weight_g) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [c.joiner_id, P.method, P.declared_value, c.notes, c.bias, c.lomo_name, c.lomo_source, P.requested_at, c.lomo_checked_at, c.bias_checked_at, c.weight_g]);
  await conn.query('UPDATE parcel_items pi JOIN claims cl ON cl.id = pi.claim_id SET pi.parcel_id = ? WHERE pi.parcel_id = ? AND cl.joiner_id = ?', [ins.insertId, parcelId, c.joiner_id]);
  await conn.query('DELETE FROM parcel_companions WHERE parcel_id = ? AND joiner_id = ?', [parcelId, c.joiner_id]);
  await audit(conn, adminId, 'parcel.uncombine', 'parcel', parcelId, { newParcel: ins.insertId, friend: c.joiner_id });
  return { newParcelId: ins.insertId, friendId: c.joiner_id, handle: who.handle };
}
