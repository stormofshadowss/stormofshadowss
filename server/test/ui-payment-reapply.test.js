import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// GOM → Payments → "Re-apply…" on a verified payment: a PREVIEW of where the money would move to, then it's done. The total owed never changes.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); await app.q("INSERT IGNORE INTO payment_methods (method, account_info) VALUES ('PayPal', 'pay@example.com')"); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ru') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async (title, deadline) => (await api('POST', '/api/admin/orders', { groupId: w.group, title: `${title} ${++N}`, proxy: 'Sam', paymentDeadline: deadline })).json.id;
const item = async (go, price, title) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price })).json.id;
async function person(...handles) { const cookie = await joinerSession(app, `${u('p')}@x.com`, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200); return { cookie, handles }; }
const secure = async (h, itemId) => (await claimAndSecure(app, admin, h, itemId))[0];
const paid = async (h, label, cat = 'initials') => Number((await app.q('SELECT cc.paid FROM claim_costs cc JOIN claims c ON c.id = cc.claim_id JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.label = ? AND cc.category = ?', [h, label, cat]))[0]?.paid ?? 0);
const verified = async (c, h, amount, extra = {}) => { const r = await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount, reference: u('TXN'), ...extra }, c); assert.equal(r.status, 201, r.text); await api('POST', `/api/admin/payments/${r.json.id}/verify`, {}); return r.json; };
async function misapply(paymentId, h, placements) {
  const [{ id: jid }] = await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [h]);
  for (const a of await app.q('SELECT claim_id, category, amount FROM payment_allocations WHERE payment_id = ?', [paymentId])) await app.q('UPDATE claim_costs SET paid = paid - ? WHERE claim_id = ? AND category = ?', [a.amount, a.claim_id, a.category]);
  await app.q('DELETE FROM payment_allocations WHERE payment_id = ?', [paymentId]);
  for (const [label, category, amount] of placements) { const [{ id: cid }] = await app.q('SELECT id FROM claims WHERE joiner_id = ? AND label = ?', [jid, label]); await app.q('UPDATE claim_costs SET paid = paid + ? WHERE claim_id = ? AND category = ?', [amount, cid, category]); await app.q('INSERT INTO payment_allocations (payment_id, claim_id, category, amount) VALUES (?,?,?,?)', [paymentId, cid, category, amount]); }
}
async function reported() {
  const h = u('payer'); const c = await person(h); const fresh = await goOrder('Hyunjin GO', '2099-01-01'), old = await goOrder('Lee Know GO', '2000-01-01');
  await secure(h, await item(fresh, 15, 'Hyunjin magazine')); await secure(h, await item(old, 10, 'Lee Know magazine')); const pcs = await secure(h, await item(old, 6, 'PCs')); await api('PATCH', `/api/admin/claims/${pcs}`, { costs: { initials: { cost: 6, paid: 6 }, ems: { cost: 5 } } });
  const pay = await verified(c.cookie, h, 15); await misapply(pay.id, h, [['Hyunjin magazine', 'initials', 15]]); return { h, c, pay };
}
const open = async (status = 'confirmed') => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Payments')); await sleep(120); await p.settle(); const sel = p.q('[data-filter="status"]'); sel.value = status; sel.dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(250); await p.settle(); return p; };
const panel = (p) => p.q('[data-reapply-panel]');
const rowOf = (p, id) => p.q(`[data-payment="${id}"]`);
const snap = async () => Object.fromEntries((await app.q('CHECKSUM TABLE claim_costs, payment_allocations, payments')).map((r) => [String(r.Table).split('.').pop(), String(r.Checksum)]));

