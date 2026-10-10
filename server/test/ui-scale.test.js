import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage, toast } from './ui.helpers.js';

// The admin screens when there are hundreds of claims: merged rows, stage mix, a stage strip, expand/collapse all, "Show more", a By item view — and a Payments editor that tucks itself away.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { delete process.env.CLAIMS_LIST_MAX; await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const u = (x = 'sc') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p, sel, root) => p.text(p.q(sel, root));
const READY = 'ready to pack / on hand', ORDERED = 'ordered via proxy / warehouse';
const order = async (title) => (await api('POST', '/api/admin/orders', { groupId: w.group, title })).json.id;
const item = async (go, title, price = 10) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price })).json.id;
const claim = async (handle, it, stage) => { const [id] = await claimAndSecure(app, admin, handle, it); if (stage) await api('PATCH', `/api/admin/claims/${id}`, { pipeline: stage }); return id; };
const claims = async (tabName = 'Claims') => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', tabName)); await sleep(80); await p.settle(); return p; };
const buyer = (p, h) => p.q(`[data-buyer="${h}"]`);
const status = async (id) => (await app.q('SELECT pipeline FROM claims WHERE id = ?', [id]))[0].pipeline;

test('IDENTICAL CONFIRMED CLAIMS ARE ONE ROW ("×5"): one stage change moves them all; "Show the 5" opens the individual claims; a claim that differs stays separate', async () => {
  const go = await order('Merge GO'); const a = await item(go, 'Merge photocard'), b = await item(go, 'Merge poster');
  const h = u('mg'); const five = []; for (let i = 0; i < 5; i++) five.push(await claim(h, a, READY)); const other = await claim(h, b, READY);
  await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: a }] });                       // a request: never merged
  const p = await claims(); await p.click(p.q('[data-act="toggle"]', buyer(p, h)));
  const rows = p.qa('tbody tr', buyer(p, h));
  assert.equal(rows.length, 3, 'merged ×5, the poster, and the request');
  const m = p.q('tr[data-group]', buyer(p, h));
  assert.equal(p.text(p.q('[data-times]', m)), '×5'); assert.match(p.text(m), /Merge photocard ×5 Show the 5.*confirmed.*£10\.00 owed|Merge photocard.*×5.*owed/s);
  assert.match(p.text(m), /Initials £10\.00 paid £0\.00/); assert.equal(p.q('input[data-act="pick"]', buyer(p, h)) && p.qa('input[data-act="pick"]', buyer(p, h)).length, 1, 'only the poster has a single tick-box; the merged row has its own');
  assert.match(p.text(m), /£50\.00 owed/, 'the owed figure is the total for all five');
  // one stage change for all five
  const sel = p.q('select[data-act-change="pipeline-group"]', m); await p.choose(sel, ORDERED); await sleep(120); await p.settle();
  assert.match(toast(p), /Moved 5 claims to "ordered via proxy \/ warehouse"\./);
  for (const id of five) assert.equal(await status(id), ORDERED); assert.equal(await status(other), READY, 'the poster did not move');
  // show / hide the individual claims (the person is still open after the stage change)
  const g2 = p.q('tr[data-group]', buyer(p, h)); await p.click(p.q('[data-act="group-toggle"]', g2));
  assert.equal(p.qa('tr[data-claim]', buyer(p, h)).filter((r) => /Merge photocard/.test(p.text(r))).length, 6, '5 individual claims + the request');
  assert.match(p.text(p.q('tr[data-group]', buyer(p, h))), /Hide the 5/); assert.ok(p.q(`tr[data-claim="${five[0]}"] [data-act="edit"]`) && p.q(`tr[data-claim="${five[0]}"] [data-act="cancel"]`), 'each can be edited or cancelled on its own');
  await p.click(p.q('[data-act="group-toggle"]', p.q('tr[data-group]', buyer(p, h)))); assert.equal(p.qa('tr[data-claim]', buyer(p, h)).filter((r) => /Merge photocard/.test(p.text(r))).length, 1, 'hidden again (only the request)');
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('MERGING FOLLOWS THE MONEY: change one claim\'s cost and it leaves the group; give another the same cost and they merge again', async () => {
  const go = await order('Split GO'); const it = await item(go, 'Split thing'); const h = u('sp'); const ids = []; for (let i = 0; i < 4; i++) ids.push(await claim(h, it, READY));
  const p = await claims(); await p.click(p.q('[data-act="toggle"]', buyer(p, h)));
  assert.equal(p.text(p.q('[data-times]', buyer(p, h))), '×4');
  assert.equal((await api('PATCH', `/api/admin/claims/${ids[0]}`, { costs: { ems: { cost: 3 } } })).status, 200);
  const q = await claims(); await q.click(q.q('[data-act="toggle"]', buyer(q, h)));
  assert.equal(q.text(q.q('[data-times]', buyer(q, h))), '×3', 'three still identical');
  const single = q.qa('tbody tr[data-claim]', buyer(q, h)); assert.equal(single.length, 1, 'the one with postage is its own row'); assert.match(q.text(single[0]), /EMS £3\.00/);
  assert.equal((await api('PATCH', `/api/admin/claims/${ids[1]}`, { costs: { ems: { cost: 3 } } })).status, 200);
  const r = await claims(); await r.click(r.q('[data-act="toggle"]', buyer(r, h)));
  assert.deepEqual([r.text(r.q('[data-times]', buyer(r, h))), r.text(r.q('[data-times]', buyer(r, h))) && r.qa('[data-times]', buyer(r, h)).length], ['×2', 2], 'two groups now: ×2 and ×2');
  assert.deepEqual(r.qa('[data-times]', buyer(r, h)).map((x) => r.text(x)), ['×2', '×2']);
  p.close(); q.close(); r.close();
});

