import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { boxSplit, splitCustoms } from '../src/lib/box.js';
import { round2 } from '../src/lib/money.js';

// ITEMS THAT CARRY NO EMS / NO CUSTOMS (e.g. the free bonus cards from purchase benefits): a standing tick on the item, applied in every box, changeable for one box; the others carry the amount, so the totals are always fully charged.
const it = (id, weight, price = 10, extra = {}) => ({ id, weight, size: 'M', price, ...extra });
const sum = (xs) => round2(xs.reduce((a, b) => a + b, 0));

test('SPLIT RULES — EMS: an item that carries no EMS gets nothing and the others take its share, by weight; the total is always fully shared', () => {
  const s = boxSplit([it(1, 100, 10, { noEms: true }), it(2, 100), it(3, 300)], { emsTotal: 10 }); assert.deepEqual(s.emsShares, [0, 2.5, 7.5]); assert.equal(sum(s.emsShares), 10);
  const odd = boxSplit([it(1, 100), it(2, 100, 10, { noEms: true }), it(3, 100), it(4, 100)], { emsTotal: 10 }); assert.equal(odd.emsShares[1], 0); assert.equal(sum(odd.emsShares), 10, 'pennies included');
  assert.deepEqual(boxSplit([it(1, 100), it(2, 300)], { emsTotal: 10 }).emsShares, [2.5, 7.5], 'with no ticks it is as before');
});

test('SPLIT RULES — CUSTOMS: an item that carries no customs gets nothing and the others take its share, by value; if none of the others has a value it is shared equally among them; nobody left to carry it is refused', () => {
  assert.deepEqual(boxSplit([it(1, 100, 10, { noCustoms: true }), it(2, 100, 10), it(3, 100, 30)], { emsTotal: 1, customsTotal: 4 }).customsShares, [0, 1, 3]);
  assert.deepEqual(boxSplit([it(1, 100, 0), it(2, 100, 0, { noCustoms: true }), it(3, 100, 0)], { emsTotal: 1, customsTotal: 6 }).customsShares, [3, 0, 3], 'all free: equal among the items that carry it');
  assert.throws(() => boxSplit([it(1, 100, 10, { noCustoms: true }), it(2, 100, 5, { noCustoms: true })], { emsTotal: 1, customsTotal: 4 }), (e) => e.code === 'no_customs_carrier' && /no customs/.test(e.message));
  assert.throws(() => boxSplit([it(1, 100, 10, { noEms: true })], { emsTotal: 5 }), (e) => e.code === 'no_ems_carrier');
  assert.deepEqual(boxSplit([it(1, 100, 10, { noEms: true, noCustoms: true })], { emsTotal: 0, customsTotal: 0 }).customsShares, [0], 'nothing to share: nothing to refuse');
  assert.deepEqual(splitCustoms([it(1, 1, 10, { noCustoms: true }), it(2, 1, 10)], 0), [0, 0]);
});

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const u = (x = 'bx') => `${x}${++N}`;
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Box GO '), proxy: 'Sam' })).json.id;
const item = async (go, price, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Card '), price, ...extra })).json.id;
async function arrived(itemId, { weight = 100 } = {}) { const h = u('p'); const [id] = await claimAndSecure(app, admin, h, itemId); assert.equal((await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'arrived at proxy / warehouse', weightG: weight })).status, 200); return { id, h }; }
const mkBox = (claimIds, extra = {}) => api('POST', '/api/admin/boxes', { claimIds, emsTotal: 10, ...extra });
const costs = async (id, cat) => Number((await app.q('SELECT cost FROM claim_costs WHERE claim_id = ? AND category = ?', [id, cat]))[0].cost);
const boxItems = async (boxId) => (await app.q('SELECT claim_id AS id, ems_share AS ems, customs_share AS customs, ems_excluded AS ee, customs_excluded AS ce FROM box_items WHERE box_id = ? ORDER BY claim_id', [boxId])).map((r) => ({ id: r.id, ems: Number(r.ems), customs: Number(r.customs), ee: r.ee, ce: r.ce }));

test('THE TICKS ON AN ITEM: set when adding or editing it, shown to you (never to joiners), one tick can be changed without touching the other, recorded', async () => {
  const go = await goOrder(); const a = await item(go, 5, { noEms: true, noCustoms: true }), b = await item(go, 5), c = await item(go, 5, { noEms: true });
  const mine = async (id) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === id); assert.deepEqual([(await mine(a)), (await mine(b)), (await mine(c))].map((i) => [i.noEms, i.noCustoms]), [[true, true], [false, false], [true, false]]);
  const pub = (await app.api('GET', '/api/orders')).json.orders.find((o) => o.id === go); if (pub) for (const i of pub.items) assert.equal(i.noEms, undefined, 'joiners never see it');
  assert.equal((await api('PATCH', `/api/admin/items/${b}`, { noCustoms: true })).status, 200); assert.deepEqual([(await mine(b)).noEms, (await mine(b)).noCustoms], [false, true], 'only the one you changed');
  assert.equal((await api('PATCH', `/api/admin/items/${c}`, { noCustoms: true })).status, 200); assert.deepEqual([(await mine(c)).noEms, (await mine(c)).noCustoms], [true, true], 'changing noCustoms left the item\'s noEms alone'); assert.equal((await api('PATCH', `/api/admin/items/${a}`, { noEms: false })).status, 200); assert.deepEqual([(await mine(a)).noEms, (await mine(a)).noCustoms], [false, true]); assert.ok((await app.q("SELECT 1 FROM audit_log WHERE entity = 'item' AND entity_id = ? AND action = 'item.box_ticks'", [a])).length >= 1);
});

