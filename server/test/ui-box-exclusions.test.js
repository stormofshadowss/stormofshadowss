import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage, toast } from './ui.helpers.js';

// GOM: "No EMS" / "No customs" ticks — on an item (Add / Edit form, shown as small labels in the items list) and for one box in the Warehouse (starting from the item's ticks, with the preview saying "not charged").
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'ub') => `${x}${++N}`;
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: `NoEms UI GO ${++N}`, proxy: 'Sam' })).json.id;
const item = async (go, title, price, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price, title, ...extra })).json.id;
const adminItem = async (go, id) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === id);
const itemsPage = async (go) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`)); await sleep(80); await p.settle(); return p; };
const row = (p, id) => p.q(`[data-act="edit-item"][data-id="${id}"]`).closest('tr');
async function arrived(itemId, weight = 100) { const h = u('p'); const [id] = await claimAndSecure(app, admin, h, itemId); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'arrived at proxy / warehouse', weightG: weight }); return { id, h }; }
const warehouse = async () => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', 'Warehouse')); await sleep(300); await p.settle(); if (p.q('[data-act="toggle-cands"]') && p.q('#candBody').hidden) await p.click(p.q('[data-act="toggle-cands"]')); return p; };
const tickOf = (p, claimId, kind) => p.q(`tr[data-cand="${claimId}"] input[data-act="${kind}"]`);

test('THE ITEM FORMS HAVE "NO EMS WHEN BOXED" AND "NO CUSTOMS WHEN BOXED" (off by default); they are saved, shown as small labels in the items list, and can be changed later', async () => {
  const go = await goOrder(); const p = await itemsPage(go); const f = p.q('form[data-form="new-item"]'); assert.deepEqual([f.elements.noEms.checked, f.elements.noCustoms.checked], [false, false]); assert.match(p.text(f.elements.noEms.closest('[data-box-ticks]')), /^No EMS when boxed\s*No customs when boxed\s*For things like free bonus cards: when this goes in a box it carries no share of the EMS or customs/);
  f.elements.title.value = 'Bonus card'; f.elements.price.value = '0'; f.elements.noEms.checked = true; f.elements.noCustoms.checked = true; await p.submit(f); await sleep(400); await p.settle(); const made = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.title === 'Bonus card'); assert.deepEqual([made.noEms, made.noCustoms], [true, true]);
  assert.equal(p.text(p.q('[data-no-ems]', row(p, made.id))), 'no EMS'); assert.equal(p.text(p.q('[data-no-customs]', row(p, made.id))), 'no customs');
  const f2 = p.q('form[data-form="new-item"]'); f2.elements.title.value = 'Album'; f2.elements.price.value = '20'; await p.submit(f2); await sleep(400); await p.settle(); const album = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.title === 'Album'); assert.equal(p.q('[data-no-ems]', row(p, album.id)), null, 'an ordinary item has no label');
  await p.click(p.q(`[data-act="edit-item"][data-id="${made.id}"]`)); const e = p.q('form[data-form="edit-item"]'); assert.deepEqual([e.elements.noEms.checked, e.elements.noCustoms.checked], [true, true], 'the edit form shows what is set'); e.elements.noEms.checked = false; await p.submit(e); await sleep(400); await p.settle();
  assert.deepEqual([(await adminItem(go, made.id)).noEms, (await adminItem(go, made.id)).noCustoms], [false, true]); assert.equal(p.q('[data-no-ems]', row(p, made.id)), null); assert.ok(p.q('[data-no-customs]', row(p, made.id))); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('WAREHOUSE — NEW BOX: each item has "No EMS" / "No customs" ticks starting from its own; changing one is for THIS box and the preview says "not charged" and re-shares the rest', async () => {
  const go = await goOrder(); const bonus = await item(go, 'Free card', 0, { noEms: true, noCustoms: true }), a = await item(go, 'Album A', 10), b = await item(go, 'Album B', 30); const A = await arrived(bonus, 50), B = await arrived(a, 100), C = await arrived(b, 300);
  const p = await warehouse(); assert.match(p.text(p.q('#candBody thead')), /Not charged/); assert.deepEqual([tickOf(p, A.id, 'noems').checked, tickOf(p, A.id, 'nocustoms').checked, tickOf(p, B.id, 'noems').checked], [true, true, false], 'starts from the item\'s own ticks');
  for (const c of [A, B, C]) await p.click(p.q(`tr[data-cand="${c.id}"] input[data-act="pick"]`)); await p.type(p.q('#boxEms'), '10'); await p.type(p.q('#boxCustoms'), '4'); await sleep(400); await p.settle();
  const cells = () => p.qa('#boxPreview tbody tr').map((r) => p.qa('td', r).slice(3).map((td) => p.text(td))); assert.deepEqual(cells(), [['not charged', 'not charged'], ['£2.50', '£1.00'], ['£7.50', '£3.00']]);
  await p.click(tickOf(p, A.id, 'noems')); await sleep(400); await p.settle(); assert.equal(cells()[0][0].startsWith('£'), true, 'turned off for this box: it carries EMS'); assert.equal(cells()[0][1], 'not charged');
  await p.click(tickOf(p, C.id, 'nocustoms')); await sleep(400); await p.settle(); assert.deepEqual(cells().map((r) => r[1]), ['not charged', '£4.00', 'not charged'], 'the cheaper album now carries all the customs');
  p.close();
});

test('YOUR CHOICES FOR A BOX SURVIVE A RELOAD OF THE LIST (e.g. entering a weight), are used when the box is created, and the box shows who carries nothing', async () => {
  const go = await goOrder(); const bonus = await item(go, 'Free card', 0, { noEms: true, noCustoms: true }), a = await item(go, 'Album', 20); const A = await arrived(bonus, 50), B = await arrived(a, 150);
  const p = await warehouse(); for (const c of [A, B]) await p.click(p.q(`tr[data-cand="${c.id}"] input[data-act="pick"]`)); await p.click(tickOf(p, B.id, 'nocustoms')); await sleep(200);
  const wt = p.q(`tr[data-cand="${B.id}"] input[data-act="weight"]`); wt.value = '160'; wt.dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(600); await p.settle(); assert.equal(tickOf(p, B.id, 'nocustoms').checked, true, 'still ticked after the list reloaded'); assert.equal(tickOf(p, A.id, 'noems').checked, true);
  await p.type(p.q('#boxEms'), '5'); await sleep(300); await p.click(p.q('[data-act="create"]')); await sleep(600); await p.settle(); assert.match(p.text(p.q('#boxMsg')), /^Box #\d+ created/);
  const box = (await api('GET', '/api/admin/boxes')).json.boxes[0]; assert.deepEqual(box.items.map((i) => [i.emsShare, i.emsExcluded, i.customsExcluded]), [[0, true, true], [5, false, true]]);
  const card = p.q(`[data-box="${box.id}"]`); assert.equal(p.qa('[data-no-ems]', card).length, 1); assert.equal(p.qa('[data-no-customs]', card).length, 2); p.close();
});

test('NOBODY LEFT TO CARRY THE EMS: the preview says so plainly and the box is not created', async () => {
  const go = await goOrder(); const a = await item(go, 'Free A', 0, { noEms: true }), b = await item(go, 'Free B', 0, { noEms: true }); const A = await arrived(a), B = await arrived(b);
  const p = await warehouse(); for (const c of [A, B]) await p.click(p.q(`tr[data-cand="${c.id}"] input[data-act="pick"]`)); await p.type(p.q('#boxEms'), '5'); await sleep(400); await p.settle(); assert.match(p.text(p.q('#boxPreview')), /^Every item in this box is set to carry no EMS — untick at least one/);
  await p.click(p.q('[data-act="create"]')); await sleep(400); assert.match(p.text(p.q('#boxMsg')), /^Every item in this box is set to carry no EMS/); assert.equal((await app.q('SELECT COUNT(*) AS n FROM box_items WHERE claim_id IN (?)', [[A.id, B.id]]))[0].n, 0); p.close();
});
