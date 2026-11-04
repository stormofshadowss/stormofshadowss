import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// GOM → Claims: select claims, "Change price…" — set a new price or add / take off an amount; a review shows exactly what will happen (and who is told) before anything changes.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'cpu') => `${x}${++N}`;
const btn = (p, re, root) => p.qa('button', root).find((b) => re.test(p.text(b)));
async function order(price = 10) { const t = u('Price UI GO '); const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: t })).json.id; return { t, go, item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: `${t} item`, price })).json.id }; }
async function holder(item, { email = false } = {}) { const h = u('h'), e = `${h}@x.com`; const cookie = await joinerSession(app, e, h); if (email) await app.api('PUT', '/api/my/notifications', { enabled: true }, cookie); const [id] = await claimAndSecure(app, admin, h, item); return { h, e, id }; }
const cost = async (id) => Number((await app.q("SELECT cost FROM claim_costs WHERE claim_id = ? AND category = 'initials'", [id]))[0].cost);
async function open(orderTitle, { panel = true } = {}) {
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); await p.type(p.q('[data-filter="q"]'), `${orderTitle} item`); await p.settle();
  await p.click(btn(p, /^Select all \d+ confirmed claims? here/)); if (panel) await p.click(btn(p, /^Change price/)); return p;
}
const fill = async (p, amount) => { p.q('#priceAmount').value = String(amount); };
const review = async (p) => { await p.click(btn(p, /^Review/)); await sleep(350); await p.settle(); };

