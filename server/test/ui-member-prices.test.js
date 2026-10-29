import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { gomPage, toast, modal, press, openPage } from './ui.helpers.js';

// A SIZE (member) of an independent item can have its own price: written Name=price when adding, editable later (with a helper for names that already have the price typed into them),
// charged to joiners, and asked about when you move a claim to a size that costs something different.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'um') => `${x}${++N}`;
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Sleeves UI GO '), proxy: 'Sam' })).json.id;
const item = async (go, members, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'independent', price: 0.55, title: u('Sleeves '), members, ...extra })).json.id;
const roster = async (go, id) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === id).members;
const itemsPage = async (go) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`)); await sleep(80); await p.settle(); return p; };
const editPage = async (go, id) => { const p = await itemsPage(go); await p.click(p.q(`[data-act="edit-item"][data-id="${id}"]`)); return p; };
const form = (p) => p.q('form[data-form="edit-item"]');
const rows = (p) => p.qa('input[data-member-id]', form(p)).map((i) => ({ name: i.value, price: i.parentElement.querySelector('[data-member-price]').value, ph: i.parentElement.querySelector('[data-member-price]').placeholder, el: i }));
const save = async (p) => { await p.submit(form(p)); await sleep(400); await p.settle(); };
const cost = async (h, id, m) => Number((await app.q("SELECT cc.cost FROM claims c JOIN joiners j ON j.id = c.joiner_id JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category = 'initials' WHERE j.instagram_handle = ? AND c.item_id = ? AND c.member_name = ? AND c.status <> 'cancelled' ORDER BY c.id DESC LIMIT 1", [h, id, m]))[0].cost);

test('ADDING: the members box says you can write a size\'s own price (70x110=0.70); those sizes are saved with that price and the items list shows it; a price that isn\'t a number is explained', async () => {
  const go = await goOrder(); const p = await itemsPage(go); const f = p.q('form[data-form="new-item"]'); await p.choose(f.elements.type, 'independent');
  assert.equal(p.text(p.q('[data-extra-label]', f)), 'Members — give one its own price like 70x110=0.70'); assert.equal(f.elements.extra.placeholder, 'Bang Chan, Han, 70x110=0.70, 80x120=0.90');
  f.elements.title.value = 'Soft Sleeves'; f.elements.price.value = '0.55'; f.elements.extra.value = '43x67, 70x110=0.70, 80x120 = 0.9, 63.5x88 (soft fit)'; await p.submit(f); await sleep(400); await p.settle();
  const made = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.title === 'Soft Sleeves'); assert.deepEqual(made.members.map((m) => [m.name, m.price, m.ownPrice]), [['43x67', 0.55, null], ['70x110', 0.7, 0.7], ['80x120', 0.9, 0.9], ['63.5x88 (soft fit)', 0.55, null]]);
  assert.match(p.text(p.q(`[data-act="edit-item"][data-id="${made.id}"]`).closest('tr')), /43x67, 70x110 £0\.70, 80x120 £0\.90, 63\.5x88 \(soft fit\)/);
  const f2 = p.q('form[data-form="new-item"]'); await p.choose(f2.elements.type, 'independent'); f2.elements.title.value = 'Bad price'; f2.elements.price.value = '1'; f2.elements.extra.value = 'A, B=cheap'; await p.submit(f2); await sleep(250); assert.match(p.text(p.q('[data-msg]', f2)), /"B" has a price that isn't a number — write it like Diary=2\./); p.close();
});

test('EDITING: each size has a price box (filled if it has its own, otherwise showing the item\'s price faintly); change one and Save — the message says what changed and how many unsecured claims followed', async () => {
  const go = await goOrder(); const it = await item(go, ['43x67', { name: '70x110', price: 0.7 }]); const h = u('own'), h2 = u('sec'); await joinerSession(app, `${h}@x.com`, h); await joinerSession(app, `${h2}@x.com`, h2);
  await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: it, member: '70x110' }] }); await claimAndSecure(app, admin, h2, it, { member: '70x110' });
  const p = await editPage(go, it); const r = rows(p); assert.deepEqual(p.qa('[data-member-price]', form(p)).map((i) => i.type), ['number', 'number'], 'real number boxes'); assert.deepEqual(r.map((x) => [x.name, x.price, x.ph]), [['43x67', '', '0.55'], ['70x110', '0.7', '0.55']]); r[1].el.parentElement.querySelector('[data-member-price]').value = '0.8'; await save(p);
  assert.equal(toast(p), 'Saved — “70x110” is now £0.80. 1 unsecured claim now uses it; secured claims keep theirs.'); assert.equal(await cost(h, it, '70x110'), 0.8); assert.equal(await cost(h2, it, '70x110'), 0.7, 'the secured claim keeps its price'); assert.equal((await roster(go, it))[1].ownPrice, 0.8);
  const p2 = await editPage(go, it); rows(p2)[1].el.parentElement.querySelector('[data-member-price]').value = ''; await save(p2); assert.equal(toast(p2), 'Saved — “70x110” is now the item\'s price. 1 unsecured claim now uses it; secured claims keep theirs.'); assert.equal((await roster(go, it))[1].ownPrice, null); p.close(); p2.close();
});

test('EDITING: nothing changed is a plain "Saved."; a bad price is explained and nothing is saved; with nobody claimed there is no claims note', async () => {
  const go = await goOrder(); const it = await item(go, ['A', { name: 'B', price: 0.9 }]); let p = await editPage(go, it); await save(p); assert.equal(toast(p), 'Saved.'); p.close();
  p = await editPage(go, it); rows(p)[0].el.parentElement.querySelector('[data-member-price]').value = '-3'; await save(p); assert.match(p.text(p.q('[data-msg]', form(p))), /^“A” has a price that isn't a number\.$|^“A”/); assert.equal((await roster(go, it))[0].ownPrice, null); p.close();
  p = await editPage(go, it); rows(p)[0].el.parentElement.querySelector('[data-member-price]').value = '0.6'; await save(p); assert.equal(toast(p), 'Saved — “A” is now £0.60.'); p.close();
});

test('NAMES THAT ALREADY HAVE A PRICE TYPED INTO THEM (70x110=0.70): a button moves each price into its box (you still press Save); the roster is cleaned, prices apply, claims on the old names follow', async () => {
  const go = await goOrder(); const it = await item(go, ['43x67', '70x110=0.70', '102x152=1', '63.5x88 (soft fit)']); const h = u('old'); await joinerSession(app, `${h}@x.com`, h); await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: it, member: '70x110=0.70' }] });
  assert.equal(await cost(h, it, '70x110=0.70'), 0.55, 'as it is today: charged the item price, whatever the name says');
  const p = await editPage(go, it); const btn = p.q('[data-act="split-prices"]', form(p)); assert.ok(btn); assert.match(p.text(btn), /^Move “name=price” into the name and price boxes$/); await p.click(btn);
  assert.deepEqual(rows(p).map((x) => [x.name, x.price]), [['43x67', ''], ['70x110', '0.7'], ['102x152', '1'], ['63.5x88 (soft fit)', '']]); assert.match(p.text(p.q('[data-split-note]')), /^Moved 2 prices into the price boxes — check them, then press Save\.$/); assert.equal(btn.hidden, true);
  assert.deepEqual((await roster(go, it)).map((m) => m.name), ['43x67', '70x110=0.70', '102x152=1', '63.5x88 (soft fit)'], 'nothing is saved until Save'); await save(p);
  assert.deepEqual((await roster(go, it)).map((m) => [m.name, m.ownPrice]), [['43x67', null], ['70x110', 0.7], ['102x152', 1], ['63.5x88 (soft fit)', null]]); assert.equal(await cost(h, it, '70x110'), 0.7, 'the claim followed the rename AND the price'); assert.match(toast(p), /“70x110=0\.70” is now “70x110”/); p.close();
  const clean = await editPage(go, it); assert.equal(clean.q('[data-act="split-prices"]', form(clean)), null, 'no button once the names are clean'); clean.close();
});

test('A JOINER SEES EACH SIZE\'S PRICE ON ITS TILE, THE BASKET ADDS THEM UP, AND THE CLAIMS ARE CHARGED THEM', async () => {
  const go = await goOrder(); const it = await item(go, ['43x67', { name: '70x110', price: 0.7 }]); const h = u('shopper'); await joinerSession(app, `${h}@x.com`, h);
  const p = await openPage(app, '/'); await sleep(250); await p.settle(); p.window.location.hash = `#/order/${go}`; await sleep(250); await p.settle();
  const tile = (m) => p.q(`[data-act="inc"][data-item="${it}"][data-member="${m}"]`).closest('.opt, .tile, div'); assert.match(p.text(tile('43x67')), /£0\.55/); assert.match(p.text(tile('70x110')), /£0\.70/);
  await p.click(p.q(`[data-act="inc"][data-item="${it}"][data-member="43x67"]`)); await p.click(p.q(`[data-act="inc"][data-item="${it}"][data-member="70x110"]`)); p.window.location.hash = '#/basket'; await sleep(150); await p.settle();
  assert.match(p.text(p.q('#view')), /£1\.25/, 'the basket total is 0.55 + 0.70'); p.q('#ig').value = h; await p.submit(p.q('form[data-form="claim"]')); await sleep(400); await p.settle(); assert.deepEqual([await cost(h, it, '43x67'), await cost(h, it, '70x110')], [0.55, 0.7]); p.close();
});

