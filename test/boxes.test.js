import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';
import { resolveBoxWeights, boxSplit, SIZE_WEIGHTS } from '../src/lib/box.js';
import { round2 } from '../src/lib/money.js';

// ───────── the split rules on their own ─────────
const it = (id, weight, size = 'M', price = 10) => ({ id, weight, size, price });
const sum = (xs) => round2(xs.reduce((a, b) => a + b, 0));

test('weights: size estimates are the documented midpoints', () => {
  assert.deepEqual(SIZE_WEIGHTS, { XS: 25, S: 75, M: 175, L: 375, XL: 750 });
});
test('weights: exact weights are used as they are; with no box weight, unweighed items fall back to their size', () => {
  const r = resolveBoxWeights([it(1, 200), it(2, null, 'S'), it(3, null, 'XL')], 0);
  assert.deepEqual(r.weights, { 1: 200, 2: 75, 3: 750 });
  assert.equal(r.note, 'No box weight entered — using size estimates for items without an exact weight.');
});
test('weights: with the box weight, unweighed items share what is LEFT, in proportion to their size', () => {
  const r = resolveBoxWeights([it(1, 400), it(2, null, 'M'), it(3, null, 'L')], 1000);
  assert.equal(r.weights[1], 400);
  assert.ok(Math.abs(r.weights[2] - 600 * 175 / 550) < 1e-9 && Math.abs(r.weights[3] - 600 * 375 / 550) < 1e-9);
  assert.ok(Math.abs(r.weights[2] + r.weights[3] - 600) < 1e-9, 'together they make up the remaining 600g');
  assert.equal(r.note, 'Box weighs 1000g; 400g comes from items with exact weights, so the other 600g is shared across 2 items by size.');
});
test('weights: nobody weighed + a box weight = the whole box shared by size', () => {
  const r = resolveBoxWeights([it(1, null, 'M'), it(2, null, 'M')], 700);
  assert.deepEqual(r.weights, { 1: 350, 2: 350 });
  assert.match(r.note, /^Box weighs 700g — the other 700g is shared across 2 items by size\.$/);
});
test('weights: exact weights that already exceed the box weight are flagged and the rest fall back to size', () => {
  const r = resolveBoxWeights([it(1, 900), it(2, null, 'S')], 500);
  assert.equal(r.weights[2], 75);
  assert.match(r.note, /^⚠ Items with exact weights already add up to 900g, more than the 500g box/);
});
test('weights: everything weighed but the totals disagree gives a heads-up (within 1g is fine)', () => {
  assert.match(resolveBoxWeights([it(1, 300), it(2, 300)], 700).note, /^Heads up: item weights add up to 600g but the box weighs 700g\.$/);
  assert.equal(resolveBoxWeights([it(1, 300), it(2, 300)], 601).note, '');
  assert.equal(resolveBoxWeights([it(1, 300)], 0).note, '');
});

