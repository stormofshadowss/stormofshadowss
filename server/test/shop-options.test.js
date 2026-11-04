import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';

// SHOP ITEMS WITH OPTIONS: one listing, the buyer picks a member / size / version; each option has its OWN count and (optionally) its own price; the listing's total is the sum.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'so') => `${x}${++N}`;
const hoodie = async (extra = {}) => { const r = await api('POST', '/api/admin/shop', { title: u('Hoodie '), price: 25, optionLabel: 'Size', options: [{ name: 'L', qty: 2 }, { name: 'M', qty: 1, price: 30 }], ...extra }); assert.equal(r.status, 201, r.text); return r.json.id; };
const claim = (handle, lines, extra = {}) => app.api('POST', '/api/claims', { handle, allowDuplicates: true, lines, ...extra });
const shopItem = async (id) => (await app.api('GET', '/api/shop')).json.items.find((i) => i.id === id);
const adminItem = async (id) => (await api('GET', '/api/admin/shop')).json.items.find((i) => i.id === id);
const claimRow = async (handle, id) => (await app.q("SELECT c.id, c.label, c.member_name AS member, c.leftover_option_id AS optId, c.status, c.pipeline, cc.cost FROM claims c JOIN joiners j ON j.id = c.joiner_id LEFT JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category = 'initials' WHERE j.instagram_handle = ? AND c.leftover_item_id = ? AND c.status <> 'cancelled' ORDER BY c.id DESC", [handle, id]));

test('CREATING: an item with options keeps each option\'s own count and price; the listing\'s total is the sum; joiners see how many of each are left; an ordinary item is exactly as before', async () => {
  const id = await hoodie(); const a = await adminItem(id); assert.deepEqual([a.optionLabel, a.qty, a.left], ['Size', 3, 3]); assert.deepEqual(a.options.map((o) => [o.name, o.qty, o.claimed, o.left, o.ownPrice, o.price]), [['L', 2, 0, 2, null, 25], ['M', 1, 0, 1, 30, 30]]);
  const s = await shopItem(id); assert.deepEqual([s.optionLabel, s.left, s.price], ['Size', 3, 25]); assert.deepEqual(s.options, [{ name: 'L', price: 25, left: 2 }, { name: 'M', price: 30, left: 1 }]);
  const plain = (await api('POST', '/api/admin/shop', { title: u('Plain '), price: 5, qty: 4 })).json.id; const p = await shopItem(plain); assert.deepEqual([p.left, p.options, p.optionLabel], [4, undefined, undefined]); assert.equal((await adminItem(plain)).options, undefined);
});

