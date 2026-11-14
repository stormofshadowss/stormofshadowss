import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { openPage, toast } from './ui.helpers.js';

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

const pop = (p) => p.q('.pcpop');
const openPick = async (p, id) => { await p.click(p.q(`[data-act="shoppick"][data-shop="${id}"]`)); await sleep(30); return pop(p); };
const choose = (p, name) => { const r = [...pop(p).querySelectorAll('input[name="shoppick"]')].find((i) => i.value === name); r.checked = true; r.dispatchEvent(new p.window.Event('change', { bubbles: true })); };
const plus = async (p) => { await p.click(pop(p).querySelector('[data-pick="inc"]')); };
const addBtn = (p) => pop(p).querySelector('[data-pick="add"]');
// open the chooser for an item, pick an option, set how many, and add it
const addOpt = async (p, id, name, qty = 1) => { await openPick(p, id); choose(p, name); for (let i = 1; i < qty; i++) await plus(p); await p.click(addBtn(p)); await sleep(60); await p.settle(); };
const goBasket = async (p) => { p.window.location.hash = '#/basket'; await sleep(150); await p.settle(); };

const claims = async (h, id) => (await app.q("SELECT c.label, c.member_name AS member, cc.cost FROM claims c JOIN joiners j ON j.id = c.joiner_id JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category = 'initials' WHERE j.instagram_handle = ? AND c.leftover_item_id = ? AND c.status <> 'cancelled' ORDER BY c.id", [h, id])).map((r) => [r.member, Number(r.cost)]);

test('THE SHOP CARD IS JUST THE TOP-LEVEL CARD: title, "from" price, how many are left and an "Add to basket" button — no list of options and no steppers on the page; sold out has no button; an ordinary item keeps its stepper', async () => {
  const id = await mk(u('Hoodie ')), cards = await mk(u('Photocards '), { price: 3, optionLabel: 'Member', options: [{ name: 'Han', qty: 1 }, { name: 'Felix', qty: 0 }] }), gone = await mk(u('Gone '), { options: [{ name: 'L', qty: 0 }, { name: 'M', qty: 0 }] }), plain = (await api('POST', '/api/admin/shop', { title: u('Plain '), price: 5, qty: 2 })).json.id;
  const p = await shopPage(); assert.match(p.text(card(p, id).querySelector('.sub')), /^from £25\.00 · 3 left · pay within 5 days of claiming/); assert.equal(card(p, id).querySelector('[data-shop-options]'), null, 'no list of options on the card'); assert.equal(card(p, id).querySelectorAll('[data-shop-option]').length, 0);
  assert.equal(card(p, id).querySelectorAll('.stepper').length, 0, 'no steppers on an item with options'); assert.equal(p.text(card(p, id).querySelector('[data-act="shoppick"]')), 'Add to basket'); assert.match(p.text(card(p, cards).querySelector('.sub')), /^£3\.00 · 1 left/, 'one price: no "from"');
  assert.match(p.text(card(p, gone).querySelector('.sub')), /Sold out/); assert.equal(card(p, gone).querySelector('[data-act="shoppick"]'), null, 'nothing to add when everything is sold out');
  assert.ok(card(p, plain).querySelector('[data-act="shopinc"]'), 'an ordinary item keeps its own stepper'); assert.equal(card(p, plain).querySelector('[data-act="shoppick"]'), null); assert.deepEqual(p.errors, []); p.close();
});

