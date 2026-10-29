import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// A SIZE (member) of an independent item can have its OWN price: a claim on it is charged that price (else the item's), it can be edited later, and unsecured claims follow while secured ones keep theirs.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'mp') => `${x}${++N}`;
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Sleeves GO '), proxy: 'Sam' })).json.id;
const sleeves = async (go, extra = {}) => { const r = await api('POST', `/api/admin/orders/${go}/items`, { type: 'independent', price: 0.55, title: u('Sleeves '), members: ['43x67', { name: '70x110', price: 0.7 }, { name: '80x120', price: 0.9 }], ...extra }); assert.equal(r.status, 201, r.text); return r.json.id; };
const roster = async (go, id) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === id).members;
const claim = async (handle, id, member) => { const r = await app.api('POST', '/api/claims', { handle, allowDuplicates: true, lines: [{ itemId: id, member }] }); assert.equal(r.status, 201, r.text); return r; };
const cost = async (handle, id, member) => (await app.q("SELECT cc.cost, c.price_tbc AS tbc, c.status FROM claims c JOIN joiners j ON j.id = c.joiner_id JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category = 'initials' WHERE j.instagram_handle = ? AND c.item_id = ? AND c.member_name = ? AND c.status <> 'cancelled' ORDER BY c.id DESC LIMIT 1", [handle, id, member]))[0];
const setPrices = (id, memberPrices, extra = {}) => api('PATCH', `/api/admin/items/${id}`, { memberPrices, ...extra });

test('A CLAIM IS CHARGED THE SIZE\'S OWN PRICE, else the item\'s — from the joiner form and from "Add a claim"; joiners see each size\'s price, you see which are own prices', async () => {
  const go = await goOrder(); const it = await sleeves(go); const h = u('buyer'); await joinerSession(app, `${h}@x.com`, h);
  await claim(h, it, '43x67'); await claim(h, it, '70x110'); await claim(h, it, '80x120');
  assert.deepEqual([(await cost(h, it, '43x67')).cost, (await cost(h, it, '70x110')).cost, (await cost(h, it, '80x120')).cost].map(Number), [0.55, 0.7, 0.9], 'the item price for a plain size, the own price for the others');
  const add = await api('POST', '/api/admin/claims/add', { handle: h, status: 'requested', lines: [{ itemId: it, member: '70x110' }] }); assert.equal(add.status, 201, add.text); assert.equal(Number((await cost(h, it, '70x110')).cost), 0.7, '"Add a claim" charges it too');
  const pub = (await app.api('GET', '/api/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === it); assert.deepEqual(pub.members.map((m) => [m.name, m.price]), [['43x67', 0.55], ['70x110', 0.7], ['80x120', 0.9]]);
  assert.deepEqual((await roster(go, it)).map((m) => [m.name, m.price, m.ownPrice]), [['43x67', 0.55, null], ['70x110', 0.7, 0.7], ['80x120', 0.9, 0.9]], 'you also see which prices are the size\'s own');
});

test('PRICE TO BE CONFIRMED: a size with its own price is NOT "TBC" (it can be secured); the others are, until the item has a price', async () => {
  const go = await goOrder(); const it = await sleeves(go, { price: undefined, priceTbc: true }); const h = u('tbc'); await joinerSession(app, `${h}@x.com`, h); await claim(h, it, '43x67'); await claim(h, it, '70x110');
  assert.deepEqual([await cost(h, it, '43x67')].map((c) => [Number(c.cost), c.tbc]), [[0, 1]], 'no own price: TBC'); assert.deepEqual([await cost(h, it, '70x110')].map((c) => [Number(c.cost), c.tbc]), [[0.7, 0]], 'its own price: a real price');
  const sec = await api('POST', '/api/admin/claims/secure', { orderId: go }); assert.equal(sec.status, 200, sec.text); const status = async (m) => (await cost(h, it, m)).status; assert.equal(await status('70x110'), 'confirmed', 'the priced size could be secured'); assert.equal(await status('43x67'), 'requested', 'the TBC one could not');
});

test('EDITING A SIZE\'S PRICE: unsecured claims on it follow the new price, secured claims keep what they were secured at; other sizes are untouched; clearing it goes back to the item\'s price; it is recorded', async () => {
  const go = await goOrder(); const it = await sleeves(go); const [, wide] = await roster(go, it); const a = u('secured'), b = u('requested'), c = u('plain'); for (const h of [a, b, c]) await joinerSession(app, `${h}@x.com`, h);
  await claimAndSecure(app, admin, a, it, { member: '70x110' }); await claim(b, it, '70x110'); await claim(c, it, '43x67');
  const r = await setPrices(it, [{ id: wide.id, price: 0.8 }]); assert.equal(r.status, 200, r.text); assert.deepEqual([r.json.memberRepriced, r.json.repriced, r.json.memberPriced.map((m) => [m.name, m.from, m.to])], [1, 0, [['70x110', 0.7, 0.8]]], 'one unsecured claim on that size was re-priced');
  assert.equal(Number((await cost(a, it, '70x110')).cost), 0.7, 'secured: keeps its price'); assert.equal(Number((await cost(b, it, '70x110')).cost), 0.8, 'requested: follows'); assert.equal(Number((await cost(c, it, '43x67')).cost), 0.55, 'another size: untouched');
  const back = await setPrices(it, [{ id: wide.id, price: null }]); assert.equal(back.status, 200); assert.equal(Number((await cost(b, it, '70x110')).cost), 0.55, 'cleared: back to the item\'s price'); assert.equal((await roster(go, it))[1].ownPrice, null);
  const log = await app.q("SELECT detail FROM audit_log WHERE entity = 'item' AND entity_id = ? AND action = 'item.member_price' ORDER BY id", [it]); assert.deepEqual(log.map((l) => (typeof l.detail === 'string' ? JSON.parse(l.detail) : l.detail)), [{ member: '70x110', from: 0.7, to: 0.8 }, { member: '70x110', from: 0.8, to: null }]);
});

test('AN ITEM PRICE EDIT STILL WORKS AROUND THEM: sizes without their own price follow the new item price, sizes with one keep it; both edits in one save use the final values', async () => {
  const go = await goOrder(); const it = await sleeves(go); const [plain, wide] = await roster(go, it); const h = u('both'); await joinerSession(app, `${h}@x.com`, h); await claim(h, it, '43x67'); await claim(h, it, '70x110');
  assert.equal((await api('PATCH', `/api/admin/items/${it}`, { price: 0.6 })).status, 200); assert.deepEqual([Number((await cost(h, it, '43x67')).cost), Number((await cost(h, it, '70x110')).cost)], [0.6, 0.7]);
  const r = await api('PATCH', `/api/admin/items/${it}`, { price: 0.65, renameMembers: [{ id: wide.id, name: '70x110 wide' }], memberPrices: [{ id: wide.id, price: 0.75 }, { id: plain.id, price: 0.5 }] }); assert.equal(r.status, 200, r.text);
  assert.deepEqual([Number((await cost(h, it, '43x67')).cost), Number((await cost(h, it, '70x110 wide')).cost)], [0.5, 0.75], 'the renamed size follows its new price; the other has an own price now'); assert.deepEqual((await roster(go, it)).map((m) => m.name), ['43x67', '70x110 wide', '80x120']);
});

test('A MEMBER SET\'S PART PRICES CAN BE EDITED THE SAME WAY (unsecured claims follow)', async () => {
  const go = await goOrder(); const set = await sleeves(go, { type: 'set', members: ['A', { name: 'B', price: 2 }], price: 1 }); const [, b] = await roster(go, set); const h = u('setp'); await joinerSession(app, `${h}@x.com`, h);
  assert.equal((await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: set, parts: [{ member: 'B', qty: 1 }] }] })).status, 201); assert.equal((await setPrices(set, [{ id: b.id, price: 3 }])).status, 200); assert.equal(Number((await cost(h, set, 'B')).cost), 3);
});

