import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// PURCHASE BENEFITS: "spend £X on these items, get N bonus copies" (repeating). Per PERSON (all their handles), on SECURED claims on the TICKED items, item cost only. The GOM sees who qualifies and presses Add.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'bn') => `${x}${++N}`;
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Benefit GO '), proxy: 'Sam' })).json.id;
const item = async (go, price, title = u('Thing '), extra = {}) => { const r = await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price, title, ...extra }); assert.equal(r.status, 201, r.text); return r.json.id; };
const offer = async (go, o = {}) => { const bonus = o.bonus ?? await item(go, 0, 'Store photocard (free)'); const items = o.items ?? [await item(go, 10, 'Album')]; const r = await api('POST', `/api/admin/orders/${go}/benefits`, { title: 'Spend £10 get a photocard', threshold: 10, quantity: 1, bonusItemId: bonus, itemIds: items, ...(o.extra || {}) }); return { r, id: r.json.id, bonus, items }; };
const spendOn = async (handle, itemId, copies = 1) => { for (let i = 0; i < copies; i++) await claimAndSecure(app, admin, handle, itemId); };
const quals = async (id, all = false) => (await api('GET', `/api/admin/benefits/${id}${all ? '?all=1' : ''}`)).json;
const person = (q, handle) => q.people.find((p) => p.handles.includes(handle));
const bonusClaims = async (id) => await app.q("SELECT c.id, c.status, c.pipeline, c.benefit_offer_id, j.instagram_handle AS handle FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE c.benefit_offer_id = ? AND c.status <> 'cancelled' ORDER BY c.id", [id]);

test('CREATING AN OFFER: a spend amount, a quantity, a FREE plain bonus item and the items that count; everything else is refused with a plain reason; GOM only; recorded', async () => {
  const go = await goOrder(); const a = await item(go, 10); const o = await offer(go, { items: [a] }); assert.equal(o.r.status, 201, o.r.text);
  const list = (await api('GET', `/api/admin/orders/${go}/benefits`)).json.offers; assert.equal(list.length, 1); assert.deepEqual([list[0].title, list[0].threshold, list[0].quantity, list[0].items.map((i) => i.id), list[0].bonusItemId], ['Spend £10 get a photocard', 10, 1, [a], o.bonus]);
  const free = await item(go, 0), paid = await item(go, 3), sized = await item(go, 5, u('Tee '), { type: 'size', variants: ['M'] }), other = await item(await goOrder(), 0);
  const bad = async (patch, code) => { const r = await api('POST', `/api/admin/orders/${go}/benefits`, { title: 't', threshold: 10, quantity: 1, bonusItemId: free, itemIds: [a], ...patch }); assert.deepEqual([r.status, r.json.code], [400, code], JSON.stringify(patch)); };
  await bad({ bonusItemId: paid }, 'bonus_not_free'); await bad({ bonusItemId: sized }, 'bad_bonus'); await bad({ bonusItemId: other }, 'bad_bonus'); await bad({ itemIds: [free] }, 'bad_items'); await bad({ itemIds: [other] }, 'bad_items');
  for (const p of [{ threshold: 0 }, { threshold: -5 }, { threshold: 1.234 }, { quantity: 0 }, { quantity: 1.5 }, { itemIds: [] }, { title: '' }]) assert.equal((await api('POST', `/api/admin/orders/${go}/benefits`, { title: 't', threshold: 10, quantity: 1, bonusItemId: free, itemIds: [a], ...p })).status, 400, JSON.stringify(p));
  const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await api('POST', `/api/admin/orders/${go}/benefits`, {}, j)).status, 403); assert.equal((await app.api('GET', `/api/admin/orders/${go}/benefits`)).status, 401);
  assert.ok((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'benefit.create' AND entity_id = ?", [o.id]))[0].n === 1);
});

