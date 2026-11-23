import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';

// REORDER THE ITEMS OF A GROUP ORDER (the order joiners see them in) and MOVE AN ITEM TO ANOTHER GROUP ORDER — with its claims, nothing deleted or re-made.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'io') => `${x}${++N}`;
const goOrder = async (proxy = 'Sam', extra = {}) => { const title = u('Order GO '); const r = await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy }); assert.equal(r.status, 201, r.text); if (extra.paymentDeadline) assert.equal((await api('PATCH', `/api/admin/orders/${r.json.id}`, { paymentDeadline: extra.paymentDeadline })).status, 200); return { id: r.json.id, title }; };
const item = async (go, title, extra = {}) => { const r = await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title, ...extra }); assert.equal(r.status, 201, r.text); return r.json.id; };
const order = async (go) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go);
const ids = async (go) => (await order(go)).items.map((i) => i.id);
const pubIds = async (go) => ((await app.api('GET', '/api/orders')).json.orders.find((o) => o.id === go)?.items || []).map((i) => i.id);
const reorder = (go, itemIds, c = admin) => api('POST', `/api/admin/orders/${go}/items/reorder`, { itemIds }, c);
const move = (id, toOrderId, extra = {}, c = admin) => api('POST', `/api/admin/items/${id}/move`, { toOrderId, ...extra }, c);
const sortOf = async (id) => (await app.q('SELECT sort_order AS s, order_id AS o FROM items WHERE id = ?', [id]))[0];

test('NEW ITEMS GO TO THE END; REORDERING PUTS THE LIST (AND THE JOINERS\' PAGE) IN YOUR ORDER — hidden and cancelled items are part of the list, and the new order is recorded', async () => {
  const { id: go } = await goOrder(); const [a, b, c] = [await item(go, 'A'), await item(go, 'B'), await item(go, 'C')]; assert.deepEqual(await ids(go), [a, b, c], 'in the order they were added');
  const hidden = await item(go, 'Hidden bonus', { hidden: true }), gone = await item(go, 'Cancelled one'); assert.equal((await api('POST', `/api/admin/items/${gone}/cancel`, { confirm: 'Cancelled one' })).status, 200); assert.deepEqual(await ids(go), [a, b, c, hidden, gone]);
  const r = await reorder(go, [c, hidden, a, gone, b]); assert.equal(r.status, 200, r.text); assert.deepEqual(await ids(go), [c, hidden, a, gone, b], 'the GOM\'s list'); assert.deepEqual(await pubIds(go), [c, a, b], 'the joiners\' page: the same order, without the hidden and cancelled ones');
  assert.deepEqual([(await sortOf(c)).s, (await sortOf(hidden)).s, (await sortOf(b)).s], [1, 2, 5], 'numbered 1…n');
  const offer = await api('POST', `/api/admin/orders/${go}/benefits`, { title: 'Spend £5', threshold: 5, quantity: 1, newBonusTitle: 'New free bonus', itemIds: [a] }); assert.equal(offer.status, 201, offer.text); const bonusId = (await ids(go)).at(-1); assert.equal((await order(go)).items.at(-1).title, 'New free bonus', 'a bonus item made for a benefit goes to the end too'); assert.deepEqual((await ids(go)).slice(0, 5), [c, hidden, a, gone, b]);
  const d = await item(go, 'D (added after)'); void bonusId; assert.deepEqual((await ids(go)).slice(0, 5), [c, hidden, a, gone, b]); assert.equal((await ids(go)).at(-1), d, 'a new item goes to the END, not the top'); assert.deepEqual((await pubIds(go)).slice(0, 3), [c, a, b]); assert.equal((await pubIds(go)).at(-1), d);
  assert.ok((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.reorder_items'"))[0].n >= 1, 'recorded');
});

test('REORDER RULES: the whole list must be sent (a missing, extra, repeated or other order\'s item is refused and NOTHING changes); not for a card bundle; only the GOM', async () => {
  const { id: go } = await goOrder(); const other = (await goOrder()).id; const [a, b, c] = [await item(go, 'A'), await item(go, 'B'), await item(go, 'C')]; const foreign = await item(other, 'Foreign'); const same = async () => assert.deepEqual(await ids(go), [a, b, c], 'unchanged');
  for (const bad of [[a, b], [a, b, c, foreign], [a, a, b], [a, b, foreign]]) { const r = await reorder(go, bad); assert.deepEqual([r.status, r.json.code], [409, 'stale_list'], JSON.stringify(bad)); await same(); }
  assert.equal((await reorder(go, [])).status, 400); assert.equal((await reorder(go, [a, 0, c])).status, 400); assert.equal((await api('POST', `/api/admin/orders/${go}/items/reorder`, {})).status, 400); assert.equal((await reorder(999999, [a])).status, 404);
  const g = await api('POST', '/api/admin/groups', { name: u('Cards group ') }); await app.q('INSERT INTO group_orders (group_id, title, status, is_private, is_cards) VALUES (?, ?, ?, 0, 1)', [g.json.id, u('Bundle '), 'open']); const cardsGo = (await app.q('SELECT MAX(id) AS id FROM group_orders'))[0].id; assert.deepEqual([(await reorder(cardsGo, [1])).status, (await reorder(cardsGo, [1])).json.code], [409, 'managed_in_cards']);
  const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await reorder(go, [c, b, a], j)).status, 403); assert.equal((await app.api('POST', `/api/admin/orders/${go}/items/reorder`, { itemIds: [c, b, a] })).status, 401); await same();
});