test('split: EMS follows weight and customs follows value, each to the penny', () => {
  const s = boxSplit([it(1, 100, 'M', 30), it(2, 300, 'M', 10)], { emsTotal: 8, customsTotal: 4 });
  assert.deepEqual(s.emsShares, [2, 6], '100g : 300g = 2 : 6');
  assert.deepEqual(s.customsShares, [3, 1], '30:10 value = 3:1');
});
test('split: awkward totals still add back exactly (no pennies lost or invented)', () => {
  const s = boxSplit([it(1, 100), it(2, 100), it(3, 100)], { emsTotal: 10, customsTotal: 0.01 });
  assert.equal(sum(s.emsShares), 10); assert.deepEqual(s.emsShares.slice().sort(), [3.33, 3.33, 3.34]);
  assert.equal(sum(s.customsShares), 0.01);
});
test('split: if every item is free, customs is shared equally rather than lost', () => {
  const s = boxSplit([it(1, 100, 'M', 0), it(2, 100, 'M', 0)], { emsTotal: 2, customsTotal: 5 });
  assert.deepEqual(s.customsShares, [2.5, 2.5]);
  assert.deepEqual(boxSplit([it(1, 100, 'M', 0)], { emsTotal: 1, customsTotal: 0 }).customsShares, [0]);
});
test('split: a free item (price £0, e.g. a raffle prize) pays no customs but still pays its share of the EMS', () => {
  const s = boxSplit([it(1, 100, 'M', 10), it(2, 100, 'M', 0)], { emsTotal: 4, customsTotal: 6 });
  assert.deepEqual(s.customsShares, [6, 0]); assert.deepEqual(s.emsShares, [2, 2]);
});
test('split: for hundreds of random boxes the shares always add up exactly, are never negative, and heavier never pays less than lighter', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < 300; n++) {
    const k = 1 + Math.floor(rnd() * 9);
    const items = Array.from({ length: k }, (_, i) => it(i, rnd() < 0.5 ? 20 + Math.floor(rnd() * 800) : null, ['XS', 'S', 'M', 'L', 'XL'][Math.floor(rnd() * 5)], Math.round(rnd() * 60 * 100) / 100));
    const ems = Math.round(rnd() * 90 * 100) / 100, customs = rnd() < 0.5 ? Math.round(rnd() * 40 * 100) / 100 : 0, box = rnd() < 0.5 ? Math.floor(rnd() * 4000) : 0;
    const s = boxSplit(items, { emsTotal: ems, customsTotal: customs, boxTotal: box });
    assert.equal(sum(s.emsShares), ems, `EMS ${ems} over ${k}`); assert.equal(sum(s.customsShares), customs, `customs ${customs} over ${k}`);
    assert.ok([...s.emsShares, ...s.customsShares].every((x) => x >= 0));
    for (const a of items) for (const b of items) if (s.weights[a.id] > s.weights[b.id] + 1e-9) assert.ok(s.emsShares[a.id] >= s.emsShares[b.id] - 0.011, 'a heavier item never pays (more than a penny) less');
  }
});

// ───────── boxes against the real database ─────────
let app, admin, w, N = 0, ITEM;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const add = (body) => app.api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', ...body }, admin).then((r) => r.json.id);
  ITEM = { card: await add({ title: 'Photocard', price: 4, sizeBucket: 'XS' }), album: await add({ title: 'Album', price: 20, sizeBucket: 'M' }), hoodie: await add({ title: 'Hoodie', price: 50, sizeBucket: 'L' }) };
});
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const fresh = (p = 'bx') => `${p}${++N}`;
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const claim1 = async (h) => (await claimsOf(h))[0];
async function arrived(handle, item = ITEM.album, { weight, size } = {}) {
  const [id] = await claimAndSecure(app, admin, handle, item);
  await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'arrived at proxy / warehouse', ...(weight ? { weightG: weight } : {}), ...(size ? { sizeBucket: size } : {}) });
  return id;
}
const mkBox = (claimIds, extra = {}) => api('POST', '/api/admin/boxes', { claimIds, emsTotal: 10, ...extra });
const boxes = async (q = '') => (await api('GET', `/api/admin/boxes${q ? `?q=${encodeURIComponent(q)}` : ''}`)).json.boxes;
const boxOf = async (id) => (await boxes()).find((b) => b.id === id);

test('candidates: only confirmed items that have arrived at the proxy and are not already in a box', async () => {
  const ok = fresh(), notArrived = fresh(), req = fresh(), boxed = fresh();
  const a = await arrived(ok);
  await claimAndSecure(app, admin, notArrived, ITEM.album);                                              // still "awaiting fulfillment"
  await api('POST', '/api/claims', { handle: req, lines: [{ itemId: ITEM.album }] }, undefined);           // never secured
  const b = await arrived(boxed); await mkBox([b]);
  const c = (await api('GET', '/api/admin/boxes/candidates')).json.candidates;
  const mine = c.filter((x) => [ok, notArrived, req, boxed].includes(x.handle));
  assert.deepEqual(mine.map((x) => x.handle), [ok]);
  assert.deepEqual([mine[0].claimId, mine[0].price, mine[0].size, mine[0].weightG], [a, 20, 'M', null]);
});

