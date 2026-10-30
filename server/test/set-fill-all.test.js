import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';

// "FILL GAPS" (Sets tab): fill every EXISTING open spot the way a drop-out would — in unsecured AND secured sets — after a preview that shows exactly who would move. People come from later UNSECURED sets only;
// someone moved into a SECURED set is secured straight away (quietly).
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'fa') => `${x}${++N}`;
const newSet = async (members = ['A', 'B'], extra = {}, title = u('FillAll set ')) => { const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('FillAll GO '), proxy: 'Sam' })).json.id; return { go, item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title, price: 4, members, ...extra })).json.id }; };
const claim = async (item, handle, members) => { const r = await app.api('POST', '/api/claims', { handle, allowDuplicates: true, lines: [{ itemId: item, parts: members.map((m) => ({ member: m, qty: 1 })) }] }); assert.ok([200, 201].includes(r.status), `${r.status} ${r.text}`); return r.json; };
const shape = async (item) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item).sort((a, b) => a.number - b.number).map((s) => `${s.number}:${s.parts.filter((p) => p.handle).map((p) => `${p.member}=${p.handle}`).join(',')}`).join(' | ');
const claimOf = async (handle, item) => (await app.q("SELECT c.id, c.label, c.status, c.set_id AS setId FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.item_id = ? AND c.status <> 'cancelled' ORDER BY c.id", [handle, item]))[0];
// leave a gap the way the OLD code did (before spots were filled automatically): the claim is cancelled and its slot freed, with nobody moved up
const strand = async (handle, item) => { const c = await claimOf(handle, item); const [{ slot_id: slot }] = await app.q('SELECT slot_id FROM claims WHERE id = ?', [c.id]); await app.q("UPDATE claims SET status = 'cancelled', slot_id = NULL WHERE id = ?", [c.id]); await app.q('DELETE FROM set_slots WHERE id = ?', [slot]); };
const secure = async (item, n) => { const s = (await api('GET', '/api/admin/sets')).json.sets.find((x) => x.itemId === item && x.number === n); const r = await api('POST', `/api/admin/sets/${s.id}/secure`, {}); assert.equal(r.status, 200, r.text); };
const preview = () => api('GET', '/api/admin/sets/fill-gaps'); const run = (c = admin) => api('POST', '/api/admin/sets/fill-gaps', {}, c);
const dbShape = async (item) => JSON.stringify(await app.q('SELECT s.set_number AS n, ss.member_name AS m, j.instagram_handle AS h FROM set_slots ss JOIN item_sets s ON s.id = ss.set_id LEFT JOIN joiners j ON j.id = ss.joiner_id WHERE s.item_id = ? ORDER BY s.set_number, ss.member_name', [item]));
const snapshot = async () => JSON.stringify(await app.q("SELECT id, set_id, slot_id, label, status FROM claims ORDER BY id"));
const mine = (r, item) => r.json.moves.filter((m) => m.itemId === item).map((m) => [m.handle, m.member, m.fromSet, m.toSet, m.secured]);

