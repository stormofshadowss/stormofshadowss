import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const fresh = (p = 'tb') => `${p}${++N}`;
const order = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: `TBC GO ${++N}` })).json.id;
const mkItem = async (go, body) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: `TBC item ${++N}`, ...body })).json;
const pub = async (id) => (await app.api('GET', '/api/orders')).json.orders.flatMap((o) => o.items).find((i) => i.id === id);
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const claim = (handle, itemId, ...parts) => app.api('POST', '/api/claims', { handle, lines: [parts.length ? { itemId, parts: parts.map((member) => ({ member, qty: 1 })) } : { itemId }] }, undefined);
const setsOf = async (item) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item);
const patch = (id, body) => api('PATCH', `/api/admin/items/${id}`, body);
async function tbcSet(members = ['A', 'B', { name: 'Diary', price: 2 }]) { const go = await order(); return { go, item: (await mkItem(go, { type: 'set', priceTbc: true, members })).id }; }

test('creating an item with its price TBC: no price needed; joiners are told it is TBC (never £0); all five item types allow it', async () => {
  const go = await order();
  const kinds = { normal: {}, independent: { members: ['A', 'B'] }, size: { variants: ['M', 'L'] }, set: { members: ['A', 'B'] }, random: {} };
  for (const [type, extra] of Object.entries(kinds)) {
    const r = await mkItem(go, { type, priceTbc: true, ...extra });
    assert.ok(r.id, `${type} was created`);
    const it = await pub(r.id);
    assert.deepEqual([it.price, it.priceTbc], [null, true], `${type}: public price is null, never £0`);
    const [row] = await app.q('SELECT price, price_tbc FROM items WHERE id = ?', [r.id]);
    assert.deepEqual([Number(row.price), row.price_tbc], [0, 1], `${type}: stored as an unused placeholder plus the TBC mark`);
  }
  const admin_ = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items;
  assert.ok(admin_.every((i) => i.price === null && i.priceTbc === true));
});

test('a price OR "to be confirmed" is required — neither, or both, is explained', async () => {
  const go = await order();
  const neither = await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'x' });
  assert.equal(neither.status, 400); assert.match(neither.json.error, /Enter a price, or tick "price to be confirmed"/);
  const both = await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'x', price: 5, priceTbc: true });
  assert.equal(both.status, 400); assert.match(both.json.error, /not both/);
  assert.equal((await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'x', priceTbc: false })).status, 400);
  const free = await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'A free gift', price: 0 });
  assert.equal(free.status, 201, '£0 is still a real price (a free item) — only TBC means unknown');
  assert.deepEqual([(await pub(free.json.id)).price, (await pub(free.json.id)).priceTbc], [0, false]);
});

test('a set with TBC pricing: parts with their own price show it, the rest are TBC, and the whole-set price is only known when every part is', async () => {
  const { item } = await tbcSet(['A', 'B', { name: 'Diary', price: 2 }]);
  const it = await pub(item);
  assert.deepEqual(it.members.map((m) => [m.name, m.price]), [['A', null], ['B', null], ['Diary', 2]]);
  assert.equal(it.wholeSetPrice, null);
  const go = await order();
  const allOwn = await mkItem(go, { type: 'set', priceTbc: true, members: [{ name: 'X', price: 3 }, { name: 'Y', price: 1.5 }] });
  assert.equal((await pub(allOwn.id)).wholeSetPrice, 4.5, 'every part has its own price, so the total is known even though the item price is TBC');
});

test('people can claim a TBC item: it is accepted as a request, costs nothing yet, and is marked TBC everywhere they and you look', async () => {
  const go = await order(); const item = (await mkItem(go, { priceTbc: true })).id; const h = fresh(); const c = await joinerSession(app, `${h}@x.com`, h);
  assert.equal((await claim(h, item)).status, 201);
  const [row] = await claimsOf(h);
  assert.deepEqual([row.status, row.priceTbc, row.costs.initials.cost], ['requested', true, 0]);
  const s = (await app.api('GET', '/api/my/summary', undefined, c)).json;
  assert.equal(s.owed.total, 0);
  assert.equal(s.orders[0].claims[0].priceTbc, true);
});

