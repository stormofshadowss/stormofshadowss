import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';

let app, admin, w;
before(async () => {
  app = await startApp();
  admin = await app.adminLogin();
  w = await seed(app, admin);
});
after(async () => { await app.stop(); });

test('anyone can browse open GOs, but private ones are invisible', async () => {
  const r = await app.api('GET', '/api/orders');
  assert.equal(r.status, 200);
  const titles = r.json.orders.map((o) => o.title);
  assert.ok(titles.includes('Run It GO'));
  assert.ok(!titles.includes('Off-site Weverse'), 'private GO is not listed');
  assert.ok(!JSON.stringify(r.json).includes('Secret thing'), 'nor are its items');
});

test("an item's own pay-by date beats the GO's; proxies stay private to the GOM", async () => {
  const pub = (await app.api('GET', '/api/orders')).json.orders[0];
  const byTitle = Object.fromEntries(pub.items.map((i) => [i.title, i]));
  assert.equal(byTitle.Keyring.payBy, '2099-01-10', "falls back to the GO's date");
  assert.equal(byTitle.Album.payBy, '2099-02-02', 'own date wins');
  assert.ok(!('proxy' in byTitle.Album), 'proxy names are not public');
  const adm = (await app.api('GET', '/api/admin/orders', undefined, admin)).json.orders.find((o) => o.title === 'Run It GO');
  const a = Object.fromEntries(adm.items.map((i) => [i.title, i]));
  assert.equal(a.Album.proxy, 'Lulu');
  assert.equal(a.Keyring.proxy, 'Sam', 'inherits the GO proxy');
  assert.equal(a.Album.ownPaymentDeadline, '2099-02-02');
});

test('clearing an item override puts it back on the GO\'s date and proxy', async () => {
  assert.equal((await app.api('PATCH', `/api/admin/items/${w.album}`, { paymentDeadline: null, proxy: null }, admin)).status, 200);
  const adm = (await app.api('GET', '/api/admin/orders', undefined, admin)).json.orders.find((o) => o.title === 'Run It GO');
  const album = adm.items.find((i) => i.title === 'Album');
  assert.equal(album.payBy, '2099-01-10');
  assert.equal(album.proxy, 'Sam');
  await app.api('PATCH', `/api/admin/items/${w.album}`, { paymentDeadline: '2099-02-02', proxy: 'Lulu' }, admin);
});

test('claiming needs no sign-in: handle only, status requested, cost = price', async () => {
  const r = await app.api('POST', '/api/claims', { handle: '@Quick_Joiner', lines: [{ itemId: w.keyring, qty: 2 }, { itemId: w.hoodie, variant: 'L' }, { itemId: w.photocards, member: 'Han' }] });
  assert.equal(r.status, 201);
  assert.equal(r.json.claimIds.length, 4);
  const rows = await app.q('SELECT c.label, c.status, c.size_bucket, cc.cost, j.instagram_handle FROM claims c JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category = \'initials\' JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? ORDER BY c.id', ['quick_joiner']);
  assert.deepEqual(rows.map((x) => [x.label, x.status, Number(x.cost)]), [
    ['Keyring', 'requested', 6], ['Keyring', 'requested', 6], ['Hoodie (L)', 'requested', 50], ['Solo Photocards — Han', 'requested', 8],
  ]);
  assert.equal(rows[2].size_bucket, 'L', 'size bucket comes from the item');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE claim_id = ?', [r.json.claimIds[0]]))[0].n, 5, 'all five cost lines exist (initials, EMS, customs, postage, packaging)');
});

test('requested claims are not debts: nothing is owed until the GOM secures them', async () => {
  const c = await joinerSession(app, 'notyet@example.com', 'notyet_h');
  await app.api('POST', '/api/claims', { handle: 'notyet_h', lines: [{ itemId: w.keyring }] });
  const s = (await app.api('GET', '/api/my/summary', undefined, c)).json;
  assert.equal(s.owed.total, 0);
  assert.equal(s.orders[0].claims[0].status, 'requested');
});