test('A BOX: items with the standing ticks carry nothing, the others share the EMS by weight and the customs by value, the totals are fully charged, and each item\'s costs and the box record show it', async () => {
  const go = await goOrder(); const free = await item(go, 0, { noEms: true, noCustoms: true }), cheap = await item(go, 10), dear = await item(go, 30);
  const A = await arrived(free, { weight: 50 }), B = await arrived(cheap, { weight: 100 }), C = await arrived(dear, { weight: 300 });
  const r = await mkBox([A.id, B.id, C.id], { emsTotal: 10, customsTotal: 4 }); assert.equal(r.status, 201, r.text); const rows = await boxItems(r.json.id);
  assert.deepEqual(rows.map((x) => [x.ems, x.customs, x.ee, x.ce]), [[0, 0, 1, 1], [2.5, 1, 0, 0], [7.5, 3, 0, 0]], 'the bonus card carries nothing; its share went to the others'); assert.equal(round2(rows.reduce((s, x) => s + x.ems, 0)), 10); assert.equal(round2(rows.reduce((s, x) => s + x.customs, 0)), 4);
  assert.deepEqual([await costs(A.id, 'ems'), await costs(A.id, 'customs'), await costs(B.id, 'ems'), await costs(C.id, 'customs')], [0, 0, 2.5, 3]); const listed = (await api('GET', '/api/admin/boxes')).json.boxes.find((b) => b.id === r.json.id).items; assert.deepEqual(listed.map((i) => [i.emsExcluded, i.customsExcluded]), [[true, true], [false, false], [false, false]]);
});

test('PER BOX: the GOM can change an item\'s standing ticks for one box — turn them off or on — and the preview says exactly what will happen', async () => {
  const go = await goOrder(); const bonus = await item(go, 0, { noEms: true, noCustoms: true }), plain = await item(go, 10), other = await item(go, 10); const A = await arrived(bonus), B = await arrived(plain), C = await arrived(other);
  const body = { claimIds: [A.id, B.id, C.id], emsTotal: 9, customsTotal: 6, exclusions: [{ claimId: A.id, noEms: false }, { claimId: B.id, noCustoms: true }] };
  const pv = await api('POST', '/api/admin/boxes/preview', body); assert.equal(pv.status, 200, pv.text); assert.deepEqual(pv.json.rows.map((r) => [r.noEms, r.noCustoms, r.emsShare, r.customsShare]), [[false, true, 3, 0], [false, true, 3, 0], [false, false, 3, 6]], 'A now carries EMS (override); B carries no customs (override); A keeps its standing no-customs');
  const r = await mkBox(body.claimIds, { emsTotal: 9, customsTotal: 6, exclusions: body.exclusions }); assert.equal(r.status, 201, r.text); assert.deepEqual((await boxItems(r.json.id)).map((x) => [x.ems, x.customs, x.ee, x.ce]), [[3, 0, 0, 1], [3, 0, 0, 1], [3, 6, 0, 0]], 'what was created is what the preview said');
  assert.deepEqual((await app.q('SELECT no_ems AS e, no_customs AS c FROM items WHERE id = ?', [bonus]))[0], { e: 1, c: 1 }, 'the item\'s own ticks are untouched by a per-box change');
});

test('CUSTOMS ADDED LATER IS SPLIT THE SAME WAY — by what that box used, not by what the item says now', async () => {
  const go = await goOrder(); const a = await item(go, 10, { noCustoms: true }), b = await item(go, 10), c = await item(go, 30); const A = await arrived(a), B = await arrived(b), C = await arrived(c);
  const box = (await mkBox([A.id, B.id, C.id], { emsTotal: 6 })).json.id; assert.deepEqual((await boxItems(box)).map((x) => x.ce), [1, 0, 0]);
  await api('PATCH', `/api/admin/items/${a}`, { noCustoms: false }); const r = await api('POST', `/api/admin/boxes/${box}/customs`, { customsTotal: 8 }); assert.equal(r.status, 200, r.text);
  assert.deepEqual((await boxItems(box)).map((x) => x.customs), [0, 2, 6], 'A is still left out — the box remembers'); assert.deepEqual([await costs(A.id, 'customs'), await costs(B.id, 'customs'), await costs(C.id, 'customs')], [0, 2, 6]);
  const box2 = (await mkBox([(await arrived(b)).id, (await arrived(a)).id], { emsTotal: 4, exclusions: [{ claimId: 0, noCustoms: true }] })).json; void box2;
  const later = await item(go, 10, { noCustoms: true }), L1 = await arrived(later), L2 = await arrived(await item(go, 10)); const bx = (await mkBox([L1.id, L2.id], { emsTotal: 2, exclusions: [{ claimId: L1.id, noCustoms: false }] })).json.id;
  assert.equal((await api('POST', `/api/admin/boxes/${bx}/customs`, { customsTotal: 4 })).status, 200); assert.deepEqual((await boxItems(bx)).map((x) => x.customs), [2, 2], 'overridden on at creation: carries customs when added later too');
});

