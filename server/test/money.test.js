import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { splitAmount, round2 } from '../src/lib/money.js';

let app, admin, w, w2;
before(async () => {
  app = await startApp();
  admin = await app.adminLogin();
  w = await seed(app, admin);
  const g2 = (await app.api('POST', '/api/admin/orders', { groupId: w.group, title: 'Second GO', paymentDeadline: '2099-03-03' }, admin)).json.id;
  w2 = { order: g2, poster: (await app.api('POST', `/api/admin/orders/${g2}/items`, { type: 'normal', title: 'Poster', price: 10 }, admin)).json.id };
});
after(async () => { await app.stop(); });

const pay = (cookie, body) => app.api('POST', '/api/my/payments', { method: 'PayPal', ...body }, cookie);
const summary = async (cookie) => (await app.api('GET', '/api/my/summary', undefined, cookie)).json;
const verify = (id) => app.api('POST', `/api/admin/payments/${id}/verify`, {}, admin);
const ledger = async (handle) => (await app.api('GET', `/api/admin/ledger?handle=${handle}`, undefined, admin)).json;
const joinerId = async (handle) => (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [handle]))[0].id;
const costLine = async (claimId, cat) => (await app.q('SELECT cost, paid, paid_date FROM claim_costs WHERE claim_id = ? AND category = ?', [claimId, cat]))[0];

test('splitAmount always adds back to exactly the total, to the penny', () => {
  for (const [total, weights] of [[100, [1, 1, 1]], [10, [1, 1, 1]], [98, [652, 43, 304]], [0.01, [1, 1, 1]], [33.33, [5, 3, 2]], [100, [375, 25, 175]], [7, [1]]]) {
    const parts = splitAmount(total, weights);
    assert.equal(round2(parts.reduce((a, b) => a + b, 0)), total, `${total} over ${weights}`);
    assert.ok(parts.every((p) => p >= 0));
  }
  assert.deepEqual(splitAmount(10, [1, 1, 1]), [3.34, 3.33, 3.33]);
  assert.deepEqual(splitAmount(0, [1, 2]), [0, 0]);
});

test('£26 owed, £30 sent, joiner says the extra is a TIP: £26 settles it, £4 is a tip, no credit', async () => {
  const c = await joinerSession(app, 'tip1@x.com', 'tip1');
  await claimAndSecure(app, admin, 'tip1', w.album);
  assert.equal((await summary(c)).owed.total, 26);

  const refused = await pay(c, { amount: 30, reference: 'TX1' });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, 'overpay_choice_required', 'the joiner has to choose — the GOM is never asked');

  const p = await pay(c, { amount: 30, reference: 'TX1', overpay: { choice: 'tip', note: 'thanks!' } });
  assert.equal(p.status, 201);
  assert.equal(p.json.extra, 4);
  const v = await verify(p.json.id);
  assert.equal(v.status, 200);
  assert.equal(v.json.applied, 26);
  assert.equal(v.json.leftover, 4);

  const s = await summary(c);
  assert.equal(s.owed.total, 0);
  assert.equal(s.credit, 0, 'a tip is never credit');
  const l = await ledger('tip1');
  assert.deepEqual(l.entries.map((e) => [e.kind, e.amount, e.balanceEffect, e.reason]), [['tip', 4, 0, 'Tip: thanks!']]);
  assert.ok(l.tipsTotal >= 4);
  const alloc = await app.q('SELECT SUM(amount) AS s FROM payment_allocations WHERE payment_id = ?', [p.json.id]);
  assert.equal(Number(alloc[0].s), 26, 'allocations show exactly what was settled');
});

test('overpayment kept as CREDIT auto-applies to the next thing they owe', async () => {
  const c = await joinerSession(app, 'cred1@x.com', 'cred1');
  await claimAndSecure(app, admin, 'cred1', w.album);
  const p = await pay(c, { amount: 30, reference: 'TX2', overpay: { choice: 'credit', note: 'paying ahead' } });
  await verify(p.json.id);
  assert.equal((await summary(c)).credit, 4);

  await claimAndSecure(app, admin, 'cred1', w.keyring); // £6 — secured, so credit meets it straight away
  const s = await summary(c);
  assert.equal(s.credit, 0, 'credit was spent');
  assert.equal(s.owed.total, 2, '£6 − £4 credit');
  const l = await ledger('cred1');
  assert.deepEqual(l.entries.map((e) => [e.kind, e.balanceEffect]).reverse(), [['credit', 4], ['applied', -4]]);
  assert.equal(l.entries.find((e) => e.kind === 'credit').reason, 'paying ahead');
});

