import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { openPage } from './ui.helpers.js';

// JOINER → Shop: an item with options shows a row per option (its own stock, its own price when it differs, "Sold out"), each with its own stepper; the basket and the claim carry the option.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'uso') => `${x}${++N}`;
const mk = async (title, extra = {}) => (await api('POST', '/api/admin/shop', { title, price: 25, optionLabel: 'Size', options: [{ name: 'L', qty: 2 }, { name: 'M', qty: 1, price: 30 }], ...extra })).json.id;
const shopPage = async () => { const p = await openPage(app, '/'); await sleep(250); await p.settle(); p.window.location.hash = '#/shop'; await sleep(150); await p.settle(); return p; };
const card = (p, id) => p.q(`[data-shop-item="${id}"]`);
const row = (p, id, opt) => p.q(`[data-shop-item="${id}"] [data-shop-option="${opt}"]`);
const inc = async (p, id, opt) => { await p.click(p.q(`[data-act="shopinc"][data-shop="${id}"][data-option="${opt}"]`)); await sleep(30); };
const dec = async (p, id, opt) => { await p.click(p.q(`[data-act="shopdec"][data-shop="${id}"][data-option="${opt}"]`)); await sleep(30); };
const claims = async (h, id) => (await app.q("SELECT c.label, c.member_name AS member, cc.cost FROM claims c JOIN joiners j ON j.id = c.joiner_id JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category = 'initials' WHERE j.instagram_handle = ? AND c.leftover_item_id = ? AND c.status <> 'cancelled' ORDER BY c.id", [h, id])).map((r) => [r.member, Number(r.cost)]);

test('THE SHOP PAGE SHOWS A ROW PER OPTION: its stock, its own price only when it differs, "Sold out" when none are left; no stepper on the listing itself; an ordinary item is as before', async () => {
  const id = await mk(u('Hoodie ')), cards = await mk(u('Photocards '), { price: 3, optionLabel: 'Member', options: [{ name: 'Han', qty: 1 }, { name: 'Felix', qty: 0 }] }), plain = (await api('POST', '/api/admin/shop', { title: u('Plain '), price: 5, qty: 2 })).json.id;
  const p = await shopPage(); assert.match(p.text(card(p, id).querySelector('.sub')), /^from £25\.00 · 3 left · pay within 5 days of claiming/); assert.equal(card(p, id).querySelector(':scope > .itemrow [data-act="shopinc"]'), null, 'no stepper on the listing');
  assert.match(p.text(row(p, id, 'L')), /^L2 left/); assert.match(p.text(row(p, id, 'M')), /^M£30\.00 · 1 left/, 'the dearer size shows its price'); assert.match(p.text(row(p, cards, 'Felix')), /^FelixSold out$/); assert.equal(row(p, cards, 'Felix').querySelector('[data-act]'), null, 'no stepper for a sold-out option'); assert.match(p.text(card(p, cards).querySelector('.sub')), /^£3\.00 · 1 left/, 'one price: no "from"');
  assert.ok(card(p, plain).querySelector('[data-act="shopinc"]'), 'an ordinary item keeps its own stepper'); assert.equal(card(p, plain).querySelector('[data-shop-options]'), null); assert.deepEqual(p.errors, []); p.close();
});

test('EACH OPTION HAS ITS OWN STEPPER, limited to ITS stock; the basket lists one line per option with its own price and the total adds them up', async () => {
  const id = await mk(u('Hoodie ')); const p = await shopPage(); await inc(p, id, 'L'); await inc(p, id, 'L'); assert.equal(p.q(`[data-act="shopinc"][data-shop="${id}"][data-option="L"]`).disabled, true, 'only 2 L'); await inc(p, id, 'M'); assert.equal(p.q(`[data-act="shopinc"][data-shop="${id}"][data-option="M"]`).disabled, true, 'only 1 M');
  assert.equal(p.text(p.q(`[data-shop-option="L"] .stepper span`, card(p, id))), '2'); await dec(p, id, 'L'); assert.equal(p.text(row(p, id, 'L').querySelector('.stepper span')), '1');
  p.window.location.hash = '#/basket'; await sleep(150); await p.settle(); const lines = p.qa('#view .card .itemrow').filter((r) => /Hoodie/.test(p.text(r))).map((r) => p.text(r)); assert.equal(lines.length, 2); assert.match(lines[0], /Hoodie \d* — L/); assert.match(lines[0], /£25\.00 each/); assert.match(lines[1], /— M/); assert.match(lines[1], /£30\.00 each/); assert.match(p.text(p.q('#view')), /Total£55\.00/);
  p.close();
});

