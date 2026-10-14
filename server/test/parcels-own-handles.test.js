import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// ONE PARCEL across a person's handles: items from any of them, posted as one handle; their other handles join automatically (no invitation); fees split across them; one payment settles it.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'po') => `${x}${++N}`;
const READY = 'ready to pack / on hand';
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Parcel GO '), proxy: 'Sam' })).json.id;
const item = async (go, price = 5) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price })).json.id;
async function person(...handles) { const email = `${u('p')}@x.com`; const cookie = await joinerSession(app, email, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200);
  await api('PUT', `/api/my/address?handle=${handles[0]}`, { fullName: 'Maiju T', address: '12 Example Road, Leeds LS1 1AA', email, phone: '07000 123456' }, cookie); return { cookie, handles, email }; }
const ready = async (h, go, price) => { const [id] = await claimAndSecure(app, admin, h, await item(go, price)); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); return id; };
const ship = (c, handle, claimIds, extra = {}) => api('POST', `/api/my/parcels?handle=${handle}`, { claimIds, method: 'UK Royal Mail Tracked 48', addressConfirmed: true, ...extra }, c);
const parcelRows = async (id) => app.q('SELECT pi.claim_id, c.joiner_id, j.instagram_handle AS handle FROM parcel_items pi JOIN claims c ON c.id = pi.claim_id JOIN joiners j ON j.id = c.joiner_id WHERE pi.parcel_id = ? ORDER BY pi.claim_id', [id]);
const companions = async (id) => app.q('SELECT j.instagram_handle AS handle, pc.status, pc.how FROM parcel_companions pc JOIN joiners j ON j.id = pc.joiner_id WHERE pc.parcel_id = ? ORDER BY pc.id', [id]);

test('ITEMS FROM TWO HANDLES IN ONE PARCEL: posted as the handle that owns the first item, the other handle joins at once (how = "own", accepted), nobody has to answer an invitation', async () => {
  const go = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const { cookie } = await person(a, b); const ca = await ready(a, go), cb = await ready(b, go);
  const r = await ship(cookie, 'all', [cb, ca]); assert.equal(r.status, 201, r.text);                                           // the FIRST item is @b's
  assert.deepEqual((await parcelRows(r.json.id)).map((x) => [x.handle, x.claim_id]).sort(), [[a, ca], [b, cb]].sort(), 'both handles\' items are in it');
  assert.equal((await app.q('SELECT j.instagram_handle AS h FROM parcels p JOIN joiners j ON j.id = p.joiner_id WHERE p.id = ?', [r.json.id]))[0].h, b, 'posted as @b (owner of the first item)');
  assert.deepEqual(await companions(r.json.id), [{ handle: a, status: 'accepted', how: 'own' }]); assert.deepEqual(r.json.companions, [], 'no friends were invited');
  const list = (await api('GET', '/api/my/parcels?handle=all', undefined, cookie)).json; assert.equal(list.parcels.length, 1, 'one parcel, listed once'); assert.deepEqual([list.parcels[0].role, list.parcels[0].recipient, list.parcels[0].shared], ['recipient', b, null], 'not shown as shared with anyone else'); assert.ok(list.parcels[0].items.every((i) => i.mine));
});

test('ASKING AS ONE HANDLE WORKS TOO: viewing @a, items from @b can go in the same parcel', async () => {
  const go = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const { cookie } = await person(a, b); const ca = await ready(a, go), cb = await ready(b, go);
  const r = await ship(cookie, a, [ca, cb]); assert.equal(r.status, 201, r.text); assert.equal((await app.q('SELECT j.instagram_handle AS h FROM parcels p JOIN joiners j ON j.id = p.joiner_id WHERE p.id = ?', [r.json.id]))[0].h, a);
  assert.deepEqual(await companions(r.json.id), [{ handle: b, status: 'accepted', how: 'own' }]);
});

