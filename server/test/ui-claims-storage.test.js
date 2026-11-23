import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// GOM → Claims: a storage deadline for any claim — in the Edit panel, or on many ticked claims at once — and a way to find the ones that lost theirs.
let app, admin, w, N = 0;
const READY = 'ready to pack / on hand';
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10), uk = (iso) => iso.split('-').reverse().join('/');
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const btn = (p, re, root) => p.qa('button', root).find((b) => re.test(p.text(b)));
async function order() { const t = `Storage UI GO ${++N}`; const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: t })).json.id; return { t, item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: `${t} item`, price: 8 })).json.id }; }
const claim = async (item) => (await claimAndSecure(app, admin, `sdu${++N}`, item))[0];
const ready = async (id) => { await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); return id; };
const lost = async (item) => { const id = await ready(await claim(item)); await app.q('UPDATE claims SET ready_to_pack_date = NULL WHERE id = ?', [id]); return id; };
const raw = async (id) => (await app.q('SELECT storage_deadline_override AS o FROM claims WHERE id = ?', [id]))[0].o;
const open = async (t, { select = false } = {}) => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); await p.type(p.q('[data-filter="q"]'), `${t} item`); await p.settle(); if (select) await p.click(btn(p, /^Select all \d+ confirmed claims? here/)); return p; };
const rowOf = (p, id) => p.q(`tr[data-claim="${id}"]`);
const done = async (p) => { await sleep(450); await p.settle(); };

