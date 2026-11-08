import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startApp, seed, joinerSession } from './helpers.js';
import { openPage } from './ui.helpers.js';

// THE BUYER'S POP-UP: arrows to the previous / next AVAILABLE card; the price tag is short; the X on a taken card is a drawing.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'pn') => `${x}${++N}`;
const photo = () => sharp({ create: { width: 1200, height: 800, channels: 3, background: '#446' } }).png().toBuffer();
const putBoard = async (bundleId, title) => { const r = await fetch(`${app.base}/api/admin/card-bundles/${bundleId}/boards?title=${encodeURIComponent(title)}`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: await photo() }); assert.equal(r.status, 201); return (await r.json()).board; };
const row = (n, prices, qtys = []) => prices.slice(0, n).map((price, i) => ({ x: 0.02 + i * 0.24, y: 0.05, w: 0.2, h: 0.3, qty: qtys[i] || 1, price }));
// boards: [{ title, boxes }]
async function live(boards) {
  const b = (await api('POST', '/api/admin/card-bundles', { title: u('Nav '), groupId: w.group })).json.id; const made = [];
  for (const bd of boards) { const board = await putBoard(b, bd.title); assert.equal((await api('PUT', `/api/admin/card-boards/${board.id}/boxes`, { boxes: bd.boxes })).status, 200); made.push(board); }
  assert.equal((await api('PATCH', `/api/admin/card-bundles/${b}`, { status: 'open' })).status, 200); const boxes = []; for (const board of made) boxes.push(...(await api('GET', `/api/admin/card-boards/${board.id}`)).json.boxes.map((x) => ({ ...x, boardId: board.id })));
  return { b, boxes, at: (i, n) => boxes.find((x) => x.boardId === made[i].id && x.number === n) };
}
const take = async (L, i, n) => { const h = u('other'), c = await joinerSession(app, `${h}@x.com`, h); assert.equal((await api('POST', '/api/claims', { handle: h, lines: [{ itemId: L.at(i, n).itemId }] }, c)).status, 201); };
const go = async (p, hash) => { p.window.location.hash = hash; await sleep(60); await p.settle(); await sleep(60); await p.settle(); };
const open = async (p, L, i, n) => { await p.click(p.q(`.hot[data-box="${L.at(i, n).id}"]`)); };
const title = (p) => p.text(p.q('.pcpop h2')), pos = (p) => p.text(p.q('[data-pop-pos]'));
const key = (p, k) => p.window.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
const site = async (L) => { const p = await openPage(app, '/'); await go(p, `#/cards/bundle/${L.b}`); return p; };

test('ARROWS MOVE THROUGH THE AVAILABLE CARDS: next and previous skip taken cards, cross from one board to the next, wrap round at both ends, and say where you are', async () => {
  const L = await live([{ title: 'Board A', boxes: row(4, [3, 4, 5, 6]) }, { title: 'Board B', boxes: row(2, [7, 2.5]) }]); await take(L, 0, 3); await take(L, 1, 2);   // A#3 and B#2 are taken: four cards remain (A#1, A#2, A#4, B#1)
  const p = await site(L); await open(p, L, 0, 1); assert.equal(title(p), 'Card 1 · Board A'); assert.equal(pos(p), '1 of 4 still available'); assert.ok(p.q('.pcnav.prev') && p.q('.pcnav.next'));
  const next = async () => { await p.click(p.q('[data-cact="pop-next"]')); }, prev = async () => { await p.click(p.q('[data-cact="pop-prev"]')); };
  await next(); assert.deepEqual([title(p), pos(p)], ['Card 2 · Board A', '2 of 4 still available']); await next(); assert.deepEqual([title(p), pos(p)], ['Card 4 · Board A', '3 of 4 still available'], 'card 3 is taken, so it is skipped');
  await next(); assert.deepEqual([title(p), pos(p)], ['Card 1 · Board B', '4 of 4 still available'], 'on to the next board'); await next(); assert.deepEqual([title(p), pos(p)], ['Card 1 · Board A', '1 of 4 still available'], 'wraps round to the first');
  await prev(); assert.deepEqual([title(p), pos(p)], ['Card 1 · Board B', '4 of 4 still available'], 'and back round to the last'); await prev(); assert.equal(title(p), 'Card 4 · Board A'); await prev(); assert.equal(title(p), 'Card 2 · Board A'); assert.equal(p.qa('.pcpop').length, 1, 'still one pop-up');
  assert.equal(p.text(p.q('[data-pop-price]')), '£4.00'); assert.equal(p.q('.pcpop img').getAttribute('src'), L.at(0, 2).crop.url, 'the picture changes with the card'); assert.deepEqual(p.errors, []); p.close();
});

