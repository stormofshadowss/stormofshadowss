import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { startApp, seed, joinerSession } from './helpers.js';
import { readingOrder } from '../src/lib/card-layout.js';

// CARDS, slice 1: card types with default prices; bundles; boards (a spread photo each); boxes drawn on a board (a card each, with a price, a quantity and its own crop of the photo).
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'cd') => `${x}${++N}`;
const uploads = () => app.cfg.uploadsDir;
const files = () => fs.readdirSync(uploads());
// a photo with four coloured quadrants: red (top-left), green (top-right), blue (bottom-left), yellow (bottom-right)
const quadPhoto = async (width = 1200, height = 800) => { const hw = width / 2, hh = height / 2; const sq = (c) => ({ create: { width: hw, height: hh, channels: 3, background: c } });
  return sharp({ create: { width, height, channels: 3, background: '#000' } }).composite([{ input: await sharp(sq('#ff0000')).png().toBuffer(), left: 0, top: 0 }, { input: await sharp(sq('#00ff00')).png().toBuffer(), left: hw, top: 0 }, { input: await sharp(sq('#0000ff')).png().toBuffer(), left: 0, top: hh }, { input: await sharp(sq('#ffff00')).png().toBuffer(), left: hw, top: hh }]).png().toBuffer(); };
