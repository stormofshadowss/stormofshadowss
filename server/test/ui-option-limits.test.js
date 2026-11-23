import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { gomPage, openPage, toast } from './ui.helpers.js';

// A LIMIT ON ONE OPTION (washi tape: Green 3, Red 2): the boxes in the GOM's Edit form and the item list, and what a joiner sees and can do.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'uo') => `${x}${++N}`;
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Opt limit UI GO '), proxy: 'Sam' })).json.id;
const item = async (go, extra = {}) => { const r = await api('POST', `/api/admin/orders/${go}/items`, { type: 'independent', price: 3, title: 'Washi tape', members: ['Green', 'Red', 'Blue'], ...extra }); assert.equal(r.status, 201, r.text); return r.json.id; };
const adminItem = async (go, id) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === id);
const mid = async (go, id, name) => (await adminItem(go, id)).members.find((m) => m.name === name).id;
const setM = async (go, id, limits) => api('PATCH', `/api/admin/items/${id}`, { memberLimits: await Promise.all(Object.entries(limits).map(async ([n, limit]) => ({ id: await mid(go, id, n), limit }))) });
const claim = (lines, handle = u()) => app.api('POST', '/api/claims', { handle, lines });
const itemsPage = async (go) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`)); await sleep(80); await p.settle(); return p; };
const row = (p, id) => p.q(`[data-act="edit-item"][data-id="${id}"]`).closest('tr');
const editForm = async (p, id) => { await p.click(p.q(`[data-act="edit-item"][data-id="${id}"]`)); return p.q('form[data-form="edit-item"]'); };
const done = async (p) => { await sleep(450); await p.settle(); };
const limitBox = (f, name) => [...f.querySelectorAll('input[data-member-id]')].find((i) => i.value === name).parentElement.querySelector('[data-member-limit]');

test('THE EDIT FORM HAS A LIMIT BOX BESIDE EACH MEMBER (member items only): type Green 3 and Red 2, save — and the item list says what is left of each; blank means none of its own', async () => {
  const go = await goOrder(); const it = await item(go); const p = await itemsPage(go); let f = await editForm(p, it);
  assert.equal(p.text(f.querySelector('[data-members-edit] label')), 'Member names, prices and limits'); const boxes = [...f.querySelectorAll('[data-member-limit]')]; assert.equal(boxes.length, 3, 'one beside each member'); assert.deepEqual(boxes.map((b) => [b.placeholder, b.value, b.min, b.max]), [['limit', '', '1', '9999'], ['limit', '', '1', '9999'], ['limit', '', '1', '9999']]);
  assert.match(p.text(f.querySelector('[data-members-edit] .sub')), /Limit is how many of that member can be claimed in total \(blank = none of its own\)/); limitBox(f, 'Green').value = '3'; limitBox(f, 'Red').value = '2'; await p.submit(f); await done(p);
  assert.deepEqual((await adminItem(go, it)).members.map((m) => [m.name, m.ownLimit]), [['Green', 3], ['Red', 2], ['Blue', null]]); assert.equal(p.text(p.q('[data-item-limit]', row(p, it))), 'Green 3 left · Red 2 left', 'Blue has no number, so it is not listed');
  f = await editForm(p, it); assert.deepEqual([...f.querySelectorAll('[data-member-limit]')].map((b) => b.value), ['3', '2', ''], 'filled in next time'); limitBox(f, 'Green').value = ''; await p.submit(f); await done(p); assert.equal((await adminItem(go, it)).members[0].ownLimit, null, 'blank clears it'); assert.equal(p.text(p.q('[data-item-limit]', row(p, it))), 'Red 2 left');
  await claim([{ itemId: it, member: 'Red', qty: 2 }]); await p.close(); const q = await itemsPage(go); assert.equal(q.text(q.q('[data-item-limit]', row(q, it))), 'Red full', 'full is said plainly'); assert.deepEqual([q.errors, q.native], [[], 0]); q.close();
});

test('A BAD LIMIT IS EXPLAINED AND NOTHING IS SAVED; changing only the title leaves the limits alone; member SETS and plain items have no limit boxes', async () => {
  const go = await goOrder(); const it = await item(go); await setM(go, it, { Green: 3 }); const p = await itemsPage(go); let f = await editForm(p, it);
  for (const bad of ['0', '2.5', '-1']) { limitBox(f, 'Red').value = bad; await p.submit(f); await done(p); assert.match(p.text(p.q('[data-msg]', f)), /“Red” needs a limit that's a whole number, 1 or more — or leave it blank\./, bad); assert.equal((await adminItem(go, it)).members[1].ownLimit, null, 'nothing saved'); }
  limitBox(f, 'Red').value = ''; f.elements.title.value = 'Washi tape (renamed)'; await p.submit(f); await done(p); const a = await adminItem(go, it); assert.deepEqual([a.title, a.members[0].ownLimit], ['Washi tape (renamed)', 3], 'the title changed and Green\'s number stayed');
  const set = await item(go, { type: 'set', title: 'A member set', members: ['A', 'B'] }), plain = await item(go, { type: 'normal', title: 'Plain', members: undefined }); const q = await itemsPage(go); const sf = await editForm(q, set); assert.equal(sf.querySelectorAll('[data-member-limit]').length, 0, 'a set has no limit boxes'); assert.equal(q.text(sf.querySelector('[data-members-edit] label')), 'Member names and prices'); const pf = await editForm(q, plain); assert.equal(pf.querySelectorAll('[data-member-limit], [data-variant-id]').length, 0); p.close(); q.close();
});

test('SIZE ITEMS: a "Limit for each size" row in the Edit form; set S to 2 and the list says what is left', async () => {
  const go = await goOrder(); const it = await item(go, { type: 'size', title: 'Tote bag', members: undefined, variants: ['S', 'M', 'L'] }); const p = await itemsPage(go); let f = await editForm(p, it); assert.equal(p.text(f.querySelector('[data-variants-edit] label')), 'Limit for each size'); const boxes = [...f.querySelectorAll('input[data-variant-id]')]; assert.equal(boxes.length, 3);
  boxes[0].value = '2'; await p.submit(f); await done(p); assert.deepEqual((await adminItem(go, it)).variantLimits.map((v) => [v.label, v.ownLimit]), [['S', 2], ['M', null], ['L', null]]); assert.equal(p.text(p.q('[data-item-limit]', row(p, it))), 'S 2 left');
  f = await editForm(p, it); assert.deepEqual([...f.querySelectorAll('input[data-variant-id]')].map((b) => b.value), ['2', '', '']); const bad = f.querySelectorAll('input[data-variant-id]')[1]; bad.value = '0'; await p.submit(f); await done(p); assert.match(p.text(p.q('[data-msg]', f)), /^Size M needs a limit that's a whole number, 1 or more — or leave it blank\.$/); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

const open = async (go, opts = {}) => { const p = await openPage(app, '/', opts); await sleep(250); await p.settle(); p.window.location.hash = `#/order/${go}`; await sleep(250); await p.settle(); return p; };
const card = (p, id) => p.q(`[data-item-card="${id}"]`);
const plus = (p, id, opt) => p.q(`[data-act="inc"][data-item="${id}"][data-member="${opt}"], [data-act="inc"][data-item="${id}"][data-variant="${opt}"]`);
const tile = (p, id, name) => p.q(`[data-opt="${name}"]`, card(p, id));

