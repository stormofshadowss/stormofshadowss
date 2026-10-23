import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// GOM → Group Orders: closed orders show "✓ all completed" when every claim is completed; Archive tucks them (and cancelled orders) into a folded Archived list; the pickers elsewhere stop offering them.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'ua') => `${x}${++N}`;
const mk = async (title, { claims = [], closed = true, cancelled = false, setItem = false } = {}) => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam' })).json.id; const it = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title: u('Thing ') })).json.id;
  if (setItem) await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', price: 5, title: u('Set '), members: ['A', 'B'] });
  for (const stage of claims) { const [id] = await claimAndSecure(app, admin, u(), it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: stage }); }
  if (closed) await api('PATCH', `/api/admin/orders/${go}`, { status: 'closed' }); if (cancelled) await app.q('UPDATE group_orders SET cancelled_at = NOW() WHERE id = ?', [go]); return go;
};
const open = async () => { const p = await gomPage(app, admin); await sleep(120); await p.settle(); return p; };
const inClosed = (p, go) => p.q(`#closedOrders [data-order="${go}"]`), inArchived = (p, go) => p.q(`#archivedOrders [data-order="${go}"]`);
const settle = async (p, ms = 350) => { await sleep(ms); await p.settle(); };

test('A CLOSED ORDER WITH EVERY CLAIM COMPLETED IS MARKED "✓ all completed"; every closed order (even cancelled) has an Archive button; an open order has neither', async () => {
  const done = await mk(u('Done GO '), { claims: ['completed', 'completed'] }), half = await mk(u('Half GO '), { claims: ['completed', 'ready to pack / on hand'] }), canc = await mk(u('Cancelled GO '), { cancelled: true }), op = await mk(u('Open GO '), { closed: false, claims: ['completed'] });
  const p = await open(); await p.click(p.q('#closedOrders summary')); assert.ok(p.q('[data-ready-archive]', inClosed(p, done)), 'ready'); assert.match(p.text(p.q('[data-ready-archive]', inClosed(p, done))), /^✓ all completed$/); assert.equal(p.q('[data-ready-archive]', inClosed(p, half)), null, 'not ready: one claim is not completed');
  assert.equal(p.q('[data-ready-archive]', inClosed(p, canc)), null, 'a cancelled order is marked cancelled, not "all completed"'); for (const go of [done, half, canc]) assert.ok(p.q('[data-act="archive-order"]', inClosed(p, go)), `${go} can be archived`);
  assert.equal(p.q('[data-act="archive-order"]', p.q(`#openOrders [data-order="${op}"]`)), null, 'an open order cannot'); for (const go of [done, half, canc, op]) assert.equal(inArchived(p, go), null, 'nothing has been archived yet'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('ARCHIVING A FINISHED ORDER: it leaves Closed (the count drops) and appears in a FOLDED Archived list with just Items and Unarchive; Unarchive puts it back', async () => {
  const a = await mk(u('Finish A '), { claims: ['completed'] }), b = await mk(u('Finish B '), { claims: ['completed'] }); const p = await open(); const closedN = () => Number(p.text(p.q('#closedOrders summary')).match(/Closed \((\d+)/)[1]); const before = closedN();
  await p.click(p.q('#closedOrders summary')); await p.click(p.q('[data-act="archive-order"]', inClosed(p, a))); await settle(p); assert.match(toast(p), /^Archived “Finish A \d+”\.$/); assert.equal(closedN(), before - 1, 'one fewer in Closed'); assert.equal(inClosed(p, a), null);
  const arch = p.q('#archivedOrders'); assert.ok(arch); assert.equal(arch.open, false, 'folded'); assert.match(p.text(p.q('summary', arch)), /^Archived \(1\) — finished and tucked away$/); await p.click(p.q('summary', arch)); const r = inArchived(p, a); assert.deepEqual(p.qa('button', r).map((x) => p.text(x)), ['Items (1)', 'Unarchive'], 'no Edit / Delete / Cancel on a finished order');
  await p.click(p.q('[data-act="archive-order"]', inClosed(p, b))); await settle(p); assert.equal(p.q('#archivedOrders').open, true, 'it stays unfolded while you are working in it'); assert.match(p.text(p.q('#archivedOrders summary')), /Archived \(2\)/);
  await p.click(p.q('[data-act="unarchive-order"]', inArchived(p, a))); await settle(p); assert.match(toast(p), /^“Finish A \d+” is back in Closed\.$/); assert.ok(inClosed(p, a)); assert.equal(inArchived(p, a), null); assert.match(p.text(p.q('#archivedOrders summary')), /Archived \(1\)/); p.close();
});

test('TOO EARLY: Archive says plainly what isn\'t completed (in a message you dismiss), and the order stays where it is; a cancelled order can always be archived', async () => {
  const half = await mk(u('Early GO '), { claims: ['completed', 'ready to pack / on hand', 'awaiting fulfillment'] }), canc = await mk(u('Cancelled again '), { claims: [], cancelled: true }); const p = await open(); await p.click(p.q('#closedOrders summary'));
  await p.click(p.q('[data-act="archive-order"]', inClosed(p, half))); await settle(p, 250); assert.match(p.text(modal(p)), /^Can't archive “Early GO \d+” yet — 2 claims aren't completed: .+ — 1 × awaiting fulfillment; .+ — 1 × ready to pack \/ on hand\./s); await press(p, 'OK'); await settle(p, 150);
  assert.ok(inClosed(p, half), 'still in Closed'); assert.equal(inArchived(p, half), null, 'and not archived'); await p.click(p.q('[data-act="archive-order"]', inClosed(p, canc))); await settle(p); assert.match(toast(p), /^Archived “Cancelled again \d+”\.$/); await p.click(p.q('#archivedOrders summary')); assert.ok(inArchived(p, canc), 'the cancelled one went in'); p.close();
});

test('THE SEARCH COVERS ARCHIVED ORDERS: a match unfolds the Archived list, showing only matches and "N match"; no match says so; clearing it folds it again', async () => {
  const x = await mk(u('Zebra tour '), { claims: ['completed'] }), y = await mk(u('Yak fansign '), { claims: ['completed'] }); const p = await open(); await p.click(p.q('#closedOrders summary')); await p.click(p.q('[data-act="archive-order"]', inClosed(p, x))); await settle(p); await p.click(p.q('[data-act="archive-order"]', inClosed(p, y))); await settle(p);
  const search = async (v) => { const i = p.q('#orderSearch'); i.value = v; i.dispatchEvent(new p.window.Event('input', { bubbles: true })); await sleep(120); await p.settle(); };
  await search('zebra'); assert.equal(p.q('#archivedOrders').open, true, 'a match unfolds it'); assert.match(p.text(p.q('#archivedOrders summary')), /Archived \(\d+, 1 match\)/); assert.ok(inArchived(p, x)); assert.equal(inArchived(p, y), null);
  await search('nothing-like-this'); assert.match(p.text(p.q('#archivedOrders')), /No archived group orders match “nothing-like-this”\./); await search(''); assert.match(p.text(p.q('#archivedOrders summary')), /^Archived \(\d+\) — finished and tucked away$/, 'cleared: back to the plain count (it stays as unfolded as you left it, like Closed does)'); assert.ok(inArchived(p, x) && inArchived(p, y), 'and everything is listed again'); p.close();
});

test('ARCHIVED ORDERS DISAPPEAR FROM THE PICKERS ELSEWHERE (Claims: the order filter and Add a claim; Sets: the order filter) and return when un-archived', async () => {
  const go = await mk(u('Picker order '), { claims: ['completed'], setItem: true }); const live = await mk(u('Live picker '), { claims: [], closed: false, setItem: true });
  const options = async (tab, sel) => { const p = await open(); await p.click(p.byText('#tabs button', tab)); await settle(p, 250); if (tab === 'Claims' && sel === 'add') { await p.click(p.q('[data-act="add-open"]')); await settle(p, 150); } const s = p.q(sel === 'add' ? '#addClaim select[name="orderId"]' : '[data-filter="order"]'); const out = [...s.options].map((o) => Number(o.value)).filter(Boolean); p.close(); return out; };
  assert.ok((await options('Claims', 'filter')).includes(go), 'before: offered'); assert.ok((await options('Claims', 'add')).includes(go)); assert.ok((await options('Sets', 'filter')).includes(go));
  await api('POST', `/api/admin/orders/${go}/archive`, {}); for (const [tab, sel] of [['Claims', 'filter'], ['Claims', 'add'], ['Sets', 'filter']]) { const o = await options(tab, sel); assert.ok(!o.includes(go), `${tab} ${sel}: archived is not offered`); if (tab === 'Claims' && sel === 'add') assert.ok(o.includes(live), 'but live orders are'); }
  await api('POST', `/api/admin/orders/${go}/unarchive`, {}); assert.ok((await options('Claims', 'filter')).includes(go), 'back after un-archiving'); assert.ok((await options('Sets', 'filter')).includes(go));
});

test('TITLES WITH HTML ARE SHOWN AS TEXT (the Archived list, the Archive message)', async () => {
  const done = await mk('<img src=x onerror="window.pwned=1"> Done <b>GO</b>', { claims: ['completed'] }), half = await mk('<i>Half</i> <img src=x onerror="window.pwned=2"> GO', { claims: ['ready to pack / on hand'] }); const p = await open(); await p.click(p.q('#closedOrders summary'));
  await p.click(p.q('[data-act="archive-order"]', inClosed(p, half))); await settle(p, 250); assert.match(p.text(modal(p)), /<i>Half<\/i> <img src=x onerror="window\.pwned=2"> GO/); assert.equal(p.q('.modal img, [role="dialog"] img'), null); await press(p, 'OK'); await settle(p, 150);
  await p.click(p.q('[data-act="archive-order"]', inClosed(p, done))); await settle(p); await p.click(p.q('#archivedOrders summary')); assert.equal(p.q('#archivedOrders img[src="x"]'), null); assert.equal(p.q('#archivedOrders b'), null); assert.equal(p.window.pwned, undefined); assert.ok(p.text(p.q('#archivedOrders')).includes('Done <b>GO</b>'), 'the title is shown exactly as typed, as text'); p.close();
});
