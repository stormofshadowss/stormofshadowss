import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

// The page is only usable if the browser can fetch its CSS and scripts. On plain http (a home network: http://192.168.1.12:2999) the header
// "upgrade-insecure-requests" makes browsers ask for them over https instead — which fails, leaving bare unstyled HTML. It belongs only on an https site.
const apps = [];
after(async () => { for (const a of apps) await a.stop(); });
const csp = async (env) => { const a = await startApp(env); apps.push(a); return (await fetch(`${a.base}/`)).headers.get('content-security-policy'); };

test('PLAIN HTTP (COOKIE_SECURE=false, e.g. a home network): the page is NOT told to upgrade its CSS and scripts to https', async () => {
  const h = await csp({ COOKIE_SECURE: 'false' });
  assert.doesNotMatch(h, /upgrade-insecure-requests/);
});

test('HTTPS (COOKIE_SECURE=true, behind a proxy with a certificate): it IS told to, as before', async () => {
  assert.match(await csp({ COOKIE_SECURE: 'true' }), /upgrade-insecure-requests/);
});

test('either way the rest of the policy is untouched: own scripts only, no framing, no objects, forms only to itself', async () => {
  for (const secure of ['false', 'true']) {
    const h = await csp({ COOKIE_SECURE: secure });
    for (const must of ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "frame-ancestors 'none'", "object-src 'none'", "form-action 'self'", "base-uri 'self'", "connect-src 'self'"]) assert.ok(h.includes(must), `${secure}: ${must}`);
  }
});

test('the pages, styles and scripts a browser needs are all served over whatever the page itself used (no redirects to https)', async () => {
  const a = await startApp({ COOKIE_SECURE: 'false' }); apps.push(a);
  for (const path of ['/', '/style.css', '/site/core.js', '/site/shop.js', '/site/shop-groups.js', '/my.html', '/privacy.html']) {
    const r = await fetch(`${a.base}${path}`, { redirect: 'manual' });
    assert.equal(r.status, 200, `${path}: ${r.status}`);
  }
});
