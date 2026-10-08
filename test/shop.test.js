import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const fresh = (p = 'sh') => `${p}${++N}`;
const isoIn = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const addItem = async (o = {}) => (await api('POST', '/api/admin/shop', { title: `Shop thing ${++N}`, price: 12.5, qty: 3, ...o })).json.id;
const shop = async () => (await app.api('GET', '/api/shop')).json.items;
const adminShop = async () => (await api('GET', '/api/admin/shop')).json.items;
const itemOf = async (id) => (await adminShop()).find((i) => i.id === id);
const claim = (handle, lines, c) => app.api('POST', '/api/claims', { handle, lines }, c);
const buy = (handle, leftoverId, qty = 1) => claim(handle, [{ leftoverId, qty }]);
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;

test('adding stock: a name, a price above zero and a quantity; pay days default to 5 and size to M; the GOM only', async () => {
  const r = await api('POST', '/api/admin/shop', { title: '  Spare Lightstick ', price: 40, qty: 1, notes: ' Boxed, unused ' });
  assert.equal(r.status, 201);
  const it = await itemOf(r.json.id);
  assert.deepEqual([it.title, it.price, it.qty, it.notes, it.payDays, it.size, it.active, it.left, it.claimed], ['Spare Lightstick', 40, 1, 'Boxed, unused', 5, 'M', true, 1, 0]);
  for (const bad of [{ title: '', price: 1, qty: 1 }, { title: 'x', price: 0, qty: 1 }, { title: 'x', price: 1.005, qty: 1 }, { title: 'x', price: 1, qty: -1 }, { title: 'x', price: 1, qty: 1.5 }, { title: 'x', price: 1, qty: 1, payDays: 0 }, { title: 'x', price: 1, qty: 1, payDays: 61 }, { title: 'x', price: 1, qty: 1, size: 'HUGE' }]) {
    assert.equal((await api('POST', '/api/admin/shop', bad)).status, 400, JSON.stringify(bad));
  }
  const j = await app.login('shop.joiner@x.com');
  for (const [m, p, b] of [['GET', '/api/admin/shop'], ['POST', '/api/admin/shop', { title: 'x', price: 1, qty: 1 }], ['PATCH', `/api/admin/shop/${r.json.id}`, { qty: 9 }]]) assert.equal((await api(m, p, b, j)).status, 403, p);
  assert.equal((await app.api('GET', '/api/admin/shop')).status, 401);
});

test('what joiners see: active items, newest first, how many are LEFT (never the stock), and sold-out items stay listed', async () => {
  const a = await addItem({ title: 'Older item', qty: 5 }), b = await addItem({ title: 'Newer item', qty: 1, notes: 'Mint' }), hidden = await addItem({ title: 'Hidden item' });
  await api('PATCH', `/api/admin/shop/${hidden}`, { active: false });
  await buy(fresh(), b);
  const list = await shop();
  const ids = list.map((i) => i.id);
  assert.ok(ids.indexOf(b) < ids.indexOf(a), 'newest first');
  assert.equal(ids.includes(hidden), false);
  assert.deepEqual(list.find((i) => i.id === b), { id: b, title: 'Newer item', price: 12.5, notes: 'Mint', payDays: 5, image: null, left: 0 }, 'sold out but still shown, with nothing about stock levels');
  assert.equal(list.find((i) => i.id === a).left, 5);
  assert.ok(!JSON.stringify(list).includes('"qty"'));
});

test('claiming: confirmed at once, priced, labelled with the item, due in the item\'s pay days — and no group order involved', async () => {
  const id = await addItem({ title: 'Extra Photobook', price: 20, qty: 4, payDays: 3 });
  const h = fresh();
  const r = await buy(h, id, 2);
  assert.equal(r.status, 201); assert.equal(r.json.claimIds.length, 2);
  const rows = await claimsOf(h);
  assert.equal(rows.length, 2);
  for (const c of rows) assert.deepEqual([c.label, c.status, c.pipeline, c.order_id, c.costs.initials.cost, c.costs.initials.paid], ['Extra Photobook', 'confirmed', 'awaiting fulfillment', null, 20, 0]);
  const [db] = await app.q('SELECT item_id, leftover_item_id, DATEDIFF(pay_by, CURDATE()) AS days FROM claims WHERE id = ?', [r.json.claimIds[0]]);
  assert.deepEqual([db.item_id, db.leftover_item_id, db.days], [null, id, 3]);
  const it = await itemOf(id);
  assert.deepEqual([it.claimed, it.left], [2, 2]);
  assert.deepEqual(it.claims.map((c) => [c.handle, c.paid, c.overdue]), [[h, false, false], [h, false, false]]);
});

