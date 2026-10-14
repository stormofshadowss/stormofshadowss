import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// The GOM adds a claim FOR someone (to fill a gap in an import, or to take an order that came by DM on a private group order): same rules as a joiner's own claim,
// but private and closed group orders are allowed, the status is chosen every time, and the person sees it in My orders like any other claim.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ad') => `${x}${++N}`;
const READY = 'ready to pack / on hand';
const goOrder = async (extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Add GO '), proxy: 'Sam', ...extra })).json.id;
const item = async (go, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price: 10, ...extra })).json.id;
const add = (body, c = admin) => api('POST', '/api/admin/claims/add', body, c);
const sess = {};
const known = async (h) => { sess[h] = await joinerSession(app, `${h}@x.com`, h); return h; };                                  // a person who exists, with a sign-in
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const mySummary = async (h) => (await api('GET', '/api/my/summary', undefined, sess[h])).json;

test('REQUESTED: the claims are made like a joiner\'s own (price, label, status requested), nothing owed yet, and the person sees them in My orders', async () => {
  const go = await goOrder(); const it = await item(go, { price: 12.5, title: 'Hoodie' }); const h = await known(u());
  const r = await add({ handle: h, status: 'requested', lines: [{ itemId: it, qty: 2 }] }); assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.json.claimIds.length, r.json.confirmed, r.json.leftAsRequests, r.json.newHandle], [2, 0, 2, false]);
  const mine = (await claimsOf(h)).filter((c) => c.order_id === go); assert.equal(mine.length, 2); assert.ok(mine.every((c) => c.status === 'requested' && c.label === 'Hoodie' && c.costs.initials.cost === 12.5));
  assert.equal((await mySummary(h)).owed.total, 0, 'a request owes nothing yet');
  const seen = (await mySummary(h)).orders.flatMap((o) => o.claims); assert.ok(seen.some((c) => /Hoodie/.test(c.label) && c.status === 'requested'), 'it appears in their My orders');
});

test('CONFIRMED: goes through the ordinary secure logic — it counts as owed straight away, and any credit they already hold is used', async () => {
  const go = await goOrder(); const it = await item(go, { price: 10 }); const h = await known(u()); const jid = (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [h]))[0].id;
  await app.q("INSERT INTO credit_ledger (joiner_id, kind, amount, balance_effect, reason) VALUES (?, 'credit', 4, 4, 'test credit')", [jid]);
  const r = await add({ handle: h, status: 'confirmed', lines: [{ itemId: it }] }); assert.equal(r.status, 201, r.text); assert.deepEqual([r.json.confirmed, r.json.leftAsRequests], [1, 0]);
  const c = (await claimsOf(h)).find((x) => x.order_id === go); assert.equal(c.status, 'confirmed'); assert.deepEqual([c.costs.initials.cost, c.costs.initials.paid], [10, 4], 'the £4 credit was applied at once');
  const s = await mySummary(h); assert.equal(s.owed.total, 6, 'they owe the rest');
});

test('THE STATUS IS CHOSEN EVERY TIME: there is no default, so leaving it out is refused and nothing is created', async () => {
  const go = await goOrder(); const it = await item(go); const h = await known(u());
  const before = (await claimsOf(h)).length;
  assert.equal((await add({ handle: h, lines: [{ itemId: it }] })).status, 400); assert.equal((await add({ handle: h, status: 'maybe', lines: [{ itemId: it }] })).status, 400);
  assert.equal((await claimsOf(h)).length, before, 'nothing was made');
});

test('PRIVATE AND CLOSED GROUP ORDERS: a joiner cannot claim there, the GOM can add — and a cancelled item still cannot be added to', async () => {
  const priv = await goOrder({ isPrivate: true }), closed = await goOrder({ status: 'closed' }); const a = await item(priv), b = await item(closed); const h = await known(u());
  assert.equal((await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: a }] })).status, 404, 'a joiner: private looks like it does not exist');
  assert.equal((await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: b }] })).status, 400, 'a joiner: closed');
  assert.equal((await add({ handle: h, status: 'requested', lines: [{ itemId: a }] })).status, 201); assert.equal((await add({ handle: h, status: 'confirmed', lines: [{ itemId: b }] })).status, 201);
  const gone = await item(priv, { title: 'Gone item' }); assert.equal((await api('POST', `/api/admin/items/${gone}/cancel`, { confirm: 'Gone item' })).status, 200);
  const r = await add({ handle: h, status: 'requested', lines: [{ itemId: gone }] }); assert.equal(r.status, 400); assert.match(r.json.error, /isn't available any more/);
});

