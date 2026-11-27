import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// A JOINER'S ITEMS ON THEIR WAY TO THE GOM: confirmed claims whose box is en route, grouped by group order (names only; a box's tracking number is never shown to joiners).
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'tr') => `${x}${++N}`;
const order = async (title) => ({ id: (await api('POST', '/api/admin/orders', { groupId: w.group, title })).json.id, title });
const item = async (go, title) => ({ id: (await api('POST', `/api/admin/orders/${go.id}/items`, { type: 'normal', title, price: 5 })).json.id, title });
const person = async () => { const handle = u(), email = `${handle}@x.com`; return { handle, email, cookie: await joinerSession(app, email, handle) }; };
const claim = async (p, it) => (await claimAndSecure(app, admin, p.handle, it.id))[0];
const stage = async (id, pipeline) => assert.equal((await api('PATCH', `/api/admin/claims/${id}`, { pipeline })).status, 200);
const transit = async (p, q = '') => (await api('GET', `/api/my/in-transit${q}`, undefined, p.cookie)).json;
const EN = 'enroute to GOM';

test('ONLY CONFIRMED ITEMS WHOSE BOX IS EN ROUTE: grouped by group order (alphabetically), the same item twice as one with a count; every other stage, unconfirmed and cancelled claims, and other people\'s items are left out', async () => {
  const ga = await order('Zeta order'), gb = await order('Alpha order'); const a = await item(ga, 'Zeta album'), b = await item(ga, 'Zeta card'), c = await item(gb, 'Alpha photocard'), d = await item(gb, 'Alpha poster'), e = await item(gb, 'Alpha keyring');
  const p = await person(), other = await person();
  const a1 = await claim(p, a), a2 = await claim(p, a), b1 = await claim(p, b), c1 = await claim(p, c), d1 = await claim(p, d), e1 = await claim(p, e); await claim(other, a);
  for (const id of [a1, a2, b1, c1]) await stage(id, EN); await stage(d1, 'arrived at GOM'); /* e1 stays at its first stage */ const oid = (await claim(other, c)); await stage(oid, EN);
  const requested = await claim(p, item === null ? a : b); await app.q("UPDATE claims SET status = 'requested', pipeline = ? WHERE id = ?", [EN, requested]); const gone = await claim(p, c); await app.q("UPDATE claims SET status = 'cancelled', pipeline = ? WHERE id = ?", [EN, gone]);
  const r = await transit(p); assert.deepEqual(r.toGom.map((g) => g.orderTitle), ['Alpha order', 'Zeta order'], 'by group order title');
  assert.deepEqual(r.toGom[0].items.map((i) => [i.label.includes('Alpha photocard'), i.count, i.handle]), [[true, 1, p.handle]]); assert.deepEqual(r.toGom[1].items.map((i) => [i.label.includes('Zeta album') ? 'album' : 'card', i.count]).sort(), [['album', 2], ['card', 1]], 'the same item twice is one item with a count of 2');
  assert.equal(JSON.stringify(r).includes('Alpha poster'), false, 'arrived at GOM: no longer in transit'); assert.equal(JSON.stringify(r).includes('Alpha keyring'), false, 'still at its first stage'); assert.deepEqual(Object.keys(r.toGom[0]).sort(), ['items', 'orderId', 'orderTitle'], 'no box ids or tracking numbers');
  assert.equal(e1 > 0, true); assert.equal((await transit(other)).toGom.length, 1, 'someone else only sees their own'); assert.equal((await transit(other)).toGom[0].items[0].count, 1);
});

test('THE REAL BOX FLOW: items are in transit from the moment the box is marked en route, and gone once it has arrived at the GOM', async () => {
  const go = await order('Box flow order'), it = await item(go, 'Boxed thing'); const p = await person(); const id = await claim(p, it);
  assert.equal((await api('POST', '/api/admin/claims/pipeline', { claimIds: [id], pipeline: 'arrived at proxy / warehouse' })).status, 200); const box = (await api('POST', '/api/admin/boxes', { claimIds: [id], emsTotal: 6 })).json.id; assert.deepEqual((await transit(p)).toGom, [], 'a box being prepared is not in transit yet');
  assert.equal((await api('POST', `/api/admin/boxes/${box}/enroute`, {})).status, 200); const on = await transit(p); assert.deepEqual([on.toGom.length, on.toGom[0].orderTitle, on.toGom[0].items[0].count], [1, 'Box flow order', 1]);
  assert.equal((await api('POST', `/api/admin/boxes/${box}/arrived`, {})).status, 200); assert.deepEqual((await transit(p)).toGom, [], 'arrived: no longer in transit');
});

test('SCOPE AND ACCESS: signed out is refused; nothing on its way is an empty list; a person with two handles sees both (and can ask for one); the GOM sees the same in read-only view-as', async () => {
  assert.equal((await app.api('GET', '/api/my/in-transit')).status, 401); const p = await person(); assert.deepEqual(await transit(p), { toGom: [] });
  const h2 = u('second'); assert.equal((await api('POST', '/api/me/handles', { handle: h2 }, p.cookie)).status, 200); const go = await order('Two handles order'), x = await item(go, 'First handle thing'), y = await item(go, 'Second handle thing'); const c1 = await claim(p, x), c2 = (await claimAndSecure(app, admin, h2, y.id))[0]; await stage(c1, EN); await stage(c2, EN);
  const ambiguous = await api('GET', '/api/my/in-transit', undefined, p.cookie); assert.notEqual(ambiguous.status, 200, 'two handles and none named: the server doesn\'t guess'); const both = await transit(p, '?handle=all'); assert.deepEqual(both.toGom[0].items.map((i) => i.handle).sort(), [p.handle, h2].sort(), 'handle=all: both handles together'); assert.deepEqual((await transit(p, `?handle=${p.handle}`)).toGom[0].items.map((i) => i.handle), [p.handle], 'one handle when asked');
  const acc = (await app.q('SELECT id FROM accounts WHERE email = ?', [p.email]))[0].id; const viewed = await api('GET', `/api/admin/view-as/${acc}/my/in-transit?handle=all`); assert.deepEqual([viewed.status, viewed.json.toGom[0].items.length], [200, 2], 'view-as shows what they see');
});
