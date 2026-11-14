import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// GOM → Shop tab: a Delete button on every listing. Never claimed → deleted for good; claimed → taken off every list but kept for its claims.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Shop')); await sleep(250); await p.settle(); return p; };
const stock = async (o = {}) => { const title = `Del stock ${++N}`; return { id: (await api('POST', '/api/admin/shop', { title, price: 10, qty: 5, ...o })).json.id, title }; };
const buy = (handle, id) => app.api('POST', '/api/claims', { handle, lines: [{ leftoverId: id }] });
const card = (p, id) => p.q(`[data-shop="${id}"]`);
const del = (p, id) => p.click(card(p, id).querySelector('[data-act="delete"]'));
const row = async (id) => (await app.q('SELECT id, is_active AS active, deleted_at AS gone FROM leftover_items WHERE id = ?', [id]))[0];
const settle = async (p) => { await sleep(450); await p.settle(); };

test('A LISTING NOBODY HAS CLAIMED: every card has a Delete button; the question says it is removed completely; "Keep it" does nothing; "Delete it" deletes it — a toast, and the card goes', async () => {
  const a = await stock(), other = await stock(); const p = await open(); assert.ok(card(p, a.id).querySelector('[data-act="delete"]'), 'a Delete button on the card'); assert.equal(p.text(card(p, a.id).querySelector('[data-act="delete"]')), 'Delete');
  await del(p, a.id); assert.match(p.text(modal(p)), new RegExp(`^Delete “${a.title}” for good\\? Nobody has claimed it, so it is removed completely — with its options and its picture\\. This can't be undone\\.Keep itDelete it$`));
  await press(p, 'Keep it'); await sleep(100); assert.ok(await row(a.id), 'Keep it: nothing happened'); assert.ok(card(p, a.id));
  await del(p, a.id); await press(p, 'Delete it'); await settle(p); assert.equal(toast(p), `Deleted “${a.title}”.`); assert.equal(card(p, a.id), null, 'the card is gone'); assert.equal(await row(a.id), undefined, 'and the listing');
  assert.ok(card(p, other.id) && await row(other.id), 'the other listing is untouched'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('A LISTING THAT HAS CLAIMS: the question says how many and that it is kept behind the scenes; "Remove it" takes it off the list — even with "Show hidden items" — and the claims are untouched', async () => {
  const two = await stock(), one = await stock(); assert.equal((await buy('del_a', two.id)).status, 201); assert.equal((await buy('del_b', two.id)).status, 201); const cancelled = await buy('del_c', one.id); await api('POST', '/api/admin/claims/cancel', { claimIds: cancelled.json.claimIds });
  const p = await open(); await del(p, two.id); const q2 = p.text(modal(p)); assert.match(q2, new RegExp(`^Remove “${two.title}” from your lists\\? 2 claims \\(including any that were cancelled\\) point at it, so it can't be erased completely\\. It disappears from the shop and from your Stock list — even with “Show hidden items” — but is kept behind the scenes so those claims, payments and packing carry on as normal\\. This can't be undone\\.Keep itRemove it$`));
  await press(p, 'Keep it'); await sleep(100); await del(p, one.id); assert.match(p.text(modal(p)), /^Remove “.+” from your lists\? 1 claim \(including any that were cancelled\) points at it, .* so that claim, payments and packing carry on as normal\./, 'the singular reads properly'); await press(p, 'Keep it'); await sleep(100);
  const before = await app.q('SELECT id, status, label FROM claims WHERE leftover_item_id = ? ORDER BY id', [two.id]); await del(p, two.id); await press(p, 'Remove it'); await settle(p);
  assert.equal(toast(p), `Removed “${two.title}” from your lists — kept behind the scenes for its 2 claims.`); assert.equal(card(p, two.id), null, 'off the list');
  const hid = p.q('input[data-act="toggle-hidden"]'); hid.checked = true; hid.dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(150); await p.settle(); assert.equal(card(p, two.id), null, 'still gone with "Show hidden items" ticked'); assert.ok(card(p, one.id), 'the other listing is still there');
  const gone = await row(two.id); assert.ok(gone.gone && gone.active === 0); assert.deepEqual(await app.q('SELECT id, status, label FROM claims WHERE leftover_item_id = ? ORDER BY id', [two.id]), before, 'its claims are untouched'); p.close();
});

test('A HIDDEN LISTING CAN BE DELETED TOO; and if it has already gone (deleted elsewhere), the screen says so and refreshes instead of pretending', async () => {
  const h = await stock(), ghost = await stock(); assert.equal((await api('PATCH', `/api/admin/shop/${h.id}`, { active: false })).status, 200); const p = await open();
  const hid = p.q('input[data-act="toggle-hidden"]'); hid.checked = true; hid.dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(150); await p.settle(); assert.ok(card(p, h.id).querySelector('[data-act="delete"]'), 'a hidden listing has Delete too');
  await del(p, h.id); await press(p, 'Delete it'); await settle(p); assert.equal(toast(p), `Deleted “${h.title}”.`); assert.equal(await row(h.id), undefined);
  assert.equal((await api('DELETE', `/api/admin/shop/${ghost.id}`)).status, 200, 'deleted elsewhere while this screen was open'); await del(p, ghost.id); await press(p, 'Delete it'); await settle(p); assert.equal(toast(p), 'No such shop item'); assert.equal(card(p, ghost.id), null, 'the list was refreshed'); p.close();
});
