import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startApp, seed, joinerSession } from './helpers.js';

// CARDS polish: a card claim carries its picture in the Claims tab data; the claim response says when to pay; who-has-what per bundle; and the packing list shows the card's picture.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'cp') => `${x}${++N}`;
const photo = () => sharp({ create: { width: 1200, height: 800, channels: 3, background: '#446' } }).png().toBuffer();
const putBoard = async (bundleId, title) => { const r = await fetch(`${app.base}/api/admin/card-bundles/${bundleId}/boards${title ? `?title=${encodeURIComponent(title)}` : ''}`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: await photo() }); assert.equal(r.status, 201); return (await r.json()).board; };
const box = (i, extra = {}) => ({ x: 0.05 + i * 0.3, y: 0.05, w: 0.25, h: 0.3, qty: 1, price: 3 + i, ...extra });
// a published bundle; `boards` is a list of box lists (one board each)
async function live({ onHand = true, payDays = 5, boards = [[box(0), box(1)]], title = u('Bundle ') } = {}) {
  const b = (await api('POST', '/api/admin/card-bundles', { title, groupId: w.group, onHand, payDays })).json.id; const made = [];
  for (const [i, boxes] of boards.entries()) { const bd = await putBoard(b, `Board ${String.fromCharCode(65 + i)}`); assert.equal((await api('PUT', `/api/admin/card-boards/${bd.id}/boxes`, { boxes })).status, 200); made.push(bd); }
  assert.equal((await api('PATCH', `/api/admin/card-bundles/${b}`, { status: 'open' })).status, 200);
  const boxes = []; for (const bd of made) boxes.push(...(await api('GET', `/api/admin/card-boards/${bd.id}`)).json.boxes.map((x) => ({ ...x, boardId: bd.id })));
  return { b, title, boards: made, boxes, at: (boardIdx, n) => boxes.find((x) => x.boardId === made[boardIdx].id && x.number === n), orderId: (await api('GET', '/api/admin/cards')).json.bundles.find((x) => x.id === b).orderId };
}
const person = async (h) => ({ h, cookie: await joinerSession(app, `${h}@x.com`, h) });
const claim = (p, itemId, qty = 1) => api('POST', '/api/claims', { handle: p.h, lines: [{ itemId, qty }] }, p.cookie);
const pay = (claimId, amount) => api('PATCH', `/api/admin/claims/${claimId}`, { costs: { initials: { paid: amount } } });
const inDays = async (n) => (await app.q(`SELECT DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL ${n} DAY), '%Y-%m-%d') AS d`))[0].d;
const putPic = async (kind, id) => (await fetch(`${app.base}/api/admin/images/${kind}/${id}`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: await photo() })).status;
const theirs = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;

test('THE CLAIMS TAB DATA CARRIES A CARD\'S PICTURE (its crop, thumbnail size) — and nothing for an ordinary claim; the raw file name isn\'t exposed', async () => {
  const L = await live(); const p = await person(u('amy')); assert.equal((await claim(p, L.at(0, 1).itemId)).status, 201);
  const plain = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: u('Plain '), price: 2 })).json.id; assert.equal(await putPic('item', plain), 200, 'the ordinary item HAS a picture of its own'); assert.equal((await claim(p, plain)).status, 201);
  const rows = await theirs(p.h); const card = rows.find((c) => c.label.includes(L.title)), other = rows.find((c) => !c.label.includes(L.title));
  assert.equal(card.cardThumb, L.at(0, 1).crop.thumb, 'the card\'s own picture'); assert.equal(other.cardThumb, null, 'an ordinary claim has none — even though its item has a picture'); assert.ok(!('cardFile' in card), 'the file name is not part of the output');
  assert.equal((await fetch(app.base + card.cardThumb)).status, 200);
});

test('THE CLAIM RESPONSE SAYS WHEN TO PAY: the earliest pay-by date of what was held for them at once (cards in hand); nothing for requests that wait to be secured or for an ordinary order', async () => {
  const A = await live({ payDays: 3 }), B = await live({ payDays: 9 }), C = await live({ onHand: false }); const p = await person(u('ben'));
  const one = await claim(p, A.at(0, 1).itemId); assert.equal(one.json.payBy, await inDays(3), 'in hand: confirmed at once, so there is a date');
  const both = await api('POST', '/api/claims', { handle: p.h, lines: [{ itemId: B.at(0, 1).itemId }, { itemId: A.at(0, 2).itemId }] }, p.cookie); assert.equal(both.json.payBy, await inDays(3), 'the earliest of the two');
  const pre = await claim(p, C.at(0, 1).itemId); assert.equal(pre.status, 201); assert.equal(pre.json.payBy, null, 'a pre-order waits to be secured: no date yet');
  const plain = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: u('Plain '), price: 2 })).json.id; assert.equal((await claim(p, plain)).json.payBy, null, 'an ordinary group order: no date');
});

