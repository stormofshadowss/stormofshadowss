import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// A FEE (EMS, customs, postage, packaging) has its OWN due date, picked by the GOM when it is added — a fee added today is never "overdue" because of the item's old pay-by date.
// The item cost still follows the claim's pay-by date. "Overdue" is worked out line by line everywhere: the joiner's dashboard, the GOM's Overdue tab, the people lookup, the reminder emails, and which debt a payment clears first.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'fd') => `${x}${++N}`;
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);            // the server runs in UTC, as does this; whole days, never near midnight edges
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => app.notifier.idle();
const goOrder = async (deadline, title = u('Fee GO ')) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam', ...(deadline ? { paymentDeadline: deadline } : {}) })).json.id;
const item = async (go, price = 10, title = u('Thing ')) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price })).json.id;
const person = async () => { const h = u('fp'); const cookie = await joinerSession(app, `${h}@x.com`, h); await app.api('PUT', '/api/my/notifications', { enabled: true }, cookie); return { h, cookie, email: `${h}@x.com` }; };          // opted in to emails, like a joiner who wants reminders
const costs = (id, c) => api('PATCH', `/api/admin/claims/${id}`, { costs: c });
const secure = async (h, itemId) => (await claimAndSecure(app, admin, h, itemId))[0];
const dash = async (p) => { const r = (await api('GET', `/api/my/summary?handle=${p.h}`, undefined, p.cookie)).json; return r.orders.flatMap((o) => o.claims); };
const overdueOf = async (h) => (await api('GET', '/api/admin/overdue')).json.payments.filter((r) => r.handle === h);
const lookup = async (h) => (await api('GET', `/api/admin/people/${encodeURIComponent(h)}/due`)).json;
const feeRow = async (claimId, cat) => (await app.q('SELECT cost, paid, due_date AS due FROM claim_costs WHERE claim_id = ? AND category = ?', [claimId, cat]))[0];
const mails = (email) => app.mailer.outbox.filter((m) => m.to === email && /friendly reminder/.test(m.subject));

test('THE REPORTED PROBLEM: a fee added to an old, already-paid claim is NOT overdue — not on the joiner\'s dashboard, not in your Overdue tab, not in the people lookup, and no reminder email', async () => {
  const p = await person(); const go = await goOrder(day(-30)); const c = await secure(p.h, await item(go, 10)); await costs(c, { initials: { cost: 10, paid: 10 } });
  await costs(c, { ems: { cost: 4, dueDate: day(10) } }); const [claim] = await dash(p);
  assert.deepEqual([claim.owed, claim.overdue, claim.overdueOwed, claim.payBy], [4, false, 0, day(10)], 'the joiner sees £4 to pay by a date 10 days away — not "overdue"'); assert.deepEqual([claim.costs.ems.due, claim.costs.ems.overdue], [day(10), false]);
  assert.deepEqual(await overdueOf(p.h), [], 'not in your Overdue tab'); const d = await lookup(p.h); assert.deepEqual([d.owedTotal, d.overdueTotal], [4, 0]); assert.match(d.explanation.join(' '), /Nothing is overdue yet — the earliest due date is/);
  const before = mails(p.email).length; await app.notifier.sendOverdueReminders(); await settle(); assert.equal(mails(p.email).length, before, 'and no overdue email goes out');
});

test('MIXED: when the item cost IS overdue and a fee is not, only the item cost is called overdue (the amount, the notice and the lines say so)', async () => {
  const p = await person(); const go = await goOrder(day(-30)); const c = await secure(p.h, await item(go, 10)); await costs(c, { ems: { cost: 4, dueDate: day(10) } });
  const [claim] = await dash(p); assert.deepEqual([claim.owed, claim.overdue, claim.overdueOwed], [14, true, 10], '£10 overdue of £14'); assert.equal(claim.payBy, day(-30), 'the date shown is the one that is overdue'); assert.deepEqual([claim.costs.initials.overdue, claim.costs.ems.overdue], [true, false]);
  const [row] = await overdueOf(p.h); assert.deepEqual([row.owed, row.feesOwed], [10, 0], 'your Overdue tab: £10, none of it fees'); assert.equal((await lookup(p.h)).overdueTotal, 10);
});

