import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage, toast } from './ui.helpers.js';

// Proxy tab: "Payments" | "Ordered from" (what each payment covered, how much has arrived, who to chase) and "Hidden from this list"; Group Orders: the "not via a proxy" tick.
let app, admin, w, N = 0, fx = {};
const ARRIVED = 'arrived at proxy / warehouse';
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); const api = (m, p, b) => app.api(m, p, b, admin);
  const mk = async (proxy, title) => { const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy })).json.id; return { go, item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 9, title: `${title} album` })).json.id }; };
  const claims = async (item, n) => { const ids = []; for (let i = 0; i < n; i++) ids.push((await claimAndSecure(app, admin, `px${++N}`, item))[0]); return ids; };
  const days = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  fx.sam = await mk('Sam', 'Sam run'); fx.samClaims = await claims(fx.sam.item, 2); fx.p1 = (await api('POST', '/api/admin/proxy/payments', { proxy: 'Sam', keys: [`item:${fx.sam.item}`], summary: 'Sam run — two albums', paid: true })).json.id;
  await api('POST', '/api/admin/claims/pipeline', { claimIds: [fx.samClaims[0]], pipeline: ARRIVED }); await app.q('UPDATE proxy_payments SET paid_at = ?, created_at = ? WHERE id = ?', [days(20), days(21), fx.p1]);
  fx.yuki = await mk('Yuki', 'Yuki run'); fx.yukiClaims = await claims(fx.yuki.item, 1); fx.p2 = (await api('POST', '/api/admin/proxy/payments', { proxy: 'Yuki', keys: [`item:${fx.yuki.item}`], summary: 'Yuki run — one album', paid: true })).json.id; await api('POST', '/api/admin/claims/pipeline', { claimIds: fx.yukiClaims, pipeline: ARRIVED });
  fx.late = await mk('Sam', 'Unpaid run'); await claims(fx.late.item, 1); fx.p3 = (await api('POST', '/api/admin/proxy/payments', { proxy: 'Sam', keys: [`item:${fx.late.item}`], summary: 'Unpaid run' })).json.id;
  fx.direct = await mk('Sam', 'Direct order'); await claims(fx.direct.item, 3); await api('PATCH', `/api/admin/orders/${fx.direct.go}`, { noProxy: true });
  fx.single = await mk('Sam', 'Mixed order'); await claims(fx.single.item, 2); await api('PATCH', `/api/admin/items/${fx.single.item}`, { noProxy: true });
});
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = async (tab = 'Proxy') => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', tab)); await sleep(300); await p.settle(); return p; };
const view = async (p, v) => { await p.click(p.q(`[data-act="px-view"][data-view="${v}"]`)); await sleep(100); await p.settle(); };
const on = (p) => p.q('#pxView .chip.on').dataset.view;
const done = async (p) => { await sleep(450); await p.settle(); };

