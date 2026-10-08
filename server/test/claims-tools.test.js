import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const fresh = (p = 'ct') => `${p}${++N}`;
const ledger = async (h) => (await api('GET', `/api/admin/ledger?handle=${h}`)).json;
const tips = async () => (await api('GET', '/api/admin/ledger')).json.tipsTotal;
const credit = async (c) => (await app.api('GET', '/api/my/summary', undefined, c)).json.credit;
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const stage = async (id) => (await api('GET', '/api/admin/claims')).json.claims.find((c) => c.id === id).pipeline;
async function newOrder(title) { const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `${title} ${++N}` })).json.id; return { go, item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: `Thing ${N}`, price: 10 })).json.id }; }

// ───────── credit → tip ─────────
test('turning credit into a tip: the credit leaves their balance and the same amount is recorded as a tip — two honest rows', async () => {
  const h = fresh(); const c = await joinerSession(app, `${h}@x.com`, h);
  await api('POST', '/api/admin/credit/add', { handle: h, amount: 10, reason: 'sold your album' });
  const before = await tips();
  const r = await api('POST', '/api/admin/credit/tip', { handle: `@${h.toUpperCase()}`, amount: 4 });
  assert.equal(r.status, 200);
  assert.equal(await credit(c), 6, 'their credit dropped by the amount');
  assert.equal(await tips(), before + 4, 'and it counts as a tip');
  const rows = (await ledger(h)).entries.slice(0, 2).reverse();
  assert.deepEqual(rows.map((e) => [e.kind, e.amount, e.balanceEffect, e.reason]), [['removed', 4, -4, 'Converted to a tip at their request'], ['tip', 4, 0, 'Converted to a tip at their request']]);
});

test('your own reason is kept; the whole balance can be converted; pennies are exact', async () => {
  const h = fresh(); const c = await joinerSession(app, `${h}@x.com`, h);
  await api('POST', '/api/admin/credit/add', { handle: h, amount: 10.1, reason: 'x' });
  assert.equal((await api('POST', '/api/admin/credit/tip', { handle: h, amount: 10.1, reason: ' asked on Instagram DM ' })).status, 200);
  assert.equal(await credit(c), 0);
  assert.equal((await ledger(h)).entries[0].reason, 'asked on Instagram DM');
});

test('cannot tip more than they hold — including credit that has already been used up — and nothing is recorded when refused', async () => {
  const h = fresh(); const c = await joinerSession(app, `${h}@x.com`, h);
  await api('POST', '/api/admin/credit/add', { handle: h, amount: 5, reason: 'x' });
  const n = (await ledger(h)).entries.length, t = await tips();
  const over = await api('POST', '/api/admin/credit/tip', { handle: h, amount: 5.01 });
  assert.equal(over.status, 400); assert.equal(over.json.code, 'not_enough_credit'); assert.match(over.json.error, /only have £5\.00 unspent credit, so £5\.01 can't be turned into a tip/);
  assert.deepEqual([(await ledger(h)).entries.length, await tips(), await credit(c)], [n, t, 5]);
  const { item } = await newOrder('Spend'); await claimAndSecure(app, admin, h, item);                 // the £5 credit is now used on what they owe
  const spent = await api('POST', '/api/admin/credit/tip', { handle: h, amount: 1 });
  assert.equal(spent.json.code, 'not_enough_credit'); assert.match(spent.json.error, /only have £0\.00/);
});

test('input is checked: an amount above zero to the penny, a real handle; and only the GOM can do it', async () => {
  const h = fresh(); await joinerSession(app, `${h}@x.com`, h); await api('POST', '/api/admin/credit/add', { handle: h, amount: 5, reason: 'x' });
  for (const amount of [0, -1, 1.005, 100001, 'a lot']) assert.equal((await api('POST', '/api/admin/credit/tip', { handle: h, amount })).status, 400, String(amount));
  assert.equal((await api('POST', '/api/admin/credit/tip', { amount: 1 })).status, 400);
  assert.equal((await api('POST', '/api/admin/credit/tip', { handle: 'nobody_here', amount: 1 })).status, 404);
  const j = await app.login('tip.joiner@x.com');
  assert.equal((await api('POST', '/api/admin/credit/tip', { handle: h, amount: 1 }, j)).status, 403, 'a joiner cannot convert their own credit');
  assert.equal((await app.api('POST', '/api/admin/credit/tip', { handle: h, amount: 1 })).status, 401);
});

test('STRESS: five conversions of £4 at the same instant from £10 credit — exactly two succeed, and the balance never goes negative', async () => {
  const h = fresh(); const c = await joinerSession(app, `${h}@x.com`, h);
  await api('POST', '/api/admin/credit/add', { handle: h, amount: 10, reason: 'x' });
  const t = await tips();
  const rs = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/api/admin/credit/tip', { handle: h, amount: 4 })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 400, 400, 400]);
  assert.equal(await credit(c), 2); assert.equal(await tips(), t + 8);
});

// ───────── totals per person ─────────
test('the claims list carries each person\'s totals — owed, paid, credit — across ALL their claims, even when filtered to one order', async () => {
  const h = fresh('tot'); const other = fresh('tot'); const c = await joinerSession(app, `${h}@x.com`, h);
  const [a, b, req, gone] = [await newOrder('A'), await newOrder('B'), await newOrder('C'), await newOrder('D')];
  await claimAndSecure(app, admin, h, a.item); await claimAndSecure(app, admin, h, b.item);
  await api('POST', '/api/claims', { handle: h, lines: [{ itemId: req.item }] }, undefined);             // a request: owes nothing yet
  const [idGone] = await claimAndSecure(app, admin, h, gone.item); await api('PATCH', `/api/admin/claims/${idGone}`, { status: 'cancelled' });
  await claimAndSecure(app, admin, other, a.item);
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 4, reference: 'T' }, c); await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  await api('POST', '/api/admin/credit/add', { handle: h, amount: 7, reason: 'goodwill' });             // used straight away against what they owe
  const all = (await api('GET', '/api/admin/claims')).json.people;
  // £10 + £10 owed on two confirmed claims; they paid £4 and £7 credit was applied: owed 20 − 11 = 9
  assert.deepEqual([all[h].owed, all[h].paid, all[h].credit], [9, 11, 0]);
  assert.deepEqual([all[other].owed, all[other].paid, all[other].credit], [10, 0, 0], 'someone else\'s figures are their own');
  const filtered = (await api('GET', `/api/admin/claims?order=${a.go}`)).json.people;
  assert.deepEqual(filtered[h], all[h], 'filtering to one order does not shrink what they owe overall');
  await api('POST', '/api/admin/credit/add', { handle: h, amount: 20, reason: 'more' });
  const after = (await api('GET', '/api/admin/claims')).json.people[h];
  assert.deepEqual([after.owed, after.credit], [0, 11], 'credit held is shown once nothing is owed');
});