const putBoard = (bundleId, body, { title, cookie = admin, type = 'image/png' } = {}) => fetch(`${app.base}/api/admin/card-bundles/${bundleId}/boards${title ? `?title=${encodeURIComponent(title)}` : ''}`, { method: 'PUT', headers: { ...(cookie ? { cookie } : {}), 'X-Requested-With': 'sos', 'Content-Type': type }, body }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const bundle = async (extra = {}) => (await api('POST', '/api/admin/card-bundles', { title: u('Bundle '), groupId: w.group, ...extra })).json.id;
const board = async (bundleId, photo, title) => { const r = await putBoard(bundleId, photo || await quadPhoto(), { title }); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.board; };
const type = async (name = u('Type '), price = 4) => (await api('POST', '/api/admin/card-types', { name, price })).json.id;
const save = (boardId, boxes) => api('PUT', `/api/admin/card-boards/${boardId}/boxes`, { boxes });
const cardsData = async () => (await api('GET', '/api/admin/cards')).json;
const meanColour = async (url) => { const buf = Buffer.from(await (await fetch(app.base + url)).arrayBuffer()); const s = await sharp(buf).stats(); return s.channels.slice(0, 3).map((c) => Math.round(c.mean)); };

test('READING ORDER: row by row from the top, left to right in a row; a slightly crooked row still reads left to right; works for columns, single boxes and nothing', () => {
  const box = (x, y, w = 0.2, h = 0.2) => ({ x, y, w, h });
  const order = (boxes) => readingOrder(boxes).map((i) => i);
  assert.deepEqual(order([]), []); assert.deepEqual(order([box(0.5, 0.5)]), [0]);
  assert.deepEqual(order([box(0.6, 0.6), box(0.1, 0.1), box(0.6, 0.1), box(0.1, 0.6)]), [1, 2, 3, 0], 'top row then bottom row, each left to right');
  assert.deepEqual(order([box(0.62, 0.105), box(0.1, 0.12), box(0.36, 0.09)]), [1, 2, 0], 'a crooked row still reads left to right');
  assert.deepEqual(order([box(0.1, 0.7), box(0.1, 0.1), box(0.1, 0.4)]), [1, 2, 0], 'a single column reads top to bottom');
  const grid = []; for (let r = 0; r < 7; r++) for (let c = 0; c < 10; c++) grid.push(box(0.02 + c * 0.095, 0.02 + r * 0.135, 0.085, 0.12)); const shuffled = grid.map((b, i) => ({ b, k: (i * 37) % 70 })).sort((a, b) => a.k - b.k).map((x) => x.b);
  const sorted = readingOrder(shuffled).map((i) => shuffled[i]); assert.deepEqual(sorted.map((b) => `${b.x.toFixed(3)},${b.y.toFixed(3)}`), grid.map((b) => `${b.x.toFixed(3)},${b.y.toFixed(3)}`), '70 shuffled boxes come out row-major');
});

test('CARD TYPES: a name and a default price; names are unique; changing a price re-prices the cards that FOLLOW it (not ones with their own price); deleting a type keeps every price as it is', async () => {
  const t = await type(u('POB '), 4); assert.equal((await api('POST', '/api/admin/card-types', { name: (await cardsData()).types.find((x) => x.id === t).name, price: 3 })).status, 409);
  const bad = async (body) => assert.equal((await api('POST', '/api/admin/card-types', body)).status, 400, JSON.stringify(body)); await bad({ name: '', price: 3 }); await bad({ name: 'x', price: 0 }); await bad({ name: 'x', price: 1.234 });
  const b = await bundle(), bd = await board(b); const rs = await save(bd.id, [{ x: 0.05, y: 0.05, w: 0.2, h: 0.2, typeId: t, qty: 1 }, { x: 0.3, y: 0.05, w: 0.2, h: 0.2, typeId: t, qty: 2, priceOverride: true, price: 9 }, { x: 0.55, y: 0.05, w: 0.2, h: 0.2, typeId: t, qty: 1 }]); assert.equal(rs.status, 200, rs.text);
  assert.deepEqual(rs.json.boxes.map((x) => [x.price, x.priceOverride]), [[4, false], [9, true], [4, false]]);
  const up = await api('PATCH', `/api/admin/card-types/${t}`, { price: 5.5 }); assert.deepEqual([up.status, up.json.repriced], [200, 2], 'two cards followed the type'); const after = (await api('GET', `/api/admin/card-boards/${bd.id}`)).json.boxes; assert.deepEqual(after.map((x) => x.price), [5.5, 9, 5.5]);
  assert.equal((await api('DELETE', `/api/admin/card-types/${t}`)).status, 200); const gone = (await api('GET', `/api/admin/card-boards/${bd.id}`)).json.boxes; assert.deepEqual(gone.map((x) => [x.price, x.typeId, x.priceOverride]), [[5.5, null, true], [9, null, true], [5.5, null, true]], 'prices kept; they are now their own');
  assert.equal((await api('PATCH', '/api/admin/card-types/999999', { price: 3 })).status, 404);
});

test('BUNDLES: created as drafts, on hand by default with 5 days to pay; can be marked not on hand; fields are checked; they can be edited, published (only with a card on it), closed, re-opened and deleted', async () => {
  const id = await bundle({ description: 'Spring clear-out' }); const first = (await cardsData()).bundles.find((b) => b.id === id); assert.deepEqual([first.status, first.onHand, first.payDays, first.closesOn, first.groupName !== null, first.boards], ['draft', true, 5, null, true, []]);
  const bad = async (body, code) => { const r = await api('POST', '/api/admin/card-bundles', { title: 'x', ...body }); assert.equal(r.status, 400, JSON.stringify(body)); if (code) assert.equal(r.json.code, code); };
  await bad({ title: '' }); await bad({ closesOn: '2026-13-45' }); await bad({ closesOn: 'tomorrow' }); await bad({ payDays: 0 }); await bad({ payDays: 99 }); await bad({ groupId: 999999 }, 'no_such_group');
  assert.equal((await api('PATCH', `/api/admin/card-bundles/${id}`, { onHand: false, closesOn: '2027-01-31', payDays: 7, title: 'Renamed', description: null })).status, 200); const edited = (await cardsData()).bundles.find((b) => b.id === id); assert.deepEqual([edited.onHand, edited.closesOn, edited.payDays, edited.title, edited.description], [false, '2027-01-31', 7, 'Renamed', null]);
  const nothing = await api('PATCH', `/api/admin/card-bundles/${id}`, { status: 'open' }); assert.deepEqual([nothing.status, nothing.json.code], [409, 'nothing_to_sell']);
  const bd = await board(id); assert.equal((await api('PATCH', `/api/admin/card-bundles/${id}`, { status: 'open' })).status, 409, 'a board with no cards on it isn\'t enough'); assert.equal((await save(bd.id, [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3, qty: 1, price: 3 }])).status, 200);
  assert.equal((await api('PATCH', `/api/admin/card-bundles/${id}`, { status: 'open' })).status, 200); assert.equal((await api('PATCH', `/api/admin/card-bundles/${id}`, { status: 'closed' })).status, 200); assert.equal((await api('PATCH', `/api/admin/card-bundles/${id}`, { status: 'open' })).status, 200, 're-opened');
  const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await api('GET', '/api/admin/cards', undefined, j)).status, 403); assert.equal((await app.api('POST', '/api/admin/card-bundles', { title: 'x' })).status, 401);
  assert.equal((await api('PATCH', '/api/admin/card-bundles/999999', { title: 'x' })).status, 404); assert.equal((await api('PATCH', `/api/admin/card-bundles/${id}`, {})).status, 400);
  const before = files().length; assert.ok(before >= 5, 'display, thumb, source and a crop with its thumbnail exist'); assert.equal((await api('DELETE', `/api/admin/card-bundles/${id}`)).status, 200); assert.equal((await cardsData()).bundles.some((b) => b.id === id), false);
  assert.equal(files().length, before - 5, 'its photo copies and the card crop were deleted'); assert.equal((await app.q('SELECT COUNT(*) AS n FROM card_boards WHERE bundle_id = ?', [id]))[0].n, 0);
});

