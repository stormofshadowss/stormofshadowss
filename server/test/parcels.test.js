import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure, tickParcel } from './helpers.js';

const READY = 'ready to pack / on hand';
let app, admin, w;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const addr = (c) => app.api('PUT', '/api/my/address', { fullName: 'Pat Kay', address: '1 Test Road, Leeds', email: 'p@x.com', phone: '0700' }, c);
const request = (c, body) => app.api('POST', '/api/my/parcels', { method: 'UK Royal Mail Tracked 48', addressConfirmed: true, ...body }, c);
const admin_ = (path, body) => app.api('POST', path, body ?? {}, admin);
// marks a parcel packed the proper way: tick the whole checklist first
const packIt = async (id) => { await tickParcel(app, admin, id); return admin_(`/api/admin/parcels/${id}/packed`); };
const summary = async (c) => (await app.api('GET', '/api/my/summary', undefined, c)).json;
const myParcels = async (c) => (await app.api('GET', '/api/my/parcels', undefined, c)).json.parcels;
// each spec is an item id, or [itemId, extra] when the item needs a choice (a size, a member)
async function readyItems(handle, ...specs) {
  const ids = [];
  for (const spec of specs) {
    const [it, extra] = Array.isArray(spec) ? spec : [spec, {}];
    const [id] = await claimAndSecure(app, admin, handle, it, extra);
    await app.api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }, admin);
    ids.push(id);
  }
  return ids;
}
const pipelineOf = async (id) => (await app.q('SELECT pipeline FROM claims WHERE id = ?', [id]))[0].pipeline;

test('the storage clock starts when an item first becomes ready to pack, and only then', async () => {
  const c = await joinerSession(app, 'st1@x.com', 'st1');
  const [id] = await claimAndSecure(app, admin, 'st1', w.keyring);
  const get = async () => (await app.q('SELECT ready_to_pack_date AS d, received_date AS r FROM claims WHERE id = ?', [id]))[0];
  assert.equal((await get()).d, null);
  await app.api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }, admin);
  const first = (await get()).d;
  assert.match(first, /^\d{4}-\d{2}-\d{2}$/);
  await app.q("UPDATE claims SET ready_to_pack_date = '2020-01-01' WHERE id = ?", [id]);
  await app.api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'checking parcel' }, admin);
  await app.api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }, admin);
  assert.equal((await get()).d, '2020-01-01', 'not re-stamped');
  await app.api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'completed' }, admin);
  assert.ok((await get()).r, 'completing stamps the received date');
});

test('requesting shipping: needs an address, ready items, your own items, and the confirmation', async () => {
  const c = await joinerSession(app, 'req1@x.com', 'req1');
  const [id] = await readyItems('req1', w.keyring);

  assert.equal((await request(c, { claimIds: [id] })).json.code, 'address_required');
  await addr(c);
  assert.equal((await request(c, { claimIds: [id], addressConfirmed: false })).status, 400, 'must confirm the address');
  assert.equal((await request(c, { claimIds: [] })).status, 400);
  assert.equal((await request(c, { claimIds: [id], method: 'WW Tracked' })).json.code, 'declared_value_required', 'worldwide needs a declared value');

  const notReady = (await claimAndSecure(app, admin, 'req1', w.album))[0]; // secured, but not on hand yet
  assert.equal((await request(c, { claimIds: [notReady] })).json.code, 'not_ready');

  const other = await joinerSession(app, 'req1b@x.com', 'req1b');
  await addr(other);
  const [theirs] = await readyItems('req1b', w.keyring);
  assert.equal((await request(c, { claimIds: [theirs] })).status, 403, 'cannot ship someone else\'s item');
  assert.equal((await request(other, { claimIds: [id] })).status, 403);

  const ok = await request(c, { claimIds: [id, id], notes: 'toploader please', bias: 'Han' });
  assert.equal(ok.status, 201, 'a repeated id is just counted once');
  assert.equal(ok.json.queuePosition, 1);
  assert.equal((await request(c, { claimIds: [id] })).json.code, 'already_requested');
});

