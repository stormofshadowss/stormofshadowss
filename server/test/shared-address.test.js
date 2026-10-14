import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// One delivery address per PERSON: saving it on one handle gives it to all their handles; a newly added handle gets it; people who already had different ones converge on the latest.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'sa') => `${x}${++N}`;
async function person(...handles) { const cookie = await joinerSession(app, `${u('p')}@x.com`, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200); return cookie; }
const put = (cookie, handle, extra = {}) => api('PUT', `/api/my/address?handle=${handle}`, { fullName: 'Maiju T', address: '12 Example Road, Leeds LS1 1AA', email: 'm@x.com', phone: '07000 123456', ...extra }, cookie);
const get = async (cookie, handle) => (await api('GET', `/api/my/address?handle=${handle}`, undefined, cookie)).json.address;
const rows = async (h) => app.q('SELECT a.full_name, a.address, a.confirmed_at FROM addresses a JOIN joiners j ON j.id = a.joiner_id WHERE j.instagram_handle = ?', [h]);

test('SAVING AN ADDRESS ON ONE HANDLE GIVES IT TO ALL THEIR HANDLES', async () => {
  const [a, b] = [u('ha'), u('hb')]; const c = await person(a, b);
  assert.equal(await get(c, b), null, 'nothing yet'); assert.equal((await put(c, a)).status, 200);
  assert.equal((await rows(b)).length, 1, 'saving wrote it to @b straight away (checked in the database, before anything reads it)'); assert.equal((await rows(b))[0].address, '12 Example Road, Leeds LS1 1AA');
  const onB = await get(c, b); assert.deepEqual([onB.fullName, onB.address, onB.phone], ['Maiju T', '12 Example Road, Leeds LS1 1AA', '07000 123456'], '@b has it without typing it again');
  assert.equal((await put(c, b, { address: '99 New Street, York YO1 1AA', fullName: 'Maiju Tahkolahti' })).status, 200); const onA = await get(c, a); assert.deepEqual([onA.fullName, onA.address], ['Maiju Tahkolahti', '99 New Street, York YO1 1AA'], 'changing it on the other handle changes it everywhere');
  assert.equal((await rows(a)).length, 1); assert.equal((await rows(b)).length, 1); assert.deepEqual((await rows(a))[0].confirmed_at, (await rows(b))[0].confirmed_at);
});

test('A HANDLE ADDED LATER GETS THE ADDRESS THE PERSON ALREADY HAS', async () => {
  const [a, b] = [u('ha'), u('hb')]; const c = await person(a); await put(c, a);
  assert.equal((await api('POST', '/api/me/handles', { handle: b }, c)).status, 200);
  assert.equal((await rows(b))[0]?.address, '12 Example Road, Leeds LS1 1AA', 'linking wrote it to the new handle straight away (checked in the database)');
  const onB = await get(c, b); assert.equal(onB?.address, '12 Example Road, Leeds LS1 1AA', 'the new handle is not asked for it again');
});

test('PEOPLE WHO ALREADY HAD DIFFERENT ADDRESSES ON TWO HANDLES converge on the most recently confirmed one the first time they look', async () => {
  const [a, b] = [u('ha'), u('hb')]; const c = await person(a, b);
  await app.q(`INSERT INTO addresses (joiner_id, full_name, address, email, phone, confirmed_at) SELECT id, 'Old Name', '1 Old Lane, Hull', 'o@x.com', '0111', '2026-01-01 10:00:00' FROM joiners WHERE instagram_handle = ?`, [a]);
  await app.q(`INSERT INTO addresses (joiner_id, full_name, address, email, phone, confirmed_at) SELECT id, 'Newer Name', '2 Newer Road, Leeds', 'n@x.com', '0222', '2026-09-01 10:00:00' FROM joiners WHERE instagram_handle = ?`, [b]);
  assert.equal((await get(c, a)).address, '2 Newer Road, Leeds', 'looking at @a shows the newer address'); assert.equal((await rows(a))[0].address, '2 Newer Road, Leeds', 'and @a\'s own row was brought into line'); assert.equal((await get(c, b)).fullName, 'Newer Name');
});

test('A PARCEL REQUESTED ON A HANDLE THAT NEVER ENTERED AN ADDRESS WORKS, using the shared one', async () => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Addr GO '), proxy: 'Sam' })).json.id; const it = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'Thing', price: 5 })).json.id;
  const [a, b] = [u('ha'), u('hb')]; const c = await person(a, b); await put(c, a);                                    // the address was typed on @a only
  const [claim] = await claimAndSecure(app, admin, b, it); await api('PATCH', `/api/admin/claims/${claim}`, { pipeline: 'ready to pack / on hand' });
  const r = await api('POST', `/api/my/parcels?handle=${b}`, { claimIds: [claim], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, c); assert.equal(r.status, 201, r.text);
});

test('OTHER PEOPLE ARE NEVER MIXED UP, and a person with one handle is unaffected', async () => {
  const [a, x, solo] = [u('ha'), u('hx'), u('hs')]; const ca = await person(a, u('hb')), cx = await person(x), cs = await person(solo);
  await put(ca, a); assert.equal(await get(cx, x), null, 'a different person has nothing'); await put(cs, solo, { address: '5 Solo Street, Bath BA1 1AA' }); assert.equal((await get(cs, solo)).address, '5 Solo Street, Bath BA1 1AA'); assert.equal((await get(ca, a)).address, '12 Example Road, Leeds LS1 1AA');
});

test('LINKING A HANDLE THAT ALREADY EXISTS ON THE SITE (say, one created by an import) gives it the person\'s address too', async () => {
  const [a, b] = [u('ha'), u('imported')]; const c = await person(a); await put(c, a);
  await app.q('INSERT INTO joiners (instagram_handle) VALUES (?)', [b]);                       // exists already, no account, nothing claimed
  assert.equal((await api('POST', '/api/me/handles', { handle: b }, c)).status, 200);
  assert.equal((await rows(b))[0]?.address, '12 Example Road, Leeds LS1 1AA', 'written at the moment of linking (checked in the database)');
});
