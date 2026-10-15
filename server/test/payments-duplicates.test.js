import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// A double-tap or a retry must not record the same payment twice: an exact repeat (same transaction ID within a week, or an identical request within two minutes) is recognised.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'dp') => `${x}${++N}`;
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Dup GO '), proxy: 'Sam' })).json.id;
const item = async (go, price) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price })).json.id;
async function person(...handles) { const email = `${u('p')}@x.com`; const cookie = await joinerSession(app, email, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200); return cookie; }
// someone who owes £20 across two group orders
async function owing(price = 20) { const h = u('dup'); const c = await person(h); const g1 = await goOrder(), g2 = await goOrder(); await claimAndSecure(app, admin, h, await item(g1, price / 2)); await claimAndSecure(app, admin, h, await item(g2, price / 2)); return { h, c, g1, g2 }; }
const pay = (c, h, body) => api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount: 20, reference: u('TXN'), ...body }, c);
const count = async (h) => (await app.q('SELECT COUNT(*) AS n FROM payments p JOIN joiners j ON j.id = p.joiner_id WHERE j.instagram_handle = ?', [h]))[0].n;
const backdate = (h, minutes) => app.q('UPDATE payments p JOIN joiners j ON j.id = p.joiner_id SET p.created_at = p.created_at - INTERVAL ? MINUTE WHERE j.instagram_handle = ?', [minutes, h]);

test('AN IDENTICAL REPEAT IS RECOGNISED: the second send says so (200, "duplicate") and returns the first payment — nothing is recorded twice', async () => {
  const { h, c } = await owing(); const body = { reference: 'ABC-1' }; const a = await pay(c, h, body), b = await pay(c, h, body);
  assert.equal(a.status, 201); assert.equal(b.status, 200, b.text); assert.deepEqual([b.json.duplicate, b.json.id, b.json.status], [true, a.json.id, 'pending']); assert.equal(await count(h), 1);
  const noRef = await owing(); const x = await pay(noRef.c, noRef.h, { reference: undefined, payerName: 'Maiju T' }), y = await pay(noRef.c, noRef.h, { reference: undefined, payerName: 'Maiju T' }); assert.deepEqual([x.status, y.status, y.json.duplicate], [201, 200, true], 'with no transaction ID, an identical request within two minutes is still a repeat'); assert.equal(await count(noRef.h), 1);
});

test('A SIMULTANEOUS BURST (five taps at once) records exactly ONE payment', async () => {
  const { h, c } = await owing(); const rs = await Promise.all(Array.from({ length: 5 }, () => pay(c, h, { reference: 'BURST-1' })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 200, 200, 201]); assert.equal(new Set(rs.map((r) => r.json.id)).size, 1, 'all five answers point at the same payment'); assert.equal(await count(h), 1);
});

test('A TRANSACTION ID IS ONE TRANSFER: the same ID and amount a day later is still the same payment; but a corrected amount, another ID, another method, another order, or a REJECTED payment are NOT repeats', async () => {
  const { h, c, g1 } = await owing(); const first = await pay(c, h, { reference: 'T-100' }); await backdate(h, 24 * 60);
  const later = await pay(c, h, { reference: 'T-100' }); assert.deepEqual([later.status, later.json.duplicate, later.json.id], [200, true, first.json.id], 'a day later, the same transaction ID');
  assert.equal((await pay(c, h, { reference: 'T-100', amount: 15 })).status, 201, 'the same ID with a corrected amount is a new payment (not a repeat)'); assert.equal((await pay(c, h, { reference: 'T-200' })).status, 201, 'another ID');
  assert.equal((await pay(c, h, { reference: 'T-100', method: 'Wise' })).status, 201, 'another method (once methods are not restricted)'); assert.equal((await pay(c, h, { reference: 'T-300', orderId: g1, amount: 10 })).status, 201); assert.equal((await pay(c, h, { reference: 'T-300', amount: 10 })).status, 201, 'the same ID, but for all outstanding rather than one order');
  const rej = await owing(); const r1 = await pay(rej.c, rej.h, { reference: 'T-REJ' }); assert.equal((await api('POST', `/api/admin/payments/${r1.json.id}/reject`, {})).status, 200); const r2 = await pay(rej.c, rej.h, { reference: 'T-REJ' }); assert.equal(r2.status, 201, 'after the GOM rejected it, sending it again is allowed'); assert.notEqual(r2.json.id, r1.json.id);
});

