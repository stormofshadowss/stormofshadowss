import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';

// ITEM WEIGHT: what ONE of an item weighs (grams, optional). A claim with no weight of its own uses its item's — in the Warehouse (the box's EMS split) and in weight-based postage sharing.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const fresh = (p = 'iw') => `${p}${++N}`;
const ARRIVED = 'arrived at proxy / warehouse', READY = 'ready to pack / on hand';
const item = async (extra = {}) => { const r = await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: fresh('Thing '), price: 10, sizeBucket: 'M', ...extra }); assert.equal(r.status, 201, r.text); return r.json.id; };
const itemRow = async (id) => (await api('GET', '/api/admin/orders')).json.orders.flatMap((o) => o.items).find((i) => i.id === id);
async function arrived(it, handle = fresh()) { const [id] = await claimAndSecure(app, admin, handle, it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: ARRIVED }); return id; }
const cand = async (claimId) => (await api('GET', '/api/admin/boxes/candidates')).json.candidates.find((c) => c.claimId === claimId);
const mkBox = async (claimIds, extra = {}) => { const r = await api('POST', '/api/admin/boxes', { claimIds, emsTotal: 12, ...extra }); assert.equal(r.status, 201, r.text); return r.json.id; };
const shares = async (box) => (await app.q('SELECT claim_id AS id, ems_share AS ems, weight_used_g AS used FROM box_items WHERE box_id = ? ORDER BY claim_id', [box])).map((r) => ({ id: r.id, ems: Number(r.ems), used: Number(r.used) }));

test('AN ITEM CAN CARRY A WEIGHT in grams: saved on create, shown on the item, changed or cleared by an edit (recorded); a weight of 0, a fraction or a silly amount is refused', async () => {
  const a = await item({ weightG: 120 }), b = await item(), c = await item({ weightG: null });
  assert.deepEqual([(await itemRow(a)).weightG, (await itemRow(b)).weightG, (await itemRow(c)).weightG], [120, null, null]);
  for (const bad of [0, -5, 1.5, 100001, '120g']) { const r = await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: fresh('Bad '), price: 5, weightG: bad }); assert.equal(r.status, 400, `weight ${JSON.stringify(bad)}`); }
  assert.equal((await api('PATCH', `/api/admin/items/${b}`, { weightG: 250 })).status, 200); assert.equal((await itemRow(b)).weightG, 250); assert.equal((await api('PATCH', `/api/admin/items/${b}`, { weightG: null })).status, 200); assert.equal((await itemRow(b)).weightG, null, 'cleared');
  assert.equal((await api('PATCH', `/api/admin/items/${a}`, { weightG: 0 })).status, 400); assert.equal((await api('PATCH', `/api/admin/items/${a}`, { weightG: 100001 })).status, 400); assert.equal((await api('PATCH', `/api/admin/items/${a}`, { weightG: 12.5 })).status, 400); assert.equal((await itemRow(a)).weightG, 120, 'a refused edit changes nothing'); assert.equal((await api('PATCH', `/api/admin/items/${a}`, { title: 'Renamed only' })).status, 200); assert.equal((await itemRow(a)).weightG, 120, 'an edit that doesn\'t mention weight leaves it alone');
  assert.ok((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'item.weight'"))[0].n >= 2, 'recorded');
  const joiner = await joinerSession(app, `${fresh('jj')}@x.com`, fresh('jj')); assert.equal((await api('PATCH', `/api/admin/items/${a}`, { weightG: 5 }, joiner)).status, 403); const pub = (await app.api('GET', '/api/orders')).json.orders.flatMap((o) => o.items).find((i) => i.id === a); assert.equal(pub.weightG, undefined, 'joiners are not shown it');
});

test('IT CARRIES OVER TO THE WAREHOUSE: an arrived claim shows its item\'s weight; a weight typed on that one claim wins; clearing it falls back to the item\'s; no weight anywhere stays blank', async () => {
  const withW = await item({ weightG: 120 }), without = await item(); const c1 = await arrived(withW), c2 = await arrived(withW), c3 = await arrived(without);
  assert.deepEqual([(await cand(c1)).weightG, (await cand(c1)).ownWeightG, (await cand(c1)).itemWeightG], [120, null, 120], 'prefilled from the item');
  assert.equal((await api('PATCH', `/api/admin/claims/${c2}`, { weightG: 150 })).status, 200); assert.deepEqual([(await cand(c2)).weightG, (await cand(c2)).ownWeightG, (await cand(c2)).itemWeightG], [150, 150, 120], 'what you typed on this claim wins');
  assert.equal((await api('PATCH', `/api/admin/claims/${c2}`, { weightG: null })).status, 200); assert.deepEqual([(await cand(c2)).weightG, (await cand(c2)).ownWeightG], [120, null], 'cleared: back to the item\'s weight');
  assert.deepEqual([(await cand(c3)).weightG, (await cand(c3)).itemWeightG], [null, null], 'no weight anywhere: blank, as before');
});

