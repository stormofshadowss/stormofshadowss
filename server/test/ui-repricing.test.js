import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage, openPage, toast } from './ui.helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function setup(type = 'set') {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Price UI GO ${++N}` })).json.id;
  const item = (await api('POST', `/api/admin/orders/${go}/items`, type === 'set' ? { type: 'set', title: `Price UI set ${N}`, price: 8, members: ['A', 'B'] } : { type: 'normal', title: `Price UI item ${N}`, price: 8 })).json.id;
  return { go, item };
}
async function editPrice(p, go, item, price) {
  await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`));
  await p.click(p.q(`[data-act="edit-item"][data-id="${item}"]`));
  const f = p.q(`form[data-form="edit-item"][data-id="${item}"]`);
  p.fill(f, { price: String(price) }); await p.submit(f);
}

test('GOM: the item form says what changing the price does, and the saved message says how many unsecured claims moved', async () => {
  const { go, item } = await setup('set');
  for (const h of ['pu_a', 'pu_b']) await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: item, parts: [{ member: h === 'pu_a' ? 'A' : 'B', qty: 1 }] }] });
  const p = await gomPage(app, admin);
  await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`));
  await p.click(p.q(`[data-act="edit-item"][data-id="${item}"]`));
  assert.match(p.text(p.q('[data-price-note]')), /Claims that haven't been secured yet will switch to the new price\. Anything already secured keeps the price it was secured at\./);
  await p.click(p.byText('button', 'Cancel', p.q('form[data-form="edit-item"]')));
  await editPrice(p, go, item, 10);
  assert.match(toast(p), /Saved — 2 unsecured claims now use the new price\. Secured claims keep theirs\./);
  const costs = (await api('GET', '/api/admin/claims')).json.claims.filter((c) => /Price UI set/.test(c.label)).map((c) => c.costs.initials.cost);
  assert.deepEqual(costs, [10, 10]);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('GOM: singular wording for one claim, and a plain "Saved." when nothing needed re-pricing', async () => {
  const { go, item } = await setup('normal');
  await app.api('POST', '/api/claims', { handle: 'pu_single', lines: [{ itemId: item }] });
  let p = await gomPage(app, admin);
  await editPrice(p, go, item, 9);
  assert.match(toast(p), /Saved — 1 unsecured claim now uses the new price\. Secured claims keep theirs\./);
  p.close();
  await api('POST', '/api/admin/claims/secure', { orderId: go });                         // now secured: locked
  p = await gomPage(app, admin);
  await editPrice(p, go, item, 12);
  assert.equal(toast(p), 'Saved.', 'a secured claim is not re-priced, so there is nothing to report');
  assert.equal((await api('GET', '/api/admin/claims?handle=pu_single')).json.claims[0].costs.initials.cost, 9);
  p.close();
});

test('joiners are told the price is final once their request is confirmed', async () => {
  const p = await openPage(app, '/');
  p.window.location.hash = `#/order/${w.order}`; await sleep(30); await p.settle();
  const plus = p.q(`[data-act="inc"][data-item="${w.keyring}"]`); await p.click(plus);
  p.window.location.hash = '#/basket'; await sleep(30); await p.settle();
  assert.match(p.text(p.q('#view')), /nothing is owed until the GOM confirms them, and the price is final once they do\./);
  p.close();
});

test('side by side: after a price change the waiting request carries the new price and the secured claim keeps the old one', async () => {
  const { item } = await setup('normal');
  await claimAndSecure(app, admin, 'pu_locked', item);                                     // secured at £8
  await app.api('POST', '/api/claims', { handle: 'pu_waiting', lines: [{ itemId: item }] });
  await api('PATCH', `/api/admin/items/${item}`, { price: 11 });
  const rows = (await api('GET', '/api/admin/claims')).json.claims.filter((c) => c.orderTitle && c.label.startsWith('Price UI item'));
  const byHandle = Object.fromEntries(rows.map((c) => [c.handle, c.costs.initials.cost]));
  assert.deepEqual([byHandle.pu_locked, byHandle.pu_waiting], [8, 11]);
});
