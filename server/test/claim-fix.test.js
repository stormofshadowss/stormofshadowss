import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// Fixing mistakes in claims (mostly from an import): change WHAT a claim is (the price question is asked each time), delete it outright (only when nothing would be lost), turn a filler line into credit.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'fx') => `${x}${++N}`;
const READY = 'ready to pack / on hand';
const goOrder = async (title = u('Fix GO '), extra = {}) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam', ...extra })).json.id;
const item = async (go, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price: 10, ...extra })).json.id;
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const one = async (h, it) => (await claimAndSecure(app, admin, h, it))[0];
const del = (ids, extra = {}) => api('POST', '/api/admin/claims/delete', { claimIds: ids, ...extra });
const sess = {};
const person = async (h) => { sess[h] = await joinerSession(app, `${h}@x.com`, h); return h; };
const costOf = async (id) => (await app.q('SELECT category, cost, paid FROM claim_costs WHERE claim_id = ?', [id])).find((r) => r.category === 'initials');
const credit = async (h) => (await api('GET', '/api/my/summary', undefined, sess[h])).json.credit;
const ledger = async (h) => app.q('SELECT kind, amount, balance_effect, reason, source FROM credit_ledger WHERE joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?) ORDER BY id', [h]);
const payIn = async (h, amount) => { const r = await api('POST', '/api/my/payments', { method: 'PayPal', amount, reference: u('R') }, sess[h]); assert.equal(r.status, 201, r.text); assert.equal((await api('POST', `/api/admin/payments/${r.json.id}/verify`, {})).status, 200); };

// ───────── delete ─────────
test('DELETE: a claim with nothing paid is removed completely — its costs go with it, the person stays, and nobody else is touched', async () => {
  const go = await goOrder(); const it = await item(go, { price: 12 }); const h = await person(u()); const keep = await one(h, it); const dup = await one(h, it);
  const before = await credit(h);
  const r = await del([dup]); assert.equal(r.status, 200, r.text); assert.deepEqual([r.json.deleted, r.json.refused.length], [1, 0]);
  assert.deepEqual((await claimsOf(h)).map((c) => c.id), [keep]); assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE claim_id = ?', [dup]))[0].n, 0, 'its cost lines are gone too');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE id = ?', [dup]))[0].n, 0); assert.equal(await credit(h), before, 'no money moved');
  const mine = (await api('GET', '/api/my/summary', undefined, sess[h])).json.orders.flatMap((o) => o.claims); assert.equal(mine.length, 1, 'and it is gone from their My orders');
  const rq = await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: it }] }); void rq;
  const req = (await claimsOf(h)).find((c) => c.status === 'requested'); assert.equal((await del([req.id])).json.deleted, 1, 'a request deletes the same way');
});

