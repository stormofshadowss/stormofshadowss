import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// A person's handles share their credit: it pays what its own handle owes first, then what their OTHER handles owe — by moving it between them with a pair of ledger entries.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'sc') => `${x}${++N}`;
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Credit GO '), proxy: 'Sam' })).json.id;
const item = async (go, price) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price })).json.id;
// one person (one sign-in) with several handles
async function person(...handles) { const email = `${u('p')}@x.com`; const cookie = await joinerSession(app, email, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200); return { cookie, handles }; }
const jid = async (h) => (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [h]))[0].id;
const balance = async (h) => Number((await app.q('SELECT COALESCE(SUM(balance_effect), 0) AS b FROM credit_ledger WHERE joiner_id = ?', [await jid(h)]))[0].b);
const ledger = async (h) => app.q('SELECT kind, amount, balance_effect AS effect, reason, source FROM credit_ledger WHERE joiner_id = ? ORDER BY id', [await jid(h)]);
const claimPaid = async (id) => Number((await app.q('SELECT COALESCE(SUM(paid), 0) AS p FROM claim_costs WHERE claim_id = ?', [id]))[0].p);
const credit = (h, amount) => api('POST', '/api/admin/credit/add', { handle: h, amount, reason: 'Test credit' });
const accountTotal = async (hs) => { let t = 0; for (const h of hs) t += await balance(h); return Math.round(t * 100) / 100; };

test('CREDIT ON ONE HANDLE PAYS FOR ANOTHER HANDLE\'S ITEM: it is moved with a pair of ledger entries and then applied, and the books still balance', async () => {
  const go = await goOrder(); const it = await item(go, 12); const [a, b] = [u('ha'), u('hb')]; await person(a, b);
  assert.equal((await credit(a, 20)).status, 200);                                            // £20 on @a; nothing owed anywhere
  const [claim] = await claimAndSecure(app, admin, b, it);                                    // @b now owes £12 (confirming sweeps credit)
  assert.equal(await claimPaid(claim), 12, '@b\'s item was paid from @a\'s credit'); assert.equal(await balance(a), 8, '@a has £8 left'); assert.equal(await balance(b), 0, '@b used what it was given');
  const la = await ledger(a), lb = await ledger(b);
  assert.deepEqual(la.map((r) => [r.kind, r.effect]), [['credit', 20], ['transfer_out', -12]]); assert.equal(la[1].reason, `Credit moved to @${b} to pay for their items`);
  assert.deepEqual(lb.map((r) => [r.kind, r.effect]), [['transfer_in', 12], ['applied', -12]]); assert.equal(lb[0].reason, `Credit moved from @${a}`); assert.equal(lb[0].source, 'moved between handles');
  assert.equal(await accountTotal([a, b]), 8, 'across the person nothing was created or lost: £20 credit − £12 spent');
});

test('A HANDLE\'S OWN CREDIT IS USED FIRST; only what is still owing is paid from the other handles', async () => {
  const go = await goOrder(); const it = await item(go, 10); const [a, b] = [u('ha'), u('hb')]; await person(a, b);
  await credit(b, 4); await credit(a, 20);
  const [claim] = await claimAndSecure(app, admin, b, it);
  assert.equal(await claimPaid(claim), 10); assert.equal(await balance(b), 0); assert.equal(await balance(a), 14, 'only £6 was needed from @a (£4 was @b\'s own)');
  assert.equal((await ledger(a)).filter((r) => r.kind === 'transfer_out').reduce((n, r) => n - r.effect, 0), 6);
});

test('CREDIT THAT ARRIVES LATER pays what the person\'s other handles already owe (a refund or a GOM credit on one handle reaches the other)', async () => {
  const go = await goOrder(); const it = await item(go, 8); const [a, b] = [u('ha'), u('hb')]; await person(a, b);
  const [claim] = await claimAndSecure(app, admin, b, it); assert.equal(await claimPaid(claim), 0, '@b owes £8 and nobody has credit yet');
  assert.equal((await credit(a, 10)).status, 200);
  assert.equal(await claimPaid(claim), 8, '@b\'s item is now paid'); assert.equal(await balance(a), 2); assert.equal(await balance(b), 0);
});