test('A NEW PERSON: an unknown handle is refused with the reason unless "create" is ticked; then they exist, and an invalid or blocked handle is refused', async () => {
  const go = await goOrder(); const it = await item(go); const h = u('newbie');
  const no = await add({ handle: `@${h}`, status: 'requested', lines: [{ itemId: it }] }); assert.equal(no.status, 400); assert.match(no.json.error, new RegExp(`There's no @${h} on the site yet — tick “New person” to create them\\.`));
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM joiners WHERE instagram_handle = ?', [h]))[0].n, 0, 'refused: nobody was created');
  const yes = await add({ handle: `@${h}`, createHandle: true, status: 'requested', lines: [{ itemId: it }] }); assert.equal(yes.status, 201); assert.equal(yes.json.newHandle, true); assert.equal(yes.json.handle, h, 'the @ is removed');
  assert.equal((await claimsOf(h)).length, 1);
  assert.equal((await add({ handle: 'no spaces!', createHandle: true, status: 'requested', lines: [{ itemId: it }] })).status, 400);
  const blocked = await known(u()); await app.q('UPDATE joiners SET is_blocked = 1 WHERE instagram_handle = ?', [blocked]); const b = await add({ handle: blocked, status: 'requested', lines: [{ itemId: it }] }); assert.equal(b.status, 409); assert.match(b.json.error, /is blocked — unblock them on the People tab first\./);
  const again = await add({ handle: h, createHandle: true, status: 'requested', lines: [{ itemId: it }] }); assert.equal(again.json.newHandle, false, 'ticking create for someone who exists is harmless');
});

test('A STAGE can be set when the claim is confirmed (the first ready-to-pack date is noted); with a request, or with a parcel-driven stage, it is refused', async () => {
  const go = await goOrder(); const it = await item(go); const h = await known(u());
  assert.equal((await add({ handle: h, status: 'requested', pipeline: READY, lines: [{ itemId: it }] })).status, 400, 'a request has no stage');
  assert.equal((await add({ handle: h, status: 'confirmed', pipeline: 'shipped', lines: [{ itemId: it }] })).status, 400, 'shipped follows from a parcel');
  const r = await add({ handle: h, status: 'confirmed', pipeline: READY, lines: [{ itemId: it }] }); assert.equal(r.status, 201);
  const row = (await app.q('SELECT pipeline, ready_to_pack_date FROM claims WHERE id = ?', [r.json.claimIds[0]]))[0]; assert.equal(row.pipeline, READY); assert.ok(row.ready_to_pack_date, 'the storage clock starts');
  const r2 = await add({ handle: h, status: 'confirmed', pipeline: 'ordered via proxy / warehouse', lines: [{ itemId: it }] }); assert.equal((await app.q('SELECT pipeline FROM claims WHERE id = ?', [r2.json.claimIds[0]]))[0].pipeline, 'ordered via proxy / warehouse');
});

test('EVERY KIND OF ITEM: sizes need a size, member items need a member, quantities are bounded, a missing item is not found', async () => {
  const go = await goOrder(); const h = await known(u());
  const size = await item(go, { type: 'size', variants: ['M', 'L'], title: 'Tee' }), mem = await item(go, { type: 'independent', members: ['Felix', 'Han'], title: 'Card' });
  assert.equal((await add({ handle: h, status: 'requested', lines: [{ itemId: size }] })).status, 400); const ok = await add({ handle: h, status: 'requested', lines: [{ itemId: size, variant: 'L', qty: 2 }, { itemId: mem, member: 'Han' }] });
  assert.equal(ok.status, 201); const labels = (await claimsOf(h)).filter((c) => c.order_id === go).map((c) => c.label).sort(); assert.deepEqual(labels, ['Card — Han', 'Tee (L)', 'Tee (L)']);
  assert.equal((await add({ handle: h, status: 'requested', lines: [{ itemId: mem, member: 'Nobody' }] })).status, 400);
  assert.equal((await add({ handle: h, status: 'requested', lines: [{ itemId: size, variant: 'M', qty: 21 }] })).status, 400); assert.equal((await add({ handle: h, status: 'requested', lines: [{ itemId: 999999 }] })).status, 404);
  assert.equal((await add({ handle: h, status: 'requested', lines: [] })).status, 400);
});

test('A TBC PRICE: the claim is made, costs nothing yet, and "confirmed" leaves it as a request and says so', async () => {
  const go = await goOrder(); const it = await item(go, { price: undefined, priceTbc: true }); const h = await known(u());
  const r = await add({ handle: h, status: 'confirmed', lines: [{ itemId: it }] }); assert.equal(r.status, 201, r.text); assert.deepEqual([r.json.confirmed, r.json.leftAsRequests, r.json.skippedTbc], [0, 1, 1]);
  const c = (await claimsOf(h)).find((x) => x.order_id === go); assert.deepEqual([c.status, c.priceTbc], ['requested', true]);
});

