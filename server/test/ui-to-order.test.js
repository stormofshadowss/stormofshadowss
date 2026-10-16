import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { gomPage, toast } from './ui.helpers.js';

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
