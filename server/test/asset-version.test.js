import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startApp } from './helpers.js';
import { assetHash, versionHtml, pageFile } from '../src/lib/asset-version.js';

// UPDATES SHOW UP BY THEMSELVES: pages are sent with every script / stylesheet link stamped with a fingerprint of that file, so a changed file has a new address and nobody has to purge Cloudflare.
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const sha = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
let tmp, app;
before(async () => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-')); fs.mkdirSync(path.join(tmp, 'gom')); fs.writeFileSync(path.join(tmp, 'gom/a.js'), 'console.log(1)'); fs.writeFileSync(path.join(tmp, 'style.css'), 'body{}'); fs.writeFileSync(path.join(tmp, 'favicon.png'), 'png'); app = await startApp(); });
after(async () => { await app.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('STAMPING: local scripts and stylesheets get ?v=<fingerprint>, whatever the quotes or other attributes; everything else is left exactly as it was', () => {
  const v = assetHash(tmp, '/gom/a.js'), c = assetHash(tmp, '/style.css'); assert.match(v, /^[0-9a-f]{10}$/); assert.equal(v, sha(path.join(tmp, 'gom/a.js')), 'a sha1 of the file, first 10 characters');
  const out = versionHtml(`<link rel="stylesheet" href="/style.css"><script src="/gom/a.js"></script><script defer src='/gom/a.js' data-x="1"></script><LINK REL=stylesheet HREF="/style.css">`, tmp);
  assert.equal(out, `<link rel="stylesheet" href="/style.css?v=${c}"><script src="/gom/a.js?v=${v}"></script><script defer src='/gom/a.js?v=${v}' data-x="1"></script><LINK REL=stylesheet HREF="/style.css?v=${c}">`, 'both kinds of quote, other attributes kept, any letter case');
  const untouched = ['<link rel="icon" href="/favicon.png">', '<link rel="stylesheet" href="https://fonts.example/x.css">', '<script src="//cdn.example/x.js"></script>', '<script src="https://cdn.example/x.js"></script>', '<script src="/gom/a.js?v=1"></script>', '<script src="/gom/a.js#x"></script>', '<script src="/gom/missing.js"></script>', '<script src="/../secret.js"></script>', '<script src="gom/a.js"></script>', '<script>var a = "/gom/a.js";</script>', '<a href="/style.css">x</a>', '<img src="/favicon.png">', '<link rel="preload" href="/gom/a.js">'];
  for (const t of untouched) assert.equal(versionHtml(t, tmp), t, t);
});

test('THE FINGERPRINT FOLLOWS THE FILE: the same while it is unchanged, different the moment its contents change (even if the size is the same), different for different files', () => {
  const f = path.join(tmp, 'gom/b.js'); fs.writeFileSync(f, 'aaaa'); const t0 = new Date(Date.now() - 60000); fs.utimesSync(f, t0, t0); const one = assetHash(tmp, '/gom/b.js'); assert.equal(assetHash(tmp, '/gom/b.js'), one, 'unchanged: the same');
  fs.writeFileSync(f, 'bbbb'); const t1 = new Date(Date.now() - 30000); fs.utimesSync(f, t1, t1); const two = assetHash(tmp, '/gom/b.js'); assert.notEqual(two, one, 'changed (same length): a new fingerprint'); assert.equal(two, sha(f)); fs.writeFileSync(f, 'cccccccc'); fs.utimesSync(f, t1, t1); assert.equal(assetHash(tmp, '/gom/b.js'), sha(f), 'a different size is noticed even if the timestamp is the same');
  assert.notEqual(assetHash(tmp, '/gom/a.js'), two, 'different files differ'); assert.equal(assetHash(tmp, '/gom/nope.js'), null); assert.equal(assetHash(tmp, '/gom'), null, 'a folder is not a file'); assert.equal(assetHash(tmp, '/../x.js'), null); assert.equal(assetHash(tmp, '/gom/../../etc/passwd'), null);
});

test('WHICH PAGES AND HOW: "/" is index.html, "x.html" is a page; only .html files inside the public folder', () => {
  fs.writeFileSync(path.join(tmp, 'index.html'), '<html></html>'); fs.writeFileSync(path.join(tmp, 'x.html'), '<html></html>');
  assert.equal(pageFile(tmp, '/'), path.join(tmp, 'index.html')); assert.equal(pageFile(tmp, '/x.html'), path.join(tmp, 'x.html')); 
  const outside = path.join(path.dirname(tmp), `outside-${path.basename(tmp)}.html`); fs.writeFileSync(outside, '<html></html>'); try { assert.equal(pageFile(tmp, `/../${path.basename(outside)}`), null, 'a page just outside the folder is not reachable'); assert.equal(pageFile(tmp, `/%2e%2e/${path.basename(outside)}`), null); } finally { fs.rmSync(outside, { force: true }); }
  for (const bad of ['/nope.html', '/gom/a.js', '/style.css', '/gom', '/../x.html', '/%2e%2e/x.html', '/x.html%00', '/%zz.html', '/gom/../../x.html']) assert.equal(pageFile(tmp, bad), null, bad);
});

test('EVERY REAL PAGE IS SENT STAMPED: each local script and stylesheet carries exactly its file\'s fingerprint, in the original order, and the page is always re-checked', async () => {
  for (const page of ['/', '/index.html', '/my.html', '/admin.html', '/claim.html', '/privacy.html']) {
    const r = await fetch(app.base + page); assert.equal(r.status, 200, page); assert.match(r.headers.get('content-type'), /^text\/html/); assert.equal(r.headers.get('cache-control'), 'no-cache', `${page}: always re-checked`); const html = await r.text();
    const tags = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="(\/[^"]+\.(?:js|css))(\?v=([0-9a-f]{10}))?"/g)]; assert.ok(tags.length >= 3, `${page}: has scripts`);
    for (const [, url, , v] of tags) { assert.ok(v, `${page}: ${url} is stamped`); assert.equal(v, sha(path.join(PUBLIC, url)), `${page}: ${url} carries its own fingerprint`); }
    const original = [...fs.readFileSync(path.join(PUBLIC, page === '/' ? 'index.html' : page.slice(1)), 'utf8').matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]); assert.deepEqual(tags.map((t) => t[1]), original, `${page}: same files, same order`);
  }
  assert.ok(/gom\/orders\.js\?v=[0-9a-f]{10}/.test(await (await fetch(`${app.base}/admin.html`)).text()), 'the admin page names the stamped orders.js (the file that was stuck in the cache)');
});

