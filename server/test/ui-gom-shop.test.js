import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { gomPage, toast } from './ui.helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b) => app.api(m, p, b, admin);
const text = (p, sel = '#tabBody') => p.text(p.q(sel));
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Shop')); return p; };
const stock = async (o = {}) => (await api('POST', '/api/admin/shop', { title: `GOM stock ${++N}`, price: 10, qty: 3, ...o })).json.id;
const buy = (handle, id, qty = 1) => app.api('POST', '/api/claims', { handle, lines: [{ leftoverId: id, qty }] });
const card = (p, id) => p.q(`[data-shop="${id}"]`);

test('an empty Shop tab invites you to add something', async () => {
  const p = await open();
  assert.match(text(p), /Add a shop item.*Stock you already have.*held for them straight away.*ready to pack once they've paid/s);
  assert.match(text(p), /No shop items yet/);
  assert.equal(p.q('form[data-form="add"] [name="payDays"]').value, '5', 'five days to pay by default');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('adding an item: shown with its stock, price, pay days and size; mistakes are explained; the form is the same one used to edit', async () => {
  const p = await open();
  const form = () => p.q('form[data-form="add"]');
  p.fill(form(), { title: 'Spare Lightstick', price: '0', qty: '1' }); await p.submit(form());
  assert.ok(p.text(p.q('[data-msg]', form())).length > 0, 'a price of zero is explained');
  p.fill(form(), { title: 'Spare Lightstick', price: '40', qty: '2', payDays: '7', size: 'L', notes: 'Boxed, unused' }); await p.submit(form());
  assert.match(toast(p), /Added "Spare Lightstick" — you can add a picture below/);
  const id = (await api('GET', '/api/admin/shop')).json.items.find((i) => i.title === 'Spare Lightstick').id;
  assert.ok(p.q('.picctl', card(p, id)), 'the new item opens ready for a picture');
  await p.click(p.byText('button', 'Cancel', card(p, id)));
  assert.match(text(p, `[data-shop="${id}"]`), /Spare Lightstick.*£40\.00 · 0 of 2 claimed · 2 left · 7 days to pay · size L.*Boxed, unused/s);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('claims show under their item: who, paid or not, when it is due, and what is overdue', async () => {
  const id = await stock({ title: 'Claimed item', price: 9, qty: 4 });
  const paid = 'gs_paid', unpaid = 'gs_unpaid', late = 'gs_late';
  const cp = await joinerSession(app, `${paid}@x.com`, paid);
  for (const h of [paid, unpaid, late]) await buy(h, id);
  await app.q("UPDATE claims SET pay_by = CURDATE() - INTERVAL 2 DAY WHERE joiner_id = (SELECT id FROM joiners WHERE instagram_handle = 'gs_late')");
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 9, reference: 'GS' }, cp); await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  const p = await open();
  assert.match(text(p, `[data-shop="${id}"]`), /3 of 4 claimed · 1 left/);
  const rows = Object.fromEntries(p.qa(`[data-shop="${id}"] .itemrow`).map((r) => [/@(\w+)/.exec(p.text(r))[1], p.text(r)]));
  assert.match(rows[paid], /@gs_paid.*ready to pack.*paid/s);
  assert.match(rows[unpaid], /@gs_unpaid.*unpaid.*pay by \d\d\/\d\d\/\d{4}/s); assert.doesNotMatch(rows[unpaid], /overdue/);
  assert.match(rows[late], /@gs_late.*unpaid.*pay by.*overdue/s);
  assert.equal(p.q('#tabs [data-tab="shop"] .badge').textContent, '1', 'the tab badge counts overdue unpaid claims');
  p.close();
});

test('editing: pre-filled, warns that price changes only apply to new claims and says the quantity floor; saving updates the card', async () => {
  const id = await stock({ title: 'Edit me', price: 10, qty: 5, payDays: 5, notes: 'old note' });
  await buy('gs_editor', id, 2);
  const p = await open();
  await p.click(p.q('[data-act="edit"]', card(p, id)));
  const form = () => p.q('form[data-form="edit"]');
  assert.deepEqual([form().elements.title.value, form().elements.price.value, form().elements.qty.value, form().elements.notes.value], ['Edit me', '10', '5', 'old note']);
  assert.match(text(p, `[data-shop="${id}"]`), /only applies to claims made from now on.*2 already claimed, so the quantity can't go below that/s);
  p.fill(form(), { qty: '1' }); await p.submit(form());
  assert.match(p.text(p.q('[data-msg]', form())), /2 are already claimed — set the quantity to at least 2/);
  p.fill(form(), { title: 'Edited', price: '12.5', qty: '6', notes: '' }); await p.submit(form());
  assert.match(toast(p), /Saved/);
  assert.match(text(p, `[data-shop="${id}"]`), /Edited.*£12\.50 · 2 of 6 claimed · 4 left/s);
  assert.equal((await api('GET', '/api/admin/claims?handle=gs_editor')).json.claims[0].costs.initials.cost, 10, 'the earlier claims kept their price');
  await p.click(p.q('[data-act="edit"]', card(p, id))); await p.click(p.byText('button', 'Cancel', card(p, id)));
  assert.equal(p.q('form[data-form="edit"]'), null, 'cancel closes the form');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('hiding an item stops joiners buying it but keeps its claims; showing it brings it back; hidden items can be tucked away', async () => {
  const id = await stock({ title: 'Hide me' }); await buy('gs_hider', id);
  const p = await open();
  await p.click(p.q('[data-act="hide"]', card(p, id)));
  assert.match(toast(p), /Hidden from joiners\. Claims already made are untouched/);
  assert.match(text(p, `[data-shop="${id}"]`), /hidden from joiners.*1 of 3 claimed/s);
  assert.equal((await app.api('GET', '/api/shop')).json.items.some((i) => i.id === id), false);
  assert.equal((await buy('gs_late_buyer', id)).status, 404);
  await p.click(p.q('input[data-act="toggle-hidden"]'));
  assert.equal(card(p, id), null, '"show hidden items" unticked: tucked away');
  await p.click(p.q('input[data-act="toggle-hidden"]'));
  await p.click(p.q('[data-act="show"]', card(p, id)));
  assert.match(toast(p), /Showing it to joiners again/);
  assert.equal((await buy('gs_late_buyer', id)).status, 201);
  p.close();
});

test('the Claims tab lists shop claims under "Shop (on hand)" and cancelling one frees the unit', async () => {
  const id = await stock({ title: 'Cancel me', qty: 1 }); await buy('gs_cancel', id);
  assert.equal((await buy('gs_next', id)).status, 409);
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims'));
  assert.match(p.text(p.byText('#tabBody .card', 'Shop (on hand)')), /Shop \(on hand\).*gs_cancel/s);
  const claim = (await api('GET', '/api/admin/claims?handle=gs_cancel')).json.claims[0];
  assert.equal((await api('PATCH', `/api/admin/claims/${claim.id}`, { status: 'cancelled' })).status, 200);
  assert.equal((await buy('gs_next', id)).status, 201, 'the unit is free again');
  p.close();
});

test('names and notes with HTML are shown as text', async () => {
  await stock({ title: '<img src=x onerror="window.pwned=1"> item', notes: '<b>bold</b>' });
  const p = await open();
  assert.equal(p.q('#tabBody img'), null);
  assert.match(text(p), /<img src=x onerror="window\.pwned=1"> item.*<b>bold<\/b>/s);
  assert.equal(p.window.pwned, undefined);
  p.close();
});
