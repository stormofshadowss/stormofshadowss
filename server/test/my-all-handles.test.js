import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// ?handle=all : the read-only views (summary, parcels, payments) for ALL of a person's handles at once — totals summed, orders merged, every claim still says whose it is.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'al') => `${x}${++N}`;
const READY = 'ready to pack / on hand';
const goOrder = async (title = u('All GO ')) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam' })).json.id;
const item = async (go, price, title = u('Thing ')) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price })).json.id;
async function person(...handles) { const cookie = await joinerSession(app, `${u('p')}@x.com`, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200); return cookie; }
const sum = (c, h = 'all') => api('GET', `/api/my/summary?handle=${h}`, undefined, c);

test('THE SUMMARY FOR ALL HANDLES: totals are the sums, each handle\'s own figures are listed, credit is combined, and orders are merged with every claim tagged by its handle', async () => {
  const go = await goOrder('Shared GO'); const x = await item(go, 10, 'Album X'), y = await item(go, 6.5, 'Album Y'), other = await item(await goOrder('Only B GO'), 4, 'B only');
  const [a, b] = [u('ha'), u('hb')]; const c = await person(a, b);
  await claimAndSecure(app, admin, a, x); await claimAndSecure(app, admin, b, y); await claimAndSecure(app, admin, b, other);
  const r = (await sum(c)).json; assert.equal(r.handle, 'all');
  assert.deepEqual(r.handles, [{ handle: a, owed: 10, credit: 0 }, { handle: b, owed: 10.5, credit: 0 }]); assert.deepEqual([r.owed.initials, r.owed.total], [20.5, 20.5]);
  const shared = r.orders.find((o) => o.title === 'Shared GO'); assert.deepEqual(shared.claims.map((cl) => [cl.handle, cl.label]), [[a, 'Album X'], [b, 'Album Y']], 'one order, both handles\' claims, in claim order, each tagged'); assert.equal(shared.owed, 16.5);
  assert.deepEqual(r.orders.map((o) => o.title).sort(), ['Only B GO', 'Shared GO']);
  const one = (await sum(c, a)).json; assert.deepEqual([one.handle, one.owed.total, one.orders.length], [a, 10, 1], 'asking for one handle is exactly as before'); assert.equal(one.orders[0].claims[0].handle, a, 'and its claims say whose they are');
});

test('CREDIT IS COMBINED (and shows per handle); the totals respect what each handle really owes', async () => {
  const go = await goOrder(); const it = await item(go, 5); const [a, b] = [u('ha'), u('hb')]; const c = await person(a, b);
  await claimAndSecure(app, admin, a, it); await api('POST', '/api/admin/credit/add', { handle: b, amount: 12, reason: 'Test' });
  const r = (await sum(c)).json;                                                           // the £12 on @b already paid @a's £5 (credit is shared)
  assert.deepEqual([r.owed.total, r.credit], [0, 7]); assert.deepEqual(r.handles.map((h) => [h.handle, h.owed, h.credit]), [[a, 0, 0], [b, 0, 7]]);
});

test('WITHOUT ?handle A PERSON WITH SEVERAL HANDLES IS STILL ASKED WHICH ("handle_required"); a person with one handle can use "all" too; strangers and nonsense are refused', async () => {
  const [a, b, solo] = [u('ha'), u('hb'), u('hs')]; const c = await person(a, b), cs = await person(solo);
  const no = await api('GET', '/api/my/summary', undefined, c); assert.equal(no.status, 400); assert.equal(no.json.code ?? no.json.errorCode ?? 'handle_required', 'handle_required');
  const s = (await sum(cs)).json; assert.deepEqual([s.handle, s.handles.map((h) => h.handle)], ['all', [solo]]);
  assert.equal((await api('GET', `/api/my/summary?handle=${solo}`, undefined, c)).status, 403, 'someone else\'s handle'); assert.equal((await api('GET', '/api/my/summary?handle=ALL', undefined, c)).status, 200, 'case does not matter');
  assert.equal((await app.api('GET', '/api/my/summary?handle=all')).status, 401, 'signed out');
});

test('PARCELS AND PAYMENTS FOR ALL HANDLES: both handles\' are listed, tagged, newest first', async () => {
  const go = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const c = await person(a, b);
  await api('PUT', `/api/my/address?handle=${a}`, { fullName: 'Maiju T', address: '12 Example Road, Leeds LS1 1AA', email: 'm@x.com', phone: '07000 123456' }, c);
  const ids = {}; for (const h of [a, b]) { const [id] = await claimAndSecure(app, admin, h, await item(go, 3)); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); ids[h] = id; }
  const pa = await api('POST', `/api/my/parcels?handle=${a}`, { claimIds: [ids[a]], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, c); const pb = await api('POST', `/api/my/parcels?handle=${b}`, { claimIds: [ids[b]], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, c);
  assert.equal(pa.status, 201); assert.equal(pb.status, 201);
  const ps = (await api('GET', '/api/my/parcels?handle=all', undefined, c)).json; assert.deepEqual(ps.parcels.map((p) => p.id), [pb.json.id, pa.json.id].sort((x, y) => y - x), 'both, newest first'); assert.deepEqual(ps.parcels.map((p) => p.role), ['recipient', 'recipient']); assert.deepEqual(new Set(ps.parcels.map((p) => p.recipient)), new Set([a, b]));
  assert.ok(ps.parcels.every((p) => p.items.every((i) => i.mine)), 'all the items are theirs'); assert.equal((await api('GET', `/api/my/parcels?handle=${a}`, undefined, c)).json.parcels.length, 1, 'one handle: just its own, as before');
  await claimAndSecure(app, admin, a, await item(go, 8)); await claimAndSecure(app, admin, b, await item(go, 9));
  for (const [h, amt] of [[a, 8], [b, 9]]) assert.equal((await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount: amt, reference: u('R') }, c)).status, 201);
  const pay = (await api('GET', '/api/my/payments?handle=all', undefined, c)).json.payments; assert.deepEqual(pay.map((p) => [p.handle, p.amount]), [[b, 9], [a, 8]]); assert.equal((await api('GET', `/api/my/payments?handle=${a}`, undefined, c)).json.payments.length, 1);
});
