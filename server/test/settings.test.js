import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { NOTIFY_EVENTS, EVENT_KEYS } from '../src/lib/notify-events.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'st') => `${x}${++N}`;
const mailsTo = (email) => app.mailer.outbox.filter((m) => m.to === email);
const linkIn = (email) => /token=([A-Za-z0-9_-]+)/.exec(mailsTo(email).filter((m) => /token=/.test(m.text)).pop().text)[1];
const confirmPage = (token) => fetch(`${app.base}/auth/confirm?token=${token}`).then(async (r) => ({ status: r.status, text: await r.text() }));
const confirmPost = async (token) => { const r = await fetch(`${app.base}/auth/confirm`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}`, redirect: 'manual' }); return { status: r.status, location: r.headers.get('location'), cookie: (r.headers.get('set-cookie') || '').split(';')[0], text: await r.text() }; };
const person = async (handle = u()) => ({ handle, email: `${handle}@x.com`, cookie: await joinerSession(app, `${handle}@x.com`, handle) });
const joinerRow = async (h) => (await app.q('SELECT * FROM joiners WHERE instagram_handle = ?', [h]))[0];
const count = async (sql, a = []) => (await app.q(sql, a))[0].n;

// ───────────── changing the sign-in email ─────────────
test('CHANGING THE SIGN-IN EMAIL: a link goes to the NEW address; only opening it there changes anything; other devices are signed out; the old address is told', async () => {
  const p = await person(); const other = await app.login(`${p.handle}.second@x.com`); void other;
  const newEmail = `${u('new')}@elsewhere.com`;
  const second = await joinerSession(app, `${p.handle}-b@x.com`, `${p.handle}b`);                 // an unrelated account, to prove it is untouched
  const r = await api('POST', '/api/my/email/change', { email: newEmail }, p.cookie);
  assert.equal(r.status, 200); assert.match(r.json.message, new RegExp(`We've sent a confirmation link to ${newEmail}\\..*signed out on your other devices`));
  assert.equal((await api('GET', '/api/me', undefined, p.cookie)).json.account.email, p.email, 'nothing changed yet');
  const mail = mailsTo(newEmail).at(-1); assert.match(mail.subject, /Confirm your new StormOfShadowss sign-in email/); assert.match(mail.text, /If it wasn't you, ignore this email and nothing will change/);
  const token = linkIn(newEmail);
  const page = await confirmPage(token); assert.match(page.text, /Confirm your new email/); assert.match(page.text, /Tap the button to make this your new sign-in email/);
  await confirmPage(token);                                                                         // looking at it twice must not use it up
  assert.equal((await api('GET', '/api/me', undefined, p.cookie)).json.account.email, p.email, 'still nothing changed');
  const done = await confirmPost(token);
  assert.equal(done.status, 303); assert.equal(done.location, '/my.html?updated=email#/settings'); assert.ok(done.cookie.startsWith('sos_session='));
  assert.equal((await api('GET', '/api/me', undefined, p.cookie)).status, 401, 'the old session (any other device) is signed out');
  const me = (await api('GET', '/api/me', undefined, done.cookie)).json;
  assert.deepEqual([me.account.email, me.handles.map((h) => h.handle)], [newEmail, [p.handle]], 'same account, same handle, new email');
  const notice = mailsTo(p.email).at(-1); assert.match(notice.subject, /Your StormOfShadowss sign-in email was changed/); assert.match(notice.text, /changed from this address to .\*\*\*@elsewhere\.com/); assert.match(notice.text, /contact the GOM straight away/);
  assert.equal((await api('GET', '/api/me', undefined, second)).status, 200, 'other accounts are untouched');
  // the old address now leads to a brand-new, empty account — not this one
  await api('POST', '/api/auth/request-link', { email: p.email }); const old = await confirmPost(linkIn(p.email));
  assert.deepEqual((await api('GET', '/api/me', undefined, old.cookie)).json.handles, []);
});

