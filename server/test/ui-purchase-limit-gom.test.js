import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { gomPage, modal, press } from './ui.helpers.js';

// GOM: set a purchase limit on an item (when adding or editing it), see it in the items list, and go past it knowingly when adding or fixing a claim yourself.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const u = (x = 'gl') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async (title = u('Lim GO ')) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam' })).json.id;
const item = async (go, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price: 10, ...extra })).json.id;
const claim = (lines, handle = u('c')) => app.api('POST', '/api/claims', { handle, lines });
const itemRow = (p, id) => p.q(`[data-act="edit-item"][data-id="${id}"]`).closest('tr');
const openItems = async (p, go) => { await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`)); await sleep(80); await p.settle(); return p; };
const ordersPage = async (go) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); return openItems(p, go); };
const limitText = (p, id) => { const e = p.q('[data-item-limit]', itemRow(p, id)); return e ? p.text(e) : null; };

test('THE ADD-ITEM FORM HAS A "PURCHASE LIMIT"; "the limit counts…" only appears for items that have members, sizes or sets; the item then shows its limit in the list', async () => {
  const go = await goOrder(); const p = await ordersPage(go); const form = p.q('form[data-form="new-item"]'); assert.ok(form.elements.purchaseLimit); assert.match(p.text(form), /Purchase limit \(blank = none\)/); assert.match(p.text(form), /At most this many across everyone, first come first served/);
  assert.equal(p.q('[data-limit-scope]', form).hidden, true, 'a plain item has nothing to count separately');
  for (const [type, shown] of [['independent', true], ['size', true], ['set', true], ['random', false], ['normal', false]]) { await p.choose(form.elements.type, type); assert.equal(p.q('[data-limit-scope]', form).hidden, !shown, `${type}: ${shown ? 'asks what it counts' : 'does not'}`); }
  await p.choose(form.elements.type, 'normal'); form.elements.title.value = 'Bulky box'; form.elements.price.value = '12'; form.elements.purchaseLimit.value = '4'; await p.submit(form); await sleep(350); await p.settle(); const made = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.title === 'Bulky box');
  assert.deepEqual(made.limit, { n: 4, scope: 'item', used: 0, left: 4 }); assert.match(limitText(p, made.id), /^Limit 4 · 4 left$/);
  const f2 = p.q('form[data-form="new-item"]'); await p.choose(f2.elements.type, 'independent'); f2.elements.title.value = 'Per member cards'; f2.elements.price.value = '3'; f2.elements.extra.value = 'Han, Felix'; f2.elements.purchaseLimit.value = '2'; await p.choose(f2.elements.limitScope, 'option'); await p.submit(f2); await sleep(350); await p.settle();
  const m = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.title === 'Per member cards'); assert.equal(m.limit.scope, 'option'); assert.match(limitText(p, m.id), /^Limit 2 of each$/);
  const f3 = p.q('form[data-form="new-item"]'); f3.elements.title.value = 'No limit'; f3.elements.price.value = '1'; await p.submit(f3); await sleep(350); await p.settle(); const none = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.title === 'No limit'); assert.equal(none.limit, null); assert.equal(limitText(p, none.id), null, 'blank = no limit, nothing shown'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('THE LIST SHOWS HOW MUCH IS USED: "Limit N · M left", "full", "full (3 over)" when you went past it, and for per-option limits which options are full', async () => {
  const go = await goOrder(); const some = await item(go, { purchaseLimit: 5 }), full = await item(go, { purchaseLimit: 1 }), opt = await item(go, { type: 'independent', members: ['Han', 'Felix', '<b>X</b>'], purchaseLimit: 1, limitScope: 'option' });
  await claim([{ itemId: some, qty: 2 }]); await claim([{ itemId: full }]); await claim([{ itemId: opt, member: 'Han' }]); await claim([{ itemId: opt, member: '<b>X</b>' }]);
  await api('POST', '/api/admin/claims/add', { handle: u('vip'), createHandle: true, status: 'requested', lines: [{ itemId: full }], overrideLimit: true });
  const p = await ordersPage(go); assert.match(limitText(p, some), /^Limit 5 · 3 left$/); assert.match(limitText(p, full), /^Limit 1 · full \(1 over\)$/); assert.match(limitText(p, opt), /^Limit 1 of each · full: Han, <b>X<\/b>$/); assert.equal(p.q('[data-item-limit] b b', itemRow(p, opt)), null, 'names are text, not HTML'); p.close();
});

test('THE EDIT-ITEM FORM SHOWS THE CURRENT LIMIT, changes it, and CLEARS it when blank; lowering it cancels nothing; the scope choice only exists for items with options', async () => {
  const go = await goOrder(); const plain = await item(go, { purchaseLimit: 3 }), mem = await item(go, { type: 'independent', members: ['Han', 'Felix'], purchaseLimit: 2, limitScope: 'option' }); await claim([{ itemId: plain, qty: 3 }]);
  const p = await ordersPage(go); await p.click(p.q(`[data-act="edit-item"][data-id="${plain}"]`)); let form = p.q('form[data-form="edit-item"]'); assert.equal(form.elements.purchaseLimit.value, '3'); assert.equal(form.elements.limitScope, undefined, 'a plain item: no "what it counts" choice'); assert.match(p.text(form), /Lowering it never cancels claims people already have — it only stops new ones/);
  form.elements.purchaseLimit.value = '2'; await p.submit(form); await sleep(350); await p.settle(); assert.deepEqual(await claimsN(plain), 3, 'lowering cancelled nothing'); assert.match(limitText(p, plain), /^Limit 2 · full \(1 over\)$/);
  await p.click(p.q(`[data-act="edit-item"][data-id="${plain}"]`)); form = p.q('form[data-form="edit-item"]'); form.elements.purchaseLimit.value = ''; await p.submit(form); await sleep(350); await p.settle(); assert.equal(limitText(p, plain), null, 'blank clears it'); assert.equal((await claim([{ itemId: plain }])).status, 201, 'and it is open again');
  await p.click(p.q(`[data-act="edit-item"][data-id="${mem}"]`)); form = p.q('form[data-form="edit-item"]'); assert.equal(form.elements.limitScope.value, 'option'); await p.choose(form.elements.limitScope, 'item'); await p.submit(form); await sleep(350); await p.settle(); assert.match(limitText(p, mem), /^Limit 2 · 2 left$/); p.close();
});
const claimsN = async (id) => (await app.q("SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND status <> 'cancelled'", [id]))[0].n;

test('ADDING A CLAIM OVER A LIMIT: the screen shows the reason and asks — "Don\'t add" leaves everything as it was, "Add anyway" adds it (you can go past a limit; people claiming normally can\'t)', async () => {
  const go = await goOrder(); const it = await item(go, { title: 'Store limited', purchaseLimit: 1 }); await claim([{ itemId: it }]); const h = u('vip'); await joinerSession(app, `${h}@x.com`, h);
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); await sleep(100); await p.settle(); await p.click(p.q('[data-act="add-open"]')); const panel = () => p.q('#addClaim'); const f = (s) => p.q(s, panel());
  await p.type(f('input[name="handle"]'), h); await p.choose(f('select[name="orderId"]'), String(go)); await p.choose(f('select[name="itemId"]'), String(it)); await p.click(f('input[name="status"][value="requested"]'));
  await p.submit(panel()); await sleep(300); await p.settle(); assert.match(p.text(modal(p)), /Sorry — “Store limited” has reached its purchase limit \(limit 1 in total\)\.\s*Add it anyway\? As the GOM you can go over a purchase limit — people claiming normally can't\./);
  await press(p, "Don't add"); await sleep(200); await p.settle(); assert.equal(await claimsN(it), 1, 'nothing was added'); assert.match(p.text(f('[data-add-error]')), /has reached its purchase limit/, 'and the reason stays on the form');
  await p.submit(panel()); await sleep(300); await p.settle(); await press(p, 'Add anyway'); await sleep(350); await p.settle(); assert.equal(await claimsN(it), 2, 'added, over the limit'); assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.item_id = ?', [h, it]))[0].n, 1); p.close();
});

test('FIXING A CLAIM ONTO A FULL ITEM asks the same way: "Don\'t move" changes nothing, "Move anyway" moves it', async () => {
  const go = await goOrder(); const src = await item(go, { title: 'Source item' }), cap = await item(go, { title: 'Full target', purchaseLimit: 1, price: 12 }); await claim([{ itemId: cap }]); const h = u('fixme'); await joinerSession(app, `${h}@x.com`, h); await claim([{ itemId: src }], h);
  const [{ id }] = await app.q('SELECT c.id FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.item_id = ?', [h, src]);
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); await sleep(100); await p.settle(); await p.choose(p.q('[data-filter="order"]'), String(go)); await sleep(150); await p.settle(); await p.click(p.q('[data-act="toggle"]', p.q(`[data-buyer="${h}"]`)));
  await p.click(p.q(`[data-act="fix"][data-id="${id}"]`)); await sleep(150); await p.settle(); const panel = () => p.q('[data-form="fix"]'); await p.choose(p.q('select[name="itemId"]', panel()), String(cap)); await p.click(p.q('input[name="pricing"][value="keep"]', panel())); await p.click(p.q('[data-act="fix-change"]', panel()));
  await sleep(250); await p.settle(); await press(p, 'Change it'); await sleep(250); await p.settle(); assert.match(p.text(modal(p)), /Sorry — “Full target” has reached its purchase limit \(limit 1 in total\)\.\s*Move it there anyway\? As the GOM you can go over a purchase limit\./);
  await press(p, "Don't move"); await sleep(250); await p.settle(); assert.equal((await app.q('SELECT item_id FROM claims WHERE id = ?', [id]))[0].item_id, src, 'unchanged'); assert.match(p.text(p.q('[data-fix-error]', panel()) || panel()), /has reached its purchase limit/);
  await p.click(p.q('[data-act="fix-change"]', panel())); await sleep(250); await p.settle(); await press(p, 'Change it'); await sleep(250); await p.settle(); await press(p, 'Move anyway'); await sleep(350); await p.settle(); assert.equal((await app.q('SELECT item_id FROM claims WHERE id = ?', [id]))[0].item_id, cap, 'moved'); p.close();
});

test('SETS TAB → ADD SOMEONE INTO A PART WHEN THE ITEM IS FULL: shows the reason and asks — "Don\'t add" leaves it empty with the reason on the form, "Add anyway" puts them in', async () => {
  const go = await goOrder(); const it = await item(go, { type: 'set', members: ['Han', 'Felix', 'Yuna'], title: 'Full set item', purchaseLimit: 2, limitScope: 'item' }); await claim([{ itemId: it, parts: [{ member: 'Han', qty: 1 }, { member: 'Felix', qty: 1 }] }]);
  const [{ id: setId }] = await app.q('SELECT id FROM item_sets WHERE item_id = ? ORDER BY set_number LIMIT 1', [it]); const h = u('hand');
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Sets')); await sleep(150); await p.settle(); const c = p.q(`[data-set-card="${setId}"]`) || p.q(`[data-act="toggle-set"][data-set="${setId}"]`)?.closest('.card, section, div');
  if (c && !p.q('table', c)) await p.click(p.q('[data-act="toggle-set"]', c)); await p.click(p.q(`[data-act="add"][data-set="${setId}"][data-member="Yuna"]`)); const form = () => p.q('form[data-form="assign"]');
  form().elements.handle.value = h; await p.submit(form()); await sleep(300); await p.settle(); assert.match(p.text(modal(p)), /Sorry — “Full set item” has reached its purchase limit \(limit 2 in total\)\.\s*Add them anyway\? As the GOM you can go over a purchase limit\./);
  await press(p, "Don't add"); await sleep(200); await p.settle(); assert.equal(await claimsN(it), 2, 'nothing was added'); assert.match(p.text(p.q('[data-msg]', form())), /has reached its purchase limit/);
  await p.submit(form()); await sleep(300); await p.settle(); await press(p, 'Add anyway'); await sleep(350); await p.settle(); assert.equal(await claimsN(it), 3, 'added, over the limit'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});
