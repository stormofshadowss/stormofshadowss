import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';
import { storageDeadlineOf } from '../src/lib/storage.js';

// A STORAGE DEADLINE FOR ANY CLAIM — one at a time or many at once — for the items that lost theirs in the Notion import.
let app, admin, w, N = 0, ITEM;
const READY = 'ready to pack / on hand';
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); ITEM = (await app.api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: 'Stored thing', price: 5 }, admin)).json.id; });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const mk = async () => (await claimAndSecure(app, admin, `sd${++N}`, ITEM))[0];
const lost = async () => { const id = await mk(); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); await app.q('UPDATE claims SET ready_to_pack_date = NULL WHERE id = ?', [id]); return id; };      // ready to pack, but no date at all — as the import left some
const row = async (id) => (await api('GET', '/api/admin/claims')).json.claims.find((c) => c.id === id);
const raw = async (id) => (await app.q('SELECT storage_deadline_override AS o, status FROM claims WHERE id = ?', [id]))[0];
const bulk = (claimIds, date, c = admin) => api('POST', '/api/admin/claims/storage-deadline', { claimIds, date }, c);

test('THE CLAIMS LIST SHOWS EACH CLAIM\'S STORAGE DEADLINE: worked out from when it became ready, a date set by hand wins, and one that lost everything shows none', async () => {
  const normal = await mk(); await api('PATCH', `/api/admin/claims/${normal}`, { pipeline: READY }); const none = await lost(), byHand = await lost(), early = await mk(); const d = inDays(20);
  assert.equal((await api('PATCH', `/api/admin/claims/${byHand}`, { storageDeadlineOverride: d })).status, 200); assert.equal((await api('PATCH', `/api/admin/claims/${early}`, { storageDeadlineOverride: d })).status, 200, 'any claim, even one that is not ready yet');
  const a = await row(normal); assert.deepEqual([a.storageDeadline, a.storageSet], [storageDeadlineOf({ size: 'M', readyDate: today(), override: null }), false], 'the normal rule: ready date + days for its size');
  const b = await row(none); assert.deepEqual([b.storageDeadline, b.storageSet], [null, false], 'ready to pack with no date and no override: no deadline'); const c = await row(byHand); assert.deepEqual([c.storageDeadline, c.storageSet], [d, true]);
  const e = await row(early); assert.deepEqual([e.pipeline === READY, e.storageDeadline, e.storageSet], [false, d, true], 'a hand-set date shows whatever the stage'); assert.equal('storageOverride' in a, false, 'the raw field isn\'t leaked');
});

test('ONE CLAIM: set, change and clear a deadline; only a REAL date is accepted (2026-02-31 used to get through and fail in the database)', async () => {
  const id = await lost(); assert.equal((await api('PATCH', `/api/admin/claims/${id}`, { storageDeadlineOverride: '2027-01-15' })).status, 200); assert.equal((await raw(id)).o, '2027-01-15'); assert.equal((await api('PATCH', `/api/admin/claims/${id}`, { storageDeadlineOverride: '2027-02-28' })).status, 200);
  for (const bad of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-2-3', 'tomorrow', '15/01/2027', '']) { const r = await api('PATCH', `/api/admin/claims/${id}`, { storageDeadlineOverride: bad }); assert.equal(r.status, 400, JSON.stringify(bad)); }
  assert.equal((await raw(id)).o, '2027-02-28', 'refused dates changed nothing'); assert.equal((await api('PATCH', `/api/admin/claims/${id}`, { storageDeadlineOverride: '2028-02-29' })).status, 200, 'a real leap day is fine'); assert.equal((await api('PATCH', `/api/admin/claims/${id}`, { storageDeadlineOverride: null })).status, 200); assert.equal((await raw(id)).o, null, 'cleared');
});

test('BULK SET: the same date on many claims — ones already on it are left, cancelled ones are skipped, any stage is fine; the counts say which; recorded', async () => {
  const [a, b, c, d, e] = [await lost(), await lost(), await lost(), await mk(), await mk()]; const D = inDays(30); await api('PATCH', `/api/admin/claims/${c}`, { storageDeadlineOverride: D }); assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: [d] })).status, 200);
  const r = await bulk([a, b, c, d, e, a], D); assert.equal(r.status, 200, r.text); assert.deepEqual([r.json.changed, r.json.unchanged, r.json.skipped, r.json.date], [3, 1, 1, D], 'a, b and e changed; c was already on it; d was cancelled; the repeated a counts once');
  for (const id of [a, b, c, e]) assert.equal((await raw(id)).o, D, `claim ${id}`); assert.equal((await raw(d)).o, null, 'the cancelled one is untouched'); const shown = await row(a); assert.deepEqual([shown.storageDeadline, shown.storageSet], [D, true]);
  assert.ok((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'claims.storage_deadline'"))[0].n >= 1, 'recorded');
});

