import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { todayUK, datePassed, closedReason } from '../src/lib/closing.js';

// Closing: an item can close before the rest of its group order — on a date of its own, or by hand — and an order closes after its own date as well as by hand.
// "After the date" = from the start of the next day, UK time. A joiner is refused; the GOM can still add claims.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'cl') => `${x}${++N}`;
const day = (offset) => { const d = new Date(`${todayUK()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const goOrder = async (extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Close GO '), proxy: 'Sam', ...extra })).json.id;
const item = async (go, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price: 10, ...extra })).json.id;
const claim = (itemIds, handle = u('who')) => app.api('POST', '/api/claims', { handle, lines: [].concat(itemIds).map((itemId) => ({ itemId })) });
const patch = (id, b) => api('PATCH', `/api/admin/items/${id}`, b);
const pub = async (go) => (await api('GET', '/api/orders')).json.orders.find((o) => o.id === go);
const adm = async (go) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go);
const claimsCount = async (itemId) => (await app.q('SELECT COUNT(*) AS n FROM claims WHERE item_id = ?', [itemId]))[0].n;

test('THE RULE (pure): the day itself is open, the next day is closed; an order closing outranks an item; UK time decides what "today" is', () => {
  assert.equal(datePassed('2026-10-20', '2026-10-20'), false, 'closes ON the 20th: still open all day'); assert.equal(datePassed('2026-10-20', '2026-10-21'), true); assert.equal(datePassed(null, '2026-10-21'), false);
  assert.equal(todayUK(new Date('2026-06-19T23:30:00Z')), '2026-06-20', 'British summer time: 23:30 UTC is already the next day in the UK'); assert.equal(todayUK(new Date('2026-12-19T23:30:00Z')), '2026-12-19');
  assert.match(todayUK(), /^\d{4}-\d{2}-\d{2}$/);
  const t = '2026-10-21'; const base = { orderStatus: 'open', orderCloseDate: null, itemCloseDate: null, itemClosedByHand: false };
  assert.equal(closedReason(base, t), null); assert.equal(closedReason({ ...base, orderStatus: 'closed' }, t), 'order_hand'); assert.equal(closedReason({ ...base, orderCloseDate: '2026-10-20' }, t), 'order_date');
  assert.equal(closedReason({ ...base, itemClosedByHand: true }, t), 'item_hand'); assert.equal(closedReason({ ...base, itemCloseDate: '2026-10-20' }, t), 'item_date');
  assert.equal(closedReason({ ...base, orderCloseDate: '2026-10-20', itemClosedByHand: true }, t), 'order_date', 'the order closing is reported first');
});

test('CLOSE AN ITEM BY HAND: a joiner is refused for that item only; the rest of the order still takes claims; reopening lets them back in', async () => {
  const go = await goOrder(); const a = await item(go, { title: 'Closing early' }), b = await item(go, { title: 'Still open' });
  assert.equal((await patch(a, { closed: true })).status, 200);
  const no = await claim(a); assert.equal(no.status, 400); assert.equal(no.json.error, 'That item has closed for claims'); assert.equal(no.json.code ?? no.json.errorCode ?? 'item_closed', 'item_closed'); assert.equal(await claimsCount(a), 0);
  assert.equal((await claim(b)).status, 201, 'the rest of the order is untouched');
  const ia = (await pub(go)).items.find((i) => i.id === a); assert.deepEqual([ia.closed, ia.closedReason, ia.closedByHand], [true, 'hand', true]); assert.equal((await pub(go)).items.find((i) => i.id === b).closed, false); assert.equal((await pub(go)).status, 'open', 'the order itself is still open');
  assert.equal((await patch(a, { closed: false })).status, 200); assert.equal((await claim(a)).status, 201, 'reopened'); assert.deepEqual([(await pub(go)).items.find((i) => i.id === a).closed], [false]);
});

test('AN ITEM\'S OWN CLOSING DATE: open all through that day, closed from the next; a future date shows but does not close; the listing says which', async () => {
  const go = await goOrder(); const past = await item(go, { closeDate: day(-1) }), today = await item(go, { closeDate: day(0) }), later = await item(go, { closeDate: day(3) }), none = await item(go);
  assert.equal((await claim(past)).status, 400); assert.equal((await claim(today)).status, 201, 'the closing day itself is still open'); assert.equal((await claim(later)).status, 201); assert.equal((await claim(none)).status, 201);
  const o = await pub(go); const by = (id) => o.items.find((i) => i.id === id);
  assert.deepEqual([by(past).closed, by(past).closedReason, by(past).closeDate], [true, 'date', day(-1)]); assert.deepEqual([by(today).closed, by(today).closeDate], [false, day(0)]); assert.deepEqual([by(later).closed, by(later).closeDate], [false, day(3)]); assert.deepEqual([by(none).closed, by(none).closeDate], [false, null]);
  assert.equal((await patch(later, { closeDate: day(-2) })).status, 200); assert.equal((await claim(later)).status, 400, 'moving the date into the past closes it at once'); assert.equal((await patch(later, { closeDate: null })).status, 200); assert.equal((await claim(later)).status, 201, 'clearing the date reopens it');
  assert.equal((await patch(later, { closeDate: 'tomorrow' })).status, 400);
});

test('REOPENING an item whose own date has passed clears that date (or uses the new one you give); a future date is left alone', async () => {
  const go = await goOrder(); const a = await item(go, { closeDate: day(-3) }), b = await item(go, { closeDate: day(-3) }), c = await item(go, { closeDate: day(5) });
  assert.equal((await patch(a, { closed: false })).status, 200); assert.equal((await claim(a)).status, 201); assert.equal((await adm(go)).items.find((i) => i.id === a).closeDate, null, 'the past date was cleared');
  assert.equal((await patch(b, { closed: false, closeDate: day(2) })).status, 200); assert.equal((await adm(go)).items.find((i) => i.id === b).closeDate, day(2)); assert.equal((await claim(b)).status, 201);
  await patch(c, { closed: true }); await patch(c, { closed: false }); assert.equal((await adm(go)).items.find((i) => i.id === c).closeDate, day(5), 'a future date stays');
});

test('AN ITEM NEVER OUTLIVES ITS GROUP ORDER: a later date is refused (create and edit) with the order\'s date; the same day or earlier is fine; no order date means no limit', async () => {
  const go = await goOrder({ closeDate: day(10) }); const ok = await item(go, { closeDate: day(10) }); assert.ok(ok);
  const r = await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'Too late', price: 5, closeDate: day(11) }); assert.equal(r.status, 400); assert.match(r.json.error, new RegExp(`The group order closes on ${day(10).slice(8, 10)}/${day(10).slice(5, 7)}/${day(10).slice(0, 4)}, so an item can't stay open longer than that`));
  const a = await item(go); assert.equal((await patch(a, { closeDate: day(11) })).status, 400); assert.equal((await patch(a, { closeDate: day(4) })).status, 200);
  const free = await goOrder(); const f = await item(free, { closeDate: day(400) }); assert.ok(f, 'an order with no date puts no limit on its items');
  await api('PATCH', `/api/admin/orders/${go}`, { closeDate: day(1) }); assert.equal((await claim(a)).status, 201, 'an order moved earlier than an item\'s date is simply the earlier of the two'); await api('PATCH', `/api/admin/orders/${go}`, { closeDate: day(-1) }); assert.equal((await claim(a)).status, 400);
});

