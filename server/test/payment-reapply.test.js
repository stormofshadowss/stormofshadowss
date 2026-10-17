import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// RE-APPLY a verified payment that went to the wrong items (applied before payments were ordered by due date): same money, put where it goes NOW. Totals owed never change.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); await app.q("INSERT IGNORE INTO payment_methods (method, account_info) VALUES ('PayPal', 'pay@example.com')"); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ra') => `${x}${++N}`;
const goOrder = async (title, deadline) => (await api('POST', '/api/admin/orders', { groupId: w.group, title: `${title} ${++N}`, proxy: 'Sam', paymentDeadline: deadline })).json.id;
const item = async (go, price, title) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price })).json.id;
async function person() { const h = u('re'); const cookie = await joinerSession(app, `${h}@x.com`, h); return { h, cookie }; }
const secure = async (h, itemId) => (await claimAndSecure(app, admin, h, itemId))[0];
const costs = (id, c) => api('PATCH', `/api/admin/claims/${id}`, { costs: c });
const pay = async (p, amount, extra = {}) => { const r = await api('POST', `/api/my/payments?handle=${p.h}`, { method: 'PayPal', amount, reference: u('TXN'), ...extra }, p.cookie); assert.equal(r.status, 201, r.text); const v = await api('POST', `/api/admin/payments/${r.json.id}/verify`, {}); assert.equal(v.status, 200, v.text); return r.json.id; };
const paid = async (h, label, cat = 'initials') => Number((await app.q('SELECT cc.paid FROM claim_costs cc JOIN claims c ON c.id = cc.claim_id JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.label = ? AND cc.category = ?', [h, label, cat]))[0]?.paid ?? 0);
const owedTotal = async (cookie, h) => (await api('GET', `/api/my/summary?handle=${h}`, undefined, cookie)).json.owed.total;
// Put a payment's money where the OLD behaviour would have: [[label, category, amount], …]
async function misapply(paymentId, h, placements) {
  const [{ id: jid }] = await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [h]);
  for (const a of await app.q('SELECT claim_id, category, amount FROM payment_allocations WHERE payment_id = ?', [paymentId])) await app.q('UPDATE claim_costs SET paid = paid - ? WHERE claim_id = ? AND category = ?', [a.amount, a.claim_id, a.category]);
  await app.q('DELETE FROM payment_allocations WHERE payment_id = ?', [paymentId]);
  for (const [label, category, amount] of placements) { const [{ id: cid }] = await app.q('SELECT id FROM claims WHERE joiner_id = ? AND label = ?', [jid, label]); await app.q('UPDATE claim_costs SET paid = paid + ? WHERE claim_id = ? AND category = ?', [amount, cid, category]); await app.q('INSERT INTO payment_allocations (payment_id, claim_id, category, amount) VALUES (?,?,?,?)', [paymentId, cid, category, amount]); }
}
const checksum = async () => Object.fromEntries((await app.q('CHECKSUM TABLE claim_costs, payment_allocations, claims, payments, credit_ledger')).map((r) => [String(r.Table).split('.').pop(), String(r.Checksum)]));
// the reported situation: £15 of an overdue Lee Know item cost (£10) and PCs EMS (£5) went onto the NEW Hyunjin magazine instead
async function reported() {
  const p = await person(); const fresh = await goOrder('Hyunjin GO', '2099-01-01'), old = await goOrder('Lee Know GO', '2000-01-01');
  await secure(p.h, await item(fresh, 15, 'Hyunjin magazine')); await secure(p.h, await item(old, 10, 'Lee Know magazine')); const pcs = await secure(p.h, await item(old, 6, 'PCs')); await costs(pcs, { initials: { cost: 6, paid: 6 }, ems: { cost: 5 } });
  const id = await pay(p, 15); await misapply(id, p.h, [['Hyunjin magazine', 'initials', 15]]); return { ...p, id };
}

