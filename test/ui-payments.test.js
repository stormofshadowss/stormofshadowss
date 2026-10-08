import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

let app, admin, w;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const ledger = async (h) => (await api('GET', `/api/admin/ledger?handle=${h}`)).json;
const open = async (label = 'Payments') => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', label)); return p; };
async function payer(handle, { item = w.keyring, address = null } = {}) {
  const c = await joinerSession(app, `${handle}@x.com`, handle);
  if (address) await app.api('PUT', '/api/my/address', { fullName: address, address: '1 Road, Leeds', email: `${handle}@x.com`, phone: '0700' }, c);
  await claimAndSecure(app, admin, handle, item);
  return c;
}
const pay = (c, body) => app.api('POST', '/api/my/payments', { method: 'PayPal', ...body }, c);
const rowOf = (p, id) => p.q(`tr[data-payment="${id}"]`);

test('"Where joiners send payment": add, save, remove, and mistakes are explained', async () => {
  const p = await open();
  assert.equal(p.qa('[data-mrow]').length, 0);
  await p.click(p.byText('[data-act="add-method"]', '＋ Add a method'));
  p.qa('[data-mrow]')[0].querySelector('[name=method]').value = 'PayPal';
  await p.submit(p.q('form[data-form="methods"]'));
  assert.match(p.text(p.q('form[data-form="methods"] [data-msg]')), /needs both a name and where to pay/);
  p.qa('[data-mrow]')[0].querySelector('[name=info]').value = '@storm (Friends & Family)';
  await p.click(p.byText('[data-act="add-method"]', '＋ Add a method'));
  const rows = p.qa('[data-mrow]');
  rows[1].querySelector('[name=method]').value = 'Wise'; rows[1].querySelector('[name=info]').value = '@stormw';
  await p.submit(p.q('form[data-form="methods"]'));
  assert.match(toast(p), /Saved/);
  assert.deepEqual((await api('GET', '/api/payment-methods')).json.methods, [{ method: 'PayPal', accountInfo: '@storm (Friends & Family)' }, { method: 'Wise', accountInfo: '@stormw' }]);
  await p.click(p.q('[data-mrow] [data-act="remove-method"]'));        // remove PayPal...
  await p.click(p.byText('[data-act="add-method"]', '＋ Add a method'));  // ...and put it back, to leave both for the later tests
  const r2 = p.qa('[data-mrow]'); r2[1].querySelector('[name=method]').value = 'PayPal'; r2[1].querySelector('[name=info]').value = '@storm (Friends & Family)';
  await p.submit(p.q('form[data-form="methods"]'));
  assert.deepEqual((await api('GET', '/api/payment-methods')).json.methods.map((m) => m.method), ['Wise', 'PayPal']);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('the waiting list shows everything needed to decide, with a badge', async () => {
  const amy = await payer('amy_p', { item: w.album, address: 'Amy Fan' });
  const bea = await payer('bea_p');
  const cat = await payer('cat_p', { address: 'Cat Cee' });
  const a = (await pay(amy, { amount: 30, reference: 'TX-AMY', overpay: { choice: 'tip', note: 'thanks!' } })).json.id;
  const b = (await pay(bea, { amount: 6, payerName: 'Bea B' })).json.id;
  const c = (await pay(cat, { amount: 6, payerChoice: 'other', payerName: 'Dan Dee' })).json.id;
  app.ids = { a, b, c };
  const p = await open();
  assert.equal(p.q('#tabs [data-tab="payments"] .badge').textContent, '3');
  const amyRow = p.text(rowOf(p, a)), beaRow = p.text(rowOf(p, b)), catRow = p.text(rowOf(p, c));
  assert.match(amyRow, /@amy_p.*Run It GO|All outstanding/); assert.match(amyRow, /£30\.00.*PayPal.*TX-AMY.*Amy Fan.*matches address name/);
  assert.match(amyRow, /£4\.00 extra → tip.*thanks!/);
  assert.match(beaRow, /no reference.*Bea B.*no name on file/);
  assert.match(catRow, /Dan Dee.*different name — address says Cat Cee/);
  assert.match(amyRow, /\d\d\/\d\d\/\d{4} \d\d:\d\d/, 'UK date and time');
  p.close();
});

test('verifying: asked first; keeping it changes nothing; confirming applies the money and says how the extra was treated', async () => {
  const p = await open();
  const { a, c } = app.ids;
  await p.click(p.q(`[data-act="verify"][data-id="${a}"]`));
  assert.match(p.text(modal(p)), /Mark the £30\.00 payment from @amy_p as received\?/);
  assert.match(p.text(modal(p)), /paid £4\.00 extra and chose for it to be a tip/);
  await press(p, 'Cancel');
  assert.equal((await api('GET', '/api/admin/payments?status=pending')).json.payments.length, 3, 'nothing changed');
  await p.click(p.q(`[data-act="verify"][data-id="${a}"]`)); await press(p, 'Yes, it arrived');
  assert.match(toast(p), /Verified: £26\.00 applied\. £4\.00 recorded as a tip/);
  assert.equal((await claimsOf('amy_p'))[0].costs.initials.paid, 26);
  assert.equal((await ledger('amy_p')).entries.find((e) => e.kind === 'tip').amount, 4);
  assert.equal(p.q('#tabs [data-tab="payments"] .badge').textContent, '2', 'the badge follows');
  await p.click(p.q(`[data-act="verify"][data-id="${c}"]`));
  assert.match(p.text(modal(p)), /paid under a different name \(Dan Dee\)/);
  await press(p, 'Cancel');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('rejecting moves no money', async () => {
  const p = await open();
  const { b } = app.ids;
  await p.click(p.q(`[data-act="reject"][data-id="${b}"]`));
  assert.match(p.text(modal(p)), /No money is moved/);
  await press(p, 'Reject it');
  assert.match(toast(p), /Rejected/);
  assert.equal((await claimsOf('bea_p'))[0].costs.initials.paid, 0);
  assert.equal((await api('GET', '/api/admin/payments?status=rejected')).json.payments.length, 1);
  p.close();
});

test('a stale page: if the payment was already dealt with elsewhere, you are told and the list refreshes', async () => {
  const dave = await payer('dave_p');
  const d = (await pay(dave, { amount: 6, reference: 'STALE' })).json.id;
  const p = await open();
  await api('POST', `/api/admin/payments/${d}/verify`, {});                     // done in another tab
  await p.click(p.q(`[data-act="verify"][data-id="${d}"]`)); await press(p, 'Yes, it arrived');
  assert.match(toast(p), /already been dealt with/);
  assert.equal(rowOf(p, d), null, 'and it is no longer listed as waiting');
  p.close();
});

test('filters and search; names with HTML are shown as text', async () => {
  const eve = await payer('eve_p');
  const e = (await pay(eve, { amount: 6, reference: '<img src=x onerror="window.pwned=1">', payerName: '<b>Eve</b>' })).json.id;
  const p = await open();
  assert.equal(p.q('img[src="x"]'), null);
  assert.match(p.text(rowOf(p, e)), /<img src=x onerror="window\.pwned=1">/);
  assert.equal(p.window.pwned, undefined);
  await p.choose(p.q('[data-filter="status"]'), 'confirmed');
  assert.match(p.text(p.q('tbody')), /@amy_p/); assert.doesNotMatch(p.text(p.q('tbody')), /@eve_p/);
  await p.type(p.q('[data-filter="q"]'), 'tx-amy');
  assert.match(p.text(p.q('tbody')), /@amy_p/);
  assert.equal(p.document.activeElement, p.q('[data-filter="q"]'), 'typing keeps the cursor in the box');
  await p.type(p.q('[data-filter="q"]'), 'nothing like this');
  assert.match(p.text(p.q('tbody')), /No payments match/);
  await p.choose(p.q('[data-filter="status"]'), 'pending'); await p.type(p.q('[data-filter="q"]'), '');
  assert.match(p.text(p.q('tbody')), /@eve_p/);
  p.close();
});

test('credit and tips: look someone up, add and remove credit, with the server\'s rules explained', async () => {
  const p = await open();
  assert.match(p.text(p.q('#tabBody')), /Tips received so far: £4\.00/);
  const lookup = async (h) => { p.fill(p.q('form[data-form="lookup"]'), { handle: h }); await p.submit(p.q('form[data-form="lookup"]')); };
  await lookup('@Amy_P');
  assert.match(p.text(p.q('#tabBody')), /@amy_p — credit on account: £0\.00/);
  assert.match(p.text(p.q('#tabBody')), /Tip.*£4\.00/);
  const add = async (amount, reason) => { const f = p.q('form[data-form="credit-add"]'); p.fill(f, { amount, reason }); await p.submit(f); };
  const remove = async (amount, reason = '') => { const f = p.q('form[data-form="credit-remove"]'); p.fill(f, { amount, reason }); await p.submit(f); };
  await add('5', '');
  assert.match(p.text(p.q('form[data-form="credit-add"] [data-msg]')), /Add a reason/);
  await add('5', 'goodwill after a delay');
  assert.match(toast(p), /Credit added/);
  assert.match(p.text(p.q('#tabBody')), /credit on account: £5\.00/);
  assert.match(p.text(p.q('#tabBody')), /Credit added.*£5\.00.*goodwill after a delay/);
  await remove('3', 'refunded by bank');
  assert.match(p.text(p.q('#tabBody')), /credit on account: £2\.00/);
  await remove('5');
  assert.match(p.text(p.q('form[data-form="credit-remove"] [data-msg]')), /only have £2\.00 unspent/);
  await lookup('nobody_here');
  assert.match(p.text(p.q('#tabBody')), /No credit history/);
  const f = p.q('form[data-form="credit-add"]'); p.fill(f, { amount: '1', reason: 'x' }); await p.submit(f);
  assert.match(p.text(p.q('form[data-form="credit-add"] [data-msg]')), /No such handle/);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});
