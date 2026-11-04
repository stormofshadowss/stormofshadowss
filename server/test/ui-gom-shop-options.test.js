import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { gomPage, toast } from './ui.helpers.js';

// GOM → Shop: add an item with options ("Han=1, Felix=2, Album B=2@18"), see how many are left of each, and edit them (rename, re-count, re-price, add, remove).
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'ugo') => `${x}${++N}`;
const shopTab = async () => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', 'Shop')); await sleep(250); await p.settle(); return p; };
const addForm = (p) => p.q('form[data-form="add"]');
const fill = (f, vals) => { for (const [k, v] of Object.entries(vals)) f.elements[k].value = v; };
const itemId = async (title) => (await api('GET', '/api/admin/shop')).json.items.find((i) => i.title === title).id;
const adminItem = async (id) => (await api('GET', '/api/admin/shop')).json.items.find((i) => i.id === id);
const mk = async (title, extra = {}) => (await api('POST', '/api/admin/shop', { title, price: 25, optionLabel: 'Size', options: [{ name: 'L', qty: 3 }, { name: 'M', qty: 2, price: 30 }], ...extra })).json.id;

test('ADDING: choosing what buyers pick shows the options box and hides the single count; "Han=1, Felix=2, Album B=2@18" makes the item; the card shows how many are left of each', async () => {
  const p = await shopTab(); const f = addForm(p); assert.equal(f.querySelector('[data-options-box]').hidden, true); assert.ok(f.elements.qty.required); await p.choose(f.elements.optionLabel, 'Member'); assert.equal(f.querySelector('[data-options-box]').hidden, false); assert.equal(f.querySelector('[data-qty-box]').hidden, true); assert.equal(f.elements.qty.required, false);
  const title = u('Photocards '); fill(f, { title, price: '3', optionsText: 'Han=1, Felix=2, Bang Chan, Album B=2@18' }); await p.submit(f); await sleep(500); await p.settle(); const id = await itemId(title); const it = await adminItem(id);
  assert.deepEqual(it.options.map((o) => [o.name, o.qty, o.ownPrice]), [['Han', 1, null], ['Felix', 2, null], ['Bang Chan', 1, null], ['Album B', 2, 18]]); assert.equal(it.qty, 6);
  assert.match(toast(p), /^Added/); await p.click(p.q('[data-act="cancel-edit"]')); await sleep(80); assert.match(p.text(p.q(`[data-shop="${id}"] [data-options]`)), /^Members: Han 1 left \(of 1\) · Felix 2 left \(of 2\) · Bang Chan 1 left \(of 1\) · Album B 2 left \(of 2\) · £18\.00$/); p.close();
  const q = await shopTab(); await q.choose(addForm(q).elements.optionLabel, ''); assert.equal(addForm(q).querySelector('[data-qty-box]').hidden, false, 'choosing "nothing" brings the count back'); q.close();
});

test('ADDING IS CHECKED ON THE SCREEN: nothing listed, and an option written wrongly, are explained (and nothing is saved)', async () => {
  const p = await shopTab(); const f = addForm(p); await p.choose(f.elements.optionLabel, 'Size'); fill(f, { title: u('Bad '), price: '5', optionsText: '' }); await p.submit(f); await sleep(200); assert.match(p.text(p.q('[data-msg]', f)), /^List the sizes, like Han=1, Felix=2\.$/);
  fill(f, { optionsText: 'L=two, M=1' }); await p.submit(f); await sleep(200); assert.match(p.text(p.q('[data-msg]', f)), /^“L=two” — write each option like Han=2, or Album B=2@18/); fill(f, { optionsText: 'L=1, l=2' }); await p.submit(f); await sleep(300); assert.match(p.text(p.q('[data-msg]', f)), /“l” is listed twice/); p.close();
});

