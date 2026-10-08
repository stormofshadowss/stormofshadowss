import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN } from './helpers.js';
import { openPage } from './ui.helpers.js';

let app, adminCookie;
before(async () => { app = await startApp(); adminCookie = await app.adminLogin(); });
after(async () => { await app.stop(); });

const api = (m, p, b) => app.api(m, p, b, adminCookie);
const adminOrders = async () => (await api('GET', '/api/admin/orders')).json.orders;
const orderNamed = async (t) => (await adminOrders()).find((o) => o.title === t);
// a signed-in GOM page that counts any use of the browser's own pop-ups (there must be none)
async function gom() {
  const p = await openPage(app, '/admin.html', { cookies: [adminCookie] });
  p.native = 0;
  for (const k of ['alert', 'confirm', 'prompt']) p.window[k] = () => { p.native++; return true; };
  return p;
}
const modal = (p) => p.q('.ui-modal');
const press = (p, label) => p.click(p.byText('.ui-modal button', label));
const toast = (p) => (p.q('#toast').hidden ? '' : p.q('#toast').textContent);

async function createOrder(p, values) {
  await p.click(p.byText('button', '＋ New group order'));
  const f = p.q('form[data-form="new-order"]');
  p.fill(f, values);
  await p.submit(f);
}

test('signing in: a first visit shows the login (no "session ended" scare), a wrong password is explained, the right one opens the app', async () => {
  const p = await openPage(app, '/admin.html');
  assert.equal(p.q('#loginView').hidden, false);
  assert.equal(p.q('#appView').hidden, true);
  assert.equal(p.q('#loginMsg').hidden, true, 'no message on a first visit');
  p.q('#username').value = ADMIN.username; p.q('#password').value = 'definitely wrong';
  await p.submit(p.q('#loginForm'));
  assert.match(p.text(p.q('#loginMsg')), /Wrong username or password/);
  assert.equal(p.q('#password').value, '', 'the password box is cleared');
  p.q('#username').value = ADMIN.username; p.q('#password').value = ADMIN.password;
  await p.submit(p.q('#loginForm'));
  assert.equal(p.q('#appView').hidden, false);
  assert.deepEqual(p.qa('#tabs button').map((b) => b.dataset.tab), ['orders', 'claims', 'sets', 'payments', 'proxy', 'warehouse', 'shop', 'packing', 'overdue', 'people', 'import']);
  assert.match(p.text(p.q('#whoami')), /Signed in as boss/);
  assert.deepEqual(p.errors, []);
  p.close();
});

test('a stranger or a joiner cannot see the GOM screens', async () => {
  const joiner = await app.login('just.a.joiner@x.com');
  const p = await openPage(app, '/admin.html', { cookies: [joiner] });
  assert.equal(p.q('#appView').hidden, true, 'a joiner session is not an admin session');
  assert.equal(p.q('#loginView').hidden, false);
  p.close();
});