test('MEMBER SETS: parts are placed exactly as for a joiner (and the placements are reported); a confirmed request waits for its set unless that set is already secured', async () => {
  const go = await goOrder(); const set = await item(go, { type: 'set', members: ['A', 'B', 'C'], price: 4, title: 'Set thing' }); const [h1, h2] = [await known(u()), await known(u())];
  const r = await add({ handle: h1, status: 'confirmed', lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }, { member: 'B', qty: 1 }], together: true }] }); assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json.placements.map((p) => [p.member, p.setNumber]), [['A', 1], ['B', 1]]); assert.deepEqual([r.json.confirmed, r.json.leftAsRequests], [0, 2], 'the set is not secured yet: they stay requests');
  const [s1] = (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === set); assert.equal(s1.filled, 2);
  const r2 = await add({ handle: h2, status: 'requested', lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] }); assert.deepEqual(r2.json.placements.map((p) => [p.member, p.setNumber]), [['A', 2]], 'A is taken in Set 1, so a new set');
  await claims3(h2, set, s1);
});
async function claims3(h2, set, s1) {
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {});                                                         // Set 1 now secured, C is open
  const r = await add({ handle: h2, status: 'confirmed', lines: [{ itemId: set, parts: [{ member: 'C', qty: 1 }] }] });
  assert.equal(r.status, 201); assert.deepEqual(r.json.placements.map((p) => [p.member, p.setNumber]), [['C', 1]], 'the open spot in the secured set is filled first');
  assert.deepEqual([r.json.confirmed, r.json.leftAsRequests], [1, 0], 'and it is confirmed, because that set is secured');
}

test('NOTHING IS DOUBLE-BOOKED when several are added at once: four people each ask for part A of a two-part set — four different sets', async () => {
  const go = await goOrder(); const set = await item(go, { type: 'set', members: ['A', 'B'], price: 3 }); const hs = []; for (let i = 0; i < 4; i++) hs.push(u());
  const rs = await Promise.all(hs.map((h) => add({ handle: h, createHandle: true, status: 'requested', lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] }))); assert.ok(rs.every((r) => r.status === 201), rs.map((r) => r.text).join());
  assert.deepEqual(rs.map((r) => r.json.placements[0].setNumber).sort(), [1, 2, 3, 4]);
});

test('ONLY THE GOM, and it leaves a record that names no one\'s details beyond the count', async () => {
  const go = await goOrder(); const it = await item(go); const h = await known(u()); const j = await app.login(`${u('jj')}@x.com`);
  assert.equal((await add({ handle: h, status: 'requested', lines: [{ itemId: it }] }, j)).status, 403); assert.equal((await app.api('POST', '/api/admin/claims/add', { handle: h, status: 'requested', lines: [{ itemId: it }] })).status, 401);
  await add({ handle: h, status: 'confirmed', lines: [{ itemId: it }] });
  const log = (await app.q("SELECT detail FROM audit_log WHERE action = 'claims.add' ORDER BY id DESC LIMIT 1"))[0]; assert.match(String(log.detail), /"count":1.*"status":"confirmed".*"confirmed":1/s);
});

test('THE SECURE BUTTONS STILL WORK exactly as before (the logic was shared, not changed)', async () => {
  const go = await goOrder(); const it = await item(go, { price: 7 }); const h = await known(u()); await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: it }, { itemId: it }] });
  const r = await api('POST', '/api/admin/claims/secure', { orderId: go }); assert.deepEqual([r.json.secured, r.json.skippedTbc, r.json.skippedCancel], [2, 0, 0]);
  assert.equal((await mySummary(h)).owed.total, 14);
});

test('WHO EXISTS (for the panel): prefix matches, whether the exact handle exists even with no claims, underscores are literal, blocked is reported, and it is GOM-only', async () => {
  const base = u('lk'); const a = `${base}_one`, b = `${base}_two`; for (const h of [a, b, `${base}xthree`]) await app.q('INSERT INTO joiners (instagram_handle) VALUES (?)', [h]);                // people with NO claims at all
  const r = (await api('GET', `/api/admin/joiners/lookup?q=${encodeURIComponent(`@${base.toUpperCase()}_`)}`)).json;
  assert.deepEqual(r.matches, [a, b].sort(), 'prefix match, @ and case ignored; the "_" is not a wildcard (…Xthree is not listed)'); assert.equal(r.exact, false);
  const one = (await api('GET', `/api/admin/joiners/lookup?q=${a}`)).json; assert.deepEqual([one.exact, one.matches[0]], [true, a], 'exact match first — and they have no claims');
  assert.deepEqual((await api('GET', '/api/admin/joiners/lookup?q=zzzz-nobody-here')).json, { matches: [], exact: false, blocked: false }); assert.deepEqual((await api('GET', '/api/admin/joiners/lookup')).json, { matches: [], exact: false, blocked: false });
  await app.q('UPDATE joiners SET is_blocked = 1 WHERE instagram_handle = ?', [b]); assert.equal((await api('GET', `/api/admin/joiners/lookup?q=${b}`)).json.blocked, true);
  for (let i = 0; i < 17; i++) await app.q('INSERT INTO joiners (instagram_handle) VALUES (?)', [`${base}m${i}`]); assert.equal((await api('GET', `/api/admin/joiners/lookup?q=${base}m`)).json.matches.length, 15, 'at most 15');
  const j = await app.login(`${u('jj')}@x.com`); assert.equal((await api('GET', `/api/admin/joiners/lookup?q=${a}`, undefined, j)).status, 403); assert.equal((await app.api('GET', `/api/admin/joiners/lookup?q=${a}`)).status, 401);
});