test('A FEE BECOMES OVERDUE ONCE ITS OWN DUE DATE HAS PASSED — and then it is counted (amount, fees part, lookup)', async () => {
  const p = await person(); const go = await goOrder(day(-30)); const c = await secure(p.h, await item(go, 10)); await costs(c, { initials: { cost: 10, paid: 10 } }); await costs(c, { ems: { cost: 4, dueDate: day(-3) } });
  const [claim] = await dash(p); assert.deepEqual([claim.overdue, claim.overdueOwed, claim.payBy, claim.costs.ems.overdue], [true, 4, day(-3), true]); const [row] = await overdueOf(p.h); assert.deepEqual([row.owed, row.feesOwed, row.daysOverdue], [4, 4, 3]);
  const d = await lookup(p.h); assert.equal(d.overdueTotal, 4); assert.match(d.explanation.join(' '), /£4\.00 is overdue on “.+”: it was due \d\d\/\d\d\/\d{4} \(3 days ago\)/);
});

test('THE DATE: you pick it; raising a fee without one keeps the date it has, or gives the default (14 days); lowering keeps it; null clears it (never overdue); the item cost ignores it; bad dates are refused', async () => {
  const p = await person(); const go = await goOrder(day(-30)); const c = await secure(p.h, await item(go, 10)); await costs(c, { initials: { cost: 10, paid: 10 } });
  await costs(c, { doms: { cost: 6 } }); const first = (await feeRow(c, 'doms')).due; assert.ok(first >= day(13) && first <= day(15), `no date given → about 14 days ahead (${first})`); assert.equal((await dash(p))[0].overdue, false);
  await costs(c, { doms: { cost: 9 } }); assert.equal((await feeRow(c, 'doms')).due, first, 'raised again without a date: keeps the date it has');
  await costs(c, { doms: { cost: 9, dueDate: day(30) } }); assert.equal((await feeRow(c, 'doms')).due, day(30), 'a date you pick always wins'); await costs(c, { doms: { cost: 7 } }); assert.equal((await feeRow(c, 'doms')).due, day(30), 'lowering the fee keeps its date');
  await costs(c, { doms: { dueDate: day(40) } }); assert.deepEqual([(await feeRow(c, 'doms')).due, Number((await feeRow(c, 'doms')).cost)], [day(40), 7], 'changing only the date leaves the amount');
  await costs(c, { doms: { dueDate: null } }); assert.equal((await feeRow(c, 'doms')).due, null, 'cleared'); assert.equal((await dash(p))[0].overdue, false, 'no date = never overdue');
  await costs(c, { initials: { cost: 10, dueDate: day(-9) } }); assert.equal((await feeRow(c, 'initials')).due, null, 'the item cost has no date of its own: it follows the claim pay-by');
  const bad = await api('PATCH', `/api/admin/claims/${c}`, { costs: { ems: { cost: 1, dueDate: '03/11/2026' } } }); assert.equal(bad.status, 400); assert.equal((await feeRow(c, 'ems')).cost, 0, 'nothing changed');
});

