import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { round2 } from '../src/lib/money.js';

const READY = 'ready to pack / on hand';
let app, admin, w;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const post = (path, body, cookie = admin) => app.api('POST', path, body, cookie);
const summary = async (c) => (await app.api('GET', '/api/my/summary', undefined, c)).json;
const ledger = async (handle) => (await app.api('GET', `/api/admin/ledger?handle=${handle}`, undefined, admin)).json.entries;
const payIn = async (c, amount, ref = 'P') => { const p = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount, reference: ref }, c); await post(`/api/admin/payments/${p.json.id}/verify`, {}); };
const claimRow = async (id) => (await app.q('SELECT status, slot_id FROM claims WHERE id = ?', [id]))[0];
const paidOn = async (id) => Number((await app.q('SELECT COALESCE(SUM(paid),0) AS s FROM claim_costs WHERE claim_id = ?', [id]))[0].s);

test('cancelling a paid claim returns everything paid as credit', async () => {
  const c = await joinerSession(app, 'c1@x.com', 'c1');
  const [id] = await claimAndSecure(app, admin, 'c1', w.album);                       // £26
  await app.api('PATCH', `/api/admin/claims/${id}`, { costs: { ems: { cost: 4 } } }, admin);
  await payIn(c, 30);                                                                 // initials 26 + ems 4
  assert.equal((await summary(c)).owed.total, 0);

  assert.equal((await app.api('PATCH', `/api/admin/claims/${id}`, { status: 'cancelled' }, admin)).status, 200);
  assert.equal((await claimRow(id)).status, 'cancelled');
  assert.equal(await paidOn(id), 0, 'nothing is left counted as paid on a cancelled claim');
  const s = await summary(c);
  assert.equal(s.credit, 30, 'all £30 comes back as credit');
  assert.equal(s.owed.total, 0, 'and a cancelled claim is not owed');
  const l = (await ledger('c1')).find((e) => e.kind === 'credit');
  assert.equal(l.amount, 30);
  assert.match(l.reason, /Cancelled by the GOM: "Album"/);
});

test('an unpaid claim cancels with nothing to return, and cancelling twice is harmless', async () => {
  const c = await joinerSession(app, 'c2@x.com', 'c2');
  const [id] = await claimAndSecure(app, admin, 'c2', w.keyring);
  assert.equal((await app.api('PATCH', `/api/admin/claims/${id}`, { status: 'cancelled' }, admin)).status, 200);
  assert.equal((await app.api('PATCH', `/api/admin/claims/${id}`, { status: 'cancelled' }, admin)).status, 200);
  assert.equal((await summary(c)).credit, 0);
  assert.equal((await ledger('c2')).length, 0);
  assert.equal((await summary(c)).orders.length, 0, 'a cancelled claim disappears from their orders');
});

test('returned credit is put to work straight away on anything else they owe', async () => {
  const c = await joinerSession(app, 'c3@x.com', 'c3');
  const [a] = await claimAndSecure(app, admin, 'c3', w.album);                        // £26, paid
  await payIn(c, 26);
  await claimAndSecure(app, admin, 'c3', w.keyring);                                  // £6 owed
  await app.api('PATCH', `/api/admin/claims/${a}`, { status: 'cancelled' }, admin);   // £26 back -> £6 settles the keyring
  const s = await summary(c);
  assert.equal(s.owed.total, 0);
  assert.equal(s.credit, 20);
});

test('bulk cancel (e.g. a whole set that will not proceed) returns each person their own money', async () => {
  const names = ['b1', 'b2', 'b3'];
  const ids = []; const cookies = {};
  for (const [i, h] of names.entries()) {
    cookies[h] = await joinerSession(app, `${h}@x.com`, h);
    const [id] = await claimAndSecure(app, admin, h, w.album);
    if (i < 2) await payIn(cookies[h], 26);                                           // b3 never paid
    ids.push(id);
  }
  const r = await post('/api/admin/claims/cancel', { claimIds: ids, reason: 'Set did not fill' });
  assert.deepEqual([r.json.cancelled, r.json.refunded, r.json.forfeited], [3, 52, 0]);
  assert.deepEqual([(await summary(cookies.b1)).credit, (await summary(cookies.b2)).credit, (await summary(cookies.b3)).credit], [26, 26, 0]);
  assert.match((await ledger('b1'))[0].reason, /Set did not fill/);
  assert.equal((await post('/api/admin/claims/cancel', { claimIds: ids })).json.cancelled, 0, 'running it again changes nothing');
});