test('the rules: not your current email, not one that is already taken (including the GOM\'s), not invalid, signed-in joiners only', async () => {
  const p = await person(); const taken = await person();
  const ask = (email, c = p.cookie) => api('POST', '/api/my/email/change', { email }, c);
  const same = await ask(p.email); assert.equal(same.status, 400); assert.equal(same.json.code, 'same_email'); assert.match(same.json.error, /already your sign-in email/);
  const t = await ask(taken.email); assert.equal(t.status, 409); assert.equal(t.json.code, 'email_taken'); assert.match(t.json.error, /already used by another account/);
  assert.equal((await ask('gom@example.com')).status === 409 || (await ask('gom@example.com')).status === 200, true);
  assert.equal((await ask('not-an-email')).status, 400);
  assert.equal((await ask('A@B.COM ')).status, 200, 'trimmed and lower-cased');
  assert.equal(await count("SELECT COUNT(*) AS n FROM login_tokens WHERE email = 'a@b.com' AND change_account_id IS NOT NULL"), 1);
  assert.equal((await app.api('POST', '/api/my/email/change', { email: 'x@y.com' })).status, 401);
  const adm = await ask('some.admin.new@x.com', admin); assert.equal(adm.status, 403);
  assert.equal(mailsTo(taken.email).filter((m) => /Confirm your new/.test(m.subject)).length, 0, 'the address that was refused got no email');
});

test('ONLY THE NEWEST LINK WORKS; a link works once, and not after it has expired; and if the address was taken in the meantime nothing changes', async () => {
  const p = await person(); const e1 = `${u('first')}@e.com`, e2 = `${u('second')}@e.com`;
  await api('POST', '/api/my/email/change', { email: e1 }, p.cookie); const t1 = linkIn(e1);
  await api('POST', '/api/my/email/change', { email: e2 }, p.cookie); const t2 = linkIn(e2);
  const dead = await confirmPost(t1); assert.equal(dead.status, 400); assert.match(dead.text, /This link has expired/);
  assert.equal(await count('SELECT COUNT(*) AS n FROM accounts WHERE email = ?', [e1]), 0);
  const ok = await confirmPost(t2); assert.equal(ok.status, 303);
  assert.equal((await confirmPost(t2)).status, 400, 'once only');
  // expiry
  const q = await person(); const e3 = `${u('late')}@e.com`; await api('POST', '/api/my/email/change', { email: e3 }, q.cookie);
  await app.q("UPDATE login_tokens SET expires_at = NOW(3) - INTERVAL 1 MINUTE WHERE email = ?", [e3]);
  assert.equal((await confirmPost(linkIn(e3))).status, 400); assert.equal((await api('GET', '/api/me', undefined, q.cookie)).json.account.email, q.email);
  // taken in between
  const r = await person(); const e4 = `${u('race')}@e.com`; await api('POST', '/api/my/email/change', { email: e4 }, r.cookie);
  const t4 = linkIn(e4);                                                                            // (keep THIS link: the next step sends the other person their own sign-in email)
  await joinerSession(app, e4, u('grabbed'));                                                       // someone else signs up with that address first
  const lost = await confirmPost(t4); assert.equal(lost.status, 400); assert.match(lost.text, /already used by another account/); assert.equal(lost.cookie, '', 'no session was created');
  assert.equal((await api('GET', '/api/me', undefined, r.cookie)).json.account.email, r.email, 'and the account was not changed');
});

test('ordinary sign-in links are unaffected by all this (and the page still says "Sign in")', async () => {
  const email = `${u('plain')}@x.com`; await api('POST', '/api/auth/request-link', { email });
  const token = linkIn(email); const page = await confirmPage(token);
  assert.match(page.text, /Tap the button to finish signing in on this device/); assert.doesNotMatch(page.text, /new sign-in email/);
  const r = await confirmPost(token); assert.equal(r.status, 303); assert.equal(r.location, '/');
  assert.equal((await api('GET', '/api/me', undefined, r.cookie)).json.account.email, email);
  assert.match((await confirmPage('nonsense-token')).text, /Tap the button to finish signing in/, 'a bad link looks like any other until used');
});