test('PACKING FEES: postage and packaging saved with a due date give that date to the fee lines of the claims in the parcel only; saving again with a new date moves it; without a date it keeps it', async () => {
  const p = await person(); await api('PUT', '/api/my/address', { fullName: 'Fee Person', address: '12 Test Street, Leeds, LS1 1AA', email: p.email, phone: '07700 900123' }, p.cookie); const go = await goOrder(day(-30)); const ids = [];
  for (let i = 0; i < 2; i++) { const [id] = await claimAndSecure(app, admin, p.h, await item(go, 5)); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' }); ids.push(id); }
  const outside = await secure(p.h, await item(go, 5)); const made = await api('POST', '/api/my/parcels', { claimIds: ids, method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p.cookie); assert.equal(made.status, 201, made.text);
  const fees = (b) => api('POST', `/api/admin/parcels/${made.json.id}/fees`, b); assert.equal((await fees({ doms: 6, packaging: 2, dueDate: day(9) })).status, 200);
  for (const id of ids) for (const cat of ['doms', 'packaging']) assert.equal((await feeRow(id, cat)).due, day(9), `${cat} on claim ${id}`); assert.equal((await feeRow(outside, 'doms')).due, null, 'a claim not in the parcel is untouched');
  assert.equal((await fees({ doms: 6, packaging: 2, dueDate: day(20) })).status, 200); assert.equal((await feeRow(ids[0], 'doms')).due, day(20), 'same amounts, new date: the date moves'); assert.equal((await feeRow(ids[0], 'doms')).cost, 3, 'and the amount did not double');
  assert.equal((await fees({ doms: 8, packaging: 2 })).status, 200); assert.equal((await feeRow(ids[0], 'doms')).due, day(20), 'raised without a date: keeps its date'); assert.equal((await fees({ doms: 1, dueDate: 'tomorrow' })).status, 400);
  const mine = (await dash(p)).filter((c) => ids.includes(c.id)); assert.ok(mine.every((c) => c.costs.doms.due === day(20) && !c.costs.doms.overdue));
});

test('BOX EMS AND CUSTOMS: a box created with a due date gives it to the EMS and customs lines of its claims; customs added later takes its own date', async () => {
  const p = await person(); const go = await goOrder(day(-30)); const ids = [];
  for (let i = 0; i < 2; i++) { const [id] = await claimAndSecure(app, admin, p.h, await item(go, 10)); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'arrived at proxy / warehouse', weightG: 300 }); ids.push(id); }
  const box = await api('POST', '/api/admin/boxes', { claimIds: ids, emsTotal: 12, customsTotal: 6, dueDate: day(8) }); assert.equal(box.status, 201, box.text);
  for (const id of ids) { assert.equal((await feeRow(id, 'ems')).due, day(8)); assert.equal((await feeRow(id, 'customs')).due, day(8)); }
  const c2 = await api('POST', `/api/admin/boxes/${box.json.id}/customs`, { customsTotal: 10, dueDate: day(15) }); assert.equal(c2.status, 200, c2.text); for (const id of ids) { assert.equal((await feeRow(id, 'customs')).due, day(15), 'customs: its own date'); assert.equal((await feeRow(id, 'ems')).due, day(8), 'EMS untouched'); }
  assert.equal((await dash(p)).every((c) => c.costs.ems.overdue === false && c.costs.customs.overdue === false), true, 'nothing overdue just because the item\'s date is old');
});

test('WHICH DEBT A PAYMENT CLEARS FIRST follows each LINE\'s date: an overdue item cost, then a fee due soon, before an item cost that is not due for weeks', async () => {
  const p = await person(); const soon = await goOrder(day(40)), late = await goOrder(day(-3)); const a = await secure(p.h, await item(soon, 10)), b = await secure(p.h, await item(late, 5)); await costs(a, { ems: { cost: 3, dueDate: day(5) } });
  const pay = async (amount) => { const r = await api('POST', `/api/my/payments?handle=${p.h}`, { method: 'PayPal', amount, reference: u('TXN') }, p.cookie); assert.equal(r.status, 201, r.text); assert.equal((await api('POST', `/api/admin/payments/${r.json.id}/verify`, {})).status, 200); };
  await pay(8); assert.deepEqual([Number((await feeRow(b, 'initials')).paid), Number((await feeRow(a, 'ems')).paid), Number((await feeRow(a, 'initials')).paid)], [5, 3, 0], '£5 overdue item, then the £3 fee (due in 5 days) — the £10 item (due in 40 days) waits');
  await pay(10); assert.equal(Number((await feeRow(a, 'initials')).paid), 10);
});