test('BOARD PHOTOS: a big photo is kept at full size for the crops and shown at 2400 px; boards are numbered and can be renamed; non-pictures and oversized files are refused; GOM only', async () => {
  const b = await bundle(); const photo = await quadPhoto(3600, 2400); const one = await board(b, photo), two = await board(b, await quadPhoto(), 'Binder 2'); assert.deepEqual([one.title, two.title], ['Board 1', 'Binder 2']);
  const dims = async (url) => { const m = await sharp(Buffer.from(await (await fetch(app.base + url)).arrayBuffer())).metadata(); return [m.width, m.height]; }; assert.deepEqual(await dims(one.image.url), [2400, 1600], 'the board shows at 2400 px'); assert.ok((await dims(one.image.thumb))[0] <= 480);
  const src = (await app.q('SELECT source_file AS f, width, height FROM card_boards WHERE id = ?', [one.id]))[0]; assert.deepEqual([src.width, src.height], [3600, 2400], 'the full-size copy is kept'); assert.equal((await sharp(path.join(uploads(), src.f)).metadata()).width, 3600);
  assert.equal((await api('PATCH', `/api/admin/card-boards/${one.id}`, { title: 'Page 1' })).status, 200); assert.equal((await api('GET', `/api/admin/card-boards/${one.id}`)).json.board.title, 'Page 1'); assert.equal((await api('PATCH', `/api/admin/card-boards/${one.id}`, { title: '' })).status, 400);
  const nope = await putBoard(b, Buffer.from('this is not a picture at all')); assert.deepEqual([nope.status, nope.json.code], [400, 'not_an_image']); const big = await putBoard(b, Buffer.alloc(26 * 1024 * 1024)); assert.deepEqual([big.status, big.json.code], [413, 'too_big']);
  const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await putBoard(b, photo, { cookie: j })).status, 403); assert.equal((await putBoard(b, photo, { cookie: null })).status, 401); assert.equal((await putBoard(999999, photo)).status, 404);
  const n = files().length; assert.equal((await api('DELETE', `/api/admin/card-boards/${two.id}`)).status, 200); assert.equal(files().length, n - 3, 'the photo copies were deleted'); assert.equal((await api('GET', `/api/admin/card-boards/${two.id}`)).status, 404);
});

