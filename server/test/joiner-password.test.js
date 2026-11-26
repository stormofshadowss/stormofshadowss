import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { hashPassword } from '../src/lib/password.js';

// OPTIONAL PASSWORDS FOR JOINERS, alongside the emailed link: set / change / remove (signed in), sign in with email + password, a lockout, a security email, and the "Want to skip the email next time?" nudge.
let app, admin, w, N = 0;
const GOOD = 'correct horse battery staple', GOOD2 = 'tangerine-umbrella-42';
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c) => app.api(m, p, b, c);
const u = (x = 'pwt') => `${x}${++N}`;
async function person() { const handle = u(), email = `${handle}@x.com`; const cookie = await joinerSession(app, email, handle); return { handle, email, cookie }; }
const setPw = (p, newPassword, currentPassword, cookie = p.cookie) => api('PUT', '/api/my/password', { newPassword, ...(currentPassword !== undefined ? { currentPassword } : {}) }, cookie);
const login = (email, password) => api('POST', '/api/auth/password-login', { email, password });
const cookieOf = (r) => r.headers.get('set-cookie').split(';')[0];
const me = async (cookie) => (await api('GET', '/api/me', undefined, cookie)).json.account;
const row = async (email) => (await app.q('SELECT id, password_hash, password_set_at, password_nudge_off, failed_logins, locked_until FROM accounts WHERE email = ?', [email]))[0];
const via = async (cookie) => (await app.q('SELECT via FROM sessions WHERE token_hash = SHA2(?, 256)', [decodeURIComponent(cookie.split('=')[1])]))[0]?.via;
const mails = (p, what) => app.mailer.outbox.filter((m) => m.to === p.email && m.subject === `Your StormOfShadowss password was ${what}`);
const BAD = "That email and password don't match — or there have been too many wrong tries, so it's paused for a few minutes. You can always use the email link instead.";

test('SET A PASSWORD: only when signed in; at least 10 characters and not a common one (no rules about capitals or symbols); stored hashed; a security email goes whatever their email settings; the account says so', async () => {
  const p = await person(); assert.equal((await api('PUT', '/api/my/password', { newPassword: GOOD })).status, 401, 'signed out: refused'); const before = await me(p.cookie); assert.deepEqual([before.hasPassword, before.passwordSetAt, before.passwordNudge], [false, null, true]);
  const refuse = async (pw, msg, why) => { const r = await setPw(p, pw); assert.deepEqual([r.status, r.json.code, r.json.error], [400, 'weak_password', msg], why); };
  await refuse('short1', 'Your password must be at least 10 characters. A few random words strung together works well.', 'too short'); await refuse('tangerin7', 'Your password must be at least 10 characters. A few random words strung together works well.', 'nine characters is one short'); await refuse('Xylophone-PASSWORD-9', 'That password is too easy to guess — please pick something less common.', 'capital letters make no difference'); await refuse('aaaaaaaaaaaa', 'That password is too repetitive.', 'one letter repeated'); await refuse('mypassword12345', 'That password is too easy to guess — please pick something less common.', 'a common word');
  await refuse(`xx${p.handle}xxzz`, "Your password shouldn't contain the first part of your email address.", 'their own email name'); await refuse('x'.repeat(5).concat('y', 'z'.repeat(200)), 'That password is too long (200 characters at most).', 'too long'); await refuse('qwerty-lemonade', 'That password is too easy to guess — please pick something less common.', 'qwerty');
  assert.equal((await row(p.email)).password_hash, null, 'nothing was saved by the refusals'); assert.equal(mails(p, 'set').length, 0);
  assert.equal((await setPw(p, 'tangerine7')).status, 200, 'exactly 10 characters is fine — no capitals, numbers or symbols needed'); const r = await row(p.email); assert.ok(r.password_hash.startsWith('scrypt$'), 'stored hashed'); assert.ok(!r.password_hash.includes('tangerine'), 'never the password itself'); assert.ok(r.password_set_at);
  assert.equal(mails(p, 'set').length, 1, 'a security email, though they never turned order emails on'); const m = mails(p, 'set')[0]; assert.match(m.text, /^The password you can use to sign in to your StormOfShadowss account was just set\.\n\nIf that was you, there's nothing to do\. If it wasn't, sign in with an email link, change or remove the password, and tell the GOM\./); assert.ok(!m.text.includes('tangerine'), 'the email never contains the password');
  const after = await me(p.cookie); assert.deepEqual([after.hasPassword, after.passwordNudge, !!after.passwordSetAt], [true, false, true]);
});

