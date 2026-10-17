import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';

// A TOTAL purchase limit on an item (a store limit, a bulky item): at most N claims across everyone, first come first served. It counts the whole item together, or each version/member/size on its own.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'lm') => `${x}${++N}`;
const goOrder = async (title = u('Limit GO ')) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam' })).json.id;
const item = async (go, extra = {}) => { const r = await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title: u('Thing '), ...extra }); assert.equal(r.status, 201, r.text); return r.json.id; };
const claim = (lines, handle = u()) => app.api('POST', '/api/claims', { handle, lines });
const count = async (itemId) => (await app.q("SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND status <> 'cancelled'", [itemId]))[0].n;
const limitOf = async (go, itemId) => (await app.api('GET', '/api/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === itemId).limit;
const adminLimit = async (go, itemId) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === itemId).limit;

test('A TOTAL LIMIT ON THE WHOLE ITEM: claims are accepted until it is reached, then refused with a plain message; asking for more than is left says how many are', async () => {
  const go = await goOrder(); const it = await item(go, { title: 'Bulky photobook', purchaseLimit: 3 });
  assert.equal((await claim([{ itemId: it }])).status, 201); assert.equal((await claim([{ itemId: it, qty: 2 }])).status, 201); assert.equal(await count(it), 3);
  const over = await claim([{ itemId: it }]); assert.deepEqual([over.status, over.json.code], [409, 'limit_reached']); assert.equal(over.json.error, 'Sorry — “Bulky photobook” has reached its purchase limit (limit 3 in total).');
  const it2 = await item(go, { title: 'Almost gone', purchaseLimit: 3 }); await claim([{ itemId: it2, qty: 2 }]); const some = await claim([{ itemId: it2, qty: 2 }]);
  assert.deepEqual([some.status, some.json.error], [409, 'Only 1 left of “Almost gone” (limit 3 in total) — you asked for 2.']); assert.equal(await count(it2), 2, 'nothing was taken from a refused request');
});

test('A REFUSED REQUEST TAKES NOTHING — even the lines that were fine (all or nothing)', async () => {
  const go = await goOrder(); const ok = await item(go, { title: 'Fine item' }), full = await item(go, { title: 'Full item', purchaseLimit: 1 }); await claim([{ itemId: full }]);
  const h = u(); const r = await claim([{ itemId: ok, qty: 2 }, { itemId: full }], h); assert.equal(r.status, 409); assert.equal(await count(ok), 0, 'the fine line was not kept either'); assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ?', [h]))[0].n, 0);
});

test('REQUESTS COUNT THE MOMENT THEY ARE MADE (first come first served), and CANCELLING A CLAIM FREES ITS PLACE', async () => {
  const go = await goOrder(); const it = await item(go, { purchaseLimit: 2 }); const a = await claim([{ itemId: it }]), b = await claim([{ itemId: it }]); assert.deepEqual([a.status, b.status], [201, 201]); assert.equal((await claim([{ itemId: it }])).status, 409, 'unsecured requests already hold a place');
  const [first] = await app.q("SELECT id FROM claims WHERE item_id = ? ORDER BY id LIMIT 1", [it]); assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: [first.id] })).status, 200);
  assert.equal((await limitOf(go, it)).left, 1, 'a place is free again'); assert.equal((await claim([{ itemId: it }])).status, 201); assert.equal((await claim([{ itemId: it }])).status, 409);
});

test('EACH MEMBER / SIZE CAN HAVE ITS OWN LIMIT ("each version separately"): one option filling up leaves the others open; "whole item" counts them together', async () => {
  const go = await goOrder(); const members = await item(go, { type: 'independent', members: ['Han', 'Felix'], title: 'Per member', purchaseLimit: 2, limitScope: 'option' });
  assert.equal((await claim([{ itemId: members, member: 'Han', qty: 2 }])).status, 201); const han = await claim([{ itemId: members, member: 'Han' }]); assert.deepEqual([han.status, han.json.error], [409, 'Sorry — “Per member — Han” has reached its purchase limit (limit 2 of each).']);
  assert.equal((await claim([{ itemId: members, member: 'Felix', qty: 2 }])).status, 201, 'Felix is a separate limit'); const sizes = await item(go, { type: 'size', variants: ['M', 'L'], title: 'Per size', purchaseLimit: 1, limitScope: 'option' });
  assert.equal((await claim([{ itemId: sizes, variant: 'M' }])).status, 201); assert.equal((await claim([{ itemId: sizes, variant: 'M' }])).status, 409); assert.equal((await claim([{ itemId: sizes, variant: 'L' }])).status, 201, 'sizes count separately');
  const whole = await item(go, { type: 'independent', members: ['A', 'B'], title: 'Whole', purchaseLimit: 3, limitScope: 'item' }); await claim([{ itemId: whole, member: 'A', qty: 2 }]); await claim([{ itemId: whole, member: 'B' }]); const more = await claim([{ itemId: whole, member: 'B' }]);
  assert.deepEqual([more.status, more.json.error], [409, 'Sorry — “Whole” has reached its purchase limit (limit 3 in total).'], 'the whole item together: 2 + 1 = 3');
});

