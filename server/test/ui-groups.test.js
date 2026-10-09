import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { openPage } from './ui.helpers.js';

// Each group has its own page. The home page lists only groups with orders open (each a card); group pages have tabs to jump between groups.
let app, admin, G = {}, O = {};
before(async () => {
  app = await startApp(); admin = await app.adminLogin();
  const api = (m, p, b) => app.api(m, p, b, admin);
  const grp = async (name) => (await api('POST', '/api/admin/groups', { name })).json.id;
  const ord = async (groupId, title, extra = {}) => { const id = (await api('POST', '/api/admin/orders', { groupId, title, ...extra })).json.id; await api('POST', `/api/admin/orders/${id}/items`, { type: 'normal', title: `${title} item`, price: 5 }); return id; };
  G.ateez = await grp('Ateez'); G.skz = await grp('Stray Kids'); G.quiet = await grp('Quiet Crew'); G.fresh = await grp('Brand New Group'); G.hidden = await grp('Off-site holder');
  await app.q('UPDATE artist_groups SET is_hidden = 1 WHERE id = ?', [G.hidden]);
  O.a1 = await ord(G.ateez, 'Golden Hour'); O.a2 = await ord(G.ateez, 'Ateez Photobook');
  O.s1 = await ord(G.skz, 'Run It GO'); O.s2 = await ord(G.skz, 'Old GO', { status: 'closed' }); O.s3 = await ord(G.skz, 'Secret GO', { isPrivate: true });
  O.q1 = await ord(G.quiet, 'Quiet Old GO', { status: 'closed' }); O.h1 = await ord(G.hidden, 'Hidden GO');
  await api('POST', '/api/admin/shop', { title: 'Shop thing', price: 3, qty: 2 });
});
after(async () => { await app.stop(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p, sel = '#view') => p.text(p.q(sel));
const go = async (p, hash) => { if (p.window.location.hash === hash) p.window.dispatchEvent(new p.window.HashChangeEvent('hashchange')); else p.window.location.hash = hash; await sleep(70); await p.settle(); };
const shop = async () => { const p = await openPage(app, '/'); await sleep(80); await p.settle(); return p; };

test('HOME: just the groups that have orders open, each a card with how many; the orders themselves are not here; quiet, new and hidden groups are left off', async () => {
  const p = await shop();
  const cards = p.qa('#groupCards a.gocard');
  assert.deepEqual(cards.map((c) => p.text(c)), ['Ateez2 open orders', 'Stray Kids1 open order'], 'Ateez has 2 open, Stray Kids 1 (its closed and private ones are not counted)');
  assert.deepEqual(cards.map((c) => c.getAttribute('href')), [`#/group/${G.ateez}-ateez`, `#/group/${G.skz}-stray-kids`]);
  const t = text(p);
  assert.match(t, /Group orders.*Pick what you want and claim it with just your Instagram handle/s);
  for (const hidden of ['Golden Hour', 'Run It GO', 'Quiet Crew', 'Brand New Group', 'Off-site holder', 'Hidden GO', 'Secret GO']) assert.ok(!t.includes(hidden), `${hidden} is not on the home page`);
  assert.match(t, /Shop.*Shop — on hand now.*1 item available/s, 'the shop card is still there');
  assert.deepEqual(p.errors, []); p.close();
});

test('A GROUP PAGE: its own address, a title, tabs to jump to other groups (the current one marked), its open orders, and closed ones tucked away; private ones nowhere', async () => {
  const p = await shop(); await p.click(p.q(`a.gocard[data-group="${G.skz}"]`)); await sleep(80); await p.settle();
  assert.equal(p.window.location.hash, `#/group/${G.skz}-stray-kids`);
  const tabs = p.qa('#groupTabs a'); assert.deepEqual(tabs.map((t) => p.text(t)), ['Ateez', 'Stray Kids'], 'tabs for the groups with orders open');
  assert.deepEqual(tabs.map((t) => t.getAttribute('aria-current')), [null, 'page'], 'the current one is marked');
  assert.match(text(p, 'h1'), /Stray Kids/);
  assert.match(text(p), /Run It GO.*1 item/s); assert.ok(!text(p).includes('Secret GO'), 'private orders are nowhere');
  assert.match(text(p, 'details'), /Closed orders \(1\).*Old GO/s); assert.ok(!text(p).replace(/Closed orders.*/s, '').includes('Old GO'), 'closed ones are only inside the tucked-away part');
  // jump to another group with its tab
  await p.click(p.q(`#groupTabs a[data-tab="${G.ateez}"]`)); await sleep(80); await p.settle();
  assert.equal(p.window.location.hash, `#/group/${G.ateez}-ateez`); assert.match(text(p, 'h1'), /Ateez/);
  assert.match(text(p, '.cards'), /Ateez Photobook.*Golden Hour/s, 'newest order first'); assert.equal(p.q('details'), null, 'no closed orders: no closed section');
  assert.equal(p.q('#groupTabs a[aria-current="page"]').dataset.tab, String(G.ateez));
  // and back to the home page
  await p.click(p.q('.crumb a')); await sleep(80); await p.settle(); assert.ok(p.q('#groupCards'));
  assert.deepEqual(p.errors, []); p.close();
});

test('A QUIET GROUP (nothing open) is not on the home page or in other groups\' tabs — but its page still works by its link, says so, and shows its closed orders', async () => {
  const p = await shop(); await go(p, `#/group/${G.quiet}-quiet-crew`);
  assert.match(text(p, 'h1'), /Quiet Crew/); assert.match(text(p), /No group orders are open for Quiet Crew right now — check back soon\./);
  assert.match(text(p, 'details'), /Closed orders \(1\).*Quiet Old GO/s);
  assert.deepEqual(p.qa('#groupTabs a').map((t) => p.text(t)), ['Ateez', 'Quiet Crew', 'Stray Kids'], 'the groups with orders open, plus this one');
  assert.ok(p.qa('#groupTabs a').some((t) => p.text(t) === 'Quiet Crew' && t.getAttribute('aria-current') === 'page'), 'it shows its own tab, marked as current, so you can see where you are');
  await go(p, `#/group/${G.fresh}`);
  assert.match(text(p), /No group orders are open for Brand New Group right now/); assert.equal(p.q('details'), null, 'a brand-new group just has an empty page');
  await go(p, '#/'); assert.ok(!text(p).includes('Quiet Crew') && !text(p).includes('Brand New Group'));
  p.close();
});

test('THE MOMENT A QUIET GROUP OPENS AN ORDER it appears on the home page and in everyone\'s tabs; and a newly created group gets its page and card with no extra work', async () => {
  const api = (m, p, b) => app.api(m, p, b, admin);
  const brandNew = (await api('POST', '/api/admin/groups', { name: 'Newest Group' })).json.id;
  const before = await shop(); assert.ok(!text(before).includes('Newest Group')); before.close();
  const o = (await api('POST', '/api/admin/orders', { groupId: brandNew, title: 'Newest GO' })).json.id; void o;
  const o2 = (await api('POST', '/api/admin/orders', { groupId: G.quiet, title: 'Quiet comes back' })).json.id; void o2;
  const p = await shop();
  assert.deepEqual(p.qa('#groupCards a.gocard').map((c) => p.text(c).replace(/\d open orders?/, '')), ['Ateez', 'Newest Group', 'Quiet Crew', 'Stray Kids'], 'alphabetical, and the returning and the new group are both there');
  await go(p, `#/group/${brandNew}-newest-group`); assert.match(text(p), /Newest GO/);
  assert.ok(p.qa('#groupTabs a').map((t) => p.text(t)).includes('Quiet Crew'));
  // and closing it again tucks the quiet group away
  await api('PATCH', `/api/admin/orders/${o2}`, { status: 'closed' }); await api('PATCH', `/api/admin/orders/${o}`, { status: 'closed' });
  await go(p, '#/'); const names = p.qa('#groupCards a.gocard').map((c) => p.text(c)); assert.ok(!names.join().includes('Quiet Crew') && !names.join().includes('Newest Group'));
  p.close();
});

test('ROBUST LINKS: the id decides the page (a wrong or old name in the link is fine); an unknown, hidden or garbled group says so kindly and offers a way back', async () => {
  const p = await shop();
  await go(p, `#/group/${G.skz}-an-old-name`); assert.match(text(p, 'h1'), /Stray Kids/);
  await go(p, `#/group/${G.skz}`); assert.match(text(p, 'h1'), /Stray Kids/);
  for (const bad of ['#/group/999999', `#/group/${G.hidden}-off-site-holder`, '#/group/abc', '#/group/']) {
    await go(p, bad); assert.match(text(p), /That group isn't available\./, bad); assert.ok(p.q('#view a[href="#/"]'), `${bad}: a way back`);
  }
  assert.deepEqual(p.errors, []); p.close();
});

test('THE ORDER PAGE LINKS BACK TO ITS GROUP (named), not just to the home page; and the item-type pills are gone', async () => {
  const p = await shop(); await go(p, `#/group/${G.ateez}`);
  await p.click(p.q(`a.gocard[href="#/order/${O.a1}"]`)); await sleep(70); await p.settle();
  const back = p.q('.crumb a'); assert.equal(p.text(back), '← Ateez'); assert.equal(back.getAttribute('href'), `#/group/${G.ateez}-ateez`);
  assert.equal(p.qa('#view .pill').length, 0);
  await p.click(back); await sleep(80); await p.settle(); assert.match(text(p, 'h1'), /Ateez/);
  p.close();
});

test('moving quickly between pages never leaves a stale page painted (an answer that arrives late for an earlier page is ignored)', async () => {
  const p = await shop();
  // make the FIRST request for the groups list slow, so its answer arrives after the person has already gone somewhere else
  const real = p.window.fetch.bind(p.window); let calls = 0;
  p.window.fetch = (...a) => { const mine = String(a[0]).includes('/api/groups') ? ++calls : 0; return real(...a).then(async (r) => { if (mine === 1) await sleep(300); return r; }); };
  p.window.location.hash = `#/group/${G.ateez}`;          // slow answer…
  await sleep(30); p.window.location.hash = '#/';         // …but they have already gone back home (fast answer)
  await sleep(600); await p.settle();
  assert.equal(calls >= 2, true, 'both requests were made');
  assert.ok(p.q('#groupCards'), 'ended on the home page'); assert.equal(p.q('#groupTabs'), null, 'the late answer for the group page did not repaint over it');
  p.close();
});

test('with only one group open there are no tabs (nothing to jump to); with none open the home page says so', async () => {
  const solo = await startApp(); const sa = await solo.adminLogin();
  try {
    const g = (await solo.api('POST', '/api/admin/groups', { name: 'Only Group' }, sa)).json.id;
    const empty = await openPage(solo, '/'); await sleep(80); await empty.settle();
    assert.match(empty.text(empty.q('#view')), /No group orders are open right now — check back soon\./); empty.close();
    const o = (await solo.api('POST', '/api/admin/orders', { groupId: g, title: 'Solo GO' }, sa)).json.id; void o;
    const p = await openPage(solo, `/#/group/${g}`); await sleep(100); await p.settle();
    assert.equal(p.q('#groupTabs'), null); assert.match(p.text(p.q('#view')), /Only Group.*Solo GO/s); p.close();
  } finally { await solo.stop(); }
});