test('the packing queue is first come, first served — and moves up as parcels are packed or cancelled', async () => {
  // the queue is shared by everyone, so start from an empty one (earlier tests left parcels in it)
  for (const p of (await app.api('GET', '/api/admin/packing', undefined, admin)).json.parcels) await admin_(`/api/admin/parcels/${p.id}/cancel`);
  const people = ['q1', 'q2', 'q3'];
  const cookies = {}; const parcel = {};
  for (const h of people) {
    cookies[h] = await joinerSession(app, `${h}@x.com`, h);
    await addr(cookies[h]);
    const [id] = await readyItems(h, w.keyring);
    parcel[h] = (await request(cookies[h], { claimIds: [id] })).json;   // sequential, so request order = q1, q2, q3
  }
  assert.deepEqual(people.map((h) => parcel[h].queuePosition), [1, 2, 3]);

  const queue = (await app.api('GET', '/api/admin/packing', undefined, admin)).json.parcels.filter((p) => people.includes(p.handle));
  assert.deepEqual(queue.map((p) => [p.handle, p.queuePosition]), [['q1', 1], ['q2', 2], ['q3', 3]]);

  // adding postage to the LAST one doesn't jump the queue
  assert.equal((await admin_(`/api/admin/parcels/${parcel.q3.id}/doms`, { total: 5 })).status, 200);
  assert.equal((await myParcels(cookies.q3))[0].queuePosition, 3);

  // pack the first: everyone behind moves up
  assert.equal((await packIt(parcel.q1.id)).status, 200);
  assert.deepEqual([(await myParcels(cookies.q2))[0].queuePosition, (await myParcels(cookies.q3))[0].queuePosition], [1, 2]);
  assert.equal((await myParcels(cookies.q1))[0].queuePosition, null, 'a packed parcel has left the queue');

  // cancel the (new) first: the last one moves up again
  assert.equal((await admin_(`/api/admin/parcels/${parcel.q2.id}/cancel`)).status, 200);
  assert.equal((await myParcels(cookies.q3))[0].queuePosition, 1);
  assert.deepEqual((await myParcels(cookies.q2)), [], 'a cancelled parcel disappears from their list');
});

test('postage is shared across the parcel to the penny, can be corrected, and only while queued', async () => {
  const c = await joinerSession(app, 'dm1@x.com', 'dm1');
  await addr(c);
  const ids = await readyItems('dm1', w.keyring, w.keyring, w.keyring);
  const p = (await request(c, { claimIds: ids })).json;
  const dom = async () => (await app.q("SELECT cc.cost FROM claim_costs cc WHERE cc.claim_id IN (?) AND cc.category = 'doms' ORDER BY cc.claim_id", [ids])).map((r) => Number(r.cost));

  await admin_(`/api/admin/parcels/${p.id}/doms`, { total: 10 });
  assert.deepEqual(await dom(), [3.34, 3.33, 3.33]);
  assert.equal((await summary(c)).owed.doms, 10, 'it shows up in what they owe');

  await admin_(`/api/admin/parcels/${p.id}/doms`, { total: 9 });                 // corrected down
  assert.deepEqual(await dom(), [3, 3, 3]);
  await admin_(`/api/admin/parcels/${p.id}/doms`, { total: 12.5 });              // and up
  assert.equal((await dom()).reduce((a, b) => a + b, 0), 12.5);
  assert.equal((await app.api('POST', `/api/admin/parcels/${p.id}/doms`, { total: -1 }, admin)).status, 400);
  assert.equal((await app.api('POST', `/api/admin/parcels/${p.id}/doms`, { total: 5 }, c)).status, 403, 'joiners can\'t set postage');

  await packIt(p.id);
  assert.equal((await admin_(`/api/admin/parcels/${p.id}/doms`, { total: 3 })).json.code, 'bad_state');
});

