import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession, tickParcel } from './helpers.js';
import { storageCase, STORAGE_DAYS } from '../src/lib/storage.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);       // the server runs in UTC, as does this
const overdue = async () => (await api('GET', '/api/admin/overdue')).json;
const mineOf = (list, handle) => list.filter((r) => r.handle === handle);
const fresh = (p = 'od') => `${p}${++N}`;
async function orderWith(dueDaysAgo, { itemDue, price = 10, size = 'M' } = {}) {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Overdue GO ${++N}`, paymentDeadline: iso(dueDaysAgo) })).json.id;
  const item = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: `Thing ${N}`, price, sizeBucket: size, ...(itemDue !== undefined ? { paymentDeadline: iso(itemDue) } : {}) })).json.id;
  return { go, item };
}

test('storage rules: small things keep longer than bulky ones (XS/S 60 days, M/L/XL 30), and the SQL is built from the same table', () => {
  assert.deepEqual(STORAGE_DAYS, { XS: 60, S: 60, M: 30, L: 30, XL: 30 });
  assert.match(storageCase(), /WHEN c\.size_bucket = 'XS' THEN 60.*WHEN c\.size_bucket = 'XL' THEN 30.*ELSE 30 END/);
});

test('payments: overdue once the pay-by date has fully passed — due today is NOT overdue, due yesterday is 1 day overdue', async () => {
  const today = await orderWith(0), yesterday = await orderWith(1), tenDays = await orderWith(10), future = await orderWith(-5);
  const [a, b, c, d] = [fresh(), fresh(), fresh(), fresh()];
  for (const [h, o] of [[a, today], [b, yesterday], [c, tenDays], [d, future]]) await claimAndSecure(app, admin, h, o.item);
  const r = (await overdue()).payments;
  assert.equal(mineOf(r, a).length, 0, 'a date lives all day');
  assert.equal(mineOf(r, d).length, 0, 'not due yet');
  assert.deepEqual([mineOf(r, b)[0].daysOverdue, mineOf(r, c)[0].daysOverdue], [1, 10]);
  assert.deepEqual([mineOf(r, c)[0].owed, mineOf(r, c)[0].due], [10, iso(10)]);
  assert.match(mineOf(r, c)[0].orderTitle, /^Overdue GO \d+$/);
});

test('payments: an item\'s own pay-by date beats its order\'s — in both directions', async () => {
  const laterOwn = await orderWith(10, { itemDue: -5 });          // order overdue, but this item is not due for 5 more days
  const earlierOwn = await orderWith(-5, { itemDue: 3 });          // order not due, but this item was due 3 days ago
  const [a, b] = [fresh(), fresh()];
  await claimAndSecure(app, admin, a, laterOwn.item); await claimAndSecure(app, admin, b, earlierOwn.item);
  const r = (await overdue()).payments;
  assert.equal(mineOf(r, a).length, 0);
  assert.deepEqual([mineOf(r, b)[0].daysOverdue, mineOf(r, b)[0].ownDate], [3, true]);
});

test('payments: only what is STILL owed counts — paid-up, part-paid, unconfirmed and cancelled claims behave', async () => {
  const o = await orderWith(5, { price: 20 });
  const [paid, part, req, cancelled] = [fresh('pd'), fresh('pt'), fresh('rq'), fresh('cx')];
  const cp = await joinerSession(app, `${paid}@x.com`, paid); const cpart = await joinerSession(app, `${part}@x.com`, part);
  await claimAndSecure(app, admin, paid, o.item); await claimAndSecure(app, admin, part, o.item);
  await api('POST', '/api/claims', { handle: req, lines: [{ itemId: o.item }] }, undefined);                 // never secured
  const [cid] = await claimAndSecure(app, admin, cancelled, o.item);
  await api('PATCH', `/api/admin/claims/${cid}`, { status: 'cancelled' });
  for (const [c, amt] of [[cp, 20], [cpart, 12]]) { const p = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: amt, reference: 'X' }, c); await api('POST', `/api/admin/payments/${p.json.id}/verify`, {}); }
  const r = (await overdue()).payments;
  assert.equal(mineOf(r, paid).length, 0, 'paid in full');
  assert.equal(mineOf(r, req).length, 0, 'a request is not a debt');
  assert.equal(mineOf(r, cancelled).length, 0, 'a cancelled claim is not a debt');
  assert.equal(mineOf(r, part)[0].owed, 8, 'only the unpaid £8, not the whole £20');
});

test('payments: every cost line counts (postage and packaging too) and the list is worst-first with totals', async () => {
  const old = await orderWith(30), recent = await orderWith(2);
  const [a, b] = [fresh('wa'), fresh('wb')];
  const [ca] = await claimAndSecure(app, admin, a, old.item); await claimAndSecure(app, admin, b, recent.item);
  await api('PATCH', `/api/admin/claims/${ca}`, { costs: { ems: { cost: 3 }, doms: { cost: 4 }, packaging: { cost: 1 } } });
  const o = await overdue();
  assert.equal(mineOf(o.payments, a)[0].owed, 18, '10 + 3 + 4 + 1');
  const order = o.payments.map((r) => r.handle);
  assert.ok(order.indexOf(a) < order.indexOf(b), 'the 30-days-late one comes before the 2-days-late one');
  assert.equal(o.totals.paymentsOwed, round(o.payments.reduce((t, r) => t + r.owed, 0)));
  assert.equal(o.totals.people, new Set(o.payments.map((r) => r.handle)).size);
});
const round = (n) => Math.round(n * 100) / 100;

test('storage: 30 days for bulky, 60 for small, from ready-to-pack — and the day after the deadline is the first overdue day', async () => {
  const big = await orderWith(-20, { size: 'L' }), small = await orderWith(-20, { size: 'XS' });
  const ids = {};
  for (const [name, o, ago] of [['big31', big, 31], ['big30', big, 30], ['big29', big, 29], ['small61', small, 61], ['small60', small, 60], ['small40', small, 40]]) {
    const h = fresh(name); const [id] = await claimAndSecure(app, admin, h, o.item);
    await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' });
    await app.q('UPDATE claims SET ready_to_pack_date = CURDATE() - INTERVAL ? DAY WHERE id = ?', [ago, id]);
    ids[name] = h;
  }
  const r = (await overdue()).storage;
  assert.deepEqual(mineOf(r, ids.big31).map((x) => x.daysOverdue), [1], 'L: 31 days on hand, deadline was yesterday');
  assert.equal(mineOf(r, ids.big30).length, 0, 'exactly 30 days: the deadline is today, so not overdue yet');
  assert.equal(mineOf(r, ids.big29).length, 0);
  assert.deepEqual(mineOf(r, ids.small61).map((x) => x.daysOverdue), [1]);
  assert.equal(mineOf(r, ids.small60).length, 0);
  assert.equal(mineOf(r, ids.small40).length, 0, 'a 40-day-old small item is fine — it would be overdue if it were bulky');
  const row = mineOf(r, ids.big31)[0];
  assert.deepEqual([row.size, row.overridden, row.readyDate, row.deadline], ['L', false, iso(31), iso(1)]);
});

test('storage: a deadline you set by hand wins — a later one keeps it off the list, an earlier one puts it on', async () => {
  const o = await orderWith(-20, { size: 'XS' });
  const [later, earlier] = [fresh('lt'), fresh('er')];
  const [a] = await claimAndSecure(app, admin, later, o.item), [b] = await claimAndSecure(app, admin, earlier, o.item);
  for (const id of [a, b]) { await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' }); }
  await app.q('UPDATE claims SET ready_to_pack_date = CURDATE() - INTERVAL 70 DAY WHERE id IN (?, ?)', [a, b]);       // 70 days: overdue by the size rule
  assert.equal(mineOf((await overdue()).storage, later).length, 1);
  await api('PATCH', `/api/admin/claims/${a}`, { storageDeadlineOverride: iso(-10) });                                   // agreed: keep it 10 more days
  await api('PATCH', `/api/admin/claims/${b}`, { pipeline: 'ready to pack / on hand', storageDeadlineOverride: iso(3) });
  const r = (await overdue()).storage;
  assert.equal(mineOf(r, later).length, 0, 'extended');
  assert.deepEqual([mineOf(r, earlier)[0].daysOverdue, mineOf(r, earlier)[0].overridden], [3, true]);
  await api('PATCH', `/api/admin/claims/${a}`, { storageDeadlineOverride: null });
  assert.equal(mineOf((await overdue()).storage, later).length, 1, 'clearing it puts the normal rule back');
});

test('storage: stops once packed, shipped or completed; ignores items not yet ready; ignores unconfirmed and cancelled', async () => {
  const o = await orderWith(-20, { size: 'L' });
  const h = fresh('stg'); const c = await joinerSession(app, `${h}@x.com`, h);
  await app.api('PUT', '/api/my/address', { fullName: 'S T', address: '1 Road, Leeds', email: `${h}@x.com`, phone: '0700' }, c);
  const [id] = await claimAndSecure(app, admin, h, o.item);
  await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' });
  await app.q('UPDATE claims SET ready_to_pack_date = CURDATE() - INTERVAL 45 DAY WHERE id = ?', [id]);
  assert.equal(mineOf((await overdue()).storage, h).length, 1);
  const p = (await app.api('POST', '/api/my/parcels', { claimIds: [id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, c)).json;
  assert.equal(mineOf((await overdue()).storage, h).length, 1, 'asking for shipping does not stop the clock — packing does');
  await tickParcel(app, admin, p.id);
  await api('POST', `/api/admin/parcels/${p.id}/packed`, {});
  assert.equal(mineOf((await overdue()).storage, h).length, 0, 'packed: no longer sitting in storage');

  const notReady = fresh('nr'); const [nid] = await claimAndSecure(app, admin, notReady, o.item);
  await app.q('UPDATE claims SET ready_to_pack_date = NULL WHERE id = ?', [nid]);
  const cx = fresh('cx'); const [xid] = await claimAndSecure(app, admin, cx, o.item);
  await api('PATCH', `/api/admin/claims/${xid}`, { pipeline: 'ready to pack / on hand' });
  await app.q('UPDATE claims SET ready_to_pack_date = CURDATE() - INTERVAL 90 DAY WHERE id = ?', [xid]);
  await api('PATCH', `/api/admin/claims/${xid}`, { status: 'cancelled' });
  const r = (await overdue()).storage;
  assert.equal(mineOf(r, notReady).length, 0); assert.equal(mineOf(r, cx).length, 0);
});

test('the overdue list is for the GOM only', async () => {
  const j = await app.login('od.joiner@x.com');
  assert.equal((await api('GET', '/api/admin/overdue', undefined, j)).status, 403);
  assert.equal((await app.api('GET', '/api/admin/overdue')).status, 401);
});
