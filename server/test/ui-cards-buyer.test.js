import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startApp, seed, joinerSession } from './helpers.js';
import { openPage } from './ui.helpers.js';

// THE BUYER'S SIDE of Cards: the home page's Photocards card, the Cards page (groups and open bundles), a bundle's boards with a tag on every card, the pop-up, the basket and claim.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'bu') => `${x}${++N}`;
const photo = () => sharp({ create: { width: 1200, height: 800, channels: 3, background: '#446' } }).png().toBuffer();
const putBoard = async (bundleId, title) => { const r = await fetch(`${app.base}/api/admin/card-bundles/${bundleId}/boards${title ? `?title=${encodeURIComponent(title)}` : ''}`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: await photo() }); assert.equal(r.status, 201); return (await r.json()).board; };
const box = (i, extra = {}) => ({ x: 0.05 + i * 0.3, y: 0.05, w: 0.25, h: 0.3, qty: 1, price: 3 + i, ...extra });
async function live({ onHand = true, boxes = [box(0), box(1, { qty: 2 }), box(2)], groupId = w.group, title = u('Bundle '), boardTitle, note } = {}) {
  const b = (await api('POST', '/api/admin/card-bundles', { title, groupId, onHand, payDays: 6 })).json.id; const bd = await putBoard(b, boardTitle);
  const s = await api('PUT', `/api/admin/card-boards/${bd.id}/boxes`, { boxes: boxes.map((x, i) => (i === 0 && note ? { ...x, note } : x)) }); assert.equal(s.status, 200, s.text);
  const p = await api('PATCH', `/api/admin/card-bundles/${b}`, { status: 'open' }); assert.equal(p.status, 200, p.text);
  const bx = (await api('GET', `/api/admin/card-boards/${bd.id}`)).json.boxes; const orderId = (await api('GET', '/api/admin/cards')).json.bundles.find((x) => x.id === b).orderId;
  return { b, bd, title, orderId, boxes: bx, boxOf: (n) => bx.find((x) => x.number === n) };
}
const person = async (h = u('p')) => ({ h, cookie: await joinerSession(app, `${h}@x.com`, h) });
const claim = (p, itemId, qty = 1) => api('POST', '/api/claims', { handle: p.h, lines: [{ itemId, qty }] }, p.cookie);
const site = (opts) => openPage(app, '/', opts);
const go = async (p, hash) => { p.window.location.hash = hash; await sleep(60); await p.settle(); await sleep(60); await p.settle(); };
const hot = (p, id) => p.q(`.hot[data-box="${id}"]`);
const view = (p) => p.text(p.q('#view'));
const pct = (el, prop) => parseFloat(el.style[prop]);

test('THE HOME PAGE OFFERS PHOTOCARDS ONLY WHEN A BUNDLE IS OPEN; the card order is not among the group orders', async () => {
  const p0 = await site(); assert.equal(p0.q('[data-cards-home]'), null, 'nothing open: no Photocards card'); p0.close();
  const L = await live(); const p = await site(); const card = p.q('[data-cards-home]'); assert.ok(card); assert.equal(p.text(card), 'Single photocards1 open bundle · 4 cards left'); assert.equal(p.q(`a.ocard[data-order="${L.orderId}"]`), null, 'not shown as a group order'); assert.ok(!view(p).includes(L.title));
  await p.click(card); await sleep(60); await p.settle(); assert.equal(p.window.location.hash, '#/cards'); assert.deepEqual(p.errors, []); p.close();
});

