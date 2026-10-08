import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

let app, admin, w, N = 0, ITEM;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const add = (body) => app.api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', ...body }, admin).then((r) => r.json.id);
  ITEM = { album: await add({ title: 'Album', price: 20, sizeBucket: 'M' }), hoodie: await add({ title: 'Hoodie', price: 50, sizeBucket: 'L' }), card: await add({ title: 'Photocard', price: 4, sizeBucket: 'XS' }) };
});
after(async () => { await app.stop(); });

const api = (m, p, b) => app.api(m, p, b, admin);
const text = (p, sel = '#tabBody') => p.text(p.q(sel));
const fresh = (x = 'wh') => `${x}${++N}`;
async function arrived(handle, item = ITEM.album) {
  const [id] = await claimAndSecure(app, admin, handle, item);
  await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'arrived at proxy / warehouse' });
  return id;
}
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Warehouse')); return p; };
const tick = (p, id) => p.click(p.q(`input[data-act="pick"][data-id="${id}"]`));
const claim1 = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims[0];
const boxCard = (p, id) => p.q(`[data-box="${id}"]`);

test('with nothing waiting, the tab explains what makes items appear, and there are no boxes yet', async () => {
  const p = await open();
  assert.match(text(p), /Nothing is waiting to be boxed.*arrived at proxy \/ warehouse/);
  assert.match(text(p), /No boxes yet — create one above/);
  p.close();
});

test('items that have arrived at the proxy are listed with size, weight and price, and the tab badge counts them', async () => {
  const [a, b] = [fresh(), fresh()];
  const ia = await arrived(a, ITEM.album), ib = await arrived(b, ITEM.hoodie);
  await claimAndSecure(app, admin, fresh('notyet'), ITEM.album);                              // not arrived: must not appear
  const p = await open();
  assert.equal(p.qa('tr[data-cand]').length, 2);
  const row = p.q(`tr[data-cand="${ia}"]`);
  assert.match(p.text(row), new RegExp(`@${a}.*Album.*£20\\.00`));
  assert.equal(p.q('select', row).value, 'M'); assert.equal(p.q('input[data-act="weight"]', row).value, '');
  assert.equal(p.q('#tabs [data-tab="warehouse"] .badge').textContent, '2');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  assert.ok(ib);
  p.close();
});

