import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { gomPage, openPage, toast } from './ui.helpers.js';

// GOM → Payments → "Payment failed…" on a verified payment: a preview of exactly what changes, then it is done. The person sees it failed and owes it again.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); await app.q("INSERT IGNORE INTO payment_methods (method, account_info) VALUES ('PayPal', 'pay@example.com')"); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ur') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('RevUI GO '), proxy: 'Sam' })).json.id;
const item = async (go, price, title = u('Thing ')) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price })).json.id;
async function person(...handles) { const cookie = await joinerSession(app, `${u('p')}@x.com`, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200); return cookie; }
const verified = async (c, h, amount, extra = {}) => { const r = await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount, reference: u('TXN'), ...extra }, c); assert.equal(r.status, 201, r.text); const v = r.json.batchKey ? await api('POST', `/api/admin/payments/batch/${r.json.batchKey}/verify`, {}) : await api('POST', `/api/admin/payments/${r.json.id}/verify`, {}); assert.equal(v.status, 200); return r.json; };
const owed = async (c, h) => (await api('GET', `/api/my/summary?handle=${h}`, undefined, c)).json.owed.total;
const open = async (status = 'confirmed') => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Payments')); await sleep(120); await p.settle(); const sel = p.q('[data-filter="status"]'); sel.value = status; sel.dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(250); await p.settle(); return p; };
const panel = (p) => p.q('[data-reverse-panel]');
const rowOf = (p, id) => p.q(`[data-payment="${id}"]`);

