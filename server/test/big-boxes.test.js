import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';

// A BOX FULL OF SMALL THINGS: well over 200 items in one box (it used to stop at 200 with "Array must contain at most 200 element(s)").
let app, admin, w, N = 0, ids = [], handles = [], box;
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const ARRIVED = 'arrived at proxy / warehouse', READY = 'ready to pack / on hand';
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const item = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: 'Small card', price: 1, sizeBucket: 'XS' })).json.id;
  handles = ['bigbox_a', 'bigbox_b', 'bigbox_c', 'bigbox_d'];
  for (let i = 0; i < 13; i++) ids.push(...await claimAndSecure(app, admin, handles[i % 4], item, { qty: 20 }));            // 13 × 20 = 260 small claims, shared between four people
  assert.equal(ids.length, 260);
  assert.equal((await api('POST', '/api/admin/claims/pipeline', { claimIds: ids, pipeline: ARRIVED })).status, 200, 'all have arrived at the proxy');
});
after(async () => { await app.stop(); });

test('A BOX OF 260 SMALL THINGS CAN BE PREVIEWED AND CREATED: every item is in it, the EMS is shared out in full across them, and everyone is charged their part', async () => {
  const pv = await api('POST', '/api/admin/boxes/preview', { claimIds: ids, emsTotal: 26 }); assert.equal(pv.status, 200, pv.text); assert.equal(pv.json.rows.length, 260);
  const r = await api('POST', '/api/admin/boxes', { claimIds: ids, emsTotal: 26 }); assert.equal(r.status, 201, r.text); box = r.json.id;
  const items = await app.q('SELECT claim_id AS id, ems_share AS ems FROM box_items WHERE box_id = ?', [box]); assert.equal(items.length, 260); assert.equal(Number(items.reduce((s, i) => s + Number(i.ems), 0).toFixed(2)), 26, '£26.00 of EMS is fully shared out');
  const perPerson = await app.q("SELECT j.instagram_handle AS h, ROUND(SUM(cc.cost), 2) AS ems FROM claims c JOIN joiners j ON j.id = c.joiner_id JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category = 'ems' WHERE c.box_id = ? GROUP BY j.instagram_handle ORDER BY j.instagram_handle", [box]);
  assert.deepEqual(perPerson.map((p) => [p.h, Number(p.ems)]), [['bigbox_a', 8], ['bigbox_b', 6], ['bigbox_c', 6], ['bigbox_d', 6]], 'one person has 80 items and three have 60: 10p each, so £8.00 and £6.00 ×3');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE box_id = ?', [box]))[0].n, 260);
});

test('THE LIMIT IS NOW 1000, AND PAST IT THE MESSAGE SAYS WHAT TO DO: 1000 passes the size check (and then fails honestly on items that don\'t exist); 1001 is refused in plain English', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => 900000 + i);
  const ok = await api('POST', '/api/admin/boxes', { claimIds: many(1000), emsTotal: 5 }); assert.equal(ok.status, 404, 'not a size error — the ids just don\'t exist'); assert.doesNotMatch(String(ok.json.error), /at most/);
  for (const [path, body, field] of [['/api/admin/boxes', { claimIds: many(1001), emsTotal: 5 }, 'claimIds'], ['/api/admin/boxes/preview', { claimIds: many(1001), emsTotal: 5 }, 'claimIds'], [`/api/admin/boxes/${box}/ready`, { ready: many(1001), checking: [] }, 'ready'], [`/api/admin/boxes/${box}/ready`, { ready: [], checking: many(1001) }, 'checking']]) {
    const r = await api('POST', path, body); assert.equal(r.status, 400, path); assert.deepEqual([r.json.issues[0].path, r.json.issues[0].message], [field, 'A box can hold at most 1000 items — split it into two boxes.'], `${path}: the screen shows "${field}: A box can hold at most 1000 items — split it into two boxes."`);
  }
});

test('A BIG BOX CAN BE TAKEN THROUGH ARRIVAL: 250 items marked ready to pack and 10 left checking, in one go', async () => {
  assert.equal((await api('POST', `/api/admin/boxes/${box}/enroute`, {})).status, 200); assert.equal((await api('POST', `/api/admin/boxes/${box}/arrived`, {})).status, 200);
  const r = await api('POST', `/api/admin/boxes/${box}/ready`, { ready: ids.slice(0, 250), checking: ids.slice(250) }); assert.equal(r.status, 200, r.text);
  const counts = await app.q('SELECT pipeline, COUNT(*) AS n FROM claims WHERE box_id = ? GROUP BY pipeline ORDER BY pipeline', [box]); assert.deepEqual(counts.map((c) => [c.pipeline, c.n]), [['checking parcel', 10], [READY, 250]]);
});

test('A BIG PARCEL\'S CHECKLIST CAN BE TICKED IN ONE GO: 250 items marked packed together, then some unticked', async () => {
  const owner = (await app.q('SELECT joiner_id AS j FROM claims WHERE id = ?', [ids[0]]))[0].j; await app.q('INSERT INTO parcels (joiner_id, method, status, requested_at) VALUES (?, ?, ?, NOW(3))', [owner, 'UK Royal Mail Tracked 48', 'requested']); const parcel = (await app.q('SELECT MAX(id) AS id FROM parcels'))[0].id;
  for (const id of ids.slice(0, 250)) await app.q('INSERT INTO parcel_items (parcel_id, claim_id) VALUES (?, ?)', [parcel, id]);
  const all = await api('POST', `/api/admin/parcels/${parcel}/items-packed`, { packed: true, claimIds: ids.slice(0, 250) }); assert.equal(all.status, 200, all.text); assert.deepEqual([all.json.ticked, all.json.total], [250, 250]);
  const some = await api('POST', `/api/admin/parcels/${parcel}/items-packed`, { packed: false, claimIds: ids.slice(0, 40) }); assert.deepEqual([some.json.ticked, some.json.total], [210, 250], 'forty unticked again');
  assert.equal((await api('POST', `/api/admin/parcels/${parcel}/items-packed`, { packed: true, claimIds: Array.from({ length: 1001 }, (_, i) => i + 1) })).status, 400, 'past 1000 is refused');
});
