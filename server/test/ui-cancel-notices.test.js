import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage, toast } from './ui.helpers.js';

// JOINER: a card on the dashboard (My orders) for each group order / item the GOM cancelled (a month, or until "Got it"); the new opt-in email kind on the email settings page.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'cu') => `${x}${++N}`;
const order = async (title = u('Cancel UI GO ')) => ({ id: (await api('POST', '/api/admin/orders', { groupId: w.group, title })).json.id, title });
const item = async (go, title = u('UI item ')) => ({ id: (await api('POST', `/api/admin/orders/${go.id}/items`, { type: 'normal', title, price: 10 })).json.id, title });
const person = async () => { const handle = u('cp'); const cookie = await joinerSession(app, `${handle}@x.com`, handle); return { handle, cookie }; };
const claim = async (p, it) => (await claimAndSecure(app, admin, p.handle, it.id))[0];
const pay = async (p, amount) => { const r = await api('POST', '/api/my/payments', { method: 'PayPal', amount, reference: u('R') }, p.cookie); await api('POST', `/api/admin/payments/${r.json.id}/verify`, {}); };
const cancel = async (what, thing) => assert.equal((await api('POST', `/api/admin/${what}s/${thing.id}/cancel`, { confirm: thing.title })).status, 200);
const page = async (p, hash = '#/') => { const pg = await openPage(app, '/my.html', { cookies: [p.cookie] }); await sleep(300); await pg.settle(); pg.window.location.hash = hash; await sleep(200); await pg.settle(); return pg; };
const card = (pg) => pg.q('[data-cancelled-notices]');
const rows = (pg) => pg.qa('[data-cancelled]', card(pg) || pg.document);