test('THE CARDS PAGE: the open bundles with their group, counts and whether they are in hand or pre-order; tapping a group narrows it; closed and draft ones are not there', async () => {
  const g2 = (await api('POST', '/api/admin/groups', { name: u('ATE '), members: ['A'] })).json.id; const A = await live({ title: u('Hand ') }), B = await live({ title: u('Pre '), onHand: false, groupId: g2 }); const closed = await live(); await api('PATCH', `/api/admin/card-bundles/${closed.b}`, { status: 'closed' });
  const p = await site(); await go(p, '#/cards'); const cards = p.qa('.ocard[data-bundle]'); assert.ok(cards.length >= 2);
  const a = p.q(`.ocard[data-bundle="${A.b}"]`), b = p.q(`.ocard[data-bundle="${B.b}"]`); assert.match(p.text(a), new RegExp(`^${A.title}.* · 3 cards · 4 left.*In hand — claim now$`)); assert.match(p.text(b), /Pre-order$/); assert.equal(p.q(`.ocard[data-bundle="${closed.b}"]`), null, 'a closed bundle is not listed');
  assert.ok(p.qa('#cardGroups .avatar-link').length >= 2, 'a group tile for each group with something open'); await p.click(p.q(`#cardGroups [data-cgroup="${g2}"]`)); await sleep(60); await p.settle();
  assert.ok(p.q(`.ocard[data-bundle="${B.b}"]`) && !p.q(`.ocard[data-bundle="${A.b}"]`), 'only that group\'s bundle'); assert.match(p.text(p.q('[data-showing]')), /^Showing .* · show every group$/); await p.click(p.q('[data-showing] a')); await sleep(60); await p.settle(); assert.ok(p.q(`.ocard[data-bundle="${A.b}"]`) && p.q(`.ocard[data-bundle="${B.b}"]`), 'all groups again'); p.close();
});

test('A BUNDLE\'S BOARD: a tag on every card, an X (and not clickable) on taken ones, a fill circle for cards with several copies, nobody\'s name anywhere; signed in you see only YOUR picks', async () => {
  const L = await live({ boxes: [box(0, { qty: 4 }), box(1), box(2, { qty: 3 })], boardTitle: 'Binder 1' }); const a = await person(), b = await person();
  assert.equal((await claim(a, L.boxOf(2).itemId)).status, 201); assert.equal((await claim(b, L.boxOf(1).itemId)).status, 201); // card 1 (4 copies): ONE taken; card 2 (1 copy): taken; card 3 (3 copies): untouched
  const p = await site(); await go(p, `#/cards/bundle/${L.b}`); assert.equal(p.qa('.hot').length, 3); assert.match(p.text(p.q('h1')), new RegExp(`^${L.title}$`)); assert.match(p.text(p.q('[data-how]')), /^These cards are in hand\. Claim and you owe straight away — pay within 6 days\./);
  const h1 = hot(p, L.boxOf(1).id), h2 = hot(p, L.boxOf(2).id), h3 = hot(p, L.boxOf(3).id);
  assert.match(h1.getAttribute('aria-label'), /^Card 1 on Binder 1, £3\.00, 3 of 4 left$/); assert.equal(h1.querySelector('.fill').getAttribute('style'), '--p:25', 'one of four taken: a quarter full (what is TAKEN, not what is left)'); assert.ok(h1.classList.contains('part') && !h1.disabled);
  assert.ok(h2.classList.contains('gone') && h2.disabled && h2.querySelector('.xmark'), 'a taken card is dimmed with an X and can\'t be tapped'); assert.match(h2.getAttribute('aria-label'), /taken$/); assert.ok(!h3.classList.contains('gone') && !h3.disabled && !h3.classList.contains('part') && !h3.querySelector('.fill'), 'an untouched card — even one with several copies — has no circle and is tappable'); assert.match(h3.getAttribute('aria-label'), /3 of 3 left$/);
  assert.ok(Math.abs(pct(h1, 'left') - 5) < 0.01 && Math.abs(pct(h1, 'width') - 25) < 0.01, 'placed by the card\'s fractions'); assert.equal(p.text(h1.querySelector('.ptag')), '£3', 'a whole-pound price is short on the card (the full £3.00 is in the pop-up and the accessible label)');
  for (const x of [a, b]) assert.ok(!view(p).includes(x.h) && !p.q('#view').innerHTML.includes(x.h), 'no handle appears'); assert.equal(p.qa('.hot.mine').length, 0, 'signed out: nothing is "yours"'); await p.click(h2); assert.equal(p.q('.pcpop'), null, 'tapping a taken card does nothing'); p.close();
  const pa = await site({ cookies: [a.cookie] }); await go(pa, `#/cards/bundle/${L.b}`); const mine = pa.qa('.hot.mine'); assert.equal(mine.length, 1); assert.equal(mine[0].dataset.box, String(L.boxOf(2).id)); assert.equal(pa.text(mine[0].querySelector('.yours')), '✓ yours'); pa.close();
  const pb = await site({ cookies: [b.cookie] }); await go(pb, `#/cards/bundle/${L.b}`); assert.deepEqual(pb.qa('.hot.mine').map((e) => e.dataset.box), [String(L.boxOf(1).id)], 'each person sees only their own'); pb.close();
});

