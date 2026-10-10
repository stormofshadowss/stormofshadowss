import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { planSetPlacement } from '../src/lib/sets.js';

let app, admin, w, S, P;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const add = (body) => app.api('POST', `/api/admin/orders/${w.order}/items`, body, admin).then((r) => r.json.id);
  S = await add({ type: 'set', title: 'Seasons Greetings', price: 3, requiresFullSet: true, members: ['Bang Chan', 'Han', { name: 'Diary', price: 2 }, { name: 'Washi tape', price: 1 }] });
  P = await add({ type: 'set', title: 'Photocard set', price: 8, members: ['A', 'B', 'C'] });
});
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const claimSet = (handle, itemId, parts, together = false) => app.api('POST', '/api/claims', { handle, lines: [{ itemId, parts: parts.map(([member, qty = 1]) => ({ member, qty })), together }] });
const sets = async (itemId) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === itemId);
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
let n = 0; const fresh = (p = 'u') => `${p}${++n}`;

// ───────── the placement rules on their own ─────────
const ROSTER = ['Bang Chan', 'Han', 'Diary', 'Washi tape'];
const sum = (plan) => plan.map((p) => `${p.member}→${p.setIdx}`).join(' ');

test('rules: 1 diary + 3 washi tapes into an empty item -> diary and a tape in Set 1, a tape in Set 2, a tape in Set 3', () => {
  assert.equal(sum(planSetPlacement(ROSTER, ['Diary', 'Washi tape', 'Washi tape', 'Washi tape'], false, [])), 'Diary→0 Washi tape→0 Washi tape→1 Washi tape→2');
});
test('rules: parts already taken push you to the next set that has room', () => {
  const held = [['Diary', 'Washi tape'], ['Washi tape']];
  assert.equal(sum(planSetPlacement(ROSTER, ['Diary', 'Washi tape', 'Washi tape', 'Washi tape'], false, held)), 'Diary→1 Washi tape→2 Washi tape→3 Washi tape→4');
});
test('rules: "together" goes round by round — one of each in a set, then the next one of each', () => {
  assert.equal(sum(planSetPlacement(ROSTER, ['Diary', 'Washi tape', 'Washi tape', 'Washi tape'], true, [])), 'Diary→0 Washi tape→0 Washi tape→1 Washi tape→2');
  assert.equal(sum(planSetPlacement(ROSTER, ['Han', 'Han', 'Diary'], true, [['Diary']])), 'Han→1 Diary→1 Han→0', 'round 1 needs a set with both free (Set 2); round 2 is Han alone, so Set 1');
});
test('rules: the whole set is one set, the next whole set is the next one — and a set never holds two of a part', () => {
  const plan = planSetPlacement(ROSTER, [...ROSTER, ...ROSTER], true, []);
  assert.deepEqual([...new Set(plan.filter((p) => p.setIdx === 0).map((p) => p.member))].length, 4);
  for (const idx of [0, 1]) assert.equal(plan.filter((p) => p.setIdx === idx).length, 4);
  const spread = planSetPlacement(ROSTER, Array(5).fill('Han'), false, [['Han']]);
  assert.deepEqual(spread.map((p) => p.setIdx), [1, 2, 3, 4, 5]);
});
test('rules: planning changes nothing it was given', () => {
  const held = [['Diary']]; planSetPlacement(ROSTER, ['Diary'], false, held);
  assert.deepEqual(held, [['Diary']]);
});

// ───────── claiming parts ─────────
test('claim 1 diary + 3 washi tapes in one request: they spread across 3 sets, priced per part, all "requested"', async () => {
  const h = fresh();
  const r = await claimSet(h, S, [['Diary'], ['Washi tape', 3]]);
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.placements.map((p) => [p.member, p.setNumber]), [['Diary', 1], ['Washi tape', 1], ['Washi tape', 2], ['Washi tape', 3]]);
  const rows = await claimsOf(h);
  assert.deepEqual(rows.map((c) => [c.label, c.status, c.costs.initials.cost]).sort(), [
    ['Seasons Greetings — Diary (Set 1)', 'requested', 2], ['Seasons Greetings — Washi tape (Set 1)', 'requested', 1],
    ['Seasons Greetings — Washi tape (Set 2)', 'requested', 1], ['Seasons Greetings — Washi tape (Set 3)', 'requested', 1]]);
  const db = await app.q('SELECT c.member_name, c.set_id, c.slot_id, sl.joiner_id, sl.member_name AS slot_member FROM claims c JOIN set_slots sl ON sl.id = c.slot_id JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ?', [h]);
  assert.equal(db.length, 4);
  assert.ok(db.every((d) => d.member_name === d.slot_member && d.set_id), 'each claim points at its own slot');
});