test('DRAWING BOXES: each gets a number in reading order, a price (from its type, or its own), a quantity and its OWN CROP of the photo — the right part of it', async () => {
  const b = await bundle(), bd = await board(b); const t = await type(u('LD '), 6);
  const rs = await save(bd.id, [{ x: 0.55, y: 0.55, w: 0.3, h: 0.3, qty: 1, typeId: t }, { x: 0.05, y: 0.05, w: 0.3, h: 0.3, qty: 2, price: 3, note: 'corner ding' }, { x: 0.55, y: 0.05, w: 0.3, h: 0.3, qty: 1, typeId: t }, { x: 0.05, y: 0.55, w: 0.3, h: 0.3, qty: 1, price: 2.5 }]); assert.equal(rs.status, 200, rs.text); assert.equal(rs.json.cropped, 4);
  const bx = rs.json.boxes; assert.deepEqual(bx.map((x) => [x.number, x.price, x.qty, x.note]), [[1, 3, 2, 'corner ding'], [2, 6, 1, ''], [3, 2.5, 1, ''], [4, 6, 1, '']], 'numbered top-left, top-right, bottom-left, bottom-right');
  assert.deepEqual(bx.map((x) => x.priceOverride), [true, false, true, false]);
  const colours = await Promise.all(bx.map((x) => meanColour(x.crop.url))); assert.ok(colours[0][0] > 240 && colours[0][1] < 15, 'box 1 is the red quadrant'); assert.ok(colours[1][1] > 240 && colours[1][0] < 15, 'box 2 is the green one'); assert.ok(colours[2][2] > 240 && colours[2][0] < 15, 'box 3 is the blue one'); assert.ok(colours[3][0] > 240 && colours[3][1] > 240 && colours[3][2] < 15, 'box 4 is the yellow one');
  assert.equal((await fetch(app.base + bx[0].crop.thumb)).status, 200); assert.match((await fetch(app.base + bx[0].crop.url)).headers.get('content-type'), /image\/webp/);
});

test('SAVING AGAIN: boxes keep their ids; ones that haven\'t moved keep their crop (nothing is re-cut); a moved one gets a new crop and the old file is deleted; a removed one\'s crop is deleted', async () => {
  const b = await bundle(), bd = await board(b); const first = (await save(bd.id, [{ x: 0.05, y: 0.05, w: 0.3, h: 0.3, qty: 1, price: 3 }, { x: 0.55, y: 0.05, w: 0.3, h: 0.3, qty: 1, price: 3 }, { x: 0.05, y: 0.55, w: 0.3, h: 0.3, qty: 1, price: 3 }])).json.boxes;
  const same = await save(bd.id, first.map((x) => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h, qty: x.qty, price: x.price }))); assert.deepEqual([same.json.cropped, same.json.boxes.map((x) => x.id), same.json.boxes.map((x) => x.crop.url)], [0, first.map((x) => x.id), first.map((x) => x.crop.url)], 'nothing was re-cut');
  const n = files().length; const moved = await save(bd.id, [{ ...first[0], qty: 5 }, { id: first[1].id, x: 0.55, y: 0.55, w: 0.3, h: 0.3, qty: 1, price: 3 }].map((x) => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h, qty: x.qty, price: x.price }))); assert.equal(moved.status, 200, moved.text); assert.equal(moved.json.cropped, 1, 'only the moved one'); assert.equal(moved.json.boxes.length, 2);
  const m = moved.json.boxes.find((x) => x.id === first[1].id), k = moved.json.boxes.find((x) => x.id === first[0].id); assert.notEqual(m.crop.url, first[1].crop.url); assert.equal(k.crop.url, first[0].crop.url); assert.equal(k.qty, 5);
  assert.equal(files().length, n - 2, 'the third box\'s crop (2 files) went; the moved one was replaced, not added'); assert.equal((await fetch(app.base + first[2].crop.url)).status, 404, 'a removed card\'s crop is gone'); assert.equal((await fetch(app.base + first[1].crop.url)).status, 404, 'a replaced crop is gone');
  const green = await meanColour(first[1].crop.url).catch(() => null); void green; assert.ok((await meanColour(m.crop.url))[0] > 200, 'the moved card now shows the yellow quadrant (bottom right)');
  assert.equal((await save(bd.id, [])).status, 200); assert.equal((await api('GET', `/api/admin/card-boards/${bd.id}`)).json.boxes.length, 0, 'a board can be cleared');
});

