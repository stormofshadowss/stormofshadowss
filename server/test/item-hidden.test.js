import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// "HIDE FROM JOINERS": a hidden item isn't on the public order page and nobody but the GOM can claim it (the GOM adds it for people — e.g. a free bonus photocard). Claims already on it stay.
// A purchase benefit can create its own hidden bonus item in one step.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'hd') => `${x}${++N}`;
const goOrder = async (title = u('Hide GO ')) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam' })).json.id;
const item = async (go, title = u('Thing '), extra = {}) => { const r = await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title, ...extra }); assert.equal(r.status, 201, r.text); return r.json.id; };
const publicItems = async (go) => (await app.api('GET', '/api/orders')).json.orders.find((o) => o.id === go)?.items || [];
const adminItem = async (go, id) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === id);
const count = async (itemId) => (await app.q("SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND status <> 'cancelled'", [itemId]))[0].n;

test('A HIDDEN ITEM IS NOT ON THE PUBLIC ORDER PAGE (the other items still are); the GOM still sees it, marked hidden, and the public payload carries no such field', async () => {
  const go = await goOrder(); const shown = await item(go, 'Visible album'), hidden = await item(go, 'Secret bonus', { hidden: true });
  assert.deepEqual((await publicItems(go)).map((i) => i.id), [shown], 'only the visible one is listed to joiners'); assert.ok(!(await publicItems(go)).some((i) => 'hidden' in i));
  assert.equal((await adminItem(go, hidden)).hidden, true, 'the GOM sees it, marked hidden'); assert.equal((await adminItem(go, shown)).hidden, false);
  assert.ok((await api('GET', '/api/admin/incoming')).json.options.some((o) => o.itemId === hidden), 'and it is still offered to YOU when logging a store order');
});

test('HIDE AND SHOW ANY ITEM: on create or edit; claims already on it are untouched; bad input is refused; GOM only; recorded', async () => {
  const go = await goOrder(); const it = await item(go, 'Toggle me'); const h = u('early'); await joinerSession(app, `${h}@x.com`, h); assert.equal((await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: it }] })).status, 201);
  assert.equal((await api('PATCH', `/api/admin/items/${it}`, { hidden: true })).status, 200); assert.deepEqual((await publicItems(go)).map((i) => i.id), [], 'gone from the public page'); assert.equal(await count(it), 1, 'the claim made before is untouched');
  assert.equal((await api('PATCH', `/api/admin/items/${it}`, { hidden: false })).status, 200); assert.deepEqual((await publicItems(go)).map((i) => i.id), [it], 'back again');
  assert.equal((await api('PATCH', `/api/admin/items/${it}`, { hidden: 'yes' })).status, 400); const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await api('PATCH', `/api/admin/items/${it}`, { hidden: true }, j)).status, 403); assert.equal((await app.api('PATCH', `/api/admin/items/${it}`, { hidden: true })).status, 401);
  assert.deepEqual((await app.q("SELECT action FROM audit_log WHERE entity = 'item' AND entity_id = ? AND action IN ('item.hide', 'item.unhide') ORDER BY id", [it])).map((r) => r.action), ['item.hide', 'item.unhide']);
});

test('NOBODY BUT THE GOM CAN CLAIM A HIDDEN ITEM: a joiner is told it isn\'t available (nothing is made, even for the other lines); the GOM can add it for someone; it shows in that person\'s own orders', async () => {
  const go = await goOrder(); const ok = await item(go, 'Fine item'), hid = await item(go, 'Hidden bonus', { hidden: true }); const h = u('claimer'); const cookie = await joinerSession(app, `${h}@x.com`, h);
  const r = await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: ok }, { itemId: hid }] }); assert.deepEqual([r.status, r.json.error], [404, "That item isn't available"]); assert.equal(await count(hid), 0); assert.equal(await count(ok), 0, 'the fine line was not made either');
  const add = await api('POST', '/api/admin/claims/add', { handle: h, status: 'confirmed', lines: [{ itemId: hid }] }); assert.equal(add.status, 201, add.text); assert.equal(await count(hid), 1, 'the GOM can');
  const mine = (await api('GET', `/api/my/summary?handle=${h}`, undefined, cookie)).json.orders.flatMap((o) => o.claims); assert.ok(mine.some((c) => /Hidden bonus/.test(c.label)), 'the person sees the claim you added, in their own orders');
});

