import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// ARCHIVE: a closed (or cancelled) group order whose claims are ALL completed can be tucked away by hand; otherwise it is refused with a plain list of what isn't done. Reversible. Joiners see no change.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ar') => `${x}${++N}`;
const goOrder = async (title = u('Archive GO '), extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam', ...extra })).json.id;
const item = async (go, title = u('Thing '), extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title, ...extra })).json.id;
const close = (go) => api('PATCH', `/api/admin/orders/${go}`, { status: 'closed' });
const claim = async (handle, itemId, stage = 'completed') => { const [id] = await claimAndSecure(app, admin, handle, itemId); if (stage) await api('PATCH', `/api/admin/claims/${id}`, { pipeline: stage }); return id; };
const row = async (go) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go);
const archive = (go, c) => api('POST', `/api/admin/orders/${go}/archive`, {}, c);

test('A CLOSED ORDER WHERE EVERY CLAIM IS COMPLETED CAN BE ARCHIVED, and un-archived again; the GOM\'s list says so, the public never does', async () => {
  const go = await goOrder('Finished GO'); const a = await item(go, 'Album'), b = await item(go, 'Keyring'); await claim(u(), a); await claim(u(), a); await claim(u(), b); await close(go);
  let o = await row(go); assert.deepEqual([o.archivedAt, o.outstanding], [null, 0], 'ready: nothing outstanding'); const r = await archive(go); assert.equal(r.status, 200, r.text);
  o = await row(go); assert.ok(o.archivedAt && !Number.isNaN(Date.parse(o.archivedAt)), 'archived, with when'); assert.equal((await archive(go)).json.code, 'already_archived');
  const pub = (await app.api('GET', '/api/orders')).json.orders.find((x) => x.id === go); assert.ok(!pub || !('archivedAt' in pub), 'the public list carries no archive information');
  assert.equal((await api('POST', `/api/admin/orders/${go}/unarchive`, {})).status, 200); assert.equal((await row(go)).archivedAt, null); assert.equal((await api('POST', `/api/admin/orders/${go}/unarchive`, {})).json.code, 'not_archived');
  assert.deepEqual((await app.q("SELECT action FROM audit_log WHERE entity = 'order' AND entity_id = ? AND action LIKE 'order.%archive' ORDER BY id", [go])).map((r2) => r2.action), ['order.archive', 'order.unarchive'], 'both are recorded');
});

test('IT IS REFUSED WITH A PLAIN LIST OF WHAT ISN\'T COMPLETED: any earlier stage, and unsecured requests, block it; cancelled claims do not; once everything is completed it works', async () => {
  const go = await goOrder('Not finished GO'); const album = await item(go, 'Album'), tee = await item(go, 'Tee'); const done = await claim(u(), album); const ready = [await claim(u(), album, 'ready to pack / on hand'), await claim(u(), album, 'ready to pack / on hand')]; const waiting = await claim(u(), tee, null);
  await app.api('POST', '/api/claims', { handle: u(), lines: [{ itemId: tee }] });                                      // a request nobody has secured
  const gone = await claim(u(), tee, 'completed'); await app.q("UPDATE claims SET status = 'cancelled' WHERE id = ?", [gone]); await close(go); void done; void waiting;
  const r = await archive(go); assert.deepEqual([r.status, r.json.code, r.json.total], [409, 'not_completed', 4]);
  assert.equal(r.json.error, 'Can\'t archive “Not finished GO” yet — 4 claims aren\'t completed: Album — 2 × ready to pack / on hand; Tee — 1 × awaiting fulfillment; Tee — 1 × requested (not secured yet).');
  assert.deepEqual(r.json.outstanding, [{ item: 'Album', stage: 'ready to pack / on hand', count: 2 }, { item: 'Tee', stage: 'awaiting fulfillment', count: 1 }, { item: 'Tee', stage: 'requested (not secured yet)', count: 1 }]); assert.equal((await row(go)).outstanding, 4, 'the list shows the same count'); assert.equal((await row(go)).archivedAt, null);
  for (const id of ready) await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'completed' }); const [{ id: waitId }] = await app.q("SELECT c.id FROM claims c WHERE c.item_id = ? AND c.status = 'confirmed' AND c.pipeline <> 'completed'", [tee]); await api('PATCH', `/api/admin/claims/${waitId}`, { pipeline: 'completed' });
  assert.equal((await archive(go)).json.code, 'not_completed', 'the unsecured request still blocks'); await app.q("UPDATE claims SET status = 'cancelled' WHERE item_id = ? AND status = 'requested'", [tee]); assert.equal((await archive(go)).status, 200, 'now everything left is completed');
});