test('credit the joiner already holds meets postage automatically', async () => {
  const c = await joinerSession(app, 'dm2@x.com', 'dm2');
  await addr(c);
  const [id] = await readyItems('dm2', w.keyring);
  const buy = await claimAndSecure(app, admin, 'dm2', w.album);
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 38, reference: 'DM2', overpay: { choice: 'credit' } }, c); // owes 6+26 = 32, pays 38 -> £6 credit
  await app.api('POST', `/api/admin/payments/${pay.json.id}/verify`, {}, admin);
  assert.equal((await summary(c)).credit, 6);
  const p = (await request(c, { claimIds: [id] })).json;
  await admin_(`/api/admin/parcels/${p.id}/doms`, { total: 4 });
  const s = await summary(c);
  assert.equal(s.owed.doms, 0, '£4 of postage was met from credit');
  assert.equal(s.credit, 2);
});

test('cancelling a parcel after postage was paid refunds it as credit — a line is never left overpaid', async () => {
  const c = await joinerSession(app, 'can1@x.com', 'can1');
  await addr(c);
  const [id] = await readyItems('can1', w.keyring);
  await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 6, reference: 'C1' }, c).then((r) => app.api('POST', `/api/admin/payments/${r.json.id}/verify`, {}, admin));
  const p = (await request(c, { claimIds: [id] })).json;
  await admin_(`/api/admin/parcels/${p.id}/doms`, { total: 4 });
  const doms = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 4, reference: 'C2' }, c);
  await app.api('POST', `/api/admin/payments/${doms.json.id}/verify`, {}, admin);
  assert.equal((await summary(c)).owed.total, 0, 'postage paid');

  assert.equal((await admin_(`/api/admin/parcels/${p.id}/cancel`)).status, 200);
  const s = await summary(c);
  assert.equal(s.credit, 4, 'the £4 postage they paid is theirs again');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost'))[0].n, 0, 'nothing overpaid');
  assert.equal((await request(c, { claimIds: [id] })).status, 201, 'and the item can be re-requested');
});

test('packed -> shipped -> received, in order; the joiner confirms arrival and the items complete', async () => {
  const c = await joinerSession(app, 'rcv1@x.com', 'rcv1');
  await addr(c);
  const ids = await readyItems('rcv1', w.keyring, [w.hoodie, { variant: 'L' }]);
  const p = (await request(c, { claimIds: ids })).json;

  assert.equal((await admin_(`/api/admin/parcels/${p.id}/shipped`)).json.code, 'bad_state', 'cannot ship what is not packed');
  assert.equal((await app.api('POST', `/api/my/parcels/${p.id}/received`, {}, c)).json.code, 'not_shipped');
  await packIt(p.id);
  assert.deepEqual(await Promise.all(ids.map(pipelineOf)), ['packed', 'packed']);
  await admin_(`/api/admin/parcels/${p.id}/shipped`);
  assert.deepEqual(await Promise.all(ids.map(pipelineOf)), ['shipped', 'shipped']);
  assert.equal((await myParcels(c))[0].status, 'shipped');

  const thief = await joinerSession(app, 'rcv1x@x.com', 'rcv1x');
  assert.equal((await app.api('POST', `/api/my/parcels/${p.id}/received`, {}, thief)).status, 404, 'only the owner can confirm');

  assert.equal((await app.api('POST', `/api/my/parcels/${p.id}/received`, {}, c)).status, 200);
  assert.deepEqual(await Promise.all(ids.map(pipelineOf)), ['completed', 'completed'], 'the whole parcel completes together');
  assert.equal((await myParcels(c))[0].status, 'received');
  assert.ok((await app.q('SELECT received_date AS d FROM claims WHERE id = ?', [ids[0]]))[0].d);
  assert.equal((await app.api('POST', `/api/my/parcels/${p.id}/received`, {}, c)).status, 200, 'confirming twice is harmless');
  const s = await summary(c);
  assert.ok(s.orders[0].claims.every((x) => x.pipeline === 'completed' && x.receivedDate));
});

