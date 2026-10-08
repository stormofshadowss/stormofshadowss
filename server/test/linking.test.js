import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, ADMIN } from './helpers.js';

const READY = 'ready to pack / on hand';
let app, admin, w;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

// A "browser": remembers its device cookie between claims, like a real one.
const browser = () => ({ cookie: null });
async function claim(b, handle, itemId = w.keyring, extra = {}) {
  const r = await app.api('POST', '/api/claims', { handle, lines: [{ itemId, ...extra }] }, b.cookie);
  const set = r.headers.get('set-cookie');
  if (set && /sos_device=/.test(set)) b.cookie = set.split(';')[0];
  return r;
}
const askLink = (b, email, handle) => app.api('POST', '/api/auth/request-link', { email, ...(handle ? { handle } : {}) }, b.cookie);
async function signInFromEmail(email) {                         // opened on a different device: no device cookie sent
  const out = await app.confirm(app.tokenFromMail(email));
  return out.setCookie ? out.setCookie.split(';')[0] : null;
}
const joiner = async (handle) => (await app.q('SELECT * FROM joiners WHERE instagram_handle = ?', [handle]))[0];

test('claiming as a brand-new handle needs no sign-in, and offers to add an email afterwards', async () => {
  const b = browser();
  const r = await claim(b, '@Fresh_Face');
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.handle, { name: 'fresh_face', isNew: true, hasAccount: false, canLinkEmail: true });
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /sos_device=/); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Lax/i);
  const proofs = await app.q('SELECT device_hash FROM handle_proofs WHERE joiner_id = ?', [(await joiner('fresh_face')).id]);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0].device_hash.length, 64);
  assert.ok(!cookie.includes(proofs[0].device_hash) && !JSON.stringify(proofs).includes(b.cookie.split('=')[1]), 'only a hash is stored, never the cookie value');
  assert.equal((await joiner('fresh_face')).account_id, null, 'nothing was linked yet — claiming alone never needs an account');
});

test('add an email after claiming: linked on the spot, no GOM approval — even if the email opens on another device', async () => {
  const b = browser();
  await claim(b, 'quick_link');
  const asked = await askLink(b, 'quick@x.com', 'quick_link');
  assert.equal(asked.json.willLinkHandle, true);
  const session = await signInFromEmail('quick@x.com');          // a different device: no claim cookie at all
  assert.ok(session);
  const me = (await app.api('GET', '/api/me', undefined, session)).json;
  assert.deepEqual(me.handles.map((h) => h.handle), ['quick_link']);
  const s = (await app.api('GET', '/api/my/summary', undefined, session)).json;
  assert.equal(s.orders[0].claims[0].label, 'Keyring', 'they can see the claim they made before signing in');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM handle_link_requests'))[0].n, 0, 'the GOM was never asked');
  const j = await joiner('quick_link');
  assert.equal(j.linked_via, 'claim_device');
  assert.ok(j.linked_at);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM handle_proofs WHERE joiner_id = ?', [j.id]))[0].n, 0, 'the proof is used up');
});

test('a later claim from the same browser keeps offering the email step until it is done, then offers sign-in', async () => {
  const b = browser();
  await claim(b, 'twice_h');
  assert.equal((await claim(b, 'twice_h')).json.handle.canLinkEmail, true);
  await askLink(b, 'twice@x.com', 'twice_h'); await signInFromEmail('twice@x.com');
  const again = await claim(b, 'twice_h');
  assert.deepEqual([again.json.handle.hasAccount, again.json.handle.canLinkEmail, again.json.handle.isNew], [true, false, false], 'welcome back: sign in to see your orders');
});

test('a different browser cannot take over the handle: no link, and it falls back to the GOM, who is never needed for anyone else', async () => {
  const owner = browser(); await claim(owner, 'guarded_h');
  const other = browser();
  const r = await claim(other, 'guarded_h');
  assert.deepEqual([r.json.handle.isNew, r.json.handle.canLinkEmail], [false, false], 'a second browser gets no link offer');
  assert.equal(r.status, 201, 'but its claim is still accepted (a claim is only a request)');
  const asked = await askLink(other, 'intruder@x.com', 'guarded_h');
  assert.equal(asked.json.willLinkHandle, false);
  const session = await signInFromEmail('intruder@x.com');
  assert.deepEqual((await app.api('GET', '/api/me', undefined, session)).json.handles, [], 'signed in, but not linked');
  assert.equal((await app.api('GET', '/api/my/summary', undefined, session)).status, 403, 'and sees nothing of that handle');
  const fallback = await app.api('POST', '/api/me/handles', { handle: 'guarded_h' }, session);
  assert.equal(fallback.status, 202, 'the old approval step is only for this rare case');
  // the real owner is unaffected and can still link from their own browser
  assert.equal((await askLink(owner, 'owner@x.com', 'guarded_h')).json.willLinkHandle, true);
});