test('WHAT COUNTS TOWARD THE SPEND: only the TICKED items, only SECURED claims (a request or a cancelled claim does not), only the ITEM COST (EMS and fees do not)', async () => {
  const go = await goOrder(); const ticked = await item(go, 10, 'Ticked'), notTicked = await item(go, 50, 'Not ticked'); const o = await offer(go, { items: [ticked] }); const h = u('spend'); await joinerSession(app, `${h}@x.com`, h);
  await spendOn(h, notTicked); assert.equal((await quals(o.id, true)).people.length, 0, 'spend on an item that is not ticked counts for nothing');
  await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: ticked }] }); assert.equal((await quals(o.id, true)).people.length, 0, 'an unsecured request does not count yet');
  await api('POST', '/api/admin/claims/secure', { orderId: go }); let p = person(await quals(o.id, true), h); assert.deepEqual([p.spend, p.entitled, p.toAdd], [10, 1, 1], 'secured: counts');
  const [{ id: cid }] = await app.q("SELECT c.id FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.item_id = ?", [h, ticked]); await api('PATCH', `/api/admin/claims/${cid}`, { costs: { ems: { cost: 40 }, customs: { cost: 9 } } });
  p = person(await quals(o.id, true), h); assert.equal(p.spend, 10, 'EMS and customs are not "spend on the item"');
  await app.q("UPDATE claims SET status = 'cancelled' WHERE id = ?", [cid]); assert.equal(person(await quals(o.id, true), h), undefined, 'a cancelled claim stops counting');
});

test('REPEATING, TO THE PENNY: every full amount earns the quantity again; just under earns nothing; the next amount is shown', async () => {
  const go = await goOrder(); const a = await item(go, 3.33, 'Three thirty-three'), b = await item(go, 0.01, 'A penny'); const o = await offer(go, { items: [a, b], extra: { threshold: 10, quantity: 2 } }); const h = u('pen'); await joinerSession(app, `${h}@x.com`, h);
  await spendOn(h, a, 3); let p = person(await quals(o.id, true), h); assert.deepEqual([p.spend, p.multiples, p.entitled, p.toGo], [9.99, 0, 0, 0.01], '£9.99 is not £10');
  await spendOn(h, b); p = person(await quals(o.id, true), h); assert.deepEqual([p.spend, p.multiples, p.entitled, p.toAdd], [10, 1, 2, 2], '£10.00 exactly: one amount × quantity 2');
  const tiny = await item(go, 0.07, 'Seven pence'); const o3 = await offer(go, { items: [tiny], extra: { threshold: 0.07, quantity: 1 } }); const k = u('tiny'); await joinerSession(app, `${k}@x.com`, k); await spendOn(k, tiny, 3);
  assert.deepEqual([person(await quals(o3.id, true), k).spend, person(await quals(o3.id, true), k).entitled], [0.21, 3], '3 × £0.07 is exactly three amounts of £0.07 (computers get 0.21 ÷ 0.07 wrong unless it is done in pence)');
  const big = await item(go, 20, 'Big'); const o2 = await offer(go, { items: [big], extra: { threshold: 10, quantity: 2 } }); const g = u('rep'); await joinerSession(app, `${g}@x.com`, g); await spendOn(g, big, 2);
  const q = person(await quals(o2.id, true), g); assert.deepEqual([q.spend, q.multiples, q.entitled], [40, 4, 8], 'repeating: £40 is four amounts');
});

