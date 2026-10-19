import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// GOM → Group Orders → an order's items → "Purchase benefits": define "spend £X on these items, get N photocards", see who qualifies, press Add.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const u = (x = 'ub') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Benefit UI GO '), proxy: 'Sam' })).json.id;
const item = async (go, price, title = u('Thing '), extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price, title, ...extra })).json.id;
const person = async (h) => joinerSession(app, `${h}@x.com`, h);
const spend = async (h, itemId, n = 1) => { for (let i = 0; i < n; i++) await claimAndSecure(app, admin, h, itemId); };
const mkOffer = async (go, bonus, items, extra = {}) => (await api('POST', `/api/admin/orders/${go}/benefits`, { title: 'Spend £10, get a photocard', threshold: 10, quantity: 1, bonusItemId: bonus, itemIds: items, ...extra })).json.id;
const open = async (go) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`)); await sleep(80); await p.settle(); await p.click(p.q('[data-act="benefits"]')); await sleep(200); await p.settle(); return p; };
const panel = (p) => p.q('#benefitsPanel');
const claimsOf = async (offerId) => (await app.q("SELECT COUNT(*) AS n FROM claims WHERE benefit_offer_id = ? AND status <> 'cancelled'", [offerId]))[0].n;

test('THE BUTTON AND THE EMPTY PANEL: "Purchase benefits" is on the items panel; with no free item the form says to add one first', async () => {
  const go = await goOrder(); await item(go, 10, 'Only a paid item'); const p = await open(go); assert.ok(panel(p), 'the panel opens'); assert.match(p.text(panel(p)), /Spend £X on these items, get N photocards\.” You choose what counts and the free bonus item; the site then shows who qualifies and you press Add\./); assert.match(p.text(panel(p)), /No offers on this group order yet\./);
  await p.click(p.q('[data-act="benefit-new"]', panel(p))); assert.match(p.text(panel(p)), /First add a free item\. The benefit is a claim on a free \(£0\) plain item in this group order/); assert.equal(p.q('form[data-form="benefit"]'), null, 'no form until there is something to give'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('CREATING AN OFFER: the bonus can only be a free plain item; only priced items can count; "Tick all"; a clear message if nothing is ticked; the saved offer reads back plainly', async () => {
  const go = await goOrder(); const album = await item(go, 10, 'Album'), tee = await item(go, 25, 'Tee'); const free = await item(go, 0, 'Store photocard'); await item(go, 5, 'Sized thing', { type: 'size', variants: ['M'] }); void tee; void free;
  const p = await open(go); await p.click(p.q('[data-act="benefit-new"]', panel(p))); const f = () => p.q('form[data-form="benefit"]');
  assert.deepEqual([...f().elements.bonusItemId.options].map((o) => o.textContent), ['Store photocard'], 'the bonus can only be a free plain item'); assert.deepEqual(p.qa('[data-benefit-items] label', f()).map((l) => p.text(l).replace(/\s+/g, ' ')).sort(), ['Album £10.00', 'Sized thing £5.00', 'Tee £25.00'], 'free items are not offered as something that counts');
  f().elements.title.value = 'Spend £30, get a photocard'; f().elements.threshold.value = '30'; f().elements.quantity.value = '2'; await p.submit(f()); await sleep(150); assert.match(p.text(p.q('[data-msg]', f())), /Tick at least one item that counts toward the spend\./);
  await p.click(p.q('[data-act="benefit-tick-all"]', f())); assert.equal(p.qa('[data-benefit-items] input:checked', f()).length, 3); await p.submit(f()); await sleep(350); await p.settle(); assert.match(toast(p), /Offer saved\./); assert.equal(p.q('form[data-form="benefit"]'), null, 'the form closes');
  const card = p.q('[data-benefit]', panel(p)); assert.match(p.text(card), /Spend £30\.00 on Album, Tee, Sized thing → get 2 × Store photocard, again for every £30\.00 spent\./); assert.match(p.text(p.q('[data-benefit-summary]', card)), /Nobody has anything to add right now\./); p.close();
});

test('WHO QUALIFIES: a table of spent / earned / added / to add; people with several handles are one row; "Show everyone" adds progress toward the next amount', async () => {
  const go = await goOrder(); const a = await item(go, 6, 'A'), bonus = await item(go, 0, 'Store photocard'); const id = await mkOffer(go, bonus, [a]); const [h1, h2, near] = [u('big'), u('big2'), u('near')];
  const cookie = await person(h1); await api('POST', '/api/me/handles', { handle: h2 }); void cookie; await person(near); await spend(h1, a, 3); await spend(near, a, 1);
  const p = await open(go); assert.match(p.text(p.q('[data-benefit-summary]')), /1 person qualifies — 1 to add/); await p.click(p.q('[data-act="benefit-who"]')); await sleep(300); await p.settle();
  const rows = () => p.qa('[data-who] tbody tr').map((r) => [...r.children].map((c) => p.text(c).replace(/\s+/g, ' '))); assert.deepEqual(rows(), [[`@${h1}`, '£18.00', '1', '0', '1', 'Add 1']], 'only people who have something to add');
  await p.click(p.q('[data-act="benefit-all"]')); await sleep(300); await p.settle(); const all = rows(); assert.equal(all.length, 2); assert.deepEqual(all[1], [`@${near}`, '£6.00', '0', '0', '£4.00 to go', ''], 'progress toward the next amount'); assert.match(p.text(p.q('[data-who]').closest('div').parentElement), /Show everyone with spend \(2\)/); p.close();
});

test('PRESSING ADD puts the bonus on that person as a free, secured claim waiting to be ordered; the table and the summary update; you are told what was added', async () => {
  const go = await goOrder(); const a = await item(go, 10, 'Album'), bonus = await item(go, 0, 'Store photocard'); const id = await mkOffer(go, bonus, [a], { quantity: 2 }); const h = u('add'); await person(h); await spend(h, a, 2);
  const p = await open(go); await p.click(p.q('[data-act="benefit-who"]')); await sleep(300); await p.settle(); assert.equal(p.text(p.q('[data-bp] button')), 'Add 4'); await p.click(p.q('[data-act="benefit-add"]')); await sleep(450); await p.settle();
  assert.match(toast(p), new RegExp(`^Added 4 × “Store photocard” to @${h}\\.$`)); assert.equal(await claimsOf(id), 4); assert.match(p.text(p.q('[data-benefit-summary]')), /Nobody has anything to add right now\./); assert.equal(p.q('[data-who] [data-act="benefit-add"]'), null, 'nothing left to add');
  await p.click(p.q('[data-act="benefit-all"]')); await sleep(300); await p.settle(); assert.deepEqual([...p.q('[data-who] tbody tr').children].map((c) => p.text(c).replace(/\s+/g, ' ')).slice(1, 5), ['£20.00', '4', '4', '£10.00 to go'], 'spent £20 = two amounts × 2 = 4 earned, and all 4 added'); p.close();
});

test('"ADD EVERYONE" asks first (how many, to whom), "Not yet" changes nothing, "Add them all" adds each person what they are owed', async () => {
  const go = await goOrder(); const a = await item(go, 10, 'Album'), bonus = await item(go, 0, 'Store photocard'); const id = await mkOffer(go, bonus, [a]); const [p1, p2] = [u('e1'), u('e2')]; await person(p1); await person(p2); await spend(p1, a, 2); await spend(p2, a, 1);
  const p = await open(go); await p.click(p.q('[data-act="benefit-who"]')); await sleep(300); await p.settle(); await p.click(p.q('[data-act="benefit-add-all"]')); await sleep(150); assert.match(p.text(modal(p)), /Add 3 × “Store photocard” to 2 people\?\s*Each person gets what their spend has earned, as a free claim waiting to be ordered\./);
  await press(p, 'Not yet'); await sleep(150); assert.equal(await claimsOf(id), 0, 'nothing happened'); await p.click(p.q('[data-act="benefit-add-all"]')); await sleep(150); await press(p, 'Add them all'); await sleep(500); await p.settle(); assert.equal(await claimsOf(id), 3); assert.match(toast(p), /^Added 3 × “Store photocard” to 2 people\.$/); p.close();
});

test('A PERSON THAT CAN\'T BE ADDED (blocked) IS SAID PLAINLY, and everyone else still is; someone given too many is flagged, never silently changed', async () => {
  const go = await goOrder(); const a = await item(go, 10, 'Album'), bonus = await item(go, 0, 'Store photocard'); const id = await mkOffer(go, bonus, [a]); const [ok, bad] = [u('okp'), u('blk')]; await person(ok); await person(bad); await spend(ok, a); await spend(bad, a); await api('POST', '/api/admin/joiners/block', { handle: bad, reason: 'test' });
  const p = await open(go); await p.click(p.q('[data-act="benefit-who"]')); await sleep(300); await p.settle(); assert.match(p.text(p.q(`[data-bp]`, p.q('[data-who]'))), /blocked|Add 1/); await p.click(p.q('[data-act="benefit-add-all"]')); await sleep(150); await press(p, 'Add them all'); await sleep(500); await p.settle();
  assert.match(toast(p), new RegExp(`Added 1 × “Store photocard” to @${ok}\\. Couldn't add for @${bad} \\(@${bad} is blocked — unblock them on the People tab first\\.\\)`)); assert.equal(await claimsOf(id), 1);
  const [{ id: cid }] = await app.q("SELECT c.id FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.item_id = ?", [ok, a]); await app.q("UPDATE claims SET status = 'cancelled' WHERE id = ?", [cid]); await p.click(p.q('[data-act="close-benefits"]')); await p.click(p.q('[data-act="benefits"]')); await sleep(300); await p.settle();
  assert.match(p.text(p.q('[data-benefit-summary]')), /1 person has more than they now qualify for \(see Claims\)/); await p.click(p.q('[data-act="benefit-who"]')); await sleep(300); await p.settle(); assert.match(p.text(p.q('[data-who] .pill.warn')), /^1 too many$/); assert.match(p.q('[data-who] .pill.warn').title, /Nothing is taken away automatically/); assert.equal(await claimsOf(id), 1, 'nothing was removed'); p.close();
});