test('TWO VIEWS ON THE PROXY TAB: "Payments" (as before) and "Ordered from", which flags how many to chase; each shows only its own things', async () => {
  const p = await open(); assert.deepEqual(p.qa('#pxView .chip').map((c) => c.dataset.view), ['payments', 'ordered'.replace('ordered', 'history')]); assert.equal(on(p), 'payments', 'opens on Payments'); assert.match(p.text(p.q('#pxView [data-view="history"]')), /^Ordered from 1 to chase$/);
  assert.ok(p.q('#proxyMe') && p.byText('h2', 'Log a proxy payment') && p.byText('h2', 'Proxy payments'), 'PAYMENTS: your proxies, the log and the list'); assert.equal(p.q('#pxHistory'), null);
  await view(p, 'history'); assert.equal(on(p), 'history'); assert.ok(p.q('#pxHistory'), 'ORDERED FROM'); assert.equal(p.q('#proxyMe, [data-cand]'), null, 'no log form here'); await view(p, 'payments'); assert.ok(p.q('#pxName'), 'back to the log form'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('ORDERED FROM: grouped by proxy — the one with something to chase first — each payment says what was paid, when, how much has arrived and whether to chase; "What it covered" lists the items', async () => {
  const p = await open(); await view(p, 'history'); const groups = p.qa('[data-proxy-group]').map((g) => g.dataset.proxyGroup); assert.deepEqual(groups.slice(0, 2), ['Sam', 'Yuki'], 'Sam has one to chase, so she comes first'); const sam = p.q('[data-proxy-group="Sam"]'), yuki = p.q('[data-proxy-group="Yuki"]');
  assert.match(p.text(p.q('h3', sam)), /^Sam — 2 payments · 2 still waiting 1 to chase$/); assert.match(p.text(p.q('h3', yuki)), /^Yuki — 1 payment$/);
  const one = p.q(`[data-hist="${fx.p1}"]`); assert.match(p.text(one), /^Sam run — two albums paid \d{2}\/\d{2}\/\d{4}\s*1 of 2 arrived Chase — paid 20 days ago/); assert.ok(one.querySelector('[data-chase]') && one.querySelector('[data-progress].warn'), 'flagged to chase');
  const two = p.q(`[data-hist="${fx.p2}"]`); assert.match(p.text(two), /All 1 arrived/); assert.ok(two.querySelector('[data-complete]') && !two.querySelector('[data-chase]'), 'complete: nothing to chase');
  const three = p.q(`[data-hist="${fx.p3}"]`); assert.match(p.text(three), /^Unpaid run logged \d{2}\/\d{2}\/\d{4} — not paid yet\s*0 of 1 arrived/); assert.equal(three.querySelector('[data-chase]'), null, 'unpaid is never "chase"');
  assert.equal(one.querySelector('details').hidden, false, 'the covered list can be opened'); assert.match(p.text(one.querySelector('details summary')), /^What it covered \(1 item\)$/); assert.match(p.text(one.querySelector('[data-hist-item]')), /^Sam run — Sam run album — 1 of 2 arrived$/); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('THE FILTERS: All · To chase (n) · Still waiting (n) — proxies with nothing to show disappear, and an empty filter says so', async () => {
  const p = await open(); await view(p, 'history'); const f = (k) => p.q(`[data-act="px-filter"][data-k="${k}"]`); assert.deepEqual(p.qa('#histFilter .chip').map((c) => p.text(c)), ['All', 'To chase (1)', 'Still waiting (2)']); assert.equal(f('all').getAttribute('aria-pressed'), 'true');
  await p.click(f('chase')); assert.deepEqual(p.qa('[data-hist]').map((x) => Number(x.dataset.hist)), [fx.p1], 'only the payment to chase'); assert.equal(p.q('[data-proxy-group="Yuki"]'), null, 'a proxy with nothing to show is gone');
  await p.click(f('waiting')); assert.deepEqual(p.qa('[data-hist]').map((x) => Number(x.dataset.hist)).sort(), [fx.p1, fx.p3].sort(), 'everything still waiting, paid or not'); await p.click(f('all')); assert.ok(p.q(`[data-hist="${fx.p2}"]`));
  await api('POST', `/api/admin/claims/pipeline`, { claimIds: [fx.samClaims[1]], pipeline: ARRIVED }); const q = await open(); await view(q, 'history'); await q.click(q.q('[data-act="px-filter"][data-k="chase"]')); assert.match(q.text(q.q('#pxHistory')), /Nothing to chase right now\./, 'when it all arrives there is nothing to chase'); assert.equal(q.qa('[data-hist]').length, 0); q.close(); p.close();
});

test('"HIDDEN FROM THIS LIST": shown on Payments when something is ticked "not via a proxy" — a whole group order, or one item — with how many claims; the items really are off the list; "Show again" puts them back', async () => {
  const p = await open(); const fold = () => p.q('#pxHidden'); assert.ok(fold(), 'the fold is there'); assert.match(p.text(fold().querySelector('summary')), /^Hidden from this list \(2\) — ordered direct or on hand$/); assert.equal(fold().open, false, 'folded');
  assert.match(p.text(p.q(`[data-hidden-order="${fx.direct.go}"]`)), /^Direct order — whole group order · 1 item · 3 confirmed claimsShow again$/); assert.match(p.text(p.q(`[data-hidden-item="${fx.single.item}"]`)), /^Mixed order album — Mixed order · 2 confirmed claimsShow again$/);
  assert.equal(p.q(`[data-cand="item:${fx.direct.item}"], [data-cand="item:${fx.single.item}"]`), null, 'neither is on the Log a proxy payment list');
  await p.click(p.q(`[data-hidden-item="${fx.single.item}"] [data-act="px-unhide"]`)); await done(p); assert.equal(toast(p), 'Back on the list.'); assert.ok(p.q(`[data-cand="item:${fx.single.item}"]`), 'back on the list'); assert.equal(p.q(`[data-hidden-item="${fx.single.item}"]`), null);
  await p.click(p.q(`[data-hidden-order="${fx.direct.go}"] [data-act="px-unhide"]`)); await done(p); assert.ok(p.q(`[data-cand="item:${fx.direct.item}"]`), 'the whole group order is back'); assert.equal(p.q('#pxHidden'), null, 'nothing hidden any more: no fold');
  assert.equal((await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === fx.direct.go).noProxy, false); await api('PATCH', `/api/admin/orders/${fx.direct.go}`, { noProxy: true }); await api('PATCH', `/api/admin/items/${fx.single.item}`, { noProxy: true }); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('THE TICK ON GROUP ORDERS AND ITEMS: on the new group order form, the edit form, and both item forms; a "not via a proxy" marker shows in the tables; saving an item without changing it records nothing', async () => {
  const p = await open('Group Orders'); await p.click(p.byText('button', '＋ New group order')); const nf = p.q('form[data-form="new-order"]'); assert.match(p.text(nf.querySelector('[name="noProxy"]').closest('.full')), /^Ordered direct \/ on hand — not via a proxyLeaves all its items off the Proxy tab's “Log a proxy payment” list\.$/);
  p.fill(nf, { group: String(w.group), title: 'Born direct order', noProxy: true }); await p.submit(nf); await done(p); const go = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.title === 'Born direct order'); assert.equal(go.noProxy, true, 'saved from the new group order form');
  await p.click(p.q(`[data-act="open-items"][data-id="${go.id}"]`)); await sleep(100); await p.settle(); const row = p.q('#orderList [data-no-proxy]'); assert.ok(row, 'the marker shows against the group order'); assert.equal(p.text(row), 'not via a proxy');
  await p.click(p.q('#addItemBox > summary')); const f = p.q('form[data-form="new-item"]'); p.fill(f, { title: 'Direct item', price: '5', noProxy: true }); await p.submit(f); await done(p); let items = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go.id).items; assert.equal(items.find((i) => i.title === 'Direct item').noProxy, true, 'saved from the new item form'); assert.ok(p.q('#itemsPanel [data-no-proxy]'), 'and shown against the item');
  const id = items.find((i) => i.title === 'Direct item').id; await p.click(p.q(`[data-act="edit-item"][data-id="${id}"]`)); const ef = p.q('form[data-form="edit-item"]'); assert.equal(ef.elements.noProxy.checked, true, 'ticked in the edit form'); const n0 = (await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'item.no_proxy'"))[0].n;
  ef.elements.title.value = 'Direct item (renamed)'; await p.submit(ef); await done(p); assert.equal((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'item.no_proxy'"))[0].n, n0, 'saving it with the tick unchanged records nothing');
  await p.click(p.q(`[data-act="edit-item"][data-id="${id}"]`)); const ef2 = p.q('form[data-form="edit-item"]'); ef2.elements.noProxy.checked = false; await p.submit(ef2); await done(p); items = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go.id).items; assert.equal(items.find((i) => i.id === id).noProxy, false, 'unticked in the edit form'); assert.equal(p.q('#itemsPanel [data-no-proxy]'), null);
  await p.click(p.q(`[data-act="edit-order"][data-id="${go.id}"]`)); const of = p.q('form[data-form="edit-order"]'); assert.equal(of.elements.noProxy.checked, true); of.elements.noProxy.checked = false; await p.submit(of); await done(p); assert.equal((await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go.id).noProxy, false, 'unticked in the edit group order form');
  await p.click(p.q(`[data-act="edit-order"][data-id="${go.id}"]`)); const of2 = p.q('form[data-form="edit-order"]'); assert.equal(of2.elements.noProxy.checked, false); of2.elements.noProxy.checked = true; await p.submit(of2); await done(p); assert.equal((await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go.id).noProxy, true, 'and ticked again in the edit group order form'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});
