import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';

let app, admin, w, S, S2, N;
const ROSTER = ['Bang Chan', 'Han', 'Felix', 'Hyunjin'];
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const add = (body) => app.api('POST', `/api/admin/orders/${w.order}/items`, body, admin).then((r) => r.json.id);
  S = await add({ type: 'set', title: 'Run It Photocards', price: 8, members: ROSTER });
  S2 = await add({ type: 'set', title: 'Next comeback photocards', price: 9, members: ROSTER.slice(0, 3) });
  N = 0;
});
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const fresh = (p = 'f') => `${p}${++N}`;
const addFixed = (itemId, handle, member) => api('POST', `/api/admin/items/${itemId}/fixed`, { handle, member });
const fixedOf = async (itemId) => (await api('GET', `/api/admin/items/${itemId}/fixed`)).json.fixed;
const setsOf = async (itemId) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === itemId);
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const general = (handle, itemId, ...members) => api('POST', '/api/claims', { handle, lines: [{ itemId, parts: members.map((m) => ({ member: m, qty: 1 })) }] }, undefined);
// a fresh set item so each test starts clean
async function newItem(title = 'Fixed test set', members = ROSTER, price = 8) {
  return (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: `${title} ${++N}`, price, members })).json.id;
}
async function member(handle) { return joinerSession(app, `${handle}@x.com`, handle); }

test('two people fixed on Bang Chan land in different sets; fixed claimers on other members fill those same early sets', async () => {
  const item = await newItem();
  const r = [await addFixed(item, 'fixa', 'Bang Chan'), await addFixed(item, 'fixb', 'Bang Chan'), await addFixed(item, 'fixc', 'Han'), await addFixed(item, 'fixd', 'Han'), await addFixed(item, 'fixe', 'Felix')];
  assert.deepEqual(r.map((x) => x.json.setNumber), [1, 2, 1, 2, 1]);
  assert.equal((await setsOf(item)).length, 2, 'five people needed only two sets');
  const sets = await setsOf(item);
  assert.deepEqual(sets[0].parts.map((p) => [p.member, p.handle, p.fixed]), [['Bang Chan', 'fixa', true], ['Han', 'fixc', true], ['Felix', 'fixe', true], ['Hyunjin', null, false]]);
  const claims = await claimsOf('fixa');
  assert.deepEqual([claims[0].is_fixed, claims[0].status, claims[0].costs.initials.cost], [true, 'requested', 8]);
  assert.equal((await fixedOf(item)).length, 5);
});

test('everyone else\'s claims skip a reserved part', async () => {
  const item = await newItem();
  await addFixed(item, 'resa', 'Bang Chan'); await addFixed(item, 'resb', 'Bang Chan');          // Bang Chan reserved in Sets 1 and 2
  const g = await general(fresh('gen'), item, 'Bang Chan', 'Han');
  assert.deepEqual(g.json.placements.map((p) => [p.member, p.setNumber]), [['Bang Chan', 3], ['Han', 1]], 'Bang Chan goes to a NEW Set 3; Han takes the earliest free slot');
});

test('adding a fixed claim: duplicates, unknown parts, non-sets, bad or blocked handles, missing items, and permissions', async () => {
  const item = await newItem();
  const h = fresh('val');
  assert.equal((await addFixed(item, h, 'Han')).status, 201);
  const dup = await addFixed(item, `@${h}`, 'Han');
  assert.equal(dup.status, 409); assert.equal(dup.json.code, 'already_fixed');
  assert.equal((await addFixed(item, h, 'Felix')).status, 201, 'a different member is fine');
  assert.equal((await addFixed(item, h, 'Nobody')).status, 400);
  assert.equal((await addFixed(w.keyring, h, 'Han')).json.code, 'not_a_set');
  assert.equal((await addFixed(item, 'bad handle!', 'Han')).status, 400);
  assert.equal((await addFixed(999999, h, 'Han')).status, 404);
  await api('POST', '/api/admin/joiners/block', { handle: 'blocked_fx', reason: 't' });
  assert.equal((await addFixed(item, 'blocked_fx', 'Han')).json.code, 'handle_blocked');
  const c = await member(fresh('plain'));
  assert.equal((await api('POST', `/api/admin/items/${item}/fixed`, { handle: 'x', member: 'Han' }, c)).status, 403);
  assert.equal((await api('GET', `/api/admin/items/${item}/fixed`, undefined, c)).status, 403);
  assert.equal((await fixedOf(item)).length, 2, 'only the two valid ones exist');
});

