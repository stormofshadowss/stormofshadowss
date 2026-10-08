import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';
import { row, csv } from './notion.fixture.js';

let app, admin, w, N = 0, ITEM;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const go = (await app.api('POST', '/api/admin/orders', { groupId: w.group, title: 'Move GO' }, admin)).json.id;
  const mk = async (title, price) => (await app.api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price }, admin)).json.id;
  ITEM = { ten: await mk('Ten pound thing', 10), twenty: await mk('Twenty pound thing', 20), five: await mk('Five pound thing', 5) };
});
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (p = 'mv') => `${p}${++N}`;
const move = (claimIds, handle, extra = {}) => api('POST', '/api/admin/claims/move', { claimIds, handle, ...extra });
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const totals = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.people[h];
// a signed-in person with confirmed claims, who may have paid
async function payer(handle = u(), items = [ITEM.ten, ITEM.twenty], pay = 0) {
  const cookie = await joinerSession(app, `${handle}@x.com`, handle);
  const ids = []; for (const it of items) ids.push((await claimAndSecure(app, admin, handle, it))[0]);
  if (pay) { const p = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: pay, reference: `REF-${handle}` }, cookie); assert.equal(p.status, 201, p.text); await api('POST', `/api/admin/payments/${p.json.id}/verify`, {}); }
  return { handle, cookie, ids };
}
const snapshot = async () => ({ claims: JSON.stringify(await app.q('SELECT id, joiner_id FROM claims ORDER BY id')), payments: JSON.stringify(await app.q('SELECT id, joiner_id, amount FROM payments ORDER BY id')), allocs: (await app.q('SELECT COUNT(*) AS n FROM payment_allocations'))[0].n });
const paymentsOf = async (h) => app.q('SELECT p.id, p.amount, p.method, p.reference, p.status FROM payments p JOIN joiners j ON j.id = p.joiner_id WHERE j.instagram_handle = ? ORDER BY p.id', [h]);
const allocSum = async (paymentId) => Number((await app.q('SELECT COALESCE(SUM(amount), 0) AS s FROM payment_allocations WHERE payment_id = ?', [paymentId]))[0].s);

