import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

// Claims → "Fix…" on a claim: change what it is (price question asked each time), delete it (when nothing has been paid), or turn a filler line into credit; and "Delete…" for a selection.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'fu') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READY = 'ready to pack / on hand';
const goOrder = async (title = u('FixUI GO '), extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam', ...extra })).json.id;
const item = async (go, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price: 10, ...extra })).json.id;
const sess = {};
const person = async (h) => { sess[h] = await joinerSession(app, `${h}@x.com`, h); return h; };
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const credit = async (h) => (await api('GET', '/api/my/summary', undefined, sess[h])).json.credit;
const payIn = async (h, amount) => { const r = await api('POST', '/api/my/payments', { method: 'PayPal', amount, reference: u('R') }, sess[h]); assert.equal((await api('POST', `/api/admin/payments/${r.json.id}/verify`, {})).status, 200); };
// open the Claims tab narrowed to one group order, and the person's row
async function open(go, handle) {
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); await sleep(100); await p.settle();
  await p.choose(p.q('[data-filter="order"]'), String(go)); await sleep(120); await p.settle();
  if (handle) await p.click(p.q('[data-act="toggle"]', p.q(`[data-buyer="${handle}"]`)));
  return p;
}
const fixBtn = (p, id) => p.q(`[data-act="fix"][data-id="${id}"]`);
const panel = (p) => p.q('[data-form="fix"]');
const f = (p, sel) => p.q(sel, panel(p));
const openFix = async (p, id) => { await p.click(fixBtn(p, id)); await sleep(150); await p.settle(); return panel(p); };
const mode = (p, m) => p.click(f(p, `[data-act="fix-mode"][data-mode="${m}"]`));
const claim1 = async (h) => (await claimsOf(h))[0];

test('THE PANEL: "Fix…" opens it with three choices (change / delete / credit), starting on "change what it is" with the current item filled in; Close and "Edit costs" put it away', async () => {
  const go = await goOrder(); const it = await item(go, { title: 'Original', price: 9 }); const h = await person(u()); const [id] = await claimAndSecure(app, admin, h, it);
  const p = await open(go, h); assert.ok(fixBtn(p, id)); await p.click(fixBtn(p, id)); await sleep(150); await p.settle();
  assert.match(p.text(f(p, '.row')), new RegExp(`Fix “Original” — @${h} · `)); assert.deepEqual(p.qa('[data-act="fix-mode"]', panel(p)).map((b) => [p.text(b), b.getAttribute('aria-pressed')]), [['Change what it is', 'true'], ['Delete it', 'false'], ['Turn into credit', 'false']]);
  assert.equal(f(p, 'select[name="orderId"]').value, String(go)); assert.equal(f(p, 'select[name="itemId"]').value, String(it)); assert.equal(f(p, '[data-ask-price]'), null, 'same item: no price question');
  await p.click(f(p, '[data-act="fix-close"]')); assert.equal(panel(p), null);
  const it2 = await item(go, { title: 'Second', price: 4 }); const [id2] = await claimAndSecure(app, admin, h, it2); const q = await open(go, h);
  await openFix(q, id); await q.click(fixBtn(q, id2)); await sleep(150); await q.settle(); assert.equal(q.qa('[data-form="fix"]').length, 1, 'only one panel at a time'); assert.match(q.text(f(q, '.row')), /Fix “Second”/, 'it moved to the other claim');
  assert.ok(q.q(`[data-claim="${id}"]`), 'the first claim is a normal row again'); await q.click(q.q(`[data-act="edit"][data-id="${id}"]`)); assert.equal(panel(q), null, 'opening Edit costs on another claim puts the Fix panel away'); assert.ok(q.q('[data-form="edit-costs"]'));
  assert.deepEqual([p.errors, p.native, q.errors, q.native], [[], 0, [], 0]); p.close(); q.close();
});

