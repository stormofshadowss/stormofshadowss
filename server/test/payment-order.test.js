import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// A payment (or credit) clears what is DUE FIRST: the earliest pay-by date, so overdue comes before anything newer — whatever order the claims were created in. Ties: older claim, then item/EMS/customs/postage/packaging.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); await app.q("INSERT IGNORE INTO payment_methods (method, account_info) VALUES ('PayPal', 'pay@example.com')"); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'po') => `${x}${++N}`;
const goOrder = async (title, deadline) => (await api('POST', '/api/admin/orders', { groupId: w.group, title: `${title} ${++N}`, proxy: 'Sam', ...(deadline ? { paymentDeadline: deadline } : {}) })).json.id;
const item = async (go, price, title, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price, ...extra })).json.id;
async function person() { const h = u('pay'); const cookie = await joinerSession(app, `${h}@x.com`, h); return { h, cookie }; }
const secure = async (h, itemId) => (await claimAndSecure(app, admin, h, itemId))[0];
const costs = (id, c) => api('PATCH', `/api/admin/claims/${id}`, { costs: c });
const lines = async (h) => Object.fromEntries((await app.q(`SELECT c.label, cc.category, cc.cost, cc.paid FROM claim_costs cc JOIN claims c ON c.id = cc.claim_id JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? ORDER BY c.id`, [h])).map((r) => [`${r.label}|${r.category}`, { cost: Number(r.cost), paid: Number(r.paid) }]));
const paidOf = (ls, k) => ls[k]?.paid ?? 0;
const payAndVerify = async (p, amount, extra = {}) => { const r = await api('POST', `/api/my/payments?handle=${p.h}`, { method: 'PayPal', amount, reference: u('TXN'), ...extra }, p.cookie); assert.equal(r.status, 201, r.text); const v = await api('POST', `/api/admin/payments/${r.json.id}/verify`, {}); assert.equal(v.status, 200, v.text); return r.json.id; };

test('THE REPORTED CASE: a newer item claimed (lowest claim number) while older lines are overdue — the payment clears the OVERDUE lines (item cost and EMS), not the new item', async () => {
  const p = await person(); const fresh = await goOrder('Hyunjin GO', '2099-01-01'), old = await goOrder('Lee Know GO', '2000-01-01');
  await secure(p.h, await item(fresh, 15, 'Hyunjin magazine'));                                              // claimed FIRST → the lowest claim number, but not due until 2099
  await secure(p.h, await item(old, 10, 'Lee Know magazine'));                                              // overdue (due 2000)
  const pcs = await secure(p.h, await item(old, 6, 'PCs')); await costs(pcs, { initials: { cost: 6, paid: 6 }, ems: { cost: 5 } });      // its item cost is paid; its EMS (£5) is overdue
  await payAndVerify(p, 15); const ls = await lines(p.h);
  assert.deepEqual([paidOf(ls, 'Lee Know magazine|initials'), paidOf(ls, 'PCs|ems'), paidOf(ls, 'Hyunjin magazine|initials')], [10, 5, 0], 'the £15 went to the overdue item cost and the overdue EMS — NOT to the new Hyunjin magazine');
  const alloc = await app.q('SELECT c.label, pa.category, pa.amount FROM payment_allocations pa JOIN claims c ON c.id = pa.claim_id JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? ORDER BY pa.id', [p.h]);
  assert.deepEqual(alloc.map((a) => [a.label, a.category, Number(a.amount)]), [['Lee Know magazine', 'initials', 10], ['PCs', 'ems', 5]]); const s = (await api('GET', `/api/my/summary?handle=${p.h}`, undefined, p.cookie)).json;
  assert.deepEqual([s.owed.total, s.orders.flatMap((o) => o.claims).filter((c) => c.overdue).length], [15, 0], 'what is left is only the new item, and nothing is overdue any more');
});

test('A PART-PAYMENT goes to the EARLIEST due date first, then the next: £7 clears part of the oldest, nothing newer', async () => {
  const p = await person(); const d3 = await goOrder('Due 2099', '2099-05-01'), d1 = await goOrder('Due 2000', '2000-01-01'), d2 = await goOrder('Due 2010', '2010-01-01');
  await secure(p.h, await item(d3, 10, 'Third')); await secure(p.h, await item(d1, 10, 'First')); await secure(p.h, await item(d2, 10, 'Second'));          // created in the order Third, First, Second
  await payAndVerify(p, 7); let ls = await lines(p.h); assert.deepEqual([paidOf(ls, 'First|initials'), paidOf(ls, 'Second|initials'), paidOf(ls, 'Third|initials')], [7, 0, 0]);
  await payAndVerify(p, 8); ls = await lines(p.h); assert.deepEqual([paidOf(ls, 'First|initials'), paidOf(ls, 'Second|initials'), paidOf(ls, 'Third|initials')], [10, 5, 0], 'finish the oldest, then the next-oldest, newest untouched');
});

