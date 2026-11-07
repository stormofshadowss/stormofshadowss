import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startApp, seed, joinerSession } from './helpers.js';

// CARDS, slice 2 (server): a published bundle is backed by a real group order and an item per card; on-hand cards are confirmed at once; the public Cards API; card orders can only be changed from the Cards tab.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'cl') => `${x}${++N}`;
const photo = () => sharp({ create: { width: 1200, height: 800, channels: 3, background: '#446' } }).png().toBuffer();
const putBoard = async (bundleId) => { const r = await fetch(`${app.base}/api/admin/card-bundles/${bundleId}/boards`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: await photo() }); assert.equal(r.status, 201); return (await r.json()).board; };
const box = (i, extra = {}) => ({ x: 0.05 + i * 0.3, y: 0.05, w: 0.25, h: 0.3, qty: 1, price: 3 + i, ...extra });
const cardsData = async () => (await api('GET', '/api/admin/cards')).json;
const bundleRow = async (id) => (await cardsData()).bundles.find((b) => b.id === id);
// a bundle with one board and some cards, not yet published
async function draft({ onHand = true, boxes = [box(0), box(1, { qty: 2, note: 'corner ding' }), box(2)], groupId = w.group, ...extra } = {}) {
  const b = (await api('POST', '/api/admin/card-bundles', { title: u('Live '), groupId, onHand, ...extra })).json.id; const bd = await putBoard(b);
  const s = await api('PUT', `/api/admin/card-boards/${bd.id}/boxes`, { boxes }); assert.equal(s.status, 200, s.text); return { b, bd, boxes: s.json.boxes };
}
const publish = (b) => api('PATCH', `/api/admin/card-bundles/${b}`, { status: 'open' });
async function live(opts) { const d = await draft(opts); const p = await publish(d.b); assert.equal(p.status, 200, p.text); const row = await bundleRow(d.b); const boxes = (await api('GET', `/api/admin/card-boards/${d.bd.id}`)).json.boxes; return { ...d, orderId: row.orderId, boxes, itemOf: (n) => boxes.find((x) => x.number === n).itemId }; }
const person = async (h = u('p')) => ({ h, cookie: await joinerSession(app, `${h}@x.com`, h) });
const claim = (p, itemId, qty = 1) => api('POST', '/api/claims', { handle: p.h, lines: [{ itemId, qty }] }, p.cookie);
const claimRow = async (id) => (await app.q("SELECT status, pipeline, label, DATE_FORMAT(pay_by, '%Y-%m-%d') AS payBy, ready_to_pack_date AS ready FROM claims WHERE id = ?", [id]))[0];
const cost = async (id) => (await app.q("SELECT cost, paid FROM claim_costs WHERE claim_id = ? AND category = 'initials'", [id])).map((r) => [Number(r.cost), Number(r.paid)])[0];
const itemRow = async (id) => (await app.q('SELECT i.*, im.filename FROM items i LEFT JOIN images im ON im.id = i.image_id WHERE i.id = ?', [id]))[0];
const save = (bd, boxes) => api('PUT', `/api/admin/card-boards/${bd}/boxes`, { boxes });
const asInput = (x, extra = {}) => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h, qty: x.qty, price: x.price, note: x.note || null, ...extra });
const today5 = async (n = 5) => (await app.q(`SELECT DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL ${n} DAY), '%Y-%m-%d') AS d`))[0].d;

