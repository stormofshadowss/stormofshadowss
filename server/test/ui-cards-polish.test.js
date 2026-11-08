import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startApp, seed, joinerSession } from './helpers.js';
import { openPage, gomPage } from './ui.helpers.js';

// CARDS polish on screen: a card's picture in the buyer's basket; the pay-by date on the confirmation page; card pictures in the GOM's Claims tab; the Claims section on a bundle's page.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'up') => `${x}${++N}`;
const photo = () => sharp({ create: { width: 1200, height: 800, channels: 3, background: '#446' } }).png().toBuffer();
const putBoard = async (bundleId, title) => { const r = await fetch(`${app.base}/api/admin/card-bundles/${bundleId}/boards${title ? `?title=${encodeURIComponent(title)}` : ''}`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: await photo() }); assert.equal(r.status, 201); return (await r.json()).board; };
const box = (i, extra = {}) => ({ x: 0.05 + i * 0.3, y: 0.05, w: 0.25, h: 0.3, qty: 1, price: 3 + i, ...extra });
async function live({ onHand = true, payDays = 6, boards = [[box(0), box(1)]] } = {}) {
  const title = u('Bundle '), b = (await api('POST', '/api/admin/card-bundles', { title, groupId: w.group, onHand, payDays })).json.id; const made = [];
  for (const [i, boxes] of boards.entries()) { const bd = await putBoard(b, `Board ${String.fromCharCode(65 + i)}`); assert.equal((await api('PUT', `/api/admin/card-boards/${bd.id}/boxes`, { boxes })).status, 200); made.push(bd); }
  assert.equal((await api('PATCH', `/api/admin/card-bundles/${b}`, { status: 'open' })).status, 200); const boxes = []; for (const bd of made) boxes.push(...(await api('GET', `/api/admin/card-boards/${bd.id}`)).json.boxes.map((x) => ({ ...x, boardId: bd.id })));
  return { b, title, boards: made, at: (i, n) => boxes.find((x) => x.boardId === made[i].id && x.number === n) };
}
const person = async (h) => ({ h, cookie: await joinerSession(app, `${h}@x.com`, h) });
const claim = (p, itemId, qty = 1) => api('POST', '/api/claims', { handle: p.h, lines: [{ itemId, qty }] }, p.cookie);
const inDays = async (n) => (await app.q(`SELECT DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL ${n} DAY), '%Y-%m-%d') AS d`))[0].d;
const go = async (p, hash) => { p.window.location.hash = hash; await sleep(60); await p.settle(); await sleep(60); await p.settle(); };
const view = (p) => p.text(p.q('#view'));
const addCard = async (p, L, boardIdx, n) => { await go(p, `#/cards/bundle/${L.b}`); await p.click(p.q(`.hot[data-box="${L.at(boardIdx, n).id}"]`)); await p.click(p.q('[data-cact="pop-save"]')); };
const putPic = async (kind, id) => (await fetch(`${app.base}/api/admin/images/${kind}/${id}`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: await photo() })).status;
const submit = async (p, handle) => { p.q('#ig').value = handle; await p.submit(p.q('form[data-form="claim"]')); await sleep(450); await p.settle(); };

test('THE BASKET SHOWS A CARD\'S PICTURE (and an ordinary item has none); the confirmation page says when to pay for cards held at once, and nothing for a pre-order', async () => {
  const L = await live({ payDays: 6 }), plain = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: u('Plain thing '), price: 2 })).json.id; assert.equal(await putPic('item', plain), 200, 'the ordinary item has its own picture');
  const p = await openPage(app, '/'); await addCard(p, L, 0, 1); await go(p, `#/order/${w.order}`); await p.click(p.q(`[data-act="inc"][data-item="${plain}"]`)); await go(p, '#/basket');
  const rows = p.qa('.itemrow'); const cardRow = rows.find((r) => r.textContent.includes(L.title)), plainRow = rows.find((r) => r.textContent.includes('Plain thing')); assert.ok(cardRow && plainRow);
  assert.equal(cardRow.querySelector('img[data-card-thumb]').getAttribute('src'), L.at(0, 1).crop.thumb, 'the card\'s own picture'); assert.equal(plainRow.querySelector('img[data-card-thumb]'), null, 'an ordinary item is unchanged — even though it has a picture');
  await submit(p, u('buyer')); assert.equal(p.window.location.hash, '#/done'); const expected = `Pay by ${p.window.SITE.fmtDate(await inDays(6))} for what is held for you right away (cards in hand and shop items) — My orders shows how to pay.`; assert.equal(p.text(p.q('[data-pay-by]')), expected); p.close();
  const P = await live({ onHand: false }); const q = await openPage(app, '/'); await addCard(q, P, 0, 1); await go(q, '#/basket'); await submit(q, u('buyer')); assert.equal(q.window.location.hash, '#/done'); assert.equal(q.q('[data-pay-by]'), null, 'a pre-order has no date yet'); assert.match(view(q), /Claims submitted/); q.close();
});

test('THE GOM\'S CLAIMS TAB SHOWS A CARD\'S PICTURE on its row (also when identical claims are merged into one line); ordinary claims have none', async () => {
  const L = await live({ boards: [[box(0, { qty: 2 }), box(1)]] }); const amy = await person(u('amy')); assert.equal((await claim(amy, L.at(0, 1).itemId, 2)).status, 201); assert.equal((await claim(amy, L.at(0, 2).itemId)).status, 201);
  const plain = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: u('Plain '), price: 2 })).json.id; assert.equal(await putPic('item', plain), 200); assert.equal((await claim(amy, plain)).status, 201);
  const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', 'Claims')); await sleep(250); await p.settle(); await p.type(p.q('[data-filter="q"]'), amy.h); await p.settle();
  const imgs = p.qa('img[data-card-thumb]'); assert.deepEqual(imgs.map((i) => i.getAttribute('src')).sort(), [L.at(0, 1).crop.thumb, L.at(0, 2).crop.thumb].sort(), 'the merged ×2 line and the single card each show their picture');
  const plainRow = p.qa('tr').find((tr) => tr.textContent.includes('Plain ') && tr.matches('[data-claim], [data-group]')); assert.ok(plainRow); assert.equal(plainRow.querySelector('img[data-card-thumb]'), null, 'an ordinary claim has no picture'); p.close();
});

