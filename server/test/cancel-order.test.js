import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// Cancelling a whole group order, or one item, that can't be fulfilled (a photocard set sold out): every live claim is cancelled, what was paid goes back as credit,
// the order/item disappears from the shop — and NO emails are sent. All-or-nothing, and only with the exact name typed.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'co') => `${x}${++N}`;
const order = async (title = u('Cancel GO '), extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, ...extra })).json.id;
const item = async (go, title = u('C item '), extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price: 10, ...extra })).json.id;
const person = async (handle = u()) => ({ handle, email: `${handle}@x.com`, cookie: await joinerSession(app, `${handle}@x.com`, handle) });
const confirmed = async (p, it) => (await claimAndSecure(app, admin, p.handle, it))[0];
const pay = async (p, amount) => { const r = await api('POST', '/api/my/payments', { method: 'PayPal', amount, reference: `R${u('r')}` }, p.cookie); await api('POST', `/api/admin/payments/${r.json.id}/verify`, {}); };
const plan = (what, id) => api('GET', `/api/admin/${what}s/${id}/cancel-plan`);
const cancel = (what, id, confirm, c = admin) => api('POST', `/api/admin/${what}s/${id}/cancel`, { confirm }, c);
const credit = async (p) => (await api('GET', '/api/my/summary', undefined, p.cookie)).json.credit;
const status = async (id) => (await app.q('SELECT status FROM claims WHERE id = ?', [id]))[0].status;
const count = async (sql, a = []) => (await app.q(sql, a))[0].n;
const publicOrders = async () => (await fetch(`${app.base}/api/orders`).then((r) => r.json())).orders;
const READY = 'ready to pack / on hand';

test('THE PREVIEW: counts what would be cancelled (confirmed and unconfirmed), the people, and the money to be returned — and changes nothing', async () => {
  const go = await order('Preview GO'); const a = await item(go, 'Preview A'), b = await item(go, 'Preview B');
  const [p1, p2] = [await person(), await person()];
  const c1 = await confirmed(p1, a); await pay(p1, 10);                                // p1: £10 paid
  const c2 = await confirmed(p2, b); await pay(p2, 4);                                 // p2: £4 of £10
  await app.api('POST', '/api/claims', { handle: u('req'), lines: [{ itemId: a }] });   // an unconfirmed request from someone else
  const r = await plan('order', go);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.summary, { claims: 3, requested: 1, confirmed: 2, people: 3, items: 2, paid: 14, credit: 14, forfeited: 0 });
  assert.deepEqual([r.json.kind, r.json.title, r.json.blockers], ['order', 'Preview GO', []]);
  assert.equal(r.json.claims.length, 3);
  const one = await plan('item', a); assert.deepEqual([one.json.summary.claims, one.json.summary.people, one.json.summary.paid], [2, 2, 10], 'one item: just its claims');
  assert.deepEqual([await status(c1), await status(c2), await credit(p1)], ['confirmed', 'confirmed', 0], 'asking changed nothing');
});

test('CANCELLING A WHOLE ORDER: every live claim is cancelled, each person gets exactly what they paid back as credit, the order closes and vanishes from the shop, and nobody can claim its items', async () => {
  const go = await order('Whole GO'); const a = await item(go, 'Whole A'), b = await item(go, 'Whole B');
  const [p1, p2, p3] = [await person(), await person(), await person()];
  const c1 = await confirmed(p1, a); await pay(p1, 10);
  const c2 = await confirmed(p2, b); await pay(p2, 4);
  const c3 = await confirmed(p3, a);                                                    // owes, paid nothing
  await app.api('POST', '/api/claims', { handle: p3.handle, lines: [{ itemId: b }] });
  const requested = (await api('GET', `/api/admin/claims?handle=${p3.handle}`)).json.claims.find((c) => c.status === 'requested').id;
  const before = (await publicOrders()).find((o) => o.id === go); assert.ok(before);
  const r = await cancel('order', go, 'Whole GO');
  assert.equal(r.status, 200, r.text); assert.deepEqual([r.json.claims, r.json.people, r.json.credit, r.json.forfeited], [4, 3, 14, 0]);
  for (const id of [c1, c2, c3, requested]) assert.equal(await status(id), 'cancelled', `claim ${id}`);
  assert.deepEqual([await credit(p1), await credit(p2), await credit(p3)], [10, 4, 0], 'each person gets back exactly what they paid');
  assert.equal(await count('SELECT COUNT(*) AS n FROM claim_costs WHERE claim_id IN (?, ?, ?) AND paid <> 0', [c1, c2, c3]), 0);
  const adm = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go);
  assert.deepEqual([adm.status, adm.cancelled, adm.items.every((i) => i.cancelled)], ['closed', true, true], 'the GOM still sees it, marked cancelled');
  assert.equal((await publicOrders()).some((o) => o.id === go), false, 'joiners do not see it');
  const groups = (await fetch(`${app.base}/api/groups`).then((x) => x.json())).groups.find((g) => g.id === w.group);
  const open = (await publicOrders()).filter((o) => o.groupId === w.group && o.status === 'open').length; assert.equal(groups.openOrders, open, 'and it is not counted as an open order');
  const claim = await app.api('POST', '/api/claims', { handle: u('late'), lines: [{ itemId: a }] });
  assert.equal(claim.status, 400); assert.ok(['order_closed', 'item_cancelled'].includes(claim.json.code), claim.json.code);
  const led = await app.q("SELECT reason FROM credit_ledger WHERE joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?) AND kind = 'credit'", [p1.handle]);
  assert.match(led[0].reason, /Cancelled by the GOM \(the group order could not go ahead\): "Whole A"/);
  assert.equal((await cancel('order', go, 'Whole GO')).status, 409, 'it cannot be cancelled twice');
});

