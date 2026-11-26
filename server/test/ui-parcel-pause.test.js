import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage, gomPage, toast, modal, press } from './ui.helpers.js';

// JOINER: "Pause this request" / "Resume" on a shipping request that isn't packed; GOM: a "Paused" section in Packing, and a paused request can't be packed.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'up') => `${x}${++N}`;
const READY = 'ready to pack / on hand';
async function person() { const h = u('pp'); const cookie = await joinerSession(app, `${h}@x.com`, h); await api('PUT', '/api/my/address', { fullName: 'Pause Person', address: '12 Test Street, Leeds, LS1 1AA', email: `${h}@x.com`, phone: '07700 900123' }, cookie); const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Pause UI GO '), proxy: 'Sam' })).json.id; return { h, cookie, go }; }
async function ready(p, title = u('Thing ')) { const it = (await api('POST', `/api/admin/orders/${p.go}/items`, { type: 'normal', title, price: 5 })).json.id; const [id] = await claimAndSecure(app, admin, p.h, it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); return id; }
const request = async (p, ids) => { const r = await api('POST', `/api/my/parcels?handle=${p.h}`, { claimIds: ids, method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p.cookie); assert.equal(r.status, 201, r.text); return r.json.id; };
const requestOne = async (p) => request(p, [await ready(p)]);
const mine = async (p, id) => (await api('GET', '/api/my/parcels', undefined, p.cookie)).json.parcels.find((x) => x.id === id);
const shipPage = async (p, cookie = p.cookie) => { const pg = await openPage(app, '/my.html', { cookies: [cookie] }); await sleep(300); await pg.settle(); pg.window.location.hash = '#/ship'; await sleep(150); await pg.settle(); return pg; };
const card = (pg, id) => pg.q(`[data-parcel="${id}"]`);
const pill = (pg, id) => pg.text(pg.q('.pill', card(pg, id)));
const btn = (pg, id, act) => pg.q(`[data-act="${act}"][data-id="${id}"]`, card(pg, id));
const done = async (pg) => { await sleep(500); await pg.settle(); };
const pausedFor = (id, days) => app.q('UPDATE parcels SET paused_at = NOW(3) - INTERVAL ? DAY WHERE id = ?', [days, id]);

test('JOINER — PAUSE: the request offers "Pause this request"; the question says what happens; "Not yet" does nothing; "Pause it" parks it — the card says so, offers Resume, and items can still be added', async () => {
  const p = await person(); const pa = await requestOne(p); const pg = await shipPage(p); const pos = (await mine(p, pa)).queuePosition;
  assert.match(pill(pg, pa), new RegExp(`^In the queue — number ${pos}$`)); assert.ok(btn(pg, pa, 'pause'), 'the button'); assert.equal(btn(pg, pa, 'resume'), null); assert.match(pg.text(card(pg, pa)), /Waiting for more items\? Pause it and it won't be packed until you resume it\./);
  await pg.click(btn(pg, pa, 'pause')); await sleep(150); assert.match(pg.text(modal(pg)), /^Pause this request\?\s*It leaves the queue, so it won't be packed — but your items stay on it and you can still add more\. Resume it whenever you're ready: within 30 days it keeps its place in the queue, after that it goes to the end\.\s*Not yet\s*Pause it$/);
  await press(pg, 'Not yet'); await sleep(150); assert.equal((await mine(p, pa)).paused, false, '"Not yet": nothing changed'); await pg.click(btn(pg, pa, 'pause')); await sleep(150); await press(pg, 'Pause it'); await done(pg);
  assert.equal(toast(pg), 'Paused. Resume it whenever you like.'); assert.equal(pill(pg, pa), 'Paused — not in the queue'); assert.equal(btn(pg, pa, 'pause'), null, 'no Pause button now'); assert.ok(btn(pg, pa, 'resume'), 'a Resume button instead');
  assert.match(pg.text(pg.q('[data-paused-note]', card(pg, pa))), /^Paused since today — it isn't being packed\. You can still add items to it\. Resume it within 30 days to keep its place in the queue\.\s*Resume$/);
  await ready(p, 'Arrived while paused'); const again = await shipPage(p); const slot = again.q(`[data-add-parcel="${pa}"]`); assert.ok(slot && again.q('form[data-form="add-items"]', slot), 'the add-items form is still offered while paused'); assert.match(again.text(slot), /Paused — not in the queue/); assert.deepEqual([pg.errors, again.errors], [[], []]); pg.close(); again.close();
});

test('JOINER — RESUME: within 30 days it goes back to its ORIGINAL place (and says the number); after 30 days the question and the toast say it goes to the END', async () => {
  const p = await person(), q = await person(); const pa = await requestOne(p); await requestOne(q); const orig = (await mine(p, pa)).queuePosition; assert.equal((await api('POST', `/api/my/parcels/${pa}/pause`, {}, p.cookie)).status, 200);
  const pg = await shipPage(p); await pg.click(btn(pg, pa, 'resume')); await sleep(150); assert.match(pg.text(modal(pg)), /^Resume this request\?\s*It goes back to its original place in the queue\.\s*Not yet\s*Resume it$/); await press(pg, 'Resume it'); await done(pg);
  assert.equal(toast(pg), `Back in the queue — number ${orig}, its original place.`); assert.equal(pill(pg, pa), `In the queue — number ${orig}`); assert.ok(btn(pg, pa, 'pause') && !btn(pg, pa, 'resume'), 'Pause is back');
  await api('POST', `/api/my/parcels/${pa}/pause`, {}, p.cookie); await pausedFor(pa, 35); const late = await shipPage(p); assert.match(late.text(late.q('[data-paused-note]', card(late, pa))), /^Paused since 35 days ago — it isn't being packed\. You can still add items to it\. It has been paused for 30 days or more, so if you resume it now it will join the end of the queue\.\s*Resume$/);
  await late.click(btn(late, pa, 'resume')); await sleep(150); assert.match(late.text(modal(late)), /^Resume this request\?\s*It has been paused for a long time, so it will join the end of the queue\.\s*Not yet\s*Resume it$/); await press(late, 'Resume it'); await done(late);
  const last = (await api('GET', '/api/admin/packing?status=requested')).json.parcels.length; assert.equal(toast(late), `Back in the queue — number ${last}, at the end.`); assert.equal(pill(late, pa), `In the queue — number ${last}`); assert.deepEqual([pg.errors, late.errors], [[], []]); pg.close(); late.close();
});

test('A FRIEND WHO JOINED THE PARCEL sees that it is paused (and by whom) but has no Pause or Resume; a packed request has no Pause button', async () => {
  const host = await person(), friend = await person(); const pa = await requestOne(host); const jid = (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [friend.h]))[0].id; await app.q("INSERT INTO parcel_companions (parcel_id, joiner_id, status, how) VALUES (?, ?, 'accepted', 'joiner')", [pa, jid]);
  const before = await shipPage(friend); assert.equal(btn(before, pa, 'pause'), null, 'a friend can\'t pause it'); before.close(); await api('POST', `/api/my/parcels/${pa}/pause`, {}, host.cookie);
  const pg = await shipPage(friend); assert.match(pg.text(pg.q('[data-paused-note]', card(pg, pa))), new RegExp(`^@${host.h} has paused this parcel — it'll go back in the queue when they resume it\\.$`)); assert.equal(btn(pg, pa, 'resume'), null); assert.equal(btn(pg, pa, 'pause'), null); pg.close();
  const owner = await person(); const po = await requestOne(owner); await app.q("UPDATE parcels SET status = 'packed' WHERE id = ?", [po]); const op = await shipPage(owner); assert.equal(btn(op, po, 'pause'), null, 'packed: nothing to pause'); assert.equal(pill(op, po), 'Packed'); assert.deepEqual([op.errors], [[]]); op.close();
});

test('GOM PACKING: a "Paused (n)" section lists parked requests (days paused, a note), the Queue leaves them out, and "Mark packed" stays off even when every checklist box is ticked', async () => {
  const a = await person(), b = await person(); const pa = await requestOne(a), pb = await requestOne(b); await api('POST', `/api/my/parcels/${pa}/pause`, {}, a.cookie); await pausedFor(pa, 3);
  const g = await gomPage(app, admin); await sleep(100); await g.settle(); await g.click(g.byText('#tabs button', 'Packing')); await sleep(400); await g.settle(); const chips = () => g.qa('[data-act="status"]').map((c) => g.text(c));
  assert.deepEqual(chips().map((t) => t.replace(/\d+/, 'n')), ['Queue (n)', 'Paused (n)', 'Packed (n)', 'Shipped (n)', 'Received (n)'], 'five chips, Paused second'); assert.ok(g.q(`[data-parcel="${pb}"]`) && !g.q(`[data-parcel="${pa}"]`), 'the Queue has the other request, not the paused one');
  const nPaused = Number(/Paused \((\d+)\)/.exec(chips()[1])[1]); assert.ok(nPaused >= 1); await g.click(g.q('[data-act="status"][data-status="paused"]')); await sleep(300); await g.settle(); const c = g.q(`[data-parcel="${pa}"]`); assert.ok(c && !g.q(`[data-parcel="${pb}"]`), 'Paused lists only the paused one');
  assert.equal(g.text(c.querySelector('[data-paused-pill]')), 'Paused 3 days'); assert.doesNotMatch(g.text(c.querySelector('strong')), /in the queue/, 'no queue number'); assert.match(g.text(c.querySelector('[data-paused-note]')), /^Paused by the joiner — they are waiting for more items\. It is not in the queue and can't be packed until they resume it\. They can still add items\.$/);
  for (const box of c.querySelectorAll('input[data-tick]')) { if (!box.checked) { box.checked = true; box.dispatchEvent(new g.window.Event('change', { bubbles: true })); await sleep(120); } } await sleep(300); await g.settle();
  const packed = g.q(`[data-parcel="${pa}"] [data-act="packed"]`); assert.equal(packed.disabled, true, 'not enabled by ticking everything'); assert.match(g.text(g.q(`[data-parcel="${pa}"] [data-pack-hint]`)), /^This request is paused — it can't be packed until the joiner resumes it\.$/); assert.equal(g.q(`[data-parcel="${pa}"] [data-pack-hint]`).hidden, false);
  await api('POST', `/api/my/parcels/${pa}/resume`, {}, a.cookie); await g.click(g.q('[data-act="status"][data-status="paused"]')); await sleep(300); await g.settle(); assert.equal(g.q(`[data-parcel="${pa}"]`), null, 'resumed: it has left the Paused section'); await g.click(g.q('[data-act="status"][data-status="requested"]')); await sleep(300); await g.settle(); assert.ok(g.q(`[data-parcel="${pa}"]`), 'and is back in the Queue'); assert.deepEqual([g.errors, g.native], [[], 0]); g.close();
});
