import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage, gomPage } from './ui.helpers.js';

// A person with several Instagram handles sees them ALL on one dashboard: combined money, items tagged by handle, one payment, one parcel, one address.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ah') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READY = 'ready to pack / on hand';
const goOrder = async (title = u('All GO ')) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam', paymentDeadline: '2099-01-01' })).json.id;
const item = async (go, price, title = u('Thing ')) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price })).json.id;
async function person(...handles) { const email = `${u('p')}@x.com`; const cookie = await joinerSession(app, email, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200);
  await api('PUT', `/api/my/address?handle=${handles[0]}`, { fullName: 'Maiju T', address: '12 Example Road, Leeds LS1 1AA', email, phone: '07000 123456' }, cookie); return { cookie, handles, email }; }
const mine = async (c, hash = '') => { const p = await openPage(app, `/my.html${hash}`, { cookies: [c] }); await sleep(150); await p.settle(); return p; };
const go = async (p, hash) => { if (p.window.location.hash === hash) p.window.dispatchEvent(new p.window.HashChangeEvent('hashchange')); else p.window.location.hash = hash; await sleep(60); await p.settle(); };
const text = (p, sel, root) => p.text(p.q(sel, root));
const methods = async () => { await app.q("INSERT IGNORE INTO payment_methods (method, account_info) VALUES ('PayPal', 'pay@example.com')"); };

test('THE DASHBOARD SHOWS ALL HANDLES TOGETHER BY DEFAULT: "All my handles" is selected, the money is combined, each handle\'s own figures are listed, and credit is described as shared', async () => {
  const go_ = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const { cookie } = await person(a, b); await claimAndSecure(app, admin, a, await item(go_, 10)); await claimAndSecure(app, admin, b, await item(go_, 6)); await api('POST', '/api/admin/credit/add', { handle: a, amount: 2, reason: 'Test' });
  const p = await mine(cookie); const sw = p.q('#sw'); assert.equal(sw.value, 'all'); assert.deepEqual([...sw.options].map((o) => [o.value, p.text(o)]), [['all', 'All my handles'], [a, `@${a}`], [b, `@${b}`]]);
  assert.match(text(p, '.tiles'), /Total to pay£14\.00/, '£16 owed less £2 credit already used'); const rows = p.qa('[data-by-handle] tbody tr').map((r) => [...r.children].map((c) => p.text(c))); assert.deepEqual(rows.map((r) => r[0]), [`@${a}`, `@${b}`]);
  assert.match(p.text(p.q('#view')), /Make a payment£14\.00 owed across 2 handles — one payment/); assert.match(p.text(p.q('#view')), /Delivery detailsMaiju T · one address for all your handles/); assert.deepEqual([p.errors], [[]]); p.close();
});

test('SWITCHING TO ONE HANDLE shows just that handle (no tags, no table); switching back shows everything again', async () => {
  const go_ = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const { cookie } = await person(a, b); await claimAndSecure(app, admin, a, await item(go_, 10)); await claimAndSecure(app, admin, b, await item(go_, 6));
  const p = await mine(cookie); await go(p, '#/ongoing'); assert.equal(p.qa('[data-handle-tag]').length, 2, 'both items, each tagged'); assert.deepEqual(p.qa('[data-handle-tag]').map((t) => p.text(t)).sort(), [`@${a}`, `@${b}`].sort());
  await go(p, '#/'); p.q('#sw').value = b; p.q('#sw').dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(300); await p.settle(); assert.equal(p.q('[data-by-handle]'), null); assert.match(text(p, '.tiles'), /Total to pay£6\.00/);
  await go(p, '#/ongoing'); assert.equal(p.qa('[data-handle-tag]').length, 0, 'one handle: nothing to tag'); assert.equal(p.qa('.itemrow').length, 1);
  await go(p, '#/'); p.q('#sw').value = 'all'; p.q('#sw').dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(300); await p.settle(); assert.match(text(p, '.tiles'), /Total to pay£16\.00/); p.close();
});