test('CANCELLING ONE ITEM leaves the rest of the order alone: only that item\'s claims go, the order stays open, and that item can no longer be claimed', async () => {
  const go = await order('One item GO'); const sold = await item(go, 'Sold out set'), keep = await item(go, 'Still here');
  const [p1, p2] = [await person(), await person()];
  const c1 = await confirmed(p1, sold); await pay(p1, 10); const c2 = await confirmed(p2, keep); await pay(p2, 10);
  const r = await cancel('item', sold, 'sold out set');                                 // case does not matter
  assert.equal(r.status, 200, r.text); assert.deepEqual([r.json.claims, r.json.credit], [1, 10]);
  assert.deepEqual([await status(c1), await status(c2), await credit(p1), await credit(p2)], ['cancelled', 'confirmed', 10, 0]);
  const o = (await publicOrders()).find((x) => x.id === go); assert.equal(o.status, 'open');
  assert.deepEqual(o.items.map((i) => i.title), ['Still here'], 'the cancelled item is gone from the shop');
  const adm = (await api('GET', '/api/admin/orders')).json.orders.find((x) => x.id === go).items.find((i) => i.id === sold); assert.equal(adm.cancelled, true);
  const claim = await app.api('POST', '/api/claims', { handle: u('late'), lines: [{ itemId: sold }] });
  assert.equal(claim.status, 400); assert.equal(claim.json.code, 'item_cancelled'); assert.match(claim.json.error, /isn't available any more/);
  assert.ok([200, 201].includes((await app.api('POST', '/api/claims', { handle: u('ok'), lines: [{ itemId: keep }] })).status), 'the other item still works');
  assert.equal((await cancel('item', sold, 'Sold out set')).status, 409);
});

test('DOUBLE-CHECKING: nothing happens unless the exact name is typed (spacing and capitals forgiven); a wrong or missing name changes nothing', async () => {
  const go = await order('Type Me GO'); const it = await item(go); const p = await person(); const c = await confirmed(p, it); await pay(p, 10);
  for (const wrong of ['', 'type me', 'Type Me GO!', 'another order']) {
    const r = await cancel('order', go, wrong); assert.equal(r.status, 400, `"${wrong}"`); assert.equal(r.json.code, 'confirm_mismatch'); assert.match(r.json.error, /type the order name exactly: Type Me GO/);
  }
  assert.equal((await api('POST', `/api/admin/orders/${go}/cancel`, {})).status, 400, 'a missing confirmation field is refused too');
  assert.deepEqual([await status(c), await credit(p)], ['confirmed', 0]);
  assert.equal((await cancel('order', go, '  type   ME go ')).status, 200, 'extra spaces and capitals are fine');
});

test('ALL OR NOTHING: a claim inside a parcel or a warehouse box stops the whole cancellation, names it, and leaves everything — including the other claims — exactly as it was', async () => {
  const go = await order('Blocked GO'); const a = await item(go, 'Blocked A'), b = await item(go, 'Blocked B');
  const p1 = await person(), p2 = await person(), p3 = await person();
  await api('PUT', '/api/my/address', { fullName: 'Block Er', address: '1 Road, Leeds', email: p1.email, phone: '0700123456' }, p1.cookie);
  const inParcel = await confirmed(p1, a); await api('PATCH', `/api/admin/claims/${inParcel}`, { pipeline: READY });
  const par = await api('POST', '/api/my/parcels', { claimIds: [inParcel], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p1.cookie); assert.equal(par.status, 201);
  const inBox = await confirmed(p2, b); await api('PATCH', `/api/admin/claims/${inBox}`, { pipeline: 'arrived at proxy / warehouse' });
  const box = await api('POST', '/api/admin/boxes', { claimIds: [inBox], emsTotal: 10, customsTotal: 0, totalWeightG: 500 }); assert.equal(box.status, 201, box.text);
  const fine = await confirmed(p3, a); await pay(p3, 10);
  const pl = (await plan('order', go)).json;
  assert.deepEqual(pl.blockers.map((x) => [x.handle, x.reason.split(' — ')[0]]), [[p1.handle, `it is in parcel #${par.json.id}`], [p2.handle, `it is in warehouse box #${box.json.id}`]]);
  const r = await cancel('order', go, 'Blocked GO'); assert.equal(r.status, 409); assert.equal(r.json.code, 'cannot_cancel');
  assert.match(r.json.error, /^Nothing was cancelled: “Blocked A.*” \(@/);
  assert.deepEqual([await status(inParcel), await status(inBox), await status(fine), await credit(p3)], ['confirmed', 'confirmed', 'confirmed', 0], 'not even the claim that WAS free was touched');
  assert.equal((await app.q('SELECT cancelled_at FROM group_orders WHERE id = ?', [go]))[0].cancelled_at, null);
  assert.equal((await cancel('item', a, 'Blocked A')).status, 409, 'cancelling just the item with the parcel claim is blocked too');
  const only = await cancel('item', b, 'Blocked B'); assert.equal(only.status, 409, 'and the one with the box claim');
});

test('RECEIVED ITEMS ARE LEFT ALONE: someone who already has theirs keeps it, is not counted, and is not refunded', async () => {
  const go = await order('Mixed GO'); const it = await item(go, 'Mixed item');
  const [got, waiting] = [await person(), await person()];
  const c1 = await confirmed(got, it); await pay(got, 10); await app.q("UPDATE claims SET pipeline = 'completed' WHERE id = ?", [c1]);
  const c2 = await confirmed(waiting, it); await pay(waiting, 10);
  assert.equal((await plan('order', go)).json.summary.claims, 1, 'only the one still waiting');
  assert.equal((await cancel('order', go, 'Mixed GO')).json.credit, 10);
  assert.deepEqual([await status(c1), await status(c2), await credit(got), await credit(waiting)], ['confirmed', 'cancelled', 0, 10]);
});

test('A BLOCKED HANDLE\'S MONEY is forfeited as always — and the preview says so before you confirm', async () => {
  const go = await order('Forfeit GO'); const it = await item(go); const bad = await person(), good = await person();
  await confirmed(bad, it); await pay(bad, 10); await confirmed(good, it); await pay(good, 10);
  await api('POST', '/api/admin/joiners/block', { handle: bad.handle, reason: 't' });
  const s = (await plan('order', go)).json.summary; assert.deepEqual([s.paid, s.credit, s.forfeited], [20, 10, 10]);
  const r = await cancel('order', go, 'Forfeit GO'); assert.deepEqual([r.json.credit, r.json.forfeited], [10, 10]);
  assert.deepEqual([await credit(bad), await credit(good)], [0, 10]);
});

test('SETS, FIXED CLAIMS AND REQUESTS: set parts are freed and leave the Sets tab and the proxy list; standing claims end; a pending "ask to cancel" is settled; no email goes to anyone', async () => {
  const go = await order('Set GO', { proxy: 'Sam' });
  const set = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: 'Photocard set', price: 4, members: ['A', 'B'] })).json.id;
  const [p1, p2] = [await person(), await person()];
  await api('PUT', '/api/my/notifications', { enabled: true }, p1.cookie);
  await app.api('POST', '/api/claims', { handle: p1.handle, lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] });
  await app.api('POST', '/api/claims', { handle: p2.handle, lines: [{ itemId: set, parts: [{ member: 'B', qty: 1 }] }] });
  const sid = (await api('GET', '/api/admin/sets')).json.sets.find((s) => s.itemId === set).id; await api('POST', `/api/admin/sets/${sid}/secure`, {});
  assert.ok((await api('GET', '/api/admin/proxy/candidates')).json.candidates.some((c) => c.key === `set:${set}`), 'a secured set is something to pay the proxy for');
  const mine = (await api('GET', `/api/admin/claims?handle=${p1.handle}`)).json.claims[0];
  const ask = await api('POST', `/api/my/claims/${mine.id}/cancel-request`, {}, p1.cookie); assert.equal(ask.status, 201);
  assert.equal((await api('POST', `/api/admin/items/${set}/fixed`, { handle: u('fx'), member: 'B' })).status, 201);
  const mailsBefore = app.mailer.outbox.length;
  const r = await cancel('order', go, 'Set GO'); assert.equal(r.status, 200, r.text);
  await app.notifier.idle();
  assert.equal(app.mailer.outbox.length, mailsBefore, 'NO emails — the GOM tells people themselves, even someone who opted in');
  assert.equal(await count('SELECT COUNT(*) AS n FROM set_slots WHERE set_id = ?', [sid]), 0, 'the parts are freed');
  assert.equal((await api('GET', '/api/admin/sets')).json.sets.some((s) => s.itemId === set), false, 'gone from the Sets tab');
  assert.equal((await api('GET', '/api/admin/proxy/candidates')).json.candidates.some((c) => c.key === `set:${set}`), false, 'and nothing to pay a proxy for');
  assert.equal(await count('SELECT COUNT(*) AS n FROM fixed_claims WHERE item_id = ? AND ended_at IS NULL', [set]), 0, 'standing claims end');
  const req = (await app.q('SELECT status, decision_note FROM cancel_requests WHERE id = ?', [ask.json.id]))[0]; assert.deepEqual([req.status, req.decision_note], ['approved', 'Cancelled by the GOM']);
});

