import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage, toast } from './ui.helpers.js';

// Four tidy-ups: "Your proxies" folds away; boxes EN ROUTE fold to one line (with their group orders); the items panel sits under the OPEN group orders with the Add item form behind a button; Card types folds away.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'td') => `${x}${++N}`;
const goOrder = async (title = u('Tidy GO '), extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam', ...extra })).json.id;
const item = async (go, title = u('Thing '), extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price: 5, ...extra })).json.id;
const open = async (tab) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', tab)); await sleep(300); await p.settle(); return p; };
const done = async (p) => { await sleep(400); await p.settle(); };
const before_ = (p, a, b) => !!(a.compareDocumentPosition(b) & p.window.Node.DOCUMENT_POSITION_FOLLOWING);

test('YOUR PROXIES FOLDS AWAY: open (so you can set it up) until a proxy is ticked, then folded with a one-line summary; it stays however you leave it', async () => {
  await goOrder(u('A '), { proxy: u('ProxyOne') }); await goOrder(u('B '), { proxy: u('ProxyTwo') }); await goOrder(u('C '), { proxy: u('ProxyThree') });
  let p = await open('Proxy'); const d = () => p.q('#proxyMe'); assert.equal(d().tagName, 'DETAILS'); assert.equal(d().open, true, 'nothing ticked yet: open'); assert.equal(p.text(d().querySelector('summary')), 'Your proxies — none ticked yet'); const boxes = () => p.qa('input[data-proxy-self]');
  await p.click(boxes()[0]); await done(p); assert.equal(d().open, true, 'still open, so you can tick more'); assert.match(p.text(d().querySelector('summary')), /^Your proxies — .+ \(you\)$/); p.close();
  p = await open('Proxy'); assert.equal(d().open, false, 'one is ticked, so it starts folded'); assert.match(p.text(d().querySelector('summary')), /^Your proxies — .+ \(you\)$/); assert.ok(d().querySelector('input[data-proxy-self]'), 'the list is still inside');
  d().open = true; await p.click(boxes()[1]); await done(p); assert.equal(d().open, true, 'left open: stays open'); d().open = false; boxes()[2].click(); await done(p); assert.equal(d().open, false, 'folded: stays folded after it redraws'); assert.match(p.text(d().querySelector('summary')), /^Your proxies — .+, .+, .+ \(you\)$/, 'the summary names every proxy that is you'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('A BOX EN ROUTE FOLDS TO ONE LINE — its number and the group orders its items are from — and opens for everything; boxes being made are not folded (and are on Arrived, not here); it stays as you leave it; searching opens the matches', async () => {
  const goA = await goOrder('Alpha merch order'), goB = await goOrder('Beta fanart order'); const ia = await item(goA, 'Alpha thing'), ib = await item(goB, 'Beta thing');
  const handles = [u('bxa'), u('bxb'), u('bxc'), u('bxd'), u('bxe')]; const cs = []; for (const [h, it] of [[handles[0], ia], [handles[1], ib], [handles[2], ia], [handles[3], ib], [handles[4], ib]]) cs.push((await claimAndSecure(app, admin, h, it))[0]);
  assert.equal((await api('POST', '/api/admin/claims/pipeline', { claimIds: cs, pipeline: 'arrived at proxy / warehouse' })).status, 200); const mk = async (ids) => (await api('POST', '/api/admin/boxes', { claimIds: ids, emsTotal: 9 })).json.id; const A = await mk(cs.slice(0, 3)), B = await mk([cs[3]]), C = await mk([cs[4]]);
  for (const id of [A, C]) assert.equal((await api('POST', `/api/admin/boxes/${id}/enroute`, {})).status, 200);
  const api1 = (await api('GET', '/api/admin/boxes')).json.boxes.find((b) => b.id === A); assert.deepEqual([...new Set(api1.items.map((i) => i.orderTitle))], ['Alpha merch order', 'Beta fanart order'], 'each item says which group order it is from');
  const p = await open('Warehouse'); const fold = (id) => p.q(`details[data-box-fold="${id}"]`); const sub = async (v) => { await p.click(p.q(`[data-act="wh-view"][data-view="${v}"]`)); await sleep(150); await p.settle(); };
  assert.ok(p.q(`[data-box="${B}"]`), 'ARRIVED: a box still being made is here'); assert.equal(p.q(`details[data-box-fold] [data-box="${B}"]`), null, '…and is not folded'); assert.equal(p.q(`[data-box="${A}"]`), null, '…and a box that is en route is not here');
  await sub('enroute'); assert.ok(fold(A), 'ENROUTE: the en-route box is a fold'); assert.equal(fold(A).open, false, 'folded by default'); assert.equal(p.text(fold(A).querySelector('summary')), `Box #${A} En route to GOM — Alpha merch order, Beta fanart order · 3 items`); assert.ok(fold(A).querySelector(`[data-box="${A}"]`), 'everything is inside'); assert.equal(p.q(`[data-box="${B}"]`), null, 'a box still being made is not here');
  assert.match(p.text(fold(C).querySelector('summary')), new RegExp(`^Box #${C} En route to GOM — Beta fanart order · 1 item$`));
  fold(A).open = true; await p.click(p.q(`[data-act="arrived"][data-id="${C}"]`)); await done(p); assert.equal(fold(A).open, true, 'A stays open as you left it'); assert.equal(p.q(`[data-box="${C}"]`), null, 'C has arrived, so it has left Enroute');
  fold(A).open = false; await p.type(p.q('#boxSearch'), handles[0]); await sleep(400); await p.settle(); assert.equal(fold(A).open, true, 'searching opens the box that matches'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('GROUP ORDERS: the items panel sits right under the OPEN group orders (above Closed and Archived); typing in the search doesn\'t disturb it', async () => {
  const go = await goOrder(u('Open order ')), closed = await goOrder(u('Closed order '), { status: 'closed' }), arch = await goOrder(u('Archived order ')); await app.q("UPDATE group_orders SET status = 'closed', archived_at = NOW(3) WHERE id = ?", [arch]); void closed;
  const p = await open('Group Orders'); await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`)); await sleep(100); await p.settle(); const panel = p.q('#itemsPanel'); assert.ok(panel); assert.ok(p.q('#closedOrders') && p.q('#archivedOrders'), 'both sections exist');
  assert.ok(before_(p, p.q('#openOrders'), panel), 'the panel comes after the open group orders…'); assert.ok(before_(p, panel, p.q('#closedOrders')), '…and before Closed'); assert.ok(before_(p, p.q('#closedOrders'), p.q('#archivedOrders')));
  await p.type(p.q('#orderSearch'), 'Open order'); await sleep(150); assert.equal(p.q('#itemsPanel'), panel, 'the same panel — searching does not rebuild it'); assert.ok(before_(p, p.q('#openOrders'), p.q('#itemsPanel')) && before_(p, p.q('#itemsPanel'), p.q('#orderOthers')), 'still in place after the search'); p.close();
});

test('THE ADD ITEM FORM IS BEHIND A BUTTON: closed to begin with; opens when pressed; stays open while you add items; closed again for another group order; a new group order opens it', async () => {
  const a = await goOrder(u('First order ')), b = await goOrder(u('Second order ')); const p = await open('Group Orders'); await p.click(p.q(`[data-act="open-items"][data-id="${a}"]`)); await sleep(100); await p.settle();
  const box = () => p.q('#addItemBox'); assert.equal(box().tagName, 'DETAILS'); assert.equal(box().open, false, 'closed to begin with'); assert.equal(p.text(box().querySelector('summary')), '＋ Add an item'); assert.ok(box().querySelector('summary').classList.contains('btn-like'), 'looks like a button');
  await p.click(box().querySelector('summary')); assert.equal(box().open, true, 'opens when pressed'); const f = () => p.q('form[data-form="new-item"]'); p.fill(f(), { title: 'Added from the form', price: '4' }); await p.submit(f()); await done(p);
  assert.ok((await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === a).items.some((i) => i.title === 'Added from the form'), 'the item was added'); assert.equal(box().open, true, 'still open, ready for the next one'); assert.equal(f().elements.title.value, '', 'and empty');
  await p.click(p.q(`[data-act="open-items"][data-id="${b}"]`)); await sleep(100); await p.settle(); assert.equal(box().open, false, 'another group order: closed again'); await p.click(box().querySelector('summary')); await p.click(p.q('[data-act="close-items"]')); await p.click(p.q(`[data-act="open-items"][data-id="${b}"]`)); await sleep(100); await p.settle(); assert.equal(box().open, false, 'closing the panel closes it too');
  await p.click(p.byText('button', '＋ New group order')); const nf = p.q('form[data-form="new-order"]'); p.fill(nf, { group: String(w.group), title: u('Brand new ') }); await p.submit(nf); await done(p); assert.equal(toast(p), 'Group order created — now add its items.'); assert.equal(box().open, true, 'a new group order opens the form: you are about to add its items'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('CARD TYPES FOLDS AWAY: folded to begin with with a one-line summary; opens for the list and the form; stays as you leave it', async () => {
  const p = await open('Cards'); const d = () => p.q('[data-types]'); assert.equal(d().tagName, 'DETAILS'); assert.equal(d().open, false, 'folded to begin with'); assert.match(p.text(d().querySelector('summary')), /^Card types — \d+ types?, what each usually costs$/); assert.ok(d().querySelector('form[data-form="new-type"]'), 'the form is inside');
  d().open = true; const before = p.qa('[data-type-row]').length; const f = () => p.q('form[data-form="new-type"]'); p.fill(f(), { name: u('Fresh type '), price: '2.5' }); await p.submit(f()); await done(p); assert.equal(p.qa('[data-type-row]').length, before + 1, 'the type was added'); assert.equal(d().open, true, 'left open: stays open');
  assert.match(p.text(d().querySelector('summary')), new RegExp(`^Card types — ${before + 1} types?, what each usually costs$`), 'the count follows'); d().open = false; p.fill(f(), { name: u('Another type '), price: '3' }); await p.submit(f()); await done(p); assert.equal(d().open, false, 'folded: stays folded'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});
