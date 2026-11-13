import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage } from './ui.helpers.js';

// GOM → Warehouse: a box of 260 small things — Select all, enter the EMS, Create box (this used to fail with "claimIds: Array must contain at most 200 element(s)").
let app, admin, w, ids = [];
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const item = (await app.api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: 'Small card', price: 1, sizeBucket: 'XS' }, admin)).json.id;
  for (let i = 0; i < 13; i++) ids.push(...await claimAndSecure(app, admin, `bigui_${i % 4}`, item, { qty: 20 }));
  assert.equal((await app.api('POST', '/api/admin/claims/pipeline', { claimIds: ids, pipeline: 'arrived at proxy / warehouse' }, admin)).status, 200);
});
after(async () => { await app.stop(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('SELECT ALL 260, ENTER THE EMS, CREATE BOX: it works, says how many items went in, and the box has every one of them', async () => {
  const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', 'Warehouse')); await sleep(400); await p.settle();
  const all = p.q('[data-act="cand-all"]'); assert.equal(p.text(all), 'Select all 260'); await p.click(all); await sleep(300); await p.settle();
  await p.type(p.q('#boxEms'), '26'); await sleep(300); await p.settle(); await p.click(p.q('[data-act="create"]')); await sleep(1500); await p.settle();
  assert.match(p.text(p.q('#boxMsg')), /^Box #\d+ created — 260 items marked "shipping requested" and their EMS added\.$/); assert.ok(p.q('#boxMsg').classList.contains('ok'), 'shown as a success, not an error');
  const box = (await app.q('SELECT id FROM boxes ORDER BY id DESC LIMIT 1'))[0].id; assert.equal((await app.q('SELECT COUNT(*) AS n FROM box_items WHERE box_id = ?', [box]))[0].n, 260); assert.equal(Number((await app.q('SELECT COALESCE(SUM(ems_share), 0) AS s FROM box_items WHERE box_id = ?', [box]))[0].s), 26);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims WHERE box_id = ? AND pipeline = 'shipping requested'", [box]))[0].n, 260, 'every item is marked shipping requested'); assert.deepEqual(p.errors, []); p.close();
});