test('MOVE AN ITEM TO ANOTHER GROUP ORDER, CLAIMS AND ALL: the item and every claim (even a cancelled one) follow, it goes to the end of that list, nothing else about the claims changes; the preview says what will change and changes nothing', async () => {
  const A = await goOrder('Sam', { paymentDeadline: '2027-03-01' }), B = await goOrder('Yuki', { paymentDeadline: '2027-04-15' }); const one = await item(A.id, 'First in A'), mover = await item(A.id, 'The mover'), last = await item(A.id, 'Last in A'); const existing = await item(B.id, 'Already in B');
  const [c1] = await claimAndSecure(app, admin, u('mv'), mover), [c2] = await claimAndSecure(app, admin, u('mv'), mover); assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: [c2] })).status, 200);
  const snap = async () => (await app.q('SELECT c.id, c.status, c.label, c.pipeline, c.joiner_id AS j, (SELECT COALESCE(SUM(cost), 0) FROM claim_costs WHERE claim_id = c.id) AS cost FROM claims c WHERE c.item_id = ? ORDER BY c.id', [mover])).map((r) => ({ ...r, cost: Number(r.cost) }));
  const before = await snap(); const pv = await move(mover, B.id, { preview: true }); assert.equal(pv.status, 200, pv.text); assert.deepEqual([pv.json.preview, pv.json.item, pv.json.from.title, pv.json.to.title, pv.json.claims, pv.json.liveClaims], [true, 'The mover', A.title, B.title, 2, 1]);
  assert.deepEqual(pv.json.payBy, { from: '2027-03-01', to: '2027-04-15', changes: true, own: false }, 'no pay-by date of its own: it follows the new group order'); assert.deepEqual(pv.json.proxy, { from: 'Sam', to: 'Yuki', changes: true, own: false });
  assert.deepEqual([(await sortOf(mover)).o, (await ids(A.id)).includes(mover)], [A.id, true], 'the preview changed nothing'); assert.deepEqual(await snap(), before);
  const r = await move(mover, B.id); assert.equal(r.status, 200, r.text); const { preview, ok, ...real } = { ...r.json }; const { preview: p2, ...pvRest } = pv.json; void preview; void ok; void p2; assert.deepEqual(real, pvRest, 'what happened is what the preview said');
  assert.deepEqual(await ids(A.id), [one, last], 'gone from the old list, the rest keep their order'); assert.deepEqual(await ids(B.id), [existing, mover], 'at the END of the new list'); assert.equal((await sortOf(mover)).o, B.id);
  assert.deepEqual(await app.q('SELECT order_id FROM claims WHERE item_id = ?', [mover]).then((r) => r.map((x) => x.order_id)), [B.id, B.id], 'every claim, the cancelled one too'); assert.deepEqual(await snap(), before, 'nothing else about the claims changed — same status, label, stage, owner and money');
  const listed = (await api('GET', '/api/admin/claims')).json.claims.filter((c) => [c1, c2].includes(c.id)); assert.ok(listed.length >= 1 && listed.every((c) => c.orderTitle === B.title), 'the Claims tab shows the new group order'); assert.ok((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'item.move'"))[0].n >= 1, 'recorded');
  const own = await item(B.id, 'Has its own dates', { paymentDeadline: '2027-06-01', proxy: 'Own proxy' }); const pv2 = await move(own, A.id, { preview: true }); assert.deepEqual([pv2.json.payBy.changes, pv2.json.payBy.own, pv2.json.proxy.changes, pv2.json.proxy.own], [false, true, false, true], 'its own pay-by date and proxy go with it, so nothing changes there');
});