test('no choice on record (e.g. entered by hand) defaults to credit, never a silent tip', async () => {
  const c = await joinerSession(app, 'nochoice@x.com', 'nochoice');
  await claimAndSecure(app, admin, 'nochoice', w.album);
  const jid = await joinerId('nochoice');
  const [ins] = await app.pool.query("INSERT INTO payments (joiner_id, amount, method, reference, status) VALUES (?, 30, 'PayPal', 'HANDKEYED', 'pending')", [jid]);
  await verify(ins.insertId);
  const l = await ledger('nochoice');
  assert.equal(l.entries[0].kind, 'credit');
  assert.match(l.entries[0].reason, /didn't choose/);
  assert.equal((await summary(c)).credit, 4);
});

test('the reference is optional once the payer is named; a different name must be typed', async () => {
  const c = await joinerSession(app, 'ref1@x.com', 'ref1');
  await app.api('PUT', '/api/my/address', { fullName: 'Ref One', address: '1 Test Road, Leeds', email: 'ref1@x.com', phone: '07000' }, c);
  await claimAndSecure(app, admin, 'ref1', w.keyring);

  const same = await pay(c, { amount: 6 });
  assert.equal(same.status, 201, 'address name is the default payer, so no reference needed');
  let row = (await app.q('SELECT * FROM payments WHERE id = ?', [same.json.id]))[0];
  assert.equal(row.payer_name, 'Ref One');
  assert.equal(row.payer_is_address_name, 1);
  assert.equal(row.reference, null);

  const noName = await pay(c, { amount: 6, payerChoice: 'other' });
  assert.equal(noName.status, 400);
  assert.equal(noName.json.code, 'payer_name_required');

  const other = await pay(c, { amount: 6, payerChoice: 'other', payerName: 'Bob Lee' });
  row = (await app.q('SELECT * FROM payments WHERE id = ?', [other.json.id]))[0];
  assert.equal(row.payer_name, 'Bob Lee');
  assert.equal(row.payer_is_address_name, 0);
  assert.equal(row.address_name_snapshot, 'Ref One', 'the address name at the time is kept for comparison');

  const sameTyped = await pay(c, { amount: 6, payerChoice: 'other', payerName: 'ref ONE' });
  assert.equal((await app.q('SELECT payer_is_address_name AS x FROM payments WHERE id = ?', [sameTyped.json.id]))[0].x, 1, 'typing the address name anyway still counts as it');
});

test('with no name on file, something must identify the payment', async () => {
  const c = await joinerSession(app, 'ref2@x.com', 'ref2');
  await claimAndSecure(app, admin, 'ref2', w.keyring);
  const none = await pay(c, { amount: 6 });
  assert.equal(none.status, 400);
  assert.equal(none.json.code, 'reference_required');
  assert.equal((await pay(c, { amount: 6, payerName: 'Nora Noname' })).status, 201, 'a payer name alone is enough');
  assert.equal((await pay(c, { amount: 6, reference: 'ABC123' })).status, 201, 'so is a transaction ID');
});

test('payment validation', async () => {
  const c = await joinerSession(app, 'val1@x.com', 'val1');
  assert.equal((await pay(c, { amount: 5, reference: 'x' })).json.code, 'nothing_owed', 'nothing owing, nothing to pay');
  await claimAndSecure(app, admin, 'val1', w.keyring);
  for (const amount of [0, -5, 6.123, 1e9]) assert.equal((await pay(c, { amount, reference: 'x' })).status, 400, `amount ${amount}`);
  assert.equal((await app.api('POST', '/api/my/payments', { amount: 6, reference: 'x' }, c)).status, 400, 'method is required');
  assert.equal((await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 6, reference: 'x' })).status, 401, 'must be signed in');
  await app.api('PUT', '/api/admin/payment-methods', { methods: [{ method: 'PayPal', accountInfo: 'a' }, { method: 'Wise', accountInfo: 'b' }] }, admin);
  assert.equal((await pay(c, { amount: 6, reference: 'x', method: 'Venmo' })).json.code, 'bad_method');
  assert.equal((await pay(c, { amount: 6, reference: 'x', method: 'Wise' })).status, 201);
  await app.api('PUT', '/api/admin/payment-methods', { methods: [] }, admin);
});

