import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from './helpers.js';

// The privacy notice (public/privacy.html). These tests keep what it SAYS true: if the code starts setting a new cookie, loading something from another company,
// or changes who can delete their account, a test here fails until the notice (or the code) is dealt with.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NOTICE = read('public/privacy.html');
const plain = NOTICE.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

test('the notice is served to anyone (no sign-in), and says the things a privacy notice must: who, what, why, who else, how long, your rights, complaints', async () => {
  const r = await fetch(`${app.base}/privacy.html`);
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/);
  const t = (await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const heading of ['Who we are', 'What we keep, and why', 'Cookies', 'Who else sees it', "Why we're allowed to", 'How long we keep it', 'Your rights', 'Changes']) assert.match(t, new RegExp(heading), heading);
  assert.match(t, /Last updated October 2026/); assert.match(t, /Information Commissioner's Office at ico\.org\.uk/); assert.match(t, /We don't sell your information and we don't use it for marketing/);
  assert.match(t, /order emails only if you turn them on/);
});

test('THE RETENTION STATEMENT matches what deleting an account really does (and says it plainly, here rather than on the delete screen)', () => {
  assert.match(plain, /If you have never had a confirmed order or a payment, everything about you is deleted/);
  assert.match(plain, /we keep a record of the order and payment — what, how much and when — without your name/);
  assert.match(plain, /for as long as accounting, tax and dispute rules require/);
  assert.match(plain, /if you leave with credit still on your account we keep your Instagram handle so we can settle it with you/);
  assert.match(plain, /a blocked handle is kept so the block continues to work/);
  // it names the same blockers the code enforces
  const code = read('server/src/lib/delete-account.js');
  for (const kind of ['owed', 'pending_payment', 'parcel']) assert.match(code, new RegExp(`kind: '${kind}'`), `the code still blocks on ${kind}`);
  assert.match(plain, /We can't do it while you still owe money, a payment is waiting to be checked, or a parcel is on its way/);
  // and the paths it points people to exist
  assert.match(read('public/site/my-settings.js'), /Delete my account/); assert.match(read('public/site/my.js'), /'My settings'/);
  assert.match(plain, /My orders → My settings/); assert.match(plain, /Delivery details/);
});

test('"TWO COOKIES" is true: the server sets only the sign-in cookie and the this-browser-made-a-claim cookie', () => {
  const names = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, 'server/src'), { recursive: true })) {
    if (!String(f).endsWith('.js')) continue;
    for (const m of read(`server/src/${f}`).matchAll(/res\.cookie\(\s*([A-Za-z_.']+)/g)) names.add(m[1]);
  }
  assert.deepEqual([...names].sort(), ['COOKIE', 'DEVICE_COOKIE'], `cookies set: ${[...names]}`);
  assert.match(plain, /Two small cookies, both needed for the site to work: one keeps you signed in, and one remembers which browser made a claim/);
});

test('"NOTHING LOADED FROM OTHER COMPANIES\' SERVERS" is true for the pages people order on (shop, My orders, claim-your-orders, this notice, their styles and scripts)', () => {
  const files = ['public/index.html', 'public/my.html', 'public/claim.html', 'public/privacy.html', 'public/style.css', ...fs.readdirSync(path.join(ROOT, 'public/site')).map((f) => `public/site/${f}`)];
  for (const f of files) {
    const hits = [...read(f).matchAll(/(?:src|href|url\(|@import)\s*=?\s*["']?\s*(https?:)?\/\/[^"')\s]+/g)].map((m) => m[0]);
    assert.deepEqual(hits, [], `${f} reaches out to another server`);
  }
  assert.match(plain, /the pages you order on don't load anything from other companies' servers/);
});

test('"SIGN-IN SECURITY DETAILS" is true: sessions record the browser type and IP address', async () => {
  const cols = (await app.q("SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions'")).map((x) => x.c);
  assert.ok(cols.includes('user_agent') && cols.includes('ip'));
  assert.match(plain, /we record the type of device or browser and the IP address with your session/);
});

test('THE CONTACT EMAIL: shown when configured (and only if it is a plain email address); otherwise the notice says to get in touch the usual way', async () => {
  assert.deepEqual(await (await fetch(`${app.base}/api/site-info`)).json(), { contactEmail: null });
  const withContact = await startApp({ CONTACT_EMAIL: '  hello@example.co.uk ' });
  try {
    assert.deepEqual(await (await fetch(`${withContact.base}/api/site-info`)).json(), { contactEmail: 'hello@example.co.uk' }, 'trimmed');
  } finally { await withContact.stop(); }
  for (const bad of ['<script>x</script>@a.com', 'javascript:alert(1)', 'two words@example.com', 'no-at-sign', 'a@b', 'a@b.c<img>']) {
    const a = await startApp({ CONTACT_EMAIL: bad });
    try { assert.deepEqual(await (await fetch(`${a.base}/api/site-info`)).json(), { contactEmail: null }, `ignored: ${bad}`); } finally { await a.stop(); }
  }
  assert.match(plain, /get in touch with the GOM the same way you normally order/);
});
