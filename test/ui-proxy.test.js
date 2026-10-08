import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b) => app.api(m, p, b, admin);
const iso = (d) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
const uk = (i) => `${i.slice(8, 10)}/${i.slice(5, 7)}/${i.slice(0, 4)}`;
const text = (p, sel = '#tabBody') => p.text(p.q(sel));
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Proxy')); return p; };
async function order(opts = {}) { return (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Proxy UI GO ${++N}`, ...opts })).json.id; }
async function item(orderId, opts = {}) { const id = (await api('POST', `/api/admin/orders/${orderId}/items`, { type: 'normal', title: `UI item ${++N}`, price: 10, ...opts })).json.id; await claimAndSecure(app, admin, `pxu${++N}`, id); return id; }
async function setItem(orderId, n = 2) {
  const id = (await api('POST', `/api/admin/orders/${orderId}/items`, { type: 'set', title: `UI set ${++N}`, price: 8, members: ['A', 'B', 'C', 'D'] })).json.id;
  for (let i = 0; i < n; i++) await api('POST', '/api/claims', { handle: `pxs${++N}`, lines: [{ itemId: id, parts: [{ member: 'A', qty: 1 }] }] }, undefined);
  for (const s of (await api('GET', '/api/admin/sets')).json.sets.filter((x) => x.itemId === id)) await api('POST', `/api/admin/sets/${s.id}/secure`, {});
  return id;
}
const tick = (p, key) => p.click(p.q(`input[data-act="pick"][data-key="${key}"]`));
const pays = async () => (await api('GET', '/api/admin/proxy/payments')).json.payments;

test('with nothing to log and nothing logged, the tab says so', async () => {
  const p = await open();
  assert.match(text(p), /No secured sets or items waiting to be paid for right now/);
  assert.match(text(p), /No proxy payments logged yet/);
  p.close();
});

test('the list shows what is waiting — sets and items — with their proxy and pay-by date', async () => {
  const go = await order({ proxy: 'Sam', paymentDeadline: '2031-05-01' });
  const i = await item(go), s = await setItem(go, 2);
  const p = await open();
  assert.match(text(p, `tr[data-cand="item:${i}"]`), /Proxy UI GO \d+ — UI item \d+ — 1 confirmed claim.*Sam.*01\/05\/2031/);
  assert.match(text(p, `tr[data-cand="set:${s}"]`), /UI set \d+ — 2 secured sets.*Sam.*01\/05\/2031/);
  assert.equal(p.q('#tabs [data-tab="proxy"] .badge').hidden, true, 'the badge counts UNPAID logged payments, of which there are none yet');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('ticking fills in the proxy when they all share one and the earliest pay-by date; a mix of proxies leaves the name for you', async () => {
  const a = await order({ proxy: 'Sam', paymentDeadline: '2031-05-01' }), b = await order({ proxy: 'Sam', paymentDeadline: '2031-02-10' }), c = await order({ proxy: 'Yuki', paymentDeadline: '2031-01-01' });
  const [ia, ib, ic] = [await item(a), await item(b), await item(c)];
  const p = await open();
  await tick(p, `item:${ia}`);
  assert.deepEqual([p.q('#pxName').value, p.q('#pxDeadline').value], ['Sam', '2031-05-01']);
  await tick(p, `item:${ib}`);
  assert.equal(p.q('#pxDeadline').value, '2031-02-10', 'the earlier of the two');
  p.q('#pxName').value = '';
  await tick(p, `item:${ic}`);
  assert.equal(p.q('#pxName').value, '', 'two different proxies: not guessed');
  assert.equal(p.q('#pxDeadline').value, '2031-01-01');
  p.close();
});

test('"Suggest" writes a summary from what is ticked, and asks you to tick something first', async () => {
  const go = await order({ proxy: 'Sam' });
  const s = await setItem(go, 2), i = await item(go);
  const p = await open();
  await p.click(p.byText('button', 'Suggest'));
  assert.match(text(p, '.ui-modal'), /Tick which sets\/items this payment covers first/); await press(p, 'OK');
  await tick(p, `set:${s}`); await tick(p, `item:${i}`);
  await p.click(p.byText('button', 'Suggest'));
  assert.match(p.q('#pxSummary').value, /^UI set \d+ — 2 OT4 sets \+ 1 other item$/);
  p.close();
});

test('saving: a missing proxy or nothing ticked is explained; a good one is saved, shown, cleared from the form and off the waiting list', async () => {
  const go = await order({ proxy: 'Sam', paymentDeadline: iso(-20) });
  const i = await item(go), s = await setItem(go, 3);
  const p = await open();
  await p.click(p.byText('button', 'Save'));
  assert.match(text(p, '#pxMsg'), /.+/, 'something is said');
  await tick(p, `item:${i}`); p.q('#pxName').value = '';
  await p.click(p.byText('button', 'Save'));
  assert.match(text(p, '#pxMsg'), /proxy/i);
  await tick(p, `set:${s}`);                                                            // name and date are now filled in
  await p.click(p.byText('button', 'Suggest'));
  await p.click(p.byText('button', 'Save'));
  assert.match(text(p, '#pxMsg'), new RegExp(`Saved — Sam, due ${uk(iso(-20))}`));
  assert.equal(p.q('#pxName').value, ''); assert.equal(p.q('#pxSummary').value, '');
  assert.equal(p.q(`tr[data-cand="item:${i}"]`), null); assert.equal(p.q(`tr[data-cand="set:${s}"]`), null);
  const card = text(p, '[data-pay]');
  assert.match(card, new RegExp(`Sam — UI set \\d+ — 3 OT4 sets \\+ 1 other item.*Due ${uk(iso(-20))}.*Proxy UI GO \\d+ — UI item.*3 sets`));
  assert.equal(p.q('#tabs [data-tab="proxy"] .badge').textContent, '1');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('an overdue payment is flagged; ticking it paid files it under "Paid" and clears the flag; un-ticking brings it back', async () => {
  const go = await order({ proxy: 'Late Sam', paymentDeadline: iso(5) });
  const i = await item(go);
  const id = (await api('POST', '/api/admin/proxy/payments', { proxy: 'Late Sam', deadline: iso(5), summary: 'Late run', keys: [`item:${i}`] })).json.id;
  const p = await open();
  assert.match(text(p, `[data-pay="${id}"]`), /Late Sam — Late run.*5 days overdue.*Due/s);
  const outstanding = `#tabBody > .card:last-child > div [data-pay="${id}"]`;
  assert.ok(p.q(outstanding), 'while unpaid it is among the outstanding ones');
  await p.click(p.q(`input[data-act="paid"][data-id="${id}"]`));
  assert.equal(p.q('details summary') && p.text(p.q('details summary')), 'Paid (1)');
  assert.ok(p.q(`details [data-pay="${id}"]`)); assert.doesNotMatch(text(p, `[data-pay="${id}"]`), /overdue/);
  assert.equal(p.q(outstanding), null, 'no longer among the outstanding ones');
  await p.click(p.q(`input[data-act="paid"][data-id="${id}"]`));
  assert.equal(p.q('details'), null); assert.match(text(p, `[data-pay="${id}"]`), /5 days overdue/);
  p.close();
});

