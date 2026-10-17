import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { openPage, toast } from './ui.helpers.js';

// What a JOINER sees when an item has a purchase limit (a store limit, a bulky item): the rule and what's left, a + that stops at the limit, and a basket that is trimmed (or refused with a plain message) if it no longer fits.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'jl') => `${x}${++N}`;
const goOrder = async (title) => (await api('POST', '/api/admin/orders', { groupId: w.group, title: `${title} ${++N}`, proxy: 'Sam' })).json.id;
const item = async (go, extra) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title: u('Thing '), ...extra })).json.id;
const claim = (lines, handle = u()) => app.api('POST', '/api/claims', { handle, lines });
const open = async (go, opts = {}) => { const p = await openPage(app, '/', opts); await sleep(250); await p.settle(); p.window.location.hash = `#/order/${go}`; await sleep(250); await p.settle(); return p; };
const card = (p, id) => p.q(`[data-item-card="${id}"]`);
const plus = (p, id, opt) => p.q(`[data-act="inc"][data-item="${id}"]${opt ? `[data-member="${opt}"], [data-act="inc"][data-item="${id}"][data-variant="${opt}"]` : ''}`);
const tileOf = (p, id, name) => p.q(`[data-opt="${name}"]`, card(p, id));
const basketLine = (itemId, qty, extra = {}) => ({ key: `${itemId}|${extra.member || ''}|${extra.variant || ''}`, itemId, orderTitle: 'GO', title: 'T', label: 'T', price: 5, qty, member: null, variant: null, ...extra });

test('A WHOLE-ITEM LIMIT: the card says "Limit N in total · M left"; + stops exactly at what is left; at the limit the card says so and + is switched off', async () => {
  const go = await goOrder('Whole'); const it = await item(go, { title: 'Bulky photobook', purchaseLimit: 3 }); await claim([{ itemId: it }]); const p = await open(go);
  assert.match(p.text(card(p, it)), /Limit 3 in total · 2 left/); assert.equal(plus(p, it).disabled, false); await p.click(plus(p, it)); await p.click(plus(p, it));
  assert.equal(p.text(p.q('.stepper span', card(p, it))), '2'); assert.equal(plus(p, it).disabled, true, 'two in the basket = all that is left'); assert.match(p.text(p.q('#basketPill')), /Basket \(2\)/);
  plus(p, it).disabled = false; await p.click(plus(p, it)); assert.equal(p.text(p.q('.stepper span', card(p, it))), '2', 'even if a stale page lets the + be pressed, nothing goes over'); assert.match(toast(p), /“Bulky photobook” has reached its purchase limit \(3 in total\)\./);
  await p.click(p.q(`[data-act="dec"][data-item="${it}"]`)); assert.equal(plus(p, it).disabled, false, 'taking one out frees it again'); assert.deepEqual([p.errors], [[]]); p.close();
  const full = await item(go, { title: 'All gone', purchaseLimit: 1 }); await claim([{ itemId: full }]); const q = await open(go); assert.ok(q.q('[data-limit-reached]', card(q, full)), 'a "Limit reached" pill'); assert.match(q.text(card(q, full)), /Limit reached/); assert.equal(plus(q, full).disabled, true); assert.doesNotMatch(q.text(card(q, full)), /left/); q.close();
});

test('AN ITEM WITHOUT A LIMIT IS UNCHANGED (no note, + works), and a closed item shows no limit note', async () => {
  const go = await goOrder('Plain'); const it = await item(go, { title: 'No limit here' }); const closed = await item(go, { title: 'Closed limited', purchaseLimit: 2 }); await api('PATCH', `/api/admin/items/${closed}`, { closed: true }); const p = await open(go);
  assert.equal(p.q('[data-limit]', card(p, it)), null); assert.doesNotMatch(p.text(card(p, it)), /Limit/); assert.equal(plus(p, it).disabled, false); assert.equal(p.q('[data-limit]', card(p, closed)), null, 'closed: no note'); p.close();
});

test('PER MEMBER / PER SIZE: the card says "limit N of each", every option says how many are left (or "limit reached"); a full option\'s + is off and the others still work', async () => {
  const go = await goOrder('Options'); const mem = await item(go, { type: 'independent', members: ['Han', 'Felix'], title: 'Per member', purchaseLimit: 2, limitScope: 'option' }); await claim([{ itemId: mem, member: 'Han', qty: 2 }]); await claim([{ itemId: mem, member: 'Felix' }]);
  const sz = await item(go, { type: 'size', variants: ['M', 'L'], title: 'Per size', purchaseLimit: 1, limitScope: 'option' }); await claim([{ itemId: sz, variant: 'M' }]); const p = await open(go);
  assert.match(p.text(card(p, mem)), /Limit 2 of each/); assert.match(p.text(tileOf(p, mem, 'Han')), /limit reached/); assert.match(p.text(tileOf(p, mem, 'Felix')), /1 left/); assert.equal(p.q('[data-act="inc"]', tileOf(p, mem, 'Han')).disabled, true); assert.equal(p.q('[data-act="inc"]', tileOf(p, mem, 'Felix')).disabled, false);
  await p.click(p.q('[data-act="inc"]', tileOf(p, mem, 'Felix'))); assert.equal(p.q('[data-act="inc"]', tileOf(p, mem, 'Felix')).disabled, true, 'Felix: one in the basket = the one that was left');
  assert.match(p.text(tileOf(p, sz, 'M')), /limit reached/); assert.match(p.text(tileOf(p, sz, 'L')), /1 left/); assert.equal(p.q('[data-act="inc"]', tileOf(p, sz, 'M')).disabled, true); assert.equal(p.q('[data-act="inc"]', tileOf(p, sz, 'L')).disabled, false); p.close();
});