test('A GROUP ORDER CLOSES AFTER ITS DATE (not only by hand): joiners are refused, the listing reads "closed", the home counts follow, the GOM still sees it as open with the reason; today is still open; a new date reopens it', async () => {
  const g = await api('POST', '/api/admin/groups', { name: u('Dated crew ') }); const gid = g.json.id;
  const mk = async (extra) => (await api('POST', '/api/admin/orders', { groupId: gid, title: u('Dated GO '), proxy: 'Sam', ...extra })).json.id;
  const expired = await mk({ closeDate: day(-1) }), closesToday = await mk({ closeDate: day(0) }), future = await mk({ closeDate: day(5) }), manual = await mk({ status: 'closed' });
  const its = {}; for (const [k, go] of Object.entries({ expired, closesToday, future, manual })) its[k] = await item(go);
  assert.equal((await claim(its.expired)).status, 400); assert.equal((await claim(its.expired)).json.error, 'That order has closed'); assert.equal((await claim(its.closesToday)).status, 201); assert.equal((await claim(its.future)).status, 201); assert.equal((await claim(its.manual)).status, 400);
  const pe = await pub(expired); assert.deepEqual([pe.status, pe.closedByDate], ['closed', true]); assert.deepEqual([(await pub(closesToday)).status, (await pub(closesToday)).closedByDate], ['open', false]); assert.equal((await pub(future)).status, 'open');
  const ae = await adm(expired); assert.deepEqual([ae.status, ae.closedByDate], ['open', true], 'the GOM sees the real status, and that the date has passed');
  const grp = (await api('GET', '/api/groups')).json.groups.find((x) => x.id === gid); assert.deepEqual([grp.openOrders, grp.closedOrders], [2, 2], 'today and future are open; expired and manual are closed');
  await api('PATCH', `/api/admin/orders/${expired}`, { closeDate: day(2) }); assert.equal((await claim(its.expired)).status, 201, 'a new date reopens it'); assert.equal((await pub(expired)).status, 'open');
});

