import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';

// The store-order item picker: every item (cancelled ones excluded) with how many SECURED claims are still waiting to be ordered ('awaiting fulfillment') — counted exactly as the To order list counts them.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'h') => `${x}${++N}`;
const goOrder = async (title, extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title: `${title} ${++N}`, proxy: 'Sam', ...extra })).json.id;
const item = async (go, title, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title, ...extra })).json.id;
const options = async () => (await api('GET', '/api/admin/incoming')).json.options;
const opt = async (id) => (await options()).find((o) => o.itemId === id);
const secured = async (itemId, n = 1) => { const out = []; for (let i = 0; i < n; i++) out.push((await claimAndSecure(app, admin, u(), itemId))[0]); return out; };

test('"WAITING" COUNTS SECURED CLAIMS STILL AT "AWAITING FULFILLMENT" — not ones already ordered/arrived/ready/completed, not unsecured requests, not cancelled claims', async () => {
  const g = await goOrder('Waiting GO'); const it = await item(g, 'Photo Set'); const ids = await secured(it, 5);
  assert.equal((await opt(it)).waiting, 5);
  await api('PATCH', `/api/admin/claims/${ids[0]}`, { pipeline: 'ordered via proxy / warehouse' }); await api('PATCH', `/api/admin/claims/${ids[1]}`, { pipeline: 'ready to pack / on hand' }); assert.equal((await opt(it)).waiting, 3, 'ordered and ready ones no longer need ordering');
  await app.q("UPDATE claims SET status = 'cancelled' WHERE id = ?", [ids[2]]); assert.equal((await opt(it)).waiting, 2, 'a cancelled claim does not');
  await app.api('POST', '/api/claims', { handle: u(), lines: [{ itemId: it }] }); assert.equal((await opt(it)).waiting, 2, 'a request nobody has secured yet does not');
  await api('PATCH', `/api/admin/claims/${ids[3]}`, { pipeline: 'completed' }); await api('PATCH', `/api/admin/claims/${ids[4]}`, { pipeline: 'ordered via proxy / warehouse' }); assert.equal((await opt(it)).waiting, 0, 'with nothing left waiting it is 0…'); assert.ok(await opt(it), '…but it is still in the list (for "Show all items")');
});

test('IT AGREES WITH THE TO ORDER LIST: the same counts, with test orders left out and private orders counted', async () => {
  const real = await goOrder('Real GO'), priv = await goOrder('Private GO', { visibility: 'private' }), test_ = await goOrder('Test GO'); await app.q('UPDATE group_orders SET is_test = 1 WHERE id = ?', [test_]);
  const [a, b, c] = [await item(real, 'Real item'), await item(priv, 'Private item'), await item(test_, 'Test item')]; await secured(a, 2); await secured(b, 3); await secured(c, 4);
  assert.deepEqual([(await opt(a)).waiting, (await opt(b)).waiting, (await opt(c)).waiting], [2, 3, 0], 'private counts; a test order never does'); assert.ok(await opt(c), 'a test order\'s item is still listed');
  const toOrder = (await api('GET', '/api/admin/incoming/to-order')).json; const fromList = (id) => toOrder.rows.filter((r) => r.itemId === id).reduce((n, r) => n + r.qty, 0);
  for (const id of [a, b, c]) assert.equal((await opt(id)).waiting, fromList(id), `item ${id}: the picker and the To order list say the same`);
  assert.equal((await options()).reduce((n, o) => n + o.waiting, 0), toOrder.total, 'and the totals agree');
});

test('A SET COUNTS EACH PART, items with no claims are listed with 0, and cancelled items and cancelled orders are not listed at all', async () => {
  const g = await goOrder('Set GO'); const set = await item(g, 'Unit Digipack', { type: 'set', members: ['A', 'B', 'C', 'D'] }); for (const parts of [['A', 'B'], ['C', 'D']]) await app.api('POST', '/api/claims', { handle: u(), lines: [{ itemId: set, parts: parts.map((m) => ({ member: m, qty: 1 })) }] });
  assert.equal((await opt(set)).waiting, 0, 'parts of a set that has not been secured are not waiting to be ordered yet'); const setRow = (await api('GET', '/api/admin/sets')).json.sets.find((x) => x.itemId === set); assert.equal((await api('POST', `/api/admin/sets/${setRow.id}/secure`, {})).status, 200);
  assert.equal((await opt(set)).waiting, 4, 'a secured set: each of its four parts is one waiting');
  const none = await item(g, 'Nobody claimed this'); assert.equal((await opt(none)).waiting, 0); assert.equal(typeof (await opt(none)).waiting, 'number');
  const gone = await item(g, 'Cancelled item'); await app.q('UPDATE items SET cancelled_at = NOW() WHERE id = ?', [gone]); assert.equal(await opt(gone), undefined, 'a cancelled item is not offered');
  const dead = await goOrder('Cancelled GO'); const di = await item(dead, 'In a cancelled order'); await app.q('UPDATE group_orders SET cancelled_at = NOW() WHERE id = ?', [dead]); assert.equal(await opt(di), undefined, 'nor is anything in a cancelled order');
  const o = await opt(set); assert.deepEqual(Object.keys(o).sort(), ['groupOrder', 'item', 'itemId', 'waiting'], 'just what the picker needs');
});

test('ONLY THE GOM CAN SEE IT', async () => {
  assert.equal((await app.api('GET', '/api/admin/incoming')).status, 401); const j = await app.login(`${u('jj')}@x.com`); assert.equal((await api('GET', '/api/admin/incoming', undefined, j)).status, 403);
});
