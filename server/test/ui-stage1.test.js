import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage, gomPage, toast } from './ui.helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'u1') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p, sel) => p.text(p.q(sel));
const order = async (title, extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, ...extra })).json.id;
const item = async (go, title, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price: 5, ...extra })).json.id;
const tab = async (name) => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', name)); await sleep(60); await p.settle(); return p; };
const btn = (p, re, root) => p.qa('button', root).find((b) => re.test(p.text(b)));

test('CLAIMS TAB: one button selects every confirmed claim shown (requested ones are not selectable); narrow by group order first to select just that order; it toggles', async () => {
  const [ga, gb] = [await order('Select GO A'), await order('Select GO B')];
  const [ia, ib] = [await item(ga, 'Sel item A'), await item(gb, 'Sel item B')];
  for (const [it, n] of [[ia, 2], [ib, 1]]) for (let i = 0; i < n; i++) await claimAndSecure(app, admin, u('sel'), it);
  await app.api('POST', '/api/claims', { handle: u('req'), lines: [{ itemId: ia }] });          // an unconfirmed request: not selectable
  const p = await tab('Claims');
  const all = () => p.q('[data-act="pick-all"]');
  assert.match(p.text(all()), /^Select all \d+ confirmed claims? shown$/);
  const total = Number(/all (\d+)/.exec(p.text(all()))[1]); assert.ok(total >= 3);
  await p.choose(p.q('[data-filter="order"]'), String(ga)); await sleep(80); await p.settle();
  assert.equal(p.text(all()), 'Select all 2 confirmed claims shown', 'just that group order (the request is not counted)');
  await p.click(all());
  assert.match(text(p, '#bulkBar'), /2 claims selected/); assert.equal(p.text(all()), 'Unselect all 2 confirmed claims shown');
  await p.click(all()); assert.equal(p.q('#bulkBar'), null, 'toggled back off'); assert.equal(p.text(all()), 'Select all 2 confirmed claims shown');
  await p.choose(p.q('[data-filter="order"]'), String(gb)); await sleep(80); await p.settle();
  assert.equal(p.text(all()), 'Select all 1 confirmed claim shown');
  assert.deepEqual([p.errors], [[]]); p.close();
});

test('WAREHOUSE TAB: select all, select all in one group order, or clear — the boxes tick to match', async () => {
  const [ga, gb] = [await order('Wh GO A'), await order('Wh GO B')];
  const ids = [];
  for (const [go, n] of [[ga, 2], [gb, 1]]) { const it = await item(go, `Wh item ${go}`); for (let i = 0; i < n; i++) { const [id] = await claimAndSecure(app, admin, u('wh'), it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'arrived at proxy / warehouse' }); ids.push(id); } }
  const p = await tab('Warehouse');
  const ticked = () => p.qa('input[data-act="pick"]').filter((x) => x.checked).length;
  assert.ok(btn(p, /^Select all \d+$/, p.q('#candPicks')) && btn(p, /^Clear$/, p.q('#candPicks')));
  assert.ok(p.qa('#candPicks [data-act="cand-order"]').map((b) => p.text(b)).includes('Select all in “Wh GO A” (2)'));
  await p.click(p.q('#candPicks [data-act="cand-order"][data-order="Wh GO A"]')); assert.equal(ticked(), 2, 'just that order\'s items');
  await p.click(p.q('#candPicks [data-act="cand-order"][data-order="Wh GO B"]')); assert.equal(ticked(), 3, 'adding the other order\'s');
  await p.click(p.q('#candPicks [data-act="cand-none"]')); assert.equal(ticked(), 0);
  await p.click(btn(p, /^Select all \d+$/, p.q('#candPicks'))); assert.equal(ticked(), p.qa('input[data-act="pick"]').length, 'everything');
  assert.deepEqual(p.errors, []); p.close();
});