test('IT IS ALL OR NOTHING: someone else\'s item, an item that is not ready, a blocked handle\'s item — each refuses the whole request and creates nothing', async () => {
  const go = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const { cookie } = await person(a, b); const ca = await ready(a, go), cb = await ready(b, go);
  const stranger = u('str'); await person(stranger); const cs = await ready(stranger, go);
  const before = async () => (await app.q('SELECT COUNT(*) AS n FROM parcels'))[0].n; const n0 = await before();
  const r1 = await ship(cookie, 'all', [ca, cs]); assert.equal(r1.status, 403); assert.match(r1.json.error, /One of those items isn't yours/);
  const notReady = (await claimAndSecure(app, admin, b, await item(go, 3)))[0]; const r2 = await ship(cookie, 'all', [ca, notReady]); assert.equal(r2.status, 400); assert.match(r2.json.error, /Only items that are ready to ship can be requested/);
  await app.q('UPDATE joiners SET is_blocked = 1 WHERE instagram_handle = ?', [b]); const r3 = await ship(cookie, a, [ca, cb]); assert.equal(r3.status, 400, r3.text); assert.match(r3.json.error, new RegExp(`can't be shared with @${b}`)); const r4 = await ship(cookie, 'all', [cb]); assert.equal(r4.status, 403, 'a blocked handle cannot be the one it is posted as');
  assert.equal(await before(), n0, 'no parcel was made by any of them'); assert.equal((await app.q('SELECT COUNT(*) AS n FROM parcel_items WHERE claim_id = ?', [ca]))[0].n, 0, 'and @a\'s item was not left in a half-made parcel');
});

test('NO EMAIL ABOUT AN "INVITATION" TO THEIR OWN HANDLE — only friends are invited', async () => {
  const go = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const { cookie, email } = await person(a, b); assert.equal((await api('PUT', `/api/my/notifications?handle=${a}`, { enabled: true }, cookie)).status, 200);
  const ca = await ready(a, go), cb = await ready(b, go); const r = await ship(cookie, 'all', [ca, cb]); assert.equal(r.status, 201); await app.notifier.idle();
  assert.equal(app.mailer.outbox.filter((m) => m.to === email && /ship a parcel together|share/i.test(`${m.subject} ${m.text}`)).length, 0);
});

test('THE WHOLE JOURNEY: pack it, the GOM\'s fees are split across the handles, the person pays it all in ONE payment, receives it once — and everything is settled', async () => {
  const go = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const { cookie } = await person(a, b); const ca = await ready(a, go, 5), cb = await ready(b, go, 7);
  await api('POST', '/api/my/payments?handle=all', { method: 'PayPal', amount: 12, reference: u('R') }, cookie); const pays = (await app.q("SELECT id FROM payments WHERE status = 'pending'")).map((x) => x.id); for (const id of pays) await api('POST', `/api/admin/payments/${id}/verify`, {});
  const r = await ship(cookie, 'all', [ca, cb]); const id = r.json.id;
  assert.equal((await api('POST', `/api/admin/parcels/${id}/items-packed`, { packed: true })).status, 200); assert.equal((await api('POST', `/api/admin/parcels/${id}/checks`, { lomo: true, bias: true })).status, 200);
  assert.equal((await api('POST', `/api/admin/parcels/${id}/fees`, { doms: 4, packaging: 2 })).status, 200); assert.equal((await api('POST', `/api/admin/parcels/${id}/packed`, { confirmed: true })).status, 200);
  const fee = async (h) => Number((await app.q("SELECT COALESCE(SUM(cc.cost), 0) AS f FROM claim_costs cc JOIN claims c ON c.id = cc.claim_id JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND cc.category IN ('doms','packaging')", [h]))[0].f);
  assert.deepEqual([await fee(a), await fee(b)], [3, 3], 'postage £4 and packaging £2 split equally between the two handles');
  const owes = (await api('GET', '/api/my/summary?handle=all', undefined, cookie)).json; assert.equal(owes.owed.total, 6, 'together they owe £6 of postage and packaging');
  const p2 = await api('POST', '/api/my/payments?handle=all', { method: 'PayPal', amount: 6, reference: u('R2') }, cookie); assert.equal(p2.status, 201); assert.equal(p2.json.split.length, 2, 'ONE payment for both handles');
  assert.equal((await api('POST', `/api/admin/payments/batch/${p2.json.batchKey}/verify`, {})).status, 200); assert.equal((await api('GET', '/api/my/summary?handle=all', undefined, cookie)).json.owed.total, 0);
  assert.equal((await api('POST', `/api/admin/parcels/${id}/shipped`, {})).status, 200);
  const owner = (await app.q('SELECT j.instagram_handle AS h FROM parcels p JOIN joiners j ON j.id = p.joiner_id WHERE p.id = ?', [id]))[0].h;
  const wrong = await api('POST', `/api/my/parcels/${id}/received?handle=${owner === a ? b : a}`, {}, cookie); assert.equal(wrong.status, 404, 'only the handle it was posted to can press it');
  const rec = await api('POST', `/api/my/parcels/${id}/received?handle=${owner}`, {}, cookie); assert.equal(rec.status, 200, rec.text);                      // the handle it was posted to
  assert.deepEqual((await app.q('SELECT pipeline FROM claims WHERE id IN (?, ?)', [ca, cb])).map((x) => x.pipeline), ['completed', 'completed'], 'both handles\' items are received at once');
});

test('THE GOM SEES IT: the packing list names the other handle as "their other handle"-type companion (how = own), with every item in the parcel', async () => {
  const go = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const { cookie } = await person(a, b); const ca = await ready(a, go), cb = await ready(b, go); const r = await ship(cookie, a, [ca, cb]);
  const p = (await api('GET', '/api/admin/packing?status=requested')).json.parcels.find((x) => x.id === r.json.id); assert.ok(p, 'it is in the queue'); assert.equal(p.items.length, 2);
  const people = JSON.stringify(p); assert.ok(people.includes(b) && people.includes('"own"'), 'the other handle is there, marked as one of their own');
});