test('GOM removes a fixed claim: the claim is cancelled, paid money returns as credit, and the part is free for anyone', async () => {
  const item = await newItem(); const h = fresh('rm'); const c = await member(h);
  const added = await addFixed(item, h, 'Han');
  const [set1] = await setsOf(item);
  await api('POST', `/api/admin/sets/${set1.id}/secure`, {});
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 8, reference: 'RM' }, c);
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  const fx = (await fixedOf(item))[0];
  const r = await api('DELETE', `/api/admin/fixed/${fx.id}`);
  assert.deepEqual([r.status, r.json.refunded], [200, 8]);
  assert.equal((await claimsOf(h))[0].status, 'cancelled');
  assert.equal((await app.api('GET', '/api/my/summary', undefined, c)).json.credit, 8);
  assert.equal((await fixedOf(item)).length, 0);
  assert.equal((await api('DELETE', `/api/admin/fixed/${fx.id}`)).json.code, 'fixed_ended', 'removing twice is refused');
  assert.equal((await setsOf(item))[0].parts.find((p) => p.member === 'Han').handle, null, 'the part is open in the (secured) set');
  assert.ok(added.json.fixedId);
  // in a set still undecided, the freed part is simply taken by the next claim
  const item2 = await newItem(); const h2 = fresh('rm');
  await addFixed(item2, h2, 'Han');
  await api('DELETE', `/api/admin/fixed/${(await fixedOf(item2))[0].id}`);
  assert.equal((await general(fresh('gen'), item2, 'Han')).json.placements[0].setNumber, 1, 'Set 1 has Han free again');
});

test('removing a fixed claim for a blocked handle forfeits what they paid', async () => {
  const item = await newItem(); const h = fresh('bl'); const c = await member(h);
  await addFixed(item, h, 'Han');
  await api('POST', `/api/admin/sets/${(await setsOf(item))[0].id}/secure`, {});
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 8, reference: 'BL' }, c);
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  await api('POST', '/api/admin/joiners/block', { handle: h, reason: 't' });
  const r = await api('DELETE', `/api/admin/fixed/${(await fixedOf(item))[0].id}`);
  assert.deepEqual([r.json.refunded, r.json.forfeited], [0, 8]);
});

test('the joiner sees their own fixed claims with price, set, and whether a change is instant — and nobody else\'s', async () => {
  const item = await newItem(); const h = fresh('see'); const c = await member(h); const other = await member(fresh('oth'));
  await addFixed(item, h, 'Felix');
  const mine = (await app.api('GET', '/api/my/fixed', undefined, c)).json;
  assert.equal(mine.fixed.length, 1);
  const f = mine.fixed[0];
  assert.deepEqual([f.member, f.price, f.setNumber, f.canChangeNow, f.claimStatus, f.pending, f.wholeSetPrice], ['Felix', 8, 1, true, 'requested', null, 32]);
  assert.match(f.itemTitle, /Fixed test set/);
  assert.deepEqual((await app.api('GET', '/api/my/fixed', undefined, other)).json.fixed, []);
  assert.equal((await app.api('GET', '/api/my/fixed')).status, 401);
});

test('instant "give it up" while the set is not yet secured: gone at once, the part reopens', async () => {
  const item = await newItem(); const h = fresh('gu'); const c = await member(h);
  await addFixed(item, h, 'Han');
  const f = (await app.api('GET', '/api/my/fixed', undefined, c)).json.fixed[0];
  const r = await app.api('POST', `/api/my/fixed/${f.id}/change`, { action: 'giveup' }, c);
  assert.deepEqual([r.status, r.json.instant, r.json.action, r.json.slotOpened], [200, true, 'giveup', true]);
  assert.deepEqual((await app.api('GET', '/api/my/fixed', undefined, c)).json.fixed, []);
  assert.equal((await claimsOf(h))[0].status, 'cancelled');
  assert.equal((await setsOf(item))[0].filled, 0);
  assert.equal((await app.api('POST', `/api/my/fixed/${f.id}/change`, { action: 'giveup' }, c)).status, 404, 'already gone');
});