test('an item already in a parcel cannot be cancelled until the parcel is dealt with', async () => {
  const c = await joinerSession(app, 'c4@x.com', 'c4');
  await app.api('PUT', '/api/my/address', { fullName: 'C Four', address: '1 Road, Leeds', email: 'c4@x.com', phone: '0700' }, c);
  const [id] = await claimAndSecure(app, admin, 'c4', w.keyring);
  await app.api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }, admin);
  const p = (await app.api('POST', '/api/my/parcels', { claimIds: [id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, c)).json;
  const r = await app.api('PATCH', `/api/admin/claims/${id}`, { status: 'cancelled' }, admin);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'in_parcel');
  assert.equal((await claimRow(id)).status, 'confirmed', 'rolled back completely');
  await post(`/api/admin/parcels/${p.id}/cancel`, {});
  assert.equal((await app.api('PATCH', `/api/admin/claims/${id}`, { status: 'cancelled' }, admin)).status, 200);
});

test('BLOCKED handle: a cancelled claim is NOT credited — it is recorded as forfeited', async () => {
  const c = await joinerSession(app, 'bl1@x.com', 'bl1');
  const [id] = await claimAndSecure(app, admin, 'bl1', w.album);
  await payIn(c, 26);
  assert.equal((await post('/api/admin/joiners/block', { handle: '@BL1', reason: 'Abandoned order, deleted account, unreachable' })).status, 200);
  const tipsBefore = (await app.api('GET', '/api/admin/ledger', undefined, admin)).json.tipsTotal;

  await app.api('PATCH', `/api/admin/claims/${id}`, { status: 'cancelled' }, admin);
  const s = await summary(c);
  assert.equal(s.credit, 0, 'no credit for a blocked handle');
  const entries = await ledger('bl1');
  const f = entries.find((e) => e.kind === 'forfeited');
  assert.equal(f.amount, 26);
  assert.equal(f.balanceEffect, 0);
  assert.match(f.reason, /blocked/);
  assert.equal(entries.filter((e) => e.kind === 'credit').length, 0);
  const tipsAfter = (await app.api('GET', '/api/admin/ledger', undefined, admin)).json.tipsTotal;
  assert.equal(tipsAfter, tipsBefore, 'forfeited money is kept separate — it is never counted as tips');
});

test('blocked handles cannot place new claims — and nothing is created for them', async () => {
  await post('/api/admin/joiners/block', { handle: 'never_ordered', reason: 'Known problem buyer' });   // blocked in advance
  const r = await app.api('POST', '/api/claims', { handle: '@Never_Ordered', lines: [{ itemId: w.keyring }] });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'handle_blocked');
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = 'never_ordered'"))[0].n, 0);
  assert.equal((await app.api('POST', '/api/claims', { handle: 'fine_person', lines: [{ itemId: w.keyring }] })).status, 201, 'everyone else is unaffected');
});

test('unblocking restores normal behaviour; forfeited money can be put back by hand if they turn up', async () => {
  const c = await joinerSession(app, 'bl2@x.com', 'bl2');
  const [first] = await claimAndSecure(app, admin, 'bl2', w.album);
  await payIn(c, 26);
  await post('/api/admin/joiners/block', { handle: 'bl2', reason: 'unreachable' });
  await app.api('PATCH', `/api/admin/claims/${first}`, { status: 'cancelled' }, admin);
  assert.equal((await summary(c)).credit, 0);

  // they turn up: unblock, and give back what was forfeited
  assert.equal((await post('/api/admin/joiners/unblock', { handle: 'bl2' })).status, 200);
  assert.equal((await post('/api/admin/credit/add', { handle: 'bl2', amount: 26, reason: 'Restoring forfeited payment — they got in touch' })).status, 200);
  assert.equal((await summary(c)).credit, 26);
  assert.equal((await app.api('POST', '/api/claims', { handle: 'bl2', lines: [{ itemId: w.keyring }] })).status, 201, 'can claim again');

  // and from now on cancellations credit normally
  const [second] = await claimAndSecure(app, admin, 'bl2', w.hoodie, { variant: 'M' });
  await app.api('PATCH', `/api/admin/claims/${second}`, { status: 'cancelled' }, admin);
  assert.ok((await ledger('bl2')).some((e) => e.kind === 'credit' && /Cancelled by the GOM/.test(e.reason)));
});

