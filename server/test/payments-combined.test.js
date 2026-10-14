import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// ONE payment for all of a person's handles: split across the handles by what each owes, stored as one row per handle tied by a batch key, verified by the GOM as one.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'pc') => `${x}${++N}`;
const goOrder = async (title = u('Pay GO ')) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam' })).json.id;
const item = async (go, price) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price })).json.id;
async function person(...handles) { const email = `${u('p')}@x.com`; const cookie = await joinerSession(app, email, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200); return { cookie, handles, email }; }
const pay = (c, handle, body) => api('POST', `/api/my/payments?handle=${handle}`, { method: 'PayPal', reference: u('REF'), ...body }, c);
const rowsOf = async (batch) => app.q('SELECT p.id, j.instagram_handle AS handle, p.amount, p.status, p.overpay_amount AS overpay, p.overpay_choice AS choice, p.order_id AS orderId FROM payments p JOIN joiners j ON j.id = p.joiner_id WHERE p.batch_key = ? ORDER BY p.id', [batch]);
const owed = async (c, h) => (await api('GET', `/api/my/summary?handle=${h}`, undefined, c)).json.owed.total;
// a person with two handles that owe £10 and £6
async function owing(prices = [10, 6]) { const go = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const p = await person(a, b); await claimAndSecure(app, admin, a, await item(go, prices[0])); await claimAndSecure(app, admin, b, await item(go, prices[1])); return { ...p, a, b, go }; }

test('ONE PAYMENT, SPLIT ACROSS THE HANDLES by what each owes: one row per handle, one batch key, listed together', async () => {
  const { cookie, a, b } = await owing(); const r = await pay(cookie, 'all', { amount: 16 }); assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json.split, [{ handle: a, amount: 10 }, { handle: b, amount: 6 }]); assert.equal(r.json.ids.length, 2); assert.match(r.json.batchKey, /^[0-9a-f]{16}$/); assert.equal(r.json.extra, 0);
  const rows = await rowsOf(r.json.batchKey); assert.deepEqual(rows.map((x) => [x.handle, Number(x.amount), x.status]), [[a, 10, 'pending'], [b, 6, 'pending']]);
  const mine = (await api('GET', '/api/my/payments?handle=all', undefined, cookie)).json.payments; assert.deepEqual(mine.map((x) => [x.handle, x.amount]), [[b, 6], [a, 10]]);
});

test('A PARTIAL PAYMENT fills the oldest handle first; and paying for just ONE handle is unchanged (no batch)', async () => {
  const { cookie, a, b } = await owing(); const r = await pay(cookie, 'all', { amount: 12 }); assert.deepEqual(r.json.split, [{ handle: a, amount: 10 }, { handle: b, amount: 2 }]);
  const one = await pay(cookie, b, { amount: 3 }); assert.equal(one.status, 201); assert.equal(one.json.batchKey, undefined, 'a payment for one handle is just a payment'); assert.equal((await app.q('SELECT batch_key FROM payments WHERE id = ?', [one.json.id]))[0].batch_key, null);
});

test('SCOPED TO ONE GROUP ORDER: only what is owed on that order, across the handles, is split', async () => {
  const g1 = await goOrder('Order One'), g2 = await goOrder('Order Two'); const [a, b] = [u('ha'), u('hb')]; const { cookie } = await person(a, b);
  await claimAndSecure(app, admin, a, await item(g1, 5)); await claimAndSecure(app, admin, b, await item(g1, 7)); await claimAndSecure(app, admin, a, await item(g2, 20));
  const r = await pay(cookie, 'all', { amount: 12, orderId: g1 }); assert.equal(r.status, 201, r.text); assert.deepEqual(r.json.split, [{ handle: a, amount: 5 }, { handle: b, amount: 7 }]); assert.ok((await rowsOf(r.json.batchKey)).every((x) => x.orderId === g1));
  const over = await pay(cookie, 'all', { amount: 40, orderId: g2 }); assert.equal(over.status, 400); assert.match(over.json.error, /£20\.00 more than you owe/);
});

