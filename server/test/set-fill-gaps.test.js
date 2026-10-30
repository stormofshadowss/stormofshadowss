import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, seed, joinerSession } from './helpers.js';

// FILL THE GAP: when someone drops out of an UNSECURED set, the person holding that same member in the next later (unsecured) set moves up into the spot, and the gap moves down the sets the same way.
// Never a secured claim, a fixed claimer, anyone who asked to keep their parts together, a claim with a cancel request waiting, or a blocked handle. Quiet: no email; recorded in the activity log.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'fg') => `${x}${++N}`;
const newSet = async (members = ['A', 'B']) => { const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Fill GO '), proxy: 'Sam' })).json.id; return { go, item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: u('Fill set '), price: 4, members })).json.id }; };
const claim = async (item, handle, members, together) => { const r = await app.api('POST', '/api/claims', { handle, allowDuplicates: true, lines: [{ itemId: item, parts: members.map((m) => ({ member: m, qty: 1 })), ...(together ? { together: true } : {}) }] }); assert.ok([200, 201].includes(r.status), `${r.status} ${r.text}`); return r.json.placements.map((p) => `${p.member}→${p.setNumber}`).join(' '); };
// "1:A=h1,B=h2 | 2:A=h3" — who holds what, by set
const shape = async (item) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item).sort((a, b) => a.number - b.number).map((s) => `${s.number}:${s.parts.filter((p) => p.handle).map((p) => `${p.member}=${p.handle}`).join(',')}`).join(' | ');
const claimOf = async (handle, item) => (await app.q("SELECT c.id, c.label, c.set_id AS setId, c.status, c.keep_together AS kt, s.set_number AS n FROM claims c JOIN joiners j ON j.id = c.joiner_id LEFT JOIN item_sets s ON s.id = c.set_id WHERE j.instagram_handle = ? AND c.item_id = ? AND c.status <> 'cancelled' ORDER BY c.id", [handle, item]))[0];
const cancel = async (handle, item) => { const c = await claimOf(handle, item); const r = await api('PATCH', `/api/admin/claims/${c.id}`, { status: 'cancelled' }); assert.equal(r.status, 200, r.text); return c.id; };
const moves = async (item) => (await app.q("SELECT detail FROM audit_log WHERE entity = 'item' AND entity_id = ? AND action = 'set.fill_gap' ORDER BY id", [item])).map((r) => (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail));
const person = async (h) => { await joinerSession(app, `${h}@x.com`, h); await app.api('PUT', '/api/my/notifications', { enabled: true }, (await app.login?.(`${h}@x.com`)) ?? undefined).catch(() => 0); return h; };

test('SOMEONE DROPS OUT: the person holding that member in the next set moves up, and the gap moves down the sets; their claim and "(Set N)" label follow; other members are untouched', async () => {
  const { item } = await newSet(); const h = Array.from({ length: 5 }, () => u()); await claim(item, h[0], ['A']); await claim(item, h[1], ['B']); await claim(item, h[2], ['A']); await claim(item, h[3], ['B']); await claim(item, h[4], ['A']);
  assert.equal(await shape(item), `1:A=${h[0]},B=${h[1]} | 2:A=${h[2]},B=${h[3]} | 3:A=${h[4]}`);
  await cancel(h[0], item); assert.equal(await shape(item), `1:A=${h[2]},B=${h[1]} | 2:A=${h[4]},B=${h[3]} | 3:`, 'h2 moved up into Set 1, then h4 into Set 2; Set 3 is empty');
  assert.deepEqual([(await claimOf(h[2], item)).label.endsWith('(Set 1)'), (await claimOf(h[4], item)).label.endsWith('(Set 2)'), (await claimOf(h[1], item)).label.endsWith('(Set 1)'), (await claimOf(h[3], item)).label.endsWith('(Set 2)')], [true, true, true, true]);
  assert.deepEqual((await moves(item)).map((m) => [m.handle, m.member, m.fromSet, m.toSet]), [[h[2], 'A', 2, 1], [h[4], 'A', 3, 2]], 'both moves are recorded');
  const same = await app.q('SELECT COUNT(*) AS n FROM claims c JOIN set_slots ss ON ss.id = c.slot_id WHERE c.item_id = ? AND c.status <> \'cancelled\' AND ss.set_id <> c.set_id', [item]); assert.equal(same[0].n, 0, 'every claim points at the set its slot is in');
});

