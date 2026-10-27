import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { storageDeadlineOf, storageStatusOf, STORAGE_DAYS } from '../src/lib/storage.js';

// STORAGE DEADLINE for joiners: an item that is READY TO PACK shows the date the GOM keeps it until — an override you set, else the date it became ready + 60 days (XS/S) or 30 days (M/L/XL).
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'sd') => `${x}${++N}`;
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const READY = 'ready to pack / on hand';
async function ready({ size = 'S', readyOffset = 0, override = null, pipeline = READY } = {}) {
  const h = u('st'); const cookie = await joinerSession(app, `${h}@x.com`, h); const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Storage GO '), proxy: 'Sam' })).json.id;
  const it = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price: 5 })).json.id; const [id] = await claimAndSecure(app, admin, h, it);
  await api('PATCH', `/api/admin/claims/${id}`, { pipeline, sizeBucket: size, ...(override ? { storageDeadlineOverride: override } : {}) }); await app.q('UPDATE claims SET ready_to_pack_date = ? WHERE id = ?', [day(readyOffset), id]);                  // an item keeps its ready date after it moves on, so the STAGE is what hides the deadline
  return { h, cookie, id };
}
const mine = async (j) => (await api('GET', `/api/my/summary?handle=${j.h}`, undefined, j.cookie)).json.orders.flatMap((o) => o.claims).find((c) => c.id === j.id);

test('THE RULE: ready date + 60 days for XS and S, + 30 days for M, L and XL (the same as your Overdue tab); a date you set by hand wins', async () => {
  for (const [size, days] of [['XS', 60], ['S', 60], ['M', 30], ['L', 30], ['XL', 30]]) { const j = await ready({ size, readyOffset: -10 }); assert.equal((await mine(j)).storageDeadline, day(-10 + days), `${size}: ${days} days`); }
  const o = await ready({ size: 'S', readyOffset: -10, override: day(90) }); assert.equal((await mine(o)).storageDeadline, day(90), 'your own date wins');
  assert.deepEqual([STORAGE_DAYS.XS, STORAGE_DAYS.S, STORAGE_DAYS.M, STORAGE_DAYS.L, STORAGE_DAYS.XL], [60, 60, 30, 30, 30]);
});

test('IT IS FLAGGED AS IT APPROACHES: ok → soon (within 7 days, including today) → late (the day after); a date lives all day, like every due date', async () => {
  const status = async (leftDays) => (await mine(await ready({ size: 'M', readyOffset: leftDays - 30 }))).storageStatus;                // M = 30 days: deadline = today + leftDays
  assert.deepEqual([await status(30), await status(8), await status(7), await status(1), await status(0), await status(-1), await status(-20)], ['ok', 'ok', 'soon', 'soon', 'soon', 'late', 'late']);
  const j = await ready({ size: 'M', readyOffset: -35 }); const c = await mine(j); assert.deepEqual([c.storageDeadline, c.storageStatus], [day(-5), 'late']);
});

test('ONLY AN ITEM THAT IS READY TO PACK HAS ONE: not earlier stages, not once packed / shipped / completed, not an unsecured request', async () => {
  for (const pipeline of ['awaiting fulfillment', 'ordered via proxy / warehouse', 'arrived at proxy / warehouse', 'packed', 'shipped', 'completed']) { const j = await ready({ pipeline }); const c = await mine(j); assert.deepEqual([c.storageDeadline, c.storageStatus], [null, null], pipeline); }
  const h = u('rq'); const cookie = await joinerSession(app, `${h}@x.com`, h); const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Req GO '), proxy: 'Sam' })).json.id; const it = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Req '), price: 5 })).json.id;
  await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: it }] }); const [claim] = (await api('GET', `/api/my/summary?handle=${h}`, undefined, cookie)).json.orders.flatMap((o) => o.claims); assert.equal(claim.storageDeadline, null, 'a request has none');
});

test('NOTHING IS INVENTED: ready to pack but with no ready date and no override has no deadline', async () => {
  const j = await ready({}); await app.q('UPDATE claims SET ready_to_pack_date = NULL, storage_deadline_override = NULL WHERE id = ?', [j.id]); assert.deepEqual([(await mine(j)).storageDeadline, (await mine(j)).storageStatus], [null, null]);
});

test('THE JOINER AND YOUR OVERDUE TAB AGREE: an item past its deadline shows the same date in both', async () => {
  const j = await ready({ size: 'M', readyOffset: -40 }); const c = await mine(j); const row = (await api('GET', '/api/admin/overdue')).json.storage.find((r) => r.claimId === j.id); assert.ok(row, 'it is in your Overdue tab'); assert.equal(String(row.deadline).slice(0, 10), c.storageDeadline); assert.equal(c.storageStatus, 'late');
});

test('THE TWO HELPERS directly: the date arithmetic and the status boundaries', async () => {
  assert.equal(storageDeadlineOf({ size: 'XS', readyDate: '2026-01-01' }), '2026-03-02'); assert.equal(storageDeadlineOf({ size: 'L', readyDate: '2026-01-01' }), '2026-01-31'); assert.equal(storageDeadlineOf({ size: 'weird', readyDate: '2026-01-01' }), '2026-01-31', 'an unknown size gets 30 days, like the SQL');
  assert.equal(storageDeadlineOf({ size: 'S', readyDate: '2026-01-01', override: '2026-12-25' }), '2026-12-25'); assert.equal(storageDeadlineOf({ size: 'S' }), null);
  assert.deepEqual([storageStatusOf(null, '2026-01-01'), storageStatusOf('2025-12-31', '2026-01-01'), storageStatusOf('2026-01-01', '2026-01-01'), storageStatusOf('2026-01-08', '2026-01-01'), storageStatusOf('2026-01-09', '2026-01-01')], [null, 'late', 'soon', 'soon', 'ok']);
});
