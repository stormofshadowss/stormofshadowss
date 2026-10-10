import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startApp, seed } from './helpers.js';
import { gomPage, openPage, modal, press, toast } from './ui.helpers.js';

let app, admin, w, orderId, groupId;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  orderId = w.order;
  groupId = (await app.api('GET', '/api/admin/groups', undefined, admin)).json.groups[0].id;
});
after(async () => { await app.stop(); });

const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const png = (color = '#3a7bd5', wd = 800, ht = 600) => sharp({ create: { width: wd, height: ht, channels: 3, background: color } }).png().toBuffer();
const text = (p, sel = '#tabBody') => p.text(p.q(sel));
// pretend the GOM chose a file in a picture control
async function choose(p, ctl, bytes, { name = 'photo.png', type = 'image/png', size } = {}) {
  const input = p.q('input[data-pic-file]', ctl);
  const file = new p.window.File([bytes], name, { type });
  if (size) Object.defineProperty(file, 'size', { value: size });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await sleep(120); await p.settle();
}
const openOrders = async () => { const p = await gomPage(app, admin); return p; };           // Group Orders is the first tab
const itemFor = async (id) => (await api('GET', '/api/admin/orders')).json.orders.flatMap((o) => o.items).find((i) => i.id === id);
async function editItem(p, itemId) {
  await p.click(p.q(`[data-act="open-items"][data-id="${orderId}"]`));
  await p.click(p.q(`[data-act="edit-item"][data-id="${itemId}"]`));
  return p.q(`form[data-form="edit-item"][data-id="${itemId}"] .picctl`);
}

