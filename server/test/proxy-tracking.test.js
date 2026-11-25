import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';

// "NOT VIA A PROXY" (a group order or an item that is ordered directly / on hand never appears in "Log a proxy payment") and the "ORDERED FROM" HISTORY (what each logged payment covered, how much has reached the warehouse, who to chase).
let app, admin, w, N = 0;
const ARRIVED = 'arrived at proxy / warehouse', ORDERED = 'ordered via proxy / warehouse';
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const fresh = (p = 'pt') => `${p}${++N}`;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
const candidates = async () => (await api('GET', '/api/admin/proxy/candidates')).json.candidates;
const history = async () => (await api('GET', '/api/admin/proxy/history')).json;
const hidden = async () => (await api('GET', '/api/admin/proxy/hidden')).json;
const log = (keys, extra = {}) => api('POST', '/api/admin/proxy/payments', { proxy: 'Sam', keys, ...extra });
const mkOrder = async (opts = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title: fresh('Tracking GO '), proxy: 'Sam', ...opts })).json.id;
const mkItem = async (go, opts = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: fresh('Tracked item '), price: 10, ...opts })).json.id;
const confirmed = async (item, n) => { const ids = []; for (let i = 0; i < n; i++) ids.push((await claimAndSecure(app, admin, fresh('who'), item))[0]); return ids; };
const move = async (ids, pipeline) => assert.equal((await api('POST', '/api/admin/claims/pipeline', { claimIds: ids, pipeline })).status, 200);
const payOf = async (id) => (await history()).proxies.flatMap((p) => p.payments).find((p) => p.id === id);
const makeOld = (id, days) => app.q('UPDATE proxy_payments SET paid_at = IF(is_paid = 1, ?, NULL), created_at = ? WHERE id = ?', [iso(days), iso(days), id]);
const adminOrder = async (go) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go);

test('THE HISTORY STARTS EMPTY: nothing logged, nothing listed', async () => {
  assert.deepEqual(await history(), { proxies: [], totals: { payments: 0, waiting: 0, toChase: 0 } }); assert.deepEqual(await hidden(), { orders: [], items: [] });
});

test('NOT VIA A PROXY — GROUP ORDER: ticking it takes all its items off "Log a proxy payment"; a payment can\'t be logged for them (with a plain message); unticking brings them back; it shows to the GOM only', async () => {
  const go = await mkOrder(), a = await mkItem(go, { title: 'Direct album' }), b = await mkItem(go, { title: 'Direct photocard' }); await confirmed(a, 2); await confirmed(b, 1); const keys = () => candidates().then((c) => c.map((x) => x.key));
  assert.ok((await keys()).includes(`item:${a}`) && (await keys()).includes(`item:${b}`), 'listed to begin with'); assert.equal((await adminOrder(go)).noProxy, false);
  assert.equal((await api('PATCH', `/api/admin/orders/${go}`, { noProxy: true })).status, 200); assert.equal((await adminOrder(go)).noProxy, true); const k1 = await keys(); assert.deepEqual([k1.includes(`item:${a}`), k1.includes(`item:${b}`)], [false, false], 'both items are off the list');
  const r = await log([`item:${a}`]); assert.deepEqual([r.status, r.json.code], [400, 'no_proxy']); assert.equal(r.json.error, '"Direct album" is marked as not via a proxy, so there\'s no proxy payment to log for it.');
  const pub = (await app.api('GET', '/api/orders')).json.orders.find((o) => o.id === go); assert.equal(pub && 'noProxy' in pub, false, 'joiners never see the flag');
  assert.equal((await api('PATCH', `/api/admin/orders/${go}`, { noProxy: false })).status, 200); const k2 = await keys(); assert.deepEqual([k2.includes(`item:${a}`), k2.includes(`item:${b}`)], [true, true], 'back on the list'); assert.equal((await log([`item:${a}`])).status, 201, 'and can be logged again');
  const mkSet = async (g) => { const set = (await api('POST', `/api/admin/orders/${g}/items`, { type: 'set', title: fresh('Direct set '), price: 8, members: ['A', 'B'] })).json.id; await api('POST', '/api/claims', { handle: fresh('ps'), lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }, { member: 'B', qty: 1 }] }] }); for (const x of (await api('GET', '/api/admin/sets')).json.sets.filter((q) => q.itemId === set)) await api('POST', `/api/admin/sets/${x.id}/secure`, {}); return set; };
  const sg = await mkOrder(), sset = await mkSet(sg); assert.ok((await keys()).includes(`set:${sset}`), 'a secured set is listed to begin with'); await api('PATCH', `/api/admin/orders/${sg}`, { noProxy: true }); assert.equal((await keys()).includes(`set:${sset}`), false, 'a member set in a ticked group order is off the list too'); const rs = await log([`set:${sset}`]); assert.deepEqual([rs.status, rs.json.code], [400, 'no_proxy']);
  await api('PATCH', `/api/admin/orders/${sg}`, { noProxy: false }); await api('PATCH', `/api/admin/items/${sset}`, { noProxy: true }); assert.equal((await keys()).includes(`set:${sset}`), false, 'and so is a ticked set item');
  const direct = (await api('POST', '/api/admin/orders', { groupId: w.group, title: fresh('Born direct '), proxy: 'Sam', noProxy: true })).json.id; assert.equal((await adminOrder(direct)).noProxy, true, 'can be set when the group order is made');
});

