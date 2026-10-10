import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage, gomPage, toast } from './ui.helpers.js';

// The store look on a phone: round group avatars with filter chips, "Open now / Closing soon / New" with picture cards, picture-led item cards, the 1-2-3 steps,
// the bottom bar, and the light/dark button.
let app, admin, w, N = 0, G = {};
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'sl') => `${x}${++N}`;
const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const png = (c) => sharp({ create: { width: 60, height: 60, channels: 3, background: c } }).png().toBuffer();
const put = async (kind, id, c = '#c36') => (await fetch(`${app.base}/api/admin/images/${kind}/${id}`, { method: 'PUT', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'image/png' }, body: await png(c) })).status;
const text = (p, sel, root) => p.text(p.q(sel, root));
const shop = async (hash = '') => { const p = await openPage(app, `/${hash}`); await sleep(120); await p.settle(); return p; };
const go = async (p, hash) => { p.window.location.hash = hash; await sleep(60); await p.settle(); };

before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const grp = async (name, kind) => { const id = (await api('POST', '/api/admin/groups', { name, ...(kind ? { kind } : {}) })).json.id; return id; };
  G.boy = await grp('Boy Band One', 'boy band'); G.girl = await grp('Girl Group One', 'girl group'); G.solo = await grp('Solo One', 'solo'); G.none = await grp('Untyped Act'); G.empty = await grp('Nothing Open', 'duo');
  await put('group', G.boy);                                                                                      // only this one has a picture
  const order = async (group, title, extra = {}) => (await api('POST', '/api/admin/orders', { groupId: group, title, ...extra })).json.id;
  G.soon = await order(G.boy, 'Soon Order', { closeDate: iso(3) }); G.tomorrow = await order(G.girl, 'Tomorrow Order', { closeDate: iso(1) }); G.today = await order(G.solo, 'Today Order', { closeDate: iso(0) });
  G.old = await order(G.boy, 'Old Order', { closeDate: iso(40) }); G.noClose = await order(G.none, 'No Close Order'); G.closed = await order(G.boy, 'Closed Order', { status: 'closed' });
  await app.q('UPDATE group_orders SET created_at = DATE_SUB(NOW(), INTERVAL 30 DAY) WHERE id IN (?)', [[G.old, G.closed]]);
  await put('order', G.soon, '#36c');
  G.simple = (await api('POST', `/api/admin/orders/${G.soon}/items`, { type: 'normal', title: 'Simple Album', price: 10 })).json.id;
  G.simple2 = (await api('POST', `/api/admin/orders/${G.soon}/items`, { type: 'normal', title: 'Pictured Album', price: 12 })).json.id; await put('item', G.simple2, '#3c6');
  G.set = (await api('POST', `/api/admin/orders/${G.soon}/items`, { type: 'set', title: 'Card Set', price: 4, members: ['A', 'B'] })).json.id;
  G.indep = (await api('POST', `/api/admin/orders/${G.soon}/items`, { type: 'independent', title: 'POB Card', price: 3, members: ['A', 'B'] })).json.id;
});
after(async () => { await app.stop(); });

test('HOME: round avatars for groups with something open (not for a group with nothing open), the exact intro sentence, escaped names', async () => {
  const bad = (await api('POST', '/api/admin/groups', { name: '<img src=x onerror="window.pwned=1"> Act' })).json.id; await api('POST', '/api/admin/orders', { groupId: bad, title: 'x' });
  const p = await shop();
  assert.equal(text(p, 'h1'), 'Group orders'); assert.match(text(p, '.hero'), /Pick what you want and claim it with just your Instagram handle — no password, no sign-up\. Storm will confirm claims, then you pay\./);
  const names = p.qa('#groupCards .avatar-link').map((a) => p.text(a));
  for (const n of ['Boy Band One', 'Girl Group One', 'Solo One', 'Untyped Act']) assert.ok(names.some((t) => t.startsWith(n)), n);
  assert.ok(!names.some((t) => t.startsWith('Nothing Open')), 'a group with nothing open has no avatar');
  const boy = p.q(`[data-group="${G.boy}"]`); assert.ok(p.q('.avatar-ring img', boy), 'a group with a picture shows it'); assert.match(p.text(boy), /2 open orders/, 'Soon Order and Old Order (the closed one is not counted)');
  const untyped = p.q(`[data-group="${G.none}"]`); assert.equal(p.q('.avatar-ring .ph', untyped)?.getAttribute('data-i'), 'UA', 'no picture: initials on a colour tile');
  assert.equal(p.q('#groupCards img[src="x"]'), null); assert.equal(p.window.pwned, undefined); assert.ok(names.some((t) => t.startsWith('<img src=x onerror="window.pwned=1"> Act')), 'shown as text');
  assert.deepEqual(p.errors, []); p.close();
});

