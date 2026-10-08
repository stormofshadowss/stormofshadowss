import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (p = 'dl') => `${p}${++N}`;
const dir = () => app.cfg.uploadsDir;
const picFiles = () => fs.readdirSync(dir()).filter((f) => f.endsWith('.webp'));
const png = () => sharp({ create: { width: 60, height: 40, channels: 3, background: '#3a7bd5' } }).png().toBuffer();
const put = async (kind, id) => fetch(`${app.base}/api/admin/images/${kind}/${id}`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: await png() }).then((r) => r.status);
const order = async (title = u('Delete GO ')) => (await api('POST', '/api/admin/orders', { groupId: w.group, title })).json.id;
const item = async (go, body = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price: 5, ...body })).json.id;
const exists = async (table, id) => (await app.q(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`, [id]))[0].n === 1;
const check = (what, id) => api('GET', `/api/admin/${what}/${id}/delete-check`);
const del = (what, id, c = admin) => api('DELETE', `/api/admin/${what}/${id}`, undefined, c);
const claimOf = async (h, itemId) => { await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId }] }); return (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims.at(-1); };

test('deleting an item with nothing on it: it goes, with its members, sizes and picture; the order stays', async () => {
  const go = await order();
  const ind = await item(go, { type: 'independent', members: ['Han', 'Felix'] }), sized = await item(go, { type: 'size', variants: ['M', 'L'] }), keep = await item(go);
  assert.equal(await put('item', ind), 200);
  const before = picFiles().length;
  const c = (await check('items', ind)).json;
  assert.deepEqual([c.canDelete, c.blockers, c.removes.claims, c.removes.pictures], [true, [], 0, 1]);
  const r = await del('items', ind);
  assert.equal(r.status, 200);
  assert.equal(await exists('items', ind), false);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM item_members WHERE item_id = ?', [ind]))[0].n, 0, 'its members went with it');
  assert.equal(picFiles().length, before - 2, 'and its picture (full size and thumbnail) is off the disk');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM images'))[0].n, (await app.q('SELECT COUNT(*) AS n FROM items WHERE image_id IS NOT NULL UNION ALL SELECT COUNT(*) FROM group_orders WHERE cover_image_id IS NOT NULL UNION ALL SELECT COUNT(*) FROM artist_groups WHERE cover_image_id IS NOT NULL UNION ALL SELECT COUNT(*) FROM leftover_items WHERE image_id IS NOT NULL')).reduce((s, x) => s + x.n, 0), 'no picture record is left unattached');
  assert.ok(await exists('items', sized) && await exists('items', keep) && await exists('group_orders', go));
  assert.equal((await api('GET', '/api/orders')).json.orders.flatMap((o) => o.items).some((i) => i.id === ind), false, 'and it is gone from the shop');
  assert.equal((await del('items', ind)).status, 404, 'already gone');
});

test('unconfirmed requests are not binding: they are removed with the item, and the check says how many people that affects', async () => {
  const go = await order(); const it = await item(go);
  const [a, b] = [u(), u()];
  await claimOf(a, it); await claimOf(a, it); await claimOf(b, it);
  const c = (await check('items', it)).json;
  assert.deepEqual([c.canDelete, c.removes.claims, c.removes.people], [true, 3, 2]);
  assert.equal((await del('items', it)).status, 200);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE item_id = ?', [it]))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE item_id IS NULL AND leftover_item_id IS NULL'))[0].n, 0, 'nothing is left pointing at nothing');
  assert.equal((await api('GET', `/api/admin/claims?handle=${a}`)).json.claims.length, 0);
});

test('a member set goes with its sets, slots and fixed claimers — and the people who had parts lose those requests', async () => {
  const go = await order();
  const set = await item(go, { type: 'set', members: ['A', 'B'], price: 4 });
  const h = u(); await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] });
  assert.equal((await api('POST', `/api/admin/items/${set}/fixed`, { handle: u(), member: 'B' })).status, 201);
  const c = (await check('items', set)).json;
  assert.deepEqual([c.canDelete, c.removes.sets, c.removes.fixed, c.removes.claims], [true, 1, 1, 2]);
  assert.equal((await del('items', set)).status, 200);
  for (const t of ['item_sets', 'fixed_claims']) assert.equal((await app.q(`SELECT COUNT(*) AS n FROM ${t} WHERE item_id = ?`, [set]))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM set_slots WHERE set_id NOT IN (SELECT id FROM item_sets)'))[0].n, 0, 'no slot is left without its set');
});

test('REFUSED: a confirmed claim is a real order — nothing is deleted, and it says what to do; once cancelled (and never paid) it can go', async () => {
  const go = await order(); const it = await item(go);
  const h = u(); await joinerSession(app, `${h}@x.com`, h);
  const [id] = await claimAndSecure(app, admin, h, it);
  const c = (await check('items', it)).json;
  assert.equal(c.canDelete, false); assert.equal(c.blockers[0].kind, 'confirmed');
  assert.match(c.blockers[0].message, /1 confirmed claim \(1 person\) — those are real orders\. Cancel them first on the Claims tab, then delete\./);
  const r = await del('items', it);
  assert.equal(r.status, 409); assert.equal(r.json.code, 'cannot_delete'); assert.match(r.json.error, /This can't be deleted: 1 confirmed claim/);
  assert.ok(await exists('items', it)); assert.equal((await api('GET', `/api/admin/claims?handle=${h}`)).json.claims.length, 1, 'nothing was touched');
  await api('PATCH', `/api/admin/claims/${id}`, { status: 'cancelled' });
  assert.equal((await del('items', it)).status, 200, 'cancelled with nothing ever paid: fine');
  assert.equal(await exists('items', it), false);
});

test('REFUSED: money, a parcel or a box behind a claim — even a cancelled one — means its records must stay', async () => {
  const go = await order(); const it = await item(go, { price: 10 });
  const h = u(); const cookie = await joinerSession(app, `${h}@x.com`, h);
  const [id] = await claimAndSecure(app, admin, h, it);
  const p = await api('POST', '/api/my/payments', { method: 'PayPal', amount: 10, reference: 'X' }, cookie); await api('POST', `/api/admin/payments/${p.json.id}/verify`, {});
  await api('PATCH', `/api/admin/claims/${id}`, { status: 'cancelled' });                       // refunded as credit, but the payment history remains
  const c = (await check('items', it)).json;
  assert.equal(c.canDelete, false);
  assert.deepEqual(c.blockers.map((b) => b.kind), ['history']);
  assert.match(c.blockers[0].message, /1 claim has payments, a parcel or a box behind it, and those records have to stay\. Close it and make it private instead/);
  assert.equal((await del('items', it)).status, 409); assert.ok(await exists('items', it));
  assert.equal((await del('orders', go)).status, 409, 'and so can its order');
  assert.ok(await exists('group_orders', go));
});

test('REFUSED: an item that has been included in a proxy payment', async () => {
  const go = await order(); const it = await item(go);
  const h = u(); await joinerSession(app, `${h}@x.com`, h);
  const [id] = await claimAndSecure(app, admin, h, it);
  assert.equal((await api('POST', '/api/admin/proxy/payments', { proxy: 'Sam', keys: [`item:${it}`] })).status, 201);
  await api('PATCH', `/api/admin/claims/${id}`, { status: 'cancelled' });
  const c = (await check('items', it)).json;
  assert.ok(c.blockers.some((b) => b.kind === 'proxy' && /included in a proxy payment/.test(b.message)));
  assert.equal((await del('items', it)).status, 409);
});

test('DELETING A WHOLE GROUP ORDER: its items, requests and pictures all go; unattached payments keep existing; artists and other orders are untouched', async () => {
  const go = await order(); const other = await order();
  const [i1, i2] = [await item(go), await item(go)];
  const keepItem = await item(other);
  assert.equal(await put('order', go), 200); assert.equal(await put('item', i1), 200);
  const files0 = picFiles().length;
  const h = u(); const cookie = await joinerSession(app, `${h}@x.com`, h);
  await claimOf(h, i1); await claimOf(h, i2);
  const pay = await api('POST', '/api/my/payments', { method: 'PayPal', amount: 3, reference: 'P', orderId: go }, cookie);
  const c = (await check('orders', go)).json;
  assert.deepEqual([c.canDelete, c.removes.items, c.removes.claims, c.removes.people, c.removes.pictures], [true, 2, 2, 1, 2]);
  assert.equal((await del('orders', go)).status, 200);
  assert.equal(await exists('group_orders', go), false);
  for (const id of [i1, i2]) assert.equal(await exists('items', id), false);
  assert.equal(picFiles().length, files0 - 4, 'both pictures (and their thumbnails) are off the disk');
  assert.ok(await exists('group_orders', other) && await exists('items', keepItem) && await exists('artist_groups', w.group), 'nothing else was touched');
  if (pay.status === 201) assert.equal((await app.q('SELECT order_id FROM payments WHERE id = ?', [pay.json.id]))[0].order_id, null, 'the payment still exists, no longer tied to a deleted order');
  assert.equal((await del('orders', go)).status, 404);
  assert.equal((await check('orders', 999999)).status, 404);
});

test('one confirmed claim anywhere in the order stops the whole order being deleted — and the reason names the count', async () => {
  const go = await order(); const [i1, i2] = [await item(go), await item(go)];
  const h = u(); await joinerSession(app, `${h}@x.com`, h);
  await claimAndSecure(app, admin, h, i2);
  const c = (await check('orders', go)).json;
  assert.equal(c.canDelete, false); assert.match(c.blockers[0].message, /1 confirmed claim/);
  assert.equal((await del('orders', go)).status, 409);
  assert.ok(await exists('items', i1) && await exists('items', i2) && await exists('group_orders', go), 'not even the harmless item was deleted');
});

test('concurrency: someone claiming an item at the instant it is deleted either lands in the deletion or is told it is gone — never an orphan', async () => {
  for (let round = 0; round < 4; round++) {
    const go = await order(); const it = await item(go);
    const hs = Array.from({ length: 4 }, () => u('race'));
    const rs = await Promise.all([...hs.map((h) => app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: it }] })), del('items', it)]);
    assert.ok(rs.every((r) => [200, 201, 404, 409].includes(r.status)), `round ${round}: ${rs.map((r) => r.status)}`);
    assert.equal(rs.at(-1).status, 200, 'the delete itself always succeeds (requests are not binding)');
    assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE item_id = ?', [it]))[0].n, 0);
    assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE item_id IS NULL AND leftover_item_id IS NULL'))[0].n, 0, `round ${round}: no orphan claim`);
  }
});

test('only the GOM can delete or check; every delete is recorded', async () => {
  const go = await order(); const it = await item(go);
  const j = await app.login('del.joiner@x.com');
  for (const [m, p] of [['DELETE', `/api/admin/items/${it}`], ['DELETE', `/api/admin/orders/${go}`], ['GET', `/api/admin/items/${it}/delete-check`], ['GET', `/api/admin/orders/${go}/delete-check`]]) {
    assert.equal((await api(m, p, undefined, j)).status, 403, `${m} ${p}`); assert.equal((await app.api(m, p)).status, 401);
  }
  assert.ok(await exists('items', it));
  await del('items', it); await del('orders', go);
  const log = await app.q("SELECT action, detail FROM audit_log WHERE action IN ('item.delete','order.delete') ORDER BY id DESC LIMIT 2");
  assert.deepEqual(log.map((l) => l.action).sort(), ['item.delete', 'order.delete']);
});

test('INVARIANTS: no orphaned sets, members, variants or picture records; every picture record is in use', async () => {
  for (const [t, col, parent] of [['item_members', 'item_id', 'items'], ['item_variants', 'item_id', 'items'], ['item_sets', 'item_id', 'items'], ['fixed_claims', 'item_id', 'items'], ['items', 'order_id', 'group_orders']]) {
    assert.equal((await app.q(`SELECT COUNT(*) AS n FROM ${t} x LEFT JOIN ${parent} p ON p.id = x.${col} WHERE p.id IS NULL`))[0].n, 0, t);
  }
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM images i WHERE NOT EXISTS (SELECT 1 FROM items WHERE image_id = i.id) AND NOT EXISTS (SELECT 1 FROM group_orders WHERE cover_image_id = i.id) AND NOT EXISTS (SELECT 1 FROM artist_groups WHERE cover_image_id = i.id) AND NOT EXISTS (SELECT 1 FROM leftover_items WHERE image_id = i.id)'))[0].n, 0);
});
