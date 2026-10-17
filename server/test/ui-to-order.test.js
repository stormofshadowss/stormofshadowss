import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// Warehouse → Incoming → "To order": what is secured and still needs ordering, counted per option — by group order or by proxy — with a copy button.
let app, admin, w, N = 0, ids;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const api = (m, p, b) => app.api(m, p, b, admin); const mk = async (title, proxy) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy })).json.id;
  const item = async (go, extra) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, ...extra })).json.id; const claim = (lines) => app.api('POST', '/api/claims', { handle: `to${++N}`, lines });
  ids = { sam: await mk('Skzoo Pop-up', 'Sam'), yuki: await mk('Ateez Fansign', 'Yuki'), me: await mk('Own order', null) };
  const plain = await item(ids.sam, { title: 'Strap plush' }), tee = await item(ids.sam, { type: 'size', variants: ['M', 'L'], title: 'Pop-up tee' }), cards = await item(ids.sam, { type: 'independent', members: ['Han', 'Felix'], title: 'Photocards' });
  for (let i = 0; i < 5; i++) await claim([{ itemId: plain }]); await claim([{ itemId: tee, variant: 'M', qty: 2 }]); await claim([{ itemId: tee, variant: 'L' }]); await claim([{ itemId: cards, member: 'Han', qty: 3 }]); await claim([{ itemId: cards, member: 'Felix' }]);
  const ay = await item(ids.yuki, { title: 'Lightstick' }); await claim([{ itemId: ay, qty: 2 }]); const own = await item(ids.me, { title: 'Zine' }); await claim([{ itemId: own }]);
  for (const go of Object.values(ids)) await api('POST', '/api/admin/claims/secure', { orderId: go });
  await item(ids.sam, { title: 'Not secured yet' }); await claim([{ itemId: (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === ids.sam).items.find((i) => i.title === 'Not secured yet').id }]);
});
after(async () => { await app.stop(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Warehouse')); await sleep(120); await p.settle(); await p.click(p.q('[data-act="wh-view"][data-view="incoming"]')); await sleep(150); await p.settle(); return p; };
const chip = (p, k) => p.q(`[data-act="filter"][data-k="${k}"]`);
const group = (p, key) => p.q(`[data-to-order-group="${key}"]`);
const optionsOf = (p, g, item) => p.qa('[data-option]', [...p.qa('[data-to-order-item]', g)].find((r) => p.text(r).includes(item))).map((x) => p.text(x));

test('THE "TO ORDER" CHIP shows the count, and opens a list of secured claims per option — "5× …, 3× …, 1× …" — by group order, with unsecured requests left out', async () => {
  const p = await open(); assert.match(p.text(chip(p, 'toorder')), /^To order \(\d+\)$/); await p.click(chip(p, 'toorder')); const g = group(p, `o${ids.sam}`); assert.ok(g, 'a card for the group order');
  assert.deepEqual(optionsOf(p, g, 'Strap plush'), ['5×'], 'a plain item: its total'); assert.deepEqual(optionsOf(p, g, 'Pop-up tee'), ['1× L', '2× M'], 'a size item: per size'); assert.deepEqual(optionsOf(p, g, 'Photocards'), ['1× Felix', '3× Han'], 'a member item: per member');
  assert.doesNotMatch(p.text(g), /Not secured yet/, 'a request nobody has secured is not something to order yet'); assert.match(p.text(p.q('[data-to-order] .sub'), 'copies'), /secured and waiting to be ordered/); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('YOU CAN SWITCH BETWEEN GROUP ORDER AND PROXY: proxies become the headings with their group orders underneath ("Me" for what you order yourself), and the choice stays', async () => {
  const p = await open(); await p.click(chip(p, 'toorder')); await p.click(p.q('[data-act="to-by"][data-by="proxy"]'));
  const heads = p.qa('[data-to-order-group] > .row strong').map((x) => p.text(x)); for (const h of ['Sam', 'Yuki', 'Me (no proxy)']) assert.ok(heads.includes(h), `${h} is a heading`);
  const sam = group(p, 'pSam'); assert.match(p.text(sam), /Skzoo Pop-up.*Strap plush.*Pop-up tee.*Photocards/s); assert.doesNotMatch(p.text(sam), /Lightstick|Zine/, 'other proxies\' items are not under Sam'); assert.match(p.text(group(p, 'pYuki')), /Ateez Fansign.*Lightstick/s);
  assert.equal(p.q('[data-act="to-by"][data-by="proxy"]').getAttribute('aria-pressed'), 'true'); await p.click(p.q('[data-act="to-by"][data-by="order"]')); assert.ok(group(p, `o${ids.sam}`), 'and back again'); p.close();
});

test('COPY: each group has "Copy list" and there is "Copy all" — plain text you can paste into a message or a shop\'s notes', async () => {
  const p = await open(); await p.click(chip(p, 'toorder')); const copied = []; p.window.navigator.clipboard = { writeText: async (t) => { copied.push(t); } };
  await p.click(p.q('[data-act="copy"]', group(p, `o${ids.sam}`))); await sleep(40); assert.match(toast(p), /Copied\./); assert.equal(copied[0], 'Skzoo Pop-up (Sam)\nStrap plush: 5×\nPop-up tee: 1× L, 2× M\nPhotocards: 1× Felix, 3× Han');
  await p.click(p.q('[data-copy-all]')); await sleep(40); assert.match(copied[1], /Own order \(Me\)\nZine: 1×[\s\S]*Ateez Fansign \(Yuki\)\nLightstick: 2×[\s\S]*Skzoo Pop-up \(Sam\)\nStrap plush: 5×/, 'every group, newest group order first');
  await p.click(p.q('[data-act="to-by"][data-by="proxy"]')); await p.click(p.q('[data-act="copy"]', group(p, 'pYuki'))); await sleep(40); assert.equal(copied[2], 'Yuki\nAteez Fansign\n  Lightstick: 2×'); p.close();
});

test('MOVING CLAIMS ON TAKES THEM OFF THE LIST (and the count on the chip falls); when nothing is left it says so', async () => {
  const api = (m, p, b) => app.api(m, p, b, admin); const claims = (await api('GET', `/api/admin/claims?order=${ids.me}`)).json.claims.map((c) => c.id);
  const p = await open(); await p.click(chip(p, 'toorder')); assert.ok(group(p, `o${ids.me}`)); const before = Number(p.text(chip(p, 'toorder')).match(/\((\d+)\)/)[1]);
  assert.equal((await api('POST', '/api/admin/claims/pipeline', { claimIds: claims, pipeline: 'ordered via proxy / warehouse' })).status, 200); p.close();
  const q = await open(); assert.equal(group(q, `o${ids.me}`), null, 'no longer listed'); await q.click(chip(q, 'toorder')); assert.equal(group(q, `o${ids.me}`), null); assert.equal(Number(q.text(chip(q, 'toorder')).match(/\((\d+)\)/)[1]), before - 1);
  const every = (await api('GET', '/api/admin/incoming/to-order')).json.rows.length; assert.ok(every > 0); q.close();
});

test('ITEM AND ORDER NAMES WITH HTML are shown as text', async () => {
  const api = (m, p, b) => app.api(m, p, b, admin); const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: '<img src=x onerror="window.pwned=1"> GO', proxy: 'Sam' })).json.id;
  const it = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'independent', members: ['<b>Bold</b>'], title: '<i>Item</i>', price: 4 })).json.id; await app.api('POST', '/api/claims', { handle: `to${++N}`, lines: [{ itemId: it, member: '<b>Bold</b>' }] }); await api('POST', '/api/admin/claims/secure', { orderId: go });
  const p = await open(); await p.click(chip(p, 'toorder')); assert.equal(p.q('img[src="x"]'), null); assert.equal(p.q('[data-to-order] b'), null); assert.equal(p.window.pwned, undefined); assert.match(p.text(group(p, `o${go}`)), /<img src=x onerror="window\.pwned=1"> GO.*<i>Item<\/i>.*1× <b>Bold<\/b>/s); p.close();
});


