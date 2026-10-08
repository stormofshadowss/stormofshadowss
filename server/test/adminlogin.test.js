import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN } from './helpers.js';
import { createAdmin, setAdminPassword, listAdmins, adminCount, AdminError } from '../src/lib/admins.js';
import { createLoginToken } from '../src/auth.js';

let app;
before(async () => { app = await startApp({ ADMIN_MAX_FAILURES: '5', ADMIN_LOCK_MINUTES: '15', ADMIN_SESSION_HOURS: '12', RATE_ADMIN_LOGIN_PER_15MIN: '1000' }); });
after(async () => { await app.stop(); });

const login = (username, password, cookie) => app.api('POST', '/api/admin/login', { username, password }, cookie);

test('the password is stored only as a salted scrypt hash', async () => {
  const [row] = await app.q('SELECT password_hash FROM accounts WHERE username = ?', [ADMIN.username]);
  assert.match(row.password_hash, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!row.password_hash.includes(ADMIN.password));
  await createAdmin(app.pool, { username: 'second', email: 'second@example.com', password: ADMIN.password });
  const [other] = await app.q('SELECT password_hash FROM accounts WHERE username = ?', ['second']);
  assert.notEqual(other.password_hash, row.password_hash, 'same password, different salt, different hash');
  await app.q("DELETE FROM accounts WHERE username = 'second'");
});

test('signing in: cookie is HttpOnly and the admin tools open up', async () => {
  const r = await login(ADMIN.username, ADMIN.password);
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await app.api('GET', '/api/admin/payments', undefined, cookie.split(';')[0])).status, 200);
});

test('the username is not case-sensitive, the password is', async () => {
  assert.equal((await login('BOSS', ADMIN.password)).status, 200);
  assert.equal((await login(ADMIN.username, ADMIN.password.toUpperCase())).status, 401);
});

test('admin sessions are short (12 hours), unlike joiners', async () => {
  const cookie = await app.adminLogin();
  const [row] = await app.q('SELECT TIMESTAMPDIFF(MINUTE, created_at, expires_at) AS mins FROM sessions ORDER BY id DESC LIMIT 1');
  assert.ok(Math.abs(row.mins - 12 * 60) <= 1, `expected ~720 minutes, got ${row.mins}`);
  assert.ok(cookie);
});

test('wrong password, unknown username and a joiner\'s email all get the same answer and no cookie', async () => {
  await app.login('joiner@example.com');   // a real joiner account exists
  const results = await Promise.all([
    login(ADMIN.username, 'wrong password here'), login('nobody', 'whatever password'), login('joiner@example.com', 'whatever password'),
  ]);
  for (const r of results) { assert.equal(r.status, 401); assert.equal(r.headers.get('set-cookie'), null); }
  assert.deepEqual(results[0].json, results[1].json, 'nothing reveals whether the username exists');
  assert.deepEqual(results[1].json, results[2].json);
});

test('five wrong passwords lock the account — even the right password is then refused', async () => {
  await createAdmin(app.pool, { username: 'lockme', email: 'lockme@example.com', password: 'a-long-test-passphrase' });
  for (let i = 0; i < 5; i++) assert.equal((await login('lockme', `wrong guess number ${i}`)).status, 401);
  const locked = await login('lockme', 'a-long-test-passphrase');
  assert.equal(locked.status, 401, 'locked, so the right password is refused too');
  assert.equal(locked.headers.get('set-cookie'), null);
  assert.equal((await listAdmins(app.pool)).find((a) => a.username === 'lockme').locked, true);
  assert.ok((await app.q("SELECT 1 FROM audit_log WHERE action = 'admin.locked'")).length >= 1, 'the lock is recorded');

  await app.q("UPDATE accounts SET locked_until = NOW(3) - INTERVAL 1 SECOND WHERE username = 'lockme'");   // the 15 minutes pass
  assert.equal((await login('lockme', 'a-long-test-passphrase')).status, 200);
  assert.equal((await app.q("SELECT failed_logins AS n FROM accounts WHERE username = 'lockme'"))[0].n, 0, 'a good sign-in resets the count');
});

test('locking one admin does not lock another', async () => {
  assert.equal((await login(ADMIN.username, ADMIN.password)).status, 200);
});

test('a few mistakes below the limit never lock you out', async () => {
  await createAdmin(app.pool, { username: 'butterfingers', email: 'bf@example.com', password: 'another-long-passphrase' });
  for (let i = 0; i < 4; i++) await login('butterfingers', 'oops, wrong');
  assert.equal((await login('butterfingers', 'another-long-passphrase')).status, 200);
});

test('per-IP limit on sign-in attempts', async () => {
  const limited = await startApp({ RATE_ADMIN_LOGIN_PER_15MIN: '4' });
  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await limited.api('POST', '/api/admin/login', { username: 'x', password: 'y' })).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429]);
  } finally { await limited.stop(); }
});

