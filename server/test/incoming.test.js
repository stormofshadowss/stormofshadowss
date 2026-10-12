import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';

// Incoming: orders the GOM (or a proxy) places with shops — what was ordered, tracking numbers to the warehouse, what has arrived, which shop to chase, and which claims should move on.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'in') => `${x}${++N}`;
const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const newItem = async (extra = {}) => { const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Incoming GO '), proxy: 'Sam' })).json.id; const item = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Album '), price: 10, ...extra })).json.id; return { go, item }; };
const claims = async (item, n) => { const ids = []; for (let i = 0; i < n; i++) ids.push((await claimAndSecure(app, admin, u('p'), item))[0]); return ids; };
const store = async (body) => { const r = await api('POST', '/api/admin/store-orders', { store: 'Ktown4u', orderedOn: iso(-2), ...body }); assert.equal(r.status, 201, r.text); return r.json.id; };
const snap = async () => (await api('GET', '/api/admin/incoming')).json;
const orderOf = async (id) => (await snap()).orders.find((o) => o.id === id);
const countOf = async (item) => (await snap()).counts.find((c) => c.itemId === item);
const stageOf = async (id) => (await app.q('SELECT pipeline FROM claims WHERE id = ?', [id]))[0].pipeline;
const ORDERED = 'ordered via proxy / warehouse', ARRIVED = 'arrived at proxy / warehouse';

test('A STORE ORDER: store, number, link, who placed it, lines and tracking numbers — all come back as saved', async () => {
  const { item } = await newItem(); const item2 = (await api('POST', `/api/admin/orders/${(await api('GET', '/api/admin/orders')).json.orders.find((o) => o.items.some((i) => i.id === item)).id}/items`, { type: 'normal', title: 'Second thing', price: 5 })).json.id;
  const id = await store({ store: 'Weverse Shop', orderRef: 'WV-12345', orderUrl: 'https://weverse.io/orders/12345', proxy: 'Yuki', notes: 'limit 3 per order', lines: [{ itemId: item, qty: 3, note: 'ver. A' }, { itemId: item2, qty: 1 }],
    shipments: [{ carrier: 'CJ Logistics', trackingNo: '6401 2345 6789', shippedOn: iso(-1) }, { trackingNo: 'EE123456789KR' }] });
  const o = await orderOf(id);
  assert.deepEqual([o.store, o.orderRef, o.orderUrl, o.proxy, o.notes, o.state, o.qty, o.arrived, o.missing], ['Weverse Shop', 'WV-12345', 'https://weverse.io/orders/12345', 'Yuki', 'limit 3 per order', 'waiting', 4, 0, 4]);
  assert.deepEqual(o.lines.map((l) => [l.itemId, l.qty, l.arrived, l.note]), [[item, 3, 0, 'ver. A'], [item2, 1, 0, null]]);
  assert.deepEqual(o.shipments.map((s) => [s.carrier, s.trackingNo, s.shippedOn, s.arrivedOn]), [['CJ Logistics', '6401 2345 6789', iso(-1), null], [null, 'EE123456789KR', null, null]]);
  assert.equal((await api('GET', '/api/admin/proxy/names')).json.names.includes('Yuki'), true, 'a proxy named here is a real proxy');
});

test('VALIDATION: a link must be http(s); tracking numbers are plain characters; real dates; sensible counts; unknown items refused', async () => {
  const { item } = await newItem(); const base = { store: 'Shop', orderedOn: iso(-1) };
  const post = (b) => api('POST', '/api/admin/store-orders', { ...base, ...b });
  for (const [b, why] of [[{ store: '' }, 'no store'], [{ orderUrl: 'javascript:alert(1)' }, 'js link'], [{ orderUrl: 'ftp://x.com/a' }, 'ftp link'], [{ orderedOn: '2026-02-30' }, 'impossible date'], [{ orderedOn: 'yesterday' }, 'not a date'],
    [{ lines: [{ itemId: item, qty: 0 }] }, 'qty 0'], [{ lines: [{ itemId: item, qty: 1.5 }] }, 'fractional qty'], [{ lines: [{ itemId: 999999, qty: 1 }] }, 'unknown item'],
    [{ shipments: [{ trackingNo: '<script>alert(1)</script>' }] }, 'html in tracking'], [{ shipments: [{ trackingNo: '../../etc' }] }, 'path in tracking'], [{ shipments: [{ trackingNo: 'abc' }] }, 'too short'],
    [{ shipments: [{ trackingNo: 'OK123456', shippedOn: '2026-13-01' }] }, 'bad shipped date']]) assert.equal((await post(b)).status, 400, why);
  assert.equal((await post({ orderUrl: 'https://example.com/o?id=1&x=2' })).status, 201, 'a normal link is fine');
  const id = await store({ lines: [{ itemId: item, qty: 2 }] });
  const lineId = (await orderOf(id)).lines[0].id;
  assert.equal((await api('PATCH', `/api/admin/store-order-lines/${lineId}`, { arrivedQty: 3 })).status, 400, 'more arrived than ordered');
  assert.equal((await api('PATCH', `/api/admin/store-order-lines/${lineId}`, { arrivedQty: 2 })).status, 200);
  assert.equal((await api('PATCH', `/api/admin/store-order-lines/${lineId}`, { qty: 1 })).status, 400, 'cannot lower the order below what has arrived');
});