test('exact weights and sizes can be recorded on an item; nonsense is refused and null clears a weight', async () => {
  const id = await arrived(fresh());
  const patch = (b) => api('PATCH', `/api/admin/claims/${id}`, b);
  assert.equal((await patch({ weightG: 480, sizeBucket: 'L' })).status, 200);
  let c = (await api('GET', '/api/admin/boxes/candidates')).json.candidates.find((x) => x.claimId === id);
  assert.deepEqual([c.weightG, c.size], [480, 'L']);
  for (const bad of [0, -5, 1.5, 100001, 'heavy']) assert.equal((await patch({ weightG: bad })).status, 400, String(bad));
  await patch({ weightG: null });
  c = (await api('GET', '/api/admin/boxes/candidates')).json.candidates.find((x) => x.claimId === id);
  assert.equal(c.weightG, null);
});

test('preview shows exactly what creating the box will do', async () => {
  const [a, b, c] = [await arrived(fresh(), ITEM.album, { weight: 200 }), await arrived(fresh(), ITEM.card, { size: 'XS' }), await arrived(fresh(), ITEM.hoodie, { size: 'L' })];
  const body = { claimIds: [c, a, b], emsTotal: 13.37, customsTotal: 7.77, totalWeightG: 1000 };
  const pre = (await api('POST', '/api/admin/boxes/preview', body)).json;
  assert.equal(pre.rows.length, 3);
  assert.match(pre.note, /Box weighs 1000g; 200g comes from items with exact weights, so the other 800g is shared across 2 items by size\./);
  assert.equal(sum(pre.rows.map((r) => r.emsShare)), 13.37); assert.equal(sum(pre.rows.map((r) => r.customsShare)), 7.77);
  assert.deepEqual(pre.rows.map((r) => r.estimated), [false, true, true], 'rows come in item order; only the unweighed are estimates');
  const made = await api('POST', '/api/admin/boxes', body);
  const box = await boxOf(made.json.id);
  assert.deepEqual(box.items.map((i) => [i.claimId, i.emsShare, i.customsShare, i.weightUsedG]), pre.rows.map((r) => [r.claimId, r.emsShare, r.customsShare, r.weightUsedG]));
});

test('creating a box: EMS and customs land on each item, the items move to "shipping requested", and what is owed goes up', async () => {
  const [h1, h2] = [fresh(), fresh()];
  const a = await arrived(h1, ITEM.album, { weight: 100 }), b = await arrived(h2, ITEM.hoodie, { weight: 300 });
  const r = await mkBox([a, b], { emsTotal: 8, customsTotal: 7, trackingId: ' EE123456789GB ' });
  assert.equal(r.status, 201);
  const [c1, c2] = [await claim1(h1), await claim1(h2)];
  assert.deepEqual([c1.costs.ems.cost, c2.costs.ems.cost], [2, 6], '100g : 300g');
  assert.deepEqual([c1.costs.customs.cost, c2.costs.customs.cost], [2, 5], '£20 : £50 of goods, 7 split 2:5');
  assert.deepEqual([c1.pipeline, c2.pipeline], ['shipping requested', 'shipping requested']);
  const box = await boxOf(r.json.id);
  assert.deepEqual([box.status, box.emsTotal, box.customsTotal, box.trackingId, box.archived], ['shipping_requested', 8, 7, 'EE123456789GB', false]);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE box_id = ?', [r.json.id]))[0].n, 2);
});

test('credit the joiner already holds meets the new postage automatically', async () => {
  const h = fresh('cr'); const c = await joinerSession(app, `${h}@x.com`, h);
  const id = await arrived(h, ITEM.album);
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 26, reference: 'CR', overpay: { choice: 'credit' } }, c);   // owes 20, pays 26 -> £6 credit
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  await mkBox([id], { emsTotal: 4 });
  const s = (await app.api('GET', '/api/my/summary', undefined, c)).json;
  assert.deepEqual([s.owed.total, s.credit], [0, 2], '£4 EMS paid from the £6 credit; £2 left');
});