test('claim validation', async () => {
  const claim = (b) => app.api('POST', '/api/claims', b);
  assert.equal((await claim({ handle: 'has space', lines: [{ itemId: w.keyring }] })).status, 400);
  assert.equal((await claim({ handle: 'ok_h', lines: [] })).status, 400);
  assert.equal((await claim({ handle: 'ok_h', lines: [{ itemId: 999999 }] })).status, 404);
  assert.equal((await claim({ handle: 'ok_h', lines: [{ itemId: w.photocards }] })).status, 400, 'independent needs a member');
  assert.equal((await claim({ handle: 'ok_h', lines: [{ itemId: w.photocards, member: 'Nobody' }] })).status, 400);
  assert.equal((await claim({ handle: 'ok_h', lines: [{ itemId: w.hoodie, variant: 'XXL' }] })).status, 400);
  assert.equal((await claim({ handle: 'ok_h', lines: [{ itemId: w.keyring, qty: 21 }] })).status, 400);
  assert.equal((await claim({ handle: 'ok_h', lines: [{ itemId: w.keyring, qty: 0 }] })).status, 400);
});

test("a private GO's items look like they don't exist", async () => {
  const r = await app.api('POST', '/api/claims', { handle: 'curious_h', lines: [{ itemId: w.secretItem }] });
  assert.equal(r.status, 404);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM joiners WHERE instagram_handle = 'curious_h'"))[0].n, 0, 'nothing was created');
});

test('a failed line rolls back the whole claim (all or nothing)', async () => {
  const r = await app.api('POST', '/api/claims', { handle: 'atomic_h', lines: [{ itemId: w.keyring }, { itemId: 999999 }] });
  assert.equal(r.status, 404);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = 'atomic_h'"))[0].n, 0);
});

test('closed orders refuse new claims; reopening works', async () => {
  const closed = (await app.api('POST', '/api/admin/orders', { groupId: w.group, title: 'Closed GO', status: 'closed' }, admin)).json.id;
  const item = (await app.api('POST', `/api/admin/orders/${closed}/items`, { type: 'normal', title: 'Late thing', price: 5 }, admin)).json.id;
  const r = await app.api('POST', '/api/claims', { handle: 'late_h', lines: [{ itemId: item }] });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'order_closed');
  await app.api('PATCH', `/api/admin/orders/${closed}`, { status: 'open' }, admin);
  assert.equal((await app.api('POST', '/api/claims', { handle: 'late_h', lines: [{ itemId: item }] })).status, 201);
});

test('securing: by GO or by id, only touches requested claims, and is admin-only', async () => {
  const c = await joinerSession(app, 'sec@example.com', 'sec_h');
  const ids = (await app.api('POST', '/api/claims', { handle: 'sec_h', lines: [{ itemId: w.keyring, qty: 3 }] })).json.claimIds;
  assert.equal((await app.api('POST', '/api/admin/claims/secure', { claimIds: ids }, c)).status, 403);
  const one = await app.api('POST', '/api/admin/claims/secure', { claimIds: [ids[0]] }, admin);
  assert.equal(one.json.secured, 1);
  assert.equal((await app.api('GET', '/api/my/summary', undefined, c)).json.owed.initials, 6);
  const rest = await app.api('POST', '/api/admin/claims/secure', { claimIds: ids }, admin);
  assert.equal(rest.json.secured, 2, 'the already-confirmed one is not touched again');
  assert.equal((await app.api('GET', '/api/my/summary', undefined, c)).json.owed.initials, 18);
  assert.equal((await app.api('POST', '/api/admin/claims/secure', {}, admin)).status, 400);
});

test('catalogue input is validated', async () => {
  assert.equal((await app.api('POST', '/api/admin/orders', { groupId: w.group, title: 'X', paymentDeadline: '10/01/2099' }, admin)).status, 400);
  assert.equal((await app.api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: 'Neg', price: -1 }, admin)).status, 400);
  assert.equal((await app.api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: 'Pennies', price: 1.005 }, admin)).status, 400);
  assert.equal((await app.api('POST', `/api/admin/orders/${w.order}/items`, { type: 'size', title: 'No sizes', price: 5 }, admin)).status, 400);
  assert.equal((await app.api('POST', '/api/admin/orders/999999/items', { type: 'normal', title: 'Z', price: 5 }, admin)).status, 404);
});