test('removing a mistaken payment asks first, and its items become available to log again', async () => {
  const go = await order({ proxy: 'Sam' }); const i = await item(go);
  const id = (await api('POST', '/api/admin/proxy/payments', { proxy: 'Sam', keys: [`item:${i}`], summary: 'Oops' })).json.id;
  const p = await open();
  assert.equal(p.q(`tr[data-cand="item:${i}"]`), null);
  await p.click(p.q(`[data-act="remove"][data-id="${id}"]`));
  assert.match(text(p, '.ui-modal'), /Remove this proxy payment\?.*Sam — Oops.*become available to log again/s);
  await press(p, 'Keep it');
  assert.ok(p.q(`[data-pay="${id}"]`));
  await p.click(p.q(`[data-act="remove"][data-id="${id}"]`)); await press(p, 'Remove it');
  assert.match(toast(p), /Removed/);
  assert.equal(p.q(`[data-pay="${id}"]`), null);
  assert.ok(p.q(`tr[data-cand="item:${i}"]`), 'waiting to be logged again');
  p.close();
});

test('payments can be searched by proxy or summary', async () => {
  const go = await order(); const [a, b] = [await item(go), await item(go)];
  const [pa, pb] = [(await api('POST', '/api/admin/proxy/payments', { proxy: 'Searchy One', keys: [`item:${a}`], summary: 'alpha order' })).json.id, (await api('POST', '/api/admin/proxy/payments', { proxy: 'Other', keys: [`item:${b}`], summary: 'beta order' })).json.id];
  const p = await open();
  await p.type(p.q('#pxSearch'), 'searchy'); await new Promise((r) => setTimeout(r, 400)); await p.settle();
  assert.ok(p.q(`[data-pay="${pa}"]`)); assert.equal(p.q(`[data-pay="${pb}"]`), null);
  await p.type(p.q('#pxSearch'), 'zzz-nothing'); await new Promise((r) => setTimeout(r, 400)); await p.settle();
  assert.match(text(p), /No matches for that search/);
  p.close();
});

