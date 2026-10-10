import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const fresh = (p = 'px') => `${p}${++N}`;
const candidates = async () => (await api('GET', '/api/admin/proxy/candidates')).json.candidates;
const payments = async (q = '') => (await api('GET', `/api/admin/proxy/payments${q ? `?q=${encodeURIComponent(q)}` : ''}`)).json.payments;
const log = (keys, extra = {}) => api('POST', '/api/admin/proxy/payments', { proxy: 'Sam', keys, ...extra });
async function order(opts = {}) {
  return (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Proxy GO ${++N}`, ...opts })).json.id;
}
async function normalItem(orderId, opts = {}) {
  return (await api('POST', `/api/admin/orders/${orderId}/items`, { type: 'normal', title: `Proxy item ${++N}`, price: 10, ...opts })).json.id;
}
// a member-set item with `n` secured sets (one claimer per set)
async function securedSets(orderId, n, opts = {}) {
  const item = (await api('POST', `/api/admin/orders/${orderId}/items`, { type: 'set', title: `Proxy set ${++N}`, price: 8, members: ['A', 'B', 'C', 'D'], ...opts })).json.id;
  for (let i = 0; i < n; i++) await api('POST', '/api/claims', { handle: fresh('ps'), lines: [{ itemId: item, parts: [{ member: 'A', qty: 1 }] }] }, undefined);
  const sets = (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item);
  for (const s of sets) await api('POST', `/api/admin/sets/${s.id}/secure`, {});
  return { item, sets };
}
const cand = async (key) => (await candidates()).find((c) => c.key === key);

test('candidates: an ordinary item shows once it has CONFIRMED claims — with its proxy and pay-by date (the item\'s own beating its order\'s)', async () => {
  const go = await order({ proxy: 'Order Proxy', paymentDeadline: '2031-05-01' });
  const plain = await normalItem(go), own = await normalItem(go, { proxy: 'Item Proxy', paymentDeadline: '2031-03-01' }), unconfirmed = await normalItem(go), none = await normalItem(go);
  await claimAndSecure(app, admin, fresh(), plain); await claimAndSecure(app, admin, fresh(), plain); await claimAndSecure(app, admin, fresh(), own);
  await api('POST', '/api/claims', { handle: fresh(), lines: [{ itemId: unconfirmed }] }, undefined);
  const p = await cand(`item:${plain}`), o = await cand(`item:${own}`);
  assert.deepEqual([p.proxy, p.deadline, p.count, p.kind, p.roster], ['Order Proxy', '2031-05-01', 2, 'item', null]);
  assert.match(p.label, /Proxy GO \d+ — Proxy item \d+ — 2 confirmed claims/);
  assert.deepEqual([o.proxy, o.deadline, o.count], ['Item Proxy', '2031-03-01', 1]);
  assert.match(o.label, /1 confirmed claim$/, 'singular');
  assert.equal(await cand(`item:${unconfirmed}`), undefined, 'a request is not something to pay for yet');
  assert.equal(await cand(`item:${none}`), undefined);
});

test('candidates: a member set shows once per item with its SECURED sets only — and not once logged, cancelled, or still undecided', async () => {
  const go = await order({ proxy: 'Sam' });
  const { item, sets } = await securedSets(go, 3);
  const c = await cand(`set:${item}`);
  assert.deepEqual([c.count, c.roster, c.kind, c.proxy], [3, 4, 'set', 'Sam']);
  assert.match(c.label, /Proxy set \d+ — 3 secured sets$/);
  await api('POST', `/api/admin/sets/${sets[2].id}/cancel`, {});
  assert.equal((await cand(`set:${item}`)).count, 2, 'a cancelled set is not paid for');
  const undecided = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: `Undecided ${++N}`, price: 1, members: ['A', 'B'] })).json.id;
  await api('POST', '/api/claims', { handle: fresh(), lines: [{ itemId: undecided, parts: [{ member: 'A', qty: 1 }] }] }, undefined);
  assert.equal(await cand(`set:${undecided}`), undefined, 'not secured yet, so nothing to order');
});

test('logging a payment: covers sets and items, creates the proxy once (any capitalisation), and what it covers leaves the candidate list', async () => {
  const go = await order({ proxy: 'Sam' });
  const item = await normalItem(go); await claimAndSecure(app, admin, fresh(), item);
  const { item: setItem } = await securedSets(go, 2);
  const r = await log([`item:${item}`, `set:${setItem}`], { proxy: '  YUKI ', deadline: '2031-06-30' });
  assert.equal(r.status, 201);
  assert.equal(await cand(`item:${item}`), undefined); assert.equal(await cand(`set:${setItem}`), undefined);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM item_sets WHERE item_id = ? AND included_in_proxy_payment = 1", [setItem]))[0].n, 2);
  const [p] = await payments();
  assert.deepEqual([p.id, p.proxy, p.deadline, p.paid, p.overdue, p.summary], [r.json.id, 'YUKI', '2031-06-30', false, false, '2 items'], 'summary defaults to a count');
  assert.deepEqual(p.items.map((i) => i.label.replace(/\d+/g, '#')), ['Proxy GO # — Proxy item # — # claim', 'Proxy GO # — Proxy set # — # sets'], 'an item payment says how many claims it covered; a set payment how many sets');
  const another = await normalItem(go); await claimAndSecure(app, admin, fresh(), another);
  await log([`item:${another}`], { proxy: 'yuki' });
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM proxies WHERE name = 'yuki'"))[0].n, 1, '"yuki" and "YUKI" are the same proxy');
  assert.ok((await api('GET', '/api/admin/proxy/names')).json.names.includes('YUKI'));
});

test('a payment can be logged already paid, with its own summary; it then counts as settled', async () => {
  const go = await order(); const item = await normalItem(go); await claimAndSecure(app, admin, fresh(), item);
  const r = await log([`item:${item}`], { paid: true, summary: '  Run It — 3 albums ' });
  const p = (await payments()).find((x) => x.id === r.json.id);
  assert.deepEqual([p.paid, p.summary], [true, 'Run It — 3 albums']);
});

test('logging needs a proxy, something to cover, and well-formed real keys — and a bad key means NOTHING is logged', async () => {
  const go = await order(); const good = await normalItem(go); await claimAndSecure(app, admin, fresh(), good);
  const before = (await payments()).length;
  assert.equal((await api('POST', '/api/admin/proxy/payments', { keys: [`item:${good}`] })).status, 400, 'a proxy is required');
  assert.equal((await log([])).status, 400);
  assert.equal((await log(['nonsense'])).status, 400); assert.equal((await log(['item:abc'])).status, 400);
  assert.equal((await log([`item:${good}`, 'item:999999'], { proxy: 'Brand New Proxy' })).status, 404);
  const { item: setItem } = await securedSets(go, 1);
  assert.equal((await log([`item:${setItem}`])).status, 400, 'a member set must be logged as a set');
  assert.equal((await log([`set:${good}`])).status, 400, 'and an ordinary item as an item');
  assert.equal((await log([`item:${good}`], { deadline: '31/12/2031' })).status, 400, 'ISO dates');
  assert.equal((await payments()).length, before, 'nothing was logged');
  assert.equal(await cand(`item:${good}`) !== undefined, true, 'the good item is still waiting');
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM proxies WHERE name = 'Brand New Proxy'"))[0].n, 0, 'not even the new proxy name was kept');
});

test('nothing is paid for twice: a logged item or set cannot be logged again, and a second request says why', async () => {
  const go = await order(); const item = await normalItem(go); await claimAndSecure(app, admin, fresh(), item);
  const { item: setItem } = await securedSets(go, 1);
  assert.equal((await log([`item:${item}`, `set:${setItem}`])).status, 201);
  const again = await log([`item:${item}`]);
  assert.equal(again.status, 409); assert.equal(again.json.code, 'already_included'); assert.match(again.json.error, /already in a proxy payment/);
  assert.equal((await log([`set:${setItem}`])).json.code, 'already_included');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM (SELECT set_id FROM proxy_payment_items WHERE set_id IS NOT NULL GROUP BY set_id HAVING COUNT(*) > 1) x'))[0].n, 0);
});

test('a NEW secured set of an item that was logged before shows up on its own — only the new one', async () => {
  const go = await order(); const { item } = await securedSets(go, 2);
  await log([`set:${item}`]);
  assert.equal(await cand(`set:${item}`), undefined);
  await api('POST', '/api/claims', { handle: fresh(), lines: [{ itemId: item, parts: [{ member: 'A', qty: 1 }] }] }, undefined);     // A is taken in both secured sets, so a third set opens (a B would fill an open spot in a secured set)
  const third = (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item && s.decision === 'none');
  await api('POST', `/api/admin/sets/${third[0].id}/secure`, {});
  assert.equal((await cand(`set:${item}`)).count, 1, 'just the one that has not been paid for');
});

test('STRESS: the same item logged by 5 requests at once is logged exactly once', async () => {
  const go = await order(); const item = await normalItem(go); await claimAndSecure(app, admin, fresh(), item);
  const before = (await payments()).length;
  const rs = await Promise.all(Array.from({ length: 5 }, () => log([`item:${item}`])));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  assert.equal((await payments()).length, before + 1);
});

test('the list: newest first, overdue means unpaid AND past its date (due today is not overdue), searchable', async () => {
  const mk = async (deadline, extra = {}) => { const go = await order(); const i = await normalItem(go, { title: `Searchable ${++N}` }); await claimAndSecure(app, admin, fresh(), i); return (await log([`item:${i}`], { deadline, ...extra })).json.id; };
  const late = await mk(iso(4)), today = await mk(iso(0)), future = await mk(iso(-9)), nodate = await mk(undefined), paidLate = await mk(iso(10), { paid: true });
  const list = await payments();
  assert.deepEqual(list.slice(0, 5).map((p) => p.id), [paidLate, nodate, future, today, late], 'newest first');
  const by = Object.fromEntries(list.map((p) => [p.id, p]));
  assert.deepEqual([by[late].overdue, by[late].daysOverdue], [true, 4]);
  for (const id of [today, future, nodate, paidLate]) assert.deepEqual([by[id].overdue, by[id].daysOverdue], [false, 0], `payment ${id}`);
  assert.equal((await payments('searchable')).length >= 5, true);
  assert.equal((await payments('zzz-no-match')).length, 0);
  assert.ok((await payments('SAM')).length >= 1, 'by proxy name, any case');
});

test('editing a payment: tick it paid (and un-tick), move or clear its date, reword it; nothing to change or a missing one is refused', async () => {
  const go = await order(); const item = await normalItem(go); await claimAndSecure(app, admin, fresh(), item);
  const id = (await log([`item:${item}`], { deadline: iso(3) })).json.id;
  const get = async () => (await payments()).find((p) => p.id === id);
  assert.equal((await get()).overdue, true);
  assert.equal((await api('PATCH', `/api/admin/proxy/payments/${id}`, { paid: true })).status, 200);
  assert.deepEqual([(await get()).paid, (await get()).overdue], [true, false]);
  await api('PATCH', `/api/admin/proxy/payments/${id}`, { paid: false, summary: 'Reworded', deadline: iso(-5) });
  assert.deepEqual([(await get()).paid, (await get()).summary, (await get()).deadline, (await get()).overdue], [false, 'Reworded', iso(-5), false]);
  await api('PATCH', `/api/admin/proxy/payments/${id}`, { deadline: null });
  assert.equal((await get()).deadline, null);
  assert.equal((await api('PATCH', `/api/admin/proxy/payments/${id}`, {})).status, 400);
  assert.equal((await api('PATCH', '/api/admin/proxy/payments/999999', { paid: true })).status, 404);
});

test('removing a payment logged by mistake frees its sets and items to be logged again', async () => {
  const go = await order(); const item = await normalItem(go); await claimAndSecure(app, admin, fresh(), item);
  const { item: setItem } = await securedSets(go, 2);
  const id = (await log([`item:${item}`, `set:${setItem}`])).json.id;
  assert.equal(await cand(`item:${item}`), undefined);
  assert.equal((await api('DELETE', `/api/admin/proxy/payments/${id}`)).status, 200);
  assert.equal((await cand(`item:${item}`)).count, 1); assert.equal((await cand(`set:${setItem}`)).count, 2);
  assert.equal((await payments()).some((p) => p.id === id), false);
  assert.equal((await api('DELETE', `/api/admin/proxy/payments/${id}`)).status, 404);
  assert.equal((await log([`item:${item}`, `set:${setItem}`])).status, 201, 'and it can be logged afresh');
});

test('the Overdue list includes proxy payments that are unpaid and past their date — and drops them when paid', async () => {
  const go = await order(); const item = await normalItem(go); await claimAndSecure(app, admin, fresh(), item);
  const id = (await log([`item:${item}`], { proxy: 'Late Proxy', summary: 'Overdue album run', deadline: iso(6) })).json.id;
  let o = (await api('GET', '/api/admin/overdue')).json;
  const row = o.proxy.find((p) => p.id === id);
  assert.deepEqual([row.proxy, row.summary, row.daysOverdue], ['Late Proxy', 'Overdue album run', 6]);
  assert.equal(o.totals.proxyPayments, o.proxy.length);
  await api('PATCH', `/api/admin/proxy/payments/${id}`, { paid: true });
  o = (await api('GET', '/api/admin/overdue')).json;
  assert.equal(o.proxy.some((p) => p.id === id), false);
});

test('proxy payments are for the GOM only', async () => {
  const j = await app.login('proxy.joiner@x.com');
  for (const [m, p, b] of [['GET', '/api/admin/proxy/candidates'], ['GET', '/api/admin/proxy/names'], ['GET', '/api/admin/proxy/payments'], ['POST', '/api/admin/proxy/payments', { proxy: 'x', keys: ['item:1'] }], ['PATCH', '/api/admin/proxy/payments/1', { paid: true }], ['DELETE', '/api/admin/proxy/payments/1']]) {
    assert.equal((await api(m, p, b, j)).status, 403, `${m} ${p}`);
    assert.equal((await app.api(m, p, b)).status, 401, `${m} ${p} signed out`);
  }
});

test('INVARIANTS: every flagged set is in exactly one payment, and every payment row points at a real payment', async () => {
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM item_sets s WHERE s.included_in_proxy_payment = 1 AND (SELECT COUNT(*) FROM proxy_payment_items x WHERE x.set_id = s.id) <> 1'))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM proxy_payment_items x LEFT JOIN proxy_payments p ON p.id = x.proxy_payment_id WHERE p.id IS NULL'))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM (SELECT item_id FROM proxy_payment_items WHERE set_id IS NULL GROUP BY item_id HAVING COUNT(*) > 1) x'))[0].n, 0, 'no ordinary item is in two payments');
});


// ───────── claims that arrive AFTER a payment was logged ─────────
const claimsLeft = async (item) => (await candidates()).find((c) => c.key === `item:${item}`);
const addConfirmed = async (item, n) => { for (let i = 0; i < n; i++) await claimAndSecure(app, admin, fresh('late'), item); };

test('ordinary items: claims confirmed AFTER a payment was logged come back as something new to pay for — only the new ones', async () => {
  const go = await order({ proxy: 'Sam' }); const item = await normalItem(go);
  await addConfirmed(item, 2);
  assert.equal((await claimsLeft(item)).count, 2);
  await log([`item:${item}`]);
  assert.equal(await claimsLeft(item), undefined, 'everything so far is paid for');
  await addConfirmed(item, 3);
  const c = await claimsLeft(item);
  assert.deepEqual([c.count, c.covered], [3, 2], 'just the 3 new ones; the 2 already paid for are not asked for again');
  assert.match(c.label, /— 3 more confirmed claims \(2 already paid for\)$/);
  const second = await log([`item:${item}`], { summary: 'Top-up' });
  assert.equal(second.status, 201);
  assert.equal(await claimsLeft(item), undefined);
  const labels = (await payments()).filter((p) => p.items.some((i) => i.itemId === item)).flatMap((p) => p.items.map((i) => i.label.replace(/^.* — /, '')));
  assert.deepEqual(labels.sort(), ['2 claims', '3 claims'], 'each payment remembers how many claims it covered');
  const again = await log([`item:${item}`]);
  assert.equal(again.status, 409); assert.match(again.json.error, /no new confirmed claims since/);
  assert.equal((await app.q('SELECT SUM(claim_count) AS n FROM proxy_payment_items WHERE item_id = ?', [item]))[0].n, 5);
});

test('requests that are not confirmed yet do not count — they appear once they are secured', async () => {
  const go = await order(); const item = await normalItem(go);
  await addConfirmed(item, 1); await log([`item:${item}`]);
  const handle = fresh('pend');
  await api('POST', '/api/claims', { handle, lines: [{ itemId: item }] }, undefined);
  assert.equal(await claimsLeft(item), undefined, 'a request is not something to pay for yet');
  await api('POST', '/api/admin/claims/secure', { orderId: go });
  assert.equal((await claimsLeft(item)).count, 1, 'now it is');
});

test('a cancelled claim never creates a phantom: units you have already paid your proxy for are reused by later claims', async () => {
  const go = await order(); const item = await normalItem(go);
  const ids = []; for (let i = 0; i < 3; i++) ids.push((await claimAndSecure(app, admin, fresh('cx'), item))[0]);
  await log([`item:${item}`]);                                                    // 3 units paid for
  await api('PATCH', `/api/admin/claims/${ids[0]}`, { status: 'cancelled' });       // one person drops out
  assert.equal(await claimsLeft(item), undefined, '2 confirmed claims, 3 units paid for: nothing to pay');
  await addConfirmed(item, 1);
  assert.equal(await claimsLeft(item), undefined, 'a replacement uses the spare unit you already paid for');
  await addConfirmed(item, 1);
  assert.equal((await claimsLeft(item)).count, 1, 'only the one beyond the 3 paid for');
});

test('removing a payment returns exactly what it covered', async () => {
  const go = await order(); const item = await normalItem(go);
  await addConfirmed(item, 2); const first = (await log([`item:${item}`])).json.id;
  await addConfirmed(item, 3); const second = (await log([`item:${item}`])).json.id;
  assert.equal(await claimsLeft(item), undefined);
  await api('DELETE', `/api/admin/proxy/payments/${second}`);
  assert.equal((await claimsLeft(item)).count, 3, 'the 3 the second payment covered');
  await api('DELETE', `/api/admin/proxy/payments/${first}`);
  assert.deepEqual([(await claimsLeft(item)).count, (await claimsLeft(item)).covered], [5, 0]);
});

test('payments logged BEFORE this change are treated as covering what the item had then (the migration\'s backfill)', async () => {
  const go = await order(); const item = await normalItem(go);
  await addConfirmed(item, 3); await log([`item:${item}`]);
  await app.q('UPDATE proxy_payment_items SET claim_count = NULL WHERE item_id = ? AND set_id IS NULL', [item]);        // how old rows look
  assert.equal((await claimsLeft(item)).count, 3, 'without the backfill an old payment would cover nothing');
  const fs = await import('node:fs'); const path = await import('node:path');
  const sql = fs.readFileSync(path.join(import.meta.dirname, '../../db/migrations/009_proxy_claim_count.sql'), 'utf8');
  const backfill = sql.split(';').map((x) => x.trim()).find((x) => /^UPDATE/m.test(x.replace(/^--.*$/gm, '').trim()));
  await app.q(backfill.replace(/^--.*$/gm, '').trim());
  assert.equal(await claimsLeft(item), undefined, 'after the backfill, the old payment covers the 3 claims it was logged for');
  await addConfirmed(item, 1);
  assert.equal((await claimsLeft(item)).count, 1, 'and a claim made since shows up');
});

test('STRESS: with 2 new claims waiting, 5 simultaneous requests to log the item log it once — and cover exactly those 2', async () => {
  const go = await order(); const item = await normalItem(go);
  await addConfirmed(item, 1); await log([`item:${item}`]); await addConfirmed(item, 2);
  const rs = await Promise.all(Array.from({ length: 5 }, () => log([`item:${item}`])));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  assert.equal((await app.q('SELECT SUM(claim_count) AS n FROM proxy_payment_items WHERE item_id = ?', [item]))[0].n, 3, '1 + 2, never double-counted');
});