test('NOBODY LEFT TO CARRY IT IS REFUSED, with nothing changed: every item set to no EMS (or no customs) while an amount is entered — at creation, in the preview and when adding customs later; with nothing to share it is fine', async () => {
  const go = await goOrder(); const a = await item(go, 10, { noEms: true, noCustoms: true }), b = await item(go, 10, { noEms: true, noCustoms: true }); const A = await arrived(a), B = await arrived(b);
  const pv = await api('POST', '/api/admin/boxes/preview', { claimIds: [A.id, B.id], emsTotal: 5 }); assert.deepEqual([pv.status, pv.json.code], [409, 'no_ems_carrier']); assert.match(pv.json.error, /^Every item in this box is set to carry no EMS/);
  const r = await mkBox([A.id, B.id], { emsTotal: 5 }); assert.deepEqual([r.status, r.json.code], [409, 'no_ems_carrier']); assert.equal((await app.q('SELECT COUNT(*) AS n FROM box_items WHERE claim_id IN (?)', [[A.id, B.id]]))[0].n, 0, 'no box was made'); assert.equal((await app.q('SELECT pipeline FROM claims WHERE id = ?', [A.id]))[0].pipeline, 'arrived at proxy / warehouse');
  const c = await item(go, 10, { noCustoms: true }), d = await item(go, 10), C = await arrived(c), D = await arrived(d); const ok = await mkBox([C.id, D.id], { emsTotal: 5, exclusions: [{ claimId: D.id, noCustoms: true }] }); assert.equal(ok.status, 201, 'no customs entered: nothing to refuse');
  const late = await api('POST', `/api/admin/boxes/${ok.json.id}/customs`, { customsTotal: 4 }); assert.deepEqual([late.status, late.json.code], [409, 'no_customs_carrier']); assert.deepEqual((await boxItems(ok.json.id)).map((x) => x.customs), [0, 0], 'nothing changed');
});

test('THE ITEM LIST FOR A NEW BOX CARRIES EACH ITEM\'S TICKS (so the screen starts from them)', async () => {
  const go = await goOrder(); const a = await item(go, 0, { noEms: true }), b = await item(go, 5); const A = await arrived(a), B = await arrived(b); const cands = (await api('GET', '/api/admin/boxes/candidates')).json.candidates;
  assert.deepEqual([A.id, B.id].map((id) => { const c = cands.find((x) => x.claimId === id); return [c.noEms, c.noCustoms]; }), [[true, false], [false, false]]);
});

test('PURCHASE BENEFITS: the free bonus card made with a benefit carries neither; the migration does the same for ones made before', async () => {
  const go = await goOrder(); const album = await item(go, 10); const r = await api('POST', `/api/admin/orders/${go}/benefits`, { title: 'Spend £10 get a card', threshold: 10, quantity: 1, newBonusTitle: u('Bonus card '), itemIds: [album] }); assert.equal(r.status, 201, r.text);
  const bonus = (await api('GET', `/api/admin/orders/${go}/benefits`)).json.offers[0].bonusItemId; assert.deepEqual((await app.q('SELECT no_ems AS e, no_customs AS c, hidden_from_public AS h FROM items WHERE id = ?', [bonus]))[0], { e: 1, c: 1, h: 1 });
  let old2; const old = await item(go, 0); const unrelated = await item(go, 3); await app.q('UPDATE items SET no_ems = 0, no_customs = 0 WHERE id IN (?)', [[bonus, old2]]); const go2 = await goOrder(); const album2 = await item(go2, 10); const o2 = await api('POST', `/api/admin/orders/${go2}/benefits`, { title: 'Older offer', threshold: 10, quantity: 1, bonusItemId: old2 = await item(go2, 0), itemIds: [album2] }); assert.equal(o2.status, 201, o2.text);
  const sql = fs.readFileSync(new URL('../../db/migrations/038_no_ems_customs.sql', import.meta.url), 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n').split(';').map((s) => s.trim()).find((s) => /^UPDATE items/i.test(s)); assert.ok(sql); await app.q(sql);
  const flags = async (id) => (await app.q('SELECT no_ems AS e, no_customs AS c FROM items WHERE id = ?', [id]))[0]; assert.deepEqual([await flags(bonus), await flags(old2), await flags(unrelated)], [{ e: 1, c: 1 }, { e: 1, c: 1 }, { e: 0, c: 0 }], 'every bonus item is flagged; an ordinary item is not');
});