test('THE CARD ON THE DASHBOARD (MY ORDERS): for a cancelled group order — what was cancelled, when, each of their items and what happened to their money, and a "Got it" button', async () => {
  const go = await order('The Cancelled Order'), a = await item(go, 'Paid album'), b = await item(go, 'Unpaid keyring'); const p = await person(); await claim(p, a); await pay(p, 10); await claim(p, b); await cancel('order', go); const pg = await page(p);
  assert.ok(card(pg), 'the card is there'); assert.match(pg.text(pg.q('h2', card(pg))), /^Cancelled — you may want to buy these elsewhere$/); assert.match(pg.text(pg.q('p.sub', card(pg))), /^The GOM had to cancel these, so they won't be coming\. This stays here for 30 days, or until you press “Got it”\.$/);
  assert.equal(rows(pg).length, 1, 'one row for the one group order'); assert.match(pg.text(pg.q('strong', rows(pg)[0])), /^Group order: The Cancelled Order$/); assert.match(pg.text(rows(pg)[0]), /cancelled today/);
  const lines = pg.qa('[data-cancelled-claim]', rows(pg)[0]).map((l) => pg.text(l)); assert.equal(lines.length, 2); assert.ok(lines.some((l) => /Paid album — £10\.00 credited to your account$/.test(l)), lines.join('|')); assert.ok(lines.some((l) => /Unpaid keyring — you hadn't paid anything for it$/.test(l)), lines.join('|'));
  assert.equal(pg.text(pg.q('[data-act="cancel-notice-ok"]', rows(pg)[0])), 'Got it'); assert.ok(pg.byText('h1', 'My orders'), 'on the dashboard (My orders)'); const owe = pg.byText('h2', 'What you owe'); assert.ok(owe, 'the dashboard'); assert.ok(card(pg).compareDocumentPosition(owe) & 4, 'above "What you owe" — seen straight away');
  for (const hash of ['#/ongoing', '#/completed']) { const other = await page(p, hash); assert.equal(card(other), null, `not on ${hash}: the dashboard is where it lives`); other.close(); } assert.deepEqual([pg.errors], [[]]); pg.close();
});

test('A CANCELLED ITEM is named by the item and its group order; several cancellations are separate rows, newest first; a blocked handle\'s money says it wasn\'t credited; an older cancellation (amount unknown) says what is certainly true', async () => {
  const go = await order('Mixed GO'), a = await item(go, 'Cancelled thing'), keep = await item(go, 'Kept thing'); const p = await person(), q = await person(); await claim(p, a); await claim(p, keep); await cancel('item', a); await sleep(30);
  const go2 = await order('Second GO'), b = await item(go2, 'Second thing'); await claim(p, b); await claim(q, b); await pay(q, 10); await app.q('UPDATE joiners SET is_blocked = 1 WHERE instagram_handle = ?', [q.handle]); await cancel('order', go2);
  const pg = await page(p); assert.deepEqual(rows(pg).map((r) => pg.text(pg.q('strong', r))), ['Group order: Second GO', 'Item: Cancelled thing'], 'newest first'); assert.match(pg.text(rows(pg)[1]), /Item: Cancelled thing in Mixed GO · cancelled today/);
  assert.match(pg.text(pg.q('[data-cancelled-claim]', rows(pg)[0])), /Second thing — you hadn't paid anything for it$/); assert.match(pg.text(pg.q('[data-cancelled-claim]', rows(pg)[1])), /Cancelled thing — you hadn't paid anything for it$/);
  const blocked = await page(q); assert.match(blocked.text(blocked.q('[data-cancelled-claim]', rows(blocked)[0])), /Second thing — £10\.00 paid, not credited$/, 'a blocked handle: what they paid is not credited, and it says so'); blocked.close();
  await app.q('UPDATE cancel_notices SET refunded = NULL, forfeited = NULL WHERE item_title = ?', ['Cancelled thing']); const again = await page(p); assert.match(again.text(again.q('[data-cancelled-claim]', rows(again)[1])), /Cancelled thing — if you'd paid anything for it, it was credited to your account$/); pg.close(); again.close();
});

test('"GOT IT" hides that cancellation straight away and for good (the others stay until their own "Got it"); with none left the card disappears; it isn\'t on Completed orders', async () => {
  const go = await order(), go2 = await order(); const a = await item(go, 'One'), b = await item(go2, 'Two'); const p = await person(), q = await person(); await claim(p, a); await claim(p, b); await claim(q, a); await cancel('order', go); await sleep(30); await cancel('order', go2);
  const pg = await page(p); assert.equal(rows(pg).length, 2); const comp = await page(p, '#/completed'); assert.equal(card(comp), null, 'not on the Completed orders page, even while notices are waiting'); comp.close(); const ong = await page(p, '#/ongoing'); assert.equal(card(ong), null, 'nor on Ongoing orders'); ong.close(); const first = rows(pg).find((r) => /Group order: /.test(pg.text(r)) && r.querySelector('[data-act]')); await pg.click(pg.q('[data-act="cancel-notice-ok"]', rows(pg)[0])); await sleep(400); await pg.settle();
  assert.equal(rows(pg).length, 1, 'that one has gone'); assert.ok(first); assert.ok(card(pg), 'the other is still there'); const again = await page(p); assert.equal(rows(again).length, 1, 'and it stays gone after a reload'); await again.click(again.q('[data-act="cancel-notice-ok"]', rows(again)[0])); await sleep(400); await again.settle(); assert.equal(card(again), null, 'none left: no card');
  const done = await page(p, '#/completed'); assert.equal(card(done), null, 'not on the Completed orders page'); const other = await page(q); assert.equal(rows(other).length, 1, 'someone else\'s notice is untouched'); assert.deepEqual([pg.errors, again.errors], [[], []]); pg.close(); again.close(); done.close(); other.close();
});

test('NO CARD when nothing was cancelled, when the cancellation is more than 30 days old (29 days still shows, with the days), and not for someone with no claim on it', async () => {
  const go = await order(), a = await item(go); const p = await person(), q = await person(); await claim(p, a); await cancel('order', go); const none = await page(q); assert.equal(card(none), null, 'no claim on it: no card'); none.close();
  const id = (await app.q('SELECT id FROM cancel_notices WHERE joiner_id IN (SELECT id FROM joiners WHERE instagram_handle = ?)', [p.handle]))[0].id; await app.q('UPDATE cancel_notices SET cancelled_at = NOW(3) - INTERVAL 29 DAY WHERE id = ?', [id]); const old = await page(p); assert.match(old.text(rows(old)[0]), /cancelled 29 days ago/); old.close();
  await app.q('UPDATE cancel_notices SET cancelled_at = NOW(3) - INTERVAL 31 DAY WHERE id = ?', [id]); const gone = await page(p); assert.equal(card(gone), null, 'past 30 days: gone'); gone.close(); await app.q('UPDATE cancel_notices SET cancelled_at = NOW(3) - INTERVAL 1 DAY WHERE id = ?', [id]); const day = await page(p); assert.match(day.text(rows(day)[0]), /cancelled 1 day ago/); day.close();
});

test('THE EMAIL SETTINGS: the new kind is listed, UNTICKED by default (the others are ticked), and ticking it saves — it is opt-in', async () => {
  const p = await person(); const pg = await page(p, '#/notifications'); const box = () => pg.q('input[data-event="orderCancelled"]'); assert.ok(box(), 'listed'); assert.match(pg.text(box().closest('label')), /A group order or item I claimed is cancelled/); assert.equal(box().checked, false, 'unticked by default');
  assert.deepEqual(pg.qa('input[data-event]').filter((b) => !b.checked).map((b) => b.dataset.event), ['orderCancelled'], 'every other kind is ticked'); await pg.click(pg.q('#notifyToggle')); await sleep(300); await pg.settle(); assert.equal(box().checked, false, 'turning order emails on does not tick it'); assert.equal(box().disabled, false);
  await pg.click(box()); await sleep(300); await pg.settle(); assert.equal((await api('GET', '/api/my/notifications', undefined, p.cookie)).json.events.find((e) => e.key === 'orderCancelled').enabled, true, 'ticking it saved'); await pg.click(box()); await sleep(300); await pg.settle(); assert.equal((await api('GET', '/api/my/notifications', undefined, p.cookie)).json.events.find((e) => e.key === 'orderCancelled').enabled, false, 'and unticking it too'); assert.deepEqual([pg.errors], [[]]); pg.close();
});
