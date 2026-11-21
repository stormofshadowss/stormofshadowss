import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession, tickParcel } from './helpers.js';
import { trackingUrl } from '../src/lib/tracking.js';

// TRACKING NUMBER for a parcel posted out to a joiner: one per parcel, typed when it is marked shipped (or added / fixed after), shown to the joiner once it is shipped, searchable by the GOM, never emailed.
let app, admin, w, N = 0, ITEM;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); ITEM = (await app.api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: 'Tracked thing', price: 6 }, admin)).json.id; });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const fresh = (x = 'tk') => `${x}${++N}`;
const person = async () => { const h = fresh(), cookie = await joinerSession(app, `${h}@x.com`, h); await api('PUT', '/api/my/address', { fullName: 'Tr P', address: '12 Test Street, Leeds, LS1 1AA', email: `${h}@x.com`, phone: '07700 900123' }, cookie); return { h, cookie }; };
const ready = async (p) => { const [id] = await claimAndSecure(app, admin, p.h, ITEM); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' }); return id; };
const request = async (p, ids, method = 'UK Royal Mail Tracked 48') => { const r = await api('POST', `/api/my/parcels?handle=${p.h}`, { claimIds: ids, method, addressConfirmed: true }, p.cookie); assert.equal(r.status, 201, r.text); return r.json.id; };
const pack = async (id) => { await tickParcel(app, admin, id); const r = await api('POST', `/api/admin/parcels/${id}/packed`, {}); assert.equal(r.status, 200, r.text); };
const ship = (id, body) => api('POST', `/api/admin/parcels/${id}/shipped`, body ?? {});
const track = (id, trackingNo, c = admin) => api('PATCH', `/api/admin/parcels/${id}/tracking`, { trackingNo }, c);
const adminRow = async (id, status) => (await api('GET', `/api/admin/packing?status=${status}`)).json.parcels.find((p) => p.id === id);
const mine = async (p, id) => (await api('GET', '/api/my/parcels', undefined, p.cookie)).json.parcels.find((x) => x.id === id);
const dbNo = async (id) => (await app.q('SELECT tracking_no AS t, status FROM parcels WHERE id = ?', [id]))[0];
const shippedParcel = async (p = null, method) => { p = p || await person(); const id = await request(p, [await ready(p)], method); await pack(id); return { p, id }; };

test('MARK SHIPPED WITH A TRACKING NUMBER: saved (spaces tidied), on the Shipped list with a Royal Mail link, on the joiner\'s page, and NOT emailed', async () => {
  const { p, id } = await shippedParcel(); const r = await ship(id, { trackingNo: '  TRK9988   123 456 gb ' }); assert.equal(r.status, 200, r.text); assert.deepEqual(await dbNo(id), { t: 'TRK9988 123 456 gb', status: 'shipped' });
  const row = await adminRow(id, 'shipped'); assert.deepEqual([row.trackingNo, row.trackingUrl], ['TRK9988 123 456 gb', 'https://www.royalmail.com/track-your-item#/tracking-results/TRK9988123456gb']);
  const j = await mine(p, id); assert.deepEqual([j.status, j.trackingNo, j.trackingUrl], ['shipped', 'TRK9988 123 456 gb', row.trackingUrl], 'the joiner sees it');
  await app.notifier.idle(); assert.equal(app.mailer.outbox.some((m) => /TRK9988/.test(m.text) || /TRK9988/.test(m.subject || '')), false, 'the number is in no email');
  assert.equal((await api('POST', `/api/admin/parcels/${id}/received`, {})).status, 200); assert.equal((await mine(p, id)).trackingNo, 'TRK9988 123 456 gb', 'still there once it has arrived');
});

test('WITHOUT A NUMBER, THEN ADD, FIX AND REMOVE IT LATER: each is recorded; blank clears; the joiner always sees the current one', async () => {
  const { p, id } = await shippedParcel(); assert.equal((await ship(id)).status, 200); assert.equal((await dbNo(id)).t, null, 'shipped with no number'); assert.equal((await mine(p, id)).trackingNo, null);
  const a = await track(id, 'JD 0123 4567'); assert.deepEqual([a.status, a.json.trackingNo, a.json.trackingUrl], [200, 'JD 0123 4567', 'https://www.royalmail.com/track-your-item#/tracking-results/JD01234567']); assert.equal((await mine(p, id)).trackingNo, 'JD 0123 4567');
  assert.equal((await track(id, 'JD 9999 0000')).json.trackingNo, 'JD 9999 0000', 'fixed'); assert.equal((await mine(p, id)).trackingNo, 'JD 9999 0000'); const c = await track(id, '   '); assert.deepEqual([c.status, c.json.trackingNo, c.json.trackingUrl], [200, null, null], 'blank removes it'); assert.equal((await mine(p, id)).trackingNo, null);
  assert.ok((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'parcel.tracking'"))[0].n >= 3, 'every change is recorded');
});

test('A BAD NUMBER IS REFUSED — and a bad number sent with "mark shipped" does NOT ship the parcel', async () => {
  const { id } = await shippedParcel(); for (const bad of ['ab', 'x'.repeat(41), '<b>x</b>1234', 'AB_1234', 'a;b 1234']) { const r = await ship(id, { trackingNo: bad }); assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal((await dbNo(id)).status, 'packed', 'still packed — nothing half-done'); }
  assert.equal((await ship(id, { trackingNo: 'GOOD 1234' })).status, 200); for (const bad of ['ab', 'x'.repeat(41), '<i>1234</i>']) assert.equal((await track(id, bad)).status, 400, JSON.stringify(bad)); assert.equal((await api('PATCH', `/api/admin/parcels/${id}/tracking`, {})).status, 400, 'the field is required'); assert.equal((await dbNo(id)).t, 'GOOD 1234', 'a refused edit changes nothing');
});

test('STATE RULES AND ACCESS: not on a parcel still in the queue; unknown parcel; a joiner is refused; signed out is refused', async () => {
  const p = await person(); const id = await request(p, [await ready(p)]); const early = await track(id, 'EARLY 1234'); assert.deepEqual([early.status, early.json.code], [409, 'bad_state']); assert.equal((await dbNo(id)).t, null);
  assert.equal((await track(999999, 'NOPE 12345')).status, 404); await pack(id); assert.equal((await track(id, 'READY 1234')).status, 200, 'once it is packed it can be added'); assert.equal((await track(id, 'SNEAK 1234', p.cookie)).status, 403); assert.equal((await app.api('PATCH', `/api/admin/parcels/${id}/tracking`, { trackingNo: 'SNEAK 1234' })).status, 401); assert.equal((await dbNo(id)).t, 'READY 1234');
});

test('WHO SEES IT, AND WHEN: not the joiner while it is only packed; not other people; a friend sharing the parcel does once it is shipped', async () => {
  const owner = await person(), friend = await person(), stranger = await person(); const o1 = await ready(owner), f1 = await ready(friend); const id = await request(owner, [o1]);
  assert.equal((await api('POST', `/api/my/parcels/${id}/companion/invite`, { handles: friend.h }, owner.cookie)).status, 201); assert.equal((await api('POST', `/api/my/parcels/${id}/companion/accept`, { claimIds: [f1] }, friend.cookie)).status, 200); await pack(id);
  assert.equal((await track(id, 'EARLY 55555')).status, 200); assert.equal((await mine(owner, id)).trackingNo, null, 'packed: the GOM has typed it but the joiner can\'t see it yet'); assert.equal((await ship(id)).status, 200);
  assert.equal((await mine(owner, id)).trackingNo, 'EARLY 55555', 'shipped: the owner sees it'); assert.equal((await mine(friend, id)).trackingNo, 'EARLY 55555', 'and so does the friend sharing it'); assert.equal(await mine(stranger, id), undefined, 'a stranger doesn\'t even see the parcel');
});

test('THE "TRACK IT" LINK: only for Royal Mail (the number is tidied and made safe for a link); every other method shows the number alone', () => {
  assert.equal(trackingUrl('UK Royal Mail Tracked 48', 'AB 12 34 GB'), 'https://www.royalmail.com/track-your-item#/tracking-results/AB1234GB'); assert.match(trackingUrl('UK Royal Mail Tracked 24', 'ZZ9'), /^https:\/\/www\.royalmail\.com\//); assert.equal(trackingUrl('UK Royal Mail Tracked 48', 'A#B/1 2'), 'https://www.royalmail.com/track-your-item#/tracking-results/A%23B%2F12', 'special characters can\'t break out of the link');
  for (const m of ['WW Tracked', 'WW Stamped', 'UK Inpost to House', 'UK Inpost to Shop', '', null, undefined]) assert.equal(trackingUrl(m, 'AB1234'), null, String(m)); assert.equal(trackingUrl('UK Royal Mail Tracked 48', null), null); assert.equal(trackingUrl('UK Royal Mail Tracked 48', ''), null);
});

test('THE GOM CAN SEARCH PACKING by tracking number, person or parcel number — across every status; a % is not a wildcard; no match gives nothing; cancelled parcels are left out', async () => {
  const p = await person(); const a = await request(p, [await ready(p)]); await pack(a); await ship(a, { trackingNo: 'FINDME 7777 1111' }); const b = await request(p, [await ready(p)]); const other = await shippedParcel(); await ship(other.id, { trackingNo: 'OTHER 0001' });
  const q = async (s, extra = '') => (await api('GET', `/api/admin/packing?q=${encodeURIComponent(s)}${extra}`)).json.parcels.map((x) => x.id).sort((x, y) => x - y);
  assert.deepEqual(await q('7777'), [a], 'by part of the tracking number'); assert.deepEqual(await q('findme 7777'), [a], 'not case-sensitive'); assert.deepEqual(await q(p.h), [a, b], 'by person: every parcel of theirs, shipped or still queued'); assert.deepEqual(await q(`@${p.h.toUpperCase()}`), [a, b], 'with an @ and capitals'); const byNumber = (await api('GET', `/api/admin/packing?q=${a}`)).json.parcels.map((x) => x.id); assert.equal(byNumber[0], a, 'by parcel number: the exact parcel comes first (others only if their tracking number or name happens to contain it)');
  assert.deepEqual(await q('7777', '&status=requested'), [a], 'the status is ignored when searching'); assert.deepEqual(await q('zzz-nothing'), []); assert.deepEqual(await q('%'), [], 'a % is not a wildcard'); assert.deepEqual(await q('_'), [], 'nor is an underscore');
  assert.equal((await api('POST', `/api/admin/parcels/${b}/cancel`, {})).status, 200); assert.deepEqual(await q(p.h), [a], 'a cancelled parcel is left out'); assert.ok((await adminRow(a, 'shipped')).trackingNo, 'the plain list still carries the number');
});
