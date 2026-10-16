import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// A payment the GOM verified can fail days later. Marking it failed puts things back: what it paid off is owed again; credit it created is taken back (and if that credit was
// already spent, those items are owed again too). No email — the GOM tells the person.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'rv') => `${x}${++N}`;
const goOrder = async (extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Rev GO '), proxy: 'Sam', ...extra })).json.id;
const item = async (go, price) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price })).json.id;
async function person(...handles) { const email = `${u('p')}@x.com`; const cookie = await joinerSession(app, email, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200); return { cookie, handles, email }; }
const owes = async (c, h = 'all') => (await api('GET', `/api/my/summary?handle=${h}`, undefined, c)).json;
const sendAndVerify = async (c, h, amount, extra = {}) => { const r = await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount, reference: u('TXN'), ...extra }, c); assert.equal(r.status, 201, r.text); const v = r.json.batchKey ? await api('POST', `/api/admin/payments/batch/${r.json.batchKey}/verify`, {}) : await api('POST', `/api/admin/payments/${r.json.id}/verify`, {}); assert.equal(v.status, 200, v.text); return r.json; };
const reverse = (id, body = {}) => api('POST', `/api/admin/payments/${id}/reverse`, body);
const status = async (id) => (await app.q('SELECT status, reversed_at, reverse_reason FROM payments WHERE id = ?', [id]))[0];
const ledgerKinds = async (h) => (await app.q('SELECT l.kind, l.balance_effect AS e FROM credit_ledger l JOIN joiners j ON j.id = l.joiner_id WHERE j.instagram_handle = ? ORDER BY l.id', [h])).map((x) => [x.kind, Number(x.e)]);
// someone who owes £12 + £8
async function twoItems() { const h = u('payer'); const p = await person(h); const go = await goOrder(); await claimAndSecure(app, admin, h, await item(go, 12)); await claimAndSecure(app, admin, h, await item(go, 8)); return { h, ...p, go }; }

test('A FAILED PAYMENT PUTS WHAT IT PAID OFF BACK: the items are owed again, the payment is kept as "reversed" with the reason, and nothing is emailed', async () => {
  const { h, cookie, email } = await twoItems(); await api('PUT', `/api/my/notifications?handle=${h}`, { enabled: true }, cookie); const pay = await sendAndVerify(cookie, h, 20); assert.equal((await owes(cookie, h)).owed.total, 0);
  const mails = app.mailer.outbox.length; const r = await reverse(pay.id, { reason: 'Bank transfer bounced' }); assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.owedAgainTotal, r.json.owedAgain.length, r.json.creditRemoved, r.json.notRecovered], [20, 2, 0, 0]); assert.equal((await owes(cookie, h)).owed.total, 20, 'they owe it again');
  const st = await status(pay.id); assert.equal(st.status, 'reversed'); assert.equal(st.reverse_reason, 'Bank transfer bounced'); assert.ok(st.reversed_at);
  await app.notifier.idle(); assert.equal(app.mailer.outbox.length, mails, 'no email is sent: the GOM messages them'); void email;
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.reverse'"))[0].n >= 1, true);
  const mine = (await api('GET', `/api/my/payments?handle=${h}`, undefined, cookie)).json.payments[0]; assert.equal(mine.status, 'reversed', 'and the person can see it failed');
});

test('A PREVIEW CHANGES NOTHING: it reports exactly what would happen (and is the same figures as doing it)', async () => {
  const { h, cookie } = await twoItems(); const pay = await sendAndVerify(cookie, h, 20);
  const dry = await reverse(pay.id, { dryRun: true }); assert.equal(dry.status, 200); assert.deepEqual([dry.json.dryRun, dry.json.owedAgainTotal, dry.json.owedAgain.map((o) => o.amount).sort((a, b) => a - b)], [true, 20, [8, 12]]);
  assert.equal((await status(pay.id)).status, 'confirmed', 'still verified'); assert.equal((await owes(cookie, h)).owed.total, 0, 'still paid'); const real = await reverse(pay.id); assert.deepEqual([real.json.owedAgainTotal, real.json.owedAgain.length], [dry.json.owedAgainTotal, dry.json.owedAgain.length]);
});

test('A PART-PAYMENT: only what that payment paid is owed again', async () => {
  const { h, cookie } = await twoItems(); const a = await sendAndVerify(cookie, h, 12); assert.equal((await owes(cookie, h)).owed.total, 8);
  const r = await reverse(a.id); assert.equal(r.json.owedAgainTotal, 12); assert.equal((await owes(cookie, h)).owed.total, 20);
});

