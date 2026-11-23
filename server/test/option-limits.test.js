import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';

// A LIMIT ON ONE OPTION: washi tape — Green 3 available, Red 2. For member items and size items; the item's own limit rule still applies where an option has no number of its own.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ol') => `${x}${++N}`;
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Option limit GO '), proxy: 'Sam' })).json.id;
const item = async (go, extra = {}) => { const r = await api('POST', `/api/admin/orders/${go}/items`, { type: 'independent', price: 3, title: 'Washi tape', members: ['Green', 'Red', 'Blue'], ...extra }); assert.equal(r.status, 201, r.text); return r.json.id; };
const claim = (lines, handle = u()) => app.api('POST', '/api/claims', { handle, lines });
const adminItem = async (go, id) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === id);
const pubItem = async (go, id) => (await app.api('GET', '/api/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === id);
const mid = async (go, id, name) => (await adminItem(go, id)).members.find((m) => m.name === name).id;
const vid = async (go, id, label) => (await adminItem(go, id)).variantLimits.find((v) => v.label === label).id;
const setM = async (go, id, limits) => { const r = await api('PATCH', `/api/admin/items/${id}`, { memberLimits: await Promise.all(Object.entries(limits).map(async ([n, limit]) => ({ id: await mid(go, id, n), limit }))) }); assert.equal(r.status, 200, r.text); };
const used = async (id, opt) => (await app.q("SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND status <> 'cancelled' AND COALESCE(member_name, variant_label) = ?", [id, opt]))[0].n;

test('WASHI TAPE: GREEN 3, RED 2 — each option stops at its own number, with plain messages; an option with no number is unlimited; a refused request takes nothing', async () => {
  const go = await goOrder(); const it = await item(go); await setM(go, it, { Green: 3, Red: 2 });
  assert.equal((await claim([{ itemId: it, member: 'Green', qty: 3 }])).status, 201); const g4 = await claim([{ itemId: it, member: 'Green' }]); assert.deepEqual([g4.status, g4.json.code, g4.json.error], [409, 'limit_reached', 'Sorry — “Washi tape — Green” has reached its purchase limit (limit 3).']);
  assert.equal((await claim([{ itemId: it, member: 'Red' }])).status, 201); const r2 = await claim([{ itemId: it, member: 'Red', qty: 2 }]); assert.deepEqual([r2.status, r2.json.error], [409, 'Only 1 left of “Washi tape — Red” (limit 2) — you asked for 2.']); assert.equal(await used(it, 'Red'), 1, 'nothing was taken from the refused request');
  assert.equal((await claim([{ itemId: it, member: 'Red' }])).status, 201); assert.equal((await claim([{ itemId: it, member: 'Red' }])).status, 409, 'Red is now full too'); assert.equal((await claim([{ itemId: it, member: 'Blue', qty: 20 }])).status, 201, 'Blue has no number: unlimited');
  const h = u(); assert.equal((await claim([{ itemId: it, member: 'Green' }], h)).status, 409); assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND status <> 'cancelled' AND member_name = 'Green'", [it]))[0].n, 3);
});

test('WHAT THE SCREENS ARE SENT: per option its limit, used and left (an option with no number is not listed); the GOM also gets each member\'s own number, joiners never do', async () => {
  const go = await goOrder(); const it = await item(go); await setM(go, it, { Green: 3, Red: 2 }); await claim([{ itemId: it, member: 'Green' }]); await claim([{ itemId: it, member: 'Red', qty: 2 }]);
  const pub = await pubItem(go, it); assert.deepEqual(pub.limit, { n: null, scope: 'option', options: { Green: { used: 1, left: 2, n: 3, own: true }, Red: { used: 2, left: 0, n: 2, own: true } } }); assert.equal(pub.members.some((m) => 'ownLimit' in m || 'id' in m), false, 'joiners get no ids or own numbers');
  const adm = await adminItem(go, it); assert.deepEqual(adm.members.map((m) => [m.name, m.ownLimit]), [['Green', 3], ['Red', 2], ['Blue', null]]); assert.deepEqual(adm.limit, pub.limit); const none = await item(await goOrder(), { title: 'No limits' }); assert.equal((await adminItem((await api('GET', '/api/admin/orders')).json.orders.find((o) => o.items.some((i) => i.id === none)).id, none)).limit, null, 'nothing set: no limit object, as before');
});

test('WITH THE ITEM\'S OWN LIMIT: "N of each" is the fallback for options with no number of their own (and an own number replaces it); a whole-item total still caps everything — the stricter wins', async () => {
  const go = await goOrder(); const each = await item(go, { title: 'Each of 5', purchaseLimit: 5, limitScope: 'option' }); await setM(go, each, { Green: 3 });
  assert.deepEqual((await pubItem(go, each)).limit, { n: 5, scope: 'option', options: { Green: { used: 0, left: 3, n: 3, own: true }, Red: { used: 0, left: 5, n: 5, own: false }, Blue: { used: 0, left: 5, n: 5, own: false } } });
  assert.equal((await claim([{ itemId: each, member: 'Green', qty: 3 }])).status, 201); assert.equal((await claim([{ itemId: each, member: 'Green' }])).status, 409, 'Green stops at its own 3'); assert.equal((await claim([{ itemId: each, member: 'Red', qty: 5 }])).status, 201, 'Red follows the item\'s 5 of each'); const r6 = await claim([{ itemId: each, member: 'Red' }]); assert.equal(r6.json.error, 'Sorry — “Each of 5 — Red” has reached its purchase limit (limit 5 of each).');
  const total = await item(go, { title: 'Total of 4', purchaseLimit: 4, limitScope: 'item' }); await setM(go, total, { Green: 3, Red: 2 }); assert.equal((await claim([{ itemId: total, member: 'Green', qty: 3 }])).status, 201); assert.equal((await claim([{ itemId: total, member: 'Red' }])).status, 201, '4 of 4 now'); const over = await claim([{ itemId: total, member: 'Red' }]); assert.equal(over.json.error, 'Sorry — “Total of 4” has reached its purchase limit (limit 4 in total).', 'Red still has room of its own, but the item total is used up');
  const lim = (await pubItem(go, total)).limit; assert.deepEqual([lim.scope, lim.n, lim.used, lim.left, lim.options.Green.left, lim.options.Red.left], ['item', 4, 4, 0, 0, 1], 'both are sent: the total and each option');
});

test('SIZES TOO: a number for one size; the others are unlimited', async () => {
  const go = await goOrder(); const it = await item(go, { type: 'size', title: 'Tote bag', members: undefined, variants: ['S', 'M', 'L'] }); const r = await api('PATCH', `/api/admin/items/${it}`, { variantLimits: [{ id: await vid(go, it, 'S'), limit: 1 }, { id: await vid(go, it, 'L'), limit: 2 }] }); assert.equal(r.status, 200, r.text);
  assert.equal((await claim([{ itemId: it, variant: 'S' }])).status, 201); const s2 = await claim([{ itemId: it, variant: 'S' }]); assert.deepEqual([s2.status, s2.json.error], [409, 'Sorry — “Tote bag — S” has reached its purchase limit (limit 1).']); assert.equal((await claim([{ itemId: it, variant: 'M', qty: 9 }])).status, 201, 'M has no number'); assert.equal((await claim([{ itemId: it, variant: 'L', qty: 2 }])).status, 201);
  assert.deepEqual(Object.entries((await pubItem(go, it)).limit.options).map(([k, v]) => [k, v.left]), [['S', 0], ['L', 0]], 'only the sizes with a number are listed'); assert.deepEqual((await adminItem(go, it)).variantLimits.map((v) => [v.label, v.ownLimit]), [['S', 1], ['M', null], ['L', 2]]);
});

test('CHANGING A NUMBER: lowering never cancels claims already made (it only stops new ones, and "left" never goes below 0); clearing it frees the option; a cancelled claim gives its place back', async () => {
  const go = await goOrder(); const it = await item(go); await setM(go, it, { Green: 3 }); await claim([{ itemId: it, member: 'Green', qty: 3 }]); await setM(go, it, { Green: 1 });
  assert.equal(await used(it, 'Green'), 3, 'nothing cancelled'); assert.equal((await pubItem(go, it)).limit.options.Green.left, 0, 'left is 0, not negative'); assert.equal((await claim([{ itemId: it, member: 'Green' }])).status, 409); await setM(go, it, { Green: null }); assert.equal((await claim([{ itemId: it, member: 'Green', qty: 5 }])).status, 201, 'cleared: unlimited again'); assert.equal((await pubItem(go, it)).limit, null);
  await setM(go, it, { Red: 1 }); const first = await claim([{ itemId: it, member: 'Red' }]); assert.equal(first.status, 201); assert.equal((await claim([{ itemId: it, member: 'Red' }])).status, 409); assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: first.json.claimIds })).status, 200); assert.equal((await claim([{ itemId: it, member: 'Red' }])).status, 201, 'the cancelled place was given back');
});