test('payment methods: GOM edits, signed-in joiners read', async () => {
  const c = await app.login('methods@example.com');
  assert.equal((await app.api('GET', '/api/payment-methods')).status, 401);
  assert.equal((await app.api('PUT', '/api/admin/payment-methods', { methods: [] }, c)).status, 403);
  await app.api('PUT', '/api/admin/payment-methods', { methods: [{ method: 'PayPal', accountInfo: '@storm (F&F)' }, { method: 'Wise', accountInfo: '@stormw' }] }, admin);
  assert.deepEqual((await app.api('GET', '/api/payment-methods', undefined, c)).json.methods, [{ method: 'PayPal', accountInfo: '@storm (F&F)' }, { method: 'Wise', accountInfo: '@stormw' }]);
  await app.api('PUT', '/api/admin/payment-methods', { methods: [] }, admin);
});

test('a set whose parts cost different amounts, where every part must be claimed', async () => {
  const id = (await app.api('POST', `/api/admin/orders/${w.order}/items`, {
    type: 'set', title: 'Seasons Greetings', price: 3, requiresFullSet: true,
    members: ['Bang Chan', 'Han', { name: 'Diary', price: 2 }, { name: 'Washi tape', price: 1 }],
  }, admin)).json.id;
  const item = (await app.api('GET', '/api/orders')).json.orders.find((o) => o.title === 'Run It GO').items.find((i) => i.id === id);
  assert.deepEqual(item.members, [
    { name: 'Bang Chan', price: 3 }, { name: 'Han', price: 3 }, { name: 'Diary', price: 2 }, { name: 'Washi tape', price: 1 },
  ], 'parts without their own price use the item price');
  assert.equal(item.wholeSetPrice, 9);
  assert.equal(item.requiresFullSet, true);
  const stored = await app.q('SELECT name, price FROM item_members WHERE item_id = ? ORDER BY sort_order', [id]);
  assert.deepEqual(stored.map((m) => [m.name, m.price === null ? null : Number(m.price)]), [['Bang Chan', null], ['Han', null], ['Diary', 2], ['Washi tape', 1]], 'only the exceptions store a price');
});

test('an ordinary set is unaffected: one price, 7/8-style, no full-set requirement', async () => {
  const id = (await app.api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: 'Plain set', price: 8, members: ['A', 'B', 'C'] }, admin)).json.id;
  const item = (await app.api('GET', '/api/orders')).json.orders.find((o) => o.title === 'Run It GO').items.find((i) => i.id === id);
  assert.deepEqual(item.members.map((m) => m.price), [8, 8, 8]);
  assert.equal(item.wholeSetPrice, 24);
  assert.equal(item.requiresFullSet, false);
});

test('part prices and the full-set rule are validated', async () => {
  const mk = (b) => app.api('POST', `/api/admin/orders/${w.order}/items`, { title: 'X', price: 3, ...b }, admin);
  assert.equal((await mk({ type: 'set', members: ['A', 'a'] })).status, 400, 'duplicate part names (case-insensitive)');
  assert.equal((await mk({ type: 'set', members: [{ name: 'A', price: -1 }] })).status, 400, 'negative part price');
  assert.equal((await mk({ type: 'set', members: [{ name: 'A', price: 1.005 }] })).status, 400, 'more than 2 decimal places');
  assert.equal((await mk({ type: 'independent', members: [{ name: 'A', price: 2 }] })).status, 400, 'part prices are for sets only');
  assert.equal((await mk({ type: 'normal', requiresFullSet: true })).status, 400, '"every part" is for sets only');
  assert.equal((await mk({ type: 'set', members: [{ name: 'A', price: 0 }] })).status, 201, 'a free part is allowed');
});

// ───────────── product descriptions ─────────────
const addItem = (body) => app.api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', price: 5, ...body }, admin);
const itemById = async (id, publicView = true) => {
  const r = publicView ? await app.api('GET', '/api/orders') : await app.api('GET', '/api/admin/orders', undefined, admin);
  return r.json.orders.flatMap((o) => o.items).find((i) => i.id === id);
};

