import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { gomPage, toast } from './ui.helpers.js';

// GOM: changing the price of an item that already has sets asks where it applies; the Sets tab shows a set's own price.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const claimSet = (handle, item, part) => app.api('POST', '/api/claims', { handle, lines: [{ itemId: item, parts: [{ member: part, qty: 1 }] }] }, undefined);
async function setup({ sets = 2, type = 'set' } = {}) {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Price choice GO ${++N}` })).json.id;
  const item = (await api('POST', `/api/admin/orders/${go}/items`, type === 'set' ? { type: 'set', title: `Price choice set ${N}`, price: 8, members: ['A', 'B'] } : { type: 'normal', title: `Price choice item ${N}`, price: 8 })).json.id;
  for (let i = 0; i < sets; i++) { await claimSet(`pc${N}x${i}a`, item, 'A'); await claimSet(`pc${N}x${i}b`, item, 'B'); }
  return { go, item };
}
const openForm = async (p, go, item) => { await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`)); await p.click(p.q(`[data-act="edit-item"][data-id="${item}"]`)); return p.q(`form[data-form="edit-item"][data-id="${item}"]`); };
const typePrice = (p, f, v) => { f.elements.price.value = String(v); f.elements.price.dispatchEvent(new p.window.Event('input', { bubbles: true })); };
const sets = async (item) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item);

test('THE CHOICE appears only when the price of an item that HAS SETS changes — "only new sets" is ticked, the wording is plain, and it goes again if the price is put back', async () => {
  const { go, item } = await setup(); const p = await gomPage(app, admin); const f = await openForm(p, go, item); const box = () => f.querySelector('[data-price-scope]');
  assert.ok(box() && box().hidden, 'there, but hidden until the price changes'); typePrice(p, f, 12); assert.equal(box().hidden, false);
  assert.match(p.text(box()), /^This item already has 2 sets\. Apply the new price to:\s*Only new sets — the 2 already started keep their price \(recommended\)\s*Everything that isn't secured yet, including the sets already started$/);
  assert.equal(f.elements.priceScope.value, 'newSets', '"only new sets" is ticked'); typePrice(p, f, 8); assert.equal(box().hidden, true, 'put back: nothing to choose');
  f.elements.priceTbc.checked = true; f.elements.priceTbc.dispatchEvent(new p.window.Event('change', { bubbles: true })); assert.equal(box().hidden, false, '"price to be confirmed" is a price change too'); f.elements.priceTbc.checked = false; f.elements.priceTbc.dispatchEvent(new p.window.Event('change', { bubbles: true })); f.elements.price.value = '8'; typePrice(p, f, 8); assert.equal(box().hidden, true);
  p.close(); const none = await setup({ sets: 0 }), plain = await setup({ type: 'normal', sets: 0 }); const q = await gomPage(app, admin); const f2 = await openForm(q, none.go, none.item); assert.equal(f2.querySelector('[data-price-scope]'), null, 'a set item with no sets yet never asks'); await q.click(q.byText('button', 'Cancel', f2)); const f3 = await openForm(q, plain.go, plain.item); assert.equal(f3.querySelector('[data-price-scope]'), null, 'an ordinary item never asks'); assert.deepEqual([q.errors, q.native], [[], 0]); q.close();
});

test('SAVING "ONLY NEW SETS" (the default): the started sets keep their price and the saved message says so; the Sets tab shows each set\'s own price', async () => {
  const { go, item } = await setup(); const p = await gomPage(app, admin); const f = await openForm(p, go, item); typePrice(p, f, 12); await p.submit(f); await sleep(500); await p.settle();
  assert.match(toast(p), /^Saved — Sets already started stay at £8\.00; new sets use the new price\.$/); assert.deepEqual((await sets(item)).map((s) => s.partPrice), [8, 8]); assert.deepEqual((await app.q("SELECT price FROM items WHERE id = ?", [item])).map((r) => Number(r.price)), [12]);
  await p.click(p.byText('#tabs button', 'Sets')); await sleep(300); await p.settle(); const mine = (await sets(item)).map((s) => s.id), pill = (id) => p.q(`[data-set="${id}"] [data-set-price]`); assert.equal(p.text(pill(mine[0])), '£8.00 each'); assert.equal(p.text(pill(mine[1])), '£8.00 each'); assert.match(pill(mine[0]).getAttribute('title'), /Every part of this set costs this, whatever the item's price is now/);
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('SAVING "EVERYTHING THAT ISN\'T SECURED YET": the unsecured claims move, the sets follow the item again, and the message counts what moved', async () => {
  const { go, item } = await setup(); const p = await gomPage(app, admin); const f = await openForm(p, go, item); typePrice(p, f, 12); f.elements.priceScope.value = 'all'; await p.submit(f); await sleep(500); await p.settle();
  assert.match(toast(p), /^Saved — 4 unsecured claims now use the new price\. Secured claims keep theirs\.$/); assert.deepEqual((await sets(item)).map((s) => s.partPrice), [null, null]); const costs = (await api('GET', '/api/admin/claims')).json.claims.filter((c) => c.label.includes(`Price choice set ${N}`)).map((c) => c.costs.initials.cost); assert.deepEqual(costs, [12, 12, 12, 12]);
  await p.click(p.byText('#tabs button', 'Sets')); await sleep(300); await p.settle(); for (const s of await sets(item)) assert.equal(p.q(`[data-set="${s.id}"] [data-set-price]`), null, 'no set of this item has a price of its own now'); assert.ok(p.q(`[data-set="${(await sets(item))[0].id}"]`), 'the sets are on the screen'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('A FORM WITH NO CHOICE ON SCREEN (opened before the item had sets) gets the server\'s plain message and saves nothing', async () => {
  const { go, item } = await setup(); const p = await gomPage(app, admin); const f = await openForm(p, go, item); f.elements.price.value = '13';          // no input event: the choice is still hidden
  f.querySelector('[data-price-scope]').remove(); await p.submit(f); await sleep(400); await p.settle(); assert.deepEqual((await sets(item)).map((s) => s.partPrice), [null, null], 'nothing was saved'); assert.match(p.text(p.q('[data-msg]', f)), /This item already has sets\. Choose whether the new price applies to new sets only/); p.close();
});