test('CREATING IS CHECKED: options need a label and the other way round, at least one option, different names (ignoring capitals), counts and prices that make sense; an ordinary item still needs a quantity; GOM only', async () => {
  const bad = async (body, code) => { const r = await api('POST', '/api/admin/shop', { title: u(), price: 5, ...body }); assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status} ${r.text}`); if (code) assert.equal(r.json.code, code); };
  await bad({ options: [{ name: 'L', qty: 1 }] }, 'options_incomplete'); await bad({ optionLabel: 'Size' }, 'options_incomplete'); await bad({ optionLabel: 'Colour', options: [{ name: 'L', qty: 1 }] }); await bad({ optionLabel: 'Size', options: [] });
  await bad({ optionLabel: 'Size', options: [{ name: 'L', qty: 1 }, { name: 'l', qty: 1 }] }, 'dup_option'); await bad({ optionLabel: 'Size', options: [{ name: '  ', qty: 1 }] }); await bad({ optionLabel: 'Size', options: [{ name: 'L', qty: -1 }] });
  await bad({ optionLabel: 'Size', options: [{ name: 'L', qty: 1, price: 0 }] }); await bad({ optionLabel: 'Size', options: [{ name: 'L', qty: 1, price: 1.555 }] }); await bad({}, 'qty_required');
  const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj')); assert.equal((await api('POST', '/api/admin/shop', { title: 'x', price: 5, optionLabel: 'Size', options: [{ name: 'L', qty: 1 }] }, j)).status, 403);
});

test('CLAIMING AN OPTION: its own count and price are what count; the claim says which one (label "Title — Option"); other options are unaffected; a sold-out option says so', async () => {
  const id = await hoodie(); const [a, b, c] = [u(), u(), u()]; assert.equal((await claim(a, [{ leftoverId: id, member: 'L' }])).status, 201); assert.equal((await claim(b, [{ leftoverId: id, member: 'M' }])).status, 201);
  const [ra] = await claimRow(a, id), [rb] = await claimRow(b, id); assert.deepEqual([ra.label.endsWith(' — L'), ra.member, Number(ra.cost), ra.status], [true, 'L', 25, 'confirmed'], 'L is at the listing\'s price'); assert.deepEqual([rb.member, Number(rb.cost)], ['M', 30], 'M has its own price'); assert.ok(ra.optId && rb.optId && ra.optId !== rb.optId);
  const s = await shopItem(id); assert.deepEqual([s.left, s.options.map((o) => [o.name, o.left])], [1, [['L', 1], ['M', 0]]]);
  const sold = await claim(c, [{ leftoverId: id, member: 'M' }]); assert.deepEqual([sold.status, sold.json.code, sold.json.error.endsWith(' — M" has sold out.')], [409, 'sold_out', true]);
  const more = await claim(c, [{ leftoverId: id, member: 'L', qty: 3 }]); assert.deepEqual([more.status, more.json.error.replace(/^Only 1 of "[^"]*? — L" left\.$/, 'OK')], [409, 'OK'], 'only 1 L left');
  assert.equal((await claim(c, [{ leftoverId: id, member: 'L' }])).status, 201); assert.equal((await shopItem(id)).left, 0);
});

test('A BAD CHOICE IS REFUSED: no option picked, an option that doesn\'t exist, an option on an ordinary item, a hidden item — and a refused line takes nothing, not even the good lines beside it', async () => {
  const id = await hoodie(); const plain = (await api('POST', '/api/admin/shop', { title: u('Plain '), price: 5, qty: 2 })).json.id; const h = u();
  let r = await claim(h, [{ leftoverId: id }]); assert.deepEqual([r.status, r.json.code], [400, 'option_required']); assert.match(r.json.error, /^Choose a size for "/);
  r = await claim(h, [{ leftoverId: id, member: 'XXL' }]); assert.equal(r.status, 404); r = await claim(h, [{ leftoverId: plain, member: 'L' }]); assert.deepEqual([r.status, r.json.code], [400, 'no_options']);
  r = await claim(h, [{ leftoverId: id, member: 'L' }, { leftoverId: id, member: 'M', qty: 2 }]); assert.equal(r.status, 409); assert.equal((await claimRow(h, id)).length, 0, 'the L that was fine was not taken either');
  await api('PATCH', `/api/admin/shop/${id}`, { active: false }); assert.equal((await claim(h, [{ leftoverId: id, member: 'L' }])).status, 404);
});

test('SEVERAL OPTIONS AT ONCE (Han and Felix in one go): each takes its own unit', async () => {
  const id = (await api('POST', '/api/admin/shop', { title: u('Photocards '), price: 3, optionLabel: 'Member', options: [{ name: 'Han', qty: 1 }, { name: 'Felix', qty: 2 }, { name: 'Bang Chan', qty: 1 }] })).json.id; const h = u();
  assert.equal((await claim(h, [{ leftoverId: id, member: 'Han' }, { leftoverId: id, member: 'Felix' }, { leftoverId: id, member: 'Felix' }])).status, 201); assert.deepEqual((await claimRow(h, id)).map((r) => r.member).sort(), ['Felix', 'Felix', 'Han']); assert.deepEqual((await shopItem(id)).options.map((o) => [o.name, o.left]), [['Han', 0], ['Felix', 0], ['Bang Chan', 1]]);
});

test('THE LAST UNIT OF AN OPTION GOES TO ONE PERSON when several press at once; cancelling a claim frees that option\'s unit', async () => {
  const id = await hoodie(); const hs = Array.from({ length: 5 }, () => u('race')); const rs = await Promise.all(hs.map((h) => claim(h, [{ leftoverId: id, member: 'M' }])));
  assert.equal(rs.filter((r) => r.status === 201).length, 1); assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409)); assert.equal((await shopItem(id)).options.find((o) => o.name === 'M').left, 0);
  const winner = hs[rs.findIndex((r) => r.status === 201)]; const [row] = await claimRow(winner, id); assert.equal((await api('PATCH', `/api/admin/claims/${row.id}`, { status: 'cancelled' })).status, 200);
  assert.deepEqual((await shopItem(id)).options.map((o) => [o.name, o.left]), [['L', 2], ['M', 1]], 'M is back; L untouched');
});

test('"YOU ALREADY HAVE THIS" IS PER OPTION: asking for the same option again asks first; a different option is not a repeat', async () => {
  const id = await hoodie({ options: [{ name: 'L', qty: 5 }, { name: 'M', qty: 5 }] }); const h = u(); assert.equal((await claim(h, [{ leftoverId: id, member: 'L' }], { allowDuplicates: false })).status, 201);
  const again = await claim(h, [{ leftoverId: id, member: 'L' }], { allowDuplicates: false }); assert.deepEqual([again.status, again.json.code], [409, 'already_claimed']); assert.deepEqual(again.json.have.map((x) => [x.count, x.leftoverId === id, x.option]), [[1, true, 'L']]); assert.match(again.json.error, /You already have 1 × .* — L — claim another\?/);
  assert.equal((await claim(h, [{ leftoverId: id, member: 'M' }], { allowDuplicates: false })).status, 201, 'a different option is not a repeat'); assert.equal((await claim(h, [{ leftoverId: id, member: 'L' }], { allowDuplicates: true })).status, 201, 'unless they say yes');
});

test('PAYING FOR AN OPTION CLAIM makes it ready to pack, like any shop claim', async () => {
  const id = await hoodie(); const h = u(); await claim(h, [{ leftoverId: id, member: 'M' }]); const [row] = await claimRow(h, id); assert.equal(row.pipeline, 'awaiting fulfillment');
  assert.equal((await api('PATCH', `/api/admin/claims/${row.id}`, { costs: { initials: { paid: 30 } } })).status, 200); assert.equal((await claimRow(h, id))[0].pipeline, 'ready to pack / on hand');
});

test('EDITING OPTIONS: a rename carries through to the claims already made (label and option); counts can go up but not below what is claimed; a new price applies only to NEW claims; clearing it goes back to the listing\'s price; the total follows', async () => {
  const id = await hoodie({ options: [{ name: 'L', qty: 3 }, { name: 'M', qty: 2, price: 30 }] }); const [a, b] = [u(), u()]; await claim(a, [{ leftoverId: id, member: 'L' }]); await claim(b, [{ leftoverId: id, member: 'M' }]); const opts = (await adminItem(id)).options; const L = opts[0], M = opts[1];
  const rn = await api('PATCH', `/api/admin/shop/${id}`, { options: [{ id: L.id, name: 'Large', qty: 4 }, { id: M.id, name: 'M', qty: 2 }] }); assert.equal(rn.status, 200, rn.text); const [ra] = await claimRow(a, id); assert.deepEqual([ra.member, ra.label.endsWith(' — Large')], ['Large', true]);
  let it = await adminItem(id); assert.deepEqual([it.qty, it.left, it.options.map((o) => [o.name, o.qty, o.left])], [6, 4, [['Large', 4, 3], ['M', 2, 1]]]);
  const low = await api('PATCH', `/api/admin/shop/${id}`, { options: [{ id: L.id, name: 'Large', qty: 0 }, { id: M.id, name: 'M', qty: 2 }] }); assert.deepEqual([low.status, low.json.code], [409, 'qty_below_claims']); assert.match(low.json.error, /^1 of “Large” is already claimed — set the count to at least 1, or cancel some claims first\.$/); assert.equal((await adminItem(id)).options[0].qty, 4, 'nothing changed');
  await api('PATCH', `/api/admin/shop/${id}`, { options: [{ id: L.id, name: 'Large', qty: 4, price: 28 }, { id: M.id, name: 'M', qty: 2, price: null }] }); const c = u(); await claim(c, [{ leftoverId: id, member: 'Large' }]); await claim(c, [{ leftoverId: id, member: 'M' }]);
  assert.deepEqual([Number((await claimRow(a, id))[0].cost), Number((await claimRow(c, id)).find((r) => r.member === 'Large').cost), Number((await claimRow(c, id)).find((r) => r.member === 'M').cost), Number((await claimRow(b, id))[0].cost)], [25, 28, 25, 30], 'the first Large claim kept 25; the new one is 28; M is now at the listing\'s price for NEW claims; the old M claim kept 30');
});

test('ADDING, REMOVING, REORDERING AND SWAPPING NAMES: a new option appears; an unclaimed one can be removed, a claimed one cannot; the order follows the list; two options can swap names; the picker\'s label can change; "qty" is ignored for these items', async () => {
  const id = await hoodie({ options: [{ name: 'S', qty: 1 }, { name: 'M', qty: 1 }, { name: 'L', qty: 1 }] }); const h = u(); await claim(h, [{ leftoverId: id, member: 'M' }]); const [S, M, L] = (await adminItem(id)).options;
  const patch = (options, extra = {}) => api('PATCH', `/api/admin/shop/${id}`, { options, ...extra });
  let r = await patch([{ id: S.id, name: 'S', qty: 1 }, { id: L.id, name: 'L', qty: 1 }]); assert.deepEqual([r.status, r.json.code], [409, 'option_has_claims']); assert.match(r.json.error, /^“M” has 1 claimed/);
  r = await patch([{ id: M.id, name: 'M', qty: 1 }, { id: L.id, name: 'L', qty: 1 }, { name: 'XL', qty: 2, price: 35 }], { optionLabel: 'Version', qty: 999 }); assert.equal(r.status, 200, r.text); let it = await adminItem(id);
  assert.deepEqual([it.optionLabel, it.qty, it.options.map((o) => [o.name, o.qty, o.ownPrice])], ['Version', 4, [['M', 1, null], ['L', 1, null], ['XL', 2, 35]]], 'S removed, XL added, the order is the list\'s, qty 999 ignored — the total is the options\'');
  r = await patch([{ id: M.id, name: 'L', qty: 1 }, { id: L.id, name: 'M', qty: 1 }, { id: it.options[2].id, name: 'XL', qty: 2 }]); assert.equal(r.status, 200, r.text); assert.equal((await claimRow(h, id))[0].member, 'L', 'the claim followed its option\'s new name');
  assert.equal((await patch([])).status, 400, 'at least one option'); assert.equal((await patch([{ id: 99999999, name: 'Z', qty: 1 }])).status, 400);
  const log = await app.q("SELECT detail FROM audit_log WHERE entity = 'leftover_item' AND entity_id = ? AND action = 'shop.options' ORDER BY id", [id]); assert.ok(log.length >= 2, 'option changes are recorded');
});

test('MAKING AN ORDINARY ITEM INTO ONE WITH OPTIONS works only while nobody has claimed it; and an item with options cannot go back', async () => {
  const fresh = (await api('POST', '/api/admin/shop', { title: u('Plain '), price: 8, qty: 3 })).json.id; let r = await api('PATCH', `/api/admin/shop/${fresh}`, { optionLabel: 'Version', options: [{ name: 'Album A', qty: 2 }, { name: 'Album B', qty: 1 }] }); assert.equal(r.status, 200, r.text);
  const it = await adminItem(fresh); assert.deepEqual([it.optionLabel, it.qty], ['Version', 3]); const taken = (await api('POST', '/api/admin/shop', { title: u('Plain '), price: 8, qty: 3 })).json.id; await claim(u(), [{ leftoverId: taken }]);
  r = await api('PATCH', `/api/admin/shop/${taken}`, { optionLabel: 'Version', options: [{ name: 'A', qty: 1 }] }); assert.deepEqual([r.status, r.json.code], [409, 'has_claims']); r = await api('PATCH', `/api/admin/shop/${taken}`, { options: [{ name: 'A', qty: 1 }] }); assert.equal(r.status, 400, 'say what the buyers choose');
  assert.equal((await adminItem(taken)).options, undefined, 'still an ordinary item');
});
