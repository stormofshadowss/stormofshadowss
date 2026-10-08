import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

const READY = 'ready to pack / on hand';
let app, admin, w, N = 0, ITEM;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const go = (await app.api('POST', '/api/admin/orders', { groupId: w.group, title: 'Cancel GO' }, admin)).json.id;
  const mk = async (title, price) => (await app.api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price }, admin)).json.id;
  ITEM = { twenty: await mk('Twenty thing', 20), ten: await mk('Ten thing', 10) };
});
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (p = 'cr') => `${p}${++N}`;
const settle = () => app.notifier.idle();
// a signed-in person with a confirmed item at a given stage, who may have paid something towards it
async function person({ stage = 'ordered via proxy / warehouse', pay = 0, item = ITEM.twenty, handle = u() } = {}) {
  const cookie = await joinerSession(app, `${handle}@x.com`, handle);
  const [id] = await claimAndSecure(app, admin, handle, item);
  if (stage) await api('PATCH', `/api/admin/claims/${id}`, { pipeline: stage });
  if (pay) { const p = await api('POST', '/api/my/payments', { method: 'PayPal', amount: pay, reference: `R-${handle}` }, cookie); await api('POST', `/api/admin/payments/${p.json.id}/verify`, {}); }
  return { handle, cookie, id };
}
const ask = (p, body = {}, id = p.id) => api('POST', `/api/my/claims/${id}/cancel-request`, body, p.cookie);
const approve = (id, body = {}) => api('POST', `/api/admin/cancel-requests/${id}/approve`, body);
const decline = (id, body = {}) => api('POST', `/api/admin/cancel-requests/${id}/decline`, body);
const pending = async () => (await api('GET', '/api/admin/cancel-requests')).json.requests;
const decided = async () => (await api('GET', '/api/admin/cancel-requests?status=decided')).json.requests;
const summary = async (p) => (await api('GET', '/api/my/summary', undefined, p.cookie)).json;
const claimRow = async (id) => (await app.q('SELECT status, pipeline FROM claims WHERE id = ?', [id]))[0];
const credit = async (p) => (await summary(p)).credit;
const req = async (id) => (await app.q('SELECT * FROM cancel_requests WHERE id = ?', [id]))[0];

test('ASKING: a confirmed item, even one not yet ordered, can be asked about; nothing changes until the GOM answers; the GOM sees the details', async () => {
  const p = await person({ stage: 'ordered via proxy / warehouse', pay: 12 });
  const r = await ask(p, { reason: '  Changed my mind about it  ' });
  assert.equal(r.status, 201);
  assert.deepEqual(await claimRow(p.id), { status: 'confirmed', pipeline: 'ordered via proxy / warehouse' }, 'nothing has been cancelled');
  const mine = (await summary(p)).orders.flatMap((o) => o.claims).find((c) => c.id === p.id);
  assert.deepEqual([mine.cancelRequest.status, mine.cancelRequest.reason, mine.cancelRequest.id], ['pending', 'Changed my mind about it', r.json.id]);
  const row = (await pending()).find((x) => x.id === r.json.id);
  assert.deepEqual([row.handle, row.label, row.stage, row.pipeline, row.paid, row.cost, row.reason, row.orderTitle, row.problem], [p.handle, 'Twenty thing', 'ordered via proxy / warehouse', 'ordered via proxy / warehouse', 12, 20, 'Changed my mind about it', 'Cancel GO', null]);
  const again = await ask(p); assert.equal(again.status, 409); assert.equal(again.json.code, 'already_requested');
  const early = await person({ stage: 'awaiting fulfillment' });
  assert.equal((await ask(early)).status, 201, 'before it has even been ordered is fine');
});