test('set parts: TBC parts are marked, a part with its own price is a normal priced claim, and placements say null for the unknown price', async () => {
  const { item } = await tbcSet(['A', 'B', { name: 'Diary', price: 2 }]); const h = fresh();
  const r = await claim(h, item, 'A', 'Diary');
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.placements.map((p) => [p.member, p.price]), [['A', null], ['Diary', 2]]);
  const rows = Object.fromEntries((await claimsOf(h)).map((c) => [c.label.replace(/^.* — /, '').replace(/ \(.*$/, ''), [c.priceTbc, c.costs.initials.cost]]));
  assert.deepEqual(rows, { A: [true, 0], Diary: [false, 2] });
});

test('SECURING IS REFUSED while a price is TBC: a set says why and secures nothing; the claims stay requests', async () => {
  const { item } = await tbcSet(['A', 'B']); const h = fresh();
  await claim(h, item, 'A');
  const [s1] = await setsOf(item);
  assert.equal(s1.hasTbc, true);
  const r = await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  assert.equal(r.status, 409); assert.equal(r.json.code, 'price_tbc');
  assert.match(r.json.error, /can't be secured yet — the price of 1 of its parts is still TBC\. Set the item's price first\./);
  assert.equal((await setsOf(item))[0].decision, 'none');
  assert.equal((await claimsOf(h))[0].status, 'requested');
});

test('a set containing only parts that have their OWN price can still be secured', async () => {
  const { item } = await tbcSet(['A', { name: 'Diary', price: 2 }]); const h = fresh();
  await claim(h, item, 'Diary');
  const [s1] = await setsOf(item);
  assert.equal(s1.hasTbc, false);
  assert.equal((await api('POST', `/api/admin/sets/${s1.id}/secure`, {})).status, 200);
  assert.deepEqual([(await claimsOf(h))[0].status, (await claimsOf(h))[0].costs.initials.cost], ['confirmed', 2]);
});

test('"secure all" in an order secures everything with a price and LEAVES the TBC claims, saying how many', async () => {
  const go = await order(); const priced = (await mkItem(go, { price: 6 })).id, tbc = (await mkItem(go, { priceTbc: true })).id;
  const [a, b] = [fresh(), fresh()];
  await app.api('POST', '/api/claims', { handle: a, lines: [{ itemId: priced }, { itemId: tbc }] });
  await claim(b, tbc);
  const r = await api('POST', '/api/admin/claims/secure', { orderId: go });
  assert.deepEqual([r.status, r.json.secured, r.json.skippedTbc], [200, 1, 2]);
  const rows = await claimsOf(a);
  assert.deepEqual(rows.map((c) => [c.status, c.priceTbc]).sort(), [['confirmed', false], ['requested', true]]);
  assert.equal((await claimsOf(b))[0].status, 'requested');
  const byIds = await api('POST', '/api/admin/claims/secure', { claimIds: [(await claimsOf(b))[0].id] });
  assert.deepEqual([byIds.json.secured, byIds.json.skippedTbc], [0, 1], 'asking for a TBC claim by id is refused too');
});

test('confirming a TBC claim by hand, adding someone to a secured set at a TBC part, and sharing a TBC part\'s cost are all refused', async () => {
  const go = await order(); const tbc = (await mkItem(go, { priceTbc: true })).id; const h = fresh();
  await claim(h, tbc);
  const [c] = await claimsOf(h);
  const r = await api('PATCH', `/api/admin/claims/${c.id}`, { status: 'confirmed' });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'price_tbc'); assert.match(r.json.error, /price is still TBC/);
  // a set secured while priced, then the price goes back to TBC: an open part can't be handed out or split at an unknown price
  const go2 = await order(); const set = (await mkItem(go2, { type: 'set', price: 5, members: ['A', 'B', 'C'] })).id;
  await claim(fresh(), set, 'A'); await claim(fresh(), set, 'B');
  const [s1] = await setsOf(set); await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  assert.equal((await patch(set, { priceTbc: true })).status, 200);
  const add = await api('POST', `/api/admin/sets/${s1.id}/slots`, { member: 'C', handle: fresh() });
  assert.deepEqual([add.status, add.json.code], [409, 'price_tbc']);
  const split = await api('POST', `/api/admin/sets/${s1.id}/split`, { member: 'C' });
  assert.deepEqual([split.status, split.json.code], [409, 'price_tbc']);
  await patch(set, { price: 5 });
  assert.equal((await api('POST', `/api/admin/sets/${s1.id}/slots`, { member: 'C', handle: fresh() })).status, 201, 'fine once the price is set again');
});