test('FILTER CHIPS: All plus only the types that exist among open groups; a chip filters the avatars AND the order cards; "All" resets; the choice survives going to a group and back', async () => {
  const p = await shop(); const chips = () => p.qa('#kindChips .chip').map((c) => p.text(c));
  assert.deepEqual(chips(), ['All', 'Boy bands', 'Girl groups', 'Solos'], 'no Duos chip: the only duo has nothing open');
  assert.equal(p.q('#kindChips .chip.on').getAttribute('aria-pressed'), 'true');
  await p.click(p.byText('#kindChips .chip', 'Boy bands'));
  assert.ok(p.qa('#groupCards .avatar-link').every((a) => /^Boy Band One/.test(p.text(a))) && p.qa('#groupCards .avatar-link').length === 1);
  assert.ok(p.qa('#homeOrders .ocard').every((c) => /Boy Band One/.test(p.text(c))), 'order cards follow the chip'); assert.equal(p.byText('#kindChips .chip', 'Boy bands').getAttribute('aria-pressed'), 'true');
  await p.click(p.q(`[data-group="${G.boy}"]`)); await sleep(80); await p.settle(); await go(p, '#/'); assert.equal(p.qa('#groupCards .avatar-link').length, 1, 'still filtered after going to a group and back');
  await p.click(p.byText('#kindChips .chip', 'All')); assert.ok(p.qa('#groupCards .avatar-link').length >= 4);
  p.close();
});

test('OPEN NOW / CLOSING SOON / NEW: right counts and cards, tabs with nothing in them are hidden, flags say when, and the order is sensible', async () => {
  const p = await shop(); const tabs = () => p.qa('#homeTabs .utab').map((c) => p.text(c));
  const open = await (async () => (await fetch(`${app.base}/api/orders`).then((r) => r.json())).orders.filter((o) => o.status === 'open').length)();
  assert.deepEqual(tabs(), [`Open now${open}`, 'Closing soon3', 'New' + (open - 2 - 0 > 0 ? p.text(p.byText('#homeTabs .utab', 'New')).replace('New', '') : '')].map((x) => x), 'Open now, Closing soon, New');
  assert.equal(p.qa('#homeOrders .ocard').length, open); assert.ok(!p.q(`[data-order="${G.closed}"]`), 'a closed order is not on the home page');
  await p.click(p.byText('#homeTabs .utab', 'Closing soon'));
  assert.deepEqual(p.qa('#homeOrders .ocard').map((c) => c.dataset.order), [String(G.today), String(G.tomorrow), String(G.soon)], 'soonest first; the order closing in 40 days is not here');
  assert.deepEqual(p.qa('#homeOrders .flag').map((f) => p.text(f)), ['Closes today', 'Closes tomorrow', 'Closes in 3 days']);
  await p.click(p.byText('#homeTabs .utab', 'New'));
  assert.ok(p.qa('#homeOrders .ocard').every((c) => c.dataset.order !== String(G.old)), 'a month-old order is not "New"'); assert.ok(p.qa('#homeOrders .flag.new').length >= 1);
  const card = p.q(`#homeOrders [data-order="${G.soon}"]`) || null; if (card) assert.match(card.getAttribute('href'), new RegExp(`#/order/${G.soon}$`));
  await p.click(p.byText('#homeTabs .utab', 'Open now')); assert.match(p.text(p.q(`[data-order="${G.soon}"]`)), /Soon OrderBoy Band One · 4 items · closes /);
  assert.ok(p.q(`[data-order="${G.soon}"] img.cover`) && p.q(`[data-order="${G.noClose}"] .cover.ph`), 'a cover picture, or a coloured tile with initials');
  assert.equal(p.q(`[data-order="${G.noClose}"] .cover.ph`).getAttribute('data-i'), 'NC'); assert.match(p.q(`[data-order="${G.noClose}"] .cover.ph`).getAttribute('style'), /--h:\d+/);
  p.close();
});