test('creating a box needs an EMS total and real, eligible items — and a bad one means NOTHING changes', async () => {
  const good = await arrived(fresh()), notYet = (await claimAndSecure(app, admin, fresh(), ITEM.album))[0], boxed = await arrived(fresh());
  await mkBox([boxed]);
  assert.equal((await mkBox([good], { emsTotal: 0 })).json.code, 'ems_required');
  assert.equal((await api('POST', '/api/admin/boxes', { claimIds: [good] })).status, 400, 'EMS total is required');
  assert.equal((await api('POST', '/api/admin/boxes', { claimIds: [], emsTotal: 5 })).status, 400);
  assert.equal((await mkBox([good, 999999])).status, 404);
  const mixed = await mkBox([good, notYet]);
  assert.equal(mixed.status, 409); assert.equal(mixed.json.code, 'not_boxable');
  assert.equal((await mkBox([good, boxed])).json.code, 'not_boxable', 'already in a box');
  const g = (await api('GET', `/api/admin/claims`)).json.claims.find((c) => c.id === good);
  assert.deepEqual([g.pipeline, g.costs.ems.cost], ['arrived at proxy / warehouse', 0], 'the good one was not touched');
  assert.equal((await mkBox([good], { emsTotal: 5.005 })).status, 400, 'pennies only');
});

test('moving a box along: en route, then arrived — its items follow, and out-of-order steps are refused', async () => {
  const h = fresh(); const id = await arrived(h); const box = (await mkBox([id])).json.id;
  assert.equal((await api('POST', `/api/admin/boxes/${box}/arrived`, {})).json.code, 'bad_state', 'cannot arrive before it is en route');
  assert.equal((await api('POST', `/api/admin/boxes/${box}/ready`, { ready: [id], checking: [] })).json.code, 'bad_state', 'nor be checked');
  assert.equal((await api('POST', `/api/admin/boxes/${box}/enroute`, {})).status, 200);
  assert.equal((await claim1(h)).pipeline, 'enroute to GOM');
  assert.equal((await api('POST', `/api/admin/boxes/${box}/enroute`, {})).json.code, 'bad_state', 'not twice');
  assert.equal((await api('POST', `/api/admin/boxes/${box}/arrived`, {})).status, 200);
  assert.equal((await claim1(h)).pipeline, 'arrived at GOM');
  assert.equal((await boxOf(box)).items[0].itemStatus, 'pending');
  assert.equal((await api('POST', '/api/admin/boxes/999999/enroute', {})).status, 404);
});

async function arrivedBox(handles, extra = {}) {
  const ids = []; for (const h of handles) ids.push(await arrived(h));
  const box = (await mkBox(ids, extra)).json.id;
  await api('POST', `/api/admin/boxes/${box}/enroute`, {}); await api('POST', `/api/admin/boxes/${box}/arrived`, {});
  return { box, ids };
}

test('ready to pack: ticked items become ready (and their storage clock starts); unticked ones stay "checking parcel" until sorted', async () => {
  const [a, b] = [fresh(), fresh()];
  const { box, ids } = await arrivedBox([a, b]);
  assert.equal((await api('POST', `/api/admin/boxes/${box}/ready`, { ready: [ids[0]], checking: [ids[1]] })).status, 200);
  const [ca, cb] = [await claim1(a), await claim1(b)];
  assert.equal(ca.pipeline, 'ready to pack / on hand'); assert.ok(ca.ready_to_pack_date, 'the storage clock started');
  assert.equal(cb.pipeline, 'checking parcel'); assert.equal(cb.ready_to_pack_date, null);
  assert.equal((await boxOf(box)).archived, false, 'one item is still being checked, so the box stays active');
  await app.q('UPDATE claims SET ready_to_pack_date = CURDATE() - INTERVAL 5 DAY WHERE id = ?', [ids[0]]);
  await api('POST', `/api/admin/boxes/${box}/ready`, { ready: ids, checking: [] });              // later: the problem is sorted
  assert.equal((await claim1(b)).pipeline, 'ready to pack / on hand');
  assert.equal((await app.q('SELECT DATEDIFF(CURDATE(), ready_to_pack_date) AS d FROM claims WHERE id = ?', [ids[0]]))[0].d, 5, 'running it again does not restart the clock');
  assert.equal((await boxOf(box)).archived, true, 'arrived and everything ready: done with');
});