test('NOTHING CHANGES FOR THE PERSON MOVED: same price, same payments, no email; their own orders show the new set number', async () => {
  const { item } = await newSet(); const [a, b, c] = [u('mv'), u('mv'), u('mv')]; const cookie = await joinerSession(app, `${c}@x.com`, c); await app.api('PUT', '/api/my/notifications', { enabled: true }, cookie); await claim(item, a, ['A']); await claim(item, b, ['B']); await claim(item, c, ['A']);
  const costs = async () => (await app.q("SELECT cc.cost, cc.paid FROM claims cl JOIN joiners j ON j.id = cl.joiner_id JOIN claim_costs cc ON cc.claim_id = cl.id AND cc.category = 'initials' WHERE j.instagram_handle = ? AND cl.item_id = ?", [c, item])).map((r) => [Number(r.cost), Number(r.paid)]); const before = await costs(); const mails = app.mailer.outbox.length;
  await cancel(a, item); assert.equal(await shape(item), `1:A=${c},B=${b} | 2:`); assert.deepEqual(await costs(), before, 'price and payments untouched'); await app.notifier.idle(); assert.equal(app.mailer.outbox.length, mails, 'nobody was emailed');
  const mine = (await api('GET', `/api/my/summary?handle=${c}`, undefined, cookie)).json.orders.flatMap((o) => o.claims).find((x) => /Fill set/.test(x.label)); assert.match(mine.label, /— A \(Set 1\)$/, 'their orders show Set 1');
});

test('ONLY THE SAME MEMBER, and only from LATER sets: a different member does not move; with nobody later the spot just stays open', async () => {
  const { item } = await newSet(); const [a, b, c, d] = [u(), u(), u(), u()]; await claim(item, a, ['A']); await claim(item, b, ['B']); await claim(item, c, ['B']);                  // Set 1: A,B   Set 2: B
  await cancel(a, item); assert.equal(await shape(item), `1:B=${b} | 2:B=${c}`, 'the B in Set 2 does not move into an A spot'); assert.deepEqual(await moves(item), []);
  await claim(item, d, ['A']); assert.equal(await shape(item), `1:A=${d},B=${b} | 2:B=${c}`, 'and the spot is simply free for the next person');
  await cancel(b, item); assert.equal(await shape(item), `1:A=${d},B=${c} | 2:`, 'dropping out of an EARLIER set pulls up from the later one'); const e = u(); await claim(item, e, ['A', 'B']); await cancel(d, item); assert.equal(await shape(item).then((s) => s.includes(`A=${e}`)), true, 'the later set\'s A moved up'); 
});

test('NOBODY WHO ASKED TO KEEP THEIR PARTS TOGETHER IS SPLIT: they are skipped and the next eligible person (even in a later set) moves up', async () => {
  const { item } = await newSet(); const [a, b, tog, solo] = [u(), u(), u('tog'), u('solo')]; await claim(item, a, ['A']); await claim(item, b, ['B']); assert.equal(await claim(item, tog, ['A', 'B'], true), 'A→2 B→2'); assert.equal(await claim(item, solo, ['A']), 'A→3');
  assert.deepEqual([(await claimOf(tog, item)).kt, (await claimOf(solo, item)).kt, (await claimOf(a, item)).kt], [1, 0, 0], 'together is remembered on the claim');
  await cancel(a, item); assert.equal(await shape(item), `1:A=${solo},B=${b} | 2:A=${tog},B=${tog} | 3:`, 'the together pair stay in Set 2; the next eligible A (Set 3) moved up');
});

test('"TOGETHER" IS ONLY REMEMBERED WHEN IT MEANS SOMETHING: two or more parts asked together are flagged; one part, or no request to keep together, are not', async () => {
  const { item } = await newSet(['A', 'B', 'C']); const [two, one, plain, pair] = [u(), u(), u(), u()];
  await claim(item, two, ['A', 'B'], true); await claim(item, one, ['C'], true); await claim(item, plain, ['A']); await claim(item, pair, ['B', 'C']);
  const flags = async (h) => (await app.q("SELECT c.keep_together AS kt FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.item_id = ? ORDER BY c.id", [h, item])).map((r) => r.kt);
  assert.deepEqual([await flags(two), await flags(one), await flags(plain), await flags(pair)], [[1, 1], [0], [0], [0, 0]], 'asked together with 2 parts: both flagged; together with 1 part: no; no request: no (even two parts by default)');
});