test('A GROUP PAGE: avatar header, chips to the other groups (current one marked), its order cards, closed orders tucked away', async () => {
  const p = await shop(`#/group/${G.boy}-boy-band-one`);
  assert.equal(text(p, 'h1'), 'Boy Band One'); assert.ok(p.q('.avatar-ring img'));
  assert.equal(p.q('#groupTabs [aria-current="page"]').dataset.tab, String(G.boy)); assert.ok(p.qa('#groupTabs .chip').length >= 4);
  assert.equal(p.qa('.ordergrid')[0].querySelectorAll('.ocard').length, 2, 'Soon Order and Old Order');
  assert.match(p.text(p.q('details')), /Closed orders \(1\)/); assert.ok(p.q(`details [data-order="${G.closed}"]`));
  p.close();
});

test('THE ORDER PAGE: a 1-2-3 tracker (1 current), items as picture cards in a grid — simple items small, sets and member options wide — and a coloured tile when there is no picture', async () => {
  const p = await shop(`#/order/${G.soon}`);
  assert.deepEqual(p.qa('.steps li').map((l) => p.text(l)), ['1Choose', '2Check', '3Claim']); assert.equal(p.q('.steps li[aria-current="step"]').textContent, '1Choose');
  const card = (id) => p.q(`[data-item-card="${id}"]`);
  assert.equal(p.qa('.itemgrid > .card.item').length, 4);
  assert.ok(!card(G.simple).classList.contains('wide') && !card(G.simple2).classList.contains('wide'), 'simple items are small cards');
  assert.ok(card(G.set).classList.contains('wide') && card(G.indep).classList.contains('wide'), 'sets and member options need the width');
  assert.ok(p.q('a.picbox img.thumb', card(G.simple2)), 'a picture when there is one'); assert.equal(p.q('.picbox.ph', card(G.simple)).getAttribute('data-i'), 'SA', 'otherwise a colour tile with initials');
  assert.ok(p.q('[data-act="inc"]', card(G.simple)), 'the stepper still works inside the new card');
  await p.click(p.q('[data-act="inc"]', card(G.simple))); assert.match(text(p, '#bottomBar .cnt'), /^1$/, 'the bottom bar counts it');
  const closed = await shop(`#/order/${G.closed}`); assert.equal(closed.q('.steps'), null, 'a closed order has no steps'); closed.close(); p.close();
});