test('adding someone to an UNSECURED set at a TBC part just makes another TBC request; a fixed claim on a TBC set is TBC too, and the joiner sees no price', async () => {
  const { item } = await tbcSet(['A', 'B']); const h = fresh('fx'); const c = await joinerSession(app, `${h}@x.com`, h);
  await claim(fresh(), item, 'A');
  const [s1] = await setsOf(item);
  assert.equal((await api('POST', `/api/admin/sets/${s1.id}/slots`, { member: 'B', handle: fresh() })).status, 201);
  assert.equal((await api('POST', `/api/admin/items/${item}/fixed`, { handle: h, member: 'A' })).status, 201);
  const mine = (await app.api('GET', '/api/my/fixed', undefined, c)).json.fixed[0];
  assert.deepEqual([mine.price, mine.priceTbc, mine.wholeSetPrice], [null, true, null]);
  assert.ok((await claimsOf(h))[0].priceTbc);
});

test('SETTING THE PRICE: every waiting claim picks it up, the TBC marks clear, and the claims can then be secured at that price', async () => {
  const { item } = await tbcSet(['A', 'B', { name: 'Diary', price: 2 }]); const [a, b] = [fresh(), fresh()];
  await claim(a, item, 'A', 'Diary'); await claim(b, item, 'B');
  const r = await patch(item, { price: 12 });
  assert.deepEqual([r.status, r.json.repriced], [200, 3]);
  const it = await pub(item);
  assert.deepEqual([it.price, it.priceTbc, it.members.map((m) => m.price), it.wholeSetPrice], [12, false, [12, 12, 2], 26]);
  const rows = Object.fromEntries([...await claimsOf(a), ...await claimsOf(b)].map((c) => [c.label.replace(/^.* — /, '').replace(/ \(.*$/, ''), [c.priceTbc, c.costs.initials.cost]]));
  assert.deepEqual(rows, { A: [false, 12], B: [false, 12], Diary: [false, 2] }, 'the part with its own price kept it');
  const [s1] = await setsOf(item);
  assert.equal((await api('POST', `/api/admin/sets/${s1.id}/secure`, {})).status, 200);
  assert.deepEqual((await claimsOf(a)).map((x) => x.status), ['confirmed', 'confirmed']);
});

test('typing a price on a TBC item confirms it by itself; the explicit forms are checked', async () => {
  const go = await order(); const item = (await mkItem(go, { priceTbc: true })).id;
  assert.equal((await patch(item, { priceTbc: false })).status, 400, 'confirming needs a price');
  assert.equal((await patch(item, { priceTbc: true, price: 5 })).status, 400);
  assert.equal((await patch(item, { price: 7.5 })).status, 200);
  assert.deepEqual([(await pub(item)).price, (await pub(item)).priceTbc], [7.5, false]);
  assert.equal((await patch(item, { priceTbc: false, price: 8 })).status, 200);
  assert.equal((await pub(item)).price, 8);
});

test('putting a price BACK to TBC: waiting claims go back to TBC, secured ones keep their price, parts with their own price are untouched', async () => {
  const go = await order(); const item = (await mkItem(go, { type: 'set', price: 10, members: ['A', 'B', { name: 'Diary', price: 2 }] })).id;
  const [locked, waiting] = [fresh(), fresh()];
  await claim(locked, item, 'A', 'Diary');
  const [s1] = await setsOf(item); await api('POST', `/api/admin/sets/${s1.id}/secure`, {});          // set 1 secured at £10
  await claim(waiting, item, 'A', 'Diary');                                                           // set 2, still a request
  const r = await patch(item, { priceTbc: true });
  assert.equal(r.json.repriced, 2);
  const lockedRows = await claimsOf(locked), waitingRows = Object.fromEntries((await claimsOf(waiting)).map((c) => [c.label.replace(/^.* — /, '').replace(/ \(.*$/, ''), [c.priceTbc, c.costs.initials.cost]]));
  assert.deepEqual(lockedRows.map((c) => [c.status, c.priceTbc]).sort(), [['confirmed', false], ['confirmed', false]], 'secured claims are untouched');
  assert.equal(lockedRows.find((c) => /A \(Set/.test(c.label)).costs.initials.cost, 10);
  assert.deepEqual(waitingRows, { A: [true, 0], Diary: [false, 2] });
  await claim(fresh(), item, 'B');
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND price_tbc = 1", [item]))[0].n, 2, 'the waiting A and a brand-new B');
  await patch(item, { price: 11 });
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND price_tbc = 1", [item]))[0].n, 0);
});

test('edits that do not change the price state do nothing to claims: the same TBC again, a title edit', async () => {
  const go = await order(); const item = (await mkItem(go, { priceTbc: true })).id; await claim(fresh(), item);
  assert.equal((await patch(item, { priceTbc: true })).json.repriced, 0);
  assert.equal((await patch(item, { title: 'Renamed' })).json.repriced, 0);
});

test('only the GOM can change a price or its TBC state', async () => {
  const go = await order(); const item = (await mkItem(go, { priceTbc: true })).id;
  const j = await app.login('tbc.joiner@x.com');
  assert.equal((await api('PATCH', `/api/admin/items/${item}`, { price: 1 }, j)).status, 403);
  assert.equal((await app.api('PATCH', `/api/admin/items/${item}`, { priceTbc: false, price: 1 })).status, 401);
  assert.equal((await pub(item)).priceTbc, true);
});

test('STRESS: setting the price while people claim — every request ends up priced, none left TBC, none at a stale price', async () => {
  const go = await order(); const item = (await mkItem(go, { priceTbc: true })).id;
  const ops = Array.from({ length: 12 }, () => claim(fresh('race'), item));
  ops.splice(6, 0, patch(item, { price: 9 }));
  const rs = await Promise.all(ops);
  assert.ok(rs.every((r) => [200, 201].includes(r.status)));
  const rows = await app.q("SELECT c.price_tbc, cc.cost FROM claims c JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category = 'initials' WHERE c.item_id = ?", [item]);
  assert.equal(rows.length, 12);
  assert.ok(rows.every((r) => r.price_tbc === 0 && Number(r.cost) === 9), `all 12 are priced at £9: ${JSON.stringify([...new Set(rows.map((r) => `${r.price_tbc}/${r.cost}`))])}`);
});

test('STRESS: "secure all" racing with the price being set — a claim is either secured WITH its price, or left waiting; never confirmed at £0', async () => {
  for (let round = 0; round < 5; round++) {
    const go = await order(); const item = (await mkItem(go, { priceTbc: true })).id;
    for (let i = 0; i < 4; i++) await claim(fresh('sr'), item);
    const [a, b] = await Promise.all([api('POST', '/api/admin/claims/secure', { orderId: go }), patch(item, { price: 5 })]);
    assert.ok(a.status === 200 && b.status === 200, `round ${round}: ${a.status}/${b.status}`);
    const rows = await app.q("SELECT c.status, c.price_tbc, cc.cost FROM claims c JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category = 'initials' WHERE c.item_id = ?", [item]);
    for (const r of rows) assert.ok((r.status === 'confirmed' && r.price_tbc === 0 && Number(r.cost) === 5) || (r.status === 'requested' && r.price_tbc === 0 && Number(r.cost) === 5), `round ${round}: ${JSON.stringify(r)}`);
  }
});

test('INVARIANTS: a TBC claim is always an unsecured, zero-cost request — and a confirmed claim is never TBC', async () => {
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims WHERE price_tbc = 1 AND status <> 'requested'"))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims c JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category = 'initials' WHERE c.price_tbc = 1 AND cc.cost <> 0"))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims c JOIN items i ON i.id = c.item_id LEFT JOIN item_members im ON im.item_id = c.item_id AND im.name = c.member_name WHERE c.status = 'requested' AND c.price_tbc = 1 AND i.price_tbc = 0"))[0].n, 0, 'no claim is marked TBC on an item whose price is set');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost'))[0].n, 0);
});