test('block / unblock / bulk cancel / goodwill credit are the GOM only', async () => {
  const c = await joinerSession(app, 'nope@x.com', 'nope_h');
  for (const [path, body] of [['/api/admin/joiners/block', { handle: 'x', reason: 'r' }], ['/api/admin/joiners/unblock', { handle: 'x' }],
    ['/api/admin/claims/cancel', { claimIds: [1] }], ['/api/admin/credit/add', { handle: 'x', amount: 1, reason: 'r' }]]) {
    assert.equal((await app.api('POST', path, body, c)).status, 403, path);
  }
  assert.equal((await app.api('GET', '/api/admin/joiners/flagged', undefined, c)).status, 403);
  assert.equal((await post('/api/admin/joiners/block', { handle: 'x' })).status, 400, 'a reason is required, so future-you remembers why');
  assert.equal((await post('/api/admin/credit/add', { handle: 'no_such_handle', amount: 5, reason: 'r' })).status, 404);
});

test('deleting an account removes the login and personal details but keeps the order history', async () => {
  const c = await joinerSession(app, 'del1@x.com', 'del1');
  await app.api('PUT', '/api/my/address', { fullName: 'Del One', address: '1 Road, Leeds', email: 'del1@x.com', phone: '0700' }, c);
  const [id] = await claimAndSecure(app, admin, 'del1', w.album);                      // owes £26 and never pays

  assert.equal((await app.api('DELETE', '/api/me', {}, c)).status, 400, 'must confirm');
  const r = await app.api('DELETE', '/api/me', { confirm: true }, c);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.handles, ['del1']);

  assert.equal((await app.api('GET', '/api/me', undefined, c)).status, 401, 'the session is gone');
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM accounts WHERE email = 'del1@x.com'"))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM addresses a JOIN joiners j ON j.id = a.joiner_id WHERE j.instagram_handle = ?', ['del1']))[0].n, 0, 'address and phone are erased');
  assert.equal((await claimRow(id)).status, 'confirmed', 'but the order record stays — it is your financial record');
  const j = (await app.q('SELECT account_id, account_deleted_at FROM joiners WHERE instagram_handle = ?', ['del1']))[0];
  assert.equal(j.account_id, null);
  assert.ok(j.account_deleted_at);
});

test('a deleted account that still owes money appears on the GOM\'s flagged list with the amounts', async () => {
  const c = await joinerSession(app, 'del2@x.com', 'del2');
  await claimAndSecure(app, admin, 'del2', w.album);                                   // owes £26
  const paidOne = await joinerSession(app, 'del3@x.com', 'del3');
  await claimAndSecure(app, admin, 'del3', w.keyring); await payIn(paidOne, 6);        // paid up, holds an item
  await post('/api/admin/joiners/block', { handle: 'flag_blocked', reason: 'chargeback' });
  await app.api('DELETE', '/api/me', { confirm: true }, c);
  await app.api('DELETE', '/api/me', { confirm: true }, paidOne);

  const f = (await app.api('GET', '/api/admin/joiners/flagged', undefined, admin)).json.joiners;
  const by = Object.fromEntries(f.map((x) => [x.handle, x]));
  assert.equal(by.del2.owed, 26);
  assert.ok(by.del2.accountDeletedAt);
  assert.equal(by.del2.openClaims, 1);
  assert.equal(by.del3.owed, 0, 'paid-up leavers are flagged too (they still hold an item) but owe nothing');
  assert.equal(by.flag_blocked.blocked, true);
  assert.equal(by.flag_blocked.blockedReason, 'chargeback');
  assert.ok(!by.fine_person, 'ordinary people are not on the list');
});

