import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, seed } from './helpers.js';

// The store look: a group's TYPE (drives the home page's filter chips), orders carry when they were created ("New"), every page loads the light/dark script first,
// and the colours are readable — checked with numbers, in BOTH themes, for every text/background pairing the stylesheet defines.
let app, admin, w;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);

test('A GROUP\'S TYPE: set and cleared by the GOM, shown to everyone on the public groups list, only the four known types allowed', async () => {
  const id = (await api('POST', '/api/admin/groups', { name: 'Type Test Band', kind: 'girl group' })).json.id;
  const pub = async () => (await fetch(`${app.base}/api/groups`).then((r) => r.json())).groups.find((g) => g.id === id);
  assert.equal((await pub()).kind, 'girl group', 'set when the group is created');
  for (const k of ['boy band', 'solo', 'duo', 'girl group']) { assert.equal((await api('PATCH', `/api/admin/groups/${id}`, { kind: k })).status, 200); assert.equal((await pub()).kind, k); }
  assert.equal((await api('GET', '/api/admin/groups')).json.groups.find((g) => g.id === id).kind, 'girl group');
  assert.equal((await api('PATCH', `/api/admin/groups/${id}`, { kind: null })).status, 200); assert.equal((await pub()).kind, null, 'cleared');
  assert.equal((await api('PATCH', `/api/admin/groups/${id}`, { kind: 'orchestra' })).status, 400); assert.equal((await api('PATCH', `/api/admin/groups/${id}`, {})).status, 400);
  assert.equal((await api('POST', '/api/admin/groups', { name: 'Bad Type', kind: 'nope' })).status, 400);
  assert.equal((await api('PATCH', '/api/admin/groups/999999', { kind: 'solo' })).status, 404);
  const j = await app.login('someone@x.com'); assert.equal((await api('PATCH', `/api/admin/groups/${id}`, { kind: 'solo' }, j)).status, 403); assert.equal((await app.api('PATCH', `/api/admin/groups/${id}`, { kind: 'solo' })).status, 401);
  assert.equal((await pub()).kind, null, 'nothing changed by those');
});

test('EVERY ORDER SAYS WHEN IT WAS CREATED (for the "New" section) — as a date, in the public list too', async () => {
  const id = (await api('POST', '/api/admin/orders', { groupId: w.group, title: 'Created-at order' })).json.id;
  const o = (await fetch(`${app.base}/api/orders`).then((r) => r.json())).orders.find((x) => x.id === id);
  assert.match(o.createdAt, /^\d{4}-\d\d-\d\dT/); assert.ok(Math.abs(Date.now() - new Date(o.createdAt).getTime()) < 60000, 'created just now');
  assert.ok((await api('GET', '/api/admin/orders')).json.orders.find((x) => x.id === id).createdAt);
});

const read = (f) => fs.readFileSync(new URL(`../../public/${f}`, import.meta.url), 'utf8');
test('EVERY PAGE LOADS THE LIGHT/DARK SCRIPT BEFORE ANYTHING PAINTS, and sets the phone\'s browser-bar colour', () => {
  for (const f of ['index.html', 'my.html', 'claim.html', 'privacy.html', 'admin.html']) {
    const html = read(f), head = html.slice(0, html.indexOf('</head>'));
    assert.match(head, /<script src="\/site\/theme\.js"><\/script>/, f); assert.match(head, /<meta name="theme-color" content="#f1eefc">/, f);
    assert.ok(head.indexOf('/style.css') < head.indexOf('/site/theme.js'), `${f}: after the stylesheet link, before the body`);
    assert.doesNotMatch(head, /<script(?![^>]*src=)[^>]*>/, `${f}: no inline script (the page's security policy forbids it)`);
  }
});
test('the theme script is served as JavaScript from the site itself', async () => {
  const r = await fetch(`${app.base}/site/theme.js`); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
});

// ── contrast, in numbers (WCAG): ordinary text needs 4.5 : 1 against its background ──
const css = read('style.css');
const block = (sel) => { const i = css.indexOf(sel); return css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i)); };
const full = (h) => (h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h);                      // #fff → #ffffff
const tokens = (b) => Object.fromEntries([...b.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)].map((m) => [m[1], full(m[2])]));
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const light = tokens(block(':root {'));                                                                  // Soft Pop is the default
const themes = { light, dark: { ...light, ...tokens(block(':root[data-theme="dark"]')) } };
const PAIRS = [['ink', 'paper'], ['ink', 'surface'], ['ink', 'surface-2'], ['soft', 'paper'], ['soft', 'surface'], ['soft', 'surface-2'], ['accent-ink', 'paper'], ['accent-ink', 'surface'], ['accent-ink', 'surface-2'], ['accent-ink', 'accent-soft'],
  ['ok-ink', 'ok-bg'], ['warn-ink', 'warn-bg'], ['err-ink', 'err-bg'], ['ink', 'accent-soft']];
for (const [name, t] of Object.entries(themes)) {
  test(`READABLE: every text/background pairing in the ${name.toUpperCase()} theme meets 4.5 : 1`, () => {
    for (const [fg, bg] of PAIRS) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name}: ${fg} ${t[fg]} on ${bg} ${t[bg]} is only ${ratio(t[fg], t[bg]).toFixed(2)} : 1`);
    assert.ok(ratio('#ffffff', t.accent) >= 4.5, `${name}: white button text on the accent colour is only ${ratio('#ffffff', t.accent).toFixed(2)} : 1`);
    assert.ok(ratio('#ffffff', t['flag-new']) >= 4.5, `${name}: white text on the "New" flag is only ${ratio('#ffffff', t['flag-new']).toFixed(2)} : 1`);       // ("Closes in…" flags use the accent colour)
    assert.ok(Object.keys(t).length >= 14, 'the tokens were found');
  });
}
test('the dark look overrides every colour token the light (default) look defines, so nothing is left light-on-light in dark mode', () => {
  const base = tokens(block(':root {')), dark = tokens(block(':root[data-theme="dark"]'));
  for (const k of ['ink', 'soft', 'paper', 'surface', 'surface-2', 'line', 'accent', 'accent-ink', 'accent-soft', 'ok-bg', 'ok-ink', 'ok-line', 'warn-bg', 'warn-ink', 'warn-line', 'err-bg', 'err-ink', 'err-line']) { assert.ok(k in base, `${k} missing from the default look`); assert.ok(k in dark, `${k} not overridden for dark`); }
  for (const k of Object.keys(dark)) if (k !== 'page') assert.ok(k in base, `${k} is defined for dark but not for the default look`);        // ('page' is a gradient in the default look, a plain colour in dark)
});