test('A BUNDLE\'S CLAIMS SECTION: who has which cards (picture, number, price), ticked once paid, what they owe, a summary, a board filter, and an empty state', async () => {
  const L = await live({ boards: [[box(0, { qty: 2 }), box(1)], [box(0, { price: 5 })]] }); const empty = await live();
  const amy = await person(u('amy')), ben = await person(u('ben')); const a1 = (await claim(amy, L.at(0, 1).itemId)).json.claimIds[0]; assert.equal((await claim(amy, L.at(1, 1).itemId)).status, 201); assert.equal((await claim(ben, L.at(0, 1).itemId)).status, 201); await api('PATCH', `/api/admin/claims/${a1}`, { costs: { initials: { paid: 3 } } });
  const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', 'Cards')); await sleep(250); await p.settle(); await p.click(p.q(`[data-bundle="${L.b}"] [data-act="open-bundle"]`)); await sleep(350); await p.settle();
  assert.match(p.text(p.q('[data-claims-summary]')), /^3 cards claimed by 2 people · £3\.00 paid · £8\.00 owed$/); const rows = p.qa('[data-claimer]'); assert.deepEqual(rows.map((r) => r.dataset.claimer), [amy.h, ben.h], 'alphabetical');
  const amyRow = rows[0]; assert.deepEqual([...amyRow.querySelectorAll('.cthumb b')].map((b) => p.text(b)), ['#1 £3.00', '#1 £5.00']); assert.deepEqual([...amyRow.querySelectorAll('.cthumb img')].map((i) => i.getAttribute('src')), [L.at(0, 1).crop.thumb, L.at(1, 1).crop.thumb]);
  assert.equal(amyRow.querySelectorAll('.cthumb i').length, 1, 'only the paid card is ticked'); assert.match(amyRow.querySelector('.cthumb[data-claim]').getAttribute('title'), /^Board A · #1 · £3\.00 · paid$/); assert.equal(p.text(amyRow.querySelector('[data-owed]')), '£5.00 owed'); assert.equal(p.text(rows[1].querySelector('[data-owed]')), '£3.00 owed'); assert.equal(rows[1].querySelector('[data-paid]'), null);
  await p.choose(p.q('#claimBoard'), String(L.boards[1].id)); assert.deepEqual(p.qa('[data-claimer]').map((r) => r.dataset.claimer), [amy.h], 'only people with a card on that board'); assert.equal(p.qa('[data-claimer] .cthumb').length, 1); await p.choose(p.q('#claimBoard'), ''); assert.equal(p.qa('[data-claimer]').length, 2);
  await api('PATCH', `/api/admin/claims/${(await api('GET', `/api/admin/claims?handle=${amy.h}`)).json.claims.find((c) => c.label.endsWith('#1') && c.label.includes('Board B')).id}`, { costs: { initials: { paid: 5 } } }); await p.click(p.byText('button', '← All bundles')); await sleep(250); await p.settle(); await p.click(p.q(`[data-bundle="${L.b}"] [data-act="open-bundle"]`)); await sleep(350); await p.settle();
  assert.ok(p.q('[data-claimer] [data-paid]'), 'fully paid people get a ✓ Paid chip'); assert.equal(p.text(p.q(`[data-claimer="${amy.h}"] [data-paid]`)), '✓ Paid');
  await p.click(p.byText('button', '← All bundles')); await sleep(250); await p.settle(); await p.click(p.q(`[data-bundle="${empty.b}"] [data-act="open-bundle"]`)); await sleep(350); await p.settle(); assert.equal(p.text(p.q('[data-no-claims]')), 'No claims yet.'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('A PRE-ORDER BUNDLE\'S CLAIMS SECTION says they are waiting for you to secure them (and that nothing is owed yet); securing turns it into what they owe', async () => {
  const L = await live({ onHand: false }); const dee = await person(u('dee')); const id = (await claim(dee, L.at(0, 1).itemId)).json.claimIds[0];
  const open = async () => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', 'Cards')); await sleep(250); await p.settle(); await p.click(p.q(`[data-bundle="${L.b}"] [data-act="open-bundle"]`)); await sleep(350); await p.settle(); return p; };
  const p = await open(); assert.match(p.text(p.q('[data-claims-summary]')), /^1 card claimed by 1 person · £0\.00 paid · £0\.00 owed · 1 waiting for you to secure$/); assert.equal(p.text(p.q('[data-waiting]')), 'waiting to be secured'); assert.equal(p.q('[data-paid]'), null, 'not "paid" just because nothing is owed yet'); assert.equal(p.q('[data-owed]'), null); assert.match(p.q('.cthumb[data-claim]').getAttribute('title'), /waiting for you to secure it$/); p.close();
  assert.equal((await api('PATCH', `/api/admin/claims/${id}`, { status: 'confirmed' })).status, 200); const q = await open(); assert.equal(q.q('[data-waiting]'), null); assert.equal(q.text(q.q('[data-owed]')), '£3.00 owed'); q.close();
});