test('the GOM-approval fallback still works for someone with no proof (new phone, cleared cookies)', async () => {
  const b = browser(); await claim(b, 'newphone_h');
  const phone = browser();
  const session = await (async () => { await askLink(phone, 'newphone@x.com'); return signInFromEmail('newphone@x.com'); })();
  assert.equal((await app.api('POST', '/api/me/handles', { handle: 'newphone_h' }, session)).status, 202);
  const req = (await app.api('GET', '/api/admin/handle-requests', undefined, admin)).json.requests.find((x) => x.handle === 'newphone_h');
  await app.api('POST', `/api/admin/handle-requests/${req.id}/approve`, {}, admin);
  assert.equal((await app.api('GET', '/api/my/summary', undefined, session)).status, 200);
  assert.equal((await joiner('newphone_h')).linked_via, 'approved');
});

test('an owned handle cannot be linked by a stranger asking for it', async () => {
  const b = browser(); await claim(b, 'taken_now'); await askLink(b, 'rightful@x.com', 'taken_now'); await signInFromEmail('rightful@x.com');
  const stranger = browser();
  assert.equal((await claim(stranger, 'taken_now')).json.handle.canLinkEmail, false);
  assert.equal((await askLink(stranger, 'stranger@x.com', 'taken_now')).json.willLinkHandle, false);
});

test('already signed in? the claiming browser links the handle with one tap, no approval', async () => {
  const b = browser(); await claim(b, 'signedin_first');
  await askLink(b, 'si@x.com'); const session = await signInFromEmail('si@x.com');          // signed in WITHOUT linking
  const viaDevice = await app.api('POST', '/api/me/handles', { handle: 'signedin_first' }, session.concat('; ', b.cookie));
  assert.equal(viaDevice.status, 200);
  assert.equal(viaDevice.json.status, 'linked');
  assert.equal((await joiner('signedin_first')).linked_via, 'claim_device');
});

test('proofs are used once, expire, and die with an unlink', async () => {
  const b = browser(); await claim(b, 'expiring_h');
  await app.q("UPDATE handle_proofs SET expires_at = NOW(3) - INTERVAL 1 SECOND WHERE joiner_id = ?", [(await joiner('expiring_h')).id]);
  assert.equal((await askLink(b, 'exp@x.com', 'expiring_h')).json.willLinkHandle, false, 'an old proof no longer works');

  const c = browser(); await claim(c, 'unlinked_h'); await askLink(c, 'unl@x.com', 'unlinked_h'); const session = await signInFromEmail('unl@x.com');
  const j = await joiner('unlinked_h');
  await app.api('DELETE', `/api/admin/joiners/${j.id}/account`, undefined, admin);            // the GOM unlinks them
  assert.equal((await askLink(c, 'unl@x.com', 'unlinked_h')).json.willLinkHandle, false, 'the same browser can NOT quietly relink afterwards');
  assert.equal((await app.api('POST', '/api/me/handles', { handle: 'unlinked_h' }, session.concat('; ', c.cookie))).status, 202);
});

test('two emails racing for one handle from one browser: exactly one wins', async () => {
  const b = browser(); await claim(b, 'raced_h');
  await askLink(b, 'racer.a@x.com', 'raced_h'); await askLink(b, 'racer.b@x.com', 'raced_h');
  const [a, bb] = await Promise.all([signInFromEmail('racer.a@x.com'), signInFromEmail('racer.b@x.com')]);
  const owners = (await app.q('SELECT account_id FROM joiners WHERE instagram_handle = ?', ['raced_h']))[0].account_id;
  const handlesA = (await app.api('GET', '/api/me', undefined, a)).json.handles.length;
  const handlesB = (await app.api('GET', '/api/me', undefined, bb)).json.handles.length;
  assert.equal(handlesA + handlesB, 1, 'one account got it, the other only signed in');
  assert.ok(owners);
});

