import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession, tickParcel } from './helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const fresh = (p = 'nt') => `${p}${++N}`;
// notification emails only (sign-in links are separate and always sent)
const mailsTo = (email) => app.mailer.outbox.filter((m) => m.to === email && !/auth\/confirm/.test(m.text));
// a joiner who is signed in, linked to a handle, and (optionally) opted in
async function joiner({ optIn = true } = {}) {
  const handle = fresh(), email = `${handle}@x.com`;
  const cookie = await joinerSession(app, email, handle);
  if (optIn) await app.api('PUT', '/api/my/notifications', { enabled: true }, cookie);
  return { handle, email, cookie };
}
const settle = () => app.notifier.idle();
async function orderWith(opts = {}, itemOpts = {}) {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Notify GO ${++N}`, ...opts })).json.id;
  const item = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: `Notify item ${N}`, price: 10, ...itemOpts })).json.id;
  return { go, item };
}

test('the setting: off by default, one per account, saved, and only for signed-in people', async () => {
  const j = await joiner({ optIn: false });
  const first = (await app.api('GET', '/api/my/notifications', undefined, j.cookie)).json;
  assert.deepEqual([first.enabled, first.email, first.events.length, first.events.every((e) => e.enabled)], [false, j.email, 6, true], 'off by default; every kind is on once emails are enabled');
  assert.equal((await app.api('PUT', '/api/my/notifications', { enabled: true }, j.cookie)).status, 200);
  assert.equal((await app.api('GET', '/api/my/notifications', undefined, j.cookie)).json.enabled, true);
  assert.equal((await app.api('PUT', '/api/my/notifications', { enabled: false }, j.cookie)).json.enabled, false);
  assert.equal((await app.api('PUT', '/api/my/notifications', { enabled: 'yes' }, j.cookie)).status, 400);
  assert.equal((await app.api('GET', '/api/my/notifications')).status, 401);
  assert.equal((await app.api('PUT', '/api/my/notifications', { enabled: true })).status, 401);
});

test('opting in covers every handle on the account, and one person opting in does not affect another', async () => {
  const a = await joiner(), b = await joiner({ optIn: false });
  assert.equal((await app.api('POST', '/api/me/handles', { handle: fresh('second') }, a.cookie)).status, 200);
  assert.equal((await app.api('GET', '/api/my/notifications', undefined, b.cookie)).json.enabled, false);
});

test('NOTHING is sent unless they opted in — not for secured claims, payments or parcels — and never to handles with no email', async () => {
  const off = await joiner({ optIn: false });
  const { item } = await orderWith();
  await claimAndSecure(app, admin, off.handle, item);
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 10, reference: 'OFF' }, off.cookie);
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  await settle();
  assert.deepEqual(mailsTo(off.email), [], 'opted out: silence');
  const sent = app.mailer.outbox.length;
  await claimAndSecure(app, admin, fresh('anon'), item);                                       // a handle nobody has linked an email to
  await settle();
  assert.equal(app.mailer.outbox.length, sent, 'no email of any kind went out');
});

test('claims secured: ONE email per person listing what was confirmed, its cost and the total they now owe, with a way to pay and a way to turn it off', async () => {
  const j = await joiner(); const a = await orderWith(), b = await orderWith({}, { price: 4.5 });
  await api('POST', '/api/claims', { handle: j.handle, lines: [{ itemId: a.item }, { itemId: b.item }] }, undefined);
  await api('POST', '/api/admin/claims/secure', { orderId: a.go }); await api('POST', '/api/admin/claims/secure', { orderId: b.go });
  await settle();
  const mails = mailsTo(j.email);
  assert.equal(mails.length, 2, 'one email per securing action');
  const first = mails.find((m) => /Notify item \d+ — £10\.00/.test(m.text));
  assert.match(first.subject, new RegExp(`^Your order is confirmed \\(@${j.handle}\\)$`));
  assert.match(first.text, new RegExp(`Hi @${j.handle},`)); assert.match(first.text, /this claim is now secured/);
  assert.match(first.text, /You now owe £10\.00 in total across your orders\./);
  assert.match(mails.find((m) => /4\.50/.test(m.text)).text, /You now owe £14\.50 in total/, 'the total counts everything they owe, not just this batch');
  assert.match(first.text, /\/my\.html#\/pay/); assert.match(first.text, /turned on email notifications.*\/my\.html#\/notifications/s);
});

test('securing several claims at once is still one email, listing them all', async () => {
  const j = await joiner(); const { go, item } = await orderWith();
  const item2 = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'Second thing', price: 5 })).json.id;
  await api('POST', '/api/claims', { handle: j.handle, lines: [{ itemId: item }, { itemId: item2 }] }, undefined);
  await api('POST', '/api/admin/claims/secure', { orderId: go });
  await settle();
  const [m] = mailsTo(j.email);
  assert.equal(mailsTo(j.email).length, 1);
  assert.match(m.text, /these claims are now secured:.*Notify item.*£10\.00.*Second thing.*£5\.00.*owe £15\.00/s);
});

test('securing a member set emails everyone in it; adding someone to an already-secured set emails them too', async () => {
  const [a, b, late] = [await joiner(), await joiner(), await joiner()];
  const { go } = await orderWith();
  const set = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: 'Notify set', price: 6, members: ['A', 'B', 'C'] })).json.id;
  await api('POST', '/api/claims', { handle: a.handle, lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] }, undefined);
  await api('POST', '/api/claims', { handle: b.handle, lines: [{ itemId: set, parts: [{ member: 'B', qty: 1 }] }] }, undefined);
  const s1 = (await api('GET', '/api/admin/sets')).json.sets.find((s) => s.itemId === set);
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  await settle();
  assert.match(mailsTo(a.email)[0].text, /Notify set — A \(Set 1\) — £6\.00/);
  assert.match(mailsTo(b.email)[0].text, /Notify set — B \(Set 1\) — £6\.00/);
  assert.equal(mailsTo(late.email).length, 0);
  await api('POST', `/api/admin/sets/${s1.id}/slots`, { member: 'C', handle: late.handle });
  await settle();
  assert.match(mailsTo(late.email)[0].text, /Notify set — C \(Set 1\) — £6\.00/, 'confirmed straight away, so they are told');
  assert.equal(mailsTo(a.email).length, 1, 'nobody else was emailed again');
});

test('a payment verified: says how much, how it was sent, and whether they are all paid up or still owe — and mentions credit', async () => {
  const j = await joiner(); const { item } = await orderWith();
  await claimAndSecure(app, admin, j.handle, item); await settle();
  const before = mailsTo(j.email).length;
  const p1 = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 4, reference: 'TX-777' }, j.cookie);
  await api('POST', `/api/admin/payments/${p1.json.id}/verify`, {}); await settle();
  const partial = mailsTo(j.email)[before];
  assert.match(partial.subject, new RegExp(`^Payment received — thank you \\(@${j.handle}\\)$`));
  assert.match(partial.text, /payment of £4\.00 via PayPal \(ref: TX-777\) has been verified.*You still owe £6\.00\./s);
  const p2 = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 9, reference: 'TX-778', overpay: { choice: 'credit' } }, j.cookie);
  await api('POST', `/api/admin/payments/${p2.json.id}/verify`, {}); await settle();
  const full = mailsTo(j.email).pop();
  assert.match(full.text, /You're all paid up\. You have £3\.00 credit on your account\./);
});

test('a payment rejected: they are told it was not applied and what to do; nothing is sent while it is still pending, or if it was already dealt with', async () => {
  const j = await joiner(); const { item } = await orderWith();
  await claimAndSecure(app, admin, j.handle, item); await settle();
  const before = mailsTo(j.email).length;
  const p = await app.api('POST', '/api/my/payments', { method: 'Bank transfer', amount: 10, reference: 'BAD' }, j.cookie);
  await settle(); assert.equal(mailsTo(j.email).length, before, 'pending: no email');
  await api('POST', `/api/admin/payments/${p.json.id}/reject`, {}); await settle();
  const m = mailsTo(j.email)[before];
  assert.match(m.subject, /^We couldn't verify your payment/);
  assert.match(m.text, /£10\.00 via Bank transfer \(ref: BAD\), so it hasn't been applied.*get in touch/s);
  assert.equal((await api('POST', `/api/admin/payments/${p.json.id}/verify`, {})).status, 409);
  assert.equal((await api('POST', `/api/admin/payments/${p.json.id}/reject`, {})).status, 409);
  await settle(); assert.equal(mailsTo(j.email).length, before + 1, 'a refused second decision sends nothing');
});

test('a parcel shipped: one email when it ships (not when packed or received), with the method and item count — and no internal tracking details', async () => {
  const j = await joiner(); const { item } = await orderWith();
  await app.api('PUT', '/api/my/address', { fullName: 'S T', address: '1 Road, Leeds', email: j.email, phone: '0700' }, j.cookie);
  const [id] = await claimAndSecure(app, admin, j.handle, item);
  await api('PATCH', `/api/admin/claims/${id}`, { pipeline: 'ready to pack / on hand' });
  const p = (await app.api('POST', '/api/my/parcels', { claimIds: [id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, j.cookie)).json;
  await tickParcel(app, admin, p.id); await settle();
  const before = mailsTo(j.email).length;
  await api('POST', `/api/admin/parcels/${p.id}/packed`, {}); await settle();
  assert.equal(mailsTo(j.email).length, before, 'packed: nothing yet');
  await api('POST', `/api/admin/parcels/${p.id}/shipped`, {}); await settle();
  const m = mailsTo(j.email)[before];
  assert.match(m.subject, new RegExp(`^Your parcel is on its way \\(@${j.handle}\\)$`));
  assert.match(m.text, /Your parcel \(1 item, UK Royal Mail Tracked 48\) has been shipped on \d\d\/\d\d\/\d{4}\./);
  assert.match(m.text, /press "It's arrived"/); assert.doesNotMatch(m.text, /tracking id/i);
  await api('POST', `/api/admin/parcels/${p.id}/received`, {}); await settle();
  assert.equal(mailsTo(j.email).length, before + 1, 'received: nothing more');
});

test('overdue reminder: ONE email per overdue claim, listing what is still owed — and never repeated', async () => {
  const j = await joiner(); const late = await orderWith({ paymentDeadline: iso(3) }), later = await orderWith({ paymentDeadline: iso(9) }, { price: 7 });
  await claimAndSecure(app, admin, j.handle, late.item); await claimAndSecure(app, admin, j.handle, later.item); await settle();
  const before = mailsTo(j.email).length;
  const r = await app.notifier.sendOverdueReminders(); await settle();
  assert.deepEqual([r.emails, r.claims >= 2], [1, true], 'one email even though two claims are overdue');
  const m = mailsTo(j.email)[before];
  assert.match(m.subject, new RegExp(`^A friendly reminder: payment is overdue \\(@${j.handle}\\)$`));
  assert.match(m.text, new RegExp(`Notify item \\d+ — £10\\.00 still to pay \\(was due ${iso(3).slice(8, 10)}/${iso(3).slice(5, 7)}/${iso(3).slice(0, 4)}\\)`));
  assert.match(m.text, /£7\.00 still to pay/); assert.match(m.text, /This is the only reminder we'll send for these items\./);
  assert.equal(mailsTo(j.email).length, before + 1);
  const again = await app.notifier.sendOverdueReminders(); await settle();
  assert.equal(again.emails, 0, 'never repeated'); assert.equal(mailsTo(j.email).length, before + 1);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM notification_log WHERE kind = 'overdue_reminder' AND joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)", [j.handle]))[0].n, 2);
});

test('a NEW overdue claim later gets its own single reminder, mentioning only that one', async () => {
  const j = await joiner(); const o1 = await orderWith({ paymentDeadline: iso(4) });
  await claimAndSecure(app, admin, j.handle, o1.item); await app.notifier.sendOverdueReminders(); await settle();
  const o2 = await orderWith({ paymentDeadline: iso(2) }, { price: 3 });
  await claimAndSecure(app, admin, j.handle, o2.item); await settle();                      // (securing it sends its own "confirmed" email)
  const before = mailsTo(j.email).length;
  await app.notifier.sendOverdueReminders(); await settle();
  assert.equal(mailsTo(j.email).length, before + 1, 'exactly one new email: the reminder');
  const m = mailsTo(j.email)[before];
  assert.match(m.subject, /friendly reminder/);
  assert.match(m.text, /this item is past the pay-by date/); assert.match(m.text, /£3\.00 still to pay/); assert.doesNotMatch(m.text, /£10\.00 still to pay/, 'the first claim was already reminded about');
});

test('reminders only for what is really overdue and unpaid, and only for people who opted in', async () => {
  const [due, future, paid, cancelled, optedOut] = [await joiner(), await joiner(), await joiner(), await joiner(), await joiner({ optIn: false })];
  const [today, ahead, past] = [await orderWith({ paymentDeadline: iso(0) }), await orderWith({ paymentDeadline: iso(-5) }), await orderWith({ paymentDeadline: iso(5) })];
  await claimAndSecure(app, admin, due.handle, today.item);                                   // due today: not overdue yet
  await claimAndSecure(app, admin, future.handle, ahead.item);
  await claimAndSecure(app, admin, paid.handle, past.item);
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 10, reference: 'P' }, paid.cookie); await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  const [cid] = await claimAndSecure(app, admin, cancelled.handle, past.item); await api('PATCH', `/api/admin/claims/${cid}`, { status: 'cancelled' });
  await claimAndSecure(app, admin, optedOut.handle, past.item);
  await settle();
  await app.notifier.sendOverdueReminders(); await settle();
  for (const p of [due, future, paid, cancelled, optedOut]) {
    const reminders = mailsTo(p.email).filter((m) => /friendly reminder/.test(m.subject));
    assert.equal(reminders.length, 0, `@${p.handle} should get no reminder`);
  }
});

test('someone who opts in AFTER their claim went overdue still gets the one reminder (it was never sent while they were opted out)', async () => {
  const j = await joiner({ optIn: false }); const o = await orderWith({ paymentDeadline: iso(6) });
  await claimAndSecure(app, admin, j.handle, o.item);
  await app.notifier.sendOverdueReminders(); await settle();
  assert.equal(mailsTo(j.email).filter((m) => /reminder/.test(m.subject)).length, 0);
  await app.api('PUT', '/api/my/notifications', { enabled: true }, j.cookie);
  await app.notifier.sendOverdueReminders(); await settle();
  assert.equal(mailsTo(j.email).filter((m) => /reminder/.test(m.subject)).length, 1);
});

test('the Overdue tab shows when a reminder was emailed', async () => {
  const j = await joiner(); const o = await orderWith({ paymentDeadline: iso(5) });
  const [id] = await claimAndSecure(app, admin, j.handle, o.item);
  let row = (await api('GET', '/api/admin/overdue')).json.payments.find((p) => p.claimId === id);
  assert.equal(row.remindedAt, null);
  await app.notifier.sendOverdueReminders(); await settle();
  row = (await api('GET', '/api/admin/overdue')).json.payments.find((p) => p.claimId === id);
  assert.ok(row.remindedAt);
});

test('STRESS: five reminder runs at the same instant send exactly one email', async () => {
  const j = await joiner(); const o = await orderWith({ paymentDeadline: iso(4) });
  await claimAndSecure(app, admin, j.handle, o.item); await settle();
  const before = mailsTo(j.email).length;
  await Promise.all(Array.from({ length: 5 }, () => app.notifier.sendOverdueReminders())); await settle();
  assert.equal(mailsTo(j.email).length, before + 1);
});

test('a broken mail server never breaks the action: the payment is still verified, and the reminder is retried next time', async () => {
  const j = await joiner(); const o = await orderWith({ paymentDeadline: iso(4) });
  await claimAndSecure(app, admin, j.handle, o.item); await settle();
  const realSend = app.mailer.send; app.mailer.send = async () => { throw new Error('smtp is down'); };
  const quiet = console.error; console.error = () => {};
  try {
    const p = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 2, reference: 'DOWN' }, j.cookie);
    assert.equal((await api('POST', `/api/admin/payments/${p.json.id}/verify`, {})).status, 200, 'the verification itself succeeded');
    await settle();
    const r = await app.notifier.sendOverdueReminders(); await settle();
    assert.equal(r.emails, 0);
    assert.equal((await app.q("SELECT COUNT(*) AS n FROM notification_log WHERE joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)", [j.handle]))[0].n, 0, 'not marked as sent, so it will be retried');
  } finally { app.mailer.send = realSend; console.error = quiet; }
  const before = mailsTo(j.email).length;
  const retry = await app.notifier.sendOverdueReminders(); await settle();
  assert.equal(retry.emails, 1); assert.equal(mailsTo(j.email).length, before + 1);
});

test('sign-in emails are untouched by all this, whatever the setting', async () => {
  const off = await joiner({ optIn: false });
  await app.api('POST', '/api/auth/request-link', { email: off.email });
  assert.ok(app.mailer.outbox.some((m) => m.to === off.email && /auth\/confirm/.test(m.text)));
});

test('every notification carries the same footer saying why, and how to turn them off', async () => {
  const j = await joiner(); const o = await orderWith({ paymentDeadline: iso(2) });
  await claimAndSecure(app, admin, j.handle, o.item); await app.notifier.sendOverdueReminders();
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 1, reference: 'F' }, j.cookie); await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {}); await settle();
  const mails = mailsTo(j.email);
  assert.ok(mails.length >= 3);
  for (const m of mails) assert.match(m.text, /You're getting this because you turned on email notifications for your orders\. You can turn them off any time: .*\/my\.html#\/notifications$/);
});