test('people with no claims in the list are not in the totals', async () => {
  const j = fresh('lonely'); await joinerSession(app, `${j}@x.com`, j);
  assert.equal((await api('GET', '/api/admin/claims')).json.people[j], undefined);
});

// ───────── bulk stage move ─────────
const arrivedClaim = async (h, item) => { const [id] = await claimAndSecure(app, admin, h, item); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'arrived at proxy / warehouse' }); return id; };
const bulk = (claimIds, pipeline) => api('POST', '/api/admin/claims/pipeline', { claimIds, pipeline });

test('moving many claims at once: they all change, and the ones already there are counted, not touched', async () => {
  const { item } = await newOrder('Bulk');
  const ids = []; for (let i = 0; i < 4; i++) ids.push((await claimAndSecure(app, admin, fresh('bk'), item))[0]);
  await api('PATCH', `/api/admin/claims/${ids[3]}`, { pipeline: 'ordered via proxy / warehouse' });
  const r = await bulk(ids, 'ordered via proxy / warehouse');
  assert.deepEqual([r.status, r.json.changed, r.json.unchanged, r.json.skipped], [200, 3, 1, []]);
  for (const id of ids) assert.equal(await stage(id), 'ordered via proxy / warehouse');
});

test('moving to "ready to pack" starts the storage clock once; moving back and forth never restarts it', async () => {
  const { item } = await newOrder('Clock');
  const [id] = await claimAndSecure(app, admin, fresh('clk'), item);
  await bulk([id], 'ready to pack / on hand');
  const first = (await claimsOf((await api('GET', '/api/admin/claims')).json.claims.find((c) => c.id === id).handle))[0].ready_to_pack_date;
  assert.ok(first);
  await app.q('UPDATE claims SET ready_to_pack_date = CURDATE() - INTERVAL 9 DAY WHERE id = ?', [id]);
  await bulk([id], 'checking parcel'); await bulk([id], 'ready to pack / on hand');
  assert.equal((await app.q('SELECT DATEDIFF(CURDATE(), ready_to_pack_date) AS d FROM claims WHERE id = ?', [id]))[0].d, 9);
});

