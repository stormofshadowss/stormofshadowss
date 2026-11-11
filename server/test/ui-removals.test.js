import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// GOM → Packing / Warehouse: take one item out of a requested shipping list or an incoming box. Pick where it goes back to, see exactly what changes, then confirm.
let app, admin, w, N = 0, ITEM;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  ITEM = (await app.api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: 'Album for removals', price: 20, sizeBucket: 'M' }, admin)).json.id;
});
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fresh = (x = 'ur') => `${x}${++N}`;
const ARRIVED = 'arrived at proxy / warehouse', READY = 'ready to pack / on hand';
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const claimRow = async (id) => (await app.q('SELECT pipeline, box_id AS boxId FROM claims WHERE id = ?', [id]))[0];
const person = async (h = fresh('pp')) => { const cookie = await joinerSession(app, `${h}@x.com`, h); await api('PUT', '/api/my/address', { fullName: 'Ui Person', address: '12 Test Street, Leeds, LS1 1AA', email: `${h}@x.com`, phone: '07700 900123' }, cookie); return { h, cookie }; };
const label = async (id) => (await app.q('SELECT label FROM claims WHERE id = ?', [id]))[0].label;
async function ready(p) { const [id] = await claimAndSecure(app, admin, p.h, ITEM); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); return id; }
const request = async (p, claimIds) => { const r = await api('POST', `/api/my/parcels?handle=${p.h}`, { claimIds, method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p.cookie); assert.equal(r.status, 201, r.text); return r.json.id; };
const arrived = async (h) => { const [id] = await claimAndSecure(app, admin, h, ITEM); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: ARRIVED }); return id; };
const tab = async (name) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', name)); await sleep(300); await p.settle(); return p; };
const text = (p) => p.text(modal(p));
const afterClick = async (p) => { await sleep(350); await p.settle(); };

test('PACKING: "Remove…" on an item in a requested list: pick where it goes back to, review what changes (nothing changes yet), then take it out — it leaves the list and goes to the stage you picked', async () => {
  const pe = await person(); const [x, y] = [await ready(pe), await ready(pe)]; const parcel = await request(pe, [x, y]); await api('POST', `/api/admin/parcels/${parcel}/fees`, { doms: 6, packaging: 2, dueDate: day(9) }); const lbl = await label(y);
  const p = await tab('Packing'); const row = () => p.q(`[data-item-row="${y}"]`); assert.ok(row().querySelector('[data-act="item-remove"]'), 'each item has a Remove… button'); await p.click(row().querySelector('[data-act="item-remove"]'));
  assert.match(text(p), new RegExp(`^Take “${lbl}” \\(@${pe.h}\\) out of this shipping request\\? Where should it go back to\\?`)); const sel = p.q('.ui-pick select'); assert.deepEqual([...sel.options].map((o) => o.textContent), ['Arrived at the proxy / warehouse', 'Ordered via proxy / warehouse', 'Awaiting fulfillment', 'Arrived at the GOM', 'Checking parcel', 'Keep as ready to pack (it IS on hand)']); assert.equal(sel.value, ARRIVED, 'the usual choice is already picked');
  await p.choose(sel, 'ordered via proxy / warehouse'); await press(p, 'Review…'); await afterClick(p); const review = text(p);
  assert.match(review, new RegExp(`“${lbl}” \\(@${pe.h}\\) goes back to “Ordered via proxy / warehouse”\\.`)); assert.match(review, /Postage and packaging \(if set\) are shared out again across the 1 item left — the totals stay the same\./); assert.match(review, /No email is sent — you will need to tell them yourself\.Not yetTake it out$/);
  assert.equal((await claimRow(y)).pipeline, READY, 'reviewing changed nothing'); await press(p, 'Not yet'); await sleep(100); assert.equal((await claimRow(y)).pipeline, READY, 'Not yet: still in the request'); assert.ok(row());
  await p.click(row().querySelector('[data-act="item-remove"]')); await p.choose(p.q('.ui-pick select'), 'ordered via proxy / warehouse'); await press(p, 'Review…'); await afterClick(p); await press(p, 'Take it out'); await afterClick(p);
  assert.equal(toast(p), `Took “${lbl}” out.`); assert.equal((await claimRow(y)).pipeline, 'ordered via proxy / warehouse'); assert.equal(p.q(`[data-item-row="${y}"]`), null, 'gone from the list'); assert.ok(p.q(`[data-item-row="${x}"]`), 'the other item is still there'); assert.deepEqual(p.errors, []); p.close();
});