test('moving claims: they change hands with their costs and stage; the target is told what it now owns; nothing else about them changes', async () => {
  const a = await payer(u('from'), [ITEM.ten, ITEM.twenty]), b = await payer(u('to'), [ITEM.five]);
  await api('PATCH', `/api/admin/claims/${a.ids[0]}`, { pipeline: 'ordered via proxy / warehouse', costs: { ems: { cost: 2 } } });
  const before = (await claimsOf(a.handle)).find((c) => c.id === a.ids[0]);
  const r = await move([a.ids[0]], `@${b.handle.toUpperCase()}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.moved, r.json.target.exists, r.json.target.signedUp, r.json.blocked], [1, true, true, []]);
  const after = (await claimsOf(b.handle)).find((c) => c.id === a.ids[0]);
  assert.deepEqual([after.label, after.status, after.pipeline, after.costs.initials.cost, after.costs.ems.cost], [before.label, before.status, before.pipeline, 10, 2]);
  assert.deepEqual((await claimsOf(a.handle)).map((c) => c.id), [a.ids[1]], 'the other claim stays');
  assert.deepEqual([(await totals(a.handle)).owed, (await totals(b.handle)).owed], [20, 17], 'a owes £20 now; b owes their own £5 plus £12 (the £10 and its £2 EMS)');
});

test('PAID MONEY FOLLOWS: a payment that went wholly to the moved claim changes hands; both people\'s books still add up', async () => {
  const a = await payer(u('from'), [ITEM.ten], 10), b = await payer(u('to'), [ITEM.five]);
  const [pay] = await paymentsOf(a.handle);
  assert.equal(Number(pay.amount), 10);
  const r = await move(a.ids, b.handle);
  assert.deepEqual(r.json.payments, { reassigned: 1, split: 0 });
  assert.deepEqual((await paymentsOf(a.handle)).length, 0, 'a no longer has that payment');
  const [bp] = (await paymentsOf(b.handle)).filter((p) => p.id === pay.id);
  assert.deepEqual([Number(bp.amount), bp.status, bp.reference], [10, 'confirmed', `REF-${a.handle}`], 'the very same payment record, now b\'s');
  assert.deepEqual([(await totals(b.handle)).paid, (await totals(a.handle))?.paid ?? 0], [10, 0]);
  assert.equal((await claimsOf(b.handle)).find((c) => c.id === a.ids[0]).costs.initials.paid, 10);
});

test('a payment SHARED with a claim that stays is SPLIT: the original shrinks, the new owner gets a verified payment for exactly what moved, and the allocations follow', async () => {
  const a = await payer(u('from'), [ITEM.ten, ITEM.twenty], 25), b = await payer(u('to'), [ITEM.five]);
  // £25 paid: £10 + £15 (greedy across the claims). Move the £10 claim.
  const [orig] = await paymentsOf(a.handle);
  assert.equal(Number(orig.amount), 25);
  const r = await move([a.ids[0]], b.handle);
  assert.deepEqual(r.json.payments, { reassigned: 0, split: 1 });
  const aPays = await paymentsOf(a.handle), bPays = await paymentsOf(b.handle);
  assert.deepEqual(aPays.map((p) => [p.id === orig.id, Number(p.amount)]), [[true, 15]], 'a\'s payment shrank by what moved');
  const moved = bPays.find((p) => p.id !== orig.id && /moved from another handle/.test(p.reference));
  assert.deepEqual([Number(moved.amount), moved.status, moved.method, moved.reference], [10, 'confirmed', 'PayPal', `REF-${a.handle} (moved from another handle)`]);
  assert.equal(await allocSum(orig.id), 15); assert.equal(await allocSum(moved.id), 10, 'each payment is allocated exactly what it is worth');
  assert.deepEqual([(await totals(a.handle)).paid, (await totals(b.handle)).paid], [15, 10]);
});

test('overpayment: the person keeps their credit — only what was allocated to the moved claim goes with it', async () => {
  const a = await payer(u('from'), [ITEM.ten], 0), b = await payer(u('to'), [ITEM.five]);
  const p = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 14, reference: 'OVER', overpay: { choice: 'credit' } }, a.cookie);
  await api('POST', `/api/admin/payments/${p.json.id}/verify`, {});
  assert.equal((await app.api('GET', '/api/my/summary', undefined, a.cookie)).json.credit, 4);
  const r = await move(a.ids, b.handle);
  assert.equal(r.status, 200);
  assert.equal((await app.api('GET', '/api/my/summary', undefined, a.cookie)).json.credit, 4, 'the £4 credit stayed with the person who overpaid');
  const mine = (await paymentsOf(a.handle)).find((x) => x.id === p.json.id);
  assert.equal(Number(mine.amount), 4, 'what is left of their payment is the overpayment');
  assert.equal(Number((await paymentsOf(b.handle)).find((x) => /moved/.test(x.reference)).amount), 10);
});

test('a dry run reports exactly what would happen — what moves, what cannot and why, and the money — and changes NOTHING', async () => {
  const a = await payer(u('from'), [ITEM.ten, ITEM.twenty], 12), b = await payer(u('to'), [ITEM.five]);
  const before = await snapshot();
  const r = await move([...a.ids, 999999], b.handle, { dryRun: true });
  assert.equal(r.status, 200); assert.equal(r.json.dryRun, true);
  assert.deepEqual(r.json.movable.map((m) => [m.id, m.paid, m.owed]), [[a.ids[0], 10, 0], [a.ids[1], 2, 18]]);
  assert.deepEqual(r.json.blocked.map((x) => [x.id, x.reason]), [[999999, 'no such claim']]);
  assert.deepEqual(r.json.money, { paid: 12, owed: 18 });
  assert.deepEqual(await snapshot(), before, 'not a single row changed');
});

test('what cannot be moved is left alone, with the reason: already theirs, set parts, fixed claims, and money that is not tied to a payment', async () => {
  const a = await payer(u('from'), [ITEM.ten], 0), b = await payer(u('to'), [ITEM.five]);
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Set GO ${++N}` })).json.id;
  const set = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: `Set ${N}`, price: 3, members: ['X', 'Y'] })).json.id;
  await app.api('POST', '/api/claims', { handle: a.handle, lines: [{ itemId: set, parts: [{ member: 'X', qty: 1 }] }] });
  await api('POST', `/api/admin/items/${set}/fixed`, { handle: a.handle, member: 'Y' });
  const setClaims = (await claimsOf(a.handle)).filter((c) => c.setId);
  // credit spent on a claim: its paid money has no payment behind it
  await api('POST', '/api/admin/credit/add', { handle: a.handle, amount: 4, reason: 'x' });
  const creditClaim = (await claimsOf(a.handle)).find((c) => c.id === a.ids[0]);
  assert.equal(creditClaim.costs.initials.paid, 4);
  const mine = await claimsOf(b.handle);
  const r = await move([a.ids[0], ...setClaims.map((c) => c.id), mine[0].id], b.handle, { dryRun: true });
  const why = Object.fromEntries(r.json.blocked.map((x) => [x.id, x.reason]));
  assert.match(why[a.ids[0]], /isn't tied to a payment \(for example credit was used\)/);
  for (const c of setClaims) assert.match(why[c.id], /part of a member set \(or a fixed claim\)/);
  assert.match(why[mine[0].id], new RegExp(`already belongs to @${b.handle}`));
  assert.deepEqual(r.json.movable, []);
  const real = await move([a.ids[0]], b.handle);
  assert.equal(real.status, 409); assert.equal(real.json.code, 'nothing_movable'); assert.match(real.json.error, /Nothing could be moved/);
});