test('A VERIFIED PAYMENT HAS "RE-APPLY…"; a waiting, rejected or failed one does not. It opens a PREVIEW of where the money would move — and until you confirm, nothing has', async () => {
  const { h, c, pay } = await reported(); const g = await goOrder('Wait GO', '2099-01-01'); await secure(h, await item(g, 7, 'Waiting item')); const waiting = await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount: 3, reference: u('WAIT') }, c.cookie);
  const p = await open(); assert.ok(p.q('[data-act="reapply"]', rowOf(p, pay.id))); const before = await snap(); await p.click(p.q('[data-act="reapply"]', rowOf(p, pay.id))); await sleep(300); await p.settle();
  const pn = panel(p); assert.ok(pn, 'the panel opens under the payment'); const t = p.text(pn);
  assert.match(t, /Re-apply this £15\.00 payment.*It would move £15\.00 so it pays what is due first:/s); const lines = p.qa('[data-reapply-moves] li', pn).map((l) => p.text(l));
  assert.deepEqual(lines, [`Hyunjin magazine @${h} · item cost — £15.00 no longer counted as paid (owed again)`, `Lee Know magazine @${h} · item cost — £10.00 counted as paid`, `PCs @${h} · EMS — £5.00 counted as paid`]);
  assert.match(t, /What they owe in total does not change — only which items count as paid\. The payment itself stays as it is, and no email is sent\./); assert.deepEqual(await snap(), before, 'the preview changed nothing'); assert.equal(await paid(h, 'Hyunjin magazine'), 15);
  await p.click(p.q('[data-act="reapply-cancel"]', pn)); assert.equal(panel(p), null); assert.deepEqual(await snap(), before, 'cancel changes nothing'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
  const w2 = await open('pending'); assert.equal(w2.q('[data-act="reapply"]'), null, 'a payment still waiting has no Re-apply'); w2.close(); void waiting;
});

test('PRESSING "RE-APPLY" DOES IT: the money moves to what is due first, the panel closes, the page says how much moved, and the total owed is unchanged', async () => {
  const { h, c, pay } = await reported(); const owedBefore = (await api('GET', `/api/my/summary?handle=${h}`, undefined, c.cookie)).json.owed.total; const p = await open();
  await p.click(p.q('[data-act="reapply"]', rowOf(p, pay.id))); await sleep(300); await p.settle(); await p.click(p.q('[data-act="reapply-go"]', panel(p))); await sleep(400); await p.settle();
  assert.match(toast(p), /Re-applied: £15\.00 now pays what was due first\./); assert.equal(panel(p), null, 'the panel closes');
  assert.deepEqual([await paid(h, 'Hyunjin magazine'), await paid(h, 'Lee Know magazine'), await paid(h, 'PCs', 'ems')], [0, 10, 5]); assert.equal((await api('GET', `/api/my/summary?handle=${h}`, undefined, c.cookie)).json.owed.total, owedBefore, 'what they owe is exactly what it was');
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.reapply' AND entity_id = ?", [pay.id]))[0].n, 1); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('A PAYMENT ALREADY ON WHAT IS DUE FIRST says "Nothing to move" and offers no Re-apply button', async () => {
  const h = u('fine'); const c = await person(h); const g = await goOrder('Fine GO', '2000-01-01'); await secure(h, await item(g, 10, 'Fine item')); const pay = await verified(c.cookie, h, 10); const p = await open(); const before = await snap();
  await p.click(p.q('[data-act="reapply"]', rowOf(p, pay.id))); await sleep(300); await p.settle(); const pn = panel(p); assert.match(p.text(pn), /Nothing to move\s*This £10\.00 payment is already on what is due first\./); assert.equal(p.q('[data-act="reapply-go"]', pn), null);
  await p.click(p.q('[data-act="reapply-cancel"]', pn)); assert.equal(panel(p), null); assert.deepEqual(await snap(), before); p.close();
});

