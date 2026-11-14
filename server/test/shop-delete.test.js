import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { startApp, seed, joinerSession } from './helpers.js';

// DELETING A SHOP LISTING. Nobody ever claimed it → gone for good (with its options and picture). It has claim rows → it can't be erased, so it is archived: off every list, kept for the claims.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'Thing ') => `${x}${++N}`;
const mk = async (title, extra = {}) => (await api('POST', '/api/admin/shop', { title, price: 4, qty: 3, ...extra })).json.id;
const claim = (id, h, extra = {}) => app.api('POST', '/api/claims', { handle: h, lines: [{ leftoverId: id, ...extra }] });
const adminList = async () => (await api('GET', '/api/admin/shop')).json.items;
const pubShop = async () => (await app.api('GET', '/api/shop')).json;
const row = async (id) => (await app.q('SELECT id, is_active AS active, deleted_at AS gone, image_id AS img FROM leftover_items WHERE id = ?', [id]))[0];
const del = (id, c = admin) => api('DELETE', `/api/admin/shop/${id}`, undefined, c);
const picture = async (id) => { const buf = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#3a7bd5' } }).png().toBuffer(); const r = await fetch(`${app.base}/api/admin/images/shop/${id}`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: buf }); assert.equal(r.status, 200); const name = (await r.json()).image.url.replace('/uploads/', ''); return { name, thumb: name.replace('.webp', '-t.webp') }; };
const onDisk = (f) => fs.existsSync(path.join(app.cfg.uploadsDir, f));
const audits = async (action) => (await app.q('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?', [action]))[0].n;

test('NOBODY HAS CLAIMED IT → DELETED FOR GOOD: the listing, its options, its picture record and both picture files; it is off the GOM\'s list and the shop; recorded', async () => {
  const id = await mk(u(), { optionLabel: 'Size', options: [{ name: 'L', qty: 2 }, { name: 'M', qty: 1 }] }); const pic = await picture(id); const imgId = (await row(id)).img; assert.ok(imgId && onDisk(pic.name) && onDisk(pic.thumb), 'it has a picture');
  assert.equal((await adminList()).find((i) => i.id === id).claimRows, 0); const r = await del(id); assert.equal(r.status, 200, r.text); assert.deepEqual([r.json.deleted, r.json.archived, r.json.claims], [true, false, 0]);
  assert.equal(await row(id), undefined, 'the listing is gone'); assert.equal((await app.q('SELECT COUNT(*) AS n FROM leftover_options WHERE leftover_item_id = ?', [id]))[0].n, 0, 'and its options'); assert.equal((await app.q('SELECT COUNT(*) AS n FROM images WHERE id = ?', [imgId]))[0].n, 0, 'and its picture record');
  assert.deepEqual([onDisk(pic.name), onDisk(pic.thumb)], [false, false], 'and both picture files'); assert.equal((await adminList()).some((i) => i.id === id), false); assert.equal((await pubShop()).items.some((i) => i.id === id), false); assert.ok(await audits('shop.delete') >= 1, 'recorded');
  const hidden = await mk(u('Hidden ')); assert.equal((await api('PATCH', `/api/admin/shop/${hidden}`, { active: false })).status, 200); assert.equal((await del(hidden)).json.deleted, true, 'a hidden listing can be deleted too');
});

test('IT HAS CLAIMS → ARCHIVED, NOT ERASED: off every list and the shop, but the listing, its options and its picture are kept and the claims carry on exactly as they were; recorded', async () => {
  const id = await mk(u(), { optionLabel: 'Size', options: [{ name: 'L', qty: 5 }, { name: 'M', qty: 5, price: 6 }] }); const pic = await picture(id); const [a, b] = [u('buyer'), u('buyer')];
  assert.equal((await claim(id, a, { member: 'L' })).status, 201); assert.equal((await claim(id, b, { member: 'M' })).status, 201); const before = await app.q('SELECT c.id, c.label, c.status, c.pipeline, c.leftover_option_id AS opt FROM claims c WHERE c.leftover_item_id = ? ORDER BY c.id', [id]); assert.equal(before.length, 2);
  assert.equal((await adminList()).find((i) => i.id === id).claimRows, 2); const r = await del(id); assert.equal(r.status, 200, r.text); assert.deepEqual([r.json.deleted, r.json.archived, r.json.claims], [false, true, 2]);
  const gone = await row(id); assert.ok(gone && gone.gone && gone.active === 0, 'kept behind the scenes, switched off and marked deleted'); assert.equal((await adminList()).some((i) => i.id === id), false, 'off the GOM\'s list — even though the list includes hidden items'); assert.equal((await pubShop()).items.some((i) => i.id === id), false, 'off the shop');
  assert.deepEqual(await app.q('SELECT c.id, c.label, c.status, c.pipeline, c.leftover_option_id AS opt FROM claims c WHERE c.leftover_item_id = ? ORDER BY c.id', [id]), before, 'the claims are exactly as they were'); assert.equal((await app.q('SELECT COUNT(*) AS n FROM leftover_options WHERE leftover_item_id = ?', [id]))[0].n, 2, 'the options the claims point at are kept');
  assert.equal(onDisk(pic.name), true, 'its picture is kept too'); assert.ok(await audits('shop.archive') >= 1, 'recorded');
});

test('A LISTING WHOSE ONLY CLAIMS WERE CANCELLED IS STILL ARCHIVED (a claim row points at it), and the count on the list includes them', async () => {
  const id = await mk(u()); const h = u('buyer'); const c = await claim(id, h); assert.equal(c.status, 201); assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: c.json.claimIds })).status, 200);
  assert.equal((await adminList()).find((i) => i.id === id).claimRows, 1, 'the cancelled one still counts'); const r = await del(id); assert.deepEqual([r.status, r.json.archived, r.json.claims], [200, true, 1]); assert.ok((await row(id)).gone);
});