test('A PERSON WITH SEVERAL HANDLES IS ONE PERSON: their spend adds up, the bonus goes to the handle that spent most, and what was given counts across all their handles', async () => {
  const go = await goOrder(); const a = await item(go, 6, 'A item'), b = await item(go, 5, 'B item'); const o = await offer(go, { items: [a, b] });
  const [x, y] = [u('ha'), u('hb')]; const cookie = await joinerSession(app, `${x}@x.com`, x); await api('POST', '/api/me/handles', { handle: y }, cookie); await spendOn(x, a); await spendOn(y, b);
  const q = await quals(o.id); assert.equal(q.people.length, 1, 'one person, not two'); const p = q.people[0]; assert.deepEqual([p.handles, p.intoHandle, p.spend, p.entitled, p.toAdd], [[x, y], x, 11, 1, 1], 'together £11; the bonus goes to the bigger spender');
  assert.equal((await api('POST', `/api/admin/benefits/${o.id}/grant`, { people: 'all' })).json.added, 1); assert.deepEqual((await bonusClaims(o.id)).map((c) => c.handle), [x]); assert.equal(person(await quals(o.id, true), y).given, 1, 'and it counts as given for the person, whichever handle you ask about');
});

test('ADDING THE BONUS: each qualifying person gets exactly what they are owed, as a SECURED free claim waiting to be ordered, tagged with the offer; it appears in To order and in their own orders at £0', async () => {
  const go = await goOrder(); const a = await item(go, 10); const o = await offer(go, { items: [a], extra: { quantity: 2 } }); const [p1, p2, p3] = [u('q1'), u('q2'), u('q3')]; const c1 = await joinerSession(app, `${p1}@x.com`, p1); await joinerSession(app, `${p2}@x.com`, p2); await joinerSession(app, `${p3}@x.com`, p3);
  await spendOn(p1, a, 3); await spendOn(p2, a, 1); const q = await quals(o.id); assert.deepEqual(q.people.map((p) => [p.intoHandle, p.toAdd]), [[p1, 6], [p2, 2]], 'biggest first; the person with no spend is not listed'); assert.deepEqual(q.totals, { qualifying: 2, toAdd: 8, over: 0 });
  const g = await api('POST', `/api/admin/benefits/${o.id}/grant`, { people: 'all' }); assert.equal(g.status, 200, g.text); assert.deepEqual([g.json.added, g.json.granted.length, g.json.failed.length], [8, 2, 0]);
  const claims = await bonusClaims(o.id); assert.equal(claims.length, 8); assert.ok(claims.every((c) => c.status === 'confirmed' && c.pipeline === 'awaiting fulfillment' && c.benefit_offer_id === o.id)); assert.equal(claims.filter((c) => c.handle === p1).length, 6);
  const toOrder = (await api('GET', '/api/admin/incoming/to-order')).json; assert.equal(toOrder.rows.filter((r) => r.itemId === o.bonus).reduce((n, r) => n + r.qty, 0), 8, 'they need ordering like anything else');
  const mine = (await api('GET', `/api/my/summary?handle=${p1}`, undefined, c1)).json; const bonus = mine.orders.flatMap((x) => x.claims).filter((c) => c.itemId === o.bonus || /photocard/i.test(c.label)); assert.equal(bonus.length, 6); assert.ok(bonus.every((c) => c.owed === 0), 'free: nothing to pay');
  const after = await quals(o.id); assert.deepEqual(after.people.map((p) => p.toAdd), [], 'nothing left to add'); assert.equal((await quals(o.id, true)).people.find((p) => p.handles.includes(p1)).given, 6);
});

test('PRESSING IT TWICE — or from two screens at the same moment — NEVER ADDS IT TWICE (what is owed is recomputed inside the locked step)', async () => {
  const go = await goOrder(); const a = await item(go, 10); const o = await offer(go, { items: [a] }); const h = u('dbl'); await joinerSession(app, `${h}@x.com`, h); await spendOn(h, a, 2);
  const runs = await Promise.all(Array.from({ length: 5 }, () => api('POST', `/api/admin/benefits/${o.id}/grant`, { people: 'all' }))); assert.ok(runs.every((r) => r.status === 200)); assert.equal(runs.reduce((n, r) => n + r.json.added, 0), 2, 'two photocards in total, however many times it was pressed'); assert.equal((await bonusClaims(o.id)).length, 2);
  const again = await api('POST', `/api/admin/benefits/${o.id}/grant`, { people: 'all' }); assert.deepEqual([again.json.added, again.json.granted], [0, []]);
});

