import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { gomPage } from './ui.helpers.js';

// Claims → "+ Add a claim" → Item → "＋ New item…": make a plain item right there (hidden from joiners) and carry on adding the claim.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const u = (x = 'ni') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async (title = u('Quick item GO ')) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam' })).json.id;
const item = async (go, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Existing '), price: 10, ...extra })).json.id;
const person = async (h) => { await joinerSession(app, `${h}@x.com`, h); return h; };
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); await sleep(100); await p.settle(); return p; };
const panel = (p) => p.q('#addClaim');
const f = (p, sel) => p.q(sel, panel(p));
const openPanel = async (p) => { await p.click(p.q('[data-act="add-open"]')); return panel(p); };
const chooseOrder = (p, id) => p.choose(f(p, 'select[name="orderId"]'), String(id));
const chooseNew = (p) => p.choose(f(p, 'select[name="itemId"]'), '__new');
const optionTexts = (p) => p.qa('select[name="itemId"] option', panel(p)).map((o) => p.text(o));
const fillNew = async (p, { title, price, tbc }) => { if (title !== undefined) await p.type(f(p, 'input[name="niTitle"]'), title); if (price !== undefined) await p.type(f(p, 'input[name="niPrice"]'), String(price)); if (tbc) await p.click(f(p, 'input[name="niTbc"]')); };
const create = async (p) => { await p.click(f(p, '[data-act="ni-create"]')); await sleep(450); await p.settle(); };
const niError = (p) => p.text(f(p, '[data-ni-error]'));
const dbItems = async (go) => app.q('SELECT id, item_type AS type, title, price, price_tbc AS tbc, hidden_from_public AS hidden, sort_order AS s FROM items WHERE order_id = ? ORDER BY sort_order, id', [go]);
const publicTitles = async (go) => ((await app.api('GET', '/api/orders')).json.orders.find((o) => o.id === go)?.items || []).map((i) => i.title);

