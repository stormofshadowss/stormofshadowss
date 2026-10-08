import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { startApp, seed } from './helpers.js';

let app, admin, w, grp;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  grp = (await app.api('GET', '/api/admin/groups', undefined, admin)).json.groups[0].id;
  w.shop = (await app.api('POST', '/api/admin/shop', { title: 'Pic shop item', price: 5, qty: 2 }, admin)).json.id;
});
after(async () => { await app.stop(); });

const dir = () => app.cfg.uploadsDir;
const files = () => fs.readdirSync(dir()).sort();
const rows = async () => app.q('SELECT id, filename, mime, width, height, bytes FROM images ORDER BY id');
// raw upload: the browser sends the file's bytes as the body
const put = (kind, id, body, { type = 'image/png', cookie = admin, csrf = true } = {}) =>
  fetch(`${app.base}/api/admin/images/${kind}/${id}`, { method: 'PUT', headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'X-Requested-With': 'sos' } : {}), 'Content-Type': type }, body })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const del = (kind, id, cookie = admin) => app.api('DELETE', `/api/admin/images/${kind}/${id}`, undefined, cookie);
const make = (w2, h, fmt = 'png', bg = '#3a7bd5') => sharp({ create: { width: w2, height: h, channels: 3, background: bg } })[fmt]().toBuffer();
const meta = (name) => sharp(fs.readFileSync(path.join(dir(), name))).metadata();
const pubItem = async (id) => (await app.api('GET', '/api/orders')).json.orders.flatMap((o) => o.items).find((i) => i.id === id);

test('uploading: shrunk to fit 1200px, saved as WebP with a thumbnail, recorded, and shown on the item in the catalogue', async () => {
  const r = await put('item', w.keyring, await make(3000, 2000));
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.image.width, r.json.image.height], [1200, 800]);
  const [row] = (await rows()).slice(-1);
  assert.deepEqual([row.mime, row.width, row.height, row.filename], ['image/webp', 1200, 800, r.json.image.url.replace('/uploads/', '')]);
  assert.ok(row.bytes > 0 && row.bytes < 60000, 'much smaller than the original');
  assert.deepEqual(files().filter((f) => f.startsWith(row.filename.slice(0, 32))), [row.filename.replace('.webp', '-t.webp'), row.filename].sort());
  const [full, thumb] = [await meta(row.filename), await meta(row.filename.replace('.webp', '-t.webp'))];
  assert.deepEqual([full.format, full.width, thumb.format, thumb.width, thumb.height], ['webp', 1200, 'webp', 480, 320]);
  const item = await pubItem(w.keyring);
  assert.deepEqual(item.image, { url: r.json.image.url, thumb: r.json.image.thumb, width: 1200, height: 800 });
});

test('a small picture is NOT enlarged, and every common format is accepted (JPEG, PNG, WebP, GIF)', async () => {
  const [a, b, c, d] = [await make(400, 300, 'jpeg'), await make(400, 300, 'png'), await make(400, 300, 'webp'), await make(400, 300, 'gif')];
  for (const [i, buf] of [a, b, c, d].entries()) {
    const r = await put('item', w.hoodie, buf, { type: 'application/octet-stream' });
    assert.equal(r.status, 200, `format #${i}`);
    assert.deepEqual([r.json.image.width, r.json.image.height], [400, 300]);
  }
});

test('the file name and claimed type are never trusted: a real picture labelled as text is fine; text labelled as a picture is refused', async () => {
  assert.equal((await put('item', w.album, await make(100, 100), { type: 'text/plain' })).status, 200);
  const fake = await put('item', w.photocards, Buffer.from('this is not a picture at all'), { type: 'image/jpeg' });
  assert.equal(fake.status, 400); assert.equal(fake.json.code, 'not_an_image'); assert.match(fake.json.error, /JPEG, PNG, WebP or GIF/);
});

test('things that are not safe or usable pictures are refused: SVG, PDF, empty, truncated, and a picture bomb', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/><script>alert(1)</script></svg>');   // perfectly drawable — refused because of what it is
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
  const good = await make(800, 600, 'jpeg');
  const before = (await rows()).length;
  for (const [name, body, type] of [['svg', svg, 'image/svg+xml'], ['pdf', pdf, 'application/pdf'], ['truncated', good.subarray(0, 200), 'image/jpeg'], ['garbage', Buffer.from(Array.from({ length: 500 }, (_, i) => (i * 37) % 251)), 'image/png']]) {
    const r = await put('item', w.keyring, body, { type });
    assert.equal(r.status, 400, name); assert.equal(r.json.code, 'not_an_image', name);
  }
  const none = await put('item', w.keyring, Buffer.alloc(0));
  assert.equal(none.status, 400);
  const bomb = await put('item', w.keyring, await sharp({ create: { width: 7000, height: 7000, channels: 3, background: '#fff' } }).png({ compressionLevel: 9 }).toBuffer());
  assert.equal(bomb.status, 400); assert.equal(bomb.json.code, 'too_many_pixels'); assert.match(bomb.json.error, /over 40 megapixels/);
  assert.equal((await rows()).length, before, 'nothing was stored for any of them');
});

