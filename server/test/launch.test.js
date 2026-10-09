import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { CONFIG_TABLES, ADMIN_TABLES, PEOPLE_TABLES, WIPE_TABLES } from '../src/lib/launch.js';

// Test data and launch: a TEST tick on orders, deleting a test order with everything on it, "Reset for launch", and the one-way "Go live" that switches both off for good.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'lt') => `${x}${++N}`;
const count = async (sql, a = [], a_ = app) => (await a_.q(sql, a))[0].n;
const order = async (extra = {}, a = app, ad = admin, group = w.group) => (await a.api('POST', '/api/admin/orders', { groupId: group, title: u('Launch GO '), ...extra }, ad)).json.id;
const item = async (go, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('L item '), price: 10, ...extra })).json.id;
const person = async (handle = u()) => ({ handle, email: `${handle}@x.com`, cookie: await joinerSession(app, `${handle}@x.com`, handle) });
const confirmed = async (p, it) => (await claimAndSecure(app, admin, p.handle, it))[0];
const pay = async (p, amount, orderId, extra = {}) => { const r = await api('POST', '/api/my/payments', { method: 'PayPal', amount, reference: u('r'), ...(orderId ? { orderId } : {}), ...extra }, p.cookie); assert.equal(r.status, 201, r.text); await api('POST', `/api/admin/payments/${r.json.id}/verify`, {}); return r.json.id; };
const credit = async (p) => (await api('GET', '/api/my/summary', undefined, p.cookie)).json.credit;
const png = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#2a9' } }).png().toBuffer();
const putPic = async (kind, id, a = app, ad = admin) => fetch(`${a.base}/api/admin/images/${kind}/${id}`, { method: 'PUT', headers: { cookie: ad, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: await png() }).then((r) => r.status);
const files = (a = app) => fs.readdirSync(a.cfg.uploadsDir).filter((f) => f.endsWith('.webp')).sort();
// every foreign key in the database still points at a row that exists — the generic "nothing is left dangling" check
async function dangling(a = app) {
  const fks = await a.q("SELECT TABLE_NAME t, COLUMN_NAME c, REFERENCED_TABLE_NAME rt, REFERENCED_COLUMN_NAME rc FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL");
  const bad = [];
  for (const f of fks) { const n = (await a.q(`SELECT COUNT(*) AS n FROM \`${f.t}\` x LEFT JOIN \`${f.rt}\` p ON p.\`${f.rc}\` = x.\`${f.c}\` WHERE x.\`${f.c}\` IS NOT NULL AND p.\`${f.rc}\` IS NULL`))[0].n; if (n) bad.push(`${f.t}.${f.c}→${f.rt}: ${n}`); }
  return bad;
}

test('EVERY TABLE IS CLASSIFIED for the reset (keep, admin-only, people, or wipe) — a table added by a future migration fails this test until someone decides', async () => {
  const all = (await app.q("SELECT TABLE_NAME n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'")).map((t) => t.n).sort();
  const classified = [...CONFIG_TABLES, ...ADMIN_TABLES, ...PEOPLE_TABLES, ...WIPE_TABLES];
  assert.equal(new Set(classified).size, classified.length, 'no table is listed twice');
  assert.deepEqual([...classified].sort(), all, 'every table, no more, no fewer');
});

test('THE TEST TICK: set on create or edit, visible to the GOM only, and never shown to joiners', async () => {
  const t = await order({ isTest: true }); const plain = await order();
  const list = (await api('GET', '/api/admin/orders')).json.orders;
  assert.deepEqual([list.find((o) => o.id === t).isTest, list.find((o) => o.id === plain).isTest], [true, false]);
  assert.equal((await api('PATCH', `/api/admin/orders/${plain}`, { isTest: true })).status, 200);
  assert.equal((await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === plain).isTest, true);
  assert.equal((await api('PATCH', `/api/admin/orders/${plain}`, { isTest: false })).status, 200);
  const pub = (await fetch(`${app.base}/api/orders`).then((r) => r.json())).orders.find((o) => o.id === t);
  assert.ok(pub && !('isTest' in pub), 'joiners never see it');
  const lau = (await api('GET', '/api/admin/launch')).json; assert.equal(lau.live, false); assert.ok(lau.testOrders.some((o) => o.id === t));
  assert.equal((await app.api('GET', '/api/admin/launch')).status, 401);
});

test('DELETING A TEST ORDER removes EVERYTHING on it — claims, the payments made towards them, the credit those moved, parcel, box, proxy payment, pictures — and nothing else', async () => {
  const keepGo = await order(); const keepItem = await item(keepGo); const bystander = await person(); const kc = await confirmed(bystander, keepItem); await pay(bystander, 10);
  const prior = await person(); await api('POST', '/api/admin/credit/add', { handle: prior.handle, amount: 5, reason: 'goodwill' });
  const go = await order({ isTest: true, proxy: 'Sam' }); const a = await item(go, { title: 'Test A' }), b = await item(go, { title: 'Test B' });
  assert.equal(await putPic('order', go), 200); assert.equal(await putPic('item', a), 200);
  const picsBefore = files().length;
  await api('PUT', '/api/my/address', { fullName: 'Pri Or', address: '1 Road, Leeds', email: prior.email, phone: '0700123456' }, prior.cookie);
  const c1 = await confirmed(prior, a); await pay(prior, 5, go);                                              // her £5 credit is used automatically, she pays the other £5
  const c2 = await confirmed(await person(), b);
  await api('PATCH', `/api/admin/claims/${c1}`, { pipeline: 'ready to pack / on hand' });
  const par = await api('POST', '/api/my/parcels', { claimIds: [c1], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, prior.cookie); assert.equal(par.status, 201);
  await api('PATCH', `/api/admin/claims/${c2}`, { pipeline: 'arrived at proxy / warehouse' });
  const box = await api('POST', '/api/admin/boxes', { claimIds: [c2], emsTotal: 10, customsTotal: 0, totalWeightG: 500 }); assert.equal(box.status, 201, box.text);
  const pp = await api('POST', '/api/admin/proxy/payments', { proxy: 'Sam', keys: [`item:${b}`] }); assert.equal(pp.status, 201, pp.text);
  const pl = (await api('GET', `/api/admin/orders/${go}/test-delete-plan`)).json;
  assert.deepEqual(pl.blockers, []); assert.deepEqual(pl.removes, { items: 2, claims: 2, people: 2, payments: 1, money: 5, ledgerRows: pl.removes.ledgerRows, parcels: 1, boxes: 1, proxyPayments: 1 });
  assert.equal((await api('POST', `/api/admin/orders/${go}/test-delete`, { confirm: 'wrong' })).status, 400);
  const r = await api('POST', `/api/admin/orders/${go}/test-delete`, { confirm: (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).title.toUpperCase() });
  assert.equal(r.status, 200, r.text);
  for (const [t, col, id] of [['group_orders', 'id', go], ['items', 'order_id', go], ['claims', 'order_id', go]]) assert.equal(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`, [id]), 0, t);
  assert.equal(await count('SELECT COUNT(*) AS n FROM parcels WHERE id = ?', [par.json.id]) + await count('SELECT COUNT(*) AS n FROM boxes WHERE id = ?', [box.json.id]) + await count('SELECT COUNT(*) AS n FROM proxy_payments WHERE id = ?', [pp.json.id]), 0, 'parcel, box and proxy payment are gone');
  assert.equal(await count('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [go]), 0);
  assert.equal(files().length, picsBefore - 4, 'both pictures (and their thumbnails) are off the disk');
  assert.equal(await credit(prior), 5, 'her credit is exactly what it was before the test order');
  assert.equal(await credit(bystander), 0); assert.equal((await app.q('SELECT status FROM claims WHERE id = ?', [kc]))[0].status, 'confirmed', 'a different order is untouched, money and all');
  assert.equal(await count('SELECT COUNT(*) AS n FROM joiners WHERE instagram_handle = ?', [prior.handle]), 1, 'the people remain');
  assert.deepEqual(await dangling(), [], 'nothing left pointing at what was deleted');
  assert.equal((await api('POST', `/api/admin/orders/${go}/test-delete`, { confirm: 'x' })).status, 404);
});

test('A TEST DELETE REFUSES — and changes nothing — when something on the order is SHARED with another order, or the order is not a test order', async () => {
  const plain = await order(); const pi = await item(plain); const p0 = await person(); await confirmed(p0, pi);
  const r0 = await api('POST', `/api/admin/orders/${plain}/test-delete`, { confirm: 'x' }); assert.equal(r0.status, 409); assert.equal(r0.json.code, 'not_test');
  // one payment that paid for a test order AND another order
  const test = await order({ isTest: true }); const ti = await item(test); const other = await order(); const oi = await item(other);
  const p = await person(); const ct = await confirmed(p, ti); await confirmed(p, oi); const payId = await pay(p, 20);
  const pl = (await api('GET', `/api/admin/orders/${test}/test-delete-plan`)).json;
  assert.ok(pl.blockers.some((b) => b.kind === 'payment' && b.id === payId), JSON.stringify(pl.blockers));
  const title = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === test).title;
  const r = await api('POST', `/api/admin/orders/${test}/test-delete`, { confirm: title }); assert.equal(r.status, 409); assert.equal(r.json.code, 'cannot_delete'); assert.match(r.json.error, /payment #\d+ also paid for other orders/);
  assert.deepEqual([await count('SELECT COUNT(*) AS n FROM group_orders WHERE id = ?', [test]), (await app.q('SELECT status FROM claims WHERE id = ?', [ct]))[0].status, await credit(p)], [1, 'confirmed', 0], 'not a thing was touched');
  // a parcel holding items from two orders
  const t2 = await order({ isTest: true }); const t2i = await item(t2); const o2 = await order(); const o2i = await item(o2);
  const q = await person(); await api('PUT', '/api/my/address', { fullName: 'Mix Ed', address: '1 Road, Leeds', email: q.email, phone: '0700123456' }, q.cookie);
  const [x, y] = [await confirmed(q, t2i), await confirmed(q, o2i)]; for (const id of [x, y]) await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' });
  const par = await api('POST', '/api/my/parcels', { claimIds: [x, y], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, q.cookie); assert.equal(par.status, 201);
  assert.ok((await api('GET', `/api/admin/orders/${t2}/test-delete-plan`)).json.blockers.some((b) => b.kind === 'parcel' && b.id === par.json.id));
});

test('IF REMOVING IT WOULD LEAVE SOMEONE\'S CREDIT NEGATIVE (the credit it earned was spent on another order) it is refused and everything is rolled back', async () => {
  const test = await order({ isTest: true }); const ti = await item(test); const p = await person(); await confirmed(p, ti);
  const payId = await pay(p, 20, undefined, { overpay: { choice: 'credit' } });                                       // £10 owed → £10 overpaid → credit
  assert.equal(await credit(p), 10, 'the overpayment became credit');
  const realGo = await order(); const ri = await item(realGo); await confirmed(p, ri);                          // a REAL order: the credit is applied to it
  assert.equal(await credit(p), 0, 'and is spent');
  const title = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === test).title;
  const r = await api('POST', `/api/admin/orders/${test}/test-delete`, { confirm: title });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'credit_tied_up'); assert.match(r.json.error, /credit negative.*tied up with another order/);
  assert.deepEqual([await count('SELECT COUNT(*) AS n FROM group_orders WHERE id = ?', [test]), await count('SELECT COUNT(*) AS n FROM payments WHERE id = ?', [payId])], [1, 1], 'rolled back');
  assert.equal(await credit(p), 0);
});

test('RESET FOR LAUNCH wipes every order, claim, payment, parcel, box, proxy payment, picture and log — and keeps your setup and your own login; the site works normally afterwards', async () => {
  const a2 = await startApp(); const ad2 = await a2.adminLogin(); const w2 = await seed(a2, ad2);
  const ap = (m, p, b, c = ad2) => a2.api(m, p, b, c);
  const go = (await ap('POST', '/api/admin/orders', { groupId: w2.group, title: 'Reset GO', proxy: 'Sam' })).json.id; const it = (await ap('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'R item', price: 10 })).json.id;
  await putPic('order', go, a2, ad2); await putPic('item', it, a2, ad2); await putPic('group', w2.group, a2, ad2);
  const h = u('rs'); const cookie = await joinerSession(a2, `${h}@x.com`, h); await ap('PUT', '/api/my/address', { fullName: 'Re Set', address: '1 Road, Leeds', email: `${h}@x.com`, phone: '0700' }, cookie);
  const [cid] = await claimAndSecure(a2, ad2, h, it); const pm = await ap('POST', '/api/my/payments', { method: 'PayPal', amount: 10, reference: 'RS' }, cookie); await ap('POST', `/api/admin/payments/${pm.json.id}/verify`, {});
  await ap('POST', '/api/admin/shop', { title: 'Shop stuff', price: 2, qty: 3 }); await ap('POST', '/api/admin/proxy/payments', { proxy: 'Sam', keys: [`item:${it}`] });
  const ordersBefore = await count('SELECT COUNT(*) AS n FROM group_orders', [], a2);
  const before = { groups: await count('SELECT COUNT(*) AS n FROM artist_groups', [], a2), methods: await count('SELECT COUNT(*) AS n FROM payment_methods', [], a2), proxies: await count('SELECT COUNT(*) AS n FROM proxies', [], a2) };
  const groupPics = (await a2.q('SELECT filename FROM images WHERE id = (SELECT cover_image_id FROM artist_groups WHERE id = ?)', [w2.group])).map((x) => x.filename);
  assert.ok(files(a2).length >= 6, 'pictures exist'); void cid;
  // refusals first: nothing happens without the word, the backup tick, and the keep-people choice
  for (const [body, re] of [[{ confirm: 'reset', backupConfirmed: true }, /keepPeople|Required/i], [{ confirm: 'reset', keepPeople: false }, /Take a backup first/], [{ confirm: 'reset', backupConfirmed: false, keepPeople: false }, /Take a backup first/], [{ confirm: 'nope', backupConfirmed: true, keepPeople: false }, /type RESET/]]) {
    const r = await ap('POST', '/api/admin/launch/reset', body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.text, re);
  }
  assert.equal(await count('SELECT COUNT(*) AS n FROM group_orders', [], a2), ordersBefore, 'nothing was reset by those');
  const r = await ap('POST', '/api/admin/launch/reset', { confirm: ' Reset ', backupConfirmed: true, keepPeople: false }); assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.removed.orders, r.json.removed.claims, r.json.removed.payments, r.json.removed.people, r.json.removed.accounts], [ordersBefore, 1, 1, 1, 1]);
  for (const t of ['group_orders', 'items', 'claims', 'claim_costs', 'payments', 'payment_allocations', 'credit_ledger', 'parcels', 'boxes', 'proxy_payments', 'proxy_payment_items', 'leftover_items', 'joiners', 'addresses', 'login_tokens', 'handle_proofs', 'notification_log']) assert.equal(await count(`SELECT COUNT(*) AS n FROM \`${t}\``, [], a2), 0, `${t} is empty`);
  assert.equal(await count('SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 0', [], a2), 0);
  assert.deepEqual({ groups: await count('SELECT COUNT(*) AS n FROM artist_groups', [], a2), methods: await count('SELECT COUNT(*) AS n FROM payment_methods', [], a2), proxies: await count('SELECT COUNT(*) AS n FROM proxies', [], a2) }, before, 'your setup is kept');
  assert.equal(await count('SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 1', [], a2), 1, 'and the GOM login');
  assert.equal((await ap('GET', '/api/admin/orders')).status, 200, 'the GOM is still signed in');
  assert.deepEqual((await a2.q('SELECT filename FROM images')).map((x) => x.filename).sort(), groupPics.sort(), 'only the group\'s own picture is left');
  assert.deepEqual(files(a2).filter((f) => !groupPics.includes(f) && !groupPics.map((g) => g.replace('.webp', '-t.webp')).includes(f)), [], 'and no stray picture files');
  assert.deepEqual(await dangling(a2), [], 'nothing anywhere points at something that no longer exists');
  assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'launch.reset'", [], a2), 1); assert.equal(await count('SELECT COUNT(*) AS n FROM audit_log', [], a2), 1, 'the log starts fresh, with the reset itself');
  assert.equal((await a2.api('GET', '/api/my/summary', undefined, cookie)).status, 401, 'the old test person is signed out');
  // …and it all works normally again
  const g2 = (await ap('POST', '/api/admin/orders', { groupId: w2.group, title: 'After reset' })).json.id; const i2 = (await ap('POST', `/api/admin/orders/${g2}/items`, { type: 'normal', title: 'Fresh', price: 5 })).json.id;
  const c2 = await joinerSession(a2, 'fresh@x.com', 'fresh_h'); assert.ok([200, 201].includes((await a2.api('POST', '/api/claims', { handle: 'fresh_h', lines: [{ itemId: i2 }] })).status));
  void c2; await a2.stop();
});

test('RESET, KEEPING PEOPLE: accounts, handles, delivery details and saved defaults stay (and can still sign in); their orders, payments and credit are gone', async () => {
  const a2 = await startApp(); const ad2 = await a2.adminLogin(); const w2 = await seed(a2, ad2); const ap = (m, p, b, c = ad2) => a2.api(m, p, b, c);
  const go = (await ap('POST', '/api/admin/orders', { groupId: w2.group, title: 'Keep people GO' })).json.id; const it = (await ap('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'K item', price: 10 })).json.id;
  const h = u('kp'); const cookie = await joinerSession(a2, `${h}@x.com`, h);
  await ap('PUT', '/api/my/address', { fullName: 'Keep Me', address: '1 Road, Leeds', email: `${h}@x.com`, phone: '0700' }, cookie); await ap('PUT', '/api/my/defaults', { bias: 'Han' }, cookie);
  await claimAndSecure(a2, ad2, h, it); await ap('POST', '/api/admin/credit/add', { handle: h, amount: 7, reason: 'g' });
  const r = await ap('POST', '/api/admin/launch/reset', { confirm: 'RESET', backupConfirmed: true, keepPeople: true }); assert.equal(r.status, 200, r.text); assert.equal(r.json.removed.people, 0);
  assert.deepEqual([await count('SELECT COUNT(*) AS n FROM joiners', [], a2), await count('SELECT COUNT(*) AS n FROM addresses', [], a2), await count('SELECT COUNT(*) AS n FROM joiner_defaults', [], a2), await count('SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 0', [], a2)], [1, 1, 1, 1]);
  assert.deepEqual([await count('SELECT COUNT(*) AS n FROM claims', [], a2), await count('SELECT COUNT(*) AS n FROM credit_ledger', [], a2), await count('SELECT COUNT(*) AS n FROM group_orders', [], a2)], [0, 0, 0]);
  const me = await a2.api('GET', '/api/my/summary', undefined, cookie); assert.equal(me.status, 200, 'still signed in'); assert.deepEqual([me.json.credit, me.json.orders.length], [0, 0]);
  assert.equal((await a2.api('GET', '/api/my/address', undefined, cookie)).json.address.fullName, 'Keep Me');
  assert.deepEqual(await dangling(a2), []); await a2.stop();
});

test('GO LIVE is one-way: it needs the words, then reset, test deletes and new test ticks are switched off for good (clearing a tick is still fine)', async () => {
  const a2 = await startApp(); const ad2 = await a2.adminLogin(); const w2 = await seed(a2, ad2); const ap = (m, p, b, c = ad2) => a2.api(m, p, b, c);
  const t = (await ap('POST', '/api/admin/orders', { groupId: w2.group, title: 'Live Test GO', isTest: true })).json.id;
  assert.equal((await ap('POST', '/api/admin/launch/go-live', { confirm: 'go' })).status, 400); assert.equal((await ap('GET', '/api/admin/launch')).json.live, false);
  const g = await ap('POST', '/api/admin/launch/go-live', { confirm: ' go  LIVE ' }); assert.equal(g.status, 200); assert.equal(g.json.live, true); assert.ok(g.json.launchedAt);
  const st = (await ap('GET', '/api/admin/launch')).json; assert.equal(st.live, true);
  for (const [path, body] of [['/api/admin/launch/reset', { confirm: 'RESET', backupConfirmed: true, keepPeople: false }], ['/api/admin/launch/go-live', { confirm: 'GO LIVE' }], [`/api/admin/orders/${t}/test-delete`, { confirm: 'Live Test GO' }]]) {
    const r = await ap('POST', path, body); assert.equal(r.status, 403, path); assert.equal(r.json.code, 'launched'); assert.match(r.json.error, /The site is live, so this is switched off for good/);
  }
  assert.equal((await ap('GET', `/api/admin/orders/${t}/test-delete-plan`)).status, 403);
  assert.equal(await count('SELECT COUNT(*) AS n FROM group_orders WHERE id = ?', [t], a2), 1, 'nothing was deleted');
  assert.equal((await ap('POST', '/api/admin/orders', { groupId: w2.group, title: 'New test', isTest: true })).status, 403, 'no new test orders once live');
  assert.equal((await ap('PATCH', `/api/admin/orders/${t}`, { isTest: true })).status, 403, 'setting the tick is refused');
  assert.equal((await ap('PATCH', `/api/admin/orders/${t}`, { isTest: false })).status, 200, 'but taking the tick off is fine');
  assert.equal((await ap('POST', '/api/admin/orders', { groupId: w2.group, title: 'A real order' })).status, 201, 'normal work carries on');
  await a2.stop();
});

test('ONLY THE GOM can use any of it', async () => {
  const j = await app.login(`${u('jj')}@x.com`); const t = await order({ isTest: true });
  for (const [m, p, b] of [['GET', '/api/admin/launch'], ['POST', '/api/admin/launch/go-live', { confirm: 'GO LIVE' }], ['POST', '/api/admin/launch/reset', { confirm: 'RESET', backupConfirmed: true, keepPeople: false }], ['GET', `/api/admin/orders/${t}/test-delete-plan`], ['POST', `/api/admin/orders/${t}/test-delete`, { confirm: 'x' }]]) {
    assert.equal((await api(m, p, b, j)).status, 403, `${m} ${p}`); assert.equal((await app.api(m, p, b)).status, 401, `${m} ${p}`);
  }
  assert.equal((await api('GET', '/api/admin/launch')).json.live, false, 'nothing happened');
});

test('CONCURRENCY: deleting a test order while people claim on it never causes a server error or a deadlock, and leaves no orphan', async () => {
  for (let round = 0; round < 6; round++) {
    const go = await order({ isTest: true }); const it = await item(go); const title = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).title;
    const hs = Array.from({ length: 4 }, () => u('tr'));
    const rs = await Promise.all([...hs.map((h) => app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: it }] })), api('POST', `/api/admin/orders/${go}/test-delete`, { confirm: title })]);
    assert.ok(rs.every((r) => r.status < 500), `round ${round}: ${rs.map((r) => r.status)}`);
    assert.equal(await count('SELECT COUNT(*) AS n FROM claims WHERE order_id = ?', [go]), 0, `round ${round}: no claim left on a deleted order`);
  }
  assert.deepEqual(await dangling(), []);
});
