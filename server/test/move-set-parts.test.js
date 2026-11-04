import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';

// MOVING SET PARTS: when someone mistypes their handle you move everything — including parts of member sets and fixed claims — to the right one. A set part keeps its place in its set (its slot moves with it); a fixed claim stays a fixed claim.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ms') => `${x}${++N}`;
const move = (claimIds, handle, extra = {}) => api('POST', '/api/admin/claims/move', { claimIds, handle, ...extra });
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Move set GO '), proxy: 'Sam' })).json.id;
const setItem = async (go, members = ['Hyunjin', 'Han', 'Felix'], title = u('Tokyo Day ')) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title, price: 6, members })).json.id;
const claimParts = async (handle, item, members, together = true) => { const r = await app.api('POST', '/api/claims', { handle, allowDuplicates: true, lines: [{ itemId: item, parts: members.map((m) => ({ member: m, qty: 1 })), ...(together ? { together: true } : {}) }] }); assert.equal(r.status, 201, r.text); };
const person = async (h = u('p')) => { const cookie = await joinerSession(app, `${h}@x.com`, h); return { h, cookie }; };
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const sets = async (item) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item).sort((a, b) => a.number - b.number);
const holders = async (item) => (await sets(item)).map((s) => `${s.number}:${s.parts.filter((p) => p.handle).map((p) => `${p.member}=${p.handle}`).join(',')}`).join(' | ');
async function secureSets(item) { for (const s of await sets(item)) assert.equal((await api('POST', `/api/admin/sets/${s.id}/secure`, {})).status, 200); }

test('A MISTYPED HANDLE: all of someone\'s parts across several sets and items move to the right handle in one go; each keeps its place in its set (same set number, same label); the old handle is left with nothing', async () => {
  const go = await goOrder(); const [d3, d4] = [await setItem(go, undefined, 'Tokyo Day 3'), await setItem(go, undefined, 'Tokyo Day 4')]; const wrong = u('beth'), right = await person(u('bethan'));
  await claimParts(u('other'), d3, ['Hyunjin']); await claimParts(wrong, d3, ['Hyunjin', 'Han']); await claimParts(wrong, d4, ['Han', 'Felix', 'Hyunjin']); await claimParts(u('other'), d4, ['Han']);
  const mine = await claimsOf(wrong); assert.equal(mine.length, 5); const before3 = await holders(d3), before4 = await holders(d4); const labels = mine.map((c) => c.label).sort();
  const pv = await move(mine.map((c) => c.id), right.h, { dryRun: true }); assert.equal(pv.status, 200, pv.text); assert.deepEqual([pv.json.movable.length, pv.json.blocked.length, pv.json.setParts, pv.json.fixed], [5, 0, 5, 0]); assert.equal((await claimsOf(wrong)).length, 5, 'the preview changed nothing');
  const r = await move(mine.map((c) => c.id), right.h); assert.equal(r.status, 200, r.text); assert.equal(r.json.moved, 5);
  assert.deepEqual([(await claimsOf(wrong)).length, (await claimsOf(right.h)).map((c) => c.label).sort()], [0, labels], 'same claims, same labels (so the same set numbers)');
  assert.equal(await holders(d3), before3.split(wrong).join(right.h), 'Day 3: only the handle changed'); assert.equal(await holders(d4), before4.split(wrong).join(right.h), 'Day 4: only the handle changed');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM set_slots ss JOIN claims c ON c.slot_id = ss.id WHERE ss.joiner_id <> c.joiner_id'))[0].n, 0, 'every slot is held by the person its claim belongs to');
  assert.ok((await app.q("SELECT detail FROM audit_log WHERE action = 'claims.move' ORDER BY id DESC LIMIT 1")).map((r) => (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail))[0].setParts === 5, 'recorded, including how many were set parts');
  assert.equal((await move(mine.map((c) => c.id), right.h)).status, 409, 'moving them again: nothing to move');
});

test('A SECURED SET STAYS SECURED AND FULL: the move changes who holds a part, nothing else — no gap opens, nobody else moves up, status and stage stay', async () => {
  const go = await goOrder(); const it = await setItem(go, ['A', 'B']); const wrong = u('wr'), right = await person(); const other = u('ot');
  await claimParts(wrong, it, ['A']); await claimParts(other, it, ['B']); await secureSets(it); const c = (await claimsOf(wrong))[0]; await api('PATCH', `/api/admin/claims/${c.id}`, { pipeline: 'ordered via proxy / warehouse' });
  const r = await move([c.id], right.h); assert.equal(r.status, 200, r.text); const s = (await sets(it))[0]; assert.deepEqual([s.decision, s.parts.filter((p) => p.handle).length, await holders(it)], ['secured', 2, `1:A=${right.h},B=${other}`]);
  const after = (await claimsOf(right.h))[0]; assert.deepEqual([after.status, after.pipeline, (await app.q('SELECT is_fixed AS f FROM claims WHERE id = ?', [c.id]))[0].f], ['confirmed', 'ordered via proxy / warehouse', 0]); assert.equal((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'set.fill_gap'"))[0].n, 0, 'no gap was filled from a later set');
});

test('A FIXED CLAIM MOVES AS A FIXED CLAIM: the standing record changes hands with it (so the new owner can give it up and the old handle can\'t), and it still counts as theirs when they swap', async () => {
  const go = await goOrder(); const it = await setItem(go, ['X', 'Y']); const wrong = await person(u('wrongfix')), right = await person(u('rightfix'));
  assert.equal((await api('POST', `/api/admin/items/${it}/fixed`, { handle: wrong.h, member: 'Y' })).status, 201); const fid = (await app.q('SELECT id FROM fixed_claims WHERE item_id = ? AND ended_at IS NULL', [it]))[0].id; const [c] = (await claimsOf(wrong.h)).filter((x) => x.setId);
  const pv = await move([c.id], right.h, { dryRun: true }); assert.deepEqual([pv.json.movable.length, pv.json.setParts, pv.json.fixed], [1, 1, 1]);
  const r = await move([c.id], right.h); assert.equal(r.status, 200, r.text); const rightId = (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [right.h]))[0].id;
  assert.deepEqual((await app.q('SELECT joiner_id AS j, member_name AS m, ended_at AS e FROM fixed_claims WHERE id = ?', [fid]))[0], { j: rightId, m: 'Y', e: null }); assert.deepEqual([(await claimsOf(right.h))[0].setId > 0, (await app.q('SELECT is_fixed AS f FROM claims WHERE id = ?', [c.id]))[0].f], [true, 1]);
  const cant = await app.api('POST', `/api/my/fixed/${fid}/change`, { action: 'giveup' }, wrong.cookie); assert.ok([403, 404].includes(cant.status), `the old handle can't act on it: ${cant.status}`);
  const give = await app.api('POST', `/api/my/fixed/${fid}/change`, { action: 'giveup' }, right.cookie); assert.equal(give.status, 200, give.text); assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE id = ? AND status = \'cancelled\'', [c.id]))[0].n, 1, 'giving it up cancelled the right claim');
});