test('THE REPORTED CASE IS FIXED: the £15 moves off the new Hyunjin magazine onto the overdue Lee Know item cost and PCs EMS — and what they owe in total does not change', async () => {
  const p = await reported(); const owedBefore = await owedTotal(p.cookie, p.h); assert.equal(await paid(p.h, 'Hyunjin magazine'), 15, 'starting point: the money is on the wrong item');
  const preview = await api('POST', `/api/admin/payments/${p.id}/reapply`, { dryRun: true }); assert.equal(preview.status, 200, preview.text); assert.deepEqual([preview.json.dryRun, preview.json.changed, preview.json.movedTotal, preview.json.total], [true, true, 15, 15]);
  assert.deepEqual(preview.json.moves.map((m) => [m.label, m.category, m.change]), [['Hyunjin magazine', 'initials', -15], ['Lee Know magazine', 'initials', 10], ['PCs', 'ems', 5]], 'what loses and what gains');
  const done = await api('POST', `/api/admin/payments/${p.id}/reapply`, {}); assert.equal(done.status, 200, done.text); assert.equal(done.json.dryRun, undefined);
  assert.deepEqual([await paid(p.h, 'Hyunjin magazine'), await paid(p.h, 'Lee Know magazine'), await paid(p.h, 'PCs', 'ems')], [0, 10, 5]); assert.equal(await owedTotal(p.cookie, p.h), owedBefore, 'the total owed is exactly what it was');
  const alloc = await app.q('SELECT c.label, pa.category, pa.amount FROM payment_allocations pa JOIN claims c ON c.id = pa.claim_id WHERE pa.payment_id = ? ORDER BY pa.id', [p.id]); assert.deepEqual(alloc.map((a) => [a.label, a.category, Number(a.amount)]), [['Lee Know magazine', 'initials', 10], ['PCs', 'ems', 5]], 'the record of where it went is corrected too');
  const s = (await api('GET', `/api/my/summary?handle=${p.h}`, undefined, p.cookie)).json; assert.equal(s.orders.flatMap((o) => o.claims).filter((c) => c.overdue).length, 0, 'nothing is overdue any more');
  const log = (await app.q("SELECT detail FROM audit_log WHERE action = 'payment.reapply' AND entity_id = ?", [p.id]))[0]; assert.match(String(log.detail), /"moved":15/);
});

test('THE PREVIEW CHANGES NOTHING, and doing it twice is harmless: the second time there is nothing to move and nothing is recorded', async () => {
  const p = await reported(); const before = await checksum(); assert.equal((await api('POST', `/api/admin/payments/${p.id}/reapply`, { dryRun: true })).status, 200); assert.deepEqual(await checksum(), before, 'the preview left every table exactly as it was');
  await api('POST', `/api/admin/payments/${p.id}/reapply`, {}); const after = await checksum(); const again = await api('POST', `/api/admin/payments/${p.id}/reapply`, {}); assert.deepEqual([again.status, again.json.changed, again.json.moves], [200, false, []]);
  assert.deepEqual(await checksum(), after, 'a second go changes nothing'); assert.equal((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.reapply' AND entity_id = ?", [p.id]))[0].n, 1, 'and is not recorded as a change');
});

test('A PAYMENT THAT IS ALREADY IN THE RIGHT PLACE is left alone ("nothing to move")', async () => {
  const p = await person(); const g = await goOrder('Fine GO', '2000-01-01'); await secure(p.h, await item(g, 10, 'Fine item')); const id = await pay(p, 10); const before = await checksum();
  const r = await api('POST', `/api/admin/payments/${id}/reapply`, {}); assert.deepEqual([r.status, r.json.changed, r.json.moves.length], [200, false, 0]); assert.deepEqual(await checksum(), before);
});

test('MONEY MOVED OFF AN ON-HAND ITEM THAT HAD BECOME "READY TO PACK" puts it back to waiting; the item it moves ONTO becomes ready when it is fully paid', async () => {
  const p = await person(); const old = await goOrder('Old GO', '2000-01-01'); await secure(p.h, await item(old, 10, 'Overdue album'));
  const sid = (await api('POST', '/api/admin/shop', { title: 'Shop sticker', price: 10, qty: 3 })).json.id; await app.api('POST', '/api/claims', { handle: p.h, lines: [{ leftoverId: sid, qty: 1 }] });
  const id = await pay(p, 10); const shopLabel = (await app.q("SELECT label FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.leftover_item_id IS NOT NULL", [p.h]))[0].label;
  assert.equal(await paid(p.h, 'Overdue album'), 10, 'with the corrected order the overdue album got the money'); await misapply(id, p.h, [[shopLabel, 'initials', 10]]);                           // the OLD, wrong placement: the shop item took it…
  await app.q("UPDATE claims SET pipeline = 'ready to pack / on hand', ready_to_pack_date = NOW() WHERE leftover_item_id IS NOT NULL AND joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)", [p.h]);        // …and so became ready to pack
  const r = await api('POST', `/api/admin/payments/${id}/reapply`, {}); assert.equal(r.status, 200, r.text);
  const [cl] = await app.q("SELECT pipeline, ready_to_pack_date FROM claims WHERE leftover_item_id IS NOT NULL AND joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)", [p.h]); assert.deepEqual([cl.pipeline, cl.ready_to_pack_date], ['awaiting fulfillment', null], 'no longer paid → back to waiting');
  assert.equal(await paid(p.h, 'Overdue album'), 10); assert.equal(await paid(p.h, shopLabel), 0);
});

test('CREDIT AND TIPS THE PAYMENT MADE ARE NOT TOUCHED (only the lines it paid are re-placed)', async () => {
  const p = await person(); const fresh = await goOrder('F GO', '2099-01-01'), old = await goOrder('O GO', '2000-01-01'); await secure(p.h, await item(fresh, 15, 'New thing')); await secure(p.h, await item(old, 10, 'Old thing'));
  const id = await pay(p, 30, { overpay: { choice: 'credit' } }); const credit = async () => Number((await app.q("SELECT COALESCE(SUM(balance_effect),0) AS c FROM credit_ledger WHERE joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)", [p.h]))[0].c);
  const c0 = await credit(); await misapply(id, p.h, [['New thing', 'initials', 15], ['Old thing', 'initials', 10]]); const r = await api('POST', `/api/admin/payments/${id}/reapply`, {}); assert.equal(r.status, 200, r.text); assert.equal(await credit(), c0, 'the credit is exactly as it was'); assert.equal(await paid(p.h, 'Old thing') + await paid(p.h, 'New thing'), 25);
});

test('IT REFUSES, CHANGING NOTHING, IF WHAT THE PAYMENT PAID HAS SINCE CHANGED, or if it is not a verified payment; GOM only', async () => {
  const p = await reported(); await app.q("UPDATE claim_costs SET paid = 5 WHERE claim_id = (SELECT id FROM claims WHERE label = 'Hyunjin magazine' AND joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)) AND category = 'initials'", [p.h]);
  const before = await checksum(); const r = await api('POST', `/api/admin/payments/${p.id}/reapply`, {}); assert.deepEqual([r.status, r.json.code], [409, 'cannot_reapply']); assert.deepEqual(await checksum(), before, 'a refusal changes nothing');
  const q = await person(); const g = await goOrder('P GO', '2099-01-01'); await secure(q.h, await item(g, 9, 'Pending item')); const pend = await api('POST', `/api/my/payments?handle=${q.h}`, { method: 'PayPal', amount: 9, reference: u('P') }, q.cookie);
  assert.deepEqual([(await api('POST', `/api/admin/payments/${pend.json.id}/reapply`, {})).status, (await api('POST', `/api/admin/payments/${pend.json.id}/reapply`, {})).json.code], [409, 'not_confirmed'], 'still waiting');
  await api('POST', `/api/admin/payments/${pend.json.id}/verify`, {}); await api('POST', `/api/admin/payments/${pend.json.id}/reverse`, {}); assert.equal((await api('POST', `/api/admin/payments/${pend.json.id}/reapply`, {})).json.code, 'not_confirmed', 'failed payments cannot be re-applied');
  assert.equal((await api('POST', '/api/admin/payments/99999999/reapply', {})).status, 404); const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await api('POST', `/api/admin/payments/${p.id}/reapply`, {}, j)).status, 403); assert.equal((await app.api('POST', `/api/admin/payments/${p.id}/reapply`, {})).status, 401);
});

