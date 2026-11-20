import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// GOM → Group Orders → Items: a one-click Hide on a closed item (so you needn't open Edit and tick "Hide from joiners") and a Show on a hidden one.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Quick hide GO ${++N}`, proxy: 'Sam' })).json.id;
const mk = async (go, title, extra = {}) => { const r = await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title, ...extra }); assert.equal(r.status, 201, r.text); return r.json.id; };
const publicIds = async (go) => ((await app.api('GET', '/api/orders')).json.orders.find((o) => o.id === go)?.items || []).map((i) => i.id);
const adminItem = async (go, id) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === id);
const claims = async (id) => (await app.q("SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND status <> 'cancelled'", [id]))[0].n;
const itemsPage = async (go) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`)); await sleep(80); await p.settle(); return p; };
const row = (p, id) => p.q(`[data-act="edit-item"][data-id="${id}"]`).closest('tr');
const btn = (p, id, act) => row(p, id).querySelector(`[data-act="${act}"][data-id="${id}"]`);          // by id too: a button whose id wasn't filled in would otherwise pass
const done = async (p) => { await sleep(450); await p.settle(); };

test('A CLOSED ITEM HAS A ONE-CLICK HIDE (beside Reopen) — closed by hand or by its date: no question asked, it goes off the joiners\' page, the claims on it are untouched, and the row now shows it is hidden with a Show button', async () => {
  const go = await goOrder(); const byHand = await mk(go, 'Closed by hand'), byDate = await mk(go, 'Closed by date', { closeDate: new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10) }), keep = await mk(go, 'Stays visible');
  const h = `qh${++N}`; await joinerSession(app, `${h}@x.com`, h); assert.equal((await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: byHand }] })).status, 201); assert.equal((await api('PATCH', `/api/admin/items/${byHand}`, { closed: true })).status, 200);
  const p = await itemsPage(go); assert.equal(p.text(btn(p, byHand, 'item-hide')), 'Hide'); assert.equal(p.text(btn(p, byHand, 'item-reopen')), 'Reopen'); assert.equal(p.text(row(p, byHand).querySelector('[data-item-state]')), 'Closed by hand'); assert.ok(btn(p, byDate, 'item-hide'), 'closed by its date: Hide too'); assert.match(p.text(row(p, byDate).querySelector('[data-item-state]')), /^Closed /);
  assert.equal(btn(p, keep, 'item-hide'), null, 'an open item has no Hide (it has Close now)'); assert.ok(btn(p, keep, 'item-close')); assert.deepEqual((await publicIds(go)).sort(), [byHand, byDate, keep].sort(), 'all three are on the joiners\' page for now');
  await p.click(btn(p, byHand, 'item-hide')); await done(p); assert.equal(p.q('.ui-modal'), null, 'one click: no question'); assert.equal(toast(p), 'Hidden from joiners. Claims already on it are untouched.');
  assert.equal((await adminItem(go, byHand)).hidden, true); assert.deepEqual((await publicIds(go)).sort(), [byDate, keep].sort(), 'gone from the joiners\' page, the others still there'); assert.equal(await claims(byHand), 1, 'the claim on it is untouched');
  assert.ok(row(p, byHand).querySelector('[data-hidden-item]'), 'the row says it is hidden'); assert.equal(btn(p, byHand, 'item-hide'), null, 'no Hide on one that is already hidden'); assert.equal(p.text(btn(p, byHand, 'item-show')), 'Show'); assert.equal(p.text(row(p, byHand).querySelector('[data-item-state]')), 'Closed by hand', 'still closed'); assert.ok(btn(p, byHand, 'item-reopen'));
  assert.equal(btn(p, byDate, 'item-show'), null, 'the other closed item is not hidden'); assert.deepEqual(p.errors, []); p.close();
});

test('SHOW ON A HIDDEN ITEM ASKS FIRST (it may be a bonus you hide on purpose) and says what joiners will see; "Not yet" does nothing; "Show it" shows it again; an open hidden item has Show but no Hide', async () => {
  const go = await goOrder(); const closed = await mk(go, 'Closed and hidden', { hidden: true }), open = await mk(go, 'Open and hidden', { hidden: true }); assert.equal((await api('PATCH', `/api/admin/items/${closed}`, { closed: true })).status, 200);
  const p = await itemsPage(go); assert.ok(btn(p, open, 'item-show') && !btn(p, open, 'item-hide'), 'open + hidden: Show, no Hide'); assert.ok(btn(p, closed, 'item-show') && !btn(p, closed, 'item-hide'), 'closed + hidden: Show, no Hide');
  await p.click(btn(p, open, 'item-show')); assert.match(p.text(modal(p)), /^Show “Open and hidden” to joiners again\? They will be able to see it and claim it\.Not yetShow it$/); await press(p, 'Not yet'); await sleep(100); assert.equal((await adminItem(go, open)).hidden, true, 'Not yet: still hidden');
  await p.click(btn(p, closed, 'item-show')); assert.match(p.text(modal(p)), /^Show “Closed and hidden” to joiners again\? It is closed, so they will see it greyed out, saying “Closed for claims”\.Not yetShow it$/); await press(p, 'Show it'); await done(p);
  assert.equal(toast(p), 'Showing it to joiners again.'); assert.equal((await adminItem(go, closed)).hidden, false); assert.deepEqual(await publicIds(go), [closed], 'only the one you showed is on the joiners\' page'); assert.equal(row(p, closed).querySelector('[data-hidden-item]'), null, 'its "hidden" tag is gone'); assert.ok(btn(p, closed, 'item-hide'), 'and it can be hidden again'); assert.equal((await adminItem(go, open)).hidden, true, 'the other is still hidden'); p.close();
});

test('HIDING DOESN\'T CHANGE WHETHER IT IS CLOSED: reopening a hidden item leaves it hidden (use Show to bring it back), and a cancelled item has neither button', async () => {
  const go = await goOrder(); const it = await mk(go, 'Hidden then reopened'), gone = await mk(go, 'Cancelled item'); assert.equal((await api('PATCH', `/api/admin/items/${it}`, { closed: true })).status, 200); assert.equal((await api('PATCH', `/api/admin/items/${it}`, { hidden: true })).status, 200);
  const p = await itemsPage(go); await p.click(btn(p, it, 'item-reopen')); await press(p, 'Reopen it'); await done(p); assert.equal(toast(p), 'Reopened.'); const a = await adminItem(go, it); assert.deepEqual([a.closed, a.hidden], [false, true], 'open again, still hidden'); assert.deepEqual(await publicIds(go), [gone], 'only the other item is on the joiners\' page — the hidden one is not'); assert.ok(btn(p, it, 'item-show'), 'Show is still offered');
  assert.equal((await api('POST', `/api/admin/items/${gone}/cancel`, { confirm: 'Cancelled item' })).status, 200); const q = await itemsPage(go); assert.equal(btn(q, gone, 'item-hide'), null); assert.equal(btn(q, gone, 'item-show'), null); p.close(); q.close();
});