test('CLAIMING SENDS THE OPTIONS: each claim is for its option at its price; the basket is cleared; the same option again asks first — naming only that option — and "No" removes just that line', async () => {
  const id = await mk(u('Hoodie '), { options: [{ name: 'L', qty: 5 }, { name: 'M', qty: 5, price: 30 }] }); const h = u('buyer'); const p = await shopPage(); await inc(p, id, 'L'); p.window.location.hash = '#/basket'; await sleep(150); await p.settle();
  p.q('#ig').value = h; await p.submit(p.q('form[data-form="claim"]')); await sleep(450); await p.settle(); assert.deepEqual(await claims(h, id), [['L', 25]]); p.close();
  const q = await shopPage(); await inc(q, id, 'L'); await inc(q, id, 'M'); q.window.location.hash = '#/basket'; await sleep(150); await q.settle(); q.q('#ig').value = h; await q.submit(q.q('form[data-form="claim"]')); await sleep(450); await q.settle();
  const msg = q.text(q.q('#view')); assert.match(msg, /You already have 1 × .* — L — claim another\?/); assert.doesNotMatch(msg, /1 × .* — M/, 'M is not a repeat'); assert.equal((await claims(h, id)).length, 1, 'nothing was added yet');
  await q.click(q.q('[data-act="dup-no"]')); await sleep(100); await q.settle(); const after = q.text(q.q('#view')); assert.match(after, /— M/, 'the M line is still there'); assert.doesNotMatch(after, /— L/, 'only the repeat (L) was taken out'); assert.equal((await claims(h, id)).length, 1); q.close();
  const r = await shopPage(); await inc(r, id, 'M'); r.window.location.hash = '#/basket'; await sleep(150); await r.settle(); r.q('#ig').value = h; await r.submit(r.q('form[data-form="claim"]')); await sleep(450); await r.settle(); assert.deepEqual(await claims(h, id), [['L', 25], ['M', 30]], 'a different option is simply claimed'); r.close();
});

test('IF THE STOCK CHANGES UNDER YOU: a basket line is trimmed to what is left on the next load, and a claim that loses the race says it sold out', async () => {
  const id = await mk(u('Hoodie ')); const p = await shopPage(); await inc(p, id, 'M'); p.window.location.hash = '#/basket'; await sleep(150); await p.settle();
  assert.equal((await app.api('POST', '/api/claims', { handle: u('fast'), lines: [{ leftoverId: id, member: 'M' }] })).status, 201, 'someone else takes the last M'); p.q('#ig').value = u('slow'); await p.submit(p.q('form[data-form="claim"]')); await sleep(450); await p.settle();
  assert.match(p.text(p.q('#view')), /has sold out/); assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims WHERE leftover_item_id = ? AND status <> 'cancelled'", [id]))[0].n, 1, 'only the fast one got it'); p.close();
  const q = await shopPage(); assert.equal(q.qa(`[data-shop-item="${id}"] [data-act="shopinc"][data-option="M"]`).length, 0, 'M is sold out for everyone now'); assert.match(q.text(row(q, id, 'M')), /^M£30\.00 · Sold out$/); q.close();
});

test('NAMES WITH HTML ARE SHOWN AS TEXT (item and option names)', async () => {
  const id = await mk('<img src=x onerror="window.pwned=1"> Tee', { options: [{ name: '<b>XL</b>', qty: 1 }] }); const p = await shopPage();
  assert.equal(p.q('img[src="x"]', card(p, id)), null); assert.equal(p.q('b', card(p, id)), null); assert.equal(p.window.pwned, undefined); assert.ok(p.text(card(p, id)).includes('<b>XL</b>')); await p.click(p.q(`[data-act="shopinc"][data-shop="${id}"]`)); await sleep(30);
  p.window.location.hash = '#/basket'; await sleep(150); await p.settle(); assert.equal(p.q('#view b'), null); assert.ok(p.text(p.q('#view')).includes('— <b>XL</b>')); p.close();
});

test('A BASKET SAVED EARLIER IS BROUGHT UP TO DATE when the page loads: too many are cut to what is left, a sold-out option or a removed one drops out, and a changed price is refreshed', async () => {
  const id = await mk(u('Hoodie '), { options: [{ name: 'L', qty: 2 }, { name: 'M', qty: 0 }, { name: 'S', qty: 3, price: 40 }] }); const t = (await api('GET', '/api/admin/shop')).json.items.find((i) => i.id === id).title;
  const line = (option, qty, price) => ({ key: `shop:${id}:${option}`, shopId: id, option, orderTitle: 'Shop (on hand)', title: t, label: `${t} — ${option}`, price, qty, payDays: 5 });
  const saved = [line('L', 5, 25), line('M', 1, 30), line('S', 1, 99), line('Gone', 1, 25)];
  const p = await openPage(app, '/', { init: (win) => win.sessionStorage.setItem('sos_basket', JSON.stringify(saved)) }); await sleep(300); await p.settle(); p.window.location.hash = '#/basket'; await sleep(150); await p.settle();
  const b = JSON.parse(p.window.sessionStorage.getItem('sos_basket')); assert.deepEqual(b.map((l) => [l.option, l.qty, l.price]), [['L', 2, 25], ['S', 1, 40]], 'L cut to the 2 left; M (sold out) and Gone (removed) dropped; S\'s price refreshed'); p.close();
});
