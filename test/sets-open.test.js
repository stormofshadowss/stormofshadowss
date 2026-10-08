import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { round2 } from '../src/lib/money.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const fresh = (p = 'o') => `${p}${++N}`;
const claim = (handle, itemId, ...parts) => api('POST', '/api/claims', { handle, lines: [{ itemId, parts: parts.map((member) => ({ member, qty: 1 })) }] }, undefined);
const sets = async (itemId) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === itemId);
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const sum = (xs) => round2(xs.reduce((a, b) => a + b, 0));
// a secured set of `price`-per-part with `held` of its parts taken by different people, one part (the last) left open
async function securedSet({ price = 8, members = ['A', 'B', 'C', 'D'], held = 3, title = 'Open part set' } = {}) {
  const item = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: `${title} ${++N}`, price, members })).json.id;
  const people = [];
  for (let i = 0; i < held; i++) { const h = fresh('p'); people.push(h); await claim(h, item, members[i]); }
  const [s1] = await sets(item);
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  return { item, set: s1.id, people, open: members[held] };
}
const split = (set, member, c = admin) => api('POST', `/api/admin/sets/${set}/split`, { member }, c);
const raffle = (set, member, handle, c = admin) => api('POST', `/api/admin/sets/${set}/raffle`, { member, handle }, c);
const initials = async (h) => (await claimsOf(h)).map((c) => c.costs.initials.cost);

test('splitting an open part: its price is shared across the claims in the set, to the penny', async () => {
  const { set, people, open } = await securedSet({ price: 8, held: 3 });
  const r = await split(set, open);
  assert.deepEqual([r.status, r.json.price, r.json.holders], [200, 8, 3]);
  const costs = (await Promise.all(people.map(initials))).flat();
  const extras = costs.map((c) => round2(c - 8));
  assert.equal(sum(extras), 8, 'the shares add back to exactly the part\'s price');
  assert.ok(extras.every((x) => x === 2.66 || x === 2.67), `shares differ by at most a penny (${extras})`);
  assert.equal((await claimsOf(people[0]))[0].status, 'confirmed', 'nothing else about the claim changes');
});

test('the shares are exact for awkward prices and any number of people', async () => {
  for (const [price, held] of [[9.99, 7], [3, 6], [0.01, 3], [100, 7], [8, 2]]) {
    const members = Array.from({ length: held + 1 }, (_, i) => `M${i}`);
    const { set, people, open } = await securedSet({ price, members, held, title: `Exact ${price}` });
    await split(set, open);
    const extras = (await Promise.all(people.map(initials))).flat().map((c) => round2(c - price));
    assert.equal(sum(extras), price, `£${price} over ${held} people`);
  }
});

test('the extra is OWED, not paid: what was already paid is untouched, and the joiner is told what the extra is for', async () => {
  const h = fresh('pay'); const cj = await joinerSession(app, `${h}@x.com`, h);
  const item = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: `Paid set ${++N}`, price: 6, members: ['X', 'Y', 'Z'] })).json.id;
  await claim(h, item, 'X'); await claim(fresh('q'), item, 'Y');
  const [s1] = await sets(item);
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 6, reference: 'SP' }, cj);
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  assert.equal((await app.api('GET', '/api/my/summary', undefined, cj)).json.owed.total, 0);
  await split(s1.id, 'Z');                                                                 // £6 shared between 2 people = £3 each
  const s = (await app.api('GET', '/api/my/summary', undefined, cj)).json;
  assert.equal(s.owed.total, 3, 'they paid £6, the claim is now £9, so £3 is owed');
  assert.equal(s.orders[0].claims[0].splitShare, 3, 'the summary says how much of the cost is a share of an unclaimed part');
});

test('credit the joiner already holds meets the extra automatically', async () => {
  const h = fresh('cr'); const cj = await joinerSession(app, `${h}@x.com`, h);
  const item = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: `Credit set ${++N}`, price: 6, members: ['X', 'Y'] })).json.id;
  await claim(h, item, 'X');
  const [s1] = await sets(item);
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 10, reference: 'CR', overpay: { choice: 'credit' } }, cj);   // owes 6, pays 10 -> £4 credit
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  await split(s1.id, 'Y');                                                                // the one claim takes the whole £6 share
  const s = (await app.api('GET', '/api/my/summary', undefined, cj)).json;
  assert.deepEqual([s.owed.total, s.credit], [2, 0], '£4 credit paid £4 of the £6 extra; £2 is left to pay');
});