test('PACKING: the only item says the whole request goes; a friend\'s last item says who leaves the parcel and what changes for whom (what they had paid goes back as credit); Cancel and Esc do nothing', async () => {
  const solo = await person(); const s1 = await ready(solo); const sp = await request(solo, [s1]); const p = await tab('Packing');
  await p.click(p.q(`[data-item-row="${s1}"] [data-act="item-remove"]`)); await press(p, 'Cancel'); await sleep(100); assert.equal(p.q('.ui-modal'), null); assert.equal((await claimRow(s1)).pipeline, READY, 'Cancel does nothing');
  await p.click(p.q(`[data-item-row="${s1}"] [data-act="item-remove"]`)); p.window.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(100); assert.equal(p.q('.ui-modal'), null, 'Esc closes it');
  await p.click(p.q(`[data-item-row="${s1}"] [data-act="item-remove"]`)); await press(p, 'Review…'); await afterClick(p); assert.match(text(p), /It is the only item, so the whole request is removed \(its postage and packaging come off\)\./); await press(p, 'Take it out'); await afterClick(p);
  assert.match(toast(p), /^Took “.+” out — and the request, as it was the only item\.$/); assert.equal((await app.q('SELECT COUNT(*) AS n FROM parcels WHERE id = ?', [sp]))[0].n, 0); p.close();
  const owner = await person(), friend = await person(); const [o1, o2, f1] = [await ready(owner), await ready(owner), await ready(friend)]; const parcel = await request(owner, [o1, o2]);
  await api('POST', `/api/my/parcels/${parcel}/companion/invite`, { handles: friend.h }, owner.cookie); await api('POST', `/api/my/parcels/${parcel}/companion/accept`, { claimIds: [f1] }, friend.cookie); await api('POST', `/api/admin/parcels/${parcel}/fees`, { doms: 10, packaging: 0, dueDate: day(9) });
  await api('PATCH', `/api/admin/claims/${f1}`, { costs: { initials: { paid: 20 }, doms: { paid: 5 } } }); const q = await tab('Packing'); await q.click(q.q(`[data-item-row="${f1}"] [data-act="item-remove"]`)); await press(q, 'Review…'); await afterClick(q); const t = text(q);
  assert.match(t, new RegExp(`@${friend.h} has no items left, so they leave the parcel\\.`)); assert.match(t, new RegExp(`• @${friend.h}: −£5\\.00 — the £5\\.00 they had paid goes back to them as credit`)); assert.match(t, new RegExp(`• @${owner.h}: \\+£5\\.00`)); await press(q, 'Take it out'); await afterClick(q);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM parcel_companions WHERE parcel_id = ?', [parcel]))[0].n, 0); q.close();
});

test('PACKING: a refusal is explained and nothing changes (the owner\'s last item while a friend shares the parcel)', async () => {
  const owner = await person(), friend = await person(); const [o1, f1] = [await ready(owner), await ready(friend)]; const parcel = await request(owner, [o1]); await api('POST', `/api/my/parcels/${parcel}/companion/invite`, { handles: friend.h }, owner.cookie); await api('POST', `/api/my/parcels/${parcel}/companion/accept`, { claimIds: [f1] }, friend.cookie);
  const p = await tab('Packing'); await p.click(p.q(`[data-item-row="${o1}"] [data-act="item-remove"]`)); await press(p, 'Review…'); await afterClick(p); assert.match(toast(p), /That is all of @.+'s items, and the parcel is posted to their address while others share it/); assert.equal(p.q('.ui-modal'), null, 'no confirmation for something that can\'t happen'); assert.equal((await claimRow(o1)).pipeline, READY); p.close();
});