test('MEMBER SETS: a limit per part counts each member on its own; a whole-item limit counts all parts together', async () => {
  const go = await goOrder(); const per = await item(go, { type: 'set', members: ['A', 'B', 'C'], title: 'Set per part', purchaseLimit: 2, limitScope: 'option' });
  const parts = (p) => [{ itemId: per, parts: p.map(([member, qty]) => ({ member, qty })) }]; assert.equal((await claim(parts([['A', 2]]))).status, 201); const third = await claim(parts([['A', 1]])); assert.deepEqual([third.status, third.json.code], [409, 'limit_reached']); assert.equal((await claim(parts([['B', 2], ['C', 1]]))).status, 201);
  const total = await item(go, { type: 'set', members: ['A', 'B'], title: 'Set total', purchaseLimit: 3, limitScope: 'item' }); const tp = (p) => [{ itemId: total, parts: p.map(([member, qty]) => ({ member, qty })) }]; assert.equal((await claim(tp([['A', 2], ['B', 1]]))).status, 201); assert.equal((await claim(tp([['B', 1]]))).status, 409, 'three parts in all');
  assert.equal(await count(total), 3);
});

test('WHAT JOINERS (AND THE GOM) SEE: the limit, how many are used and left — whole-item or per option; null when there is no limit; it follows claims as they come and go', async () => {
  const go = await goOrder(); const none = await item(go), lim = await item(go, { purchaseLimit: 5 }), opt = await item(go, { type: 'independent', members: ['Han', 'Felix'], purchaseLimit: 2, limitScope: 'option' });
  assert.equal(await limitOf(go, none), null); assert.deepEqual(await limitOf(go, lim), { n: 5, scope: 'item', used: 0, left: 5 }); await claim([{ itemId: lim, qty: 2 }]); assert.deepEqual(await limitOf(go, lim), { n: 5, scope: 'item', used: 2, left: 3 });
  await claim([{ itemId: opt, member: 'Han', qty: 2 }]); await claim([{ itemId: opt, member: 'Felix' }]); assert.deepEqual(await limitOf(go, opt), { n: 2, scope: 'option', options: { Han: { used: 2, left: 0 }, Felix: { used: 1, left: 1 } } });
  assert.deepEqual(await adminLimit(go, lim), { n: 5, scope: 'item', used: 2, left: 3 }, 'the GOM sees the same'); assert.ok(!JSON.stringify((await app.api('GET', '/api/orders')).json).includes('"handle"'), 'and never who claimed');
});

test('TWO PEOPLE GRABBING THE LAST PLACE AT THE SAME MOMENT: exactly one gets it, and the limit is never exceeded', async () => {
  const go = await goOrder(); const it = await item(go, { purchaseLimit: 3 }); await claim([{ itemId: it, qty: 2 }]);
  const results = await Promise.all(Array.from({ length: 6 }, () => claim([{ itemId: it }]))); assert.equal(results.filter((r) => r.status === 201).length, 1, 'only one of six got the last place'); assert.equal(results.filter((r) => r.status === 409).length, 5); assert.equal(await count(it), 3, 'never over the limit');
});

test('THE GOM ADDING A CLAIM MAY GO PAST THE LIMIT — but only knowingly: refused with the same code unless overrideLimit; a joiner can never override; "left" never goes negative', async () => {
  const go = await goOrder(); const it = await item(go, { title: 'Capped', purchaseLimit: 1 }); await claim([{ itemId: it }]); const h = u('vip'); const add = (extra = {}) => api('POST', '/api/admin/claims/add', { handle: h, createHandle: true, status: 'requested', lines: [{ itemId: it }], ...extra });
  const refused = await add(); assert.deepEqual([refused.status, refused.json.code], [409, 'limit_reached']); assert.equal(await count(it), 1); const knowingly = await add({ overrideLimit: true }); assert.equal(knowingly.status, 201, knowingly.text); assert.equal(await count(it), 2);
  assert.deepEqual(await adminLimit(go, it), { n: 1, scope: 'item', used: 2, left: 0 }, 'over the limit is shown as used 2, left 0');
  const sneaky = await app.api('POST', '/api/claims', { handle: u(), overrideLimit: true, lines: [{ itemId: it }] }); assert.equal(sneaky.status, 409, 'a joiner sending overrideLimit is still refused'); assert.equal(await count(it), 2);
});

