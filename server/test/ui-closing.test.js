import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { openPage, gomPage, modal, press, toast } from './ui.helpers.js';
import { todayUK } from '../src/lib/closing.js';

// An item can close before the rest of its group order (on its own date, or by hand), and an order closes after its own date. Joiners see closed items greyed out, "Closed for claims";
// the GOM sets the dates and closes / reopens items from the Group Orders tab.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const u = (x = 'uc') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (offset) => { const d = new Date(`${todayUK()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const uk = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const goOrder = async (title = u('Closing GO '), extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam', ...extra })).json.id;
const item = async (go, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price: 10, ...extra })).json.id;
const patch = (id, b) => api('PATCH', `/api/admin/items/${id}`, b);
const shop = async (hash) => { const p = await openPage(app, `/${hash}`); await sleep(150); await p.settle(); return p; };
const card = (p, id) => p.q(`[data-item-card="${id}"]`);

// ───────── the joiner's page ─────────
test('A CLOSED ITEM IS VISIBLE BUT GREYED OUT, saying "Closed for claims", with no way to claim it — for every kind of item — while the rest of the order is untouched', async () => {
  const go = await goOrder(); const open = await item(go, { title: 'Still open' }), shut = await item(go, { title: 'Shut by hand' }), late = await item(go, { title: 'Shut by date', closeDate: day(-1) });
  const size = await item(go, { type: 'size', variants: ['M', 'L'], title: 'Shut tee' }), mem = await item(go, { type: 'independent', members: ['Felix', 'Han'], title: 'Shut cards' }), set = await item(go, { type: 'set', members: ['A', 'B'], price: 3, title: 'Shut set' });
  for (const id of [shut, size, mem, set]) await patch(id, { closed: true });
  const p = await shop(`#/order/${go}`);
  assert.ok(p.q('[data-act="inc"]', card(p, open)), 'the open one can be claimed'); assert.equal(p.q('[data-item-closed]', card(p, open)), null); assert.ok(!card(p, open).classList.contains('closed'));
  for (const [id, what] of [[shut, 'by hand'], [late, 'by date'], [size, 'size'], [mem, 'member'], [set, 'set']]) {
    const c = card(p, id); assert.ok(c, `${what}: still shown`); assert.ok(c.classList.contains('closed'), `${what}: greyed`); assert.equal(p.text(p.q('[data-item-closed]', c)), 'Closed for claims', what);
    assert.equal(p.q('[data-act="inc"], [data-act="dec"], [data-act="whole"]', c), null, `${what}: nothing to press`);
  }
  assert.match(p.text(card(p, shut)), /Shut by hand/); assert.deepEqual([p.errors], [[]]); p.close();
});

test('AN ITEM WITH A FUTURE CLOSING DATE says when it closes and can still be claimed; one closing today is still open', async () => {
  const go = await goOrder(); const soon = await item(go, { title: 'Closes soon', closeDate: day(3) }), today = await item(go, { title: 'Closes today', closeDate: day(0) });
  const p = await shop(`#/order/${go}`); assert.match(p.text(card(p, soon)), new RegExp(`closes ${uk(day(3))}`)); assert.ok(p.q('[data-act="inc"]', card(p, soon))); assert.equal(p.q('[data-item-closed]', card(p, soon)), null);
  assert.match(p.text(card(p, today)), new RegExp(`closes ${uk(day(0))}`)); assert.ok(p.q('[data-act="inc"]', card(p, today)), 'the closing day itself is still open'); await p.click(p.q('[data-act="inc"]', card(p, soon))); assert.match(p.text(p.q('.stepper span', card(p, soon))), /^1$/); p.close();
});

test('A GROUP ORDER PAST ITS CLOSING DATE reads as closed everywhere joiners look: not under Open now, not counted on the home page, nothing to claim', async () => {
  const gid = (await api('POST', '/api/admin/groups', { name: u('Dated crew ') })).json.id; const title = u('Expired GO ');
  const go = (await api('POST', '/api/admin/orders', { groupId: gid, title, proxy: 'Sam', closeDate: day(-1) })).json.id; await item(go, { title: 'Too late' }); const live = (await api('POST', '/api/admin/orders', { groupId: gid, title: u('Live GO '), proxy: 'Sam' })).json.id; await item(live);
  const p = await shop('#/'); assert.ok(!p.text(p.q('#homeOrders') || p.q('#view')).includes(title), 'not offered as an open order'); const g = (await (await fetch(`${app.base}/api/groups`)).json()).groups.find((x) => x.id === gid); assert.deepEqual([g.openOrders, g.closedOrders], [1, 1]);
  const q = await shop(`#/order/${go}`); assert.equal(q.q('[data-act="inc"]'), null, 'nothing to claim'); p.close(); q.close();
});