test('ready to pack never moves an item backwards once it has gone on to packing, and only accepts items in that box', async () => {
  const { box, ids } = await arrivedBox([fresh(), fresh()]);
  await api('PATCH', `/api/admin/claims/${ids[0]}`, { pipeline: 'packed' });
  assert.equal((await api('POST', `/api/admin/boxes/${box}/ready`, { ready: [], checking: [ids[0]] })).status, 200);
  assert.equal((await api('GET', '/api/admin/claims')).json.claims.find((c) => c.id === ids[0]).pipeline, 'packed', 'still packed');
  const stranger = await arrived(fresh());
  assert.equal((await api('POST', `/api/admin/boxes/${box}/ready`, { ready: [stranger], checking: [] })).status, 404);
});

test('customs arriving later: split by value; raising or lowering it only applies the CHANGE, and a lower figure returns paid money as credit', async () => {
  const [h1, h2] = [fresh('cu'), fresh('cu')];
  const c1 = await joinerSession(app, `${h1}@x.com`, h1);
  const a = await arrived(h1, ITEM.album), b = await arrived(h2, ITEM.hoodie);                      // £20 : £50
  const box = (await mkBox([a, b], { emsTotal: 4 })).json.id;
  assert.equal((await api('POST', `/api/admin/boxes/${box}/customs`, { customsTotal: 0 })).json.code, 'customs_required');
  await api('POST', `/api/admin/boxes/${box}/customs`, { customsTotal: 7 });
  assert.deepEqual([(await claim1(h1)).costs.customs.cost, (await claim1(h2)).costs.customs.cost], [2, 5]);
  await api('POST', `/api/admin/boxes/${box}/customs`, { customsTotal: 14 });
  assert.deepEqual([(await claim1(h1)).costs.customs.cost, (await claim1(h2)).costs.customs.cost], [4, 10], 'raised: only the difference is added');
  const owes = (await app.api('GET', '/api/my/summary', undefined, c1)).json.owed.total;                        // £20 + their share of the EMS + £4 customs
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: owes, reference: 'CU' }, c1);
  assert.equal(pay.status, 201);
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  await api('POST', `/api/admin/boxes/${box}/customs`, { customsTotal: 7 });
  const after = await claim1(h1);
  assert.equal(after.costs.customs.cost, 2);
  assert.equal(round2(after.costs.customs.paid), 2, 'paid never exceeds the cost');
  const s = (await app.api('GET', '/api/my/summary', undefined, c1)).json;
  assert.equal(s.credit, 2, 'the £2 they had paid beyond the new customs figure is credit');
  const bx = await boxOf(box);
  assert.equal(bx.customsTotal, 7); assert.equal(sum(bx.items.map((i) => i.customsShare)), 7);
});

test('undoing a box takes its EMS and customs back off, returns anything already paid towards them as credit, and frees the items', async () => {
  const h = fresh('un'); const c = await joinerSession(app, `${h}@x.com`, h);
  const id = await arrived(h, ITEM.album);
  const box = (await mkBox([id], { emsTotal: 5, customsTotal: 3 })).json.id;
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 28, reference: 'UN' }, c);        // 20 + 5 + 3
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  assert.equal((await app.api('GET', '/api/my/summary', undefined, c)).json.owed.total, 0);
  assert.equal((await api('DELETE', `/api/admin/boxes/${box}`)).status, 200);
  const cl = await claim1(h);
  assert.deepEqual([cl.costs.ems.cost, cl.costs.customs.cost, cl.pipeline], [0, 0, 'arrived at proxy / warehouse']);
  assert.equal((await app.api('GET', '/api/my/summary', undefined, c)).json.credit, 8, 'the £8 they paid for postage and customs is theirs again');
  assert.equal(await boxOf(box), undefined);
  assert.ok((await api('GET', '/api/admin/boxes/candidates')).json.candidates.some((x) => x.claimId === id), 'available for another box');
  const arrivedOne = (await arrivedBox([fresh()])).box;
  assert.equal((await api('DELETE', `/api/admin/boxes/${arrivedOne}`)).json.code, 'bad_state', "once it has arrived it can't be undone");
  assert.equal((await api('DELETE', '/api/admin/boxes/999999')).status, 404);
});