test('NOT VIA A PROXY — ONE ITEM: just that item is hidden, its neighbours stay; refused if you try to log it; made with the tick if you like; recorded; only the GOM', async () => {
  const go = await mkOrder(), a = await mkItem(go, { title: 'Hidden one' }), b = await mkItem(go, { title: 'Still listed' }); await confirmed(a, 1); await confirmed(b, 1); const keys = () => candidates().then((c) => c.map((x) => x.key));
  assert.equal((await api('PATCH', `/api/admin/items/${a}`, { noProxy: true })).status, 200); const items = (await adminOrder(go)).items; assert.deepEqual(items.map((i) => [i.title, i.noProxy]), [['Hidden one', true], ['Still listed', false]]);
  const k = await keys(); assert.deepEqual([k.includes(`item:${a}`), k.includes(`item:${b}`)], [false, true]); const r = await log([`item:${a}`]); assert.deepEqual([r.status, r.json.code], [400, 'no_proxy']);
  const born = await mkItem(go, { title: 'Born direct', noProxy: true }); assert.equal((await adminOrder(go)).items.find((i) => i.id === born).noProxy, true); assert.ok((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'item.no_proxy'"))[0].n >= 1, 'recorded');
  const j = await joinerSession(app, `${fresh('jj')}@x.com`, fresh('jj')); assert.equal((await api('PATCH', `/api/admin/items/${a}`, { noProxy: false }, j)).status, 403); assert.equal((await adminOrder(go)).items[0].noProxy, true);
  assert.equal((await api('PATCH', `/api/admin/items/${a}`, { noProxy: false })).status, 200); assert.ok((await keys()).includes(`item:${a}`), 'unticked: back');
});

test('A CARD BUNDLE IS NEVER LISTED (it is on hand), and can\'t be logged; a payment that was ALREADY logged stays in the history when you tick the group order afterwards', async () => {
  const go = await mkOrder(), it = await mkItem(go, { title: 'On hand cards' }); await confirmed(it, 1); await app.q('UPDATE group_orders SET is_cards = 1 WHERE id = ?', [go]);
  assert.equal((await candidates()).some((c) => c.key === `item:${it}`), false, 'not listed'); const r = await log([`item:${it}`]); assert.deepEqual([r.status, r.json.code], [400, 'no_proxy']); assert.match(r.json.error, /is a card bundle \(on hand\)/); await app.q('UPDATE group_orders SET is_cards = 0 WHERE id = ?', [go]);
  const paid = (await log([`item:${it}`])).json.id; assert.ok(paid); assert.equal((await api('PATCH', `/api/admin/orders/${go}`, { noProxy: true })).status, 200); assert.ok(await payOf(paid), 'a payment already logged stays in the history'); assert.equal((await api('GET', '/api/admin/proxy/payments')).json.payments.some((p) => p.id === paid), true);
});

test('"HIDDEN FROM THIS LIST": the group orders and single items you have ticked (with their claim counts), so you can see and undo them — not card bundles, not cancelled ones, an item of a ticked order only under the order; GOM only', async () => {
  const go = await mkOrder({ noProxy: true }), a = await mkItem(go), cards = await mkOrder({ noProxy: true }); await app.q('UPDATE group_orders SET is_cards = 1 WHERE id = ?', [cards]); await confirmed(a, 2);
  const go2 = await mkOrder(), solo = await mkItem(go2, { noProxy: true }), inOrder = await mkItem(go, { noProxy: true }); await confirmed(solo, 3); const dead = await mkOrder({ noProxy: true }); assert.equal((await api('POST', `/api/admin/orders/${dead}/cancel`, { confirm: (await adminOrder(dead)).title })).status, 200);
  const h = await hidden(); const o = h.orders.find((x) => x.id === go); assert.deepEqual([o.title, o.items, o.claims], [(await adminOrder(go)).title, 2, 2]); assert.deepEqual([h.orders.some((x) => x.id === cards), h.orders.some((x) => x.id === dead)], [false, false], 'no card bundle, no cancelled order');
  const s = h.items.find((x) => x.id === solo); assert.deepEqual([s.title, s.orderTitle, s.claims], [(await adminOrder(go2)).items[0].title, (await adminOrder(go2)).title, 3]); assert.equal(h.items.some((x) => x.id === inOrder), false, 'an item of a ticked order is covered by the order');
  const j = await joinerSession(app, `${fresh('jj')}@x.com`, fresh('jj')); assert.equal((await api('GET', '/api/admin/proxy/hidden', undefined, j)).status, 403); assert.equal((await app.api('GET', '/api/admin/proxy/hidden')).status, 401);
});

test('THE HISTORY WORKS OUT WHAT EACH PAYMENT COVERED, OLDEST FIRST, AND HOW MUCH HAS ARRIVED: payment 1 = the oldest 3 claims, payment 2 = the next 2', async () => {
  const go = await mkOrder(), it = await mkItem(go, { title: 'History album' }); const c = await confirmed(it, 3); const p1 = (await log([`item:${it}`], { summary: 'First run' })).json.id; const c2 = await confirmed(it, 2); const p2 = (await log([`item:${it}`], { summary: 'Second run' })).json.id;
  let a = await payOf(p1), b = await payOf(p2); assert.deepEqual([a.covered, a.arrived, a.waiting, a.complete], [3, 0, 3, false]); assert.deepEqual([b.covered, b.arrived, b.waiting], [2, 0, 2]); assert.deepEqual(a.items.map((i) => [i.label.endsWith('History album'), i.covered, i.arrived, i.waiting]), [[true, 3, 0, 3]]);
  await move([c[0], c[1]], ARRIVED); a = await payOf(p1); b = await payOf(p2); assert.deepEqual([a.arrived, a.waiting], [2, 1], 'the two oldest claims have arrived: they belong to payment 1'); assert.deepEqual([b.arrived, b.waiting], [0, 2]);
  await app.q("UPDATE claims SET pipeline = 'shipping requested' WHERE id IN (?)", [[c[2], ...c2]]); a = await payOf(p1); b = await payOf(p2); assert.deepEqual([a.complete, a.waiting, b.complete, b.waiting], [true, 0, true, 0], 'a claim that has moved BEYOND arrived has certainly arrived'); assert.deepEqual([a.summary, b.summary], ['First run', 'Second run']);
  assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: [c2[1]] })).status, 200); b = await payOf(p2); assert.deepEqual([b.covered, b.arrived, b.waiting], [1, 1, 0], 'a cancelled claim drops out of both numbers'); assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: [c2[0]] })).status, 200); b = await payOf(p2); assert.deepEqual([b.covered, b.arrived, b.waiting, b.complete, b.chase], [0, 0, 0, false, false], 'nothing left on it: not "complete", nothing to chase');
});

