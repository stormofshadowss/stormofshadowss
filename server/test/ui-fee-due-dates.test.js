import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage, gomPage, modal, press } from './ui.helpers.js';

// A FEE (EMS, customs, postage, packaging) has its OWN due date. Joiner side: a fee added today is not "overdue" because of an old item date, and each fee line shows when it is due.
// GOM side: you pick the date each time you add a fee (Edit costs, packing fees, warehouse boxes), and the Overdue tab says how much of an overdue amount is fees.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'uf') => `${x}${++N}`;
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const uk = (ymd) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
const goOrder = async (deadline) => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Fee UI GO '), proxy: 'Sam', ...(deadline ? { paymentDeadline: deadline } : {}) })).json.id;
const item = async (go, price = 10) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Thing '), price })).json.id;
const feeRow = async (claimId, cat) => (await app.q('SELECT cost, due_date AS due FROM claim_costs WHERE claim_id = ? AND category = ?', [claimId, cat]))[0];
const settle = async (p, ms = 350) => { await sleep(ms); await p.settle(); };
// a joiner with one claim on an order whose pay-by passed 30 days ago
async function oldClaim({ paid = false, fee = null } = {}) {
  const h = u('jf'); const cookie = await joinerSession(app, `${h}@x.com`, h); const go = await goOrder(day(-30)); const [id] = await claimAndSecure(app, admin, h, await item(go, 10));
  const costs = {}; if (paid) costs.initials = { cost: 10, paid: 10 }; if (fee) costs[fee.cat] = { cost: fee.cost, dueDate: fee.due }; if (Object.keys(costs).length) await api('PATCH', `/api/admin/claims/${id}`, { costs });
  return { h, cookie, id };
}
const mine = async (j, hash = '#/ongoing') => { const p = await openPage(app, '/my.html', { cookies: [j.cookie] }); await sleep(300); await p.settle(); p.window.location.hash = hash; await sleep(80); await p.settle(); return p; };
const pill = (p, re) => p.qa('.pill').find((x) => re.test(p.text(x)));

test('JOINER — THE REPORTED PROBLEM: an EMS fee added to an old, already-paid claim shows when it is due, in amber — no overdue notice, no overdue flag', async () => {
  const j = await oldClaim({ paid: true, fee: { cat: 'ems', cost: 4, due: day(10) } }); const home = await mine(j, '#/');
  assert.equal(home.q('[data-overdue-notice]'), null, 'no red "You have overdue payments" notice'); home.close();
  const p = await mine(j); const ems = pill(p, /^EMS £4\.00/); assert.ok(ems, 'the EMS pill'); assert.match(p.text(ems), new RegExp(`^EMS £4\\.00 · £4\\.00 to pay by ${uk(day(10))}$`)); assert.ok(ems.classList.contains('warn') && !ems.classList.contains('err'), 'amber, not red');
  assert.equal(p.qa('.pill.err').some((x) => /overdue/.test(p.text(x))), false, 'no overdue flag'); assert.equal(p.q('.itemrow.overdue'), null); assert.match(p.text(p.q('#view')), new RegExp(`pay by ${uk(day(10))}`)); assert.deepEqual([p.errors], [[]]); p.close();
});

test('JOINER — ONLY WHAT IS REALLY OVERDUE IS CALLED OVERDUE: an overdue item cost with a fee not yet due says £10 is overdue (not £14); the item pill is red and the fee pill amber', async () => {
  const j = await oldClaim({ fee: { cat: 'ems', cost: 4, due: day(10) } }); const home = await mine(j, '#/'); const n = home.q('[data-overdue-notice]'); assert.ok(n); assert.match(home.text(n), /£10\.00 is overdue across 1 item/); assert.doesNotMatch(home.text(n), /£14\.00/); home.close();
  const p = await mine(j); assert.ok(pill(p, /^Initials £10\.00/).classList.contains('err'), 'the item cost: red'); assert.ok(pill(p, /^EMS £4\.00/).classList.contains('warn') && !pill(p, /^EMS £4\.00/).classList.contains('err'), 'the fee: amber'); assert.match(p.text(p.q('[data-go-overdue]')), /1 overdue · £10\.00/); p.close();
});

