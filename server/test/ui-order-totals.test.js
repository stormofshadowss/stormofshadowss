import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage } from './ui.helpers.js';

// GOM → Claims: choosing a group order shows ITS total item cost on one line (secured, paid, still owed, plus what is still only requested), whatever else you have filtered.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'ut') => `${x}${++N}`;
const mk = async (title, { secured = 0, requested = 0, tbc = false, price = 10 } = {}) => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam' })).json.id; const it = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), ...(tbc ? { priceTbc: true } : { price }) })).json.id;
  for (let i = 0; i < secured; i++) await claimAndSecure(app, admin, u(), it); for (let i = 0; i < requested; i++) await app.api('POST', '/api/claims', { handle: u(), lines: [{ itemId: it }] }); return { go, it };
};
const claimsTab = async () => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', 'Claims')); await sleep(250); await p.settle(); return p; };
const pick = async (p, go) => { await p.choose(p.q('[data-filter="order"]'), go === '' ? '' : String(go)); await sleep(350); await p.settle(); };
const card = (p) => p.q('[data-order-total]');

test('CHOOSING A GROUP ORDER SHOWS ITS TOTAL: secured item cost with paid and still owed, and the still-requested claims separately; "All" shows none', async () => {
  const { go, it } = await mk('Totals Tour 2026', { secured: 3, requested: 2 }); const [c] = await app.q("SELECT c.id FROM claims c WHERE c.item_id = ? AND c.status = 'confirmed' ORDER BY c.id", [it]); await api('PATCH', `/api/admin/claims/${c.id}`, { costs: { initials: { paid: 6 } } });
  const p = await claimsTab(); assert.equal(card(p), null, 'nothing before an order is chosen'); await pick(p, go);
  assert.match(p.text(card(p)), /^Totals Tour 2026 — item cost £30\.00 across 3 secured claims · paid £6\.00 · still owed £24\.00 · plus £20\.00 in 2 requested claims not secured yet\s*Item cost only — postage, EMS, customs and packaging aren't included\.$/);
  await pick(p, ''); assert.equal(card(p), null, 'back to All: no total'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('WORDING FOR ONE CLAIM, FOR NONE REQUESTED, AND FOR PRICE-TBC', async () => {
  const one = await mk('One claim order', { secured: 1, requested: 1 }), none = await mk('Fully secured order', { secured: 2 }), tbc = await mk('Price TBC order', { requested: 2, tbc: true }); const p = await claimsTab(); await pick(p, one.go); assert.match(p.text(card(p)), /item cost £10\.00 across 1 secured claim · paid £0\.00 · still owed £10\.00 · plus £10\.00 in 1 requested claim not secured yet/); 
  await pick(p, none.go); assert.doesNotMatch(p.text(card(p)), /requested/); assert.match(p.text(card(p)), /item cost £20\.00 across 2 secured claims/);
  await pick(p, tbc.go); assert.match(p.text(card(p)), /item cost £0\.00 across 0 secured claims/); assert.match(p.text(card(p)), /plus £0\.00 in 2 requested claims not secured yet · 2 still price TBC/); p.close();
});

test('IT IS THE WHOLE ORDER WHATEVER ELSE IS FILTERED: a search for one person, or the status chips, do not change it; securing the requested claims moves them into the secured total', async () => {
  const { go, it } = await mk('Filtered order', { secured: 2, requested: 2 }); const p = await claimsTab(); await pick(p, go); const before = p.text(card(p)); const [mine] = await app.q("SELECT j.instagram_handle AS h FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE c.item_id = ? LIMIT 1", [it]);
  await p.type(p.q('[data-filter="q"]'), mine.h); await p.settle(); assert.equal(p.text(card(p)), before, 'a search does not change the order total'); await p.type(p.q('[data-filter="q"]'), ''); await p.settle();
  await api('POST', '/api/admin/claims/secure', { orderId: go }); await pick(p, ''); await pick(p, go); assert.match(p.text(card(p)), /item cost £40\.00 across 4 secured claims/); assert.doesNotMatch(p.text(card(p)), /requested/); p.close();
});

test('THE GROUP ORDER\'S NAME IS SHOWN AS TEXT', async () => {
  const { go } = await mk('<img src=x onerror="window.pwned=1"> Odd <b>GO</b>', { secured: 1 }); const p = await claimsTab(); await pick(p, go); assert.equal(p.q('img[src="x"]', card(p)), null); assert.equal(p.q('b', card(p)), null); assert.equal(p.window.pwned, undefined); assert.ok(p.text(card(p)).startsWith('<img src=x onerror="window.pwned=1"> Odd <b>GO</b> — item cost £10.00')); p.close();
});