test('A MEMBER SET IS ONE UNIT: it has arrived only when ALL its parts have; several items on one payment are listed separately', async () => {
  const go = await mkOrder(); const set = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: fresh('History set '), price: 8, members: ['A', 'B'] })).json.id;
  for (let i = 0; i < 2; i++) await api('POST', '/api/claims', { handle: fresh('ps'), lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }, { member: 'B', qty: 1 }] }] });
  const sets = (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === set); for (const s of sets) assert.equal((await api('POST', `/api/admin/sets/${s.id}/secure`, {})).status, 200);
  const plain = await mkItem(go, { title: 'Plain with the set' }); await confirmed(plain, 1); const pay = (await log([`set:${set}`, `item:${plain}`], { summary: 'Mixed' })).json.id; let p = await payOf(pay); assert.deepEqual([p.covered, p.arrived, p.items.length], [3, 0, 2], '2 sets + 1 plain claim');
  const parts = await app.q('SELECT id, set_id FROM claims WHERE set_id = ? ORDER BY id', [sets[0].id]); assert.ok(parts.length >= 2); await move([parts[0].id], ARRIVED); p = await payOf(pay); assert.equal(p.arrived, 0, 'one part of a set is not a set');
  await move(parts.map((x) => x.id), ARRIVED); p = await payOf(pay); assert.deepEqual([p.covered, p.arrived, p.waiting], [3, 1, 2], 'all parts: the set has arrived'); assert.deepEqual(p.items.map((i) => [i.covered, i.arrived]), [[2, 1], [1, 0]]);
});