test('THE POP-UP: the card close up with price and copies left; a stepper limited by what is left; Add / Update / Remove basket; Esc, the × and the backdrop close it', async () => {
  const L = await live({ boxes: [box(0, { qty: 3, price: 4 }), box(1, { price: 2.5 })], note: 'corner ding' }); const p = await site(); await go(p, `#/cards/bundle/${L.b}`);
  const h1 = hot(p, L.boxOf(1).id); await p.click(h1); const pop = p.q('.pcpop'); assert.ok(pop); assert.equal(pop.querySelector('img').getAttribute('src'), L.boxOf(1).crop.url); assert.equal(p.text(p.q('[data-pop-price]')), '£4.00'); assert.equal(p.text(p.q('[data-pop-left]')), '3 of 3 left'); assert.equal(p.text(p.q('[data-pop-note]')), 'corner ding');
  assert.equal(p.text(p.q('[data-pop-qty]')), '1'); for (let i = 0; i < 4; i++) await p.click(p.q('[data-cact="pop-inc"]')); assert.equal(p.text(p.q('[data-pop-qty]')), '3', 'can\'t take more than are left'); await p.click(p.q('[data-cact="pop-dec"]')); await p.click(p.q('[data-cact="pop-inc"]'));
  await p.click(p.q('[data-cact="pop-save"]')); assert.equal(p.q('.pcpop'), null, 'closed after adding'); assert.equal(p.text(p.q('#basketPill')), 'Basket (3) · £12.00'); assert.equal(p.text(p.q('#pcBar')), 'Review basket (3) · £12.00'); assert.equal(p.text(hot(p, L.boxOf(1).id).querySelector('.inb')), '×3 in basket'); assert.match(hot(p, L.boxOf(1).id).getAttribute('aria-label'), /, 3 in your basket$/);
  await p.click(hot(p, L.boxOf(1).id)); assert.equal(p.text(p.q('[data-cact="pop-save"]')), 'Update basket'); assert.ok(p.q('[data-cact="pop-remove"]')); await p.click(p.q('[data-cact="pop-dec"]')); await p.click(p.q('[data-cact="pop-save"]')); assert.equal(p.text(p.q('#basketPill')), 'Basket (2) · £8.00');
  await p.click(hot(p, L.boxOf(1).id)); await p.click(p.q('[data-cact="pop-remove"]')); assert.equal(p.q('#basketPill').textContent.trim(), '', 'removed'); assert.equal(hot(p, L.boxOf(1).id).querySelector('.inb'), null);
  const single = hot(p, L.boxOf(2).id); await p.click(single); assert.equal(p.text(p.q('[data-pop-left]')), 'Only 1 — first come, first served'); assert.equal(p.q('[data-cact="pop-inc"]'), null, 'one copy: no stepper'); p.window.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(p.q('.pcpop'), null, 'Esc closes');
  await p.click(single); await p.click(p.q('.pcpop-x')); assert.equal(p.q('.pcpop'), null, '× closes'); await p.click(single); await p.click(p.q('.pcpop')); assert.equal(p.q('.pcpop'), null, 'the backdrop closes'); assert.deepEqual(p.errors, []); p.close();
});