test('A COMBINED PAYMENT (one transfer across handles) IS RE-APPLIED AS ONE: every verified part, each handle\'s money put where it goes now', async () => {
  const [x, y] = [u('ha'), u('hb')]; const cookie = await joinerSession(app, `${x}@x.com`, x); await api('POST', '/api/me/handles', { handle: y }, cookie); const fresh = await goOrder('C new', '2099-01-01'), old = await goOrder('C old', '2000-01-01');
  await secure(x, await item(fresh, 20, 'X new')); await secure(x, await item(old, 10, 'X old')); await secure(y, await item(fresh, 20, 'Y new')); await secure(y, await item(old, 5, 'Y old'));
  const c = await api('POST', '/api/my/payments?handle=all', { method: 'PayPal', amount: 15, reference: u('CO') }, cookie); await api('POST', `/api/admin/payments/batch/${c.json.batchKey}/verify`, {});
  const rows = await app.q('SELECT id, joiner_id FROM payments WHERE batch_key = ? ORDER BY id', [c.json.batchKey]); assert.equal(rows.length, 2); await misapply(rows[0].id, x, [['X new', 'initials', 10]]); await misapply(rows[1].id, y, [['Y new', 'initials', 5]]);
  const r = await api('POST', `/api/admin/payments/${rows[1].id}/reapply`, {}); assert.equal(r.status, 200, r.text); assert.deepEqual(r.json.payments.map((p) => p.amount), [10, 5], 'both parts were re-applied');
  assert.deepEqual([await paid(x, 'X old'), await paid(x, 'X new'), await paid(y, 'Y old'), await paid(y, 'Y new')], [10, 0, 5, 0]);
});

test('A PAYMENT CHOSEN FOR ONE GROUP ORDER STAYS INSIDE THAT ORDER when re-applied', async () => {
  const p = await person(); const a = await goOrder('Scope A', '2099-02-01'), b = await goOrder('Scope B', '2000-02-01'); await secure(p.h, await item(a, 10, 'In A late')); await secure(p.h, await item(a, 10, 'In A also')); await secure(p.h, await item(b, 10, 'In B overdue'));
  const id = await pay(p, 10, { orderId: a }); await misapply(id, p.h, [['In A also', 'initials', 10]]); const r = await api('POST', `/api/admin/payments/${id}/reapply`, {}); assert.equal(r.status, 200, r.text);
  assert.deepEqual([await paid(p.h, 'In A late'), await paid(p.h, 'In A also'), await paid(p.h, 'In B overdue')], [10, 0, 0], 'within order A (the overdue item in B is not touched — they chose A)');
});
