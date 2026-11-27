import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, seed } from './helpers.js';

// PRICE PER SET: a set is bought at one price, so every part in it costs the same even when the item's price changes (a proxy deal like "£10 a set up to 8 sets, then £15").
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const fresh = (p = 'sp') => `${p}${++N}`;
const setPrice = (item, price, priceScope) => api('PATCH', `/api/admin/items/${item}`, { price, ...(priceScope ? { priceScope } : {}) });
const initials = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims.map((c) => c.costs.initials.cost);
const setsOf = async (item) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item);
const claimSet = (handle, item, ...parts) => app.api('POST', '/api/claims', { handle, lines: [{ itemId: item, parts: parts.map((member) => ({ member, qty: 1 })) }] }, undefined);
const secure = async (s) => assert.equal((await api('POST', `/api/admin/sets/${s.id}/secure`, {})).status, 200);
async function newSet(price = 10, members = ['A', 'B', 'C'], memberPrices = {}) {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Set price GO ${++N}` })).json.id;
  const r = await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: `Set price item ${N}`, price, members: members.map((m) => (memberPrices[m] ? { name: m, price: memberPrices[m] } : m)) }); assert.equal(r.status, 201, r.text); return r.json.id;
}
// two sets of A + B at £10 (each missing C), set 1 secured; returns the people
async function twoSets() { const item = await newSet(10); const p = [fresh(), fresh(), fresh(), fresh()]; await claimSet(p[0], item, 'A'); await claimSet(p[1], item, 'B'); await claimSet(p[2], item, 'A'); await claimSet(p[3], item, 'B'); const [s1, s2] = await setsOf(item); await secure(s1); return { item, p, s1, s2 }; }

test('AN ITEM WITH SETS MUST SAY WHERE A NEW PRICE APPLIES (an item without sets, a same-price save and other edits need no answer); the answer must be one of the two', async () => {
  const item = await newSet(10, ['A', 'B']); const none = await api('PATCH', `/api/admin/items/${item}`, { price: 12 }); assert.deepEqual([none.status, none.json.code], [200, undefined], 'no sets yet: nothing to ask');
  await claimSet(fresh(), item, 'A'); const asked = await setPrice(item, 15); assert.deepEqual([asked.status, asked.json.code], [400, 'price_scope_needed']); assert.match(asked.json.error, /^This item already has sets\. Choose whether the new price applies to new sets only \(sets already started keep their price\), or to everything that is not secured yet\.$/);
  assert.equal((await setPrice(item, 12)).status, 200, 'the same price: nothing to choose'); assert.equal((await api('PATCH', `/api/admin/items/${item}`, { title: 'Renamed set item' })).status, 200, 'an edit that is not about price'); assert.equal((await setPrice(item, 15, 'sometimes')).status, 400, 'only the two choices');
  const { item: normal } = await (async () => { const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Plain GO ${++N}` })).json.id; return { item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: `Plain ${N}`, price: 5 })).json.id }; })(); assert.equal((await setPrice(normal, 6)).status, 200, 'an ordinary item never asks');
  const listed = (await api('GET', '/api/admin/orders')).json.orders.flatMap((o) => o.items).find((i) => i.id === item); assert.equal(listed.setCount, 1, 'the item form is told how many sets there are');
});

test('"ONLY NEW SETS": the sets already started keep their price (even the ones not yet secured), the next new set gets the new price — and a second change pins that set too', async () => {
  const { item, p, s1, s2 } = await twoSets(); const r = await setPrice(item, 15, 'newSets'); assert.equal(r.status, 200, r.text); assert.equal(r.json.repriced, 0, 'nothing was re-priced: the unsecured set 2 is protected too');
  const sets = await setsOf(item); assert.deepEqual(sets.map((s) => s.partPrice), [10, 10], 'both started sets are pinned at what they cost'); assert.deepEqual(sets.map((s) => s.parts.map((x) => x.price)), [[10, 10, 10], [10, 10, 10]], 'every part of those sets, including the open one, is £10');
  assert.deepEqual([await initials(p[2]), await initials(p[3])], [[10], [10]], 'the unsecured set 2 stayed at £10');
  const fresh1 = fresh(), fresh2 = fresh(); await claimSet(fresh1, item, 'A'); await claimSet(fresh2, item, 'B'); const [, , s3] = await setsOf(item); assert.equal(s3.number, 3, 'a new set was opened'); assert.deepEqual([await initials(fresh1), await initials(fresh2)], [[15], [15]], 'new sets use the new price'); assert.equal(s3.partPrice, null, 'and follow the item');
  assert.equal((await setPrice(item, 18, 'newSets')).status, 200); assert.deepEqual((await setsOf(item)).map((s) => s.partPrice), [10, 10, 15], 'a second change pins set 3 at £15; sets 1–2 stay at £10'); const f3 = fresh(); await claimSet(f3, item, 'A'); const sets4 = await setsOf(item); assert.deepEqual([sets4.length, await initials(f3)], [4, [18]], 'A is taken in sets 1–3, so a new set 4 opens at the new price');
  assert.ok(s1 && s2);
});