test('descriptions: an item can have one; it is trimmed, keeps line breaks, emoji and £, and appears in the public and the GOM catalogue', async () => {
  const text = '  Includes:\n• 1 photobook (£20 value)\n• 2 photocards 💌\n\nShips with the next box.  ';
  const id = (await addItem({ title: 'Described', description: text })).json.id;
  const expected = 'Includes:\n• 1 photobook (£20 value)\n• 2 photocards 💌\n\nShips with the next box.';
  assert.equal((await itemById(id)).description, expected);
  assert.equal((await itemById(id, false)).description, expected);
});

test('descriptions are optional: none, blank or whitespace-only all mean "no description"', async () => {
  const a = (await addItem({ title: 'No desc' })).json.id, b = (await addItem({ title: 'Blank desc', description: '' })).json.id, c = (await addItem({ title: 'Space desc', description: '   \n  ' })).json.id;
  for (const id of [a, b, c]) assert.equal((await itemById(id)).description, '');
  assert.deepEqual((await app.q('SELECT description FROM items WHERE id IN (?) ORDER BY id', [[a, b, c]])).map((r) => r.description), [null, null, null], 'stored as NULL, not as empty text');
});

test('descriptions work for every kind of item', async () => {
  const ids = {
    set: (await addItem({ type: 'set', title: 'Set d', members: ['A', 'B'], description: 'a set' })).json.id,
    independent: (await addItem({ type: 'independent', title: 'Ind d', members: ['A'], description: 'independent' })).json.id,
    size: (await addItem({ type: 'size', title: 'Size d', variants: ['M'], description: 'sized' })).json.id,
    random: (await addItem({ type: 'random', title: 'Random d', description: 'random' })).json.id,
  };
  for (const [type, id] of Object.entries(ids)) assert.equal((await itemById(id)).description, type === 'set' ? 'a set' : type === 'independent' ? 'independent' : type === 'size' ? 'sized' : 'random');
});

test('editing a description: change it, clear it with blank or null, and leave it alone when not mentioned', async () => {
  const id = (await addItem({ title: 'Editable', description: 'first' })).json.id;
  const edit = (body) => app.api('PATCH', `/api/admin/items/${id}`, body, admin);
  assert.equal((await edit({ description: '  second\nline  ' })).status, 200);
  assert.equal((await itemById(id)).description, 'second\nline');
  assert.equal((await edit({ price: 7 })).status, 200);
  assert.equal((await itemById(id)).description, 'second\nline', 'editing something else keeps it');
  assert.equal((await edit({ description: '' })).status, 200);
  assert.equal((await itemById(id)).description, '');
  await edit({ description: 'back' });
  assert.equal((await edit({ description: null })).status, 200);
  assert.equal((await itemById(id)).description, '', 'null clears it too');
});

test('descriptions: 2000 characters is fine, more is refused, and only the GOM can write them', async () => {
  const ok = await addItem({ title: 'Long', description: 'x'.repeat(2000) });
  assert.equal(ok.status, 201);
  assert.equal((await itemById(ok.json.id)).description.length, 2000);
  assert.equal((await addItem({ title: 'Too long', description: 'x'.repeat(2001) })).status, 400);
  assert.equal((await app.api('PATCH', `/api/admin/items/${ok.json.id}`, { description: 'y'.repeat(2001) }, admin)).status, 400);
  const joiner = await app.login('desc.joiner@x.com');
  assert.equal((await app.api('PATCH', `/api/admin/items/${ok.json.id}`, { description: 'hijack' }, joiner)).status, 403);
  assert.equal((await itemById(ok.json.id)).description.length, 2000, 'unchanged');
});

test('descriptions are stored exactly as written (HTML included) — it is the screens that make it safe to show', async () => {
  const raw = '<img src=x onerror="window.pwned=1"> & <b>bold</b>';
  const id = (await addItem({ title: 'Raw', description: raw })).json.id;
  assert.equal((await app.q('SELECT description FROM items WHERE id = ?', [id]))[0].description, raw);
});