test('THE BASKET: pressing Claim on something that has closed since it was added says so, makes nothing, and takes it out of the basket', async () => {
  const go = await goOrder(); const a = await item(go, { title: 'Will close', price: 5 }), b = await item(go, { title: 'Stays open', price: 7 });
  const p = await shop(`#/order/${go}`); await p.click(p.q('[data-act="inc"]', card(p, a))); await p.click(p.q('[data-act="inc"]', card(p, b)));
  p.window.location.hash = '#/basket'; await sleep(150); await p.settle(); assert.match(p.text(p.q('#view')), /Will close.*Stays open/s);
  await patch(a, { closed: true });                                                                         // the GOM closes it while it is in someone's basket
  const h = u('basket'); p.q('#ig').value = h; await p.submit(p.q('#view form')); await sleep(300); await p.settle();
  assert.match(p.text(p.q('#view')), /That item has closed for claims/); assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ?', [h]))[0].n, 0, 'nothing was made');
  assert.doesNotMatch(p.text(p.q('#view')), /Will close/); assert.match(p.text(p.q('#view')), /Stays open/, 'the open item is still in the basket'); p.close();
});

// ───────── the GOM's screen ─────────
const gomOrders = async () => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); return p; };
const openItems = async (p, go) => { await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`)); await sleep(80); await p.settle(); };
const row = (p, id) => p.q(`[data-act="edit-item"][data-id="${id}"]`).closest('tr');
const cell = (p, id) => p.q('[data-closes]', row(p, id));

test('THE ITEMS TABLE has a "Closes" column: "with the order", a date, "Closed by hand", or "Closed <date>" — each with a Close now or Reopen button', async () => {
  const go = await goOrder(); const plain = await item(go), dated = await item(go, { closeDate: day(4) }), hand = await item(go); await patch(hand, { closed: true }); const gone = await item(go, { closeDate: day(-2) });
  const p = await gomOrders(); await openItems(p, go); assert.ok(p.byText('#itemsPanel th', 'Closes'));
  assert.match(p.text(cell(p, plain)), /^with the orderClose now$/); assert.ok(p.q('[data-act="item-close"]', cell(p, plain))); assert.match(p.text(cell(p, dated)), new RegExp(`^${uk(day(4))}Close now$`));
  assert.match(p.text(cell(p, hand)), /^Closed by handReopen$/); assert.equal(p.q('[data-item-state]', cell(p, hand)).dataset.itemState, 'hand'); assert.match(p.text(cell(p, gone)), new RegExp(`^Closed ${uk(day(-2))}Reopen$`)); assert.ok(p.q('[data-act="item-reopen"]', cell(p, gone))); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('CLOSE NOW asks first and says what happens; Reopen explains when it clears a date that has passed — and each does it', async () => {
  const go = await goOrder(); const a = await item(go, { title: 'Early closer' }), b = await item(go, { title: 'Past date', closeDate: day(-3) });
  const p = await gomOrders(); await openItems(p, go);
  await p.click(p.q('[data-act="item-close"]', cell(p, a))); assert.match(p.text(modal(p)), /Close “Early closer” for claims now\?.*greyed out, saying “Closed for claims”\. The rest of the group order stays open, anything already claimed is untouched, and you can reopen it any time\./s); await press(p, 'Not yet');
  assert.equal((await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === a).closedByHand, false, 'not yet means not yet');
  await p.click(p.q('[data-act="item-close"]', cell(p, a))); await press(p, 'Close it'); await sleep(250); await p.settle(); assert.match(toast(p), /Closed for claims\./); assert.match(p.text(cell(p, a)), /^Closed by handReopen$/);
  await p.click(p.q('[data-act="item-reopen"]', cell(p, b))); assert.match(p.text(modal(p)), new RegExp(`Reopen “Past date” for claims\\?.*Its closing date \\(${uk(day(-3))}\\) has passed, so that date is cleared as well — it will then follow the group order\\.`, 's')); await press(p, 'Reopen it'); await sleep(250); await p.settle();
  assert.match(toast(p), /Reopened\./); assert.match(p.text(cell(p, b)), /^with the orderClose now$/); await p.click(p.q('[data-act="item-reopen"]', cell(p, a))); assert.doesNotMatch(p.text(modal(p)), /cleared as well/, 'no date to clear: nothing extra to say'); await press(p, 'Not yet'); p.close();
});

test('THE DATE FIELD on the item forms: saved, shown, cleared; a date later than the group order\'s is explained; the add form takes one too', async () => {
  const go = await goOrder(undefined, { closeDate: day(10) }); const it = await item(go, { title: 'Editable' });
  const p = await gomOrders(); await openItems(p, go); await p.click(p.q(`[data-act="edit-item"][data-id="${it}"]`)); const form = () => p.q('form[data-form="edit-item"]');
  const input = () => p.q('input[name="closeDate"]', form()); assert.ok(input()); assert.match(p.text(form()), new RegExp(`Claims on this item stop after this day \\(UK time\\)\\. It can't be later than the group order's ${uk(day(10))}\\.`));
  input().value = day(11); await p.submit(form()); await sleep(200); await p.settle(); assert.match(p.text(p.q('[data-msg]', form())), new RegExp(`The group order closes on ${uk(day(10))}, so an item can't stay open longer than that`)); assert.ok(form(), 'the form stays open');
  input().value = day(6); await p.submit(form()); await sleep(250); await p.settle(); assert.match(p.text(cell(p, it)), new RegExp(`^${uk(day(6))}Close now$`));
  await p.click(p.q(`[data-act="edit-item"][data-id="${it}"]`)); assert.equal(input().value, day(6)); input().value = ''; await p.submit(form()); await sleep(250); await p.settle(); assert.match(p.text(cell(p, it)), /^with the orderClose now$/);
  const add = p.q('form[data-form="new-item"]'); assert.ok(p.q('input[name="closeDate"]', add)); p.q('input[name="title"]', add).value = 'Added with a date'; p.q('input[name="price"]', add).value = '4'; p.q('input[name="closeDate"]', add).value = day(2); await p.submit(add); await sleep(300); await p.settle();
  const made = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.title === 'Added with a date'); assert.equal(made.closeDate, day(2)); p.close();
});

