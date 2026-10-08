import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let app;
before(async () => { app = await startApp({ LOGIN_LINKS_PER_EMAIL_PER_HOUR: '3' }); });
after(async () => { await app.stop(); });

test('asking for a link answers identically for any address and emails a link to real ones', async () => {
  const a = await app.api('POST', '/api/auth/request-link', { email: 'new.person@example.com' });
  assert.equal(a.status, 200);
  assert.equal(a.json.ok, true);
  assert.equal(app.mailer.outbox.length, 1);
  assert.match(app.mailer.outbox[0].text, /http:\/\/test\.local\/auth\/confirm\?token=/);
  const b = await app.api('POST', '/api/auth/request-link', { email: 'someone.else@example.com' });
  assert.deepEqual(b.json, a.json, 'the answer reveals nothing about the address');
});

test('bad email addresses are rejected', async () => {
  assert.equal((await app.api('POST', '/api/auth/request-link', { email: 'not-an-email' })).status, 400);
  assert.equal((await app.api('POST', '/api/auth/request-link', {})).status, 400);
});

test('only a hash of the token is ever stored', async () => {
  await app.api('POST', '/api/auth/request-link', { email: 'hash.check@example.com' });
  const token = app.tokenFromMail('hash.check@example.com');
  const rows = await app.q('SELECT token_hash FROM login_tokens WHERE email = ?', ['hash.check@example.com']);
  assert.equal(rows[0].token_hash.length, 64);
  assert.notEqual(rows[0].token_hash, token);
  assert.ok(!JSON.stringify(await app.q('SELECT * FROM login_tokens')).includes(token), 'the raw token appears nowhere in the table');
});

test('opening the emailed link does NOT sign you in (mail scanners fetch links); the button does', async () => {
  await app.api('POST', '/api/auth/request-link', { email: 'scanner@example.com' });
  const token = app.tokenFromMail('scanner@example.com');
  const page = await fetch(`${app.base}/auth/confirm?token=${token}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<button type="submit">Sign in<\/button>/);
  assert.equal(page.headers.get('set-cookie'), null, 'a plain GET sets no session');
  // ...and the token still works afterwards, so the scanner didn't burn it
  const out = await app.confirm(token);
  assert.equal(out.status, 303);
  assert.match(out.setCookie, /^sos_session=/);
});

test('the session cookie is HttpOnly, SameSite=Lax, and works', async () => {
  await app.api('POST', '/api/auth/request-link', { email: 'cookie@example.com' });
  const out = await app.confirm(app.tokenFromMail('cookie@example.com'));
  assert.match(out.setCookie, /HttpOnly/i);
  assert.match(out.setCookie, /SameSite=Lax/i);
  const me = await app.api('GET', '/api/me', undefined, out.setCookie.split(';')[0]);
  assert.equal(me.status, 200);
  assert.equal(me.json.account.email, 'cookie@example.com');
  assert.equal(me.json.account.isAdmin, false);
});

test('a sign-in link works exactly once', async () => {
  await app.api('POST', '/api/auth/request-link', { email: 'once@example.com' });
  const token = app.tokenFromMail('once@example.com');
  assert.equal((await app.confirm(token)).status, 303);
  const again = await app.confirm(token);
  assert.equal(again.status, 400);
  assert.match(again.text, /expired/i);
  assert.equal(again.setCookie, null);
});

test('two requests racing on one link: only one gets in', async () => {
  await app.api('POST', '/api/auth/request-link', { email: 'race@example.com' });
  const token = app.tokenFromMail('race@example.com');
  const results = await Promise.all(Array.from({ length: 6 }, () => app.confirm(token)));
  assert.equal(results.filter((r) => r.status === 303).length, 1);
});

test('expired and made-up tokens are refused', async () => {
  await app.api('POST', '/api/auth/request-link', { email: 'expired@example.com' });
  const token = app.tokenFromMail('expired@example.com');
  await app.q("UPDATE login_tokens SET expires_at = NOW(3) - INTERVAL 1 MINUTE WHERE email = 'expired@example.com'");
  assert.equal((await app.confirm(token)).status, 400);
  assert.equal((await app.confirm('x'.repeat(43))).status, 400);
  assert.equal((await app.confirm('')).status, 400);
});

test('admin screens need an admin login; joiner sessions and strangers are refused', async () => {
  const adminCookie = await app.adminLogin();
  const me = (await app.api('GET', '/api/me', undefined, adminCookie)).json.account;
  assert.equal(me.isAdmin, true);
  assert.equal(me.username, 'boss');
  const joinerCookie = await app.login('joiner@example.com');
  assert.equal((await app.api('GET', '/api/me', undefined, joinerCookie)).json.account.isAdmin, false);
  assert.equal((await app.api('GET', '/api/admin/payments', undefined, joinerCookie)).status, 403);
  assert.equal((await app.api('GET', '/api/admin/payments')).status, 401);
  assert.equal((await app.api('GET', '/api/admin/payments', undefined, adminCookie)).status, 200);
});

test('anything that changes data needs the X-Requested-With header (blocks cross-site forms)', async () => {
  const cookie = await app.login('csrf@example.com');
  const res = await fetch(`${app.base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(res.status, 403);
  assert.equal((await app.api('GET', '/api/me', undefined, cookie)).status, 200, 'session untouched');
});

test('signing out ends the session for good', async () => {
  const cookie = await app.login('logout@example.com');
  assert.equal((await app.api('POST', '/api/auth/logout', {}, cookie)).status, 200);
  assert.equal((await app.api('GET', '/api/me', undefined, cookie)).status, 401, 'the old cookie no longer works');
});

test('sessions expire', async () => {
  const cookie = await app.login('expiring@example.com');
  await app.q("UPDATE sessions SET expires_at = NOW(3) - INTERVAL 1 SECOND");
  assert.equal((await app.api('GET', '/api/me', undefined, cookie)).status, 401);
});

test('a forged or garbage cookie is just "not signed in"', async () => {
  assert.equal((await app.api('GET', '/api/me', undefined, 'sos_session=' + 'A'.repeat(43))).status, 401);
  assert.equal((await app.api('GET', '/api/me', undefined, 'sos_session=%E0%A4%A')).status < 500, true, 'malformed cookie never causes a 500');
});

test('one email can only request so many links an hour — and still gets the same answer', async () => {
  const before = app.mailer.outbox.length;
  const answers = [];
  for (let i = 0; i < 5; i++) answers.push((await app.api('POST', '/api/auth/request-link', { email: 'spammed@example.com' })).json);
  assert.equal(app.mailer.outbox.length - before, 3, 'only 3 emails go out (the limit for this test app)');
  assert.ok(answers.every((a) => a.ok === true));
});

test('per-IP rate limit on link requests', async () => {
  const limited = await startApp({ RATE_REQUEST_LINK_PER_HOUR: '3' });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await limited.api('POST', '/api/auth/request-link', { email: `r${i}@example.com` })).status);
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  } finally { await limited.stop(); }
});

test('security headers are on', async () => {
  const res = await fetch(`${app.base}/healthz`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-powered-by'), null);
});
