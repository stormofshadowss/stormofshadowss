import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// "MORE OF YOUR ITEMS HAVE ARRIVED": when claims become ready to pack / on hand and their owner has a shipping request that hasn't been packed, they are told they can add them — straight away, one email per person per action.
let app, admin, w, N = 0;
const READY = 'ready to pack / on hand', ARRIVED = 'arrived at proxy / warehouse';
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ir') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { await sleep(200); await app.notifier.idle(); await sleep(50); await app.notifier.idle(); };       // the check runs just after the response is sent
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Ready GO '), proxy: 'Sam' })).json.id;
async function person({ optIn = true } = {}) { const h = u('ir'), email = `${h}@x.com`; const cookie = await joinerSession(app, email, h); await api('PUT', '/api/my/address', { fullName: 'Ready Person', address: '12 Test Street, Leeds, LS1 1AA', email, phone: '07700 900123' }, cookie); if (optIn) assert.equal((await api('PUT', '/api/my/notifications', { enabled: true }, cookie)).status, 200); return { h, email, cookie, go: await goOrder() }; }
const claim = async (p, title = u('Thing ')) => { const it = (await api('POST', `/api/admin/orders/${p.go}/items`, { type: 'normal', title, price: 5 })).json.id; return (await claimAndSecure(app, admin, p.h, it))[0]; };
const makeReady = async (id) => assert.equal((await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY })).status, 200);
const request = async (p, claimIds) => { const r = await api('POST', `/api/my/parcels?handle=${p.h}`, { claimIds, method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p.cookie); assert.equal(r.status, 201, r.text); return r.json.id; };
const mails = (p) => app.mailer.outbox.filter((m) => m.to === p.email && /More of your items have arrived/.test(m.subject));
const withRequest = async (p) => { const a = await claim(p); await makeReady(a); const parcel = await request(p, [a]); await settle(); return { a, parcel }; };

test('THE EMAIL: a person with an unpacked shipping request is told when another item is ready — wording, link, no mention of postage; one email per action', async () => {
  const p = await person(); const { parcel } = await withRequest(p); assert.equal(mails(p).length, 0, 'their own request being made, and the first item ready before it, sends nothing');
  const t = u('Washi tape '); const b = await claim(p, t); await makeReady(b); await settle(); assert.equal(mails(p).length, 1, 'one email'); const m = mails(p)[0];
  assert.equal(m.subject, `More of your items have arrived (@${p.h})`); assert.match(m.text, new RegExp(`^Hi @${p.h},\\n\\nAnother of your items is now ready with the GOM:\\n\\n  • .*${t}.*\\n\\nYour shipping request hasn't been packed yet, so you can add it to it: .*/my\\.html#/ship\\n\\nIf you'd rather it went in a later parcel, you don't need to do anything\\.`));
  assert.doesNotMatch(m.text, /postage|doms|packaging|£/i, 'nothing about postage or money'); assert.match(m.text, /turned on email notifications/, 'the usual footer with the way to switch it off');
  const c = await claim(p); await makeReady(c); await settle(); assert.equal(mails(p).length, 2, 'a second action: a second email'); assert.ok(parcel);
});

test('ONE EMAIL PER PERSON PER ACTION: several of their items made ready at once (a box checked in one go) are listed together; another person\'s items in the same action get their own email', async () => {
  const p = await person(), q = await person(); const { parcel } = await withRequest(p); const qa = await withRequest(q); const mine = [await claim(p, u('Album ')), await claim(p, u('Card '))], theirs = await claim(q, u('Keyring '));
  const all = [...mine, theirs]; assert.equal((await api('POST', '/api/admin/claims/pipeline', { claimIds: all, pipeline: ARRIVED })).status, 200); const box = (await api('POST', '/api/admin/boxes', { claimIds: all, emsTotal: 6 })).json.id;
  await api('POST', `/api/admin/boxes/${box}/enroute`, {}); await api('POST', `/api/admin/boxes/${box}/arrived`, {}); await settle(); assert.equal(mails(p).length + mails(q).length, 0, 'not ready yet: nothing');
  assert.equal((await api('POST', `/api/admin/boxes/${box}/ready`, { ready: all, checking: [] })).status, 200); await settle();
  assert.equal(mails(p).length, 1, 'one email for the person'); assert.match(mails(p)[0].text, /^Hi @.*,\n\n2 more of your items are now ready with the GOM:\n\n  • .*\n  • .*\n\nYour shipping request hasn't been packed yet, so you can add them to it: /); assert.equal(mails(q).length, 1, 'and their own for the other person'); assert.match(mails(q)[0].text, /Another of your items is now ready/); assert.ok(parcel && qa);
});

test('NO EMAIL when: they have no shipping request; it is packed or cancelled; they haven\'t turned emails on; they switched this kind off; the item is already in a parcel; someone else\'s item', async () => {
  const none = await person(); await makeReady(await claim(none)); await settle(); assert.equal(mails(none).length, 0, 'no request at all');
  const packed = await person(); const pk = await withRequest(packed); await app.q("UPDATE parcels SET status = 'packed' WHERE id = ?", [pk.parcel]); await makeReady(await claim(packed)); await settle(); assert.equal(mails(packed).length, 0, 'the request is packed');
  const cancelled = await person(); const cx = await withRequest(cancelled); await app.q("UPDATE parcels SET status = 'cancelled' WHERE id = ?", [cx.parcel]); await makeReady(await claim(cancelled)); await settle(); assert.equal(mails(cancelled).length, 0, 'the request is cancelled');
  const off = await person({ optIn: false }); await withRequest(off); await makeReady(await claim(off)); await settle(); assert.equal(mails(off).length, 0, 'emails not turned on');
  const kind = await person(); await withRequest(kind); assert.equal((await api('PUT', '/api/my/notifications', { events: { itemsReady: false } }, kind.cookie)).status, 200); await makeReady(await claim(kind)); await settle(); assert.equal(mails(kind).length, 0, 'this kind switched off');
  assert.equal((await api('PUT', '/api/my/notifications', { events: { itemsReady: true } }, kind.cookie)).status, 200); await makeReady(await claim(kind)); await settle(); assert.equal(mails(kind).length, 1, 'switched back on: it comes');
  const inParcel = await person(); const ip = await withRequest(inParcel); await app.q('UPDATE claims SET ready_notified_at = NULL WHERE id = ?', [ip.a]); await app.notifier.itemsReady(); await settle(); assert.equal(mails(inParcel).length, 0, 'an item that is already in the parcel is not announced as one to add');
  assert.ok((await app.q('SELECT ready_notified_at AS n FROM claims WHERE id = ?', [ip.a]))[0].n, 'but it is still marked as considered');
  const gone = await person(); await withRequest(gone); const dead = await claim(gone); await settle(); assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: [dead] })).status, 200); await settle(); await app.q('UPDATE claims SET pipeline = ?, ready_notified_at = NULL WHERE id = ?', [READY, dead]); await app.notifier.itemsReady(); await settle(); assert.equal(mails(gone).length, 0, 'a cancelled claim is never announced');
  const other = await person(); const host = await withRequest(other); void host; const stranger = await person(); await makeReady(await claim(stranger)); await settle(); assert.equal(mails(other).length, 0, 'someone else\'s item never emails them'); assert.equal(mails(stranger).length, 0);
});