test('PENNIES ADD UP, a partial amount is moved when that is all there is, and no handle is ever left with negative credit', async () => {
  const go = await goOrder(); const it = await item(go, 5.37); const [a, b, c] = [u('ha'), u('hb'), u('hc')]; await person(a, b, c);
  await credit(a, 1.11); await credit(c, 2.22);
  const [claim] = await claimAndSecure(app, admin, b, it);
  assert.equal(await claimPaid(claim), 3.33, 'all the credit there was: £1.11 + £2.22'); for (const h of [a, b, c]) assert.ok((await balance(h)) >= 0, `${h} is not negative`); assert.equal(await accountTotal([a, b, c]), 0);
});

test('OTHER PEOPLE ARE UNTOUCHED: credit never crosses to a different person, even with similar handles', async () => {
  const go = await goOrder(); const it = await item(go, 9); const [a, x] = [u('ha'), u('hx')]; await person(a); await person(x);
  await credit(a, 50); const [claim] = await claimAndSecure(app, admin, x, it);
  assert.equal(await claimPaid(claim), 0, 'a different person\'s credit does not pay for it'); assert.equal(await balance(a), 50);
});

test('A BLOCKED HANDLE IS LEFT OUT: its credit is not moved, and it is not paid for', async () => {
  const go = await goOrder(); const [a, b, c] = [u('ha'), u('hb'), u('hc')]; await person(a, b, c);
  await credit(a, 10); await app.q('UPDATE joiners SET is_blocked = 1 WHERE instagram_handle = ?', [a]);
  const [forB] = await claimAndSecure(app, admin, b, await item(go, 6)); assert.equal(await claimPaid(forB), 0, 'the blocked handle\'s credit is not used'); assert.equal(await balance(a), 10);
  const [forC] = await claimAndSecure(app, admin, c, await item(go, 3)); assert.equal(await claimPaid(forC), 0);
  await app.q('UPDATE joiners SET is_blocked = 0 WHERE instagram_handle = ?', [a]); await app.q('UPDATE joiners SET is_blocked = 1 WHERE instagram_handle = ?', [c]);
  assert.equal((await credit(a, 1)).status, 200);                                               // a is back: its credit now reaches b, but NOT the blocked c
  assert.equal(await claimPaid(forB), 6, 'the unblocked sibling is paid for'); assert.equal(await claimPaid(forC), 0, 'a blocked handle is not paid for'); assert.equal(await balance(c), 0);
});

test('TWO THINGS AT ONCE ON THE SAME PERSON never spend the same credit twice: no negative balance, nothing over-paid, no deadlock', async () => {
  const go = await goOrder(); const [a, b] = [u('ha'), u('hb')]; await person(a, b);
  const x = await item(go, 10), y = await item(go, 10); await credit(a, 10);
  const claims = await Promise.all([app.api('POST', '/api/claims', { handle: a, lines: [{ itemId: x }] }), app.api('POST', '/api/claims', { handle: b, lines: [{ itemId: y }] })]); assert.ok(claims.every((r) => r.status === 201));
  const ids = (await app.q('SELECT id FROM claims WHERE joiner_id IN (?, ?) ORDER BY id', [await jid(a), await jid(b)])).map((r) => r.id);
  const secure = await Promise.all([api('POST', '/api/admin/claims/secure', { claimIds: [ids[0]] }), api('POST', '/api/admin/claims/secure', { claimIds: [ids[1]] })]); assert.ok(secure.every((r) => r.status === 200), secure.map((r) => r.text).join());
  const paid = (await claimPaid(ids[0])) + (await claimPaid(ids[1])); assert.equal(paid, 10, 'exactly the £10 of credit was spent, once');
  for (const h of [a, b]) assert.ok((await balance(h)) >= 0); assert.equal(await accountTotal([a, b]), 0);
});

test('A PERSON WITH ONE HANDLE behaves exactly as before (no transfers, no extra entries)', async () => {
  const go = await goOrder(); const it = await item(go, 7); const h = u('solo'); await person(h); await credit(h, 10);
  const [claim] = await claimAndSecure(app, admin, h, it); assert.equal(await claimPaid(claim), 7); assert.deepEqual((await ledger(h)).map((r) => r.kind), ['credit', 'applied']);
});