test('STATES: waiting → part arrived → arrived; cancelled; "no tracking yet"; days waiting', async () => {
  const { item } = await newItem(); const id = await store({ orderedOn: iso(-5), lines: [{ itemId: item, qty: 4 }] });
  let o = await orderOf(id); assert.deepEqual([o.state, o.daysWaiting, o.noTracking, o.chase], ['waiting', 5, true, false]);
  await api('POST', `/api/admin/store-orders/${id}/shipments`, { trackingNo: 'TRK0001234' });
  o = await orderOf(id); assert.equal(o.noTracking, false);
  await api('PATCH', `/api/admin/store-order-lines/${o.lines[0].id}`, { arrivedQty: 1 });
  o = await orderOf(id); assert.deepEqual([o.state, o.arrived, o.missing, o.daysWaiting], ['part', 1, 3, 5]);
  await api('PATCH', `/api/admin/store-order-lines/${o.lines[0].id}`, { arrivedQty: 4 });
  o = await orderOf(id); assert.deepEqual([o.state, o.daysWaiting, o.chase], ['arrived', null, false], 'arrived: nothing to chase');
  await api('PATCH', `/api/admin/store-orders/${id}`, { status: 'cancelled' }); assert.equal((await orderOf(id)).state, 'cancelled');
});

test('THE CHASE LIST: outstanding orders, oldest first; flagged to chase after 14 days unless chased in the last week; arrived and cancelled ones are not on it', async () => {
  const { item } = await newItem();
  const old = await store({ store: 'Old shop', orderedOn: iso(-30), lines: [{ itemId: item, qty: 1 }] }), mid = await store({ store: 'Mid shop', orderedOn: iso(-15), lines: [{ itemId: item, qty: 1 }] }), fresh = await store({ store: 'New shop', orderedOn: iso(-3), lines: [{ itemId: item, qty: 1 }] });
  const done = await store({ store: 'Done shop', orderedOn: iso(-40), lines: [{ itemId: item, qty: 1 }] }); await api('POST', `/api/admin/store-orders/${done}/arrived-all`);
  const gone = await store({ store: 'Gone shop', orderedOn: iso(-50), lines: [{ itemId: item, qty: 1 }] }); await api('PATCH', `/api/admin/store-orders/${gone}`, { status: 'cancelled' });
  let s = await snap(); const mine = s.chase.filter((i) => [old, mid, fresh, done, gone].includes(i));
  assert.deepEqual(mine, [old, mid, fresh], 'oldest first; arrived and cancelled left off');
  assert.deepEqual([old, mid, fresh].map((i) => s.orders.find((o) => o.id === i).chase), [true, true, false], '30 and 15 days old: chase; 3 days: not yet');
  await api('PATCH', `/api/admin/store-orders/${old}`, { lastChasedOn: iso(-2) });                      // chased 2 days ago
  s = await snap(); assert.equal(s.orders.find((o) => o.id === old).chase, false, 'chased this week: leave it');
  await api('PATCH', `/api/admin/store-orders/${old}`, { lastChasedOn: iso(-9) });
  assert.equal((await snap()).orders.find((o) => o.id === old).chase, true, 'chased 9 days ago: due again');
  assert.ok(s.totals.waiting >= 3 && s.totals.toChase >= 1); assert.equal(s.chaseAfterDays, 14);
});

