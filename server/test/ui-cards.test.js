import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startApp, seed } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// GOM → Cards: card types, bundles, boards (a photo each) and the box editor — drawing, moving, resizing, the grid tool, zoom, prices, saving, publishing.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'uc') => `${x}${++N}`;
const photo = (wd = 1200, ht = 800) => sharp({ create: { width: wd, height: ht, channels: 3, background: '#556' } }).png().toBuffer();
const RECT = { left: 0, top: 0, width: 1000, height: 667, right: 1000, bottom: 667 };
const mk = async (extra = {}) => { const id = (await api('POST', '/api/admin/card-bundles', { title: u('Bundle '), groupId: w.group, ...extra })).json.id; return id; };
const mkBoard = async (bundleId, title) => { const r = await fetch(`${app.base}/api/admin/card-bundles/${bundleId}/boards${title ? `?title=${encodeURIComponent(title)}` : ''}`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: await photo() }); return (await r.json()).board; };
const boxesOf = async (boardId) => (await api('GET', `/api/admin/card-boards/${boardId}`)).json.boxes;
const cardsTab = async () => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', 'Cards')); await sleep(250); await p.settle(); return p; };
const openBundle = async (p, id) => { await p.click(p.q(`[data-bundle="${id}"] [data-act="open-bundle"]`)); await sleep(200); await p.settle(); };
const openEditor = async (p, bundleId, boardId) => { await openBundle(p, bundleId); await p.click(p.q(`[data-board="${boardId}"] [data-act="edit-board"]`)); await sleep(250); await p.settle(); return cv(p); };
const cv = (p) => { const c = p.q('#boardCanvas'); c.getBoundingClientRect = () => RECT; return c; };
const ev = (p, type, x, y, extra = {}) => new p.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...extra });
const drag = (p, target, from, to, extra = {}) => { target.dispatchEvent(ev(p, 'mousedown', from[0], from[1], extra)); p.window.document.dispatchEvent(ev(p, 'mousemove', to[0], to[1])); p.window.document.dispatchEvent(ev(p, 'mouseup', to[0], to[1])); };
const boxEls = (p) => p.qa('#boardCanvas .cbox');
const pct = (el, prop) => parseFloat(el.style[prop]);
const key = (p, k, extra = {}) => p.window.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));
const msg = (p) => p.text(p.q('[data-save-error]'));

test('THE CARDS TAB: card types start empty; add one; changing its price says how many cards followed; deleting asks first and keeps their prices', async () => {
  const p = await cardsTab(); assert.ok(p.q('[data-no-types]') || p.q('[data-type-row]'), 'the card types panel is there');
  const f = p.q('form[data-form="new-type"]'); const name = u('POB '); f.elements.name.value = name; f.elements.price.value = '4'; await p.submit(f); await sleep(300); await p.settle();
  const row = p.qa('[data-type-row]').find((r) => r.querySelector('[data-type-name]').value === name); assert.ok(row, 'the new type is listed'); assert.equal(row.querySelector('[data-type-price]').value, '4');
  const typeId = Number(row.querySelector('[data-act="type-save"]').dataset.id); const b = await mk(), bd = await mkBoard(b); assert.equal((await api('PUT', `/api/admin/card-boards/${bd.id}/boxes`, { boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, qty: 1, typeId }, { x: 0.4, y: 0.1, w: 0.2, h: 0.2, qty: 1, typeId, priceOverride: true, price: 9 }] })).status, 200);
  const q = await cardsTab(); const r2 = q.qa('[data-type-row]').find((r) => r.querySelector('[data-type-name]').value === name); r2.querySelector('[data-type-price]').value = '5.5'; await q.click(r2.querySelector('[data-act="type-save"]')); await sleep(400); await q.settle();
  assert.equal(toast(q), 'Saved — 1 card that follows this price changed with it.'); assert.deepEqual((await boxesOf(bd.id)).map((x) => x.price), [5.5, 9]);
  const r3 = q.qa('[data-type-row]').find((r) => r.querySelector('[data-type-name]').value === name); await q.click(r3.querySelector('[data-act="type-del"]')); assert.match(q.text(modal(q)), /Cards of this type keep their current price/); await press(q, 'Delete the type'); await sleep(300); await q.settle();
  assert.equal(q.qa('[data-type-row]').some((r) => r.querySelector('[data-type-name]').value === name), false); assert.deepEqual((await boxesOf(bd.id)).map((x) => x.price), [5.5, 9], 'their prices are kept'); p.close(); q.close();
});