test('JOINER — A FEE IS OVERDUE ONCE ITS OWN DATE HAS PASSED: the fee pill turns red and the notice counts it', async () => {
  const j = await oldClaim({ paid: true, fee: { cat: 'doms', cost: 6, due: day(-2) } }); const home = await mine(j, '#/'); assert.match(home.text(home.q('[data-overdue-notice]')), /£6\.00 is overdue across 1 item/); home.close();
  const p = await mine(j); const doms = pill(p, /^Doms/); assert.ok(doms.classList.contains('err')); assert.match(p.text(doms), new RegExp(`£6\\.00 to pay by ${uk(day(-2))}`)); assert.ok(p.qa('.pill.err').some((x) => /^overdue$/.test(p.text(x))), 'and the claim is flagged overdue'); p.close();
});

test('GOM — EDIT COSTS: a "Due by" date for each fee (suggested 14 days ahead for a new fee, the existing date for one that has it, blank for an old undated one); the item cost says it follows the pay-by date', async () => {
  const j = await oldClaim({ paid: true, fee: { cat: 'ems', cost: 4, due: day(9) } }); await api('PATCH', `/api/admin/claims/${j.id}`, { costs: { customs: { cost: 2, dueDate: null } } });
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); await settle(p, 300); await p.type(p.q('[data-filter="q"]'), j.h); await p.settle(); await p.click(p.q(`[data-act="edit"][data-id="${j.id}"]`)); const f = p.q('form[data-form="edit-costs"]');
  assert.match(p.text(f.querySelector('.cost-edit')), /Cost \(£\)\s*Paid \(£\)\s*Due by/); assert.match(p.text(f), /pay-by date/); assert.deepEqual(['ems', 'customs', 'doms', 'packaging'].map((k) => f.elements[`${k}_due`].type), ['date', 'date', 'date', 'date'], 'a real date picker for each fee'); assert.equal(f.elements.ems_due.value, day(9), 'the date it has'); assert.equal(f.elements.customs_due.value, '', 'an old undated fee: blank (not silently dated)'); assert.equal(f.elements.doms_due.value, day(14), 'a new fee: suggested 14 days ahead'); assert.equal(f.elements.initials_due, undefined);
  assert.match(p.text(f), /Each fee has its own due date — it is only called overdue once that date has passed/); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('GOM — RAISING A FEE SAVES ITS DATE; a fee with no date is refused with a message (nothing saved); changing only the date works; an unrelated edit does not stamp a date onto an undated fee', async () => {
  const j = await oldClaim({ paid: true }); await api('PATCH', `/api/admin/claims/${j.id}`, { costs: { customs: { cost: 2, dueDate: null } } });
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); await settle(p, 300); await p.type(p.q('[data-filter="q"]'), j.h); await p.settle(); const edit = async () => { await p.click(p.q(`[data-act="edit"][data-id="${j.id}"]`)); return p.q('form[data-form="edit-costs"]'); };
  let f = await edit(); f.elements.ems_cost.value = '5'; f.elements.ems_due.value = day(12); await p.submit(f); await settle(p); assert.deepEqual([Number((await feeRow(j.id, 'ems')).cost), (await feeRow(j.id, 'ems')).due], [5, day(12)], 'saved with the date you picked');
  f = await edit(); f.elements.doms_cost.value = '3'; f.elements.doms_due.value = ''; await p.submit(f); await sleep(200); assert.match(p.text(p.q('[data-msg]', f)), /^Pick a due date for the Doms fee\.$/); assert.equal(Number((await feeRow(j.id, 'doms')).cost), 0, 'nothing was saved'); await p.click(p.q('[data-act="cancel-edit"]'));
  f = await edit(); f.elements.ems_due.value = day(25); await p.submit(f); await settle(p); assert.deepEqual([Number((await feeRow(j.id, 'ems')).cost), (await feeRow(j.id, 'ems')).due], [5, day(25)], 'only the date changed');
  f = await edit(); f.elements.initials_paid.value = '10'; f.elements.ems_cost.value = '6'; await p.submit(f); await settle(p); assert.equal((await feeRow(j.id, 'customs')).due, null, 'the old undated customs fee was left undated'); assert.equal((await feeRow(j.id, 'ems')).due, day(25), 'and the EMS date stays when only its amount changes'); p.close();
});