test('who can ask, and for what: only your own items — not cancelled or received ones, fixed claims, or items in a parcel (and never someone else\'s)', async () => {
  const [a, b] = [await person(), await person()];
  const forbidden = await ask(a, {}, b.id); assert.equal(forbidden.status, 403);
  assert.equal((await api('POST', '/api/my/claims/999999/cancel-request', {}, a.cookie)).status, 403);
  assert.equal((await app.api('POST', `/api/my/claims/${a.id}/cancel-request`, {})).status, 401);
  // already received
  const done = await person({ stage: 'completed' });
  const r2 = await ask(done); assert.deepEqual([r2.status, r2.json.code], [409, 'already_received']);
  // already cancelled
  const gone = await person(); await api('PATCH', `/api/admin/claims/${gone.id}`, { status: 'cancelled' });
  assert.equal((await ask(gone)).json.code, 'already_cancelled');
  // in a parcel
  const parcel = await person({ stage: READY }); await api('PUT', '/api/my/address', { fullName: 'Pat Kay', address: '1 Test Road, Leeds', email: 'p@x.com', phone: '0700' }, parcel.cookie);
  await api('POST', '/api/my/parcels', { claimIds: [parcel.id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, parcel.cookie);
  const r3 = await ask(parcel); assert.deepEqual([r3.status, r3.json.code], [409, 'in_parcel']); assert.match(r3.json.error, /Ask the GOM to take it out first/);
  // too long a reason
  assert.equal((await ask(a, { reason: 'x'.repeat(501) })).status, 400);
});

test('a set part can be asked about; approving frees the part for someone else. Shop items too.', async () => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Set GO ${++N}` })).json.id;
  const set = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: `Set ${N}`, price: 4, members: ['A', 'B'] })).json.id;
  const [h1, h2] = [u(), u()]; const c1 = await joinerSession(app, `${h1}@x.com`, h1);
  await app.api('POST', '/api/claims', { handle: h1, lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] });
  await app.api('POST', '/api/claims', { handle: h2, lines: [{ itemId: set, parts: [{ member: 'B', qty: 1 }] }] });
  const sid = (await api('GET', '/api/admin/sets')).json.sets.find((s) => s.itemId === set).id;
  await api('POST', `/api/admin/sets/${sid}/secure`, {});
  const claim = (await api('GET', `/api/admin/claims?handle=${h1}`)).json.claims[0];
  const r = await api('POST', `/api/my/claims/${claim.id}/cancel-request`, {}, c1);
  assert.equal(r.status, 201);
  const row = (await pending()).find((x) => x.id === r.json.id);
  assert.equal(row.setPart, true);
  assert.equal((await approve(r.json.id)).status, 200);
  assert.equal((await api('GET', '/api/admin/sets')).json.sets.find((s) => s.id === sid).parts.find((p) => p.member === 'A').handle, null, 'the part is free again');
  // shop stock
  const shop = (await api('POST', '/api/admin/shop', { title: `Shop thing ${N}`, price: 3, qty: 2 })).json.id;
  const h3 = u(); const c3 = await joinerSession(app, `${h3}@x.com`, h3);
  await app.api('POST', '/api/claims', { handle: h3, lines: [{ leftoverId: shop }] });
  const sc = (await api('GET', `/api/admin/claims?handle=${h3}`)).json.claims[0];
  const r2 = await api('POST', `/api/my/claims/${sc.id}/cancel-request`, {}, c3);
  assert.equal(r2.status, 201);
  await approve(r2.json.id);
  assert.equal((await app.api('GET', '/api/shop')).json.items.find((i) => i.id === shop).left, 2, 'the stock is back');
});

test('WITHDRAWING: only your own, only while pending; you can ask again afterwards', async () => {
  const [a, b] = [await person(), await person()];
  const r = await ask(a);
  assert.equal((await api('DELETE', `/api/my/cancel-requests/${r.json.id}`, undefined, b.cookie)).status, 404, 'not someone else\'s');
  assert.equal((await api('DELETE', `/api/my/cancel-requests/${r.json.id}`, undefined, a.cookie)).status, 200);
  assert.equal((await req(r.json.id)).status, 'withdrawn');
  assert.equal((await pending()).some((x) => x.id === r.json.id), false);
  assert.equal((await api('DELETE', `/api/my/cancel-requests/${r.json.id}`, undefined, a.cookie)).json.code, 'bad_state');
  assert.equal((await summary(a)).orders[0].claims[0].cancelRequest, null, 'a withdrawn request shows nothing');
  assert.equal((await ask(a)).status, 201, 'and they can ask again');
  assert.equal((await approve(r.json.id)).json.code, 'bad_state', 'a withdrawn request cannot be approved');
});

test('APPROVING WITH A FEE: what was paid, less the fee you keep, goes back as credit; the fee is recorded as kept; the item is cancelled', async () => {
  const p = await person({ pay: 15 });                                    // £15 of a £20 item
  const r = await ask(p, { reason: 'no longer want' });
  const before = await credit(p);
  const ok = await approve(r.json.id, { keep: 5, note: 'Proxy order was already placed, so a fee applies.' });
  assert.equal(ok.status, 200); assert.deepEqual([ok.json.refunded, ok.json.kept, ok.json.forfeited], [10, 5, 0]);
  assert.equal(Math.round((await credit(p) - before) * 100) / 100, 10, '£10 came back as credit');
  assert.equal((await claimRow(p.id)).status, 'cancelled');
  const row = await req(r.json.id);
  assert.deepEqual([row.status, Number(row.paid_at_decision), Number(row.kept), Number(row.refunded), row.decision_note, row.open_flag], ['approved', 15, 5, 10, 'Proxy order was already placed, so a fee applies.', null]);
  const ledger = await app.q("SELECT kind, amount, balance_effect, reason FROM credit_ledger WHERE claim_id = ? ORDER BY id", [p.id]);
  assert.deepEqual(ledger.map((l) => [l.kind, Number(l.amount), Number(l.balance_effect)]), [['forfeited', 5, 0], ['credit', 10, 10]], 'the fee kept (no effect on their balance) and the credit returned');
  assert.match(ledger.find((l) => l.kind === 'forfeited').reason, /Cancellation fee kept/);
  assert.equal((await summary(p)).orders.flatMap((o) => o.claims).some((c) => c.id === p.id), false, 'it is gone from their list');
  const d = (await decided()).find((x) => x.id === r.json.id);
  assert.deepEqual([d.status, d.kept, d.refunded, d.handle], ['approved', 5, 10, p.handle]);
  assert.equal((await approve(r.json.id)).json.code, 'bad_state');
});

test('approving with no fee (the default) returns everything paid; an unpaid item just cancels', async () => {
  const p = await person({ pay: 20 }); const r = await ask(p);
  const ok = await approve(r.json.id);
  assert.deepEqual([ok.json.refunded, ok.json.kept], [20, 0]);
  assert.equal(await credit(p), 20);
  assert.equal((await req(r.json.id)).decision_note, '', 'no message recorded when none is given');
  const q = await person(); const r2 = await ask(q);
  const ok2 = await approve(r2.json.id);
  assert.deepEqual([ok2.status, ok2.json.refunded, ok2.json.kept], [200, 0, 0]);
});

test('the fee can never be more than was paid — and a refused approval changes nothing at all', async () => {
  const p = await person({ pay: 8 }); const r = await ask(p);
  const too = await approve(r.json.id, { keep: 9 });
  assert.equal(too.status, 400); assert.equal(too.json.code, 'keep_too_much'); assert.match(too.json.error, /only paid £8\.00.*can't keep £9\.00/);
  assert.deepEqual([(await req(r.json.id)).status, (await claimRow(p.id)).status, await credit(p)], ['pending', 'confirmed', 0], 'still pending, still confirmed, no credit given');
  assert.equal((await approve(r.json.id, { keep: -1 })).status, 400);
  assert.equal((await approve(r.json.id, { keep: 1.005 })).status, 400);
  const unpaid = await person(); const r2 = await ask(unpaid);
  assert.equal((await approve(r2.json.id, { keep: 1 })).json.code, 'keep_too_much', 'there is nothing to keep a fee from');
  assert.equal((await approve(r.json.id, { keep: 8 })).status, 200, 'keeping all of it is allowed');
  assert.equal(await credit(p), 0);
});

test('a blocked handle\'s money is forfeited as always, whatever the fee', async () => {
  const p = await person({ pay: 10 }); const r = await ask(p);
  await api('POST', '/api/admin/joiners/block', { handle: p.handle, reason: 't' });
  const ok = await approve(r.json.id, { keep: 2 });
  assert.deepEqual([ok.json.refunded, ok.json.forfeited], [0, 10]);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM credit_ledger WHERE claim_id = ? AND kind = 'credit'", [p.id]))[0].n, 0);
});

test('DECLINING: the item stays exactly as it was; the person is told why, and can ask again', async () => {
  const p = await person({ pay: 5 }); const r = await ask(p);
  assert.equal((await decline(r.json.id, { note: 'It has already shipped from Korea.' })).status, 200);
  assert.deepEqual([(await claimRow(p.id)).status, await credit(p)], ['confirmed', 0]);
  const mine = (await summary(p)).orders[0].claims[0];
  assert.deepEqual([mine.cancelRequest.status, mine.cancelRequest.note], ['declined', 'It has already shipped from Korea.']);
  assert.equal((await decline(r.json.id)).json.code, 'bad_state'); assert.equal((await approve(r.json.id)).json.code, 'bad_state');
  const again = await ask(p, { reason: 'please?' });
  assert.equal(again.status, 201);
  assert.equal((await summary(p)).orders[0].claims[0].cancelRequest.status, 'pending', 'the new request replaces the old answer');
  assert.equal((await decided()).filter((x) => x.claimId === p.id).length, 1);
});

test('after the item has been received, an approval is refused (decline it instead); a pending request holds shipping; and moving the claim to someone else', async () => {
  const p = await person({ stage: READY }); await api('PUT', '/api/my/address', { fullName: 'Pat Kay', address: '1 Test Road, Leeds', email: 'p@x.com', phone: '0700' }, p.cookie);
  const r = await ask(p);
  const ship = await api('POST', '/api/my/parcels', { claimIds: [p.id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p.cookie);
  assert.equal(ship.status, 409); assert.equal(ship.json.code, 'cancel_pending'); assert.match(ship.json.error, /asked to cancel one of those items/);
  const other = await person();
  const mv = await api('POST', '/api/admin/claims/move', { claimIds: [p.id], handle: other.handle, dryRun: true });
  assert.match(mv.json.blocked[0].reason, /has asked to cancel it — answer that request first/);
  await api('PATCH', `/api/admin/claims/${p.id}`, { pipeline: 'completed' });
  const late = await approve(r.json.id); assert.equal(late.status, 409); assert.equal(late.json.code, 'already_received');
  assert.equal((await req(r.json.id)).status, 'pending', 'unchanged');
  assert.equal((await decline(r.json.id, { note: 'Already with you' })).status, 200);
  await api('PATCH', `/api/admin/claims/${p.id}`, { pipeline: READY });
  assert.equal((await api('POST', '/api/my/parcels', { claimIds: [p.id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p.cookie)).status, 201, 'once answered, shipping works again');
});

test('if the GOM cancels an item directly, its pending request is settled as approved ("Cancelled by the GOM") — one by one or in bulk', async () => {
  const [a, b] = [await person({ pay: 6 }), await person()];
  const [ra, rb] = [await ask(a), await ask(b)];
  await api('PATCH', `/api/admin/claims/${a.id}`, { status: 'cancelled' });
  await api('POST', '/api/admin/claims/cancel', { claimIds: [b.id] });
  for (const [r, who] of [[ra, a], [rb, b]]) {
    const row = await req(r.json.id);
    assert.deepEqual([row.status, row.decision_note, row.open_flag], ['approved', 'Cancelled by the GOM', null], who.handle);
  }
  assert.equal(Number((await req(ra.json.id)).refunded), 6);
  assert.equal((await pending()).some((x) => [ra.json.id, rb.json.id].includes(x.id)), false);
});

test('EMAILS (opt-in): approval says what came back and what was kept, with your message; a decline says why; nothing is sent to someone who has not opted in', async () => {
  const on = await person({ pay: 20 }), off = await person({ pay: 4 });
  await api('PUT', '/api/my/notifications', { enabled: true }, on.cookie);
  const mails = (p) => app.mailer.outbox.filter((m) => m.to === `${p.handle}@x.com` && !/auth\/confirm/.test(m.text));
  const [r1, r2] = [await ask(on), await ask(off)];
  await approve(r1.json.id, { keep: 5, note: 'Sorry — proxy fee.' }); await approve(r2.json.id); await settle();
  assert.equal(mails(off).length, 0);
  assert.equal(mails(on).length, 1);
  assert.match(mails(on)[0].subject, /Your cancellation was approved/);
  assert.match(mails(on)[0].text, /approved your request to cancel "Twenty thing"\. £15\.00 has been returned to your account as credit\. £5\.00 was kept as a cancellation fee\.\s+Message from the GOM: Sorry — proxy fee\./);
  const p2 = await person(); await api('PUT', '/api/my/notifications', { enabled: true }, p2.cookie);
  const r3 = await ask(p2); await decline(r3.json.id, { note: 'Already shipped.' }); await settle();
  assert.match(mails(p2)[0].subject, /wasn't approved/); assert.match(mails(p2)[0].text, /hasn't approved your request to cancel "Twenty thing".*Message from the GOM: Already shipped\./s);
  const p3 = await person(); await api('PUT', '/api/my/notifications', { enabled: true }, p3.cookie);
  await approve((await ask(p3)).json.id); await settle();
  assert.match(mails(p3)[0].text, /nothing to return/);
});

test('concurrency: approving while the joiner withdraws, approving twice, or approving while the GOM cancels directly — one outcome, money never doubled', async () => {
  const p = await person({ pay: 20 }); const r = await ask(p);
  const rs = await Promise.all([approve(r.json.id), api('DELETE', `/api/my/cancel-requests/${r.json.id}`, undefined, p.cookie)]);
  assert.equal(rs.filter((x) => x.status === 200).length, 1, `exactly one wins (${rs.map((x) => x.status)})`);
  const row = await req(r.json.id); assert.ok(['approved', 'withdrawn'].includes(row.status));
  assert.equal(await credit(p), row.status === 'approved' ? 20 : 0);
  const q = await person({ pay: 20 }); const r2 = await ask(q);
  const two = await Promise.all([approve(r2.json.id, { keep: 5 }), approve(r2.json.id, { keep: 5 }), approve(r2.json.id)]);
  assert.equal(two.filter((x) => x.status === 200).length, 1);
  assert.ok([15, 20].includes(await credit(q)), 'refunded once, whichever approval won');
  const s = await person({ pay: 20 }); const r3 = await ask(s);
  const mix = await Promise.all([approve(r3.json.id), api('PATCH', `/api/admin/claims/${s.id}`, { status: 'cancelled' })]);
  assert.ok(mix.every((x) => x.status === 200), mix.map((x) => x.status).join());
  assert.equal(await credit(s), 20, 'returned once, not twice');
  assert.equal((await req(r3.json.id)).status, 'approved');
});

test('only the GOM can see or answer requests; the lists are what they say', async () => {
  const p = await person(); const r = await ask(p);
  for (const [m, path, b] of [['GET', '/api/admin/cancel-requests'], ['POST', `/api/admin/cancel-requests/${r.json.id}/approve`, {}], ['POST', `/api/admin/cancel-requests/${r.json.id}/decline`, {}]]) {
    assert.equal((await api(m, path, b, p.cookie)).status, 403, `${m} ${path}`); assert.equal((await app.api(m, path, b)).status, 401);
  }
  assert.equal((await approve(999999)).status, 404); assert.equal((await decline(999999)).status, 404);
  const order = (await pending()).map((x) => x.id); assert.deepEqual(order, [...order].sort((a, b) => a - b), 'oldest first');
});

test('INVARIANTS: one pending request per item, only for items that are not cancelled; approved requests are for cancelled items; money adds up', async () => {
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM (SELECT claim_id FROM cancel_requests WHERE status = 'pending' GROUP BY claim_id HAVING COUNT(*) > 1) x"))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM cancel_requests r JOIN claims c ON c.id = r.claim_id WHERE r.status = 'pending' AND c.status = 'cancelled'"))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM cancel_requests r JOIN claims c ON c.id = r.claim_id WHERE r.status = 'approved' AND c.status <> 'cancelled'"))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM cancel_requests WHERE (status = 'pending') <> (open_flag IS NOT NULL)"))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM cancel_requests WHERE status = 'approved' AND ABS(COALESCE(paid_at_decision, 0) - COALESCE(kept, 0) - COALESCE(refunded, 0)) > 0.005"))[0].n, 0, 'paid = kept + refunded (or forfeited) on every approval');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost OR cost < 0'))[0].n, 0);
});

// ───────────── every stage, and keeping sets tidy ─────────────
test('EVERY STAGE: an item that has not even been confirmed yet can be asked about too — and is only cancelled when the GOM approves', async () => {
  const h = u(); const c = await joinerSession(app, `${h}@x.com`, h);
  await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: ITEM.ten }] });
  const claim = (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims[0];
  assert.equal(claim.status, 'requested');
  const r = await api('POST', `/api/my/claims/${claim.id}/cancel-request`, { reason: 'Ordered by mistake' }, c);
  assert.equal(r.status, 201);
  assert.equal((await claimRow(claim.id)).status, 'requested', 'still there until approved');
  const row = (await pending()).find((x) => x.id === r.json.id);
  assert.deepEqual([row.stage, row.claimStatus, row.paid, row.cost], ['not confirmed yet', 'requested', 0, 10]);
  assert.equal((await approve(r.json.id, { keep: 1 })).json.code, 'keep_too_much', 'nothing was paid, so there is no fee');
  assert.equal((await approve(r.json.id)).status, 200);
  assert.equal((await claimRow(claim.id)).status, 'cancelled');
  assert.equal((await req(r.json.id)).status, 'approved');
});

test('SETS STAY TIDY: while a part has a cancellation request waiting the set cannot be secured; answering it (either way) unlocks it; approving frees the part', async () => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Tidy GO ${++N}` })).json.id;
  const set = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: `Tidy set ${N}`, price: 4, members: ['A', 'B'] })).json.id;
  const [h1, h2] = [u(), u()]; const c1 = await joinerSession(app, `${h1}@x.com`, h1);
  await app.api('POST', '/api/claims', { handle: h1, lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] });
  await app.api('POST', '/api/claims', { handle: h2, lines: [{ itemId: set, parts: [{ member: 'B', qty: 1 }] }] });
  const sid = (await api('GET', '/api/admin/sets')).json.sets.find((x) => x.itemId === set).id;
  const mine = (await api('GET', `/api/admin/claims?handle=${h1}`)).json.claims[0];
  assert.equal(mine.status, 'requested');
  const r = await api('POST', `/api/my/claims/${mine.id}/cancel-request`, {}, c1);
  assert.equal(r.status, 201);
  let s1 = (await api('GET', '/api/admin/sets')).json.sets.find((x) => x.id === sid);
  assert.deepEqual([s1.hasRequests, s1.parts.find((p) => p.member === 'A').cancelAsked, s1.parts.find((p) => p.member === 'B').cancelAsked], [true, true, false], 'the Sets list says which part');
  const refused = await api('POST', `/api/admin/sets/${sid}/secure`, {});
  assert.equal(refused.status, 409); assert.equal(refused.json.code, 'cancel_pending'); assert.match(refused.json.error, /1 of its parts has a request to cancel waiting\. Answer it first/);
  assert.equal((await api('GET', '/api/admin/sets')).json.sets.find((x) => x.id === sid).decision, 'none', 'nothing was secured');
  await decline(r.json.id);
  s1 = (await api('GET', '/api/admin/sets')).json.sets.find((x) => x.id === sid);
  assert.equal(s1.hasRequests, false);
  const ask2 = await api('POST', `/api/my/claims/${mine.id}/cancel-request`, {}, c1);
  assert.equal((await approve(ask2.json.id)).status, 200);
  s1 = (await api('GET', '/api/admin/sets')).json.sets.find((x) => x.id === sid);
  assert.deepEqual([s1.parts.find((p) => p.member === 'A').handle, s1.filled, s1.hasRequests], [null, 1, false], 'the part is free again');
});