test('instant swap to the full set: lands in the very set they were fixed in when it can, so their slot is theirs again', async () => {
  const item = await newItem(); const h = fresh('ot'); const c = await member(h);
  await addFixed(item, h, 'Han');
  const f = (await app.api('GET', '/api/my/fixed', undefined, c)).json.fixed[0];
  const r = await app.api('POST', `/api/my/fixed/${f.id}/change`, { action: 'ot8' }, c);
  assert.deepEqual([r.status, r.json.instant, r.json.setNumber, r.json.slotOpened], [200, true, 1, false]);
  const rows = await claimsOf(h);
  assert.equal(rows.filter((x) => x.status !== 'cancelled').length, 4, 'one of every part');
  assert.ok(rows.filter((x) => x.status !== 'cancelled').every((x) => !x.is_fixed && x.status === 'requested'), 'the new claims are ordinary ones');
  assert.deepEqual((await setsOf(item))[0].parts.map((p) => p.handle), [h, h, h, h]);
  assert.deepEqual((await app.api('GET', '/api/my/fixed', undefined, c)).json.fixed, [], 'the fixed claim has ended');
});

test('swap to the full set when their old set cannot take it: it goes to the next set where every part is free, and their old slot opens', async () => {
  const item = await newItem(); const h = fresh('ot2'); const c = await member(h);
  await addFixed(item, h, 'Han');
  await general(fresh('blocker'), item, 'Felix');                                                  // Set 1 now has Felix taken, so no whole set fits there
  const f = (await app.api('GET', '/api/my/fixed', undefined, c)).json.fixed[0];
  const r = await app.api('POST', `/api/my/fixed/${f.id}/change`, { action: 'ot8' }, c);
  assert.deepEqual([r.json.setNumber, r.json.slotOpened], [2, true]);
  assert.equal((await setsOf(item))[0].parts.find((p) => p.member === 'Han').handle, null);
});

test('once the set is SECURED a change becomes a request: it waits, can be withdrawn and re-sent, and cannot be doubled', async () => {
  const item = await newItem(); const h = fresh('rq'); const c = await member(h);
  await addFixed(item, h, 'Han');
  await api('POST', `/api/admin/sets/${(await setsOf(item))[0].id}/secure`, {});
  const f = () => app.api('GET', '/api/my/fixed', undefined, c).then((r) => r.json.fixed[0]);
  assert.equal((await f()).canChangeNow, false);
  const r = await app.api('POST', `/api/my/fixed/${(await f()).id}/change`, { action: 'ot8' }, c);
  assert.deepEqual([r.status, r.json.instant], [202, false]);
  assert.equal((await claimsOf(h))[0].status, 'confirmed', 'nothing changed yet');
  assert.deepEqual([(await f()).pending.action, (await f()).pending.id], ['ot8', r.json.requestId]);
  assert.equal((await app.api('POST', `/api/my/fixed/${(await f()).id}/change`, { action: 'giveup' }, c)).json.code, 'request_pending');
  assert.equal((await api('GET', '/api/admin/fixed-requests')).json.requests.some((x) => x.handle === h && x.action === 'ot8'), true);
  assert.equal((await app.api('POST', `/api/my/fixed/requests/${r.json.requestId}/withdraw`, {}, c)).status, 200);
  assert.equal((await f()).pending, null);
  assert.equal((await app.api('POST', `/api/my/fixed/requests/${r.json.requestId}/withdraw`, {}, c)).status, 404, 'already withdrawn');
  assert.equal((await app.api('POST', `/api/my/fixed/${(await f()).id}/change`, { action: 'giveup' }, c)).status, 202, 'a fresh request is allowed');
  const hist = (await app.api('GET', '/api/my/fixed', undefined, c)).json.requests;
  assert.deepEqual(hist.map((x) => x.status), ['pending', 'withdrawn']);
});