test('PACKING LIST: a thumbnail beside items that have a picture; tap it to open the picture under that item, tap again to close; ticking is unaffected; the address is not on the list', async () => {
  const go = await order('Pack pics GO'); const withPic = await item(go, 'Pictured thing'), plain = await item(go, 'Plain thing');
  const png = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#c63' } }).png().toBuffer();
  assert.equal((await fetch(`${app.base}/api/admin/images/item/${withPic}`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: png })).status, 200);
  const h = u('pkp'); const cookie = await joinerSession(app, `${h}@x.com`, h);
  await api('PUT', '/api/my/address', { fullName: 'Pic Pack', address: '1 Road, Leeds', email: `${h}@x.com`, phone: '0700123456' }, cookie);
  const ids = []; for (const it of [withPic, plain]) { const [id] = await claimAndSecure(app, admin, h, it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' }); ids.push(id); }
  const par = (await api('POST', '/api/my/parcels', { claimIds: ids, method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, cookie)).json.id;
  const p = await tab('Packing'); const card = () => p.q(`[data-parcel="${par}"]`);
  const rows = () => p.qa('[data-item-row]', card());
  assert.equal(rows().length, 2);
  const thumbs = p.qa('[data-act="pic"]', card()); assert.equal(thumbs.length, 1, 'only the item with a picture has one');
  assert.ok(rows().find((r) => /Pictured thing/.test(p.text(r))).contains(thumbs[0]));
  assert.doesNotMatch(p.text(p.q('[data-checklist]', card())), /Delivery address checked/);
  const count = () => p.text(p.q('[data-count]', card()));
  const before = count();
  await p.click(thumbs[0]);
  const big = p.q('[data-pic-open] img', card()); assert.ok(big); assert.match(big.getAttribute('src'), /^\/uploads\//);
  assert.equal(thumbs[0].closest('[data-item-row]').nextElementSibling, big.parentElement, 'it opens directly under that item');
  assert.equal(count(), before, 'looking at a picture does not tick the item');
  await p.click(p.q('[data-act="pic"]', card())); assert.equal(p.q('[data-pic-open]', card()), null, 'tap again closes it');
  assert.deepEqual(p.errors, []); p.close();
});

test('MY ORDERS: parcels on their way are a card at the TOP (home page and Ongoing page), with the "It\'s arrived" button — not buried at the bottom; no card when nothing is on its way', async () => {
  const h = u('par'); const cookie = await joinerSession(app, `${h}@x.com`, h);
  await api('PUT', '/api/my/address', { fullName: 'Par Cel', address: '1 Road, Leeds', email: `${h}@x.com`, phone: '0700123456' }, cookie);
  const go = await order('Parcel card GO'); const it = await item(go, 'Parcel thing');
  const open = await openPage(app, '/my.html', { cookies: [cookie] }); await sleep(60); await open.settle();
  assert.equal(open.q('[data-parcels-card]'), null, 'nothing on its way: no card'); open.close();
  const [id] = await claimAndSecure(app, admin, h, it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' });
  const par = (await api('POST', '/api/my/parcels', { claimIds: [id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, cookie)).json.id;
  await app.q("UPDATE parcels SET status = 'shipped', shipped_date = CURDATE() WHERE id = ?", [par]);
  const p = await openPage(app, '/my.html', { cookies: [cookie] }); await sleep(80); await p.settle();
  const card = p.q('[data-parcels-card]'); assert.ok(card, 'the card is on the home page');
  assert.match(p.text(card), /Parcels on their way.*Parcel thing.*It's arrived/s);
  assert.match(card.getAttribute('style'), /border:2px solid var\(--accent\)/, 'it stands out');
  const owe = p.qa('.card').find((c) => /What you owe/.test(p.text(c)));
  if (owe) assert.ok(card.compareDocumentPosition(owe) & p.window.Node.DOCUMENT_POSITION_FOLLOWING, 'above the money, not below it');
  p.window.location.hash = '#/ongoing'; await sleep(60); await p.settle();
  const cards = p.qa('#view > .card'); assert.ok(cards[0].matches('[data-parcels-card]'), 'first thing on the Ongoing page');
  assert.equal(p.qa('[data-parcels-card]').length, 1);
  p.window.location.hash = '#/completed'; await sleep(60); await p.settle(); assert.equal(p.q('[data-parcels-card]'), null, 'not on the completed page');
  assert.deepEqual(p.errors, []); p.close();
});

test('PROXY TAB: a "Your proxies" card with a "this is me" tick — ticking it removes that proxy\'s orders from the to-pay list straight away', async () => {
  const me = `Zed Me ${++N}`; const go = await order('Mine GO', { proxy: me }); const it = await item(go, 'My own thing');
  await claimAndSecure(app, admin, u('pm'), it);
  const p = await tab('Proxy');
  assert.match(text(p, '#proxyMe'), new RegExp(`Your proxies.*Tick any proxy that is you.*${me} — this is me`, 's'));
  assert.match(text(p, '#tabBody'), /My own thing/, 'listed to be paid for, to begin with');
  await p.click(p.qa('#proxyMe label').find((l) => l.textContent.includes(me)).querySelector('input'));
  await sleep(80); await p.settle();
  assert.match(toast(p), /Marked as you — its orders are left out/);
  assert.ok(p.qa('#proxyMe label').find((l) => l.textContent.includes(me)).querySelector('input').checked, 'the tick stays after the tab redraws');
  assert.doesNotMatch(text(p, '#tabBody'), /My own thing/, 'and its order is gone from the to-pay list');
  assert.deepEqual(p.errors, []); p.close();
});