test('GOM — PACKING FEES: a "Fees due by" date (suggested 14 days ahead) is sent with the postage and packaging; without one you are asked; the claims in the parcel get that date', async () => {
  const h = u('pkf'); const cookie = await joinerSession(app, `${h}@x.com`, h); await api('PUT', '/api/my/address', { fullName: 'Pack Fee', address: '12 Test Street, Leeds, LS1 1AA', email: `${h}@x.com`, phone: '07700 900123' }, cookie); const go = await goOrder(day(-30));
  const [id] = await claimAndSecure(app, admin, h, await item(go, 5)); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' }); const made = await api('POST', '/api/my/parcels', { claimIds: [id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, cookie); assert.equal(made.status, 201, made.text);
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Packing')); await settle(p, 300); const f = p.q(`[data-parcel="${made.json.id}"] form[data-form="fees"]`);
  assert.equal(f.elements.dueDate.value, day(14), 'suggested'); assert.match(p.text(f.elements.dueDate.closest('div')), /^Fees due by/); f.elements.doms.value = '4.5'; f.elements.packaging.value = '1'; f.elements.dueDate.value = ''; await p.submit(f); await sleep(200); assert.match(p.text(p.q('[data-msg]', f)), /^Pick the date these fees are due\.$/); assert.equal(Number((await feeRow(id, 'doms')).cost), 0, 'nothing saved');
  f.elements.dueDate.value = day(11); await p.submit(f); await settle(p); assert.deepEqual([(await feeRow(id, 'doms')).due, (await feeRow(id, 'packaging')).due, Number((await feeRow(id, 'doms')).cost)], [day(11), day(11), 4.5]); p.close();
});

test('GOM — WAREHOUSE BOXES: the create form has "EMS & customs due by" (suggested 14 days ahead) and the box\'s claims get that date; a later customs split has its own date box', async () => {
  const h = u('whf'); await joinerSession(app, `${h}@x.com`, h); const go = await goOrder(day(-30)); const [id] = await claimAndSecure(app, admin, h, await item(go, 10)); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'arrived at proxy / warehouse', weightG: 300 });
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Warehouse')); await settle(p, 300); const due = p.q('#boxDue'); assert.equal(due.value, day(14), 'suggested'); assert.match(p.text(due.closest('div')), /^EMS & customs due by/);
  await p.click(p.q(`input[data-act="pick"][data-id="${id}"]`)); p.q('#boxEms').value = '12'; p.q('#boxCustoms').value = '4'; due.value = day(7); await p.click(p.byText('button', 'Create box')); await settle(p, 450);
  assert.deepEqual([(await feeRow(id, 'ems')).due, (await feeRow(id, 'customs')).due], [day(7), day(7)]); const [box] = await app.q('SELECT box_id AS id FROM box_items WHERE claim_id = ?', [id]); const cu = p.q(`input[data-customs-due="${box.id}"]`); assert.ok(cu, 'the customs split has its own date'); assert.equal(cu.value, day(14));
  p.q(`input[data-customs="${box.id}"]`).value = '9'; cu.value = day(20); await p.click(p.byText('button', 'Update customs split', p.q(`[data-box="${box.id}"]`) || p.q('#tabBody'))); await sleep(150); await press(p, 'Apply customs'); await settle(p, 450); assert.equal((await feeRow(id, 'customs')).due, day(20), 'customs: its own date'); assert.equal((await feeRow(id, 'ems')).due, day(7), 'EMS untouched'); p.close();
});

test('GOM — OVERDUE TAB says how much of an overdue amount is postage / fees, and not when it is only the item cost', async () => {
  const a = await oldClaim({ fee: { cat: 'ems', cost: 4, due: day(-2) } }), b = await oldClaim({}); const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Overdue')); await settle(p, 300);
  const rowOf = (h) => [...p.qa('.row, .card, div')].find((x) => x.children.length && p.text(x).startsWith(`@${h}`) && /overdue/.test(p.text(x))); const ta = p.text(rowOf(a.h)), tb = p.text(rowOf(b.h));
  assert.match(ta, /Owed £14\.00 \(£4\.00 of it postage \/ fees\) · was due/); assert.match(tb, /Owed £10\.00 · was due/); assert.doesNotMatch(tb, /postage \/ fees/); p.close();
});