test('PUBLISHING CREATES THE REAL ORDER AND AN ITEM PER CARD: titled "Bundle — Board — #n", the card\'s price, its crop as the picture, copies as the purchase limit; a draft has none; a bundle needs a group to publish', async () => {
  const d = await draft({ closesOn: '2099-01-31' }); assert.equal((await bundleRow(d.b)).orderId, null, 'a draft has no order'); const before = (await app.q('SELECT COUNT(*) AS n FROM group_orders WHERE is_cards = 1'))[0].n;
  const p = await publish(d.b); assert.equal(p.status, 200, p.text); const row = await bundleRow(d.b); assert.ok(row.orderId); assert.equal((await app.q('SELECT COUNT(*) AS n FROM group_orders WHERE is_cards = 1'))[0].n, before + 1);
  const o = (await app.q("SELECT *, DATE_FORMAT(close_date, '%Y-%m-%d') AS cd FROM group_orders WHERE id = ?", [row.orderId]))[0]; assert.deepEqual([o.is_cards, o.title, o.group_id, o.status, o.cd, o.is_private], [1, row.title, w.group, 'open', '2099-01-31', 0]);
  const items = await app.q('SELECT i.*, im.filename FROM items i LEFT JOIN images im ON im.id = i.image_id WHERE i.order_id = ? ORDER BY i.sort_order', [row.orderId]); const boxes = (await api('GET', `/api/admin/card-boards/${d.bd.id}`)).json.boxes;
  assert.deepEqual(items.map((i) => i.title), [1, 2, 3].map((n) => `${row.title} — Board 1 — #${n}`)); assert.deepEqual(items.map((i) => [Number(i.price), i.purchase_limit, i.limit_scope, i.item_type, i.size_bucket, i.description]), [[3, 1, 'item', 'normal', 'XS', null], [4, 2, 'item', 'normal', 'XS', 'corner ding'], [5, 1, 'item', 'normal', 'XS', null]]);
  assert.deepEqual(items.map((i) => i.filename), boxes.map((x) => x.crop.url.split('/').pop()), "each item's picture is its card's crop"); assert.deepEqual(boxes.map((x) => x.itemId), items.map((i) => i.id), 'each card knows its item');
  assert.equal((await publish(d.b)).status, 200, 'publishing again changes nothing'); assert.equal((await app.q('SELECT COUNT(*) AS n FROM items WHERE order_id = ?', [row.orderId]))[0].n, 3);
  const noGroup = await draft({ groupId: null }); const r = await publish(noGroup.b); assert.deepEqual([r.status, r.json.code], [409, 'group_required']); assert.deepEqual([(await bundleRow(noGroup.b)).status, (await bundleRow(noGroup.b)).orderId], ['draft', null], 'nothing half-published');
  assert.equal((await api('PATCH', `/api/admin/card-bundles/${noGroup.b}`, { groupId: w.group, status: 'open' })).status, 200); assert.ok((await bundleRow(noGroup.b)).orderId); assert.equal((await api('PATCH', `/api/admin/card-bundles/${d.b}`, { status: 'draft' })).status, 409, 'a published bundle can\'t go back to draft');
  assert.equal((await api('GET', '/api/admin/orders')).json.orders.find((x) => x.id === row.orderId).isCards, true, 'the GOM\'s order list flags it');
});