test('ORDERS PAST THEIR DATE: "Closed (date passed)" in the list and a notice naming them (so imported ones are not missed); it clears when the date moves on; closed-by-hand orders are not in the notice', async () => {
  const late = await goOrder('Imported old GO', { closeDate: day(-5) }), fine = await goOrder('Fine GO', { closeDate: day(5) }), shut = await goOrder('Shut by hand GO', { status: 'closed', closeDate: day(-5) }); await item(late); await item(fine); await item(shut);
  const p = await gomOrders(); const n = () => p.q('[data-date-notice]'); assert.ok(n()); assert.match(p.text(n()), new RegExp(`open group orders? (is|are) past (its|their) closing date, so (it no longer takes|they no longer take) claims.*Imported old GO \\(${uk(day(-5))}\\).*To reopen one, edit it and change or clear its closing date`, 's'));
  assert.doesNotMatch(p.text(n()), /Fine GO|Shut by hand GO/); const rowOf = (id) => p.q(`[data-act="edit-order"][data-id="${id}"]`).closest('tr'); assert.ok(p.q('[data-closed-by-date]', rowOf(late))); assert.equal(p.q('[data-closed-by-date]', rowOf(fine)), null); assert.equal(p.q('[data-closed-by-date]', rowOf(shut)), null, 'closed by hand is just Closed');
  await api('PATCH', `/api/admin/orders/${late}`, { closeDate: day(3) }); const q = await gomOrders(); assert.equal(q.q('[data-closed-by-date]', q.q(`[data-act="edit-order"][data-id="${late}"]`).closest('tr')), null, 'a new date reopens it'); assert.ok(!q.q('[data-date-notice]') || !/Imported old GO/.test(q.text(q.q('[data-date-notice]')))); p.close(); q.close();
});

test('NAMES WITH HTML are shown as text in the notice, the table and the dialogs', async () => {
  const late = await goOrder('<img src=x onerror="window.pwned=1"> late', { closeDate: day(-1) }); const it = await item(late, { title: '<b>Bold</b> item' });
  const p = await gomOrders(); assert.equal(p.q('img[src="x"]'), null); assert.equal(p.window.pwned, undefined); assert.match(p.text(p.q('[data-date-notice]')), /<img src=x onerror="window\.pwned=1"> late/);
  await openItems(p, late); await p.click(p.q('[data-act="item-close"]', cell(p, it))); assert.match(p.text(modal(p)), /Close “<b>Bold<\/b> item”/); await press(p, 'Not yet'); p.close();
});