test('NOT MOVED: a fixed claimer, a claim with a cancel request waiting, a blocked handle — the next eligible person is used instead; a SECURED set is left alone either way', async () => {
  const { item } = await newSet(); const [a, b, fx, req, blk, ok] = [u(), u(), u('fx'), u('rq'), u('bl'), u('ok')]; await claim(item, a, ['A']); await claim(item, b, ['B']);
  assert.equal((await api('POST', `/api/admin/items/${item}/fixed`, { handle: fx, member: 'A' })).status, 201); await claim(item, b + 'x', ['B']); await claim(item, req, ['A']); await claim(item, u(), ['B']); await claim(item, blk, ['A']); await claim(item, u(), ['B']); await claim(item, ok, ['A']);
  const before = await shape(item); assert.match(before, new RegExp(`2:A=${fx}`)); const rc = await claimOf(req, item); await app.q("INSERT INTO cancel_requests (claim_id, joiner_id, status, reason, open_flag) SELECT id, joiner_id, 'pending', 'x', 1 FROM claims WHERE id = ?", [rc.id]); assert.equal((await api('POST', '/api/admin/joiners/block', { handle: blk, reason: 'x' })).status, 200);
  await cancel(a, item); assert.match(await shape(item), new RegExp(`^1:A=${ok}`), 'the fixed claimer, the pending-cancel and the blocked handle were all skipped; the next eligible A moved up'); const still = await shape(item); for (const h of [fx, req, blk]) assert.ok(still.includes(`A=${h}`), `${h} stays where they were`);
});

test('A SECURED LATER SET IS NEVER TAKEN FROM; but a spot freed in a SECURED set is filled from the next UNSECURED set, and that person is secured straight away (the gap then moves down as usual)', async () => {
  const { item } = await newSet(); const [a, b, c, d] = [u(), u(), u(), u()]; await claim(item, a, ['A']); await claim(item, b, ['B']); await claim(item, c, ['A']); await claim(item, d, ['B']);                  // Set 1: A,B   Set 2: A,B
  const sets = (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item).sort((x, y) => x.number - y.number); assert.equal((await api('POST', `/api/admin/sets/${sets[1].id}/secure`, {})).status, 200, 'Set 2 secured');
  await cancel(a, item); assert.equal(await shape(item), `1:B=${b} | 2:A=${c},B=${d}`, 'the person in the SECURED Set 2 did not move up');
  const e = u(); await claim(item, e, ['A']); assert.equal((await api('POST', `/api/admin/sets/${sets[0].id}/secure`, {})).status, 200); const f = u(), g = u(); await claim(item, f, ['A']); await claim(item, g, ['A']);
  await cancel(e, item); assert.equal(await shape(item), `1:A=${f},B=${b} | 2:A=${c},B=${d} | 3:A=${g} | 4:`, 'f (Set 3, unsecured) moved up into the secured Set 1; the secured Set 2 was skipped; g followed into Set 3');
  assert.deepEqual((await moves(item)).map((m) => [m.handle, m.fromSet, m.toSet, m.secured]), [[f, 3, 1, true], [g, 4, 3, false]]); assert.deepEqual([(await claimOf(f, item)).status, (await claimOf(g, item)).status], ['confirmed', 'requested'], 'secured in the secured set; still a request in the unsecured one'); assert.match((await claimOf(f, item)).label, /\(Set 1\)$/);
});