test('FIXING A CLAIM ONTO A LIMITED ITEM OR OPTION is checked too (its own current place does not count against it); overrideLimit allows it knowingly', async () => {
  const go = await goOrder(); const a = await item(go, { title: 'Source' }), cap = await item(go, { title: 'Capped target', purchaseLimit: 1 }); await claim([{ itemId: cap }]); const [{ id: moving }] = (await claim([{ itemId: a }]).then(() => app.q('SELECT id FROM claims WHERE item_id = ?', [a])));
  const refused = await api('POST', `/api/admin/claims/${moving}/change`, { itemId: cap, pricing: 'reprice' }); assert.deepEqual([refused.status, refused.json.code], [409, 'limit_reached']); assert.equal((await app.q('SELECT item_id FROM claims WHERE id = ?', [moving]))[0].item_id, a, 'unchanged');
  assert.equal((await api('POST', `/api/admin/claims/${moving}/change`, { itemId: cap, pricing: 'reprice', overrideLimit: true })).status, 200); assert.equal(await count(cap), 2);
  const m = await item(go, { type: 'independent', members: ['Han', 'Felix'], title: 'Opt target', purchaseLimit: 1, limitScope: 'option' }); await claim([{ itemId: m, member: 'Han' }]); const mine = await claim([{ itemId: m, member: 'Felix' }]); void mine; const [{ id: own }] = await app.q("SELECT id FROM claims WHERE item_id = ? AND member_name = 'Felix'", [m]);
  assert.equal((await api('POST', `/api/admin/claims/${own}/change`, { itemId: m, member: 'Han' })).status, 409, 'Han is full'); await app.q("UPDATE claims SET status = 'cancelled' WHERE item_id = ? AND member_name = 'Han'", [m]); assert.equal((await api('POST', `/api/admin/claims/${own}/change`, { itemId: m, member: 'Han' })).status, 200, 'now it has room — and its own old place (Felix) did not get in the way');
});

test('MOVING A CLAIM WITHIN AN ITEM THAT IS EXACTLY AT ITS WHOLE-ITEM LIMIT is allowed (the total does not change) — its own place never blocks itself', async () => {
  const go = await goOrder(); const it = await item(go, { type: 'independent', members: ['Han', 'Felix'], title: 'At the limit', purchaseLimit: 2, limitScope: 'item' }); await claim([{ itemId: it, member: 'Han' }]); await claim([{ itemId: it, member: 'Felix' }]);
  assert.equal(await count(it), 2); const [{ id }] = await app.q("SELECT id FROM claims WHERE item_id = ? AND member_name = 'Han'", [it]); const moved = await api('POST', `/api/admin/claims/${id}/change`, { itemId: it, member: 'Felix' }); assert.equal(moved.status, 200, moved.text);
  assert.deepEqual([(await app.q('SELECT member_name FROM claims WHERE id = ?', [id]))[0].member_name, await count(it)], ['Felix', 2], 'moved, and the total is still 2');
  const other = await item(go, { title: 'Elsewhere' }); const [{ id: oc }] = (await claim([{ itemId: other }]).then(() => app.q('SELECT id FROM claims WHERE item_id = ?', [other]))); const into = await api('POST', `/api/admin/claims/${oc}/change`, { itemId: it, member: 'Han', pricing: 'reprice' }); assert.equal(into.status, 409, 'but moving a claim IN from another item does add one, and is refused');
});

