import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';

// TAKING ONE ITEM OUT of an incoming box ("it wasn't actually in the box") or of a requested shipping list ("it wasn't actually on hand").
let app, admin, w, N = 0, ITEM;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const add = (body) => app.api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', ...body }, admin).then((r) => r.json.id);
  ITEM = { card: await add({ title: 'Photocard', price: 4, sizeBucket: 'XS' }), album: await add({ title: 'Album', price: 20, sizeBucket: 'M' }), hoodie: await add({ title: 'Hoodie', price: 50, sizeBucket: 'L' }) };
});
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const fresh = (p = 'rm') => `${p}${++N}`;
const ARRIVED = 'arrived at proxy / warehouse', READY = 'ready to pack / on hand';
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const claimRow = async (id) => (await app.q('SELECT pipeline, box_id AS boxId, ready_to_pack_date AS ready FROM claims WHERE id = ?', [id]))[0];
const cost = async (id, cat) => Number((await app.q('SELECT cost FROM claim_costs WHERE claim_id = ? AND category = ?', [id, cat]))[0]?.cost || 0);
const credit = async (h) => Number((await app.q('SELECT COALESCE(SUM(l.balance_effect), 0) AS c FROM credit_ledger l JOIN joiners j ON j.id = l.joiner_id WHERE j.instagram_handle = ?', [h]))[0].c);
async function arrived(handle, item = ITEM.album, weight) { const [id] = await claimAndSecure(app, admin, handle, item); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: ARRIVED, ...(weight ? { weightG: weight } : {}) }); return id; }
const mkBox = async (claimIds, extra = {}) => { const r = await api('POST', '/api/admin/boxes', { claimIds, emsTotal: 12, ...extra }); assert.equal(r.status, 201, r.text); return r.json.id; };
const rmBox = (box, claimId, extra = {}) => api('POST', `/api/admin/boxes/${box}/remove-item`, { claimId, ...extra });
const boxItems = async (box) => (await app.q('SELECT claim_id AS id, ems_share AS ems, customs_share AS customs FROM box_items WHERE box_id = ? ORDER BY claim_id', [box])).map((r) => ({ id: r.id, ems: Number(r.ems), customs: Number(r.customs) }));

test('BOX: an item that wasn\'t in the box comes out; its EMS comes off and the box\'s total is shared out again among the rest; it goes back to "arrived at the proxy"; the box keeps its totals', async () => {
  const [ha, hb, hc] = [fresh(), fresh(), fresh()]; const a = await arrived(ha, ITEM.album, 100), b = await arrived(hb, ITEM.album, 200), c = await arrived(hc, ITEM.album, 300); const box = await mkBox([a, b, c]);
  assert.deepEqual((await boxItems(box)).map((x) => x.ems), [2, 4, 6], 'shared by weight before'); const r = await rmBox(box, b); assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.label.length > 0, r.json.handle, r.json.stage, r.json.boxRemoved, r.json.left], [true, hb, ARRIVED, false, 2]);
  assert.deepEqual((await boxItems(box)).map((x) => [x.id, x.ems]), [[a, 3], [c, 9]], '12 shared 100:300 between the two left'); assert.deepEqual([await cost(a, 'ems'), await cost(b, 'ems'), await cost(c, 'ems')], [3, 0, 9]);
  const back = await claimRow(b); assert.deepEqual([back.pipeline, back.boxId, back.ready], [ARRIVED, null, null]); assert.equal((await api('GET', '/api/admin/boxes')).json.boxes.find((x) => x.id === box).emsTotal, 12, 'the box still has its 12 total');
  assert.deepEqual(r.json.changes.map((x) => [x.handle, x.feeChange]).sort(), [[ha, 1], [hb, -4], [hc, 3]].sort(), 'who it changed, and by how much'); assert.ok((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'box.remove_item'"))[0].n >= 1);
});