test('WHO TO CHASE: a PAID payment with things still waiting after 14 days; never an unpaid one, a recent one, or a complete one; the days count from when you PAID; marking it paid sets the date', async () => {
  const go = await mkOrder(), it = await mkItem(go); const cs = await confirmed(it, 2); const unpaid = (await log([`item:${it}`], { summary: 'Unpaid yet' })).json.id; await makeOld(unpaid, 40); let p = await payOf(unpaid);
  assert.deepEqual([p.paid, p.chase, p.days], [false, false, 40], 'unpaid, however old: not a chase (days count from when it was logged)'); assert.equal(p.paidOn, null);
  assert.equal((await api('PATCH', `/api/admin/proxy/payments/${unpaid}`, { paid: true })).status, 200); p = await payOf(unpaid); assert.deepEqual([p.paid, p.days, p.chase], [true, 0, false], 'paid today: the clock starts now'); assert.ok(p.paidOn);
  await makeOld(unpaid, 20); p = await payOf(unpaid); assert.deepEqual([p.days, p.chase], [20, true], 'paid 20 days ago, nothing arrived: chase'); await makeOld(unpaid, 13); assert.equal((await payOf(unpaid)).chase, false, '13 days: not yet'); await makeOld(unpaid, 14); assert.equal((await payOf(unpaid)).chase, true, '14 days: chase');
  await move(cs, ARRIVED); p = await payOf(unpaid); assert.deepEqual([p.complete, p.chase], [true, false], 'everything arrived: nothing to chase'); assert.equal((await api('PATCH', `/api/admin/proxy/payments/${unpaid}`, { paid: false })).status, 200); p = await payOf(unpaid); assert.deepEqual([p.paid, p.paidOn], [false, null], 'marked unpaid again: the paid date is cleared');
  const direct = (await log([`item:${it}`], { summary: 'Logged as paid', paid: true })); assert.equal(direct.status, 409, 'nothing new to log for that item (sanity)'); const it2 = await mkItem(go); await confirmed(it2, 1); const born = (await log([`item:${it2}`], { paid: true })).json.id; assert.ok((await payOf(born)).paidOn, 'logged already paid: dated');
});

test('GROUPED BY PROXY: payments newest first, the proxies with something to chase first (even when they sort later), totals per proxy and overall', async () => {
  const mk = async (proxy, days, paid = true) => { const go = await mkOrder(), it = await mkItem(go); await confirmed(it, 1); const id = (await log([`item:${it}`], { proxy, paid })).json.id; await makeOld(id, days); return id; };
  const zed = fresh('Zed'), amy = fresh('Amy'); const z1 = await mk(zed, 30), z2 = await mk(zed, 5), a1 = await mk(amy, 3), a2 = await mk(amy, 2, false); const h = await history();
  const names = h.proxies.map((p) => p.name); assert.ok(names.indexOf(zed) < names.indexOf(amy), 'Zed has one to chase, so he is first even though Amy sorts before him'); const A = h.proxies.find((p) => p.name === amy), Z = h.proxies.find((p) => p.name === zed);
  assert.deepEqual(A.payments.map((p) => p.id), [a2, a1], 'newest first'); assert.deepEqual([A.totals.payments, A.totals.toChase, A.totals.unpaid, A.totals.waiting], [2, 0, 1, 2]); assert.deepEqual([Z.totals.payments, Z.totals.toChase, Z.totals.waiting], [2, 1, 2]); assert.deepEqual(Z.payments.map((p) => p.id), [z2, z1]);
  assert.equal(h.totals.toChase, h.proxies.reduce((n, p) => n + p.totals.toChase, 0)); assert.ok(h.totals.payments >= 4);
});

test('ONLY THE GOM CAN SEE THE HISTORY', async () => {
  const j = await joinerSession(app, `${fresh('jj')}@x.com`, fresh('jj')); assert.equal((await api('GET', '/api/admin/proxy/history', undefined, j)).status, 403); assert.equal((await app.api('GET', '/api/admin/proxy/history')).status, 401);
});