test('EDIT AND DELETE: the form comes back filled in; saving recalculates; an offer with bonus claims already added cannot be deleted (and says why)', async () => {
  const go = await goOrder(); const a = await item(go, 10, 'Album'), b = await item(go, 15, 'Mug'), bonus = await item(go, 0, 'Store photocard'); const id = await mkOffer(go, bonus, [a]); const h = u('ed'); await person(h); await spend(h, a, 2);
  const p = await open(go); await p.click(p.q(`[data-act="benefit-edit"][data-id="${id}"]`)); const f = () => p.q('form[data-form="benefit"]'); assert.deepEqual([f().elements.title.value, f().elements.threshold.value, f().elements.quantity.value], ['Spend £10, get a photocard', '10', '1']); assert.deepEqual(p.qa('[data-benefit-items] input:checked', f()).map((c) => c.closest('label').textContent.trim().split(/\s+/)[0]), ['Album'], 'what is ticked is remembered');
  f().elements.threshold.value = '20'; await p.submit(f()); await sleep(350); await p.settle(); assert.match(p.text(p.q('[data-benefit]')), /Spend £20\.00 on Album/); assert.match(p.text(p.q('[data-benefit-summary]')), /1 person qualifies — 1 to add/, 'recalculated: £20 on a £20 amount');
  await p.click(p.q('[data-act="benefit-who"]')); await sleep(300); await p.settle(); await p.click(p.q('[data-act="benefit-add"]')); await sleep(400); await p.settle(); await p.click(p.q(`[data-act="benefit-delete"][data-id="${id}"]`)); await sleep(150); await press(p, 'Delete it'); await sleep(300); await p.settle(); assert.match(toast(p), /1 bonus claim was already added from this offer — cancel it first, or keep the offer\./); assert.ok(p.q('[data-benefit]'), 'still there');
  const empty = await mkOffer(go, bonus, [b], { title: 'Mug offer' }); await p.click(p.q('[data-act="close-benefits"]')); await p.click(p.q('[data-act="benefits"]')); await sleep(300); await p.settle(); await p.click(p.q(`[data-act="benefit-delete"][data-id="${empty}"]`)); await sleep(150); await press(p, 'Delete it'); await sleep(350); await p.settle(); assert.match(toast(p), /Offer deleted\./); assert.equal(p.q(`[data-benefit="${empty}"]`), null); p.close();
});

test('NAMES WITH HTML ARE SHOWN AS TEXT (offer name, items, bonus item)', async () => {
  const go = await goOrder(); const a = await item(go, 10, '<b>Bold</b> album'), bonus = await item(go, 0, '<i>Free</i> card'); await mkOffer(go, bonus, [a], { title: '<img src=x onerror="window.pwned=1"> Offer' }); const p = await open(go);
  assert.equal(p.q('img[src="x"]'), null); assert.equal(p.window.pwned, undefined); assert.equal(p.q('#benefitsPanel b'), null); assert.equal(p.q('#benefitsPanel i'), null); assert.match(p.text(panel(p)), /<img src=x onerror="window\.pwned=1"> Offer/); assert.match(p.text(panel(p)), /<b>Bold<\/b> album → get 1 × <i>Free<\/i> card/); p.close();
});