test('MOVE RULES: not to the same group order, a missing one, a cancelled or archived one, a card bundle; not a cancelled item; not an item in a purchase benefit; and only the GOM — each refusal changes nothing', async () => {
  const A = await goOrder(), B = await goOrder(); const it = await item(A.id, 'Stays put'); const still = async () => assert.equal((await sortOf(it)).o, A.id, 'still where it was');
  const same = await move(it, A.id); assert.deepEqual([same.status, same.json.code], [400, 'same_order']); assert.equal((await move(it, 999999)).status, 404); assert.equal((await move(999999, B.id)).status, 404); assert.equal((await api('POST', `/api/admin/items/${it}/move`, {})).status, 400);
  const dead = await goOrder(); assert.equal((await api('POST', `/api/admin/orders/${dead.id}/cancel`, { confirm: dead.title })).status, 200); const c1 = await move(it, dead.id); assert.deepEqual([c1.status, c1.json.code], [409, 'bad_target']); assert.match(c1.json.error, /is cancelled, so nothing can be moved into it/);
  const arch = await goOrder(); await app.q('UPDATE group_orders SET archived_at = NOW(3) WHERE id = ?', [arch.id]); const c2 = await move(it, arch.id); assert.deepEqual([c2.status, c2.json.code], [409, 'bad_target']); assert.match(c2.json.error, /is archived/);
  const g = await api('POST', '/api/admin/groups', { name: u('Cards group ') }); await app.q('INSERT INTO group_orders (group_id, title, status, is_private, is_cards) VALUES (?, ?, ?, 0, 1)', [g.json.id, u('Bundle '), 'open']); const cardsGo = (await app.q('SELECT MAX(id) AS id FROM group_orders'))[0].id; assert.deepEqual([(await move(it, cardsGo)).json.code], ['managed_in_cards'], 'into a card bundle');
  const gone = await item(A.id, 'Cancelled item'); assert.equal((await api('POST', `/api/admin/items/${gone}/cancel`, { confirm: 'Cancelled item' })).status, 200); const c3 = await move(gone, B.id); assert.deepEqual([c3.status, c3.json.code], [409, 'cancelled']);
  const album = await item(A.id, 'Album', { price: 10 }), bonus = await item(A.id, 'Free photocard', { price: 0 }); const offer = await api('POST', `/api/admin/orders/${A.id}/benefits`, { title: 'Spend £10', threshold: 10, quantity: 1, bonusItemId: bonus, itemIds: [album] }); assert.equal(offer.status, 201, offer.text);
  for (const inOffer of [album, bonus]) { const r = await move(inOffer, B.id); assert.deepEqual([r.status, r.json.code], [409, 'in_benefit'], inOffer === album ? 'a qualifying item' : 'the bonus item'); assert.equal((await sortOf(inOffer)).o, A.id); }
  const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await move(it, B.id, {}, j)).status, 403); assert.equal((await app.api('POST', `/api/admin/items/${it}/move`, { toOrderId: B.id })).status, 401); await still();
});

test('ITEMS CAN\'T BE ADDED TO A CANCELLED OR ARCHIVED GROUP ORDER (e.g. from a page left open) — a clear refusal, nothing created; a normal one is fine', async () => {
  const live = await goOrder(), dead = await goOrder(), arch = await goOrder(); assert.equal((await api('POST', `/api/admin/orders/${dead.id}/cancel`, { confirm: dead.title })).status, 200); await app.q('UPDATE group_orders SET archived_at = NOW(3) WHERE id = ?', [arch.id]);
  const make = (go) => api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'New thing', price: 3 });
  const a = await make(dead.id); assert.deepEqual([a.status, a.json.code], [409, 'bad_target']); assert.match(a.json.error, /is cancelled, so items can't be added to it\./); const b = await make(arch.id); assert.deepEqual([b.status, b.json.code], [409, 'bad_target']); assert.match(b.json.error, /is archived/);
  assert.deepEqual([(await ids(dead.id)).length, (await ids(arch.id)).length], [0, 0], 'nothing was created'); assert.equal((await make(live.id)).status, 201, 'a normal group order is fine');
});