test('"ADD TO BASKET" OPENS A CHOOSER: titled with the item, asking for the member / size / version you named, every option with its stock (and its own price only when it differs), sold-out ones disabled, NOTHING chosen for you and nothing to add until you choose', async () => {
  const id = await mk(u('Hoodie ')), cards = await mk(u('Photocards '), { price: 3, optionLabel: 'Member', options: [{ name: 'Han', qty: 4 }, { name: 'Felix', qty: 0 }] }); const p = await shopPage();
  await openPick(p, id); assert.match(p.text(pop(p).querySelector('h2')), /^Hoodie/); assert.equal(p.text(pop(p).querySelector('[data-pick-prompt]')), 'Choose a size'); assert.equal(pop(p).getAttribute('role'), 'dialog');
  const opt = (n) => pop(p).querySelector(`[data-pick-option="${n}"]`); assert.match(p.text(opt('L')), /^L2 left$/); assert.match(p.text(opt('M')), /^M£30\.00 · 1 left$/, 'the dearer size shows its price');
  assert.equal(pop(p).querySelectorAll('input[name="shoppick"]:checked').length, 0, 'nothing is chosen for you'); assert.equal(addBtn(p).disabled, true); assert.equal(p.text(addBtn(p)), 'Choose a size first'); assert.equal(pop(p).querySelector('.stepper'), null, 'no quantity until you have chosen');
  choose(p, 'M'); assert.equal(opt('M').classList.contains('on'), true); assert.equal(addBtn(p).disabled, false); assert.equal(p.text(addBtn(p)), 'Add to basket · £30.00'); assert.equal(pop(p).querySelector('[data-pick="inc"]').disabled, true, 'only 1 M, so no more'); assert.equal(pop(p).querySelector('[data-pick="dec"]').disabled, true);
  choose(p, 'L'); await plus(p); assert.equal(p.text(pop(p).querySelector('[data-pick-qty]')), '2'); assert.equal(p.text(addBtn(p)), 'Add to basket · £50.00', 'the price follows the amount'); assert.equal(pop(p).querySelector('[data-pick="inc"]').disabled, true, 'capped at the 2 L in stock'); choose(p, 'M'); assert.equal(p.text(pop(p).querySelector('[data-pick-qty]')), '1', 'changing option starts again at 1');
  p.q('.pcpop [data-pick="close"]').click(); await sleep(30); assert.equal(pop(p), null); await openPick(p, cards); assert.equal(p.text(pop(p).querySelector('[data-pick-prompt]')), 'Choose a member', 'it uses the name you gave the options'); assert.equal(opt('Felix').querySelector('input').disabled, true, 'a sold-out option can\'t be chosen'); assert.match(p.text(opt('Felix')), /^FelixSold out$/); assert.equal(opt('Han').querySelector('input').disabled, false);
  assert.equal(p.window.sessionStorage.getItem('sos_basket') || '[]', '[]', 'nothing was added by looking'); p.close();
});

test('THE CHOOSER CLOSES WITHOUT ADDING: ×, Cancel, tapping outside and Esc; going to another page also closes it', async () => {
  const id = await mk(u('Hoodie ')); const p = await shopPage(); const basket = () => JSON.parse(p.window.sessionStorage.getItem('sos_basket') || '[]').length;
  await openPick(p, id); choose(p, 'L'); await p.click(pop(p).querySelector('.pcpop-x')); assert.equal(pop(p), null, '×'); await openPick(p, id); await p.click(pop(p).querySelector('.btn-row .secondary')); assert.equal(pop(p), null, 'Cancel'); await openPick(p, id); await p.click(pop(p)); assert.equal(pop(p), null, 'tapping outside');
  await openPick(p, id); p.window.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(pop(p), null, 'Esc'); await openPick(p, id); p.window.location.hash = '#/basket'; await sleep(100); assert.equal(pop(p), null, 'another page'); assert.equal(basket(), 0, 'nothing was added by any of that'); p.close();
});