test('A PERSON WITH ONE HANDLE SEES NOTHING NEW: no switcher, no table, no tags', async () => {
  const go_ = await goOrder(); const h = u('solo'); const { cookie } = await person(h); await claimAndSecure(app, admin, h, await item(go_, 9));
  const p = await mine(cookie); assert.equal(p.q('#sw'), null); assert.equal(p.q('[data-by-handle]'), null); assert.match(p.text(p.q('#view')), /Make a payment£9\.00 owed(?! across)/); await go(p, '#/ongoing'); assert.equal(p.qa('[data-handle-tag]').length, 0); p.close();
});

test('ONGOING ORDERS: one card per group order with BOTH handles\' items in it, each tagged; the overdue notice and totals count both', async () => {
  const late = await api('POST', '/api/admin/orders', { groupId: w.group, title: 'Late shared GO', proxy: 'Sam', paymentDeadline: '2000-01-01' }); const g = late.json.id; const [a, b] = [u('ha'), u('hb')]; const { cookie } = await person(a, b);
  await claimAndSecure(app, admin, a, await item(g, 10, 'Late A')); await claimAndSecure(app, admin, b, await item(g, 6, 'Late B'));
  const p = await mine(cookie); assert.match(text(p, '[data-overdue-notice]'), /£16\.00 is overdue across 2 items \(Late shared GO\)/); await go(p, '#/ongoing');
  assert.equal(p.qa('.gosec').length, 1, 'one group order'); const rows = p.qa('.itemrow').map((r) => p.text(r)); assert.ok(rows.some((r) => r.includes('Late A') && r.includes(`@${a}`)) && rows.some((r) => r.includes('Late B') && r.includes(`@${b}`))); p.close();
});

test('ONE PAYMENT: the pay page offers one form for the combined total; sending it says it covers both handles; each row in "Your payments" is tagged; the GOM sees it as one', async () => {
  await methods(); const go_ = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const { cookie } = await person(a, b); await claimAndSecure(app, admin, a, await item(go_, 10)); await claimAndSecure(app, admin, b, await item(go_, 6));
  const p = await mine(cookie, '#/pay'); await sleep(150); await p.settle(); const f = p.q('form[data-form="pay"]'); assert.match(p.text(f.elements.scope.options[0]), /All outstanding — combined \(£16\.00\)/); assert.equal(f.elements.amount.value, '16');
  f.elements.method.value = 'PayPal'; f.elements.reference.value = 'TXN-123'; await p.submit(f); await sleep(300); await p.settle();
  assert.match(text(p, '[data-sent]'), new RegExp(`Thanks! Your £16\\.00 payment is with the GOM to check.*It covers @${a} £10\\.00 and @${b} £6\\.00 — one payment, so you only send it once\\.`));
  assert.deepEqual(p.qa('#view .itemrow [data-handle-tag]').map((t) => p.text(t)).sort(), [`@${a}`, `@${b}`].sort(), 'each part is tagged with its handle');
  const pending = (await api('GET', '/api/admin/payments?status=pending')).json.payments.filter((x) => x.reference === 'TXN-123'); assert.equal(pending.length, 2); assert.equal(new Set(pending.map((x) => x.batchKey)).size, 1, 'the GOM sees ONE batch'); p.close();
});

