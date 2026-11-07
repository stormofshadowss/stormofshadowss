import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startApp, seed } from './helpers.js';
import { gomPage } from './ui.helpers.js';

// GOM → Group Orders: a photocard bundle's order shows that it is managed from the Cards tab, and its edit / delete / add buttons are gone (the server refuses those changes too).
let app, admin, w;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('A CARD ORDER IN THE GROUP ORDERS TAB: "Managed in the Cards tab", no Edit or Delete on the order, none on its cards, no add-an-item form; a normal order keeps all of them', async () => {
  const b = (await api('POST', '/api/admin/card-bundles', { title: 'Card bundle for the orders tab', groupId: w.group })).json.id;
  const r = await fetch(`${app.base}/api/admin/card-bundles/${b}/boards`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: await sharp({ create: { width: 800, height: 600, channels: 3, background: '#445' } }).png().toBuffer() }); const bd = (await r.json()).board;
  assert.equal((await api('PUT', `/api/admin/card-boards/${bd.id}/boxes`, { boxes: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3, qty: 1, price: 3 }] })).status, 200); assert.equal((await api('PATCH', `/api/admin/card-bundles/${b}`, { status: 'open' })).status, 200);
  const orderId = (await api('GET', '/api/admin/cards')).json.bundles.find((x) => x.id === b).orderId;
  const p = await gomPage(app, admin); await sleep(100); await p.settle(); const row = (id) => p.qa('tr').find((tr) => tr.querySelector(`[data-act="open-items"][data-id="${id}"]`));
  const card = row(orderId), plain = row(w.order); assert.ok(card && plain);
  assert.match(p.text(card.querySelector('[data-cards-managed]')), /^Managed in the Cards tab$/); assert.equal(card.querySelector('[data-act="edit-order"]'), null); assert.equal(card.querySelector('[data-act="delete-order"]'), null); assert.ok(card.querySelector('[data-act="open-items"]'), 'its items can still be looked at');
  assert.ok(plain.querySelector('[data-act="edit-order"]') && plain.querySelector('[data-act="delete-order"]') && !plain.querySelector('[data-cards-managed]'), 'a normal order is unchanged');
  await p.click(card.querySelector('[data-act="open-items"]')); await sleep(100); await p.settle(); assert.match(p.text(p.q('[data-cards-note]')), /^This is a photocard bundle — its cards \(prices, copies, pictures\) are changed from the Cards tab, not here\.$/);
  assert.equal(p.qa('#itemsPanel [data-act="edit-item"], #itemsPanel [data-act="delete-item"]').length, 0, 'no edit or delete on its cards'); assert.ok(p.q('#itemsPanel form[data-form="new-item"]').hidden, 'no add-an-item form');
  const q = await gomPage(app, admin); await sleep(100); await q.settle(); const plainRow = q.qa('tr').find((tr) => tr.querySelector(`[data-act="open-items"][data-id="${w.order}"]`)); await q.click(plainRow.querySelector('[data-act="open-items"]')); await sleep(100); await q.settle();
  assert.ok(q.qa('#itemsPanel [data-act="edit-item"]').length > 0 && !q.q('#itemsPanel form[data-form="new-item"]').hidden && !q.q('[data-cards-note]'), 'a normal order still has its edit buttons and add form'); p.close(); q.close();
});