test('claim the whole set (together): one part of each in one set; a second whole set opens the next', async () => {
  const a = fresh(), b = fresh();
  const parts = ['Bang Chan', 'Han', 'Diary', 'Washi tape'].map((m) => [m]);
  const r1 = await claimSet(a, S, parts, true);                                    // Seasons: sets 1-3 already partly used above
  const sets1 = new Set(r1.json.placements.map((p) => p.setNumber));
  assert.equal(sets1.size, 1, 'all four parts went into ONE set');
  assert.equal(r1.json.placements.reduce((t, p) => t + p.price, 0), 9, 'the whole set costs the sum of its parts');
  const r2 = await claimSet(b, S, parts, true);
  const sets2 = new Set(r2.json.placements.map((p) => p.setNumber));
  assert.equal(sets2.size, 1); assert.ok([...sets2][0] > [...sets1][0], 'the next whole set goes in the next set');
});

test('claim validation: parts needed, real parts only, quantities capped, nothing left half-done', async () => {
  const h = fresh();
  const before = (await sets(S)).length;
  assert.equal((await api('POST', '/api/claims', { handle: h, lines: [{ itemId: S }] }, undefined)).status, 400, 'a set needs parts');
  assert.equal((await claimSet(h, S, [])).status, 400);
  const bad = await claimSet(h, S, [['Nobody']]);
  assert.equal(bad.status, 400); assert.match(bad.json.error, /isn't part of/);
  assert.equal((await claimSet(h, S, [['Han', 21]])).status, 400, 'at most 20 of one part');
  assert.equal((await claimSet(h, S, [['Han', 15], ['Han', 15]])).status, 400, 'merged repeats are capped too');
  // a good set line followed by a bad line: NOTHING is created, including the new sets
  const mixed = await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: S, parts: [{ member: 'Han', qty: 3 }] }, { itemId: 999999 }] });
  assert.equal(mixed.status, 404);
  assert.equal((await sets(S)).length, before, 'no stray sets were created');
  assert.equal((await claimsOf(h)).length, 0);
});

test('private and closed orders cannot have set parts claimed', async () => {
  const secretSet = (await api('POST', `/api/admin/orders/${w.secret}/items`, { type: 'set', title: 'Hidden set', price: 5, members: ['X', 'Y'] })).json.id;
  assert.equal((await claimSet(fresh(), secretSet, [['X']])).status, 404);
  const closed = (await api('POST', '/api/admin/orders', { groupId: w.group, title: 'Closed set GO', status: 'closed' })).json.id;
  const cs = (await api('POST', `/api/admin/orders/${closed}/items`, { type: 'set', title: 'Closed set', price: 5, members: ['X', 'Y'] })).json.id;
  assert.equal((await claimSet(fresh(), cs, [['X']])).json.code, 'order_closed');
});

test('STRESS: 12 people claiming the same part at the same instant each get their own set — none share, none fail', async () => {
  const set = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: 'Stress set', price: 4, members: ['One', 'Two'] })).json.id;
  const results = await Promise.all(Array.from({ length: 12 }, () => claimSet(fresh('st'), set, [['One']])));
  assert.ok(results.every((r) => r.status === 201), `all accepted (got ${[...new Set(results.map((r) => r.status))]})`);
  const placed = results.map((r) => r.json.placements[0].setNumber).sort((a, b) => a - b);
  assert.deepEqual(placed, Array.from({ length: 12 }, (_, i) => i + 1), 'Sets 1..12, one person in each');
  const dup = await app.q('SELECT COUNT(*) AS n FROM (SELECT set_id, member_name FROM set_slots GROUP BY set_id, member_name HAVING COUNT(*) > 1) x');
  assert.equal(dup[0].n, 0);
});