test('ONLY THE GOM, only things that exist; the activity log records counts and money but never a name', async () => {
  const go = await order('Audit GO'); const it = await item(go); const p = await person(); await confirmed(p, it); await pay(p, 10);
  const j = await app.login(`${u('jj')}@x.com`);
  for (const [m, path, b] of [['GET', `/api/admin/orders/${go}/cancel-plan`], ['GET', `/api/admin/items/${it}/cancel-plan`], ['POST', `/api/admin/orders/${go}/cancel`, { confirm: 'Audit GO' }], ['POST', `/api/admin/items/${it}/cancel`, { confirm: 'x' }]]) {
    assert.equal((await api(m, path, b, j)).status, 403, `${m} ${path}`); assert.equal((await app.api(m, path, b)).status, 401);
  }
  assert.equal((await plan('order', 999999)).status, 404); assert.equal((await plan('item', 999999)).status, 404); assert.equal((await cancel('order', 999999, 'x')).status, 404);
  await cancel('order', go, 'Audit GO');
  const row = (await app.q("SELECT detail FROM audit_log WHERE action = 'order.cancel' ORDER BY id DESC LIMIT 1"))[0];
  assert.doesNotMatch(row.detail, new RegExp(p.handle)); assert.match(row.detail, /"claims":1.*"people":1.*"credit":10/s);
});

