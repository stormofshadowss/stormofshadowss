import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage, toast } from './ui.helpers.js';

// WAREHOUSE SUB-TABS: Unordered · Incoming · Arrived · Enroute · On hand — each with its count, opening on Arrived.
let app, admin, w, N = 0, boxes = {}, ids = {};
const ARRIVED = 'arrived at proxy / warehouse';
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); const api = (m, p, b) => app.api(m, p, b, admin);
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: 'Tabs order', proxy: 'Sam' })).json.id; const it = async (t) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title: t })).json.id; ids = { go, unordered: await it('Waiting to order'), waiting: await it('Boxed thing') };
  const claim = async (item, h) => (await claimAndSecure(app, admin, `${h}${++N}`, item))[0]; const toProxy = (c) => api('POST', '/api/admin/claims/pipeline', { claimIds: c, pipeline: ARRIVED });
  await claim(ids.unordered, 'un'); await claim(ids.unordered, 'un');
  const mk = async (h) => { const c = await claim(ids.waiting, h); await toProxy([c]); return { c, id: (await api('POST', '/api/admin/boxes', { claimIds: [c], emsTotal: 5 })).json.id }; };
  boxes.making = await mk('mk'); boxes.enroute = await mk('en'); await api('POST', `/api/admin/boxes/${boxes.enroute.id}/enroute`, {});
  boxes.check = await mk('tc'); await api('POST', `/api/admin/boxes/${boxes.check.id}/enroute`, {}); await api('POST', `/api/admin/boxes/${boxes.check.id}/arrived`, {});
  boxes.done = await mk('dn'); await api('POST', `/api/admin/boxes/${boxes.done.id}/enroute`, {}); await api('POST', `/api/admin/boxes/${boxes.done.id}/arrived`, {}); await api('POST', `/api/admin/boxes/${boxes.done.id}/ready`, { ready: [boxes.done.c], checking: [] });
  ids.waitingClaim = await claim(ids.waiting, 'wt'); await toProxy([ids.waitingClaim]);                                          // one item at the proxy, not in a box
  await api('POST', '/api/admin/store-orders', { store: 'Ktown4u', orderedOn: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), lines: [{ itemId: ids.unordered, qty: 1 }] });
});
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Warehouse')); await sleep(250); await p.settle(); return p; };
const sub = async (p, v) => { await p.click(p.q(`[data-act="wh-view"][data-view="${v}"]`)); await sleep(200); await p.settle(); };
const chips = (p) => p.qa('#whSwitch .chip');
const on = (p) => p.q('#whSwitch .chip.on').dataset.view;
const label = (p, v) => p.text(p.q(`#whSwitch [data-view="${v}"]`));
const body = (p) => p.text(p.q('#tabBody'));
const before_ = (p, a, b) => !!(a.compareDocumentPosition(b) & p.window.Node.DOCUMENT_POSITION_FOLLOWING);