test('the GOM approves: a give-up cancels the claim and returns what was paid as credit; a swap places the full set in a new set', async () => {
  const item = await newItem(); const a = fresh('ap'), b = fresh('ap'); const ca = await member(a), cb = await member(b);
  await addFixed(item, a, 'Han'); await addFixed(item, b, 'Felix');
  await api('POST', `/api/admin/sets/${(await setsOf(item))[0].id}/secure`, {});
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 8, reference: 'AP' }, ca);
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  const fa = (await app.api('GET', '/api/my/fixed', undefined, ca)).json.fixed[0], fb = (await app.api('GET', '/api/my/fixed', undefined, cb)).json.fixed[0];
  const ra = (await app.api('POST', `/api/my/fixed/${fa.id}/change`, { action: 'giveup' }, ca)).json.requestId;
  const rb = (await app.api('POST', `/api/my/fixed/${fb.id}/change`, { action: 'ot8' }, cb)).json.requestId;

  const ok = await api('POST', `/api/admin/fixed-requests/${ra}/approve`, {});
  assert.deepEqual([ok.status, ok.json.action, ok.json.refunded], [200, 'giveup', 8]);
  assert.equal((await app.api('GET', '/api/my/summary', undefined, ca)).json.credit, 8);
  assert.equal((await claimsOf(a))[0].status, 'cancelled');
  const ok2 = await api('POST', `/api/admin/fixed-requests/${rb}/approve`, {});
  assert.equal(ok2.json.setNumber, 2, 'the secured Set 1 takes no new claims, so the full set goes to a new Set 2');
  assert.equal((await claimsOf(b)).filter((x) => x.status !== 'cancelled' && !x.is_fixed).length, 4);
  assert.equal((await api('POST', `/api/admin/fixed-requests/${ra}/approve`, {})).json.code, 'not_pending', 'approving twice does the work once');
  assert.deepEqual((await app.api('GET', '/api/my/fixed', undefined, ca)).json.requests.map((x) => x.status), ['approved']);
});

test('declining leaves everything as it was; approving a request whose fixed claim has already ended is marked void', async () => {
  const item = await newItem(); const h = fresh('dc'); const c = await member(h);
  await addFixed(item, h, 'Han');
  await api('POST', `/api/admin/sets/${(await setsOf(item))[0].id}/secure`, {});
  const f = (await app.api('GET', '/api/my/fixed', undefined, c)).json.fixed[0];
  const r1 = (await app.api('POST', `/api/my/fixed/${f.id}/change`, { action: 'giveup' }, c)).json.requestId;
  assert.equal((await api('POST', `/api/admin/fixed-requests/${r1}/decline`, {})).status, 200);
  assert.equal((await claimsOf(h))[0].status, 'confirmed');
  const r2 = (await app.api('POST', `/api/my/fixed/${f.id}/change`, { action: 'giveup' }, c)).json.requestId;
  await api('DELETE', `/api/admin/fixed/${f.id}`);                                              // the GOM removed it meanwhile
  const v = await api('POST', `/api/admin/fixed-requests/${r2}/approve`, {});
  assert.deepEqual([v.status, v.json.voided], [200, true]);
  assert.deepEqual((await app.api('GET', '/api/my/fixed', undefined, c)).json.requests.map((x) => x.status), ['void', 'declined']);
});

test('nobody can change someone else\'s fixed claim, and the request controls are the GOM only', async () => {
  const item = await newItem(); const h = fresh('own'); await member(h); const intruder = await member(fresh('int'));
  await addFixed(item, h, 'Han');
  const fx = (await fixedOf(item))[0];
  assert.equal((await app.api('POST', `/api/my/fixed/${fx.id}/change`, { action: 'giveup' }, intruder)).status, 404);
  assert.equal((await app.api('POST', `/api/my/fixed/${fx.id}/change`, { action: 'nonsense' }, intruder)).status, 400);
  for (const [m, p, b] of [['GET', '/api/admin/fixed-requests'], ['POST', '/api/admin/fixed-requests/1/approve', {}], ['POST', '/api/admin/fixed-requests/1/decline', {}], ['DELETE', `/api/admin/fixed/${fx.id}`], ['POST', `/api/admin/items/${item}/fixed/copy`, { fromItemId: 1 }]]) {
    assert.equal((await api(m, p, b, intruder)).status, 403, p);
  }
  assert.equal((await api('POST', '/api/admin/fixed-requests/999999/approve', {})).status, 404);
});

