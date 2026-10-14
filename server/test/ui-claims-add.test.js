import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { gomPage } from './ui.helpers.js';

// Claims tab → "+ Add a claim": the GOM enters a claim for someone (a gap in an import, or an order that came by DM, often on a private group order).
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const u = (x = 'ac') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async (title = u('Panel GO '), extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam', ...extra })).json.id;
const item = async (go, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price: 10, ...extra })).json.id;
const person = async (h) => { await joinerSession(app, `${h}@x.com`, h); return h; };
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); await sleep(100); await p.settle(); return p; };
const panel = (p) => p.q('#addClaim');
const f = (p, sel) => p.q(sel, panel(p));
const openPanel = async (p) => { await p.click(p.q('[data-act="add-open"]')); return panel(p); };
const pick = async (p, { handle, order, itemId, create }) => {
  if (handle !== undefined) await p.type(f(p, 'input[name="handle"]'), handle);
  if (create) await p.click(f(p, 'input[name="createHandle"]'));
  if (order !== undefined) await p.choose(f(p, 'select[name="orderId"]'), String(order));
  if (itemId !== undefined) await p.choose(f(p, 'select[name="itemId"]'), String(itemId));
};
const status = (p, v) => p.click(f(p, `input[name="status"][value="${v}"]`));
const send = async (p) => { await p.submit(panel(p)); await sleep(250); await p.settle(); };
const err = (p) => p.text(f(p, '[data-add-error]'));