test('twelve people making the first claim for one new handle at the same instant: only one is "the first"', async () => {
  const browsers = Array.from({ length: 12 }, browser);
  const results = await Promise.all(browsers.map((b) => claim(b, 'stampede_h')));
  assert.ok(results.every((r) => r.status === 201));
  assert.equal(results.filter((r) => r.json.handle.isNew).length, 1);
  assert.equal(results.filter((r) => r.json.handle.canLinkEmail).length, 1);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM handle_proofs WHERE joiner_id = ?', [(await joiner('stampede_h')).id]))[0].n, 1);
});

test('blocked handles get no proof and cannot claim', async () => {
  await app.api('POST', '/api/admin/joiners/block', { handle: 'nope_h', reason: 'test' }, admin);
  const b = browser();
  assert.equal((await claim(b, 'nope_h')).status, 403);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM handle_proofs WHERE joiner_id = ?', [(await joiner('nope_h')).id]))[0].n, 0);
});

test('odd input is handled: junk device cookie, unknown handle, the admin email', async () => {
  const r = await app.api('POST', '/api/claims', { handle: 'junkcookie', lines: [{ itemId: w.keyring }] }, 'sos_device=short');
  assert.equal(r.status, 201);
  assert.match(r.headers.get('set-cookie'), /sos_device=[A-Za-z0-9_-]{43}/, 'a fresh valid cookie replaces the junk');
  const b = browser();
  assert.equal((await askLink(b, 'ghost@x.com', 'handle_never_seen')).json.willLinkHandle, false);
  const before = app.mailer.outbox.length;
  await claim(b, 'adm_try'); await askLink(b, ADMIN.email, 'adm_try');
  assert.equal(app.mailer.outbox.length, before, 'the admin email still never gets a link');
});

test('the GOM can review new links afterwards, and mark people she has checked', async () => {
  const b = browser(); await claim(b, 'review_me', w.album); await askLink(b, 'review@x.com', 'review_me'); await signInFromEmail('review@x.com');
  const list = (await app.api('GET', '/api/admin/joiners/recent-links', undefined, admin)).json.links;
  const row = list.find((x) => x.handle === 'review_me');
  assert.deepEqual([row.email, row.linkedVia, row.claims, row.verified], ['review@x.com', 'claim_device', 1, false]);
  assert.equal((await app.api('POST', '/api/admin/joiners/verify', { handle: '@Review_Me' }, admin)).status, 200);
  assert.equal((await app.api('GET', '/api/admin/joiners/recent-links', undefined, admin)).json.links.find((x) => x.handle === 'review_me').verified, true);
  await app.api('POST', '/api/admin/joiners/unverify', { handle: 'review_me' }, admin);
  assert.equal((await app.api('GET', '/api/admin/joiners/recent-links?days=1', undefined, admin)).json.links.find((x) => x.handle === 'review_me').verified, false);
  assert.equal((await app.api('POST', '/api/admin/joiners/verify', { handle: 'no_such' }, admin)).status, 404);
  const joinerCookie = await app.login('plain@x.com');
  for (const [m, p, body] of [['GET', '/api/admin/joiners/recent-links'], ['POST', '/api/admin/joiners/verify', { handle: 'x' }], ['POST', '/api/admin/joiners/unverify', { handle: 'x' }]]) {
    assert.equal((await app.api(m, p, body, joinerCookie)).status, 403, p);
  }
});

test('the packing queue flags handles you have not checked yet — before the first parcel goes out', async () => {
  const b = browser(); await claim(b, 'ship_check'); await askLink(b, 'shipc@x.com', 'ship_check'); const session = await signInFromEmail('shipc@x.com');
  await app.api('PUT', '/api/my/address', { fullName: 'Ship Check', address: '1 Road, Leeds', email: 'shipc@x.com', phone: '0700' }, session);
  const [id] = await claimAndSecure(app, admin, 'ship_check', w.keyring);
  await app.api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }, admin);
  const p = (await app.api('POST', '/api/my/parcels', { claimIds: [id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, session)).json;
  const find = async () => (await app.api('GET', '/api/admin/packing', undefined, admin)).json.parcels.find((x) => x.id === p.id);
  assert.equal((await find()).handleVerified, false, 'flagged: worth a quick Instagram DM before packing');
  await app.api('POST', '/api/admin/joiners/verify', { handle: 'ship_check' }, admin);
  assert.equal((await find()).handleVerified, true);
});

test('INVARIANTS: every linked handle says how it was linked, and keeps no live proofs', async () => {
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM joiners WHERE account_id IS NOT NULL AND linked_via IS NULL'))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM handle_proofs hp JOIN joiners j ON j.id = hp.joiner_id WHERE j.account_id IS NOT NULL'))[0].n, 0, 'a linked handle keeps no live proofs');
});
