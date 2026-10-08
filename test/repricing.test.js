import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const fresh = (p = 'rp') => `${p}${++N}`;
const setPrice = (item, price) => api('PATCH', `/api/admin/items/${item}`, { price });
const costOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims.map((c) => [c.label, c.status, c.costs.initials.cost]);
const initials = async (h) => (await costOf(h)).map((r) => r[2]);
const setsOf = async (item) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item);
const claimSet = (handle, item, ...parts) => app.api('POST', '/api/claims', { handle, lines: [{ itemId: item, parts: parts.map((member) => ({ member, qty: 1 })) }] }, undefined);
async function newSet(price = 8, members = ['A', 'B', 'C']) {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Reprice GO ${++N}` })).json.id;
  return (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: `Reprice set ${N}`, price, members })).json.id;
}
async function newItem(price = 10) {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Reprice GO ${++N}` })).json.id;
  return { go, item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: `Reprice item ${N}`, price })).json.id };
}

test('a set that is NOT secured follows the listed price: change it and every part in it changes', async () => {
  const set = await newSet(8); const [a, b] = [fresh(), fresh()];
  await claimSet(a, set, 'A', 'B'); await claimSet(b, set, 'C');
  assert.deepEqual([await initials(a), await initials(b)], [[8, 8], [8]]);
  const r = await setPrice(set, 10);
  assert.deepEqual([r.status, r.json.repriced], [200, 3]);
  assert.deepEqual([await initials(a), await initials(b)], [[10, 10], [10]]);
  await setPrice(set, 7.5);
  assert.deepEqual(await initials(a), [7.5, 7.5], 'and again, in either direction');
});

test('SECURING locks the price: a later change leaves a secured set alone', async () => {
  const set = await newSet(8); const a = fresh();
  await claimSet(a, set, 'A', 'B');
  const [s1] = await setsOf(set);
  await setPrice(set, 10);                                                          // still unsecured: follows
  assert.deepEqual(await initials(a), [10, 10]);
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {});                          // secured at £10
  const r = await setPrice(set, 12);
  assert.equal(r.json.repriced, 0, 'nothing was unsecured, so nothing changed');
  assert.deepEqual(await initials(a), [10, 10], 'a secured set keeps the price it was secured at');
});

test('your scenario: several sets secured at one price, then the price changes — new sets use the new price, and each secured set keeps its own', async () => {
  const set = await newSet(8, ['A', 'B']);
  const people = [fresh(), fresh(), fresh(), fresh(), fresh(), fresh()];
  // Set 1 and 2 fill up at £8 and are secured
  await claimSet(people[0], set, 'A'); await claimSet(people[1], set, 'B'); await claimSet(people[2], set, 'A'); await claimSet(people[3], set, 'B');
  const [s1, s2] = await setsOf(set);
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {}); await api('POST', `/api/admin/sets/${s2.id}/secure`, {});
  await setPrice(set, 10);                                                          // the price goes up AFTER two sets were secured
  await claimSet(people[4], set, 'A'); await claimSet(people[5], set, 'B');          // set 3 forms at the new price
  const costs = Object.fromEntries(await Promise.all(people.map(async (h) => [h, (await initials(h))[0]])));
  assert.deepEqual(people.map((h) => costs[h]), [8, 8, 8, 8, 10, 10], 'sets 1–2 stay at £8; set 3 is £10');
  const [, , s3] = await setsOf(set);
  assert.equal(s3.decision, 'none');
  await setPrice(set, 11);                                                          // set 3 is not secured yet, so it moves again
  assert.deepEqual([await initials(people[4]), await initials(people[5]), await initials(people[0])], [[11], [11], [8]]);
  await api('POST', `/api/admin/sets/${s3.id}/secure`, {});                           // set 3 is locked at £11
  await setPrice(set, 14);
  assert.deepEqual(await Promise.all(people.map(async (h) => (await initials(h))[0])), [8, 8, 8, 8, 11, 11], 'each secured set keeps the price it was secured at');
});

