import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { gomPage } from './ui.helpers.js';

// Group Orders: open orders in a table, everything closed (by hand, past its date, or cancelled) folded away underneath, and a search box that filters both.
let app, admin, w, N = 0;
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (o) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
const mk = async (title, extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam', ...extra })).json.id;
let ids;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  ids = { alpha: await mk('Alpha Open GO'), bravo: await mk('Bravo Open GO'), charlie: await mk('Charlie Closed GO', { status: 'closed' }), delta: await mk('Delta Late GO', { closeDate: day(-3) }), echo: await mk('Echo Cancelled GO') };
  for (const id of Object.values(ids)) await api('POST', `/api/admin/orders/${id}/items`, { type: 'normal', title: 'Thing', price: 5 });
  assert.equal((await api('POST', `/api/admin/orders/${ids.echo}/cancel`, { confirm: 'Echo Cancelled GO' })).status, 200);
  const zeta = (await api('POST', '/api/admin/groups', { name: 'Zeta Crew' })).json.id; ids.foxtrot = (await api('POST', '/api/admin/orders', { groupId: zeta, title: 'Foxtrot Pop-up', proxy: 'Yuki' })).json.id;
});
const open = async () => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); return p; };
const titles = (p, root) => p.qa('tr[data-order] td:first-child strong', root).map((x) => p.text(x));
const search = async (p, q) => { const i = p.q('#orderSearch'); i.value = q; i.dispatchEvent(new p.window.Event('input', { bubbles: true })); await sleep(40); };

test('OPEN ORDERS IN THE TABLE, EVERYTHING CLOSED FOLDED AWAY: closed by hand, past its date, and cancelled all go in "Closed" — which is folded until you open it', async () => {
  const p = await open(); const d = p.q('#closedOrders'); assert.ok(d && d.tagName === 'DETAILS'); assert.equal(d.open, false, 'folded by default');
  const openTitles = titles(p, p.q('#openOrders')), closedTitles = titles(p, d);
  for (const t of ['Alpha Open GO', 'Bravo Open GO']) assert.ok(openTitles.includes(t), `${t} is in the open table`);
  for (const t of ['Charlie Closed GO', 'Delta Late GO', 'Echo Cancelled GO']) { assert.ok(closedTitles.includes(t), `${t} is under Closed`); assert.ok(!openTitles.includes(t)); }
  assert.match(p.text(p.q('summary', d)), /^Closed \(\d+\) — closed, past their closing date, or cancelled$/); assert.ok(p.q('[data-closed-by-date]', d), 'the "date passed" pill is there'); assert.ok(p.q('[data-cancelled]', d)); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('THE SEARCH BOX filters both sections as you type (any case; by title or group name); the cursor is never lost; clearing it brings everything back', async () => {
  const p = await open(); const box = p.q('#orderSearch');
  await search(p, 'BRAVO'); assert.deepEqual(titles(p, p.q('#openOrders')), ['Bravo Open GO']); assert.equal(p.q('#orderSearch'), box, 'the same box — the page was not rebuilt, so the cursor stays');
  assert.match(p.text(p.q('#closedOrders summary')), /, 0 match\)/); assert.equal(p.q('#closedOrders').open, false, 'nothing closed matches, so it stays folded');
  await search(p, 'zeta'); assert.deepEqual(titles(p, p.q('#openOrders')), ['Foxtrot Pop-up'], 'by group name'); await search(p, 'sam'); assert.ok(titles(p, p.q('#openOrders')).includes('Alpha Open GO'), 'by proxy too');
  await search(p, ''); assert.ok(['Alpha Open GO', 'Bravo Open GO', 'Foxtrot Pop-up'].every((t) => titles(p, p.q('#openOrders')).includes(t))); assert.doesNotMatch(p.text(p.q('#closedOrders summary')), /match/); p.close();
});

test('A SEARCH THAT MATCHES A CLOSED ORDER UNFOLDS THE CLOSED SECTION for you, showing only the matches; "no open match" is said plainly', async () => {
  const p = await open(); await search(p, 'charlie'); const d = p.q('#closedOrders'); assert.equal(d.open, true, 'unfolded automatically');
  assert.deepEqual(titles(p, d), ['Charlie Closed GO']); assert.match(p.text(p.q('summary', d)), /, 1 match\)/); assert.match(p.text(p.q('#openOrders')), /No open group orders match “charlie”\./);
  await search(p, 'late'); assert.deepEqual(titles(p, p.q('#closedOrders')), ['Delta Late GO']); await search(p, 'zzzz-nothing'); assert.match(p.text(p.q('#openOrders')), /No open group orders match “zzzz-nothing”\./); assert.match(p.text(p.q('#closedOrders')), /No closed group orders match “zzzz-nothing”\./); p.close();
});

test('THE CLOSED SECTION STAYS AS YOU LEFT IT: unfold it, press Items on another order (the page redraws) — it is still unfolded', async () => {
  const p = await open(); p.q('#closedOrders').open = true; await p.click(p.q(`[data-act="open-items"][data-id="${ids.alpha}"]`)); await sleep(60); await p.settle();
  assert.equal(p.q('#closedOrders').open, true, 'still unfolded'); p.q('#closedOrders').open = false; await p.click(p.q(`[data-act="open-items"][data-id="${ids.bravo}"]`)); await sleep(60); await p.settle(); assert.equal(p.q('#closedOrders').open, false, 'and still folded when you folded it'); p.close();
});

test('EDITING A CLOSED ORDER opens the form right there and unfolds the section; the buttons on closed rows work (Items)', async () => {
  const p = await open(); await p.click(p.q(`[data-act="edit-order"][data-id="${ids.charlie}"]`)); await sleep(60); await p.settle();
  assert.equal(p.q('#closedOrders').open, true); assert.ok(p.q('#closedOrders form[data-form="order"], #closedOrders form'), 'the edit form is inside the Closed section');
  await p.click(p.q(`[data-act="open-items"][data-id="${ids.delta}"]`)); await sleep(60); await p.settle(); assert.match(p.text(p.q('#itemsPanel')), /Items — Delta Late GO/); p.close();
});

test('NAMES AND SEARCHES WITH HTML are shown as text', async () => {
  const weird = await mk('<img src=x onerror="window.pwned=1"> Zulu GO'); const p = await open(); assert.equal(p.q('img[src="x"]'), null); assert.equal(p.window.pwned, undefined); assert.ok(titles(p, p.q('#openOrders')).includes('<img src=x onerror="window.pwned=1"> Zulu GO'));
  await search(p, '<b>nope</b>'); assert.equal(p.q('#openOrders b'), null); assert.match(p.text(p.q('#openOrders')), /No open group orders match “<b>nope<\/b>”\./); void weird; p.close();
});