// ───────── "Log as a store order…": the To order list → a New store order with its items already in ─────────
const form = (p) => p.q('#newOrder');
const lines = (p) => p.qa('[data-line-row]', form(p)).map((r) => { const v = r.querySelector('[data-combo-input]').value; return [v.includes(' — ') ? v.slice(0, v.lastIndexOf(' — ')) : v, r.querySelector('[name=qty]').value, r.querySelector('[name=lnote]').value]; });   // [item name, how many, note] (the box shows "Item — Group order")
const mkOrder = async (title, proxy, items) => { const api = (m, pa, b) => app.api(m, pa, b, admin); const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy })).json.id; const out = [];
  for (const it of items) { const id = (await api('POST', `/api/admin/orders/${go}/items`, { type: it.members ? 'independent' : 'normal', price: 5, ...it })).json.id; out.push(id); for (const [member, qty] of it.claims || [[null, it.qty || 1]]) await app.api('POST', '/api/claims', { handle: `lg${++N}`, lines: [{ itemId: id, ...(member ? { member } : {}), qty }] }); }
  await api('POST', '/api/admin/claims/secure', { orderId: go }); return { go, items: out }; };

test('"LOG AS A STORE ORDER…" OPENS THE FORM FILLED IN: one line per item with how many, the options in the line\'s note, "Placed by" set to the group\'s proxy — and the cursor in the Store box', async () => {
  const p = await open(); await p.click(chip(p, 'toorder')); assert.equal(form(p), null, 'not open until asked'); await p.click(p.q('[data-act="log-order"]', group(p, `o${ids.sam}`))); await sleep(60);
  assert.ok(form(p)); assert.match(p.text(p.q('[data-prefill]', form(p))), /Filled in from Skzoo Pop-up on your To order list — check the quantities, add the store, then save\./);
  assert.deepEqual(lines(p), [['Strap plush', '5', ''], ['Pop-up tee', '3', '1× L, 2× M'], ['Photocards', '4', '1× Felix, 3× Han']], 'the same totals and options as the list'); assert.ok(p.qa('[data-line-row] [name=itemId]', form(p)).every((i) => Number(i.value) > 0), 'each line has its item really chosen (not just shown)'); assert.equal(form(p).elements.proxy.value, 'Sam'); assert.equal(form(p).elements.store.value, '', 'you still add the store');
  assert.equal(p.window.document.activeElement, form(p).elements.store, 'ready to type the store'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('THE PROXY IS FILLED IN FROM THE GROUP: by proxy it is that proxy ("Me" = blank); a group whose items have different proxies leaves it for you to choose', async () => {
  const none = await mkOrder('Self-ordered GO', null, [{ title: 'My own thing' }]); const mixed = await mkOrder('Mixed proxies GO', 'Sam', [{ title: 'Sam thing' }, { title: 'Yuki thing', proxy: 'Yuki' }]);
  const p = await open(); await p.click(chip(p, 'toorder'));
  await p.click(p.q('[data-act="log-order"]', group(p, `o${mixed.go}`))); assert.equal(form(p).elements.proxy.value, '', 'two proxies in one group: you choose'); assert.equal(lines(p).length, 2);
  await p.click(p.q('[data-act="to-by"][data-by="proxy"]')); await p.click(p.q('[data-act="log-order"]', group(p, 'pYuki'))); assert.equal(form(p).elements.proxy.value, 'Yuki'); assert.ok(lines(p).some(([t, q]) => t === 'Lightstick' && q === '2'));
  assert.ok(lines(p).some(([t]) => t === 'Yuki thing'), 'by proxy, only that proxy\'s items — across group orders'); await p.click(p.q('[data-act="log-order"]', group(p, 'pMe'))); assert.equal(form(p).elements.proxy.value, ''); assert.ok(lines(p).some(([t]) => t === 'My own thing')); void none; p.close();
});

test('SAVING IT creates the store order with those lines and notes, and tells you the next step; nothing is moved on yet (the list is unchanged)', async () => {
  const api = (m, pa, b) => app.api(m, pa, b, admin); const me = await mkOrder('Save flow GO', 'Yuki', [{ title: 'Keyring set', members: ['Han', 'Felix'], claims: [['Han', 2], ['Felix', 1]] }]);
  const p = await open(); await p.click(chip(p, 'toorder')); const before = Number(p.text(chip(p, 'toorder')).match(/\((\d+)\)/)[1]); await p.click(p.q('[data-act="log-order"]', group(p, `o${me.go}`)));
  form(p).elements.store.value = 'Ktown4u'; form(p).elements.orderRef.value = 'KT-1001'; await p.submit(form(p)); await sleep(350); await p.settle();
  assert.match(toast(p), /Store order saved\. To move those claims on, use “Mark ordered…” under By item\./); assert.equal(form(p), null, 'the form closes'); assert.equal(p.q('[data-act="filter"][data-k="toorder"]').getAttribute('aria-pressed'), 'true', 'and you are still on the To order list');
  const saved = (await api('GET', '/api/admin/incoming')).json.orders.find((o) => o.orderRef === 'KT-1001'); assert.deepEqual([saved.store, saved.proxy, saved.lines.map((l) => [l.qty, l.note])], ['Ktown4u', 'Yuki', [[3, '1× Felix, 2× Han']]]);
  assert.equal(Number(p.text(chip(p, 'toorder')).match(/\((\d+)\)/)[1]), before, 'logging a store order does not move claims on by itself'); p.close();
});

test('THE WHOLE JOURNEY: see what to order → log it → "Mark ordered…" under By item moves exactly those claims → they leave the To order list', async () => {
  const j = await mkOrder('Journey GO', 'Sam', [{ title: 'Journey album', qty: 4 }]); const api = (m, pa, b) => app.api(m, pa, b, admin);
  const p = await open(); await p.click(chip(p, 'toorder')); assert.match(p.text(group(p, `o${j.go}`)), /Journey album.*4 in all/s); await p.click(p.q('[data-act="log-order"]', group(p, `o${j.go}`))); form(p).elements.store.value = 'Weverse Shop'; await p.submit(form(p)); await sleep(350); await p.settle();
  await p.click(chip(p, 'items')); await p.click(p.q(`[data-act="advance"][data-to="ordered"][data-id="${j.items[0]}"]`)); await sleep(250); await p.settle(); assert.match(p.text(modal(p)), /Move 4 claims to “ordered via proxy \/ warehouse”\?/); await press(p, 'Move them'); await sleep(350); await p.settle();
  assert.equal((await api('GET', `/api/admin/claims?order=${j.go}`)).json.claims.filter((c) => c.pipeline === 'ordered via proxy / warehouse').length, 4, 'all four moved'); await p.click(chip(p, 'toorder')); assert.equal(group(p, `o${j.go}`), null, 'gone from the list'); p.close();
});

test('THE ORDINARY "+ New store order" BUTTON IS STILL A BLANK FORM (no leftover pre-fill), and closing the filled-in form forgets it', async () => {
  const p = await open(); await p.click(chip(p, 'toorder')); await p.click(p.q('[data-act="log-order"]', group(p, `o${ids.sam}`))); assert.ok(p.q('[data-prefill]'));
  await p.click(p.q('[data-act="new"]')); assert.equal(form(p), null, 'pressing + New store order while the filled-in form is open closes it');
  await p.click(p.q('[data-act="new"]')); assert.ok(form(p)); assert.equal(p.q('[data-prefill]'), null, 'no hint'); assert.deepEqual(lines(p), [['', '', '']], 'one empty line'); assert.equal(p.q('[name=itemId]', form(p)).value, '', 'and no item chosen'); assert.equal(form(p).elements.proxy.value, ''); p.close();
});

test('A LONG LIST OF OPTIONS STILL SAVES: the note is kept within its 200 characters (cut with "…") instead of failing', async () => {
  const members = Array.from({ length: 30 }, (_, i) => `Member Number ${String(i + 1).padStart(2, '0')}`); const long = await mkOrder('Long options GO', 'Sam', [{ title: 'Huge set', members, claims: members.map((m) => [m, 1]) }]);
  const p = await open(); await p.click(chip(p, 'toorder')); await p.click(p.q('[data-act="log-order"]', group(p, `o${long.go}`))); const note = lines(p)[0][2]; assert.ok(note.length <= 200 && note.endsWith('…'), `kept within 200 (is ${note.length})`); assert.ok(note.startsWith('1× Member Number 01, 1× Member Number 02'));
  form(p).elements.store.value = 'Big shop'; form(p).elements.orderRef.value = 'LONG-1'; await p.submit(form(p)); await sleep(350); await p.settle(); assert.match(toast(p), /Store order saved/); assert.equal((await app.api('GET', '/api/admin/incoming', undefined, admin)).json.orders.find((o) => o.orderRef === 'LONG-1').lines[0].qty, 30); p.close();
});

test('NAMES WITH HTML in the pre-filled form are shown as text (the hint, the item picker and the note)', async () => {
  const x = await mkOrder('<img src=x onerror="window.pwned=1"> Hint GO', 'Sam', [{ title: '<b>Bold</b> thing', members: ['<i>Han</i>'], claims: [['<i>Han</i>', 2]] }]);
  const p = await open(); await p.click(chip(p, 'toorder')); await p.click(p.q('[data-act="log-order"]', group(p, `o${x.go}`))); assert.equal(p.q('img[src="x"]'), null); assert.equal(p.window.pwned, undefined); assert.equal(p.q('#newOrder b'), null);
  assert.match(p.text(p.q('[data-prefill]')), /<img src=x onerror="window\.pwned=1"> Hint GO/); assert.deepEqual(lines(p)[0], ['<b>Bold</b> thing', '2', '2× <i>Han</i>']); p.close();
});
