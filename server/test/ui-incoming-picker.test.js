import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage } from './ui.helpers.js';

// Warehouse → Incoming → New store order: the item box is a SEARCH box — it offers items still WAITING to be ordered (secured, 'awaiting fulfillment'), grouped by group order with "— N waiting";
// type to filter (any order of words), arrows + Enter, mouse; "Show all items" adds the ones with nothing waiting.
let app, admin, w, N = 0, ids;
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async (title) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam' })).json.id;
const item = async (go, title, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title, ...extra })).json.id;
const waiting = async (itemId, n) => { const out = []; for (let i = 0; i < n; i++) out.push((await claimAndSecure(app, admin, `pk${++N}`, itemId))[0]); return out; };
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); ids = {};
  const done = await goOrder('Old completed GO'), thisThat = await goOrder('This & That Inclusions only'), pop = await goOrder('Odd & Fresh Pop-up');           // created oldest → newest, so the newest is listed first
  ids.done = await item(done, 'Finished thing'); for (const c of await waiting(ids.done, 2)) await api('PATCH', `/api/admin/claims/${c}`, { pipeline: 'completed' });
  ids.truck = await item(thisThat, 'Truck Ver OT8'); await waiting(ids.truck, 1); ids.fans = await item(thisThat, 'FANS ver OT8');                                       // FANS: nobody has claimed it
  ids.photo = await item(pop, 'Photo Set'); await waiting(ids.photo, 5); ids.poster = await item(pop, 'Poster Book'); for (const c of await waiting(ids.poster, 2)) await api('PATCH', `/api/admin/claims/${c}`, { pipeline: 'ordered via proxy / warehouse' });
  ids.hoodie = await item(pop, 'Hoodie'); const h = await waiting(ids.hoodie, 3); await api('PATCH', `/api/admin/claims/${h[0]}`, { pipeline: 'ordered via proxy / warehouse' });                // 2 waiting, 1 already ordered
});
after(async () => { await app.stop(); });
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Warehouse')); await sleep(120); await p.settle(); await p.click(p.q('[data-act="wh-view"][data-view="incoming"]')); await sleep(150); await p.settle(); await p.click(p.q('[data-act="new"]')); await sleep(80); return p; };
const form = (p) => p.q('#newOrder');
const box = (p, i = 0) => p.qa('[data-combo-input]', form(p))[i];
const listOf = (p, i = 0) => p.qa('.combo-list', form(p))[i];
const focus = (p, el) => { el.focus(); el.dispatchEvent(new p.window.FocusEvent('focusin', { bubbles: true })); };
const type = (p, el, text) => { el.value = text; el.dispatchEvent(new p.window.Event('input', { bubbles: true })); };
const key = (p, el, k) => { const e = new p.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };
const rows = (p, i = 0) => [...listOf(p, i).querySelectorAll('.combo-group, .combo-opt')].map((n) => n.classList.contains('combo-group') ? `# ${p.text(n)}` : `${p.text(n.querySelector('span'))} ${p.text(n.querySelector('[data-waiting]'))}`);
const chosen = (p, i = 0) => p.qa('[name=itemId]', form(p))[i].value;