test('THE ITEM LIST ENDS WITH "＋ New item…" once a group order is chosen — not before, and the real items come first (cancelled ones still not listed)', async () => {
  const go = await goOrder(), empty = await goOrder(); const keep = await item(go, { title: 'Real item' }), dead = await item(go, { title: 'Dead item' }); await api('POST', `/api/admin/items/${dead}/cancel`, { confirm: 'Dead item' }); void keep;
  const p = await open(); await openPanel(p); assert.deepEqual(optionTexts(p), ['Choose a group order first'], 'nothing before a group order is chosen'); await chooseOrder(p, go); assert.deepEqual(optionTexts(p), ['Choose…', 'Real item — £10.00', '＋ New item…']);
  await chooseOrder(p, empty); assert.deepEqual(optionTexts(p), ['Choose…', '＋ New item…'], 'a group order with no items can still get one'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('CHOOSING IT SHOWS A SMALL FORM (title, price, price TBC, and what hidden means) and the claim details wait; what you had typed stays; Cancel puts the list back and creates nothing', async () => {
  const h = await person(u('who')), go = await goOrder(); await item(go); const p = await open(); await openPanel(p); await p.type(f(p, 'input[name="handle"]'), h); await p.click(f(p, 'input[name="status"][value="confirmed"]')); await chooseOrder(p, go); await chooseNew(p);
  const form = f(p, '[data-new-item]'); assert.ok(form, 'the form is there'); assert.match(p.text(form), /^New item in this group order\s*Title\s*Price \(£\)\s*Price still TBC\s*A plain item: one price, any quantity\. It is hidden from joiners — only you can add it for people\. Show it from Group Orders → Items when you want it on the order page\.\s*Create itemCancel$/);
  assert.equal(f(p, 'input[name="niTitle"]').placeholder, 'e.g. Washi tape'); assert.equal(f(p, 'input[name="niPrice"]').type, 'number'); assert.equal(f(p, 'input[name="qty"]'), null, 'no quantity yet — first make the item'); const before = (await dbItems(go)).length;
  await fillNew(p, { title: 'Half written' }); await p.click(f(p, '[data-act="ni-cancel"]')); assert.equal(f(p, '[data-new-item]'), null, 'the form is gone'); assert.equal(f(p, 'select[name="itemId"]').value, '', 'the list is back to "Choose…"'); assert.equal((await dbItems(go)).length, before, 'nothing was created');
  assert.deepEqual([f(p, 'input[name="handle"]').value, f(p, 'select[name="orderId"]').value, f(p, 'input[name="status"][value="confirmed"]').checked], [h, String(go), true], 'person, group order and status are as you left them'); await chooseNew(p); assert.equal(f(p, 'input[name="niTitle"]').value, '', 'a fresh form'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('CREATE ITEM: a plain item, HIDDEN from joiners, in that group order at the end of its list, already selected — then finish the claim (end to end)', async () => {
  const h = await person(u('buyer')), go = await goOrder(); const first = await item(go, { title: 'Already there' }); const p = await open(); await openPanel(p); await p.type(f(p, 'input[name="handle"]'), h); await chooseOrder(p, go); await chooseNew(p); await fillNew(p, { title: '  Washi tape  ', price: '3.50' }); await create(p);
  const rows = await dbItems(go); const made = rows.find((r) => r.title === 'Washi tape'); assert.ok(made, 'created (title tidied)'); assert.deepEqual([made.type, Number(made.price), !!made.tbc, !!made.hidden], ['normal', 3.5, false, true]); assert.deepEqual(rows.map((r) => r.id), [first, made.id], 'at the end of the list'); assert.ok(made.s > rows[0].s);
  assert.deepEqual(await publicTitles(go), ['Already there'], 'joiners do not see it'); assert.equal(f(p, '[data-new-item]'), null, 'the form closed'); assert.equal(f(p, 'select[name="itemId"]').value, String(made.id), 'and the new item is selected'); assert.deepEqual(optionTexts(p), ['Choose…', 'Already there — £10.00', 'Washi tape — £3.50', '＋ New item…']);
  assert.match(p.text(f(p, '[data-add-msg]')), /^Created “Washi tape” in this group order — hidden from joiners\. Now say how many, and add the claim\./); assert.deepEqual([f(p, 'input[name="handle"]').value, f(p, 'select[name="orderId"]').value], [h, String(go)], 'person and group order kept');
  await p.type(f(p, 'input[name="qty"]'), '2'); await p.click(f(p, 'input[name="status"][value="requested"]')); await p.submit(panel(p)); await sleep(300); await p.settle();
  const claims = await app.q('SELECT status FROM claims WHERE item_id = ?', [made.id]); assert.equal(claims.length, 2, 'two claims on the new item'); assert.ok(claims.every((c) => c.status === 'requested')); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('PRICE TBC: tick it and the price is switched off; the item is made with the price still to be set, and adding a claim says so; a price of £0 (free) is fine', async () => {
  const go = await goOrder(); const p = await open(); await openPanel(p); await chooseOrder(p, go); await chooseNew(p); await fillNew(p, { title: 'Mystery bonus', price: '9', tbc: true }); assert.equal(f(p, 'input[name="niPrice"]').disabled, true, 'price switched off'); await create(p);
  const made = (await dbItems(go)).find((r) => r.title === 'Mystery bonus'); assert.equal(!!made.tbc, true); assert.ok(optionTexts(p).includes('Mystery bonus (price TBC)')); assert.match(p.text(f(p, '[data-add-detail]')), /The price is still TBC — you can add this as a request, but it can't be confirmed until the price is set\./);
  await chooseNew(p); await fillNew(p, { title: 'Free gift', price: '0' }); await create(p); const free = (await dbItems(go)).find((r) => r.title === 'Free gift'); assert.deepEqual([Number(free.price), !!free.tbc], [0, false], 'free is fine'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('VALIDATION IS SAID IN THE FORM: a title is needed; a price is needed unless TBC; a negative price is refused — and nothing is created', async () => {
  const go = await goOrder(); const p = await open(); await openPanel(p); await chooseOrder(p, go); await chooseNew(p); const n0 = (await dbItems(go)).length;
  await create(p); assert.equal(niError(p), 'Enter a title for the new item.'); await fillNew(p, { title: 'Needs a price' }); await create(p); assert.equal(niError(p), 'Enter the price (£0 or more), or tick “Price still TBC”.'); await fillNew(p, { price: '-2' }); await create(p); assert.equal(niError(p), 'Enter the price (£0 or more), or tick “Price still TBC”.', 'negative');
  assert.equal((await dbItems(go)).length, n0, 'nothing created'); assert.ok(f(p, '[data-new-item]'), 'the form is still open with what you typed'); assert.equal(f(p, 'input[name="niTitle"]').value, 'Needs a price'); await p.type(f(p, 'input[name="niPrice"]'), '4'); await create(p); assert.equal((await dbItems(go)).length, n0 + 1, 'fixed, so it is made'); p.close();
});

test('ENTER IN THE FORM MAKES THE ITEM — it does not submit the claim; changing the group order closes the form; a server refusal is shown in the form', async () => {
  const h = await person(u('enter')), go = await goOrder(), other = await goOrder(); const p = await open(); await openPanel(p); await p.type(f(p, 'input[name="handle"]'), h); await chooseOrder(p, go); await chooseNew(p); await fillNew(p, { title: 'Made by Enter', price: '5' }); await p.submit(panel(p)); await sleep(450); await p.settle();
  assert.ok((await dbItems(go)).some((r) => r.title === 'Made by Enter'), 'the item was made'); assert.equal((await api('GET', `/api/admin/claims?handle=${h}`)).json.claims.length, 0, 'but no claim was submitted');
  await chooseNew(p); await fillNew(p, { title: 'Abandoned' }); await chooseOrder(p, other); assert.equal(f(p, '[data-new-item]'), null, 'a different group order closes the form'); assert.equal(f(p, 'select[name="itemId"]').value, ''); await chooseNew(p); assert.equal(f(p, 'input[name="niTitle"]').value, '', 'what was typed is dropped');
  await fillNew(p, { title: 'Too late', price: '1' }); assert.equal((await api('POST', `/api/admin/orders/${other}/cancel`, { confirm: (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === other).title })).status, 200, 'cancelled in another tab'); await create(p);
  assert.match(niError(p), /is cancelled, so items can't be added to it\./, 'the refusal is shown in the form'); assert.ok(f(p, '[data-new-item]'), 'and the form stays open'); assert.equal((await dbItems(other)).some((r) => r.title === 'Too late'), false, 'nothing was created'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('NOT OFFERED FOR A CARD BUNDLE (those are managed in the Cards tab); offered for an ordinary group order', async () => {
  const g = (await api('POST', '/api/admin/groups', { name: u('Cards group ') })).json.id; await app.q('INSERT INTO group_orders (group_id, title, status, is_private, is_cards) VALUES (?, ?, ?, 0, 1)', [g, 'Bundle for the cards', 'open']); const bundle = (await app.q('SELECT MAX(id) AS id FROM group_orders'))[0].id; const plain = await goOrder();
  const p = await open(); await openPanel(p); const orderLabels = p.qa('select[name="orderId"] option', panel(p)).map((o) => p.text(o)); assert.ok(orderLabels.includes('Bundle for the cards'), 'the bundle is on the list of group orders'); await chooseOrder(p, bundle); assert.equal(optionTexts(p).includes('＋ New item…'), false, 'but no quick new item for it'); await chooseOrder(p, plain); assert.ok(optionTexts(p).includes('＋ New item…')); p.close();
});