test('MEMBER SETS: parts stop at what is left; "Claim the whole set" adds NOTHING (and says why) if any part is full — and escapes names', async () => {
  const go = await goOrder('Sets'); const per = await item(go, { type: 'set', members: ['<b>A</b>', 'B'], title: '<i>Set</i> per part', purchaseLimit: 1, limitScope: 'option' });
  await claim([{ itemId: per, parts: [{ member: '<b>A</b>', qty: 1 }] }]); const p = await open(go);
  assert.match(p.text(tileOf(p, per, '<b>A</b>')), /limit reached/); assert.equal(p.q('[data-act="inc"]', tileOf(p, per, '<b>A</b>')).disabled, true); assert.equal(p.q('[data-act="inc"]', tileOf(p, per, 'B')).disabled, false);
  await p.click(p.q(`[data-act="whole"][data-item="${per}"]`)); assert.match(toast(p), /can't be claimed as a whole set — part of it has reached its purchase limit\./); assert.match(toast(p), /<i>Set<\/i> per part/, 'the name is shown as text'); assert.equal(p.q('#toast i'), null);
  assert.equal(p.q('#basketPill').textContent.trim(), '', 'nothing was added — not even the part that was free'); assert.equal(p.q('b', card(p, per)), null); p.close();
  const tot = await item(go, { type: 'set', members: ['A', 'B', 'C'], title: 'Set total', purchaseLimit: 2, limitScope: 'item' }); const q = await open(go); await q.click(q.q('[data-act="inc"]', tileOf(q, tot, 'A'))); await q.click(q.q('[data-act="inc"]', tileOf(q, tot, 'B')));
  assert.ok(['A', 'B', 'C'].every((m) => q.q('[data-act="inc"]', tileOf(q, tot, m)).disabled), 'two parts in all: every + stops'); q.close();
});

test('A BASKET THAT NO LONGER FITS IS TRIMMED WHEN THE PAGE LOADS (someone claimed meanwhile, or the limit was lowered), and it says so; lines with nothing left are removed', async () => {
  const go = await goOrder('Trim'); const whole = await item(go, { title: 'Whole trim', purchaseLimit: 3 }); await claim([{ itemId: whole, qty: 2 }]); const opt = await item(go, { type: 'independent', members: ['Han', 'Felix'], title: 'Opt trim', purchaseLimit: 1, limitScope: 'option' }); await claim([{ itemId: opt, member: 'Han' }]);
  const saved = [basketLine(whole, 3), basketLine(opt, 2, { member: 'Han' }), basketLine(opt, 1, { member: 'Felix' })];
  const p = await openPage(app, '/', { init: (win) => win.sessionStorage.setItem('sos_basket', JSON.stringify(saved)) }); await sleep(300); await p.settle(); const left = JSON.parse(p.window.sessionStorage.getItem('sos_basket'));
  assert.deepEqual(left.map((l) => [l.itemId, l.member, l.qty]), [[whole, null, 1], [opt, 'Felix', 1]], 'Whole: 3 → the 1 that is left; Han: nothing left, removed; Felix: untouched');
  await sleep(150); assert.match(toast(p), /2 items in your basket were reduced or taken out — the purchase limit has been reached\./); p.close();
});

test('IF SOMEONE TAKES THE LAST ONE WHILE YOU ARE CHECKING OUT: Claim is refused with the plain message, nothing is taken, and the page refreshes so it tells the truth', async () => {
  const go = await goOrder('Race'); const it = await item(go, { title: 'Last one', purchaseLimit: 2 }); await claim([{ itemId: it }]); const p = await open(go); await p.click(plus(p, it)); assert.match(p.text(p.q('#basketPill')), /Basket \(1\)/);
  await claim([{ itemId: it }]);                                                                        // …meanwhile someone else claims the last place
  p.window.location.hash = '#/basket'; await sleep(250); await p.settle(); const f = p.q('form[data-form="claim"]'); f.elements.handle.value = u('me'); await p.submit(f); await sleep(400); await p.settle();
  assert.match(p.text(p.q('#view')), /Sorry — “Last one” has reached its purchase limit \(limit 2 in total\)\./); assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND status <> 'cancelled'", [it]))[0].n, 2, 'nothing was added');
  assert.equal(JSON.parse(p.window.sessionStorage.getItem('sos_basket') || '[]').length, 0, 'the page refreshed what is left and trimmed the basket'); p.close();
});

test('THE LIMIT FOLLOWS CLAIMS COMING AND GOING: cancelling a claim frees a place the next time the page is opened', async () => {
  const go = await goOrder('Free'); const it = await item(go, { title: 'Frees up', purchaseLimit: 1 }); await claim([{ itemId: it }]); let p = await open(go); assert.equal(plus(p, it).disabled, true); p.close();
  const [{ id }] = await app.q('SELECT id FROM claims WHERE item_id = ?', [it]); assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: [id] })).status, 200); p = await open(go); assert.equal(plus(p, it).disabled, false); assert.match(p.text(card(p, it)), /Limit 1 in total · 1 left/); p.close();
});
