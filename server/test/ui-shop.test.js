import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { openPage } from './ui.helpers.js';

let app, admin, w, closedOrder, closedItem, atOrder;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  await app.api('PATCH', `/api/admin/orders/${w.order}`, { closeDate: '2099-01-05' }, admin);
  const add = (order, body) => app.api('POST', `/api/admin/orders/${order}/items`, body, admin).then((r) => r.json.id);
  w.random = await add(w.order, { type: 'random', title: 'Random card', price: 2 });
  w.set = await add(w.order, { type: 'set', title: 'Seasons Greetings', price: 3, requiresFullSet: true, members: ['Bang Chan', 'Han', { name: 'Diary', price: 2 }, { name: 'Washi tape', price: 1 }] });
  const g2 = (await app.api('POST', '/api/admin/groups', { name: 'ATE1EY', members: ['A'] }, admin)).json.id;
  atOrder = (await app.api('POST', '/api/admin/orders', { groupId: g2, title: 'Debut GO', paymentDeadline: '2099-03-03' }, admin)).json.id;
  w.debut = await add(atOrder, { type: 'normal', title: 'Debut photobook', price: 20 });
  closedOrder = (await app.api('POST', '/api/admin/orders', { groupId: w.group, title: 'Old GO', status: 'closed' }, admin)).json.id;
  closedItem = await add(closedOrder, { type: 'normal', title: 'Old thing', price: 9 });
});
after(async () => { await app.stop(); });

const shop = (opts) => openPage(app, '/', opts);
const go = async (p, hash) => { p.window.location.hash = hash; await new Promise((r) => setTimeout(r, 25)); await p.settle(); };
const plus = async (p, itemId, { member, variant, n = 1 } = {}) => {
  for (let i = 0; i < n; i++) {
    const sel = `[data-act="inc"][data-item="${itemId}"]${member ? `[data-member="${member}"]` : ''}${variant ? `[data-variant="${variant}"]` : ''}`;
    await p.click(p.q(sel));
  }
};
const claimsOf = async (h) => (await app.api('GET', `/api/admin/claims?handle=${h}`, undefined, admin)).json.claims;
const submit = async (p, handle) => { p.q('#ig').value = handle; await p.submit(p.q('form[data-form="claim"]')); };

test('home: open group orders grouped by artist, private ones hidden, closed ones tucked away', async () => {
  const p = await shop();
  const text = p.text(p.q('#view'));
  assert.match(text, /Group orders/);
  assert.match(text, /Stray Kids.*Run It GO.*closes 05\/01\/2099.*pay by 10\/01\/2099/, 'UK dates');
  assert.match(text, /ATE1EY.*Debut GO/);
  assert.doesNotMatch(text.replace(/Closed orders.*/, ''), /Off-site Weverse|Old GO/, 'private and closed orders are not in the open list');
  assert.ok(!text.includes('Off-site Weverse'), 'a private order is nowhere on the page');
  assert.match(p.text(p.q('details')), /Closed orders \(1\).*Old GO/);
  assert.deepEqual(p.errors, []);
  p.close();
});

test('an order page shows every kind of item with prices, claimed counts and pay-by dates', async () => {
  const p = await shop();
  await go(p, `#/order/${w.order}`);
  const text = p.text(p.q('#view'));
  assert.match(text, /Run It GO.*Stray Kids · closes 05\/01\/2099 · payment due 10\/01\/2099/);
  assert.match(text, /Keyring.*£6\.00 each.*0 claimed · pay by 10\/01\/2099/);
  assert.match(text, /Album.*£26\.00 each.*pay by 02\/02\/2099/, 'an item with its own pay-by date shows that');
  assert.match(text, /Solo Photocards.*pick any members.*Bang Chan £8\.00.*Han £8\.00/);
  assert.match(text, /Hoodie.*£50\.00 each.*Size M.*Size L/);
  assert.match(text, /Random card.*random/);
  assert.match(text, /Seasons Greetings.*member set.*£9\.00 for the whole set.*every part must be claimed/);
  assert.match(text, /Diary £2\.00 · 0 claimed.*Washi tape £1\.00 · 0 claimed/, 'each part shows its own price and how many are claimed');
  assert.match(text, /you can take more than one of the same part, and each goes in a different set/);
  assert.ok(p.byText('button', 'Claim the whole set (£9.00, all in one set)'));
  p.close();
});

