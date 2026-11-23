import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// GOM → Group Orders → Items: drag handle and ▲ ▼ to reorder (the order joiners see), and "Move to another group order" in the Edit form.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async (proxy = 'Sam') => { const title = `Item order GO ${++N}`; const r = await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy }); return { id: r.json.id, title }; };
const item = async (go, title, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title, ...extra })).json.id;
const dbIds = async (go) => (await app.q('SELECT id FROM items WHERE order_id = ? ORDER BY sort_order, id', [go])).map((r) => r.id);
const itemsPage = async (go) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`)); await sleep(80); await p.settle(); return p; };
const rowIds = (p) => p.qa('tr[data-row-id]').map((r) => Number(r.dataset.rowId));
const row = (p, id) => p.q(`tr[data-row-id="${id}"]`);
const done = async (p) => { await sleep(450); await p.settle(); };
const ev = (p, type, init = {}) => new p.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
const drag = async (p, id, onId, { after = false, drop = true } = {}) => { p.q(`[data-drag="${id}"]`).dispatchEvent(ev(p, 'dragstart')); row(p, onId).dispatchEvent(ev(p, 'dragover', { clientY: after ? 5 : 0 })); const hint = { before: row(p, onId).classList.contains('drop-before'), after: row(p, onId).classList.contains('drop-after') }; if (drop) row(p, onId).dispatchEvent(ev(p, 'drop', { clientY: after ? 5 : 0 })); else p.q(`[data-drag="${id}"]`).dispatchEvent(ev(p, 'dragend')); await done(p); return hint; };

test('EACH ROW HAS A DRAG HANDLE AND ▲ ▼: the first can\'t go up, the last can\'t go down; the arrows move an item one place and the new order is saved (and shown) straight away', async () => {
  const { id: go } = await goOrder(); const [a, b, c] = [await item(go, 'Alpha'), await item(go, 'Bravo'), await item(go, 'Charlie')]; const p = await itemsPage(go);
  assert.deepEqual(rowIds(p), [a, b, c]); for (const id of [a, b, c]) { assert.ok(p.q(`[data-drag="${id}"]`, row(p, id)), 'a handle'); assert.equal(p.q(`[data-drag="${id}"]`).getAttribute('draggable'), 'true'); }
  const up = (id) => p.q(`[data-act="item-up"][data-id="${id}"]`), down = (id) => p.q(`[data-act="item-down"][data-id="${id}"]`); assert.deepEqual([up(a).disabled, down(a).disabled, up(b).disabled, down(b).disabled, up(c).disabled, down(c).disabled], [true, false, false, false, false, true]);
  await p.click(down(a)); await done(p); assert.deepEqual(rowIds(p), [b, a, c], 'shown'); assert.deepEqual(await dbIds(go), [b, a, c], 'saved'); assert.equal(up(b).disabled, true, 'the new first can\'t go up'); await p.click(up(c)); await done(p); assert.deepEqual(await dbIds(go), [b, c, a]); await p.click(up(c)); await done(p); assert.deepEqual(rowIds(p), [c, b, a]);
  assert.equal(toast(p) || '', '', 'no message for a simple move'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('DRAGGING: drop a row on another to put it before (upper half) or after (lower half); the line shows where it will land; dropping on itself, outside the rows or cancelling does nothing', async () => {
  const { id: go } = await goOrder(); const [a, b, c, d] = [await item(go, 'One'), await item(go, 'Two'), await item(go, 'Three'), await item(go, 'Four')]; const p = await itemsPage(go);
  let hint = await drag(p, d, a); assert.deepEqual([hint.before, hint.after], [true, false], 'a line above the row it will land on'); assert.deepEqual(await dbIds(go), [d, a, b, c], 'dropped before'); assert.deepEqual(rowIds(p), [d, a, b, c]);
  hint = await drag(p, d, c, { after: true }); assert.deepEqual([hint.before, hint.after], [false, true], 'a line below'); assert.deepEqual(await dbIds(go), [a, b, c, d], 'dropped after');
  await drag(p, b, b); assert.deepEqual(await dbIds(go), [a, b, c, d], 'onto itself: nothing'); await drag(p, c, a, { drop: false }); assert.deepEqual(await dbIds(go), [a, b, c, d], 'cancelled: nothing'); assert.equal(p.qa('tr.dragging, tr.drop-before, tr.drop-after').length, 0, 'the lines are cleared');
  p.q(`[data-drag="${a}"]`).dispatchEvent(ev(p, 'dragstart')); p.q('h1, h2, .card').dispatchEvent(ev(p, 'drop')); await done(p); assert.deepEqual(await dbIds(go), [a, b, c, d], 'dropped outside the rows: nothing'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('WHILE AN ITEM IS BEING EDITED, moving is refused with a reason (so an edit isn\'t lost); then it works again', async () => {
  const { id: go } = await goOrder(); const [a, b, c] = [await item(go, 'First'), await item(go, 'Second'), await item(go, 'Third')]; const p = await itemsPage(go); await p.click(p.q(`[data-act="edit-item"][data-id="${a}"]`));
  await p.click(p.q(`[data-act="item-down"][data-id="${b}"]`)); const upB = p.q(`[data-act="item-up"][data-id="${b}"]`); if (upB) await p.click(upB); await done(p); assert.equal(toast(p), 'Finish or cancel the edit first, then move items.'); assert.deepEqual(await dbIds(go), [a, b, c], 'nothing moved');
  assert.ok(p.q('form[data-form="edit-item"]'), 'the edit is still open'); p.q(`[data-drag="${c}"]`).dispatchEvent(ev(p, 'dragstart')); row(p, b).dispatchEvent(ev(p, 'dragover', { clientY: 0 })); row(p, b).dispatchEvent(ev(p, 'drop', { clientY: 0 })); await done(p); assert.deepEqual(await dbIds(go), [a, b, c], 'dragging is refused while editing: the drop did nothing'); assert.equal(toast(p), 'Finish or cancel the edit first, then move items.'); await p.click(p.q('[data-act="cancel-item-edit"]')); await sleep(80); await p.click(p.q(`[data-act="item-up"][data-id="${b}"]`)); await done(p); assert.deepEqual(await dbIds(go), [b, a, c], 'works once the edit is closed'); p.close();
});

test('MOVE TO ANOTHER GROUP ORDER (in the Edit form): the choice lists the other open group orders only; the question says what moves and what changes; "Not yet" does nothing; "Move it" moves the item and its claims and the list updates', async () => {
  const A = await goOrder('Sam'), B = await goOrder('Yuki'), dead = await goOrder(); assert.equal((await api('POST', `/api/admin/orders/${dead.id}/cancel`, { confirm: dead.title })).status, 200); await api('PATCH', `/api/admin/orders/${A.id}`, { paymentDeadline: '2027-03-01' }); await api('PATCH', `/api/admin/orders/${B.id}`, { paymentDeadline: '2027-04-15' });
  const keep = await item(A.id, 'Stays'), mover = await item(A.id, 'Washi tape'); await claimAndSecure(app, admin, `mvu${++N}`, mover); await claimAndSecure(app, admin, `mvu${++N}`, mover); const p = await itemsPage(A.id); await p.click(p.q(`[data-act="edit-item"][data-id="${mover}"]`)); const field = p.q('[data-move-item]'); assert.ok(field, 'a section in the Edit form');
  const sel = field.querySelector('[data-move-target]'); const labels = [...sel.options].map((o) => o.textContent), ids = [...sel.options].map((o) => Number(o.value)); assert.equal(labels[0], 'Choose a group order…'); assert.ok(ids.includes(B.id) && !ids.includes(A.id) && !ids.includes(dead.id), 'other open group orders; not this one, not a cancelled one'); assert.ok(labels.some((l) => l.endsWith(`— ${B.title}`)), 'group name — title');
  await p.click(field.querySelector('[data-act="item-move"]')); await sleep(80); assert.equal(toast(p), 'Choose the group order to move it to.'); sel.value = String(B.id); await p.click(field.querySelector('[data-act="item-move"]')); await sleep(200); const q = p.text(modal(p));
  assert.match(q, new RegExp(`^Move “Washi tape” from “${A.title}” to “${B.title}”\\? Its 2 claims \\(2 not cancelled\\) move with it — nothing is deleted or re-made\\. It goes to the end of that group order's list\\. Pay-by date: \\d{2}/\\d{2}/\\d{4} → \\d{2}/\\d{2}/\\d{4} for claims secured from now on \\(claims already secured keep theirs\\)\\. Proxy: Sam → Yuki\\.Not yetMove it$`));
  await press(p, 'Not yet'); await sleep(100); assert.equal((await dbIds(A.id)).includes(mover), true, 'Not yet: nothing moved'); await p.click(field.querySelector('[data-act="item-move"]')); await sleep(200); await press(p, 'Move it'); await done(p);
  assert.equal(toast(p), `Moved “Washi tape” to “${B.title}”.`); assert.deepEqual(await dbIds(A.id), [keep]); assert.deepEqual(await dbIds(B.id), [mover]); assert.deepEqual(rowIds(p), [keep], 'gone from this list'); assert.equal(p.q('form[data-form="edit-item"]'), null, 'the edit panel closed'); assert.equal(p.text(p.q('table.grid')).includes('Washi tape'), false, 'the item is not in the table any more'); assert.equal((await app.q('SELECT COUNT(DISTINCT order_id) AS n, MIN(order_id) AS o FROM claims WHERE item_id = ?', [mover]))[0].o, B.id); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('MOVING SAYS WHEN IT WON\'T WORK, AND WARNS ABOUT A CLOSED TARGET: a refusal is shown as a message and nothing moves; a cancelled item has no move section; an item with no claims says so', async () => {
  const A = await goOrder(), B = await goOrder(); await api('PATCH', `/api/admin/orders/${B.id}`, { closeDate: '2020-01-01' }); const free = await item(A.id, 'Free photocard', { price: 0 }), album = await item(A.id, 'Album', { price: 10 }), gone = await item(A.id, 'Cancelled one');
  assert.equal((await api('POST', `/api/admin/orders/${A.id}/benefits`, { title: 'Spend £10', threshold: 10, quantity: 1, bonusItemId: free, itemIds: [album] })).status, 201); assert.equal((await api('POST', `/api/admin/items/${gone}/cancel`, { confirm: 'Cancelled one' })).status, 200); const plain = await item(A.id, 'Plain'); const p = await itemsPage(A.id);
  await p.click(p.q(`[data-act="edit-item"][data-id="${album}"]`)); let f = p.q('[data-move-item]'); f.querySelector('[data-move-target]').value = String(B.id); await p.click(f.querySelector('[data-act="item-move"]')); await sleep(200); assert.match(toast(p), /This item is part of a purchase benefit — take it out of the benefit before moving it\./); assert.equal(p.q('.ui-modal'), null, 'no question for something that can\'t happen'); assert.equal((await dbIds(A.id)).includes(album), true);
  await p.click(p.q('[data-act="cancel-item-edit"]')); await p.click(p.q(`[data-act="edit-item"][data-id="${gone}"]`)); assert.equal(p.q('[data-move-item]'), null, 'a cancelled item can\'t be moved, so there is no section');
  await p.click(p.q('[data-act="cancel-item-edit"]')); await p.click(p.q(`[data-act="edit-item"][data-id="${plain}"]`)); f = p.q('[data-move-item]'); f.querySelector('[data-move-target]').value = String(B.id); await p.click(f.querySelector('[data-act="item-move"]')); await sleep(200); const q = p.text(modal(p));
  assert.match(q, /^Move “Plain” from .* to .*\? It has no claims yet\. It goes to the end of that group order's list\./); assert.match(q, new RegExp(`“${B.title}” is closed, so joiners won't be able to claim this item there\\.Not yetMove it$`)); await press(p, 'Not yet'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('IF THE LIST CHANGED WHILE YOU WERE LOOKING (another tab, someone else) a move is refused with a plain message and the list refreshes — nothing is scrambled', async () => {
  const { id: go } = await goOrder(); const [a, b] = [await item(go, 'Old one'), await item(go, 'Old two')]; const p = await itemsPage(go); const added = await item(go, 'Added elsewhere'); assert.deepEqual(rowIds(p), [a, b], 'this page doesn\'t know yet');
  await p.click(p.q(`[data-act="item-down"][data-id="${a}"]`)); await done(p); assert.equal(toast(p), 'This list has changed since you opened it — refresh and try again.'); assert.deepEqual(await dbIds(go), [a, b, added], 'nothing was reordered'); assert.deepEqual(rowIds(p), [a, b, added], 'the list refreshed itself'); p.close();
});
