import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage, gomPage, toast } from './ui.helpers.js';

// JOINER: on a shipping request that isn't packed yet, "Add more items" lists their other ready items; ticking and pressing the button adds them. GOM: the parcel is marked in Packing when items were added after the
// postage was set ("Postage is fine" or saving the fees again clears it), and each added item is tagged "added later".
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'ua') => `${x}${++N}`;
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const READY = 'ready to pack / on hand';
async function person() { const h = u('pa'); const cookie = await joinerSession(app, `${h}@x.com`, h); await api('PUT', '/api/my/address', { fullName: 'Add Person', address: '12 Test Street, Leeds, LS1 1AA', email: `${h}@x.com`, phone: '07700 900123' }, cookie); const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Add UI GO '), proxy: 'Sam' })).json.id; return { h, cookie, go }; }
async function ready(p, title = u('Thing '), price = 5) { const it = (await api('POST', `/api/admin/orders/${p.go}/items`, { type: 'normal', title, price })).json.id; const [id] = await claimAndSecure(app, admin, p.h, it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); return id; }
const request = async (p, ids) => { const r = await api('POST', `/api/my/parcels?handle=${p.h}`, { claimIds: ids, method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p.cookie); assert.equal(r.status, 201, r.text); return r.json.id; };
const page = async (p, cookie = p.cookie) => { const pg = await openPage(app, '/my.html', { cookies: [cookie] }); await sleep(300); await pg.settle(); pg.window.location.hash = '#/ship'; await sleep(120); await pg.settle(); return pg; };
const card = (pg, id) => pg.q(`[data-parcel="${id}"]`);
const addForm = (pg, id) => pg.q('form[data-form="add-items"]', card(pg, id));
const labels = (pg, id) => pg.qa('label.chk', addForm(pg, id)).map((l) => pg.text(l));

test('THE REQUEST OFFERS "ADD MORE ITEMS": it lists the person\'s OTHER ready items (not the ones already in the parcel); ticking one and pressing the button adds it, and the request now shows it', async () => {
  const p = await person(); const a = await ready(p, 'Already in'); const parcel = await request(p, [a]); await ready(p, 'Arrived later'); await ready(p, 'Also arrived');
  const pg = await page(p); assert.ok(addForm(pg, parcel), 'the form is there'); assert.match(pg.text(addForm(pg, parcel).querySelector('label')), /^More items ready\? Add them to this request — until the GOM packs it:$/);
  assert.deepEqual(labels(pg, parcel).map((t) => t.replace(/\s+Add UI GO.*$/, '')), ['Arrived later', 'Also arrived'], 'only the items not in the parcel'); assert.equal(pg.q('[data-add-fees-note]', card(pg, parcel)), null, 'no fee note when no fees are set');
  pg.qa('input[name="claim"]', addForm(pg, parcel))[0].checked = true; await pg.submit(addForm(pg, parcel)); await sleep(450); await pg.settle(); assert.equal(toast(pg), `Added 1 item to Parcel #${parcel}.`);
  assert.match(pg.text(card(pg, parcel)), /Already in, Arrived later/, 'the request now lists it'); assert.deepEqual(labels(pg, parcel).map((t) => t.replace(/\s+Add UI GO.*$/, '')), ['Also arrived'], 'and it is no longer offered'); assert.deepEqual([pg.errors], [[]]); pg.close();
});

test('NOTHING TICKED IS SAID PLAINLY; a server refusal (the item is no longer ready) is shown in the form and nothing is added', async () => {
  const p = await person(); const a = await ready(p); const parcel = await request(p, [a]); const b = await ready(p); const pg = await page(p);
  await pg.submit(addForm(pg, parcel)); await sleep(150); assert.match(pg.text(pg.q('[data-msg]', addForm(pg, parcel))), /^Tick the items you want to add\.$/);
  await api('PATCH', `/api/admin/claims/${b}`, { pipeline: 'awaiting fulfillment' }); pg.qa('input[name="claim"]', addForm(pg, parcel))[0].checked = true; await pg.submit(addForm(pg, parcel)); await sleep(400); await pg.settle();
  assert.match(pg.text(pg.q('[data-msg]', addForm(pg, parcel))), /Only items that are ready to ship can be requested/); assert.equal(pg.q('[data-add-submit]', addForm(pg, parcel)).disabled, false, 'the button is usable again'); assert.equal((await app.q('SELECT COUNT(*) AS n FROM parcel_items WHERE parcel_id = ?', [parcel]))[0].n, 1); pg.close();
});

test('WHEN POSTAGE IS ALREADY SET the form says it will be shared out again; a shared parcel adds "and everyone sharing it"', async () => {
  const p = await person(); const a = await ready(p); const parcel = await request(p, [a]); await ready(p); await api('POST', `/api/admin/parcels/${parcel}/fees`, { doms: 6, dueDate: day(9) });
  let pg = await page(p); assert.match(pg.text(pg.q('[data-add-fees-note]', card(pg, parcel))), /^Postage and packaging are already set for this parcel\. They'll be shared out again across all the items, so what you owe on each item may change\.$/); pg.close();
  const q = await person(), friend = await person(); const qa = await ready(q), fi = await ready(friend); const shared = await request(q, [qa]); assert.equal((await api('POST', `/api/my/parcels/${shared}/companion/invite`, { handles: friend.h }, q.cookie)).status, 201); assert.equal((await api('POST', `/api/my/parcels/${shared}/companion/accept`, { claimIds: [fi] }, friend.cookie)).status, 200);
  await ready(q); await api('POST', `/api/admin/parcels/${shared}/fees`, { doms: 6, dueDate: day(9) }); pg = await page(q); assert.match(pg.text(pg.q('[data-add-fees-note]', card(pg, shared))), /shared out again across all the items \(and everyone sharing it\), so what you owe/); pg.close();
});

test('IT IS NOT OFFERED when the parcel is already packed, when nothing else is ready, or to a friend who is only sharing it', async () => {
  const p = await person(); const a = await ready(p); const parcel = await request(p, [a]); let pg = await page(p); assert.equal(addForm(pg, parcel), null, 'nothing else is ready: no form'); pg.close();
  const b = await ready(p); pg = await page(p); assert.ok(addForm(pg, parcel)); pg.close(); await app.q("UPDATE parcels SET status = 'packed' WHERE id = ?", [parcel]); pg = await page(p); assert.equal(addForm(pg, parcel), null, 'packed: no form'); pg.close(); void b;
  const q = await person(), friend = await person(); const qa = await ready(q); const shared = await request(q, [qa]); const fi = await ready(friend); assert.equal((await api('POST', `/api/my/parcels/${shared}/companion/invite`, { handles: friend.h }, q.cookie)).status, 201); assert.equal((await api('POST', `/api/my/parcels/${shared}/companion/accept`, { claimIds: [fi] }, friend.cookie)).status, 200);
  await ready(friend); await ready(q); const fp = await page(friend); assert.equal(addForm(fp, shared), null, 'the friend cannot add to it'); fp.close(); const qp = await page(q); assert.ok(addForm(qp, shared), 'the person it is posted to can'); qp.close();
});

test('ITEM NAMES WITH HTML ARE SHOWN AS TEXT in the form', async () => {
  const p = await person(); const a = await ready(p); const parcel = await request(p, [a]); await ready(p, '<img src=x onerror="window.pwned=1"> <b>Bold</b>'); const pg = await page(p);
  assert.equal(pg.q('img[src="x"]', card(pg, parcel)), null); assert.equal(pg.window.pwned, undefined); assert.ok(labels(pg, parcel)[0].includes('<img src=x onerror="window.pwned=1"> <b>Bold</b>')); pg.close();
});

test('GOM — PACKING: a parcel with items added AFTER the postage was set is marked (with the totals), each added item is tagged "added later"; "Postage is fine" clears it; saving the fees again also clears it', async () => {
  const p = await person(); const a = await ready(p, 'First item'); const parcel = await request(p, [a]); await api('POST', `/api/admin/parcels/${parcel}/fees`, { doms: 6, packaging: 2, dueDate: day(9) }); const b = await ready(p, 'Second item'); assert.equal((await api('POST', `/api/my/parcels/${parcel}/items`, { claimIds: [b] }, p.cookie)).status, 201);
  const g = await gomPage(app, admin); await g.click(g.byText('#tabs button', 'Packing')); await sleep(350); await g.settle(); const c = () => g.q(`[data-parcel="${parcel}"]`);
  const banner = g.q('[data-fees-check]', c()); assert.ok(banner); assert.match(g.text(banner), /^Items were added after the postage was set\. The same totals \(postage £6\.00 · packaging £2\.00\) were shared out again across all the items\. Check they still cover the parcel — change them below, or Postage is fine$/);
  const tags = g.qa('[data-added-later]', c()); assert.equal(tags.length >= 1, true); assert.match(g.text(tags[0].closest('[data-item-row]') || tags[0].parentElement), /Second item/); assert.ok(!g.text(c()).match(/First item[^]*?added later[^]*?Second item/), 'only the added item is tagged');
  await g.click(g.byText('button', 'Postage is fine', c())); await sleep(350); await g.settle(); assert.equal(toast(g), 'Okay — marked as checked.'); assert.equal(g.q('[data-fees-check]', c()), null); assert.equal((await app.q('SELECT fees_check_needed AS f FROM parcels WHERE id = ?', [parcel]))[0].f, 0);
  const c2 = await ready(p, 'Third item'); await api('POST', `/api/my/parcels/${parcel}/items`, { claimIds: [c2] }, p.cookie); await g.click(g.byText('#tabs button', 'Warehouse')); await g.click(g.byText('#tabs button', 'Packing')); await sleep(350); await g.settle(); assert.ok(g.q('[data-fees-check]', c()), 'flagged again');
  const form = g.q('form[data-form="fees"]', c()); form.elements.dueDate.value = day(9); await g.submit(form); await sleep(400); await g.settle(); assert.equal(g.q('[data-fees-check]', c()), null, 're-saving the fees clears it'); g.close();
});

test('GOM — NO MARKER WHEN NO FEES WERE SET YET (nothing to check), but the added item is still tagged', async () => {
  const p = await person(); const a = await ready(p); const parcel = await request(p, [a]); const b = await ready(p, 'Added early'); await api('POST', `/api/my/parcels/${parcel}/items`, { claimIds: [b] }, p.cookie);
  const g = await gomPage(app, admin); await g.click(g.byText('#tabs button', 'Packing')); await sleep(350); await g.settle(); const c = g.q(`[data-parcel="${parcel}"]`); assert.equal(g.q('[data-fees-check]', c), null); assert.equal(g.qa('[data-added-later]', c).length, 1); g.close();
});