test('sign-in needs the X-Requested-With header and sensible input', async () => {
  const res = await fetch(`${app.base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }) });
  assert.equal(res.status, 403);
  assert.equal((await login('', '')).status, 400);
  assert.equal((await login(ADMIN.username, 'x'.repeat(201))).status, 400, 'absurdly long passwords are refused before any hashing');
});

test('an admin can NOT sign in with an emailed link (that would bypass the password)', async () => {
  const before = app.mailer.outbox.length;
  const r = await app.api('POST', '/api/auth/request-link', { email: ADMIN.email });
  assert.equal(r.status, 200);
  assert.equal(app.mailer.outbox.length, before, 'no email is sent');
  assert.deepEqual(r.json, (await app.api('POST', '/api/auth/request-link', { email: 'someone.else@example.com' })).json, 'and the reply is the same as for anyone');
  // even a token that somehow exists is refused
  const token = await createLoginToken(app.pool, app.cfg, ADMIN.email, '127.0.0.1');
  const out = await app.confirm(token);
  assert.equal(out.status, 400);
  assert.equal(out.setCookie, null);
});

test('signing out ends an admin session', async () => {
  const cookie = (await login(ADMIN.username, ADMIN.password)).headers.get('set-cookie').split(';')[0];
  assert.equal((await app.api('POST', '/api/auth/logout', {}, cookie)).status, 200);
  assert.equal((await app.api('GET', '/api/admin/payments', undefined, cookie)).status, 401);
});

test('creating admins: username, email and password are checked', async () => {
  const bad = async (o, re) => { await assert.rejects(createAdmin(app.pool, { username: 'okname', email: 'ok@example.com', password: 'a-very-good-passphrase', ...o }), (e) => e instanceof AdminError && re.test(e.message)); };
  await bad({ password: 'short' }, /at least 12/);
  await bad({ password: 'okname-okname-okname' }, /must not contain the username/);
  await bad({ password: 'aaaaaaaaaaaaaaaaaa' }, /repetitive/);
  await bad({ password: 'MyPassword12345!' }, /easy to guess/);
  await bad({ username: 'a b' }, /3–40 characters/);
  await bad({ username: 'ab' }, /3–40 characters/);
  await bad({ email: 'nope' }, /email/);
  await bad({ username: ADMIN.username }, /already an admin/);
  await bad({ email: ADMIN.email }, /already used/);
  await app.login('joiner.taken@example.com');
  await bad({ email: 'joiner.taken@example.com' }, /already used.*can't double as joiner/s);
});

test('changing a password: the old one stops working, every device is signed out, any lock is cleared', async () => {
  await createAdmin(app.pool, { username: 'changer', email: 'changer@example.com', password: 'the-first-passphrase' });
  const cookie = (await login('changer', 'the-first-passphrase')).headers.get('set-cookie').split(';')[0];
  for (let i = 0; i < 5; i++) await login('changer', 'nope nope nope');
  await setAdminPassword(app.pool, 'changer', 'the-second-passphrase');
  assert.equal((await app.api('GET', '/api/admin/payments', undefined, cookie)).status, 401, 'the old session was ended');
  assert.equal((await login('changer', 'the-first-passphrase')).status, 401);
  assert.equal((await login('changer', 'the-second-passphrase')).status, 200, 'and the lock is gone');
  await assert.rejects(setAdminPassword(app.pool, 'changer', 'short'), AdminError);
  await assert.rejects(setAdminPassword(app.pool, 'nobody', 'a-very-good-passphrase'), /no admin called/);
});

test('listing admins never exposes a password hash; the count drives the "no admin yet" warning', async () => {
  const list = await listAdmins(app.pool);
  assert.ok(list.length >= 1);
  assert.ok(list.every((a) => !('password_hash' in a) && !('passwordHash' in a) && a.username && a.email));
  assert.ok((await adminCount(app.pool)) >= 1);
});

test('the admin command works from a script (piped input), and refuses mismatched passwords', async () => {
  const { spawnSync } = await import('node:child_process');
  const env = { ...process.env, DB_HOST: app.cfg.db.host, DB_USER: app.cfg.db.user, DB_PASSWORD: app.cfg.db.password, DB_NAME: app.cfg.db.database, MIGRATIONS_DIR: undefined };
  delete env.MIGRATIONS_DIR;
  const run = (args, input) => spawnSync(process.execPath, ['src/admin-cli.js', ...args], { env, input, encoding: 'utf8' });

  let r = run(['create'], 'cliadmin\ncli@example.com\nthis-is-a-good-passphrase\nthis-is-a-good-passphrase\n');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /You can now sign in at \/admin\.html as "cliadmin"/);
  assert.ok(!r.stdout.includes('this-is-a-good-passphrase') || /Password/.test(r.stdout), 'the password is never echoed back');
  assert.equal((await login('cliadmin', 'this-is-a-good-passphrase')).status, 200);

  r = run(['create'], 'other\nother@example.com\nthis-is-a-good-passphrase\ndifferent-passphrase-typed\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not match/);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM accounts WHERE username = 'other'"))[0].n, 0);

  r = run(['set-password', 'cliadmin'], 'a-brand-new-passphrase\na-brand-new-passphrase\n');
  assert.equal(r.status, 0, r.stderr);
  assert.equal((await login('cliadmin', 'this-is-a-good-passphrase')).status, 401);
  assert.equal((await login('cliadmin', 'a-brand-new-passphrase')).status, 200);

  r = run(['list'], '');
  assert.match(r.stdout, /cliadmin\s+<cli@example\.com>/);
  assert.ok(!/scrypt/.test(r.stdout));
  r = run(['create'], 'weak\nweak@example.com\nshort\nshort\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /at least 12/);
});
