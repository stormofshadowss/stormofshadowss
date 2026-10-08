import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure, tickParcel } from './helpers.js';
import { openPage, modal, press, toast } from './ui.helpers.js';

const READY = 'ready to pack / on hand';
let app, admin, w;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  await app.api('PUT', '/api/admin/payment-methods', { methods: [{ method: 'PayPal', accountInfo: '@storm (Friends & Family)' }, { method: 'Wise', accountInfo: '@stormw' }] }, admin);
});
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const pendingPayments = async () => (await api('GET', '/api/admin/payments?status=pending')).json.payments;
const mine = (h) => openPage(app, '/my.html', { cookies: [cookies[h]] });
const cookies = {};
async function joiner(handle, { address = null } = {}) {
  cookies[handle] = await joinerSession(app, `${handle}@x.com`, handle);
  if (address) await api('PUT', '/api/my/address', { fullName: address, address: '12 Test Street, Leeds, LS1 1AA', email: `${handle}@x.com`, phone: '07700 900123' }, cookies[handle]);
  return cookies[handle];
}
// Opens a section. Opening the one you're already on reloads it, like pressing refresh.
const go = async (p, hash) => {
  if (p.window.location.hash === hash) p.window.dispatchEvent(new p.window.HashChangeEvent('hashchange'));
  else p.window.location.hash = hash;
  await new Promise((r) => setTimeout(r, 30)); await p.settle();
};
const text = (p, sel = '#view') => p.text(p.q(sel));
const tiles = (p) => Object.fromEntries(p.qa('.tile').map((t) => [p.text(t.firstElementChild), p.text(t.lastElementChild)]));
async function readyClaims(handle, ...items) {
  const ids = [];
  for (const it of items) { const [id] = await claimAndSecure(app, admin, handle, it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); ids.push(id); }
  return ids;
}

test('the landing page: what you owe (five tiles), and a card for each thing you can do with live hints', async () => {
  await joiner('lan_h');
  const [id] = await claimAndSecure(app, admin, 'lan_h', w.keyring);
  await api('POST', '/api/claims', { handle: 'lan_h', lines: [{ itemId: w.album }] });            // stays "requested"
  await api('PATCH', `/api/admin/claims/${id}`, { costs: { ems: { cost: 2 } } });
  const p = await mine('lan_h');
  assert.deepEqual(tiles(p), { Initials: '£6.00', EMS: '£2.00', Customs: '£0.00', Doms: '£0.00', Packaging: '£0.00', 'Total to pay': '£8.00' });
  const cards = Object.fromEntries(p.qa('a.gocard').map((c) => [p.text(c.querySelector('strong')), p.text(c.querySelector('.sub'))]));
  assert.deepEqual(cards, { 'Make a payment': '£8.00 owed', 'Request shipping': 'nothing ready yet', 'Ongoing orders': '2 items', 'Completed orders': '0 received', 'Email notifications': 'off', 'Delivery details': 'not added yet' });
  assert.deepEqual([p.errors], [[]]);
  p.close();
});

test('someone with two handles can switch between them', async () => {
  const c = await joiner('two_a');
  await claimAndSecure(app, admin, 'two_a', w.keyring);
  assert.equal((await api('POST', '/api/me/handles', { handle: 'two_b' }, c)).status, 200);
  const p = await mine('two_a');
  assert.equal(tiles(p)['Total to pay'], '£6.00');
  await p.choose(p.q('#sw'), 'two_b');
  assert.equal(tiles(p)['Total to pay'], '£0.00', 'the other handle owes nothing');
  assert.match(text(p, '#handleCard'), /@two_a.*@two_b/);
  p.close();
});