test('AN OVERPAYMENT KEPT AS CREDIT: the credit it created is taken back; a TIP is noted as not received', async () => {
  const a = await person(u('ov')); const go = await goOrder(); await claimAndSecure(app, admin, a.handles[0], await item(go, 10)); const p1 = await sendAndVerify(a.cookie, a.handles[0], 15, { overpay: { choice: 'credit' } });
  assert.equal((await owes(a.cookie, a.handles[0])).credit, 5); const r = await reverse(p1.id); assert.deepEqual([r.json.owedAgainTotal, r.json.creditRemoved, r.json.notRecovered], [10, 5, 0]); const after = await owes(a.cookie, a.handles[0]); assert.deepEqual([after.owed.total, after.credit], [10, 0]);
  assert.deepEqual((await ledgerKinds(a.handles[0])).slice(-1), [['removed', -5]], 'a clear ledger entry for the credit that was taken back');
  const t = await person(u('tip')); const go2 = await goOrder(); await claimAndSecure(app, admin, t.handles[0], await item(go2, 10)); const p2 = await sendAndVerify(t.cookie, t.handles[0], 13, { overpay: { choice: 'tip', note: 'thanks' } });
  const r2 = await reverse(p2.id); assert.deepEqual([r2.json.tipsNotReceived, r2.json.creditRemoved, r2.json.owedAgainTotal], [3, 0, 10]);
});

test('CREDIT THAT HAS ALREADY BEEN SPENT: the items it paid for are owed again too, so nobody keeps the benefit of a payment that never arrived', async () => {
  const a = await person(u('sp')); const h = a.handles[0]; const go = await goOrder(); await claimAndSecure(app, admin, h, await item(go, 10)); const pay = await sendAndVerify(a.cookie, h, 15, { overpay: { choice: 'credit' } });
  const [claimB] = await claimAndSecure(app, admin, h, await item(go, 5));                                                               // the £5 credit pays for this at once
  const before = await owes(a.cookie, h); assert.deepEqual([before.owed.total, before.credit], [0, 0], 'all paid: £10 by the payment, £5 by the credit');
  const dry = await reverse(pay.id, { dryRun: true }); assert.deepEqual([dry.json.owedAgainTotal, dry.json.creditSpentUndone, dry.json.creditRemoved, dry.json.notRecovered], [15, 5, 0, 0]);
  const r = await reverse(pay.id, { reason: 'Chargeback' }); assert.equal(r.status, 200); assert.ok(r.json.owedAgain.some((o) => o.claimId === claimB && o.creditHadBeenSpent && o.amount === 5), 'the item the credit paid for is named');
  const after = await owes(a.cookie, h); assert.deepEqual([after.owed.total, after.credit], [15, 0]);
  assert.ok((await ledgerKinds(h)).some(([k, e]) => k === 'removed' && e === 0), 'a memo entry says that credit had been spent');
});

test('CREDIT ONLY PARTLY SPENT: the unspent part is taken back and the spent part is owed again', async () => {
  const a = await person(u('pt')); const h = a.handles[0]; const go = await goOrder(); await claimAndSecure(app, admin, h, await item(go, 10)); const pay = await sendAndVerify(a.cookie, h, 15, { overpay: { choice: 'credit' } });
  await claimAndSecure(app, admin, h, await item(go, 3)); assert.equal((await owes(a.cookie, h)).credit, 2);
  const r = await reverse(pay.id); assert.deepEqual([r.json.creditRemoved, r.json.creditSpentUndone, r.json.owedAgainTotal, r.json.notRecovered], [2, 3, 13, 0]); const after = await owes(a.cookie, h); assert.deepEqual([after.owed.total, after.credit], [13, 0]);
});

test('CREDIT SHARED ACROSS HANDLES: if the failed payment\'s extra credit went to pay another handle\'s item, that item is owed again', async () => {
  const [a, b] = [u('ha'), u('hb')]; const p = await person(a, b); const go = await goOrder(); await claimAndSecure(app, admin, a, await item(go, 10));
  const pay = await sendAndVerify(p.cookie, a, 16, { overpay: { choice: 'credit' } });                                                  // £6 extra on @a
  await claimAndSecure(app, admin, b, await item(go, 6));                                                                              // @a's £6 credit moves across and pays @b's item
  assert.deepEqual([(await owes(p.cookie, 'all')).owed.total, (await owes(p.cookie, 'all')).credit], [0, 0]);
  const r = await reverse(pay.id); assert.equal(r.status, 200, r.text); assert.deepEqual([r.json.owedAgainTotal, r.json.creditSpentUndone, r.json.notRecovered], [16, 6, 0]); const all = await owes(p.cookie, 'all'); assert.deepEqual([all.owed.total, all.credit], [16, 0]);
  assert.equal((await owes(p.cookie, b)).owed.total, 6, 'the item on the OTHER handle is owed again');
});

