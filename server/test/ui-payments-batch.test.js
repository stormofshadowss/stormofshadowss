import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

// GOM → Payments: one transfer covering several of a person's handles shows as ONE line (with the split), verified or rejected as one; the tab badge counts it once.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ub') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Batch GO '), proxy: 'Sam' })).json.id;
const item = async (go, price) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price })).json.id;
async function person(...handles) { const cookie = await joinerSession(app, `${u('p')}@x.com`, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200); return cookie; }
// a person with two handles owing £10 and £6, who sent ONE payment for both
async function combined(extra = {}) { const go = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const c = await person(a, b); await claimAndSecure(app, admin, a, await item(go, 10)); await claimAndSecure(app, admin, b, await item(go, 6));
  const r = await api('POST', '/api/my/payments?handle=all', { method: 'PayPal', amount: 16, reference: u('TXN'), ...extra }, c); assert.equal(r.status, 201, r.text); return { a, b, c, ...r.json }; }
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Payments')); await sleep(120); await p.settle(); return p; };
const line = (p, key) => p.q(`[data-payment-batch="${key}"]`);

test('A COMBINED PAYMENT IS ONE LINE: the split, the total, "one payment, 2 handles", and Verify all / Reject all — not two separate rows', async () => {
  const { a, b, batchKey, ids } = await combined(); const single = await (async () => { const g = await goOrder(); const h = u('solo'); const c = await person(h); await claimAndSecure(app, admin, h, await item(g, 4)); return (await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount: 4, reference: u('SOLO') }, c)).json; })();
  const p = await open(); const l = line(p, batchKey); assert.ok(l, 'one line for the batch'); assert.equal(p.qa(`[data-payment="${ids[0]}"], [data-payment="${ids[1]}"]`).length, 0, 'its parts are not listed as separate rows');
  assert.match(p.text(l), new RegExp(`@${a} £10\\.00@${b} £6\\.00one payment, 2 handles.*£16\\.00.*PayPal`)); assert.deepEqual([p.text(p.q('[data-act="verify-batch"]', l)), p.text(p.q('[data-act="reject-batch"]', l))], ['Verify all', 'Reject all']);
  assert.ok(p.q(`[data-payment="${single.id}"]`), 'an ordinary payment is still an ordinary row'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('VERIFY ALL asks first and says what it does; confirming verifies every part, each handle\'s claims are paid, and the line shows it as confirmed', async () => {
  const { a, b, c, batchKey, ids } = await combined({ amount: 20, overpay: { choice: 'credit' } });
  const p = await open(); await p.click(p.q('[data-act="verify-batch"]', line(p, batchKey)));
  assert.match(p.text(modal(p)), new RegExp(`Mark the £20\\.00 payment as received\\?.*ONE transfer covering 2 of this person's handles, split as: @${a} £14\\.00, @${b} £6\\.00\\..*£4\\.00 extra and chose for it to be credit`, 's')); await press(p, 'Not yet');
  assert.deepEqual((await app.q('SELECT status FROM payments WHERE batch_key = ?', [batchKey])).map((r) => r.status), ['pending', 'pending'], 'not yet means not yet');
  await p.click(p.q('[data-act="verify-batch"]', line(p, batchKey))); await press(p, 'Mark all as received'); await sleep(300); await p.settle();
  assert.match(toast(p), /Verified: £16\.00 applied across 2 handles\. £4\.00 kept as credit\./); assert.deepEqual((await app.q('SELECT status FROM payments WHERE batch_key = ?', [batchKey])).map((r) => r.status), ['confirmed', 'confirmed']);
  const s = (await api('GET', '/api/my/summary?handle=all', undefined, c)).json; assert.deepEqual([s.owed.total, s.credit], [0, 4]); void ids; p.close();
});

test('REJECT ALL asks first, then rejects every part; nothing is applied', async () => {
  const { a, c, batchKey } = await combined(); const p = await open(); await p.click(p.q('[data-act="reject-batch"]', line(p, batchKey)));
  assert.match(p.text(modal(p)), new RegExp(`Reject the £16\\.00 payment covering @${a}, @.*\\?.*No money is moved`, 's')); await press(p, 'Not yet'); assert.equal((await app.q("SELECT COUNT(*) AS n FROM payments WHERE batch_key = ? AND status = 'rejected'", [batchKey]))[0].n, 0);
  await p.click(p.q('[data-act="reject-batch"]', line(p, batchKey))); await press(p, 'Reject all'); await sleep(250); await p.settle(); assert.match(toast(p), /Rejected\./); assert.deepEqual((await app.q('SELECT status FROM payments WHERE batch_key = ?', [batchKey])).map((r) => r.status), ['rejected', 'rejected']);
  assert.equal((await api('GET', '/api/my/summary?handle=all', undefined, c)).json.owed.total, 16); p.close();
});

test('PART-VERIFIED: if one part was verified on its own, the line says so and "Verify all (1 left)" finishes the job', async () => {
  const { batchKey, ids } = await combined(); assert.equal((await api('POST', `/api/admin/payments/${ids[0]}/verify`, {})).status, 200);
  const p = await open(); assert.equal(line(p, batchKey), null, 'under "Waiting for me" the part that is left is an ordinary row'); assert.ok(p.q(`[data-payment="${ids[1]}"]`));
  p.q('[data-filter="status"]').value = 'all'; p.q('[data-filter="status"]').dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(250); await p.settle();
  const l = line(p, batchKey); assert.match(p.text(p.q('[data-act="verify-batch"]', l)), /^Verify all \(1 left\)$/); assert.equal(p.qa('.pill', l).filter((x) => p.text(x) === 'confirmed').length, 1, 'the part that was verified is marked');
  await p.click(p.q('[data-act="verify-batch"]', l)); await press(p, 'Mark all as received'); await sleep(250); await p.settle(); assert.deepEqual((await app.q('SELECT status FROM payments WHERE batch_key = ?', [batchKey])).map((r) => r.status), ['confirmed', 'confirmed']); p.close();
});

test('THE TAB BADGE COUNTS A COMBINED PAYMENT ONCE', async () => {
  const before = (await api('GET', '/api/admin/payments?status=pending')).json.payments; const distinct = new Set(before.map((x) => x.batchKey || `#${x.id}`)).size;
  const { batchKey } = await combined(); const p = await open(); const badge = p.text(p.byText('#tabs button', 'Payments').querySelector('.badge, .count, span') || p.byText('#tabs button', 'Payments'));
  assert.match(badge, new RegExp(`(^|\\D)${distinct + 1}$`), `one more waiting payment, not two (was ${distinct})`); void batchKey; p.close();
});

test('REFERENCES WITH HTML are shown as text on a combined line; the rest of the tab (search) still works', async () => {
  const { a, batchKey } = await combined({ reference: '<img src=x onerror="window.pwned=1">' }); const p = await open(); assert.equal(p.q('img[src="x"]'), null); assert.equal(p.window.pwned, undefined); assert.match(p.text(line(p, batchKey)), /<img src=x onerror="window\.pwned=1">/);
  p.q('[data-filter="q"]').value = a; p.q('[data-filter="q"]').dispatchEvent(new p.window.Event('input', { bubbles: true })); await sleep(60); assert.ok(line(p, batchKey), 'searching by one of its handles finds the line'); p.close();
});