test('WHO HAS WHAT IN A BUNDLE (GOM): one row per person, alphabetical, with each card\'s picture, board, number and price; paid cards are marked; what they owe; cancelled claims left out; summary totals', async () => {
  const L = await live({ boards: [[box(0, { qty: 2 }), box(1)], [box(0, { price: 5 })]] }); const amy = await person(u('amy')), ben = await person(u('ben')), cat = await person(u('cat'));
  const b1 = (await claim(ben, L.at(0, 1).itemId)).json.claimIds[0]; assert.equal((await claim(amy, L.at(1, 1).itemId)).status, 201); const a1 = (await claim(amy, L.at(0, 1).itemId)).json.claimIds[0]; const c1 = (await claim(cat, L.at(0, 2).itemId)).json.claimIds[0];   // ben claimed FIRST, but amy sorts first; amy took Board B's card before Board A's
  assert.equal((await pay(a1, 3)).status, 200); assert.equal((await pay(b1, 1)).status, 200, 'ben has paid only part'); await app.q("UPDATE claims SET status = 'cancelled' WHERE id = ?", [c1]); assert.equal((await claim(amy, L.at(0, 2).itemId)).status, 201, 'amy then takes Board A\'s #2, freed by cat\'s cancelled claim');
  const r = await api('GET', `/api/admin/card-bundles/${L.b}/claims`); assert.equal(r.status, 200, r.text); const j = r.json;
  assert.deepEqual(j.people.map((p) => p.handle), [amy.h, ben.h], 'alphabetical; cat\'s only claim was cancelled so she isn\'t listed');
  const A = j.people[0]; assert.deepEqual(A.cards.map((c) => [c.boardTitle, c.number, c.price, c.paidUp, c.status]), [['Board A', 1, 3, true, 'confirmed'], ['Board A', 2, 4, false, 'confirmed'], ['Board B', 1, 5, false, 'confirmed']], 'board by board, then by number — not in the order she claimed them'); assert.equal(A.owed, 9);
  assert.deepEqual(A.cards.map((c) => c.thumb), [L.at(0, 1).crop.thumb, L.at(0, 2).crop.thumb, L.at(1, 1).crop.thumb]); assert.deepEqual([j.people[1].owed, j.people[1].cards[0].paidUp], [2, false], 'part paid is not paid up, and still owes the rest');
  assert.deepEqual(j.summary, { cards: 4, people: 2, paid: 4, owed: 11, waiting: 0 }); assert.equal(JSON.stringify(j).includes(cat.h), false, 'a person with only cancelled claims is nowhere in it');
});

test('A PRE-ORDER BUNDLE: claims waiting to be secured say so, owe nothing yet, and are counted as waiting; securing one makes it owe', async () => {
  const L = await live({ onHand: false }); const p = await person(u('dee')); const id = (await claim(p, L.at(0, 1).itemId)).json.claimIds[0];
  let j = (await api('GET', `/api/admin/card-bundles/${L.b}/claims`)).json; assert.deepEqual([j.people[0].waiting, j.people[0].owed, j.people[0].cards[0].status, j.people[0].cards[0].paidUp, j.summary.waiting, j.summary.owed], [1, 0, 'requested', false, 1, 0]);
  assert.equal((await api('PATCH', `/api/admin/claims/${id}`, { status: 'confirmed' })).status, 200); j = (await api('GET', `/api/admin/card-bundles/${L.b}/claims`)).json; assert.deepEqual([j.people[0].waiting, j.people[0].owed, j.summary.waiting, j.summary.owed], [0, 3, 0, 3]);
});

test('THE CLAIMS-BY-BUNDLE ENDPOINT: GOM only; an unknown bundle is 404; a draft or unclaimed bundle gives an empty list', async () => {
  const L = await live(); const j = await person(u('zed')); assert.equal((await api('GET', `/api/admin/card-bundles/${L.b}/claims`, undefined, j.cookie)).status, 403); assert.equal((await app.api('GET', `/api/admin/card-bundles/${L.b}/claims`)).status, 401); assert.equal((await api('GET', '/api/admin/card-bundles/999999/claims')).status, 404);
  assert.deepEqual((await api('GET', `/api/admin/card-bundles/${L.b}/claims`)).json, { people: [], summary: { cards: 0, people: 0, paid: 0, owed: 0, waiting: 0 } }); const dr = (await api('POST', '/api/admin/card-bundles', { title: u('Draft '), groupId: w.group })).json.id; assert.deepEqual((await api('GET', `/api/admin/card-bundles/${dr}/claims`)).json.people, []);
});

test('THE PACKING LIST SHOWS A CARD\'S PICTURE: a paid on-hand card, requested for shipping, appears in Packing with its own crop', async () => {
  const L = await live(); const h = u('eve'), p = await person(h); await api('PUT', '/api/my/address', { fullName: 'Eve Test', address: '12 Test Street, Leeds, LS1 1AA', email: `${h}@x.com`, phone: '07700 900123' }, p.cookie);
  const id = (await claim(p, L.at(0, 1).itemId)).json.claimIds[0]; assert.equal((await pay(id, 3)).status, 200); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' });
  const r = await api('POST', `/api/my/parcels?handle=${h}`, { claimIds: [id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p.cookie); assert.equal(r.status, 201, r.text);
  const parcel = (await api('GET', '/api/admin/packing?status=requested')).json.parcels.find((x) => x.id === r.json.id); const item = parcel.items[0]; assert.equal(item.image.thumb, L.at(0, 1).crop.thumb, 'the packer sees the card itself'); assert.match(item.label, new RegExp(`${L.title} — Board A — #1`));
});