test('a closed order can be read but not claimed', async () => {
  const p = await shop();
  await go(p, `#/order/${closedOrder}`);
  assert.match(p.text(p.q('#view')), /This group order has closed/);
  assert.equal(p.qa('[data-act="inc"]').length, 0);
  await go(p, '#/order/999999');
  assert.match(p.text(p.q('#view')), /isn't available/);
  p.close();
});

test('the basket: steppers add and remove, the header total follows, and it is capped at 20', async () => {
  const p = await shop();
  await go(p, `#/order/${w.order}`);
  await plus(p, w.keyring, { n: 3 });
  await plus(p, w.hoodie, { variant: 'M' });
  await plus(p, w.photocards, { member: 'Han', n: 2 });
  assert.match(p.text(p.q('#basketPill')), /Basket \(6\) · £84\.00/, '3×£6 + £50 + 2×£8');
  await p.click(p.q(`[data-act="dec"][data-item="${w.keyring}"]`));
  assert.match(p.text(p.q('#basketPill')), /Basket \(5\) · £78\.00/);
  assert.equal(p.q(`[data-act="dec"][data-item="${w.random}"]`).disabled, true, 'nothing to remove yet');
  await plus(p, w.random, { n: 25 });
  assert.equal(p.q(`[data-act="inc"][data-item="${w.random}"]`).previousElementSibling.textContent, '20', 'the screen shows 20');
  assert.equal(p.q(`[data-act="inc"][data-item="${w.random}"]`).disabled, true, '+ is disabled at 20');
  const stored = JSON.parse(p.window.sessionStorage.getItem('sos_basket'));
  assert.equal(stored.find((l) => l.itemId === w.random).qty, 20, 'capped, and saved for a refresh');
  await go(p, '#/basket');
  const lines = p.text(p.q('#view'));
  assert.match(lines, /Keyring.*Run It GO · £6\.00 each.*£12\.00/);
  assert.match(lines, /Hoodie \(M\).*£50\.00/); assert.match(lines, /Solo Photocards — Han.*£16\.00/);
  p.close();
});

test('a basket survives a page refresh, and lines for things that vanished are dropped quietly', async () => {
  const saved = [{ key: `${w.keyring}||`, itemId: w.keyring, orderTitle: 'Run It GO', title: 'Keyring', label: 'Keyring', price: 6, qty: 2, member: null, variant: null },
    { key: '99999||', itemId: 99999, orderTitle: 'Gone', title: 'Gone', label: 'Gone', price: 5, qty: 1, member: null, variant: null }];
  const p = await shop({ init: (win) => win.sessionStorage.setItem('sos_basket', JSON.stringify(saved)) });
  assert.match(p.text(p.q('#basketPill')), /Basket \(2\) · £12\.00/, 'the item that no longer exists was dropped');
  p.close();
});

test('submitting needs a valid Instagram handle; mistakes are explained and the basket is kept', async () => {
  const p = await shop();
  await go(p, `#/order/${w.order}`); await plus(p, w.keyring);
  await go(p, '#/basket');
  await submit(p, '');
  assert.match(p.text(p.q('[data-msg]')), /Enter your Instagram ID first/);
  await submit(p, 'has space');
  assert.match(p.text(p.q('[data-msg]')), /letters, numbers, full stops and underscores/);
  assert.match(p.text(p.q('#basketPill')), /Basket \(1\)/, 'nothing was lost');
  assert.equal((await claimsOf('has space')).length, 0);
  await app.api('POST', '/api/admin/joiners/block', { handle: 'blocked_h', reason: 'test' }, admin);
  await submit(p, '@Blocked_H');
  assert.match(p.text(p.q('[data-msg]')), /can't place orders right now/);
  assert.match(p.text(p.q('#basketPill')), /Basket \(1\)/);
  p.close();
});

test('claiming as a new handle: no sign-in, claims recorded at the right prices, basket cleared, handle remembered', async () => {
  const p = await shop();
  await go(p, `#/order/${w.order}`);
  await plus(p, w.keyring, { n: 2 }); await plus(p, w.hoodie, { variant: 'L' }); await plus(p, w.photocards, { member: 'Bang Chan' });
  await go(p, '#/basket');
  await submit(p, '@New_Fan');
  assert.equal(p.window.location.hash, '#/done');
  const text = p.text(p.q('#view'));
  assert.match(text, /Claims submitted.*@new_fan/);
  assert.match(text, /2 × Keyring.*£12\.00/); assert.match(text, /1 × Hoodie \(L\)/); assert.match(text, /Total £70\.00/);
  assert.match(text, /requests for now/);
  const rows = (await claimsOf('new_fan')).map((c) => [c.label, c.status, c.costs.initials.cost]);
  assert.deepEqual(rows.sort(), [['Hoodie (L)', 'requested', 50], ['Keyring', 'requested', 6], ['Keyring', 'requested', 6], ['Solo Photocards — Bang Chan', 'requested', 8]].sort());
  assert.equal(p.window.sessionStorage.getItem('sos_basket'), '[]', 'basket emptied');
  assert.equal(p.q('#basketPill').textContent, '');
  assert.equal(p.window.localStorage.getItem('sos_handle'), 'new_fan');
  assert.equal((await app.q("SELECT account_id FROM joiners WHERE instagram_handle = 'new_fan'"))[0].account_id, null, 'no account was needed');
  p.close();
});

test('after claiming, add your email: the link both signs you in AND connects the handle, from any device — no GOM approval', async () => {
  const p = await shop();
  await go(p, `#/order/${w.order}`); await plus(p, w.keyring); await go(p, '#/basket'); await submit(p, 'email_fan');
  assert.match(p.text(p.q('#follow')), /Want to see your orders and pay\?.*one-time sign-in link/);
  p.q('#em').value = 'email.fan@x.com'; await p.submit(p.q('form[data-form="email"]'));
  assert.match(p.text(p.q('#follow')), /Check your email.*link is on its way/);
  assert.match(p.text(p.q('#follow')), /connects @email_fan to your email, from any device/);
  const out = await app.confirm(app.tokenFromMail('email.fan@x.com'));          // opened on a completely different device
  const me = (await app.api('GET', '/api/me', undefined, out.setCookie.split(';')[0])).json;
  assert.deepEqual(me.handles.map((h) => h.handle), ['email_fan']);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM handle_link_requests'))[0].n, 0, 'no approval was ever needed');
  p.close();
});

test('"Not now" is respected, and a second claim by someone who already has an account says welcome back', async () => {
  const p = await shop();
  await go(p, `#/order/${w.order}`); await plus(p, w.keyring); await go(p, '#/basket'); await submit(p, 'skip_fan');
  await p.click(p.byText('[data-act="skip-email"]', 'Not now'));
  assert.match(p.text(p.q('#follow')), /Whenever you want to see your orders, use.*My orders/);
  assert.equal(p.q('form[data-form="email"]'), null);

  const q = await shop();
  await go(q, `#/order/${w.order}`); await plus(q, w.keyring); await go(q, '#/basket'); await submit(q, 'email_fan');   // linked in the previous test
  assert.match(q.text(q.q('#follow')), /Welcome back.*@email_fan already has an account.*Sign in to see your orders/);
  assert.equal(q.q('form[data-form="email"]'), null, 'no email prompt for a handle that already has one');
  p.close(); q.close();
});

test('a different browser claiming an existing handle gets no email shortcut — just a pointer to sign in', async () => {
  const a = await shop();
  await go(a, `#/order/${w.order}`); await plus(a, w.keyring); await go(a, '#/basket'); await submit(a, 'contested_fan');
  assert.ok(a.q('form[data-form="email"]'), 'the first browser is offered the shortcut');
  const b = await shop();                                                           // a separate browser with its own cookies
  await go(b, `#/order/${w.order}`); await plus(b, w.keyring); await go(b, '#/basket'); await submit(b, 'contested_fan');
  assert.match(b.text(b.q('#follow')), /See your orders.*sign in with your email/);
  assert.equal(b.q('form[data-form="email"]'), null);
  assert.equal((await claimsOf('contested_fan')).length, 2, 'both claims were still accepted');
  a.close(); b.close();
});

test('if an order closes while it is in your basket, you are told and the basket is cleaned up', async () => {
  const p = await shop();
  await go(p, `#/order/${atOrder}`); await plus(p, w.debut); await go(p, '#/basket');
  await app.api('PATCH', `/api/admin/orders/${atOrder}`, { status: 'closed' }, admin);
  await submit(p, 'late_fan');
  assert.match(p.text(p.q('#view')), /That order has closed/);
  assert.equal(p.q('#basketPill').textContent, '', 'the closed order\'s line was removed');
  assert.equal((await claimsOf('late_fan')).length, 0);
  await app.api('PATCH', `/api/admin/orders/${atOrder}`, { status: 'open' }, admin);
  p.close();
});

test('titles with HTML are shown as text', async () => {
  const g = (await app.api('POST', '/api/admin/groups', { name: '<b>Evil</b> Crew' }, admin)).json.id;
  const o = (await app.api('POST', '/api/admin/orders', { groupId: g, title: '<img src=x onerror="window.pwned=1"> GO' }, admin)).json.id;
  await app.api('POST', `/api/admin/orders/${o}/items`, { type: 'normal', title: '<script>window.pwned=2</script>Item', price: 1 }, admin);
  const p = await shop();
  assert.equal(p.q('#view img'), null);
  assert.match(p.text(p.q('#view')), /<b>Evil<\/b> Crew.*<img src=x onerror="window\.pwned=1"> GO/);
  await go(p, `#/order/${o}`);
  assert.match(p.text(p.q('#view')), /<script>window\.pwned=2<\/script>Item/);
  await plus(p, (await app.api('GET', '/api/orders')).json.orders.find((x) => x.id === o).items[0].id);
  await go(p, '#/basket');
  assert.equal(p.q('#view script'), null);
  assert.equal(p.window.pwned, undefined);
  p.close();
});

// ───────────── My orders (sign-in + summary) ─────────────
test('My orders when signed out: a sign-in form that explains itself', async () => {
  const p = await openPage(app, '/my.html');
  assert.match(p.text(p.q('#view')), /Sign in.*No password or PIN.*one-time link/);
  p.q('#email').value = 'visitor@x.com'; await p.submit(p.q('form[data-form="signin"]'));
  assert.match(p.text(p.q('[data-msg]')), /sign-in link is on its way/);
  assert.equal(app.mailer.outbox.filter((m) => m.to === 'visitor@x.com').length, 1);
  p.q('#email').value = 'not an email'; await p.submit(p.q('form[data-form="signin"]'));
  assert.ok(p.text(p.q('[data-msg]')).length > 0 && !/on its way/.test(p.text(p.q('[data-msg]'))));
  p.close();
});

test('My orders when signed in: handle, the five "what you owe" tiles, and each claim with its status', async () => {
  const c = await joinerSession(app, 'owes@x.com', 'owes_h');
  for (const item of [w.keyring, w.album]) await app.api('POST', '/api/claims', { handle: 'owes_h', lines: [{ itemId: item }] });
  const [first] = (await claimsOf('owes_h'));
  await app.api('POST', '/api/admin/claims/secure', { claimIds: [first.id] }, admin);
  await app.api('PATCH', `/api/admin/claims/${first.id}`, { costs: { ems: { cost: 2 }, doms: { cost: 3 }, packaging: { cost: 1 } } }, admin);
  const p = await openPage(app, '/my.html', { cookies: [c] });
  const text = p.text(p.q('#view'));
  assert.match(text, /owes@x\.com/); assert.match(text, /@owes_h/);
  const tiles = Object.fromEntries(p.qa('.tile').map((t) => [p.text(t.firstElementChild), p.text(t.lastElementChild)]));
  assert.deepEqual(tiles, { Initials: '£6.00', EMS: '£2.00', Customs: '£0.00', Doms: '£3.00', Packaging: '£1.00', 'Total to pay': '£12.00' });
  await go(p, '#/ongoing');                                       // the claims list lives under "Ongoing orders"
  const ongoing = p.text(p.q('#view'));
  assert.match(ongoing, /Run It GO.*Keyring.*awaiting fulfillment.*pay by 10\/01\/2099/);
  assert.match(ongoing, /Album.*waiting for the GOM to confirm/);
  assert.deepEqual([p.errors], [[]]);
  p.close();
});

test('My orders: linking a handle — new (instant), taken (explained), already has orders (waits, nothing else held up)', async () => {
  const c = await app.login('linker@x.com');
  const p = await openPage(app, '/my.html', { cookies: [c] });
  assert.match(p.text(p.q('#handleCard')), /No handle linked yet/);
  const link = async (h) => { p.q('#handle').value = h; await p.submit(p.q('form[data-form="handle"]')); };
  await link('@Brand_New');
  assert.match(p.text(p.q('#handleCard')), /@brand_new/);
  assert.match(p.text(p.q('#view')), /No claims yet — browse group orders/);
  await link('email_fan');                                                           // owned by someone else
  assert.match(p.text(p.q('#handleCard [data-msg]')), /already linked to another account/);
  await link('skip_fan');                                                            // has orders, nobody owns it: needs the GOM
  assert.match(p.text(p.q('#handleCard')), /@skip_fan — waiting for the GOM to confirm it's you/);
  assert.match(p.text(p.q('#handleCard [data-msg]')), /nothing else is held up/);
  p.close();
});

test('My orders: sign out, and the GOM is pointed to their own page', async () => {
  const c = await joinerSession(app, 'leaver@x.com', 'leaver_h');
  const p = await openPage(app, '/my.html', { cookies: [c] });
  await p.click(p.q('[data-act="logout"]'));
  assert.match(p.text(p.q('#view')), /Sign in.*one-time link/);
  const g = await openPage(app, '/my.html', { cookies: [admin] });
  assert.match(p.text(g.q('#view')), /signed in as the GOM.*\/admin\.html/);
  p.close(); g.close();
});


// ───────────── member sets ─────────────
const sel = (itemId, member, act = 'inc') => `[data-act="${act}"][data-item="${itemId}"][data-member="${member}"]`;
const setsOf = async (itemId) => (await app.api('GET', '/api/admin/sets', undefined, admin)).json.sets.filter((x) => x.itemId === itemId);

test('set parts: + as many times as you like — 1 diary and 3 washi tapes — with a running total and where each will go', async () => {
  const p = await shop();
  await go(p, `#/order/${w.order}`);
  await plus(p, w.set, { member: 'Diary' }); await plus(p, w.set, { member: 'Washi tape', n: 3 });
  const text = p.text(p.q('#view'));
  assert.match(text, /Selected: Diary, 3 × Washi tape — £5\.00/, 'diary £2 + 3 tapes at £1');
  assert.match(text, /Where they'll go: Set 1 \(new set\): Diary, Washi tape · Set 2 \(new set\): Washi tape · Set 3 \(new set\): Washi tape/);
  assert.match(text, /this can shift if someone else claims first/);
  assert.match(p.text(p.q('#basketPill')), /Basket \(4\) · £5\.00/);
  await p.click(p.q(sel(w.set, 'Washi tape', 'dec')));
  assert.match(p.text(p.q('#view')), /Selected: Diary, 2 × Washi tape — £4\.00/);
  assert.ok(p.q('input[data-act="together"]'), 'the "keep together" option appears once 2+ parts are chosen');
  assert.match(p.text(p.q('#view')), /one of each part goes in the same set, then the next one of each in the next set/);
  p.close();
});

test('"keep together" regroups the preview round by round; the whole-set button takes one of every part in one set', async () => {
  const p = await shop();
  await go(p, `#/order/${w.order}`);
  await plus(p, w.set, { member: 'Han', n: 2 }); await plus(p, w.set, { member: 'Diary' });
  assert.match(p.text(p.q('#view')), /Set 1 \(new set\): Han, Diary · Set 2 \(new set\): Han/, 'by default each part takes the first set it fits in');
  await p.click(p.q('input[data-act="together"]'));
  assert.match(p.text(p.q('#view')), /Set 1 \(new set\): Han, Diary · Set 2 \(new set\): Han/);
  assert.equal(p.window.sessionStorage.getItem('sos_together'), `{"${w.set}":true}`);
  await p.click(p.q(sel(w.set, 'Han', 'dec'))); await p.click(p.q(sel(w.set, 'Han', 'dec'))); await p.click(p.q(sel(w.set, 'Diary', 'dec')));
  assert.equal(p.q('#basketPill').textContent, '', 'removing everything empties the basket');
  assert.equal(p.window.sessionStorage.getItem('sos_together'), '{}', 'and forgets the together flag');
  await p.click(p.q(`[data-act="whole"][data-item="${w.set}"]`));
  const text = p.text(p.q('#view'));
  assert.match(text, /Selected: Bang Chan, Han, Diary, Washi tape — £9\.00/);
  assert.match(text, /Where they'll go: Set 1 \(new set\): Bang Chan, Han, Diary, Washi tape/);
  assert.equal(p.q('input[data-act="together"]').checked, true);
  p.close();
});

test('submitting set parts: each lands where the server placed it, and the confirmation says where', async () => {
  const p = await shop();
  await go(p, `#/order/${w.order}`);
  await plus(p, w.set, { member: 'Diary' }); await plus(p, w.set, { member: 'Washi tape', n: 3 });
  await go(p, '#/basket');
  assert.match(p.text(p.q('#view')), /Seasons Greetings — where they'll go: Set 1 \(new set\): Diary, Washi tape · Set 2 \(new set\): Washi tape · Set 3 \(new set\): Washi tape/);
  assert.match(p.text(p.q('#view')), /Seasons Greetings — Washi tape.*£1\.00 each.*£3\.00/);
  await submit(p, '@Set_Fan');
  const text = p.text(p.q('#view'));
  assert.match(text, /Claims submitted.*@set_fan/);
  assert.match(text, /Where your set parts went: Diary — Set 1 · Washi tape — Set 1 · Washi tape — Set 2 · Washi tape — Set 3/);
  assert.match(text, /Total £5\.00/);
  const rows = (await claimsOf('set_fan')).map((c) => [c.label, c.status, c.costs.initials.cost]).sort();
  assert.deepEqual(rows, [['Seasons Greetings — Diary (Set 1)', 'requested', 2], ['Seasons Greetings — Washi tape (Set 1)', 'requested', 1], ['Seasons Greetings — Washi tape (Set 2)', 'requested', 1], ['Seasons Greetings — Washi tape (Set 3)', 'requested', 1]]);
  assert.equal(p.window.sessionStorage.getItem('sos_basket'), '[]');
  p.close();
});

test('the preview and the part counts follow what others have already claimed', async () => {
  const p = await shop();
  await go(p, `#/order/${w.order}`);
  assert.match(p.text(p.q('#view')), /Washi tape £1\.00 · 3 claimed/);
  assert.match(p.text(p.q('#view')), /Diary £2\.00 · 1 claimed/);
  await plus(p, w.set, { member: 'Diary' });                           // Set 1 already has a Diary; Set 2 doesn't
  assert.match(p.text(p.q('#view')), /Where they'll go: Set 2: Diary/, 'an existing set with room, not a new one');
  await plus(p, w.set, { member: 'Washi tape', n: 2 });                // Sets 1-3 already have tapes -> a new Set 4 and Set 5
  assert.match(p.text(p.q('#view')), /Set 4 \(new set\): Washi tape · Set 5 \(new set\): Washi tape/);
  p.close();
});

test('securing a set takes it out of the preview: the next claim goes to the next set', async () => {
  const [s1] = await setsOf(w.set);
  await app.api('POST', `/api/admin/sets/${s1.id}/cancel`, {}, admin);
  const p = await shop();
  await go(p, `#/order/${w.order}`); await plus(p, w.set, { member: 'Diary' });
  assert.match(p.text(p.q('#view')), /Where they'll go: Set 2: Diary/, 'Set 1 is cancelled, so it is skipped (Set 2 has room for a diary)');
  p.close();
});

// ───────────── product descriptions ─────────────
test('descriptions show on every kind of item in the shop, keep their line breaks, and items without one show nothing extra', async () => {
  const o = (await app.api('POST', '/api/admin/orders', { groupId: w.group, title: 'Described GO' }, admin)).json.id;
  const add = (body) => app.api('POST', `/api/admin/orders/${o}/items`, { price: 5, ...body }, admin);
  await add({ type: 'normal', title: 'Plain item', description: 'Line one\nLine two' });
  await add({ type: 'independent', title: 'Ind item', members: ['A'], description: 'Pick your bias' });
  await add({ type: 'size', title: 'Sized item', variants: ['M'], description: 'Runs small' });
  await add({ type: 'set', title: 'Set item', members: ['A', 'B'], description: 'Full set contents' });
  await add({ type: 'random', title: 'Random item', description: 'Surprise!' });
  await add({ type: 'normal', title: 'Bare item' });
  const p = await shop();
  await go(p, `#/order/${o}`);
  const descs = p.qa('.itemdesc').map((e) => e.textContent);
  assert.deepEqual(descs.sort(), ['Full set contents', 'Line one\nLine two', 'Pick your bias', 'Runs small', 'Surprise!'].sort(), 'one per described item, none for the bare one');
  const plain = p.byText('#view .card', 'Plain item');
  assert.equal(p.q('.itemdesc', plain).textContent, 'Line one\nLine two', 'the break is kept in the text (shown as two lines)');
  assert.equal(p.q('.itemdesc', p.byText('#view .card', 'Bare item')), null);
  assert.match(p.text(p.byText('#view .card', 'Plain item')), /Plain item.*£5\.00 each.*Line one Line two/s, 'the description sits with its item');
  p.close();
});

test('descriptions with HTML are shown as text, never run', async () => {
  const o = (await app.api('POST', '/api/admin/orders', { groupId: w.group, title: 'Markup GO' }, admin)).json.id;
  await app.api('POST', `/api/admin/orders/${o}/items`, { type: 'normal', title: 'Tricky', price: 1, description: '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>' }, admin);
  const p = await shop();
  await go(p, `#/order/${o}`);
  assert.equal(p.q('#view img'), null); assert.equal(p.q('#view script'), null);
  assert.match(p.text(p.q('.itemdesc')), /<img src=x onerror="window\.pwned=1"><script>window\.pwned=2<\/script>/);
  assert.equal(p.window.pwned, undefined);
  p.close();
});

// ───────────── the Shop (stock already on hand) ─────────────
const addStock = async (o = {}) => (await app.api('POST', '/api/admin/shop', { title: 'Extra Photobook', price: 20, qty: 3, notes: 'Minor corner ding, otherwise mint', ...o }, admin)).json.id;
const shopPlus = (p, id) => p.click(p.q(`[data-act="shopinc"][data-shop="${id}"]`));
const shopMinus = (p, id) => p.click(p.q(`[data-act="shopdec"][data-shop="${id}"]`));

test('shop: with no stock there is no Shop card or page content; with stock, the home page links to it and says how many items are available', async () => {
  let p = await shop();
  assert.doesNotMatch(p.text(p.q('#view')), /Shop — on hand now/);
  await go(p, '#/shop');
  assert.match(p.text(p.q('#view')), /Nothing in the shop right now/);
  p.close();
  const id = await addStock({ title: 'Home card item' });
  await addStock({ title: 'Sold out item', qty: 1 }).then((x) => app.api('POST', '/api/claims', { handle: 'shop_buyer0', lines: [{ leftoverId: x, qty: 1 }] }));
  p = await shop();
  assert.match(p.text(p.q('#view')), /Shop — on hand now.*1 item available.*held for you as soon as you claim/s, 'the sold-out one is not counted');
  assert.ok(p.q('a.gocard[href="#/shop"]'));
  assert.ok(id);
  p.close();
});

test('shop page: each item with price, how many are left, how long to pay, and its notes; sold-out ones are marked and have no stepper', async () => {
  const id = await addStock({ title: 'Page item', price: 12.5, qty: 2, payDays: 3, notes: 'Includes a poster' });
  const gone = await addStock({ title: 'Gone item', qty: 1 }); await app.api('POST', '/api/claims', { handle: 'shop_buyer1', lines: [{ leftoverId: gone }] });
  const p = await shop(); await go(p, '#/shop');
  const card = p.q(`[data-shop-item="${id}"]`);
  assert.match(p.text(card), /Page item.*£12\.50 · 2 left · pay within 3 days of claiming.*Includes a poster/s);
  assert.ok(p.q('[data-act="shopinc"]', card));
  const out = p.q(`[data-shop-item="${gone}"]`);
  assert.match(p.text(out), /Gone item.*Sold out/s); assert.equal(p.q('[data-act="shopinc"]', out), null);
  assert.deepEqual(p.errors, []);
  p.close();
});

test('shop: + stops at what is left; the basket shows the shop line with its own wording; the header total follows', async () => {
  const id = await addStock({ title: 'Limited thing', price: 8, qty: 2, payDays: 4 });
  const p = await shop(); await go(p, '#/shop');
  await shopPlus(p, id); await shopPlus(p, id);
  assert.equal(p.q(`[data-act="shopinc"][data-shop="${id}"]`).disabled, true, 'both units chosen: no more');
  assert.match(p.text(p.q('#basketPill')), /Basket \(2\) · £16\.00/);
  await go(p, '#/basket');
  const t = p.text(p.q('#view'));
  assert.match(t, /Limited thing.*Shop \(on hand\) · £8\.00 each.*£16\.00/s);
  assert.match(t, /Shop items are held for you straight away and you'll owe for them right away \(you have 4 days to pay\)\./);
  assert.doesNotMatch(t, /nothing is owed until the GOM confirms/);
  await shopMinus(p, id);
  assert.match(p.text(p.q('#basketPill')), /Basket \(1\) · £8\.00/);
  await shopMinus(p, id);
  assert.equal(p.q('#basketPill').textContent, '');
  p.close();
});

test('claiming shop items: held and confirmed at once, the confirmation says how long to pay, and the stock goes down', async () => {
  const id = await addStock({ title: 'Claim me', price: 6, qty: 3, payDays: 2 });
  const p = await shop(); await go(p, '#/shop');
  await shopPlus(p, id); await shopPlus(p, id);
  await go(p, '#/basket'); await submit(p, '@Shop_Fan');
  const t = p.text(p.q('#view'));
  assert.match(t, /Claims submitted.*@shop_fan.*2 × Claim me.*£12\.00/s);
  assert.match(t, /Your shop items are held for you — pay within 2 days \(you'll find how in My orders\)\./);
  assert.doesNotMatch(t, /They're requests for now/);
  const rows = await claimsOf('shop_fan');
  assert.deepEqual(rows.map((c) => [c.label, c.status, c.costs.initials.cost]), [['Claim me', 'confirmed', 6], ['Claim me', 'confirmed', 6]]);
  const q = await shop(); await go(q, '#/shop');
  assert.match(q.text(q.q(`[data-shop-item="${id}"]`)), /1 left/);
  p.close(); q.close();
});

test('a mixed basket (shop + group order) explains both: shop items are owed now, group-order items are requests', async () => {
  const id = await addStock({ title: 'Mixed shop item', price: 5, payDays: 5 });
  const p = await shop(); await go(p, '#/shop'); await shopPlus(p, id);
  await go(p, `#/order/${w.order}`); await plus(p, w.keyring);
  await go(p, '#/basket');
  assert.match(p.text(p.q('#view')), /Shop items are held for you straight away.*Group-order items are requests: nothing is owed for those until the GOM confirms them, and their price is final once they do\./s);
  await submit(p, 'mixed_shopper');
  assert.match(p.text(p.q('#view')), /Your shop items are held for you.*The rest are requests for now — the GOM will confirm them/s);
  assert.deepEqual((await claimsOf('mixed_shopper')).map((c) => c.status).sort(), ['confirmed', 'requested']);
  p.close();
});

test('if the last unit goes while you are choosing, you are told, your selection is trimmed to what is left, and nothing half-submits', async () => {
  const id = await addStock({ title: 'Race item', price: 4, qty: 2 });
  const p = await shop(); await go(p, '#/shop');
  await shopPlus(p, id); await shopPlus(p, id);
  await app.api('POST', '/api/claims', { handle: 'shop_snipe', lines: [{ leftoverId: id, qty: 1 }] });          // someone else buys one meanwhile
  await go(p, '#/basket'); await submit(p, 'slow_buyer');
  assert.match(p.text(p.q('[data-msg]')), /Only 1 of "Race item" left\./);
  assert.equal((await claimsOf('slow_buyer')).length, 0, 'nothing was claimed');
  assert.match(p.text(p.q('#basketPill')), /Basket \(1\) · £4\.00/, 'the basket was trimmed to the 1 that is left');
  await submit(p, 'slow_buyer');
  assert.match(p.text(p.q('#view')), /Claims submitted.*1 × Race item/s);
  p.close();
});

test('a shop item that sells out disappears from an old basket instead of failing later', async () => {
  const id = await addStock({ title: 'Vanishing item', qty: 1 });
  const p = await shop(); await go(p, '#/shop'); await shopPlus(p, id);
  const saved = p.window.sessionStorage.getItem('sos_basket');
  p.close();
  assert.match(saved, /"shopId"/, 'the basket really holds the shop line');
  const control = await shop({ init: (win) => win.sessionStorage.setItem('sos_basket', saved) });
  await new Promise((r) => setTimeout(r, 60)); await control.settle();
  assert.match(control.text(control.q('#basketPill')), /Basket \(1\)/, 'while it is in stock, the saved basket is restored');
  control.close();
  await app.api('POST', '/api/claims', { handle: 'shop_snipe2', lines: [{ leftoverId: id }] });
  const q = await shop({ init: (win) => win.sessionStorage.setItem('sos_basket', saved) });
  await new Promise((r) => setTimeout(r, 60)); await q.settle();
  assert.equal(q.q('#basketPill').textContent, '', 'the sold-out line was dropped when the page loaded');
  q.close();
});

test('shop names and notes with HTML are shown as text', async () => {
  await addStock({ title: '<img src=x onerror="window.pwned=1"> thing', notes: '<script>window.pwned=2</script>' });
  const p = await shop(); await go(p, '#/shop');
  assert.equal(p.q('#view img'), null); assert.equal(p.q('#view script'), null);
  assert.match(p.text(p.q('#view')), /<img src=x onerror="window\.pwned=1"> thing/);
  assert.equal(p.window.pwned, undefined);
  p.close();
});