test('STRESS: 8 people each claiming the whole set at once: 8 whole sets, every part of every set held exactly once', async () => {
  const set = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: 'Whole stress', price: 2, members: ['P', 'Q', 'R'] })).json.id;
  const results = await Promise.all(Array.from({ length: 8 }, () => claimSet(fresh('wh'), set, [['P'], ['Q'], ['R']], true)));
  assert.ok(results.every((r) => r.status === 201));
  const all = await sets(set);
  assert.equal(all.length, 8);
  assert.ok(all.every((s) => s.filled === 3), 'each set is exactly full — no set got two people for one part');
});

test('two requests from the SAME person at once do not trip over each other', async () => {
  const h = fresh('same');
  const set = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: 'Same-person set', price: 2, members: ['M', 'N'] })).json.id;
  const rs = await Promise.all([claimSet(h, set, [['M']]), claimSet(h, set, [['M']]), claimSet(h, set, [['N']])]);
  assert.ok(rs.every((r) => r.status === 201));
  assert.equal((await claimsOf(h)).length, 3);
  assert.deepEqual((await sets(set)).map((s) => s.filled).sort(), [1, 2], 'M twice needs two sets; N fits in one of them');
});

// ───────── what the public can see ─────────
test('the public catalogue shows how many of each part are claimed and which parts each set has taken — never who', async () => {
  const h = fresh('pub');
  await claimSet(h, P, [['A'], ['B']]);
  const raw = JSON.stringify((await app.api('GET', '/api/orders')).json);
  const item = (await app.api('GET', '/api/orders')).json.orders.find((o) => o.title === 'Run It GO').items.find((i) => i.id === P);
  assert.equal(item.partsClaimed.A, 1);
  assert.deepEqual(item.sets[0], { number: 1, decision: 'none', taken: ['A', 'B'] });
  assert.ok(!raw.includes(h), 'no handle appears anywhere in the public data');
});

// ───────── the GOM: secure, cancel, fill a gap ─────────
test('securing: a set that needs every part is refused until full, then confirms every claim and what each person owes starts to count', async () => {
  const set = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: 'Needs all', price: 3, requiresFullSet: true, members: ['Bang Chan', 'Han', { name: 'Diary', price: 2 }] })).json.id;
  const a = fresh('sa'), b = fresh('sb');
  await claimSet(a, set, [['Bang Chan'], ['Diary']]);
  const [s1] = await sets(set);
  const refused = await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  assert.equal(refused.status, 409); assert.equal(refused.json.code, 'set_incomplete');
  assert.match(refused.json.error, /Every part of this set has to be claimed.*\(2\/3 so far\)/);
  assert.ok((await claimsOf(a)).every((c) => c.status === 'requested'), 'nothing changed');
  await claimSet(b, set, [['Han']]);
  const ok = await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  assert.deepEqual([ok.status, ok.json.secured, ok.json.openParts], [200, 3, 0]);
  assert.deepEqual((await claimsOf(a)).map((c) => c.status), ['confirmed', 'confirmed']);
  assert.equal((await api('POST', `/api/admin/sets/${s1.id}/secure`, {})).json.code, 'bad_state', 'securing twice is refused');
  assert.equal((await claimsOf(a)).reduce((t, c) => t + (c.costs.initials.cost - c.costs.initials.paid), 0), 5, 'Bang Chan £3 + Diary £2 is now owed');
});

test('securing an ordinary set with parts still open is allowed (the GOM decides); the open parts stay open', async () => {
  const h = fresh('so');
  await claimSet(h, P, [['A']]);                                                   // Photocard set: A, B, C
  const target = (await sets(P)).find((s) => s.parts.some((p) => p.handle === h));
  const r = await api('POST', `/api/admin/sets/${target.id}/secure`, {});
  assert.equal(r.status, 200);
  assert.ok(r.json.openParts >= 1);
  const after = (await sets(P)).find((s) => s.id === target.id);
  assert.equal(after.decision, 'secured');
  assert.ok(after.parts.some((p) => p.handle === null), 'some parts are still open');
});