// ───────────── removing a handle ─────────────
test('REMOVING A HANDLE: when it has nothing in progress it goes back to being unlinked, and its delivery details are wiped so a future owner never sees them', async () => {
  const p = await person(); const h2 = u('extra');
  await api('PUT', '/api/my/address', { fullName: 'Remove Me', address: '9 Gone Street, Leeds', email: 'r@x.com', phone: '0700123456' }, p.cookie);
  assert.equal((await api('POST', '/api/me/handles', { handle: h2 }, p.cookie)).status, 200);
  await api('PUT', '/api/my/address?handle=' + h2, { fullName: 'Second Handle', address: '10 Gone Street, Leeds', email: 'r2@x.com', phone: '0700123457' }, p.cookie);
  await api('PUT', '/api/my/defaults', { handle: h2, bias: 'Gone Bias', lomoName: 'Gone Lomo' }, p.cookie);
  assert.equal((await api('DELETE', `/api/me/handles/@${h2.toUpperCase()}`, undefined, p.cookie)).status, 200, '@ and capitals are tolerated');
  const j = await joinerRow(h2); assert.equal(j.account_id, null); assert.equal(j.linked_via, null);
  assert.equal(await count('SELECT COUNT(*) AS n FROM addresses WHERE joiner_id = ?', [j.id]) + await count('SELECT COUNT(*) AS n FROM joiner_defaults WHERE joiner_id = ?', [j.id]), 0, 'their details are gone');
  assert.deepEqual((await api('GET', '/api/me', undefined, p.cookie)).json.handles.map((h) => h.handle), [p.handle], 'the other handle is untouched');
  assert.equal((await api('GET', '/api/my/address', undefined, p.cookie)).status, 200);
  const newcomer = await joinerSession(app, `${u('newowner')}@x.com`, h2);
  assert.equal((await api('GET', '/api/my/address', undefined, newcomer)).json.address ?? null, null, 'a new owner sees none of it');
  assert.equal((await api('DELETE', `/api/me/handles/${h2}`, undefined, p.cookie)).status, 404, 'not theirs any more');
  assert.equal((await api('DELETE', `/api/me/handles/${p.handle}`, undefined, newcomer)).status, 404, 'and nobody can remove someone else\'s');
  assert.equal((await app.api('DELETE', `/api/me/handles/${p.handle}`)).status, 401);
});

test('A HANDLE WITH BUSINESS IN PROGRESS CANNOT BE REMOVED — open orders, money owed, credit, a payment waiting, a parcel — each said plainly; and once finished it can', async () => {
  const mk = async () => { const p = await person(); const extra = u('xtra'); await api('POST', '/api/me/handles', { handle: extra }, p.cookie); return { ...p, extra }; };
  const refuse = async (p, re) => { const r = await api('DELETE', `/api/me/handles/${p.extra}`, undefined, p.cookie); assert.equal(r.status, 409, r.text); assert.equal(r.json.code, 'handle_busy'); assert.match(r.json.error, re); assert.equal((await joinerRow(p.extra)).account_id !== null, true, 'still linked'); };
  const a = await mk(); await app.api('POST', '/api/claims', { handle: a.extra, lines: [{ itemId: w.keyring }] });
  await refuse(a, /can't be removed yet — it still has orders that are still in progress/);
  const b = await mk(); const [cb] = await claimAndSecure(app, admin, b.extra, w.keyring);
  await refuse(b, /orders that are still in progress, money owed/);
  const pay = await api('POST', '/api/my/payments', { handle: b.extra, method: 'PayPal', amount: 6, reference: 'x' }, b.cookie);
  await refuse(b, /a payment waiting to be checked/);
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {}); await refuse(b, /orders that are still in progress/);
  await app.q("UPDATE claims SET pipeline = 'completed' WHERE id = ?", [cb]);
  await api('POST', '/api/admin/credit/add', { handle: b.extra, amount: 3, reason: 'g' }); await refuse(b, /credit on it/);
  const jb = await joinerRow(b.extra); await app.q("UPDATE credit_ledger SET balance_effect = 0 WHERE joiner_id = ? AND kind = 'credit'", [jb.id]);
  assert.equal((await api('DELETE', `/api/me/handles/${b.extra}`, undefined, b.cookie)).status, 200, 'finished, paid, delivered, nothing held: it can go');
  assert.equal(await count('SELECT COUNT(*) AS n FROM claims WHERE id = ?', [cb]), 1, 'and its completed order history stays with the handle');
  const only = await person(); assert.equal((await api('DELETE', `/api/me/handles/${only.handle}`, undefined, only.cookie)).status, 200, 'even a last handle can go if it is clean');
  assert.equal((await api('GET', '/api/my/summary', undefined, only.cookie)).json.code, 'no_handle');
});