test('REMINDER EMAILS: an overdue ITEM COST and an overdue FEE are reminded about separately (one each, per claim, never repeated); a fee that is not yet due is never mentioned', async () => {
  const p = await person(); const go = await goOrder(day(-5)); const c = await secure(p.h, await item(go, 10)); await costs(c, { ems: { cost: 4, dueDate: day(-1) }, customs: { cost: 2, dueDate: day(20) } }); const before = mails(p.email).length;
  const r = await app.notifier.sendOverdueReminders(); await settle(); assert.equal(r.emails >= 1, true); const m = mails(p.email)[before]; assert.match(m.text, /• Thing \d+ — £10\.00 still to pay \(was due \d\d\/\d\d\/\d{4}\)/); assert.match(m.text, /• Thing \d+ — £4\.00 in postage \/ fees still to pay \(was due \d\d\/\d\d\/\d{4}\)/); assert.doesNotMatch(m.text, /£2\.00/, 'the customs fee is not due yet');
  assert.equal(mails(p.email).length, before + 1, 'one email'); assert.deepEqual((await app.q("SELECT kind FROM notification_log WHERE ref_id = ? AND kind LIKE 'overdue%' ORDER BY kind", [c])).map((x) => x.kind), ['overdue_fee_reminder', 'overdue_reminder']);
  assert.equal((await app.notifier.sendOverdueReminders()).emails, 0, 'never repeated'); await costs(c, { customs: { dueDate: day(-1) } }); const again = await app.notifier.sendOverdueReminders(); await settle(); assert.equal(again.emails, 0, 'the claim has had its fee reminder already: one per claim');
});

test('A FEE-ONLY REMINDER: a claim whose item cost is paid but whose fee is overdue gets a fee reminder (and the item cost is not mentioned)', async () => {
  const p = await person(); const go = await goOrder(day(-30)); const c = await secure(p.h, await item(go, 10)); await costs(c, { initials: { cost: 10, paid: 10 } }); await costs(c, { doms: { cost: 6, dueDate: day(-2) } }); const before = mails(p.email).length;
  await app.notifier.sendOverdueReminders(); await settle(); const m = mails(p.email)[before]; assert.ok(m, 'an email'); assert.match(m.text, /— £6\.00 in postage \/ fees still to pay/); assert.doesNotMatch(m.text, /£10\.00/);
});

test('FEES ALREADY ADDED WHEN THIS GOES LIVE get a fresh due date (14 days on): the migration\'s own update, run on old-style rows — unpaid fees only, never the item cost', async () => {
  const p = await person(); const go = await goOrder(day(-30)); const c = await secure(p.h, await item(go, 10)); await app.q("UPDATE claim_costs SET cost = 5, due_date = NULL WHERE claim_id = ? AND category = 'ems'", [c]); await app.q("UPDATE claim_costs SET cost = 3, paid = 3, due_date = NULL WHERE claim_id = ? AND category = 'customs'", [c]);
  const sql = fs.readFileSync(new URL('../../db/migrations/034_fee_due_dates.sql', import.meta.url), 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n').split(';').map((s) => s.trim()).find((s) => /^UPDATE claim_costs/i.test(s)); assert.ok(sql, 'the migration has the backfill');
  await app.q(sql); const ems = (await feeRow(c, 'ems')).due, customs = (await feeRow(c, 'customs')).due, init = (await feeRow(c, 'initials')).due; assert.ok(ems >= day(13) && ems <= day(15), `unpaid fee: a fresh date (${ems})`); assert.equal(customs, null, 'a fee that is fully paid is left alone'); assert.equal(init, null, 'the item cost has no date of its own');
  const [claim] = await dash(p); assert.equal(claim.costs.ems.overdue, false);
});