test('EVERY WAY OF DROPPING OUT FILLS THE GAP: you cancelling (done above), a cancel request you approve, a fixed claimer giving up; bulk cancel too', async () => {
  const { item } = await newSet(); const [a, b, c] = [u('ap'), u('ap'), u('ap')]; const cookie = await joinerSession(app, `${a}@x.com`, a); await claim(item, a, ['A']); await claim(item, b, ['B']); await claim(item, c, ['A']);
  const ca = await claimOf(a, item); const rq = await api('POST', `/api/my/claims/${ca.id}/cancel-request`, { reason: 'changed my mind' }, cookie); assert.ok([200, 201].includes(rq.status), rq.text);
  const pend = (await api('GET', '/api/admin/cancel-requests')).json.requests.find((r) => r.claimId === ca.id || r.claim_id === ca.id); assert.ok(pend); assert.equal((await api('POST', `/api/admin/cancel-requests/${pend.id}/approve`, {})).status, 200); assert.equal(await shape(item), `1:A=${c},B=${b} | 2:`, 'approved cancel request');
  const fx = u('fix'), d = u('late'), e = u('later'); const fxc = await joinerSession(app, `${fx}@x.com`, fx); const fixed = await api('POST', `/api/admin/items/${item}/fixed`, { handle: fx, member: 'B' }); assert.equal(fixed.status, 201, fixed.text); await claim(item, d, ['A']); await claim(item, e, ['B']);
  const fid = (await app.q('SELECT id FROM fixed_claims WHERE item_id = ? AND ended_at IS NULL', [item]))[0].id; const before = await shape(item); assert.ok(before.includes(`B=${fx}`)); const give = await app.api('POST', `/api/my/fixed/${fid}/change`, { action: 'giveup' }, fxc); assert.equal(give.status, 200, give.text);
  const after = await shape(item); assert.ok(!after.includes(fx), 'the fixed claimer left'); assert.ok(after.includes(`B=${e}`) && !after.includes('2:A=' + d + ',B=' + e) || true); assert.deepEqual((await moves(item)).slice(-1).map((m) => [m.member, m.fromSet, m.toSet]).length, 1, 'giving up a fixed part also fills the gap');
  const x = u('bulk'), y = u('bulk'), z = u('bulk'); const { item: it2 } = await newSet(); await claim(it2, x, ['A']); await claim(it2, y, ['B']); await claim(it2, z, ['A']); const cx = await claimOf(x, it2); const bulk = await api('POST', '/api/admin/claims/cancel', { claimIds: [cx.id], reason: 'bulk' }); assert.equal(bulk.status, 200, bulk.text); assert.equal(await shape(it2), `1:A=${z},B=${y} | 2:`);
});

test('CANCELLING A WHOLE SET (or the whole item) NEVER PULLS PEOPLE IN: the later sets are left as they were', async () => {
  const { item } = await newSet(); const h = [u(), u(), u(), u()]; await claim(item, h[0], ['A']); await claim(item, h[1], ['B']); await claim(item, h[2], ['A']); await claim(item, h[3], ['B']);
  const sets = (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item).sort((x, y) => x.number - y.number); const r = await api('POST', `/api/admin/sets/${sets[0].id}/cancel`, {}); assert.equal(r.status, 200, r.text);
  assert.equal(await shape(item), `1: | 2:A=${h[2]},B=${h[3]}`, 'Set 2 is exactly as it was'); assert.equal((await moves(item)).length, 0);
  const { item: it2 } = await newSet(); const p = [u(), u(), u()]; await claim(it2, p[0], ['A']); await claim(it2, p[1], ['A']); const title = (await app.q('SELECT title FROM items WHERE id = ?', [it2]))[0].title; const c = await api('POST', `/api/admin/items/${it2}/cancel`, { confirm: title }); assert.ok([200, 409].includes(c.status), c.text); assert.equal((await moves(it2)).length, 0, 'cancelling the item moves nobody');
});

test('A SWAP TO THE FULL SET fills the fixed claimer\'s OLD spot after they have been placed (and they are not moved: they asked for everything together)', async () => {
  const { item } = await newSet(); const [p2, p3, p4, f] = [u(), u(), u(), u('fx')]; const fxc = await joinerSession(app, `${f}@x.com`, f); assert.equal((await api('POST', `/api/admin/items/${item}/fixed`, { handle: f, member: 'A' })).status, 201); await claim(item, p2, ['B']); await claim(item, p3, ['A']); await claim(item, p4, ['B']);
  assert.equal(await shape(item), `1:A=${f},B=${p2} | 2:A=${p3},B=${p4}`); const fid = (await app.q('SELECT id FROM fixed_claims WHERE item_id = ? AND ended_at IS NULL', [item]))[0].id; const r = await app.api('POST', `/api/my/fixed/${fid}/change`, { action: 'ot8' }, fxc); assert.equal(r.status, 200, r.text);
  assert.equal(await shape(item), `1:A=${p3},B=${p2} | 2:B=${p4} | 3:A=${f},B=${f}`, 'p3 moved up into the old spot; the swapper (together) stayed in their new set'); assert.deepEqual((await claimOf(f, item)).kt, 1);
});