test('the GOM can mark received on a joiner\'s behalf; parcel actions are admin-only', async () => {
  const c = await joinerSession(app, 'rcv2@x.com', 'rcv2');
  await addr(c);
  const [id] = await readyItems('rcv2', w.keyring);
  const p = (await request(c, { claimIds: [id] })).json;
  for (const action of ['packed', 'shipped', 'received', 'cancel']) assert.equal((await app.api('POST', `/api/admin/parcels/${p.id}/${action}`, {}, c)).status, 403, action);
  await packIt(p.id); await admin_(`/api/admin/parcels/${p.id}/shipped`);
  assert.equal((await admin_(`/api/admin/parcels/${p.id}/received`)).status, 200);
  assert.equal(await pipelineOf(id), 'completed');
  assert.equal((await admin_('/api/admin/parcels/999999/packed')).status, 404);
});

test('a joiner with two requests and many items keeps each parcel separate', async () => {
  const c = await joinerSession(app, 'two1@x.com', 'two1');
  await addr(c);
  const ids = await readyItems('two1', w.keyring, w.keyring, [w.hoodie, { variant: 'M' }]);
  const a = (await request(c, { claimIds: [ids[0]] })).json;
  const b = (await request(c, { claimIds: [ids[1], ids[2]] })).json;
  const mine = await myParcels(c);
  assert.deepEqual(mine.map((p) => [p.id, p.items.length]), [[b.id, 2], [a.id, 1]]);
  assert.deepEqual([a.queuePosition, b.queuePosition].map(Number).every((n) => n >= 1), true);
});

test('personalised Lomo: uses the delivery-details name unless they choose another', async () => {
  const c = await joinerSession(app, 'lomo1@x.com', 'lomo1');
  await addr(c); // the name on these details is "Pat Kay"
  const send = async (extra) => {
    const [id] = await readyItems('lomo1', w.keyring);
    const p = (await request(c, { claimIds: [id], ...extra })).json;
    return (await app.q('SELECT lomo_name AS n, lomo_source AS s FROM parcels WHERE id = ?', [p.id]))[0];
  };
  assert.deepEqual(await send({}), { n: 'Pat Kay', s: 'delivery' }, 'nothing entered -> the delivery name');
  assert.deepEqual(await send({ lomoName: 'Patty' }), { n: 'Patty', s: 'custom' }, 'a name they chose');
  assert.deepEqual(await send({ lomoName: 'pat KAY' }), { n: 'pat KAY', s: 'delivery' }, 'typing the delivery name anyway is still the delivery name');
  assert.equal((await request(c, { claimIds: [(await readyItems('lomo1', w.keyring))[0]], lomoName: 'x'.repeat(81) })).status, 400, 'length-limited');
});

test('the Lomo name shows to the joiner and to the GOM', async () => {
  const c = await joinerSession(app, 'lomo2@x.com', 'lomo2');
  await addr(c);
  const [id] = await readyItems('lomo2', w.keyring);
  const p = (await request(c, { claimIds: [id], lomoName: 'Lo' })).json;
  const mine = (await myParcels(c)).find((x) => x.id === p.id);
  assert.deepEqual([mine.lomoName, mine.lomoSource], ['Lo', 'custom']);
  const adminView = (await app.api('GET', '/api/admin/packing', undefined, admin)).json.parcels.find((x) => x.id === p.id);
  assert.deepEqual([adminView.lomoName, adminView.lomoSource], ['Lo', 'custom']);
});