test('BOX: what the person had already paid beyond their new figure comes back as credit', async () => {
  const [ha, hb] = [fresh(), fresh()]; const a = await arrived(ha, ITEM.album, 100), b = await arrived(hb, ITEM.album, 100); const box = await mkBox([a, b], { emsTotal: 10 }); await api('PATCH', `/api/admin/claims/${b}`, { costs: { initials: { paid: 20 }, ems: { paid: 5 } } });          // b owes nothing else, so the credit stays as credit
  const before = await credit(hb); const r = await rmBox(box, b); assert.equal(r.status, 200, r.text); assert.equal(await cost(b, 'ems'), 0); assert.equal(Number(((await credit(hb)) - before).toFixed(2)), 5, 'their £5 EMS payment is credit now'); assert.equal(r.json.changes.find((x) => x.handle === hb).creditBack, 5);
});

test('BOX: customs are shared out again by price among what is left (and sum back to the total); someone ticked "no EMS" stays out of the EMS', async () => {
  const [ha, hb, hc] = [fresh(), fresh(), fresh()]; const a = await arrived(ha, ITEM.album, 100), b = await arrived(hb, ITEM.hoodie, 100), c = await arrived(hc, ITEM.card, 100); const box = await mkBox([a, b, c], { emsTotal: 9, customsTotal: 12, exclusions: [{ claimId: c, noEms: true }] });
  assert.equal((await boxItems(box)).find((x) => x.id === c).ems, 0, 'c pays no EMS'); const r = await rmBox(box, b); assert.equal(r.status, 200, r.text); const left = await boxItems(box);
  assert.deepEqual(left.map((x) => [x.id, x.ems]), [[a, 9], [c, 0]], 'all 9 on the one who can carry it; c stays out'); assert.deepEqual(left.map((x) => x.customs), [10, 2], '12 shared 20 : 4 by price'); assert.deepEqual([await cost(a, 'customs'), await cost(c, 'customs'), await cost(b, 'customs'), await cost(b, 'ems')], [10, 2, 0, 0]);
});

test('BOX: it works after the box has arrived, and the items that stay keep their stage; the last item takes the box with it; you choose the stage it goes back to', async () => {
  const [ha, hb] = [fresh(), fresh()]; const a = await arrived(ha), b = await arrived(hb); const box = await mkBox([a, b]); assert.equal((await api('POST', `/api/admin/boxes/${box}/enroute`, {})).status, 200); assert.equal((await api('POST', `/api/admin/boxes/${box}/arrived`, {})).status, 200);
  await app.q('UPDATE claims SET pipeline = ?, ready_to_pack_date = CURDATE() WHERE id = ?', [READY, b]);          // it had been ticked "ready to pack" after the box arrived — its storage clock is running
  assert.equal((await rmBox(box, b, { stage: 'ordered via proxy / warehouse' })).status, 200, 'out of an arrived box'); assert.equal((await claimRow(b)).ready, null, 'and its storage clock stops (it was never really on hand)'); assert.equal((await claimRow(b)).pipeline, 'ordered via proxy / warehouse'); assert.equal((await claimRow(a)).pipeline, 'arrived at GOM', 'the one that stayed is untouched');
  const last = await rmBox(box, a); assert.deepEqual([last.status, last.json.boxRemoved, last.json.left], [200, true, 0]); assert.equal((await api('GET', '/api/admin/boxes')).json.boxes.some((x) => x.id === box), false, 'the empty box is gone'); assert.deepEqual([(await claimRow(a)).pipeline, (await claimRow(a)).boxId], [ARRIVED, null]);
  assert.equal((await cost(a, 'ems')) + (await cost(b, 'ems')), 0);
});