test('GOM: an item\'s edit form has a picture control; choosing a file uploads it at once, shows the thumbnail, and the item list gets a thumbnail too', async () => {
  const p = await openOrders();
  let ctl = await editItem(p, w.keyring);
  assert.match(p.text(ctl), /Item picture.*No picture.*JPEG, PNG, WebP or GIF, up to 8 MB.*shrunk for the web and any location data is removed/s);
  assert.equal(p.q('[data-pic-remove]', ctl), null, 'nothing to remove yet');
  await choose(p, ctl, await png());
  assert.match(toast(p), /Picture saved/);
  ctl = p.q(`form[data-form="edit-item"] .picctl`);
  const img = p.q('img.thumb', ctl);
  assert.ok(img && /^\/uploads\/[a-f0-9]{32}-t\.webp$/.test(img.getAttribute('src')));
  assert.ok(p.q('[data-pic-remove]', ctl), 'now it can be removed');
  assert.equal((await fetch(app.base + img.getAttribute('src'))).status, 200, 'and the picture is really served');
  assert.equal((await itemFor(w.keyring)).image.thumb, img.getAttribute('src'));
  await p.click(p.byText('button', 'Cancel', p.q('form[data-form="edit-item"]')));
  assert.ok(p.q('#itemsPanel img.thumb.sm') || p.q('table img.thumb.sm'), 'the item list shows it too');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('GOM: choosing another picture replaces it (the old one is gone); removing asks first', async () => {
  const p = await openOrders();
  let ctl = await editItem(p, w.hoodie);
  await choose(p, ctl, await png('#111111'));
  const first = p.q('form[data-form="edit-item"] .picctl img.thumb').getAttribute('src');
  ctl = p.q('form[data-form="edit-item"] .picctl');
  await choose(p, ctl, await png('#eeeeee'));
  const second = p.q('form[data-form="edit-item"] .picctl img.thumb').getAttribute('src');
  assert.notEqual(first, second);
  assert.equal((await fetch(app.base + first)).status, 404, 'the replaced picture is deleted');
  ctl = p.q('form[data-form="edit-item"] .picctl');
  await p.click(p.q('[data-pic-remove]', ctl));
  assert.match(p.text(modal(p)), /Remove this picture\?/);
  await press(p, 'Keep it');
  assert.ok((await itemFor(w.hoodie)).image, 'cancelling kept it');
  await p.click(p.q('[data-pic-remove]', p.q('form[data-form="edit-item"] .picctl'))); await press(p, 'Remove it');
  assert.match(toast(p), /Picture removed/);
  assert.equal((await itemFor(w.hoodie)).image, null);
  assert.match(p.text(p.q('form[data-form="edit-item"] .picctl')), /No picture/);
  p.close();
});

test('GOM: problems are explained in the control — too big (checked before sending) and not really a picture', async () => {
  const p = await openOrders();
  const ctl = await editItem(p, w.album);
  await choose(p, ctl, Buffer.from('tiny'), { size: 9 * 1024 * 1024 });
  assert.match(p.text(p.q('[data-pic-msg]', ctl)), /That picture is too big — the limit is 8 MB/);
  assert.equal((await itemFor(w.album)).image, null);
  await choose(p, p.q('form[data-form="edit-item"] .picctl'), Buffer.from('this is plain text, not a picture'), { name: 'sneaky.png' });
  assert.match(p.text(p.q('form[data-form="edit-item"] [data-pic-msg]')), /doesn't look like a picture we can use/);
  assert.equal((await itemFor(w.album)).image, null);
  p.close();
});

test('GOM: a group order can have a cover picture, and artist groups have their own pictures card', async () => {
  const p = await openOrders();
  await p.click(p.q(`[data-act="edit-order"][data-id="${orderId}"]`));
  const ctl = p.q('form[data-form="edit-order"] .picctl');
  assert.match(p.text(ctl), /Cover picture for this group order/);
  await choose(p, ctl, await png('#c33'));
  assert.ok((await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === orderId).cover);
  const details = p.q('#groupPics');
  assert.match(p.text(p.q('summary', details)), /Artist \/ group pictures and type \(\d+\)/);
  const gctl = p.q(`.picctl[data-pic-kind="group"][data-pic-id="${groupId}"]`, details);
  assert.ok(gctl); await choose(p, gctl, await png('#3a3'));
  assert.ok((await api('GET', '/api/admin/groups')).json.groups.find((g) => g.id === groupId).cover);
  assert.match(toast(p), /Picture saved/);
  p.close();
});

test('GOM: shop items — a new item opens ready for a picture, and the picture shows on its card', async () => {
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Shop'));
  const form = p.q('form[data-form="add"]');
  p.fill(form, { title: 'Pictured stock', price: '9', qty: '2' }); await p.submit(form);
  const id = (await api('GET', '/api/admin/shop')).json.items.find((i) => i.title === 'Pictured stock').id;
  const ctl = p.q(`[data-shop="${id}"] .picctl`);
  assert.ok(ctl); await choose(p, ctl, await png('#a5a'));
  await p.click(p.byText('button', 'Cancel', p.q(`[data-shop="${id}"]`)));
  assert.ok(p.q(`[data-shop="${id}"] img.thumb`), 'the card shows the picture');
  assert.ok((await api('GET', '/api/admin/shop')).json.items.find((i) => i.id === id).image);
  p.close();
});

// ───────────── what joiners see ─────────────
const setPic = async (kind, id, color = '#3a7bd5') => (await fetch(`${app.base}/api/admin/images/${kind}/${id}`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: await png(color, 600, 400) })).json();
const go = async (p, hash) => { p.window.location.hash = hash; await sleep(30); await p.settle(); };

test('joiners see a picture on every kind of item, tappable to the full size; items without one are unchanged', async () => {
  const add = (body) => api('POST', `/api/admin/orders/${orderId}/items`, { price: 5, ...body }).then((r) => r.json.id);
  const ids = { normal: await add({ type: 'normal', title: 'Pic normal' }), ind: await add({ type: 'independent', title: 'Pic indep', members: ['A', 'B'] }), size: await add({ type: 'size', title: 'Pic size', variants: ['M', 'L'] }),
    set: await add({ type: 'set', title: 'Pic set', members: ['A', 'B'] }), random: await add({ type: 'random', title: 'Pic random' }), bare: await add({ type: 'normal', title: 'Pic bare' }) };
  const pics = {};
  for (const k of ['normal', 'ind', 'size', 'set', 'random']) pics[k] = (await setPic('item', ids[k])).image;
  const p = await openPage(app, '/');
  await go(p, `#/order/${orderId}`);
  for (const [k, title] of [['normal', 'Pic normal'], ['ind', 'Pic indep'], ['size', 'Pic size'], ['set', 'Pic set'], ['random', 'Pic random']]) {
    const card = p.byText('#view .card', title);
    const img = p.q('a.picbox img.thumb', card);
    assert.ok(img, `${title} has its picture`);
    assert.equal(img.getAttribute('src'), pics[k].thumb); assert.equal(img.getAttribute('alt'), title);
    assert.equal(p.q('a.picbox', card).getAttribute('href'), pics[k].url, 'tapping opens the full-size picture');
    assert.equal(p.q('a.picbox', card).getAttribute('rel'), 'noopener');
    assert.equal((await fetch(app.base + pics[k].thumb)).status, 200);
  }
  assert.equal(p.q('a.picbox', p.byText('#view .card', 'Pic bare')), null, 'no picture, no gap');
  assert.deepEqual(p.errors, []);
  p.close();
});

test('joiners see the order\'s cover as a banner, small covers on order cards, and the artist\'s picture on its card and beside its name', async () => {
  const cover = (await setPic('order', orderId, '#c33')).image, artist = (await setPic('group', groupId, '#3a3')).image;
  const p = await openPage(app, '/');
  await new Promise((r) => setTimeout(r, 80)); await p.settle();
  assert.equal(p.q(`a.avatar-link[data-group="${groupId}"] .avatar-ring img`).getAttribute('src'), artist.thumb, 'the artist\'s picture is its round avatar on the home page');
  await go(p, `#/group/${groupId}`);
  assert.equal(p.q(`a.ocard[href="#/order/${orderId}"] img.cover`).getAttribute('src'), cover.thumb, 'the order\'s cover is the picture on its card on the group page');
  assert.equal(p.q('.avatar-ring img').getAttribute('src'), artist.thumb, 'and the artist\'s picture sits beside the group\'s name');
  await go(p, `#/order/${orderId}`);
  assert.equal(p.q('#view img.banner').getAttribute('src'), cover.url);
  assert.ok(p.q('#view img.banner').getAttribute('alt').length > 0);
  p.close();
});

test('the Shop page shows each item\'s picture', async () => {
  const id = (await api('POST', '/api/admin/shop', { title: 'Shop pic item', price: 4, qty: 2 })).json.id;
  const pic = (await setPic('shop', id)).image;
  const p = await openPage(app, '/'); await go(p, '#/shop');
  const card = p.q(`[data-shop-item="${id}"]`);
  assert.equal(p.q('a.picbox img.thumb', card).getAttribute('src'), pic.thumb);
  assert.equal(p.q('a.picbox', card).getAttribute('href'), pic.url);
  p.close();
});

test('quotes and markup in item titles cannot break out of a picture\'s alt text', async () => {
  const id = (await api('POST', `/api/admin/orders/${orderId}/items`, { type: 'normal', title: '"><img src=x onerror="window.pwned=1">', price: 3 })).json.id;
  await setPic('item', id);
  const p = await openPage(app, '/'); await go(p, `#/order/${orderId}`);
  assert.equal(p.q('img[src="x"]'), null); assert.equal(p.window.pwned, undefined);
  const imgs = p.qa('a.picbox img.thumb');
  assert.ok(imgs.some((i) => i.getAttribute('alt') === '"><img src=x onerror="window.pwned=1">'), 'shown literally as the alt text');
  p.close();
});