test('EDITING: rows for each option (name, how many, price, claimed); rename + re-count + re-price + add + remove in one save; the card and the claims follow', async () => {
  const id = await mk(u('Hoodie ')); const h = u('buyer'); await app.api('POST', '/api/claims', { handle: h, lines: [{ leftoverId: id, member: 'L' }] }); await adminItem(id);
  const p = await shopTab(); await p.click(p.q(`[data-act="edit"][data-id="${id}"]`)); const f = p.q('form[data-form="edit"]'); const rows = p.qa('[data-opt-id]', f); assert.equal(rows.length, 2); assert.equal(f.querySelector('[data-qty-box]'), null, 'no single count for an item with options');
  assert.deepEqual(rows.map((r) => [r.querySelector('[data-opt-name]').value, r.querySelector('[data-opt-qty]').value, r.querySelector('[data-opt-price]').value, r.querySelector('[data-opt-remove]').disabled]), [['L', '3', '', true], ['M', '2', '30', false]], 'a claimed option can\'t be removed'); assert.equal(rows[0].querySelector('[data-opt-qty]').min, '1', 'and its count can\'t go below what is claimed');
  rows[0].querySelector('[data-opt-name]').value = 'Large'; rows[0].querySelector('[data-opt-qty]').value = '5'; rows[0].querySelector('[data-opt-price]').value = '28'; rows[1].querySelector('[data-opt-remove]').checked = true; f.elements.moreOptions.value = 'XL=2@35'; await p.submit(f); await sleep(500); await p.settle();
  assert.equal(toast(p), 'Saved.'); const it = await adminItem(id); assert.deepEqual(it.options.map((o) => [o.name, o.qty, o.ownPrice]), [['Large', 5, 28], ['XL', 2, 35]]); assert.equal(it.qty, 7);
  assert.match(p.text(p.q(`[data-shop="${id}"] [data-options]`)), /^Sizes: Large 4 left \(of 5\) · £28\.00 · XL 2 left \(of 2\) · £35\.00$/); assert.match(p.text(p.q(`[data-shop="${id}"] [data-claim-option]`)), /^— Large$/, 'the claim followed the rename'); p.close();
});

test('EDITING SAYS WHY IT WAS REFUSED: a count below what is claimed; and the picker\'s name can be changed', async () => {
  const id = await mk(u('Hoodie ')); await app.api('POST', '/api/claims', { handle: u('b'), allowDuplicates: true, lines: [{ leftoverId: id, member: 'L', qty: 2 }] });
  const p = await shopTab(); await p.click(p.q(`[data-act="edit"][data-id="${id}"]`)); const f = p.q('form[data-form="edit"]'); p.qa('[data-opt-id] [data-opt-qty]', f)[0].value = '1'; await p.submit(f); await sleep(400); assert.match(p.text(p.q('[data-msg]', f)), /^2 of “L” are already claimed — set the count to at least 2/); assert.equal((await adminItem(id)).options[0].qty, 3, 'nothing changed');
  p.qa('[data-opt-id] [data-opt-qty]', f)[0].value = '3'; await p.choose(f.elements.optionLabel, 'Version'); await p.submit(f); await sleep(400); await p.settle(); assert.equal((await adminItem(id)).optionLabel, 'Version'); assert.match(p.text(p.q(`[data-shop="${id}"] [data-options]`)), /^Versions: /); p.close();
});

test('AN ORDINARY ITEM: still one count; it can be turned into one with options while nobody has claimed it, but not once someone has', async () => {
  const fresh = (await api('POST', '/api/admin/shop', { title: u('Plain '), price: 8, qty: 3 })).json.id, taken = (await api('POST', '/api/admin/shop', { title: u('Taken '), price: 8, qty: 3 })).json.id; await app.api('POST', '/api/claims', { handle: u('b'), lines: [{ leftoverId: taken }] });
  const p = await shopTab(); await p.click(p.q(`[data-act="edit"][data-id="${taken}"]`)); assert.equal(p.q('form[data-form="edit"] [name="optionLabel"]'), null, 'claimed: no way to add options'); assert.ok(p.q('form[data-form="edit"] [data-qty-box]')); p.close();
  const q = await shopTab(); await q.click(q.q(`[data-act="edit"][data-id="${fresh}"]`)); const f = q.q('form[data-form="edit"]'); await q.choose(f.elements.optionLabel, 'Version'); fill(f, { optionsText: 'Album A=2, Album B=1' }); await q.submit(f); await sleep(500); await q.settle();
  const it = await adminItem(fresh); assert.deepEqual([it.optionLabel, it.qty, it.options.map((o) => o.name)], ['Version', 3, ['Album A', 'Album B']]); q.close();
});
