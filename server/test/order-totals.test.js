import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// CLAIMS TAB: the TOTAL item cost of a group order (what you pay the store / proxy), secured and still-requested kept apart — for cross-checking what you actually paid. Item cost only; cancelled claims never count.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ot') => `${x}${++N}`;
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Totals GO '), proxy: 'Sam' })).json.id;
const item = async (go, price = 10, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price, ...extra })).json.id;
const request = async (handle, itemId, extra = {}) => { const r = await app.api('POST', '/api/claims', { handle, allowDuplicates: true, lines: [{ itemId, ...extra }] }); assert.equal(r.status, 201, r.text); };
const totals = async (go, qs = '') => (await api('GET', `/api/admin/claims?order=${go}${qs}`)).json.orderTotals;
const idOf = async (handle, itemId) => (await app.q("SELECT c.id FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.item_id = ? AND c.status <> 'cancelled' ORDER BY c.id DESC LIMIT 1", [handle, itemId]))[0].id;

test('THE TOTAL: secured claims\' item cost (with what is paid and what is still owed), and the still-requested claims shown separately; cancelled claims and fees are not in it', async () => {
  const go = await goOrder(); const a = await item(go, 10); const [s1, s2, r1, r2, gone] = [u(), u(), u(), u(), u()];
  const [id1] = await claimAndSecure(app, admin, s1, a); await claimAndSecure(app, admin, s2, a); await request(r1, a); await request(r2, a); await request(gone, a); await app.q("UPDATE claims SET status = 'cancelled' WHERE id = ?", [await idOf(gone, a)]);
  await api('PATCH', `/api/admin/claims/${id1}`, { costs: { initials: { paid: 4 }, ems: { cost: 5, dueDate: '2099-01-01' } } });          // £4 paid on the item; an EMS fee that must NOT count
  assert.deepEqual(await totals(go), { secured: { claims: 2, cost: 20, paid: 4, owed: 16 }, requested: { claims: 2, cost: 20 }, tbcClaims: 0 });
  await api('POST', '/api/admin/claims/secure', { orderId: go }); assert.deepEqual(await totals(go), { secured: { claims: 4, cost: 40, paid: 4, owed: 36 }, requested: { claims: 0, cost: 0 }, tbcClaims: 0 }, 'securing moves claims from requested to secured');
});

test('EDITED PRICES, OVERPAYMENTS AND A SIZE\'S OWN PRICE ARE REFLECTED: the total is what the claims actually cost; an overpayment does not make "still owed" negative', async () => {
  const go = await goOrder(); const it = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'independent', title: u('Sleeves '), price: 0.55, members: ['43x67', { name: '70x110', price: 0.7 }] })).json.id; const [a, b] = [u(), u()];
  const [ca] = await claimAndSecure(app, admin, a, it, { member: '43x67' }); await claimAndSecure(app, admin, b, it, { member: '70x110' }); assert.deepEqual((await totals(go)).secured, { claims: 2, cost: 1.25, paid: 0, owed: 1.25 });
  await api('PATCH', `/api/admin/claims/${ca}`, { costs: { initials: { cost: 1, paid: 3 } } }); const t = (await totals(go)).secured; assert.deepEqual([t.cost, t.owed], [1.7, 0.7], 'the edited cost counts; the overpaid claim owes nothing (not a negative)'); assert.ok(t.paid >= 0.7 && t.paid <= 3.7);
});

test('A CLAIM WHOSE PRICE IS STILL TBC IS COUNTED AND FLAGGED (it adds £0 until the price is set)', async () => {
  const go = await goOrder(); const it = await item(go, undefined, { priceTbc: true, price: undefined }); const dropped = u(); await request(u(), it); await request(u(), it); await request(dropped, it); await app.q("UPDATE claims SET status = 'cancelled' WHERE id = ?", [await idOf(dropped, it)]); const t = await totals(go); assert.deepEqual([t.tbcClaims, t.requested.claims, t.requested.cost], [2, 2, 0], 'a cancelled TBC claim is not counted either');
});

test('IT IS THE WHOLE ORDER, whatever the list is filtered by; other group orders and shop (on-hand) items are never mixed in; without an order there is no total', async () => {
  const go = await goOrder(), other = await goOrder(); const a = await item(go, 10), o = await item(other, 99); const [x, y] = [u(), u()]; await claimAndSecure(app, admin, x, a); await request(y, a); await claimAndSecure(app, admin, u(), o);
  const sid = (await api('POST', '/api/admin/shop', { title: 'Shop thing', price: 7, qty: 3 })).json.id; await app.api('POST', '/api/claims', { handle: x, allowDuplicates: true, lines: [{ leftoverId: sid }] });
  const full = await totals(go); assert.deepEqual([full.secured.cost, full.requested.cost], [10, 10]); for (const qs of ['&status=requested', `&handle=${x}`, '&status=confirmed']) assert.deepEqual(await totals(go, qs), full, `unchanged by ${qs}`);
  assert.equal((await api('GET', '/api/admin/claims')).json.orderTotals, null, 'no group order chosen: no total');
});

test('ONLY THE GOM can see it (the same route as before)', async () => {
  const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await api('GET', '/api/admin/claims?order=1', undefined, j)).status, 403); assert.equal((await app.api('GET', '/api/admin/claims?order=1')).status, 401);
});

test('EVERY GROUP ORDER\'S ITEM COST COMES WITH THE LIST (for the cards): secured and requested per order, fees and cancelled claims excluded, the same figures as the single-order total, whatever the list is filtered by', async () => {
  const g1 = await goOrder(), g2 = await goOrder(), empty = await goOrder(); const a = await item(g1, 10), b = await item(g2, 3); const [s1, r1, gone, s2] = [u(), u(), u(), u()];
  const [id1] = await claimAndSecure(app, admin, s1, a); await request(r1, a); await request(gone, a); await app.q("UPDATE claims SET status = 'cancelled' WHERE id = ?", [await idOf(gone, a)]); await claimAndSecure(app, admin, s2, b); await api('PATCH', `/api/admin/claims/${id1}`, { costs: { ems: { cost: 9, dueDate: '2099-01-01' } } });
  const all = (await api('GET', '/api/admin/claims')).json.itemCostByOrder; assert.deepEqual([all[g1], all[g2], all[empty]], [{ secured: 10, requested: 10 }, { secured: 3, requested: 0 }, undefined], 'an order with no claims is simply absent');
  for (const qs of [`?order=${g1}`, '?status=requested', `?handle=${s1}`]) assert.deepEqual((await api('GET', `/api/admin/claims${qs}`)).json.itemCostByOrder, all, `unchanged by ${qs}`);
  const one = await totals(g1); assert.deepEqual([all[g1].secured, all[g1].requested], [one.secured.cost, one.requested.cost], 'the same figures as the single-order total');
});