test('CHANGE THE ITEM: another group order and item; a different price asks the question (no default); re-price or keep; a confirmation says what happens; the row shows the new item', async () => {
  const g1 = await goOrder('Wrong order'), g2 = await goOrder('Right order'); const wrong = await item(g1, { title: 'Wrong album', price: 10 }), right = await item(g2, { title: 'Right album', price: 14 });
  const h = await person(u()); const [id] = await claimAndSecure(app, admin, h, wrong);
  const p = await open(g1, h); await openFix(p, id); await p.choose(f(p, 'select[name="orderId"]'), String(g2)); assert.deepEqual([...f(p, 'select[name="itemId"]').options].map((o) => p.text(o)).slice(1), ['Right album — £14.00'], 'only that order\'s items');
  await p.choose(f(p, 'select[name="itemId"]'), String(right)); assert.ok(f(p, '[data-ask-price]'), 'the price differs: asked'); assert.deepEqual(p.qa('input[name="pricing"]', panel(p)).map((r) => [r.value, r.checked]), [['reprice', false], ['keep', false]], 'no default');
  assert.match(p.text(panel(p)), /Re-price it — set it to the new item's price \(£14\.00\)\. What's already paid is kept, so any difference shows as owed or as credit\./); assert.match(p.text(panel(p)), /Keep the old price \(£10\.00\) — only what it's called changes\./); assert.match(p.text(panel(p)), /check the Proxy tab/);
  await p.click(f(p, '[data-act="fix-change"]')); assert.match(p.text(f(p, '[data-fix-error]')), /Choose whether to re-price it or keep the old price — there is no default\./); assert.equal((await claim1(h)).label, 'Wrong album', 'nothing changed');
  await p.click(f(p, 'input[name="pricing"][value="reprice"]')); await p.click(f(p, '[data-act="fix-change"]'));
  assert.match(p.text(modal(p)), /Change “Wrong album” to “Right album” for @.*\?.*Its price becomes £14\.00; what's paid is kept/s); await press(p, 'Not yet'); assert.equal((await claim1(h)).label, 'Wrong album', 'not yet means not yet');
  await p.click(f(p, '[data-act="fix-change"]')); await press(p, 'Change it'); await sleep(250); await p.settle();
  assert.match(toast(p), /Changed to “Right album” and re-priced\./); const c = await claim1(h); assert.deepEqual([c.label, c.orderTitle, c.costs.initials.cost], ['Right album', 'Right order', 14]); assert.equal(panel(p), null, 'the panel closes'); p.close();
});

test('KEEPING THE OLD PRICE leaves the cost alone; an item with the SAME PRICE asks nothing; another member or size of the same item asks nothing', async () => {
  const go = await goOrder(); const a = await item(go, { title: 'A', price: 10 }), same = await item(go, { title: 'Same price', price: 10 }), mem = await item(go, { type: 'independent', members: ['Felix', 'Han'], title: 'Card', price: 3 }), tee = await item(go, { type: 'size', variants: ['M', 'L'], title: 'Tee', price: 20 });
  const h = await person(u()); const [keepId] = await claimAndSecure(app, admin, h, a);
  const p = await open(go, h); await openFix(p, keepId); await p.choose(f(p, 'select[name="itemId"]'), String(tee)); await p.choose(f(p, 'select[name="variant"]'), 'L'); await p.click(f(p, 'input[name="pricing"][value="keep"]')); await p.click(f(p, '[data-act="fix-change"]')); await press(p, 'Change it'); await sleep(250); await p.settle();
  const c = await claim1(h); assert.deepEqual([c.label, c.costs.initials.cost], ['Tee (L)', 10], 'kept £10 although the Tee is £20');
  await openFix(p, keepId); assert.ok(f(p, 'select[name="variant"]')); await p.choose(f(p, 'select[name="variant"]'), 'M'); assert.equal(f(p, '[data-ask-price]'), null, 'same item, another size: no question'); await p.click(f(p, '[data-act="fix-change"]')); await press(p, 'Change it'); await sleep(250); await p.settle(); assert.equal((await claim1(h)).label, 'Tee (M)');
  await openFix(p, keepId); await p.choose(f(p, 'select[name="itemId"]'), String(same)); assert.equal(f(p, '[data-ask-price]'), null, 'same price: nothing to ask'); await p.click(f(p, '[data-act="fix-change"]')); await press(p, 'Change it'); await sleep(250); await p.settle(); assert.equal((await claim1(h)).label, 'Same price');
  await openFix(p, keepId); await p.choose(f(p, 'select[name="itemId"]'), String(mem)); await p.click(f(p, '[data-act="fix-change"]')); assert.match(p.text(f(p, '[data-fix-error]')), /Choose a member\./); p.close();
});

test('WHEN IT CANNOT BE CHANGED the panel says why and offers no form (a parcel; a member-set part is explained on the Sets tab)', async () => {
  const go = await goOrder(); const it = await item(go); const h = await person(u()); await api('PUT', '/api/my/address', { fullName: 'P Q', address: '1 Road, Leeds', email: `${h}@x.com`, phone: '0700123456' }, sess[h]);
  const [id] = await claimAndSecure(app, admin, h, it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); const par = await api('POST', '/api/my/parcels', { claimIds: [id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, sess[h]);
  const p = await open(go, h); await openFix(p, id); assert.match(p.text(f(p, '[data-fix-blocked]')), new RegExp(`It's in parcel #${par.json.id}\\.`)); assert.equal(f(p, '[data-act="fix-change"]'), null, 'no form to fill in'); p.close();
});

test('DELETE: nothing paid → "Delete it…" explains, asks, and removes it; paid, or in a parcel → the reasons and a pointer to Cancel, and no delete button', async () => {
  const go = await goOrder(); const it = await item(go, { price: 8, title: 'Dup item' }); const h = await person(u()); const [id] = await claimAndSecure(app, admin, h, it);
  const p = await open(go, h); await openFix(p, id); await mode(p, 'delete'); assert.match(p.text(panel(p)), /Removes it completely, as if it had never been added — it isn't kept anywhere, and it can't be undone\./); await p.click(f(p, '[data-act="fix-delete"]'));
  assert.match(p.text(modal(p)), /Delete “Dup item” for @.* completely\?.*as if it had never been added\. This can't be undone\./s); await press(p, 'Not yet'); assert.equal((await claimsOf(h)).length, 1);
  await p.click(f(p, '[data-act="fix-delete"]')); await press(p, 'Delete it'); await sleep(250); await p.settle(); assert.match(toast(p), /Deleted\./); assert.equal((await claimsOf(h)).length, 0); assert.equal(p.q(`[data-claim="${id}"]`), null);
  const h2 = await person(u()); const [paid] = await claimAndSecure(app, admin, h2, it); await payIn(h2, 8); const q = await open(go, h2); await openFix(q, paid); await mode(q, 'delete');
  assert.match(q.text(f(q, '[data-fix-blocked]')), /£8\.00 has been paid towards it — cancel it instead \(what was paid goes back to them as credit\)\./); assert.equal(f(q, '[data-act="fix-delete"]'), null); p.close(); q.close();
});

test('TURN INTO CREDIT: the amount starts as the line\'s price, the reason is filled in, it must be valid, it asks first, then credit appears and the line goes; when paid it points to Cancel', async () => {
  const go = await goOrder(); const filler = await item(go, { price: 20, title: 'Credit from Notion' }); const h = await person(u()); const [id] = await claimAndSecure(app, admin, h, filler);
  const p = await open(go, h); await openFix(p, id); await mode(p, 'credit'); assert.equal(f(p, 'input[name="amount"]').value, '20'); assert.equal(f(p, 'input[name="reason"]').value, 'Credit (was a filler line: “Credit from Notion”)');
  await p.type(f(p, 'input[name="amount"]'), '0'); await p.click(f(p, '[data-act="fix-credit"]')); assert.match(p.text(f(p, '[data-fix-error]')), /Enter the credit amount\./);
  await p.type(f(p, 'input[name="amount"]'), '18.5'); await p.type(f(p, 'input[name="reason"]'), '   '); await p.click(f(p, '[data-act="fix-credit"]')); assert.match(p.text(f(p, '[data-fix-error]')), /Enter a reason — they can see it\./);
  await p.type(f(p, 'input[name="reason"]'), 'Carried over from my Notion list'); await mode(p, 'change'); await mode(p, 'credit'); assert.equal(f(p, 'input[name="amount"]').value, '18.5', 'what you typed survives switching tabs');
  await p.click(f(p, '[data-act="fix-credit"]')); assert.match(p.text(modal(p)), /Add £18\.50 credit to @.* and remove “Credit from Notion”\?.*used on anything they owe straight away\. This can't be undone\./s); await press(p, 'Not yet'); assert.equal(await credit(h), 0);
  await p.click(f(p, '[data-act="fix-credit"]')); await press(p, 'Turn into credit'); await sleep(250); await p.settle(); assert.match(toast(p), /Added £18\.50 credit for @/); assert.equal(await credit(h), 18.5); assert.equal((await claimsOf(h)).length, 0);
  const h2 = await person(u()); const [paid] = await claimAndSecure(app, admin, h2, filler); await payIn(h2, 20); const q = await open(go, h2); await openFix(q, paid); await mode(q, 'credit'); assert.match(q.text(f(q, '[data-fix-blocked]')), /has been paid towards it — cancel it instead/); assert.equal(f(q, '[data-act="fix-credit"]'), null); p.close(); q.close();
});

test('SELECTED CLAIMS: "Delete…" checks first — the deletable ones are removed, the rest are left alone and named; when none can be deleted it says so', async () => {
  const go = await goOrder(); const it = await item(go, { price: 6, title: 'Bulk item' }); const hs = [u('bd'), u('bd'), u('bd')]; const ids = []; for (const h of hs) ids.push((await claimAndSecure(app, admin, h, it))[0]);
  const hp = await person(u('bp')); const [paid] = await claimAndSecure(app, admin, hp, it); await payIn(hp, 6);
  const p = await open(go); await p.click(p.byText('button', 'Expand all')); for (const id of [...ids, paid]) await p.click(p.q(`input[data-act="pick"][data-id="${id}"]`));
  await p.click(p.q('[data-act="bulk-delete"]')); assert.match(p.text(modal(p)), /Delete 3 claims completely\?.*1 can't be deleted and will be left alone \(for example “Bulk item” for @bp.*has been paid towards it.*They are removed as if they had never been added\. This can't be undone\./s);
  await press(p, 'Not yet'); assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE id IN (?)', [ids]))[0].n, 3, 'not yet means not yet');
  await p.click(p.q('[data-act="bulk-delete"]')); await press(p, 'Delete 3'); await sleep(300); await p.settle(); assert.match(toast(p), /Deleted 3\. 1 left alone\./); assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE id IN (?)', [ids]))[0].n, 0); assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE id = ?', [paid]))[0].n, 1);
  await p.click(p.byText('button', 'Expand all')); await p.click(p.q(`input[data-act="pick"][data-id="${paid}"]`)); await p.click(p.q('[data-act="bulk-delete"]')); await sleep(150); await p.settle(); assert.match(toast(p), /None of the 1 can be deleted — £6\.00 has been paid towards it/); p.close();
});

test('NAMES WITH HTML are shown as text in the panel, the dialogs and the results', async () => {
  const go = await goOrder('<img src=x onerror="window.pwned=1"> order'); const it = await item(go, { title: '<b>Bold</b> thing', price: 5 }); const h = await person(u('xs')); const [id] = await claimAndSecure(app, admin, h, it);
  const p = await open(go, h); await openFix(p, id); assert.equal(p.q('img[src="x"]', panel(p)), null); assert.equal(p.q('b', panel(p)), null); assert.equal(p.window.pwned, undefined); assert.match(p.text(f(p, '.row')), /Fix “<b>Bold<\/b> thing” — @.* · <img src=x onerror="window\.pwned=1"> order/);
  await mode(p, 'delete'); await p.click(f(p, '[data-act="fix-delete"]')); assert.match(p.text(modal(p)), /Delete “<b>Bold<\/b> thing”/); p.close();
});