test('THE ORDER STAYS IN STEP: price, copies, a moved card\'s picture, new and removed cards, the bundle\'s name, group and closing date; closing and re-opening close and re-open the order', async () => {
  const L = await live({ closesOn: '2099-03-01' }); const [b1, b2] = L.boxes; const i1 = await itemRow(b1.itemId), crop1 = b1.crop.url;
  const r = await save(L.bd.id, [asInput(b1, { price: 7.5 }), asInput(b2, { qty: 5 }), asInput(L.boxes[2])]); assert.equal(r.status, 200, r.text); assert.deepEqual([Number((await itemRow(b1.itemId)).price), (await itemRow(b2.itemId)).purchase_limit], [7.5, 5], 'price and copies follow');
  const mv = await save(L.bd.id, [asInput(b1, { price: 7.5, x: 0.6, y: 0.6 }), asInput(b2, { qty: 5 }), asInput(L.boxes[2])]); const moved = mv.json.boxes.find((x) => x.id === b1.id); assert.equal(mv.json.cropped, 1); const i1b = await itemRow(b1.itemId); assert.notEqual(i1b.image_id, i1.image_id, "the item's picture follows the new crop"); assert.equal(i1b.filename, moved.crop.url.split('/').pop());
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM images WHERE id = ?', [i1.image_id]))[0].n, 0, 'the old picture row is gone'); assert.equal((await fetch(app.base + crop1)).status, 404, 'and its file');
  const add = await save(L.bd.id, [...mv.json.boxes.map((x) => asInput(x)), box(0, { x: 0.05, y: 0.62, price: 9 })]); assert.equal(add.status, 200, add.text); const fresh = add.json.boxes.find((x) => !mv.json.boxes.some((y) => y.id === x.id)); assert.ok(fresh.itemId, 'a new card gets an item'); assert.equal((await app.q('SELECT COUNT(*) AS n FROM items WHERE order_id = ?', [L.orderId]))[0].n, 4);
  const gone = await save(L.bd.id, add.json.boxes.filter((x) => x.id !== fresh.id).map((x) => asInput(x))); assert.equal(gone.status, 200, gone.text); assert.equal((await app.q('SELECT COUNT(*) AS n FROM items WHERE id = ?', [fresh.itemId]))[0].n, 0, 'an unclaimed card\'s item goes with it'); assert.equal((await fetch(app.base + fresh.crop.url)).status, 404, 'and its picture file');
  assert.equal((await api('PATCH', `/api/admin/card-bundles/${L.b}`, { title: 'Renamed bundle', closesOn: '2099-04-02' })).status, 200); const o = (await app.q("SELECT title, DATE_FORMAT(close_date, '%Y-%m-%d') AS cd FROM group_orders WHERE id = ?", [L.orderId]))[0]; assert.deepEqual([o.title, o.cd], ['Renamed bundle', '2099-04-02']); assert.equal((await itemRow(b2.itemId)).title, 'Renamed bundle — Board 1 — #1', "the cards' titles follow the new name and numbering (it is #1 now that the other card moved to the bottom row)");
  assert.equal((await api('PATCH', `/api/admin/card-bundles/${L.b}`, { status: 'closed' })).status, 200); assert.equal((await app.q('SELECT status FROM group_orders WHERE id = ?', [L.orderId]))[0].status, 'closed'); const p = await person(); const c = await claim(p, b2.itemId); assert.deepEqual([c.status, c.json.code], [400, 'order_closed'], 'closed: no claims');
  assert.equal((await api('PATCH', `/api/admin/card-bundles/${L.b}`, { status: 'open' })).status, 200); assert.equal((await app.q('SELECT status FROM group_orders WHERE id = ?', [L.orderId]))[0].status, 'open'); assert.equal((await claim(p, b2.itemId)).status, 201, 're-opened: claims work again');
});

test('ON-HAND CARDS ARE CONFIRMED AT ONCE with days to pay counted from now, priced as the card is; copies run out (a cancelled claim gives one back); credit already held is used', async () => {
  const L = await live({ payDays: 7, boxes: [box(0, { price: 2 }), box(1, { qty: 2, price: 4 })] }); const p = await person(), q = await person(), r = await person();
  const c1 = await claim(p, L.itemOf(1)); assert.equal(c1.status, 201, c1.text); const id1 = c1.json.claimIds[0]; const row = await claimRow(id1); assert.deepEqual([row.status, row.pipeline, row.payBy, row.label], ['confirmed', 'awaiting fulfillment', await today5(7), (await itemRow(L.itemOf(1))).title]); assert.deepEqual(await cost(id1), [2, 0]);
  const c2 = await claim(q, L.itemOf(1)); assert.deepEqual([c2.status, c2.json.code], [409, 'limit_reached'], 'a single copy goes to one person only');
  assert.equal((await claim(p, L.itemOf(2), 2)).status, 201); const third = await claim(q, L.itemOf(2)); assert.deepEqual([third.status, third.json.code], [409, 'limit_reached'], 'both copies are taken'); const mine = (await api('GET', `/api/cards/bundles/${L.b}`, undefined, p.cookie)).json.boards[0].boxes; assert.deepEqual(mine.map((x) => [x.left, x.mine]), [[0, 1], [0, 2]]);
  await app.q("UPDATE claims SET status = 'cancelled' WHERE id = ?", [id1]); assert.equal((await claim(q, L.itemOf(1))).status, 201, 'a cancelled claim gives the copy back');
  const jid = (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [r.h]))[0].id; await app.q("INSERT INTO credit_ledger (joiner_id, kind, amount, balance_effect, reason, source) VALUES (?, 'credit', 3, 3, 'test credit', 'test')", [jid]);
  const L2 = await live({ boxes: [box(0, { price: 2 })] }); const cr = await claim(r, L2.itemOf(1)); assert.equal(cr.status, 201, cr.text); assert.deepEqual(await cost(cr.json.claimIds[0]), [2, 2], 'the credit they held paid for it');
});

