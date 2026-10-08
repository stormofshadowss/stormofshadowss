import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b) => app.api(m, p, b, admin);
const u = (x = 'mv') => `${x}${++N}`;
const text = (p, sel = '#tabBody') => p.text(p.q(sel));
const btn = (p, re, root) => p.qa('button', root).find((b) => re.test(p.text(b)));
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
async function order(price = 10) { const t = u('Move GO '); const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: t })).json.id; return { t, item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: `${t} item`, price })).json.id }; }
async function holder(item, handle = u('from')) { await claimAndSecure(app, admin, handle, item); return handle; }
// opens Claims, narrows to one order, selects all its confirmed claims, and opens the move panel
async function open(orderTitle, filterText = `${orderTitle} item`) {
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims'));
  await p.type(p.q('[data-filter="q"]'), filterText); await p.settle();
  await p.click(btn(p, /^Select all \d+ confirmed claims? here/));
  await p.click(btn(p, /^Move to another person/));
  return p;
}
const check = async (p, handle) => { p.q('#moveHandle').value = handle; await p.click(btn(p, /^Check$/)); };

test('the selection bar offers "Move to another person…"; the panel explains itself and can be cancelled', async () => {
  const { t, item } = await order(); await holder(item);
  const p = await open(t);
  const panel = text(p, '#movePanel');
  assert.match(panel, /Move the 1 selected claim to another person.*Everything goes with them — costs, stage, dates and the money already paid.*can't be moved safely stays where it is/s);
  assert.ok(p.q('#moveHandle'));
  await p.click(btn(p, /^Cancel$/, p.q('#movePanel')));
  assert.equal(p.q('#movePanel'), null); assert.ok(p.q('#bulkBar'), 'the selection itself is still there');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('checking a signed-up person: shows who they are, what moves and the money; asking first; then it moves and the screen follows', async () => {
  const { t, item } = await order(10);
  const a = u('from'), b = u('to');
  const cookie = await joinerSession(app, `${b}@x.com`, b);
  await holder(item, a); await holder(item, a);
  const p = await open(t);
  await check(p, `@${b}`);
  assert.match(text(p, '[data-move-preview]'), new RegExp(`@${b} is already signed up.*2 can move.*£0\\.00 already paid goes with them; £20\\.00 is still owed`, 's'));
  await p.click(btn(p, /^Move 2 claims to/));
  assert.match(p.text(modal(p)), new RegExp(`Move 2 claims to @${b}\\?.*appear in @${b}'s My orders.*£0\\.00 already paid and £20\\.00 still owed`, 's'));
  await press(p, 'Not yet');
  assert.equal((await claimsOf(b)).length, 0, 'saying "not yet" moved nothing');
  await p.click(btn(p, /^Move 2 claims to/)); await press(p, 'Move them');
  assert.match(toast(p), new RegExp(`Moved 2 claims to @${b}`));
  assert.equal((await claimsOf(b)).length, 2); assert.equal((await claimsOf(a)).length, 0);
  assert.equal(p.q('#bulkBar'), null, 'the selection is cleared');
  assert.equal(p.q('#movePanel'), null);
  const mine = (await app.api('GET', '/api/my/summary', undefined, cookie)).json;
  assert.equal(mine.owed.total, 20, 'and the signed-up person sees it straight away');
  p.close();
});

test('a handle that is not on the site is explained; moving needs the "create" tick; ticking it creates them', async () => {
  const { t, item } = await order(); await holder(item);
  const nobody = u('nobody');
  const p = await open(t);
  await check(p, nobody);
  assert.match(text(p, '[data-move-preview]'), new RegExp(`@${nobody} isn't on the site yet.*Create @${nobody} and move the claims there`, 's'));
  assert.equal(btn(p, /^Move 1 claim to/).disabled, true, 'not until you say create it');
  await p.click(p.q('#moveCreate'));
  assert.equal(btn(p, /^Move 1 claim to/).disabled, false);
  await p.click(btn(p, /^Move 1 claim to/));
  assert.match(p.text(modal(p)), new RegExp(`@${nobody} will be created`));
  await press(p, 'Move them');
  assert.equal((await claimsOf(nobody)).length, 1);
  p.close();
});

test('claims that cannot be moved are listed with the reason; only the movable ones are counted; nothing movable disables the button', async () => {
  const { t, item } = await order();
  const a = u('from'), b = u('to');
  await holder(item, a); await joinerSession(app, `${b}@x.com`, b);
  await holder(item, b);                                                                      // one claim already belongs to the target
  const p = await open(t);
  await check(p, b);
  const pv = text(p, '[data-move-preview]');
  assert.match(pv, /1 can move · 1 can't/);
  assert.match(text(p, '[data-move-blocked]'), new RegExp(`already belongs to @${b}`));
  p.close();
  // a selection where NOTHING can move
  const { t: t2, item: item2 } = await order(); const only = await holder(item2, u('own'));
  const q = await open(t2);
  await check(q, only);
  assert.match(text(q, '[data-move-preview]'), /0 can move · 1 can't/);
  assert.equal(btn(q, /^Move 0 claims to/).disabled, true);
  q.close();
});

test('a check goes out of date when the selection changes, mistakes in the handle are explained, and the panel keeps what you typed', async () => {
  const { t, item } = await order(); await holder(item); await holder(item);
  const p = await open(t);
  await check(p, 'not a handle!');
  assert.match(text(p, '#movePanel'), /isn't a valid Instagram handle/);
  assert.equal(p.q('#moveHandle').value, 'not a handle!', 'what you typed is still there');
  p.q('#moveHandle').value = ''; await p.click(btn(p, /^Check$/));
  assert.match(text(p, '#movePanel'), /Enter the handle to move them to/);
  const who = u('to'); await app.api('POST', '/api/claims', { handle: who, lines: [{ itemId: item }] });
  await check(p, who);
  assert.ok(p.q('[data-move-preview]'));
  await p.click(btn(p, /^Unselect all/));                                                      // the selection changes...
  assert.equal(p.q('#bulkBar'), null);
  p.close();
});

test('claim and person names with HTML are shown as text in the preview', async () => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('X GO ') })).json;
  const title = (await app.q('SELECT title FROM group_orders WHERE id = ?', [go.id]))[0].title;
  const item = (await api('POST', `/api/admin/orders/${go.id}/items`, { type: 'normal', title: `${title} <img src=x onerror="window.pwned=1"> item`, price: 5 })).json.id;
  const h = await holder(item);
  const p = await open(title, title);
  await check(p, h);
  assert.equal(p.q('#movePanel img'), null); assert.equal(p.window.pwned, undefined);
  assert.match(text(p, '[data-move-blocked]'), /<img src=x onerror="window\.pwned=1"> item/);
  p.close();
});