test('A LONG LIST IS SHORTENED IN THE MESSAGE (first six, then "…and N more"), but the details are all there', async () => {
  const go = await goOrder('Many things GO'); for (let i = 0; i < 8; i++) await claim(u(), await item(go, `Item ${i + 1}`), null); await close(go);
  const r = await archive(go); assert.equal(r.json.outstanding.length, 8); assert.match(r.json.error, /8 claims aren't completed: Item 1 — 1 × awaiting fulfillment; .* Item 6 — 1 × awaiting fulfillment; …and 2 more\.$/);
});

test('ONLY CLOSED ORDERS: an open order is refused ("close it first"); closed by hand, closed by date, or cancelled all count as closed; a cancelled order needs nothing completed', async () => {
  const open = await goOrder('Still open GO'); const o = await archive(open); assert.deepEqual([o.status, o.json.code], [409, 'still_open']); assert.equal(o.json.error, '“Still open GO” is still open — close it first. Only closed (or cancelled) group orders can be archived.');
  const byDate = await goOrder('Past its date GO', { closeDate: '2000-01-01' }); assert.equal((await archive(byDate)).status, 200, 'past its closing date = closed');
  const future = await goOrder('Future date GO', { closeDate: '2099-01-01' }); assert.equal((await archive(future)).json.code, 'still_open');
  const cancelled = await goOrder('Cancelled GO'); const it = await item(cancelled); await claim(u(), it, null); await app.q("UPDATE claims SET status = 'cancelled' WHERE item_id = ?", [it]); await app.q('UPDATE group_orders SET cancelled_at = NOW() WHERE id = ?', [cancelled]); assert.equal((await archive(cancelled)).status, 200, 'cancelled: nothing outstanding, so it can');
  const cancelledWithStuff = await goOrder('Cancelled with leftovers'); const it2 = await item(cancelledWithStuff); await claim(u(), it2, null); await app.q('UPDATE group_orders SET cancelled_at = NOW() WHERE id = ?', [cancelledWithStuff]); assert.equal((await archive(cancelledWithStuff)).status, 200, 'a cancelled order is archivable whatever is left on it');
});

test('REOPENING OR MOVING THE CLOSING DATE BRINGS AN ARCHIVED ORDER BACK to the normal lists (it does not silently stay archived underneath)', async () => {
  const go = await goOrder('Reopen GO'); await close(go); assert.equal((await archive(go)).status, 200); assert.ok((await row(go)).archivedAt);
  assert.equal((await api('PATCH', `/api/admin/orders/${go}`, { status: 'open' })).status, 200); assert.equal((await row(go)).archivedAt, null, 'reopened → no longer archived'); await close(go); assert.equal((await row(go)).archivedAt, null, 'and closing it again does not bring the old flag back');
  assert.equal((await archive(go)).status, 200); await api('PATCH', `/api/admin/orders/${go}`, { closeDate: '2099-06-01' }); assert.equal((await row(go)).archivedAt, null, 'moving the closing date also un-archives it');
  await api('PATCH', `/api/admin/orders/${go}`, { title: 'Renamed' }); await close(go); await archive(go); await api('PATCH', `/api/admin/orders/${go}`, { title: 'Renamed again' }); assert.ok((await row(go)).archivedAt, 'but editing something else leaves it archived');
});

test('ARCHIVED ORDERS LEAVE THE DAY-TO-DAY PICKER: their items are not offered when logging a store order, and come back when un-archived', async () => {
  const go = await goOrder('Picker GO'); const it = await item(go, 'Picker item'); await claim(u(), it); await close(go); const offered = async () => (await api('GET', '/api/admin/incoming')).json.options.some((o) => o.itemId === it);
  assert.equal(await offered(), true); await archive(go); assert.equal(await offered(), false); await api('POST', `/api/admin/orders/${go}/unarchive`, {}); assert.equal(await offered(), true);
});

test('JOINERS SEE NO CHANGE: their dashboard still lists claims from an archived order, exactly as before', async () => {
  const go = await goOrder('Joiner view GO'); const it = await item(go, 'Joiner item'); const h = u('jv'); const cookie = await joinerSession(app, `${h}@x.com`, h); await claim(h, it); await close(go);
  const before = (await api('GET', `/api/my/summary?handle=${h}`, undefined, cookie)).json; await archive(go); const after = (await api('GET', `/api/my/summary?handle=${h}`, undefined, cookie)).json; assert.deepEqual(after, before, 'identical');
  assert.equal(after.orders.flatMap((o) => o.claims).length, 1);
});

test('ONLY THE GOM, and unknown orders are not found', async () => {
  const go = await goOrder('Auth GO'); await close(go); const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj'));
  assert.equal((await archive(go, j)).status, 403); assert.equal((await app.api('POST', `/api/admin/orders/${go}/archive`, {})).status, 401); assert.equal((await api('POST', `/api/admin/orders/${go}/unarchive`, {}, j)).status, 403);
  assert.equal((await archive(99999999)).status, 404); assert.equal((await api('POST', '/api/admin/orders/99999999/unarchive', {})).status, 404); assert.equal((await row(go)).archivedAt, null, 'nothing happened');
});
