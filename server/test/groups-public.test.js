import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startApp } from './helpers.js';

// GET /api/groups: the artists/groups shown on the site and how many public orders each has open or closed — what the group pages are built from.
let app, admin, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'G') => `${x}${++N}`;
const group = async (name = u()) => (await api('POST', '/api/admin/groups', { name })).json.id;
const order = async (groupId, extra = {}) => (await api('POST', '/api/admin/orders', { groupId, title: u('Order '), ...extra })).json.id;
const groups = async () => (await fetch(`${app.base}/api/groups`).then((r) => r.json())).groups;
const find = async (id) => (await groups()).find((g) => g.id === id);

test('anyone can read it (no sign-in); each group has its id, name, cover and counts of open and closed orders', async () => {
  const r = await fetch(`${app.base}/api/groups`); assert.equal(r.status, 200);
  const g = await group('Counting Crew'); await order(g); await order(g); await order(g, { status: 'closed' });
  assert.deepEqual(await find(g), { id: g, name: 'Counting Crew', kind: null, cover: null, openOrders: 2, closedOrders: 1 });
});

test('a brand-new group appears straight away with no orders (so its page exists as soon as it is created); a cover picture shows', async () => {
  const g = await group(u('Fresh '));
  const f = await find(g); assert.deepEqual([f.openOrders, f.closedOrders, f.cover], [0, 0, null]);
  const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#c33' } }).png().toBuffer();
  const up = await fetch(`${app.base}/api/admin/images/group/${g}`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: png });
  assert.equal(up.status, 200);
  const c = (await find(g)).cover; assert.ok(c && c.thumb && c.url, JSON.stringify(c));
});

test('private orders are never counted or hinted at; closed ones count as closed; a group with nothing open reports 0', async () => {
  const g = await group(u('Mixed ')); await order(g, { isPrivate: true }); await order(g, { isPrivate: true, status: 'closed' }); await order(g, { status: 'closed' });
  assert.deepEqual([(await find(g)).openOrders, (await find(g)).closedOrders], [0, 1]);
  const open = await order(g); assert.equal((await find(g)).openOrders, 1, 'it counts the moment an order opens');
  await api('PATCH', `/api/admin/orders/${open}`, { status: 'closed' }); assert.deepEqual([(await find(g)).openOrders, (await find(g)).closedOrders], [0, 2]);
});

test('hidden groups (like the off-site holder) are not listed; groups come in the GOM\'s order, then by name', async () => {
  const hidden = await group(u('Hidden ')); await app.q('UPDATE artist_groups SET is_hidden = 1 WHERE id = ?', [hidden]); await order(hidden);
  assert.equal(await find(hidden), undefined);
  const [a, b] = [await group('Zed Group'), await group('Alpha Group')];
  await app.q('UPDATE artist_groups SET sort_order = 100 WHERE id IN (?, ?)', [a, b]);
  const names = (await groups()).filter((g) => [a, b].includes(g.id)).map((g) => g.name); assert.deepEqual(names, ['Alpha Group', 'Zed Group']);
  const all = await groups(); const orders = all.map((g) => g.id); assert.ok(orders.indexOf(a) > orders.indexOf(b));
});

test('each public order now says which group it belongs to by id (that is how a group page finds its orders)', async () => {
  const g = await group(u('Owner ')); const o = await order(g);
  const pub = (await fetch(`${app.base}/api/orders`).then((r) => r.json())).orders.find((x) => x.id === o);
  assert.deepEqual([pub.groupId, pub.group], [g, (await find(g)).name]);
});