test('A VERIFIED PAYMENT HAS "PAYMENT FAILED…"; a waiting or failed one does not. It opens a PREVIEW of what would change — and until you confirm, nothing has', async () => {
  const h = u('payer'); const c = await person(h); const go = await goOrder(); await claimAndSecure(app, admin, h, await item(go, 12, 'Album One')); await claimAndSecure(app, admin, h, await item(go, 8, 'Album Two')); const pay = await verified(c, h, 20);
  const waiting = await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount: 3, reference: u('WAIT') }, c); assert.equal(waiting.status, 400, 'nothing owed → refused (sanity)');
  const p = await open(); assert.ok(p.q('[data-act="reverse"]', rowOf(p, pay.id))); await p.click(p.q('[data-act="reverse"]', rowOf(p, pay.id))); await sleep(250); await p.settle();
  const pn = panel(p); assert.ok(pn, 'the panel opens under the payment'); const t = p.text(pn);
  assert.match(t, /Mark this £20\.00 payment as failed.*£20\.00 is owed again, across 2 lines:.*Album One @.* — £12\.00.*Album Two @.* — £8\.00/s); assert.match(t, /The payment stays on record, marked as failed\. No email is sent — message them yourself\./);
  assert.equal((await app.q('SELECT status FROM payments WHERE id = ?', [pay.id]))[0].status, 'confirmed', 'nothing has changed yet'); assert.equal(await owed(c, h), 0);
  await p.click(p.q('[data-act="reverse-cancel"]', pn)); assert.equal(panel(p), null); assert.equal((await app.q('SELECT status FROM payments WHERE id = ?', [pay.id]))[0].status, 'confirmed', 'cancel changes nothing'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('CONFIRMING DOES IT: the reason you type is kept, the toast says what is owed again, and the payment now reads "failed after it was received" under "Marked as failed"', async () => {
  const h = u('payer'); const c = await person(h); const go = await goOrder(); await claimAndSecure(app, admin, h, await item(go, 14)); const pay = await verified(c, h, 14);
  const p = await open(); await p.click(p.q('[data-act="reverse"]', rowOf(p, pay.id))); await sleep(250); await p.settle(); const box = p.q('input[name="reverseReason"]', panel(p));
  box.value = 'Bank transfer bounced'; box.dispatchEvent(new p.window.Event('input', { bubbles: true })); assert.equal(p.q('input[name="reverseReason"]', panel(p)), box, 'typing does not rebuild the panel (the cursor stays)');
  await p.click(p.q('[data-act="reverse-go"]', panel(p))); await sleep(350); await p.settle(); assert.match(toast(p), /Marked as failed: £14\.00 is owed again\./);
  const row = (await app.q('SELECT status, reverse_reason FROM payments WHERE id = ?', [pay.id]))[0]; assert.deepEqual([row.status, row.reverse_reason], ['reversed', 'Bank transfer bounced']); assert.equal(await owed(c, h), 14);
  const sel = p.q('[data-filter="status"]'); sel.value = 'reversed'; sel.dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(250); await p.settle();
  const r = rowOf(p, pay.id); assert.ok(r, 'listed under "Marked as failed"'); assert.match(p.text(p.q('[data-reversed]', r).parentElement), /failed after it was received.*Bank transfer bounced/); assert.equal(p.q('[data-act="reverse"]', r), null, 'and cannot be marked again'); p.close();
});

test('THE PREVIEW TELLS THE WHOLE STORY about credit: credit the payment created is taken back; credit already spent means those items are owed again (and is flagged)', async () => {
  const h = u('over'); const c = await person(h); const go = await goOrder(); await claimAndSecure(app, admin, h, await item(go, 10, 'First item')); const pay = await verified(c, h, 15, { overpay: { choice: 'credit' } });
  let p = await open(); await p.click(p.q('[data-act="reverse"]', rowOf(p, pay.id))); await sleep(250); await p.settle(); assert.match(p.text(panel(p)), /£10\.00 is owed again.*£5\.00 of credit that this payment created is taken back\./s); assert.doesNotMatch(p.text(panel(p)), /already been spent/); p.close();
  await claimAndSecure(app, admin, h, await item(go, 5, 'Second item'));                                                              // the £5 credit now pays for this
  p = await open(); await p.click(p.q('[data-act="reverse"]', rowOf(p, pay.id))); await sleep(250); await p.settle(); const t = p.text(panel(p));
  assert.match(t, /£15\.00 is owed again.*Second item.*paid with credit from this payment/s); assert.match(t, /£5\.00 of that credit had already been spent, so the items it paid for are owed again too \(shown above\)\./); p.close();
});

test('A COMBINED PAYMENT: one "Payment failed…" on the line, one preview covering every part, and the whole line then shows as failed', async () => {
  const [a, b] = [u('ha'), u('hb')]; const c = await person(a, b); const go = await goOrder(); await claimAndSecure(app, admin, a, await item(go, 10)); await claimAndSecure(app, admin, b, await item(go, 6)); const pay = await verified(c, 'all', 16);
  const p = await open(); const line = p.q(`[data-payment-batch="${pay.batchKey}"]`); assert.ok(line); await p.click(p.q('[data-act="reverse"]', line)); await sleep(250); await p.settle();
  assert.match(p.text(panel(p)), /Mark this £16\.00 payment as failed.*£16\.00 is owed again, across 2 lines/s); await p.click(p.q('[data-act="reverse-go"]', panel(p))); await sleep(350); await p.settle();
  assert.deepEqual((await app.q('SELECT status FROM payments WHERE batch_key = ?', [pay.batchKey])).map((x) => x.status), ['reversed', 'reversed']); assert.equal((await api('GET', '/api/my/summary?handle=all', undefined, c)).json.owed.total, 16); p.close();
  const q = await open('reversed'); assert.ok(p.q === p.q && q.q(`[data-payment-batch="${pay.batchKey}"] [data-reversed]`), 'the whole combined line reads as failed'); q.close();
});

test('THE PERSON SEES IT: their pay page says the payment failed after it was received, and the form is back asking for what they owe', async () => {
  const h = u('seen'); const c = await person(h); const go = await goOrder(); await claimAndSecure(app, admin, h, await item(go, 9)); const pay = await verified(c, h, 9);
  assert.equal((await api('POST', `/api/admin/payments/${pay.id}/reverse`, { reason: 'x' })).status, 200);
  const p = await openPage(app, '/my.html#/pay', { cookies: [c] }); await sleep(200); await p.settle(); assert.match(p.text(p.q('[data-failed]')), /the payment failed after it was received — it is owed again, please check with the GOM/);
  assert.ok(p.q('form[data-form="pay"]'), 'the form is there again'); assert.equal(p.q('form[data-form="pay"]').elements.amount.value, '9'); assert.equal(p.q('[data-waiting]'), null, 'a failed payment is not "waiting"'); p.close();
});

test('ONE CLICK = ONE REVERSAL (a double click does not send twice) and the item names in the preview are shown as text', async () => {
  const h = u('once'); const c = await person(h); const go = await goOrder(); await claimAndSecure(app, admin, h, await item(go, 7, '<img src=x onerror="window.pwned=1"> Album')); const pay = await verified(c, h, 7);
  const p = await open(); await p.click(p.q('[data-act="reverse"]', rowOf(p, pay.id))); await sleep(250); await p.settle(); assert.equal(p.q('img[src="x"]'), null); assert.equal(p.window.pwned, undefined); assert.match(p.text(panel(p)), /<img src=x onerror="window\.pwned=1"> Album/);
  const orig = p.window.fetch; let posts = 0; p.window.fetch = (...a) => { if (/\/reverse/.test(String(a[0])) && a[1]?.method === 'POST' && !/dryRun/.test(a[1].body || '')) posts++; return orig(...a); };
  const go_ = p.q('[data-act="reverse-go"]', panel(p)); go_.click(); go_.click(); await sleep(450); await p.settle(); assert.equal(posts, 1, 'two clicks, one request'); assert.equal((await app.q('SELECT status FROM payments WHERE id = ?', [pay.id]))[0].status, 'reversed'); p.close();
});
