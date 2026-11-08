import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startApp, seed } from './helpers.js';
import { openPage } from './ui.helpers.js';

// THE HOME PAGE: the Shop and Photocards cards each have an icon tile, so they're easy to pick out.
let app, admin, w;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addStock = async () => (await api('POST', '/api/admin/shop', { title: 'Extra Photobook', price: 20, qty: 3, notes: 'Mint' })).json.id;
async function liveBundle() {
  const b = (await api('POST', '/api/admin/card-bundles', { title: 'Icon test bundle', groupId: w.group })).json.id;
  const r = await fetch(`${app.base}/api/admin/card-bundles/${b}/boards`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: await sharp({ create: { width: 800, height: 600, channels: 3, background: '#446' } }).png().toBuffer() }); const bd = (await r.json()).board;
  assert.equal((await api('PUT', `/api/admin/card-boards/${bd.id}/boxes`, { boxes: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3, qty: 1, price: 3 }] })).status, 200); assert.equal((await api('PATCH', `/api/admin/card-bundles/${b}`, { status: 'open' })).status, 200);
}
const home = async () => { const p = await openPage(app, '/'); await sleep(80); await p.settle(); return p; };

test('NOTHING TO SHOW, NO CARD, NO ICON: with no shop stock and no open card bundle the home page has neither card', async () => {
  const p = await home(); assert.equal(p.q('a.gocard[href="#/shop"]'), null); assert.equal(p.q('[data-cards-home]'), null); assert.equal(p.qa('.gicon').length, 0); p.close();
});

test('THE SHOP CARD HAS A SHOPPING-BAG ICON TILE; its words and its link are as before', async () => {
  await addStock(); const p = await home(); const card = p.q('a.gocard[href="#/shop"]'); assert.ok(card);
  const tile = card.querySelector('.gicon'); assert.ok(tile && tile.querySelector('svg'), 'an icon tile with a drawing in it'); assert.equal(tile.getAttribute('data-icon'), 'shop'); assert.equal(tile.getAttribute('aria-hidden'), 'true', 'decorative: a screen reader just reads the words');
  assert.match(p.text(card), /^Shop — on hand now.*available · held for you as soon as you claim$/); assert.ok(card.classList.contains('hasicon')); assert.equal(card.querySelectorAll('strong').length, 1);
  await p.click(card); await sleep(60); await p.settle(); assert.equal(p.window.location.hash, '#/shop', 'still goes to the shop'); assert.deepEqual(p.errors, []); p.close();
});

test('THE PHOTOCARDS CARD HAS ITS OWN, DIFFERENT ICON (two cards); the words, the link and the data hook are as before', async () => {
  await liveBundle(); const p = await home(); const card = p.q('[data-cards-home]'); assert.ok(card); const tile = card.querySelector('.gicon'); assert.ok(tile && tile.querySelector('svg')); assert.equal(tile.getAttribute('data-icon'), 'cards'); assert.equal(tile.getAttribute('aria-hidden'), 'true');
  assert.match(p.text(card), /^Single photocards1 open bundle · 1 card left$/); const shopTile = p.q('a.gocard[href="#/shop"] .gicon'); assert.notEqual(shopTile.innerHTML, tile.innerHTML, 'the two icons are different pictures');
  await p.click(card); await sleep(60); await p.settle(); assert.equal(p.window.location.hash, '#/cards'); p.close();
});

test('THE ICONS TAKE THEIR COLOUR FROM THE THEME: drawn with the text colour, no fixed colours in the drawing', async () => {
  const p = await home(); for (const tile of p.qa('.gicon')) { const svg = tile.querySelector('svg'); assert.equal(svg.getAttribute('stroke'), 'currentColor'); assert.equal(svg.getAttribute('fill'), 'none'); assert.doesNotMatch(tile.innerHTML, /#[0-9a-f]{3,6}\b|rgb\(/i, 'no fixed colour'); } assert.equal(p.qa('.gicon').length, 2); p.close();
});