test('parcels: a claim in a parcel being packed stays; a shipped parcel moves WITH its claims when all of them go; otherwise they stay', async () => {
  const a = await payer(u('from'), [ITEM.ten, ITEM.twenty, ITEM.five]), b = await payer(u('to'), [ITEM.five]);
  const jid = (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [a.handle]))[0].id;
  const parcel = async (status, claimIds) => { const [r] = await app.q ? [await app.pool.query('INSERT INTO parcels (joiner_id, method, status) VALUES (?, ?, ?)', [jid, 'Test post', status])] : []; const pid = r[0].insertId; for (const c of claimIds) await app.pool.query('INSERT INTO parcel_items (parcel_id, claim_id) VALUES (?, ?)', [pid, c]); return pid; };
  const packing = await parcel('requested', [a.ids[2]]);
  const shipped = await parcel('shipped', [a.ids[0], a.ids[1]]);
  // the shipped parcel has two items; moving just one is refused, moving both moves the parcel too
  let r = await move([a.ids[0], a.ids[2]], b.handle, { dryRun: true });
  const why = Object.fromEntries(r.json.blocked.map((x) => [x.id, x.reason]));
  assert.match(why[a.ids[2]], /being packed — use the Packing tab/); assert.match(why[a.ids[0]], /parcel with other items that aren't being moved/);
  assert.deepEqual(r.json.movable, []);
  r = await move([a.ids[0], a.ids[1]], b.handle);
  assert.equal(r.status, 200); assert.deepEqual(r.json.parcels, [shipped]);
  assert.equal((await app.q('SELECT joiner_id FROM parcels WHERE id = ?', [shipped]))[0].joiner_id, (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [b.handle]))[0].id, 'the parcel went with its claims');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM parcel_items WHERE parcel_id = ?', [shipped]))[0].n, 2);
  assert.equal((await app.q('SELECT joiner_id FROM parcels WHERE id = ?', [packing]))[0].joiner_id, jid, 'the parcel being packed did not move');
  const bp = await app.api('GET', '/api/my/parcels', undefined, b.cookie);
  assert.ok(bp.json.parcels.some((p) => p.id === shipped), 'and the new owner can see it (and press "It\'s arrived")');
});

test('the target: it must exist (unless you say create it), cannot be blocked, and handles are checked', async () => {
  const a = await payer(u('from'), [ITEM.ten]);
  const nobody = u('nobody');
  const no = await move(a.ids, nobody);
  assert.equal(no.status, 404); assert.equal(no.json.code, 'no_such_handle'); assert.match(no.json.error, new RegExp(`Nobody has the handle @${nobody}.*"create it"`));
  assert.deepEqual((await move(a.ids, nobody, { dryRun: true })).json.target, { handle: nobody, exists: false, signedUp: false, blocked: false, willCreate: false });
  const made = await move(a.ids, nobody, { create: true });
  assert.equal(made.status, 200); assert.equal(made.json.target.willCreate, true);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM joiners WHERE instagram_handle = ?', [nobody]))[0].n, 1);
  assert.deepEqual((await claimsOf(nobody)).map((c) => c.id), a.ids);
  const bad = u('bl'); await api('POST', '/api/admin/joiners/block', { handle: bad, reason: 't' });
  const c = await payer(u('from2'), [ITEM.five]);
  const blockedRes = await move(c.ids, bad);
  assert.equal(blockedRes.status, 409); assert.match(blockedRes.json.error, new RegExp(`@${bad} is blocked`));
  assert.equal((await move(c.ids, 'not a handle!')).status, 400);
  assert.equal((await move([], 'someone')).status, 400);
  assert.equal((await move(Array.from({ length: 501 }, (_, i) => i + 1), 'someone')).status, 400);
});

test('other screens follow the claim: Overdue names the new owner, and the new owner\'s My orders shows it with what is owed', async () => {
  const [go] = [(await api('POST', '/api/admin/orders', { groupId: w.group, title: `Late move GO ${++N}`, paymentDeadline: new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10) })).json.id];
  const it = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'Late thing', price: 9 })).json.id;
  const a = await payer(u('from'), [it]), b = await payer(u('to'), [ITEM.five]);
  assert.ok((await api('GET', '/api/admin/overdue')).json.payments.some((x) => x.handle === a.handle));
  await move(a.ids, b.handle);
  const o = (await api('GET', '/api/admin/overdue')).json.payments;
  assert.ok(o.some((x) => x.handle === b.handle && x.claimId === a.ids[0])); assert.equal(o.some((x) => x.handle === a.handle), false);
  const s = (await app.api('GET', '/api/my/summary', undefined, b.cookie)).json;
  assert.equal(s.orders.flatMap((x) => x.claims).some((c) => c.id === a.ids[0]), true);
  assert.equal(s.owed.total, 14, 'their own £5 plus the £9 that came across');
});