test('new claims fill an OPEN spot in a secured set (staying requested) before a new set is started; once that set is full they go to the next one', async () => {
  const set = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: 'Fill secured', price: 3, members: ['U', 'V'] })).json.id;
  await claimSet(fresh('k'), set, [['U']]);
  const [s1] = await sets(set);
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  const h = fresh('k'); const r = await claimSet(h, set, [['V']]);                    // V is free in Set 1, which is secured: the set is bought, so the spot is real
  assert.equal(r.json.placements[0].setNumber, 1, 'it fills the open spot instead of starting Set 2');
  assert.equal((await claimsOf(h)).find((c) => c.label.startsWith('Fill secured')).status, 'requested', 'and waits for the GOM to confirm it');
  const r2 = await claimSet(fresh('k'), set, [['V']]);                                // Set 1 is full now
  assert.equal(r2.json.placements[0].setNumber, 2);
});

test('the generic "secure" and a hand-confirm never touch the parts of a set still waiting for a decision — only the Sets screen does', async () => {
  const h = fresh('gen');
  await claimSet(h, P, [['C']]);
  await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: w.keyring }] });
  const r = await api('POST', '/api/admin/claims/secure', { orderId: w.order });
  assert.ok(r.json.secured >= 1);
  const rows = await claimsOf(h);
  assert.equal(rows.find((c) => c.label === 'Keyring').status, 'confirmed');
  assert.equal(rows.find((c) => /Photocard set/.test(c.label)).status, 'requested', 'the set part waits for its set');
  const part = rows.find((c) => /Photocard set/.test(c.label));
  const direct = await api('PATCH', `/api/admin/claims/${part.id}`, { status: 'confirmed' });
  assert.equal(direct.status, 400); assert.equal(direct.json.code, 'set_part');
  assert.equal(rows.find((c) => /Photocard set/.test(c.label)).setId > 0, true, 'the claims list says which are set parts');
});

test('cancelling a set: everything is cancelled, paid money comes back as credit, the parts are free again', async () => {
  const h = fresh('cs');
  const c = await joinerSession(app, `${h}@x.com`, h);
  const set = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: 'Cancel me', price: 10, members: ['K', 'L'] })).json.id;
  await claimSet(h, set, [['K'], ['L']]);
  const [s1] = await sets(set);
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 20, reference: 'CS' }, c);
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});

  const r = await api('POST', `/api/admin/sets/${s1.id}/cancel`, {});
  assert.deepEqual([r.status, r.json.cancelled, r.json.refunded, r.json.forfeited], [200, 2, 20, 0]);
  assert.equal((await app.api('GET', '/api/my/summary', undefined, c)).json.credit, 20);
  assert.equal((await sets(set))[0].decision, 'cancelled');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM set_slots WHERE set_id = ?', [s1.id]))[0].n, 0, 'the parts are free');
  assert.equal((await api('POST', `/api/admin/sets/${s1.id}/cancel`, {})).json.code, 'bad_state');
  const again = await claimSet(fresh('cs'), set, [['K']]);
  assert.equal(again.json.placements[0].setNumber, 2, 'a cancelled set takes no new claims; numbering carries on');
});

test('cancelling a set for a blocked handle records the money as forfeited, not credit', async () => {
  const h = fresh('bl');
  const c = await joinerSession(app, `${h}@x.com`, h);
  const set = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: 'Forfeit set', price: 5, members: ['K'] })).json.id;
  await claimSet(h, set, [['K']]);
  const [s1] = await sets(set);
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 5, reference: 'BL' }, c).then((p) => api('POST', `/api/admin/payments/${p.json.id}/verify`, {}));
  await api('POST', '/api/admin/joiners/block', { handle: h, reason: 'test' });
  const r = await api('POST', `/api/admin/sets/${s1.id}/cancel`, {});
  assert.deepEqual([r.json.refunded, r.json.forfeited], [0, 5]);
});