test('THE ARROW KEYS DO THE SAME, and Esc still closes', async () => {
  const L = await live([{ title: 'Board A', boxes: row(3, [3, 4, 5]) }]); await take(L, 0, 2); const p = await site(L); await open(p, L, 0, 1);
  key(p, 'ArrowRight'); assert.equal(title(p), 'Card 3 · Board A', 'the right arrow key goes to the next available card (card 2 is taken)'); key(p, 'ArrowRight'); assert.equal(title(p), 'Card 1 · Board A'); key(p, 'ArrowLeft'); assert.equal(title(p), 'Card 3 · Board A'); key(p, 'Escape'); assert.equal(p.q('.pcpop'), null); p.close();
});

test('YOUR BASKET FOLLOWS YOU: moving to a card that is already in the basket shows its amount and "Update basket"; adding works on the card you moved to; a multi-copy card keeps its stepper limit', async () => {
  const L = await live([{ title: 'Board A', boxes: row(3, [3, 4, 5], [1, 3, 1]) }]); const p = await site(L);
  await open(p, L, 0, 2); await p.click(p.q('[data-cact="pop-inc"]')); await p.click(p.q('[data-cact="pop-save"]')); assert.equal(p.text(p.q('#basketPill')), 'Basket (2) · £8.00');
  await open(p, L, 0, 1); await p.click(p.q('[data-cact="pop-next"]')); assert.equal(title(p), 'Card 2 · Board A'); assert.equal(p.text(p.q('[data-pop-qty]')), '2', 'the amount already in the basket'); assert.equal(p.text(p.q('[data-cact="pop-save"]')), 'Update basket'); assert.ok(p.q('[data-cact="pop-remove"]'));
  for (let i = 0; i < 4; i++) await p.click(p.q('[data-cact="pop-inc"]')); assert.equal(p.text(p.q('[data-pop-qty]')), '3', 'capped at the 3 copies');
  await p.click(p.q('[data-cact="pop-next"]')); assert.equal(title(p), 'Card 3 · Board A'); assert.equal(p.q('[data-cact="pop-inc"]'), null, 'one copy: no stepper'); assert.equal(p.text(p.q('[data-cact="pop-save"]')), 'Add to basket'); await p.click(p.q('[data-cact="pop-save"]'));
  assert.equal(p.q('.pcpop'), null); assert.equal(p.text(p.q('#basketPill')), 'Basket (3) · £13.00', 'card 3 was added, card 2 stayed at 2 (the stepper wasn\'t saved when you moved on)'); p.close();
});

test('WITH ONLY ONE CARD LEFT THERE ARE NO ARROWS AND NO COUNTER (and the arrow keys do nothing)', async () => {
  const L = await live([{ title: 'Board A', boxes: row(2, [3, 4]) }]); await take(L, 0, 2); const p = await site(L); await open(p, L, 0, 1); assert.equal(p.q('.pcnav'), null); assert.equal(p.q('[data-pop-pos]'), null); key(p, 'ArrowRight'); assert.equal(title(p), 'Card 1 · Board A'); p.close();
});

test('THE PRICE TAG IS SHORT AND THE X IS A DRAWING: £3 for a whole price, £2.50 otherwise (the full price stays in the accessible label); a taken card has an SVG X of two lines that carries its own size', async () => {
  const L = await live([{ title: 'Board A', boxes: row(3, [3, 2.5, 8]) }]); await take(L, 0, 3); const p = await site(L);
  const hot = (n) => p.q(`.hot[data-box="${L.at(0, n).id}"]`); assert.equal(p.text(hot(1).querySelector('.ptag')), '£3'); assert.equal(p.text(hot(2).querySelector('.ptag')), '£2.50'); assert.match(hot(1).getAttribute('aria-label'), /£3\.00/); assert.match(hot(2).getAttribute('aria-label'), /£2\.50/);
  const x = hot(3).querySelector('svg.xmark'); assert.ok(x, 'a taken card has the X drawing'); assert.equal(x.getAttribute('viewBox'), '0 0 100 100'); assert.equal(x.querySelectorAll('path').length, 2, 'a dark outline and a white line'); assert.deepEqual([...x.querySelectorAll('path')].map((q) => q.getAttribute('class')), ['xo', 'xi']);
  assert.match(x.getAttribute('style'), /width:100%/); assert.match(x.getAttribute('style'), /height:100%/); assert.equal(hot(1).querySelector('svg.xmark'), null, 'only taken cards have it'); assert.equal(hot(3).disabled, true); p.close();
});