test('ADDING FROM THE CHOOSER: the chosen option and amount go in the basket (and a toast says so); the card then says what is in your basket; an option you have all of is greyed out next time; the basket has one line per option at its own price', async () => {
  const id = await mk(u('Hoodie ')); const p = await shopPage(); await addOpt(p, id, 'L', 2); assert.equal(pop(p), null, 'the chooser closes'); assert.match(toast(p), /^Added 2 × “Hoodie \d*” — L to your basket\.$/);
  assert.equal(p.text(card(p, id).querySelector('[data-shop-in-basket]')), 'In your basket: L ×2'); assert.equal(p.text(p.q('#basketPill')), 'Basket (2) · £50.00');
  await openPick(p, id); const l = pop(p).querySelector('[data-pick-option="L"]'); assert.equal(l.querySelector('input').disabled, true, 'both L are already in the basket'); assert.match(p.text(l), /^LAll of them are in your basket$/); assert.match(p.text(pop(p).querySelector('[data-pick-option="M"]')), /^M£30\.00 · 1 left$/); p.q('.pcpop [data-pick="close"]').click(); await sleep(30);
  await addOpt(p, id, 'M'); assert.equal(p.text(card(p, id).querySelector('[data-shop-in-basket]')), 'In your basket: L ×2, M ×1'); await goBasket(p);
  const lines = p.qa('#view .card .itemrow').filter((r) => /Hoodie/.test(p.text(r))).map((r) => p.text(r)); assert.equal(lines.length, 2); assert.match(lines[0], /Hoodie \d* — L/); assert.match(lines[0], /£25\.00 each/); assert.match(lines[1], /— M/); assert.match(lines[1], /£30\.00 each/); assert.match(p.text(p.q('#view')), /Total£80\.00/); p.close();
});

test('AN OPTION THAT IS PART-WAY IN YOUR BASKET: the chooser says how many are left and how many you have, and only lets you add what is still available', async () => {
  const id = await mk(u('Tee '), { options: [{ name: 'L', qty: 3 }] }); const p = await shopPage(); await addOpt(p, id, 'L', 2);
  await openPick(p, id); const l = pop(p).querySelector('[data-pick-option="L"]'); assert.match(p.text(l), /^L3 left · 2 in your basket$/); assert.equal(l.querySelector('input').disabled, false, 'one more can still be added'); choose(p, 'L');
  assert.equal(pop(p).querySelector('[data-pick="inc"]').disabled, true, 'only 1 more is possible'); assert.equal(p.text(addBtn(p)), 'Add to basket · £25.00'); await p.click(addBtn(p)); await sleep(60); await p.settle(); assert.equal(p.text(card(p, id).querySelector('[data-shop-in-basket]')), 'In your basket: L ×3');
  await openPick(p, id); assert.match(p.text(pop(p).querySelector('[data-pick-option="L"]')), /^LAll of them are in your basket$/); p.close();
});

test('CLAIMING SENDS THE OPTIONS: each claim is for its option at its price; the basket is cleared; the same option again asks first — naming only that option — and "No" removes just that line', async () => {
  const id = await mk(u('Hoodie '), { options: [{ name: 'L', qty: 5 }, { name: 'M', qty: 5, price: 30 }] }); const h = u('buyer'); const p = await shopPage(); await addOpt(p, id, 'L'); await goBasket(p);
  p.q('#ig').value = h; await p.submit(p.q('form[data-form="claim"]')); await sleep(450); await p.settle(); assert.deepEqual(await claims(h, id), [['L', 25]]); p.close();
  const q = await shopPage(); await addOpt(q, id, 'L'); await addOpt(q, id, 'M'); await goBasket(q); q.q('#ig').value = h; await q.submit(q.q('form[data-form="claim"]')); await sleep(450); await q.settle();
  const msg = q.text(q.q('#view')); assert.match(msg, /You already have 1 × .* — L — claim another\?/); assert.doesNotMatch(msg, /1 × .* — M/, 'M is not a repeat'); assert.equal((await claims(h, id)).length, 1, 'nothing was added yet');
  await q.click(q.q('[data-act="dup-no"]')); await sleep(100); await q.settle(); const after = q.text(q.q('#view')); assert.match(after, /— M/, 'the M line is still there'); assert.doesNotMatch(after, /— L/, 'only the repeat (L) was taken out'); assert.equal((await claims(h, id)).length, 1); q.close();
  const r = await shopPage(); await addOpt(r, id, 'M'); await goBasket(r); r.q('#ig').value = h; await r.submit(r.q('form[data-form="claim"]')); await sleep(450); await r.settle(); assert.deepEqual(await claims(h, id), [['L', 25], ['M', 30]], 'a different option is simply claimed'); r.close();
});