test('NOT ON HAND: claims wait to be secured like any group order (no pay-by yet); once secured and paid they are NOT ready to pack (they still have to arrive)', async () => {
  const L = await live({ onHand: false }); const p = await person(); const c = await claim(p, L.itemOf(1)); assert.equal(c.status, 201, c.text); const id = c.json.claimIds[0]; assert.deepEqual([(await claimRow(id)).status, (await claimRow(id)).payBy], ['requested', null]);
  assert.equal((await api('PATCH', `/api/admin/claims/${id}`, { status: 'confirmed' })).status, 200); await api('PATCH', `/api/admin/claims/${id}`, { costs: { initials: { paid: 3 } } }); const row = await claimRow(id); assert.deepEqual([row.status, row.pipeline, row.ready], ['confirmed', 'awaiting fulfillment', null], 'paid, but still waiting for the cards to be ordered and arrive');
});

test('PAID ON-HAND CARDS ARE READY TO PACK; if the payment is reversed (and they are not in a parcel) they go back to waiting', async () => {
  const L = await live({ boxes: [box(0, { price: 3 })] }); const p = await person(); const c = await claim(p, L.itemOf(1)); const id = c.json.claimIds[0];
  const pay = await api('POST', `/api/my/payments?handle=${p.h}`, { method: 'PayPal', amount: 3, reference: u('TXN') }, p.cookie); assert.equal(pay.status, 201, pay.text); const v = pay.json.batchKey ? await api('POST', `/api/admin/payments/batch/${pay.json.batchKey}/verify`, {}) : await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {}); assert.equal(v.status, 200, v.text);
  const ready = await claimRow(id); assert.deepEqual([ready.pipeline, !!ready.ready], ['ready to pack / on hand', true]);
  const rev = await api('POST', `/api/admin/payments/${pay.json.id}/reverse`, { reason: 'Bounced' }); assert.equal(rev.status, 200, rev.text); const back = await claimRow(id); assert.deepEqual([back.pipeline, back.ready], ['awaiting fulfillment', null]);
});

test('THE PUBLIC CARDS API: only published, open, current bundles; groups with how many are open; copies left per card; nothing says who claimed what (you see only YOUR OWN picks, signed in)', async () => {
  const groupsBefore = JSON.stringify((await app.api('GET', '/api/groups')).json); const ordersBefore = (await app.api('GET', '/api/orders')).json.orders.filter((o) => !o.isCards).length;
  const L = await live({ payDays: 3, boxes: [box(0, { qty: 3 }), box(1)] }); const dr = await draft(); const cl = await live(); await api('PATCH', `/api/admin/card-bundles/${cl.b}`, { status: 'closed' }); const old = await live({ closesOn: '2099-01-01' }); await api('PATCH', `/api/admin/card-bundles/${old.b}`, { closesOn: '2020-01-01' });
  const list = (await app.api('GET', '/api/cards')).json; assert.ok(list.bundles.some((b) => b.id === L.b), 'the open one is listed'); for (const x of [dr.b, cl.b, old.b]) assert.equal(list.bundles.some((b) => b.id === x), false, 'a draft, a closed one and one past its closing date are not');
  const entry = list.bundles.find((b) => b.id === L.b); assert.deepEqual([entry.onHand, entry.payDays, entry.boards, entry.cards, entry.copies, entry.left, entry.groupId], [true, 3, 1, 2, 4, 4, w.group]); assert.ok(entry.cover.url, 'it has a cover'); assert.ok(list.groups.find((g) => g.id === w.group).openBundles >= 1);
  assert.equal(JSON.stringify((await app.api('GET', '/api/groups')).json), groupsBefore, 'the normal groups page (and its open-order counts) is unchanged by card bundles'); const pub = (await app.api('GET', '/api/orders')).json.orders; assert.equal(pub.filter((o) => !o.isCards).length, ordersBefore, 'the normal orders are unchanged'); const ce = pub.find((o) => o.id === L.orderId); assert.deepEqual([ce.isCards, ce.cardBundleId, ce.items.length], [true, L.b, 2], 'a card order is in the list, flagged, so the basket knows its items'); assert.deepEqual([ce.items[0].limit.n, ce.items[0].limit.scope], [3, 'item']);
  const a = await person(), z = await person(); assert.equal((await claim(a, L.itemOf(1), 2)).status, 201); const anon = (await app.api('GET', `/api/cards/bundles/${L.b}`)).json; const boxes = anon.boards[0].boxes; assert.deepEqual(boxes.map((x) => [x.number, x.left, x.qty, x.price, x.mine]), [[1, 1, 3, 3, 0], [2, 1, 1, 4, 0]]);
  assert.ok(boxes.every((x) => x.crop.url && x.itemId && x.w > 0 && x.x >= 0), 'each card has its place, picture and item'); assert.equal(anon.boards[0].image.width, 1200); assert.ok(anon.boards[0].aspect > 1.4);
  const raw = JSON.stringify((await app.api('GET', `/api/cards/bundles/${L.b}`, undefined, z.cookie)).json); assert.equal(raw.includes(a.h), false, 'nobody\'s handle appears'); assert.equal(JSON.parse(raw).boards[0].boxes[0].mine, 0, 'someone else\'s claim isn\'t "mine"');
  assert.equal((await api('GET', `/api/cards/bundles/${L.b}`, undefined, a.cookie)).json.boards[0].boxes[0].mine, 2, 'your own picks, when signed in'); for (const x of [dr.b, cl.b, old.b, 999999]) assert.equal((await app.api('GET', `/api/cards/bundles/${x}`)).status, 404, `bundle ${x} isn't open`);
});