test('cancelling ONE claim in a set frees just that part for someone else', async () => {
  const h = fresh('one');
  const set = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: 'Free one', price: 3, members: ['G', 'H'] })).json.id;
  await claimSet(h, set, [['G'], ['H']]);
  const g = (await claimsOf(h)).find((x) => /— G /.test(x.label));
  assert.equal((await api('PATCH', `/api/admin/claims/${g.id}`, { status: 'cancelled' })).status, 200);
  const r = await claimSet(fresh('one'), set, [['G']]);
  assert.equal(r.json.placements[0].setNumber, 1, 'G is free again in Set 1');
});

test('putting someone into an open part by hand: pending in an unsecured set, confirmed in a secured one; occupied or unknown parts are refused', async () => {
  const set = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: 'Fill gaps', price: 6, members: ['E', 'F', 'G'] })).json.id;
  await claimSet(fresh('fg'), set, [['E']]);
  const [s1] = await sets(set);
  const add = (member, handle) => api('POST', `/api/admin/sets/${s1.id}/slots`, { member, handle });
  const h = fresh('fillin');
  const r1 = await add('F', `@${h}`);
  assert.deepEqual([r1.status, r1.json.status], [201, 'requested']);
  assert.equal((await add('F', fresh('x'))).json.code, 'slot_taken');
  assert.equal((await add('Nope', fresh('x'))).status, 400);
  assert.equal((await add('G', 'bad handle!')).status, 400);
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  const r2 = await add('G', fresh('late'));
  assert.deepEqual([r2.status, r2.json.status], [201, 'confirmed'], 'joining an already-secured set is confirmed straight away');
  assert.equal((await claimsOf(h))[0].is_direct, true);
  await api('POST', '/api/admin/joiners/block', { handle: 'blocked_set', reason: 'x' });
  const set2 = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: 'Blocked try', price: 1, members: ['Z'] })).json.id;
  await claimSet(fresh('bt'), set2, [['Z']]);
  const [t1] = await sets(set2);
  await api('POST', `/api/admin/sets/${t1.id}/cancel`, {});
  assert.equal((await api('POST', `/api/admin/sets/${t1.id}/slots`, { member: 'Z', handle: fresh('x') })).json.code, 'bad_state', 'not into a cancelled set');
  const spare = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: 'Blocked target 2', price: 1, members: ['Y', 'Z'] })).json.id;
  await claimSet(fresh('bt'), spare, [['Y']]);
  const [sp] = await sets(spare);
  const blocked = await api('POST', `/api/admin/sets/${sp.id}/slots`, { member: 'Z', handle: 'blocked_set' });
  assert.deepEqual([blocked.status, blocked.json.code], [403, 'handle_blocked'], 'a blocked handle cannot be put into a set');
});

test('set endpoints are the GOM only; the listing shows who holds each part', async () => {
  const joiner = await app.login('plain.joiner@x.com');
  const [any] = await sets(S);
  for (const [m, p, b] of [['GET', '/api/admin/sets'], ['POST', `/api/admin/sets/${any.id}/secure`, {}], ['POST', `/api/admin/sets/${any.id}/cancel`, {}], ['POST', `/api/admin/sets/${any.id}/slots`, { member: 'Han', handle: 'x' }]]) {
    assert.equal((await api(m, p, b, joiner)).status, 403, p);
  }
  assert.equal((await api('POST', '/api/admin/sets/999999/secure', {})).status, 404);
  const first = (await sets(S))[0];
  assert.deepEqual(first.parts.map((p) => p.member), ['Bang Chan', 'Han', 'Diary', 'Washi tape'], 'parts in roster order');
  assert.ok(first.parts.some((p) => p.handle) && first.total === 4);
  assert.equal(first.parts.find((p) => p.member === 'Diary').price, 2);
});

test('INVARIANTS: no part of a set is ever held twice, every set-claim has its slot, cancelled claims hold none', async () => {
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM (SELECT set_id, member_name FROM set_slots GROUP BY set_id, member_name HAVING COUNT(*) > 1) x'))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims WHERE set_id IS NOT NULL AND status <> 'cancelled' AND slot_id IS NULL"))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims WHERE status = 'cancelled' AND slot_id IS NOT NULL"))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM set_slots sl LEFT JOIN claims c ON c.slot_id = sl.id WHERE c.id IS NULL'))[0].n, 0, 'no orphan slots');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost'))[0].n, 0);
});