test('PAYING MORE THAN IS OWED needs the credit-or-tip choice; the extra rides on the first row', async () => {
  const { cookie, a, b } = await owing(); const no = await pay(cookie, 'all', { amount: 20 }); assert.equal(no.status, 400); assert.match(no.json.error, /£4\.00 more than you owe — choose whether that's credit for next time or a tip\./);
  const yes = await pay(cookie, 'all', { amount: 20, overpay: { choice: 'credit', note: 'ahead' } }); assert.equal(yes.status, 201); assert.equal(yes.json.extra, 4);
  const rows = await rowsOf(yes.json.batchKey); assert.deepEqual(rows.map((x) => [x.handle, Number(x.amount), Number(x.overpay || 0), x.choice]), [[a, 14, 4, 'credit'], [b, 6, 0, null]]); assert.equal(rows.reduce((n, x) => n + Number(x.amount), 0), 20, 'the rows add up to what they sent');
});

test('THE GOM VERIFIES IT AS ONE: both rows confirm, each handle\'s claims are paid, the extra becomes shared credit, and verifying twice is refused', async () => {
  const { cookie, a, b } = await owing(); const r = await pay(cookie, 'all', { amount: 20, overpay: { choice: 'credit' } });
  const v = await api('POST', `/api/admin/payments/batch/${r.json.batchKey}/verify`, {}); assert.equal(v.status, 200, v.text); assert.equal(v.json.verified, 2);
  assert.deepEqual((await rowsOf(r.json.batchKey)).map((x) => x.status), ['confirmed', 'confirmed']); assert.equal(await owed(cookie, a), 0); assert.equal(await owed(cookie, b), 0);
  const all = (await api('GET', '/api/my/summary?handle=all', undefined, cookie)).json; assert.deepEqual([all.owed.total, all.credit], [0, 4], 'paid in full, £4 left as credit');
  assert.equal((await api('POST', `/api/admin/payments/batch/${r.json.batchKey}/verify`, {})).status, 409);
  assert.equal((await api('POST', '/api/admin/payments/batch/nosuchbatch/verify', {})).status, 409);
});

test('ONE ROW CAN BE VERIFIED ON ITS OWN, then the rest of the batch finishes the job; the list shows each row\'s batch', async () => {
  const { cookie, a, b } = await owing(); const r = await pay(cookie, 'all', { amount: 16 });
  const listed = (await api('GET', '/api/admin/payments?status=pending')).json.payments.filter((p) => p.batchKey === r.json.batchKey); assert.deepEqual(listed.map((p) => [p.handle, p.amount]).sort(), [[a, 10], [b, 6]].sort());
  assert.equal((await api('POST', `/api/admin/payments/${r.json.ids[0]}/verify`, {})).status, 200); assert.equal(await owed(cookie, a), 0); assert.equal(await owed(cookie, b), 6);
  const rest = await api('POST', `/api/admin/payments/batch/${r.json.batchKey}/verify`, {}); assert.equal(rest.json.verified, 1); assert.equal(await owed(cookie, b), 0);
});

test('REJECTING THE BATCH rejects every pending part; nothing is applied', async () => {
  const { cookie, a, b } = await owing(); const r = await pay(cookie, 'all', { amount: 16 });
  const x = await api('POST', `/api/admin/payments/batch/${r.json.batchKey}/reject`, {}); assert.equal(x.status, 200); assert.equal(x.json.rejected, 2); assert.deepEqual((await rowsOf(r.json.batchKey)).map((p) => p.status), ['rejected', 'rejected']);
  assert.equal(await owed(cookie, a), 10); assert.equal(await owed(cookie, b), 6); assert.equal((await api('POST', `/api/admin/payments/${r.json.ids[0]}/verify`, {})).status, 409); assert.equal((await api('POST', `/api/admin/payments/batch/${r.json.batchKey}/reject`, {})).status, 409);
});

test('ONE EMAIL FOR ONE PAYMENT: nothing is sent until the whole batch is decided, then a single message with the total', async () => {
  const { cookie, a, b, email } = await owing(); assert.equal((await api('PUT', `/api/my/notifications?handle=${a}`, { enabled: true }, cookie)).status, 200);
  const mails = () => app.mailer.outbox.filter((m) => m.to === email && !/auth\/confirm/.test(m.text) && /Payment received/.test(m.subject || ''));
  const r = await pay(cookie, 'all', { amount: 16 }); await api('POST', `/api/admin/payments/${r.json.ids[0]}/verify`, {}); await app.notifier.idle(); assert.equal(mails().length, 0, 'half of it verified: nothing sent yet');
  await api('POST', `/api/admin/payments/${r.json.ids[1]}/verify`, {}); await app.notifier.idle(); assert.equal(mails().length, 1, 'all of it verified: one email'); assert.match(mails()[0].text, /Your payment of £16\.00 via PayPal/); assert.match(mails()[0].text, /You're all paid up\./);
  const r2 = await pay(cookie, 'all', { amount: 0.5 }); void r2;
  const { cookie: c2, email: e2, a: a2 } = await owing(); await api('PUT', `/api/my/notifications?handle=${a2}`, { enabled: true }, c2); const r3 = await pay(c2, 'all', { amount: 16 });
  await api('POST', `/api/admin/payments/batch/${r3.json.batchKey}/verify`, {}); await app.notifier.idle(); assert.equal(app.mailer.outbox.filter((m) => m.to === e2 && /Payment received/.test(m.subject || '')).length, 1, 'verifying the batch in one go is also one email');
});

test('A BLOCKED HANDLE IS NOT PAID FOR; a person with one handle can use "all"; nothing owing and bad input are refused; strangers cannot', async () => {
  const { cookie, a, b } = await owing(); await app.q('UPDATE joiners SET is_blocked = 1 WHERE instagram_handle = ?', [b]);
  const r = await pay(cookie, 'all', { amount: 10 }); assert.equal(r.status, 201, r.text); assert.equal(r.json.batchKey, undefined, 'one payer left: an ordinary payment');
  assert.deepEqual((await app.q('SELECT j.instagram_handle AS h, p.amount FROM payments p JOIN joiners j ON j.id = p.joiner_id WHERE p.id = ?', [r.json.id])).map((x) => [x.h, Number(x.amount)]), [[a, 10]], 'recorded against the unblocked handle');
  const flip = await owing(); await app.q('UPDATE joiners SET is_blocked = 1 WHERE instagram_handle = ?', [flip.a]);           // now the FIRST handle is the blocked one
  const f = await pay(flip.cookie, 'all', { amount: 6 }); assert.equal(f.status, 201, f.text); assert.equal((await app.q('SELECT j.instagram_handle AS h FROM payments p JOIN joiners j ON j.id = p.joiner_id WHERE p.id = ?', [f.json.id]))[0].h, flip.b, 'never recorded against a blocked handle');
  await app.q('UPDATE joiners SET is_blocked = 1 WHERE instagram_handle = ?', [flip.b]); const both = await pay(flip.cookie, 'all', { amount: 1 }); assert.equal(both.status, 403, 'every handle blocked: refused');
  const solo = u('hs'); const sc = (await person(solo)).cookie; await claimAndSecure(app, admin, solo, await item(await goOrder(), 9)); const s = await pay(sc, 'all', { amount: 9 }); assert.equal(s.status, 201); assert.equal(s.json.batchKey, undefined);
  const clean = await person(u('x1'), u('x2')); const none = await pay(clean.cookie, 'all', { amount: 5 }); assert.equal(none.status, 400); assert.match(none.json.error, /Nothing is owing right now/);
  await app.q("INSERT INTO payment_methods (method, account_info) VALUES ('PayPal', 'pay@example.com')");                 // once methods are listed, only those are accepted
  const t = await owing(); assert.equal((await pay(t.cookie, 'all', { amount: 5, method: 'Smoke signals' })).status, 400); assert.equal((await pay(t.cookie, 'all', { amount: -1 })).status, 400); assert.equal((await pay(t.cookie, solo, { amount: 5 })).status, 403, 'someone else\'s handle');
  assert.equal((await app.api('POST', '/api/my/payments?handle=all', { method: 'PayPal', amount: 5 })).status, 401);
});

test('VERIFYING A COMBINED PAYMENT KEEPS THE LEDGER CLEAN: every part is applied first, then the extra is recorded once — no credit bounced between the handles', async () => {
  const { cookie, a, b } = await owing(); const r = await pay(cookie, 'all', { amount: 20, overpay: { choice: 'credit' } });
  const v = await api('POST', `/api/admin/payments/batch/${r.json.batchKey}/verify`, {}); assert.equal(v.status, 200);
  assert.deepEqual([v.json.parts.reduce((n, x) => n + x.applied, 0), v.json.parts.reduce((n, x) => n + x.leftover, 0)], [16, 4], 'the toast figures: £16 applied, £4 left over (not £12 and £8)');
  const kinds = async (h) => (await app.q('SELECT l.kind FROM credit_ledger l JOIN joiners j ON j.id = l.joiner_id WHERE j.instagram_handle = ? ORDER BY l.id', [h])).map((x) => x.kind);
  assert.deepEqual(await kinds(a), ['credit'], 'one credit entry for the £4 extra'); assert.deepEqual(await kinds(b), [], 'and nothing at all on the other handle — no transfers, no applied entries');
});