test('THE SELECTION BAR OFFERS "CHANGE PRICE…": the panel explains what it does, has the two ways to enter it and the email tick (on), the label follows the way chosen (keeping what you typed), and it can be cancelled', async () => {
  const { t, item } = await order(); await holder(item); const p = await open(t); const panel = p.text(p.q('#pricePanel'));
  assert.match(panel, /^Change the price of the 1 selected claim\s*Changes each claim's item cost, whatever stage it is at\. Postage, EMS and customs aren't touched, and neither is the item's price for new claims\./); assert.equal(p.q('input[name="priceMode"][value="set"]').checked, true); assert.equal(p.q('#priceNotify').checked, true);
  assert.equal(p.text(p.q('label[for="priceAmount"]')), 'New price for each (£)'); await fill(p, '12.5'); await p.click(p.q('input[name="priceMode"][value="adjust"]')); assert.equal(p.text(p.q('label[for="priceAmount"]')), 'Amount to add to each (£) — a minus takes off'); assert.equal(p.q('#priceAmount').value, '12.5', 'what you typed is kept');
  await p.click(btn(p, /^Cancel$/, p.q('#pricePanel'))); assert.equal(p.q('#pricePanel'), null); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('SET A NEW PRICE: the review lists what changes (grouped), the total and who is told; "Not yet" changes nothing; confirming changes every selected claim, says how many, and closes the panel and the selection', async () => {
  const { t, item } = await order(10); const hs = [await holder(item), await holder(item), await holder(item)]; const p = await open(t); await fill(p, '10.75'); await review(p);
  const d = p.text(modal(p)); assert.match(d, new RegExp(`^Change the price of 3 claims\\?\\s*• ${t} item — 3 claims: £10\\.00 → £10\\.75 \\(\\+£0\\.75 each\\)\\s*In total \\+£2\\.25 across 3 people\\.\\s*New claims still use the item's price — change that in Group Orders if it should change too\\.\\s*They'll be emailed \\(those with emails on\\)\\.Not yetChange the price$`));
  await press(p, 'Not yet'); await sleep(150); assert.deepEqual(await Promise.all(hs.map((x) => cost(x.id))), [10, 10, 10], 'Not yet: nothing changed'); assert.ok(p.q('#pricePanel'), 'the panel is still there');
  await review(p); await press(p, 'Change the price'); await sleep(500); await p.settle(); assert.equal(toast(p), 'Changed the price of 3 claims (+£2.25 in total).'); assert.deepEqual(await Promise.all(hs.map((x) => cost(x.id))), [10.75, 10.75, 10.75]); assert.equal(p.q('#pricePanel'), null); assert.equal(p.q('#bulkBar'), null, 'the selection was cleared'); p.close();
});

test('ADD OR TAKE OFF AN AMOUNT: "−£1.00 each" and a negative total; the review also says how many are already ordered (they will owe the difference) and who has paid more than the new price (credit back)', async () => {
  const { t, item } = await order(10); const [a, b, c] = [await holder(item), await holder(item), await holder(item)]; await api('PATCH', `/api/admin/claims/${b.id}`, { pipeline: 'ordered via proxy / warehouse' }); await api('PATCH', `/api/admin/claims/${c.id}`, { costs: { initials: { paid: 10 } } });
  const p = await open(t); await p.click(p.q('input[name="priceMode"][value="adjust"]')); await fill(p, '-4'); await review(p); const d = p.text(modal(p));
  assert.match(d, /3 claims: £10\.00 → £6\.00 \(−£4\.00 each\)/); assert.match(d, /In total −£12\.00 across 3 people\./); assert.match(d, /1 is already ordered or further along — they'll owe the difference\./); assert.match(d, /1 person has paid more than the new price — £4\.00 goes back to them as credit\./);
  await press(p, 'Change the price'); await sleep(500); await p.settle(); assert.equal(toast(p), 'Changed the price of 3 claims (−£12.00 in total).'); assert.deepEqual(await Promise.all([a, b, c].map((x) => cost(x.id))), [6, 6, 6]); p.close();
});

test('THE EMAIL TICK DECIDES: ticked, the people with emails on are emailed; unticked, the review says "Nobody will be emailed." and nobody is', async () => {
  const { t, item } = await order(10); const a = await holder(item, { email: true }); const p = await open(t); const sent = () => app.mailer.outbox.filter((m) => m.to === a.e && /price of your order/i.test(m.subject)).length;
  await fill(p, '11'); await p.click(p.q('#priceNotify')); await review(p); assert.match(p.text(modal(p)), /Nobody will be emailed\.Not yetChange the price$/); await press(p, 'Change the price'); await sleep(500); await p.settle(); await app.notifier.idle(); assert.equal(sent(), 0); assert.equal(await cost(a.id), 11); p.close();
  const q = await open(t); await fill(q, '12'); await review(q); assert.match(q.text(modal(q)), /They'll be emailed \(those with emails on\)\./); await press(q, 'Change the price'); await sleep(500); await q.settle(); await app.notifier.idle(); assert.equal(sent(), 1); q.close();
});

test('MISTAKES ARE EXPLAINED AND NOTHING CHANGES: no amount, a negative new price, everything already at that price, and a take-off that would go below £0 (the server\'s reason is shown)', async () => {
  const { t, item } = await order(10); const a = await holder(item); const p = await open(t); const err = () => p.text(p.q('[data-price-error]'));
  await review(p); assert.equal(err(), 'Enter an amount.'); await fill(p, '-1'); await review(p); assert.equal(err(), "A price can't be below £0."); await fill(p, '10'); await review(p); assert.equal(err(), 'Nothing to change — every selected claim is already at that price.'); assert.equal(modal(p), null, 'no dialog for nothing');
  await p.click(p.q('input[name="priceMode"][value="adjust"]')); await fill(p, '-11'); await review(p); assert.match(err(), /^That would take “.*” \(@.*\) below £0 \(it is £10\.00 now\)\.$/); assert.equal(await cost(a.id), 10); p.close();
});

test('SEVERAL ITEMS AT ONCE: the review has a line per item and price; each claim moves by the amount from where it is', async () => {
  const t = u('Two GO '); const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: t })).json.id; const i1 = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: `${t} item A`, price: 10 })).json.id, i2 = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: `${t} item B`, price: 20 })).json.id;
  const [a, b] = [await holder(i1), await holder(i2)]; const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); await p.type(p.q('[data-filter="q"]'), `${t} item`); await p.settle(); await p.click(btn(p, /^Select all \d+ confirmed claims? here/)); await p.click(btn(p, /^Change price/));
  await p.click(p.q('input[name="priceMode"][value="adjust"]')); await fill(p, '0.5'); await review(p); const d = p.text(modal(p)); assert.match(d, /item A — 1 claim: £10\.00 → £10\.50 \(\+£0\.50\)/); assert.match(d, /item B — 1 claim: £20\.00 → £20\.50 \(\+£0\.50\)/); await press(p, 'Change the price'); await sleep(500); await p.settle(); assert.deepEqual([await cost(a.id), await cost(b.id)], [10.5, 20.5]); p.close();
});