test('the GOM sees the delivery details on each parcel (and nobody else does)', async () => {
  const c = await joinerSession(app, 'addr1@x.com', 'addr1');
  await addr(c);
  const [id] = await readyItems('addr1', w.keyring);
  const p = (await request(c, { claimIds: [id] })).json;
  const row = (await app.api('GET', '/api/admin/packing', undefined, admin)).json.parcels.find((x) => x.id === p.id);
  assert.deepEqual([row.deliveryName, row.deliveryAddress, row.deliveryPhone], ['Pat Kay', '1 Test Road, Leeds', '0700']);
  assert.equal((await app.api('GET', '/api/admin/packing', undefined, c)).status, 403);
  assert.ok(!JSON.stringify(await myParcels(c)).includes('1 Test Road'), 'the joiner-side parcel list never echoes the address');
});

// ───────────── postage (Doms) + packaging fee ─────────────
const fees = (id, body, cookie = admin) => app.api('POST', `/api/admin/parcels/${id}/fees`, body, cookie);
const costOf = async (ids, cat) => (await app.q('SELECT cost FROM claim_costs WHERE claim_id IN (?) AND category = ? ORDER BY claim_id', [ids, cat])).map((r) => Number(r.cost));

test('packaging fee: set together with postage, each shared across the items to the penny', async () => {
  const c = await joinerSession(app, 'pf1@x.com', 'pf1');
  await addr(c);
  const ids = await readyItems('pf1', w.keyring, w.keyring, w.keyring);
  const p = (await request(c, { claimIds: ids })).json;
  assert.equal((await fees(p.id, { doms: 4.5, packaging: 1 })).status, 200);
  assert.deepEqual(await costOf(ids, 'doms'), [1.5, 1.5, 1.5]);
  assert.deepEqual(await costOf(ids, 'packaging'), [0.34, 0.33, 0.33], '£1 over 3 items adds back to exactly £1');
  const s = await summary(c);
  assert.equal(s.owed.doms, 4.5);
  assert.equal(s.owed.packaging, 1);
  assert.equal(s.owed.total, 18 + 4.5 + 1, '3 keyrings + postage + packaging');
  const mine = (await myParcels(c)).find((x) => x.id === p.id);
  assert.deepEqual([mine.domsTotal, mine.packagingTotal], [4.5, 1]);
  const adm = (await app.api('GET', '/api/admin/packing', undefined, admin)).json.parcels.find((x) => x.id === p.id);
  assert.deepEqual([adm.domsTotal, adm.packagingTotal], [4.5, 1]);
});

test('either fee can be set on its own, corrected later, and set to £0', async () => {
  const c = await joinerSession(app, 'pf2@x.com', 'pf2');
  await addr(c);
  const ids = await readyItems('pf2', w.keyring, w.keyring);
  const p = (await request(c, { claimIds: ids })).json;
  assert.equal((await fees(p.id, { packaging: 2 })).status, 200);
  assert.deepEqual([(await summary(c)).owed.doms, (await summary(c)).owed.packaging], [0, 2], 'postage untouched');
  await fees(p.id, { doms: 3 });
  await fees(p.id, { packaging: 1.5 });                               // corrected down
  assert.equal((await summary(c)).owed.packaging, 1.5);
  await fees(p.id, { packaging: 0 });                                  // and set to nothing on purpose
  assert.deepEqual([(await summary(c)).owed.packaging, (await myParcels(c)).find((x) => x.id === p.id).packagingTotal], [0, 0], 'zero is a real answer, distinct from "not set"');
  assert.equal((await summary(c)).owed.doms, 3);
});

test('fee input is validated, and fees are only for parcels still in the queue', async () => {
  const c = await joinerSession(app, 'pf3@x.com', 'pf3');
  await addr(c);
  const [id] = await readyItems('pf3', w.keyring);
  const p = (await request(c, { claimIds: [id] })).json;
  assert.equal((await fees(p.id, {})).status, 400, 'nothing to set');
  assert.equal((await fees(p.id, { doms: -1 })).status, 400);
  assert.equal((await fees(p.id, { packaging: 1.234 })).status, 400, 'pennies only');
  assert.equal((await fees(p.id, { doms: 'a lot' })).status, 400);
  assert.equal((await fees(p.id, { doms: 1 }, c)).status, 403, 'joiners cannot set fees');
  assert.equal((await fees(999999, { doms: 1 })).status, 404);
  assert.equal((await app.q('SELECT packaging_total AS t FROM parcels WHERE id = ?', [p.id]))[0].t, null, 'nothing was saved by the failed attempts');
  await packIt(p.id);
  const late = await fees(p.id, { doms: 1, packaging: 1 });
  assert.equal(late.status, 409);
  assert.equal(late.json.code, 'bad_state');
});