test('it never touches what it should not — cancelled, unconfirmed, in a parcel, in a box on its way — and says why for each', async () => {
  const { item } = await newOrder('Skips');
  const hc = fresh('sk'); const cj = await joinerSession(app, `${hc}@x.com`, hc);
  const [ok] = await claimAndSecure(app, admin, fresh('sk'), item);
  const [cancelled] = await claimAndSecure(app, admin, fresh('sk'), item); await api('PATCH', `/api/admin/claims/${cancelled}`, { status: 'cancelled' });
  const requested = fresh('sk'); await api('POST', '/api/claims', { handle: requested, lines: [{ itemId: item }] }, undefined);
  const reqId = (await claimsOf(requested))[0].id;
  // in a parcel
  await app.api('PUT', '/api/my/address', { fullName: 'S K', address: '1 Road, Leeds', email: `${hc}@x.com`, phone: '0700' }, cj);
  const [inParcel] = await claimAndSecure(app, admin, hc, item); await api('PATCH', `/api/admin/claims/${inParcel}`, { pipeline: 'ready to pack / on hand' });
  assert.equal((await app.api('POST', '/api/my/parcels', { claimIds: [inParcel], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, cj)).status, 201);
  // in a box that has not arrived
  const inBox = await arrivedClaim(fresh('sk'), item);
  assert.equal((await api('POST', '/api/admin/boxes', { claimIds: [inBox], emsTotal: 4 })).status, 201);
  const r = await bulk([ok, cancelled, reqId, inParcel, inBox, 999999], 'arrived at GOM');
  assert.deepEqual([r.json.changed, r.json.unchanged, r.json.skipped.length], [1, 0, 5]);
  const why = Object.fromEntries(r.json.skipped.map((s) => [s.claimId, s.reason]));
  assert.equal(why[cancelled], 'it is cancelled'); assert.equal(why[reqId], "it isn't confirmed yet");
  assert.match(why[inParcel], /in a parcel.*Packing tab/); assert.match(why[inBox], /in a box that hasn't arrived yet.*Warehouse tab/); assert.equal(why[999999], 'no such claim');
  assert.equal(await stage(ok), 'arrived at GOM');
  assert.equal(await stage(inParcel), 'ready to pack / on hand'); assert.equal(await stage(inBox), 'shipping requested');
});

test('only the stages that make sense in bulk are offered — not the ones other screens drive (boxes, packing, shipping)', async () => {
  const { item } = await newOrder('Stages'); const [id] = await claimAndSecure(app, admin, fresh('st'), item);
  for (const bad of ['shipping requested', 'enroute to GOM', 'packed', 'shipped', 'completed', 'nonsense']) assert.equal((await bulk([id], bad)).status, 400, bad);
  for (const good of ['awaiting fulfillment', 'ordered via proxy / warehouse', 'arrived at proxy / warehouse', 'arrived at GOM', 'checking parcel', 'ready to pack / on hand']) assert.equal((await bulk([id], good)).status, 200, good);
  assert.equal((await bulk([], 'arrived at GOM')).status, 400);
  assert.equal((await bulk(Array.from({ length: 501 }, (_, i) => i + 1), 'arrived at GOM')).status, 400);
  assert.equal((await bulk([1.5], 'arrived at GOM')).status, 400);
  const dup = await bulk([id, id, id], 'ordered via proxy / warehouse');
  assert.equal(dup.json.changed + dup.json.unchanged, 1, 'the same claim listed three times is moved once');
});

test('a claim that came in a box keeps the box\'s own checklist in step', async () => {
  const { item } = await newOrder('BoxSync');
  const id = await arrivedClaim(fresh('bs'), item);
  const box = (await api('POST', '/api/admin/boxes', { claimIds: [id], emsTotal: 3 })).json.id;
  await api('POST', `/api/admin/boxes/${box}/enroute`, {}); await api('POST', `/api/admin/boxes/${box}/arrived`, {});
  await bulk([id], 'ready to pack / on hand');
  const b = (await api('GET', '/api/admin/boxes')).json.boxes.find((x) => x.id === box);
  assert.deepEqual([b.items[0].itemStatus, b.archived], ['ready', true]);
  await bulk([id], 'checking parcel');
  assert.equal((await api('GET', '/api/admin/boxes')).json.boxes.find((x) => x.id === box).items[0].itemStatus, 'checking');
});

test('only the GOM can move claims in bulk, and it is recorded', async () => {
  const j = await app.login('bulk.joiner@x.com');
  assert.equal((await api('POST', '/api/admin/claims/pipeline', { claimIds: [1], pipeline: 'arrived at GOM' }, j)).status, 403);
  assert.equal((await app.api('POST', '/api/admin/claims/pipeline', { claimIds: [1], pipeline: 'arrived at GOM' })).status, 401);
  assert.ok((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'claims.pipeline'"))[0].n > 0);
});

test('STRESS: a bulk move and a box creation on the same claims at the same instant never deadlock or corrupt anything', async () => {
  const { item } = await newOrder('Race');
  for (let round = 0; round < 5; round++) {
    const ids = []; for (let i = 0; i < 4; i++) ids.push(await arrivedClaim(fresh('rc'), item));
    const [a, b] = await Promise.all([bulk(ids, 'arrived at GOM'), api('POST', '/api/admin/boxes', { claimIds: ids, emsTotal: 5 })]);
    assert.ok([200].includes(a.status) && [201, 409].includes(b.status), `round ${round}: bulk ${a.status}, box ${b.status}`);
    const rows = await app.q('SELECT id, pipeline, box_id FROM claims WHERE id IN (?)', [ids]);
    for (const r of rows) assert.ok((r.box_id && r.pipeline === 'shipping requested') || (!r.box_id && r.pipeline === 'arrived at GOM'), `claim ${r.id}: ${r.pipeline} / box ${r.box_id}`);
  }
});

test('INVARIANTS: no negative balances, tips never touch a balance, nothing overpaid', async () => {
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM (SELECT joiner_id FROM credit_ledger GROUP BY joiner_id HAVING SUM(balance_effect) < -0.004) x'))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM credit_ledger WHERE kind = 'tip' AND balance_effect <> 0"))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost'))[0].n, 0);
});
