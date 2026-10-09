import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// Stage 1 of the alpha feedback: a proxy can be "me" (its orders are left out of proxy payments), and the packing list carries each item's picture.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 's1') => `${x}${++N}`;
const candidates = async () => (await api('GET', '/api/admin/proxy/candidates')).json.candidates;
const order = async (extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Stage1 GO '), ...extra })).json.id;
const item = async (go, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('S1 item '), price: 10, ...extra })).json.id;
const confirmedClaim = async (itemId) => { const h = u('p'); await claimAndSecure(app, admin, h, itemId); return h; };
const proxies = async () => (await api('GET', '/api/admin/proxy/names')).json.proxies;
const proxyId = async (name) => (await proxies()).find((p) => p.name === name).id;
const has = async (itemId) => (await candidates()).some((c) => c.key === `item:${itemId}`);

test('A PROXY CAN BE "ME": its orders drop out of "to pay a proxy"; un-ticking brings them back; other proxies are untouched', async () => {
  const name = u('Me Myself '), other = u('Sam ');
  const mine = await order({ proxy: name }), theirs = await order({ proxy: other });
  const [a, b] = [await item(mine), await item(theirs)];
  await confirmedClaim(a); await confirmedClaim(b);
  assert.ok(await has(a) && await has(b), 'both listed to begin with');
  const list = await proxies(); assert.deepEqual(list.find((p) => p.name === name), { id: await proxyId(name), name, isSelf: false });
  const r = await api('PATCH', `/api/admin/proxies/${await proxyId(name)}`, { isSelf: true });
  assert.deepEqual([r.status, r.json.isSelf], [200, true]);
  assert.equal(await has(a), false, 'my own orders are left out'); assert.equal(await has(b), true, 'another proxy\'s are not');
  assert.equal((await proxies()).find((p) => p.name === name).isSelf, true);
  await api('PATCH', `/api/admin/proxies/${await proxyId(name)}`, { isSelf: false });
  assert.equal(await has(a), true, 'untick: back in the list');
});

test('it applies to member sets too, and an ITEM\'s own proxy beats its order\'s', async () => {
  const me = u('Me '), sam = u('Sam ');
  const go = await order({ proxy: sam });
  const own = await item(go, { proxy: me });                                  // this item goes through me, though the order uses Sam
  const viaSam = await item(go);
  await confirmedClaim(own); await confirmedClaim(viaSam);
  await api('PATCH', `/api/admin/proxies/${await proxyId(me)}`, { isSelf: true });
  assert.equal(await has(own), false, 'the item is mine'); assert.equal(await has(viaSam), true, 'the rest of the order still goes through Sam');
  // an order that is mine, with an item that goes elsewhere
  const mineGo = await order({ proxy: me }); const away = await item(mineGo, { proxy: sam }); await confirmedClaim(away);
  assert.equal(await has(away), true, 'an item sent through another proxy still counts');
  // a set
  const setGo = await order({ proxy: me });
  const set = (await api('POST', `/api/admin/orders/${setGo}/items`, { type: 'set', title: u('S1 set '), price: 4, members: ['A', 'B'] })).json.id;
  await app.api('POST', '/api/claims', { handle: u('ps'), lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] });
  const sid = (await api('GET', '/api/admin/sets')).json.sets.find((s) => s.itemId === set).id; await api('POST', `/api/admin/sets/${sid}/secure`, {});
  assert.equal((await candidates()).some((c) => c.key === `set:${set}`), false, 'a secured set of mine is left out');
});

test('trying to log a payment for something that is mine is refused, with the reason; validation and access are as for every admin route', async () => {
  const me = u('Me '); const go = await order({ proxy: me }); const it = await item(go); await confirmedClaim(it);
  await api('PATCH', `/api/admin/proxies/${await proxyId(me)}`, { isSelf: true });
  const r = await api('POST', '/api/admin/proxy/payments', { proxy: 'Sam', keys: [`item:${it}`] });
  assert.equal(r.status, 400); assert.equal(r.json.code, 'self_proxy'); assert.match(r.json.error, /uses a proxy you've marked as yourself, so there's no proxy payment to log for it/);
  const id = await proxyId(me);
  assert.equal((await api('PATCH', `/api/admin/proxies/${id}`, { isSelf: 'yes' })).status, 400);
  assert.equal((await api('PATCH', '/api/admin/proxies/999999', { isSelf: true })).status, 404);
  const j = await app.login(`${u('j')}@x.com`);
  assert.equal((await api('PATCH', `/api/admin/proxies/${id}`, { isSelf: false }, j)).status, 403); assert.equal((await app.api('PATCH', `/api/admin/proxies/${id}`, { isSelf: false })).status, 401);
  assert.equal((await proxies()).find((p) => p.id === id).isSelf, true, 'nothing changed');
});

test('THE PACKING LIST CARRIES EACH ITEM\'S PICTURE (or null when there is none), including shop items, and the address is no longer needed to pack', async () => {
  const go = await order(); const withPic = await item(go, { title: 'Pic item' }), noPic = await item(go, { title: 'Plain item' });
  const png = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#39c' } }).png().toBuffer();
  const up = await fetch(`${app.base}/api/admin/images/item/${withPic}`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: png }); assert.equal(up.status, 200);
  const h = u('pk'); const cookie = await joinerSession(app, `${h}@x.com`, h);
  await api('PUT', '/api/my/address', { fullName: 'Pack Er', address: '1 Road, Leeds', email: `${h}@x.com`, phone: '0700123456' }, cookie);
  const ids = []; for (const it of [withPic, noPic]) { const [id] = await claimAndSecure(app, admin, h, it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' }); ids.push(id); }
  const par = await api('POST', '/api/my/parcels', { claimIds: ids, method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, cookie); assert.equal(par.status, 201);
  const parcel = (await api('GET', '/api/admin/packing')).json.parcels.find((p) => p.id === par.json.id);
  const pic = parcel.items.find((i) => i.label.includes('Pic item')), plain = parcel.items.find((i) => i.label.includes('Plain item'));
  assert.ok(pic.image.thumb && pic.image.url, JSON.stringify(pic.image)); assert.equal(plain.image, null);
  assert.ok(!('imgFile' in pic), 'no raw picture columns leak out');
  // tick everything except the address, and it packs
  await api('POST', `/api/admin/parcels/${par.json.id}/items-packed`, { packed: true });
  await api('POST', `/api/admin/parcels/${par.json.id}/checks`, { lomo: true });
  await api('PUT', `/api/admin/parcels/${par.json.id}/fees`, { domsTotal: 3, packagingTotal: 1 });
  const packed = await api('POST', `/api/admin/parcels/${par.json.id}/packed`, { confirmed: true });
  assert.equal(packed.status, 200, packed.text);
});