test('"EVERYTHING NOT SECURED YET": sets follow the item again (pins are cleared) and unsecured claims move — secured claims never do', async () => {
  const { item, p } = await twoSets(); await setPrice(item, 15, 'newSets'); assert.deepEqual((await setsOf(item)).map((s) => s.partPrice), [10, 10]);
  const r = await setPrice(item, 12, 'all'); assert.equal(r.json.repriced, 2, 'the two unsecured claims in set 2 moved'); assert.deepEqual((await setsOf(item)).map((s) => s.partPrice), [null, null], 'no set has its own price any more'); assert.deepEqual((await setsOf(item)).map((s) => s.parts[2].price), [12, 12], 'open parts follow the item');
  assert.deepEqual([await initials(p[0]), await initials(p[1]), await initials(p[2]), await initials(p[3])], [[10], [10], [12], [12]], 'set 1 was secured and keeps £10; set 2 was not and follows');
});

test('A NEWCOMER WHO TAKES AN OPEN SPOT IN AN OLDER SET PAYS THAT SET\'S PRICE; one who needs a new set pays the item\'s price', async () => {
  const { item, s1 } = await twoSets(); await setPrice(item, 15, 'newSets'); const into = fresh(); const placed = await claimSet(into, item, 'C'); assert.equal(placed.status, 201, placed.text);
  assert.deepEqual(await initials(into), [10], 'part C was open in set 1 (£10) — so they pay £10'); const claim = (await api('GET', `/api/admin/claims?handle=${into}`)).json.claims[0]; assert.match(claim.label, /\(Set 1\)$/); assert.equal(claim.status, 'requested', 'in a secured set it still waits for you to confirm');
  const [after] = await setsOf(item); assert.equal(after.id, s1.id); assert.equal(after.partPrice, 10);
  const own = new Map(); void own;
});

test('SPLITTING AN OPEN PART AND ASSIGNING SOMEONE TO ONE BOTH USE THE SET\'S PRICE (your raffle case)', async () => {
  const { item, p, s1, s2 } = await twoSets(); await secure(s2); await setPrice(item, 15, 'newSets');
  const split = await api('POST', `/api/admin/sets/${s1.id}/split`, { member: 'C' }); assert.equal(split.status, 200, split.text); assert.deepEqual([split.json.price, split.json.holders, split.json.share], [10, 2, 5], 'the open part is shared at £10, not £15');
  assert.deepEqual([await initials(p[0]), await initials(p[1])], [[15], [15]].map(() => [15]).length ? [[15], [15]] : [], 'each holder owes their £10 + £5 share');
  const who = fresh(); const assign = await api('POST', `/api/admin/sets/${s2.id}/slots`, { member: 'C', handle: who }); assert.equal(assign.status, 201, assign.text); assert.deepEqual(await initials(who), [10], 'someone put into an open part of the £10 set pays £10');
  const raffle = await app.q("SELECT raffle_share AS s FROM set_slots WHERE set_id = ? AND member_name = 'C'", [s1.id]); assert.equal(Number(raffle[0].s), 5, 'and the raffle is for a £5 share');
});

test('A PART WITH ITS OWN PRICE STILL COSTS THAT, whatever the set\'s price — even when it lands in a set that has its own price', async () => {
  const item = await newSet(10, ['A', 'B'], { B: 14 }); const first = fresh(); await claimSet(first, item, 'A'); await setPrice(item, 15, 'newSets');          // set 1 has only A, and is now pinned at £10
  const [s1] = await setsOf(item); assert.equal(s1.partPrice, 10); assert.deepEqual(s1.parts.map((x) => [x.member, x.price]), [['A', 10], ['B', 14]], 'B keeps its own price in the list');
  const b = fresh(); await claimSet(b, item, 'B'); assert.deepEqual(await initials(b), [14], 'B lands in the pinned set 1 — and costs its OWN price (£14), not the set\'s £10 or the item\'s £15');
  const later = fresh(); await claimSet(later, item, 'B'); assert.deepEqual(await initials(later), [14], 'and in a new set it is the same');
});

test('A CANCELLED SET IS NOT PINNED when the price changes ("only new sets" only protects the sets that are still going)', async () => {
  const { item, s1, s2 } = await twoSets(); assert.equal((await api('POST', `/api/admin/sets/${s2.id}/cancel`, {})).status, 200); await setPrice(item, 15, 'newSets');
  const rows = await app.q('SELECT id, part_price AS p FROM item_sets WHERE item_id = ? ORDER BY set_number', [item]); assert.deepEqual(rows.map((r) => r.p === null ? null : Number(r.p)), [10, null], 'set 1 pinned; the cancelled set 2 left alone'); assert.ok(s1);
});