test('SIGN IN WITH EMAIL + PASSWORD: starts a normal session (remembered as a password session); wrong password, unknown email, no password and a locked account all get the SAME answer; the email link still works', async () => {
  const p = await person(), none = await person(); await setPw(p, GOOD); const ok = await login(p.email.toUpperCase(), GOOD); assert.equal(ok.status, 200, 'email case doesn\'t matter'); const c = cookieOf(ok); assert.ok(c.startsWith('sos_session=')); assert.equal((await me(c)).email, p.email, 'a real session'); assert.equal(await via(c), 'password'); assert.equal(await via(p.cookie), 'link', 'the link session is remembered as one'); assert.equal((await me(c)).needsCurrentPassword, true, 'a password session: the page is told to ask for the current password'); assert.equal((await me(p.cookie)).needsCurrentPassword, false, 'a link session: it is not');
  const fails = [await login(p.email, 'wrong password here'), await login(`nobody-${u()}@x.com`, GOOD), await login(none.email, GOOD)]; for (const f of fails) assert.deepEqual([f.status, f.json.code, f.json.error], [401, 'bad_login', BAD]); assert.equal(fails.some((f) => f.headers.get('set-cookie')), false, 'no cookie for a failure');
  assert.equal((await api('POST', '/api/auth/password-login', { email: 'not-an-email', password: 'x' })).status, 400); assert.equal((await api('POST', '/api/auth/password-login', { email: p.email })).status, 400); const link = await app.login(p.email); assert.ok(link, 'the emailed link still signs them in'); assert.equal((await me(link)).email, p.email);
});