test('a shop item and an ordinary item can be claimed together in one go', async () => {
  const id = await addItem({ price: 5 }); const h = fresh();
  const r = await claim(h, [{ itemId: w.keyring }, { leftoverId: id }]);
  assert.equal(r.status, 201);
  assert.deepEqual((await claimsOf(h)).map((c) => c.status).sort(), ['confirmed', 'requested'], 'the shop one is confirmed at once; the group-order one still waits to be secured');
});

test('lines must be one or the other, with a sensible quantity', async () => {
  const id = await addItem();
  const h = fresh();
  assert.equal((await claim(h, [{ itemId: w.keyring, leftoverId: id }])).status, 400, 'both');
  assert.equal((await claim(h, [{ qty: 1 }])).status, 400, 'neither');
  assert.equal((await claim(h, [{ leftoverId: id, qty: 21 }])).status, 400);
  assert.equal((await claim(h, [{ leftoverId: id, qty: 0 }])).status, 400);
  assert.equal((await claimsOf(h)).length, 0);
});

test('stock: asking for more than is left is refused and says how many are; once gone it says sold out; unknown and hidden items are not found', async () => {
  const id = await addItem({ title: 'Last ones', qty: 3 });
  assert.equal((await buy(fresh(), id, 2)).status, 201);
  const over = await buy(fresh(), id, 2);
  assert.equal(over.status, 409); assert.equal(over.json.code, 'sold_out'); assert.equal(over.json.error, 'Only 1 of "Last ones" left.');
  assert.equal((await buy(fresh(), id, 1)).status, 201);
  const gone = await buy(fresh(), id, 1);
  assert.deepEqual([gone.status, gone.json.error], [409, '"Last ones" has sold out.']);
  assert.equal((await buy(fresh(), 999999)).status, 404);
  const hidden = await addItem(); await api('PATCH', `/api/admin/shop/${hidden}`, { active: false });
  assert.equal((await buy(fresh(), hidden)).status, 404);
});

test('a request that fails part way creates NOTHING — not even the shop units that were fine', async () => {
  const id = await addItem({ qty: 5 }); const h = fresh();
  const r = await claim(h, [{ leftoverId: id, qty: 2 }, { itemId: 999999 }]);
  assert.equal(r.status, 404);
  assert.equal((await itemOf(id)).claimed, 0); assert.equal((await claimsOf(h)).length, 0);
});

test('STRESS: 12 people grab the last 3 units at the same instant — exactly 3 get one, the other 9 are told it sold out, and it is never oversold', async () => {
  const id = await addItem({ qty: 3 });
  const rs = await Promise.all(Array.from({ length: 12 }, () => buy(fresh('rush'), id)));
  assert.deepEqual([rs.filter((r) => r.status === 201).length, rs.filter((r) => r.status === 409).length], [3, 9]);
  assert.deepEqual([(await itemOf(id)).claimed, (await itemOf(id)).left], [3, 0]);
});

test('STRESS: five people each wanting 2 of 5 units: only two can have them, and the odd unit is left over — never oversold', async () => {
  const id = await addItem({ qty: 5 });
  const rs = await Promise.all(Array.from({ length: 5 }, () => buy(fresh('pair'), id, 2)));
  assert.equal(rs.filter((r) => r.status === 201).length, 2);
  assert.deepEqual([(await itemOf(id)).claimed, (await itemOf(id)).left], [4, 1]);
});

test('cancelling a shop claim frees the unit for someone else', async () => {
  const id = await addItem({ qty: 1 }); const h = fresh();
  await buy(h, id);
  assert.equal((await buy(fresh(), id)).status, 409);
  const [c] = await claimsOf(h);
  assert.equal((await api('PATCH', `/api/admin/claims/${c.id}`, { status: 'cancelled' })).status, 200);
  assert.deepEqual([(await itemOf(id)).claimed, (await itemOf(id)).left], [0, 1]);
  assert.equal((await buy(fresh(), id)).status, 201);
});

test('a blocked handle cannot buy from the shop', async () => {
  const id = await addItem(); const h = fresh('blk');
  await api('POST', '/api/admin/joiners/block', { handle: h, reason: 'test' });
  const r = await buy(h, id);
  assert.deepEqual([r.status, r.json.code], [403, 'handle_blocked']);
});

