import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

// The Incoming view (inside the Warehouse tab): store orders with tracking, arrivals, the chase flag, item counts, and the buttons that move the oldest claims along.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const u = (x = 'ui') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const text = (p, sel, root) => p.text(p.q(sel, root));
const newItem = async (title = u('Album ')) => { const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Inc GO '), proxy: 'Sam' })).json.id; return { go, item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price: 10 })).json.id, title }; };
const claims = async (item, n) => { const ids = []; for (let i = 0; i < n; i++) ids.push((await claimAndSecure(app, admin, u('p'), item))[0]); return ids; };
const store = async (body) => (await api('POST', '/api/admin/store-orders', { store: 'Ktown4u', orderedOn: iso(-2), ...body })).json.id;
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Warehouse')); await sleep(80); await p.settle(); await p.click(p.q('[data-act="wh-view"][data-view="incoming"]')); await sleep(100); await p.settle(); return p; };
const card = (p, id) => p.q(`[data-store-order="${id}"]`);
const stage = async (id) => (await app.q('SELECT pipeline FROM claims WHERE id = ?', [id]))[0].pipeline;

test('THE SWITCH: Warehouse has Boxes and Incoming; each remembers nothing it shouldn\'t, and both work', async () => {
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Warehouse')); await sleep(80); await p.settle();
  assert.deepEqual(p.qa('#whSwitch .chip').map((c) => p.text(c)), ['Boxes', 'Incoming']); assert.equal(p.q('#whSwitch .chip.on').textContent, 'Boxes'); assert.ok(p.q('#candidates, [data-act="cand-all"], h2') && /New box/.test(p.text(p.q('#tabBody'))), 'the boxes view is as before');
  await p.click(p.q('[data-view="incoming"]')); await sleep(100); await p.settle();
  assert.equal(p.q('#whSwitch .chip.on').textContent, 'Incoming'); assert.ok(p.q('#incomingSummary')); assert.match(text(p, '#incomingSummary'), /Nothing outstanding/);
  await p.click(p.q('[data-view="boxes"]')); await sleep(100); await p.settle(); assert.match(p.text(p.q('#tabBody')), /New box/);
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('ADDING A STORE ORDER: store, number, link, who placed it, several items and tracking numbers; it appears as Waiting with everything shown; bad input is explained', async () => {
  const a = await newItem('Form Album'), b = await newItem('Form Poster');
  const p = await open(); await p.click(p.q('[data-act="new"]'));
  const f = p.q('#newOrder'); assert.ok(f && /New store order/.test(p.text(f)));
  const row = () => p.qa('[data-line-row]', f);
  const setLine = (r, item, qty, note) => { r.querySelector('[name=itemId]').value = String(item); r.querySelector('[name=qty]').value = String(qty); if (note) r.querySelector('[name=lnote]').value = note; };
  // a line with an item but no count is refused before anything is sent
  setLine(row()[0], a.item, ''); f.elements.store.value = 'Weverse Shop'; await p.submit(f); assert.match(text(p, '[data-msg]', f), /Each item line needs an item and how many\./);
  await p.click(p.q('[data-act="more-lines"]')); await p.click(p.q('[data-act="more-ships"]')); assert.equal(row().length, 2);
  setLine(row()[0], a.item, 3, 'ver. A'); setLine(row()[1], b.item, 1);
  f.elements.orderRef.value = 'WV-777'; f.elements.orderedOn.value = iso(-1); f.elements.proxy.value = 'Sam'; f.elements.orderUrl.value = 'javascript:alert(1)';
  const ships = p.qa('[data-ship-row]', f); ships[0].querySelector('[name=carrier]').value = 'CJ Logistics'; ships[0].querySelector('[name=trackingNo]').value = '6401 2345 6789'; ships[1].querySelector('[name=trackingNo]').value = 'EE123456789KR';
  await p.submit(f); await sleep(150); await p.settle(); assert.match(text(p, '[data-msg]', f), /The link must start with http:\/\/ or https:\/\//, 'the server\'s reason is shown');
  f.elements.orderUrl.value = 'https://weverse.io/o/777'; await p.submit(f); await sleep(200); await p.settle();
  assert.match(toast(p), /Store order saved\./); assert.equal(p.q('#newOrder'), null, 'the form closes');
  const c = p.qa('[data-store-order]')[0];
  assert.match(p.text(c), /Weverse Shop #WV-777 · ordered .*· by Sam/); assert.equal(p.q('[data-state]', c).dataset.state, 'waiting'); assert.match(p.text(p.q('[data-state]', c)), /Waiting · 1 day/);
  assert.deepEqual(p.qa('tr[data-line]', c).map((r) => [p.text(r.children[0]).startsWith(r.children[1].previousElementSibling ? 'Form ' : ''), p.text(r.children[1])]), [[true, '3'], [true, '1']]);
  assert.match(p.text(p.qa('tr[data-line]', c)[0]), /^Form Album.*ver\. A/); assert.match(p.text(p.qa('tr[data-line]', c)[1]), /^Form Poster/);
  assert.deepEqual(p.qa('[data-ship]', c).map((s) => p.text(s.querySelector('strong'))), ['6401 2345 6789', 'EE123456789KR']);
  assert.ok(p.q('a[href="https://weverse.io/o/777"][rel="noopener noreferrer"]', c), 'the order page link'); assert.equal((await api('GET', '/api/admin/incoming')).json.orders.length, 1);
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('TRACKING: a "Track" link built from the carrier (number spaces removed, opens safely in a new tab), none for "Other"; add and remove tracking numbers; mark one arrived', async () => {
  const { item } = await newItem(); const id = await store({ lines: [{ itemId: item, qty: 2 }], shipments: [{ carrier: 'CJ Logistics', trackingNo: '6401 2345 6789' }, { carrier: 'Other', trackingNo: 'ODD-12345' }] });
  const p = await open(); const c = () => card(p, id);
  const link = p.q('a[data-track]', c()); assert.equal(link.getAttribute('href'), 'https://trace.cjlogistics.com/next/tracking.html?wblNo=640123456789'); assert.deepEqual([link.target, link.rel], ['_blank', 'noopener noreferrer']);
  assert.equal(p.qa('a[data-track]', c()).length, 1, 'no link for "Other"');
  assert.equal(p.q('[data-form="add-ship"]', c()), null, 'the add form is tucked away'); await p.click(p.q('[data-act="add-ship"]', c()));
  const f = p.q('[data-form="add-ship"]', c()); f.elements.carrier.value = 'DHL'; f.elements.trackingNo.value = '<b>x</b>'; await p.submit(f); await sleep(120); await p.settle();
  assert.match(text(p, `[data-ship-msg="${id}"]`), /letters, numbers, spaces and dashes/, 'html is refused with the reason');
  const f2 = p.q('[data-form="add-ship"]', c()); f2.elements.carrier.value = 'DHL'; f2.elements.trackingNo.value = 'JD0146000012345'; await p.submit(f2); await sleep(150); await p.settle();
  assert.equal(p.qa('[data-ship]', c()).length, 3); assert.equal(p.q('a[data-track][href*="dhl.com"]', c()).getAttribute('href'), 'https://www.dhl.com/gb-en/home/tracking.html?tracking-id=JD0146000012345');
  const ship = p.qa('[data-ship]', c())[0]; await p.click(p.q('[data-act="ship-arrived"]', ship)); await sleep(100); await p.settle();
  assert.match(p.text(p.qa('[data-ship]', c())[0]), new RegExp(`arrived ${iso(0).slice(8, 10)}/`)); await p.click(p.q('[data-act="del-ship"]', p.qa('[data-ship]', c())[2])); await sleep(100); await p.settle(); assert.equal(p.qa('[data-ship]', c()).length, 2);
  p.close();
});

test('ARRIVALS: typing how many arrived saves and changes the state; "All arrived" asks first; the chase flag shows on old orders and goes once chased', async () => {
  const { item } = await newItem(); const old = await store({ store: 'Old Shop', orderedOn: iso(-20), lines: [{ itemId: item, qty: 4 }] }), fresh = await store({ store: 'Fresh Shop', orderedOn: iso(-1), lines: [{ itemId: item, qty: 2 }] });
  const p = await open();
  assert.deepEqual(p.qa('[data-store-order]').map((c) => c.querySelector('strong').textContent).filter((n) => ['Old Shop', 'Fresh Shop'].includes(n)), ['Old Shop', 'Fresh Shop'], 'waiting list: oldest first');
  assert.ok(p.q('[data-chase-flag]', card(p, old)) && !p.q('[data-chase-flag]', card(p, fresh)), 'only the 20-day-old order is flagged'); assert.match(text(p, '[data-to-chase]'), /1 to chase/);
  const inp = p.q('[data-arrived]', card(p, old)); inp.value = '3'; inp.dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(150); await p.settle();
  assert.match(p.text(p.q('[data-state]', card(p, old))), /Part arrived 3\/4 · 20 days/); assert.equal((await api('GET', '/api/admin/incoming')).json.orders.find((o) => o.id === old).arrived, 3);
  await p.click(p.q('[data-act="chased"]', card(p, old))); await sleep(120); await p.settle(); assert.match(toast(p), /Noted — chased today\./); assert.equal(p.q('[data-chase-flag]', card(p, old)), null, 'chased today: leave it for a week'); assert.match(p.text(card(p, old)), /chased \d\d\/\d\d\/\d{4}/);
  await p.click(p.q('[data-act="arrived-all"]', card(p, fresh))); assert.match(p.text(modal(p)), /Mark everything on this store order as arrived\?/); await press(p, 'Not yet');
  assert.equal((await api('GET', '/api/admin/incoming')).json.orders.find((o) => o.id === fresh).arrived, 0, 'not yet means not yet');
  await p.click(p.q('[data-act="arrived-all"]', card(p, fresh))); await press(p, 'Yes, all arrived'); await sleep(120); await p.settle();
  assert.equal(card(p, fresh), null, 'it leaves the Waiting list'); await p.click(p.byText('#orderFilter .chip', 'Arrived')); assert.match(p.text(p.q('[data-state]', card(p, fresh))), /^Arrived$/);
  p.close();
});

test('BY ITEM: needed / ordered / arrived with what is still to order and what is on the way; filter by group order', async () => {
  const x = await newItem('Counted Album'); await claims(x.item, 5); await store({ lines: [{ itemId: x.item, qty: 3 }] });
  const p = await open(); await p.click(p.byText('#orderFilter .chip', 'By item'));
  const row = () => p.q(`tr[data-count="${x.item}"]`);
  assert.deepEqual([...row().children].slice(1, 4).map((c) => p.text(c)), ['5', '3', '0']); assert.match(p.text(row()), /2 still to order.*3 on the way/s);
  await p.choose(p.q('[data-filter="group"]'), (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === x.go).title); assert.equal(p.qa('tr[data-count]').length, 1, 'only that group order');
  p.close();
});

test('MOVE THE OLDEST CLAIMS ALONG: "Mark ordered…" lists who, asks first, moves exactly that many, and says so when there is nothing left to move', async () => {
  const x = await newItem('Moving Album'); const ids = await claims(x.item, 4);
  const p = await open(); await p.click(p.byText('#orderFilter .chip', 'By item')); const btn = (to) => p.q(`tr[data-count="${x.item}"] [data-act="advance"][data-to="${to}"]`);
  await p.click(btn('ordered')); assert.match(toast(p), /No copies are marked ordered on a store order yet\./);
  await store({ lines: [{ itemId: x.item, qty: 2 }] });
  await p.click(p.byText('#orderFilter .chip', 'By item')); await p.click(btn('ordered'));
  assert.match(p.text(modal(p)), /Move 2 claims to “ordered via proxy \/ warehouse”\?.*The oldest first: @p\d+, @p\d+\..*2 ordered · 0 arrived · 4 needed\./s); await press(p, 'Not yet');
  assert.deepEqual([await stage(ids[0]), await stage(ids[2])], ['awaiting fulfillment', 'awaiting fulfillment'], 'not yet means not yet');
  await p.click(btn('ordered')); await press(p, 'Move them'); await sleep(200); await p.settle(); assert.match(toast(p), /Moved 2 claims\./);
  assert.deepEqual([await stage(ids[0]), await stage(ids[1]), await stage(ids[2])], ['ordered via proxy / warehouse', 'ordered via proxy / warehouse', 'awaiting fulfillment'], 'the two OLDEST');
  await p.click(p.byText('#orderFilter .chip', 'By item')); await p.click(btn('ordered')); assert.match(toast(p), /Nothing to move — claims already match the 2 ordered\./);
  p.close();
});

test('EDITING: change the store, who placed it and the notes; cancel and reopen; delete (with a warning that no claims change)', async () => {
  const { item } = await newItem(); const id = await store({ store: 'Typo Shop', lines: [{ itemId: item, qty: 1 }] });
  const p = await open(); await p.click(p.q('[data-act="edit"]', card(p, id)));
  const f = p.q('[data-form="edit-order"]', card(p, id)); f.elements.store.value = 'Right Shop'; f.elements.proxy.value = 'Sam'; f.elements.notes.value = 'chase on Friday'; await p.submit(f); await sleep(150); await p.settle();
  assert.match(toast(p), /Saved\./); assert.match(p.text(card(p, id)), /Right Shop.*by Sam.*chase on Friday/s);
  await p.click(p.q('[data-act="edit"]', card(p, id))); await p.click(p.q('[data-act="cancel-order"]', card(p, id))); assert.match(p.text(modal(p)), /Cancel this store order\?/); await press(p, 'Cancel it'); await sleep(120); await p.settle();
  assert.equal(card(p, id), null, 'a cancelled order leaves the Waiting list'); await p.click(p.byText('#orderFilter .chip', 'Cancelled')); assert.match(p.text(p.q('[data-state]', card(p, id))), /Cancelled/);
  await p.click(p.q('[data-act="edit"]', card(p, id))); await p.click(p.q('[data-act="reopen"]', card(p, id))); await sleep(120); await p.settle(); await p.click(p.byText('#orderFilter .chip', 'Waiting')); assert.ok(card(p, id), 'reopened');
  await p.click(p.q('[data-act="edit"]', card(p, id))); await p.click(p.q('[data-act="del-order"]', card(p, id))); assert.match(p.text(modal(p)), /no claims are changed/); await press(p, 'Delete'); await sleep(120); await p.settle(); assert.equal(card(p, id), null);
  assert.equal((await api('GET', '/api/admin/incoming')).json.orders.some((o) => o.id === id), false); p.close();
});

test('THE WAREHOUSE ADDRESS: saved once, shown with a Copy button', async () => {
  const p = await open(); const f = p.q('[data-form="address"]'); f.elements.address.value = 'Seoul Warehouse\n123 Example-ro'; await p.submit(f); await sleep(150); await p.settle();
  assert.match(toast(p), /Address saved\./); assert.match(text(p, '[data-address]'), /Seoul Warehouse\s+123 Example-ro/); assert.equal(p.q('[data-address]').textContent, 'Seoul Warehouse\n123 Example-ro', 'line breaks kept'); assert.ok(p.byText('button', 'Copy address'));
  p.close();
});

test('NAMES WITH HTML are shown as text everywhere on the Incoming view', async () => {
  const { item } = await newItem('<b>Bold</b> Album'); await store({ store: '<img src=x onerror="window.pwned=1"> Shop', orderRef: '<i>ref</i>', notes: '<script>window.pwned=2</script>', lines: [{ itemId: item, qty: 1, note: '<u>note</u>' }], shipments: [{ trackingNo: 'SAFE123456' }] });
  const p = await open(); const c = p.qa('[data-store-order]').find((x) => x.textContent.includes('window.pwned=1'));
  assert.equal(p.q('img', c), null); assert.equal(p.q('b, i, u, script', c), null); assert.equal(p.window.pwned, undefined); assert.match(p.text(c), /<img src=x onerror="window\.pwned=1"> Shop #<i>ref<\/i>.*<script>window\.pwned=2<\/script>.*<b>Bold<\/b> Album.*<u>note<\/u>/s);
  p.close();
});
