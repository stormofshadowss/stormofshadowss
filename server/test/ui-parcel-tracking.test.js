import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure, tickParcel } from './helpers.js';
import { openPage, gomPage, toast, modal } from './ui.helpers.js';

// Tracking numbers: the GOM's Packing screen (enter when marking shipped, edit / copy / remove after, search) and what the joiner sees on their shipping page.
let app, admin, w, N = 0, ITEM;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); ITEM = (await app.api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: 'Tracked thing', price: 6 }, admin)).json.id; });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const person = async () => { const h = `tku${++N}`, cookie = await joinerSession(app, `${h}@x.com`, h); await api('PUT', '/api/my/address', { fullName: 'Tr P', address: '12 Test Street, Leeds, LS1 1AA', email: `${h}@x.com`, phone: '07700 900123' }, cookie); return { h, cookie }; };
const ready = async (p) => { const [id] = await claimAndSecure(app, admin, p.h, ITEM); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' }); return id; };
const request = async (p, method = 'UK Royal Mail Tracked 48') => { const r = await api('POST', `/api/my/parcels?handle=${p.h}`, { claimIds: [await ready(p)], method, ...(method.startsWith('WW') ? { declaredValue: 'true' } : {}), addressConfirmed: true }, p.cookie); assert.equal(r.status, 201, r.text); return r.json.id; };
const packed = async (p, method) => { const id = await request(p, method); await tickParcel(app, admin, id); assert.equal((await api('POST', `/api/admin/parcels/${id}/packed`, {})).status, 200); return id; };
const dbNo = async (id) => (await app.q('SELECT tracking_no AS t, status FROM parcels WHERE id = ?', [id]))[0];
const packing = async (tab) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', 'Packing')); await sleep(300); await p.settle(); if (tab) { await p.click(p.q(`[data-act="status"][data-status="${tab}"]`)); await sleep(150); await p.settle(); } return p; };
const card = (p, id) => p.q(`[data-parcel="${id}"]`);
const input = (p, id) => p.q(`[data-track-input="${id}"]`);
const done = async (p) => { await sleep(450); await p.settle(); };
const joinerPage = async (p) => { const pg = await openPage(app, '/my.html', { cookies: [p.cookie] }); await sleep(300); await pg.settle(); pg.window.location.hash = '#/ship'; await sleep(120); await pg.settle(); return pg; };

test('MARK SHIPPED WITH A TRACKING NUMBER: a packed parcel has an optional Tracking box next to Mark shipped (no Save yet); the number goes with the button; without one it just ships', async () => {
  const p = await person(), q = await person(); const a = await packed(p), b = await packed(q); const g = await packing('packed');
  assert.equal(input(g, a).placeholder, 'Tracking number (optional)'); assert.equal(card(g, a).querySelector('[data-act="track-save"]'), null, 'nothing to save separately yet'); assert.ok(card(g, a).querySelector('[data-act="shipped"]'));
  input(g, a).value = ' TRK 1234 5678 '; await g.click(card(g, a).querySelector('[data-act="shipped"]')); await done(g); assert.equal(toast(g), 'Marked shipped, tracking saved.'); assert.deepEqual(await dbNo(a), { t: 'TRK 1234 5678', status: 'shipped' });
  await g.click(card(g, b).querySelector('[data-act="shipped"]')); await done(g); assert.equal(toast(g), 'Marked shipped.'); assert.deepEqual(await dbNo(b), { t: null, status: 'shipped' });
  input(g, a) ?? null; await g.click(g.q('[data-act="status"][data-status="shipped"]')); await sleep(150); await g.settle();
  assert.equal(input(g, a).value, 'TRK 1234 5678', 'shown on the Shipped list'); const link = card(g, a).querySelector('a[href^="https://www.royalmail.com/"]'); assert.equal(link.getAttribute('href'), 'https://www.royalmail.com/track-your-item#/tracking-results/TRK12345678'); assert.deepEqual([link.target, link.rel], ['_blank', 'noopener noreferrer']);
  assert.equal(input(g, b).value, ''); assert.equal(input(g, b).placeholder, 'Not added yet'); assert.equal(card(g, b).querySelector('[data-act="track-copy"]'), null, 'nothing to copy'); assert.equal(card(g, b).querySelector('a[href^="https://www.royalmail"]'), null, 'and no link'); assert.deepEqual(g.errors, []); g.close();
});

test('ADD, FIX, COPY AND REMOVE IT FROM THE SHIPPED LIST; a bad number is explained and changes nothing; another carrier gets the number but no link', async () => {
  const p = await person(), q = await person(); const a = await packed(p), w2 = await packed(q, 'WW Tracked'); for (const id of [a, w2]) assert.equal((await api('POST', `/api/admin/parcels/${id}/shipped`, {})).status, 200);
  const g = await packing('shipped'); input(g, a).value = 'JD 0123 4567'; await g.click(card(g, a).querySelector('[data-act="track-save"]')); await done(g); assert.equal(toast(g), 'Tracking saved.'); assert.equal((await dbNo(a)).t, 'JD 0123 4567'); assert.equal(input(g, a).value, 'JD 0123 4567'); assert.ok(card(g, a).querySelector('[data-act="track-copy"]'), 'Copy appears');
  await g.click(card(g, a).querySelector('[data-act="track-copy"]')); await sleep(80); assert.match(g.text(modal(g)), /Tracking number:\s*JD 0123 4567/, 'with no clipboard it shows the number to copy'); g.q('.ui-modal button').click(); await sleep(50);
  input(g, a).value = 'ab'; await g.click(card(g, a).querySelector('[data-act="track-save"]')); await done(g); assert.match(toast(g), /tracking number is letters, numbers, spaces and dashes/); assert.equal((await dbNo(a)).t, 'JD 0123 4567', 'unchanged');
  input(g, a).value = ''; await g.click(card(g, a).querySelector('[data-act="track-save"]')); await done(g); assert.equal(toast(g), 'Tracking removed.'); assert.equal((await dbNo(a)).t, null); assert.equal(card(g, a).querySelector('[data-act="track-copy"]'), null, 'nothing left to copy');
  input(g, w2).value = 'WW 9999 0000 UK'; await g.click(card(g, w2).querySelector('[data-act="track-save"]')); await done(g); assert.equal((await dbNo(w2)).t, 'WW 9999 0000 UK'); assert.ok(card(g, w2).querySelector('[data-act="track-copy"]')); assert.equal(card(g, w2).querySelector('a[target="_blank"]'), null, 'worldwide tracked: the number but no link (the carrier isn\'t known)'); assert.deepEqual(g.errors, []); g.close();
});

test('THE SEARCH BOX finds a parcel by tracking number or person across every status (even from another tab), says so, says when nothing matches, keeps the cursor, and clearing it returns to the tab', async () => {
  const p = await person(); const shipped = await packed(p); await api('POST', `/api/admin/parcels/${shipped}/shipped`, { trackingNo: 'FIND ME 4242' }); const queued = await request(p); const g = await packing();                // on the Queue tab
  const type = async (v) => { const b = g.q('#packSearch'); b.value = v; b.dispatchEvent(new g.window.Event('input', { bubbles: true })); await sleep(700); await g.settle(); };
  assert.ok(card(g, queued) && !card(g, shipped), 'the Queue tab shows only the queued one'); await type('4242'); assert.ok(card(g, shipped), 'found the shipped one from the Queue tab'); assert.equal(card(g, queued), null); assert.match(g.text(g.q('[data-search-note]')), /^Every parcel matching your search, whatever its status\.$/);
  assert.equal(g.window.document.activeElement?.id, 'packSearch', 'the cursor stays in the box'); assert.equal(g.q('#packSearch').value, '4242'); await type(p.h); assert.ok(card(g, shipped) && card(g, queued), 'by person: both their parcels');
  await type('nothing-like-this'); assert.ok(g.qa('p.muted').some((e) => g.text(e) === 'No parcel matches that.'), 'says nothing matches'); assert.equal(g.qa('[data-parcel]').length, 0); await type(''); assert.equal(g.q('[data-search-note]'), null); assert.ok(card(g, queued) && !card(g, shipped), 'cleared: back to the Queue tab'); assert.deepEqual(g.errors, []); g.close();
});

test('THE JOINER SEES IT ON THEIR SHIPPING PAGE once it is shipped — the number, Copy and (Royal Mail only) a Track it link; not while only packed; nothing for a parcel with no number', async () => {
  const p = await person(), none = await person(), ww = await person(); const a = await packed(p), early = await packed(none), c = await packed(ww, 'WW Tracked');
  await api('PATCH', `/api/admin/parcels/${early}/tracking`, { trackingNo: 'EARLY 12345' }); let pg = await joinerPage(none); assert.equal(pg.q('[data-tracking]'), null, 'packed: typed by the GOM but not shown yet'); pg.close();
  await api('POST', `/api/admin/parcels/${a}/shipped`, { trackingNo: 'AB 1234 5678 GB' }); await api('POST', `/api/admin/parcels/${c}/shipped`, { trackingNo: 'WWTRACK 7777' }); await api('POST', `/api/admin/parcels/${early}/shipped`, {}); await api('PATCH', `/api/admin/parcels/${early}/tracking`, { trackingNo: '' });
  pg = await joinerPage(p); const t = pg.q(`[data-parcel="${a}"] [data-tracking]`); assert.equal(pg.text(t), 'Tracking: AB 1234 5678 GB Copy Track it ↗'); const link = t.querySelector('a'); assert.equal(link.getAttribute('href'), 'https://www.royalmail.com/track-your-item#/tracking-results/AB12345678GB'); assert.deepEqual([link.target, link.rel], ['_blank', 'noopener noreferrer']);
  await pg.click(t.querySelector('[data-act="copy-tracking"]')); await sleep(80); assert.match(toast(pg), /^Tracking number( copied\.|: AB 1234 5678 GB)$/); assert.deepEqual(pg.errors, []); pg.close();
  pg = await joinerPage(ww); const w3 = pg.q(`[data-parcel="${c}"] [data-tracking]`); assert.equal(pg.text(w3), 'Tracking: WWTRACK 7777 Copy', 'another carrier: the number and Copy, no link'); assert.equal(w3.querySelector('a'), null); pg.close();
  pg = await joinerPage(none); assert.equal(pg.q('[data-tracking]'), null, 'shipped with no number: nothing is shown'); pg.close();
});