test('WHAT A JOINER SEES AND CAN DO: each option shows how many are left, a + that stops exactly there, no number on an option without one; the item\'s total still caps everything', async () => {
  const go = await goOrder(); const it = await item(go); await setM(go, it, { Green: 3, Red: 2 }); await claim([{ itemId: it, member: 'Green' }]); const p = await open(go);
  assert.match(p.text(tile(p, it, 'Green')), /2 left/); assert.match(p.text(tile(p, it, 'Red')), /2 left/); assert.doesNotMatch(p.text(tile(p, it, 'Blue')), /left|limit/i, 'no number: nothing said'); assert.equal(p.q('[data-limit]', card(p, it)), null, 'and no "Limit N of each" note, as there is no item-wide number');
  await p.click(plus(p, it, 'Green')); await p.click(plus(p, it, 'Green')); assert.equal(plus(p, it, 'Green').disabled, true, 'both that are left are in the basket'); plus(p, it, 'Green').disabled = false; await p.click(plus(p, it, 'Green')); assert.match(toast(p), /“Washi tape — Green” has reached its purchase limit \(limit 3\)\./);
  for (let i = 0; i < 5; i++) await p.click(plus(p, it, 'Blue')); assert.equal(plus(p, it, 'Blue').disabled, false, 'Blue has no number'); assert.match(p.text(p.q('#basketPill')), /Basket \(7\)/); p.close();
  const total = await item(go, { title: 'Total of 4', purchaseLimit: 4, limitScope: 'item' }); await setM(go, total, { Green: 3, Red: 2 }); const q = await open(go); assert.match(q.text(card(q, total)), /Limit 4 in total · 4 left/);
  assert.match(q.text(tile(q, total, 'Green')), /3 left/); assert.match(q.text(tile(q, total, 'Red')), /2 left/, 'each option still shows its own number beside the item total');
  for (let i = 0; i < 3; i++) await q.click(plus(q, total, 'Green')); assert.equal(plus(q, total, 'Green').disabled, true, 'Green is at its own 3'); assert.equal(plus(q, total, 'Red').disabled, false, 'Red has room of its own and the total has 1 left'); await q.click(plus(q, total, 'Red')); assert.equal(plus(q, total, 'Red').disabled, true, 'the total of 4 is now used up, though Red\'s own 2 is not'); assert.deepEqual(q.errors, []); q.close();
});

test('A SAVED BASKET IS TRIMMED TO WHAT IS LEFT OF EACH OPTION when the page opens, with the usual message', async () => {
  const go = await goOrder(); const it = await item(go); await setM(go, it, { Green: 3, Red: 2 }); await claim([{ itemId: it, member: 'Red', qty: 2 }]);
  const line = (member, qty) => ({ key: `${it}|${member}|`, itemId: it, orderTitle: 'GO', title: 'Washi tape', label: 'Washi tape', price: 3, qty, member, variant: null });
  const p = await openPage(app, '/', { init: (win) => win.sessionStorage.setItem('sos_basket', JSON.stringify([line('Green', 5), line('Red', 1), line('Blue', 4)])) }); await sleep(300); await p.settle();
  const left = JSON.parse(p.window.sessionStorage.getItem('sos_basket')); assert.deepEqual(left.map((l) => [l.member, l.qty]), [['Green', 3], ['Blue', 4]], 'Green cut to its 3; Red is full, so removed; Blue has no number, so untouched'); await sleep(150); assert.match(toast(p), /2 items in your basket were reduced or taken out — the purchase limit has been reached\./); p.close();
});
