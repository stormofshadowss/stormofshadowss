import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { gomPage, toast } from './ui.helpers.js';
import { openPage } from './ui.helpers.js';

// GOM: "Hide from joiners" on any item (a tick in the Add and Edit forms, a marker in the list), and the Purchase benefits panel creating its own hidden bonus item.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Hidden UI GO ${++N}`, proxy: 'Sam' })).json.id;
const item = async (go, title, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title, ...extra })).json.id;
const itemsPage = async (go) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`)); await sleep(80); await p.settle(); return p; };
const benefitsPage = async (go) => { const p = await itemsPage(go); await p.click(p.q('[data-act="benefits"]')); await sleep(250); await p.settle(); return p; };
const row = (p, id) => p.q(`[data-act="edit-item"][data-id="${id}"]`).closest('tr');
const publicIds = async (go) => ((await app.api('GET', '/api/orders')).json.orders.find((o) => o.id === go)?.items || []).map((i) => i.id);
const adminItem = async (go, id) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === id);

test('THE ADD FORM HAS A "HIDE FROM JOINERS" TICK (off by default); a hidden item is marked in your list and is not on the public page', async () => {
  const go = await goOrder(); const p = await itemsPage(go); const f = p.q('form[data-form="new-item"]'); assert.ok(f.elements.hidden); assert.equal(f.elements.hidden.checked, false, 'off by default'); assert.match(p.text(f.elements.hidden.closest('div.full')), /Hide from joiners\s*They can't see it or claim it — only you can add it for people \(for example a free bonus photocard\)\./);
  f.elements.title.value = 'Secret thing'; f.elements.price.value = '0'; f.elements.hidden.checked = true; await p.submit(f); await sleep(350); await p.settle(); const [made] = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.filter((i) => i.title === 'Secret thing');
  assert.equal(made.hidden, true); assert.deepEqual(await publicIds(go), [], 'not on the public page'); assert.match(p.text(p.q('[data-hidden-item]', row(p, made.id))), /^Hidden from joiners$/);
  const f2 = p.q('form[data-form="new-item"]'); f2.elements.title.value = 'Normal thing'; f2.elements.price.value = '4'; await p.submit(f2); await sleep(350); await p.settle(); const normal = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.title === 'Normal thing'); assert.equal(p.q('[data-hidden-item]', row(p, normal.id)), null, 'an ordinary item has no marker'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('THE EDIT FORM SHOWS WHETHER IT IS HIDDEN, and unticking it makes the item public again (the marker goes); saving other changes leaves it as it was', async () => {
  const go = await goOrder(); const it = await item(go, 'Toggle me', { hidden: true }); const p = await itemsPage(go); await p.click(p.q(`[data-act="edit-item"][data-id="${it}"]`)); let f = p.q('form[data-form="edit-item"]'); assert.equal(f.elements.hidden.checked, true, 'remembered');
  f.elements.title.value = 'Toggle me, renamed'; await p.submit(f); await sleep(350); await p.settle(); assert.equal((await adminItem(go, it)).hidden, true, 'a rename leaves it hidden'); await p.click(p.q(`[data-act="edit-item"][data-id="${it}"]`)); f = p.q('form[data-form="edit-item"]'); f.elements.hidden.checked = false; await p.submit(f); await sleep(350); await p.settle();
  assert.equal((await adminItem(go, it)).hidden, false); assert.deepEqual(await publicIds(go), [it], 'public again'); assert.equal(p.q('[data-hidden-item]', row(p, it)), null, 'the marker is gone'); p.close();
});

test('A JOINER REALLY DOES NOT SEE A HIDDEN ITEM on the order page (the other items are there)', async () => {
  const go = await goOrder(); const shown = await item(go, 'Visible album'), hidden = await item(go, 'Hidden bonus', { hidden: true }); const p = await openPage(app, '/'); await sleep(250); await p.settle(); p.window.location.hash = `#/order/${go}`; await sleep(250); await p.settle();
  assert.ok(p.q(`[data-item-card="${shown}"]`)); assert.equal(p.q(`[data-item-card="${hidden}"]`), null); assert.doesNotMatch(p.text(p.q('#view')), /Hidden bonus/); p.close();
});