test('EACH CLAIM SAYS WHEN ITS STORAGE RUNS OUT — "Storage until …" (and "set by you" when you chose it) — or flags "No storage deadline" when it is ready to pack with nothing to go on; a claim not ready yet says nothing', async () => {
  const { t, item } = await order(); const normal = await ready(await claim(item)), none = await lost(item), byHand = await lost(item), early = await claim(item); const D = inDays(25);
  await api('PATCH', `/api/admin/claims/${byHand}`, { storageDeadlineOverride: D }); const p = await open(t);
  assert.match(p.text(p.q('[data-storage]', rowOf(p, normal))), /^Storage until \d{2}\/\d{2}\/\d{4}$/, 'the normal rule: no "set by you"'); assert.equal(p.text(p.q('[data-storage]', rowOf(p, byHand))), `Storage until ${uk(D)} · set by you`);
  assert.equal(p.text(p.q('[data-storage-missing]', rowOf(p, none))), 'No storage deadline'); assert.equal(p.q('[data-storage]', rowOf(p, none)), null); assert.equal(p.q('[data-storage], [data-storage-missing]', rowOf(p, early)), null, 'not ready yet: nothing to say'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('THE EDIT PANEL HAS A STORAGE DEADLINE ROW: it says what the normal date would be, a date you pick is saved and shown as set by you, clearing it goes back; saving only costs leaves the date alone', async () => {
  const { t, item } = await order(); const id = await ready(await claim(item)); const p = await open(t); await p.click(p.q('[data-act="edit"]', rowOf(p, id))); const form = () => p.q(`form[data-form="edit-costs"][data-id="${id}"]`);
  assert.equal(form().elements.storageDeadline.value, '', 'nothing set by hand yet'); assert.match(p.text(form()), /Storage deadline.*Normally \d{2}\/\d{2}\/\d{4} \(the day it became ready to pack plus days for its size\)\. Pick a date to set it by hand; clear it to go back to the normal rule\./);
  const D = inDays(45); form().elements.storageDeadline.value = D; await p.submit(form()); await done(p); assert.equal(toast(p), 'Saved.'); assert.equal(await raw(id), D); assert.equal(p.text(p.q('[data-storage]', rowOf(p, id))), `Storage until ${uk(D)} · set by you`);
  await p.click(p.q('[data-act="edit"]', rowOf(p, id))); assert.equal(form().elements.storageDeadline.value, D, 'it is filled in next time'); form().elements.initials_cost.value = '9.50'; await p.submit(form()); await done(p); assert.equal(await raw(id), D, 'changing a cost left the deadline alone');
  await p.click(p.q('[data-act="edit"]', rowOf(p, id))); form().elements.storageDeadline.value = ''; await p.submit(form()); await done(p); assert.equal(await raw(id), null, 'cleared'); assert.match(p.text(p.q('[data-storage]', rowOf(p, id))), /^Storage until \d{2}\/\d{2}\/\d{4}$/, 'back to the normal rule');
  await p.click(p.q('[data-act="edit"]', rowOf(p, id))); await p.submit(form()); await done(p); assert.equal(p.q('form[data-form="edit-costs"]'), null, 'saving with nothing changed just closes it'); assert.equal(await raw(id), null); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('BULK: "Storage deadline…" on ticked claims — a date is required, the question says how many and (for a past date) that they will show on Overdue; "Not yet" changes nothing; setting then clearing both work and say what happened', async () => {
  const { t, item } = await order(); const ids = [await lost(item), await lost(item), await lost(item)]; const p = await open(t, { select: true }); await p.click(btn(p, /^Storage deadline…$/)); const panel = () => p.q('[data-storage-panel]');
  assert.match(p.text(panel()), /^Storage deadline for the 3 selected claims\s*Keep it until.*For items that lost their storage date\./); await p.click(btn(p, /^Set it…$/, panel())); assert.equal(p.text(p.q('[data-storage-error]')), 'Pick the date to keep them until.'); assert.equal(await raw(ids[0]), null);
  const D = inDays(-4); const pick = (v) => { const i = p.q('#storageDate'); i.value = v; i.dispatchEvent(new p.window.Event('change', { bubbles: true })); };
  pick(D); await p.click(btn(p, /^Set it…$/, panel())); const q1 = p.text(modal(p)); assert.match(q1, new RegExp(`^Set the storage deadline of 3 claims to ${uk(D)}\\? It replaces the normal rule for them until you clear it\\. Cancelled claims are left alone\\. That date has already passed, so any that are not packed yet will show on the Overdue tab straight away\\.`));
  await press(p, 'Not yet'); await sleep(120); assert.equal(await raw(ids[0]), null, 'Not yet: nothing changed'); assert.ok(panel(), 'the panel is still open');
  const F = inDays(30); pick(F); await p.click(btn(p, /^Set it…$/, panel())); assert.doesNotMatch(p.text(modal(p)), /already passed/, 'no warning for a future date'); await press(p, 'Set it'); await done(p);
  assert.equal(toast(p), `Set to ${uk(F)}: 3 claims.`); for (const id of ids) assert.equal(await raw(id), F); assert.equal(p.q('[data-storage-panel]'), null, 'the panel closes'); assert.equal(p.q('#bulkBar'), null, 'and so does the selection'); assert.equal(p.text(p.q('[data-storage]', rowOf(p, ids[1]))), `Storage until ${uk(F)} · set by you`);
  await p.click(btn(p, /^Select all \d+ confirmed claims? here/)); await p.click(btn(p, /^Storage deadline…$/)); pick(F); await p.click(btn(p, /^Set it…$/, panel())); await press(p, 'Set it'); await done(p); assert.equal(toast(p), `Set to ${uk(F)}: 0 claims. 3 already had that date.`, 'nothing changed, and it says so');
  await p.click(btn(p, /^Select all \d+ confirmed claims? here/)); await p.click(btn(p, /^Storage deadline…$/)); await p.click(btn(p, /^Clear it…$/, panel())); assert.match(p.text(modal(p)), /^Clear the hand-set storage deadline of 3 claims\? They go back to the normal rule: the day they became ready to pack plus days for their size\. A claim with no ready-to-pack date will have no deadline at all\./);
  await press(p, 'Clear it'); await done(p); assert.equal(toast(p), 'Cleared 3 claims.'); for (const id of ids) assert.equal(await raw(id), null); assert.ok(p.q('[data-storage-missing]', rowOf(p, ids[0])), 'the lost ones are flagged again'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('FINDING THE ONES THAT LOST IT: a "no storage deadline" chip and an "Only ready to pack with no storage deadline" tick show only those; fixing them (in bulk) takes them off', async () => {
  const { t, item } = await order(); const a = await lost(item), b = await lost(item), fine = await ready(await claim(item)), early = await claim(item), byHand = await lost(item); await api('PATCH', `/api/admin/claims/${byHand}`, { storageDeadlineOverride: inDays(12) });
  const p = await open(t); const shown = () => p.qa('tr[data-claim]').map((r) => Number(r.dataset.claim)).sort((x, y) => x - y); assert.deepEqual(shown(), [a, b, fine, early, byHand].sort((x, y) => x - y), 'everything shows to begin with');
  const chip = p.q('[data-act="nodeadline-chip"]'); assert.ok(chip, 'the chip is there'); assert.match(p.text(chip), /^no storage deadline 2$/); await p.click(chip); assert.deepEqual(shown(), [a, b].sort((x, y) => x - y), 'only the ones ready to pack with no deadline'); assert.equal(p.q('input[data-filter="noDeadline"]').checked, true, 'the tick follows the chip');
  await p.click(p.q('[data-act="nodeadline-chip"]')); assert.equal(shown().length, 5, 'the chip toggles it off'); const tick = p.q('input[data-filter="noDeadline"]'); assert.match(p.text(tick.closest('label')), /^Only ready to pack with no storage deadline$/); tick.checked = true; tick.dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(120); await p.settle(); assert.deepEqual(shown(), [a, b].sort((x, y) => x - y), 'the tick does the same');
  await p.click(btn(p, /^Select all \d+ confirmed claims? here/)); await p.click(btn(p, /^Storage deadline…$/)); const i = p.q('#storageDate'); i.value = inDays(20); i.dispatchEvent(new p.window.Event('change', { bubbles: true })); await p.click(btn(p, /^Set it…$/, p.q('[data-storage-panel]'))); await press(p, 'Set it'); await done(p);
  assert.equal(await raw(a), inDays(20)); assert.equal(await raw(b), inDays(20)); assert.equal(p.q('[data-act="nodeadline-chip"]'), null, 'nothing has lost its deadline any more, so the chip goes'); assert.deepEqual(shown(), [], 'and the filtered list is empty'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('IF A SELECTED CLAIM IS CANCELLED WHILE YOU ARE WORKING: the bulk set carries on for the rest, leaves the cancelled one alone, and says so', async () => {
  const { t, item } = await order(); const [a, b, c] = [await lost(item), await lost(item), await lost(item)]; const p = await open(t, { select: true }); await p.click(btn(p, /^Storage deadline…$/));
  assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: [c] })).status, 200, 'cancelled in another tab after you ticked it'); const F = inDays(14); const i = p.q('#storageDate'); i.value = F; i.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await p.click(btn(p, /^Set it…$/, p.q('[data-storage-panel]'))); await press(p, 'Set it'); await done(p); assert.equal(toast(p), `Set to ${uk(F)}: 2 claims. 1 cancelled left alone.`); assert.deepEqual([await raw(a), await raw(b), await raw(c)], [F, F, null], 'the cancelled one is untouched'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});