test('CARD ORDERS CAN ONLY BE CHANGED FROM THE CARDS TAB: editing or deleting the order or its items elsewhere is refused (normal orders are unaffected)', async () => {
  const L = await live(); const item = L.itemOf(1); const refuse = async (m, path, body) => { const r = await api(m, path, body); assert.deepEqual([r.status, r.json.code], [409, 'managed_in_cards'], `${m} ${path}`); };
  await refuse('PATCH', `/api/admin/orders/${L.orderId}`, { title: 'x' }); await refuse('POST', `/api/admin/orders/${L.orderId}/items`, { type: 'normal', title: 'extra', price: 3 }); await refuse('PATCH', `/api/admin/items/${item}`, { price: 9 }); await refuse('DELETE', `/api/admin/items/${item}`); await refuse('DELETE', `/api/admin/orders/${L.orderId}`);
  assert.equal(Number((await itemRow(item)).price), 3, 'nothing changed'); const plain = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Plain ') })).json.id; assert.equal((await api('PATCH', `/api/admin/orders/${plain}`, { title: 'Still editable' })).status, 200);
  assert.equal((await api('GET', `/api/admin/orders/${L.orderId}/delete-check`)).status, 200, 'looking is still fine');
});

test('DELETING: a bundle or board with a real (confirmed) claim is refused with the reason; one with only an unconfirmed request, or none, goes with its order, items and pictures; on hand can\'t be switched once there are claims', async () => {
  const L = await live(); const p = await person(); const c = await claim(p, L.itemOf(1)); assert.equal(c.status, 201); const sw = await api('PATCH', `/api/admin/card-bundles/${L.b}`, { onHand: false }); assert.deepEqual([sw.status, sw.json.code], [409, 'has_claims']);
  const d1 = await api('DELETE', `/api/admin/card-bundles/${L.b}`); assert.deepEqual([d1.status, d1.json.code], [409, 'cannot_delete']); assert.match(d1.json.error, /confirmed claim/); assert.equal((await api('DELETE', `/api/admin/card-boards/${L.bd.id}`)).status, 409); const rm = await save(L.bd.id, L.boxes.filter((x) => x.number !== 1).map((x) => asInput(x))); assert.deepEqual([rm.status, rm.json.code], [409, 'cannot_delete'], 'a claimed card can\'t be removed from the board');
  assert.ok(await bundleRow(L.b)); assert.equal((await app.q('SELECT COUNT(*) AS n FROM items WHERE order_id = ?', [L.orderId]))[0].n, 3, 'nothing was removed'); const lowered = await save(L.bd.id, L.boxes.map((x) => asInput(x, x.number === 1 ? { qty: 1 } : {}))); assert.equal(lowered.status, 200, 'keeping at least what is claimed is fine');
  const N2 = await live({ onHand: false }); const q = await person(); const rq = await claim(q, N2.itemOf(1)); assert.equal((await claimRow(rq.json.claimIds[0])).status, 'requested'); const files = (await app.q('SELECT COUNT(*) AS n FROM images'))[0].n; assert.equal((await api('DELETE', `/api/admin/card-bundles/${N2.b}`)).status, 200, 'an unconfirmed request goes with it');
  assert.deepEqual([(await app.q('SELECT COUNT(*) AS n FROM group_orders WHERE id = ?', [N2.orderId]))[0].n, (await app.q('SELECT COUNT(*) AS n FROM items WHERE order_id = ?', [N2.orderId]))[0].n, (await app.q('SELECT COUNT(*) AS n FROM claims WHERE id = ?', [rq.json.claimIds[0]]))[0].n], [0, 0, 0]); assert.ok((await app.q('SELECT COUNT(*) AS n FROM images'))[0].n < files, 'its pictures were removed');
  const E = await live(); assert.equal((await api('DELETE', `/api/admin/card-bundles/${E.b}`)).status, 200); assert.equal((await app.q('SELECT COUNT(*) AS n FROM group_orders WHERE id = ?', [E.orderId]))[0].n, 0, 'an untouched bundle goes with its order'); const sw2 = await live(); assert.equal((await api('PATCH', `/api/admin/card-bundles/${sw2.b}`, { onHand: false })).status, 200, 'switching is fine before any claims');
});

