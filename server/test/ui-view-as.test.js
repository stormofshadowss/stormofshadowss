import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage } from './ui.helpers.js';

// The joiner page opened by the GOM as /my.html?viewAs=<account>: the person's real dashboard, with a banner, every request routed through the read-only view-as route, and any change refused.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); await app.q("INSERT IGNORE INTO payment_methods (method, account_info) VALUES ('PayPal', 'pay@example.com')"); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'vw') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function person(...handles) { const email = `${u('p')}@x.com`; const cookie = await joinerSession(app, email, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200); return { cookie, handles, email, id: (await app.q('SELECT account_id AS id FROM joiners WHERE instagram_handle = ?', [handles[0]]))[0].id }; }
const owing = async (h, price, deadline = '2000-01-01', title = u('View GO ')) => { const g = (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam', paymentDeadline: deadline })).json.id; const it = (await api('POST', `/api/admin/orders/${g}/items`, { type: 'normal', title: u('Thing '), price })).json.id; return claimAndSecure(app, admin, h, it); };
const viewAs = async (id, hash = '', cookie = admin) => { const p = await openPage(app, `/my.html?viewAs=${id}${hash}`, { cookies: [cookie] }); const seen = []; await sleep(400); await p.settle(); return { p, seen }; };
const text = (p, sel) => p.text(p.q(sel));

test('THE GOM SEES THE PERSON\'S REAL DASHBOARD: a banner naming them, their totals, and the overdue notice — the same as on their own page', async () => {
  const x = await person(u('seen')); await owing(x.handles[0], 12); const { p } = await viewAs(x.id); const mine = await openPage(app, '/my.html', { cookies: [x.cookie] }); await sleep(400); await mine.settle();
  assert.ok(p.window.document.documentElement.classList.contains('viewas')); assert.match(text(p, '.viewas-banner'), new RegExp(`^Read-only view of ${x.email.replace('.', '\\.')} \\(@${x.handles[0]}\\) — exactly what they see\\. Nothing here can be changed\\.$`));
  assert.equal(text(p, '.tiles'), text(mine, '.tiles'), 'the same figures'); assert.match(text(p, '[data-overdue-notice]'), /£12\.00 is overdue across 1 item/); assert.equal(text(p, '[data-overdue-notice]'), text(mine, '[data-overdue-notice]'), 'including the red notice they get');
  assert.equal(p.q('[data-act="logout"]'), null, 'no Sign out link at all while looking at someone else\'s dashboard'); assert.doesNotMatch(p.text(p.q('#view .muted')), /·\s*$/, 'and no stray separator left behind'); assert.ok(mine.q('[data-act="logout"]'), 'while the person themselves still has it'); assert.deepEqual([p.errors], [[]]); p.close(); mine.close();
});

test('EVERY READ GOES THROUGH THE GOM-ONLY ROUTE (never the raw /api/my, which would show the GOM\'s own data); public pages are untouched', async () => {
  const x = await person(u('route')); await owing(x.handles[0], 5, '2099-01-01'); const p = await openPage(app, `/my.html?viewAs=${x.id}`, { cookies: [admin] }); const urls = []; const orig = p.window.fetch; p.window.fetch = (...a) => { urls.push(String(a[0])); return orig(...a); };
  p.window.location.hash = '#/ongoing'; await sleep(300); await p.settle(); p.window.location.hash = '#/pay'; await sleep(300); await p.settle(); p.window.location.hash = '#/'; await sleep(300); await p.settle();
  const mine = urls.filter((u2) => /\/api\/(me|my)(\/|\?|$)/.test(u2)); assert.deepEqual(mine, [], 'no raw /api/me or /api/my request was made after the page opened'); const viewed = urls.filter((u2) => u2.includes(`/api/admin/view-as/${x.id}/`));
  assert.ok(viewed.length > 0 || urls.length === 0, 'reads went through the view-as route'); p.close();
  const p2 = await openPage(app, `/my.html?viewAs=${x.id}`, { cookies: [admin] }); const all = []; const f2 = p2.window.fetch; p2.window.fetch = (...a) => { all.push(String(a[0])); return f2(...a); }; p2.window.location.hash = '#/ongoing'; await sleep(400); await p2.settle();
  assert.ok(all.every((u2) => !/^\/api\/(me|my)(\/|\?|$)/.test(u2)), `no unrouted reads: ${all.join(' ')}`); p2.close();
});

test('NOTHING CAN BE CHANGED: submitting the pay form sends nothing and says so; no payment is created', async () => {
  const x = await person(u('nochange')); await owing(x.handles[0], 15, '2099-01-01'); const before = (await app.q('SELECT COUNT(*) AS n FROM payments'))[0].n; const { p } = await viewAs(x.id, '#/pay'); await sleep(250); await p.settle();
  const f = p.q('form[data-form="pay"]'); assert.ok(f, 'they can see exactly the page the person sees'); const posts = []; const orig = p.window.fetch; p.window.fetch = (...a) => { if (a[1]?.method && a[1].method !== 'GET') posts.push(a[0]); return orig(...a); };
  f.elements.method.value = 'PayPal'; f.elements.reference.value = 'SHOULD-NOT-EXIST'; await p.submit(f); await sleep(300); await p.settle();
  assert.deepEqual(posts, [], 'no change request left the browser'); assert.match(p.text(p.q('[data-msg]', f)), /This is a read-only view — nothing can be changed from here\./); assert.equal((await app.q('SELECT COUNT(*) AS n FROM payments'))[0].n, before); assert.equal((await app.q("SELECT COUNT(*) AS n FROM payments WHERE reference = 'SHOULD-NOT-EXIST'"))[0].n, 0); p.close();
});

test('SEVERAL HANDLES: "All my handles" and the per-handle table show as they do for the person, and the switcher loads each handle (through the read-only route)', async () => {
  const x = await person(u('ha'), u('hb')); const [a, b] = x.handles; await owing(a, 10, '2099-01-01'); await owing(b, 6, '2099-01-01'); const { p } = await viewAs(x.id);
  assert.equal(p.q('#sw').value, 'all'); assert.equal(p.qa('[data-by-handle] tbody tr').length, 2); assert.match(text(p, '.tiles'), /Total to pay£16\.00/); assert.match(text(p, '.viewas-banner'), new RegExp(`@${a}, @${b}`));
  p.q('#sw').value = b; p.q('#sw').dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(400); await p.settle(); assert.match(text(p, '.tiles'), /Total to pay£6\.00/, 'switching handle works (it only changes what is drawn)'); assert.equal(p.q('[data-by-handle]'), null); p.close();
});

test('THEY CAN BROWSE THEIR PAGES (ongoing orders, shipping, delivery details, settings) without errors; forms are visible but cannot be sent', async () => {
  const x = await person(u('browse')); await owing(x.handles[0], 8, '2099-01-01'); await api('PUT', `/api/my/address?handle=${x.handles[0]}`, { fullName: 'Sam Kim', address: '5 Example Road, Leeds LS1 1AA', email: x.email, phone: '07700 900123' }, x.cookie);
  const { p } = await viewAs(x.id); for (const hash of ['#/ongoing', '#/ship', '#/address', '#/settings', '#/completed']) { p.window.location.hash = hash; await sleep(300); await p.settle(); assert.ok(p.text(p.q('#view')).length > 20, `${hash} shows something`); }
  p.window.location.hash = '#/address'; await sleep(250); await p.settle(); assert.equal(p.q('form input[name="fullName"]')?.value, 'Sam Kim', 'their saved delivery details, as they see them'); assert.deepEqual([p.errors], [[]]); p.close();
});

test('ONLY THE GOM CAN USE IT: a signed-in joiner or a signed-out visitor opening ?viewAs=<someone else> sees none of that person\'s money', async () => {
  const x = await person(u('target')), spy = await person(u('spy')); await owing(x.handles[0], 77.77, '2099-01-01');
  const { p } = await viewAs(x.id, '', spy.cookie); assert.doesNotMatch(p.text(p.q('body')), /77\.77/, 'a joiner is refused'); p.close();
  const q = await openPage(app, `/my.html?viewAs=${x.id}`); await sleep(400); await q.settle(); assert.doesNotMatch(q.text(q.q('body')), /77\.77/, 'a visitor is refused'); q.close();
});

test('THE STYLESHEET HIDES SIGN-OUT AND SWITCHES OFF EVERY CONTROL EXCEPT THE ONES THAT ONLY CHANGE WHAT IS DRAWN (handle switcher, folding an order open and shut)', async () => {
  const css = await (await fetch(`${app.base}/style.css`)).text();
  assert.match(css, /\.viewas \[data-act="logout"\] \{ display:none; \}/); assert.match(css, /\.viewas #view button, \.viewas #view input, \.viewas #view select, \.viewas #view textarea \{ pointer-events:none; opacity:\.55; \}/);
  for (const keep of ['#sw', '[data-act="toggle-go"]', '[data-act="open-all-go"]', '[data-act="close-all-go"]']) assert.ok(css.includes(`.viewas #view ${keep}`), `${keep} stays usable`);
  assert.doesNotMatch(css, /\.viewas #view \[data-act="(pay|ship|cancel-ask|received)[^"]*"\][^{]*\{ pointer-events:auto/, 'no action that changes anything is re-enabled');
});
