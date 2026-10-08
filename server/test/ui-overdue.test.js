import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';
import { gomPage, toast } from './ui.helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const uk = (i) => `${i.slice(8, 10)}/${i.slice(5, 7)}/${i.slice(0, 4)}`;
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Overdue')); return p; };
const text = (p, sel = '#tabBody') => p.text(p.q(sel));
async function overdueOrder(daysAgo, { title, price = 10, size = 'M', itemDue } = {}) {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: title || `Late GO ${++N}`, paymentDeadline: iso(daysAgo) })).json.id;
  const item = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: `Late thing ${N}`, price, sizeBucket: size, ...(itemDue !== undefined ? { paymentDeadline: iso(itemDue) } : {}) })).json.id;
  return { go, item };
}

test('with nothing overdue the tab says so, plainly', async () => {
  const p = await open();
  assert.match(text(p), /All clear — nothing is overdue right now/);
  assert.equal((await p.qa('#tabs [data-tab="overdue"] .badge'))[0].hidden, true);
  assert.equal(p.qa('[data-person]').length, 0);
  assert.match(text(p), /Overdue payments.*Nothing overdue right now.*Overdue storage.*Nothing overdue right now/s);
  p.close();
});

test('overdue payments are grouped by person with their total, and each item says how late it is', async () => {
  const a = await overdueOrder(10, { title: 'Ten days late GO', price: 20 }), b = await overdueOrder(2, { title: 'Two days late GO', price: 6, itemDue: 4 });
  const [h1, h2] = ['late_amy', 'late_bob'];
  await claimAndSecure(app, admin, h1, a.item); await claimAndSecure(app, admin, h1, b.item); await claimAndSecure(app, admin, h2, a.item);
  const p = await open();
  assert.match(text(p, '#tabBody .card'), /£46\.00 overdue across 2 people/);
  const amy = text(p, `[data-person="${h1}"]`);
  assert.match(amy, /@late_amy\s*owes £26\.00 overdue · 2 items/);
  assert.match(amy, /Late thing.*Ten days late GO.*Owed £20\.00 · was due \d\d\/\d\d\/\d{4}.*10 days overdue/s);
  assert.match(amy, new RegExp(`was due ${uk(iso(10))}`));
  assert.match(amy, /Owed £6\.00.*\(this item's own date\).*4 days overdue/s, 'the item\'s own date beat its order\'s');
  assert.match(text(p, `[data-person="late_bob"]`), /@late_bob\s*owes £20\.00 overdue · 1 item/);
  assert.equal(p.q('#tabs [data-tab="overdue"] .badge').textContent, '3', 'the badge counts overdue items');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('once someone pays, they come off the list', async () => {
  const h = 'late_cat'; const c = await joinerSession(app, `${h}@x.com`, h);
  const o = await overdueOrder(3, { price: 8 });
  await claimAndSecure(app, admin, h, o.item);
  const p = await open();
  assert.ok(p.q(`[data-person="${h}"]`));
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 8, reference: 'LATE' }, c);
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  await p.click(p.byText('#tabs button', 'Overdue'));
  assert.equal(p.q(`[data-person="${h}"]`), null);
  p.close();
});

test('overdue storage: shows when it became ready, the size rule, the deadline and how late — with an extension control', async () => {
  const o = await overdueOrder(-30, { size: 'L' });
  const h = 'store_dan'; const [id] = await claimAndSecure(app, admin, h, o.item);
  await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' });
  await app.q('UPDATE claims SET ready_to_pack_date = CURDATE() - INTERVAL 40 DAY WHERE id = ?', [id]);
  const p = await open();
  const row = p.q(`.itemrow[data-claim="${id}"]`);
  const t = p.text(row);
  assert.match(t, /@store_dan.*Late thing/);
  assert.match(t, new RegExp(`On hand since ${uk(iso(40))} · size L · deadline was ${uk(iso(10))}`));
  assert.match(t, /10 days overdue/);
  assert.match(text(p, '#tabBody'), /Small items \(XS and S\) are kept 60 days, bigger ones \(M, L, XL\) 30 days.*unless you've set a date by hand, which always wins.*clock stops once an item is packed/s);
  assert.equal(p.q('[data-act="clear"]', row), null, 'no "back to normal" while nothing is set by hand');
  p.close();
});

test('extending a storage deadline: asks for a date, saves it, takes the item off the list; the override can be removed', async () => {
  const o = await overdueOrder(-30, { size: 'XS' });
  const h = 'store_eve'; const [id] = await claimAndSecure(app, admin, h, o.item);
  await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' });
  await app.q('UPDATE claims SET ready_to_pack_date = CURDATE() - INTERVAL 65 DAY WHERE id = ?', [id]);
  const p = await open();
  const form = () => p.q(`form[data-form="extend"][data-id="${id}"]`);
  await p.submit(form());
  assert.match(p.text(p.q('[data-msg]', form())), /Pick the date to keep it until/);
  assert.equal((await api('GET', '/api/admin/overdue')).json.storage.some((r) => r.claimId === id), true, 'nothing saved');
  form().elements.date.value = iso(-14); await p.submit(form());
  assert.match(toast(p), new RegExp(`Keeping it until ${uk(iso(-14))}`));
  assert.equal(p.q(`.itemrow[data-claim="${id}"]`), null, 'no longer overdue');
  assert.equal((await app.q('SELECT storage_deadline_override AS d FROM claims WHERE id = ?', [id]))[0].d, iso(-14));
  // an earlier hand-set date puts it back, flagged as set by you, with a way back to the normal rule
  await api('PATCH', `/api/admin/claims/${id}`, { storageDeadlineOverride: iso(2) });
  await p.click(p.byText('#tabs button', 'Overdue'));
  assert.match(p.text(p.q(`.itemrow[data-claim="${id}"]`)), /\(set by you\).*2 days overdue/s);
  await p.click(p.q(`[data-act="clear"][data-id="${id}"]`));
  assert.match(toast(p), /Back to the normal storage rule/);
  assert.equal((await app.q('SELECT storage_deadline_override AS d FROM claims WHERE id = ?', [id]))[0].d, null);
  p.close();
});

test('names with HTML in them are shown as text', async () => {
  const o = await overdueOrder(5, { title: '<img src=x onerror="window.pwned=1"> GO' });
  await claimAndSecure(app, admin, 'xss_late', o.item);
  const p = await open();
  assert.equal(p.q('#tabBody img'), null);
  assert.match(text(p, '[data-person="xss_late"]'), /<img src=x onerror="window\.pwned=1"> GO/);
  assert.equal(p.window.pwned, undefined);
  p.close();
});


test('after a reminder email goes out, the Overdue tab says so — and only for that claim', async () => {
  const h = 'remind_rae'; const c = await joinerSession(app, `${h}@x.com`, h);
  await app.api('PUT', '/api/my/notifications', { enabled: true }, c);
  const o = await overdueOrder(6, { title: 'Reminder GO' });
  const [id] = await claimAndSecure(app, admin, h, o.item);
  let p = await open();
  assert.doesNotMatch(text(p, `.itemrow[data-claim="${id}"]`), /reminder emailed/);
  p.close();
  await app.notifier.sendOverdueReminders(); await app.notifier.idle();
  p = await open();
  assert.match(text(p, `.itemrow[data-claim="${id}"]`), /was due.*· reminder emailed \d\d\/\d\d\/\d{4}/s);
  p.close();
});