test('paying when nothing is owed says so', async () => {
  await joiner('paid_up');
  const p = await mine('paid_up'); await go(p, '#/pay');
  assert.match(text(p), /Nothing owing right now — you're all paid up/);
  assert.equal(p.q('form[data-form="pay"]'), null);
  p.close();
});

test('make a payment: where to send it, scope and amount follow each other, mistakes are explained, and the GOM receives it', async () => {
  await joiner('pay_h');
  await claimAndSecure(app, admin, 'pay_h', w.keyring);                // £6 in Run It GO
  const second = (await api('POST', '/api/admin/orders', { groupId: w.group, title: 'Second GO', paymentDeadline: '2099-03-03' })).json.id;
  const poster = (await api('POST', `/api/admin/orders/${second}/items`, { type: 'normal', title: 'Poster', price: 10 })).json.id;
  await claimAndSecure(app, admin, 'pay_h', poster);                   // £10 in Second GO
  const p = await mine('pay_h'); await go(p, '#/pay');
  assert.match(text(p), /PayPal: @storm \(Friends & Family\).*Wise: @stormw/);
  const form = () => p.q('form[data-form="pay"]');
  assert.match(text(p), /All outstanding — combined \(£16\.00\)/);
  assert.match(text(p), /Run It GO \(£6\.00\)/); assert.match(text(p), /Second GO \(£10\.00\)/);
  assert.equal(form().elements.amount.value, '16');
  await p.choose(form().elements.scope, String(second));
  assert.equal(form().elements.amount.value, '10', 'picking an order sets the amount owed for it');

  await p.submit(form());
  assert.match(text(p, '[data-msg]'), /Choose how you paid/);
  form().elements.method.value = 'PayPal'; await p.submit(form());
  assert.match(text(p, '[data-msg]'), /Add a transaction ID or the name the payment was sent under/, 'no name on file, so it needs a reference');
  form().elements.reference.value = 'TX-12345'; await p.submit(form());
  assert.match(text(p, '[data-sent]'), /Thanks! Your £10\.00 payment is with the GOM to check/);
  const sent = (await pendingPayments()).find((x) => x.handle === 'pay_h');
  assert.deepEqual([sent.amount, sent.method, sent.reference, sent.orderTitle], [10, 'PayPal', 'TX-12345', 'Second GO']);
  assert.match(text(p), /£10\.00 · PayPal.*Second GO · TX-12345.*waiting for the GOM to check/);
  assert.equal(tiles(await (async () => { await go(p, '#/'); return p; })())['Total to pay'], '£16.00', 'nothing counts until the GOM verifies it');
  p.close();
});

test('paying more than you owe: you must choose credit or tip, and the choice reaches the GOM', async () => {
  await joiner('over_h');
  await claimAndSecure(app, admin, 'over_h', w.keyring);               // owes £6
  const p = await mine('over_h'); await go(p, '#/pay');
  const form = () => p.q('form[data-form="pay"]');
  assert.equal(p.q('[data-overpay]').hidden, true);
  form().elements.method.value = 'Wise'; form().elements.reference.value = 'Over Payer';
  await p.type(form().elements.amount, '10');
  assert.equal(p.q('[data-overpay]').hidden, false);
  assert.match(text(p, '[data-overpay-head]'), /You're paying £4\.00 more than you owe/);
  await p.submit(form());
  assert.match(text(p, '[data-msg]'), /£4\.00 more than you owe — choose whether that's credit for next time or a tip/);
  assert.equal((await pendingPayments()).some((x) => x.handle === 'over_h'), false, 'nothing was sent');
  form().elements.overpayChoice.value = 'tip'; form().elements.overpayNote.value = 'thank you!';
  await p.submit(form());
  const sent = (await pendingPayments()).find((x) => x.handle === 'over_h');
  assert.deepEqual([sent.amount, sent.overpayAmount, sent.overpayChoice, sent.overpayNote], [10, 4, 'tip', 'thank you!']);
  await p.type(form().elements.amount, '6');
  assert.equal(p.q('[data-overpay]').hidden, true, 'back to the exact amount hides the question');
  p.close();
});

test('whose name: with a delivery name on file it defaults to it; a different name must be typed', async () => {
  await joiner('name_h', { address: 'Nora Name' });
  await claimAndSecure(app, admin, 'name_h', w.keyring);
  const p = await mine('name_h'); await go(p, '#/pay');
  const form = () => p.q('form[data-form="pay"]');
  assert.match(text(p), /My delivery name \(Nora Name\)/);
  assert.equal(form().elements.payerName.hidden, true);
  form().elements.method.value = 'PayPal';
  await p.submit(form());                                           // no reference needed: paid under her own name
  assert.equal((await pendingPayments()).find((x) => x.handle === 'name_h').payerIsAddressName, true);
  await p.click(p.q('input[name="payerChoice"][value="other"]'));
  assert.equal(form().elements.payerName.hidden, false);
  form().elements.method.value = 'Wise'; await p.submit(form());
  assert.match(text(p, '[data-msg]'), /Type the name the payment was made under/);
  form().elements.payerName.value = 'Dan Dee'; await p.submit(form());
  const rows = (await pendingPayments()).filter((x) => x.handle === 'name_h');
  assert.deepEqual(rows.map((r) => [r.payerName, r.payerIsAddressName]).sort(), [['Dan Dee', false], ['Nora Name', true]]);
  p.close();
});

test('once the GOM verifies a payment, the joiner sees it counted and the history says received', async () => {
  const p = await mine('name_h');
  for (const pay of (await pendingPayments()).filter((x) => x.handle === 'name_h')) await api('POST', `/api/admin/payments/${pay.id}/verify`, {});
  await go(p, '#/pay');                                              // opening a section loads fresh figures
  assert.match(text(p), /received ✓/);
  await go(p, '#/');
  assert.equal(tiles(p)['Total to pay'], '£0.00');
  p.close();
});

test('delivery details: saved, validated, and pre-filled next time', async () => {
  await joiner('addr_h');
  const p = await mine('addr_h'); await go(p, '#/address');
  const form = () => p.q('form[data-form="address"]');
  assert.equal(form().elements.email.value, 'addr_h@x.com', 'email is pre-filled from the account');
  p.fill(form(), { fullName: 'Ada Addr', address: 'x', phone: '07700 900001' }); await p.submit(form());
  assert.ok(text(p, '[data-msg]').length > 0, 'an address that is too short is refused with a message');
  p.fill(form(), { address: '1 Test Road\nLeeds\nLS1 1AA\nUnited Kingdom' }); await p.submit(form());
  assert.match(text(p), /Saved ✓.*Request shipping/);
  const a = (await api('GET', '/api/my/address', undefined, cookies.addr_h)).json.address;
  assert.deepEqual([a.fullName, a.address, a.phone], ['Ada Addr', '1 Test Road\nLeeds\nLS1 1AA\nUnited Kingdom', '07700 900001']);
  await go(p, '#/address');
  assert.equal(form().elements.fullName.value, 'Ada Addr');
  assert.match(text(p), /Last confirmed \d\d\/\d\d\/\d{4}/);
  await go(p, '#/');
  assert.match(text(p, 'a.gocard[href="#/address"]'), /Ada Addr/);
  p.close();
});

test('request shipping needs delivery details first, then ready items', async () => {
  await joiner('noaddr_h');
  await readyClaims('noaddr_h', w.keyring);
  const p = await mine('noaddr_h'); await go(p, '#/ship');
  assert.match(text(p), /Add your delivery details first/);
  await joiner('noready_h', { address: 'No Ready' });
  const q = await mine('noready_h'); await go(q, '#/ship');
  assert.match(text(q), /Nothing is ready to ship yet/);
  p.close(); q.close();
});

test('request shipping end to end: choose items, method, notes, bias, Lomo name; the GOM sees it all; the items leave the list', async () => {
  await joiner('ship_h', { address: 'Sam Ship' });
  const [k1, k2] = await readyClaims('ship_h', w.keyring, w.keyring);
  const [album] = await readyClaims('ship_h', w.album);
  const p = await mine('ship_h'); await go(p, '#/ship');
  const form = () => p.q('form[data-form="ship"]');
  assert.equal(p.qa('input[name="claim"]').length, 3);
  assert.match(text(p), /Sometimes I like to include a personalised Lomo in with orders.*Sam Ship.*name you would prefer me to use/);
  assert.equal(form().elements.lomoName.placeholder, 'Leave blank to use Sam Ship');
  assert.equal(p.q('[data-declared]').hidden, true);

  await p.submit(form());
  assert.match(text(p, '[data-msg]'), /Select at least one item/);
  p.qa('input[name="claim"]').slice(0, 2).forEach((c) => { c.checked = true; });
  await p.submit(form());
  assert.match(text(p, '[data-msg]'), /Choose a shipping method first/);
  await p.choose(form().elements.method, 'WW Tracked');
  assert.equal(p.q('[data-declared]').hidden, false, 'worldwide methods ask for a declared value');
  await p.submit(form());
  assert.match(text(p, '[data-msg]'), /Choose a declared value for customs/);
  form().elements.declaredValue.value = 'reduced'; await p.submit(form());
  assert.match(text(p, '[data-msg]'), /confirm your delivery details are still correct/);
  form().elements.addressConfirmed.checked = true;
  form().elements.notes.value = 'toploader please'; form().elements.bias.value = 'Hyunjin'; form().elements.lomoName.value = 'Sammy';
  await p.submit(form());

  assert.match(text(p, '[data-sent]'), /Shipping requested — parcel #\d+ is number 1 in the packing queue/);
  const parcel = (await api('GET', '/api/admin/packing')).json.parcels.find((x) => x.handle === 'ship_h');
  assert.deepEqual([parcel.method, parcel.declaredValue, parcel.notes, parcel.bias, parcel.lomoName, parcel.lomoSource], ['WW Tracked', 'reduced', 'toploader please', 'Hyunjin', 'Sammy', 'custom']);
  assert.deepEqual(parcel.items.map((i) => i.claimId).sort(), [k1, k2].sort());
  assert.equal(p.qa('input[name="claim"]').length, 1, 'only the item not yet requested is still listed');
  assert.match(text(p), /Your parcels.*Parcel #\d+ In the queue — number 1.*Keyring, Keyring.*WW Tracked.*Personalised Lomo: Sammy/);
  assert.equal(p.window.document.querySelector('input[name="claim"]').value, String(album));
  p.close();
});

test('leaving the Lomo box blank uses the delivery name', async () => {
  await joiner('lomo_h', { address: 'Lo Mo' });
  await readyClaims('lomo_h', w.keyring);
  const p = await mine('lomo_h'); await go(p, '#/ship');
  const form = () => p.q('form[data-form="ship"]');
  p.q('input[name="claim"]').checked = true; await p.choose(form().elements.method, 'UK Royal Mail Tracked 48');
  form().elements.addressConfirmed.checked = true; await p.submit(form());
  const parcel = (await api('GET', '/api/admin/packing')).json.parcels.find((x) => x.handle === 'lomo_h');
  assert.deepEqual([parcel.lomoName, parcel.lomoSource], ['Lo Mo', 'delivery']);
  p.close();
});

test('following a parcel: queue → fees → packed → on its way → "it\'s arrived" completes the order', async () => {
  await joiner('track_h', { address: 'Tracy Track' });
  const [id] = await readyClaims('track_h', w.keyring);
  const p = await mine('track_h'); await go(p, '#/ship');
  p.q('input[name="claim"]').checked = true; await p.choose(p.q('select[name="method"]'), 'UK Royal Mail Tracked 48');
  p.q('input[name="addressConfirmed"]').checked = true; await p.submit(p.q('form[data-form="ship"]'));
  const parcel = (await api('GET', '/api/admin/packing')).json.parcels.find((x) => x.handle === 'track_h');

  await api('POST', `/api/admin/parcels/${parcel.id}/fees`, { doms: 4.5, packaging: 1 });
  await tickParcel(app, admin, parcel.id);
  await api('POST', `/api/admin/parcels/${parcel.id}/packed`, {});
  await go(p, '#/ship');
  assert.match(text(p, `[data-parcel="${parcel.id}"]`), /Packed.*Postage £4\.50 · Packaging £1\.00/);
  assert.equal(p.q('[data-act="received"]'), null, 'no "arrived" button until it has shipped');
  await go(p, '#/');
  assert.equal(tiles(p).Doms, '£4.50'); assert.equal(tiles(p).Packaging, '£1.00');

  await api('POST', `/api/admin/parcels/${parcel.id}/shipped`, {});
  await go(p, '#/ongoing');
  assert.match(text(p), /Keyring.*On its way \(parcel #\d+\)/);
  assert.match(text(p), /Parcels on their way.*It's arrived — mark as received/);
  await p.click(p.q('[data-act="received"]'));
  assert.match(p.text(p.q('#toast')), /Marked as received/);
  assert.equal((await claimsOf('track_h'))[0].pipeline, 'completed');
  await go(p, '#/completed');
  assert.match(text(p), /Keyring.*Received \d\d\/\d\d\/\d{4}/);
  await go(p, '#/ongoing');
  assert.match(text(p), /No ongoing orders/);
  assert.ok(p.q('#view a[href="#/completed"]'), 'an empty Ongoing page points to Completed');
  assert.deepEqual([p.errors], [[]]);
  p.close();
});

test('ongoing orders: grouped by order, each item shows its stage, cost lines with paid dates, and an overdue flag', async () => {
  await joiner('ong_h');
  const [paid] = await claimAndSecure(app, admin, 'ong_h', w.keyring);
  await api('PATCH', `/api/admin/claims/${paid}`, { costs: { initials: { paid: 6 }, ems: { cost: 2 } } });
  await claimAndSecure(app, admin, 'ong_h', w.album);
  await api('PATCH', `/api/admin/orders/${w.order}`, { paymentDeadline: '2000-01-01' });
  const p = await mine('ong_h'); await go(p, '#/ongoing');
  assert.match(text(p), /Run It GO.*Keyring.*awaiting fulfillment/);
  assert.match(text(p), /Initials £6\.00 · paid \d\d\/\d\d\/\d{4}/);
  assert.match(text(p), /EMS £2\.00 · £2\.00 to pay/);
  assert.match(text(p), /Album.*Initials £26\.00 · £26\.00 to pay/);
  assert.ok(p.qa('.pill.warn').some((x) => x.textContent === 'overdue'), 'overdue is flagged');
  await api('PATCH', `/api/admin/orders/${w.order}`, { paymentDeadline: '2099-01-10' });
  p.close();
});

test('deleting your account: asked first; keeping it changes nothing; confirming erases it; a parcel on its way blocks it', async () => {
  await joiner('del_h', { address: 'Del Eted' });
  await claimAndSecure(app, admin, 'del_h', w.keyring);
  const p = await mine('del_h'); await go(p, '#/account');
  await p.click(p.q('[data-act="delete"]'));
  assert.match(p.text(modal(p)), /erased and you'll be signed out.*can't be undone/s);
  await press(p, 'Keep my account');
  assert.equal((await api('GET', '/api/me', undefined, cookies.del_h)).status, 200);
  await p.click(p.q('[data-act="delete"]')); await press(p, 'Yes, delete it');
  assert.match(text(p), /Your account has been deleted/);
  assert.equal((await api('GET', '/api/me', undefined, cookies.del_h)).status, 401);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM addresses a JOIN joiners j ON j.id = a.joiner_id WHERE j.instagram_handle = 'del_h'"))[0].n, 0);

  await joiner('delblock_h', { address: 'Block Ed' });
  await readyClaims('delblock_h', w.keyring);
  const q = await mine('delblock_h'); await go(q, '#/ship');
  q.q('input[name="claim"]').checked = true; await q.choose(q.q('select[name="method"]'), 'UK Inpost to House');
  q.q('input[name="addressConfirmed"]').checked = true; await q.submit(q.q('form[data-form="ship"]'));
  await go(q, '#/account'); await q.click(q.q('[data-act="delete"]')); await press(q, 'Yes, delete it');
  assert.match(text(q, '[data-msg]'), /parcel for @delblock_h is still on its way/);
  assert.equal((await api('GET', '/api/me', undefined, cookies.delblock_h)).status, 200, 'nothing was deleted');
  p.close(); q.close();
});

test('labels with HTML are shown as text on every joiner page', async () => {
  await joiner('xss_h', { address: '<b>Bold</b> Buyer' });
  const o = (await api('POST', '/api/admin/orders', { groupId: w.group, title: '<img src=x onerror="window.pwned=1"> GO' })).json.id;
  const it = (await api('POST', `/api/admin/orders/${o}/items`, { type: 'normal', title: '<script>window.pwned=2</script>Thing', price: 1 })).json.id;
  const [id] = await claimAndSecure(app, admin, 'xss_h', it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY });
  const p = await mine('xss_h');
  for (const hash of ['#/', '#/ongoing', '#/ship', '#/pay', '#/address']) {
    await go(p, hash);
    assert.equal(p.q('#view img'), null, hash); assert.equal(p.q('#view script'), null, hash);
  }
  await go(p, '#/ongoing');
  assert.match(text(p), /<script>window\.pwned=2<\/script>Thing/);
  await go(p, '#/ship');
  assert.match(text(p), /<b>Bold<\/b> Buyer/);
  assert.equal(p.window.pwned, undefined);
  p.close();
});


test('a share of an unclaimed part: the joiner sees it in what they owe, and what it is for', async () => {
  const h = 'share_h'; await joiner(h);
  const set = (await api('POST', '/api/admin/orders', { groupId: w.group, title: 'Share GO' })).json.id;
  const item = (await api('POST', `/api/admin/orders/${set}/items`, { type: 'set', title: 'Share set', price: 6, members: ['X', 'Y', 'Z'] })).json.id;
  await api('POST', '/api/claims', { handle: h, lines: [{ itemId: item, parts: [{ member: 'X', qty: 1 }] }] }, undefined);
  await api('POST', '/api/claims', { handle: 'share_other', lines: [{ itemId: item, parts: [{ member: 'Y', qty: 1 }] }] }, undefined);
  const s1 = (await api('GET', '/api/admin/sets')).json.sets.find((x) => x.itemId === item);
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  await api('POST', `/api/admin/sets/${s1.id}/split`, { member: 'Z' });                       // £6 over 2 people = £3 each
  const p = await mine(h);
  assert.equal(tiles(p).Initials, '£9.00');
  await go(p, '#/ongoing');
  assert.match(text(p), /Initials £9\.00 \(includes £3\.00 for an unclaimed part\) · £9\.00 to pay/);
  p.close();
});

// ───────────── email notifications (opt-in) ─────────────
test('email notifications: off by default, explained plainly, and turned on and off with one tick', async () => {
  const h = 'notify_nia'; await joiner(h);
  let p = await mine(h);
  assert.match(text(p, 'a.gocard[href="#/notifications"]'), /Email notifications.*off/);
  await go(p, '#/notifications');
  const t = text(p);
  assert.match(t, new RegExp(`These are off unless you turn them on.*notify_nia@x\\.com`, 's'));
  assert.match(t, /your claims are secured \(and what you now owe\).*verified — or couldn't be.*your parcel has been shipped.*one reminder per item, never repeated/s);
  assert.equal(p.q('#notifyToggle').checked, false);
  assert.match(t, /Notifications are off\./);
  await p.click(p.q('#notifyToggle'));
  assert.match(toast(p), /Email notifications turned on/);
  assert.match(text(p, '[data-state]'), /Notifications are on\. This covers every Instagram handle linked to your email/);
  assert.equal((await app.api('GET', '/api/my/notifications', undefined, cookies[h])).json.enabled, true, 'really saved');
  await go(p, '#/');
  assert.match(text(p, 'a.gocard[href="#/notifications"]'), /Email notifications.*on/);
  await go(p, '#/notifications');
  assert.equal(p.q('#notifyToggle').checked, true, 'remembered');
  await p.click(p.q('#notifyToggle'));
  assert.equal((await app.api('GET', '/api/my/notifications', undefined, cookies[h])).json.enabled, false);
  assert.match(text(p, '[data-state]'), /Notifications are off\./);
  assert.deepEqual(p.errors, []);
  p.close();
});

test('the link at the bottom of every notification email lands on this page', async () => {
  const h = 'notify_oli'; await joiner(h);
  await app.api('PUT', '/api/my/notifications', { enabled: true }, cookies[h]);
  const { item } = { item: (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'normal', title: 'Footer item', price: 2 })).json.id };
  await claimAndSecure(app, admin, h, item); await app.notifier.idle();
  const mail = app.mailer.outbox.filter((m) => m.to === 'notify_oli@x.com' && !/auth\/confirm/.test(m.text)).pop();
  const hash = new URL(/(https?:\/\/\S+#\/notifications)/.exec(mail.text)[1]).hash;
  const p = await mine(h); await go(p, hash);
  assert.match(text(p), /Email notifications.*Email me about my orders/s);
  p.close();
});

test('a shop item shows in Ongoing orders under "Shop (on hand)" with what is owed and when to pay by', async () => {
  const h = 'shop_myorders'; await joiner(h);
  const id = (await api('POST', '/api/admin/shop', { title: 'My shop photobook', price: 14, qty: 2, payDays: 5 })).json.id;
  await app.api('POST', '/api/claims', { handle: h, lines: [{ leftoverId: id }] });
  const p = await mine(h);
  assert.equal(tiles(p).Initials, '£14.00');
  await go(p, '#/ongoing');
  const t = text(p);
  assert.match(t, /Shop \(on hand\).*My shop photobook.*Initials £14\.00.*to pay/s);
  assert.match(t, /pay by \d\d\/\d\d\/\d{4}/i);
  assert.deepEqual(p.errors, []);
  p.close();
});