test('IMPORTED claims: old claims imported under the wrong handle can be moved to the signed-up account — and the import can then no longer be undone', async () => {
  const [wrong, go] = [u('kei_old'), `Moved import ${++N}`];
  const right = await payer(u('kei'), [ITEM.five]);
  const up = await fetch(`${app.base}/api/admin/import/notion?filename=x.csv`, { method: 'POST', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'text/csv' }, body: csv([row({ joiner: wrong, go, item: 'Old album', initials: 20, paid: 5 }), row({ joiner: wrong, go, item: 'Old shirt', initials: 30, paid: 30 })]) }).then((r) => r.json());
  await api('PUT', `/api/admin/import/batches/${up.id}/mapping`, { scope: 'all' });
  assert.equal((await api('POST', `/api/admin/import/batches/${up.id}/run`, {})).status, 200);
  const ids = (await claimsOf(wrong)).map((c) => c.id);
  assert.equal(ids.length, 2);
  const r = await move(ids, right.handle);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual((await claimsOf(right.handle)).map((c) => c.label).sort(), ['Five pound thing', 'Old album', 'Old shirt']);
  const s = (await app.api('GET', '/api/my/summary', undefined, right.cookie)).json;
  assert.equal(s.orders.find((o) => o.title === go).claims.length, 2, 'it all shows in the account they already had');
  assert.equal(s.owed.total, 20, '£5 for the five-pound thing, £15 left on the album');
  // the import's own records would now be out of step, so it can no longer be undone
  const undo = await api('POST', `/api/admin/import/batches/${up.id}/undo`, {});
  assert.equal(undo.status, 409); assert.equal(undo.json.code, 'import_in_use'); assert.match(undo.json.error, /some of its claims have since been moved to other people/);
});

test('two moves of the same claims at the same instant leave everything consistent — one owner, with the money alongside', async () => {
  const a = await payer(u('from'), [ITEM.ten, ITEM.twenty], 25), b = await payer(u('b'), [ITEM.five]), c = await payer(u('c'), [ITEM.five]);
  const rs = await Promise.all([move(a.ids, b.handle), move(a.ids, c.handle)]);
  assert.ok(rs.every((r) => [200, 409].includes(r.status)), rs.map((r) => r.status).join());
  const owners = await app.q('SELECT DISTINCT j.instagram_handle AS h FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE c.id IN (?)', [a.ids]);
  assert.equal(owners.length, 1, `both claims ended with one owner (${owners.map((o) => o.h)})`);
  const holder = owners[0].h;
  assert.equal(Number((await totals(holder)).paid) >= 25, true);
  const bad = await app.q('SELECT COUNT(*) AS n FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id JOIN claims c ON c.id = pa.claim_id WHERE p.joiner_id <> c.joiner_id');
  assert.equal(bad[0].n, 0, 'no payment is allocated to a claim that belongs to someone else');
});

test('only the GOM can move claims, and every move is recorded', async () => {
  const a = await payer(u('from'), [ITEM.ten]), b = await payer(u('to'), [ITEM.five]);
  const j = await app.login('mv.joiner@x.com');
  assert.equal((await api('POST', '/api/admin/claims/move', { claimIds: a.ids, handle: b.handle }, j)).status, 403);
  assert.equal((await app.api('POST', '/api/admin/claims/move', { claimIds: a.ids, handle: b.handle })).status, 401);
  await move(a.ids, b.handle);
  const log = (await app.q("SELECT detail FROM audit_log WHERE action = 'claims.move' ORDER BY id DESC LIMIT 1"))[0];
  assert.match(String(log.detail), new RegExp(b.handle));
});

test('INVARIANTS: payments add up everywhere — each is worth what it is allocated plus any overpayment, and every allocation belongs to its claim\'s owner', async () => {
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM payments p WHERE p.status = 'confirmed' AND p.amount < COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id = p.id), 0) - 0.005"))[0].n, 0, 'never allocated more than it is worth');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id JOIN claims c ON c.id = pa.claim_id WHERE p.joiner_id <> c.joiner_id'))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost OR cost < 0'))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM payments WHERE amount <= 0'))[0].n, 0, 'no empty payments left behind');
});