test('A WHOLE BINDER OF 70 CARDS (10 × 7) SAVES IN ONE GO: numbered 1–70 row by row, every card with its own crop, and saving again re-cuts nothing', async () => {
  const b = await bundle(), bd = await board(b, await quadPhoto(3000, 2100)); const t = await type(u('Mixed '), 3); const boxes = []; for (let r = 0; r < 7; r++) for (let c = 0; c < 10; c++) boxes.push({ x: 0.01 + c * 0.098, y: 0.01 + r * 0.14, w: 0.09, h: 0.13, qty: 1, typeId: t });
  const shuffled = boxes.map((x, i) => ({ x, k: (i * 31) % 70 })).sort((a, b) => a.k - b.k).map((o) => o.x); const rs = await save(bd.id, shuffled); assert.equal(rs.status, 200, rs.text); assert.equal(rs.json.cropped, 70);
  const byNumber = rs.json.boxes; assert.deepEqual(byNumber.map((x) => x.number), Array.from({ length: 70 }, (_, i) => i + 1)); const pos = (x) => `${x.x.toFixed(6)},${x.y.toFixed(6)}`; assert.deepEqual(byNumber.map(pos), boxes.map(pos), 'row by row, left to right');
  assert.equal(new Set(byNumber.map((x) => x.crop.url)).size, 70, 'every card has its own picture'); const again = await save(bd.id, byNumber.map((x) => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h, qty: 1, typeId: t }))); assert.equal(again.json.cropped, 0);
  const listed = (await cardsData()).bundles.find((x) => x.id === b).boards[0]; assert.deepEqual([listed.cards, listed.copies], [70, 70]);
});

test('BOX CHECKS: outside the photo, too small, no quantity, no price (and no type), unknown type, someone else\'s card, the same card twice, over 400 — all refused with nothing changed', async () => {
  const b = await bundle(), bd = await board(b), other = await board(await bundle()); const ok = (await save(bd.id, [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, qty: 1, price: 3 }])).json.boxes[0]; const otherBox = (await save(other.id, [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, qty: 1, price: 3 }])).json.boxes[0];
  const refuse = async (boxes, code, label) => { const r = await save(bd.id, boxes); assert.equal(r.status, 400, `${label}: ${r.text}`); if (code) assert.equal(r.json.code, code, label); const now = (await api('GET', `/api/admin/card-boards/${bd.id}`)).json.boxes; assert.deepEqual(now.map((x) => x.id), [ok.id], `${label}: nothing changed`); };
  const base = { x: 0.1, y: 0.1, w: 0.2, h: 0.2, qty: 1, price: 3 };
  await refuse([{ ...base, x: 0.9, w: 0.2 }], null, 'outside the photo'); await refuse([{ ...base, w: 0.001 }], null, 'too small'); await refuse([{ ...base, qty: 0 }], null, 'no quantity'); await refuse([{ ...base, qty: 1000 }], null, 'too many copies'); await refuse([{ ...base, price: undefined }], 'price_required', 'no price');
  await refuse([{ ...base, price: 0 }], null, 'a free card'); await refuse([{ ...base, price: 1.999 }], null, 'a price with 3 decimals'); await refuse([{ ...base, typeId: 999999 }], 'no_such_type', 'unknown type'); await refuse([{ ...base, id: otherBox.id }], 'no_such_box', "someone else's card");
  await refuse([{ ...base, id: ok.id }, { ...base, id: ok.id }], 'dup_box', 'the same card twice'); await refuse(Array.from({ length: 401 }, (_, i) => ({ ...base, x: (i % 20) * 0.04, y: Math.floor(i / 20) * 0.04, w: 0.03, h: 0.03 })), null, 'over 400'); const t = await type(); await refuse([{ ...base, typeId: t, priceOverride: true, price: undefined }], 'price_required', 'a hand price without a price');
  const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await api('PUT', `/api/admin/card-boards/${bd.id}/boxes`, { boxes: [] }, j)).status, 403); assert.equal((await save(999999, [])).status, 404);
});
