import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { gomPage } from './ui.helpers.js';

// GOM → People → "Look up a person": what they owe and why, and a toggle to their dashboard exactly as they see it (read-only).
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); await app.q("INSERT IGNORE INTO payment_methods (method, account_info) VALUES ('PayPal', 'pay@example.com')"); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'pl') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async (title = u('Look GO '), deadline = '2099-01-01') => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam', paymentDeadline: deadline })).json.id;
const item = async (go, price, title = u('Thing ')) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price })).json.id;
async function person(...handles) { const email = `${u('p')}@x.com`; const cookie = await joinerSession(app, email, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200); return { cookie, handles, email, id: (await app.q('SELECT account_id AS id FROM joiners WHERE instagram_handle = ?', [handles[0]]))[0].id }; }
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'People')); await sleep(150); await p.settle(); return p; };
const lookup = async (p, handle) => { const i = p.q('#dueSearch'); i.value = handle; i.dispatchEvent(new p.window.Event('input', { bubbles: true })); await p.submit(p.q('form[data-form="due-lookup"]')); await sleep(250); await p.settle(); };
const result = (p) => p.q('#lookupCard');

test('THE CARD IS AT THE TOP OF PEOPLE; typing suggests handles (including people with no claims yet); the cursor is never lost', async () => {
  const h = u('suggest'); await app.q('INSERT INTO joiners (instagram_handle) VALUES (?)', [h]); const p = await open();
  assert.ok(p.q('#lookupCard h2') && p.text(p.q('#lookupCard h2')) === 'Look up a person'); assert.equal(p.text(p.q('#lookupCard').previousElementSibling), 'People', 'directly under the People heading, above the other cards');
  const box = p.q('#dueSearch'); box.value = h.slice(0, -1); box.dispatchEvent(new p.window.Event('input', { bubbles: true })); await sleep(450); await p.settle();
  assert.ok(p.qa('#dueHandles option').some((o) => o.value === h), 'suggested as you type'); assert.equal(p.q('#dueSearch'), box, 'the same box — the cursor stays'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('LOOKING SOMEONE UP SHOWS WHAT THEY OWE AND WHY: the plain-words explanation, then each item with its group order, owed, paid and due date (overdue flagged) and a breakdown only when it is more than one thing', async () => {
  const p0 = await person(u('who')); const h = p0.handles[0]; const late = await goOrder('Old Fansign', '2000-01-01'), fine = await goOrder('New Pop-up', '2099-03-04');
  const [c1] = await claimAndSecure(app, admin, h, await item(late, 10, 'Late album')); await claimAndSecure(app, admin, h, await item(fine, 5, 'Fresh keyring')); await api('PATCH', `/api/admin/claims/${c1}`, { costs: { ems: { cost: 4, dueDate: '2000-01-01' } } });          // an EMS fee whose OWN date has passed too (a fee added today is not overdue — see fee-due-dates.test.js)
  const p = await open(); await lookup(p, `@${h.toUpperCase()}`); const card = result(p);
  assert.equal(p.text(p.q('[data-due-handle]', card)), `@${h}`); assert.match(p.text(card), new RegExp(p0.email.replace('.', '\\.')));
  const lines = p.qa('[data-due-explanation] li', card).map((l) => p.text(l)); assert.equal(lines[0], `@${h} owes £19.00 now, across 2 items on 2 group orders.`); assert.ok(lines.some((l) => /^£14\.00 is overdue on “Old Fansign”: it was due 01\/01\/2000 \(\d+ days ago\)\.$/.test(l)));
  const rows = p.qa('[data-due-items] tbody tr', card).map((r) => [...r.children].map((c) => p.text(c))); const late_ = rows.find((r) => r[0] === 'Late album'), fresh = rows.find((r) => r[0] === 'Fresh keyring');
  assert.match(late_[2], /^£14\.00\s*item £10\.00 · EMS £4\.00$/, 'owed with the breakdown'); assert.match(late_[4], /^01\/01\/2000\s*overdue \d+ days$/); assert.deepEqual([fresh[2], fresh[4]], ['£5.00', '04/03/2099'], 'one thing only: no breakdown, and not overdue'); assert.equal(p.q('[data-due-handles]', card), null, 'one handle: no per-handle table'); p.close();
});

test('A PERSON WITH SEVERAL HANDLES: all their handles are named, there is a per-handle table, and each item says which handle', async () => {
  const p0 = await person(u('ha'), u('hb')); const [a, b] = p0.handles; const g = await goOrder(); await claimAndSecure(app, admin, a, await item(g, 10, 'A item')); await claimAndSecure(app, admin, b, await item(g, 6, 'B item'));
  const p = await open(); await lookup(p, b); const card = result(p); assert.match(p.text(card), new RegExp(`@${a}\\s*·\\s*@${b}`)); assert.equal(p.qa('[data-due-handles] tbody tr', card).length, 2); assert.match(p.text(p.q('[data-due-explanation] li', card)), /^Across their handles they owe £16\.00 now/);
  assert.ok(p.byText('[data-due-items] th', 'Handle'), 'an items column for the handle'); const row = p.qa('[data-due-items] tbody tr', card).find((r) => p.text(r).includes('B item')); assert.match(p.text(row.children[1]), new RegExp(`^@${b}$`)); p.close();
});

test('THE TOGGLE: "Their dashboard" shows their real dashboard (read-only) in the page; "What they owe" brings the explanation back; the buttons say which is showing', async () => {
  const p0 = await person(u('tog')); await claimAndSecure(app, admin, p0.handles[0], await item(await goOrder(), 9)); const p = await open(); await lookup(p, p0.handles[0]); const card = result(p);
  assert.equal(p.q('[data-act="due-view"][data-view="owe"]', card).getAttribute('aria-pressed'), 'true'); assert.equal(p.q('[data-due-frame]', card), null);
  await p.click(p.q('[data-act="due-view"][data-view="dash"]', result(p))); const frame = p.q('[data-due-frame]', result(p)); assert.ok(frame, 'the dashboard appears'); assert.equal(frame.getAttribute('src'), `/my.html?viewAs=${p0.id}`); assert.match(frame.title, /dashboard, read-only/);
  assert.equal(p.q('[data-act="due-view"][data-view="dash"]', result(p)).getAttribute('aria-pressed'), 'true'); assert.match(p.text(result(p)), /Exactly what they see, and read-only — nothing you press there can change anything\. Open it in its own tab/); assert.equal(p.q('[data-due-explanation]', result(p)), null, 'the explanation is swapped out');
  assert.match(p.q('a[target="_blank"]', result(p)).getAttribute('href'), new RegExp(`/my\\.html\\?viewAs=${p0.id}$`)); assert.equal(p.q('a[target="_blank"]', result(p)).rel, 'noopener');
  await p.click(p.q('[data-act="due-view"][data-view="owe"]', result(p))); assert.ok(p.q('[data-due-explanation]', result(p))); assert.equal(p.q('[data-due-frame]', result(p)), null); p.close();
});

test('SOMEONE WHO HAS NEVER SIGNED IN has the explanation but no dashboard: the button is disabled and says why', async () => {
  const h = u('imported'); await app.q('INSERT INTO joiners (instagram_handle) VALUES (?)', [h]); await api('POST', '/api/admin/claims/add', { handle: h, status: 'confirmed', lines: [{ itemId: await item(await goOrder(), 11) }] });
  const p = await open(); await lookup(p, h); const dash = p.q('[data-act="due-view"][data-view="dash"]', result(p)); assert.equal(dash.disabled, true); assert.match(dash.title, /haven't signed in yet, so there is no dashboard to show/); assert.match(p.text(result(p)), /not signed in yet/);
  assert.ok(p.qa('[data-due-explanation] li', result(p)).some((l) => /haven't signed in yet/.test(p.text(l)))); await p.click(dash); assert.equal(p.q('[data-due-frame]', result(p)), null, 'pressing it does nothing'); p.close();
});

test('UNKNOWN HANDLE AND EMPTY SEARCH say so plainly and clear any earlier result', async () => {
  const p0 = await person(u('known')); const p = await open(); await lookup(p, p0.handles[0]); assert.ok(p.q('[data-due-explanation]', result(p)));
  await lookup(p, 'nobody-with-this-handle'); assert.match(p.text(p.q('[data-due-error]', result(p))), /^No one on the site has the handle @nobody-with-this-handle\.$/); assert.equal(p.q('[data-due-explanation]', result(p)), null, 'the old result is gone');
  await lookup(p, '   '); assert.match(p.text(p.q('[data-due-error]', result(p))), /^Enter an Instagram handle\.$/); p.close();
});

test('THE RESULT SURVIVES THE PAGE REDRAWING (other People actions), and everything from the database is shown as text', async () => {
  const p0 = await person(u('esc')); const h = p0.handles[0]; const g = await goOrder('<img src=x onerror="window.pwned=1"> Order'); await claimAndSecure(app, admin, h, await item(g, 9, '<b>Bold</b> item'));
  await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount: 3, reference: '<i>REF</i>' }, p0.cookie);
  const p = await open(); await lookup(p, h); assert.equal(p.q('img[src="x"]'), null); assert.equal(p.window.pwned, undefined); assert.equal(p.q('#lookupCard b'), null); assert.equal(p.q('#lookupCard i'), null);
  assert.match(p.text(result(p)), /<img src=x onerror="window\.pwned=1"> Order/); assert.match(p.text(result(p)), /<b>Bold<\/b> item/); assert.match(p.text(result(p)), /<i>REF<\/i>/);
  const days = p.q('select[data-filter="days"]'); if (days) { days.value = '7'; days.dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(300); await p.settle(); }
  assert.ok(p.q('[data-due-explanation]', result(p)), 'still there after the page redraws'); assert.equal(p.q('#dueSearch').value, h); p.close();
});