test('a payment can only be verified once — even if the button is hammered', async () => {
  const c = await joinerSession(app, 'race1@x.com', 'race1');
  await claimAndSecure(app, admin, 'race1', w.album);
  const p = await pay(c, { amount: 26, reference: 'RACE' });
  const results = await Promise.all(Array.from({ length: 6 }, () => verify(p.json.id)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 5);
  const claim = (await app.q('SELECT c.id FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ?', ['race1']))[0];
  assert.equal(Number((await costLine(claim.id, 'initials')).paid), 26, 'applied once, not six times');
});

test('rejecting a payment moves no money', async () => {
  const c = await joinerSession(app, 'rej1@x.com', 'rej1');
  await claimAndSecure(app, admin, 'rej1', w.keyring);
  const p = await pay(c, { amount: 6, reference: 'BOGUS' });
  assert.equal((await app.api('POST', `/api/admin/payments/${p.json.id}/reject`, {}, admin)).status, 200);
  assert.equal((await summary(c)).owed.total, 6);
  assert.equal((await verify(p.json.id)).status, 409, 'a rejected payment can\'t then be verified');
  assert.equal((await app.api('POST', `/api/admin/payments/${p.json.id}/verify`, {}, c)).status, 403, 'and joiners can\'t verify anything');
});

test("a payment for one GO only touches that GO; 'all outstanding' spreads across everything", async () => {
  const c = await joinerSession(app, 'scope1@x.com', 'scope1');
  await claimAndSecure(app, admin, 'scope1', w.album);        // £26 in Run It GO
  await claimAndSecure(app, admin, 'scope1', w2.poster);      // £10 in Second GO
  const p1 = await pay(c, { orderId: w2.order, amount: 10, reference: 'SCOPE-A' });
  await verify(p1.json.id);
  let s = await summary(c);
  assert.deepEqual(s.orders.map((o) => [o.title, o.owed]).sort(), [['Run It GO', 26], ['Second GO', 0]]);

  const tooMuch = await pay(c, { orderId: w2.order, amount: 12, reference: 'x' });
  assert.equal(tooMuch.json.code, 'nothing_owed', 'that GO is settled');

  const p2 = await pay(c, { orderId: null, amount: 26, reference: 'SCOPE-B' });
  await verify(p2.json.id);
  assert.equal((await summary(c)).owed.total, 0);
});

test('money goes to Initials first, then EMS, Customs, Doms — and the allocations show it', async () => {
  const c = await joinerSession(app, 'alloc1@x.com', 'alloc1');
  const [claimId] = await claimAndSecure(app, admin, 'alloc1', w.album);
  await app.api('PATCH', `/api/admin/claims/${claimId}`, { costs: { ems: { cost: 4 }, customs: { cost: 3 }, doms: { cost: 2 } } }, admin);
  let s = await summary(c);
  assert.deepEqual([s.owed.initials, s.owed.ems, s.owed.customs, s.owed.doms, s.owed.total], [26, 4, 3, 2, 35]);

  const p = await pay(c, { amount: 30, reference: 'ALLOC1' });
  await verify(p.json.id);
  const alloc = await app.q('SELECT category, amount FROM payment_allocations WHERE payment_id = ? ORDER BY id', [p.json.id]);
  assert.deepEqual(alloc.map((a) => [a.category, Number(a.amount)]), [['initials', 26], ['ems', 4]]);
  s = await summary(c);
  assert.deepEqual([s.owed.initials, s.owed.ems, s.owed.customs, s.owed.doms], [0, 0, 3, 2]);
  assert.ok((await costLine(claimId, 'initials')).paid_date, 'the paid-on date is stamped when a line clears');
  assert.equal((await costLine(claimId, 'customs')).paid_date, null);
});

test('exchange-rate adjustment: raising a cost after payment only changes what is left', async () => {
  const c = await joinerSession(app, 'fx1@x.com', 'fx1');
  const [claimId] = await claimAndSecure(app, admin, 'fx1', w.album);
  await verify((await pay(c, { amount: 26, reference: 'FX' })).json.id);
  assert.equal((await summary(c)).owed.total, 0);

  await app.api('PATCH', `/api/admin/claims/${claimId}`, { costs: { initials: { cost: 27.5 } } }, admin);
  let line = await costLine(claimId, 'initials');
  assert.equal(Number(line.paid), 26, 'what they already paid is untouched');
  assert.equal((await summary(c)).owed.total, 1.5);
  assert.equal(line.paid_date, null, 'no longer fully paid, so the paid-on date is cleared');

  // and lowering it below what they paid turns the difference into credit
  await app.api('PATCH', `/api/admin/claims/${claimId}`, { costs: { initials: { cost: 25 } } }, admin);
  line = await costLine(claimId, 'initials');
  assert.equal(Number(line.paid), 25, 'capped at the new cost');
  assert.equal((await summary(c)).credit, 1);
});

test('typing a paid amount above the cost in Claims becomes credit (defaulted), capped at the cost', async () => {
  const c = await joinerSession(app, 'edit1@x.com', 'edit1');
  const [claimId] = await claimAndSecure(app, admin, 'edit1', w.album);
  await app.api('PATCH', `/api/admin/claims/${claimId}`, { costs: { initials: { paid: 30 } } }, admin);
  assert.equal(Number((await costLine(claimId, 'initials')).paid), 26);
  assert.equal((await summary(c)).credit, 4);
  assert.match((await ledger('edit1')).entries[0].reason, /didn't choose/);
});

test('credit can be removed only while unspent', async () => {
  const c = await joinerSession(app, 'rem1@x.com', 'rem1');
  await claimAndSecure(app, admin, 'rem1', w.album);
  await verify((await pay(c, { amount: 30, reference: 'REM', overpay: { choice: 'credit' } })).json.id);
  assert.equal((await app.api('POST', '/api/admin/credit/remove', { handle: 'rem1', amount: 5 }, admin)).json.code, 'credit_already_spent', 'only £4 is there');
  assert.equal((await app.api('POST', '/api/admin/credit/remove', { handle: 'rem1', amount: 3, reason: 'refunded by bank' }, admin)).status, 200);
  assert.equal((await summary(c)).credit, 1);

  await claimAndSecure(app, admin, 'rem1', w.keyring); // spends the last £1
  assert.equal((await summary(c)).credit, 0);
  assert.equal((await app.api('POST', '/api/admin/credit/remove', { handle: 'rem1', amount: 1 }, admin)).status, 400, 'already applied to costs');
  assert.equal((await app.api('POST', '/api/admin/credit/remove', { handle: 'rem1', amount: 1 }, c)).status, 403);
});

test('pay-by dates: an item uses its own, else the GO\'s, and overdue is flagged per claim', async () => {
  const c = await joinerSession(app, 'due1@x.com', 'due1');
  await claimAndSecure(app, admin, 'due1', w.keyring);   // GO date 2099-01-10
  await claimAndSecure(app, admin, 'due1', w.album);     // own date 2099-02-02
  let s = await summary(c);
  const claims = s.orders[0].claims;
  assert.deepEqual(claims.map((x) => [x.label, x.payBy, x.overdue]), [['Keyring', '2099-01-10', false], ['Album', '2099-02-02', false]]);
  await app.api('PATCH', `/api/admin/orders/${w.order}`, { paymentDeadline: '2000-01-01' }, admin);
  s = await summary(c);
  const byLabel = Object.fromEntries(s.orders[0].claims.map((x) => [x.label, x]));
  assert.equal(byLabel.Keyring.overdue, true, 'GO date has passed');
  assert.equal(byLabel.Album.overdue, false, 'its own later date has not');
  await app.api('PATCH', `/api/admin/orders/${w.order}`, { paymentDeadline: '2099-01-10' }, admin);
});

test("one joiner can never see or pay another's balance", async () => {
  const a = await joinerSession(app, 'priv.a@x.com', 'priv_a');
  const b = await joinerSession(app, 'priv.b@x.com', 'priv_b');
  await claimAndSecure(app, admin, 'priv_a', w.album);
  assert.equal((await summary(b)).owed.total, 0);
  assert.equal((await pay(b, { amount: 26, reference: 'x' })).json.code, 'nothing_owed');
  assert.equal((await app.api('GET', '/api/my/summary?handle=priv_a', undefined, b)).status, 403);
  assert.equal((await summary(a)).owed.total, 26);
});

test('credit is never double-spent when two claims are secured at the same instant', async () => {
  const c = await joinerSession(app, 'dbl1@x.com', 'dbl1');
  await claimAndSecure(app, admin, 'dbl1', w.album);
  await verify((await pay(c, { amount: 36, reference: 'DBL', overpay: { choice: 'credit' } })).json.id);
  assert.equal((await summary(c)).credit, 10);

  const ids = (await app.api('POST', '/api/claims', { handle: 'dbl1', lines: [{ itemId: w.keyring, qty: 2 }] })).json.claimIds; // 2 × £6
  await Promise.all(ids.map((id) => app.api('POST', '/api/admin/claims/secure', { claimIds: [id] }, admin)));

  const s = await summary(c);
  assert.equal(s.credit, 0, 'all £10 used');
  assert.equal(s.owed.total, 2, '£12 of cost − £10 credit');
  const l = await ledger('dbl1');
  assert.equal(round2(l.entries.filter((e) => e.kind === 'applied').reduce((a, e) => a + e.amount, 0)), 10, 'exactly £10 applied, never more');
  const paid = await app.q('SELECT SUM(paid) AS s FROM claim_costs WHERE claim_id IN (?)', [ids]);
  assert.equal(Number(paid[0].s), 10);
});

test('penny-exact: awkward amounts settle without drift', async () => {
  const c = await joinerSession(app, 'pen1@x.com', 'pen1');
  const [claimId] = await claimAndSecure(app, admin, 'pen1', w.keyring);
  await app.api('PATCH', `/api/admin/claims/${claimId}`, { costs: { initials: { cost: 10.01 }, ems: { cost: 10.01 }, customs: { cost: 10.01 } } }, admin);
  assert.equal((await summary(c)).owed.total, 30.03);
  const p = await pay(c, { amount: 30.03, reference: 'PEN' });
  await verify(p.json.id);
  assert.equal((await summary(c)).owed.total, 0);
  assert.equal(Number((await app.q('SELECT SUM(amount) AS s FROM payment_allocations WHERE payment_id = ?', [p.json.id]))[0].s), 30.03);
});

test('STRESS: 12 people each with £10 credit and two claims secured simultaneously — nobody is ever double-spent', async () => {
  const people = Array.from({ length: 12 }, (_, i) => `stress${i}`);
  // set up each person: £10 credit
  for (const h of people) {
    const c = await joinerSession(app, `${h}@x.com`, h);
    await claimAndSecure(app, admin, h, w.album);
    await verify((await pay(c, { amount: 36, reference: `S-${h}`, overpay: { choice: 'credit' } })).json.id);
  }
  // every person's two claims, all secured at once (24 simultaneous requests)
  const claimIds = {};
  for (const h of people) claimIds[h] = (await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: w.keyring, qty: 2 }] })).json.claimIds;
  const results = await Promise.all(people.flatMap((h) => claimIds[h].map((id) => app.api('POST', '/api/admin/claims/secure', { claimIds: [id] }, admin))));
  assert.ok(results.every((r) => r.status === 200), `no request failed (got ${[...new Set(results.map((r) => r.status))]})`);
  for (const h of people) {
    const jid = await joinerId(h);
    const bal = Number((await app.q('SELECT COALESCE(SUM(balance_effect),0) AS b FROM credit_ledger WHERE joiner_id = ?', [jid]))[0].b);
    assert.equal(bal, 0, `${h}: all £10 used, none left over and none overspent`);
    const paid = Number((await app.q('SELECT SUM(paid) AS s FROM claim_costs WHERE claim_id IN (?) AND category = \'initials\'', [claimIds[h]]))[0].s);
    assert.equal(paid, 10, `${h}: exactly £10 went on the two £6 claims`);
  }
});

