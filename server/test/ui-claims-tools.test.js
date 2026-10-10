import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b) => app.api(m, p, b, admin);
const text = (p, sel = '#tabBody') => p.text(p.q(sel));
const fresh = (x = 'uc') => `${x}${++N}`;
async function order(title, price = 10) { const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title })).json.id; return { go, item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: `${title} item`, price })).json.id }; }
const stageOf = async (id) => (await api('GET', '/api/admin/claims')).json.claims.find((c) => c.id === id).pipeline;

// ───────────── credit → tip (Payments tab) ─────────────
async function lookup(p, handle) {
  await p.click(p.byText('#tabs button', 'Payments'));
  const f = p.q('form[data-form="lookup"]'); p.fill(f, { handle }); await p.submit(f);
}

test('Payments: turning credit into a tip — asks first and says what it does, then records it', async () => {
  const h = fresh(); const c = await joinerSession(app, `${h}@x.com`, h);
  await api('POST', '/api/admin/credit/add', { handle: h, amount: 10, reason: 'sold your album' });
  const p = await gomPage(app, admin); await lookup(p, h);
  assert.match(text(p), /credit on account: £10\.00/);
  const form = () => p.q('form[data-form="credit-tip"]');
  assert.match(p.text(form()), /Turn credit into a tip.*Only when they've asked you to.*counted as a tip/s);
  await p.submit(form());
  assert.match(p.text(p.q('[data-msg]', form())), /Enter an amount/);
  p.fill(form(), { amount: '4', reason: 'asked me to keep the change' }); await p.submit(form());
  assert.match(p.text(modal(p)), new RegExp(`Turn £4\\.00 of @${h}'s credit into a tip\\?.*asked you to.*can't be turned back into credit`, 's'));
  await press(p, 'Cancel');
  assert.equal((await app.api('GET', '/api/my/summary', undefined, c)).json.credit, 10, 'cancelling changed nothing');
  await p.submit(form()); await press(p, 'Turn it into a tip');
  assert.match(toast(p), /£4\.00 turned into a tip/);
  assert.match(text(p), /credit on account: £6\.00/);
  assert.match(text(p), /Tip.*£4\.00.*asked me to keep the change/s);
  assert.match(text(p), /Credit removed.*−£4\.00/s);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('Payments: asking for more than they hold shows the server\'s explanation in the form', async () => {
  const h = fresh(); await joinerSession(app, `${h}@x.com`, h);
  await api('POST', '/api/admin/credit/add', { handle: h, amount: 3, reason: 'x' });
  const p = await gomPage(app, admin); await lookup(p, h);
  const form = () => p.q('form[data-form="credit-tip"]');
  p.fill(form(), { amount: '9' }); await p.submit(form()); await press(p, 'Turn it into a tip');
  assert.match(p.text(p.q('[data-msg]', form())), /only have £3\.00 unspent credit, so £9\.00 can't be turned into a tip/);
  p.close();
});

// ───────────── Claims tab ─────────────
const openClaims = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); return p; };
const buyerOf = (p, h) => p.q(`[data-buyer="${h}"]`);
const btn = (p, re) => p.qa('button').find((b) => re.test(p.text(b)));
const peopleOrder = (p) => p.qa('[data-buyer]').map((e) => e.dataset.buyer);

test('each person shows overall totals — owed, paid and credit across ALL their orders — even though the list is grouped by order', async () => {
  const h = fresh('tt'); const c = await joinerSession(app, `${h}@x.com`, h);
  const a = await order('Totals A', 10), b = await order('Totals B', 6);
  await claimAndSecure(app, admin, h, a.item); await claimAndSecure(app, admin, h, b.item);
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 5, reference: 'U' }, c); await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  const p = await openClaims();
  const lines = p.qa(`[data-totals="${h}"]`).map((e) => p.text(e));
  assert.equal(lines.length, 2, 'they appear in two orders, with the same overall line in each');
  for (const l of lines) assert.match(l, /Overall: owes £11\.00 · paid £5\.00 · credit £0\.00/);
  await api('POST', '/api/admin/credit/add', { handle: h, amount: 30, reason: 'x' });
  const q = await openClaims();
  assert.match(q.text(q.q(`[data-totals="${h}"]`)), /Overall: owes £0\.00 · paid £16\.00 · credit £19\.00/);
  p.close(); q.close();
});