test('A COMBINED PAYMENT FAILS AS ONE: every verified part is reversed and any part still waiting is rejected', async () => {
  const [a, b] = [u('ha'), u('hb')]; const p = await person(a, b); const go = await goOrder(); await claimAndSecure(app, admin, a, await item(go, 10)); await claimAndSecure(app, admin, b, await item(go, 6));
  const pay = await api('POST', '/api/my/payments?handle=all', { method: 'PayPal', amount: 16, reference: u('COMBO') }, p.cookie); assert.equal(pay.status, 201); assert.equal((await api('POST', `/api/admin/payments/${pay.json.ids[0]}/verify`, {})).status, 200);   // only the first part verified so far
  const r = await reverse(pay.json.ids[1]); assert.equal(r.status, 200, r.text); assert.equal(r.json.rejectedParts, 1); assert.deepEqual((await app.q('SELECT status FROM payments WHERE batch_key = ? ORDER BY id', [pay.json.batchKey])).map((x) => x.status), ['reversed', 'rejected']);
  assert.equal((await owes(p.cookie, 'all')).owed.total, 16);
  const p2 = await person(u('c1'), u('c2')); const g2 = await goOrder(); await claimAndSecure(app, admin, p2.handles[0], await item(g2, 4)); await claimAndSecure(app, admin, p2.handles[1], await item(g2, 5));
  const b2 = await sendAndVerify(p2.cookie, 'all', 9); const r2 = await reverse(b2.id); assert.equal(r2.json.payments.length, 2, 'both parts'); assert.deepEqual((await app.q('SELECT status FROM payments WHERE batch_key = ?', [b2.batchKey])).map((x) => x.status), ['reversed', 'reversed']); assert.equal((await owes(p2.cookie, 'all')).owed.total, 9);
});

test('CREDIT THEY HOLD FROM ELSEWHERE then applies to what is owed again (it is theirs, from another source)', async () => {
  const a = await person(u('el')); const h = a.handles[0]; const go = await goOrder(); await claimAndSecure(app, admin, h, await item(go, 10)); const pay = await sendAndVerify(a.cookie, h, 10);
  assert.equal((await api('POST', '/api/admin/credit/add', { handle: h, amount: 4, reason: 'Goodwill' })).status, 200); assert.equal((await owes(a.cookie, h)).credit, 4);
  const r = await reverse(pay.id); assert.equal(r.status, 200); const after = await owes(a.cookie, h); assert.deepEqual([after.owed.total, after.credit], [6, 0], '£10 owed again, £4 of their own credit applied');
});

test('ONLY A VERIFIED PAYMENT CAN FAIL: a waiting, rejected or already-reversed one is refused; unknown ids; GOM only; and sending it again afterwards is NOT a "repeat"', async () => {
  const { h, cookie } = await twoItems(); const waiting = await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount: 5, reference: 'WAIT-1' }, cookie); const w1 = await reverse(waiting.json.id); assert.equal(w1.status, 409); assert.equal(w1.json.code, 'not_confirmed');
  await api('POST', `/api/admin/payments/${waiting.json.id}/reject`, {}); assert.equal((await reverse(waiting.json.id)).status, 409);
  const done = await sendAndVerify(cookie, h, 20); assert.equal((await reverse(done.id)).status, 200); const again = await reverse(done.id); assert.equal(again.status, 409); assert.equal(again.json.code, 'already_reversed');
  assert.equal((await reverse(999999)).status, 404); const j = await app.login(`${u('jj')}@x.com`); assert.equal((await api('POST', `/api/admin/payments/${done.id}/reverse`, {}, j)).status, 403); assert.equal((await app.api('POST', `/api/admin/payments/${done.id}/reverse`, {})).status, 401);
  const ref = (await app.q('SELECT reference FROM payments WHERE id = ?', [done.id]))[0].reference; const resend = await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount: 20, reference: ref }, cookie); assert.equal(resend.status, 201, 'the same transaction ID after it failed is a new attempt, not a repeat');
});

test('TWO REVERSALS AT ONCE: exactly one happens, the money is put back once', async () => {
  const { h, cookie } = await twoItems(); const pay = await sendAndVerify(cookie, h, 20); const rs = await Promise.all([reverse(pay.id), reverse(pay.id), reverse(pay.id)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]); assert.equal((await owes(cookie, h)).owed.total, 20, 'owed once, not three times');
});

test('IT SHOWS ON THE PACKING SCREEN AND AS OVERDUE: an item already in a parcel is owed again (the packing warning appears), and past its pay-by date it is overdue', async () => {
  const late = await goOrder({ paymentDeadline: '2000-01-01' }); const h = u('late'); const p = await person(h); const [id] = await claimAndSecure(app, admin, h, await item(late, 9)); const pay = await sendAndVerify(p.cookie, h, 9);
  await api('PUT', `/api/my/address?handle=${h}`, { fullName: 'L T', address: '1 Road, Leeds LS1 1AA', email: `${h}@x.com`, phone: '07000 123456' }, p.cookie); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' });
  const par = await api('POST', `/api/my/parcels?handle=${h}`, { claimIds: [id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p.cookie); assert.equal(par.status, 201, par.text);
  assert.equal((await reverse(pay.id)).status, 200); const pk = (await api('GET', '/api/admin/packing?status=requested')).json.parcels.find((x) => x.id === par.json.id); assert.ok(pk.owing.length && pk.owing[0].total === 9, 'the packing screen warns it is not paid');
  const s = await owes(p.cookie, h); assert.equal(s.orders[0].claims[0].overdue, true, 'and it is overdue again (the pay-by date has passed)');
});
