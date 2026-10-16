import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';

// On-hand (shop) items can belong to an artist group, so the Shop page can be filtered by artist like the home page. No group (or a hidden one) = "Other".
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const group = async (name) => (await api('POST', '/api/admin/groups', { name: `${name} ${++N}` })).json.id;
const addItem = async (o = {}) => { const r = await api('POST', '/api/admin/shop', { title: `Shop thing ${++N}`, price: 3, qty: 4, ...o }); assert.equal(r.status, 201, r.text); return r.json.id; };
const pub = async () => (await app.api('GET', '/api/shop')).json;
const adm = async () => (await api('GET', '/api/admin/shop')).json.items;

test('THE PUBLIC LIST SAYS WHICH ARTIST EACH ITEM IS, and lists the artists that have something on the shelf (not ones with nothing, or only inactive items)', async () => {
  const [a, b, empty, inactiveOnly] = [await group('Ateez'), await group('Stray Kids'), await group('Nobody here'), await group('Ghost')];
  const x = await addItem({ groupId: a }), y = await addItem({ groupId: b }), z = await addItem({ groupId: b }), loose = await addItem(); const gone = await addItem({ groupId: inactiveOnly }); await api('PATCH', `/api/admin/shop/${gone}`, { active: false });
  const { items, groups } = await pub(); const by = (id) => items.find((i) => i.id === id);
  assert.deepEqual([by(x).groupId, by(y).groupId, by(z).groupId, by(loose).groupId], [a, b, b, null]); const ids = groups.map((g) => g.id);
  assert.ok(ids.includes(a) && ids.includes(b), 'artists with items are listed'); assert.ok(!ids.includes(empty), 'an artist with nothing on the shelf is not'); assert.ok(!ids.includes(inactiveOnly), 'nor one whose only items are switched off');
  assert.deepEqual(Object.keys(groups.find((g) => g.id === a)).sort(), ['cover', 'id', 'name'], 'just what the avatar needs'); assert.ok(!('qty' in by(x)), 'and still nothing about stock levels');
});

test('ARTISTS ARE LISTED IN THE SAME ORDER AS THE HOME PAGE (sort order, then name)', async () => {
  const [late, early] = [await group('Zed'), await group('Abe')]; await addItem({ groupId: late }); await addItem({ groupId: early });
  await app.q('UPDATE artist_groups SET sort_order = 900 WHERE id = ?', [late]); await app.q('UPDATE artist_groups SET sort_order = 901 WHERE id = ?', [early]);
  const order = (await pub()).groups.map((g) => g.id); assert.ok(order.indexOf(late) < order.indexOf(early), 'sort order wins over name'); const home = (await app.api('GET', '/api/groups')).json.groups.map((g) => g.id).filter((id) => order.includes(id)); assert.deepEqual(order, home, 'the same order the home page uses');
});

test('AN ITEM IN A HIDDEN GROUP IS SHOWN UNDER "OTHER" (no group id, and the hidden group is not offered), like an item with no group', async () => {
  const g = await group('Hidden crew'); const it = await addItem({ groupId: g }); await app.q('UPDATE artist_groups SET is_hidden = 1 WHERE id = ?', [g]);
  const { items, groups } = await pub(); assert.equal(items.find((i) => i.id === it).groupId, null); assert.ok(!groups.some((x) => x.id === g)); assert.equal((await adm()).find((i) => i.id === it).groupId, g, 'but the GOM still sees the real group');
});

test('THE GOM CAN SET, CHANGE AND CLEAR AN ITEM\'S ARTIST (on create or edit); an unknown artist is refused and nothing changes', async () => {
  const [a, b] = [await group('One'), await group('Two')]; const id = await addItem({ groupId: a }); assert.equal((await adm()).find((i) => i.id === id).groupId, a);
  assert.equal((await api('PATCH', `/api/admin/shop/${id}`, { groupId: b })).status, 200); assert.equal((await adm()).find((i) => i.id === id).groupId, b);
  assert.equal((await api('PATCH', `/api/admin/shop/${id}`, { title: 'Renamed' })).status, 200); assert.equal((await adm()).find((i) => i.id === id).groupId, b, 'editing something else leaves the artist alone');
  assert.equal((await api('PATCH', `/api/admin/shop/${id}`, { groupId: null })).status, 200); assert.equal((await adm()).find((i) => i.id === id).groupId, null, 'cleared');
  const bad1 = await api('PATCH', `/api/admin/shop/${id}`, { groupId: 999999 }); assert.equal(bad1.status, 400); assert.equal(bad1.json.code, 'no_group'); const bad2 = await api('POST', '/api/admin/shop', { title: 'x', price: 2, qty: 1, groupId: 999999 }); assert.equal(bad2.status, 400);
  assert.equal((await adm()).find((i) => i.id === id).groupId, null, 'the refused edit changed nothing');
});

test('BULK: several items can be sorted into an artist at once (or taken out); bad input is refused; GOM only; recorded', async () => {
  const g = await group('Bulk crew'); const ids = [await addItem(), await addItem(), await addItem()];
  const r = await api('POST', '/api/admin/shop/group', { itemIds: ids, groupId: g }); assert.equal(r.status, 200, r.text); assert.equal(r.json.updated, 3); assert.ok((await adm()).filter((i) => ids.includes(i.id)).every((i) => i.groupId === g));
  assert.equal((await api('POST', '/api/admin/shop/group', { itemIds: [ids[0]], groupId: null })).json.updated, 1); assert.equal((await adm()).find((i) => i.id === ids[0]).groupId, null, 'taken out of any group'); assert.equal((await adm()).find((i) => i.id === ids[1]).groupId, g, 'the others untouched');
  assert.equal((await api('POST', '/api/admin/shop/group', { itemIds: ids, groupId: 999999 })).status, 400); assert.equal((await api('POST', '/api/admin/shop/group', { itemIds: [], groupId: g })).status, 400); assert.equal((await api('POST', '/api/admin/shop/group', { itemIds: ['x'], groupId: g })).status, 400);
  const j = await app.login(`sg${++N}@x.com`); assert.equal((await api('POST', '/api/admin/shop/group', { itemIds: ids, groupId: g }, j)).status, 403); assert.equal((await app.api('POST', '/api/admin/shop/group', { itemIds: ids, groupId: g })).status, 401);
  const log = (await app.q("SELECT detail FROM audit_log WHERE action = 'shop.group' ORDER BY id DESC LIMIT 1"))[0]; assert.match(String(log.detail), /"count":/);
});

test('IF A GROUP IS DELETED its items are not lost: they simply have no group', async () => {
  const g = await group('Doomed'); const it = await addItem({ groupId: g }); await app.q('DELETE FROM artist_groups WHERE id = ?', [g]); assert.equal((await adm()).find((i) => i.id === it).groupId, null); assert.equal((await pub()).items.find((i) => i.id === it).groupId, null);
});
