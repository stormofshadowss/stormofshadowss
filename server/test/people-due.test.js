import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// GOM → People → look up a person: "what is due and why", worked out from the SAME numbers the joiner's dashboard shows, with plain-words reasons (and what is NOT counted).
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); await app.q("INSERT IGNORE INTO payment_methods (method, account_info) VALUES ('PayPal', 'pay@example.com')"); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'pd') => `${x}${++N}`;
const goOrder = async (title = u('Due GO '), deadline = '2099-01-01') => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam', paymentDeadline: deadline })).json.id;
const item = async (go, price, title = u('Thing ')) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price })).json.id;
async function person(...handles) { const email = `${u('p')}@x.com`; const cookie = await joinerSession(app, email, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200); return { cookie, handles, email }; }
const due = async (h) => (await api('GET', `/api/admin/people/${encodeURIComponent(h)}/due`)).json;
const send = async (c, h, amount, extra = {}) => (await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount, reference: u('TXN'), ...extra }, c)).json;
const verify = (id) => api('POST', `/api/admin/payments/${id}/verify`, {});

test('THE BASICS: what they owe, across how many items and group orders, what it is made up of, and (with nothing late) the earliest due date', async () => {
  const { cookie, handles } = await person(u('basic')); const [h] = handles; const g = await goOrder('Skzoo Pop-up', '2099-03-04'); const a = await item(g, 12, 'Plush'), b = await item(g, 8, 'Keyring');
  const [ca] = await claimAndSecure(app, admin, h, a); await claimAndSecure(app, admin, h, b); await api('PATCH', `/api/admin/claims/${ca}`, { costs: { ems: { cost: 4 }, customs: { cost: 3 } } }); void cookie;
  const d = await due(h); assert.deepEqual([d.owedTotal, d.overdueTotal, d.items.length, d.many], [27, 0, 2, false]); assert.deepEqual([d.byCategory.initials, d.byCategory.ems, d.byCategory.customs], [20, 4, 3]);
  assert.equal(d.explanation[0], `@${h} owes £27.00 now, across 2 items on 1 group order.`); assert.equal(d.explanation[1], 'That is made up of £20.00 item cost, £4.00 EMS, £3.00 customs.'); assert.equal(d.explanation[2], 'Nothing is overdue yet — the earliest due date is 04/03/2099.');
  const plush = d.items.find((i) => i.label === 'Plush'); assert.deepEqual([plush.order, plush.owed, plush.owedBy.ems, plush.payBy, plush.overdue], ['Skzoo Pop-up', 19, 4, '2099-03-04', false]);
});

test('OVERDUE IS EXPLAINED PER GROUP ORDER: how much, which order, when it was due, and how long ago', async () => {
  const { handles } = await person(u('late')); const [h] = handles; const late = await goOrder('Old Fansign', '2000-01-01'), fine = await goOrder('New Pop-up', '2099-01-01'); await claimAndSecure(app, admin, h, await item(late, 10)); await claimAndSecure(app, admin, h, await item(fine, 5));
  const d = await due(h); assert.deepEqual([d.owedTotal, d.overdueTotal], [15, 10]); const line = d.explanation.find((l) => /overdue on/.test(l)); assert.match(line, /^£10\.00 is overdue on “Old Fansign”: it was due 01\/01\/2000 \(\d+ days ago\)\.$/);
  assert.equal(d.items.find((i) => i.order === 'Old Fansign').overdue, true); assert.ok(d.items.find((i) => i.order === 'Old Fansign').daysLate > 9000); assert.equal(d.items.find((i) => i.order === 'New Pop-up').overdue, false);
});

test('WHAT IS NOT COUNTED IS SAID: requests, a payment still waiting (and what they would owe once verified), failed and rejected payments', async () => {
  const { cookie, handles } = await person(u('notc')); const [h] = handles; const g = await goOrder(); await claimAndSecure(app, admin, h, await item(g, 20));
  await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: await item(g, 6, 'Only requested') }, { itemId: await item(g, 4, 'Also requested') }] });
  const waiting = await send(cookie, h, 5, { reference: 'WAIT-1' }); const d = await due(h);
  assert.deepEqual([d.requested.count, d.requested.total, d.owedTotal], [2, 10, 20], 'the two requests are not owed');
  assert.ok(d.explanation.some((l) => /^2 items they have only requested \(£10\.00\) aren't owed yet — a request only counts once you've secured it\.$/.test(l)));
  assert.ok(d.explanation.some((l) => /^A £5\.00 payment sent \d\d\/\d\d\/\d{4} \(PayPal, ref WAIT-1\) is still waiting for you to verify, so it is NOT counted yet\.$/.test(l))); assert.ok(d.explanation.includes('Once it is verified they would owe about £15.00.'));
  const rej = await send(cookie, h, 3, { reference: 'REJ-1' }); await api('POST', `/api/admin/payments/${rej.id}/reject`, {}); assert.ok((await due(h)).explanation.some((l) => /^A £3\.00 payment from .* was rejected, so it was never counted\.$/.test(l)));
  assert.equal((await verify(waiting.id)).status, 200); const ok = await send(cookie, h, 4, { reference: 'FAIL-1' }); await verify(ok.id); await api('POST', `/api/admin/payments/${ok.id}/reverse`, { reason: 'Bank transfer bounced' });
  const d2 = await due(h); assert.ok(d2.explanation.some((l) => /^A £4\.00 payment from .* was marked as failed on .* \(Bank transfer bounced\) — what it paid is owed again\.$/.test(l))); assert.equal(d2.payments.failed[0].reason, 'Bank transfer bounced'); assert.equal(d2.owedTotal, 15, '£20 − the £5 payment that WAS verified (the failed one is owed again)');
});