test('EXISTING GAPS (UNSECURED): the preview lists every move — the gaps cascade down — and changes NOTHING; confirming does exactly those moves; running it again finds nothing', async () => {
  const { item } = await newSet(); const h = Array.from({ length: 6 }, () => u()); for (const [i, m] of [['A'], ['B'], ['A'], ['B'], ['A'], ['B']].entries()) await claim(item, h[i], m);                    // Set 1: A,B  Set 2: A,B  Set 3: A,B
  await strand(h[0], item); await strand(h[3], item); assert.equal(await shape(item), `1:B=${h[1]} | 2:A=${h[2]} | 3:A=${h[4]},B=${h[5]}`, 'two gaps: A in Set 1, B in Set 2');
  const before = await snapshot(); const p = await preview(); assert.equal(p.status, 200, p.text); assert.deepEqual(mine(p, item), [[h[2], 'A', 2, 1, false], [h[4], 'A', 3, 2, false], [h[5], 'B', 3, 2, false]]); assert.equal(p.json.total, 3);
  assert.equal(await snapshot(), before, 'the preview changed nothing'); assert.equal((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'set.fill_gap'")).length, 1);
  const r = await run(); assert.equal(r.status, 200, r.text); assert.deepEqual(mine(r, item), mine(p, item), 'what happened is exactly what the preview said'); assert.equal(await shape(item), `1:A=${h[2]},B=${h[1]} | 2:A=${h[4]},B=${h[5]} | 3:`);
  for (const [who, set] of [[h[2], 1], [h[4], 2], [h[5], 2]]) assert.match((await claimOf(who, item)).label, new RegExp(`\\(Set ${set}\\)$`)); const again = await run(); assert.equal(again.json.total, 0, 'nothing left to fill'); assert.equal((await preview()).json.total, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'item' AND entity_id = ? AND action = 'set.fill_gap'", [item]))[0].n, 3, 'each move recorded'); assert.ok((await app.q("SELECT 1 FROM audit_log WHERE action = 'sets.fill_gaps'")).length >= 1);
});

test('A GAP IN A SECURED SET: someone from the next UNSECURED set moves up and is SECURED STRAIGHT AWAY (their price unchanged, existing credit applied); a secured later set is never taken from', async () => {
  const { item } = await newSet(); const [a, b, c, d, e] = [u(), u(), u(), u(), u()]; await claim(item, a, ['A']); await claim(item, b, ['B']); await claim(item, c, ['A']); await claim(item, d, ['B']); await claim(item, e, ['A']);              // Set 1: A,B  Set 2: A,B  Set 3: A
  await secure(item, 1); await strand(a, item); assert.equal((await api('GET', '/api/admin/sets')).json.sets.find((s) => s.itemId === item && s.number === 1).decision, 'secured');
  const jc = (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [c]))[0].id; await app.q("INSERT INTO credit_ledger (joiner_id, kind, amount, balance_effect, reason, source) VALUES (?, 'credit', 4, 4, 'test credit', 'test')", [jc]);
  const p = await preview(); assert.deepEqual(mine(p, item), [[c, 'A', 2, 1, true], [e, 'A', 3, 2, false]], 'c is secured in Set 1; e moves into the (unsecured) Set 2 as a request'); const r = await run(); assert.deepEqual(mine(r, item), mine(p, item));
  assert.equal(await shape(item), `1:A=${c},B=${b} | 2:B=${d},A=${e}`.replace('B=' + d + ',A=' + e, 'A=' + e + ',B=' + d) + ' | 3:'); const cl = await claimOf(c, item); assert.deepEqual([cl.status], ['confirmed'], 'secured'); assert.equal((await claimOf(e, item)).status, 'requested');
  const cost = (await app.q("SELECT cost, paid FROM claim_costs WHERE claim_id = ? AND category = 'initials'", [cl.id]))[0]; assert.deepEqual([Number(cost.cost), Number(cost.paid)], [4, 4], 'same price; the credit they already had now meets it (as for any newly secured claim)');
  const { item: it2 } = await newSet(); const [p1, p2, p3, p4] = [u(), u(), u(), u()]; await claim(it2, p1, ['A']); await claim(it2, p2, ['B']); await claim(it2, p3, ['A']); await claim(it2, p4, ['B']); await secure(it2, 2); await strand(p1, it2);
  assert.equal(mine(await run(), it2).length, 0, 'the only A later is in a SECURED set: nobody is taken from it'); assert.equal(await shape(it2), `1:B=${p2} | 2:A=${p3},B=${p4}`);
});

test('A CLAIM WHOSE PRICE IS STILL TBC CANNOT MOVE INTO A SECURED SET (it would have to be secured); it can move into an unsecured one', async () => {
  const { item } = await newSet(['A', 'B'], { price: undefined, priceTbc: true, members: [{ name: 'A', price: 2 }, 'B'] }); const [a, b0, x] = [u(), u(), u()]; await claim(item, a, ['A']); await claim(item, b0, ['B']); await claim(item, x, ['A']); await claim(item, x + 'b', ['B']);
  const setRows = (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item).sort((p, q) => p.number - q.number); void setRows; await strand(b0, item); await app.q("UPDATE item_sets SET admin_decision = 'secured' WHERE item_id = ? AND set_number = 1", [item]);
  assert.equal((await claimOf(x + 'b', item)).status, 'requested'); const r = await run(); assert.equal(mine(r, item).length, 0, 'the TBC B in Set 2 stays put: Set 1 is secured'); assert.match(await shape(item), /2:A=.*,B=/);
  await app.q("UPDATE item_sets SET admin_decision = 'none' WHERE item_id = ? AND set_number = 1", [item]); const r2 = await run(); assert.deepEqual(mine(r2, item).map((m) => [m[1], m[2], m[3]]), [['B', 2, 1]], 'with Set 1 unsecured it does move');
});

test('SEVERAL ITEMS AT ONCE: the moves are grouped by item with the item and group order named; cancelled and archived group orders are left alone; an empty early set is filled from later ones', async () => {
  const one = await newSet(['A', 'B'], {}, 'Photocard set ONE'), two = await newSet(['A', 'B'], {}, 'Photocard set TWO'), dead = await newSet(), arch = await newSet(); const hs = Array.from({ length: 12 }, () => u());
  for (const [it, base] of [[one.item, 0], [two.item, 4], [dead.item, 8]]) { await claim(it, hs[base], ['A']); await claim(it, hs[base + 1], ['B']); await claim(it, hs[base + 2], ['A']); await claim(it, hs[base + 3], ['B']); }                    // each: Set 1 A,B  Set 2 A,B
  const [ar1, ar2] = [u('arch'), u('arch')]; await claim(arch.item, ar1, ['A']); await claim(arch.item, ar2, ['A']); await strand(hs[0], one.item); await strand(hs[1], one.item); await strand(hs[4], two.item); await strand(hs[8], dead.item); await strand(ar1, arch.item);                                          // a gap in Set 1 that ar2 (Set 2) COULD fill — if archived orders were wrongly included
  await app.q('UPDATE group_orders SET cancelled_at = NOW() WHERE id = ?', [dead.go]); await app.q('UPDATE group_orders SET archived_at = NOW() WHERE id = ?', [arch.go]);
  const deadBefore = await dbShape(dead.item), archBefore = await dbShape(arch.item); const p = await preview(); assert.deepEqual(p.json.moves.filter((m) => [dead.item, arch.item].includes(m.itemId)), [], 'cancelled and archived group orders are not touched');
  const items = p.json.items.filter((i) => [one.item, two.item].includes(i.itemId)); assert.deepEqual(items.map((i) => [i.itemTitle, i.count]), [['Photocard set ONE', 2], ['Photocard set TWO', 1]]); assert.match(items[0].orderTitle, /FillAll GO/);
  await run(); assert.equal(await shape(one.item), `1:A=${hs[2]},B=${hs[3]} | 2:`, 'the empty Set 1 was filled from Set 2'); assert.equal(await dbShape(dead.item), deadBefore, 'the cancelled order is exactly as it was'); assert.equal(await dbShape(arch.item), archBefore, 'and so is the archived one');
});

test('EXISTING RULES STILL HOLD WHEN FILLING GAPS: a keep-together pair, a fixed claimer, a cancel request waiting and a blocked handle are not moved', async () => {
  const { item } = await newSet(); const [a, b, tog, fx, rq, blk, ok] = [u(), u(), u('tog'), u('fx'), u('rq'), u('bl'), u('ok')]; await claim(item, a, ['A']); await claim(item, b, ['B']); const together = await app.api('POST', '/api/claims', { handle: tog, lines: [{ itemId: item, parts: [{ member: 'A', qty: 1 }, { member: 'B', qty: 1 }], together: true }] }); assert.equal(together.status, 201);
  assert.equal((await api('POST', `/api/admin/items/${item}/fixed`, { handle: fx, member: 'A' })).status, 201); await claim(item, u(), ['B']); await claim(item, rq, ['A']); await claim(item, u(), ['B']); await claim(item, blk, ['A']); await claim(item, u(), ['B']); await claim(item, ok, ['A']);
  const rc = await claimOf(rq, item); await app.q("INSERT INTO cancel_requests (claim_id, joiner_id, status, reason, open_flag) SELECT id, joiner_id, 'pending', 'x', 1 FROM claims WHERE id = ?", [rc.id]); await api('POST', '/api/admin/joiners/block', { handle: blk, reason: 'x' }); await strand(a, item);
  const r = await run(); assert.deepEqual(mine(r, item).map((m) => m[0]), [ok], 'only the eligible person moved'); const s = await shape(item); for (const h of [tog, fx, rq, blk]) assert.ok(s.includes(`=${h}`)); assert.match(s, new RegExp(`^1:A=${ok}`));
});

test('ONLY THE GOM; the preview and the action need a login; two presses at once move each person once', async () => {
  const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await api('GET', '/api/admin/sets/fill-gaps', undefined, j)).status, 403); assert.equal((await api('POST', '/api/admin/sets/fill-gaps', {}, j)).status, 403); assert.equal((await app.api('GET', '/api/admin/sets/fill-gaps')).status, 401); assert.equal((await app.api('POST', '/api/admin/sets/fill-gaps', {})).status, 401);
  const { item } = await newSet(); const h = Array.from({ length: 6 }, () => u()); for (const [i, m] of [['A'], ['B'], ['A'], ['B'], ['A'], ['B']].entries()) await claim(item, h[i], m); await strand(h[0], item);
  const rs = await Promise.all([run(), run(), run()]); assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.text).join(' | ')); assert.equal(rs.reduce((n, r) => n + mine(r, item).length, 0), 2, 'the two moves happened exactly once between them');
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM (SELECT set_id, member_name FROM set_slots ss JOIN item_sets s ON s.id = ss.set_id WHERE s.item_id = ? GROUP BY set_id, member_name HAVING COUNT(*) > 1) d", [item]))[0].n, 0);
});
