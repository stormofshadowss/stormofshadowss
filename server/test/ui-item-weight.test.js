import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage } from './ui.helpers.js';

// GOM: a weight on the item (Add / Edit form, shown in the items list) that carries over to the Warehouse table.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Weight UI GO ${++N}`, proxy: 'Sam' })).json.id;
const itemsOf = async (go) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items;
const itemsPage = async (go) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`)); await sleep(80); await p.settle(); return p; };
const row = (p, id) => p.q(`[data-act="edit-item"][data-id="${id}"]`).closest('tr');
const done = async (p) => { await sleep(450); await p.settle(); };

test('THE ADD FORM HAS "WEIGHT OF ONE (g)": it is saved on the item and shown in the items list as "120 g each"; an item without one shows nothing; a bad weight is refused with a message and nothing is made', async () => {
  const go = await goOrder(); const p = await itemsPage(go); const f = p.q('form[data-form="new-item"]'); const field = f.elements.weightG; assert.ok(field, 'the field is on the form'); assert.equal(field.type, 'number'); assert.match(p.text(field.parentElement.querySelector('label')), /^Weight of one \(g\), optional$/); assert.match(p.text(field.parentElement.querySelector('.sub')), /carries over to the Warehouse/);
  f.elements.title.value = 'Heavy album'; f.elements.price.value = '20'; field.value = '120'; await p.submit(f); await done(p); const made = (await itemsOf(go)).find((i) => i.title === 'Heavy album'); assert.equal(made.weightG, 120); assert.equal(p.text(p.q('[data-item-weight]', row(p, made.id))), '120 g each');
  const f2 = p.q('form[data-form="new-item"]'); f2.elements.title.value = 'No weight known'; f2.elements.price.value = '5'; await p.submit(f2); await done(p); const plain = (await itemsOf(go)).find((i) => i.title === 'No weight known'); assert.equal(plain.weightG, null); assert.equal(p.q('[data-item-weight]', row(p, plain.id)), null, 'nothing shown when there is no weight');
  const f3 = p.q('form[data-form="new-item"]'); f3.elements.title.value = 'Bad weight'; f3.elements.price.value = '5'; f3.elements.weightG.value = '0'; await p.submit(f3); await done(p); assert.ok(p.text(p.q('[data-msg]', f3)).length > 0, 'explained'); assert.equal((await itemsOf(go)).some((i) => i.title === 'Bad weight'), false, 'nothing was made'); assert.deepEqual(p.errors, []); p.close();
});

test('THE EDIT FORM SHOWS THE WEIGHT AND CHANGES IT: pre-filled; a new number is saved; clearing it removes it; other fields are untouched', async () => {
  const go = await goOrder(); const id = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'Edit me', price: 12, weightG: 80 })).json.id; const p = await itemsPage(go);
  await p.click(p.q(`[data-act="edit-item"][data-id="${id}"]`)); let e = p.q('form[data-form="edit-item"]'); assert.equal(e.elements.weightG.value, '80', 'pre-filled'); e.elements.weightG.value = '250'; await p.submit(e); await done(p); assert.equal((await itemsOf(go)).find((i) => i.id === id).weightG, 250); assert.equal(p.text(p.q('[data-item-weight]', row(p, id))), '250 g each');
  await p.click(p.q(`[data-act="edit-item"][data-id="${id}"]`)); e = p.q('form[data-form="edit-item"]'); e.elements.weightG.value = ''; await p.submit(e); await done(p); const after = (await itemsOf(go)).find((i) => i.id === id); assert.deepEqual([after.weightG, after.title, after.price], [null, 'Edit me', 12], 'cleared; nothing else changed'); assert.equal(p.q('[data-item-weight]', row(p, id)), null); p.close();
});

test('THE WAREHOUSE TABLE IS PRE-FILLED FROM THE ITEM (marked so, in italics, with a hint); typing a different number gives just that claim its own; clearing it goes back to the item\'s', async () => {
  const go = await goOrder(); const it = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'Weighed album', price: 20, weightG: 120 })).json.id; const [c1] = await claimAndSecure(app, admin, `wh${++N}`, it); await api('PATCH', `/api/admin/claims/${c1}`, { pipeline: 'arrived at proxy / warehouse' });
  const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', 'Warehouse')); await sleep(300); await p.settle(); const body = () => p.q('[data-cands-body]'); if (body().hidden) { await p.click(p.q('[data-act="toggle-cands"]')); await sleep(80); }
  const input = () => p.q(`input[data-act="weight"][data-id="${c1}"]`); assert.equal(input().value, '120', 'prefilled from the item'); assert.ok(input().hasAttribute('data-from-item')); assert.match(input().getAttribute('title'), /^From the item's weight — type a different number to give just this one its own$/); assert.match(input().getAttribute('style'), /font-style:italic/);
  await p.choose(input(), '150'); await sleep(500); await p.settle(); assert.equal(input().value, '150'); assert.equal(input().hasAttribute('data-from-item'), false, 'it has its own weight now'); assert.deepEqual((await app.q('SELECT weight_g AS w FROM claims WHERE id = ?', [c1]))[0], { w: 150 });
  await p.choose(input(), ''); await sleep(500); await p.settle(); assert.equal(input().value, '120', 'cleared: back to the item\'s weight'); assert.ok(input().hasAttribute('data-from-item')); assert.equal((await app.q('SELECT weight_g AS w FROM claims WHERE id = ?', [c1]))[0].w, null);
  const [c2] = await claimAndSecure(app, admin, `wh${++N}`, (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'Unweighed', price: 5 })).json.id); await api('PATCH', `/api/admin/claims/${c2}`, { pipeline: 'arrived at proxy / warehouse' }); await p.click(p.byText('#tabs button', 'Packing')); await sleep(200); await p.click(p.byText('#tabs button', 'Warehouse')); await sleep(300); await p.settle(); if (body().hidden) { await p.click(p.q('[data-act="toggle-cands"]')); await sleep(80); }
  assert.equal(p.q(`input[data-act="weight"][data-id="${c2}"]`).value, '', 'no weight anywhere: blank, as before'); assert.equal(p.q(`input[data-act="weight"][data-id="${c2}"]`).hasAttribute('data-from-item'), false); assert.deepEqual(p.errors, []); p.close();
});