test('A NEW BUNDLE: name, group, closing date, days to pay, and the "not on hand" tick; it opens straight into the bundle; the list shows its status and that it is not on hand', async () => {
  const p = await cardsTab(); const f = p.q('form[data-form="new-bundle"]'); assert.equal(f.elements.notOnHand.checked, false, 'on hand unless you tick it'); assert.equal(f.elements.payDays.value, '5'); assert.match(p.text(f.elements.notOnHand.closest('label')), /^Not on hand — these cards still need ordering, so claims go through the normal ordering and shipping process, like a group order$/);
  const title = u('Not on hand '); f.elements.title.value = title; f.elements.groupId.value = String(w.group); f.elements.closesOn.value = '2027-02-14'; f.elements.payDays.value = '7'; f.elements.notOnHand.checked = true; await p.submit(f); await sleep(400); await p.settle();
  assert.equal(toast(p), 'Bundle created — now add a board photo.'); assert.match(p.text(p.q('#tabBody h1')), new RegExp(`^${title} Draft$`)); const made = (await api('GET', '/api/admin/cards')).json.bundles.find((x) => x.title === title); assert.deepEqual([made.onHand, made.closesOn, made.payDays, made.groupId, made.status], [false, '2027-02-14', 7, w.group, 'draft']);
  await p.click(p.byText('button', '← All bundles')); await sleep(250); await p.settle(); const li = p.q(`[data-bundle="${made.id}"]`); assert.ok(li.querySelector('[data-not-on-hand]'), 'marked as not on hand'); assert.equal(p.text(li.querySelector('[data-status]')), 'Draft'); assert.match(p.text(li), /0 boards · 0 cards/);
  const bad = p.q('form[data-form="new-bundle"]'); bad.elements.title.value = u('Bad '); bad.elements.payDays.value = '0'; await p.submit(bad); await sleep(300); assert.ok(p.text(p.q('[data-msg]', bad)).length > 0, 'a bad value is explained'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('ADDING A BOARD PHOTO: choosing a file uploads it (with the name you typed); the board appears with 0 cards; a non-picture is refused with a reason', async () => {
  const b = await mk(); const p = await cardsTab(); await openBundle(p, b); const send = async (bytes, name = 'board.png', title = '') => { if (title) p.q('[data-board-title]').value = title; const input = p.q('[data-board-file]'); Object.defineProperty(input, 'files', { value: [new p.window.File([bytes], name, { type: 'image/png' })], configurable: true }); input.dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(900); await p.settle(); };
  await send(await photo(), 'a.png', 'Binder 1'); assert.equal(toast(p), 'Board added — now draw a box on each card.'); const row = p.q('[data-board]'); assert.match(p.text(row), /^Binder 1\s*0 cards \(0 copies\)Draw boxesDelete$/); assert.match(row.querySelector('img').getAttribute('src'), /\/uploads\/[a-f0-9]{32}-t\.webp/);
  await send(Buffer.from('not a picture'), 'x.png'); assert.match(p.text(p.q('[data-board-msg]')), /doesn't look like a picture/); assert.equal(p.qa('[data-board]').length, 1, 'nothing was added'); await send(await photo(), 'b.png'); assert.equal(p.qa('[data-board]').length, 2); assert.match(p.text(p.qa('[data-board]')[1]), /^Board 2/); p.close();
});

test('DRAWING AND SAVING: drag to draw boxes, they are numbered in reading order, a box with no price is refused with a reason (and selected), a price from the panel fixes it, and Save makes the cards with their crops', async () => {
  const b = await mk(), bd = await mkBoard(b); const p = await cardsTab(); const canvas = await openEditor(p, b, bd.id);
  await p.choose(p.q('#brushType'), ''); drag(p, canvas, [600, 100], [800, 250]); drag(p, cv(p), [100, 400], [300, 550]); drag(p, cv(p), [100, 100], [300, 250]); assert.equal(boxEls(p).length, 3);
  const nums = boxEls(p).map((e) => [`${pct(e, 'left').toFixed(0)}/${pct(e, 'top') < 40 ? 'top' : 'bottom'}`, p.text(e.querySelector('.cn'))]); assert.deepEqual(nums.sort(), [['10/bottom', '3'], ['10/top', '1'], ['60/top', '2']], 'top row left to right, then the bottom row — whatever order they were drawn in');
  assert.ok(boxEls(p).every((e) => p.text(e.querySelector('.cp')) === '£?'), 'no price yet'); assert.match(p.text(p.q('#dirtyNote')), /Unsaved changes/);
  await p.click(p.byText('button', 'Save cards')); assert.match(msg(p), /^3 cards still need a price — they're selected\. Set a type or a price, then Apply\.$/); assert.equal(p.qa('#boardCanvas .cbox.sel').length, 3); assert.deepEqual(await boxesOf(bd.id), [], 'nothing saved');
  p.q('#boxPrice').value = '3'; await p.click(p.q('[data-act="apply"]')); assert.ok(boxEls(p).every((e) => p.text(e.querySelector('.cp')) === '£3.00'));
  await p.click(p.byText('button', 'Save cards')); await sleep(600); await p.settle(); assert.equal(toast(p), 'Saved 3 cards.'); const saved = await boxesOf(bd.id); assert.deepEqual(saved.map((x) => [x.number, x.price, x.qty, !!x.crop]), [[1, 3, 1, true], [2, 3, 1, true], [3, 3, 1, true]]); assert.equal(p.text(p.q('#dirtyNote')), '', 'saved');
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('TYPES AND PRICES: new cards start as the chosen type (and its price); a price typed in the panel is the card\'s own (marked); "Use the type\'s price" goes back; quantity and notes apply to every selected card', async () => {
  const b = await mk(), bd = await mkBoard(b); const t = (await api('POST', '/api/admin/card-types', { name: u('LD '), price: 4 })).json.id; const p = await cardsTab(); await openEditor(p, b, bd.id);
  await p.choose(p.q('#brushType'), String(t)); drag(p, cv(p), [100, 100], [250, 250]); drag(p, cv(p), [400, 100], [550, 250]); assert.deepEqual(boxEls(p).map((e) => p.text(e.querySelector('.cp'))), ['£4.00', '£4.00'], 'the type\'s price');
  boxEls(p)[0].dispatchEvent(ev(p, 'mousedown', 175, 175)); p.window.document.dispatchEvent(ev(p, 'mouseup', 175, 175)); assert.equal(p.qa('#boardCanvas .cbox.sel').length, 1, 'clicking a box selects just it');
  p.q('#boxPrice').value = '9'; p.q('#boxQty').value = '3'; p.q('#boxNote').value = 'corner ding'; await p.click(p.q('[data-act="apply"]')); const rows = () => p.qa('#boxList tbody tr').map((r) => p.text(r)); assert.match(rows()[0], /£9\.00 •\s*3\s*corner ding/, 'its own price is marked with a dot'); assert.match(rows()[1], /£4\.00\s*1/);
  await p.click(p.q('[data-act="use-type-price"]')); assert.match(rows()[0], /£4\.00\s*3/, 'back to the type\'s price'); p.q('#boxPrice').value = '9'; await p.click(p.q('[data-act="apply"]'));
  key(p, 'a', { ctrlKey: true }); p.q('#boxQty').value = '2'; await p.click(p.q('[data-act="apply"]')); assert.deepEqual(p.qa('#boxList tbody tr').map((r) => p.text(r.children[3])), ['2', '2'], 'every selected card got 2 copies'); await p.click(p.byText('button', 'Save cards')); await sleep(600); await p.settle();
  assert.deepEqual((await boxesOf(bd.id)).map((x) => [x.price, x.priceOverride, x.qty, x.typeId === t]), [[9, true, 2, true], [4, false, 2, true]]); p.close();
});

test('THE GRID TOOL: drag over the area, say 8 across and 8 down, and 64 boxes appear (with a live count and preview); they save as 64 numbered, cropped cards; a gap shrinks the boxes', async () => {
  const b = await mk(), bd = await mkBoard(b); const p = await cardsTab(); await openEditor(p, b, bd.id); await p.click(p.q('[data-act="mode-grid"]')); await sleep(100); assert.match(p.text(p.q('[data-grid-hint]')), /drag over the area that covers all the cards/);
  drag(p, cv(p), [50, 33], [950, 633]); assert.ok(p.q('#gridForm'), 'the form appears'); assert.equal(p.text(p.q('#gridCount')), '3 × 3 = 9 cards'); assert.equal(p.qa('.cgrid-preview').length, 9);
  await p.type(p.q('#gridCols'), '8'); await p.type(p.q('#gridRows'), '8'); assert.equal(p.text(p.q('#gridCount')), '8 × 8 = 64 cards'); assert.equal(p.qa('.cgrid-preview').length, 64); await p.type(p.q('#gridGap'), '2'); const cell = p.qa('.cgrid-preview')[0]; assert.ok(pct(cell, 'width') < 10, 'a 2% gap makes each box clearly narrower than area ÷ 8 (11.25%)');
  await p.click(p.q('[data-act="grid-make"]')); assert.equal(toast(p), "Made 64 boxes — they're selected, so you can set their type or price now."); assert.equal(boxEls(p).length, 64); assert.equal(p.qa('#boardCanvas .cbox.sel').length, 64, 'all selected, ready for a price');
  p.q('#boxPrice').value = '3'; await p.click(p.q('[data-act="apply"]')); await p.click(p.byText('button', 'Save cards')); await sleep(2500); await p.settle(); assert.equal(toast(p), 'Saved 64 cards.');
  const saved = await boxesOf(bd.id); assert.deepEqual([saved.length, saved.every((x) => x.crop), saved.map((x) => x.number).join() === Array.from({ length: 64 }, (_, i) => i + 1).join()], [64, true, true]); assert.ok(saved[1].x > saved[0].x && saved[8].y > saved[0].y && saved[8].x === saved[0].x, '1→2 goes across, 1→9 goes down');
  assert.equal((await api('GET', '/api/admin/cards')).json.bundles.find((x) => x.id === b).cards, 64); p.close();
});

test('MOVING, RESIZING, SELECTING, NUDGING, DELETING: drag a box to move it, drag its corner to resize, Shift-click adds to the selection, the arrow keys nudge, Delete removes, and zoom changes the size of the photo', async () => {
  const b = await mk(), bd = await mkBoard(b); const p = await cardsTab(); await openEditor(p, b, bd.id); const t = (await api('POST', '/api/admin/card-types', { name: u('T '), price: 2 })).json.id; void t;
  for (const x of [100, 400, 700]) drag(p, cv(p), [x, 100], [x + 200, 300]); assert.equal(boxEls(p).length, 3);
  const first = () => boxEls(p).find((e) => p.text(e.querySelector('.cn')) === '1'); const left0 = pct(first(), 'left'); first().dispatchEvent(ev(p, 'mousedown', 200, 200)); p.window.document.dispatchEvent(ev(p, 'mousemove', 300, 250)); p.window.document.dispatchEvent(ev(p, 'mouseup', 300, 250));
  assert.ok(Math.abs(pct(first(), 'left') - (left0 + 10)) < 0.2, 'moved 100px of 1000 = 10% across'); const top0 = pct(first(), 'top'); assert.ok(Math.abs(top0 - (100 / 667 * 100 + 50 / 667 * 100)) < 0.3, 'and 50px down');
  const w0 = pct(first(), 'width'); const h = first().querySelector('.handle'); assert.ok(h, 'a lone selected box has a corner handle'); h.dispatchEvent(ev(p, 'mousedown', 400, 350)); p.window.document.dispatchEvent(ev(p, 'mousemove', 450, 380)); p.window.document.dispatchEvent(ev(p, 'mouseup', 450, 380)); assert.ok(Math.abs(pct(first(), 'width') - (w0 + 5)) < 0.2, 'resized by 50px = 5%');
  const left1 = pct(first(), 'left'); key(p, 'ArrowRight'); assert.ok(Math.abs(pct(first(), 'left') - (left1 + 0.1)) < 0.02, 'nudged 0.1%'); key(p, 'ArrowRight', { shiftKey: true }); assert.ok(Math.abs(pct(first(), 'left') - (left1 + 1.1)) < 0.02, 'Shift nudges 1%');
  const second = boxEls(p).find((e) => p.text(e.querySelector('.cn')) === '2'); second.dispatchEvent(ev(p, 'mousedown', 500, 200, { shiftKey: true })); p.window.document.dispatchEvent(ev(p, 'mouseup', 500, 200)); assert.equal(p.qa('#boardCanvas .cbox.sel').length, 2, 'Shift-click adds'); assert.match(p.text(p.q('#boxPanel strong')), /^2 selected$/);
  key(p, 'Delete'); assert.equal(boxEls(p).length, 1); assert.match(toast(p), /^Removed 2 cards from the board \(press Save cards to keep that\)\.$/); key(p, 'a', { ctrlKey: true }); assert.equal(p.qa('#boardCanvas .cbox.sel').length, 1, 'Ctrl+A selects all'); key(p, 'Escape'); assert.equal(p.qa('#boardCanvas .cbox.sel').length, 0); key(p, 'a', { ctrlKey: true }); assert.equal(p.qa('#boardCanvas .cbox.sel').length, 1); drag(p, cv(p), [900, 600], [901, 601]); assert.equal(p.qa('#boardCanvas .cbox.sel').length, 0, 'a click on empty photo selects nothing');
  await p.choose(p.q('#zoomSel'), '300'); assert.equal(p.q('#boardCanvas').style.width, '300%', 'zoomed'); assert.deepEqual(await boxesOf(bd.id), [], 'nothing was saved by any of this'); p.close();
});

test('LEAVING WITH UNSAVED CHANGES asks first (Stay keeps you there; Leave goes back and the board is unchanged)', async () => {
  const b = await mk(), bd = await mkBoard(b); const p = await cardsTab(); await openEditor(p, b, bd.id); drag(p, cv(p), [100, 100], [300, 250]); await p.click(p.q('[data-act="back-bundle"]')); assert.match(p.text(modal(p)), /^You have unsaved changes to this board\. Leave without saving them\?/); await press(p, 'Stay'); await sleep(100); assert.ok(p.q('#cardEditor'), 'still editing');
  await p.click(p.q('[data-act="back-bundle"]')); await press(p, 'Leave without saving'); await sleep(300); await p.settle(); assert.equal(p.q('#cardEditor'), null); assert.ok(p.q('[data-boards]')); assert.deepEqual(await boxesOf(bd.id), []);
  const q = await cardsTab(); await openEditor(q, b, bd.id); await q.click(q.q('[data-act="back-bundle"]')); await sleep(300); assert.equal(q.q('#cardEditor'), null, 'no unsaved changes: leaves at once'); p.close(); q.close();
});

test('PUBLISHING: needs a card (the reason is shown); then Publish → Open, Close → Closed, Re-open; deleting a bundle asks first', async () => {
  const b = await mk(), bd = await mkBoard(b); const p = await cardsTab(); await openBundle(p, b); await p.click(p.q('[data-act="status"]')); await sleep(300); assert.equal(toast(p), 'Add a board with at least one card before publishing.');
  assert.equal((await api('PUT', `/api/admin/card-boards/${bd.id}/boxes`, { boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, qty: 1, price: 3 }] })).status, 200); const q = await cardsTab(); await openBundle(q, b); assert.match(q.text(q.q(`[data-board="${bd.id}"]`)), /1 card \(1 copy\)/);
  await q.click(q.q('[data-act="status"]')); await sleep(400); await q.settle(); assert.equal(toast(q), 'Published.'); assert.equal(q.text(q.q('h1 [data-status]')), 'Open'); await q.click(q.byText('button', 'Close bundle')); await sleep(400); await q.settle(); assert.equal(q.text(q.q('h1 [data-status]')), 'Closed'); await q.click(q.byText('button', 'Re-open bundle')); await sleep(400); await q.settle(); assert.equal(q.text(q.q('h1 [data-status]')), 'Open');
  await q.click(q.q('[data-act="delete-bundle"]')); assert.match(q.text(modal(q)), /Delete this bundle, its boards and every card on them\?/); await press(q, 'Keep it'); await sleep(100); assert.ok((await api('GET', '/api/admin/cards')).json.bundles.some((x) => x.id === b)); await q.click(q.q('[data-act="delete-bundle"]')); await press(q, 'Delete it'); await sleep(400); await q.settle();
  assert.equal((await api('GET', '/api/admin/cards')).json.bundles.some((x) => x.id === b), false); assert.ok(q.q('[data-bundles]'), 'back at the list'); p.close(); q.close();
});

test('NAMES WITH HTML ARE SHOWN AS TEXT (bundle, board and type names)', async () => {
  const evil = '<img src=x onerror="window.pwned=1"> <b>bold</b>'; const b = await mk({ title: evil }); const bd = await mkBoard(b, evil); await api('POST', '/api/admin/card-types', { name: evil, price: 2 });
  const p = await cardsTab(); assert.equal(p.q('img[src="x"]'), null); await openBundle(p, b); assert.equal(p.q('img[src="x"]'), null); assert.equal(p.q('#tabBody h1 b'), null); assert.ok(p.text(p.q('#tabBody h1')).includes(evil)); await p.click(p.q(`[data-board="${bd.id}"] [data-act="edit-board"]`)); await sleep(250); assert.equal(p.q('img[src="x"]'), null); assert.equal(p.window.pwned, undefined); p.close();
});