test('names with HTML in them are shown as text', async () => {
  const go = await order({ proxy: '<b>Proxy</b>' }); const i = await item(go, { title: '<img src=x onerror="window.pwned=1"> item' });
  const p = await open();
  assert.equal(p.q('#tabBody img'), null);
  assert.match(text(p, `tr[data-cand="item:${i}"]`), /<img src=x onerror="window\.pwned=1"> item.*<b>Proxy<\/b>/);
  await tick(p, `item:${i}`); await p.click(p.byText('button', 'Save'));
  assert.equal(p.q('#tabBody img'), null); assert.equal(p.window.pwned, undefined);
  p.close();
});

test('the Overdue tab lists unpaid proxy payments that are past their date', async () => {
  const go = await order(); const i = await item(go);
  const id = (await api('POST', '/api/admin/proxy/payments', { proxy: 'Slow Pay', deadline: iso(8), summary: 'Very late order', keys: [`item:${i}`] })).json.id;
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Overdue'));
  assert.match(text(p, `[data-proxy="${id}"]`), new RegExp(`Slow Pay — Very late order.*Due ${uk(iso(8))}.*8 days overdue`, 's'));
  assert.match(text(p), /unpaid proxy payments? past their date/);
  assert.ok(Number(p.q('#tabs [data-tab="overdue"] .badge').textContent) >= 1);
  await api('PATCH', `/api/admin/proxy/payments/${id}`, { paid: true });
  await p.click(p.byText('#tabs button', 'Overdue'));
  assert.equal(p.q(`[data-proxy="${id}"]`), null, 'paid, so it comes off');
  p.close();
});

test('claims that arrive after a payment was logged reappear in the list, labelled as new ones, and can be logged on top', async () => {
  const go = await order({ proxy: 'Sam' }); const i = await item(go);
  await claimAndSecure(app, admin, `pxl${++N}`, i);                                       // a 2nd confirmed claim (item() made the 1st)
  await api('POST', '/api/admin/proxy/payments', { proxy: 'Sam', keys: [`item:${i}`], summary: 'First run' });
  let p = await open();
  assert.equal(p.q(`tr[data-cand="item:${i}"]`), null, 'all paid for');
  assert.match(text(p, '[data-pay]'), /UI item \d+ — 2 claims/, 'the payment says how many claims it covered');
  p.close();
  await claimAndSecure(app, admin, `pxl${++N}`, i); await claimAndSecure(app, admin, `pxl${++N}`, i);
  p = await open();
  assert.match(text(p, `tr[data-cand="item:${i}"]`), /UI item \d+ — 2 more confirmed claims \(2 already paid for\)/);
  await tick(p, `item:${i}`);
  await p.click(p.byText('button', 'Save'));
  assert.match(text(p, '#pxMsg'), /Saved/);
  assert.equal(p.q(`tr[data-cand="item:${i}"]`), null, 'and the new ones are now paid for too');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});