test('IT IS REFUSED, WITH NOTHING CHANGED, FOR: a negative or 3-decimal price, text, an unknown member, an ordinary item; GOM only; the same price is a no-op', async () => {
  const go = await goOrder(); const it = await sleeves(go); const [plain, wide] = await roster(go, it); const plainItem = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 1, title: 'Plain' })).json.id;
  for (const bad of [-1, 0.555, 'cheap']) assert.equal((await setPrices(it, [{ id: wide.id, price: bad }])).status, 400, String(bad)); assert.equal((await setPrices(it, [{ id: 99999999, price: 1 }])).status, 400);
  const nm = await setPrices(plainItem, [{ id: plain.id, price: 1 }]); assert.deepEqual([nm.status, nm.json.code], [400, 'no_members']); const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await api('PATCH', `/api/admin/items/${it}`, { memberPrices: [{ id: wide.id, price: 1 }] }, j)).status, 403);
  assert.equal(Number((await roster(go, it))[1].price), 0.7, 'nothing changed'); const before = (await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'item' AND entity_id = ? AND action = 'item.member_price'", [it]))[0].n; assert.equal((await setPrices(it, [{ id: wide.id, price: 0.7 }])).json.memberPriced.length, 0); assert.equal((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'item' AND entity_id = ? AND action = 'item.member_price'", [it]))[0].n, before);
});

test('FIX A CLAIM: moving to a size with a DIFFERENT price asks whether to re-price (re-price / keep); a size with the same price just moves', async () => {
  const go = await goOrder(); const it = await sleeves(go, { members: ['A', 'B', { name: 'Big', price: 0.9 }] }); const h = u('fix'); await joinerSession(app, `${h}@x.com`, h); await claim(h, it, 'A'); await claim(h, it, 'A'); const ids = (await app.q("SELECT c.id FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? ORDER BY c.id", [h])).map((r) => r.id);
  const change = (id, body) => api('POST', `/api/admin/claims/${id}/change`, { itemId: it, ...body });
  const same = await change(ids[0], { member: 'B' }); assert.equal(same.status, 200, same.text); assert.equal(same.json.repriced, false, 'the same price: nothing to ask');
  const ask = await change(ids[1], { member: 'Big' }); assert.deepEqual([ask.status, ask.json.error], [400, 'Choose whether to re-price it or keep the old price.']); assert.equal((await app.q('SELECT member_name AS m FROM claims WHERE id = ?', [ids[1]]))[0].m, 'A', 'nothing moved');
  const keep = await change(ids[1], { member: 'Big', pricing: 'keep' }); assert.equal(keep.status, 200); assert.equal(Number((await app.q("SELECT cost FROM claim_costs WHERE claim_id = ? AND category = 'initials'", [ids[1]]))[0].cost), 0.55, 'keep: still the old price');
  const back = await change(ids[1], { member: 'A', pricing: 'reprice' }); assert.equal(back.status, 200); assert.equal(back.json.repriced, true); assert.equal(Number((await app.q("SELECT cost FROM claim_costs WHERE claim_id = ? AND category = 'initials'", [ids[1]]))[0].cost), 0.55, 're-priced to the new size\'s price (the item\'s here)');
  const up = await change(ids[1], { member: 'Big', pricing: 'reprice' }); assert.equal(Number((await app.q("SELECT cost FROM claim_costs WHERE claim_id = ? AND category = 'initials'", [ids[1]]))[0].cost), 0.9, 're-priced to the dearer size'); assert.equal(up.json.repriced, true);
});
