import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage } from './ui.helpers.js';

// What a JOINER sees: the storage deadline on each item that is ready to pack — Ongoing orders and the Ship page. Amber within a week, red once passed; gone once the item is in a parcel.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'us') => `${x}${++N}`;
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const uk = (ymd) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
const READY = 'ready to pack / on hand';
async function person() { const h = u('js'); const cookie = await joinerSession(app, `${h}@x.com`, h); await api('PUT', '/api/my/address', { fullName: 'Store Person', address: '12 Test Street, Leeds, LS1 1AA', email: `${h}@x.com`, phone: '07700 900123' }, cookie); return { h, cookie }; }
async function addItem(p, { title, size = 'M', readyOffset = 0, pipeline = READY }) {
  p.go ??= (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Store GO '), proxy: 'Sam' })).json.id; const go = p.go;                    // one group order per person, so the Ongoing page keeps it open
  const it = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price: 5 })).json.id; const [id] = await claimAndSecure(app, admin, p.h, it);
  await api('PATCH', `/api/admin/claims/${id}`, { pipeline, sizeBucket: size }); if (pipeline === READY) await app.q('UPDATE claims SET ready_to_pack_date = ? WHERE id = ?', [day(readyOffset), id]); return id;
}
const page = async (p, hash) => { const pg = await openPage(app, '/my.html', { cookies: [p.cookie] }); await sleep(300); await pg.settle(); pg.window.location.hash = hash; await sleep(100); await pg.settle(); return pg; };
const rowOf = (pg, title) => pg.qa('.itemrow').find((r) => pg.text(r).includes(title));

test('ONGOING ORDERS: each item that is ready to pack shows its storage deadline — plain when there is time, amber within a week, red once passed; other stages show none', async () => {
  const p = await person(); await addItem(p, { title: 'Plenty of time', size: 'S', readyOffset: -5 }); await addItem(p, { title: 'Nearly up', size: 'M', readyOffset: -26 }); await addItem(p, { title: 'Too late', size: 'M', readyOffset: -40 }); await addItem(p, { title: 'Still travelling', pipeline: 'ordered via proxy / warehouse' });
  const pg = await page(p, '#/ongoing'); const note = (t) => rowOf(pg, t).querySelector('[data-storage]');
  const ok = note('Plenty of time'); assert.equal(pg.text(ok), `storage deadline ${uk(day(55))}`); assert.equal(ok.dataset.storage, 'ok'); assert.equal(ok.className, '', 'no alarm when there is time');
  const soon = note('Nearly up'); assert.equal(pg.text(soon), `storage deadline ${uk(day(4))}`); assert.equal(soon.dataset.storage, 'soon'); assert.ok(soon.classList.contains('soon-text'));
  const late = note('Too late'); assert.equal(pg.text(late), `storage deadline passed ${uk(day(-10))}`); assert.equal(late.dataset.storage, 'late'); assert.ok(late.classList.contains('late-text'));
  assert.equal(note('Still travelling'), null, 'not ready to pack: no deadline'); assert.match(late.title, /The GOM keeps items on hand until this date — please request shipping before then\./); assert.deepEqual([pg.errors], [[]]); pg.close();
});

test('IT GOES AWAY ONCE THE ITEM IS IN A PARCEL (the deadline no longer matters), and comes back if the parcel is taken apart', async () => {
  const p = await person(); const id = await addItem(p, { title: 'Going in a parcel', size: 'M', readyOffset: -20 }); await addItem(p, { title: 'Staying put', size: 'M', readyOffset: -20 });
  let pg = await page(p, '#/ongoing'); assert.ok(rowOf(pg, 'Going in a parcel').querySelector('[data-storage]'), 'before'); pg.close();
  const made = await api('POST', '/api/my/parcels', { claimIds: [id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p.cookie); assert.equal(made.status, 201, made.text);
  pg = await page(p, '#/ongoing'); const row = rowOf(pg, 'Going in a parcel'); assert.equal(row.querySelector('[data-storage]'), null, 'in a parcel: none'); assert.match(pg.text(row), /Shipping requested \(parcel #\d+\)/); assert.ok(rowOf(pg, 'Staying put').querySelector('[data-storage]'), 'the other item still has it'); pg.close();
});

test('THE SHIP PAGE shows each item\'s storage deadline next to it — and only the items that are ready are listed', async () => {
  const p = await person(); await addItem(p, { title: 'Ship me soon', size: 'M', readyOffset: -27 }); await addItem(p, { title: 'Ship me later', size: 'S', readyOffset: 0 }); await addItem(p, { title: 'Not ready yet', pipeline: 'awaiting fulfillment' });
  const pg = await page(p, '#/ship'); const labels = pg.qa('label.chk').filter((l) => l.querySelector('input[name="claim"]')); const text = labels.map((l) => pg.text(l));
  assert.equal(labels.length, 2, 'only the two ready items'); const soon = text.find((t) => t.includes('Ship me soon')), later = text.find((t) => t.includes('Ship me later'));
  assert.match(soon, new RegExp(`storage deadline ${uk(day(3))}$`)); assert.match(later, new RegExp(`storage deadline ${uk(day(60))}$`)); assert.ok(labels.find((l) => l.textContent.includes('Ship me soon')).querySelector('[data-storage="soon"].soon-text')); assert.ok(!text.some((t) => t.includes('Not ready yet'))); assert.deepEqual([pg.errors], [[]]); pg.close();
});

test('A COMPLETED ORDER SHOWS NO STORAGE DEADLINE', async () => {
  const p = await person(); await addItem(p, { title: 'All done', pipeline: 'completed' }); const pg = await page(p, '#/completed'); assert.equal(pg.q('[data-storage]'), null); pg.close();
});