test('ADD JUST SOME PEOPLE: only the people you pick (by key); unknown keys are ignored; bad input is refused', async () => {
  const go = await goOrder(); const a = await item(go, 10); const o = await offer(go, { items: [a] }); const [p1, p2] = [u('s1'), u('s2')]; await joinerSession(app, `${p1}@x.com`, p1); await joinerSession(app, `${p2}@x.com`, p2); await spendOn(p1, a); await spendOn(p2, a);
  const q = await quals(o.id); const key1 = q.people.find((p) => p.intoHandle === p1).key; const r = await api('POST', `/api/admin/benefits/${o.id}/grant`, { people: [key1, 'a99999999'] }); assert.deepEqual([r.json.added, r.json.granted.map((g) => g.handle)], [1, [p1]]);
  assert.deepEqual((await quals(o.id)).people.map((p) => p.intoHandle), [p2], 'the other person still qualifies');
  for (const bad of [[], ['x1'], 'some', [`${key1}; DROP`]]) assert.equal((await api('POST', `/api/admin/benefits/${o.id}/grant`, { people: bad })).status, 400); assert.equal((await api('POST', '/api/admin/benefits/99999999/grant', { people: 'all' })).status, 404);
});

test('IF SPEND LATER DROPS (a claim is cancelled) NOTHING IS TAKEN AWAY — they are flagged as "given more than they now qualify for"; cancelling a bonus claim makes them qualify again', async () => {
  const go = await goOrder(); const a = await item(go, 10); const o = await offer(go, { items: [a] }); const h = u('drop'); await joinerSession(app, `${h}@x.com`, h); await spendOn(h, a, 2); await api('POST', `/api/admin/benefits/${o.id}/grant`, { people: 'all' }); assert.equal((await bonusClaims(o.id)).length, 2);
  const [{ id: cid }] = await app.q("SELECT c.id FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.item_id = ? LIMIT 1", [h, a]); await app.q("UPDATE claims SET status = 'cancelled' WHERE id = ?", [cid]);
  const q = await quals(o.id); const p = q.people[0]; assert.deepEqual([p.entitled, p.given, p.toAdd, p.over], [1, 2, 0, 1], 'owed 1, has 2: one too many'); assert.deepEqual(q.totals, { qualifying: 0, toAdd: 0, over: 1 }); assert.equal((await bonusClaims(o.id)).length, 2, 'nothing was removed by itself');
  assert.equal((await api('POST', `/api/admin/benefits/${o.id}/grant`, { people: 'all' })).json.added, 0, 'and nothing more is added');
  const [{ id: bid }] = await bonusClaims(o.id); await app.q("UPDATE claims SET status = 'cancelled' WHERE id = ?", [bid]); const q2 = await quals(o.id, true); assert.deepEqual([q2.people[0].given, q2.people[0].toAdd, q2.people[0].over], [1, 0, 0], 'once the extra one is cancelled they are square'); assert.deepEqual((await quals(o.id)).people, [], 'and no longer listed as needing attention');
});

test('A BLOCKED HANDLE, AND A BONUS ITEM THAT IS FULL, FAIL FOR THAT PERSON ONLY (with the reason) — everyone else is still added', async () => {
  const go = await goOrder(); const a = await item(go, 10); const bonus = await item(go, 0, 'Limited bonus', { purchaseLimit: 1 }); const o = await offer(go, { items: [a], bonus }); const [ok, bad, extra] = [u('ok'), u('blk'), u('lim')];
  for (const h of [ok, bad, extra]) { await joinerSession(app, `${h}@x.com`, h); await spendOn(h, a); } await api('POST', '/api/admin/joiners/block', { handle: bad, reason: 'test' });
  const r = await api('POST', `/api/admin/benefits/${o.id}/grant`, { people: 'all' }); assert.equal(r.status, 200, r.text); const by = Object.fromEntries(r.json.failed.map((f) => [f.handle, f.error]));
  assert.match(by[bad], /is blocked — unblock them on the People tab first\./); assert.equal(r.json.granted.length + r.json.failed.length, 3); assert.equal(r.json.granted.length, 1, 'the bonus item has a limit of 1: only one person fits'); assert.match(Object.values(by).find((e) => /purchase limit/.test(e)), /reached its purchase limit/);
});