test('EACH CLAIM IS CONSIDERED ONCE: no second email for the same item, and an item that was ready BEFORE they asked to ship is never announced later', async () => {
  const p = await person(); const before = await claim(p); await makeReady(before); await settle(); assert.equal(mails(p).length, 0, 'ready, but they have no request: nothing');
  const early = await person(); const e1 = await claim(early); await makeReady(e1); await settle(); const e2 = await claim(early); await makeReady(e2); await request(early, [e2]); await settle(); await app.notifier.itemsReady(); await app.notifier.itemsReady(); assert.equal(mails(early).length, 0, 'e1 was ready before they asked: never announced, however often we check');
  const q = await person(); await withRequest(q); const c = await claim(q); await makeReady(c); await settle(); assert.equal(mails(q).length, 1); await app.notifier.itemsReady(); await app.notifier.itemsReady(); await settle(); assert.equal(mails(q).length, 1, 'checking again sends nothing more'); const row = (await app.q('SELECT ready_notified_at AS n FROM claims WHERE id = ?', [c]))[0]; assert.ok(row.n, 'it is recorded');
});

test('A FRIEND WHO HAS JOINED SOMEONE\'S SHIPPING REQUEST is told too — an invitation they haven\'t accepted doesn\'t count', async () => {
  const host = await person(), friend = await person(), invited = await person(); const { parcel } = await withRequest(host); const jid = async (p) => (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [p.h]))[0].id;
  await app.q("INSERT INTO parcel_companions (parcel_id, joiner_id, status, how) VALUES (?, ?, 'accepted', 'joiner'), (?, ?, 'invited', 'joiner')", [parcel, await jid(friend), parcel, await jid(invited)]);
  await makeReady(await claim(friend)); await makeReady(await claim(invited)); await settle(); assert.equal(mails(friend).length, 1, 'the friend who joined it'); assert.equal(mails(invited).length, 0, 'an unaccepted invitation: no');
});

test('THE CHECK HAPPENS AFTER ANY SUCCESSFUL CHANGE BY THE GOM (so no way of making a claim ready can be missed) — and not after reading or a refused change; the kind is in the settings, on by default', async () => {
  const p = await person(); await withRequest(p); const c = await claim(p); await settle(); await app.q('UPDATE claims SET pipeline = ? WHERE id = ?', [READY, c]);                                  // made ready behind the app's back
  await api('GET', '/api/admin/orders'); await settle(); assert.equal(mails(p).length, 0, 'reading something does not trigger it'); await api('PATCH', '/api/admin/claims/999999999', { pipeline: READY }); await settle(); assert.equal(mails(p).length, 0, 'a refused change does not');
  const g = await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Trigger GO '), proxy: 'Sam' }); assert.equal(g.status, 201); await settle(); assert.equal(mails(p).length, 1, 'any successful change by the GOM runs the check');
  const s = (await api('GET', '/api/my/notifications', undefined, p.cookie)).json; const ev = s.events.find((e) => e.key === 'itemsReady'); assert.deepEqual([ev.label, ev.enabled], ['More of my items are ready, and I can add them to my shipping request', true]);
});

test('STRUCTURE: the running server also checks every minute, as a safety net for anything that makes claims ready outside the GOM screens', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
  assert.match(src, /setInterval\(\(\) => app\.locals\.notifier\.itemsReady\(\), 60_000\)\.unref\(\)/);
});