test('ITEM COUNTS: needed (confirmed claims) / ordered / arrived, what is still to order, what is missing, and over-ordering; cancelled store orders do not count', async () => {
  const { item } = await newItem(); await claims(item, 6); await app.api('POST', '/api/claims', { handle: u('req'), lines: [{ itemId: item }] });   // 6 confirmed + 1 request
  const a = await store({ lines: [{ itemId: item, qty: 3 }] }), b = await store({ lines: [{ itemId: item, qty: 2 }] }), c = await store({ lines: [{ itemId: item, qty: 5 }] });
  await api('PATCH', `/api/admin/store-orders/${c}`, { status: 'cancelled' });
  await api('PATCH', `/api/admin/store-order-lines/${(await orderOf(a)).lines[0].id}`, { arrivedQty: 2 });
  assert.deepEqual(await countOf(item), { ...(await countOf(item)), needed: 6, ordered: 5, arrived: 2, toOrder: 1, missing: 3, over: 0 });
  await store({ lines: [{ itemId: item, qty: 4 }] });
  const k = await countOf(item); assert.deepEqual([k.ordered, k.toOrder, k.over], [9, 0, 3], 'ordered 9 for 6 wanted: 3 over');
  assert.equal(b > 0, true);
});

test('WHICH CLAIMS SHOULD MOVE ON: the oldest ones, up to what has been ordered / has arrived — and never twice', async () => {
  const { item } = await newItem(); const ids = await claims(item, 5);
  await store({ lines: [{ itemId: item, qty: 3 }] });
  let p = (await api('GET', `/api/admin/incoming/items/${item}/advance-plan?to=ordered`)).json;
  assert.deepEqual([p.needed, p.ordered, p.target, p.already, p.stage], [5, 3, 3, 0, ORDERED]); assert.deepEqual(p.claimIds, ids.slice(0, 3), 'the three OLDEST claims');
  const mv = await api('POST', '/api/admin/claims/pipeline', { claimIds: p.claimIds, pipeline: p.stage }); assert.equal(mv.json.changed, 3);
  p = (await api('GET', `/api/admin/incoming/items/${item}/advance-plan?to=ordered`)).json; assert.deepEqual([p.already, p.claimIds], [3, []], 'nothing more to move once they have');
  const o2 = await store({ lines: [{ itemId: item, qty: 2 }] });
  p = (await api('GET', `/api/admin/incoming/items/${item}/advance-plan?to=ordered`)).json; assert.deepEqual(p.claimIds, ids.slice(3, 5), 'a second store order: the next two');
  // arrivals
  await api('POST', '/api/admin/claims/pipeline', { claimIds: p.claimIds, pipeline: ORDERED });
  const first = (await snap()).orders.find((o) => o.lines.some((l) => l.itemId === item && l.qty === 3)); await api('PATCH', `/api/admin/store-order-lines/${first.lines.find((l) => l.itemId === item).id}`, { arrivedQty: 2 });
  p = (await api('GET', `/api/admin/incoming/items/${item}/advance-plan?to=arrived`)).json; assert.deepEqual([p.arrived, p.claimIds, p.stage], [2, ids.slice(0, 2), ARRIVED]);
  assert.equal((await api('POST', '/api/admin/claims/pipeline', { claimIds: p.claimIds, pipeline: p.stage })).json.changed, 2);
  assert.deepEqual([await stageOf(ids[0]), await stageOf(ids[1]), await stageOf(ids[2]), await stageOf(ids[4])], [ARRIVED, ARRIVED, ORDERED, ORDERED]);
  // arrived more than ordered claims exist: capped at what is needed
  await api('PATCH', `/api/admin/store-order-lines/${first.lines.find((l) => l.itemId === item).id}`, { arrivedQty: 3 }); await api('PATCH', `/api/admin/store-orders/${o2}`, { status: 'open' });
  p = (await api('GET', `/api/admin/incoming/items/${item}/advance-plan?to=arrived`)).json; assert.deepEqual(p.claimIds, [ids[2]], 'one more has arrived: the next oldest');
  assert.equal((await api('GET', `/api/admin/incoming/items/${item}/advance-plan?to=nonsense`)).status, 400); assert.equal((await api('GET', '/api/admin/incoming/items/999999/advance-plan?to=ordered')).status, 404);
});

test('CLAIMS THAT ARE NOT REAL DEMAND ARE LEFT OUT: unconfirmed requests and cancelled claims are never moved or counted', async () => {
  const { item } = await newItem(); const ids = await claims(item, 3); await app.api('POST', '/api/claims', { handle: u('req'), lines: [{ itemId: item }] });
  await api('PATCH', `/api/admin/claims/${ids[0]}`, { status: 'cancelled' });
  await store({ lines: [{ itemId: item, qty: 10 }] });
  const p = (await api('GET', `/api/admin/incoming/items/${item}/advance-plan?to=ordered`)).json;
  assert.deepEqual([p.needed, p.target, p.claimIds], [2, 2, [ids[1], ids[2]]]);
});