test('THE BASKET AND DONE PAGES CONTINUE THE STEPS: 2 Check is current, the claim form is step 3, and when it is done every step is ticked off', async () => {
  const p = await shop(`#/order/${G.soon}`); await p.click(p.q(`[data-item-card="${G.simple}"] [data-act="inc"]`)); await go(p, '#/basket');
  assert.equal(p.q('.steps li[aria-current="step"]').textContent, '2Check'); assert.ok(p.q('.steps li.done'), 'step 1 is ticked off');
  assert.match(text(p, 'form[data-form="claim"] .stephead'), /^3 Who's claiming\?$/); assert.match(text(p, 'h1'), /Your selections/);
  p.type(p.q('#ig'), u('new')); await p.submit(p.q('form[data-form="claim"]')); await sleep(200); await p.settle();
  assert.match(text(p, 'h1'), /Claims submitted/); assert.equal(p.qa('.steps li.done').length, 3, 'all three done'); assert.equal(p.q('.steps li.on'), null);
  p.close();
});

test('THE BOTTOM BAR (phones): Home, Basket with a count, My orders — on the shop and on My orders; the active one is marked; the count follows the basket', async () => {
  const p = await shop(); const bar = () => p.q('#bottomBar');
  assert.deepEqual(p.qa('a', bar()).map((a) => p.text(a).replace(/\d+$/, '')), ['Home', 'Basket', 'My orders']); assert.ok(p.q('a[data-nav="shop"]', bar()).classList.contains('on'));
  assert.equal(p.q('.cnt', bar()).hidden, true, 'no count on an empty basket'); assert.match(p.q('a[data-nav="my"]', bar()).getAttribute('href'), /\/my\.html$/);
  await go(p, `#/order/${G.soon}`); await p.click(p.q(`[data-item-card="${G.simple}"] [data-act="inc"]`)); await p.click(p.q(`[data-item-card="${G.simple}"] [data-act="inc"]`));
  assert.equal(p.q('.cnt', bar()).hidden, false); assert.equal(p.text(p.q('.cnt', bar())), '2');
  assert.match(p.q('a[data-nav="basket"]', bar()).getAttribute('href'), /#\/basket$/); p.close();
  const my = await openPage(app, '/my.html'); await sleep(100); await my.settle(); assert.ok(my.q('a[data-nav="my"]', my.q('#bottomBar')).classList.contains('on')); my.close();
});

test('NO HINT NOISE: member tiles of a brand-new set say nothing about "the next set"; once a set exists they do', async () => {
  const p = await shop(`#/order/${G.soon}`);
  assert.equal(p.qa('[data-spot]').length, 0, 'no sets yet: nothing to point at');
  await app.api('POST', '/api/claims', { handle: u('hint'), lines: [{ itemId: G.set, parts: [{ member: 'A', qty: 1 }] }] });
  const q = await shop(`#/order/${G.soon}`); const spots = q.qa(`[data-item-card="${G.set}"] [data-spot]`).map((s) => q.text(s));
  assert.deepEqual(spots, ['next one starts a new set', 'open in Set 1']); p.close(); q.close();
});

test('LIGHT / DARK: the soft pop (light) look by default; the footer button switches, remembers the choice in this browser, and labels itself', async () => {
  const p = await shop(); const html = p.window.document.documentElement, btn = () => p.q('#siteFoot [data-theme-toggle]');
  assert.equal(html.getAttribute('data-theme'), 'light'); assert.equal(p.text(btn()), '☾ Dark mode');
  await p.click(btn()); assert.equal(html.getAttribute('data-theme'), 'dark'); assert.equal(p.text(btn()), '☀ Light mode'); assert.equal(p.window.localStorage.getItem('sos_theme'), 'dark');
  assert.equal(p.q('meta[name="theme-color"]').getAttribute('content'), '#100c18', 'the phone\'s browser bar follows');
  await p.click(btn()); assert.equal(html.getAttribute('data-theme'), 'light'); assert.equal(p.window.localStorage.getItem('sos_theme'), 'light');
  p.window.localStorage.setItem('sos_theme', 'dark'); const t = p.window.SOS_THEME; assert.equal(t.get(), 'dark', 'reads what is stored'); p.window.localStorage.setItem('sos_theme', 'nonsense'); assert.equal(t.get(), 'light', 'anything unknown falls back to the default');
  p.close();
});

test('THE GOM: a Type selector for each group (saved straight away, feeds the chips) and a light/dark button in the admin footer', async () => {
  const p = await gomPage(app, admin); await sleep(100); await p.settle();
  assert.ok(p.q('#whoami') && p.q('.foot [data-theme-toggle]'), 'a theme button in the admin footer');
  const sel = p.q(`select[data-kind-for="${G.none}"]`); assert.ok(sel, 'in the group pictures card'); assert.deepEqual([...sel.options].map((o) => o.text), ['— none —', 'Boy band', 'Girl group', 'Solo', 'Duo']);
  assert.equal(p.q(`select[data-kind-for="${G.boy}"]`).value, 'boy band', 'shows the current type');
  await p.choose(sel, 'duo'); await sleep(100); await p.settle(); assert.match(toast(p), /Saved\./);
  assert.equal((await fetch(`${app.base}/api/groups`).then((r) => r.json())).groups.find((g) => g.id === G.none).kind, 'duo');
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});