test('the split preview follows your selection and the figures you type — weights, estimates, shares and the explanation', async () => {
  const [a, b] = [fresh('pv'), fresh('pv')];
  const ia = await arrived(a, ITEM.album), ib = await arrived(b, ITEM.hoodie);
  const p = await open();
  assert.match(text(p, '#boxPreview'), /Select at least one item above to see the split/);
  await tick(p, ia); await tick(p, ib);
  await p.type(p.q('#boxEms'), '8'); await p.type(p.q('#boxCustoms'), '7');
  await p.settle();
  let t = text(p, '#boxPreview');
  assert.match(t, new RegExp(`@${a}.*Album.*175g \\(est\\.\\).*£2\\.55.*£2\\.00`), 'M ≈ 175g, L ≈ 375g: EMS 8 split 175:375; customs 7 split 20:50');
  assert.match(t, new RegExp(`@${b}.*Hoodie.*375g \\(est\\.\\).*£5\\.45.*£5\\.00`));
  assert.match(t, /No box weight entered — using size estimates/);
  await p.type(p.q('#boxWeight'), '1000'); await p.settle();
  assert.match(text(p, '#boxPreview'), /Box weighs 1000g — the other 1000g is shared across 2 items by size\./);
  assert.match(text(p, '#boxPreview'), /Album.*318g/, 'the real box weight spreads the estimates: 1000 × 175/550');
  // an exact weight for one item is saved straight away and used
  await p.choose(p.q(`input[data-act="weight"][data-id="${ia}"]`), '600'); await p.settle();
  t = text(p, '#boxPreview');
  assert.match(t, /Album.*600g(?! \(est)/); assert.match(t, /Hoodie.*400g \(est\.\)/);
  assert.match(t, /Box weighs 1000g; 600g comes from items with exact weights, so the other 400g is shared across 1 item by size/);
  assert.equal((await api('GET', '/api/admin/boxes/candidates')).json.candidates.find((c) => c.claimId === ia).weightG, 600);
  await p.choose(p.q(`select[data-act="size"][data-id="${ib}"]`), 'XL'); await p.settle();
  assert.equal((await api('GET', '/api/admin/boxes/candidates')).json.candidates.find((c) => c.claimId === ib).size, 'XL');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('creating a box: mistakes are explained; success moves the items, adds their costs, clears the form, and shows the box', async () => {
  const [a, b] = [fresh('cb'), fresh('cb')];
  const ia = await arrived(a, ITEM.album), ib = await arrived(b, ITEM.hoodie);
  const p = await open();
  await p.click(p.byText('button', 'Create box'));
  assert.match(text(p, '#boxMsg'), /Select at least one item first/);
  await tick(p, ia); await tick(p, ib);
  await p.click(p.byText('button', 'Create box'));
  assert.match(text(p, '#boxMsg'), /Enter an EMS total — that's what creates the box/);
  await p.type(p.q('#boxEms'), '8'); await p.type(p.q('#boxCustoms'), '7'); await p.type(p.q('#boxTracking'), 'EE111GB');
  await p.click(p.byText('button', 'Create box'));
  assert.match(text(p, '#boxMsg'), /Box #\d+ created — 2 items marked "shipping requested" and their EMS\/customs added/);
  const [ca, cb] = [await claim1(a), await claim1(b)];
  assert.deepEqual([ca.pipeline, cb.pipeline], ['shipping requested', 'shipping requested']);
  assert.equal(Math.round((ca.costs.ems.cost + cb.costs.ems.cost) * 100) / 100, 8); assert.equal(Math.round((ca.costs.customs.cost + cb.costs.customs.cost) * 100) / 100, 7);
  assert.equal(p.q('#boxEms').value, ''); assert.equal(p.q('#boxTracking').value, '');
  assert.equal(p.q(`tr[data-cand="${ia}"]`), null, 'no longer waiting to be boxed');
  const card = text(p, '[data-box]');
  assert.match(card, new RegExp(`Box #\\d+.*Shipping requested.*@${a} — Album.*@${b} — Hoodie.*EMS total: £8\\.00.*Customs total: £7\\.00`));
  assert.ok(p.q('[data-box] input[data-track]').value === 'EE111GB');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('a box goes en route, then arrives; once arrived, you tick what is fine — the rest stay "checking parcel" — and a finished box is archived', async () => {
  const [a, b] = [fresh('lc'), fresh('lc')];
  const ia = await arrived(a), ib = await arrived(b);
  const box = (await api('POST', '/api/admin/boxes', { claimIds: [ia, ib], emsTotal: 6 })).json.id;
  const p = await open();
  assert.ok(p.byText('button', 'Mark en route', boxCard(p, box)) && p.byText('button', 'Undo box', boxCard(p, box)));
  await p.click(p.byText('button', 'Mark en route', boxCard(p, box)));
  assert.match(text(p, `[data-box="${box}"]`), /En route to GOM/);
  assert.equal((await claim1(a)).pipeline, 'enroute to GOM');
  assert.equal(p.q('input[data-ready]'), null, 'no checklist until it has arrived');
  await p.click(p.byText('button', 'Mark arrived', boxCard(p, box)));
  assert.match(text(p, `[data-box="${box}"]`), /Arrived at GOM.*Mark ready to pack.*Untick anything that isn't actually fine/s);
  assert.equal(p.byText('button', 'Undo box', boxCard(p, box)), undefined, "an arrived box can't be undone");
  assert.equal(p.qa(`input[data-ready="${box}"]:checked`).length, 2, 'everything starts ticked');
  await p.click(p.q(`input[data-ready="${box}"][data-claim="${ib}"]`));                          // b has a problem
  await p.click(p.byText('button', 'Save ready-to-pack selections', boxCard(p, box)));
  assert.match(toast(p), /Saved/);
  assert.match(text(p, `[data-box="${box}"]`), new RegExp(`@${a} — Album Ready to pack.*@${b} — Album Checking parcel`));
  assert.deepEqual([(await claim1(a)).pipeline, (await claim1(b)).pipeline], ['ready to pack / on hand', 'checking parcel']);
  assert.equal(p.q('details'), null, 'still active while something is being checked');
  await p.click(p.q(`input[data-ready="${box}"][data-claim="${ib}"]`));                          // problem sorted
  await p.click(p.byText('button', 'Save ready-to-pack selections', boxCard(p, box)));
  assert.match(text(p, 'details summary'), /Archived boxes \(1\)/);
  assert.ok(p.q(`details [data-box="${box}"]`), 'the finished box moved into the archive');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('customs added later: needs a figure, asks first, shares it by value, and can be updated', async () => {
  const [a, b] = [fresh('cu'), fresh('cu')];
  const ia = await arrived(a, ITEM.album), ib = await arrived(b, ITEM.hoodie);
  const box = (await api('POST', '/api/admin/boxes', { claimIds: [ia, ib], emsTotal: 4 })).json.id;
  const p = await open();
  assert.match(text(p, `[data-box="${box}"]`), /Customs: not added yet/);
  await p.click(p.byText('button', 'Apply customs split', boxCard(p, box)));
  assert.match(text(p, '.ui-modal'), /Enter a customs total first/); await press(p, 'OK');
  await p.type(p.q(`input[data-customs="${box}"]`), '7');
  await p.click(p.byText('button', 'Apply customs split', boxCard(p, box)));
  assert.match(text(p, '.ui-modal'), /Set the customs total for box #\d+ to £7\.00\?.*shared across the items by their value.*difference back as credit/s);
  await press(p, 'Cancel');
  assert.equal((await claim1(a)).costs.customs.cost, 0, 'cancelling did nothing');
  await p.click(p.byText('button', 'Apply customs split', boxCard(p, box))); await press(p, 'Apply customs');
  assert.match(toast(p), /Customs applied/);
  assert.deepEqual([(await claim1(a)).costs.customs.cost, (await claim1(b)).costs.customs.cost], [2, 5]);
  assert.match(text(p, `[data-box="${box}"]`), /Customs total: £7\.00/);
  assert.ok(p.byText('button', 'Update customs split', boxCard(p, box)), 'now offers to update it');
  p.close();
});

test('undoing a box: asks first, explains the money, and puts the items back to be boxed again', async () => {
  const h = fresh('un'); const id = await arrived(h);
  const box = (await api('POST', '/api/admin/boxes', { claimIds: [id], emsTotal: 5 })).json.id;
  const p = await open();
  await p.click(p.byText('button', 'Undo box', boxCard(p, box)));
  assert.match(text(p, '.ui-modal'), new RegExp(`Undo box #${box}\\?.*go back to "arrived at proxy / warehouse".*already paid towards them is returned to each person as credit.*box record is deleted`, 's'));
  await press(p, 'Keep it');
  assert.ok(boxCard(p, box)); assert.equal((await claim1(h)).costs.ems.cost, 5);
  await p.click(p.byText('button', 'Undo box', boxCard(p, box))); await press(p, 'Undo the box');
  assert.match(toast(p), new RegExp(`Box #${box} undone`));
  assert.equal(boxCard(p, box), null);
  assert.ok(p.q(`tr[data-cand="${id}"]`), 'waiting to be boxed again');
  assert.deepEqual([(await claim1(h)).costs.ems.cost, (await claim1(h)).pipeline], [0, 'arrived at proxy / warehouse']);
  p.close();
});

test('tracking can be saved, and boxes searched by person or tracking', async () => {
  const [a, b] = [fresh('tr'), fresh('tr')];
  const boxA = (await api('POST', '/api/admin/boxes', { claimIds: [await arrived(a)], emsTotal: 3 })).json.id;
  const boxB = (await api('POST', '/api/admin/boxes', { claimIds: [await arrived(b)], emsTotal: 3 })).json.id;
  const p = await open();
  await p.type(p.q(`input[data-track="${boxA}"]`), 'ZZ-TRACK-1');
  await p.click(p.byText('button', 'Save', boxCard(p, boxA)));
  assert.match(toast(p), /Tracking saved/);
  assert.equal(p.q(`input[data-track="${boxA}"]`).value, 'ZZ-TRACK-1');
  await p.type(p.q('#boxSearch'), 'zz-track'); await new Promise((r) => setTimeout(r, 300)); await p.settle();
  assert.ok(boxCard(p, boxA)); assert.equal(boxCard(p, boxB), null);
  await p.type(p.q('#boxSearch'), b); await new Promise((r) => setTimeout(r, 300)); await p.settle();
  assert.ok(boxCard(p, boxB)); assert.equal(boxCard(p, boxA), null);
  await p.type(p.q('#boxSearch'), 'nothing-like-this'); await new Promise((r) => setTimeout(r, 300)); await p.settle();
  assert.match(text(p), /No boxes match that search/);
  p.close();
});

test('names with HTML in them are shown as text', async () => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: 'XSS GO' })).json.id;
  const item = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: '<img src=x onerror="window.pwned=1"> thing', price: 5 })).json.id;
  const id = await arrived('xss_wh', item);
  const p = await open();
  assert.equal(p.q('#tabBody img'), null);
  assert.match(text(p, `tr[data-cand="${id}"]`), /<img src=x onerror="window\.pwned=1"> thing/);
  await tick(p, id); await p.type(p.q('#boxEms'), '2'); await p.settle();
  assert.equal(p.q('#boxPreview img'), null);
  assert.equal(p.window.pwned, undefined);
  p.close();
});