test('filter by stage, and "only claims that still owe money"', async () => {
  const { item } = await order('Filters');
  const [paid, unpaid, moved] = [fresh('fl'), fresh('fl'), fresh('fl')];
  const cp = await joinerSession(app, `${paid}@x.com`, paid);
  await claimAndSecure(app, admin, paid, item); await claimAndSecure(app, admin, unpaid, item);
  const [idMoved] = await claimAndSecure(app, admin, moved, item); await api('PATCH', `/api/admin/claims/${idMoved}`, { pipeline: 'arrived at GOM' });
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 10, reference: 'F' }, cp); await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  const p = await openClaims();
  await p.type(p.q('[data-filter="q"]'), 'Filters item'); await p.settle();
  assert.deepEqual(peopleOrder(p).sort(), [moved, paid, unpaid].sort());
  await p.choose(p.q('select[data-filter="stage"]'), 'arrived at GOM');
  assert.deepEqual(peopleOrder(p), [moved], 'only claims at that stage');
  await p.choose(p.q('select[data-filter="stage"]'), '');
  await p.click(p.q('input[data-filter="unpaid"]'));
  assert.deepEqual(peopleOrder(p).sort(), [moved, unpaid].sort(), 'the person who has paid in full is hidden');
  await p.click(p.q('input[data-filter="unpaid"]'));
  assert.equal(peopleOrder(p).length, 3);
  p.close();
});

test('sorting: by person, by who owes most, by earliest stage, and newest first — people and the claims inside them', async () => {
  const o = await order('Sorting', 10);
  const [a, b, c] = ['sa_zed', 'sb_amy', 'sc_mid'];
  await claimAndSecure(app, admin, a, o.item);                                                    // oldest, owes £10
  await claimAndSecure(app, admin, b, o.item); await claimAndSecure(app, admin, b, o.item);       // owes £20
  const [idC] = await claimAndSecure(app, admin, c, o.item);                                      // newest, owes £10
  await api('PATCH', `/api/admin/claims/${idC}`, { pipeline: 'ordered via proxy / warehouse' });
  const p = await openClaims();
  await p.type(p.q('[data-filter="q"]'), 'Sorting item'); await p.settle();
  assert.deepEqual(peopleOrder(p), ['sa_zed', 'sb_amy', 'sc_mid'], 'A–Z by default');
  await p.choose(p.q('select[data-filter="sort"]'), 'owed');
  assert.deepEqual(peopleOrder(p), ['sb_amy', 'sa_zed', 'sc_mid'], 'most owed first, ties A–Z');
  await p.choose(p.q('select[data-filter="sort"]'), 'stage');
  assert.deepEqual(peopleOrder(p), ['sa_zed', 'sb_amy', 'sc_mid'], 'still-awaiting claims before the one that has moved on');
  await p.choose(p.q('select[data-filter="sort"]'), 'newest');
  assert.deepEqual(peopleOrder(p), ['sc_mid', 'sb_amy', 'sa_zed'], 'whoever claimed most recently first');
  assert.equal(p.q('select[data-filter="sort"]').value, 'newest', 'the choice sticks');
  p.close();
});

test('selecting claims: tick-boxes only on confirmed claims; per-person and per-order select-all; the bar counts and clears', async () => {
  const { item } = await order('Select');
  const [x, y] = [fresh('sel'), fresh('sel')];
  await claimAndSecure(app, admin, x, item); await claimAndSecure(app, admin, x, item); await claimAndSecure(app, admin, y, item);
  const req = fresh('sel'); await app.api('POST', '/api/claims', { handle: req, lines: [{ itemId: item }] });
  const p = await openClaims();
  await p.type(p.q('[data-filter="q"]'), 'Select item'); await p.settle();
  await p.click(p.q('[data-act="toggle"]', buyerOf(p, x)));
  assert.equal(p.qa('tr[data-group]', buyerOf(p, x)).length, 1, 'two identical confirmed claims are ONE merged row');
  assert.equal(p.text(p.q('[data-times]', buyerOf(p, x))), '×2'); assert.equal(p.q('input[data-act="pick"]', buyerOf(p, x)), null, 'their individual boxes are inside the merged row');
  await p.click(p.q('[data-act="group-toggle"]', buyerOf(p, x)));                      // "Show the 2"
  assert.equal(p.qa('input[data-act="pick"]', buyerOf(p, x)).length, 2);
  await p.click(p.q('[data-act="toggle"]', buyerOf(p, req)));
  assert.equal(p.q('input[data-act="pick"]', buyerOf(p, req)), null, 'a mere request has nothing to move');
  assert.equal(p.q('#bulkBar'), null, 'no bar until something is ticked');
  await p.click(p.q('input[data-act="pick"]', buyerOf(p, x)));
  assert.match(text(p, '#bulkBar'), /1 claim selected/);
  await p.click(p.q('input[data-act="pick-person"]', buyerOf(p, x)));
  assert.match(text(p, '#bulkBar'), /2 claims selected/);
  await p.click(btn(p, /^Select all \d+ confirmed claims here/));
  assert.match(text(p, '#bulkBar'), /3 claims selected/, 'everything confirmed in the order, but not the request');
  await p.click(btn(p, /^Unselect all 3 confirmed claims here/));
  assert.equal(p.q('#bulkBar'), null);
  await p.click(p.q('input[data-act="pick"]', buyerOf(p, x))); await p.click(btn(p, /^Clear$/));
  assert.equal(p.q('#bulkBar'), null);
  p.close();
});