test('FIVE SUB-TABS IN YOUR ORDER, OPENING ON ARRIVED, EACH WITH ITS COUNT (and what needs attention on it)', async () => {
  const c = (await api('GET', '/api/admin/warehouse/counts')).json; const p = await open();
  assert.deepEqual(chips(p).map((x) => x.dataset.view), ['unordered', 'incoming', 'arrived', 'enroute', 'onhand']); assert.equal(on(p), 'arrived', 'the Warehouse opens on Arrived'); assert.equal(p.q('#whSwitch .chip.on').getAttribute('aria-pressed'), 'true');
  assert.equal(label(p, 'unordered'), `Unordered (${c.unordered})`); assert.equal(label(p, 'incoming'), `Incoming (${c.incoming}) ${c.toChase} to chase`); assert.equal(label(p, 'arrived'), `Arrived (${c.arrived})`); assert.equal(label(p, 'enroute'), `Enroute (${c.enroute})`); assert.equal(label(p, 'onhand'), `On hand ${c.toCheck} to check`);
  assert.deepEqual([c.unordered >= 2, c.incoming >= 1, c.toChase >= 1, c.arrived >= 1, c.enroute >= 1, c.toCheck >= 1, c.checked >= 1], Array(7).fill(true), 'the fixtures are all reflected'); assert.ok(p.q('#whSwitch [data-to-chase-tab]') && p.q('#whSwitch [data-to-check-tab]')); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('WHAT EACH SUB-TAB SHOWS: Unordered = the To order list and the button to log a store order; Incoming = store orders (no To order chip any more); Arrived = items to box + boxes being made; Enroute = boxes on their way; On hand = To check, then Checked and ready', async () => {
  const p = await open(); assert.ok(p.q('#candToggle') && p.q('#boxEms'), 'ARRIVED: the New box form'); assert.ok(p.q('[data-boxes-making]') && p.q(`[data-boxes-making] [data-box="${boxes.making.id}"]`), '…and the boxes being made'); assert.equal(p.q('[data-boxes-enroute], [data-boxes-to-check]'), null);
  await sub(p, 'unordered'); assert.equal(on(p), 'unordered'); assert.ok(p.q('[data-to-order]'), 'UNORDERED: the To order list'); assert.ok(p.byText('button', '＋ New store order'), '…and the way to log a store order'); assert.equal(p.q('#boxEms'), null, 'no New box form here'); assert.equal(p.q('#orderFilter'), null, 'no store order filters here');
  await sub(p, 'incoming'); assert.ok(p.q('#incomingSummary'), 'INCOMING: the store orders summary'); assert.deepEqual(p.qa('#orderFilter .chip').map((x) => x.dataset.k), ['waiting', 'arrived', 'cancelled', 'all', 'items'], 'the filters — without a To order chip'); assert.equal(p.q('[data-to-order]'), null);
  await sub(p, 'enroute'); assert.ok(p.q('[data-boxes-enroute]') && p.q(`details[data-box-fold="${boxes.enroute.id}"]`), 'ENROUTE: the box on its way, folded'); assert.equal(p.q(`[data-box="${boxes.making.id}"]`), null, 'not the box being made');
  await sub(p, 'onhand'); assert.ok(p.q(`[data-boxes-to-check] [data-box="${boxes.check.id}"]`), 'ON HAND: the box that has arrived is under To check'); assert.ok(p.q(`[data-boxes-checked] details[data-box-fold="${boxes.done.id}"]`), '…and the checked one under Checked and ready, folded'); assert.ok(before_(p, p.q('[data-boxes-to-check]'), p.q('[data-boxes-checked]')), 'To check comes first');
  assert.match(p.text(p.q('[data-boxes-to-check] h2')), /^To check \(\d+\)$/); assert.match(p.text(p.q('[data-boxes-checked] h2')), /^Checked and ready \(\d+\)$/); assert.ok(p.q(`[data-boxes-to-check] input[data-ready="${boxes.check.id}"]`), 'the ready-to-pack checklist is on the To check box'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('A BOX MOVES ALONG THE SUB-TABS AS YOU TAKE IT THROUGH, AND THE COUNTS FOLLOW: being made → Enroute → To check → Checked and ready', async () => {
  const mine = boxes.making.id, p = await open(); const n0 = (await api('GET', '/api/admin/warehouse/counts')).json;
  await p.click(p.q(`[data-box="${mine}"] [data-act="enroute"]`)); await sleep(300); await p.settle(); assert.equal(toast(p), 'Marked en route.'); assert.equal(on(p), 'arrived', 'you stay where you were'); assert.equal(p.q(`[data-box="${mine}"]`), null, 'gone from Arrived'); assert.equal(label(p, 'enroute'), `Enroute (${n0.enroute + 1})`, 'the count has already gone up');
  await sub(p, 'enroute'); assert.ok(p.q(`details[data-box-fold="${mine}"]`)); await p.click(p.q(`[data-box="${mine}"] [data-act="arrived"]`)); await sleep(300); await p.settle(); assert.equal(p.q(`[data-box="${mine}"]`), null, 'gone from Enroute'); assert.equal(label(p, 'onhand'), `On hand ${n0.toCheck + 1} to check`);
  await sub(p, 'onhand'); assert.ok(p.q(`[data-boxes-to-check] [data-box="${mine}"]`)); await p.click(p.q(`[data-box="${mine}"] [data-act="ready"]`)); await sleep(300); await p.settle(); assert.equal(on(p), 'onhand'); assert.equal(p.q(`[data-boxes-to-check] [data-box="${mine}"]`), null); assert.ok(p.q(`[data-boxes-checked] details[data-box-fold="${mine}"]`), 'now under Checked and ready');
  assert.equal(label(p, 'onhand'), n0.toCheck ? `On hand ${n0.toCheck} to check` : 'On hand', 'the to-check number is back where it was'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('THE SUB-TAB YOU WERE ON IS REMEMBERED while you visit other tabs (a fresh visit opens on Arrived); each box sub-tab has its own empty message and a search that says when nothing matches', async () => {
  const p = await open(); await sub(p, 'onhand'); await p.click(p.byText('#tabs button', 'Claims')); await sleep(250); await p.settle(); await p.click(p.byText('#tabs button', 'Warehouse')); await sleep(250); await p.settle(); assert.equal(on(p), 'onhand', 'back where you left it');
  await p.type(p.q('#boxSearch'), 'zzz-no-such-person'); await sleep(450); await p.settle(); assert.match(body(p), /No boxes match that search\./); assert.equal(p.q('[data-boxes-checked] details'), null);
  await p.type(p.q('#boxSearch'), ''); await sleep(450); await p.settle(); await sub(p, 'enroute'); await p.type(p.q('#boxSearch'), 'zzz-no-such-person'); await sleep(450); await p.settle(); assert.match(body(p), /No boxes match that search\./); p.close();
  const q = await open(); assert.equal(on(q), 'arrived', 'a fresh visit starts on Arrived again (that is the one you chose)'); q.close();
});

test('LOGGING A STORE ORDER FROM UNORDERED KEEPS YOU ON UNORDERED, and moving the claims on brings the Unordered count down; the new store order is on Incoming with its All arrived button', async () => {
  const p = await open(); await sub(p, 'unordered'); const n0 = (await api('GET', '/api/admin/warehouse/counts')).json.unordered; assert.equal(label(p, 'unordered'), `Unordered (${n0})`); const g = p.q(`[data-to-order-group="o${ids.go}"]`); assert.ok(g, 'the group order with two secured copies is on the list');
  await p.click(p.q('[data-act="log-order"]', g)); const f = p.q('form[data-form="new-order"]'); f.elements.store.value = 'Weverse Shop'; await p.submit(f); await sleep(450); await p.settle();
  assert.equal(toast(p), 'Store order saved.'); assert.match(p.text(p.q('.ui-modal')), /^Move 2 claims to /); await p.click(p.byText('.ui-modal button', 'Move them')); await sleep(500); await p.settle();
  assert.equal(on(p), 'unordered', 'still on Unordered'); assert.equal(p.q('form[data-form="new-order"]'), null, 'the form closed'); assert.equal(label(p, 'unordered'), n0 - 2 > 0 ? `Unordered (${n0 - 2})` : 'Unordered', 'the Unordered count came down by the two claims that moved on');
  await sub(p, 'incoming'); assert.ok(/Weverse Shop/.test(body(p)), 'the new store order is on Incoming'); assert.ok(p.q('[data-act="arrived-all"]'), 'with its All arrived button'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});
