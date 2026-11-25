import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// Warehouse → Incoming: logging a store order, adding a line, "All arrived" and a line's arrived count each SHOW which claims would move on and ask first.
let app, admin, w, N = 0;
const ORDERED = 'ordered via proxy / warehouse', ARRIVED = 'arrived at proxy / warehouse', WAITING = 'awaiting fulfillment';
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'sc') => `${x}${++N}`;
const mk = async (n, title = u('Album ')) => { const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Plan UI GO '), proxy: 'Sam' })).json.id; const item = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 10, title })).json.id; const claims = []; for (let i = 0; i < n; i++) claims.push((await claimAndSecure(app, admin, u('who'), item))[0]); return { go, item, title, claims }; };
const store = async (lines) => (await api('POST', '/api/admin/store-orders', { store: 'Ktown4u', orderedOn: new Date(Date.now() - 864e5).toISOString().slice(0, 10), lines })).json.id;
const stageOf = async (ids) => (await app.q('SELECT pipeline FROM claims WHERE id IN (?) ORDER BY id', [ids])).map((r) => r.pipeline);
const move = (ids, pipeline) => api('POST', '/api/admin/claims/pipeline', { claimIds: ids, pipeline });
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Warehouse')); await sleep(120); await p.settle(); await p.click(p.q('[data-act="wh-view"][data-view="incoming"]')); await sleep(150); await p.settle(); return p; };
const chip = (p, k) => p.q(`[data-act="filter"][data-k="${k}"]`);
const group = (p, go) => p.q(`[data-to-order-group="o${go}"]`);
const form = (p) => p.q('form[data-form="new-order"]');
const dialog = (p) => p.text(modal(p));
const logFromList = async (p, go, qty) => { await p.click(chip(p, 'toorder')); await p.click(p.q('[data-act="log-order"]', group(p, go))); form(p).elements.store.value = 'Weverse Shop'; if (qty !== undefined) form(p).querySelector('[data-line-row] [name="qty"]').value = String(qty); await p.submit(form(p)); await sleep(400); await p.settle(); };

test('LOG A STORE ORDER → A PREVIEW OF THE CLAIMS IT WOULD MARK AS ORDERED, naming the item, its group order and the people; "Move them" moves exactly those and says so', async () => {
  const m = await mk(4); const p = await open(); await logFromList(p, m.go); assert.equal(toast(p), 'Store order saved.');
  const t = dialog(p); assert.match(t, new RegExp(`^Move 4 claims to “${ORDERED.replace(/\//g, '\\/')}”\\? • ${m.title} \\(Plan UI GO \\d+\\) — 4 claims: @who\\d+, @who\\d+, @who\\d+, @who\\d+Not nowMove them$`)); assert.deepEqual(await stageOf(m.claims), Array(4).fill(WAITING), 'nothing moved until you say so');
  await press(p, 'Move them'); await sleep(450); await p.settle(); assert.equal(toast(p), `Moved 4 claims to “${ORDERED}”.`); assert.deepEqual(await stageOf(m.claims), Array(4).fill(ORDERED)); assert.equal(p.q('.ui-modal'), null); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('ONLY AS MANY AS WERE ORDERED, OLDEST FIRST: order 3 of 5 and the preview says "3 ordered of 5 needed, so the oldest first" — and only those three move', async () => {
  const m = await mk(5); const p = await open(); await logFromList(p, m.go, 3); assert.match(dialog(p), /^Move 3 claims to .* — 3 claims: .* — 3 ordered of 5 needed, so the oldest firstNot nowMove them$/); await press(p, 'Move them'); await sleep(450); await p.settle();
  assert.deepEqual(await stageOf(m.claims), [ORDERED, ORDERED, ORDERED, WAITING, WAITING], 'the oldest three'); p.close();
});

test('"NOT NOW" LEAVES THE CLAIMS ALONE (and the store order is still saved); a long list of people is shortened', async () => {
  const m = await mk(8); const p = await open(); await logFromList(p, m.go); assert.match(dialog(p), /— 8 claims: (@who\d+, ){5}@who\d+ and 2 moreNot nowMove them$/, 'six names, then "and 2 more"'); await press(p, 'Not now'); await sleep(200); assert.equal(p.q('.ui-modal'), null); assert.deepEqual(await stageOf(m.claims), Array(8).fill(WAITING), 'nothing moved');
  assert.ok((await api('GET', '/api/admin/incoming')).json.orders.some((o) => o.lines.some((l) => l.itemId === m.item)), 'the store order was saved'); p.close();
});

test('"ALL ARRIVED" ASKS ITS OWN QUESTION FIRST, THEN SHOWS WHICH CLAIMS HAVE ARRIVED AT THE WAREHOUSE; the claims move only when you say so', async () => {
  const m = await mk(3); const id = await store([{ itemId: m.item, qty: 3 }]); await move(m.claims, ORDERED); const p = await open(); await p.click(p.q(`[data-act="arrived-all"][data-id="${id}"]`)); await sleep(100); assert.match(dialog(p), /^Mark everything on this store order as arrived\?/); await press(p, 'Yes, all arrived'); await sleep(450); await p.settle();
  assert.equal(toast(p), 'Marked as arrived.'); assert.match(dialog(p), new RegExp(`^Move 3 claims to “${ARRIVED.replace(/\//g, '\\/')}”\\? • ${m.title} \\(Plan UI GO \\d+\\) — 3 claims: .*Not nowMove them$`)); assert.deepEqual(await stageOf(m.claims), Array(3).fill(ORDERED), 'not moved yet');
  await press(p, 'Move them'); await sleep(450); await p.settle(); assert.deepEqual(await stageOf(m.claims), Array(3).fill(ARRIVED)); assert.equal(toast(p), `Moved 3 claims to “${ARRIVED}”.`); p.close();
});

test('A PARTIAL ARRIVAL: raising a line\'s arrived count shows exactly that many (and again when you raise it more); lowering it says nothing', async () => {
  const m = await mk(4); const id = await store([{ itemId: m.item, qty: 6 }]); await move(m.claims, ORDERED); const line = (await api('GET', '/api/admin/incoming')).json.orders.find((o) => o.id === id).lines[0].id; const p = await open();
  const setArrived = async (n) => { const i = p.q(`[data-arrived="${line}"]`); i.value = String(n); i.dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(450); await p.settle(); };
  await setArrived(2); assert.match(dialog(p), /^Move 2 claims to .* — 2 claims: .* — 2 arrived of 4 needed, so the oldest firstNot nowMove them$/); await press(p, 'Move them'); await sleep(450); await p.settle(); assert.deepEqual(await stageOf(m.claims), [ARRIVED, ARRIVED, ORDERED, ORDERED]);
  await setArrived(3); assert.match(dialog(p), /^Move 1 claim to /, 'one more arrived: one more claim'); await press(p, 'Not now'); await sleep(150); assert.deepEqual(await stageOf(m.claims), [ARRIVED, ARRIVED, ORDERED, ORDERED], 'declined: unchanged');
  await setArrived(5); assert.match(dialog(p), /^Move 2 claims to /); await press(p, 'Not now'); await sleep(150); await setArrived(3); assert.equal(p.q('.ui-modal'), null, 'lowering it says nothing — even though a claim could still be moved for the lower count'); assert.deepEqual(await stageOf(m.claims), [ARRIVED, ARRIVED, ORDERED, ORDERED]); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('ADDING A LINE TO A STORE ORDER SHOWS THE PREVIEW TOO; and when there is nothing to move, nothing is said', async () => {
  const m = await mk(2), filler = await mk(0), bare = await mk(0); const id = await store([{ itemId: filler.item, qty: 1 }]), id2 = await store([{ itemId: bare.item, qty: 2 }]); const p = await open(); await p.click(p.q(`[data-act="add-line"][data-id="${id}"]`)); const f = p.q('form[data-form="add-line"]'); f.querySelector('[name="itemId"]').value = String(m.item); f.querySelector('[name="qty"]').value = '2'; await p.submit(f); await sleep(450); await p.settle();
  assert.match(dialog(p), new RegExp(`^Move 2 claims to “${ORDERED.replace(/\//g, '\\/')}”\\? • ${m.title}`)); await press(p, 'Move them'); await sleep(450); await p.settle(); assert.deepEqual(await stageOf(m.claims), [ORDERED, ORDERED]);
  await p.click(p.q(`[data-act="arrived-all"][data-id="${id2}"]`)); await sleep(100); await press(p, 'Yes, all arrived'); await sleep(450); await p.settle(); assert.equal(p.q('.ui-modal'), null, 'nothing is waiting for that item, so nothing is shown'); assert.equal(toast(p), 'Marked as arrived.'); p.close();
});

test('A CLAIM THAT CAN NO LONGER BE MOVED IS LEFT ALONE, AND YOU ARE TOLD (here: cancelled while the question was open)', async () => {
  const m = await mk(3); const p = await open(); await logFromList(p, m.go); assert.match(dialog(p), /^Move 3 claims to /); assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: [m.claims[1]] })).status, 200, 'cancelled in another tab');
  await press(p, 'Move them'); await sleep(450); await p.settle(); assert.match(toast(p), new RegExp(`^Moved 2 claims to “${ORDERED.replace(/\//g, '\\/')}”\\. 1 left alone \\(.+\\)\\.$`)); assert.deepEqual(await stageOf([m.claims[0], m.claims[2]]), [ORDERED, ORDERED]); p.close();
});