test('A CARD LIST FOR THE GOM: each bundle shows its order and how many claims it has', async () => {
  const L = await live(); assert.equal((await bundleRow(L.b)).claims, 0); const p = await person(); await claim(p, L.itemOf(2), 2); const row = await bundleRow(L.b); assert.deepEqual([row.orderId, row.claims], [L.orderId, 2]); assert.equal((await bundleRow((await draft()).b)).orderId, null);
});

test('A CARD CAN\'T HAVE FEWER COPIES THAN ARE ALREADY CLAIMED: the save is refused with the number, and nothing changes; more copies are fine', async () => {
  const L = await live({ boxes: [box(0, { qty: 2 }), box(1)] }); const p = await person(); assert.equal((await claim(p, L.itemOf(1), 2)).status, 201);
  const r = await save(L.bd.id, L.boxes.map((x) => asInput(x, x.number === 1 ? { qty: 1 } : {}))); assert.deepEqual([r.status, r.json.code], [409, 'qty_below_claims']); assert.match(r.json.error, /already has 2 claimed, so it can't have fewer than 2 copies/);
  assert.deepEqual([(await itemRow(L.itemOf(1))).purchase_limit, (await api('GET', `/api/admin/card-boards/${L.bd.id}`)).json.boxes.find((x) => x.number === 1).qty], [2, 2], 'nothing changed'); assert.equal((await save(L.bd.id, L.boxes.map((x) => asInput(x, x.number === 1 ? { qty: 3 } : {})))).status, 200, 'more copies are fine'); assert.equal((await itemRow(L.itemOf(1))).purchase_limit, 3);
});

test('ON-HAND CLAIMANTS ARE TOLD WHAT THEY OWE (if they have emails on), as with the Shop; a not-on-hand claim (only requested) sends nothing yet', async () => {
  const L = await live({ boxes: [box(0, { price: 2.5 })] }), N2 = await live({ onHand: false, boxes: [box(0, { price: 2.5 })] }); const p = await person(), q = await person();
  for (const x of [p, q]) assert.equal((await api('PUT', `/api/my/notifications?handle=${x.h}`, { enabled: true }, x.cookie)).status, 200);
  const mails = (x) => app.mailer.outbox.filter((m) => m.to === `${x.h}@x.com`); const before = mails(p).length, beforeQ = mails(q).length;
  assert.equal((await claim(p, L.itemOf(1))).status, 201); assert.equal((await claim(q, N2.itemOf(1))).status, 201); await app.notifier.idle();
  assert.equal(mails(p).length, before + 1, 'told at once'); assert.match(mails(p).at(-1).text, /£2\.50/); assert.equal(mails(q).length, beforeQ, 'not on hand: nothing until you secure it');
});