test('EDITING AN OFFER recalculates who qualifies (what was already given stays); changing it is validated the same way; it can only be deleted while nothing has been added from it', async () => {
  const go = await goOrder(); const a = await item(go, 10), b = await item(go, 15); const o = await offer(go, { items: [a] }); const h = u('edit'); await joinerSession(app, `${h}@x.com`, h); await spendOn(h, a, 2); await spendOn(h, b);
  assert.equal(person(await quals(o.id), h).toAdd, 2, '£20 on the ticked item, £10 amount'); assert.equal((await api('PATCH', `/api/admin/benefits/${o.id}`, { threshold: 20 })).status, 200); assert.equal(person(await quals(o.id), h).toAdd, 1);
  assert.equal((await api('PATCH', `/api/admin/benefits/${o.id}`, { itemIds: [a, b], quantity: 3 })).status, 200); assert.equal(person(await quals(o.id), h).toAdd, 3, '£35 → one £20 amount × 3'); assert.equal((await api('PATCH', `/api/admin/benefits/${o.id}`, { bonusItemId: a })).json.code, 'bonus_not_free');
  assert.equal((await api('PATCH', `/api/admin/benefits/${o.id}`, { threshold: 0 })).status, 400); await api('POST', `/api/admin/benefits/${o.id}/grant`, { people: 'all' }); const del = await api('DELETE', `/api/admin/benefits/${o.id}`); assert.deepEqual([del.status, del.json.code], [409, 'has_grants']); assert.match(del.json.error, /3 bonus claims were already added/);
  const empty = await offer(go, { items: [a] }); assert.equal((await api('DELETE', `/api/admin/benefits/${empty.id}`)).status, 200); assert.equal((await api('GET', `/api/admin/benefits/${empty.id}`)).status, 404);
});

test('"EVERYONE" SHOWS PROGRESS TOWARD THE NEXT AMOUNT for people who have not qualified yet (and the default list is only those who owe or are over)', async () => {
  const go = await goOrder(); const a = await item(go, 4); const o = await offer(go, { items: [a] }); const h = u('near'); await joinerSession(app, `${h}@x.com`, h); await spendOn(h, a, 2);
  assert.deepEqual((await quals(o.id)).people, [], 'not yet qualifying: not in the default list'); const all = await quals(o.id, true); assert.equal(all.everyone, 1); const p = all.people[0]; assert.deepEqual([p.spend, p.entitled, p.toAdd, p.toGo], [8, 0, 0, 2], '£2.00 to go');
});

test('THE LAUNCH RESET WIPES OFFERS TOO (they belong to the test group orders), and nothing is left pointing at them', async () => {
  const go = await goOrder(); const a = await item(go, 10); const o = await offer(go, { items: [a] }); const h = u('rst'); await joinerSession(app, `${h}@x.com`, h); await spendOn(h, a); await api('POST', `/api/admin/benefits/${o.id}/grant`, { people: 'all' }); assert.equal((await bonusClaims(o.id)).length, 1);
  const r = await api('POST', '/api/admin/launch/reset', { confirm: 'Reset', backupConfirmed: true, keepPeople: false }); assert.equal(r.status, 200, r.text);
  for (const t of ['benefit_offers', 'benefit_offer_items', 'claims', 'items', 'group_orders']) assert.equal((await app.q(`SELECT COUNT(*) AS n FROM ${t}`))[0].n, 0, `${t} is empty`);
});