test('NO TRANSACTION ID, TWO MINUTES APART IS NOT A REPEAT; a different amount within two minutes is not either', async () => {
  const { h, c } = await owing(); const named = { reference: undefined, payerName: 'Maiju T' }; const a = await pay(c, h, { ...named, amount: 10 }); assert.equal(a.status, 201); await backdate(h, 5);
  assert.equal((await pay(c, h, { ...named, amount: 10 })).status, 201, 'the same request five minutes later is a deliberate second payment'); assert.equal((await pay(c, h, { ...named, amount: 7.5 })).status, 201, 'a different amount straight away is a different payment');
});

test('A COMBINED PAYMENT (all handles) IS GUARDED TOO: a repeat returns the same batch, and a burst makes one batch', async () => {
  const go = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const c = await person(a, b); await claimAndSecure(app, admin, a, await item(go, 10)); await claimAndSecure(app, admin, b, await item(go, 6));
  const body = { method: 'PayPal', amount: 16, reference: 'COMBO-1' }; const one = await api('POST', '/api/my/payments?handle=all', body, c), two = await api('POST', '/api/my/payments?handle=all', body, c);
  assert.equal(one.status, 201); assert.equal(two.status, 200); assert.deepEqual([two.json.duplicate, two.json.batchKey, two.json.ids, two.json.split], [true, one.json.batchKey, one.json.ids, one.json.split]);
  assert.equal((await app.q('SELECT COUNT(DISTINCT batch_key) AS n FROM payments WHERE batch_key IS NOT NULL AND reference = ?', ['COMBO-1']))[0].n, 1); assert.equal((await app.q('SELECT COUNT(*) AS n FROM payments WHERE reference = ?', ['COMBO-1']))[0].n, 2, 'two rows (one per handle), once');
  const [g, h2] = [u('hc'), u('hd')]; const c2 = await person(g, h2); const go2 = await goOrder(); await claimAndSecure(app, admin, g, await item(go2, 5)); await claimAndSecure(app, admin, h2, await item(go2, 5));
  const burst = await Promise.all(Array.from({ length: 4 }, () => api('POST', '/api/my/payments?handle=all', { method: 'PayPal', amount: 10, reference: 'COMBO-2' }, c2))); assert.deepEqual(burst.map((r) => r.status).sort(), [200, 200, 200, 201]);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM payments WHERE reference = ?', ['COMBO-2']))[0].n, 2, 'one batch of two rows');
});

test('THE PAYMENT LIST SAYS WHICH ORDER EACH WAS FOR (so the page can tell what a waiting payment already covers)', async () => {
  const { h, c, g1 } = await owing(); await pay(c, h, { reference: 'O-1', orderId: g1, amount: 10 }); await pay(c, h, { reference: 'O-2', amount: 5 });
  const list = (await api('GET', `/api/my/payments?handle=${h}`, undefined, c)).json.payments; assert.deepEqual(list.map((p) => [p.reference, p.orderId]), [['O-2', null], ['O-1', g1]]);
});

test('"IDENTICAL" MEANS EVERYTHING THEY TYPED: the same amount straight after, but under another transaction ID or another payer name, is a different payment', async () => {
  const { h, c } = await owing(); assert.equal((await pay(c, h, { reference: 'ID-ONE', amount: 6 })).status, 201);
  assert.equal((await pay(c, h, { reference: 'ID-TWO', amount: 6 })).status, 201, 'another transaction ID, same amount, seconds later: two separate £6 payments');
  const n = await owing(); assert.equal((await pay(n.c, n.h, { reference: undefined, payerName: 'Alice A', amount: 6 })).status, 201);
  assert.equal((await pay(n.c, n.h, { reference: undefined, payerName: 'Bob B', amount: 6 })).status, 201, 'paid under another name');
  assert.equal((await pay(n.c, n.h, { reference: 'WITH-ID', payerName: undefined, amount: 6 })).status, 201, 'one with an ID, one with only a name');
  const again = await pay(n.c, n.h, { reference: undefined, payerName: 'Alice A', amount: 6 }); assert.deepEqual([again.status, again.json.duplicate], [200, true], 'but Alice sending exactly the same thing twice is a repeat');
});