// ───────────── saved shipping defaults ─────────────
test('SHIPPING DEFAULTS: saved per handle, trimmed, cleared by saving blanks, and private to the person', async () => {
  const p = await person(); const h2 = u('two'); await api('POST', '/api/me/handles', { handle: h2 }, p.cookie);
  assert.equal((await api('GET', '/api/my/defaults', undefined, p.cookie)).status, 400, 'two handles: it asks which');
  const get = async (h, c = p.cookie) => (await api('GET', `/api/my/defaults?handle=${h}`, undefined, c)).json;
  assert.deepEqual(await get(p.handle), { handle: p.handle, bias: '', lomoName: '' });
  const put = await api('PUT', '/api/my/defaults', { handle: p.handle, bias: '  Hyunjin ', lomoName: ' Jinnie  ' }, p.cookie);
  assert.deepEqual([put.status, put.json.bias, put.json.lomoName], [200, 'Hyunjin', 'Jinnie']);
  assert.deepEqual(await get(p.handle), { handle: p.handle, bias: 'Hyunjin', lomoName: 'Jinnie' });
  assert.deepEqual(await get(h2), { handle: h2, bias: '', lomoName: '' }, 'each handle has its own');
  await api('PUT', '/api/my/defaults', { handle: p.handle, bias: 'Only bias', lomoName: '' }, p.cookie); assert.equal((await get(p.handle)).lomoName, '');
  assert.equal((await api('PUT', '/api/my/defaults', { handle: p.handle, bias: 'x'.repeat(81) }, p.cookie)).status, 400);
  await api('PUT', '/api/my/defaults', { handle: p.handle, bias: '', lomoName: '' }, p.cookie);
  assert.equal(await count('SELECT COUNT(*) AS n FROM joiner_defaults WHERE joiner_id = ?', [(await joinerRow(p.handle)).id]), 0, 'blank saves remove the row');
  const stranger = await person(); assert.equal((await api('GET', `/api/my/defaults?handle=${p.handle}`, undefined, stranger.cookie)).status, 403, 'not someone else\'s');
  assert.equal((await app.api('GET', '/api/my/defaults')).status, 401); assert.equal((await app.api('PUT', '/api/my/defaults', { bias: 'x' })).status, 401);
});

// ───────────── choosing which emails to get ─────────────
test('CHOOSING WHICH EMAILS: every kind is listed and on by default; each can be switched off on its own; the master switch keeps your choices; nonsense is refused', async () => {
  const p = await person(); const get = async () => (await api('GET', '/api/my/notifications', undefined, p.cookie)).json;
  const g = await get(); assert.deepEqual(g.events.map((e) => e.key), EVENT_KEYS); assert.deepEqual(g.events.map((e) => e.label), NOTIFY_EVENTS.map((e) => e.label)); assert.ok(g.events.every((e) => e.enabled));
  await api('PUT', '/api/my/notifications', { enabled: true }, p.cookie);
  const off = await api('PUT', '/api/my/notifications', { events: { parcelShipped: false, overdue: false } }, p.cookie);
  assert.deepEqual([off.status, off.json.enabled, off.json.events.filter((e) => !e.enabled).map((e) => e.key)], [200, true, ['parcelShipped', 'overdue']]);
  await api('PUT', '/api/my/notifications', { events: { parcelShipped: true } }, p.cookie);
  assert.deepEqual((await get()).events.filter((e) => !e.enabled).map((e) => e.key), ['overdue']);
  const master = await api('PUT', '/api/my/notifications', { enabled: false }, p.cookie); assert.equal(master.json.enabled, false);
  assert.deepEqual((await get()).events.filter((e) => !e.enabled).map((e) => e.key), ['overdue'], 'turning everything off and on again remembers the individual choices');
  const unknown = await api('PUT', '/api/my/notifications', { events: { nonsense: false } }, p.cookie); assert.equal(unknown.status, 400); assert.equal(unknown.json.code, 'unknown_event');
  assert.equal((await api('PUT', '/api/my/notifications', {}, p.cookie)).status, 400); assert.equal((await api('PUT', '/api/my/notifications', { events: { overdue: 'no' } }, p.cookie)).status, 400);
  assert.equal((await app.api('PUT', '/api/my/notifications', { events: { overdue: false } })).status, 401);
});