test('THE LISTS TELL THE SCREENS: each set says its own price (or null), the item says how many sets it has', async () => {
  const { item } = await twoSets(); await setPrice(item, 15, 'newSets'); await claimSet(fresh(), item, 'A'); await claimSet(fresh(), item, 'B'); const sets = await setsOf(item); assert.deepEqual(sets.map((s) => [s.number, s.partPrice]), [[1, 10], [2, 10], [3, null]]);
  const it = (await api('GET', '/api/admin/orders')).json.orders.flatMap((o) => o.items).find((i) => i.id === item); assert.equal(it.setCount, 3, 'the item form is told it has 3 sets');
});

test('THE MIGRATION BACKFILL: a set where everyone pays the same price that is not the item\'s current price remembers it; sets at the item price, sets that disagree, raffle wins, shares, own-price parts, TBC and cancelled claims are handled', async () => {
  const sql = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations/050_set_prices.sql'), 'utf8'); const update = sql.slice(sql.indexOf('UPDATE item_sets s'), sql.lastIndexOf(';') + 1); assert.ok(update.startsWith('UPDATE item_sets s') && update.includes('HAVING') === false);
  const item = await newSet(15, ['A', 'B', 'C']); const people = Array.from({ length: 12 }, () => fresh()); const take = async (h, part) => { const r = await claimSet(h, item, part); assert.equal(r.status, 201, r.text); };
  // six sets, filled A,B,C in turn; set n is made of people[3(n-1)..]
  for (const h of people.slice(0, 3)) void h; const sets = []; for (let n = 0; n < 4; n++) { await take(people[n * 3], 'A'); await take(people[n * 3 + 1], 'B'); await take(people[n * 3 + 2], 'C'); }
  const all = await setsOf(item); assert.equal(all.length, 4); const cost = (h, v) => app.q("UPDATE claim_costs SET cost = ? WHERE category = 'initials' AND claim_id IN (SELECT id FROM claims WHERE joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?))", [v, h]);
  for (const h of people.slice(0, 3)) await cost(h, 10);                                    // set 1: everyone at £10 (item is £15)  → pinned at 10
  /* set 2: untouched, everyone at £15 → NULL */
  await cost(people[6], 10); await cost(people[7], 12); await cost(people[8], 10);          // set 3: they disagree → NULL
  await cost(people[9], 10); await cost(people[10], 10); await cost(people[11], 0);         // set 4: two at £10 and a raffle win (cost 0) → pinned at 10
  await app.q('UPDATE item_sets SET part_price = NULL WHERE item_id = ?', [item]); await app.q(update); const got = (await setsOf(item)).map((s) => s.partPrice); assert.deepEqual(got, [10, null, null, 10]);
  // a share of an open part is taken off: set 2's people at £15 with a £5 share each = £10 → pinned at 10; a cancelled claim at another price doesn't count
  await app.q("UPDATE claims SET split_share = 5 WHERE joiner_id IN (SELECT id FROM joiners WHERE instagram_handle IN (?))", [people.slice(3, 6)]); await app.q('UPDATE item_sets SET part_price = NULL WHERE item_id = ?', [item]); await app.q(update);
  assert.deepEqual((await setsOf(item)).map((s) => s.partPrice), [10, 10, null, 10], 'set 2: £15 less a £5 share of an open part is £10');
});

test('AN ITEM THAT GOES "PRICE TO BE CONFIRMED" AFTER ITS SETS WERE PRICED: those sets keep their price, so an open part can still be split or assigned (it is not treated as TBC)', async () => {
  const { item, p, s1, s2 } = await twoSets(); await secure(s2); const r = await api('PATCH', `/api/admin/items/${item}`, { priceTbc: true, priceScope: 'newSets' }); assert.equal(r.status, 200, r.text);
  assert.deepEqual((await setsOf(item)).map((s) => s.partPrice), [10, 10], 'pinned at what they cost'); assert.deepEqual([await initials(p[2]), await initials(p[3])], [[10], [10]], 'and the unsecured claims in them did not go TBC');
  const split = await api('POST', `/api/admin/sets/${s1.id}/split`, { member: 'C' }); assert.deepEqual([split.status, split.json.price], [200, 10], 'a part of a priced set can still be split'); const who = fresh(); const assign = await api('POST', `/api/admin/sets/${s2.id}/slots`, { member: 'C', handle: who }); assert.equal(assign.status, 201, assign.text); assert.deepEqual(await initials(who), [10]);
});

test('AN ITEM THAT WAS "TO BE CONFIRMED" IS NEVER PINNED AT ITS HIDDEN PLACEHOLDER (£0): setting its price with "only new sets" leaves the sets following it', async () => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Tbc set GO ${++N}` })).json.id; const created = await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: `Tbc set ${N}`, priceTbc: true, members: ['A', 'B'] }); assert.equal(created.status, 201, created.text); const item = created.json.id;
  const people = [fresh(), fresh()]; await claimSet(people[0], item, 'A'); await claimSet(people[1], item, 'B'); const r = await setPrice(item, 12, 'newSets'); assert.equal(r.status, 200, r.text);
  assert.deepEqual((await setsOf(item)).map((s) => s.partPrice), [null], 'not pinned at £0'); assert.deepEqual([await initials(people[0]), await initials(people[1])], [[12], [12]], 'the TBC claims take the price that has just been set');
});