test('copy from another comeback: same people, same members — skipping parts the new item lacks, blocked handles and duplicates', async () => {
  const from = await newItem('Copy source', ROSTER), to = await newItem('Copy target', ROSTER.slice(0, 3));
  await addFixed(from, 'cp_a', 'Bang Chan'); await addFixed(from, 'cp_b', 'Hyunjin'); await addFixed(from, 'cp_c', 'Han'); await addFixed(from, 'cp_blk', 'Felix');
  await api('POST', '/api/admin/joiners/block', { handle: 'cp_blk', reason: 't' });
  await addFixed(to, 'cp_c', 'Han');                                                                 // already there
  const r = await api('POST', `/api/admin/items/${to}/fixed/copy`, { fromItemId: from });
  assert.equal(r.status, 200);
  assert.equal(r.json.added, 1, 'only Bang Chan for cp_a is new');
  assert.equal(r.json.skipped.length, 3);
  assert.ok(r.json.skipped.some((x) => /cp_b.*Hyunjin.*isn't part of/.test(x)));
  assert.ok(r.json.skipped.some((x) => /cp_c.*Han.*already have a fixed claim/.test(x)));
  assert.ok(r.json.skipped.some((x) => /cp_blk.*blocked/.test(x)));
  assert.equal((await api('POST', `/api/admin/items/${to}/fixed/copy`, { fromItemId: to })).status, 400);
  assert.equal((await api('POST', `/api/admin/items/${w.keyring}/fixed/copy`, { fromItemId: from })).json.code, 'not_a_set');
});

test('STRESS: 10 fixed claims on the same member added at the same instant each get their own set', async () => {
  const item = await newItem();
  const rs = await Promise.all(Array.from({ length: 10 }, () => addFixed(item, fresh('cc'), 'Han')));
  assert.ok(rs.every((r) => r.status === 201), `all accepted (${[...new Set(rs.map((r) => r.status))]})`);
  assert.deepEqual(rs.map((r) => r.json.setNumber).sort((x, y) => x - y), Array.from({ length: 10 }, (_, i) => i + 1));
});

test('STRESS: the GOM approving the same request twice at once does the work exactly once', async () => {
  const item = await newItem(); const h = fresh('dbl'); const c = await member(h);
  await addFixed(item, h, 'Han');
  await api('POST', `/api/admin/sets/${(await setsOf(item))[0].id}/secure`, {});
  const f = (await app.api('GET', '/api/my/fixed', undefined, c)).json.fixed[0];
  const rid = (await app.api('POST', `/api/my/fixed/${f.id}/change`, { action: 'ot8' }, c)).json.requestId;
  const rs = await Promise.all(Array.from({ length: 5 }, () => api('POST', `/api/admin/fixed-requests/${rid}/approve`, {})));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409, 409, 409]);
  assert.equal((await claimsOf(h)).filter((x) => x.status !== 'cancelled' && !x.is_fixed).length, 4, 'one full set, not five');
});

test('INVARIANTS: no part held twice, every active fixed claim has its reserved slot and claim, ended ones hold nothing', async () => {
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM (SELECT set_id, member_name FROM set_slots GROUP BY set_id, member_name HAVING COUNT(*) > 1) x'))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM fixed_claims f LEFT JOIN set_slots sl ON sl.set_id = f.set_id AND sl.member_name = f.member_name AND sl.joiner_id = f.joiner_id AND sl.is_fixed = 1 WHERE f.ended_at IS NULL AND sl.id IS NULL'))[0].n, 0, 'every active fixed claim holds its reserved slot');
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM fixed_claims f JOIN set_slots sl ON sl.set_id = f.set_id AND sl.member_name = f.member_name AND sl.joiner_id = f.joiner_id AND sl.is_fixed = 1 WHERE f.ended_at IS NOT NULL"))[0].n, 0, 'an ended fixed claim holds no slot');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost'))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM set_slots sl LEFT JOIN claims c ON c.slot_id = sl.id WHERE c.id IS NULL'))[0].n, 0);
});