test('moving the selected claims: asks first and explains the exception; moves them; and tells you exactly what it left alone', async () => {
  const { item } = await order('Mover');
  const [a, b] = [fresh('mv'), fresh('mv')];
  const [idA] = await claimAndSecure(app, admin, a, item), [idB] = await claimAndSecure(app, admin, b, item);
  // b's claim sits in a box that has not arrived: it must be left alone, and the GOM told
  await api('PATCH', `/api/admin/claims/${idB}`, { pipeline: 'arrived at proxy / warehouse' });
  assert.equal((await api('POST', '/api/admin/boxes', { claimIds: [idB], emsTotal: 3 })).status, 201);
  const p = await openClaims();
  await p.type(p.q('[data-filter="q"]'), 'Mover item'); await p.settle();
  await p.click(btn(p, /^Select all \d+ confirmed claims here/));
  assert.match(text(p, '#bulkBar'), /2 claims selected/);
  await p.choose(p.q('#bulkStage'), 'ordered via proxy / warehouse');
  await p.click(p.byText('button', 'Move them'));
  const d = p.text(modal(p));
  assert.match(d, /Move 2 claims to "ordered via proxy \/ warehouse"\?/);
  assert.match(d, /Only confirmed claims are moved.*in a parcel, or in a box that hasn't arrived yet, is left alone.*Packing and Warehouse tabs/s);
  await press(p, 'Cancel');
  assert.equal(await stageOf(idA), 'awaiting fulfillment', 'cancelling moved nothing');
  await p.click(p.byText('button', 'Move them')); await press(p, 'Move them');
  assert.match(toast(p), /Moved 1 claim to "ordered via proxy \/ warehouse"\. 1 left alone\./);
  assert.match(p.text(modal(p)), new RegExp(`1 claim was left where it was:.*Mover item.*in a box that hasn't arrived yet.*Warehouse tab`, 's'));
  await press(p, 'OK');
  assert.equal(await stageOf(idA), 'ordered via proxy / warehouse'); assert.equal(await stageOf(idB), 'shipping requested');
  assert.equal(p.q('#bulkBar'), null, 'the selection is cleared afterwards');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('you can never move a claim you cannot see: changing the filter drops hidden claims from the selection', async () => {
  const [o1, o2] = [await order('Hidden A'), await order('Hidden B')];
  const [h1, h2] = [fresh('hd'), fresh('hd')];
  await claimAndSecure(app, admin, h1, o1.item); await claimAndSecure(app, admin, h2, o2.item);
  const p = await openClaims();
  await p.type(p.q('[data-filter="q"]'), 'Hidden'); await p.settle();
  await p.click(btn(p, /^Select all 1 confirmed claim here/));                       // the page redraws after each click, so look again for the next one
  await p.click(btn(p, /^Select all 1 confirmed claim here/));
  assert.match(text(p, '#bulkBar'), /2 claims selected/);
  await p.type(p.q('[data-filter="q"]'), 'Hidden A'); await p.settle();
  assert.match(text(p, '#bulkBar'), /1 claim selected/, 'the claim that is no longer shown was unselected');
  p.close();
});

test('names with HTML in them are shown as text in the new controls', async () => {
  const o = await order('<img src=x onerror="window.pwned=1"> bulk'); const h = fresh('xs');
  await claimAndSecure(app, admin, h, o.item);
  const p = await openClaims();
  await p.click(p.q('[data-act="toggle"]', buyerOf(p, h)));
  await p.click(p.q('input[data-act="pick"]', buyerOf(p, h)));
  assert.equal(p.q('#tabBody img'), null); assert.equal(p.window.pwned, undefined);
  p.close();
});