test('"secure all" and confirming by hand leave alone anything a joiner has asked to cancel — and say how many', async () => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Bulk GO ${++N}` })).json.id;
  const it = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: `Bulk item ${N}`, price: 6 }, admin)).json.id;
  const [a, b] = [u(), u()]; const ca = await joinerSession(app, `${a}@x.com`, a);
  await app.api('POST', '/api/claims', { handle: a, lines: [{ itemId: it }] });
  await app.api('POST', '/api/claims', { handle: b, lines: [{ itemId: it }] });
  const claimA = (await api('GET', `/api/admin/claims?handle=${a}`)).json.claims[0];
  const r = await api('POST', `/api/my/claims/${claimA.id}/cancel-request`, {}, ca);
  const out = await api('POST', '/api/admin/claims/secure', { orderId: go });
  assert.deepEqual([out.status, out.json.secured, out.json.skippedCancel], [200, 1, 1]);
  assert.deepEqual([(await claimRow(claimA.id)).status, (await api('GET', `/api/admin/claims?handle=${b}`)).json.claims[0].status], ['requested', 'confirmed']);
  const hand = await api('PATCH', `/api/admin/claims/${claimA.id}`, { status: 'confirmed' });
  assert.equal(hand.status, 409); assert.equal(hand.json.code, 'cancel_pending');
  await decline(r.json.id);
  assert.equal((await api('PATCH', `/api/admin/claims/${claimA.id}`, { status: 'confirmed' })).status, 200, 'once answered it can be confirmed');
});

test('fixed claims are NOT affected: a joiner can still change a fixed claim themselves (that flow is unchanged)', async () => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Fixed GO ${++N}` })).json.id;
  const set = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: `Fixed set ${N}`, price: 4, members: ['A', 'B'] })).json.id;
  const h = u(); const c = await joinerSession(app, `${h}@x.com`, h);
  assert.equal((await api('POST', `/api/admin/items/${set}/fixed`, { handle: h, member: 'A' })).status, 201);
  const f = (await api('GET', '/api/my/fixed', undefined, c)).json.fixed[0];
  const r = await api('POST', `/api/my/fixed/${f.id}/change`, { action: 'giveup' }, c);
  assert.deepEqual([r.status, r.json.instant], [200, true], 'unchanged: instant before the set is secured');
  const claim = (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims[0];
  const ask2 = await api('POST', `/api/my/claims/${claim.id}/cancel-request`, {}, c);
  assert.ok(ask2.status >= 400, 'and a fixed claim is never part of the cancel-request flow');
});