test('A HIDDEN MEMBER SET CAN\'T BE CLAIMED BY JOINERS EITHER', async () => {
  const go = await goOrder(); const set = await item(go, 'Hidden set', { type: 'set', members: ['A', 'B'], hidden: true }); const r = await app.api('POST', '/api/claims', { handle: u('setter'), lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] });
  assert.deepEqual([r.status, r.json.error], [404, "That item isn't available"]); assert.equal(await count(set), 0);
});

test('A PURCHASE BENEFIT CAN CREATE ITS OWN HIDDEN BONUS ITEM IN ONE STEP: a free plain item in that order, hidden from joiners, used for the offer; adding the bonus works and the person sees it', async () => {
  const go = await goOrder(); const a = await item(go, 'Album', { price: 10 }); const h = u('earner'); const cookie = await joinerSession(app, `${h}@x.com`, h); await claimAndSecure(app, admin, h, a);
  const r = await api('POST', `/api/admin/orders/${go}/benefits`, { title: 'Spend £10, get a card', threshold: 10, quantity: 1, newBonusTitle: 'Store benefit photocard', itemIds: [a] }); assert.equal(r.status, 201, r.text); assert.equal(r.json.offer.bonusHidden, true);
  const [made] = await app.q('SELECT id, item_type, price, price_tbc, hidden_from_public, order_id FROM items WHERE title = ? AND order_id = ?', ['Store benefit photocard', go]); assert.deepEqual([made.item_type, Number(made.price), made.price_tbc, made.hidden_from_public, made.order_id], ['normal', 0, 0, 1, go]); assert.equal(r.json.offer.bonusItemId, made.id);
  assert.deepEqual((await publicItems(go)).map((i) => i.id), [a], 'joiners never see the bonus item'); assert.equal((await app.api('POST', '/api/claims', { handle: u('sneak'), lines: [{ itemId: made.id }] })).status, 404, 'and cannot claim it');
  const g = await api('POST', `/api/admin/benefits/${r.json.id}/grant`, { people: 'all' }); assert.equal(g.json.added, 1, g.text); const mine = (await api('GET', `/api/my/summary?handle=${h}`, undefined, cookie)).json.orders.flatMap((o) => o.claims); assert.ok(mine.some((c) => /Store benefit photocard/.test(c.label) && c.owed === 0), 'their own orders show the free bonus');
});

test('THE BONUS CHOICE IS VALIDATED: an existing item OR a new one (not both, not neither); a new one can\'t be used when editing; and an existing PUBLIC free item is reported as visible until you hide it', async () => {
  const go = await goOrder(); const a = await item(go, 'Album', { price: 10 }), free = await item(go, 'Public free card', { price: 0 }); const body = (extra) => ({ title: 't', threshold: 10, quantity: 1, itemIds: [a], ...extra });
  const both = await api('POST', `/api/admin/orders/${go}/benefits`, body({ bonusItemId: free, newBonusTitle: 'New one' })); assert.deepEqual([both.status, both.json.code], [400, 'bad_bonus']); const none = await api('POST', `/api/admin/orders/${go}/benefits`, body({})); assert.deepEqual([none.status, none.json.code], [400, 'bad_bonus']);
  assert.equal((await api('POST', `/api/admin/orders/${go}/benefits`, body({ newBonusTitle: '' }))).status, 400); assert.equal((await app.q('SELECT COUNT(*) AS n FROM items WHERE order_id = ?', [go]))[0].n, 2, 'a refused offer created no stray item');
  const ok = await api('POST', `/api/admin/orders/${go}/benefits`, body({ bonusItemId: free })); assert.equal(ok.status, 201); assert.equal(ok.json.offer.bonusHidden, false, 'a public free item is reported as visible'); assert.equal((await api('PATCH', `/api/admin/benefits/${ok.json.id}`, { newBonusTitle: 'x' })).json.code, 'bad_bonus');
  await api('PATCH', `/api/admin/items/${free}`, { hidden: true }); assert.equal((await api('GET', `/api/admin/orders/${go}/benefits`)).json.offers[0].bonusHidden, true, 'hiding the item is reflected');
});