test('AN ITEM\'S OWN (earlier) PAY-BY DATE counts, a claim with NO due date comes last, and equal dates go to the older claim then item → EMS → customs → postage → packaging', async () => {
  const p = await person(); const g = await goOrder('Shared GO', '2099-06-01'), none = await goOrder('No date GO'); const early = await item(g, 10, 'Early item', { paymentDeadline: '2001-01-01' });
  await secure(p.h, await item(none, 10, 'No date')); await secure(p.h, await item(g, 10, 'Same date B')); await secure(p.h, early);                         // ids: No date < Same date B < Early item
  await payAndVerify(p, 10); let ls = await lines(p.h); assert.deepEqual([paidOf(ls, 'Early item|initials'), paidOf(ls, 'Same date B|initials'), paidOf(ls, 'No date|initials')], [10, 0, 0], 'the item with its own earlier date first');
  await payAndVerify(p, 10); ls = await lines(p.h); assert.deepEqual([paidOf(ls, 'Same date B|initials'), paidOf(ls, 'No date|initials')], [10, 0], 'then the dated one, before the one with no date');
  const q = await person(); const g2 = await goOrder('Tie GO', '2050-01-01'); const [a, b] = [await secure(q.h, await item(g2, 10, 'Tie one')), await secure(q.h, await item(g2, 10, 'Tie two'))]; await costs(a, { ems: { cost: 4, dueDate: '2050-01-01' }, customs: { cost: 3, dueDate: '2050-01-01' }, doms: { cost: 2, dueDate: '2050-01-01' }, packaging: { cost: 1, dueDate: '2050-01-01' } }); void b;          // the fees share the item's due date, so the old tie-break (item → EMS → customs → postage → packaging) applies
  await payAndVerify(q, 12); const lq = await lines(q.h); assert.deepEqual(['initials', 'ems', 'customs', 'doms', 'packaging'].map((c) => paidOf(lq, `Tie one|${c}`)), [10, 2, 0, 0, 0], 'same due date: the older claim is cleared item-cost-then-EMS-then… before the next claim'); assert.equal(paidOf(lq, 'Tie two|initials'), 0);
});

test('CREDIT FOLLOWS THE SAME RULE: credit given to someone clears what is overdue before newer items', async () => {
  const p = await person(); const fresh = await goOrder('New GO', '2099-01-01'), old = await goOrder('Old GO', '2000-01-01'); await secure(p.h, await item(fresh, 10, 'New thing')); await secure(p.h, await item(old, 10, 'Old thing'));
  assert.equal((await api('POST', '/api/admin/credit/add', { handle: p.h, amount: 6, reason: 'Goodwill' })).status, 200); const ls = await lines(p.h);
  assert.deepEqual([paidOf(ls, 'Old thing|initials'), paidOf(ls, 'New thing|initials')], [6, 0], 'the credit went to the overdue item');
});

test('A PAYMENT FOR ONE GROUP ORDER still stays inside that order (and is ordered by due date within it); a combined payment across handles follows the same rule per handle', async () => {
  const p = await person(); const a = await goOrder('Scope A', '2099-02-01'), b = await goOrder('Scope B', '2000-02-01'); await secure(p.h, await item(a, 10, 'In A')); await secure(p.h, await item(b, 10, 'In B'));
  const r = await api('POST', `/api/my/payments?handle=${p.h}`, { method: 'PayPal', amount: 4, reference: u('SC'), orderId: a }, p.cookie); await api('POST', `/api/admin/payments/${r.json.id}/verify`, {}); const ls = await lines(p.h);
  assert.deepEqual([paidOf(ls, 'In A|initials'), paidOf(ls, 'In B|initials')], [4, 0], 'the scoped payment stayed in order A even though B is overdue (the person chose that order)');
  const [x, y] = [u('ha'), u('hb')]; const cookie = await joinerSession(app, `${x}@x.com`, x); await api('POST', '/api/me/handles', { handle: y }, cookie); const g1 = await goOrder('Combo new', '2099-03-01'), g0 = await goOrder('Combo old', '2000-03-01');
  await secure(x, await item(g1, 10, 'X new')); await secure(x, await item(g0, 10, 'X old')); await secure(y, await item(g1, 5, 'Y new')); await secure(y, await item(g0, 5, 'Y old'));
  const c = await api('POST', '/api/my/payments?handle=all', { method: 'PayPal', amount: 15, reference: u('CO') }, cookie); assert.equal(c.status, 201, c.text); assert.deepEqual(c.json.split, [{ handle: x, amount: 10 }, { handle: y, amount: 5 }], 'the £15 is split to cover what is OVERDUE on each handle');
  await api('POST', `/api/admin/payments/batch/${c.json.batchKey}/verify`, {}); let lx = await lines(x), ly = await lines(y); assert.deepEqual([paidOf(lx, 'X old|initials'), paidOf(lx, 'X new|initials'), paidOf(ly, 'Y old|initials'), paidOf(ly, 'Y new|initials')], [10, 0, 5, 0], 'overdue first, on both handles');
  const c2 = await api('POST', '/api/my/payments?handle=all', { method: 'PayPal', amount: 4, reference: u('CO') }, cookie); assert.deepEqual(c2.json.split, [{ handle: x, amount: 4 }], 'then the next-due, on whichever handle it is');
});