test('CONCURRENCY: people claiming at the very moment it is cancelled either land in the cancellation or are refused — never left holding a live claim on a cancelled item; two cancels at once → one wins', async () => {
  for (let round = 0; round < 6; round++) {
    const go = await order(`Race GO ${round}`); const it = await item(go);
    const hs = Array.from({ length: 4 }, () => u('race'));
    const rs = await Promise.all([...hs.map((h) => app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: it }] })), cancel('order', go, `Race GO ${round}`), cancel('order', go, `Race GO ${round}`)]);
    assert.ok(rs.slice(0, 4).every((x) => [200, 201, 400].includes(x.status)), `claims: ${rs.slice(0, 4).map((x) => x.status)}`);
    assert.deepEqual(rs.slice(4).map((x) => x.status).sort(), [200, 409], 'exactly one cancel succeeds');
    assert.equal(await count("SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND status IN ('requested', 'confirmed')", [it]), 0, `round ${round}: no live claim left`);
  }
});

test('A CANCELLED ORDER with nothing paid on it can be deleted afterwards; one that had money on it is kept (its records stay)', async () => {
  const clean = await order('Clean cancel GO'); const a = await item(clean); const p = await person(); await confirmed(p, a);
  await cancel('order', clean, 'Clean cancel GO'); assert.equal((await api('DELETE', `/api/admin/orders/${clean}`)).status, 200, 'never paid: it can be deleted');
  const paid = await order('Paid cancel GO'); const b = await item(paid); const q = await person(); await confirmed(q, b); await pay(q, 10);
  await cancel('order', paid, 'Paid cancel GO'); const d = await api('DELETE', `/api/admin/orders/${paid}`);
  assert.equal(d.status, 409); assert.match(d.json.error, /payments, a parcel or a box behind/);
});