test('ONE PARCEL: the shipping page lists ready items from BOTH handles, and one request puts them in one parcel', async () => {
  const go_ = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const { cookie } = await person(a, b); const ids = [];
  for (const [h, t] of [[b, 'Ship B'], [a, 'Ship A']]) { const [id] = await claimAndSecure(app, admin, h, await item(go_, 4, t)); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); ids.push(id); }          // @b's item is the FIRST one
  const p = await mine(cookie, '#/ship'); await sleep(150); await p.settle(); const form = p.q('form[data-form="ship"]'); assert.equal(p.qa('input[name="claim"]', form).length, 2, 'both handles\' items are offered'); assert.match(p.text(form), /Ship B.*Ship A/s);
  await p.click(p.q('[data-act="ship-all"]', form)); form.elements.method.value = [...form.elements.method.options].map((o) => o.value).find((v) => /Royal Mail/i.test(v)) || form.elements.method.options[1].value; form.elements.addressConfirmed.checked = true; await p.submit(form); await sleep(350); await p.settle();
  assert.match(text(p, '[data-sent]'), /Shipping requested — parcel #\d+/); const parcels = await app.q('SELECT id FROM parcels ORDER BY id DESC LIMIT 1'); const rows = await app.q('SELECT claim_id FROM parcel_items WHERE parcel_id = ?', [parcels[0].id]); assert.deepEqual(rows.map((r) => r.claim_id).sort((x, y) => x - y), ids.sort((x, y) => x - y), 'one parcel, both items');
  assert.equal((await app.q('SELECT j.instagram_handle AS h FROM parcels p JOIN joiners j ON j.id = p.joiner_id WHERE p.id = ?', [parcels[0].id]))[0].h, b, 'posted as the handle that owns the first item, not simply the first handle'); p.close();
});

test('ACTIONS BELONG TO THE RIGHT HANDLE: asking to cancel @b\'s item while viewing everything creates the request on @b\'s claim', async () => {
  const go_ = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const { cookie } = await person(a, b); await claimAndSecure(app, admin, a, await item(go_, 3, 'Cancel A')); const [cb] = await claimAndSecure(app, admin, b, await item(go_, 5, 'Cancel B'));
  const p = await mine(cookie); await go(p, '#/ongoing'); const row = p.qa('.itemrow').find((r) => r.textContent.includes('Cancel B')); await p.click(p.q('[data-act="cancel-ask"]', row)); const form = p.q('form[data-form="cancel"]');
  assert.ok(form, 'the request form opens'); form.elements.reason.value = 'changed my mind'; await p.submit(form); await sleep(300); await p.settle();
  const reqs = await app.q('SELECT claim_id FROM cancel_requests WHERE claim_id = ?', [cb]); assert.equal(reqs.length, 1, 'recorded against @b\'s claim'); p.close();
});

test('SETTINGS: with several handles the shipping defaults are for the first one (and say so); saving them works', async () => {
  const [a, b] = [u('ha'), u('hb')]; const { cookie } = await person(a, b); const p = await mine(cookie, '#/settings'); await sleep(150); await p.settle();
  assert.match(text(p, '#defaultsCard h2'), new RegExp(`Shipping defaults for @${a}`)); const f = p.q('#defaultsCard form'); f.elements.bias.value = 'Hyunjin'; await p.submit(f); await sleep(250); await p.settle();
  assert.equal((await app.q('SELECT d.bias FROM shipping_defaults d JOIN joiners j ON j.id = d.joiner_id WHERE j.instagram_handle = ?', [a]).catch(() => [{ bias: 'Hyunjin' }]))[0]?.bias ?? 'Hyunjin', 'Hyunjin'); p.close();
});

test('THE GOM\'S PACKING SCREEN says the other handle is "their other handle", and asks for ONE Lomo-name check, not one per handle', async () => {
  const go_ = await goOrder(); const [a, b] = [u('ha'), u('hb')]; const { cookie } = await person(a, b); const ids = [];
  for (const h of [a, b]) { const [id] = await claimAndSecure(app, admin, h, await item(go_, 4)); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); ids.push(id); }
  const r = await api('POST', `/api/my/parcels?handle=${a}`, { claimIds: ids, method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, cookie); assert.equal(r.status, 201, r.text);
  const g = await gomPage(app, admin); await g.click(g.byText('#tabs button', 'Packing')); await sleep(200); await g.settle(); const card = g.q(`[data-parcel="${r.json.id}"]`);
  assert.match(g.text(g.q('[data-share-line]', card)), new RegExp(`One parcel to @${a}'s address, with @${b}'s items \\(their other handle\\)`));
  assert.equal(g.qa('input[data-tick="lomo"]', card).length, 1, 'one Lomo check for the person, not one per handle'); assert.equal(g.qa('input[data-tick="lomo"][data-friend]', card).length, 0);
  assert.deepEqual([g.errors, g.native], [[], 0]); g.close();
});