test('A FIXED CLAIM THE TARGET ALREADY HAS IS LEFT ALONE (with the reason); everything else in the same move still goes', async () => {
  const go = await goOrder(); const it = await setItem(go, ['X', 'Y', 'Z']); const wrong = await person(u('wf')), right = await person(u('rf')); assert.equal((await api('POST', `/api/admin/items/${it}/fixed`, { handle: wrong.h, member: 'Y' })).status, 201); assert.equal((await api('POST', `/api/admin/items/${it}/fixed`, { handle: right.h, member: 'Y' })).status, 201); await claimParts(wrong.h, it, ['Z'], false);
  const mine = await claimsOf(wrong.h); const r = await move(mine.map((c) => c.id), right.h); assert.equal(r.status, 200, r.text); assert.equal(r.json.moved, 1); assert.equal(r.json.blocked.length, 1); assert.match(r.json.blocked[0].reason, new RegExp(`^@${right.h} already has a fixed claim on Y for this item$`));
  assert.deepEqual((await claimsOf(wrong.h)).map((c) => c.member || c.label.includes('Y')), [true], 'the blocked fixed claim stayed with the old handle');
});

test('A RAFFLE WIN MOVES WITH THE PART; a part with a cancel request waiting is still refused (answer that first); money paid on a set part follows it', async () => {
  const go = await goOrder(); const it = await setItem(go, ['A', 'B']); const wrong = await person(u('wr')), right = await person(u('ri')); await claimParts(wrong.h, it, ['A']); await claimParts(wrong.h, it, ['B'], false);
  const [a, b] = await claimsOf(wrong.h); const slot = (await app.q('SELECT slot_id AS s FROM claims WHERE id = ?', [a.id]))[0].s; const wid = (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [wrong.h]))[0].id; await app.q("UPDATE set_slots SET raffle_status = 'resolved', raffle_winner_joiner_id = ? WHERE id = ?", [wid, slot]);
  await secureSets(it); const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 3, reference: 'REF-SET' }, wrong.cookie); assert.equal(pay.status, 201, pay.text); await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  const owned = (await claimsOf(wrong.h)).filter((c) => c.costs.initials.paid > 0).map((c) => c.id); assert.ok(owned.length >= 1);
  await app.q("INSERT INTO cancel_requests (claim_id, joiner_id, status, reason, open_flag) VALUES (?, ?, 'pending', 'x', 1)", [b.id, wid]); const refused = await move([b.id], right.h, { dryRun: true }); assert.match(refused.json.blocked[0].reason, /has asked to cancel it/);
  const r = await move([a.id], right.h); assert.equal(r.status, 200, r.text); const rightId = (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [right.h]))[0].id; assert.equal((await app.q('SELECT raffle_winner_joiner_id AS w FROM set_slots WHERE id = ?', [slot]))[0].w, rightId, 'the win moved with the part');
  if (owned.includes(a.id)) assert.equal((await app.q('SELECT COUNT(*) AS n FROM payments WHERE joiner_id = ?', [rightId]))[0].n >= 1, true, 'the money followed the set part');
});

test('AFTERWARDS THE PART BEHAVES AS THE NEW PERSON\'S: cancelling it frees its spot, the next person moves up into it, and the old handle has no hold on the set', async () => {
  const go = await goOrder(); const it = await setItem(go, ['A', 'B']); const wrong = u('wr'), right = await person(); await claimParts(u('first'), it, ['A', 'B']); await claimParts(wrong, it, ['A']); await claimParts(u('third'), it, ['A', 'B']);
  const before = await holders(it); const c = (await claimsOf(wrong))[0]; assert.equal((await move([c.id], right.h)).status, 200); assert.equal(await holders(it), before.split(wrong).join(right.h));
  assert.equal((await api('PATCH', `/api/admin/claims/${c.id}`, { status: 'cancelled' })).status, 200); assert.ok(!(await holders(it)).includes(wrong), 'the old handle holds nothing'); assert.ok(!(await holders(it)).includes(right.h), 'the cancelled spot was released (someone moved up into it)');
});
