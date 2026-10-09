import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

const apps = [];
after(async () => { for (const a of apps) await a.stop(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p, sel) => p.text(p.q(sel));
let N = 0; const u = (x = 'ul') => `${x}${++N}`;
// every test gets its own app (reset and go-live change the whole database)
async function world() {
  const a = await startApp(); apps.push(a); const admin = await a.adminLogin(); const w = await seed(a, admin);
  const api = (m, p, b, c = admin) => a.api(m, p, b, c);
  const order = async (title, extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, ...extra })).json.id;
  const item = async (go, title) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price: 10 })).json.id;
  const paidClaim = async (it) => { const h = u('p'); const cookie = await joinerSession(a, `${h}@x.com`, h); const [id] = await claimAndSecure(a, admin, h, it); const r = await api('POST', '/api/my/payments', { method: 'PayPal', amount: 10, reference: u('r') }, cookie); await api('POST', `/api/admin/payments/${r.json.id}/verify`, {}); return { h, id, cookie }; };
  const tab = async (name) => { const p = await gomPage(a, admin); await p.click(p.byText('#tabs button', name)); await sleep(80); await p.settle(); return p; };
  return { a, admin, w, api, order, item, paidClaim, tab };
}
const typed = (p, sel, v) => { const i = p.q(sel); i.value = v; i.dispatchEvent(new p.window.Event('input', { bubbles: true })); };