test('a failed fee never leaves a half-saved parcel (both or neither)', async () => {
  const c = await joinerSession(app, 'pf4@x.com', 'pf4');
  await addr(c);
  const [id] = await readyItems('pf4', w.keyring);
  const p = (await request(c, { claimIds: [id] })).json;
  await app.q("UPDATE parcels SET status = 'packed' WHERE id = ?", [p.id]);          // so the request is refused
  assert.equal((await fees(p.id, { doms: 5, packaging: 2 })).status, 409);
  assert.deepEqual([await costOf([id], 'doms'), await costOf([id], 'packaging')], [[0], [0]]);
});

test('payments settle in order: item cost, EMS, customs, postage, THEN packaging', async () => {
  const c = await joinerSession(app, 'pf5@x.com', 'pf5');
  await addr(c);
  const [id] = await readyItems('pf5', w.keyring);                      // £6, unpaid
  await app.api('PATCH', `/api/admin/claims/${id}`, { costs: { ems: { cost: 2 } } }, admin);
  const p = (await request(c, { claimIds: [id] })).json;
  await fees(p.id, { doms: 3, packaging: 1 });
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 9, reference: 'ORDER' }, c);     // owes 6 + 2 + 3 + 1 = 12
  await app.api('POST', `/api/admin/payments/${pay.json.id}/verify`, {}, admin);
  const alloc = await app.q('SELECT category, amount FROM payment_allocations WHERE payment_id = ? ORDER BY id', [pay.json.id]);
  assert.deepEqual(alloc.map((a) => [a.category, Number(a.amount)]), [['initials', 6], ['ems', 2], ['doms', 1]]);
  const s = await summary(c);
  assert.deepEqual([s.owed.doms, s.owed.packaging, s.owed.total], [2, 1, 3]);
});

test('credit the joiner holds meets the new fee automatically', async () => {
  const c = await joinerSession(app, 'pf6@x.com', 'pf6');
  await addr(c);
  const [id] = await readyItems('pf6', w.keyring);
  await claimAndSecure(app, admin, 'pf6', w.album);
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 35, reference: 'X', overpay: { choice: 'credit' } }, c);   // owes 32 -> £3 credit
  await app.api('POST', `/api/admin/payments/${pay.json.id}/verify`, {}, admin);
  const p = (await request(c, { claimIds: [id] })).json;
  await fees(p.id, { packaging: 2 });
  const s = await summary(c);
  assert.deepEqual([s.owed.packaging, s.credit], [0, 1], '£2 of the £3 credit paid the packaging fee');
});

test('cancelling a parcel removes BOTH fees, and returns anything already paid as credit', async () => {
  const c = await joinerSession(app, 'pf7@x.com', 'pf7');
  await addr(c);
  const [id] = await readyItems('pf7', w.keyring);
  const p = (await request(c, { claimIds: [id] })).json;
  await fees(p.id, { doms: 3, packaging: 1.5 });
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 10.5, reference: 'ALL' }, c);   // 6 + 3 + 1.5
  await app.api('POST', `/api/admin/payments/${pay.json.id}/verify`, {}, admin);
  assert.equal((await summary(c)).owed.total, 0);
  await admin_(`/api/admin/parcels/${p.id}/cancel`);
  const s = await summary(c);
  assert.deepEqual([s.owed.doms, s.owed.packaging, s.credit], [0, 0, 4.5], 'both fees refunded as credit');
  assert.deepEqual([await costOf([id], 'doms'), await costOf([id], 'packaging')], [[0], [0]]);
  const cancelled = (await app.q('SELECT doms_total AS d, packaging_total AS p FROM parcels WHERE id = ?', [p.id]))[0];
  assert.deepEqual([cancelled.d, cancelled.p], [null, null]);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost'))[0].n, 0, 'nothing overpaid');
});

