import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { gomPage, openPage } from './ui.helpers.js';

// WAREHOUSE: the long list of items waiting to be boxed folds away (starts folded, remembered on the device) so the boxes underneath aren't pushed to the bottom. Ticks survive folding.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'wf') => `${x}${++N}`;
const KEY = 'sos_wh_items_open';
const candidates = async () => (await api('GET', '/api/admin/boxes/candidates')).json.candidates;
async function arrived(title = u('Arrived thing '), go = null) {
  const h = u('wfp'); await joinerSession(app, `${h}@x.com`, h); const g = go ?? (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Fold GO '), proxy: 'Sam' })).json.id;
  const it = (await api('POST', `/api/admin/orders/${g}/items`, { type: 'normal', title, price: 5 })).json.id; const [id] = await claimAndSecure(app, admin, h, it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'arrived at proxy / warehouse' }); return { id, g, h };
}
const open = async (stored) => { const p = await openPage(app, '/admin.html', { cookies: [admin], init: (win) => { if (stored !== undefined) win.localStorage.setItem(KEY, stored); } }); await sleep(250); await p.settle(); await p.click(p.byText('#tabs button', 'Warehouse')); await sleep(300); await p.settle(); return p; };
const toggle = (p) => p.q('#candToggle'), body = (p) => p.q('#candBody');

test('IT STARTS FOLDED: the item list is hidden behind a one-line summary; the select-all buttons, the EMS form and the boxes underneath are all still there', async () => {
  await arrived(); await arrived(); const n = (await candidates()).length; const p = await open(); assert.equal(p.text(toggle(p)), `▸ ${n} items waiting to be boxed`); assert.equal(toggle(p).getAttribute('aria-expanded'), 'false'); assert.equal(body(p).hidden, true, 'the list is hidden');
  assert.ok(p.byText('#candPicks button', `Select all ${n}`), 'the select-all buttons stay'); assert.ok(p.q('#boxEms') && p.q('#boxDue'), 'and so does the EMS form'); for (const sel of ['#candPicks', '#boxEms', '#boxDue', '#candToggle']) assert.equal(p.q(sel).closest('[hidden]'), null, `${sel} is visible (not inside anything folded away)`); const html = p.q('#tabBody, #view, body').innerHTML; assert.ok(html.indexOf('id="candToggle"') < html.indexOf('<h2 style="margin:0">Boxes</h2>'), 'the Boxes section is right below'); assert.deepEqual(p.errors, []); p.close();
});

test('THE TOGGLE OPENS AND CLOSES IT, and the choice is remembered for next time (and nothing is redrawn, so what you typed stays)', async () => {
  await arrived(); const p = await open(); await p.click(toggle(p)); assert.equal(body(p).hidden, false); assert.match(p.text(toggle(p)), /^▾ \d+ items? waiting to be boxed$/); assert.equal(toggle(p).getAttribute('aria-expanded'), 'true'); assert.equal(p.window.localStorage.getItem(KEY), '1');
  const weight = p.q('input[data-act="weight"]'); weight.value = '321'; p.q('#boxEms').value = '12'; await p.click(toggle(p)); await p.click(toggle(p)); assert.equal(weight.value, '321', 'an unsaved weight survives folding'); assert.equal(p.q('#boxEms').value, '12');
  await p.click(toggle(p)); assert.equal(body(p).hidden, true); assert.equal(p.window.localStorage.getItem(KEY), '0'); p.close();
});

test('A NEW VISIT STARTS HOW YOU LEFT IT: open if you left it open, folded if you left it folded or have never chosen', async () => {
  await arrived(); const opened = await open('1'); assert.equal(body(opened).hidden, false); assert.match(opened.text(toggle(opened)), /^▾/); opened.close(); const folded = await open('0'); assert.equal(body(folded).hidden, true); folded.close(); const fresh = await open(undefined); assert.equal(body(fresh).hidden, true, 'a device that has never chosen starts folded'); fresh.close();
});

test('TICKS SURVIVE FOLDING: "Select all" while folded shows "N ticked" in the summary, Clear removes it, and opening the list shows the ticks', async () => {
  await arrived(); await arrived(); const n = (await candidates()).length; const p = await open(); await p.click(p.byText('#candPicks button', `Select all ${n}`)); await sleep(300); await p.settle(); assert.equal(p.text(toggle(p)), `▸ ${n} items waiting to be boxed · ${n} ticked`);
  await p.click(toggle(p)); assert.ok(p.qa('input[data-act="pick"]').every((i) => i.checked), 'all ticked when opened'); await p.click(p.byText('#candPicks button', 'Clear')); await sleep(200); await p.settle(); assert.equal(p.text(toggle(p)), `▾ ${n} items waiting to be boxed`);
  await p.click(p.q('input[data-act="pick"]')); await sleep(300); await p.settle(); assert.match(p.text(toggle(p)), /· 1 ticked$/); p.close();
});

test('YOU CAN MAKE A BOX WITHOUT EVER OPENING THE LIST: pick a group order\'s items with its button, enter the EMS, create — the box appears, the summary goes back to no ticks, and it stays folded', async () => {
  const a = await arrived('Boxed thing A'), b = await arrived('Boxed thing B', a.g); void b; const p = await open(); const order = (await candidates()).find((c) => c.claimId === a.id).orderTitle; const group = (await candidates()).filter((c) => c.orderTitle === order).length;
  await p.click(p.byText('#candPicks button', `Select all in “${order}” (${group})`)); await sleep(300); await p.settle(); assert.match(p.text(toggle(p)), new RegExp(`· ${group} ticked$`)); p.q('#boxEms').value = '10'; await p.click(p.byText('button', 'Create box')); await sleep(500); await p.settle();
  assert.match(p.text(p.q('#boxMsg')), /^Box #\d+ created — 2 items marked "shipping requested"/); assert.doesNotMatch(p.text(toggle(p)), /ticked/); assert.equal(body(p).hidden, true, 'still folded'); assert.match(p.text(p.q('#tabBody, #view, body')), /Box #\d+/); p.close();
});

test('THE SUMMARY SAYS "1 item" for one; with nothing waiting there is no toggle and the "nothing waiting" message is showing', async () => {
  for (const c of await candidates()) await api('PATCH', `/api/admin/claims/${c.claimId}`, { pipeline: 'ordered via proxy / warehouse' });
  let p = await open(); assert.equal(toggle(p), null, 'no toggle when there is nothing to fold'); assert.match(p.text(body(p)), /Nothing is waiting to be boxed\./); assert.equal(body(p).hidden, false, 'the message is not hidden away'); p.close();
  await arrived(); p = await open(); assert.equal(p.text(toggle(p)), '▸ 1 item waiting to be boxed'); p.close();
});