test('THE TEST TICK: shown in the order form, ticked orders carry a Test pill, and editing the tick saves', async () => {
  const x = await world(); const t = await x.order('Ticked test GO', { isTest: true }); const plain = await x.order('Plain GO');
  const p = await x.tab('Group Orders');
  const row = (id) => p.q(`tr[data-order="${id}"]`);
  assert.ok(row(t).querySelector('[data-test]'), 'the test order is marked'); assert.equal(row(plain).querySelector('[data-test]'), null);
  await p.click(row(plain).querySelector('[data-act="edit-order"]'));
  const f = p.q('form[data-form="edit-order"]'); const box = f.elements.isTest;
  assert.ok(box && !box.checked); assert.match(p.text(f), /Test order — can be deleted with everything on it \(payments, parcels…\) from the Launch tab, until you go live/);
  box.checked = true; await p.submit(f); await sleep(80); await p.settle();
  assert.equal((await x.api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === plain).isTest, true, 'saved');
  assert.ok(p.q(`tr[data-order="${plain}"]`).querySelector('[data-test]'), 'and the pill appears');
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('LAUNCH TAB — TEST ORDERS: listed with their claims and payments; delete shows exactly what goes, needs the name typed, asks once more, then removes it and everything on it', async () => {
  const x = await world(); const t = await x.order('Doomed test GO', { isTest: true }); const it = await x.item(t, 'Doomed item'); const a = await x.paidClaim(it); await x.paidClaim(it);
  const keep = await x.order('Real GO'); const kc = await x.paidClaim(await x.item(keep, 'Real item'));
  const p = await x.tab('Launch');
  assert.match(text(p, `[data-test-order="${t}"]`), /Doomed test GO.*2 claims · 2 payments/); assert.equal(p.q(`[data-test-order="${keep}"]`), null, 'only test orders are listed');
  await p.click(p.q(`[data-act="td-open"][data-id="${t}"]`));
  assert.match(text(p, '[data-removes]'), /This removes 1 item, 2 claims from 2 people, 2 payments \(£20\.00\), and puts anyone's credit back to how it was before this order\. The people themselves stay\./);
  const go = () => p.q('[data-act="td-go"]'); assert.equal(go().disabled, true);
  typed(p, '#tdTyped', 'doomed test'); assert.equal(go().disabled, true, 'a partial name is not enough');
  typed(p, '#tdTyped', ' DOOMED  test go '); assert.equal(go().disabled, false); assert.equal(p.q('#tdTyped').value, ' DOOMED  test go ', 'typing did not redraw');
  await p.click(go()); assert.match(p.text(modal(p)), /Really delete “Doomed test GO” and everything on it\?.*can't be undone/s);
  await press(p, 'Go back'); assert.equal(await x.a.q('SELECT COUNT(*) AS n FROM group_orders WHERE id = ?', [t]).then((r) => r[0].n), 1, 'going back deleted nothing');
  await p.click(go()); await press(p, 'Yes, delete it');
  assert.match(toast(p), /Deleted “Doomed test GO” and everything on it\./);
  assert.equal(await x.a.q('SELECT COUNT(*) AS n FROM group_orders WHERE id = ?', [t]).then((r) => r[0].n), 0);
  assert.equal(p.q(`[data-test-order="${t}"]`), null, 'it leaves the list'); assert.match(text(p, '#testOrders'), /No orders are ticked as test orders\./);
  assert.equal((await x.a.q('SELECT status FROM claims WHERE id = ?', [kc.id]))[0].status, 'confirmed', 'the real order is untouched'); void a;
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('LAUNCH TAB — a test order whose payment is shared with another order cannot be deleted on its own: the reason is shown and there is nothing to type', async () => {
  const x = await world(); const t = await x.order('Shared test GO', { isTest: true }); const o = await x.order('Other GO');
  const ti = await x.item(t, 'T item'), oi = await x.item(o, 'O item'); const h = u('sh'); const cookie = await joinerSession(x.a, `${h}@x.com`, h);
  await claimAndSecure(x.a, x.admin, h, ti); await claimAndSecure(x.a, x.admin, h, oi);
  const r = await x.api('POST', '/api/my/payments', { method: 'PayPal', amount: 20, reference: 'S' }, cookie); await x.api('POST', `/api/admin/payments/${r.json.id}/verify`, {});
  const p = await x.tab('Launch'); await p.click(p.q(`[data-act="td-open"][data-id="${t}"]`));
  assert.match(text(p, '[data-blockers]'), /It can't be deleted on its own:.*payment #\d+ also paid for other orders/s);
  assert.equal(p.q('#tdTyped'), null); assert.equal(p.q('[data-act="td-go"]').hidden, true); await p.click(p.q('[data-act="td-close"]')); assert.equal(p.q('#tdPanel'), null);
  p.close();
});

test('LAUNCH TAB — RESET FOR LAUNCH: shows the backup command; the button only wakes up when the backup box is ticked AND RESET is typed; a final confirmation; then everything is wiped and the GOM stays signed in', async () => {
  const x = await world(); const go = await x.order('Wipe me GO'); const it = await x.item(go, 'Wipe item'); const c = await x.paidClaim(it);
  const p = await x.tab('Launch');
  assert.equal(text(p, '[data-backup-cmd]'), 'docker exec -e ONCE=1 sos-backup /bin/sh /backup.sh');
  assert.match(text(p, '#resetCard'), /Wipes every order.*Kept: your artists\/groups, payment methods, proxies and your own GOM login.*before the Notion import/s);
  const rs = () => p.q('[data-act="rs-go"]');
  assert.equal(rs().disabled, true); typed(p, '#rsTyped', 'RESET'); assert.equal(rs().disabled, true, 'typed the word but not ticked the backup');
  p.q('#rsBackup').checked = true; p.q('#rsBackup').dispatchEvent(new p.window.Event('change', { bubbles: true })); assert.equal(rs().disabled, false, 'both: now it works');
  typed(p, '#rsTyped', 'rese'); assert.equal(rs().disabled, true, 'a mistyped word locks it again'); typed(p, '#rsTyped', ' reset ');
  await p.click(rs()); assert.match(p.text(modal(p)), /Reset everything for launch\?.*wiped, and every person with them.*You've taken a backup\. This can't be undone\./s);
  await press(p, 'Go back'); assert.equal(await x.a.q('SELECT COUNT(*) AS n FROM group_orders').then((r) => r[0].n) > 0, true, 'going back wiped nothing');
  await p.click(rs()); await press(p, 'Yes, reset everything');
  assert.match(toast(p), /Reset done — removed \d+ orders?, 1 claim, 1 payment, 1 person\./);
  for (const t of ['group_orders', 'items', 'claims', 'payments', 'joiners']) assert.equal(await x.a.q(`SELECT COUNT(*) AS n FROM ${t}`).then((r) => r[0].n), 0, t);
  assert.equal((await x.api('GET', '/api/admin/orders')).status, 200, 'still signed in'); assert.equal(await x.a.q('SELECT COUNT(*) AS n FROM artist_groups').then((r) => r[0].n) > 0, true, 'your groups are kept');
  assert.equal(p.q('#rsBackup').checked, false, 'the card starts fresh'); void c;
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('RESET with "keep people" ticked keeps their accounts and handles (and says so)', async () => {
  const x = await world(); const it = await x.item(await x.order('KP GO'), 'KP item'); await x.paidClaim(it);
  const p = await x.tab('Launch'); p.q('#rsBackup').checked = true; p.q('#rsKeep').checked = true; typed(p, '#rsTyped', 'RESET');
  await p.click(p.q('[data-act="rs-go"]')); assert.match(p.text(modal(p)), /wiped\. Your setup and your GOM login stay/); await press(p, 'Yes, reset everything');
  assert.match(toast(p), /Reset done — removed \d+ orders?, 1 claim, 1 payment\./); assert.doesNotMatch(toast(p), /person/);
  assert.equal(await x.a.q('SELECT COUNT(*) AS n FROM joiners').then((r) => r[0].n), 1, 'the person stays'); assert.equal(await x.a.q('SELECT COUNT(*) AS n FROM claims').then((r) => r[0].n), 0);
  p.close();
});

test('LAUNCH TAB — GO LIVE: needs the words and a final confirmation; afterwards the tab only says the site is live and reset/deleting are switched off for good', async () => {
  const x = await world(); const t = await x.order('Last test GO', { isTest: true });
  const p = await x.tab('Launch'); const gl = () => p.q('[data-act="gl-go"]');
  assert.equal(gl().disabled, true); typed(p, '#glTyped', 'go'); assert.equal(gl().disabled, true); typed(p, '#glTyped', ' go LIVE '); assert.equal(gl().disabled, false);
  assert.match(text(p, '#goLiveCard'), /permanent.*resetting and deleting test orders are switched off for good/s);
  await p.click(gl()); assert.match(p.text(modal(p)), /Go live\?.*switched off for good\. This can never be undone\./s);
  await press(p, 'Not yet'); assert.equal((await x.api('GET', '/api/admin/launch')).json.live, false, 'not yet means not yet');
  await p.click(gl()); await press(p, 'Yes, go live');
  assert.match(toast(p), /The site is live\./);
  assert.match(text(p, '[data-live]'), /The site is live.*It went live on \d\d\/\d\d\/\d{4}.*switched off for good/s);
  assert.equal(p.q('#resetCard'), null); assert.equal(p.q('#goLiveCard'), null); assert.equal(p.q('#testOrders'), null);
  assert.equal((await x.api('POST', '/api/admin/launch/reset', { confirm: 'RESET', backupConfirmed: true, keepPeople: false })).status, 403);
  assert.equal(await x.a.q('SELECT COUNT(*) AS n FROM group_orders WHERE id = ?', [t]).then((r) => r[0].n), 1);
  const again = await x.tab('Launch'); assert.ok(again.q('[data-live]'), 'and it stays that way on a fresh load'); again.close();
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('names with HTML are shown as text on the Launch tab', async () => {
  const x = await world(); await x.order('<img src=x onerror="window.pwned=1"> test', { isTest: true });
  const p = await x.tab('Launch');
  assert.equal(p.q('#testOrders img'), null); assert.equal(p.window.pwned, undefined); assert.match(text(p, '#testOrders'), /<img src=x onerror="window\.pwned=1"> test/);
  await p.click(p.q('#testOrders [data-act="td-open"]')); assert.equal(p.q('#tdPanel img'), null); assert.match(text(p, '#tdPanel'), /<img src=x onerror="window\.pwned=1"> test/);
  p.close();
});