test('CACHE RULES: a page is re-checked (and answers 304 when unchanged); a stamped file is kept for a year; an unstamped script is always re-checked; other files keep the short cache', async () => {
  const a = await fetch(`${app.base}/my.html`); const etag = a.headers.get('etag'); assert.ok(etag, 'pages have an ETag'); await a.text(); const revalidated = await new Promise((resolve, reject) => http.get(`${app.base}/my.html`, { headers: { 'If-None-Match': etag } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));          // plain http: fetch() itself adds a no-cache header when you send a conditional one
  assert.equal(revalidated, 304, 'unchanged: nothing re-sent');
  const stamped = await fetch(`${app.base}/gom/orders.js?v=${sha(path.join(PUBLIC, 'gom/orders.js'))}`); assert.equal(stamped.status, 200); assert.equal(stamped.headers.get('cache-control'), 'public, max-age=31536000, immutable'); assert.equal(await stamped.text(), fs.readFileSync(path.join(PUBLIC, 'gom/orders.js'), 'utf8'), 'the stamped address serves the real file');
  const css = await fetch(`${app.base}/style.css?v=abc`); assert.equal(css.headers.get('cache-control'), 'public, max-age=31536000, immutable'); assert.equal((await fetch(`${app.base}/gom/orders.js`)).headers.get('cache-control'), 'no-cache'); assert.equal((await fetch(`${app.base}/style.css`)).headers.get('cache-control'), 'no-cache');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])); const other = walk(PUBLIC).find((f) => !/\.(js|css|html)$/i.test(f));
  if (other) assert.match((await fetch(`${app.base}/${path.relative(PUBLIC, other).split(path.sep).join('/')}`)).headers.get('cache-control'), /max-age=300/, 'other kinds of file (images and so on, if there are any) keep the short cache as before');
});

test('NOTHING ELSE CHANGES: a missing page is a 404, a path that tries to leave the folder is refused, HEAD works, a POST to a page isn\'t served as one, and the API is untouched', async () => {
  assert.equal((await fetch(`${app.base}/nope.html`)).status, 404); for (const bad of ['/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/gom/..%2f..%2fserver%2fpackage.json']) { const r = await fetch(`${app.base}${bad}`); assert.ok([400, 403, 404].includes(r.status), `${bad} → ${r.status}`); assert.doesNotMatch(await r.text(), /root:|"name"/); }
  const head = await fetch(`${app.base}/my.html`, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('cache-control'), 'no-cache'); assert.notEqual((await fetch(`${app.base}/my.html`, { method: 'POST' })).status, 200);
  assert.equal((await fetch(`${app.base}/healthz`)).status, 200); assert.equal((await fetch(`${app.base}/api/nothing-here`)).status, 404); assert.match((await fetch(`${app.base}/preview.html`)).headers.get('content-security-policy') || '', /unsafe-inline/, 'the design preview keeps its own policy');
});