test('too big a file is refused with the limit stated, before anything is processed', async () => {
  const r = await put('item', w.keyring, Buffer.alloc(9 * 1024 * 1024, 1));
  assert.equal(r.status, 413); assert.equal(r.json.code, 'too_big'); assert.match(r.json.error, /limit is 8 MB/);
});

test('hidden data in a photo is stripped: location and camera details do not survive, and the camera rotation is applied', async () => {
  const withGps = await sharp({ create: { width: 600, height: 300, channels: 3, background: '#a33' } })
    .jpeg().withExif({ IFD0: { Copyright: 'SECRET-OWNER', ImageDescription: 'taken at my house' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '53/1 59/1 0/1' } }).toBuffer();
  assert.ok((await sharp(withGps).metadata()).exif, 'the test photo really does carry metadata');
  assert.ok(withGps.includes(Buffer.from('SECRET-OWNER')));
  const r = await put('item', w.keyring, withGps, { type: 'image/jpeg' });
  const name = r.json.image.url.replace('/uploads/', '');
  for (const f of [name, name.replace('.webp', '-t.webp')]) {
    const raw = fs.readFileSync(path.join(dir(), f));
    assert.equal((await sharp(raw).metadata()).exif, undefined, `${f}: no EXIF`);
    assert.ok(!raw.includes(Buffer.from('SECRET-OWNER')) && !raw.includes(Buffer.from('my house')), `${f}: nothing identifying in the bytes`);
  }
  // a phone photo held sideways: stored 600x300 with an orientation flag; shown upright it is 300x600
  const sideways = await sharp({ create: { width: 600, height: 300, channels: 3, background: '#3a3' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const s = await put('item', w.hoodie, sideways, { type: 'image/jpeg' });
  assert.deepEqual([s.json.image.width, s.json.image.height], [300, 600]);
});

test('an animated GIF becomes a still picture (its first frame)', async () => {
  const gif = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#0af' } }).gif().toBuffer();
  const r = await put('shop', w.shop, gif, { type: 'image/gif' });
  assert.equal(r.status, 200); assert.equal((await meta(r.json.image.url.replace('/uploads/', ''))).pages, undefined);
});

test('all four places can have a picture, and it appears in the right place for joiners and for the GOM', async () => {
  const [item, shop, order, group] = [await put('item', w.album, await make(500, 500)), await put('shop', w.shop, await make(500, 400)), await put('order', w.order, await make(600, 300)), await put('group', grp, await make(300, 300))];
  for (const r of [item, shop, order, group]) assert.equal(r.status, 200);
  const cat = (await app.api('GET', '/api/orders')).json.orders.find((o) => o.id === w.order);
  assert.deepEqual([cat.cover.url, cat.groupCover.url], [order.json.image.url, group.json.image.url]);
  assert.equal(cat.items.find((i) => i.id === w.album).image.url, item.json.image.url);
  assert.equal((await app.api('GET', '/api/shop')).json.items.find((i) => i.id === w.shop).image.url, shop.json.image.url);
  assert.equal((await app.api('GET', '/api/admin/shop', undefined, admin)).json.items.find((i) => i.id === w.shop).image.url, shop.json.image.url);
  assert.equal((await app.api('GET', '/api/admin/groups', undefined, admin)).json.groups.find((g) => g.id === grp).cover.url, group.json.image.url);
  assert.equal((await app.api('GET', '/api/admin/orders', undefined, admin)).json.orders.find((o) => o.id === w.order).cover.url, order.json.image.url);
  assert.equal((await pubItem(w.photocards)).image, null, 'items without a picture say so');
});

test('replacing a picture deletes the old one — the record and both files — so nothing piles up', async () => {
  const first = await put('item', w.hoodie, await make(300, 300, 'png', '#111'));
  const oldName = first.json.image.url.replace('/uploads/', '');
  const second = await put('item', w.hoodie, await make(300, 300, 'png', '#eee'));
  const newName = second.json.image.url.replace('/uploads/', '');
  assert.notEqual(oldName, newName);
  assert.equal(fs.existsSync(path.join(dir(), oldName)), false); assert.equal(fs.existsSync(path.join(dir(), oldName.replace('.webp', '-t.webp'))), false);
  assert.ok(fs.existsSync(path.join(dir(), newName)));
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM images WHERE filename = ?', [oldName]))[0].n, 0);
  assert.equal((await pubItem(w.hoodie)).image.url, second.json.image.url);
});

test('removing a picture deletes it everywhere; removing when there is none is harmless', async () => {
  const r = await put('item', w.photocards, await make(200, 200));
  const name = r.json.image.url.replace('/uploads/', '');
  const d = await del('item', w.photocards);
  assert.deepEqual([d.status, d.json.removed], [200, true]);
  assert.equal((await pubItem(w.photocards)).image, null);
  assert.equal(fs.existsSync(path.join(dir(), name)), false); assert.equal(fs.existsSync(path.join(dir(), name.replace('.webp', '-t.webp'))), false);
  assert.deepEqual([(await del('item', w.photocards)).status, (await del('item', w.photocards)).json.removed], [200, false]);
});

test('serving: pictures are WebP with a year-long cache and no sniffing; made-up, tampered or non-picture names are 404', async () => {
  const r = await put('item', w.keyring, await make(400, 400));
  const g = await fetch(app.base + r.json.image.url);
  assert.deepEqual([g.status, g.headers.get('content-type'), g.headers.get('x-content-type-options')], [200, 'image/webp', 'nosniff']);
  assert.match(g.headers.get('cache-control'), /max-age=31536000.*immutable/);
  assert.equal((await fetch(app.base + r.json.image.thumb)).status, 200);
  for (const bad of ['/uploads/', '/uploads/nothing.webp', '/uploads/00000000000000000000000000000000.webp', '/uploads/../package.json', '/uploads/%2e%2e/package.json', `/uploads/${r.json.image.url.slice(9, 41)}.png`, `/uploads/${r.json.image.url.slice(9, 41)}.webp/../x`]) {
    assert.equal((await fetch(app.base + bad)).status, 404, bad);
  }
});

test('only the GOM can add or remove pictures; unknown places and items are not found; the CSRF header is required', async () => {
  const joiner = await app.login('pic.joiner@x.com');
  const img = await make(50, 50);
  assert.equal((await put('item', w.keyring, img, { cookie: joiner })).status, 403);
  assert.equal((await put('item', w.keyring, img, { cookie: null })).status, 401);
  assert.equal((await del('item', w.keyring, joiner)).status, 403);
  assert.equal((await app.api('DELETE', `/api/admin/images/item/${w.keyring}`)).status, 401);
  assert.equal((await put('item', w.keyring, img, { csrf: false })).status, 403, 'a cross-site form could not do this');
  assert.equal((await put('banana', 1, img)).status, 404); assert.equal((await put('item', 999999, img)).status, 404); assert.equal((await put('item', 'abc', img)).status, 404);
  assert.equal((await del('banana', 1)).status, 404);
});

test('if the uploads folder cannot be written, the GOM is told plainly and nothing half-saves', async () => {
  const before = (await rows()).length, real = app.cfg.uploadsDir;
  const aFile = path.join(real, 'not-a-folder.txt'); fs.writeFileSync(aFile, 'x');
  app.cfg.uploadsDir = path.join(aFile, 'pictures');                              // a folder underneath a plain file: it can never be created
  try {
    const r = await put('item', w.keyring, await make(100, 100));
    assert.equal(r.status, 500); assert.equal(r.json.code, 'uploads_unwritable'); assert.match(r.json.error, /uploads folder isn't writable/);
  } finally { app.cfg.uploadsDir = real; fs.rmSync(aFile, { force: true }); }
  assert.equal((await rows()).length, before);
});

test('STRESS: six uploads to the same item at the same instant leave exactly one picture — one record, one pair of files, all consistent', async () => {
  const id = (await app.api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: 'Race item', price: 1 }, admin)).json.id;
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => make(300 + i * 10, 300, 'png', `#${i}${i}${i}`).then((b) => put('item', id, b))));
  assert.ok(rs.every((r) => r.status === 200));
  const final = await pubItem(id);
  const name = final.image.url.replace('/uploads/', '');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM images i JOIN items it ON it.image_id = i.id WHERE it.id = ?', [id]))[0].n, 1);
  assert.ok(fs.existsSync(path.join(dir(), name)));
});

test('INVARIANTS: every file on disk belongs to a record and every record has both its files — no orphans either way', async () => {
  const recs = await rows();
  const expected = recs.flatMap((r) => [r.filename, r.filename.replace('.webp', '-t.webp')]).sort();
  assert.deepEqual(files(), expected);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM images i WHERE NOT EXISTS (SELECT 1 FROM items x WHERE x.image_id = i.id) AND NOT EXISTS (SELECT 1 FROM leftover_items x WHERE x.image_id = i.id) AND NOT EXISTS (SELECT 1 FROM group_orders x WHERE x.cover_image_id = i.id) AND NOT EXISTS (SELECT 1 FROM artist_groups x WHERE x.cover_image_id = i.id)'))[0].n, 0, 'no picture records nobody uses');
});