test('THE BENEFIT PANEL CREATES A HIDDEN BONUS ITEM IN ONE STEP: name it (or keep the suggestion), tick what counts, save — the new item is free, hidden from joiners, and the offer uses it; no warning because it is hidden', async () => {
  const go = await goOrder(); const album = await item(go, 'Album', { price: 10 }); const p = await benefitsPage(go); await p.click(p.q('[data-act="benefit-new"]')); const f = () => p.q('form[data-form="benefit"]');
  f().elements.title.value = 'Spend £10, get a card'; f().elements.threshold.value = '10'; f().elements.quantity.value = '1'; f().elements.newBonusTitle.value = 'Lucky draw photocard'; await p.click(p.q('[data-benefit-items] input[type="checkbox"]', f())); await p.submit(f()); await sleep(450); await p.settle();
  assert.match(toast(p), /Offer saved\./); const card = p.q('[data-benefit]', p.q('#benefitsPanel')); assert.match(p.text(card), /get 1 × Lucky draw photocard/); assert.equal(p.q('[data-bonus-public]', card), null, 'hidden, so nothing to warn about');
  const made = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.title === 'Lucky draw photocard'); assert.deepEqual([made.hidden, made.price, made.type], [true, 0, 'normal']); assert.deepEqual(await publicIds(go), [album], 'joiners see only the album');
  assert.match(p.text(row(p, made.id)), /Hidden from joiners/, 'and your items list shows it, marked hidden'); void album; p.close();
});

test('AN OFFER WHOSE BONUS ITEM IS STILL PUBLIC SAYS SO, with a one-press "Hide it from joiners"; pressing it hides the item and the warning goes', async () => {
  const go = await goOrder(); const a = await item(go, 'Album', { price: 10 }), bonus = await item(go, 'Public free card', { price: 0 }); await api('POST', `/api/admin/orders/${go}/benefits`, { title: 'Offer', threshold: 10, quantity: 1, bonusItemId: bonus, itemIds: [a] });
  const p = await benefitsPage(go); const card = () => p.q('[data-benefit]', p.q('#benefitsPanel')); assert.match(p.text(p.q('[data-bonus-public]', card())), /^⚠ The bonus item “Public free card” is visible to joiners — they could claim it themselves\.\s*Hide it from joiners$/);
  assert.deepEqual((await publicIds(go)).sort(), [a, bonus].sort(), 'before: joiners can see it'); await p.click(p.q('[data-act="benefit-hide-bonus"]', card())); await sleep(450); await p.settle(); assert.match(toast(p), /^“Public free card” is now hidden from joiners\.$/); assert.equal(p.q('[data-bonus-public]', card()), null, 'the warning is gone'); assert.deepEqual(await publicIds(go), [a], 'after: they cannot'); assert.equal((await adminItem(go, bonus)).hidden, true); p.close();
});

test('TITLES WITH HTML ARE SHOWN AS TEXT (the warning, the marker, the bonus choices)', async () => {
  const go = await goOrder(); const a = await item(go, 'Album', { price: 10 }), bonus = await item(go, '<img src=x onerror="window.pwned=1"> <b>Bonus</b>', { price: 0 }); await api('POST', `/api/admin/orders/${go}/benefits`, { title: 'Offer', threshold: 10, quantity: 1, bonusItemId: bonus, itemIds: [a] });
  const p = await benefitsPage(go); assert.equal(p.q('img[src="x"]'), null); assert.equal(p.q('#benefitsPanel b'), null); assert.equal(p.window.pwned, undefined); assert.ok(p.text(p.q('[data-bonus-public]')).includes('<img src=x onerror="window.pwned=1"> <b>Bonus</b>')); await p.click(p.q('[data-act="benefit-new"]')); assert.ok([...p.q('form[data-form="benefit"]').elements.bonusItemId.options].some((o) => o.textContent.includes('<b>Bonus</b>')), 'in the choice list too'); p.close();
});