test('tracking is internal: it can be saved and cleared, and boxes are searchable by number, tracking, person or item', async () => {
  const h = fresh('sr'); const id = await arrived(h, ITEM.hoodie); const box = (await mkBox([id])).json.id;
  assert.equal((await api('PATCH', `/api/admin/boxes/${box}`, { trackingId: '  TRK-999 ' })).status, 200);
  assert.equal((await boxOf(box)).trackingId, 'TRK-999');
  for (const q of [String(box), 'trk-999', h, `@${h.toUpperCase()}`, 'hoodie']) assert.ok((await boxes(q)).some((x) => x.id === box), `found by "${q}"`);
  assert.equal((await boxes('zzz-nothing')).length, 0);
  await api('PATCH', `/api/admin/boxes/${box}`, { trackingId: '' });
  assert.equal((await boxOf(box)).trackingId, null);
  assert.equal((await api('PATCH', '/api/admin/boxes/999999', { trackingId: 'x' })).status, 404);
  const j = await app.api('GET', `/api/my/summary`, undefined, await joinerSession(app, `${fresh('tj')}@x.com`, fresh('th')));
  assert.ok(!JSON.stringify(j.json).includes('TRK-999'), 'never shown to joiners');
});

test('STRESS: the same item put in boxes by 5 requests at once is boxed exactly once, and its EMS added exactly once', async () => {
  const h = fresh('st'); const id = await arrived(h);
  const rs = await Promise.all(Array.from({ length: 5 }, () => mkBox([id], { emsTotal: 6 })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  assert.equal((await claim1(h)).costs.ems.cost, 6, 'not 30');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM box_items WHERE claim_id = ?', [id]))[0].n, 1);
});

test('the box screens are for the GOM only', async () => {
  const j = await app.login('box.joiner@x.com');
  for (const [m, p, b] of [['GET', '/api/admin/boxes'], ['GET', '/api/admin/boxes/candidates'], ['POST', '/api/admin/boxes', { claimIds: [1], emsTotal: 1 }], ['POST', '/api/admin/boxes/preview', { claimIds: [1], emsTotal: 1 }],
    ['PATCH', '/api/admin/boxes/1', { trackingId: 'x' }], ['POST', '/api/admin/boxes/1/enroute', {}], ['POST', '/api/admin/boxes/1/arrived', {}], ['POST', '/api/admin/boxes/1/ready', { ready: [], checking: [] }], ['POST', '/api/admin/boxes/1/customs', { customsTotal: 1 }], ['DELETE', '/api/admin/boxes/1']]) {
    assert.equal((await api(m, p, b, j)).status, 403, `${m} ${p}`);
    assert.equal((await app.api(m, p, b)).status, 401, `${m} ${p} signed out`);
  }
});

test('INVARIANTS: every box\'s shares add up to its totals, every boxed item points at its box, and nothing is overpaid', async () => {
  const bad = await app.q(`SELECT b.id FROM boxes b JOIN box_items bi ON bi.box_id = b.id GROUP BY b.id, b.ems_total, b.customs_total
                             HAVING ROUND(SUM(bi.ems_share), 2) <> b.ems_total OR (b.customs_total > 0 AND ROUND(SUM(bi.customs_share), 2) <> b.customs_total)`);
  assert.deepEqual(bad, []);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM box_items bi JOIN claims c ON c.id = bi.claim_id WHERE c.box_id IS NULL OR c.box_id <> bi.box_id'))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost OR cost < 0'))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs cc JOIN box_items bi ON bi.claim_id = cc.claim_id WHERE cc.category = \'ems\' AND cc.cost < bi.ems_share'))[0].n, 0, 'an item\'s EMS cost is never below the share its box added');
});