test('CLAIMING: pick a card, review the basket, claim with a handle — an on-hand card is confirmed at once and shows as taken; a card taken meanwhile is refused with the reason', async () => {
  const L = await live({ boxes: [box(0, { price: 2 }), box(1, { price: 5 })] }); const p = await site(); await go(p, `#/cards/bundle/${L.b}`); await p.click(hot(p, L.boxOf(1).id)); await p.click(p.q('[data-cact="pop-save"]'));
  await go(p, '#/basket'); assert.match(view(p), new RegExp(`${L.title} — Board 1 — #1`)); assert.match(view(p), /£2\.00/); const handle = u('claimer'); p.q('#ig').value = handle; await p.submit(p.q('form[data-form="claim"]')); await sleep(400); await p.settle();
  assert.equal(p.window.location.hash, '#/done'); assert.match(view(p), /Claims submitted/); const claims = (await api('GET', `/api/admin/claims?handle=${handle}`)).json.claims; assert.equal(claims.length, 1); assert.deepEqual([claims[0].status, claims[0].orderTitle], ['confirmed', L.title], 'confirmed at once, under the bundle\'s name');
  await go(p, `#/cards/bundle/${L.b}`); const taken = hot(p, L.boxOf(1).id); assert.ok(taken.classList.contains('gone') && taken.disabled, 'now shown as taken'); assert.ok(!p.q('#pcBoards').innerHTML.includes(handle), 'and the board says nothing about who');
  await p.click(hot(p, L.boxOf(2).id)); await p.click(p.q('[data-cact="pop-save"]')); const other = await person(); assert.equal((await claim(other, L.boxOf(2).itemId)).status, 201, 'someone else takes it first'); await go(p, '#/basket'); p.q('#ig').value = u('late'); await p.submit(p.q('form[data-form="claim"]')); await sleep(400); await p.settle();
  assert.match(view(p), /purchase limit|Only 0 left|isn't available/i, 'told why'); assert.equal(p.window.location.hash, '#/basket', 'still on the basket'); p.close();
});

test('THE FADE SLIDER AND ZOOM: how visible taken cards stay is remembered; zoom steps 100 → 150 → 200 and back', async () => {
  const L = await live({ boxes: [box(0), box(1)] }); const a = await person(); await claim(a, L.boxOf(1).itemId); const p = await site(); await go(p, `#/cards/bundle/${L.b}`);
  assert.equal(p.text(p.q('#fadeVal')), '25'); assert.match(p.q('#pcBoards').getAttribute('style'), /--gone-dim:0\.75/); const s = p.q('#cardFade'); s.value = '60'; s.dispatchEvent(new p.window.Event('input', { bubbles: true }));
  assert.equal(p.text(p.q('#fadeVal')), '60'); assert.match(p.q('#pcBoards').getAttribute('style'), /--gone-dim:0\.4/); assert.equal(p.window.sessionStorage.getItem('sos_cards_fade'), '60'); await go(p, '#/cards'); await go(p, `#/cards/bundle/${L.b}`); assert.equal(p.q('#cardFade').value, '60', 'remembered');
  const width = () => p.q('.pccanvas').style.width; assert.equal(width(), '100%'); await p.click(p.q('[data-cact="zoom-in"]')); assert.equal(width(), '150%'); assert.equal(p.text(p.q('#zoomLabel')), '150%'); await p.click(p.q('[data-cact="zoom-in"]')); assert.equal(width(), '200%'); await p.click(p.q('[data-cact="zoom-out"]')); assert.equal(width(), '150%'); p.close();
});

test('A BUNDLE THAT ISN\'T OPEN, AND THE OLD ORDER LINK: closed, draft and unknown bundles say so; the card order\'s own page points to the cards instead of listing every item', async () => {
  const L = await live(); await api('PATCH', `/api/admin/card-bundles/${L.b}`, { status: 'closed' }); const dr = (await api('POST', '/api/admin/card-bundles', { title: u('Draft '), groupId: w.group })).json.id; const O = await live();
  const p = await site(); for (const id of [L.b, dr, 999999]) { await go(p, `#/cards/bundle/${id}`); assert.match(p.text(p.q('[data-not-open]')), /^That bundle isn't open\.$/, `bundle ${id}`); }
  await go(p, `#/order/${O.orderId}`); assert.match(view(p), new RegExp(`“${O.title}” is a photocard bundle\\.`)); assert.equal(p.q('#view a[href="#/cards/bundle/' + O.b + '"]') !== null, true); assert.equal(p.q('.itemgrid'), null, 'not a long list of items'); p.close();
});

test('TITLES AND NOTES WITH HTML ARE SHOWN AS TEXT everywhere on the Cards pages', async () => {
  const evil = '<img src=x onerror="window.pwned=1"><b>bold</b>'; const L = await live({ title: evil, boardTitle: evil, note: evil }); const p = await site();
  for (const hash of ['#/cards', `#/cards/bundle/${L.b}`]) { await go(p, hash); assert.equal(p.q('#view img[src="x"]'), null, hash); assert.equal(p.q('#view b'), null, hash); }
  assert.ok(view(p).includes(evil), 'shown as text'); await p.click(p.q('.hot')); assert.equal(p.q('.pcpop img[src="x"]'), null); assert.ok(p.text(p.q('[data-pop-note]')).includes(evil)); assert.equal(p.window.pwned, undefined); p.close();
});