test('a payment being verified while a claim is secured: either order ends in the same place', async () => {
  const c = await joinerSession(app, 'order1@x.com', 'order1');
  await claimAndSecure(app, admin, 'order1', w.album);                       // owes 26
  const p = await pay(c, { amount: 30, reference: 'ORD', overpay: { choice: 'credit' } });
  const kid = (await app.api('POST', '/api/claims', { handle: 'order1', lines: [{ itemId: w.keyring }] })).json.claimIds;
  const [v, sec] = await Promise.all([verify(p.json.id), app.api('POST', '/api/admin/claims/secure', { claimIds: kid }, admin)]);
  assert.equal(v.status, 200);
  assert.equal(sec.status, 200);
  const s = await summary(c);
  assert.equal(s.credit, 0);
  assert.equal(s.owed.total, 2, '£32 of costs − £30 paid');
});

test('INVARIANTS across everything done above: no line overpaid, no negative credit, every pound accounted for', async () => {
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost'))[0].n, 0, 'no cost line is ever overpaid');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid < 0 OR cost < 0'))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM (SELECT joiner_id FROM credit_ledger GROUP BY joiner_id HAVING SUM(balance_effect) < 0) x'))[0].n, 0, 'nobody has negative credit');
  const confirmed = Number((await app.q("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status = 'confirmed'"))[0].s);
  const allocated = Number((await app.q('SELECT COALESCE(SUM(amount),0) AS s FROM payment_allocations'))[0].s);
  const leftover = Number((await app.q("SELECT COALESCE(SUM(amount),0) AS s FROM credit_ledger WHERE payment_id IS NOT NULL AND kind IN ('credit','tip')"))[0].s);
  assert.equal(round2(confirmed), round2(allocated + leftover), 'every confirmed pound went to a cost line, to credit, or to a tip');
});
