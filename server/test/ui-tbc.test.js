import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';
import { gomPage, openPage, press, toast } from './ui.helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p, sel = '#tabBody') => p.text(p.q(sel));
const go = async (p, hash) => { p.window.location.hash = hash; await sleep(30); await p.settle(); };
async function order(title) { return (await api('POST', '/api/admin/orders', { groupId: w.group, title: `${title} ${++N}` })).json.id; }
const mk = async (go_, body) => (await api('POST', `/api/admin/orders/${go_}/items`, { type: 'normal', title: `TBC item ${++N}`, ...body })).json.id;
const shop = (opts) => openPage(app, '/', opts);
const plus = async (p, id, { member, variant } = {}) => p.click(p.q(`[data-act="inc"][data-item="${id}"]${member ? `[data-member="${member}"]` : ''}${variant ? `[data-variant="${variant}"]` : ''}`));
const submit = async (p, handle) => { p.q('#ig').value = handle; await p.submit(p.q('form[data-form="claim"]')); };
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const claimSet = (h, item, ...parts) => app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: item, parts: parts.map((member) => ({ member, qty: 1 })) }] });

// ───────────── the GOM: item forms ─────────────
test('GOM: ticking "price to be confirmed" switches the price box off and clears it; unticking brings it back', async () => {
  const go_ = await order('Form');
  const p = await gomPage(app, admin);
  await p.click(p.q(`[data-act="open-items"][data-id="${go_}"]`));
  const form = () => p.q('form[data-form="new-item"]');
  const price = () => form().elements.price, box = () => form().elements.priceTbc;
  assert.equal(price().disabled, false); assert.equal(price().required, true);
  price().value = '12'; await p.click(box());
  assert.deepEqual([price().disabled, price().required, price().value], [true, false, ''], 'off, not required, and cleared so an old number can\'t linger');
  await p.click(box());
  assert.deepEqual([price().disabled, price().required], [false, true]);
  assert.match(p.text(form()), /Tick TBC if you're hosting before the price is final/);
  p.close();
});

test('GOM: an item added with TBC has no price; one with neither a price nor TBC is refused and NEVER becomes a £0.00 item', async () => {
  const go_ = await order('Add');
  const p = await gomPage(app, admin);
  await p.click(p.q(`[data-act="open-items"][data-id="${go_}"]`));
  const form = () => p.q('form[data-form="new-item"]');
  p.fill(form(), { title: 'Mystery album' }); await p.submit(form());
  assert.match(p.text(p.q('[data-msg]', form())), /Enter a price, or tick "price to be confirmed"/);
  assert.equal((await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go_).items.length, 0, 'nothing was created — in particular no £0.00 item');
  p.fill(form(), { title: 'Mystery album', priceTbc: true }); await p.submit(form());
  const it = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go_).items[0];
  assert.deepEqual([it.title, it.price, it.priceTbc], ['Mystery album', null, true]);
  assert.match(p.text(p.byText('#itemsPanel tbody tr', 'Mystery album')), /Mystery album.*TBC/);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('GOM: editing — a TBC item opens ticked with the price off; entering a price confirms it and the waiting claims follow; ticking TBC again sends them back', async () => {
  const go_ = await order('Edit'); const item = await mk(go_, { priceTbc: true });
  await app.api('POST', '/api/claims', { handle: 'tbc_ed1', lines: [{ itemId: item }] }); await app.api('POST', '/api/claims', { handle: 'tbc_ed2', lines: [{ itemId: item }] });
  const p = await gomPage(app, admin);
  await p.click(p.q(`[data-act="open-items"][data-id="${go_}"]`));
  await p.click(p.q(`[data-act="edit-item"][data-id="${item}"]`));
  let f = p.q('form[data-form="edit-item"]');
  assert.deepEqual([f.elements.priceTbc.checked, f.elements.price.disabled, f.elements.price.value], [true, true, '']);
  assert.match(p.text(p.q('[data-price-note]', f)), /Tick TBC if the price isn't final yet.*nothing can be secured until you set a price/);
  await p.click(f.elements.priceTbc); f.elements.price.value = '14'; await p.submit(f);
  assert.match(toast(p), /Saved — 2 unsecured claims now use the new price\. Secured claims keep theirs\./);
  assert.equal((await api('GET', '/api/admin/claims?handle=tbc_ed1')).json.claims[0].costs.initials.cost, 14);
  await p.click(p.q(`[data-act="edit-item"][data-id="${item}"]`));
  f = p.q('form[data-form="edit-item"]');
  assert.deepEqual([f.elements.priceTbc.checked, f.elements.price.value], [false, '14'], 'a priced item opens with its price');
  await p.click(f.elements.priceTbc); await p.submit(f);
  assert.match(toast(p), /Saved — 2 unsecured claims are now marked price TBC\. Secured claims keep theirs\./);
  assert.deepEqual((await claimsOf('tbc_ed1')).map((c) => [c.priceTbc, c.costs.initials.cost]), [[true, 0]]);
  p.close();
});

// ───────────── the GOM: Sets and Claims tabs ─────────────
test('GOM Sets: TBC parts show as TBC, "Secure" is off with the reason; setting the price turns it on', async () => {
  const go_ = await order('Sets'); const set = (await api('POST', `/api/admin/orders/${go_}/items`, { type: 'set', title: `TBC set ${++N}`, priceTbc: true, members: ['A', 'B', { name: 'Diary', price: 2 }] })).json.id;
  await claimSet('tbc_s1', set, 'A'); await claimSet('tbc_s2', set, 'Diary');
  const sid = (await api('GET', '/api/admin/sets')).json.sets.find((s) => s.itemId === set).id;
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Sets'));
  const card = () => p.q(`[data-set="${sid}"]`);
  const row = (m) => p.q(`tr[data-part="${m}"]`, card());
  assert.match(p.text(row('A')), /A.*TBC/); assert.match(p.text(row('Diary')), /Diary.*£2\.00/); assert.match(p.text(row('B')), /B.*TBC/);
  assert.equal(p.q('[data-act="secure"]', card()).disabled, true);
  assert.match(p.text(card()), /The price is still TBC — set it \(Group Orders → Items → Edit\) before this set can be secured\./);
  await api('PATCH', `/api/admin/items/${set}`, { price: 6 });
  await p.click(p.byText('#tabs button', 'Sets'));
  assert.equal(p.q('[data-act="secure"]', card()).disabled, false);
  assert.match(p.text(row('A')), /A.*£6\.00/);
  p.close();
});

test('GOM Sets: splitting an open part whose price is TBC says why instead of showing £0.00', async () => {
  const go_ = await order('Split'); const set = (await api('POST', `/api/admin/orders/${go_}/items`, { type: 'set', title: `Split set ${++N}`, price: 6, members: ['A', 'B', 'C'] })).json.id;
  await claimSet('tbc_sp1', set, 'A'); await claimSet('tbc_sp2', set, 'B');
  const sid = (await api('GET', '/api/admin/sets')).json.sets.find((s) => s.itemId === set).id;
  await api('POST', `/api/admin/sets/${sid}/secure`, {});
  await api('PATCH', `/api/admin/items/${set}`, { priceTbc: true });
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Sets'));
  await p.choose(p.q('[data-filter="decision"]'), 'secured');
  await p.click(p.q('[data-act="split"]', p.q(`[data-set="${sid}"] tr[data-part="C"]`)));
  assert.match(p.text(p.q('.ui-modal')), /That part's price is still TBC, so its cost can't be shared out yet/);
  p.close();
});

test('GOM Claims: TBC claims are labelled, counted separately, left out of "secure all", and the result says how many were left', async () => {
  const go_ = await order('Claims'); const priced = await mk(go_, { price: 7 }), tbc = await mk(go_, { priceTbc: true });
  await app.api('POST', '/api/claims', { handle: 'tbc_c1', lines: [{ itemId: priced }, { itemId: tbc }] });
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims'));
  const card = () => p.byText('#tabBody .card', `Claims ${N}`);
  assert.match(p.text(card()), /2 claims · 1 waiting to be secured · 1 waiting for a price \(TBC\)/);
  assert.match(p.text(card()), /Secure all requested \(1\)/, 'only the priced claim is counted');
  await p.click(p.q('[data-act="toggle"]', card()));
  assert.ok(p.qa('tr', card()).some((r) => /Price TBC/.test(p.text(r))), 'the TBC claim is labelled');
  assert.ok(p.qa('tr', card()).some((r) => /Initials £7\.00/.test(p.text(r)) && !/Price TBC/.test(p.text(r))), 'and the priced one is not');
  await p.click(p.byText('button', 'Secure all requested (1)', card()));
  await press(p, 'Secure them');
  assert.match(toast(p), /Secured 1 claim\./);
  assert.deepEqual((await claimsOf('tbc_c1')).map((c) => c.status).sort(), ['confirmed', 'requested']);
  p.close();
});

// ───────────── what joiners see ─────────────
test('joiners see "Price TBC" — never £0.00 — on every kind of item, including set parts and the whole-set button', async () => {
  const go_ = await order('Joiner');
  await mk(go_, { priceTbc: true });
  await mk(go_, { type: 'independent', priceTbc: true, members: ['Han', 'Felix'] });
  await mk(go_, { type: 'size', priceTbc: true, variants: ['M', 'L'] });
  await mk(go_, { type: 'random', priceTbc: true });
  await mk(go_, { price: 5 });
  await mk(go_, { type: 'set', priceTbc: true, members: ['A', 'B', { name: 'Diary', price: 2 }] });
  const p = await shop(); await go(p, `#/order/${go_}`);
  const view = p.text(p.q('#view'));
  assert.doesNotMatch(view, /£0\.00/, 'a TBC price is never shown as £0.00');
  assert.equal((view.match(/Price TBC/g) || []).length >= 8, true, `Price TBC appears for each TBC item and part (${(view.match(/Price TBC/g) || []).length})`);
  assert.match(view, /A Price TBC · 0 claimed.*B Price TBC · 0 claimed.*Diary £2\.00 · 0 claimed/s);
  assert.ok(p.byText('button', 'Claim the whole set (price TBC, all in one set)'));
  assert.match(view, /£5\.00 each/, 'the priced item is unchanged');
  p.close();
});

test('the basket adds up only what is known, says what is TBC, and the claims are submitted as requests', async () => {
  const go_ = await order('Basket'); const tbc = await mk(go_, { priceTbc: true }), priced = await mk(go_, { price: 6 });
  const p = await shop(); await go(p, `#/order/${go_}`);
  await plus(p, priced); await plus(p, tbc); await plus(p, tbc);
  assert.match(p.text(p.q('#basketPill')), /Basket \(3\) · £6\.00 \+ 2 TBC/);
  await go(p, '#/basket');
  const t = p.text(p.q('#view'));
  assert.match(t, /Price TBC.*TBC.*Total£6\.00 \+ 2 TBC/s);
  assert.match(t, /Price TBC: the price of 2 items are still to be confirmed\. You won't owe anything for them until the price is set and the GOM confirms your claim\./);
  assert.doesNotMatch(t, /£0\.00/);
  await submit(p, '@Tbc_Buyer');
  const done = p.text(p.q('#view'));
  assert.match(done, /Total £6\.00 \+ 2 TBC\. Items marked Price TBC cost nothing until their price is confirmed/);
  assert.match(done, /2 × TBC item.*Price TBC/s);
  assert.deepEqual((await claimsOf('tbc_buyer')).map((c) => [c.status, c.priceTbc, c.costs.initials.cost]).sort(), [['requested', false, 6], ['requested', true, 0], ['requested', true, 0]]);
  p.close();
  const q = await shop(); await go(q, `#/order/${go_}`); await plus(q, tbc);
  assert.match(q.text(q.q('#basketPill')), /Basket \(1\) · 1 TBC/, 'only TBC items: no misleading £0.00 total');
  await go(q, '#/basket');
  assert.match(q.text(q.q('#view')), /Price TBC: the price of one item is still to be confirmed\. You won't owe anything for it/);
  q.close();
});

test('a set selection with TBC parts totals the known parts and counts the rest', async () => {
  const go_ = await order('SetSel'); const set = await mk(go_, { type: 'set', priceTbc: true, members: ['A', 'B', { name: 'Diary', price: 2 }] });
  const p = await shop(); await go(p, `#/order/${go_}`);
  await plus(p, set, { member: 'A' }); await plus(p, set, { member: 'Diary' });
  assert.match(p.text(p.q('#view')), /Selected: A, Diary — £2\.00 \+ 1 TBC/);
  p.close();
});

test('a basket saved before the price was set picks up the real price when the page loads', async () => {
  const go_ = await order('Saved'); const item = await mk(go_, { priceTbc: true });
  let p = await shop(); await go(p, `#/order/${go_}`); await plus(p, item);
  const saved = p.window.sessionStorage.getItem('sos_basket'); p.close();
  assert.match(saved, /"price":null/);
  await api('PATCH', `/api/admin/items/${item}`, { price: 9.5 });
  p = await shop({ init: (win) => win.sessionStorage.setItem('sos_basket', saved) });
  await sleep(60); await p.settle();
  assert.match(p.text(p.q('#basketPill')), /Basket \(1\) · £9\.50/);
  p.close();
});

test('My orders: a TBC request reads "Price TBC — nothing to pay yet", then shows the real figures once it is priced and secured', async () => {
  const go_ = await order('Mine'); const item = await mk(go_, { priceTbc: true });
  const h = 'tbc_mine'; const c = await joinerSession(app, `${h}@x.com`, h);
  await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: item }] });
  let p = await openPage(app, '/my.html', { cookies: [c] });
  await go(p, '#/ongoing');
  assert.match(p.text(p.q('#view')), /Price TBC — nothing to pay yet/);
  assert.doesNotMatch(p.text(p.q('#view')), /Initials £0\.00/);
  p.close();
  await api('PATCH', `/api/admin/items/${item}`, { price: 11 }); await api('POST', '/api/admin/claims/secure', { orderId: go_ });
  p = await openPage(app, '/my.html', { cookies: [c] });
  await go(p, '#/ongoing');
  assert.match(p.text(p.q('#view')), /Initials £11\.00/); assert.doesNotMatch(p.text(p.q('#view')), /Price TBC/);
  p.close();
});

test('Fixed claims page: a TBC price is not shown as £0.00, and the swap dialog explains', async () => {
  const go_ = await order('Fixed'); const set = await mk(go_, { type: 'set', priceTbc: true, members: ['A', 'B'] });
  const h = 'tbc_fixed'; const c = await joinerSession(app, `${h}@x.com`, h);
  assert.equal((await api('POST', `/api/admin/items/${set}/fixed`, { handle: h, member: 'A' })).status, 201);
  const p = await openPage(app, '/my.html', { cookies: [c] }); await go(p, '#/fixed');
  assert.match(p.text(p.q('#view')), /Your fixed claim: A · Price TBC/);
  assert.doesNotMatch(p.text(p.q('#view')), /£0\.00/);
  await p.click(p.byText('button', 'Swap to the full set'));
  assert.match(p.text(p.q('.ui-modal')), /the whole set \(its price is still TBC\), instead of your fixed A \(price TBC\)/);
  p.close();
});