test('THE PANEL: a button opens it; nothing is preselected (no default status); the item list waits for a group order; people who exist are suggested; Close puts it away', async () => {
  const h = await person(u('known')); const go = await goOrder(); await item(go); await api('POST', '/api/claims', { handle: h, lines: [{ itemId: w.keyring }] });
  const p = await open(); assert.equal(panel(p), null, 'closed to begin with');
  await openPanel(p); assert.match(p.text(panel(p)), /Add a claim for someone.*no email is sent/s);
  assert.deepEqual(p.qa('input[name="status"]', panel(p)).map((r) => [r.value, r.checked]), [['requested', false], ['confirmed', false]], 'no default: you choose each time');
  assert.equal(f(p, 'select[name="itemId"]').disabled, true, 'choose a group order first'); assert.equal(f(p, '[data-add-stage]'), null, 'no stage until confirmed');
  await p.type(f(p, 'input[name="handle"]'), h.slice(0, -1)); await sleep(450); await p.settle(); assert.ok(p.qa('#knownHandles option', panel(p)).some((o) => o.value === h), 'people who exist are suggested as you type'); await p.type(f(p, 'input[name="handle"]'), '');
  await p.click(p.q('[data-act="add-close"]')); assert.equal(panel(p), null); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('ADDING A REQUEST: person, group order, item, how many, status → the claims exist, the message says what happened, and one click shows them', async () => {
  const h = await person(u('rq')); const go = await goOrder(u('Req GO ')); const it = await item(go, { title: 'Hoodie', price: 12 });
  const p = await open(); await openPanel(p); await pick(p, { handle: `@${h}`, order: go, itemId: it });
  await p.type(f(p, 'input[name="qty"]'), '2'); await status(p, 'requested'); await send(p);
  assert.match(p.text(f(p, '[data-add-msg]')), new RegExp(`Added 2 claims for @${h} — as requests\\.`));
  assert.doesNotMatch(p.text(f(p, '[data-add-msg]')), /Set parts stay|confirmed/, 'a plain request says nothing about sets or confirming');
  const mine = (await claimsOf(h)).filter((c) => c.order_id === go); assert.equal(mine.length, 2); assert.ok(mine.every((c) => c.status === 'requested' && c.label === 'Hoodie'));
  assert.equal(f(p, 'select[name="itemId"]').value, '', 'the item is cleared ready for the next'); assert.equal(f(p, 'input[name="handle"]').value, `@${h}`, 'the person is kept');
  await p.click(p.q('[data-act="add-show"]', panel(p))); assert.equal(p.q('[data-filter="q"]').value, h); assert.ok(p.q(`[data-buyer="${h}"]`), 'their claims are shown');
  p.close();
});

test('THE STATUS MUST BE CHOSEN: without it nothing is sent; and "confirmed" offers where the item is now', async () => {
  const h = await person(u('st')); const go = await goOrder(); const it = await item(go); const p = await open(); await openPanel(p); await pick(p, { handle: h, order: go, itemId: it }); await p.type(f(p, 'input[name="qty"]'), '1');
  await send(p); assert.match(err(p), /Choose Requested or Confirmed — there is no default\./); assert.equal((await claimsOf(h)).filter((c) => c.order_id === go).length, 0);
  await status(p, 'confirmed'); const stage = f(p, 'select[name="stage"]'); assert.ok(stage, 'a stage picker appears'); assert.deepEqual([...stage.options].map((o) => o.value), ['awaiting fulfillment', 'ordered via proxy / warehouse', 'arrived at proxy / warehouse', 'arrived at GOM', 'checking parcel', 'ready to pack / on hand']);
  await p.choose(stage, 'ready to pack / on hand'); await send(p);
  assert.match(p.text(f(p, '[data-add-msg]')), /Added 1 claim for @.* — 1 confirmed\./); const c = (await claimsOf(h)).find((x) => x.order_id === go); assert.deepEqual([c.status, c.pipeline], ['confirmed', 'ready to pack / on hand']);
  await status(p, 'requested'); assert.equal(f(p, '[data-add-stage]'), null, 'switching back to requested removes it'); p.close();
});

test('A NEW PERSON: an unknown handle is flagged as you type; sending without ticking explains; ticking creates them', async () => {
  const go = await goOrder(); const it = await item(go); const h = u('brandnew'); const p = await open(); await openPanel(p); await pick(p, { order: go, itemId: it });
  const hint = () => f(p, '[data-unknown]'); assert.equal(hint().hidden, true); await p.type(f(p, 'input[name="handle"]'), `@${h}`); assert.equal(hint().hidden, true, 'not until the server has answered'); await sleep(450); await p.settle(); assert.equal(hint().hidden, false); assert.match(p.text(hint()), new RegExp(`There's no @${h} on the site yet — tick “New person” if that's right\\.`));
  await p.type(f(p, 'input[name="qty"]'), '1'); await status(p, 'requested'); await send(p); assert.match(err(p), /There's no @.* on the site yet — tick “New person” to create them\./); assert.equal((await app.q('SELECT COUNT(*) AS n FROM joiners WHERE instagram_handle = ?', [h]))[0].n, 0);
  await p.click(f(p, 'input[name="createHandle"]')); assert.equal(hint().hidden, true, 'ticked: the hint goes'); await send(p);
  assert.match(p.text(f(p, '[data-add-msg]')), new RegExp(`Added 1 claim for @${h} \\(a new person was created\\) — as a request\\.`)); assert.equal((await claimsOf(h)).length, 1);
  p.close();
});

test('EACH KIND OF ITEM asks for the right thing: how many / a size and how many / which members / which parts and "keep together"; a TBC price is noted', async () => {
  const go = await goOrder(); const plain = await item(go, { title: 'Plain' }), size = await item(go, { type: 'size', variants: ['M', 'L'], title: 'Sized' }), mem = await item(go, { type: 'independent', members: ['Felix', 'Han'], title: 'Cards' }),
    set = await item(go, { type: 'set', members: ['A', 'B', 'C'], price: 4, title: 'Setty' }), tbc = await item(go, { price: undefined, priceTbc: true, title: 'Later' });
  const p = await open(); await openPanel(p); await pick(p, { order: go });
  const detail = () => f(p, '[data-add-detail]');
  await pick(p, { itemId: plain }); assert.ok(f(p, 'input[name="qty"]') && !f(p, 'select[name="variant"]') && !p.q('[data-part]', detail()));
  await pick(p, { itemId: size }); assert.deepEqual([...f(p, 'select[name="variant"]').options].map((o) => o.value), ['', 'M', 'L']); assert.ok(f(p, 'input[name="qty"]'));
  await pick(p, { itemId: mem }); assert.deepEqual(p.qa('[data-part]', detail()).map((i) => i.dataset.part), ['Felix', 'Han']); assert.equal(f(p, 'input[name="together"]'), null);
  await pick(p, { itemId: set }); assert.deepEqual(p.qa('[data-part]', detail()).map((i) => i.dataset.part), ['A', 'B', 'C']); assert.match(p.text(f(p, 'input[name="together"]').closest('label')), /Keep these together in the same set/); assert.match(p.text(detail()), /A set's parts only confirm once their set is secured/);
  await pick(p, { itemId: tbc }); assert.match(p.text(f(p, '[data-tbc]')), /The price is still TBC — you can add this as a request, but it can't be confirmed until the price is set\./); p.close();
});

test('SIZES AND MEMBERS ARE ADDED: the labels are the same as when a joiner claims', async () => {
  const h = await person(u('kinds')); const go = await goOrder(); const size = await item(go, { type: 'size', variants: ['M', 'L'], title: 'Tee' }), mem = await item(go, { type: 'independent', members: ['Felix', 'Han'], title: 'Card' });
  const p = await open(); await openPanel(p); await pick(p, { handle: h, order: go, itemId: size }); await send(p); assert.match(err(p), /Choose a size\./);
  await p.choose(f(p, 'select[name="variant"]'), 'L'); await p.type(f(p, 'input[name="qty"]'), '2'); await status(p, 'requested'); await send(p); assert.match(p.text(f(p, '[data-add-msg]')), /Added 2 claims/);
  await pick(p, { itemId: mem }); await send(p); assert.match(err(p), /Enter how many of at least one member\./);
  await p.type(p.q('[data-part="Han"]', panel(p)), '1'); await p.type(p.q('[data-part="Felix"]', panel(p)), '2'); await send(p);
  assert.deepEqual((await claimsOf(h)).filter((c) => c.order_id === go).map((c) => c.label).sort(), ['Card — Felix', 'Card — Felix', 'Card — Han', 'Tee (L)', 'Tee (L)']); p.close();
});

test('MEMBER SETS: parts and "keep together" are sent, and the message says where each went and that they wait for their set', async () => {
  const h = await person(u('setp')); const go = await goOrder(); const set = await item(go, { type: 'set', members: ['A', 'B', 'C'], price: 4, title: 'Setty' });
  const p = await open(); await openPanel(p); await pick(p, { handle: h, order: go, itemId: set }); await status(p, 'confirmed'); await send(p); assert.match(err(p), /Enter how many of at least one part\./);
  await p.type(p.q('[data-part="A"]', panel(p)), '1'); await p.type(p.q('[data-part="B"]', panel(p)), '1'); await p.click(f(p, 'input[name="together"]')); await send(p);
  const m = p.text(f(p, '[data-add-msg]')); assert.match(m, /Added 2 claims for @.* — 0 confirmed, 2 left as requests\. Placed: A → Set 1, B → Set 1\. Set parts stay requests until their set is secured \(Sets tab\)\./);
  p.close();
});

test('PRIVATE AND CLOSED group orders are on the list (and labelled); a cancelled order is not; a cancelled item is not', async () => {
  const priv = await goOrder('Secret DM order', { isPrivate: true }), closed = await goOrder('Finished order', { status: 'closed' }), gone = await goOrder('Cancelled order'); const keep = await item(priv, { title: 'Kept' }), dead = await item(priv, { title: 'Dead item' });
  await api('POST', `/api/admin/items/${dead}/cancel`, { confirm: 'Dead item' }); await api('POST', `/api/admin/orders/${gone}/cancel`, { confirm: 'Cancelled order' });
  const p = await open(); await openPanel(p); const labels = p.qa('select[name="orderId"] option', panel(p)).map((o) => p.text(o));
  assert.ok(labels.includes('Secret DM order (private)')); assert.ok(labels.includes('Finished order (closed)')); assert.ok(!labels.some((l) => /Cancelled order/.test(l)));
  await pick(p, { order: priv }); assert.deepEqual(p.qa('select[name="itemId"] option', panel(p)).map((o) => p.text(o)).slice(1), ['Kept — £10.00']); void keep; p.close();
});

test('WHAT YOU TYPED SURVIVES: other changes on the page (Expand all, a filter) do not wipe the panel', async () => {
  const h = await person(u('keep')); const go = await goOrder(); const it = await item(go); const p = await open(); await openPanel(p); await pick(p, { handle: h, order: go, itemId: it }); await p.type(f(p, 'input[name="qty"]'), '3'); await status(p, 'confirmed');
  const box = f(p, 'input[name="handle"]'), qty = f(p, 'input[name="qty"]'); await p.type(box, `${h}x`); await p.type(qty, '4'); await p.type(box, h); await p.type(qty, '3');
  assert.equal(f(p, 'input[name="handle"]'), box, 'typing in the handle box does not rebuild the page (the cursor would jump)'); assert.equal(f(p, 'input[name="qty"]'), qty, 'nor does typing a number');
  await p.click(p.byText('button', 'Expand all')); await p.choose(p.q('[data-filter="status"]'), 'all');
  assert.equal(f(p, 'input[name="handle"]').value, h); assert.equal(f(p, 'select[name="orderId"]').value, String(go)); assert.equal(f(p, 'select[name="itemId"]').value, String(it)); assert.equal(f(p, 'input[name="qty"]').value, '3'); assert.equal(f(p, 'input[name="status"][value="confirmed"]').checked, true); p.close();
});

test('NAMES WITH HTML are shown as text in the panel (orders, items, members, suggestions, the result)', async () => {
  const go = await goOrder('<img src=x onerror="window.pwned=1"> order'); const it = await item(go, { type: 'independent', members: ['<b>Bold</b>'], title: '<i>Item</i>' }); const h = await person(u('xs'));
  const p = await open(); await openPanel(p); await pick(p, { handle: h, order: go, itemId: it });
  assert.equal(p.q('img[src="x"]', panel(p)), null); assert.equal(p.window.pwned, undefined); assert.ok(p.byText('option', '<img src=x onerror="window.pwned=1"> order')); assert.equal(p.q('b', panel(p)), null); assert.equal(p.q('[data-part]', panel(p)).dataset.part, '<b>Bold</b>');
  await p.type(p.q('[data-part]', panel(p)), '1'); await status(p, 'requested'); await send(p); assert.match(p.text(f(p, '[data-add-msg]')), /Added 1 claim/); p.close();
});

test('SOMEONE WHO EXISTS BUT HAS NO CLAIMS is suggested and is NOT called a new person (the case of a joiner missing from an import)', async () => {
  const h = u('noclaims'); await app.q('INSERT INTO joiners (instagram_handle) VALUES (?)', [h]); await app.q('INSERT INTO joiners (instagram_handle) VALUES (?)', [`${h}_alt`]);
  const p = await open(); await openPanel(p); const hint = () => f(p, '[data-unknown]');
  await p.type(f(p, 'input[name="handle"]'), h.slice(0, -2)); await sleep(450); await p.settle(); assert.ok(p.qa('#knownHandles option', panel(p)).some((o) => o.value === h), 'suggested as you type');
  await p.type(f(p, 'input[name="handle"]'), `@${h}`); await sleep(450); await p.settle(); assert.equal(hint().hidden, true, 'an existing person: no "new person" warning');
  await p.type(f(p, 'input[name="handle"]'), `${h}_ghost`); await sleep(450); await p.settle(); assert.equal(hint().hidden, false, 'only a handle that does not exist gets the warning');
  await app.q('UPDATE joiners SET is_blocked = 1 WHERE instagram_handle = ?', [`${h}_alt`]); await p.type(f(p, 'input[name="handle"]'), `${h}_alt`); await sleep(450); await p.settle(); assert.match(p.text(hint()), /is blocked — unblock them on the People tab first\./);
  p.close();
});