test('create a group order with a brand-new group, and it appears publicly', async () => {
  const p = await gom();
  assert.match(p.text(p.q('#tabBody')), /No group orders yet/);
  await createOrder(p, { newGroup: 'Stray Kids', newGroupMembers: 'Bang Chan, Han, Felix', title: 'Run It GO', paymentDeadline: '2099-01-10', proxy: 'Sam' });
  assert.match(toast(p), /Group order created/);
  assert.match(p.text(p.q('#tabBody tbody')), /Run It GO.*Stray Kids.*Open.*Public.*10\/01\/2099.*Sam/, 'UK date format in the table');
  assert.match(p.text(p.q('#itemsPanel')), /Items — Run It GO/, 'the items panel opens ready to add the first item');
  const pub = (await app.api('GET', '/api/orders')).json.orders.find((o) => o.title === 'Run It GO');
  assert.equal(pub.group, 'Stray Kids');
  assert.equal(pub.paymentDeadline, '2099-01-10', 'stored as ISO');
  assert.deepEqual((await api('GET', '/api/admin/groups')).json.groups[0].members, ['Bang Chan', 'Han', 'Felix']);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('mistakes are explained next to the form and nothing is created', async () => {
  const p = await gom();
  await p.click(p.byText('button', '＋ New group order'));
  let f = p.q('form[data-form="new-order"]'); p.fill(f, { title: 'No group' }); await p.submit(f);
  assert.match(p.text(p.q('[data-msg]')), /Choose a group, or type a new group name/);
  f = p.q('form[data-form="new-order"]'); p.fill(f, { newGroup: 'Some Group', title: '' }); await p.submit(f);
  assert.match(p.text(p.q('[data-msg]')), /title/i, 'the server\'s complaint about the title is shown');
  f = p.q('form[data-form="new-order"]'); p.fill(f, { newGroup: 'Some Group', title: 'Bad date', paymentDeadline: '2099-02-30' });
  assert.equal((await orderNamed('Bad date')), undefined);
  p.close();
});

test('a private GO is hidden from the public; closing an order stops new claims; reopening allows them', async () => {
  const p = await gom();
  await createOrder(p, { group: String((await api('GET', '/api/admin/groups')).json.groups[0].id), title: 'Off-site Weverse', isPrivate: true });
  assert.match(p.text(p.q('tbody')), /Off-site Weverse.*Private/);
  assert.ok(!(await app.api('GET', '/api/orders')).json.orders.some((o) => o.title === 'Off-site Weverse'));

  const o = await orderNamed('Run It GO');
  const item = (await api('POST', `/api/admin/orders/${o.id}/items`, { type: 'normal', title: 'Keyring', price: 6 })).json.id;
  const edit = async (status) => {
    await p.click(p.q(`tr[data-order="${o.id}"] [data-act="edit-order"]`));
    const f = p.q('form[data-form="edit-order"]'); p.fill(f, { status }); await p.submit(f);
  };
  await edit('closed');
  assert.match(p.text(p.q(`tr[data-order="${o.id}"]`)), /Closed/);
  const refused = await app.api('POST', '/api/claims', { handle: 'late_one', lines: [{ itemId: item }] });
  assert.equal(refused.json.code, 'order_closed');
  await edit('open');
  assert.equal((await app.api('POST', '/api/claims', { handle: 'late_one', lines: [{ itemId: item }] })).status, 201);
  p.close();
});

test('adding items: the form adapts to the type, and every kind lands correctly', async () => {
  const p = await gom();
  const o = await orderNamed('Run It GO');
  await p.click(p.q(`[data-act="open-items"][data-id="${o.id}"]`));
  const form = () => p.q('form[data-form="new-item"]');

  assert.equal(p.q('[data-extra]', form()).hidden, true, 'a normal item needs no member list');
  await p.choose(form().elements.type, 'set');
  assert.equal(p.q('[data-extra]', form()).hidden, false);
  assert.equal(p.q('[data-setonly]', form()).hidden, false, 'the every-part tick box appears for sets only');
  assert.match(p.text(p.q('[data-extra-label]', form())), /own price like Diary=2/);
  await p.choose(form().elements.type, 'size');
  assert.equal(p.q('[data-setonly]', form()).hidden, true);
  assert.match(p.text(p.q('[data-extra-label]', form())), /Sizes/);

  const add = async (type, values) => { await p.choose(form().elements.type, type); p.fill(form(), values); await p.submit(form()); };
  await add('normal', { title: 'Keyring 2', price: '6.5', paymentDeadline: '2099-02-02', proxy: 'Lulu' });
  await add('independent', { title: 'Solo Photocards', price: '8', extra: 'Bang Chan, Han' });
  await add('size', { title: 'Hoodie', price: '50', extra: 'M, L', sizeBucket: 'L' });
  await add('set', { title: 'Seasons Greetings', price: '3', extra: 'Bang Chan, Han, Diary=2, Washi tape=1', requiresFullSet: true });
  await add('random', { title: 'Random card', price: '2' });
  assert.match(toast(p), /Item added/);

  const items = Object.fromEntries((await orderNamed('Run It GO')).items.map((i) => [i.title, i]));
  assert.equal(items['Keyring 2'].price, 6.5);
  assert.deepEqual([items['Keyring 2'].ownPaymentDeadline, items['Keyring 2'].proxy], ['2099-02-02', 'Lulu']);
  assert.deepEqual(items['Solo Photocards'].members.map((m) => m.name), ['Bang Chan', 'Han']);
  assert.deepEqual(items.Hoodie.variants, ['M', 'L']);
  const set = items['Seasons Greetings'];
  assert.deepEqual(set.members, [{ name: 'Bang Chan', price: 3 }, { name: 'Han', price: 3 }, { name: 'Diary', price: 2 }, { name: 'Washi tape', price: 1 }]);
  assert.deepEqual([set.requiresFullSet, set.wholeSetPrice], [true, 9]);
  const row = p.text(p.byText('#itemsPanel tbody tr', 'Seasons Greetings'));
  assert.match(row, /4 parts · £9\.00 whole set/);
  assert.match(row, /every part required/);
  assert.match(row, /Diary £2\.00/);
  assert.match(p.text(p.byText('#itemsPanel tbody tr', 'Keyring 2')), /£6\.50.*02\/02\/2099 \(own\).*Lulu/);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('item mistakes: a non-numeric part price is explained and nothing is added; bad prices are refused', async () => {
  const p = await gom();
  const o = await orderNamed('Run It GO'); const before = o.items.length;
  await p.click(p.q(`[data-act="open-items"][data-id="${o.id}"]`));
  const form = () => p.q('form[data-form="new-item"]');
  await p.choose(form().elements.type, 'set'); p.fill(form(), { title: 'Bad parts', price: '3', extra: 'A, B, Diary=abc' }); await p.submit(form());
  assert.match(p.text(p.q('[data-msg]', form())), /"Diary" has a price that isn't a number/);
  p.fill(form(), { title: 'Bad parts', price: '3', extra: 'A, B, Diary=' }); await p.submit(form());
  assert.match(p.text(p.q('[data-msg]', form())), /isn't a number/);
  await p.choose(form().elements.type, 'normal'); p.fill(form(), { title: 'Negative', price: '-4' }); await p.submit(form());
  assert.ok(p.text(p.q('[data-msg]', form())).length > 0, 'a negative price is refused with a message');
  await p.choose(form().elements.type, 'independent'); p.fill(form(), { title: 'No members', price: '3', extra: '' }); await p.submit(form());
  assert.match(p.text(p.q('[data-msg]', form())), /member list/i);
  assert.equal((await orderNamed('Run It GO')).items.length, before);
  p.close();
});

test('"Use the group\'s members" fills the box; with no saved members it says so in a dialog', async () => {
  const p = await gom();
  const o = await orderNamed('Run It GO');
  await p.click(p.q(`[data-act="open-items"][data-id="${o.id}"]`));
  const form = () => p.q('form[data-form="new-item"]');
  await p.choose(form().elements.type, 'independent');
  await p.click(p.byText('[data-act="fill-members"]', "Use the group's members"));
  assert.equal(form().elements.extra.value, 'Bang Chan, Han, Felix');

  const g = (await api('POST', '/api/admin/groups', { name: 'Memberless' })).json.id;
  await api('POST', '/api/admin/orders', { groupId: g, title: 'Memberless GO' });
  await p.click(p.byText('#tabs button', 'Group Orders'));   // reload the page's data, as a person would
  await p.click(p.q(`[data-act="open-items"][data-id="${(await orderNamed('Memberless GO')).id}"]`));
  await p.choose(form().elements.type, 'set');
  await p.click(p.byText('[data-act="fill-members"]', "Use the group's members"));
  assert.match(p.text(modal(p)), /no member list saved for Memberless/);
  await press(p, 'OK');
  assert.equal(modal(p), null);
  assert.equal(p.native, 0);
  p.close();
});

test('editing an item: pay-by and proxy overrides apply, and clearing them returns to the GO\'s', async () => {
  const p = await gom();
  const o = await orderNamed('Run It GO');
  const keyring = o.items.find((i) => i.title === 'Keyring');
  await p.click(p.q(`[data-act="open-items"][data-id="${o.id}"]`));
  await p.click(p.q(`[data-act="edit-item"][data-id="${keyring.id}"]`));
  assert.match(p.text(p.q('form[data-form="edit-item"]')), /only affects future claims/);
  let f = p.q('form[data-form="edit-item"]'); p.fill(f, { price: '7', paymentDeadline: '2099-03-03', proxy: 'Yuki' }); await p.submit(f);
  let it = (await orderNamed('Run It GO')).items.find((i) => i.id === keyring.id);
  assert.deepEqual([it.price, it.payBy, it.proxy], [7, '2099-03-03', 'Yuki']);
  await p.click(p.q(`[data-act="edit-item"][data-id="${keyring.id}"]`));
  f = p.q('form[data-form="edit-item"]'); p.fill(f, { paymentDeadline: '', proxy: '' }); await p.submit(f);
  it = (await orderNamed('Run It GO')).items.find((i) => i.id === keyring.id);
  assert.deepEqual([it.payBy, it.proxy], ['2099-01-10', 'Sam'], 'back to the GO\'s date and proxy');
  p.close();
});

test('names with HTML in them are shown as text, never run', async () => {
  const p = await gom();
  await createOrder(p, { newGroup: '<b>Bold</b> Boys', title: '<img src=x onerror="window.pwned=1"> GO' });
  assert.equal(p.q('#tabBody img[src="x"]'), null, 'no image element was created');
  assert.match(p.text(p.q('tbody')), /<img src=x onerror="window\.pwned=1"> GO/);
  assert.match(p.text(p.q('tbody')), /<b>Bold<\/b> Boys/);
  assert.equal(p.window.pwned, undefined);
  p.close();
});

// ───────────── claims ─────────────
async function seedClaims() {
  const o = await orderNamed('Run It GO');
  const keyring = o.items.find((i) => i.title === 'Keyring').id;
  const album = (await api('POST', `/api/admin/orders/${o.id}/items`, { type: 'normal', title: 'Album', price: 26 })).json.id;
  for (const [handle, lines] of [['amy_1', [{ itemId: keyring, qty: 2 }, { itemId: album }]], ['bob_2', [{ itemId: keyring }]]]) {
    assert.equal((await app.api('POST', '/api/claims', { handle, lines })).status, 201);
  }
  return { o, keyring, album };
}
const claimsOf = async (handle) => (await api('GET', `/api/admin/claims?handle=${handle}`)).json.claims;

test('Claims tab: grouped by order and person, with what is waiting to be secured', async () => {
  await seedClaims();
  const p = await gom();
  await p.click(p.byText('#tabs button', 'Claims'));
  const waiting = (await api('GET', '/api/admin/claims?status=requested')).json.claims.length;
  assert.ok(waiting >= 4, 'amy has 3, bob has 1, plus one from an earlier test');
  const card = p.text(p.byText('#tabBody .card', 'Run It GO'));
  assert.match(card, new RegExp(`${waiting} claims · ${waiting} waiting to be secured`));
  assert.match(card, new RegExp(`Secure all requested \\(${waiting}\\)`));
  await p.click(p.q('[data-buyer="amy_1"] [data-act="toggle"]'));
  const rows = p.text(p.q('[data-buyer="amy_1"] table'));
  assert.match(rows, /Keyring.*requested/); assert.match(rows, /Album.*requested/);
  assert.match(p.text(p.q('[data-buyer="amy_1"]')), /3 claims.*3 requested/);
  p.close();
});

test('securing: a confirmation first; keeping it changes nothing; confirming makes the claims count', async () => {
  const p = await gom();
  await p.click(p.byText('#tabs button', 'Claims'));
  await p.click(p.q('[data-act="secure"]'));
  const waiting = (await api('GET', '/api/admin/claims?status=requested')).json.claims.length;
  assert.match(p.text(modal(p)), new RegExp(`Secure ${waiting} requested claims in "Run It GO"\\?`));
  await press(p, 'Cancel');
  assert.equal((await claimsOf('amy_1')).filter((c) => c.status === 'confirmed').length, 0, 'cancelling the dialog did nothing');
  await p.click(p.q('[data-act="secure"]'));
  await press(p, 'Secure them');
  assert.match(toast(p), new RegExp(`Secured ${waiting} claims`));
  assert.equal((await claimsOf('amy_1')).filter((c) => c.status === 'confirmed').length, 3);
  assert.equal(p.q('[data-act="secure"]'), null, 'nothing left to secure, so the button is gone');
  assert.match(p.text(p.q('[data-buyer="amy_1"]')), /owes £40\.00/, '2 keyrings at £7 (the price was raised in an earlier test) + album £26');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('editing costs: add postage, record a payment; the owed figure follows', async () => {
  const p = await gom();
  await p.click(p.byText('#tabs button', 'Claims'));
  await p.click(p.q('[data-buyer="bob_2"] [data-act="toggle"]'));
  const claim = (await claimsOf('bob_2'))[0];
  await p.click(p.q(`[data-act="edit"][data-id="${claim.id}"]`));
  let f = p.q('form[data-form="edit-costs"]');
  p.fill(f, { ems_cost: '3.5', initials_paid: '6' }); await p.submit(f);
  const after = (await claimsOf('bob_2'))[0];
  assert.deepEqual([after.costs.ems.cost, after.costs.initials.paid], [3.5, 6]);
  assert.match(p.text(p.q('[data-buyer="bob_2"]')), /owes £4\.50/, 'keyring £7 − £6 paid = £1, plus £3.50 postage');
  assert.match(toast(p), /Saved/);
  await p.click(p.q(`[data-act="edit"][data-id="${claim.id}"]`));
  await p.click(p.byText('[data-act="cancel-edit"]', 'Cancel'));
  assert.equal(p.q('form[data-form="edit-costs"]'), null, 'cancelling the edit closes it');
  p.close();
});

test('a paid amount above the cost is capped and the extra becomes credit (shown by the server, not the screen)', async () => {
  const p = await gom();
  await p.click(p.byText('#tabs button', 'Claims'));
  await p.click(p.q('[data-buyer="bob_2"] [data-act="toggle"]'));
  const claim = (await claimsOf('bob_2'))[0];
  await p.click(p.q(`[data-act="edit"][data-id="${claim.id}"]`));
  const f = p.q('form[data-form="edit-costs"]'); p.fill(f, { ems_paid: '10' }); await p.submit(f);   // EMS cost is 3.50
  assert.equal((await claimsOf('bob_2'))[0].costs.ems.paid, 3.5);
  const credit = (await api('GET', '/api/admin/ledger?handle=bob_2')).json.entries.find((e) => e.kind === 'credit');
  assert.equal(credit.amount, 6.5);
  p.close();
});

test('moving a claim along the pipeline updates it, and starts the storage clock when ready to pack', async () => {
  const p = await gom();
  await p.click(p.byText('#tabs button', 'Claims'));
  await p.click(p.q('[data-buyer="amy_1"] [data-act="toggle"]'));
  const claim = (await claimsOf('amy_1')).find((c) => c.label === 'Album');
  await p.choose(p.q(`select[data-id="${claim.id}"]`), 'ready to pack / on hand');
  const after = (await claimsOf('amy_1')).find((c) => c.id === claim.id);
  assert.equal(after.pipeline, 'ready to pack / on hand');
  assert.match(after.ready_to_pack_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(p.q(`select[data-id="${claim.id}"]`).value, 'ready to pack / on hand');
  p.close();
});

test('cancelling: the dialog says exactly what happens to money; keeping it does nothing; confirming returns paid money as credit', async () => {
  const p = await gom();
  await p.click(p.byText('#tabs button', 'Claims'));
  await p.click(p.q('[data-buyer="amy_1"] [data-act="toggle"]'));
  const album = (await claimsOf('amy_1')).find((c) => c.label === 'Album');
  await api('PATCH', `/api/admin/claims/${album.id}`, { costs: { initials: { paid: 26 } } });
  await p.click(p.byText('#tabs button', 'Claims'));          // the screen remembers amy is open, so no second toggle
  assert.ok(p.q(`[data-claim="${album.id}"]`), 'amy\'s list stayed open across the refresh');
  await p.click(p.q(`[data-act="cancel"][data-id="${album.id}"]`));
  assert.match(p.text(modal(p)), /£26\.00 has already been paid on it, so it goes back to them as credit/);
  await press(p, 'Keep it');
  assert.equal((await claimsOf('amy_1')).find((c) => c.id === album.id).status, 'confirmed');
  await p.click(p.q(`[data-act="cancel"][data-id="${album.id}"]`));
  await press(p, 'Yes, cancel it');
  assert.match(toast(p), /£26\.00 returned as credit/);
  assert.equal((await claimsOf('amy_1')).find((c) => c.id === album.id).status, 'cancelled');
  assert.equal((await api('GET', '/api/admin/ledger?handle=amy_1')).json.entries.find((e) => e.kind === 'credit').amount, 26);
  assert.equal(p.q(`[data-claim="${album.id}"]`), null, 'cancelled claims are hidden by default');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('filters: show cancelled, narrow to one person, pick one group order', async () => {
  const p = await gom();
  await p.click(p.byText('#tabs button', 'Claims'));
  await p.choose(p.q('[data-filter="status"]'), 'cancelled');
  assert.match(p.text(p.q('#tabBody')), /@amy_1/);
  assert.doesNotMatch(p.text(p.q('#tabBody')), /@bob_2/);
  await p.choose(p.q('[data-filter="status"]'), 'all');
  await p.type(p.q('[data-filter="q"]'), '@BOB');
  assert.match(p.text(p.q('#tabBody')), /@bob_2/);
  assert.doesNotMatch(p.text(p.q('#tabBody')), /@amy_1/);
  assert.equal(p.document.activeElement, p.q('[data-filter="q"]'), 'typing keeps the cursor in the search box');
  await p.type(p.q('[data-filter="q"]'), 'zzzz');
  assert.match(p.text(p.q('#tabBody')), /No claims match/);
  await p.type(p.q('[data-filter="q"]'), '');
  const o = await orderNamed('Run It GO');
  await p.choose(p.q('[data-filter="order"]'), String(o.id));
  assert.match(p.text(p.q('#tabBody')), /Run It GO/);
  p.close();
});

// ───────────── people + session ─────────────
test('People: a handle request shows a badge, can be approved, and the badge clears', async () => {
  await app.api('POST', '/api/claims', { handle: 'needs_ok', lines: [{ itemId: (await orderNamed('Run It GO')).items.find((i) => i.title === 'Keyring').id }] });
  const joiner = await app.login('needs.ok@x.com');
  assert.equal((await app.api('POST', '/api/me/handles', { handle: 'needs_ok' }, joiner)).status, 202);
  const p = await gom();
  assert.equal(p.q('#tabs [data-tab="people"] .badge').textContent, '1');
  await p.click(p.byText('#tabs button', 'People'));
  assert.match(p.text(p.q('[data-req]')), /@needs_ok ← needs\.ok@x\.com.*1 claim/);
  await p.click(p.byText('[data-act="approve"]', 'Approve'));
  assert.match(toast(p), /Approved/);
  assert.match(p.text(p.q('#tabBody')), /Nothing waiting/);
  assert.equal(p.q('#tabs [data-tab="people"] .badge').hidden, true);
  assert.equal((await app.api('GET', '/api/my/summary', undefined, joiner)).status, 200, 'and the person can now see their orders');
  p.close();
});

// ───────────── product descriptions ─────────────
test('descriptions: add one when creating an item, see a preview in the list, edit it, and clear it', async () => {
  const p = await gom();
  const o = await orderNamed('Run It GO');
  await p.click(p.q(`[data-act="open-items"][data-id="${o.id}"]`));
  const form = () => p.q('form[data-form="new-item"]');
  assert.match(p.text(form()), /Description \(optional — shown to joiners on the item\)/);
  p.fill(form(), { title: 'Described album', price: '20', description: 'Includes a poster.\nShips next month.' }); await p.submit(form());
  const item = () => p.byText('#itemsPanel tbody tr', 'Described album');
  assert.match(p.text(item()), /Described album.*Includes a poster\. Ships next month\./);
  assert.equal((await orderNamed('Run It GO')).items.find((i) => i.title === 'Described album').description, 'Includes a poster.\nShips next month.');

  const long = 'Long text. '.repeat(30);
  await p.click(p.q(`[data-act="edit-item"][data-id="${(await orderNamed('Run It GO')).items.find((i) => i.title === 'Described album').id}"]`));
  let f = p.q('form[data-form="edit-item"]');
  assert.equal(f.elements.description.value, 'Includes a poster.\nShips next month.', 'the edit form is pre-filled');
  p.fill(f, { description: long }); await p.submit(f);
  assert.match(p.text(item()), /Long text\./);
  assert.match(p.text(item()), /…/, 'a long description is shortened in the list');
  assert.equal((await orderNamed('Run It GO')).items.find((i) => i.title === 'Described album').description, long.trim(), 'but stored in full');

  await p.click(p.q(`[data-act="edit-item"][data-id="${(await orderNamed('Run It GO')).items.find((i) => i.title === 'Described album').id}"]`));
  f = p.q('form[data-form="edit-item"]'); p.fill(f, { description: '' }); await p.submit(f);
  assert.doesNotMatch(p.text(item()), /Long text/);
  assert.equal((await orderNamed('Run It GO')).items.find((i) => i.title === 'Described album').description, '');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('descriptions: too long is explained, and HTML in a description is shown as text', async () => {
  const p = await gom();
  const o = await orderNamed('Run It GO');
  await p.click(p.q(`[data-act="open-items"][data-id="${o.id}"]`));
  const form = () => p.q('form[data-form="new-item"]');
  p.fill(form(), { title: 'Too wordy', price: '1', description: 'x'.repeat(2001) }); await p.submit(form());
  assert.ok(p.text(p.q('[data-msg]', form())).length > 0);
  assert.equal((await orderNamed('Run It GO')).items.some((i) => i.title === 'Too wordy'), false);
  p.fill(form(), { title: 'Markup item', price: '1', description: '<img src=x onerror="window.pwned=1">' }); await p.submit(form());
  assert.equal(p.q('#itemsPanel img'), null);
  assert.match(p.text(p.byText('#itemsPanel tbody tr', 'Markup item')), /<img src=x onerror="window\.pwned=1">/);
  assert.equal(p.window.pwned, undefined);
  p.close();
});

test('if the session ends while the page is open, the next action returns to the sign-in with an explanation', async () => {
  const p = await gom();
  await app.q('DELETE FROM sessions WHERE account_id = (SELECT id FROM accounts WHERE username = ?)', [ADMIN.username]);
  await p.click(p.byText('#tabs button', 'Claims'));
  assert.equal(p.q('#loginView').hidden, false);
  assert.equal(p.q('#appView').hidden, true);
  assert.match(p.text(p.q('#loginMsg')), /session ended/);
  p.close();
});