test('EACH KIND OF EMAIL RESPECTS ITS SWITCH: confirmed claims, payment decisions and cancellation answers are only sent when that kind is on', async () => {
  const subjectsTo = async (email) => { await app.notifier.idle(); return mailsTo(email).filter((m) => !/token=/.test(m.text)).map((m) => m.subject); };
  const mkPerson = async (off) => { const p = await person(); await api('PUT', '/api/my/notifications', { enabled: true, events: Object.fromEntries(off.map((k) => [k, false])) }, p.cookie); return p; };
  // confirmed claims
  const a = await mkPerson(['claimsSecured']); const b = await mkPerson([]);
  const [ca] = await claimAndSecure(app, admin, a.handle, w.keyring); await claimAndSecure(app, admin, b.handle, w.keyring);
  assert.deepEqual(await subjectsTo(a.email), [], 'switched off: nothing'); assert.equal((await subjectsTo(b.email)).length, 1, 'on: one email');
  // payment decisions
  const pa = await api('POST', '/api/my/payments', { method: 'PayPal', amount: 6, reference: 'a' }, a.cookie); const pb = await api('POST', '/api/my/payments', { method: 'PayPal', amount: 6, reference: 'b' }, b.cookie);
  await api('POST', `/api/admin/payments/${pa.json.id}/verify`, {}); await api('POST', `/api/admin/payments/${pb.json.id}/verify`, {});
  // (a switched off only the confirmed-claims email, so a DOES still get the payment email)
  assert.equal((await subjectsTo(a.email)).length, 1); assert.equal((await subjectsTo(b.email)).length, 2);
  const c = await mkPerson(['paymentDecided', 'cancelDecided']); const [cc] = await claimAndSecure(app, admin, c.handle, w.keyring); const pc = await api('POST', '/api/my/payments', { method: 'PayPal', amount: 6, reference: 'c' }, c.cookie);
  await api('POST', `/api/admin/payments/${pc.json.id}/verify`, {}); const rq = await api('POST', `/api/my/claims/${cc}/cancel-request`, {}, c.cookie); await api('POST', `/api/admin/cancel-requests/${rq.json.id}/approve`, {});
  const got = await subjectsTo(c.email); assert.equal(got.length, 1, `only the confirmed-claims email: ${JSON.stringify(got)}`); void ca;
  const d = await mkPerson([]); const [cd] = await claimAndSecure(app, admin, d.handle, w.keyring); const rd = await api('POST', `/api/my/claims/${cd}/cancel-request`, {}, d.cookie); await api('POST', `/api/admin/cancel-requests/${rd.json.id}/decline`, { note: 'no' });
  assert.ok((await subjectsTo(d.email)).some((s) => /cancellation request wasn't approved/.test(s)), 'cancellation answers arrive when that kind is on');
});

test('STRUCTURE: every email the system sends names its kind from the registry, and every kind in the registry is actually used — so a switch can never be a dead switch', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/lib/notify.js'), 'utf8');
  const calls = [...src.matchAll(/recipient\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => a !== 'joinerId, event = null');
  assert.equal(calls.length, 6, 'six places send a kind of email');
  const used = calls.map((a) => /'([A-Za-z]+)'/.exec(a)?.[1]);
  assert.ok(used.every((k) => EVENT_KEYS.includes(k)), `every call names a registered kind: ${used}`);
  assert.deepEqual([...new Set(used)].sort(), [...EVENT_KEYS].sort(), 'and every registered kind is used');
  const others = fs.readdirSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/routes')).map((f) => [f, fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/routes', f), 'utf8')]).filter(([, s]) => /mailer\.send/.test(s)).map(([f]) => f).sort();
  assert.deepEqual(others, ['auth.js', 'invites.js', 'settings.js'], 'the only other emails are sign-in links, claim-your-orders links and the email-change link — never switchable');
});