test('A COLLAPSED PERSON STILL SHOWS WHERE THEIR CLAIMS ARE: a stage mix (three, in pipeline order, then "+N more") next to the count', async () => {
  const go = await order('Mix GO'); const it = await item(go, 'Mix thing'); const h = u('mx');
  for (let i = 0; i < 3; i++) await claim(h, it, READY); for (let i = 0; i < 2; i++) await claim(h, it, ORDERED);
  await claim(h, it, 'arrived at proxy / warehouse'); await claim(h, it, 'arrived at GOM'); await claim(h, it, 'checking parcel');
  const p = await claims(); const head = buyer(p, h);
  assert.equal(p.q('table', head), null, 'collapsed: no rows'); assert.match(p.text(head), /8 claims/);
  assert.deepEqual(p.qa('[data-mix]', head).map((x) => p.text(x)), ['2 ordered via proxy / warehouse', '1 arrived at proxy / warehouse', '1 arrived at GOM']);
  assert.match(p.text(head), /\+2 more/);
  p.close();
});

test('THE STAGE STRIP: counts per stage for what is listed; click one to show just those, click again to clear; "owing money" and "waiting to be secured" work the same way', async () => {
  const go = await order('Strip GO'); const it = await item(go, 'Strip thing'); const hs = [u('st'), u('st'), u('st')];
  await claim(hs[0], it, READY); await claim(hs[1], it, READY); await claim(hs[2], it, ORDERED);
  await app.api('POST', '/api/claims', { handle: u('rq'), lines: [{ itemId: it }] });
  const p = await claims(); await p.choose(p.q('[data-filter="order"]'), String(go)); await sleep(100); await p.settle();
  const chip = (re) => p.qa('#stageStrip button').find((b) => re.test(p.text(b)));
  assert.match(p.text(chip(/^ready to pack/)), /ready to pack \/ on hand 2$/); assert.match(p.text(chip(/^ordered via proxy/)), /ordered via proxy \/ warehouse 1$/);
  assert.match(p.text(chip(/^waiting to be secured/)), /waiting to be secured 1$/); assert.match(p.text(chip(/^owing money/)), /owing money 3$/);
  assert.equal(p.qa('[data-buyer]').length, 4);
  await p.click(chip(/^ready to pack/)); assert.equal(p.qa('[data-buyer]').length, 2, 'just the two with ready-to-pack claims'); assert.equal(chip(/^ready to pack/).getAttribute('aria-pressed'), 'true');
  assert.ok(chip(/^ordered via proxy/), 'the other stages stay in the strip so you can switch');
  await p.click(chip(/^ready to pack/)); assert.equal(p.qa('[data-buyer]').length, 4, 'click again: cleared');
  await p.click(chip(/^waiting to be secured/)); assert.equal(p.qa('[data-buyer]').length, 1); await p.click(chip(/^waiting to be secured/));
  await p.click(chip(/^owing money/)); assert.equal(chip(/^owing money/).getAttribute('aria-pressed'), 'true'); assert.equal(p.q('[data-filter="unpaid"]').checked, true, 'the same filter as the tick-box');
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('EXPAND ALL / COLLAPSE ALL, and searching opens whatever matches', async () => {
  const go = await order('Expand GO'); const it = await item(go, 'Expand thing'); const hs = [u('ex'), u('ex'), u('ex')]; for (const h of hs) { await claim(h, it, READY); await claim(h, it, READY); }
  const p = await claims(); await p.choose(p.q('[data-filter="order"]'), String(go)); await sleep(100); await p.settle();
  assert.equal(p.qa('[data-buyer] table').length, 0, 'everyone starts collapsed');
  await p.click(p.byText('button', 'Expand all')); assert.equal(p.qa('[data-buyer] table').length, 3);
  await p.click(p.byText('button', 'Collapse all')); assert.equal(p.qa('[data-buyer] table').length, 0);
  await p.type(p.q('[data-filter="q"]'), hs[1]); await p.settle(); assert.equal(p.qa('[data-buyer]').length, 1); assert.equal(p.qa('[data-buyer] table').length, 1, 'searching opens the match');
  p.close();
});

test('LONG LISTS ARE PAGED: 25 people at a time with "Show 25 more", and searching shows every match', async () => {
  const go = await order('Many GO'); const it = await item(go, 'Many thing'); const hs = Array.from({ length: 30 }, () => u('mp'));
  for (const h of hs) await claim(h, it, READY);
  const p = await claims(); await p.choose(p.q('[data-filter="order"]'), String(go)); await sleep(120); await p.settle();
  assert.equal(p.qa('[data-buyer]').length, 25); const m = p.byText('button', 'Show 5 more people'); assert.ok(m, p.text(p.q('#tabBody')).slice(0, 200)); assert.match(p.text(m), /Show 5 more people \(5 not shown\)/);
  await p.click(m); assert.equal(p.qa('[data-buyer]').length, 30); assert.equal(p.byText('button', 'Show'), undefined, 'no more button once everyone is listed');
  await p.click(p.byText('button', 'Collapse all')); assert.equal(p.qa('[data-buyer]').length, 25, 'collapse all starts the paging over');
  await p.type(p.q('[data-filter="q"]'), 'mp'); await p.settle(); assert.ok(p.qa('[data-buyer]').length >= 30, 'a search is never cut off at 25');
  p.close();
});

test('BY ITEM: one block per item (claims, people, stage mix, owed); open it for who has it; its tick-box selects every confirmed claim of that item for a bulk stage move; the choice is remembered', async () => {
  const go = await order('Item view GO'); const a = await item(go, 'View card A'), b = await item(go, 'View card B'); const [h1, h2] = [u('iv'), u('iv')];
  const a1 = await claim(h1, a, READY), a2 = await claim(h1, a, READY), a3 = await claim(h2, a, ORDERED); await claim(h2, b, READY);
  const p = await claims(); await p.choose(p.q('[data-filter="order"]'), String(go)); await sleep(100); await p.settle();
  await p.click(p.byText('button', 'By item')); assert.equal(p.byText('button', 'By item').getAttribute('aria-pressed'), 'true');
  const blocks = p.qa('[data-item]'); assert.deepEqual(blocks.map((x) => x.dataset.item), ['View card A', 'View card B']);
  const A = p.q('[data-item="View card A"]'); assert.match(p.text(A), /3 claims · 2 people · owed £30\.00/); assert.match(p.text(A), /1 ordered via proxy \/ warehouse.*2 ready to pack \/ on hand/s);
  assert.equal(p.q('table', A), null); await p.click(p.q('[data-act="toggle"]', A));
  const A2 = () => p.q('[data-item="View card A"]');                                             // the block is redrawn when opened
  assert.deepEqual(p.qa('tr[data-who]', A2()).map((r) => [r.dataset.who, p.text(r.children[1])]), [[h1, '2'], [h2, '1']].sort((x, y) => x[0].localeCompare(y[0])));
  await p.click(p.q('input[data-act="pick-person"]', A2())); assert.match(text(p, '#bulkBar'), /3 claims selected/, 'every confirmed claim of that item, whoever has it');
  await p.choose(p.q('#bulkStage'), 'arrived at GOM'); await p.click(p.byText('button', 'Move them')); await sleep(60); await (await import('./ui.helpers.js')).press(p, 'Move them'); await sleep(150); await p.settle();
  for (const id of [a1, a2, a3]) assert.equal(await status(id), 'arrived at GOM');
  // remembered: written to this browser's storage, and still By item after going to another tab and back
  assert.equal(p.window.localStorage.getItem('gom.claims.view'), 'item', 'saved in this browser');
  await p.click(p.byText('#tabs button', 'Sets')); await sleep(60); await p.settle(); await p.click(p.byText('#tabs button', 'Claims')); await sleep(80); await p.settle();
  assert.equal(p.byText('button', 'By item').getAttribute('aria-pressed'), 'true', 'still By item after switching tabs');
  await p.click(p.byText('button', 'By person')); assert.equal(p.window.localStorage.getItem('gom.claims.view'), 'person'); assert.ok(p.qa('[data-buyer]').length >= 2); assert.equal(p.qa('[data-item]').length, 0);
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('IF THERE ARE MORE CLAIMS THAN THE LIST CAN CARRY the screen says so, in a box at the top', async () => {
  const go = await order('Cut GO'); const it = await item(go, 'Cut thing'); for (let i = 0; i < 4; i++) await claim(u('cut'), it, READY);
  process.env.CLAIMS_LIST_MAX = '3';
  const p = await claims(); assert.match(text(p, '[data-truncated]'), /Only the first 3 claims are shown\. There are more than that — narrow it with Group order above/);
  delete process.env.CLAIMS_LIST_MAX; const q = await claims(); assert.equal(q.q('[data-truncated]'), null, 'and no warning when nothing is cut'); p.close(); q.close();
});

test('PAYMENTS: the "where joiners send payment" editor is tucked away once methods exist (a one-line summary), open when there are none, remembers if you open it, and tucks away again after Save', async () => {
  const a2 = await startApp(); const ad2 = await a2.adminLogin(); try {
    const ap = (m, p, b) => a2.api(m, p, b, ad2);
    await ap('PUT', '/api/admin/payment-methods', { methods: [] });
    const open = async () => { const p = await gomPage(a2, ad2); await p.click(p.byText('#tabs button', 'Payments')); await sleep(80); await p.settle(); return p; };
    let p = await open(); assert.equal(p.q('#methodsCard').open, true, 'no methods yet: open so you can add one'); assert.match(text(p, '[data-methods-summary]'), /none yet — click to add one/);
    await ap('PUT', '/api/admin/payment-methods', { methods: [{ method: 'PayPal Friends & Family', accountInfo: 'paypal.me/x' }, { method: 'Bank Transfer', accountInfo: '12-34-56 1234' }, { method: 'Wise', accountInfo: '@x' }] }); p.close();
    p = await open(); const card = () => p.q('#methodsCard');
    assert.equal(card().open, false, 'methods exist: tucked away'); assert.match(text(p, '[data-methods-summary]'), /3 methods: PayPal Friends & Family, Bank Transfer, Wise · click to edit/);
    card().open = true; card().dispatchEvent(new p.window.Event('toggle'));                  // the GOM opens it…
    await p.choose(p.q('[data-filter="status"]'), 'confirmed'); await sleep(100); await p.settle();   // …then does something else on the tab (which redraws it)
    assert.equal(p.q('#methodsCard').open, true, 'once you open it, it stays open while you do other things on the tab');
    const f = p.q('form[data-form="methods"]'); await p.submit(f); await sleep(120); await p.settle();
    assert.match(toast(p), /Saved\./); assert.equal(p.q('#methodsCard').open, false, 'saved: tucked away again');
    p.close();
  } finally { await a2.stop(); }
});