test('the packaging line can be edited by hand on a claim like the others', async () => {
  const c = await joinerSession(app, 'pf8@x.com', 'pf8');
  const [id] = await claimAndSecure(app, admin, 'pf8', w.keyring);
  assert.equal((await app.api('PATCH', `/api/admin/claims/${id}`, { costs: { packaging: { cost: 0.75 } } }, admin)).status, 200);
  assert.equal((await summary(c)).owed.packaging, 0.75);
  assert.equal((await app.api('PATCH', `/api/admin/claims/${id}`, { costs: { nonsense: { cost: 1 } } }, admin)).status, 200, 'unknown categories are ignored, not applied');
});


// ───────────── the packing checklist ─────────────
const tick = (id, body, cookie = admin) => app.api('POST', `/api/admin/parcels/${id}/items-packed`, body, cookie);
const check = (id, body, cookie = admin) => app.api('POST', `/api/admin/parcels/${id}/checks`, body, cookie);
const listed = async (id) => (await app.api('GET', '/api/admin/packing', undefined, admin)).json.parcels.find((x) => x.id === id);
async function checklistParcel(handle, name = 'Pat Kay', extra = {}, items = [w.keyring, w.keyring, w.album]) {
  const c = await joinerSession(app, `${handle}@x.com`, handle);
  await app.api('PUT', '/api/my/address', { fullName: name, address: '1 Test Road, Leeds', email: `${handle}@x.com`, phone: '0700' }, c);
  const ids = await readyItems(handle, ...items);
  return { c, ids, id: (await request(c, { claimIds: ids, ...extra })).json.id };
}

test('checklist: items start unticked, can be ticked and unticked one at a time or all at once, and it is saved', async () => {
  const { ids, id } = await checklistParcel('cl1', 'Cl One', { bias: 'Han' });
  let row = await listed(id);
  assert.deepEqual(row.items.map((i) => i.packed), [false, false, false]);
  assert.deepEqual([row.addressChecked, row.lomoChecked, row.biasChecked], [false, false, false]);
  let r = await tick(id, { packed: true, claimIds: [ids[0]] });
  assert.deepEqual([r.status, r.json.ticked, r.json.total], [200, 1, 3]);
  assert.deepEqual((await listed(id)).items.map((i) => i.packed), [true, false, false], 'saved on the server, not just on screen');
  await tick(id, { packed: true, claimIds: [ids[1], ids[2]] });
  assert.equal((await tick(id, { packed: false, claimIds: [ids[1]] })).json.ticked, 2);
  assert.equal((await tick(id, { packed: true })).json.ticked, 3, 'no claimIds means every item');
  assert.equal((await tick(id, { packed: false })).json.ticked, 0);
  await check(id, { address: true }); await check(id, { lomo: true, bias: true });
  row = await listed(id);
  assert.deepEqual([row.addressChecked, row.lomoChecked, row.biasChecked], [true, true, true]);
  await check(id, { lomo: false });
  assert.equal((await listed(id)).lomoChecked, false, 'a check can be taken back');
});