test('THE BOX\'S EMS IS SPLIT BY THE ITEM WEIGHTS with no typing: exact weights (not estimates); a weight on the item and one on a claim mix; once boxed, the shares are fixed even if the item\'s weight changes later', async () => {
  const a = await item({ weightG: 100 }), b = await item(); const ca = await arrived(a), cb = await arrived(b); await api('PATCH', `/api/admin/claims/${cb}`, { weightG: 300 });
  const pv = await api('POST', '/api/admin/boxes/preview', { claimIds: [ca, cb], emsTotal: 12 }); assert.equal(pv.status, 200, pv.text); assert.deepEqual(pv.json.rows.map((r) => [r.weightUsedG, !!r.estimated]), [[100, false], [300, false]], 'both exact: the item\'s and the claim\'s');
  const box = await mkBox([ca, cb]); assert.deepEqual((await shares(box)).map((s) => [s.id, s.ems, s.used]), [[ca, 3, 100], [cb, 9, 300]], '12 shared 100 : 300');
  assert.equal((await api('PATCH', `/api/admin/items/${a}`, { weightG: 900 })).status, 200); assert.deepEqual((await shares(box)).map((s) => s.ems), [3, 9], 'a box already made keeps its shares');
  const x = await item(), y = await item(); const cx = await arrived(x), cy = await arrived(y); const est = await api('POST', '/api/admin/boxes/preview', { claimIds: [cx, cy], emsTotal: 12 }); assert.ok(est.json.rows.every((r) => r.estimated), 'with no weights anywhere it still estimates by size, as before');
});

test('CHANGING THE ITEM\'S WEIGHT LATER reaches every claim that isn\'t in a box yet (one with its own typed weight keeps it)', async () => {
  const it = await item({ weightG: 100 }); const c1 = await arrived(it), c2 = await arrived(it), c3 = await arrived(it); await api('PATCH', `/api/admin/claims/${c3}`, { weightG: 77 });
  assert.equal((await api('PATCH', `/api/admin/items/${it}`, { weightG: 200 })).status, 200); assert.deepEqual([(await cand(c1)).weightG, (await cand(c2)).weightG, (await cand(c3)).weightG], [200, 200, 77]);
  assert.equal((await api('PATCH', `/api/admin/items/${it}`, { weightG: null })).status, 200); assert.deepEqual([(await cand(c1)).weightG, (await cand(c3)).weightG], [null, 77], 'clearing the item\'s weight: those that followed it go blank again');
});

test('WEIGHT-BASED POSTAGE SHARING USES IT TOO: in a shared worldwide parcel each person\'s estimated weight is the sum of their items\' weights (item-level ones included)', async () => {
  const person = async () => { const h = fresh('pp'), cookie = await joinerSession(app, `${h}@x.com`, h); await api('PUT', '/api/my/address', { fullName: 'W P', address: '12 Test Street, Leeds, LS1 1AA', email: `${h}@x.com`, phone: '07700 900123' }, cookie); return { h, cookie }; };
  const ready = async (p, it) => { const [id] = await claimAndSecure(app, admin, p.h, it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); return id; };
  const owner = await person(), friend = await person(); const [o1, o2] = [await ready(owner, await item({ weightG: 100 })), await ready(owner, await item({ weightG: 50 }))]; const f1 = await ready(friend, await item({ weightG: 80 }));
  const r = await api('POST', `/api/my/parcels?handle=${owner.h}`, { claimIds: [o1, o2], method: 'WW Tracked', declaredValue: 'true', addressConfirmed: true }, owner.cookie); assert.equal(r.status, 201, r.text); const parcel = r.json.id;
  assert.equal((await api('POST', `/api/my/parcels/${parcel}/companion/invite`, { handles: friend.h }, owner.cookie)).status, 201); assert.equal((await api('POST', `/api/my/parcels/${parcel}/companion/accept`, { claimIds: [f1] }, friend.cookie)).status, 200);
  const p = (await api('GET', '/api/admin/packing?status=requested')).json.parcels.find((x) => x.id === parcel); assert.equal(p.feeSplit.mode, 'weight', 'worldwide postage is shared by weight');
  assert.deepEqual([p.people.find((x) => x.handle === owner.h).estimatedG, p.people.find((x) => x.handle === friend.h).estimatedG], [150, 80], '100 + 50 g for the owner, 80 g for the friend');
});

test('TAKING AN ITEM OUT OF A BOX RE-SHARES BY THE ITEM WEIGHTS TOO', async () => {
  const [i1, i2, i3] = [await item({ weightG: 100 }), await item({ weightG: 200 }), await item({ weightG: 300 })]; const [a, b, c] = [await arrived(i1), await arrived(i2), await arrived(i3)]; const box = await mkBox([a, b, c]); assert.deepEqual((await shares(box)).map((s) => s.ems), [2, 4, 6]);
  const r = await api('POST', `/api/admin/boxes/${box}/remove-item`, { claimId: b }); assert.equal(r.status, 200, r.text); assert.deepEqual((await shares(box)).map((s) => [s.id, s.ems]), [[a, 3], [c, 9]], '12 shared 100 : 300 between the two left');
});
