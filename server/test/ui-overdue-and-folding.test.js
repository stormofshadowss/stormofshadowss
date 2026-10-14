import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage, gomPage } from './ui.helpers.js';

// Three things found while importing real data: Request shipping has Select all; My orders folds by group order and shows overdue in RED (with a notice on the dashboard);
// the admin Claims screen folds each group order down to one line.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'od') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READY = 'ready to pack / on hand';
const goOrder = async (title, extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam', ...extra })).json.id;
const newItem = async (go, title = u('Thing '), price = 10) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price })).json.id;
const cookies = {};
const joiner = async (h) => { cookies[h] = await joinerSession(app, `${h}@x.com`, h); await api('PUT', '/api/my/address', { fullName: 'Test Person', address: '1 Road, Leeds', email: `${h}@x.com`, phone: '0700123456' }, cookies[h]); return cookies[h]; };
const mine = (h, hash = '') => openPage(app, `/my.html${hash}`, { cookies: [cookies[h]] });
const go = async (p, hash) => { if (p.window.location.hash === hash) p.window.dispatchEvent(new p.window.HashChangeEvent('hashchange')); else p.window.location.hash = hash; await sleep(40); await p.settle(); };
const text = (p, sel, root) => p.text(p.q(sel, root));
const late = '2000-01-01', future = '2099-01-01';
// a joiner with one item in each of the given group orders (overdue ones have a payment deadline in the past)
async function withOrders(h, specs) {
  await joiner(h); const out = [];
  for (const [title, deadline] of specs) { const g = await goOrder(title, { paymentDeadline: deadline }); const it = await newItem(g, `${title} item`, 10); const [c] = await claimAndSecure(app, admin, h, it); out.push({ g, it, c, title }); }
  return out;
}

// ───────── Request shipping: Select all ─────────
test('REQUEST SHIPPING: "Select all N" and "Clear" appear when there are two or more items, and tick / untick every one', async () => {
  const h = u('sa'); const os = await withOrders(h, [['Ship A', future], ['Ship B', future], ['Ship C', future]]);
  for (const o of os) await api('PATCH', `/api/admin/claims/${o.c}`, { pipeline: READY });
  const p = await mine(h); await go(p, '#/ship');
  const form = p.q('form[data-form="ship"]'); const boxes = () => p.qa('input[name="claim"]', form);
  assert.equal(boxes().length, 3); assert.equal(boxes().filter((b) => b.checked).length, 0);
  const all = p.q('[data-act="ship-all"]', form); assert.equal(p.text(all), 'Select all 3'); await p.click(all); assert.equal(boxes().filter((b) => b.checked).length, 3, 'all ticked');
  await p.click(p.q('[data-act="ship-none"]', form)); assert.equal(boxes().filter((b) => b.checked).length, 0, 'cleared');
  boxes()[1].checked = true; await p.click(all); assert.equal(boxes().filter((b) => b.checked).length, 3, 'select all also ticks the ones not yet ticked');
  assert.deepEqual(p.errors, []); p.close();
});

test('REQUEST SHIPPING: with only one item there is nothing to "select all"', async () => {
  const h = u('sa1'); const [o] = await withOrders(h, [['Solo ship', future]]); await api('PATCH', `/api/admin/claims/${o.c}`, { pipeline: READY });
  const p = await mine(h); await go(p, '#/ship'); assert.equal(p.q('[data-act="ship-all"]'), null); assert.equal(p.qa('input[name="claim"]').length, 1); p.close();
});

// ───────── My orders: overdue in red, and the dashboard notice ─────────
test('THE DASHBOARD SAYS SO when something is overdue: the total, how many items, which orders, and where to go — and says nothing when nothing is', async () => {
  const h = u('dn'); await withOrders(h, [['Late One', late], ['Late Two', late], ['On Time', future]]);
  const p = await mine(h); const n = p.q('[data-overdue-notice]');
  assert.ok(n, 'a notice'); assert.equal(n.getAttribute('role'), 'alert'); assert.match(p.text(n), /You have overdue payments.*£20\.00 is overdue across 2 items \(Late One, Late Two\)\./s, 'only the two late ones, not the on-time one');
  assert.equal(p.q('a[href="#/pay"]', n).textContent, 'Pay now'); assert.equal(p.q('a[href="#/ongoing"]', n).textContent, 'See which items');
  assert.ok(p.q('[data-overdue-notice]').compareDocumentPosition(p.q('.cards')) & 4, 'it comes before the menu of sections');
  const h2 = u('dn'); await withOrders(h2, [['Fine A', future]]); const q = await mine(h2); assert.equal(q.q('[data-overdue-notice]'), null, 'nothing overdue: no notice'); p.close(); q.close();
});