test('paying for it makes it ready to pack at once (it is already on hand); part-paying does not; and then it can be shipped', async () => {
  const h = fresh('pay'); const c = await joinerSession(app, `${h}@x.com`, h);
  const id = await addItem({ price: 10 });
  await buy(h, id);
  const part = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 4, reference: 'P1' }, c);
  await api('POST', `/api/admin/payments/${part.json.id}/verify`, {});
  let [cl] = await claimsOf(h);
  assert.deepEqual([cl.pipeline, cl.ready_to_pack_date], ['awaiting fulfillment', null], 'only part paid');
  const rest = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 6, reference: 'P2' }, c);
  await api('POST', `/api/admin/payments/${rest.json.id}/verify`, {});
  [cl] = await claimsOf(h);
  assert.equal(cl.pipeline, 'ready to pack / on hand'); assert.ok(cl.ready_to_pack_date, 'the storage clock starts now');
  await app.api('PUT', '/api/my/address', { fullName: 'S H', address: '1 Road, Leeds', email: `${h}@x.com`, phone: '0700' }, c);
  const p = await app.api('POST', '/api/my/parcels', { claimIds: [cl.id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, c);
  assert.equal(p.status, 201, 'a paid shop item can be sent like any other');
});

test('credit the joiner already holds pays for it, and that too makes it ready', async () => {
  const h = fresh('cr'); const c = await joinerSession(app, `${h}@x.com`, h);
  await api('POST', '/api/admin/credit/add', { handle: h, amount: 30, reason: 'sold your album' });
  await buy(h, await addItem({ price: 12 }));
  const [cl] = await claimsOf(h);
  assert.equal(cl.costs.initials.paid, 0, 'credit is applied when the GOM next touches the account...');
  await api('POST', '/api/admin/credit/add', { handle: h, amount: 1, reason: 'top up' });
  const [after] = await claimsOf(h);
  assert.deepEqual([after.costs.initials.paid, after.pipeline], [12, 'ready to pack / on hand']);
  assert.ok(c);
});

test('it shows in the joiner\'s own orders under "Shop (on hand)", with what is owed and when to pay by', async () => {
  const h = fresh('my'); const c = await joinerSession(app, `${h}@x.com`, h);
  await buy(h, await addItem({ title: 'My shop thing', price: 7, payDays: 5 }));
  const s = (await app.api('GET', '/api/my/summary', undefined, c)).json;
  const g = s.orders.find((o) => o.title === 'Shop (on hand)');
  assert.ok(g, 'a Shop group');
  assert.deepEqual([g.claims[0].label, g.owed], ['My shop thing', 7]);
  assert.equal(g.claims[0].payBy.slice(0, 10), isoIn(5));
  assert.equal(s.owed.total, 7);
});

test('unpaid past its pay-by date it shows in Overdue (with the GOM to cancel it); paid, or not yet due, it does not', async () => {
  const [late, fine, paid] = [fresh('late'), fresh('fine'), fresh('paidx')];
  const cp = await joinerSession(app, `${paid}@x.com`, paid);
  const id = await addItem({ title: 'Overdue shop item', price: 9 });
  for (const h of [late, fine, paid]) await buy(h, id);
  const ids = Object.fromEntries(await Promise.all([late, fine, paid].map(async (h) => [h, (await claimsOf(h))[0].id])));
  await app.q('UPDATE claims SET pay_by = CURDATE() - INTERVAL 3 DAY WHERE id IN (?, ?)', [ids[late], ids[paid]]);
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 9, reference: 'OK' }, cp); await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  const rows = (await api('GET', '/api/admin/overdue')).json.payments;
  const row = rows.find((r) => r.handle === late);
  assert.deepEqual([row.orderTitle, row.daysOverdue, row.owed, row.ownDate, row.label], ['Shop (on hand)', 3, 9, true, 'Overdue shop item']);
  assert.equal(rows.some((r) => r.handle === fine), false, 'not due yet'); assert.equal(rows.some((r) => r.handle === paid), false, 'paid');
  const listed = (await itemOf(id)).claims.find((c) => c.handle === late);
  assert.deepEqual([listed.overdue, listed.paid], [true, false], 'and the shop screen flags it too');
});