test('what a person OWES follows: after the change and then securing, they owe the new price', async () => {
  const set = await newSet(8, ['A']); const h = fresh(); const c = await joinerSession(app, `${h}@x.com`, h);
  await claimSet(h, set, 'A');
  await setPrice(set, 9.5);
  const [s1] = await setsOf(set); await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  assert.equal((await app.api('GET', '/api/my/summary', undefined, c)).json.owed.total, 9.5);
  await setPrice(set, 20);
  assert.equal((await app.api('GET', '/api/my/summary', undefined, c)).json.owed.total, 9.5, 'and it does not move afterwards');
});

test('a part with its OWN price in a mixed-price set keeps it; only the parts that use the item price follow', async () => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Mixed ${++N}` })).json.id;
  const set = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: `Mixed set ${N}`, price: 3, members: ['Han', { name: 'Diary', price: 2 }, { name: 'Washi', price: 1 }] })).json.id;
  const h = fresh(); await claimSet(h, set, 'Han', 'Diary', 'Washi');
  assert.deepEqual((await costOf(h)).map((r) => r[2]).sort(), [1, 2, 3]);
  const r = await setPrice(set, 5);
  assert.equal(r.json.repriced, 3);
  assert.deepEqual((await costOf(h)).map((x) => [x[0].replace(/^.* — /, '').replace(/ \(.*$/, ''), x[2]]).sort(), [['Diary', 2], ['Han', 5], ['Washi', 1]]);
});

test('ordinary items follow the same rule: a request follows the listing; a secured claim keeps its price', async () => {
  const { go, item } = await newItem(10); const [req, secured] = [fresh(), fresh()];
  await claimAndSecure(app, admin, secured, item);
  await app.api('POST', '/api/claims', { handle: req, lines: [{ itemId: item }] });
  const r = await setPrice(item, 12);
  assert.equal(r.json.repriced, 1);
  const [reqRow] = await costOf(req), [secRow] = await costOf(secured);
  assert.deepEqual([reqRow[1], reqRow[2], secRow[1], secRow[2]], ['requested', 12, 'confirmed', 10]);
  await api('POST', '/api/admin/claims/secure', { orderId: go });
  await setPrice(item, 15);
  assert.equal((await initials(req))[0], 12, 'locked once secured');
});

test('fixed claims in a set that is not secured follow the price too', async () => {
  const set = await newSet(8, ['A', 'B']); const h = fresh();
  assert.equal((await api('POST', `/api/admin/items/${set}/fixed`, { handle: h, member: 'A' })).status, 201);
  await setPrice(set, 9);
  assert.deepEqual(await initials(h), [9]);
});

test('only what should change changes: cancelled claims, shop stock, other items, the same price, and edits that are not about price', async () => {
  const set = await newSet(8, ['A', 'B']); const other = await newSet(8, ['A']);
  const [live, cancelled, elsewhere] = [fresh(), fresh(), fresh()];
  await claimSet(live, set, 'A'); await claimSet(cancelled, set, 'B'); await claimSet(elsewhere, other, 'A');
  const cc = (await api('GET', `/api/admin/claims?handle=${cancelled}`)).json.claims[0];
  await api('PATCH', `/api/admin/claims/${cc.id}`, { status: 'cancelled' });
  const shopId = (await api('POST', '/api/admin/shop', { title: 'Shop thing', price: 4, qty: 2 })).json.id;
  const shopper = fresh(); await app.api('POST', '/api/claims', { handle: shopper, lines: [{ leftoverId: shopId }] });
  assert.equal((await setPrice(set, 8)).json.repriced, 0, 'the same price: nothing to do');
  assert.equal((await api('PATCH', `/api/admin/items/${set}`, { title: 'Renamed set' })).json.repriced, 0, 'a title edit is not a price edit');
  const r = await setPrice(set, 20);
  assert.equal(r.json.repriced, 1, 'just the one live claim');
  assert.deepEqual([await initials(live), await initials(cancelled), await initials(elsewhere), await initials(shopper)], [[20], [8], [8], [4]]);
});

test('a price change is explained to the GOM as a count, and only the GOM can make it', async () => {
  const set = await newSet(8, ['A']); await claimSet(fresh(), set, 'A');
  const j = await app.login('rp.joiner@x.com');
  assert.equal((await api('PATCH', `/api/admin/items/${set}`, { price: 1 }, j)).status, 403);
  assert.equal((await app.api('PATCH', `/api/admin/items/${set}`, { price: 1 })).status, 401);
  assert.equal((await api('PATCH', `/api/admin/items/${set}`, { price: -3 })).status, 400);
  assert.equal((await api('GET', '/api/orders')).status, 200);
  const pub = (await app.api('GET', '/api/orders')).json.orders.flatMap((o) => o.items).find((i) => i.id === set);
  assert.equal(pub.price, 8, 'the failed attempts changed nothing');
});

test('STRESS: price edits racing with people claiming — every request ends up at the price LISTED at the end, never a stale one', async () => {
  const { item } = await newItem(10);
  const ops = [];
  for (let i = 0; i < 12; i++) ops.push(app.api('POST', '/api/claims', { handle: fresh('race'), lines: [{ itemId: item }] }));
  for (const p of [11, 12, 13]) ops.push(setPrice(item, p));
  const rs = await Promise.all(ops);
  assert.ok(rs.every((r) => [200, 201].includes(r.status)), `no errors (${[...new Set(rs.map((r) => r.status))]})`);
  const final = (await app.api('GET', '/api/orders')).json.orders.flatMap((o) => o.items).find((i) => i.id === item).price;
  const costs = await app.q("SELECT DISTINCT cc.cost FROM claim_costs cc JOIN claims c ON c.id = cc.claim_id WHERE c.item_id = ? AND c.status = 'requested' AND cc.category = 'initials'", [item]);
  assert.deepEqual(costs.map((r) => Number(r.cost)), [final], `all 12 requests are at the final listed price £${final}`);
});

test('a claim made while a price edit is in progress WAITS for it, and is saved at the new price — it can never slip in with the old one', async () => {
  const { item } = await newItem(10);
  const conn = await app.pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM items WHERE id = ? FOR UPDATE', [item]);              // exactly what a price edit holds while it works
    let finished = false; const h = fresh('wait');
    const claim = app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: item }] }, undefined).then((r) => { finished = true; return r; });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(finished, false, 'the claim is held back while the price edit is still in progress');
    await conn.query('UPDATE items SET price = 13 WHERE id = ?', [item]);
    await conn.commit();
    assert.equal((await claim).status, 201);
    assert.deepEqual(await initials(h), [13], 'saved at the price that was listed once the edit finished');
  } finally { conn.release(); }
});

test('STRESS: a price edit and "secure this set" at the same instant — the set ends up at ONE price, never half and half', async () => {
  for (let round = 0; round < 6; round++) {
    const set = await newSet(8, ['A', 'B', 'C']); const hs = [fresh('sr'), fresh('sr'), fresh('sr')];
    await claimSet(hs[0], set, 'A'); await claimSet(hs[1], set, 'B'); await claimSet(hs[2], set, 'C');
    const [s1] = await setsOf(set);
    const [a, b] = await Promise.all([setPrice(set, 10), api('POST', `/api/admin/sets/${s1.id}/secure`, {})]);
    assert.ok(a.status === 200 && b.status === 200, `round ${round}: ${a.status}/${b.status}`);
    const costs = (await Promise.all(hs.map((h) => initials(h)))).flat();
    assert.equal(new Set(costs).size, 1, `round ${round}: one price across the set (${costs})`);
    assert.ok([8, 10].includes(costs[0]));
    const status = (await setsOf(set))[0].decision;
    assert.equal(status, 'secured');
  }
});

test('INVARIANTS: nothing is overpaid and no unsecured claim carries a price different from the listing', async () => {
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost OR cost < 0'))[0].n, 0);
  const stale = await app.q(`SELECT c.id FROM claims c JOIN items i ON i.id = c.item_id JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category = 'initials'
                              LEFT JOIN item_members im ON im.item_id = c.item_id AND im.name = c.member_name
                             WHERE c.status = 'requested' AND c.set_id IS NOT NULL AND cc.cost <> COALESCE(im.price, i.price)`);
  assert.deepEqual(stale, [], 'every unsecured set claim carries the currently listed price');
});