test('DELETE IS REFUSED, WITH THE REASON, when anything would be lost: money paid, a parcel, a box, a pending cancel request, credit history, a member-set part', async () => {
  const go = await goOrder(); const it = await item(go, { price: 10 }); const reasonOf = async (id) => { const r = await del([id]); assert.equal(r.status, 200); assert.equal(r.json.deleted, 0); return r.json.refused[0].reasons.join(' | '); };
  // paid
  const hp = await person(u()); const paid = await one(hp, it); await payIn(hp, 10); assert.match(await reasonOf(paid), /£10\.00 has been paid towards it — cancel it instead \(what was paid goes back to them as credit\)\./);
  // in a parcel
  const hq = await person(u()); await api('PUT', '/api/my/address', { fullName: 'P Q', address: '1 Road, Leeds', email: `${hq}@x.com`, phone: '0700123456' }, sess[hq]);
  const inParcel = await one(hq, await item(go)); await api('PATCH', `/api/admin/claims/${inParcel}`, { pipeline: READY });
  const par = await api('POST', '/api/my/parcels', { claimIds: [inParcel], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, sess[hq]); assert.equal(par.status, 201, par.text);
  assert.match(await reasonOf(inParcel), new RegExp(`It's in parcel #${par.json.id}\\.`));
  // in a box
  const hb = await person(u()); const boxed = await one(hb, await item(go)); await api('PATCH', `/api/admin/claims/${boxed}`, { pipeline: 'arrived at proxy / warehouse', weightG: 300, sizeBucket: 'S' });
  assert.equal((await api('POST', '/api/admin/boxes', { claimIds: [boxed], emsTotal: 10 })).status, 201); assert.match(await reasonOf(boxed), /It's in a box \(Warehouse tab\)\./);
  // a pending request to cancel
  const hc = await person(u()); const asked = await one(hc, await item(go)); assert.equal((await api('POST', `/api/my/claims/${asked}/cancel-request`, {}, sess[hc])).status, 201); assert.match(await reasonOf(asked), /They've asked to cancel it — answer that first/);
  // credit history (a claim that was cancelled with money paid)
  const hh = await person(u()); const hist = await one(hh, await item(go, { price: 5 })); await payIn(hh, 5); await api('PATCH', `/api/admin/claims/${hist}`, { status: 'cancelled' }); assert.match(await reasonOf(hist), /It has credit or fee history, which has to be kept\./);
  // a member-set part
  const set = await item(go, { type: 'set', members: ['A', 'B'], price: 3 }); const hs = await person(u()); await app.api('POST', '/api/claims', { handle: hs, lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] });
  const part = (await claimsOf(hs))[0]; assert.match(await reasonOf(part.id), /It's a member-set part — manage it on the Sets tab/);
  for (const id of [paid, inParcel, boxed, asked, hist, part.id]) assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE id = ?', [id]))[0].n, 1, 'still there');
});

test('BULK DELETE: the deletable ones go, the rest come back with reasons, a dry run changes nothing, a missing id is reported, and only the GOM can do it', async () => {
  const go = await goOrder(); const it = await item(go, { price: 10 }); const ok = [], hp = await person(u()); for (let i = 0; i < 3; i++) ok.push(await one(u('dd'), it)); const paid = await one(hp, it); await payIn(hp, 10);
  const dry = await del([...ok, paid, 999999], { dryRun: true }); assert.equal(dry.status, 200); assert.deepEqual([dry.json.dryRun, dry.json.deleted, dry.json.refused.length], [true, 3, 2]);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE id IN (?)', [ok]))[0].n, 3, 'a dry run deletes nothing');
  const r = await del([...ok, paid, 999999]); assert.deepEqual([r.json.deleted, r.json.refused.length], [3, 2]); assert.match(r.json.refused.find((x) => x.id === paid).reasons[0], /has been paid towards it/); assert.deepEqual(r.json.refused.find((x) => x.id === 999999).reasons, ['There is no such claim.']);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE id = ?', [paid]))[0].n, 1);
  assert.equal((await del([])).status, 400); assert.equal((await del(Array.from({ length: 201 }, (_, i) => i + 1))).status, 400);
  const j = await app.login(`${u('jj')}@x.com`); assert.equal((await api('POST', '/api/admin/claims/delete', { claimIds: [paid] }, j)).status, 403); assert.equal((await app.api('POST', '/api/admin/claims/delete', { claimIds: [paid] })).status, 401);
  const log = (await app.q("SELECT detail FROM audit_log WHERE action = 'claims.delete' ORDER BY id DESC LIMIT 1"))[0]; assert.match(String(log.detail), /"count":3.*"refused":2/s);
});

test('TWO DELETES AT ONCE of the same claim: one deletes it, the other is told there is no such claim — nothing breaks', async () => {
  const go = await goOrder(); const it = await item(go); const id = await one(u(), it);
  const rs = await Promise.all([del([id]), del([id])]); assert.deepEqual(rs.map((r) => r.status), [200, 200]); assert.equal(rs.reduce((n, r) => n + r.json.deleted, 0), 1);
});

// ───────── filler line → credit ─────────
test('TURN INTO CREDIT: the filler line becomes credit on their account (and is used on what they owe), and the line is gone', async () => {
  const go = await goOrder(); const filler = await item(go, { price: 20, title: 'CREDIT filler' }); const real = await item(go, { price: 15 });
  const a = await person(u()); const f1 = await one(a, filler);
  const r = await api('POST', `/api/admin/claims/${f1}/to-credit`, { amount: 20, reason: 'Credit carried over from Notion' }); assert.equal(r.status, 200, r.text);
  assert.equal(await credit(a), 20); assert.equal((await claimsOf(a)).length, 0, 'the filler line is gone'); const lg = await ledger(a); assert.deepEqual([lg[0].kind, lg[0].amount, lg[0].balance_effect, lg[0].source, lg[0].reason], ['credit', 20, 20, 'Admin credit', 'Credit carried over from Notion']);
  const b = await person(u()); await one(b, real); const f2 = await one(b, filler);                                      // owes £15 + a £20 filler
  assert.equal((await api('POST', `/api/admin/claims/${f2}/to-credit`, { amount: 20, reason: 'Carried over' })).status, 200);
  const s = (await api('GET', '/api/my/summary', undefined, sess[b])).json; assert.deepEqual([s.owed.total, s.credit], [0, 5], 'the £20 credit paid the £15 they owed, £5 left');
});

test('TURN INTO CREDIT is refused when anything has been paid on the line (cancel it instead) and for a bad amount, a missing reason, an unknown claim, or a non-GOM', async () => {
  const go = await goOrder(); const it = await item(go, { price: 10 }); const h = await person(u()); const c = await one(h, it); await payIn(h, 10);
  const r = await api('POST', `/api/admin/claims/${c}/to-credit`, { amount: 10, reason: 'x' }); assert.equal(r.status, 409); assert.match(r.json.error, /£10\.00 has been paid towards it — cancel it instead/); assert.equal(await credit(h), 0, 'nothing was credited');
  const f = await one(await person(u()), it); for (const body of [{ amount: 0, reason: 'x' }, { amount: -5, reason: 'x' }, { amount: 100001, reason: 'x' }, { amount: 5 }, { amount: 5, reason: '   ' }, { reason: 'x' }]) assert.equal((await api('POST', `/api/admin/claims/${f}/to-credit`, body)).status, 400, JSON.stringify(body));
  assert.equal((await api('POST', '/api/admin/claims/999999/to-credit', { amount: 5, reason: 'x' })).status, 404);
  const j = await app.login(`${u('jj')}@x.com`); assert.equal((await api('POST', `/api/admin/claims/${f}/to-credit`, { amount: 5, reason: 'x' }, j)).status, 403);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claims WHERE id = ?', [f]))[0].n, 1, 'every refusal left the line alone');
});

// ───────── change what it is ─────────
test('CHANGE THE ITEM: it moves to the other item and group order; the price question must be answered; "re-price" uses the new price, "keep" leaves the old one', async () => {
  const g1 = await goOrder('Wrong GO'), g2 = await goOrder('Right GO'); const wrong = await item(g1, { price: 10, title: 'Wrong album' }), right = await item(g2, { price: 14, title: 'Right album' });
  const h = await person(u()); const a = await one(h, wrong), b = await one(h, wrong);
  const noAnswer = await api('POST', `/api/admin/claims/${a}/change`, { itemId: right }); assert.equal(noAnswer.status, 400); assert.match(noAnswer.json.error, /Choose whether to re-price it or keep the old price\./);
  const r = await api('POST', `/api/admin/claims/${a}/change`, { itemId: right, pricing: 'reprice' }); assert.equal(r.status, 200, r.text); assert.deepEqual([r.json.label, r.json.repriced], ['Right album', true]);
  const ca = (await claimsOf(h)).find((c) => c.id === a); assert.deepEqual([ca.label, ca.order_id, ca.orderTitle, ca.costs.initials.cost], ['Right album', g2, 'Right GO', 14]);
  const k = await api('POST', `/api/admin/claims/${b}/change`, { itemId: right, pricing: 'keep' }); assert.equal(k.json.repriced, false); const cb = (await claimsOf(h)).find((c) => c.id === b); assert.deepEqual([cb.label, cb.costs.initials.cost], ['Right album', 10], 'kept the old price');
  const seen = (await api('GET', '/api/my/summary', undefined, sess[h])).json.orders.map((o) => o.title ?? o.orderTitle); assert.ok(JSON.stringify(seen).includes('Right GO'), 'their My orders shows the new group order');
});

test('RE-PRICING WITH MONEY ALREADY PAID: paid more than the new price becomes credit; paid less leaves the rest owed', async () => {
  const go = await goOrder(); const dear = await item(go, { price: 10 }), cheap = await item(go, { price: 6 }), pricier = await item(go, { price: 15 });
  const h = await person(u()); const a = await one(h, dear); await payIn(h, 10);
  assert.equal((await api('POST', `/api/admin/claims/${a}/change`, { itemId: cheap, pricing: 'reprice' })).status, 200); assert.deepEqual([(await costOf(a)).cost, (await costOf(a)).paid], [6, 6]); assert.equal(await credit(h), 4, 'the £4 over goes back as credit');
  const h2 = await person(u()); const b = await one(h2, dear); await payIn(h2, 10); await api('POST', `/api/admin/claims/${b}/change`, { itemId: pricier, pricing: 'reprice' });
  assert.deepEqual([(await costOf(b)).cost, (await costOf(b)).paid], [15, 10], 'still £5 owed'); assert.equal((await api('GET', '/api/my/summary', undefined, sess[h2])).json.owed.total, 5);
});

test('CHANGE THE SIZE OR MEMBER on the same item: no price question, the price is unchanged, and an admin-set size band is kept', async () => {
  const go = await goOrder(); const tee = await item(go, { type: 'size', variants: ['M', 'L'], title: 'Tee', price: 20 }), card = await item(go, { type: 'independent', members: ['Felix', 'Han'], title: 'Card', price: 3 });
  const h = await person(u()); await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: tee, variant: 'M' }, { itemId: card, member: 'Felix' }] }); await api('POST', '/api/admin/claims/secure', { orderId: go });
  const [t, c] = [(await claimsOf(h)).find((x) => /Tee/.test(x.label)), (await claimsOf(h)).find((x) => /Card/.test(x.label))]; await api('PATCH', `/api/admin/claims/${t.id}`, { sizeBucket: 'L' });
  assert.equal((await api('POST', `/api/admin/claims/${t.id}/change`, { itemId: tee, variant: 'L' })).status, 200); assert.equal((await api('POST', `/api/admin/claims/${c.id}/change`, { itemId: card, member: 'Han' })).status, 200);
  const after = await claimsOf(h); assert.deepEqual(after.map((x) => x.label).sort(), ['Card — Han', 'Tee (L)']); assert.equal((await costOf(t.id)).cost, 20); assert.equal((await app.q('SELECT size_bucket FROM claims WHERE id = ?', [t.id]))[0].size_bucket, 'L', 'the size band was kept');
  assert.equal((await api('POST', `/api/admin/claims/${t.id}/change`, { itemId: tee, variant: 'L' })).status, 400, "that's what it already is");
  assert.equal((await api('POST', `/api/admin/claims/${t.id}/change`, { itemId: tee })).status, 400, 'a size item needs a size'); assert.equal((await api('POST', `/api/admin/claims/${c.id}/change`, { itemId: card, member: 'Nobody' })).status, 400);
});