test('FIX A CLAIM: moving to a size that costs something different asks "re-price or keep" (naming the size\'s price); a size at the same price just moves', async () => {
  const go = await goOrder(); const it = await item(go, ['A', 'B', { name: 'Big', price: 0.9 }]); const h = u('fixer'); await joinerSession(app, `${h}@x.com`, h); const [id] = await claimAndSecure(app, admin, h, it, { member: 'A' });
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); await sleep(100); await p.settle(); await p.choose(p.q('[data-filter="order"]'), String(go)); await sleep(120); await p.settle(); await p.click(p.q('[data-act="toggle"]', p.q(`[data-buyer="${h}"]`)));
  const f = (sel) => p.q(sel, p.q('[data-form="fix"]')); await p.click(p.q(`[data-act="fix"][data-id="${id}"]`)); await sleep(150); await p.settle();
  await p.choose(f('select[name="member"]'), 'B'); assert.equal(f('[data-ask-price]'), null, 'B costs the same as A: no question'); await p.choose(f('select[name="member"]'), 'Big'); assert.ok(f('[data-ask-price]'), 'Big costs more: asked');
  assert.match(p.text(f('input[name="pricing"][value="reprice"]').closest('label')), /^Re-price it — set it to the new size's price \(£0\.90\)\./);
  await p.click(f('[data-act="fix-change"]')); await sleep(150); assert.match(p.text(p.q('[data-msg], .msg', p.q('[data-form="fix"]'))), /Choose whether to re-price it or keep the old price/); await p.click(f('input[name="pricing"][value="reprice"]')); await p.click(f('[data-act="fix-change"]')); await sleep(150);
  assert.match(p.text(modal(p)), /Its price becomes £0\.90;/); await press(p, 'Change it'); await sleep(400); await p.settle(); assert.equal(await cost(h, it, 'Big'), 0.9); p.close();
});