test('LOCKOUT: five wrong tries lock the password sign-in for 15 minutes (even the right password is refused), the emailed link is never affected, it opens again afterwards, and a good sign-in resets the count', async () => {
  const p = await person(); await setPw(p, GOOD); for (let i = 0; i < 4; i++) assert.equal((await login(p.email, `wrong-${i}-wrong`)).status, 401); assert.equal((await row(p.email)).failed_logins, 4); assert.equal((await login(p.email, GOOD)).status, 200, 'the 5th try is the right one'); assert.equal((await row(p.email)).failed_logins, 0, 'a good sign-in resets the count');
  for (let i = 0; i < 5; i++) await login(p.email, `wrong-${i}-wrong`); const locked = await row(p.email); assert.ok(locked.locked_until && locked.failed_logins === 0, 'locked'); const r = await login(p.email, GOOD); assert.deepEqual([r.status, r.json.error], [401, BAD], 'locked: even the right password is refused, with the same message');
  assert.equal((await me(await app.login(p.email))).email, p.email, 'the emailed link still works while it is locked'); await app.q('UPDATE accounts SET locked_until = NOW(3) - INTERVAL 1 MINUTE WHERE email = ?', [p.email]); assert.equal((await login(p.email, GOOD)).status, 200, 'after the lock passes it works again');
  assert.ok((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'password.locked'"))[0].n >= 1, 'recorded');
});

test('CHANGE AND REMOVE: after an EMAIL LINK sign-in the old password isn\'t needed (that is how "I forgot it" works); after a PASSWORD sign-in it is; each change sends a security email; a removed password no longer signs in', async () => {
  const p = await person(); await setPw(p, GOOD); const viaLink = await setPw(p, GOOD2); assert.equal(viaLink.status, 200, 'signed in by the link: no old password needed'); assert.equal(mails(p, 'changed').length, 1); assert.equal((await login(p.email, GOOD)).status, 401, 'the old one no longer works'); assert.equal((await login(p.email, GOOD2)).status, 200);
  const pc = cookieOf(await login(p.email, GOOD2)); const need = await setPw(p, 'another-long-phrase-9', undefined, pc); assert.deepEqual([need.status, need.json.code], [403, 'current_password_needed']); const wrong = await setPw(p, 'another-long-phrase-9', 'not my password', pc); assert.deepEqual([wrong.status, wrong.json.code, wrong.json.error], [403, 'wrong_current_password', "That isn't your current password."]); assert.equal((await row(p.email)).failed_logins, 1, 'a wrong current password counts towards the lock');
  assert.equal((await setPw(p, 'another-long-phrase-9', GOOD2, pc)).status, 200, 'with the right current password'); assert.equal(mails(p, 'changed').length, 2); const weak = await setPw(p, 'short', 'another-long-phrase-9', pc); assert.equal(weak.status, 400, 'the new one must still meet the rule');
  const noCur = await api('DELETE', '/api/my/password', {}, pc); assert.equal(noCur.json.code, 'current_password_needed'); assert.equal((await api('DELETE', '/api/my/password', { currentPassword: 'another-long-phrase-9' }, pc)).status, 200); assert.equal((await row(p.email)).password_hash, null); assert.equal((await row(p.email)).password_set_at, null);
  assert.equal(mails(p, 'removed').length, 1); assert.match(mails(p, 'removed')[0].text, /was just removed\./); assert.equal((await login(p.email, 'another-long-phrase-9')).status, 401, 'a removed password no longer signs in'); assert.equal((await api('DELETE', '/api/my/password', {}, p.cookie)).json.code, 'no_password', 'nothing to remove');
  await setPw(p, GOOD); assert.equal((await api('DELETE', '/api/my/password', {}, p.cookie)).status, 200, 'by link: removable without the old password too'); assert.deepEqual([(await me(p.cookie)).hasPassword, (await me(p.cookie)).passwordNudge], [false, false], 'having set one, they are not nagged again after removing it');
});

test('THE NUDGE: "Want to skip the email next time?" shows until they set a password or say no thanks; saying no thanks is remembered; signed out is refused', async () => {
  const p = await person(), q = await person(); assert.equal((await me(p.cookie)).passwordNudge, true); assert.equal((await api('POST', '/api/my/password/nudge-off', {})).status, 401); assert.equal((await api('POST', '/api/my/password/nudge-off', {}, p.cookie)).status, 200); assert.equal((await me(p.cookie)).passwordNudge, false, 'no thanks: remembered');
  assert.equal((await api('POST', '/api/my/password/nudge-off', {}, p.cookie)).status, 200, 'harmless twice'); assert.equal((await me(q.cookie)).passwordNudge, true, 'someone else is unaffected'); await setPw(q, GOOD); assert.equal((await me(q.cookie)).passwordNudge, false, 'setting one ends the nudge too');
});

test('ADMIN ACCOUNTS ARE NEVER TOUCHED: the joiner routes refuse an admin session, and an admin\'s email and password can\'t be used at the joiner sign-in', async () => {
  const set = await setPw({}, GOOD, undefined, admin); assert.deepEqual([set.status, set.json.code], [403, 'admin_account']); assert.equal((await api('DELETE', '/api/my/password', {}, admin)).json.code, 'admin_account'); assert.equal((await api('POST', '/api/my/password/nudge-off', {}, admin)).json.code, 'admin_account');
  const email = `${u('adm')}@x.com`; await app.q('INSERT INTO accounts (email, is_admin, username, password_hash) VALUES (?, 1, ?, ?)', [email, u('admuser'), await hashPassword('an-admin-pass-phrase-77')]); const r = await login(email, 'an-admin-pass-phrase-77'); assert.deepEqual([r.status, r.json.error], [401, BAD], 'the correct ADMIN password does nothing at the joiner sign-in');
  assert.equal((await me(admin)).passwordNudge, false, 'and an admin is never nudged'); assert.ok((await app.q("SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 1 AND password_hash IS NOT NULL"))[0].n >= 2, 'admin passwords are untouched');
});

test('THE SIGN-IN IS RATE LIMITED PER ADDRESS: a flood of attempts is stopped with a plain message that points at the email link', async () => {
  const p = await person(); await setPw(p, GOOD); let limited = null; for (let i = 0; i < 80 && !limited; i++) { const r = await login(p.email, `flood-${i}-flood`); if (r.status === 429) limited = r; }
  assert.ok(limited, 'stopped before 80 tries'); assert.match(limited.text, /Too many sign-in attempts from here — please wait a few minutes\. You can always use the email link instead\./);
});