test('THE GOM CAN GO PAST AN OPTION\'S NUMBER — only knowingly (the same refusal unless overrideLimit); a joiner can never override', async () => {
  const go = await goOrder(); const it = await item(go); await setM(go, it, { Green: 1 }); await claim([{ itemId: it, member: 'Green' }]); const add = (extra = {}) => api('POST', '/api/admin/claims/add', { handle: u('vip'), createHandle: true, status: 'requested', lines: [{ itemId: it, member: 'Green' }], ...extra });
  const refused = await add(); assert.deepEqual([refused.status, refused.json.code], [409, 'limit_reached']); assert.equal(await used(it, 'Green'), 1); assert.equal((await add({ overrideLimit: true })).status, 201); assert.equal(await used(it, 'Green'), 2); assert.equal((await pubItem(go, it)).limit.options.Green.left, 0, 'over the number is left 0');
  const sneaky = await app.api('POST', '/api/claims', { handle: u(), overrideLimit: true, lines: [{ itemId: it, member: 'Green' }] }); assert.equal(sneaky.status, 409);
});

test('SAVING THEM: a number is a whole number 1–9999 (blank clears); only member items and size items; only options of THIS item; recorded; only the GOM', async () => {
  const go = await goOrder(); const it = await item(go), other = await item(go, { title: 'Other tape' }); const gid = await mid(go, it, 'Green'), foreign = await mid(go, other, 'Green');
  const patch = (b, c = admin) => api('PATCH', `/api/admin/items/${it}`, b, c);
  for (const bad of [0, 10000, 1.5, -2, 'x']) assert.equal((await patch({ memberLimits: [{ id: gid, limit: bad }] })).status, 400, JSON.stringify(bad)); assert.equal((await adminItem(go, it)).members[0].ownLimit, null, 'refused numbers changed nothing');
  const wrong = await patch({ memberLimits: [{ id: foreign, limit: 2 }] }); assert.deepEqual([wrong.status, wrong.json.code], [400, 'no_such_option']); assert.equal((await adminItem(go, other)).members[0].ownLimit, null, 'the other item is untouched');
  assert.equal((await patch({ variantLimits: [{ id: gid, limit: 2 }] })).status, 400, 'a member item has member limits, not size limits'); const normal = await item(go, { type: 'normal', members: undefined, title: 'Plain' }); assert.equal((await api('PATCH', `/api/admin/items/${normal}`, { memberLimits: [{ id: gid, limit: 2 }] })).status, 400, 'a plain item has no options');
  const set = await item(go, { type: 'set', title: 'A set', members: ['A', 'B'] }); assert.deepEqual([(await api('PATCH', `/api/admin/items/${set}`, { memberLimits: [{ id: await mid(go, set, 'A'), limit: 1 }] })).status], [400], 'a member set: each set takes one of every part, so no');
  assert.equal((await patch({ memberLimits: [{ id: gid, limit: 9999 }] })).status, 200); assert.ok((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'item.option_limit'"))[0].n >= 1, 'recorded');
  const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await patch({ memberLimits: [{ id: gid, limit: 1 }] }, j)).status, 403); assert.equal((await app.api('PATCH', `/api/admin/items/${it}`, { memberLimits: [{ id: gid, limit: 1 }] })).status, 401); assert.equal((await adminItem(go, it)).members[0].ownLimit, 9999);
});
