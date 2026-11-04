import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { gomPage } from './ui.helpers.js';

// GOM → Sets: "Ordered" is a list of its own. "Secured" is secured sets still waiting to be ordered; once a set is full, secured and every claim is ordered (or further on) it moves to "Ordered" (still in All).
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'uo') => `${x}${++N}`;
const setup = async () => {
  const title = u('Ordered UI GO '); const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam' })).json.id; const item = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: 'Digipack', price: 4, members: ['A', 'B'] })).json.id;
  for (let i = 0; i < 3; i++) { await app.api('POST', '/api/claims', { handle: u('p'), lines: [{ itemId: item, parts: [{ member: 'A', qty: 1 }, { member: 'B', qty: 1 }], together: true }] }); }                    // three FULL sets
  const sets = (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item).sort((a, b) => a.number - b.number); for (const s of sets.slice(0, 2)) assert.equal((await api('POST', `/api/admin/sets/${s.id}/secure`, {})).status, 200);                    // Set 1 + Set 2 secured, Set 3 not
  const claims = (n) => sets[n].parts.map((p) => p.claimId); for (const id of claims(0)) await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ordered via proxy / warehouse' });                    // Set 1: ordered
  return { title, go, item, sets, claims };
};
const open = async (title) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', 'Sets')); await sleep(250); await p.settle(); const go = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.title === title).id; await p.choose(p.q('[data-filter="order"]'), String(go)); await sleep(300); await p.settle(); return p; };
const chip = async (p, label) => { await p.click(p.byText('#setChips .chip', label)); await sleep(60); };
const rows = (p) => p.qa('.setrow').map((r) => r.dataset.set);

test('THE CHIPS: To decide / Ready to secure / Secured / Ordered / Cancelled / All — "Secured" no longer includes finished sets, which are under "Ordered"; All has everything', async () => {
  const { title, sets } = await setup(); const p = await open(title); const labels = p.qa('#setChips .chip').map((c) => p.text(c)); assert.deepEqual(labels, ['To decide1', 'Ready to secure1', 'Secured1', 'Ordered1', 'Cancelled0', 'All3']);
  await chip(p, 'Secured'); assert.deepEqual(rows(p), [String(sets[1].id)], 'secured and still waiting to be ordered'); await chip(p, 'Ordered'); assert.deepEqual(rows(p), [String(sets[0].id)], 'the finished set'); await chip(p, 'All'); assert.equal(rows(p).length, 3);
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('THE ORDERED SET SAYS SO, AND THE ITEM\'S HEADER COUNTS EACH KIND', async () => {
  const { title, sets } = await setup(); const p = await open(title); await chip(p, 'All'); const pills = (n) => p.qa('.pill', p.q(`.setrow[data-set="${sets[n].id}"]`)).map((x) => p.text(x));
  assert.ok(pills(0).includes('secured') && pills(0).includes('ordered'), 'Set 1: secured + ordered'); assert.ok(pills(1).includes('secured') && !pills(1).includes('ordered'), 'Set 2: secured, not ordered'); assert.ok(!pills(2).includes('ordered'));
  const head = p.text(p.q('.itemsec > div > div:last-child')); assert.match(head, /3 sets/); assert.match(head, /1 secured/); assert.match(head, /1 ordered/); p.close();
});

test('A SET MOVES BACK AND FORTH BY ITS CLAIMS\' STAGES: order the other secured set and it joins Ordered; move a claim back and it returns to Secured', async () => {
  const { title, sets, claims } = await setup(); for (const id of claims(1)) await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'arrived at proxy / warehouse' });
  let p = await open(title); await chip(p, 'Ordered'); assert.deepEqual(rows(p).sort(), [String(sets[0].id), String(sets[1].id)].sort(), 'a later stage counts as ordered'); await chip(p, 'Secured'); assert.equal(rows(p).length, 0); p.close();
  await api('PATCH', `/api/admin/claims/${claims(0)[0]}`, { pipeline: 'awaiting fulfillment' }); p = await open(title); await chip(p, 'Secured'); assert.deepEqual(rows(p), [String(sets[0].id)], 'back to Secured because one claim is not ordered any more'); p.close();
});