test('an overdue shop claim gets the one reminder email, like any other overdue item', async () => {
  const h = fresh('rem'); const c = await joinerSession(app, `${h}@x.com`, h);
  await app.api('PUT', '/api/my/notifications', { enabled: true }, c);
  await buy(h, await addItem({ title: 'Reminder shop item', price: 6 }));
  await app.q('UPDATE claims SET pay_by = CURDATE() - INTERVAL 2 DAY WHERE joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)', [h]);
  await app.notifier.idle();
  const before = app.mailer.outbox.filter((m) => m.to === `${h}@x.com`).length;
  await app.notifier.sendOverdueReminders(); await app.notifier.idle();
  const mail = app.mailer.outbox.filter((m) => m.to === `${h}@x.com`)[before];
  assert.match(mail.text, /Reminder shop item — £6\.00 still to pay/);
});

test('a shop claim by someone who opted in is announced straight away, since it is confirmed straight away', async () => {
  const h = fresh('ann'); const c = await joinerSession(app, `${h}@x.com`, h);
  await app.api('PUT', '/api/my/notifications', { enabled: true }, c);
  await buy(h, await addItem({ title: 'Announced item', price: 8 })); await app.notifier.idle();
  const mail = app.mailer.outbox.filter((m) => m.to === `${h}@x.com`).pop();
  assert.match(mail.text, /this claim is now secured:.*Announced item — £8\.00.*You now owe £8\.00/s);
});

test('editing: price and pay days apply to NEW claims only; quantity cannot drop below what is claimed; hiding stops sales; partial edits change only what is sent', async () => {
  const id = await addItem({ title: 'Editable', price: 10, qty: 4, payDays: 5, notes: 'Keep me' });
  const early = fresh(); await buy(early, id, 2);
  assert.equal((await api('PATCH', `/api/admin/shop/${id}`, { price: 15, payDays: 2, title: 'Renamed' })).status, 200);
  const late = fresh(); await buy(late, id);
  assert.equal((await claimsOf(early))[0].costs.initials.cost, 10, 'an earlier claim keeps the price it was made at');
  assert.equal((await claimsOf(late))[0].costs.initials.cost, 15);
  assert.equal((await app.q('SELECT DATEDIFF(pay_by, CURDATE()) AS d FROM claims WHERE joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)', [late]))[0].d, 2);
  const it = await itemOf(id);
  assert.deepEqual([it.title, it.notes, it.size, it.qty], ['Renamed', 'Keep me', 'M', 4], 'untouched fields stay as they were');
  const low = await api('PATCH', `/api/admin/shop/${id}`, { qty: 2 });
  assert.equal(low.status, 409); assert.equal(low.json.code, 'qty_below_claims'); assert.match(low.json.error, /3 are already claimed — set the quantity to at least 3/);
  assert.equal((await api('PATCH', `/api/admin/shop/${id}`, { qty: 3 })).status, 200);
  assert.equal((await buy(fresh(), id)).status, 409, 'now sold out');
  assert.equal((await api('PATCH', `/api/admin/shop/${id}`, { qty: 9 })).status, 200);
  await api('PATCH', `/api/admin/shop/${id}`, { active: false });
  assert.equal((await buy(fresh(), id)).status, 404); assert.equal((await shop()).some((i) => i.id === id), false);
  assert.equal((await itemOf(id)).claimed, 3, 'its claims are still there');
  await api('PATCH', `/api/admin/shop/${id}`, { active: true, notes: '' });
  assert.equal((await buy(fresh(), id)).status, 201); assert.equal((await itemOf(id)).notes, '');
  assert.equal((await api('PATCH', `/api/admin/shop/${id}`, { price: 0 })).status, 400);
  assert.equal((await api('PATCH', '/api/admin/shop/999999', { qty: 1 })).status, 404);
});

test('STRESS: lowering the stock while people are buying can never leave more claimed than there is', async () => {
  const id = await addItem({ qty: 10 });
  const ops = [...Array.from({ length: 10 }, () => buy(fresh('mix'), id)), api('PATCH', `/api/admin/shop/${id}`, { qty: 4 })];
  await Promise.all(ops);
  const it = await itemOf(id);
  assert.ok(it.claimed <= it.qty, `claimed ${it.claimed} of ${it.qty}`);
});

test('INVARIANTS: nothing is oversold, shop claims have no group order, and no line is overpaid', async () => {
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM leftover_items li WHERE li.qty < (SELECT COUNT(*) FROM claims c WHERE c.leftover_item_id = li.id AND c.status <> 'cancelled')"))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE leftover_item_id IS NOT NULL AND (order_id IS NOT NULL OR item_id IS NOT NULL OR pay_by IS NULL)'))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost'))[0].n, 0);
});