test('rules for splitting: only a secured set, only a part that is really open, only once, and the GOM only', async () => {
  const fresh1 = await securedSet({ held: 3 });
  const plain = await joinerSession(app, `${fresh('nj')}@x.com`, fresh('nh'));
  assert.equal((await split(fresh1.set, fresh1.open, plain)).status, 403);
  assert.equal((await split(999999, 'A')).status, 404);
  assert.equal((await split(fresh1.set, 'Nope')).status, 400, 'not a part of this set');
  assert.equal((await split(fresh1.set, 'A')).json.code, 'slot_taken', 'a part someone holds is not open');
  assert.equal((await split(fresh1.set, fresh1.open)).status, 200);
  assert.equal((await split(fresh1.set, fresh1.open)).json.code, 'slot_taken', 'splitting twice would charge everyone twice');
  const item = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: `Undecided ${++N}`, price: 3, members: ['P', 'Q'] })).json.id;
  await claim(fresh(), item, 'P');
  const [s1] = await sets(item);
  assert.equal((await split(s1.id, 'Q')).json.code, 'bad_state', 'an unsecured set can just be left open or secured differently');
});

test('while a raffle is pending: the part shows as such, and nobody can be put into it by hand', async () => {
  const { set, item, open } = await securedSet({ held: 3 });
  await split(set, open);
  const part = (await sets(item))[0].parts.find((p) => p.member === open);
  assert.deepEqual([part.handle, part.raffle.status], [null, 'pending']);
  assert.ok(part.raffle.share >= 2.66);
  const add = await api('POST', `/api/admin/sets/${set}/slots`, { member: open, handle: fresh('late') });
  assert.equal(add.status, 409); assert.equal(add.json.code, 'raffle_pending');
  assert.equal((await sets(item))[0].filled, 3, 'still three people in it');
});

test('picking the winner: they get the part at no further cost, confirmed; it must be someone in the set; only once', async () => {
  const { set, item, people, open } = await securedSet({ held: 3, title: 'Raffle set' });
  await split(set, open);
  assert.equal((await raffle(set, open, fresh('stranger'))).json.code, 'not_in_set');
  const outsider = fresh('out'); await claim(outsider, (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: `Other ${++N}`, price: 1, members: ['Z'] })).json.id, 'Z');
  assert.equal((await raffle(set, open, outsider)).json.code, 'not_in_set', 'being in a DIFFERENT set does not count');
  assert.equal((await raffle(set, 'A', people[0])).json.code, 'no_raffle', 'there is no raffle for a part someone already holds');
  const win = await raffle(set, open, `@${people[1].toUpperCase()}`);
  assert.equal(win.status, 200);
  const rows = await claimsOf(people[1]);
  const prize = rows.find((c) => /raffle win/.test(c.label));
  assert.deepEqual([prize.status, prize.costs.initials.cost, prize.is_direct], ['confirmed', 0, false]);
  assert.match(prize.label, new RegExp(`${open} \\(Set 1\\) — raffle win`));
  const after = (await sets(item))[0];
  assert.deepEqual([after.filled, after.parts.find((p) => p.member === open).handle, after.parts.find((p) => p.member === open).raffle.status], [4, people[1], 'resolved']);
  assert.equal((await raffle(set, open, people[2])).json.code, 'no_raffle', 'a raffle can only be settled once');
  const total = sum((await Promise.all(people.map(async (h) => (await claimsOf(h)).reduce((t, c) => t + c.costs.initials.cost, 0)))));
  assert.equal(total, 3 * 8 + 8, 'together they paid for the 3 parts they held plus the raffled one — the winner\'s prize costs nothing more');
});

test('cancelling the set after a split removes the pending raffle and returns what was paid, shares included', async () => {
  const h = fresh('cs'); const cj = await joinerSession(app, `${h}@x.com`, h);
  const item = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: `Cancel after split ${++N}`, price: 6, members: ['A', 'B', 'C'] })).json.id;
  await claim(h, item, 'A'); await claim(fresh(), item, 'B');
  const [s1] = await sets(item);
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  await split(s1.id, 'C');                                                                 // £6 / 2 = £3 each -> they now owe £9
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 9, reference: 'CS' }, cj);
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  const r = await api('POST', `/api/admin/sets/${s1.id}/cancel`, {});
  assert.equal(r.json.refunded, 9, 'the share they paid comes back with the rest');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM set_slots WHERE set_id = ?', [s1.id]))[0].n, 0, 'the raffle placeholder is gone too');
});

test('STRESS: five splits of the same part at the same instant charge everyone exactly once', async () => {
  const { set, people, open } = await securedSet({ price: 9, held: 3 });
  const rs = await Promise.all(Array.from({ length: 5 }, () => split(set, open)));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409, 409, 409]);
  const extras = (await Promise.all(people.map(initials))).flat().map((c) => round2(c - 9));
  assert.equal(sum(extras), 9, 'one split, not five');
});

test('INVARIANTS: money still adds up and no part is held twice', async () => {
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost OR cost < 0'))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM (SELECT set_id, member_name FROM set_slots GROUP BY set_id, member_name HAVING COUNT(*) > 1) x'))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM set_slots sl LEFT JOIN claims c ON c.slot_id = sl.id WHERE c.id IS NULL AND sl.joiner_id IS NOT NULL'))[0].n, 0, 'every held part has its claim');
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM set_slots WHERE joiner_id IS NULL AND raffle_status <> 'pending'"))[0].n, 0, 'a part with nobody in it is only ever a pending raffle');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE split_share > 0 AND set_id IS NULL'))[0].n, 0);
});