test('checklist: a parcel cannot be marked packed until every applicable box is ticked — and the refusal says exactly what is missing', async () => {
  const { id } = await checklistParcel('cl2', 'Cl Two', { bias: 'Felix', lomoName: 'Fee' });
  let r = await admin_(`/api/admin/parcels/${id}/packed`);
  assert.equal(r.status, 409); assert.equal(r.json.code, 'checklist_incomplete');
  assert.equal(r.json.error, 'Not everything is ticked off yet: 3 items, the delivery address, the Lomo name, the bias name.');
  await tick(id, { packed: true });
  assert.equal((await admin_(`/api/admin/parcels/${id}/packed`)).json.error, 'Not everything is ticked off yet: the delivery address, the Lomo name, the bias name.');
  await check(id, { address: true });
  assert.equal((await admin_(`/api/admin/parcels/${id}/packed`)).json.error, 'Not everything is ticked off yet: the Lomo name, the bias name.');
  await check(id, { lomo: true });
  assert.equal((await admin_(`/api/admin/parcels/${id}/packed`)).json.error, 'Not everything is ticked off yet: the bias name.');
  await tick(id, { packed: false, claimIds: [(await listed(id)).items[0].claimId] });
  assert.match((await admin_(`/api/admin/parcels/${id}/packed`)).json.error, /1 item, the bias name/, 'unticking an item blocks it again');
  assert.equal((await listed(id)).status, 'requested', 'nothing moved');
  await tick(id, { packed: true }); await check(id, { bias: true });
  assert.equal((await admin_(`/api/admin/parcels/${id}/packed`)).status, 200);
  assert.deepEqual((await claimsOfHandle('cl2')).map((c) => c.pipeline), ['packed', 'packed', 'packed']);
});

test('checklist: no bias given means no bias box to tick; the address is always required', async () => {
  const { id } = await checklistParcel('cl3', 'Cl Three');                       // no bias; the Lomo name defaults to the delivery name
  await tick(id, { packed: true });
  assert.match((await admin_(`/api/admin/parcels/${id}/packed`)).json.error, /the delivery address, the Lomo name\./);
  await check(id, { address: true, lomo: true });
  assert.equal((await admin_(`/api/admin/parcels/${id}/packed`)).status, 200, 'the bias was never asked for, so it is not required');
});

test('checklist: only for parcels still in the queue, only for items that are in the parcel, validated, admin-only', async () => {
  const { c, ids, id } = await checklistParcel('cl4');
  const other = await checklistParcel('cl4b');
  assert.equal((await tick(id, { packed: true, claimIds: [other.ids[0]] })).status, 404, 'an item from another parcel is refused');
  assert.equal((await tick(id, { packed: 'yes' })).status, 400);
  assert.equal((await tick(id, {})).status, 400);
  assert.equal((await check(id, {})).status, 400);
  assert.equal((await check(id, { address: 'yes' })).status, 400);
  assert.equal((await tick(id, { packed: true }, c)).status, 403);
  assert.equal((await check(id, { address: true }, c)).status, 403);
  assert.equal((await tick(999999, { packed: true })).status, 404);
  assert.equal((await check(999999, { address: true })).status, 404);
  await packIt(id);
  const late = await tick(id, { packed: false });
  assert.equal(late.status, 409); assert.equal(late.json.code, 'bad_state');
  assert.equal((await check(id, { address: false })).status, 409);
  const packed = (await app.api('GET', '/api/admin/packing?status=packed', undefined, admin)).json.parcels.find((x) => x.id === id);
  assert.deepEqual(packed.items.map((i) => i.packed), ids.map(() => true), 'the ticks stay as they were once it is packed');
  assert.deepEqual([packed.addressChecked, packed.lomoChecked], [true, true]);
});

test('checklist: ticks belong to one parcel — a cancelled and re-requested parcel starts with a clean list', async () => {
  const { c, ids, id } = await checklistParcel('cl5', 'Cl Five', {}, [w.keyring]);
  await tick(id, { packed: true }); await check(id, { address: true, lomo: true });
  await admin_(`/api/admin/parcels/${id}/cancel`);
  const again = (await request(c, { claimIds: ids })).json;
  const row = await listed(again.id);
  assert.deepEqual([row.items[0].packed, row.addressChecked, row.lomoChecked], [false, false, false]);
});

const claimsOfHandle = async (h) => (await app.api('GET', `/api/admin/claims?handle=${h}`, undefined, admin)).json.claims;
