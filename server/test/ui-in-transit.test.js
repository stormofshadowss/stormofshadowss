import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage } from './ui.helpers.js';

// JOINER DASHBOARD: an "In transit" card — parcels shipped to them, and their items on the way to the GOM (names only, grouped by group order). Nothing is shown when nothing is travelling.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'ut') => `${x}${++N}`;
const order = async (title) => ({ id: (await api('POST', '/api/admin/orders', { groupId: w.group, title })).json.id, title });
const item = async (go, title) => ({ id: (await api('POST', `/api/admin/orders/${go.id}/items`, { type: 'normal', title, price: 5 })).json.id, title });
async function person() { const handle = u(), cookie = await joinerSession(app, `${handle}@x.com`, handle); await api('PUT', '/api/my/address', { fullName: 'Transit Person', address: '1 Road, Leeds', email: `${handle}@x.com`, phone: '0700123456' }, cookie); return { handle, cookie }; }
const claim = async (p, it) => (await claimAndSecure(app, admin, p.handle, it.id))[0];
const enroute = (id) => api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'enroute to GOM' });
const page = async (cookie, hash = '#/') => { const pg = await openPage(app, '/my.html', { cookies: [cookie] }); await sleep(300); await pg.settle(); if (hash !== '#/') { pg.window.location.hash = hash; await sleep(200); await pg.settle(); } return pg; };
const card = (pg) => pg.q('[data-in-transit]');
async function shippedParcel(p, it) { const id = await claim(p, it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' }); const par = (await api('POST', '/api/my/parcels', { claimIds: [id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p.cookie)).json.id; await app.q("UPDATE parcels SET status = 'shipped', shipped_date = CURDATE() WHERE id = ?", [par]); return par; }

test('THE CARD, with both: "In transit" holds the parcels shipped to them (with the button) and their items on the way to the GOM, grouped by group order with counts; it sits above "What you owe"', async () => {
  const p = await person(), g1 = await order('Stray Kids order'), g2 = await order('ATE1EY order'); const album = await item(g1, 'Album'), card1 = await item(g1, 'Photocard'), poster = await item(g2, 'Poster'), sent = await item(g2, 'Sent thing');
  const par = await shippedParcel(p, sent); for (const it of [album, album, card1, poster]) await enroute(await claim(p, it)); const pg = await page(p.cookie);
  assert.ok(card(pg), 'the card'); assert.equal(pg.text(pg.q('h2', card(pg))), 'In transit'); assert.equal(pg.q('[data-parcels-card]'), null, 'it replaces the old card on the dashboard');
  assert.equal(pg.text(pg.q('[data-to-you]', card(pg))), 'Parcels on their way to you'); assert.match(pg.text(card(pg)), new RegExp(`Parcel #${par}.*Sent thing.*It's arrived — mark as received`));
  assert.equal(pg.text(pg.q('[data-to-gom]', card(pg))), 'Your items on their way to the GOM'); const rows = pg.qa('[data-transit-group]', card(pg)).map((r) => pg.text(r)); assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => /^Stray Kids order .*Album.*\(×2\).*Photocard/.test(r) && !/Poster/.test(r)), rows.join(' | ')); assert.ok(rows.some((r) => /^ATE1EY order .*Poster/.test(r) && !/\(×/.test(r)), rows.join(' | '));
  assert.ok(card(pg).compareDocumentPosition(pg.qa('.card').find((c) => /What you owe/.test(pg.text(c)))) & pg.window.Node.DOCUMENT_POSITION_FOLLOWING, 'above the money'); assert.ok(pg.q('[data-to-you]', card(pg)).compareDocumentPosition(pg.q('[data-to-gom]', card(pg))) & pg.window.Node.DOCUMENT_POSITION_FOLLOWING, 'to you first, then to the GOM'); assert.deepEqual([pg.errors], [[]]); pg.close();
});

test('EACH HALF APPEARS ON ITS OWN: only items on the way to the GOM (no parcels part, no button); only a parcel (no GOM part); nothing at all (no card)', async () => {
  const only = await person(), go = await order('Only items order'); await enroute(await claim(only, await item(go, 'Lonely item'))); const a = await page(only.cookie); assert.ok(a.q('[data-to-gom]', card(a)) && !a.q('[data-to-you]', card(a)) && !a.q('[data-act="received"]', card(a)), 'items only'); a.close();
  const par = await person(), go2 = await order('Only parcel order'); await shippedParcel(par, await item(go2, 'Posted thing')); const b = await page(par.cookie); assert.ok(b.q('[data-to-you]', card(b)) && !b.q('[data-to-gom]', card(b)), 'a parcel only'); b.close();
  const none = await person(); const c = await page(none.cookie); assert.equal(card(c), null, 'nothing travelling: no card'); c.close();
});

test('THE ONGOING ORDERS PAGE IS UNCHANGED (no In transit card there), and the card goes when the box arrives', async () => {
  const p = await person(), go = await order('Ongoing check order'); const id = await claim(p, await item(go, 'Travelling thing')); await enroute(id); const pg = await page(p.cookie, '#/ongoing'); assert.equal(card(pg), null, 'not on the Ongoing page'); assert.match(pg.text(pg.q('#view')), /Travelling thing/, 'the claim is in the list as before'); pg.close();
  await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'arrived at GOM' }); const home = await page(p.cookie); assert.equal(card(home), null, 'arrived at the GOM: no longer in transit'); home.close();
});

test('A PERSON WITH TWO HANDLES sees both together, each item tagged with its handle', async () => {
  const p = await person(), h2 = u('sec'); assert.equal((await api('POST', '/api/me/handles', { handle: h2 }, p.cookie)).status, 200); const go = await order('Two handle order'); await enroute(await claim(p, await item(go, 'First thing'))); await enroute((await claimAndSecure(app, admin, h2, (await item(go, 'Second thing')).id))[0]);
  const pg = await page(p.cookie); const row = pg.text(pg.q('[data-transit-group]', card(pg))); assert.match(row, new RegExp(`@${p.handle} · First thing`)); assert.match(row, new RegExp(`@${h2} · Second thing`)); pg.close();
});

test('THE GOM\'S READ-ONLY "VIEW AS" shows the same card', async () => {
  const p = await person(), go = await order('View as order'); await enroute(await claim(p, await item(go, 'Viewed thing'))); const acc = (await app.q('SELECT id FROM accounts WHERE email = ?', [`${p.handle}@x.com`]))[0].id;
  const pg = await openPage(app, `/my.html?viewAs=${acc}`, { cookies: [admin] }); await sleep(400); await pg.settle(); assert.ok(card(pg), 'the card'); assert.match(pg.text(card(pg)), /Your items on their way to the GOM.*View as order.*Viewed thing/); assert.deepEqual([pg.errors], [[]]); pg.close();
});