test('IF IT CAN\'T BE RE-APPLIED (what it paid has since changed) you are told why in a message, no panel opens, and nothing changes', async () => {
  const { h, pay } = await reported(); await app.q("UPDATE claim_costs SET paid = 5 WHERE claim_id = (SELECT id FROM claims WHERE label = 'Hyunjin magazine' AND joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)) AND category = 'initials'", [h]);
  const p = await open(); const before = await snap(); await p.click(p.q('[data-act="reapply"]', rowOf(p, pay.id))); await sleep(350); await p.settle();
  assert.match(toast(p), /Part of what this payment paid has since been changed .* so it can't be re-applied automatically\./); assert.equal(panel(p), null); assert.deepEqual(await snap(), before); p.close();
});

test('A COMBINED PAYMENT HAS ONE RE-APPLY on its line, and the preview lists every handle\'s part', async () => {
  const [x, y] = [u('ha'), u('hb')]; const c = await person(x, y); const fresh = await goOrder('C new', '2099-01-01'), old = await goOrder('C old', '2000-01-01');
  await secure(x, await item(fresh, 20, 'X new')); await secure(x, await item(old, 10, 'X old')); await secure(y, await item(fresh, 20, 'Y new')); await secure(y, await item(old, 5, 'Y old'));
  const pay = await api('POST', '/api/my/payments?handle=all', { method: 'PayPal', amount: 15, reference: u('CO') }, c.cookie); await api('POST', `/api/admin/payments/batch/${pay.json.batchKey}/verify`, {});
  const rows = await app.q('SELECT id FROM payments WHERE batch_key = ? ORDER BY id', [pay.json.batchKey]); await misapply(rows[0].id, x, [['X new', 'initials', 10]]); await misapply(rows[1].id, y, [['Y new', 'initials', 5]]);
  const p = await open(); assert.equal(p.qa('[data-act="reapply"]').filter((b) => rows.some((r) => String(r.id) === b.dataset.id)).length, 1, 'one button for the whole combined payment');
  await p.click(p.q('[data-act="reapply"]', p.q(`[data-batch="${pay.json.batchKey}"]`) || p.q(`[data-payment="${rows[0].id}"]`) || p.q('body'))); await sleep(350); await p.settle(); const t = p.text(panel(p));
  assert.match(t, /Re-apply this £15\.00 payment/); for (const m of [`X old @${x}`, `Y old @${y}`, `X new @${x}`, `Y new @${y}`]) assert.ok(t.includes(m), `${m} is listed`);
  await p.click(p.q('[data-act="reapply-go"]', panel(p))); await sleep(450); await p.settle(); assert.deepEqual([await paid(x, 'X old'), await paid(x, 'X new'), await paid(y, 'Y old'), await paid(y, 'Y new')], [10, 0, 5, 0]); p.close();
});

test('RE-APPLY AND "PAYMENT FAILED…" NEVER BOTH OPEN: opening one closes the other', async () => {
  const { pay } = await reported(); const p = await open(); await p.click(p.q('[data-act="reverse"]', rowOf(p, pay.id))); await sleep(300); await p.settle(); assert.ok(p.q('[data-reverse-panel]')); assert.equal(panel(p), null);
  await p.click(p.q('[data-act="reapply"]', rowOf(p, pay.id))); await sleep(300); await p.settle(); assert.ok(panel(p)); assert.equal(p.q('[data-reverse-panel]'), null, 'the failed-payment panel closed'); await p.click(p.q('[data-act="reverse"]', rowOf(p, pay.id))); await sleep(300); await p.settle(); assert.equal(panel(p), null, 'and the other way round'); assert.ok(p.q('[data-reverse-panel]')); p.close();
});

test('THE VERIFY CONFIRMATIONS NOW DESCRIBE THE REAL ORDER (what is due first; overdue before newer items), and item names with HTML are shown as text', async () => {
  const h = u('conf'); const c = await person(h); const g = await goOrder('Conf GO', '2099-01-01'); await secure(h, await item(g, 12, '<b>Bold</b> album')); const sent = await api('POST', `/api/my/payments?handle=${h}`, { method: 'PayPal', amount: 12, reference: u('C') }, c.cookie);
  const p = await open('pending'); await p.click(p.q('[data-act="verify"]', rowOf(p, sent.json.id))); await sleep(200); await p.settle(); assert.match(p.text(modal(p)), /It will be applied to what they owe, whatever is due first \(overdue before newer items\); within an item: item cost, then EMS, customs, postage, packaging\./); assert.doesNotMatch(p.text(modal(p)), /item cost first/);
  await press(p, 'Cancel'); p.close();
  const e = u('esc'); const ec = await person(e); const fresh = await goOrder('Esc new', '2099-01-01'), old = await goOrder('Esc old', '2000-01-01'); await secure(e, await item(fresh, 9, '<b>Newer</b> thing')); await secure(e, await item(old, 9, '<img src=x onerror="window.pwned=1"> Older'));
  const escPay = await verified(ec.cookie, e, 9); await misapply(escPay.id, e, [['<b>Newer</b> thing', 'initials', 9]]); const q = await open(); await q.click(q.q('[data-act="reapply"]', rowOf(q, escPay.id))); await sleep(300); await q.settle();
  assert.equal(q.q('[data-reapply-moves] b'), null); assert.equal(q.q('[data-reapply-moves] img'), null); assert.equal(q.window.pwned, undefined); assert.ok(q.text(q.q('[data-reapply-moves]')).includes('<b>Newer</b> thing') && q.text(q.q('[data-reapply-moves]')).includes('<img src=x onerror="window.pwned=1"> Older'), 'shown as text'); q.close();
});