test('IF THE STOCK CHANGES UNDER YOU: a claim that loses the race says it sold out, and the chooser then shows that option as sold out', async () => {
  const id = await mk(u('Hoodie ')); const p = await shopPage(); await addOpt(p, id, 'M'); await goBasket(p);
  assert.equal((await app.api('POST', '/api/claims', { handle: u('fast'), lines: [{ leftoverId: id, member: 'M' }] })).status, 201, 'someone else takes the last M'); p.q('#ig').value = u('slow'); await p.submit(p.q('form[data-form="claim"]')); await sleep(450); await p.settle();
  assert.match(p.text(p.q('#view')), /has sold out/); assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims WHERE leftover_item_id = ? AND status <> 'cancelled'", [id]))[0].n, 1, 'only the fast one got it'); p.close();
  const q = await shopPage(); await openPick(q, id); const m = pop(q).querySelector('[data-pick-option="M"]'); assert.equal(m.querySelector('input').disabled, true, 'M is sold out for everyone now'); assert.match(q.text(m), /^M£30\.00 · Sold out$/); q.close();
});

test('NAMES WITH HTML ARE SHOWN AS TEXT (item and option names) — on the card, in the chooser and in the basket', async () => {
  const id = await mk('<img src=x onerror="window.pwned=1"> Tee', { options: [{ name: '<b>XL</b>', qty: 1 }] }); const p = await shopPage();
  assert.equal(p.q('img[src="x"]', card(p, id)), null); assert.equal(p.q('b', card(p, id)), null); assert.equal(p.window.pwned, undefined); await openPick(p, id); assert.equal(p.q('.pcpop img[src="x"]'), null); assert.equal(p.q('.pcpop b'), null); assert.ok(p.text(pop(p)).includes('<b>XL</b>'), 'the option name is shown as text');
  choose(p, '<b>XL</b>'); await p.click(addBtn(p)); await sleep(60); await p.settle(); assert.ok(p.text(card(p, id).querySelector('[data-shop-in-basket]')).includes('<b>XL</b> ×1')); await goBasket(p); assert.equal(p.q('#view b'), null); assert.ok(p.text(p.q('#view')).includes('— <b>XL</b>')); p.close();
});

test('A BASKET SAVED EARLIER IS BROUGHT UP TO DATE when the page loads: too many are cut to what is left, a sold-out option or a removed one drops out, and a changed price is refreshed', async () => {
  const id = await mk(u('Hoodie '), { options: [{ name: 'L', qty: 2 }, { name: 'M', qty: 0 }, { name: 'S', qty: 3, price: 40 }] }); const t = (await api('GET', '/api/admin/shop')).json.items.find((i) => i.id === id).title;
  const line = (option, qty, price) => ({ key: `shop:${id}:${option}`, shopId: id, option, orderTitle: 'Shop (on hand)', title: t, label: `${t} — ${option}`, price, qty, payDays: 5 });
  const saved = [line('L', 5, 25), line('M', 1, 30), line('S', 1, 99), line('Gone', 1, 25)];
  const p = await openPage(app, '/', { init: (win) => win.sessionStorage.setItem('sos_basket', JSON.stringify(saved)) }); await sleep(300); await p.settle(); p.window.location.hash = '#/basket'; await sleep(150); await p.settle();
  const b = JSON.parse(p.window.sessionStorage.getItem('sos_basket')); assert.deepEqual(b.map((l) => [l.option, l.qty, l.price]), [['L', 2, 25], ['S', 1, 40]], 'L cut to the 2 left; M (sold out) and Gone (removed) dropped; S\'s price refreshed'); p.close();
});