test('THE DASHBOARD NOTICE: counts only what is still owed, lists at most three orders, and clears once paid', async () => {
  const h = u('dp'); const os = await withOrders(h, [['O1', late], ['O2', late], ['O3', late], ['O4', late], ['O5', late]]);
  let p = await mine(h); assert.match(text(p, '[data-overdue-notice]'), /£50\.00 is overdue across 5 items \(O1, O2, O3 and 2 more\)\./); p.close();
  for (const o of os) await api('PATCH', `/api/admin/claims/${o.c}`, { costs: { initials: { paid: 10 } } });          // paid in full
  p = await mine(h); assert.equal(p.q('[data-overdue-notice]'), null, 'paid: it goes'); p.close();
});

test('ONGOING ORDERS: overdue is RED — the pill, the item\'s left edge, "was due", the cost chip and the order\'s badge; what is merely owed stays yellow', async () => {
  const h = u('rd'); await withOrders(h, [['Red GO', late], ['Fine GO', future]]);
  const p = await mine(h); await go(p, '#/ongoing');
  const red = p.q('[data-go="Red GO"]'), fine = p.q('[data-go="Fine GO"]');
  assert.match(text(p, '[data-go-overdue]', red), /^1 overdue · £10\.00$/); assert.ok(p.q('[data-go-overdue].pill.err', red)); assert.ok(red.classList.contains('has-overdue'));
  assert.ok(p.q('.itemrow.overdue', red)); assert.ok(p.qa('.itemrow .pill.err', red).some((x) => p.text(x) === 'overdue'), 'a red "overdue" pill'); assert.match(text(p, '.late-text', red), /^was due 01\/01\/2000$/);
  assert.ok(p.q('.pill.err', p.q('.itemrow', red)) && p.qa('.pill.err', red).some((x) => /Initials £10\.00 · £10\.00 to pay/.test(p.text(x))), 'the owing chip is red');
  assert.equal(p.q('.pill.err', fine), null, 'nothing red on the one that is not late'); assert.equal(p.q('.itemrow.overdue', fine), null); assert.ok(p.qa('.pill.warn', fine).some((x) => /£10\.00 to pay/.test(p.text(x))), 'owed but not late: the usual yellow'); assert.equal(p.q('.late-text', fine), null); assert.match(p.text(p.q('.itemrow', fine)), /pay by 01\/01\/2099/, 'not late: it still says "pay by", in plain text');
  p.close();
});

// ───────── My orders: fold by group order ─────────
test('ONGOING ORDERS FOLD BY GROUP ORDER: a header with how many items and what is owed; a short list opens by itself; Open all / Close all; your choice sticks', async () => {
  const h = u('fo'); await withOrders(h, [['Fold A', future], ['Fold B', future]]);
  const p = await mine(h); await go(p, '#/ongoing'); const head = (t) => p.q(`[data-go="${t}"] [data-act="toggle-go"]`);
  assert.equal(head('Fold A').getAttribute('aria-expanded'), 'true', 'two orders: open'); assert.ok(p.q('.itemrow', p.q('[data-go="Fold A"]')));
  assert.match(text(p, '[data-go="Fold A"] .gobadges'), /£10\.00 to pay.*1 item/);
  await p.click(head('Fold A')); assert.equal(p.q('.itemrow', p.q('[data-go="Fold A"]')), null, 'folded'); assert.equal(head('Fold A').getAttribute('aria-expanded'), 'false'); assert.ok(p.q('.itemrow', p.q('[data-go="Fold B"]')), 'the other is untouched');
  await p.click(p.byText('button', 'Close all')); assert.equal(p.qa('.itemrow').length, 0); await p.click(p.byText('button', 'Open all')); assert.equal(p.qa('.itemrow').length, 2);
  p.close();
});

test('ONGOING ORDERS, A LONG LIST: with more than three group orders they start folded — except any with something overdue, which stay open', async () => {
  const h = u('lo'); await withOrders(h, [['Long 1', future], ['Long 2', future], ['Long 3', future], ['Long 4', late], ['Long 5', future]]);
  const p = await mine(h); await go(p, '#/ongoing'); const open = (t) => p.q(`[data-go="${t}"] [data-act="toggle-go"]`).getAttribute('aria-expanded') === 'true';
  assert.deepEqual(['Long 1', 'Long 2', 'Long 3', 'Long 4', 'Long 5'].map(open), [false, false, false, true, false], 'only the overdue one is open');
  assert.equal(p.qa('.itemrow').length, 1); assert.match(text(p, '[data-go="Long 1"] .gobadges'), /£10\.00 to pay/, 'the closed ones still say what is owed');
  await p.click(p.q('[data-go="Long 2"] [data-act="toggle-go"]')); assert.ok(open('Long 2'), 'opened by hand'); await go(p, '#/'); await go(p, '#/ongoing'); assert.ok(open('Long 2'), 'and it is still open when you come back'); p.close();
});