test('CREDIT IS EXPLAINED, and a person with several handles is explained across all of them with each handle\'s own figures', async () => {
  const { handles } = await person(u('ha'), u('hb')); const [a, b] = handles; const g = await goOrder(); await claimAndSecure(app, admin, a, await item(g, 10)); await claimAndSecure(app, admin, b, await item(g, 6));
  await api('POST', '/api/admin/credit/add', { handle: a, amount: 2, reason: 'Goodwill' }); const d = await due(b);                                    // asking about EITHER handle gives the whole person
  assert.equal(d.many, true); assert.deepEqual(d.handles.map((x) => x.handle), [a, b]); assert.equal(d.explanation[0], `Across their handles they owe £14.00 now, across 2 items on 1 group order.`);
  assert.deepEqual(d.perHandle.map((x) => [x.handle, x.owed]), [[a, 8], [b, 6]]); assert.equal(d.items.length, 2); assert.equal(d.credit.total, 0, 'the £2 credit was already used on what they owe');
  assert.ok(d.credit.recent.some((r) => r.kind === 'applied'), 'and the activity shows it was applied');
  await api('POST', '/api/admin/credit/add', { handle: a, amount: 50, reason: 'Big credit' }); const d2 = await due(a); assert.equal(d2.owedTotal, 0, 'a big credit paid everything'); assert.ok(d2.explanation.some((l) => /^£\d+\.\d\d credit is held \(@.*\) — it is applied automatically to anything they owe\.$/.test(l)));
});

test('IT AGREES WITH THE JOINER\'S OWN DASHBOARD: the same totals per handle, the same overdue flags, with overdue items, part-payments and credit all in play', async () => {
  const { cookie, handles } = await person(u('ha'), u('hb')); const [a, b] = handles; const late = await goOrder('Late GO', '2000-06-01'), fine = await goOrder('Fine GO', '2099-06-01');
  await claimAndSecure(app, admin, a, await item(late, 14)); await claimAndSecure(app, admin, a, await item(fine, 9)); await claimAndSecure(app, admin, b, await item(late, 7)); await claimAndSecure(app, admin, b, await item(fine, 3));
  const p = await send(cookie, a, 5, { reference: 'PART-1' }); await verify(p.id);                                                                         // part-paid
  const own = (await api('GET', '/api/my/summary?handle=all', undefined, cookie)).json; const d = await due(a);
  assert.equal(d.owedTotal, own.owed.total, 'the same total'); assert.deepEqual(d.perHandle.map((h) => [h.handle, h.owed]), own.handles.map((h) => [h.handle, h.owed]), 'the same per handle');
  const flagged = (summary) => summary.orders.flatMap((o) => o.claims).filter((c) => c.owed > 0).map((c) => [c.id, c.overdue]).sort((x, y) => x[0] - y[0]);
  assert.deepEqual(d.items.map((i) => [i.claimId, i.overdue]).sort((x, y) => x[0] - y[0]), flagged(own), 'the same items flagged overdue');
  assert.equal(d.overdueTotal, own.orders.flatMap((o) => o.claims).filter((c) => c.overdue).reduce((n, c) => n + c.owed, 0), 'the same overdue total');
});

test('A PERSON WHO HAS NEVER SIGNED IN (an imported handle) is explained too, and the line says they have no dashboard yet', async () => {
  const h = u('imported'); await app.q('INSERT INTO joiners (instagram_handle) VALUES (?)', [h]); const g = await goOrder(); await api('POST', '/api/admin/claims/add', { handle: h, status: 'confirmed', lines: [{ itemId: await item(g, 11) }] });
  const d = await due(h); assert.deepEqual([d.accountId, d.email, d.owedTotal], [null, null, 11]); assert.ok(d.explanation.includes("They haven't signed in yet, so there is no dashboard to view — this is what they would see."));
});

test('BLOCKED HANDLES ARE MENTIONED; nothing owed says so; other people are never mixed in; unknown → 404; handles are tolerant (@, case); GOM only; the lookup is recorded', async () => {
  const { handles } = await person(u('bl')); const [h] = handles; assert.equal((await due(h)).explanation[0], `@${h} owes nothing right now.`); await app.q('UPDATE joiners SET is_blocked = 1 WHERE instagram_handle = ?', [h]); assert.ok((await due(h)).explanation.includes(`@${h} is blocked.`));
  const other = await person(u('oth')); await claimAndSecure(app, admin, other.handles[0], await item(await goOrder(), 9)); assert.equal((await due(h)).owedTotal, 0, 'someone else\'s money never leaks in');
  const r = await api('GET', `/api/admin/people/${encodeURIComponent(`@${h.toUpperCase()}`)}/due`); assert.equal(r.status, 200); assert.equal(r.json.handle, h); assert.equal((await api('GET', '/api/admin/people/nobody-here-xyz/due')).status, 404);
  const j = await app.login(`${u('jj')}@x.com`); assert.equal((await api('GET', `/api/admin/people/${h}/due`, undefined, j)).status, 403); assert.equal((await app.api('GET', `/api/admin/people/${h}/due`)).status, 401);
  const log = (await app.q("SELECT detail FROM audit_log WHERE action = 'people.lookup' ORDER BY id DESC LIMIT 1"))[0]; assert.match(String(log.detail), new RegExp(`"handle":"${h}"`));
});