test('BULK CLEAR: back to the normal rule — a claim that was ready gets its date from when it became ready; one that never had a ready date has none again', async () => {
  const withReady = await mk(); await api('PATCH', `/api/admin/claims/${withReady}`, { pipeline: READY }); const noReady = await lost(); const D = inDays(40); assert.equal((await bulk([withReady, noReady], D)).json.changed, 2);
  const r = await bulk([withReady, noReady, noReady], null); assert.deepEqual([r.status, r.json.changed, r.json.unchanged, r.json.date], [200, 2, 0, null]); assert.equal((await raw(withReady)).o, null); const a = await row(withReady), b = await row(noReady);
  assert.deepEqual([a.storageDeadline, a.storageSet], [storageDeadlineOf({ size: 'M', readyDate: today(), override: null }), false], 'the normal rule again'); assert.deepEqual([b.storageDeadline, b.storageSet], [null, false], 'nothing to fall back on'); assert.equal((await bulk([withReady], null)).json.unchanged, 1, 'clearing what is already clear changes nothing');
});

test('BULK RULES: the list must be 1–500 claims, the date a real day (a past date is fine); an unknown claim refuses the lot; a joiner and a signed-out visitor are refused', async () => {
  const a = await lost(), b = await lost(); const many = (n) => Array.from({ length: n }, (_, i) => 900000 + i);
  assert.equal((await bulk([], inDays(5))).status, 400); assert.equal((await bulk(many(501), inDays(5))).status, 400, 'more than 500'); for (const bad of ['2026-02-31', 'soon', '2026-13-13', undefined]) assert.equal((await api('POST', '/api/admin/claims/storage-deadline', { claimIds: [a], date: bad })).status, 400, JSON.stringify(bad));
  assert.equal((await bulk([a, 999999], inDays(5))).status, 404); assert.equal((await raw(a)).o, null, 'one unknown claim and NOTHING was changed'); assert.equal((await bulk([a, b], inDays(-10))).status, 200, 'a date in the past is allowed');
  const j = await joinerSession(app, `${'jj'}${++N}@x.com`, `jj${N}`); assert.equal((await bulk([a], inDays(5), j)).status, 403); assert.equal((await app.api('POST', '/api/admin/claims/storage-deadline', { claimIds: [a], date: inDays(5) })).status, 401);
});

test('THE OVERDUE TAB PICKS THEM UP: a ready-to-pack claim with no deadline is invisible there; a past date from the bulk tool puts it on the list; clearing takes it off', async () => {
  const id = await lost(); const onList = async () => (await api('GET', '/api/admin/overdue')).json.storage.find((s) => s.claimId === id);
  assert.equal(await onList(), undefined, 'no deadline: never overdue'); assert.equal((await bulk([id], inDays(-3))).status, 200); const s = await onList(); assert.ok(s, 'now on the Overdue tab'); assert.deepEqual([s.overridden, s.daysOverdue >= 3], [true, true]);
  assert.equal((await bulk([id], null)).status, 200); assert.equal(await onList(), undefined, 'cleared: off it again'); assert.equal((await bulk([id], inDays(10))).status, 200); assert.equal(await onList(), undefined, 'a future date: not overdue yet');
});