test('AN ARCHIVED LISTING IS GONE FOR GOOD: it can\'t be edited, un-hidden, deleted again or claimed', async () => {
  const id = await mk(u()); assert.equal((await claim(id, u('buyer'))).status, 201); assert.equal((await del(id)).json.archived, true); const was = await row(id);
  assert.equal((await api('PATCH', `/api/admin/shop/${id}`, { active: true })).status, 404, 'not brought back'); assert.equal((await api('PATCH', `/api/admin/shop/${id}`, { title: 'Renamed' })).status, 404); assert.equal((await del(id)).status, 404, 'deleting again');
  const n = (await app.q('SELECT COUNT(*) AS n FROM claims WHERE leftover_item_id = ?', [id]))[0].n; const late = await claim(id, u('late')); assert.ok(late.status >= 400 && late.status < 500, `a new claim is refused (${late.status})`); assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE leftover_item_id = ?', [id]))[0].n, n, 'no new claim was made');
  assert.deepEqual(await row(id), was, 'the archived row is untouched');
});

test('ONLY THE ONE LISTING GOES: the others are untouched; an artist\'s avatar disappears from the shop when its only listing is archived; refusals — unknown id, a joiner, not signed in', async () => {
  const [keep, drop] = [await mk(u('Keep ')), await mk(u('Drop '))]; await del(drop); assert.ok(await row(keep), 'the other listing is untouched'); assert.equal((await adminList()).some((i) => i.id === keep), true);
  const g = (await api('POST', '/api/admin/groups', { name: u('Artist ') })).json.id; const inGroup = await mk(u('Grouped '), { groupId: g }); assert.equal((await pubShop()).groups.some((x) => x.id === g), true, 'the artist shows while it has a listing'); assert.equal((await claim(inGroup, u('buyer'))).status, 201); await del(inGroup); assert.equal((await pubShop()).groups.some((x) => x.id === g), false, 'an archived listing doesn\'t keep the artist on the shop');
  assert.equal((await del(999999)).status, 404); const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await del(keep, j)).status, 403); assert.equal((await app.api('DELETE', `/api/admin/shop/${keep}`)).status, 401); assert.ok(await row(keep), 'still there after the refusals');
});