test('SETTING, CHANGING AND CLEARING A LIMIT: on create or edit; blank clears it; lowering it cancels nothing; bad values refused; a plain item is always "whole item"; GOM only; recorded', async () => {
  const go = await goOrder(); const it = await item(go, { purchaseLimit: 4, limitScope: 'option' }); assert.deepEqual(await adminLimit(go, it), { n: 4, scope: 'item', used: 0, left: 4 }, 'a plain item has no options, so it counts as a whole'); assert.equal((await app.q('SELECT limit_scope FROM items WHERE id = ?', [it]))[0].limit_scope, 'item', 'and that is what is stored');
  await claim([{ itemId: it, qty: 3 }]); assert.equal((await api('PATCH', `/api/admin/items/${it}`, { purchaseLimit: 2 })).status, 200); assert.equal(await count(it), 3, 'lowering the limit cancels nothing'); assert.deepEqual(await adminLimit(go, it), { n: 2, scope: 'item', used: 3, left: 0 });
  assert.equal((await claim([{ itemId: it }])).status, 409); assert.equal((await api('PATCH', `/api/admin/items/${it}`, { purchaseLimit: null })).status, 200); assert.equal(await adminLimit(go, it), null); assert.equal((await claim([{ itemId: it }])).status, 201, 'no limit: open again');
  const set = await item(go, { type: 'independent', members: ['A', 'B'], purchaseLimit: 2 }); assert.equal((await api('PATCH', `/api/admin/items/${set}`, { limitScope: 'option' })).status, 200); assert.equal((await adminLimit(go, set)).scope, 'option'); assert.equal((await api('PATCH', `/api/admin/items/${set}`, { limitScope: 'item' })).status, 200); assert.equal((await adminLimit(go, set)).scope, 'item');
  for (const bad of [0, -1, 10000, 2.5, 'x']) assert.equal((await api('PATCH', `/api/admin/items/${it}`, { purchaseLimit: bad })).status, 400, `${bad} is refused`); assert.equal((await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 1, title: 'x', purchaseLimit: 0 })).status, 400);
  const rnd = await item(go, { type: 'random', purchaseLimit: 2, limitScope: 'option' }); assert.equal((await app.q('SELECT limit_scope FROM items WHERE id = ?', [rnd]))[0].limit_scope, 'item', 'a random item has no options to count separately'); await claim([{ itemId: rnd, qty: 2 }]); assert.equal((await claim([{ itemId: rnd }])).status, 409, 'so it is simply limited as a whole');
  const j = await app.login(`${u('jj')}@x.com`); assert.equal((await api('PATCH', `/api/admin/items/${it}`, { purchaseLimit: 1 }, j)).status, 403); assert.equal((await app.api('PATCH', `/api/admin/items/${it}`, { purchaseLimit: 1 })).status, 401);
  assert.ok((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'item.limit' AND entity_id = ?", [it]))[0].n >= 2, 'each change is recorded');
});

test('ADDING SOMEONE TO A PART OF A SET BY HAND (Sets tab) HONOURS THE LIMIT TOO: a full item refuses with the reason unless you knowingly go past it; a part-by-part limit only counts that part', async () => {
  const go = await goOrder(); const it = await item(go, { type: 'set', members: ['Han', 'Felix', 'Yuna'], title: 'Hand-added set', purchaseLimit: 2, limitScope: 'item' });
  await claim([{ itemId: it, parts: [{ member: 'Han', qty: 1 }, { member: 'Felix', qty: 1 }] }]);                              // 2 of the 2 allowed — Yuna is still a free part of Set 1
  const [{ id: setId }] = await app.q('SELECT id FROM item_sets WHERE item_id = ? ORDER BY set_number LIMIT 1', [it]); const add = (member, extra = {}) => api('POST', `/api/admin/sets/${setId}/slots`, { member, handle: u('hand'), ...extra });
  const refused = await add('Yuna'); assert.deepEqual([refused.status, refused.json.code], [409, 'limit_reached']); assert.equal(refused.json.error, 'Sorry — “Hand-added set” has reached its purchase limit (limit 2 in total).'); assert.equal(await count(it), 2, 'nothing was added');
  const knowingly = await add('Yuna', { overrideLimit: true }); assert.equal(knowingly.status, 201, knowingly.text); assert.equal(await count(it), 3, 'added, over the limit, because you said so');
  const per = await item(go, { type: 'set', members: ['A', 'B'], title: 'Per-part set', purchaseLimit: 1, limitScope: 'option' }); await claim([{ itemId: per, parts: [{ member: 'A', qty: 1 }] }]);
  const [{ id: perSet }] = await app.q('SELECT id FROM item_sets WHERE item_id = ? ORDER BY set_number LIMIT 1', [per]); const ok = await api('POST', `/api/admin/sets/${perSet}/slots`, { member: 'B', handle: u('hand') }); assert.equal(ok.status, 201, 'B has its own limit, and it is free'); assert.equal(await count(per), 2);
  assert.equal((await api('POST', `/api/admin/sets/${perSet}/slots`, { member: 'B', handle: u('hand') })).status, 409, 'and now that part is taken'); assert.equal((await app.api('POST', `/api/admin/sets/${setId}/slots`, { member: 'Yuna', handle: u('x'), overrideLimit: true })).status, 401, 'only the GOM can');
});
