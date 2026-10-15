import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage } from './ui.helpers.js';

// After sending payment details the person must SEE that it was sent (and not be able to send it twice): a clear confirmation replaces the form, the button locks while sending,
// and a payment already waiting for the GOM is taken into account.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); await app.q("INSERT IGNORE INTO payment_methods (method, account_info) VALUES ('PayPal', 'pay@example.com')"); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ps') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async (title = u('Sent GO ')) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam', paymentDeadline: '2099-01-01' })).json.id;
const item = async (go, price) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price })).json.id;
async function owing(...prices) { const h = u('pay'); const email = `${h}@x.com`; const cookie = await joinerSession(app, email, h); const orders = []; for (const price of prices) { const g = await goOrder(); orders.push(g); await claimAndSecure(app, admin, h, await item(g, price)); } return { h, cookie, orders }; }
const payPage = async (cookie) => { const p = await openPage(app, '/my.html#/pay', { cookies: [cookie] }); await sleep(200); await p.settle(); return p; };
const fill = (p, { ref = u('TXN'), method = 'PayPal', amount } = {}) => { const f = p.q('form[data-form="pay"]').elements; f.method.value = method; f.reference.value = ref; if (amount !== undefined) { f.amount.value = amount; f.amount.dispatchEvent(new p.window.Event('input', { bubbles: true })); } return ref; };
const form = (p) => p.q('form[data-form="pay"]');
const countOf = async (h) => (await app.q('SELECT COUNT(*) AS n FROM payments p JOIN joiners j ON j.id = p.joiner_id WHERE j.instagram_handle = ?', [h]))[0].n;

test('AFTER SENDING, A CLEAR CONFIRMATION REPLACES THE FORM and is scrolled into view — the form is not there to be filled in again', async () => {
  const { h, cookie } = await owing(12, 8); const p = await payPage(cookie); const seen = []; p.window.Element.prototype.scrollIntoView = function () { seen.push(this); };
  const ref = fill(p); await p.submit(form(p)); await sleep(350); await p.settle();
  const card = p.q('[data-sent]'); assert.ok(card, 'a confirmation'); assert.equal(form(p), null, 'the form has gone'); assert.match(p.text(card), /✓ Payment details sent\s*Thanks! Your £20\.00 payment is with the GOM to check — it'll count once they've marked it received\./);
  assert.match(p.text(card), /You don't need to do anything else, and please don't send it again — it's listed under Your payments below\./); assert.ok(seen.includes(card), 'scrolled into view (it used to appear above the form, out of sight on a phone)'); assert.equal(p.window.document.activeElement, card, 'and given focus, so a screen reader announces it');
  assert.equal(await countOf(h), 1); assert.match(p.text(p.q('#view')), new RegExp(`Your payments.*£20\\.00.*PayPal.*${ref}.*waiting for the GOM to check`, 's'), 'and it is already listed below'); assert.deepEqual(p.errors, [], 'no page errors'); p.close();
});

test('THE BUTTON LOCKS WHILE SENDING: a second tap does nothing — only one request is made', async () => {
  const { h, cookie } = await owing(15); const p = await payPage(cookie); const orig = p.window.fetch; let posts = 0; p.window.fetch = (...a) => { if (/\/api\/my\/payments/.test(String(a[0])) && a[1]?.method === 'POST') posts++; return orig(...a); };
  fill(p); const f = form(p), btn = p.q('button[type="submit"]', f); const submit = () => f.dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
  submit(); assert.deepEqual([btn.disabled, p.text(btn)], [true, 'Sending…'], 'locked, and says so, straight away'); submit(); submit(); await sleep(400); await p.settle();
  assert.equal(posts, 1, 'three taps, one request'); assert.equal(await countOf(h), 1); p.close();
});

test('IF SENDING FAILS the button comes back with its words and the reason is shown, so they can correct it and try again', async () => {
  const { h, cookie, orders } = await owing(10); const p = await payPage(cookie);                                                       // the page thinks £10 is owed…
  const [claim] = (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims; assert.equal((await api('PATCH', `/api/admin/claims/${claim.id}`, { status: 'cancelled' })).status, 200); void orders;   // …then the GOM cancels it
  fill(p); const f = form(p), btn = p.q('button[type="submit"]', f); await p.submit(f); await sleep(300); await p.settle();
  assert.match(p.text(p.q('[data-msg]', f)), /Nothing is owing right now/); assert.deepEqual([btn.disabled, p.text(btn), f.dataset.busy], [false, 'Send payment details', undefined], 'ready to try again'); assert.equal(p.q('[data-sent]'), null, 'no false confirmation'); p.close();
});

test('A PAYMENT ALREADY WAITING COVERS WHAT THEY OWE: the page says so and offers no form — only "I\'m sending a different payment" — and that brings the form back', async () => {
  const { h, cookie } = await owing(20); assert.equal((await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount: 20, reference: u('PRE') }, cookie)).status, 201);
  const p = await payPage(cookie); const n = p.q('[data-waiting]'); assert.match(p.text(n), /You've already sent £20\.00 — it's waiting for the GOM to check\.\s*That covers what you owe, so there is nothing more to send\./); assert.equal(form(p), null);
  await p.click(p.q('[data-act="pay-again"]', n)); assert.ok(form(p), 'the form is back'); assert.equal(form(p).elements.amount.value, '20'); p.close();
});

test('A PART-PAYMENT WAITING: the form asks only for what is still uncovered, and a single order is judged on its own', async () => {
  const { h, cookie, orders } = await owing(10, 10); assert.equal((await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount: 12, reference: u('PART') }, cookie)).status, 201);
  const p = await payPage(cookie); assert.match(p.text(p.q('[data-waiting]')), /You've already sent £12\.00.*Only £8\.00 is still to cover — the amount below is filled in for you\./); assert.equal(form(p).elements.amount.value, '8', 'not the full £20 again');
  form(p).elements.scope.value = String(orders[0]); form(p).elements.scope.dispatchEvent(new p.window.Event('change', { bubbles: true })); assert.equal(form(p).elements.amount.value, '10', 'one order: its own £10 (the waiting payment was not for that order)');
  p.close();
});

test('SENDING THE SAME THING AGAIN (an old tab, a retry): they are told it was already sent and nothing is recorded twice', async () => {
  const { h, cookie } = await owing(14); const p = await payPage(cookie); const ref = fill(p);                                       // the page is open and ready…
  assert.equal((await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount: 14, reference: ref }, cookie)).status, 201);          // …but the same payment has just gone in from somewhere else
  await p.submit(form(p)); await sleep(350); await p.settle(); assert.match(p.text(p.q('[data-sent]')), /You'd already sent this one — it's with the GOM to check, and nothing was recorded twice\./); assert.equal(await countOf(h), 1); p.close();
});

test('"I\'M SENDING A DIFFERENT PAYMENT" on the confirmation brings the form back; names with HTML are shown as text', async () => {
  const { h, cookie } = await owing(30); const p = await payPage(cookie); fill(p, { ref: '<img src=x onerror="window.pwned=1">', amount: 10 }); await p.submit(form(p)); await sleep(350); await p.settle();
  assert.equal(p.q('img[src="x"]'), null); assert.equal(p.window.pwned, undefined); assert.match(p.text(p.q('#view')), /<img src=x onerror="window\.pwned=1">/, 'shown as text in the list');
  await p.click(p.q('[data-act="pay-again"]')); assert.ok(form(p)); assert.equal(form(p).elements.amount.value, '20', 'the form is back, asking only for what is left after the £10 already sent'); assert.equal(p.q('[data-sent]'), null); assert.equal(await countOf(h), 1); p.close();
});