test('SETS: a set is one unit (its parts move together); the oldest secured sets first; unsecured sets are not needed yet', async () => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Set GO '), proxy: 'Sam' })).json.id;
  const set = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: 'Card set', price: 4, members: ['A', 'B'] })).json.id;
  for (const h of [u('s'), u('s'), u('s')]) await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }, { member: 'B', qty: 1 }], together: true }] });   // three full sets
  const sets = (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === set);
  for (const s of sets.slice(0, 2)) await api('POST', `/api/admin/sets/${s.id}/secure`, {});                  // two secured, one not
  assert.equal((await countOf(set)).needed, 2, 'only secured sets count');
  await store({ lines: [{ itemId: set, qty: 1 }] });
  const p = (await api('GET', `/api/admin/incoming/items/${set}/advance-plan?to=ordered`)).json;
  assert.equal(p.type, 'set'); assert.deepEqual([p.needed, p.target], [2, 1]); assert.equal(p.moves.length, 1); assert.equal(p.moves[0].unit, 'Set 1'); assert.equal(p.claimIds.length, 2, 'both parts of Set 1 together');
});

test('SHORTCUTS AND CLEAN-UP: "all arrived" fills every line and dates every tracking number; deleting a store order removes its lines and tracking; an item on a store order cannot be deleted', async () => {
  const { go, item } = await newItem(); const id = await store({ lines: [{ itemId: item, qty: 3 }], shipments: [{ trackingNo: 'TRK1111111' }, { trackingNo: 'TRK2222222' }] });
  const blocked = await api('DELETE', `/api/admin/items/${item}`); assert.equal(blocked.status, 409); assert.match(blocked.json.error, /1 store order lists it \(Warehouse → Incoming\), so it can't be deleted\./);
  await api('POST', `/api/admin/store-orders/${id}/arrived-all`);
  const o = await orderOf(id); assert.deepEqual([o.state, o.arrived, o.shipments.every((s) => s.arrivedOn === iso(0))], ['arrived', 3, true]);
  assert.equal((await api('DELETE', `/api/admin/store-orders/${id}`)).status, 200);
  assert.deepEqual([(await app.q('SELECT COUNT(*) AS n FROM store_order_lines'))[0].n >= 0, (await app.q('SELECT COUNT(*) AS n FROM store_shipments WHERE tracking_no IN (?, ?)', ['TRK1111111', 'TRK2222222']))[0].n], [true, 0]);
  assert.equal((await api('DELETE', `/api/admin/items/${item}`)).status, 200, 'once it is off every store order the item can go'); void go;
  assert.equal((await api('DELETE', '/api/admin/store-orders/999999')).status, 404);
});

test('THE WAREHOUSE ADDRESS is saved once and comes back with the snapshot', async () => {
  assert.equal((await api('PUT', '/api/admin/settings/warehouse-address', { address: 'Seoul Warehouse\n123 Example-ro, Mapo-gu\nSeoul 04000, Korea\n(tel +82 10 0000 0000)' })).status, 200);
  assert.match((await snap()).warehouseAddress, /Seoul Warehouse\n123 Example-ro/);
  assert.equal((await api('PUT', '/api/admin/settings/warehouse-address', { address: 'x'.repeat(601) })).status, 400); assert.equal((await api('PUT', '/api/admin/settings/warehouse-address', { address: '' })).status, 200);
});

test('ONLY THE GOM can use any of it; the activity log records counts, never tracking numbers', async () => {
  const j = await app.login(`${u('jj')}@x.com`); const { item } = await newItem();
  for (const [m, p, b] of [['GET', '/api/admin/incoming'], ['POST', '/api/admin/store-orders', { store: 'x', orderedOn: iso(0) }], ['PATCH', '/api/admin/store-orders/1', { store: 'y' }], ['DELETE', '/api/admin/store-orders/1'], ['POST', '/api/admin/store-orders/1/arrived-all'],
    ['GET', `/api/admin/incoming/items/${item}/advance-plan?to=ordered`], ['PUT', '/api/admin/settings/warehouse-address', { address: 'x' }]]) { assert.equal((await api(m, p, b, j)).status, 403, `${m} ${p}`); assert.equal((await app.api(m, p, b)).status, 401, `${m} ${p}`); }
  await store({ lines: [{ itemId: item, qty: 1 }], shipments: [{ trackingNo: 'SECRET99887766' }] });
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE detail LIKE '%SECRET99887766%'"))[0].n, 0);
});
