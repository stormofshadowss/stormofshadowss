import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { bootstrapAdmin, adminCount } from '../src/lib/admins.js';
import { loadConfig } from '../src/config.js';

// The first admin can come from the settings file, so a fresh install needs no terminal. Each test gets its own empty database.
let app;
const apps = [];
// the test harness always makes an admin; remove it so this really is an empty, brand-new install
const fresh = async () => { const a = await startApp(); apps.push(a); await a.q('DELETE FROM accounts WHERE is_admin = 1'); return a; };
after(async () => { for (const a of apps) await a.stop(); });
const logger = () => { const out = { log: [], warn: [], error: [] }; return { out, log: (m) => out.log.push(m), warn: (m) => out.warn.push(m), error: (m) => out.error.push(m) }; };
const signIn = (a, username, password) => fetch(`${a.base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sos' }, body: JSON.stringify({ username, password }) });
const PW = 'purple-kettle-meadow-83';

test('on a fresh install the admin is created from the settings and can sign in straight away', async () => {
  const a = await fresh(); const log = logger();
  assert.equal(await adminCount(a.pool), 0, 'a brand-new database has no admin');
  const r = await bootstrapAdmin(a.pool, { username: 'Caroline', password: PW }, log);
  assert.deepEqual(r, { created: true, username: 'caroline' });
  assert.equal(await adminCount(a.pool), 1);
  assert.equal((await signIn(a, 'caroline', PW)).status, 200, 'and the login works');
  assert.equal((await signIn(a, 'caroline', 'not-the-password-1')).status, 401);
  assert.match(log.out.log[0], /Created the first admin "caroline"\. You can sign in now — and remove INITIAL_ADMIN_PASSWORD from your settings/);
  const [row] = await a.q('SELECT email, is_admin FROM accounts WHERE username = ?', ['caroline']);
  assert.deepEqual([row.email, row.is_admin], ['caroline@admin.local', 1], 'an email is not needed: a placeholder is used');
});

test('an email can be given if you want one on the account', async () => {
  const a = await fresh();
  assert.equal((await bootstrapAdmin(a.pool, { username: 'gom', email: 'Me@Example.com', password: PW }, logger())).created, true);
  assert.equal((await a.q('SELECT email FROM accounts WHERE username = ?', ['gom']))[0].email, 'me@example.com');
});

test('IT NEVER TOUCHES AN EXISTING ADMIN: if there is one, the settings are ignored (and it says so) — even a different username or a new password', async () => {
  const a = await fresh(); const log = logger();
  await bootstrapAdmin(a.pool, { username: 'first', password: PW }, logger());
  const r1 = await bootstrapAdmin(a.pool, { username: 'first', password: 'a-completely-new-pass-9' }, log);
  const r2 = await bootstrapAdmin(a.pool, { username: 'second', password: PW }, log);
  assert.deepEqual([r1.created, r1.reason, r2.created, r2.reason], [false, 'exists', false, 'exists']);
  assert.equal(await adminCount(a.pool), 1);
  assert.equal((await signIn(a, 'first', PW)).status, 200, 'the password did not change');
  assert.equal((await signIn(a, 'first', 'a-completely-new-pass-9')).status, 401);
  assert.equal((await signIn(a, 'second', PW)).status, 401, 'no second admin appeared');
  assert.match(log.out.log[0], /an admin already exists, so it was ignored/);
});

test('nothing set means nothing happens; half set is explained and creates nothing', async () => {
  const a = await fresh(); const log = logger();
  assert.deepEqual(await bootstrapAdmin(a.pool, {}, log), { created: false, reason: 'not_set' });
  assert.deepEqual(await bootstrapAdmin(a.pool, undefined, log), { created: false, reason: 'not_set' });
  assert.equal((await bootstrapAdmin(a.pool, { username: 'only-a-name' }, log)).reason, 'incomplete');
  assert.equal((await bootstrapAdmin(a.pool, { password: PW }, log)).reason, 'incomplete');
  assert.match(log.out.warn[0], /must be set together — no admin was created/);
  assert.equal(await adminCount(a.pool), 0);
});

test('a weak password or a bad username does NOT create an admin, does not crash the start-up, and says exactly what is wrong', async () => {
  const a = await fresh(); const log = logger();
  const weak = await bootstrapAdmin(a.pool, { username: 'caroline', password: 'short' }, log);
  assert.deepEqual([weak.created, weak.reason], [false, 'invalid']); assert.match(weak.error, /at least 12 characters/);
  assert.equal((await bootstrapAdmin(a.pool, { username: 'caroline', password: 'caroline-is-my-name-1' }, log)).reason, 'invalid');
  const badName = await bootstrapAdmin(a.pool, { username: 'a b', password: PW }, log);
  assert.match(badName.error, /username must be 3–40 characters/);
  assert.ok(log.out.error.length === 3 && log.out.error.every((e) => /Couldn't create the first admin/.test(e)));
  assert.equal(await adminCount(a.pool), 0);
  assert.equal((await bootstrapAdmin(a.pool, { username: 'caroline', password: PW }, log)).created, true, 'and a corrected setting works on the next start');
});

test('an email already used by a joiner is explained rather than crashing', async () => {
  const a = await fresh(); const log = logger();
  await a.q("INSERT INTO accounts (email, is_admin) VALUES ('taken@example.com', 0)");
  const r = await bootstrapAdmin(a.pool, { username: 'caroline', email: 'taken@example.com', password: PW }, log);
  assert.equal(r.created, false); assert.match(r.error, /email is already used by another account/);
});

test('THE PASSWORD IS NEVER WRITTEN TO THE LOG, in any outcome', async () => {
  const a = await fresh(); const log = logger();
  await bootstrapAdmin(a.pool, { username: 'caroline', password: PW }, log);                // created
  await bootstrapAdmin(a.pool, { username: 'caroline', password: PW }, log);                // exists
  const b = await fresh();
  await bootstrapAdmin(b.pool, { username: 'caroline', password: 'caroline-secret-pass' }, log);   // refused (contains the username)
  const all = JSON.stringify(log.out);
  assert.ok(!all.includes(PW) && !all.includes('caroline-secret-pass'), 'no password in any message');
  const [row] = await a.q('SELECT password_hash FROM accounts WHERE username = ?', ['caroline']);
  assert.ok(!row.password_hash.includes(PW) && /^\$|^[a-z0-9]+\$/i.test(row.password_hash.slice(0, 12)), 'and it is stored hashed');
});

test('the settings are read from the environment (and stripped of stray spaces); an empty environment means no first admin', () => {
  const c = loadConfig({ INITIAL_ADMIN_USERNAME: '  caroline ', INITIAL_ADMIN_EMAIL: ' me@x.com ', INITIAL_ADMIN_PASSWORD: PW, DB_PASSWORD: 'x', PUBLIC_URL: 'http://localhost' });
  assert.deepEqual(c.initialAdmin, { username: 'caroline', email: 'me@x.com', password: PW });
  assert.deepEqual(loadConfig({ DB_PASSWORD: 'x', PUBLIC_URL: 'http://localhost' }).initialAdmin, { username: '', email: '', password: '' });
});