test('COMPLETED ORDERS fold too (and never say "to pay")', async () => {
  const h = u('co'); const os = await withOrders(h, [['Done A', future], ['Done B', future]]);
  for (const o of os) await api('PATCH', `/api/admin/claims/${o.c}`, { pipeline: 'completed', costs: { initials: { paid: 10 } } });
  const p = await mine(h); await go(p, '#/completed'); assert.equal(p.qa('[data-act="toggle-go"]').length, 2); assert.equal(p.q('.gobadges .pill'), null); await p.click(p.q('[data-act="toggle-go"]')); assert.equal(p.qa('.itemrow').length, 1); p.close();
});

test('NAMES WITH HTML in a group order\'s title are shown as text in the fold header and the notice', async () => {
  const h = u('xs'); await withOrders(h, [['<img src=x onerror="window.pwned=1"> GO', late]]);
  const p = await mine(h); assert.equal(p.q('img[src="x"]'), null); await go(p, '#/ongoing'); assert.equal(p.q('img[src="x"]'), null); assert.equal(p.window.pwned, undefined);
  assert.match(text(p, '[data-act="toggle-go"]'), /<img src=x onerror="window\.pwned=1"> GO/); p.close();
});

// ───────── admin Claims: a group order is one line ─────────
const claimsPage = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); await sleep(100); await p.settle(); return p; };
const goCard = (p, id) => p.q(`[data-go="${id}"]`);
const buyers = (p) => p.qa('[data-buyer]').length;

test('ADMIN CLAIMS: each group order folds to ONE LINE — its name, counts and what is owed — and "Secure all requested" stays on that line', async () => {
  const gos = []; for (const t of ['Fold Admin 1', 'Fold Admin 2', 'Fold Admin 3', 'Fold Admin 4']) { const g = await goOrder(t); const it = await newItem(g, `${t} thing`, 7); await app.api('POST', '/api/claims', { handle: u('adm'), lines: [{ itemId: it }] }); gos.push(g); }
  const p = await claimsPage();                                                          // more than three group orders on the page: they start folded
  for (const g of gos) { const c = goCard(p, g); assert.equal(p.q('[data-act="toggle-go"]', c).getAttribute('aria-expanded'), 'false'); assert.equal(p.q('[data-buyer]', c), null, 'no people shown'); assert.match(p.text(c), /1 claim · 1 waiting to be secured/); assert.ok(p.q('[data-act="secure"]', c), 'the bulk button is still on the line'); }
  await p.click(p.q('[data-act="toggle-go"]', goCard(p, gos[0]))); assert.equal(p.q('[data-act="toggle-go"]', goCard(p, gos[0])).getAttribute('aria-expanded'), 'true'); assert.ok(p.q('[data-buyer]', goCard(p, gos[0])), 'opened: the people appear'); assert.equal(p.q('[data-buyer]', goCard(p, gos[1])), null, 'the others stay folded');
  p.close();
});

test('ADMIN CLAIMS: a short list opens by itself; the owed amount shows on the folded line; Expand all / Collapse all; folding then searching or filtering shows what was found', async () => {
  const g = await goOrder('Short Admin GO'); const it = await newItem(g, 'Short thing', 12); const hs = [u('sh'), u('sh')]; for (const h of hs) await claimAndSecure(app, admin, h, it);
  const p = await claimsPage(); await p.choose(p.q('[data-filter="order"]'), String(g)); await sleep(120); await p.settle();
  assert.equal(buyers(p), 2, 'one group order shown: open'); assert.match(text(p, '.sub', goCard(p, g)), /owed £24\.00/);
  await p.click(p.byText('button', 'Collapse all')); assert.equal(buyers(p), 0); assert.match(text(p, '.sub', goCard(p, g)), /owed £24\.00/, 'folded, and still says what is owed');
  await p.click(p.byText('button', 'Expand all')); assert.equal(buyers(p), 2);
  await p.click(p.byText('button', 'Collapse all')); assert.equal(buyers(p), 0);
  await p.type(p.q('[data-filter="q"]'), hs[0]); await p.settle(); assert.equal(buyers(p), 1, 'a search opens what it found');
  await p.type(p.q('[data-filter="q"]'), ''); await p.settle(); await p.click(p.byText('button', 'Collapse all')); assert.equal(buyers(p), 0);
  await p.click(p.q('input[data-filter="unpaid"]')); await p.settle(); assert.equal(buyers(p), 2, 'so does a filter');
  p.close();
});

test('ADMIN CLAIMS BY ITEM folds the same way', async () => {
  const g = await goOrder('Item Fold GO'); const it = await newItem(g, 'Item fold thing'); await claimAndSecure(app, admin, u('if'), it);
  const p = await claimsPage(); await p.choose(p.q('[data-filter="order"]'), String(g)); await sleep(120); await p.settle(); await p.click(p.byText('button', 'By item')); await sleep(60);
  assert.ok(p.q('[data-item="Item fold thing"]'), 'open: the item shows'); await p.click(p.q('[data-act="toggle-go"]', goCard(p, g))); assert.equal(p.q('[data-item="Item fold thing"]'), null, 'folded'); p.close();
});