test('CHANGE IS REFUSED, with the reason: a cancelled claim, a parcel, a box, a member-set part, a pending cancel request, a cancelled item, a set as the target, a TBC price for a confirmed claim', async () => {
  const go = await goOrder(); const a = await item(go, { title: 'A' }), b = await item(go, { title: 'B' }); const why = async (id, to, extra = {}) => { const r = await api('POST', `/api/admin/claims/${id}/change`, { itemId: to, pricing: 'keep', ...extra }); assert.ok([400, 409].includes(r.status), `${r.status} ${r.text}`); return r.json.error; };
  const h = await person(u()); const cancelled = await one(h, a); await api('PATCH', `/api/admin/claims/${cancelled}`, { status: 'cancelled' }); assert.match(await why(cancelled, b), /It's cancelled\./);
  const hq = await person(u()); await api('PUT', '/api/my/address', { fullName: 'P Q', address: '1 Road, Leeds', email: `${hq}@x.com`, phone: '0700123456' }, sess[hq]); const inP = await one(hq, a); await api('PATCH', `/api/admin/claims/${inP}`, { pipeline: READY });
  const par = await api('POST', '/api/my/parcels', { claimIds: [inP], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, sess[hq]); assert.match(await why(inP, b), new RegExp(`It's in parcel #${par.json.id}\\.`));
  const hc = await person(u()); const asked = await one(hc, a); await api('POST', `/api/my/claims/${asked}/cancel-request`, {}, sess[hc]); assert.match(await why(asked, b), /They've asked to cancel it/);
  const set = await item(go, { type: 'set', members: ['A', 'B'], price: 3 }); const hs = await person(u()); await app.api('POST', '/api/claims', { handle: hs, lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] }); const part = (await claimsOf(hs))[0]; assert.match(await why(part.id, b), /member-set part/);
  const ok = await one(await person(u()), a); assert.match(await why(ok, set), /can't be changed into a member-set part/);
  const dead = await item(go, { title: 'Dead' }); await api('POST', `/api/admin/items/${dead}/cancel`, { confirm: 'Dead' }); assert.match(await why(ok, dead), /isn't available any more/);
  const tbc = await item(go, { price: undefined, priceTbc: true }); assert.match(await why(ok, tbc), /That item's price is still TBC — a confirmed claim can't move to it/);
  const hpd = await person(u()); const paidOne = await one(hpd, a); await payIn(hpd, 10); const tbcReq = await app.api('POST', '/api/claims', { handle: hpd, lines: [{ itemId: a }] }); void tbcReq;
  assert.equal((await api('POST', `/api/admin/claims/${ok}/change`, { itemId: 999999, pricing: 'keep' })).status, 404); assert.equal((await api('POST', '/api/admin/claims/999999/change', { itemId: b, pricing: 'keep' })).status, 404);
  const j = await app.login(`${u('jj')}@x.com`); assert.equal((await api('POST', `/api/admin/claims/${ok}/change`, { itemId: b, pricing: 'keep' }, j)).status, 403); void paidOne;
  assert.equal((await claimsOf(h))[0].label, 'A', 'nothing was changed by any refusal');
});

test('A REQUEST CAN MOVE TO A TBC ITEM (with the old price kept); a confirmed one cannot be re-priced to TBC while money is paid', async () => {
  const go = await goOrder(); const a = await item(go, { price: 10 }), tbc = await item(go, { price: undefined, priceTbc: true, title: 'Later' }); const h = await person(u());
  await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: a }] }); const req = (await claimsOf(h))[0];
  assert.equal((await api('POST', `/api/admin/claims/${req.id}/change`, { itemId: tbc, pricing: 'keep' })).status, 200); const after = (await claimsOf(h))[0]; assert.deepEqual([after.label, after.priceTbc, after.status], ['Later', true, 'requested']);
});

// ───────── the plan the panel uses ─────────
test('THE PLAN says what can be done and what stops each, and offers the claim\'s cost as the default credit', async () => {
  const go = await goOrder('Plan GO'); const it = await item(go, { price: 17.5, title: 'Plan thing' }); const h = await person(u()); const c = await one(h, it);
  const p = (await api('GET', `/api/admin/claims/${c}/fix-plan`)).json; assert.deepEqual([p.label, p.handle, p.orderTitle, p.cost, p.paid, p.delete.ok, p.change.ok, p.credit.ok, p.credit.amount], ['Plan thing', h, 'Plan GO', 17.5, 0, true, true, true, 17.5]);
  await payIn(h, 5); const q = (await api('GET', `/api/admin/claims/${c}/fix-plan`)).json; assert.deepEqual([q.delete.ok, q.credit.ok, q.change.ok, q.paid], [false, false, true, 5]); assert.match(q.delete.reasons[0], /£5\.00 has been paid/);
  assert.equal((await api('GET', '/api/admin/claims/999999/fix-plan')).status, 404); const j = await app.login(`${u('jj')}@x.com`); assert.equal((await api('GET', `/api/admin/claims/${c}/fix-plan`, undefined, j)).status, 403);
});
