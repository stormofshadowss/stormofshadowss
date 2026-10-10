import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage, gomPage, modal, press, toast } from './ui.helpers.js';

const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public/style.css'), 'utf8');
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ld') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p, sel = '#view') => p.text(p.q(sel));
const go = async (p, hash) => { p.window.location.hash = hash; await sleep(30); await p.settle(); };
const btn = (p, re, root) => p.qa('button', root).find((b) => re.test(p.text(b)));
const order = async (extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Layout GO '), ...extra })).json.id;
const item = async (go_, body = {}) => (await api('POST', `/api/admin/orders/${go_}/items`, { type: 'normal', title: u('Thing '), price: 1, ...body })).json.id;
const shopPage = async (go_) => { const p = await openPage(app, '/'); await go(p, `#/order/${go_}`); return p; };
const MEMBERS = ['Bang Chan', 'Lee Know', 'Changbin', 'Hyunjin', 'Han', 'Felix', 'Seungmin', 'I.N'];

// ───────────── how items look ─────────────
test('MEMBER OPTIONS ARE LITTLE BOXES in a grid (not a list): one box per member with name, price and its own + / − — and picking one highlights it', async () => {
  const go_ = await order(); const it = await item(go_, { type: 'independent', members: MEMBERS });
  const p = await shopPage(go_);
  const boxes = () => p.qa('.opts .opt');
  assert.equal(boxes().length, 8, 'a box for every member');
  assert.equal(p.qa('#view .itemrow').length, 0, 'and no list rows');
  assert.match(p.text(boxes()[0]), /^Bang Chan £1\.00/);
  assert.ok(boxes().every((b) => b.querySelector('[data-act="inc"]') && b.querySelector('[data-act="dec"]')), 'each box has its own buttons');
  assert.equal(p.qa('.opt.on').length, 0);
  await p.click(p.q(`[data-act="inc"][data-item="${it}"][data-member="Han"]`));
  assert.deepEqual(p.qa('.opt.on').map((b) => p.q('.opt-name', b).textContent), ['Han'], 'only the one you picked is highlighted');
  await p.click(p.q(`[data-act="inc"][data-item="${it}"][data-member="Han"]`));
  assert.match(p.text(p.q('.opt.on')), /Han £1\.00.*2/s, 'and it counts up');
  await p.click(p.q(`[data-act="dec"][data-item="${it}"][data-member="Han"]`)); await p.click(p.q(`[data-act="dec"][data-item="${it}"][data-member="Han"]`));
  assert.equal(p.qa('.opt.on').length, 0, 'back to none: no highlight');
  assert.deepEqual(p.errors, []);
  p.close();
});

test('SIZES ARE HORIZONTAL PILLS in a row: one pill per size with its own buttons, highlighted when picked', async () => {
  const go_ = await order(); const it = await item(go_, { type: 'size', variants: ['M', 'L', 'XL'] });
  const p = await shopPage(go_);
  const pills = () => p.qa('.pills .sizepill');
  assert.deepEqual(pills().map((x) => p.q('.sz', x).textContent), ['Size M', 'Size L', 'Size XL']);
  assert.equal(p.qa('#view .itemrow').length, 0);
  assert.ok(pills().every((x) => x.querySelector('[data-act="inc"]')));
  await p.click(p.q(`[data-act="inc"][data-item="${it}"][data-variant="L"]`));
  assert.deepEqual(p.qa('.sizepill.on').map((x) => p.q('.sz', x).textContent), ['Size L']);
  p.close();
});

test('member SET parts are boxes too, showing each part\'s price and how many are claimed; the "whole set" button and notes are unchanged', async () => {
  const go_ = await order(); const set = await item(go_, { type: 'set', price: 3, members: ['A', 'B', { name: 'Diary', price: 2 }] });
  await app.api('POST', '/api/claims', { handle: u('c'), lines: [{ itemId: set, parts: [{ member: 'Diary', qty: 1 }] }] });
  const p = await shopPage(go_);
  assert.equal(p.qa('.opts .opt').length, 3);
  assert.match(p.text(p.q('.opt[data-opt="Diary"]')), /Diary £2\.00 · 1 claimed/);
  assert.match(p.text(p.q('.opt[data-opt="A"]')), /A £3\.00 · 0 claimed/);
  assert.ok(btn(p, /^Claim the whole set/));
  await p.click(p.q(`[data-act="inc"][data-item="${set}"][data-member="A"]`));
  assert.ok(p.q('.opt[data-opt="A"].on')); assert.match(text(p), /Selected: A — £3\.00/);
  p.close();
});

test('a closed order still shows the boxes (so you can see what was on offer) but with no buttons; and names with HTML are shown as text', async () => {
  const go_ = await order({ status: 'closed' }); await item(go_, { type: 'independent', members: ['<img src=x onerror="window.pwned=1">', 'Han'] });
  const p = await shopPage(go_);
  assert.equal(p.qa('.opts .opt').length, 2); assert.equal(p.qa('.opts .opt [data-act]').length, 0, 'nothing to press');
  assert.equal(p.q('#view img'), null); assert.equal(p.window.pwned, undefined);
  assert.match(text(p), /<img src=x onerror="window\.pwned=1">/);
  p.close();
});

test('the styles that make it look right are in place (box grid, pills, highlight) — and it works on a phone-width screen', () => {
  const rule = (sel) => (CSS.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) || [])[1] || '';
  assert.match(rule('.opts'), /display:grid/); assert.match(rule('.opts'), /grid-template-columns:repeat\(auto-fill, minmax\(\d+px, 1fr\)\)/);
  assert.match(rule('.opt'), /border-radius:14px/); assert.match(rule('.opt'), /border:1\.5px solid/);
  assert.match(rule('.pills'), /display:flex/); assert.match(rule('.pills'), /flex-wrap:wrap/);
  assert.match(rule('.sizepill'), /border-radius:999px/);
  assert.match(CSS, /\.opt\.on, \.sizepill\.on \{[^}]*border-color:var\(--accent(-ink)?\)/, 'a picked box or pill is highlighted in the accent colour');
  const min = Number(/minmax\((\d+)px/.exec(rule('.opts'))[1]);
  assert.ok(min <= 160, `boxes can fit two across on a 360px phone (min ${min}px)`);
});

// ───────────── the GOM page ─────────────
test('the admin page links to the real site, in a new tab, from the top — so you can check it is working', async () => {
  const p = await gomPage(app, admin);
  const shop = p.q('a[data-view-site]');
  assert.deepEqual([shop.getAttribute('href'), shop.getAttribute('target'), shop.getAttribute('rel'), p.text(shop)], ['/', '_blank', 'noopener', 'View the shop ↗']);
  const mine = p.qa('.top-links a').find((a) => /My orders/.test(p.text(a)));
  assert.deepEqual([mine.getAttribute('href'), mine.getAttribute('target')], ['/my.html', '_blank']);
  p.close();
});

// ───────────── deleting ─────────────
const openOrders = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Group Orders')); return p; };
const row = (p, sel, label) => p.qa(`${sel} tr`).find((r) => p.text(r).includes(label));

test('DELETING AN ITEM: asks what will go, does nothing if you say no, deletes if you say yes, and the row disappears', async () => {
  const go_ = await order(); const it = await item(go_, { title: 'Removable thing' }); const keep = await item(go_, { title: 'Stays put' });
  await app.api('POST', '/api/claims', { handle: u('a'), lines: [{ itemId: it }] }); await app.api('POST', '/api/claims', { handle: u('b'), lines: [{ itemId: it }] });
  const p = await openOrders();
  await p.click(p.q(`[data-act="open-items"][data-id="${go_}"]`));
  await p.click(btn(p, /^Delete$/, row(p, '#itemsPanel', 'Removable thing')));
  assert.match(p.text(modal(p)), /Delete the item “Removable thing”\?.*This also removes 2 unconfirmed requests from 2 people\..*This can't be undone\./s);
  await press(p, 'Keep it');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM items WHERE id = ?', [it]))[0].n, 1, 'saying no deleted nothing');
  await p.click(btn(p, /^Delete$/, row(p, '#itemsPanel', 'Removable thing'))); await press(p, 'Delete it');
  assert.match(toast(p), /Deleted “Removable thing”/);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM items WHERE id = ?', [it]))[0].n, 0);
  assert.equal(row(p, '#itemsPanel', 'Removable thing'), undefined); assert.ok(row(p, '#itemsPanel', 'Stays put'));
  assert.ok(keep);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('an item nothing depends on says so; an item with a confirmed claim EXPLAINS why it cannot go and deletes nothing', async () => {
  const go_ = await order(); const bare = await item(go_, { title: 'Bare item' }), real = await item(go_, { title: 'Real order item' });
  const h = u('rl'); await joinerSession(app, `${h}@x.com`, h); await claimAndSecure(app, admin, h, real);
  const p = await openOrders();
  await p.click(p.q(`[data-act="open-items"][data-id="${go_}"]`));
  await p.click(btn(p, /^Delete$/, row(p, '#itemsPanel', 'Bare item')));
  assert.match(p.text(modal(p)), /Delete the item “Bare item”\?.*Nothing else depends on it\./s);
  await press(p, 'Keep it');
  await p.click(btn(p, /^Delete$/, row(p, '#itemsPanel', 'Real order item')));
  const t = p.text(modal(p));
  assert.match(t, /“Real order item” can't be deleted yet\..*• 1 confirmed claim \(1 person\) — those are real orders\. Cancel them first on the Claims tab, then delete\./s);
  assert.equal(p.qa('.ui-modal button').length, 1, 'just an OK — there is nothing to confirm');
  await press(p, 'OK');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM items WHERE id IN (?, ?)', [bare, real]))[0].n, 2);
  p.close();
});

test('DELETING A GROUP ORDER: the confirmation counts its items and requests; afterwards it is gone from the list and its items panel closes', async () => {
  const go_ = await order({ title: 'Doomed order' }); const keepGo = await order({ title: 'Safe order' });
  const [i1, i2] = [await item(go_), await item(go_)];
  await app.api('POST', '/api/claims', { handle: u('a'), lines: [{ itemId: i1 }] });
  const p = await openOrders();
  await p.click(p.q(`[data-act="open-items"][data-id="${go_}"]`));
  assert.ok(p.q('#itemsPanel'));
  await p.click(p.q(`[data-act="delete-order"][data-id="${go_}"]`));
  assert.match(p.text(modal(p)), /Delete the group order “Doomed order”\?.*This also removes 2 items, 1 unconfirmed request from 1 person\..*This can't be undone\./s);
  await press(p, 'Delete it');
  assert.match(toast(p), /Deleted “Doomed order”/);
  assert.equal(row(p, '#tabBody', 'Doomed order'), undefined); assert.ok(row(p, '#tabBody', 'Safe order'));
  assert.equal(p.q('#itemsPanel'), null, 'the panel for the deleted order closed');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM group_orders WHERE id = ?', [go_]))[0].n, 0);
  assert.ok(i2 && keepGo);
  p.close();
});

test('a group order with a real order in it cannot be deleted from the list either, and says why', async () => {
  const go_ = await order({ title: 'Has real orders' }); const it = await item(go_);
  const h = u('rl'); await joinerSession(app, `${h}@x.com`, h); await claimAndSecure(app, admin, h, it);
  const p = await openOrders();
  await p.click(p.q(`[data-act="delete-order"][data-id="${go_}"]`));
  assert.match(p.text(modal(p)), /“Has real orders” can't be deleted yet\..*1 confirmed claim/s);
  await press(p, 'OK');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM group_orders WHERE id = ?', [go_]))[0].n, 1);
  p.close();
});