test('THE LIST OFFERS ONLY WHAT IS STILL WAITING TO BE ORDERED — grouped by group order (newest first), each saying how many are waiting; completed, already-ordered and never-claimed items are not there', async () => {
  const p = await open(); focus(p, box(p)); assert.equal(listOf(p).hidden, false);
  assert.deepEqual(rows(p), ['# Odd & Fresh Pop-up', 'Photo Set — 5 waiting', 'Hoodie — 2 waiting', '# This & That Inclusions only', 'Truck Ver OT8 — 1 waiting'], 'only items with something waiting, newest group order first');
  const all = p.text(listOf(p)); for (const gone of ['Finished thing', 'Poster Book', 'FANS ver OT8']) assert.ok(!all.includes(gone), `${gone} is not offered`);
  assert.equal(box(p).getAttribute('role'), 'combobox'); assert.equal(box(p).getAttribute('aria-expanded'), 'true'); assert.equal(listOf(p).getAttribute('role'), 'listbox'); assert.ok(p.qa('.combo-opt', listOf(p)).every((o) => o.getAttribute('role') === 'option')); assert.equal(p.qa('select[name=itemId]', form(p)).length, 0, 'no more long dropdown');
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('TYPING FILTERS: every word must appear in the group order or item name, in any order, any case — and a search with no match says why', async () => {
  const p = await open(); focus(p, box(p)); type(p, box(p), 'hood'); assert.deepEqual(rows(p), ['# Odd & Fresh Pop-up', 'Hoodie — 2 waiting']);
  type(p, box(p), 'POP hood'); assert.deepEqual(rows(p), ['# Odd & Fresh Pop-up', 'Hoodie — 2 waiting'], 'the group order counts, any order of words, any case'); type(p, box(p), 'hood pop'); assert.equal(rows(p).length, 2);
  type(p, box(p), 'that truck'); assert.deepEqual(rows(p), ['# This & That Inclusions only', 'Truck Ver OT8 — 1 waiting']); type(p, box(p), 'photo hoodie'); assert.equal(p.q('[data-combo-empty]', listOf(p)) && true, true);
  assert.match(p.text(p.q('[data-combo-empty]', listOf(p))), /^No items match “photo hoodie” that are waiting to be ordered\. Tick “Show all items” to include the rest\.$/);
  type(p, box(p), 'finished'); assert.match(p.text(listOf(p)), /No items match “finished”/, 'a completed item is not found unless you ask for all items'); p.close();
});

test('KEYBOARD: ↓/↑ move through the matches, Enter chooses and NEVER submits the form, Esc closes without choosing, a single match is chosen by Enter alone', async () => {
  const p = await open(); const post = []; const orig = p.window.fetch; p.window.fetch = (...a) => { if (a[1]?.method && a[1].method !== 'GET') post.push(a[0]); return orig(...a); };
  focus(p, box(p)); key(p, box(p), 'ArrowDown'); const first = p.q('.combo-opt[aria-selected="true"]', listOf(p)); assert.match(p.text(first), /^Photo Set/); assert.equal(box(p).getAttribute('aria-activedescendant'), first.id); key(p, box(p), 'ArrowDown'); assert.match(p.text(p.q('.combo-opt[aria-selected="true"]', listOf(p))), /^Hoodie/);
  key(p, box(p), 'ArrowUp'); key(p, box(p), 'ArrowUp'); assert.match(p.text(p.q('.combo-opt[aria-selected="true"]', listOf(p))), /^Truck Ver OT8/, 'wraps round to the end');
  const enter = key(p, box(p), 'Enter'); assert.equal(enter.defaultPrevented, true, 'Enter does not submit the form'); assert.equal(chosen(p), String(ids.truck)); assert.equal(box(p).value, 'Truck Ver OT8 — This & That Inclusions only'); assert.equal(listOf(p).hidden, true); assert.equal(box(p).getAttribute('aria-expanded'), 'false');
  focus(p, box(p)); type(p, box(p), 'poster'); assert.match(p.text(listOf(p)), /No items match/); type(p, box(p), 'hoodie'); const e2 = key(p, box(p), 'Enter'); assert.equal(e2.defaultPrevented, true); assert.equal(chosen(p), String(ids.hoodie), 'one match: Enter alone chooses it');
  focus(p, box(p)); type(p, box(p), 'photo'); key(p, box(p), 'Escape'); assert.equal(listOf(p).hidden, true); assert.equal(chosen(p), '', 'Esc closes without choosing (editing the text cleared the earlier choice)'); assert.deepEqual(post, [], 'nothing was sent'); p.close();
});

test('THE MOUSE WORKS TOO: clicking a match chooses it and fills the box; focusing a box that already has an item shows the whole list again', async () => {
  const p = await open(); focus(p, box(p)); type(p, box(p), 'photo'); const opt = p.q('.combo-opt', listOf(p)); opt.dispatchEvent(new p.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(chosen(p), String(ids.photo)); assert.equal(box(p).value, 'Photo Set — Odd & Fresh Pop-up'); assert.equal(listOf(p).hidden, true); box(p).blur(); focus(p, box(p)); assert.equal(rows(p).filter((r) => !r.startsWith('#')).length, 3, 'with an item chosen, opening it again lists everything waiting (so it is easy to change)');
  type(p, box(p), 'photo set x'); assert.equal(chosen(p), '', 'editing the text un-chooses the item (it can never save a stale one)'); p.close();
});

test('"SHOW ALL ITEMS" adds the ones with nothing waiting (marked "none waiting"); unticking hides them again but keeps what you chose; it is one tick for every line', async () => {
  const p = await open(); const tick = p.q('[data-act="show-all-items"]', form(p)); assert.ok(tick); assert.equal(tick.checked, false, 'off by default'); assert.match(p.text(tick.closest('label')), /Show all items \(even ones with nothing waiting\)/);
  await p.click(tick); focus(p, box(p)); const all = rows(p); for (const want of ['Finished thing — none waiting', 'Poster Book — none waiting', 'FANS ver OT8 — none waiting', 'Photo Set — 5 waiting']) assert.ok(all.includes(want), want);
  type(p, box(p), 'fans'); key(p, box(p), 'Enter'); assert.equal(chosen(p), String(ids.fans), 'an item with nothing waiting can be chosen'); await p.click(p.q('[data-act="more-lines"]')); assert.equal(p.qa('[data-act="show-all-items"]', form(p)).length, 1, 'one tick, however many lines'); assert.equal(p.q('[data-act="show-all-items"]', form(p)).checked, true, 'still ticked after adding a line');
  focus(p, box(p, 1)); assert.ok(rows(p, 1).includes('Poster Book — none waiting'), 'the new line honours it too'); await p.click(p.q('[data-act="show-all-items"]', form(p))); assert.equal(chosen(p), String(ids.fans), 'unticking keeps the item already chosen'); focus(p, box(p, 1)); assert.ok(!p.text(listOf(p, 1)).includes('Poster Book'), 'and hides the rest again'); p.close();
});

test('SAVING: an item chosen from the box saves the right item; typing without choosing is refused with a clear message and nothing is saved', async () => {
  const p = await open(); const f = form(p); focus(p, box(p)); type(p, box(p), 'photo'); key(p, box(p), 'Enter'); f.elements.store.value = 'Ktown4u'; f.elements.orderRef.value = 'PICK-1'; f.elements.qty.value = '5'; await p.submit(f); await sleep(350); await p.settle();
  const saved = (await api('GET', '/api/admin/incoming')).json.orders.find((o) => o.orderRef === 'PICK-1'); assert.deepEqual([saved.store, saved.lines[0].qty], ['Ktown4u', 5]); assert.equal((await app.q('SELECT item_id FROM store_order_lines WHERE store_order_id = ?', [saved.id]))[0].item_id, ids.photo);
  const q = await open(); const g = form(q); focus(q, box(q)); type(q, box(q), 'phot'); g.elements.store.value = 'Nope'; g.elements.qty.value = '1'; await q.submit(g); await sleep(250); assert.match(q.text(q.q('.msg', g)), /^Choose “phot” from the list — start typing, then pick the item\.$/); assert.equal(box(q).getAttribute('aria-invalid'), 'true', 'the box is marked');
  focus(q, box(q)); type(q, box(q), ''); g.elements.qty.value = '3'; await q.submit(g); await sleep(250); assert.match(q.text(q.q('.msg', g)), /Each item line needs an item and how many\./, 'a quantity with no item at all gets the usual message'); assert.equal((await app.q("SELECT COUNT(*) AS n FROM store_orders WHERE store = 'Nope'"))[0].n, 0); p.close(); q.close();
});

test('"ADD A LINE" TO AN EXISTING STORE ORDER USES THE SAME BOX (and tick)', async () => {
  const so = await api('POST', '/api/admin/store-orders', { store: 'Addline shop', orderedOn: '2026-10-01', lines: [{ itemId: ids.truck, qty: 1 }] }); assert.equal(so.status, 201, so.text);
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Warehouse')); await sleep(120); await p.settle(); await p.click(p.q('[data-act="wh-view"][data-view="incoming"]')); await sleep(150); await p.settle(); await p.click(p.q(`[data-act="add-line"][data-id="${so.json.id}"]`)); await sleep(80);
  const f = p.q('form[data-form="add-line"]'); const b = p.q('[data-combo-input]', f); focus(p, b); type(p, b, 'hoodie'); key(p, b, 'Enter'); f.elements.qty.value = '2'; assert.ok(p.q('[data-act="show-all-items"]', f), 'the tick is here too'); await p.submit(f); await sleep(350); await p.settle();
  assert.deepEqual((await app.q('SELECT item_id, qty FROM store_order_lines WHERE store_order_id = ? ORDER BY id', [so.json.id])).map((r) => [r.item_id, r.qty]), [[ids.truck, 1], [ids.hoodie, 2]]); p.close();
});

test('A LONG LIST IS CAPPED (first 60, then "…and N more — keep typing"), and names with HTML are shown as text everywhere', async () => {
  const big = await goOrder('Zzz Big GO'); for (let i = 0; i < 64; i++) await waiting(await item(big, `Bulk item ${String(i).padStart(2, '0')}`), 1);
  const weird = await goOrder('<img src=x onerror="window.pwned=1"> Weird GO'); const wi = await item(weird, '<b>Bold</b> thing'); await waiting(wi, 1);
  const p = await open(); focus(p, box(p)); assert.equal(p.qa('.combo-opt', listOf(p)).length, 60); const rest = p.text(p.qa('.combo-empty', listOf(p)).at(-1)); assert.match(rest, /^…and \d+ more — keep typing to narrow it down\.$/); type(p, box(p), 'bulk item 63'); assert.equal(p.qa('.combo-opt', listOf(p)).length, 1, 'typing narrows it');
  type(p, box(p), 'bold'); assert.equal(p.q('img[src="x"]', listOf(p)), null); assert.equal(p.window.pwned, undefined); assert.equal(p.q('b', listOf(p)), null); assert.ok(p.text(listOf(p)).includes('<b>Bold</b> thing') && p.text(listOf(p)).includes('<img src=x onerror="window.pwned=1"> Weird GO'));
  key(p, box(p), 'Enter'); assert.equal(box(p).value, '<b>Bold</b> thing — <img src=x onerror="window.pwned=1"> Weird GO', 'and in the box'); type(p, box(p), '<i>zzz</i>'); assert.equal(p.q('i', listOf(p)), null); assert.match(p.text(listOf(p)), /No items match “<i>zzz<\/i>”/); p.close();
});