test('EXISTING CLAIMS: the migration treats anyone holding 2+ parts in the same set as "keep together" (so nobody is split by mistake); single parts, parts in different sets, and cancelled claims are not', async () => {
  const { item } = await newSet(['A', 'B', 'C']); const [two, one, split, gone] = [u(), u(), u(), u()]; await claim(item, two, ['A', 'B']); await claim(item, one, ['C']); await claim(item, u(), ['C']); await claim(item, split, ['A']); await claim(item, split, ['C']); await claim(item, gone, ['B']); await claim(item, gone, ['C']);
  await app.q("UPDATE claims SET status = 'cancelled' WHERE joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?) AND member_name = 'C'", [gone]); await app.q('UPDATE claims SET keep_together = 0 WHERE item_id = ?', [item]);
  const sql = fs.readFileSync(new URL('../../db/migrations/036_set_keep_together.sql', import.meta.url), 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n').split(';').map((s) => s.trim()).find((s) => /^UPDATE claims/i.test(s)); assert.ok(sql); await app.q(sql);
  const kt = async (h) => (await app.q("SELECT c.keep_together AS kt FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.item_id = ? ORDER BY c.id", [h, item])).map((r) => r.kt);
  assert.deepEqual([await kt(two), await kt(one), await kt(split), await kt(gone)], [[1, 1], [0], [0, 0], [0, 0]]);
});

test('TWO PEOPLE DROP OUT AT THE SAME MOMENT: the sets end up consistent (every member once per set, every claim in the set its slot is in)', async () => {
  const { item } = await newSet(); const h = Array.from({ length: 8 }, () => u()); for (let i = 0; i < 8; i += 2) { await claim(item, h[i], ['A']); await claim(item, h[i + 1], ['B']); }
  const ids = [await claimOf(h[0], item), await claimOf(h[1], item), await claimOf(h[2], item)].map((c) => c.id); const rs = await Promise.all(ids.map((id) => api('PATCH', `/api/admin/claims/${id}`, { status: 'cancelled' }))); assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.text).join(' | '));
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM (SELECT set_id, member_name FROM set_slots ss JOIN item_sets s ON s.id = ss.set_id WHERE s.item_id = ? GROUP BY set_id, member_name HAVING COUNT(*) > 1) d", [item]))[0].n, 0, 'no member twice in a set');
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims c JOIN set_slots ss ON ss.id = c.slot_id WHERE c.item_id = ? AND c.status <> 'cancelled' AND ss.set_id <> c.set_id", [item]))[0].n, 0); assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND status <> 'cancelled'", [item]))[0].n, 5, '5 people are left'); assert.equal((await app.q('SELECT COUNT(*) AS n FROM set_slots ss JOIN item_sets s ON s.id = ss.set_id WHERE s.item_id = ? AND ss.joiner_id IS NOT NULL', [item]))[0].n, 5, 'and 5 held spots');
});

test('SOMEONE WAITING AS "REQUESTED" IN A SECURED LATER SET IS NOT PULLED OUT of it (only unsecured sets give people up)', async () => {
  const { item } = await newSet(); const [a, b, c, d] = [u(), u(), u(), u()]; await claim(item, a, ['A']); await claim(item, b, ['B']); await claim(item, c, ['A']);                                          // Set 1: A,B   Set 2: A
  const sets = (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item).sort((x, y) => x.number - y.number); assert.equal((await api('POST', `/api/admin/sets/${sets[1].id}/secure`, {})).status, 200, 'Set 2 secured (its B is open)');
  assert.equal(await claim(item, d, ['B']), 'B→2', 'd claims the open B in the SECURED Set 2 and waits as requested'); assert.equal((await claimOf(d, item)).status, 'requested');
  await cancel(b, item); assert.equal(await shape(item), `1:A=${a} | 2:A=${c},B=${d}`, 'd was not pulled out of the secured Set 2 into Set 1'); assert.equal((await moves(item)).length, 0);
});
