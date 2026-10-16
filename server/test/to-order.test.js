import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';

// "What still needs ordering": SECURED claims that are still at "awaiting fulfillment", counted per group order → item → OPTION (member / size). Marking them ordered takes them off.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'to') => `${x}${++N}`;
const goOrder = async (extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Order GO '), proxy: 'Sam', ...extra })).json.id;
const item = async (go, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price: 5, ...extra })).json.id;
const claim = (handle, lines) => app.api('POST', '/api/claims', { handle, lines });
const secure = (go) => api('POST', '/api/admin/claims/secure', { orderId: go });
const list = async () => (await api('GET', '/api/admin/incoming/to-order')).json;
const mine = async (go) => (await list()).rows.filter((r) => r.orderId === go);
const sum = (rows) => rows.reduce((n, r) => n + r.qty, 0);
const claimIds = async (go) => (await api('GET', `/api/admin/claims?order=${go}`)).json.claims.map((c) => c.id);

test('SECURED CLAIMS ARE COUNTED PER OPTION: a plain item by its total, a size item per size, a member item per member — and only once they are secured', async () => {
  const go = await goOrder(); const plain = await item(go, { title: 'Plain album' }), tee = await item(go, { type: 'size', variants: ['M', 'L'], title: 'Tee' }), cards = await item(go, { type: 'independent', members: ['Han', 'Felix'], title: 'Cards' });
  for (let i = 0; i < 5; i++) await claim(u('p'), [{ itemId: plain }]);
  await claim(u('p'), [{ itemId: tee, variant: 'M', qty: 2 }]); await claim(u('p'), [{ itemId: tee, variant: 'L' }]); await claim(u('p'), [{ itemId: cards, member: 'Han', qty: 3 }]); await claim(u('p'), [{ itemId: cards, member: 'Felix' }]);
  assert.deepEqual(await mine(go), [], 'requests are not on the list: nothing is secured yet');
  assert.equal((await secure(go)).status, 200);
  assert.deepEqual((await mine(go)).map((r) => [r.item, r.option, r.qty]), [['Plain album', null, 5], ['Tee', 'L', 1], ['Tee', 'M', 2], ['Cards', 'Felix', 1], ['Cards', 'Han', 3]], 'the "5×, 3×, 1×" list, by option');
  assert.equal((await list()).total >= 12, true);
});

test('MEMBER SETS ARE COUNTED BY MEMBER (secured sets only): each secured set contributes one of each member that has been claimed', async () => {
  const go = await goOrder(); const set = await item(go, { type: 'set', members: ['A', 'B', 'C'], price: 4, title: 'Photocard set' });
  await claim(u('s'), [{ itemId: set, parts: [{ member: 'A', qty: 1 }, { member: 'B', qty: 1 }], together: true }]); await claim(u('s'), [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }]);   // set 1: A+B, set 2: A
  assert.deepEqual(await mine(go), [], 'sets that are not secured are not on the list');
  const sets = (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === set); for (const s of sets) assert.equal((await api('POST', `/api/admin/sets/${s.id}/secure`, {})).status, 200);
  assert.deepEqual((await mine(go)).map((r) => [r.option, r.qty]), [['A', 2], ['B', 1]], 'two A and one B to order');
});

test('MARKING THINGS ORDERED TAKES THEM OFF; cancelled claims, cancelled items and test orders are never on it; a private order IS', async () => {
  const go = await goOrder(); const it = await item(go, { title: 'Moves on' }); const hs = [u('m'), u('m'), u('m'), u('m')]; for (const h of hs) await claim(h, [{ itemId: it }]); await secure(go);
  assert.equal(sum(await mine(go)), 4); const ids = await claimIds(go);
  assert.equal((await api('POST', '/api/admin/claims/pipeline', { claimIds: ids.slice(0, 3), pipeline: 'ordered via proxy / warehouse' })).status, 200); assert.equal(sum(await mine(go)), 1, 'three ordered, one still to order');
  assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: [ids[3]] })).status, 200); assert.deepEqual(await mine(go), [], 'a cancelled claim is not something to order');
  const dead = await goOrder(); const di = await item(dead); await claim(u('c'), [{ itemId: di }]); await secure(dead); assert.equal(sum(await mine(dead)), 1); await api('POST', `/api/admin/items/${di}/cancel`, { confirm: (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === dead).items[0].title }); assert.deepEqual(await mine(dead), [], 'a cancelled item is left out');
  const test_ = await goOrder({ isTest: true }); const ti = await item(test_); await api('POST', '/api/admin/claims/add', { handle: u('t'), createHandle: true, status: 'confirmed', lines: [{ itemId: ti }] }); assert.deepEqual(await mine(test_), [], 'test orders are left out');
  const priv = await goOrder({ isPrivate: true }); const pi = await item(priv); await api('POST', '/api/admin/claims/add', { handle: u('dm'), createHandle: true, status: 'confirmed', lines: [{ itemId: pi }] }); assert.equal(sum(await mine(priv)), 1, 'an order that came by message still has to be ordered');
});

test('EACH ROW SAYS WHICH PROXY ORDERS IT: the item\'s own proxy, else its order\'s; none means you', async () => {
  const go = await goOrder({ proxy: 'Sam' }); const own = await item(go, { title: 'Yuki item', proxy: 'Yuki' }), inherits = await item(go, { title: 'Sam item' });
  await claim(u('x'), [{ itemId: own }, { itemId: inherits }]); await secure(go); assert.deepEqual((await mine(go)).map((r) => [r.item, r.proxy]), [['Yuki item', 'Yuki'], ['Sam item', 'Sam']]);
  const mine_ = await goOrder({ proxy: null }); const mi = await item(mine_, { title: 'Mine' }); await claim(u('y'), [{ itemId: mi }]); await secure(mine_); assert.equal((await mine(mine_))[0].proxy, null, 'no proxy: you order it yourself');
});

test('THE LIST IS FOR THE GOM ONLY', async () => {
  const j = await app.login(`${u('jj')}@x.com`); assert.equal((await api('GET', '/api/admin/incoming/to-order', undefined, j)).status, 403); assert.equal((await app.api('GET', '/api/admin/incoming/to-order')).status, 401);
});
