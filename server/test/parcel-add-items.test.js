import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// ADDING ITEMS TO A SHIPPING REQUEST that isn't packed yet: more of the person's items have arrived and can go out together. The request keeps its place; if postage / packaging were already set, the SAME totals are
// re-shared across all the items and the parcel is flagged in Packing for the GOM to check them.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ad') => `${x}${++N}`;
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const READY = 'ready to pack / on hand';
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Add GO '), proxy: 'Sam' })).json.id;
async function person() { const h = u('ap'); const cookie = await joinerSession(app, `${h}@x.com`, h); await api('PUT', '/api/my/address', { fullName: 'Add Person', address: '12 Test Street, Leeds, LS1 1AA', email: `${h}@x.com`, phone: '07700 900123' }, cookie); return { h, cookie, go: await goOrder() }; }
async function ready(p, { handle = p.h, price = 5, stage = READY } = {}) { const it = (await api('POST', `/api/admin/orders/${p.go}/items`, { type: 'normal', title: u('Thing '), price })).json.id; const [id] = await claimAndSecure(app, admin, handle, it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: stage }); return id; }
const request = async (p, claimIds) => { const r = await api('POST', `/api/my/parcels?handle=${p.h}`, { claimIds, method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p.cookie); assert.equal(r.status, 201, r.text); return r.json.id; };
const add = (p, parcel, claimIds, c = p.cookie) => api('POST', `/api/my/parcels/${parcel}/items`, { claimIds }, c);
const inParcel = async (parcel) => (await app.q('SELECT claim_id AS id, added_at AS addedAt FROM parcel_items WHERE parcel_id = ? ORDER BY claim_id', [parcel]));
const packingRow = async (parcel) => (await api('GET', '/api/admin/packing?status=requested')).json.parcels.find((x) => x.id === parcel);
const fee = async (claimId, cat) => (await app.q('SELECT cost, paid, due_date AS due FROM claim_costs WHERE claim_id = ? AND category = ?', [claimId, cat]))[0];

test('MORE ITEMS HAVE ARRIVED: they are added to the request, which keeps its place in the queue; the new item is marked as added later; with no fees set yet there is nothing to check', async () => {
  const p = await person(); const a = await ready(p); const other = await person(); const oa = await ready(other); await request(other, [oa]);
  const parcel = await request(p, [a]); const before = (await api('GET', '/api/my/parcels', undefined, p.cookie)).json.parcels.find((x) => x.id === parcel).queuePosition; const b = await ready(p);
  const r = await add(p, parcel, [b]); assert.equal(r.status, 201, r.text); assert.deepEqual([r.json.added, r.json.feesResplit, r.json.queuePosition], [1, false, before], 'same place in the queue');
  const items = await inParcel(parcel); assert.deepEqual(items.map((i) => [i.id, i.addedAt !== null]), [[a, false], [b, true]]); const row = await packingRow(parcel); assert.equal(!!row.feesCheckNeeded, false); assert.deepEqual(row.items.map((i) => [i.claimId, i.addedLater]), [[a, false], [b, true]]);
  const mine = (await api('GET', '/api/my/parcels', undefined, p.cookie)).json.parcels.find((x) => x.id === parcel); assert.deepEqual([mine.canAddItems, mine.items.length], [true, 2]);
  assert.deepEqual((await app.q("SELECT action FROM audit_log WHERE entity = 'parcel' AND entity_id = ? AND action = 'parcel.add_items'", [parcel])).length, 1, 'recorded');
});

test('FEES ALREADY SET: the SAME totals are re-shared across all the items (what the person owes in total does not change), the new item\'s fee lines get the same due dates, and the parcel is flagged for you', async () => {
  const p = await person(); const a = await ready(p); const parcel = await request(p, [a]); assert.equal((await api('POST', `/api/admin/parcels/${parcel}/fees`, { doms: 6, packaging: 2, dueDate: day(9) })).status, 200);
  assert.deepEqual([Number((await fee(a, 'doms')).cost), Number((await fee(a, 'packaging')).cost)], [6, 2]); const b = await ready(p);
  const r = await add(p, parcel, [b]); assert.deepEqual([r.status, r.json.feesResplit], [201, true]);
  const costs = async (cat) => [Number((await fee(a, cat)).cost), Number((await fee(b, cat)).cost)]; const d = await costs('doms'), k = await costs('packaging'); assert.equal(d[0] + d[1], 6, 'postage is still £6.00 in total'); assert.equal(k[0] + k[1], 2, 'packaging is still £2.00'); assert.ok(d[1] > 0 && d[0] < 6, 'the new item takes a share; the first item\'s share goes down');
  assert.deepEqual([(await fee(b, 'doms')).due, (await fee(b, 'packaging')).due, (await fee(a, 'doms')).due], [day(9), day(9), day(9)], 'the new item\'s fees are due when the others are');
  const row = await packingRow(parcel); assert.equal(!!row.feesCheckNeeded, true, 'flagged for you'); assert.deepEqual([row.domsTotal, row.packagingTotal], [6, 2], 'your totals are untouched');
});

test('IF THE POSTAGE WAS ALREADY PAID: the first item\'s share goes down and what is no longer owed on it goes to the person\'s credit (nothing is lost)', async () => {
  const p = await person(); const a = await ready(p); const parcel = await request(p, [a]); await api('POST', `/api/admin/parcels/${parcel}/fees`, { doms: 6, dueDate: day(9) }); await api('PATCH', `/api/admin/claims/${a}`, { costs: { doms: { paid: 6 } } });
  const credit = async () => Number((await app.q("SELECT COALESCE(SUM(l.balance_effect), 0) AS c FROM credit_ledger l JOIN joiners j ON j.id = l.joiner_id WHERE j.instagram_handle = ?", [p.h]))[0].c); const before = await credit(); const b = await ready(p); assert.equal((await add(p, parcel, [b])).status, 201);
  const [da, db] = [Number((await fee(a, 'doms')).cost), Number((await fee(b, 'doms')).cost)]; assert.equal(da + db, 6); assert.ok(Number((await fee(a, 'doms')).paid) <= da + 1e-9, 'the first item is not shown as paid more than it costs now'); assert.ok((await credit()) - before >= db - 1e-9 || Number((await fee(b, 'doms')).paid) > 0, 'the difference was kept for them (as credit or as payment on the new item)');
});

test('YOU CLEAR THE FLAG: saving the fees again, or "Postage is fine", takes it away; unknown parcels are not found; GOM only', async () => {
  const p = await person(); const a = await ready(p); const parcel = await request(p, [a]); await api('POST', `/api/admin/parcels/${parcel}/fees`, { doms: 4, dueDate: day(9) }); await add(p, parcel, [await ready(p)]); assert.equal(!!(await packingRow(parcel)).feesCheckNeeded, true);
  assert.equal((await api('POST', `/api/admin/parcels/${parcel}/fees`, { doms: 4, dueDate: day(9) })).status, 200); assert.equal(!!(await packingRow(parcel)).feesCheckNeeded, false, 're-saving the fees = you have checked them');
  await add(p, parcel, [await ready(p)]); assert.equal(!!(await packingRow(parcel)).feesCheckNeeded, true); assert.equal((await api('POST', `/api/admin/parcels/${parcel}/fees-checked`, {})).status, 200); assert.equal(!!(await packingRow(parcel)).feesCheckNeeded, false);
  assert.equal((await api('POST', '/api/admin/parcels/99999999/fees-checked', {})).status, 404); assert.equal((await api('POST', `/api/admin/parcels/${parcel}/fees-checked`, {}, p.cookie)).status, 403); assert.equal((await app.api('POST', `/api/admin/parcels/${parcel}/fees-checked`, {})).status, 401);
});

test('IT IS REFUSED, WITH NOTHING CHANGED, WHEN: the request is already packed, the item is not ready, already in a parcel, has a pending cancel, belongs to someone else, or the parcel is someone else\'s / a friend\'s', async () => {
  const p = await person(); const a = await ready(p); const parcel = await request(p, [a]); const other = await person(); const mineElsewhere = await ready(p); const otherParcel = await request(p, [mineElsewhere]);
  const notReady = await ready(p, { stage: 'ordered via proxy / warehouse' }); let r = await add(p, parcel, [notReady]); assert.deepEqual([r.status, r.json.code], [400, 'not_ready']);
  r = await add(p, parcel, [mineElsewhere]); assert.deepEqual([r.status, r.json.code], [409, 'already_requested'], 'already in another request');
  const pend = await ready(p); await api('POST', '/api/my/cancel-requests', { claimId: pend, reason: 'changed my mind' }, p.cookie).catch(() => null); await app.q("INSERT IGNORE INTO cancel_requests (claim_id, joiner_id, status, reason) SELECT ?, joiner_id, 'pending', 'x' FROM claims WHERE id = ?", [pend, pend]); r = await add(p, parcel, [pend]); assert.deepEqual([r.status, r.json.code], [409, 'cancel_pending']);
  const theirs = await ready(other); assert.equal((await add(p, parcel, [theirs])).status, 403, "someone else's item"); assert.equal((await add(other, parcel, [await ready(other)], other.cookie)).status, 404, "someone else's parcel");
  assert.equal((await add(p, parcel, [])).status, 400); assert.equal((await add(p, parcel, Array.from({ length: 51 }, (_, i) => i + 1))).status, 400); assert.equal((await add(p, 99999999, [await ready(p)])).status, 404);
  assert.deepEqual((await inParcel(parcel)).map((i) => i.id), [a], 'nothing was added by any of those'); void otherParcel;
  const late = await ready(p); await app.q("UPDATE parcels SET status = 'packed' WHERE id = ?", [parcel]); r = await add(p, parcel, [late]); assert.deepEqual([r.status, r.json.code], [409, 'parcel_not_open']); assert.match(r.json.error, /already been packed, so it's too late to add items/); assert.equal((await inParcel(parcel)).length, 1);
  const mine = (await api('GET', '/api/my/parcels', undefined, p.cookie)).json.parcels.find((x) => x.id === parcel); assert.equal(mine.canAddItems, false, 'once packed, the screen no longer offers it');
});

test('A FRIEND SHARING YOUR PARCEL CANNOT ADD TO IT (only the person it is posted to can)', async () => {
  const p = await person(), friend = await person(); const a = await ready(p), f1 = await ready(friend); const parcel = await request(p, [a]); assert.equal((await api('POST', `/api/my/parcels/${parcel}/companion/invite`, { handles: friend.h }, p.cookie)).status, 201); assert.equal((await api('POST', `/api/my/parcels/${parcel}/companion/accept`, { claimIds: [f1] }, friend.cookie)).status, 200);
  const f2 = await ready(friend); const r = await add(friend, parcel, [f2], friend.cookie); assert.equal(r.status, 404); assert.deepEqual((await inParcel(parcel)).map((i) => i.id), [a, f1]); const view = (await api('GET', '/api/my/parcels', undefined, friend.cookie)).json.parcels.find((x) => x.id === parcel); assert.equal(view.canAddItems, false);
});

test('ONE PERSON, SEVERAL HANDLES: items from their other handle can be added too — that handle joins the parcel automatically (no invitation) and is only added once', async () => {
  const p = await person(); const sibling = u('sib'); assert.equal((await api('POST', '/api/me/handles', { handle: sibling }, p.cookie)).status, 200); const a = await ready(p); const parcel = await request(p, [a]);
  const s1 = await ready(p, { handle: sibling }); const r = await add(p, parcel, [s1]); assert.equal(r.status, 201, r.text); const comps = await app.q("SELECT pc.status, pc.how, j.instagram_handle AS handle FROM parcel_companions pc JOIN joiners j ON j.id = pc.joiner_id WHERE pc.parcel_id = ?", [parcel]); assert.deepEqual(comps.map((c) => [c.handle, c.status, c.how]), [[sibling, 'accepted', 'own']]);
  const s2 = await ready(p, { handle: sibling }); assert.equal((await add(p, parcel, [s2])).status, 201); assert.equal((await app.q('SELECT COUNT(*) AS n FROM parcel_companions WHERE parcel_id = ?', [parcel]))[0].n, 1, 'still one companion row'); assert.deepEqual((await inParcel(parcel)).map((i) => i.id), [a, s1, s2]);
});

test('TWO PRESSES AT ONCE for the same item add it exactly once', async () => {
  const p = await person(); const a = await ready(p); const parcel = await request(p, [a]); const b = await ready(p); const rs = await Promise.all([add(p, parcel, [b]), add(p, parcel, [b]), add(p, parcel, [b])]);
  assert.equal(rs.filter((r) => r.status === 201).length, 1); assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409)); assert.deepEqual((await inParcel(parcel)).map((i) => i.id), [a, b]);
});
