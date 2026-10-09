import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'uc') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const order = async (title) => (await api('POST', '/api/admin/orders', { groupId: w.group, title })).json.id;
const item = async (go, title) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price: 10 })).json.id;
const person = async (h = u()) => ({ handle: h, cookie: await joinerSession(app, `${h}@x.com`, h) });
const confirmedPaid = async (p, it, amount = 10) => { const [id] = await claimAndSecure(app, admin, p.handle, it); if (amount) { const r = await api('POST', '/api/my/payments', { method: 'PayPal', amount, reference: u('r') }, p.cookie); await api('POST', `/api/admin/payments/${r.json.id}/verify`, {}); } return id; };
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Group Orders')); await sleep(60); await p.settle(); return p; };
const text = (p, sel) => p.text(p.q(sel));
const typed = (p, v) => { const i = p.q('#cancelTyped'); i.value = v; i.dispatchEvent(new p.window.Event('input', { bubbles: true })); };
const status = async (id) => (await app.q('SELECT status FROM claims WHERE id = ?', [id]))[0].status;

test('CANCELLING A WHOLE ORDER, step by step: the impact first; the button stays off until the exact name is typed; then one more "are you sure"; then it is done', async () => {
  const go = await order('Screen Cancel GO'); const it = await item(go, 'Sold-out photocards');
  const [a, b] = [await person(), await person()];
  const ca = await confirmedPaid(a, it, 10), cb = await confirmedPaid(b, it, 4);
  await app.api('POST', '/api/claims', { handle: u('req'), lines: [{ itemId: it }] });
  const p = await open();
  await p.click(p.q(`[data-act="cancel-order"][data-id="${go}"]`));
  const panel = () => p.q('#cancelPanel');
  assert.match(p.text(panel()), /Cancel the group order “Screen Cancel GO”\?/);
  assert.match(text(p, '[data-impact]'), /This will cancel 3 claims \(2 confirmed, 1 unconfirmed\) from 3 people and return the £14\.00 they've paid to them as credit\./);
  assert.match(text(p, '[data-claims]'), new RegExp(`@${a.handle} — Sold-out photocards \\(confirmed, paid £10\\.00\\)`));
  assert.match(p.text(panel()), /The order closes and disappears from the shop.*Nothing is emailed — you'll need to tell people yourself\./);
  const go_ = () => p.q('[data-act="cancel-go"]');
  assert.equal(go_().disabled, true, 'locked until the name is typed');
  typed(p, 'Screen Cancel'); assert.equal(go_().disabled, true, 'a partial name is not enough');
  typed(p, '  screen   CANCEL go '); assert.equal(go_().disabled, false, 'spacing and capitals are forgiven');
  assert.equal(p.q('#cancelTyped').value, '  screen   CANCEL go ', 'typing did not redraw the panel or lose the text');
  await p.click(go_());
  assert.match(p.text(modal(p)), /Really cancel “Screen Cancel GO”\?.*3 claims will be cancelled and £14\.00 returned to people as credit\. Nobody is emailed\. This can't be undone\./s);
  await press(p, 'Go back');
  assert.deepEqual([await status(ca), await status(cb)], ['confirmed', 'confirmed'], 'going back changed nothing'); assert.ok(panel(), 'the panel is still there');
  await p.click(go_()); await press(p, 'Yes, cancel it');
  assert.match(toast(p), /Cancelled “Screen Cancel GO” — 3 claims, £14\.00 returned as credit\./);
  assert.deepEqual([await status(ca), await status(cb)], ['cancelled', 'cancelled']);
  assert.equal(p.q('#cancelPanel'), null, 'the panel closes');
  const row = p.qa('tbody tr').find((r) => /Screen Cancel GO/.test(p.text(r)));
  assert.ok(row.querySelector('[data-cancelled]'), 'the row is marked Cancelled'); assert.equal(row.querySelector('[data-act="cancel-order"]'), null, 'and offers no second cancel');
  assert.equal((await api('GET', '/api/my/summary', undefined, a.cookie)).json.credit, 10);
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('CANCELLING ONE ITEM from the items list: the order stays open, the item is marked Cancelled and loses its Cancel button', async () => {
  const go = await order('Item Cancel GO'); const sold = await item(go, 'Set that sold out'), keep = await item(go, 'Still on offer');
  const a = await person(); const c = await confirmedPaid(a, sold, 10); await confirmedPaid(await person(), keep, 0);
  const p = await open();
  await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`));
  await p.click(p.q(`[data-act="cancel-item"][data-id="${sold}"]`));
  assert.match(p.text(p.q('#cancelPanel')), /Cancel the item “Set that sold out”\?/); assert.match(text(p, '[data-impact]'), /This will cancel 1 claim \(1 confirmed, 0 unconfirmed\) from 1 person and return the £10\.00/);
  assert.match(p.text(p.q('#cancelPanel')), /The item disappears from the shop and can no longer be claimed/);
  typed(p, 'Set that sold out'); await p.click(p.q('[data-act="cancel-go"]')); await press(p, 'Yes, cancel it');
  assert.match(toast(p), /Cancelled “Set that sold out” — 1 claim, £10\.00 returned as credit/);
  assert.equal(await status(c), 'cancelled');
  const rows = p.qa('#itemsPanel tr'); const done = rows.find((r) => /Set that sold out/.test(p.text(r))), other = rows.find((r) => /Still on offer/.test(p.text(r)));
  assert.ok(done.querySelector('[data-cancelled]')); assert.equal(done.querySelector('[data-act="cancel-item"]'), null);
  assert.ok(other.querySelector('[data-act="cancel-item"]'), 'the other item can still be cancelled');
  const orderRow = p.qa('tbody tr').find((r) => /Item Cancel GO/.test(p.text(r))); assert.equal(orderRow.querySelector('[data-cancelled]'), null, 'the order itself is not cancelled');
  p.close();
});

test('ANYTHING IN THE WAY IS SHOWN, AND THE CANCEL BUTTON IS NOT OFFERED: a claim in a parcel names itself and the panel can only be closed', async () => {
  const go = await order('Stuck GO'); const it = await item(go, 'Parcel thing'); const a = await person();
  await api('PUT', '/api/my/address', { fullName: 'Stuck Er', address: '1 Road, Leeds', email: `${a.handle}@x.com`, phone: '0700123456' }, a.cookie);
  const c = await confirmedPaid(a, it, 0); await api('PATCH', `/api/admin/claims/${c}`, { pipeline: 'ready to pack / on hand' });
  const par = await api('POST', '/api/my/parcels', { claimIds: [c], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, a.cookie);
  const p = await open(); await p.click(p.q(`[data-act="cancel-order"][data-id="${go}"]`));
  assert.match(text(p, '[data-blockers]'), new RegExp(`It can't be cancelled yet:.*“Parcel thing” \\(@${a.handle}\\) — it is in parcel #${par.json.id} — take it out of the parcel first`, 's'));
  assert.equal(p.q('#cancelTyped'), null, 'no name to type'); assert.equal(p.q('[data-act="cancel-go"]').hidden, true, 'no cancel button'); assert.equal(p.text(p.q('[data-act="cancel-close"]')), 'Close');
  await p.click(p.q('[data-act="cancel-close"]')); assert.equal(p.q('#cancelPanel'), null); assert.equal(await status(c), 'confirmed');
  p.close();
});

test('an order nobody has claimed says so; "Keep it" closes the panel; names, handles and items with HTML in them are shown as text', async () => {
  const empty = await order('Nobody GO'); await item(empty, 'Unclaimed');
  const p = await open(); await p.click(p.q(`[data-act="cancel-order"][data-id="${empty}"]`));
  assert.match(text(p, '[data-impact]'), /Nobody has a live claim on it, so no claims change\./);
  await p.click(p.q('[data-act="cancel-close"]')); assert.equal(p.q('#cancelPanel'), null);
  const nasty = await order('<img src=x onerror="window.pwned=1"> GO'); const it = await item(nasty, '<b>bold</b> thing'); await confirmedPaid(await person('evil_h'), it, 0);
  await p.click(p.byText('#tabs button', 'Group Orders')); await sleep(60); await p.settle();
  await p.click(p.q(`[data-act="cancel-order"][data-id="${nasty}"]`));
  assert.equal(p.q('#cancelPanel img'), null); assert.equal(p.q('#cancelPanel b'), null); assert.equal(p.window.pwned, undefined);
  assert.match(p.text(p.q('#cancelPanel')), /<img src=x onerror="window\.pwned=1"> GO/); assert.match(text(p, '[data-claims]'), /<b>bold<\/b> thing/);
  p.close();
});

test('a cancelled order is gone from what joiners see, and the Sets tab and proxy list no longer offer its items', async () => {
  const go = await order('Vanishing GO'); const it = await item(go, 'Vanishing item'); await confirmedPaid(await person(), it, 0);
  assert.ok((await fetch(`${app.base}/api/orders`).then((r) => r.json())).orders.some((o) => o.id === go));
  const r = await api('POST', `/api/admin/orders/${go}/cancel`, { confirm: 'Vanishing GO' }); assert.equal(r.status, 200);
  assert.equal((await fetch(`${app.base}/api/orders`).then((x) => x.json())).orders.some((o) => o.id === go), false);
  const shop = await (await import('./ui.helpers.js')).openPage(app, '/'); await sleep(100); await shop.settle();
  assert.ok(!shop.text(shop.q('#view')).includes('Vanishing GO')); shop.close();
});
