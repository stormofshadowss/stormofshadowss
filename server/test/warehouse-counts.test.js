import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';

// GET /api/admin/warehouse/counts — the numbers on the Warehouse sub-tabs: Unordered · Incoming · Arrived · Enroute · On hand.
let app, admin, w, N = 0;
const ARRIVED = 'arrived at proxy / warehouse';
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'wc') => `${x}${++N}`;
const counts = async () => (await api('GET', '/api/admin/warehouse/counts')).json;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);
const goItem = async (title = u('Counted ')) => { const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Counts GO '), proxy: 'Sam' })).json.id; return (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title })).json.id; };
const secured = async (item, n) => { const ids = []; for (let i = 0; i < n; i++) ids.push((await claimAndSecure(app, admin, u('who'), item))[0]); return ids; };
const atProxy = async (ids) => assert.equal((await api('POST', '/api/admin/claims/pipeline', { claimIds: ids, pipeline: ARRIVED })).status, 200);
const mkBox = async (ids) => (await api('POST', '/api/admin/boxes', { claimIds: ids, emsTotal: 5 })).json.id;
const diff = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - a[k]]));

test('EACH SUB-TAB\'S NUMBER FOLLOWS ITS OWN THING: unordered copies, waiting store orders (and the ones to chase), items waiting to be boxed, boxes being made, boxes en route, boxes to check, boxes checked', async () => {
  const c0 = await counts(); assert.deepEqual(Object.keys(c0).sort(), ['arrived', 'checked', 'enroute', 'incoming', 'making', 'toChase', 'toCheck', 'unordered']); assert.ok(Object.values(c0).every((n) => Number.isInteger(n) && n >= 0));
  const item = await goItem(); await secured(item, 3); assert.deepEqual(diff(c0, await counts()), { arrived: 0, checked: 0, enroute: 0, incoming: 0, making: 0, toChase: 0, toCheck: 0, unordered: 3 }, 'three secured copies waiting to be ordered');
  const c1 = await counts(); assert.equal((await api('POST', '/api/admin/store-orders', { store: 'Ktown4u', orderedOn: iso(2), lines: [{ itemId: item, qty: 1 }] })).status, 201); assert.equal((await api('POST', '/api/admin/store-orders', { store: 'Old shop', orderedOn: iso(30), lines: [{ itemId: item, qty: 1 }] })).status, 201);
  assert.deepEqual(diff(c1, await counts()), { arrived: 0, checked: 0, enroute: 0, incoming: 2, making: 0, toChase: 1, toCheck: 0, unordered: 0 }, 'two store orders waiting, one of them old enough to chase');
  const other = await goItem(); const c2 = await counts(); const ids = await secured(other, 2); await atProxy(ids); assert.deepEqual(diff(c2, await counts()), { arrived: 2, checked: 0, enroute: 0, incoming: 0, making: 0, toChase: 0, toCheck: 0, unordered: 0 }, 'two items at the proxy waiting to be boxed (they are not "unordered")');
  const c3 = await counts(); const making = await mkBox([ids[0]]); assert.deepEqual(diff(c3, await counts()), { arrived: -1, checked: 0, enroute: 0, incoming: 0, making: 1, toChase: 0, toCheck: 0, unordered: 0 }, 'a box takes an item off the waiting list and is "being made"');
  const c4 = await counts(); assert.equal((await api('POST', `/api/admin/boxes/${making}/enroute`, {})).status, 200); assert.deepEqual(diff(c4, await counts()), { arrived: 0, checked: 0, enroute: 1, incoming: 0, making: -1, toChase: 0, toCheck: 0, unordered: 0 }, 'en route');
  const c5 = await counts(); assert.equal((await api('POST', `/api/admin/boxes/${making}/arrived`, {})).status, 200); assert.deepEqual(diff(c5, await counts()), { arrived: 0, checked: 0, enroute: -1, incoming: 0, making: 0, toChase: 0, toCheck: 1, unordered: 0 }, 'arrived but not checked: "to check"');
  const c6 = await counts(); assert.equal((await api('POST', `/api/admin/boxes/${making}/ready`, { ready: [ids[0]], checking: [] })).status, 200); assert.deepEqual(diff(c6, await counts()), { arrived: 0, checked: 1, enroute: 0, incoming: 0, making: 0, toChase: 0, toCheck: -1, unordered: 0 }, 'checked: on hand');
});

test('A BOX WITH SOMETHING STILL BEING CHECKED STAYS "TO CHECK"; a store order that has fully arrived is no longer "incoming"; a cancelled one neither; chasing it takes it off "to chase"', async () => {
  const item = await goItem(); const ids = await secured(item, 2); await atProxy(ids); const box = await mkBox(ids); await api('POST', `/api/admin/boxes/${box}/enroute`, {}); await api('POST', `/api/admin/boxes/${box}/arrived`, {});
  const c0 = await counts(); assert.equal((await api('POST', `/api/admin/boxes/${box}/ready`, { ready: [ids[0]], checking: [ids[1]] })).status, 200); assert.deepEqual(diff(c0, await counts()), { arrived: 0, checked: 0, enroute: 0, incoming: 0, making: 0, toChase: 0, toCheck: 0, unordered: 0 }, 'one item still at "checking parcel": still to check');
  assert.equal((await api('POST', `/api/admin/boxes/${box}/ready`, { ready: [ids[1]], checking: [] })).status, 200); const c1 = await counts(); assert.equal(c1.toCheck, c0.toCheck - 1); assert.equal(c1.checked, c0.checked + 1);
  const so = (await api('POST', '/api/admin/store-orders', { store: 'Ktown4u', orderedOn: iso(40), lines: [{ itemId: item, qty: 1 }] })).json.id; const c2 = await counts(); assert.equal((await api('POST', `/api/admin/store-orders/${so}`, {})).status, 404, 'sanity: that is not a route');
  assert.equal((await api('PATCH', `/api/admin/store-orders/${so}`, { lastChasedOn: iso(0) })).status, 200); const c3 = await counts(); assert.deepEqual([c3.incoming - c2.incoming, c3.toChase - c2.toChase], [0, -1], 'chased today: still incoming, no longer to chase');
  assert.equal((await api('POST', `/api/admin/store-orders/${so}/arrived-all`, {})).status, 200); const c4 = await counts(); assert.deepEqual([c4.incoming - c3.incoming], [-1], 'fully arrived: no longer incoming');
  const so2 = (await api('POST', '/api/admin/store-orders', { store: 'Ktown4u', orderedOn: iso(1), lines: [{ itemId: item, qty: 1 }] })).json.id; const c5 = await counts(); assert.equal((await api('PATCH', `/api/admin/store-orders/${so2}`, { status: 'cancelled' })).status, 200); assert.equal((await counts()).incoming, c5.incoming - 1, 'cancelled: no longer incoming');
});

test('ONLY THE GOM CAN ASK', async () => {
  const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await api('GET', '/api/admin/warehouse/counts', undefined, j)).status, 403); assert.equal((await app.api('GET', '/api/admin/warehouse/counts')).status, 401);
});
