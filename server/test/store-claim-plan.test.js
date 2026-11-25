import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';

// A STORE ORDER → THE CLAIMS: which claims should move to "ordered" when it is logged, and to "arrived at proxy / warehouse" when things have arrived — a plan only; the ordinary "move stage" action does the moving.
let app, admin, w, N = 0;
const ORDERED = 'ordered via proxy / warehouse', ARRIVED = 'arrived at proxy / warehouse', WAITING = 'awaiting fulfillment';
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'sp') => `${x}${++N}`;
const goOrder = async (title = u('Plan GO ')) => ({ id: (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam' })).json.id, title });
const item = async (go, title, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title, ...extra })).json.id;
const claims = async (it, n) => { const ids = []; for (let i = 0; i < n; i++) ids.push((await claimAndSecure(app, admin, u('who'), it))[0]); return ids; };
const store = async (lines, extra = {}) => { const r = await api('POST', '/api/admin/store-orders', { store: 'Ktown4u', orderedOn: new Date(Date.now() - 864e5).toISOString().slice(0, 10), lines, ...extra }); assert.equal(r.status, 201, r.text); return r.json.id; };
const plan = (id, to, c = admin) => api('GET', `/api/admin/store-orders/${id}/claim-plan?to=${to}`, undefined, c);
const stageOf = async (ids) => (await app.q('SELECT id, pipeline FROM claims WHERE id IN (?) ORDER BY id', [ids])).map((r) => r.pipeline);
const move = async (ids, pipeline) => { const r = await api('POST', '/api/admin/claims/pipeline', { claimIds: ids, pipeline }); assert.equal(r.status, 200, r.text); return r.json; };

test('THE PLAN FOR A STORE ORDER: for each item on it, the OLDEST waiting claims up to what was ordered — with the item, its group order and the counts', async () => {
  const go = await goOrder(); const a = await item(go.id, 'Album A'), b = await item(go.id, 'Album B'); const ca = await claims(a, 3), cb = await claims(b, 2); const id = await store([{ itemId: a, qty: 2 }, { itemId: b, qty: 5 }]);
  const r = await plan(id, 'ordered'); assert.equal(r.status, 200, r.text); const p = r.json; assert.deepEqual([p.storeOrder.id, p.storeOrder.store, p.storeOrder.status, p.to, p.stage], [id, 'Ktown4u', 'open', 'ordered', ORDERED]);
  assert.deepEqual(p.items.map((i) => [i.itemId, i.title, i.orderTitle]), [[a, 'Album A', go.title], [b, 'Album B', go.title]]); const [pa, pb] = p.items;
  assert.deepEqual([pa.needed, pa.ordered, pa.target, pa.already, pa.claimIds], [3, 2, 2, 0, ca.slice(0, 2)], 'A: 2 ordered of 3 needed — the OLDEST two'); assert.deepEqual([pb.needed, pb.ordered, pb.target, pb.claimIds], [2, 5, 2, cb], 'B: 5 ordered but only 2 are needed — both');
  assert.deepEqual(p.claimIds, [...ca.slice(0, 2), ...cb]); assert.equal(p.totalMoves, 4); assert.ok(pa.moves.every((m) => m.handles.length === 1 && m.claimIds.length === 1)); assert.deepEqual(await stageOf([...ca, ...cb]), Array(5).fill(WAITING), 'planning changed nothing');
});

test('IT ADDS UP ACROSS STORE ORDERS: what a second order covers is what is still behind; once applied, there is nothing left to move', async () => {
  const go = await goOrder(); const a = await item(go.id, 'Cumulative album'); const cs = await claims(a, 3); const first = await store([{ itemId: a, qty: 2 }]); const p1 = (await plan(first, 'ordered')).json; assert.deepEqual(p1.claimIds, cs.slice(0, 2)); await move(p1.claimIds, ORDERED);
  const second = await store([{ itemId: a, qty: 1 }]); const p2 = (await plan(second, 'ordered')).json; assert.deepEqual([p2.items[0].ordered, p2.items[0].target, p2.items[0].already, p2.claimIds], [3, 3, 2, [cs[2]]], '3 ordered in all, 2 already moved: the third claim');
  await move(p2.claimIds, ORDERED); assert.deepEqual(await stageOf(cs), Array(3).fill(ORDERED)); const p3 = (await plan(second, 'ordered')).json; assert.deepEqual([p3.claimIds, p3.totalMoves], [[], 0], 'nothing left'); assert.equal(p3.items[0].moves.length, 0);
});

test('ARRIVED: the plan follows how many have arrived — a partial arrival moves exactly that many (oldest first), "all arrived" moves the rest; the line save says which order it was', async () => {
  const go = await goOrder(); const a = await item(go.id, 'Arriving album'); const cs = await claims(a, 4); const id = await store([{ itemId: a, qty: 4 }]); await move(cs, ORDERED); const line = (await api('GET', '/api/admin/incoming')).json.orders.find((o) => o.id === id).lines[0].id;
  assert.deepEqual((await plan(id, 'arrived')).json.claimIds, [], 'nothing has arrived yet'); const patch = await api('PATCH', `/api/admin/store-order-lines/${line}`, { arrivedQty: 2 }); assert.deepEqual([patch.status, patch.json.orderId], [200, id], 'the response says which store order');
  const p1 = (await plan(id, 'arrived')).json; assert.deepEqual([p1.stage, p1.claimIds, p1.items[0].arrived, p1.items[0].target], [ARRIVED, cs.slice(0, 2), 2, 2]); await move(p1.claimIds, ARRIVED); assert.deepEqual(await stageOf(cs), [ARRIVED, ARRIVED, ORDERED, ORDERED]);
  assert.equal((await api('POST', `/api/admin/store-orders/${id}/arrived-all`, {})).status, 200); const p2 = (await plan(id, 'arrived')).json; assert.deepEqual([p2.claimIds, p2.items[0].already], [cs.slice(2), 2], '"all arrived" leaves the other two'); await move(p2.claimIds, ARRIVED); assert.deepEqual((await plan(id, 'arrived')).json.claimIds, []);
});

test('ONLY SECURED CLAIMS ARE PLANNED: a request nobody has secured, a cancelled claim and an item with nothing waiting are never moved (an item with nothing waiting is still listed, with no moves)', async () => {
  const go = await goOrder(); const a = await item(go.id, 'Mixed album'), empty = await item(go.id, 'Nobody wants this'); const secured = await claims(a, 2);
  const unsecured = await app.api('POST', '/api/claims', { handle: u('req'), lines: [{ itemId: a }] }); assert.equal(unsecured.status, 201); const gone = (await claimAndSecure(app, admin, u('gone'), a))[0]; assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: [gone] })).status, 200);
  const id = await store([{ itemId: a, qty: 10 }, { itemId: empty, qty: 3 }]); const p = (await plan(id, 'ordered')).json; const pa = p.items.find((i) => i.itemId === a), pe = p.items.find((i) => i.itemId === empty);
  assert.deepEqual([pa.needed, pa.claimIds], [2, secured], 'just the two secured claims'); assert.deepEqual([pe.needed, pe.moves.length, pe.claimIds], [0, 0, []], 'listed, but nothing to move'); assert.equal(p.totalMoves, 2);
});

test('PLANNING IS SAFE AND CHECKED: it changes nothing; an unknown store order is a 404; the direction must be ordered or arrived; a store order with no lines has no items; only the GOM', async () => {
  const go = await goOrder(); const a = await item(go.id, 'Safe album'); const cs = await claims(a, 2); const id = await store([{ itemId: a, qty: 2 }]); const empty = await store([]);
  await plan(id, 'ordered'); await plan(id, 'arrived'); assert.deepEqual(await stageOf(cs), [WAITING, WAITING], 'nothing moved'); assert.equal((await plan(999999, 'ordered')).status, 404);
  for (const bad of ['', 'shipped', 'ORDERED']) assert.equal((await api('GET', `/api/admin/store-orders/${id}/claim-plan?to=${bad}`)).status, 400, JSON.stringify(bad)); assert.equal((await api('GET', `/api/admin/store-orders/${id}/claim-plan`)).status, 400, 'missing');
  const none = (await plan(empty, 'ordered')).json; assert.deepEqual([none.items, none.claimIds, none.totalMoves], [[], [], 0]); const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await plan(id, 'ordered', j)).status, 403); assert.equal((await app.api('GET', `/api/admin/store-orders/${id}/claim-plan?to=ordered`)).status, 401);
});