test('THE GOM CAN STILL ADD CLAIMS to anything closed — an item closed by hand or by date, or an order past its date', async () => {
  const go = await goOrder(); const byHand = await item(go), byDate = await item(go, { closeDate: day(-1) }); await patch(byHand, { closed: true });
  const late = await goOrder({ closeDate: day(-2) }); const inLate = await item(late); const h = u('adm'); const add = (itemId) => api('POST', '/api/admin/claims/add', { handle: h, createHandle: true, status: 'requested', lines: [{ itemId }] });
  for (const id of [byHand, byDate, inLate]) { assert.equal((await claim(id)).status, 400, 'a joiner is refused'); assert.equal((await add(id)).status, 201, 'the GOM is not'); }
});

test('ONE CLOSED ITEM REFUSES THE WHOLE REQUEST and creates nothing (no half-made basket); member sets close too, and existing claims are untouched', async () => {
  const go = await goOrder(); const open = await item(go), closed = await item(go, { closeDate: day(-1) }); const h = u('mix');
  const r = await claim([open, closed], h); assert.equal(r.status, 400); assert.equal(r.json.error, 'That item has closed for claims'); assert.equal(await claimsCount(open), 0, 'nothing was made for the open item either');
  const set = await item(go, { type: 'set', members: ['A', 'B'], price: 3 }); const first = await app.api('POST', '/api/claims', { handle: u('s'), lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] }); assert.equal(first.status, 201);
  await patch(set, { closed: true }); const second = await app.api('POST', '/api/claims', { handle: u('s'), lines: [{ itemId: set, parts: [{ member: 'B', qty: 1 }] }] }); assert.equal(second.status, 400);
  assert.equal(await claimsCount(set), 1, 'the claim made before it closed is still there'); assert.equal((await adm(go)).items.find((i) => i.id === set).claimed, 1);
});

test('ONLY THE GOM can close or reopen an item or set its date; it is recorded; the admin listing carries the facts', async () => {
  const go = await goOrder(); const a = await item(go, { closeDate: day(3) }); const j = await app.login(`${u('jj')}@x.com`);
  assert.equal((await api('PATCH', `/api/admin/items/${a}`, { closed: true }, j)).status, 403); assert.equal((await app.api('PATCH', `/api/admin/items/${a}`, { closed: true })).status, 401); assert.equal((await claim(a)).status, 201);
  await patch(a, { closed: true }); const log = (await app.q("SELECT detail FROM audit_log WHERE action = 'item.closing' ORDER BY id DESC LIMIT 1"))[0]; assert.match(String(log.detail), /"closed":true/);
  const ia = (await adm(go)).items.find((i) => i.id === a); assert.deepEqual([ia.closeDate, ia.closedByHand, ia.closed, ia.closedReason], [day(3), true, true, 'hand']);
});