test('a person with a parcel on its way cannot delete their account yet', async () => {
  const c = await joinerSession(app, 'del4@x.com', 'del4');
  await app.api('PUT', '/api/my/address', { fullName: 'Del Four', address: '1 Road, Leeds', email: 'del4@x.com', phone: '0700' }, c);
  const [id] = await claimAndSecure(app, admin, 'del4', w.keyring);
  await app.api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }, admin);
  await app.api('POST', '/api/my/parcels', { claimIds: [id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, c);
  const r = await app.api('DELETE', '/api/me', { confirm: true }, c);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'parcel_in_progress');
  assert.equal((await app.api('GET', '/api/me', undefined, c)).status, 200, 'nothing was deleted');
  assert.ok((await app.q("SELECT COUNT(*) AS n FROM addresses a JOIN joiners j ON j.id = a.joiner_id WHERE j.instagram_handle = 'del4'"))[0].n === 1);
});

test('someone who deleted their account can return only with the GOM\'s say-so, which clears the flag', async () => {
  const old = await joinerSession(app, 'back1@x.com', 'back1');
  await claimAndSecure(app, admin, 'back1', w.album);
  await app.api('DELETE', '/api/me', { confirm: true }, old);

  const again = await app.login('back1.new@x.com');
  const r = await app.api('POST', '/api/me/handles', { handle: 'back1' }, again);
  assert.equal(r.status, 202, 'the handle has orders on it, so it needs approval — it is not just handed over');
  assert.equal((await app.api('GET', '/api/my/summary', undefined, again)).status, 403);
  const req = (await app.api('GET', '/api/admin/handle-requests', undefined, admin)).json.requests.find((x) => x.handle === 'back1');
  await post(`/api/admin/handle-requests/${req.id}/approve`, {});
  assert.equal((await summary(again)).owed.total, 26, 'their old debt is still there');
  assert.equal((await app.q("SELECT account_deleted_at AS d FROM joiners WHERE instagram_handle = 'back1'"))[0].d, null, 'no longer flagged');
});

test('STRESS: cancelling many paid claims for the same people at once never deadlocks or loses a penny', async () => {
  const people = Array.from({ length: 8 }, (_, i) => `cs${i}`);
  const all = [];
  for (const h of people) {
    const c = await joinerSession(app, `${h}@x.com`, h);
    const ids = (await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: w.keyring, qty: 3 }] })).json.claimIds;
    await post('/api/admin/claims/secure', { claimIds: ids });
    await payIn(c, 18);                                                              // all three £6 keyrings paid
    all.push(...ids.map((id) => ({ h, id })));
  }
  const results = await Promise.all(all.map(({ id }) => app.api('PATCH', `/api/admin/claims/${id}`, { status: 'cancelled' }, admin)));
  assert.ok(results.every((r) => r.status === 200), `no request failed (${[...new Set(results.map((r) => r.status))]})`);
  for (const h of people) {
    const bal = Number((await app.q('SELECT COALESCE(SUM(balance_effect),0) AS b FROM credit_ledger l JOIN joiners j ON j.id = l.joiner_id WHERE j.instagram_handle = ?', [h]))[0].b);
    assert.equal(bal, 18, `${h}: all £18 back, exactly once`);
  }
});

test('INVARIANTS after all of the above', async () => {
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost OR paid < 0'))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM claim_costs cc JOIN claims c ON c.id = cc.claim_id WHERE c.status = 'cancelled' AND cc.paid <> 0"))[0].n, 0, 'cancelled claims hold no money');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM (SELECT joiner_id FROM credit_ledger GROUP BY joiner_id HAVING SUM(balance_effect) < 0) x'))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM credit_ledger WHERE kind = 'forfeited' AND balance_effect <> 0"))[0].n, 0, 'forfeited entries never touch a balance');
});