test('BOX: refusals change nothing — not in this box, in a shipping request already, a stage that isn\'t one of the earlier ones, an unknown box, not the GOM', async () => {
  const [ha, hb, hc] = [fresh(), fresh(), fresh()]; const a = await arrived(ha), b = await arrived(hb), c = await arrived(hc); const box = await mkBox([a, b]), other = await mkBox([c]);
  const same = async (label) => assert.deepEqual((await boxItems(box)).map((x) => [x.id, x.ems]), [[a, 6], [b, 6]], `${label}: nothing changed`);
  assert.equal((await rmBox(box, c)).status, 404, 'not in this box'); await same('not in box'); assert.equal((await rmBox(999999, a)).status, 404); const bad = await rmBox(box, a, { stage: 'shipped' }); assert.deepEqual([bad.status, bad.json.code], [400, 'bad_stage']); await same('bad stage'); assert.equal((await rmBox(box, a, { stage: READY })).status, 400, 'ready to pack isn\'t an earlier stage');
  const j = await joinerSession(app, `${fresh('jj')}@x.com`, fresh('jj')); assert.equal((await api('POST', `/api/admin/boxes/${box}/remove-item`, { claimId: a }, j)).status, 403); assert.equal((await app.api('POST', `/api/admin/boxes/${box}/remove-item`, { claimId: a })).status, 401);
  await app.q('INSERT INTO parcels (joiner_id, method, status, requested_at) SELECT joiner_id, ?, ?, NOW(3) FROM claims WHERE id = ?', ['UK Royal Mail Tracked 48', 'requested', a]); const pid = (await app.q('SELECT MAX(id) AS id FROM parcels'))[0].id; await app.q('INSERT INTO parcel_items (parcel_id, claim_id) VALUES (?, ?)', [pid, a]);
  const inReq = await rmBox(box, a); assert.deepEqual([inReq.status, inReq.json.code], [409, 'in_parcel']); assert.match(inReq.json.error, /already in shipping request #\d+ — take it out of the request first/); await same('in a request'); void other;
});

test('BOX: the preview says exactly what will happen and changes nothing', async () => {
  const [ha, hb, hc] = [fresh(), fresh(), fresh()]; const a = await arrived(ha, ITEM.album, 100), b = await arrived(hb, ITEM.album, 200), c = await arrived(hc, ITEM.album, 300); const box = await mkBox([a, b, c]); const before = await boxItems(box);
  const pv = await rmBox(box, b, { preview: true, stage: 'ordered via proxy / warehouse' }); assert.equal(pv.status, 200, pv.text); assert.equal(pv.json.preview, true); assert.deepEqual(await boxItems(box), before, 'nothing changed'); assert.equal((await claimRow(b)).boxId, box); assert.equal(await cost(b, 'ems'), 4);
  const real = await rmBox(box, b, { stage: 'ordered via proxy / warehouse' }); const { preview, ok, ...rest } = { ...pv.json, ...{ ok: undefined } }; void ok; void preview; const { ok: ok2, ...realRest } = real.json; void ok2; assert.deepEqual(realRest, rest, 'the real result is what the preview said');
});

// ───────── requested shipping lists ─────────
const person = async (h = fresh('pp')) => { const cookie = await joinerSession(app, `${h}@x.com`, h); await api('PUT', '/api/my/address', { fullName: 'Rm Person', address: '12 Test Street, Leeds, LS1 1AA', email: `${h}@x.com`, phone: '07700 900123' }, cookie); return { h, cookie }; };
async function ready(p, item = ITEM.album) { const [id] = await claimAndSecure(app, admin, p.h, item); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); return id; }
const request = async (p, claimIds) => { const r = await api('POST', `/api/my/parcels?handle=${p.h}`, { claimIds, method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p.cookie); assert.equal(r.status, 201, r.text); return r.json.id; };
const setFees = async (parcel, doms, packaging) => assert.equal((await api('POST', `/api/admin/parcels/${parcel}/fees`, { doms, packaging, dueDate: day(9) })).status, 200);
const rmParcel = (parcel, claimId, extra = {}) => api('POST', `/api/admin/parcels/${parcel}/remove-item`, { claimId, ...extra });
const pItems = async (parcel) => (await app.q('SELECT claim_id AS id, doms_share AS doms, packaging_share AS pack FROM parcel_items WHERE parcel_id = ? ORDER BY claim_id', [parcel])).map((r) => ({ id: r.id, doms: Number(r.doms), pack: Number(r.pack) }));
const parcelRow = async (id) => (await app.q('SELECT status, doms_total AS doms, packaging_total AS pack, fees_check_needed AS chk FROM parcels WHERE id = ?', [id]))[0];

test('REQUEST: an item marked on hand by mistake comes out of the request and back to the stage you choose (its storage clock gone); postage and packaging are shared out again across what is left, and the parcel is flagged for a look', async () => {
  const p = await person(); const [x, y, z] = [await ready(p), await ready(p), await ready(p)]; const parcel = await request(p, [x, y, z]); await setFees(parcel, 9, 3); assert.deepEqual((await pItems(parcel)).map((i) => [i.doms, i.pack]), [[3, 1], [3, 1], [3, 1]]);
  const r = await rmParcel(parcel, y, { stage: ARRIVED }); assert.equal(r.status, 200, r.text); assert.deepEqual([r.json.handle, r.json.stage, r.json.parcelRemoved, r.json.companionRemoved, r.json.left], [p.h, ARRIVED, false, null, 2]);
  assert.deepEqual((await pItems(parcel)).map((i) => [i.id, i.doms, i.pack]), [[x, 4.5, 1.5], [z, 4.5, 1.5]], 'the same totals, shared across the two left'); assert.deepEqual([await cost(y, 'doms'), await cost(y, 'packaging')], [0, 0]); const back = await claimRow(y); assert.deepEqual([back.pipeline, back.ready], [ARRIVED, null]);
  const pr = await parcelRow(parcel); assert.deepEqual([Number(pr.doms), Number(pr.pack), !!pr.chk], [9, 3, true], 'totals unchanged; flagged for the GOM to check the postage'); assert.deepEqual(r.json.changes, [], 'it is all one person\'s own parcel, so nobody\'s total moved');
  assert.ok((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'parcel.remove_item'"))[0].n >= 1);
});

test('REQUEST: "keep it ready to pack" takes it out of the request but leaves it on hand (and its storage clock); without postage set nothing is re-shared', async () => {
  const p = await person(); const [x, y] = [await ready(p), await ready(p)]; const parcel = await request(p, [x, y]); const was = (await claimRow(y)).ready;
  const r = await rmParcel(parcel, y, { stage: READY }); assert.equal(r.status, 200, r.text); const back = await claimRow(y); assert.equal(back.pipeline, READY); assert.equal(String(back.ready), String(was), 'the storage clock is unchanged'); assert.deepEqual((await pItems(parcel)).map((i) => i.id), [x]); assert.equal(!!(await parcelRow(parcel)).chk, false, 'no postage was set, so nothing to check');
});

test('REQUEST: a friend\'s last item takes the friend out of the parcel and the postage is shared between whoever is left (their payment comes back as credit); you can\'t take out the owner\'s last item while friends share it', async () => {
  const owner = await person(), friend = await person(); const [o1, o2, f1] = [await ready(owner), await ready(owner), await ready(friend)]; const parcel = await request(owner, [o1, o2]);
  assert.equal((await api('POST', `/api/my/parcels/${parcel}/companion/invite`, { handles: friend.h }, owner.cookie)).status, 201); assert.equal((await api('POST', `/api/my/parcels/${parcel}/companion/accept`, { claimIds: [f1] }, friend.cookie)).status, 200); await setFees(parcel, 10, 0);
  assert.deepEqual([(await pItems(parcel)).reduce((s, i) => s + i.doms, 0), await cost(f1, 'doms')], [10, 5], 'UK postage: equal per person'); await api('PATCH', `/api/admin/claims/${f1}`, { costs: { initials: { paid: 20 }, doms: { paid: 5 } } });          // the friend owes nothing else, so the credit stays as credit
  const refuse = await rmParcel(parcel, o1); assert.equal(refuse.status, 200, 'the owner still has another item, so one can go'); const o2only = await rmParcel(parcel, o2); assert.deepEqual([o2only.status, o2only.json.code], [409, 'owner_last_item']);
  const before = await credit(friend.h); const r = await rmParcel(parcel, f1, { stage: ARRIVED }); assert.equal(r.status, 200, r.text); assert.equal(r.json.companionRemoved, friend.h); assert.equal((await app.q('SELECT COUNT(*) AS n FROM parcel_companions WHERE parcel_id = ?', [parcel]))[0].n, 0, 'the friend is out of the parcel');
  assert.equal(Number(((await credit(friend.h)) - before).toFixed(2)), 5, 'their £5 postage payment is credit'); assert.deepEqual((await pItems(parcel)).map((i) => [i.id, i.doms]), [[o2, 10]], 'all of it on the one person left'); assert.equal(r.json.changes.find((x) => x.handle === friend.h).creditBack, 5);
});

test('REQUEST: the only item takes the whole request with it (and its postage comes off); a packed request can\'t be touched; an item recorded as being in a box can\'t go back to before the box; refusals change nothing', async () => {
  const p = await person(); const x = await ready(p); const parcel = await request(p, [x]); await setFees(parcel, 6, 2); const solo = await rmParcel(parcel, x, { stage: 'ordered via proxy / warehouse' }); assert.deepEqual([solo.status, solo.json.parcelRemoved, solo.json.left], [200, true, 0]);
  assert.equal((await api('GET', '/api/admin/packing?status=requested')).json.parcels.some((q) => q.id === parcel), false, 'the request is gone'); assert.deepEqual([await cost(x, 'doms'), await cost(x, 'packaging'), (await claimRow(x)).pipeline], [0, 0, 'ordered via proxy / warehouse']);
  const q = await person(); const [a, b] = [await ready(q), await ready(q)]; const pk = await request(q, [a, b]); await app.q("UPDATE parcels SET status = 'packed' WHERE id = ?", [pk]); const late = await rmParcel(pk, a); assert.deepEqual([late.status, late.json.code], [409, 'too_late']);
  const r = await person(); const [c, d] = [await ready(r), await ready(r)]; const pr = await request(r, [c, d]); const other = await arrived(fresh()); const box = await mkBox([other]); await app.q('UPDATE claims SET box_id = ? WHERE id = ?', [box, c]);
  const inBox = await rmParcel(pr, c, { stage: ARRIVED }); assert.deepEqual([inBox.status, inBox.json.code], [409, 'in_box']); assert.equal((await rmParcel(pr, c, { stage: 'arrived at GOM' })).status, 200, 'a stage the box allows is fine'); assert.deepEqual((await pItems(pr)).map((i) => i.id), [d]);
  assert.equal((await rmParcel(pr, 999999)).status, 404, 'not in this request'); assert.equal((await rmParcel(999999, d)).status, 404); assert.deepEqual([(await rmParcel(pr, d, { stage: 'shipped' })).status], [400]);
  const j = await joinerSession(app, `${fresh('jj')}@x.com`, fresh('jj')); assert.equal((await api('POST', `/api/admin/parcels/${pr}/remove-item`, { claimId: d }, j)).status, 403); assert.equal((await app.api('POST', `/api/admin/parcels/${pr}/remove-item`, { claimId: d })).status, 401);
});

test('REQUEST: the preview says exactly what will happen (including whose postage changes) and changes nothing', async () => {
  const owner = await person(), friend = await person(); const [o1, o2, f1] = [await ready(owner), await ready(owner), await ready(friend)]; const parcel = await request(owner, [o1, o2]);
  await api('POST', `/api/my/parcels/${parcel}/companion/invite`, { handles: friend.h }, owner.cookie); await api('POST', `/api/my/parcels/${parcel}/companion/accept`, { claimIds: [f1] }, friend.cookie); await setFees(parcel, 10, 0); const before = await pItems(parcel);
  const pv = await rmParcel(parcel, f1, { preview: true, stage: ARRIVED }); assert.equal(pv.status, 200, pv.text); assert.deepEqual(await pItems(parcel), before, 'nothing changed'); assert.equal((await claimRow(f1)).pipeline, READY); assert.equal(await cost(f1, 'doms'), 5);
  assert.deepEqual(pv.json.changes.map((x) => [x.handle, x.feeChange]).sort(), [[friend.h, -5], [owner.h, 5]].sort(), 'the friend\'s £5 comes off and the owner carries all of it now'); const real = await rmParcel(parcel, f1, { stage: ARRIVED }); const { ok, ...realRest } = real.json; const { preview, ...pvRest } = pv.json; void ok; void preview; assert.deepEqual(realRest, pvRest);
});