test('WAREHOUSE: a "remove" beside each item in a box: pick the stage (only the earlier ones), review, take it out — the box\'s EMS is shared out again; the last item takes the box with it', async () => {
  const [ha, hb] = [fresh(), fresh()]; const [a, b] = [await arrived(ha), await arrived(hb)]; const box = (await api('POST', '/api/admin/boxes', { claimIds: [a, b], emsTotal: 12 })).json.id; const lb = await label(b);
  const p = await tab('Warehouse'); const rm = (id) => p.q(`[data-act="box-remove"][data-claim="${id}"]`); assert.ok(rm(a) && rm(b), 'every item has a remove'); await p.click(rm(b));
  assert.match(text(p), new RegExp(`^Take “${lb}” \\(@${hb}\\) out of box #${box}\\? Where should it go back to\\?`)); const sel = p.q('.ui-pick select'); assert.deepEqual([...sel.options].map((o) => o.textContent), ['Arrived at the proxy / warehouse', 'Ordered via proxy / warehouse', 'Awaiting fulfillment'], 'only stages before it reached the GOM'); await press(p, 'Review…'); await afterClick(p);
  const review = text(p); assert.match(review, /The box's EMS and customs are shared out again across the 1 item still in it — the box totals stay the same\./); assert.match(review, new RegExp(`• @${hb}: −£6\\.00`)); assert.match(review, new RegExp(`• @${ha}: \\+£6\\.00`)); assert.equal((await claimRow(b)).boxId, box, 'reviewing changed nothing');
  await press(p, 'Take it out'); await afterClick(p); assert.equal(toast(p), `Took “${lb}” out.`); assert.deepEqual([(await claimRow(b)).pipeline, (await claimRow(b)).boxId], [ARRIVED, null]); assert.equal(rm(b), null, 'it is off the box\'s list'); assert.ok(rm(a));
  await p.click(rm(a)); await press(p, 'Review…'); await afterClick(p); assert.match(text(p), /It is the last item, so the box is removed as well\./); await press(p, 'Take it out'); await afterClick(p); assert.match(toast(p), /^Took “.+” out — and the box, as it was the last item\.$/); assert.equal((await app.q('SELECT COUNT(*) AS n FROM boxes WHERE id = ?', [box]))[0].n, 0); p.close();
});

test('WAREHOUSE: an item that is already in a shipping request is refused with the reason (take it out of the request first)', async () => {
  const pe = await person(); const [id] = await claimAndSecure(app, admin, pe.h, ITEM); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: ARRIVED }); const [other] = await claimAndSecure(app, admin, fresh(), ITEM); await api('PATCH', `/api/admin/claims/${other}`, { pipeline: ARRIVED });
  const box = (await api('POST', '/api/admin/boxes', { claimIds: [id, other], emsTotal: 8 })).json.id; await app.q('INSERT INTO parcels (joiner_id, method, status, requested_at) SELECT joiner_id, ?, ?, NOW(3) FROM claims WHERE id = ?', ['UK Royal Mail Tracked 48', 'requested', id]); const pid = (await app.q('SELECT MAX(id) AS id FROM parcels'))[0].id; await app.q('INSERT INTO parcel_items (parcel_id, claim_id) VALUES (?, ?)', [pid, id]);
  const p = await tab('Warehouse'); await p.click(p.q(`[data-act="box-remove"][data-claim="${id}"]`)); await press(p, 'Review…'); await afterClick(p); assert.match(toast(p), /is already in shipping request #\d+ — take it out of the request first/); assert.equal((await claimRow(id)).boxId, box); p.close();
});

test('PACKING: a parcel that has already been packed has no Remove… buttons (only requests still waiting can have items taken out)', async () => {
  const pe = await person(); const [x, y] = [await ready(pe), await ready(pe)]; const parcel = await request(pe, [x, y]); const p = await tab('Packing'); assert.equal(p.qa(`[data-item-row="${x}"] [data-act="item-remove"]`).length, 1, 'while it is a request it has them');
  await app.q("UPDATE parcels SET status = 'packed' WHERE id = ?", [parcel]); await p.click(p.q('[data-act="status"][data-status="packed"]')); await sleep(250); await p.settle(); assert.match(p.text(p.q('#tabBody, #view')), new RegExp(`Parcel ${parcel} —`), 'the packed parcel is shown'); assert.equal(p.qa('[data-act="item-remove"]').length, 0, 'but not with Remove… buttons'); p.close();
});
