import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// CANCELLED ORDERS AND ITEMS: when the GOM cancels a whole group order or one item ("could not go ahead"), each person with a claim on it gets a notice at the top of My orders for 30 days (or until "Got it"),
// and an email if they have switched that (opt-in) kind on.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'cn') => `${x}${++N}`;
const order = async (title = u('Notice GO ')) => ({ id: (await api('POST', '/api/admin/orders', { groupId: w.group, title })).json.id, title });
const item = async (go, title = u('Notice item ')) => ({ id: (await api('POST', `/api/admin/orders/${go.id}/items`, { type: 'normal', title, price: 10 })).json.id, title });
const person = async (opts = {}) => { const handle = u('np'); const email = `${handle}@x.com`; const cookie = await joinerSession(app, email, handle); if (opts.emails) await api('PUT', '/api/my/notifications', { enabled: true, ...(opts.optIn ? { events: { orderCancelled: true } } : {}) }, cookie); return { handle, email, cookie }; };
const claim = async (p, it) => (await claimAndSecure(app, admin, p.handle, it.id))[0];
const pay = async (p, amount) => { const r = await api('POST', '/api/my/payments', { method: 'PayPal', amount, reference: u('R') }, p.cookie); await api('POST', `/api/admin/payments/${r.json.id}/verify`, {}); };
const cancel = async (what, thing) => { const r = await api('POST', `/api/admin/${what}s/${thing.id}/cancel`, { confirm: thing.title }); assert.equal(r.status, 200, r.text); return r.json; };
const notices = async (p) => (await api('GET', '/api/my/cancelled', undefined, p.cookie)).json;
const mails = (p) => app.mailer.outbox.filter((m) => m.to === p.email && /was cancelled/.test(m.subject));
const settle = async () => { await app.notifier.idle(); await new Promise((r) => setTimeout(r, 50)); await app.notifier.idle(); };

test('A CANCELLED GROUP ORDER: every person who had a claim on it gets a notice — what was cancelled, which of their items, and what happened to their money; people with no claim get none; the notice isn\'t in the cancel reply', async () => {
  const go = await order(), a = await item(go, 'Notice A'), b = await item(go, 'Notice B'); const p1 = await person(), p2 = await person(), p3 = await person();
  await claim(p1, a); await pay(p1, 10); await claim(p1, b); await claim(p2, a); const reply = await cancel('order', go); assert.equal('noticeIds' in reply, false, 'an internal detail is not in the reply'); assert.equal(reply.claims, 3);
  const n1 = await notices(p1); assert.equal(n1.days, 30); assert.equal(n1.notices.length, 1, 'one notice for the one group order'); const g = n1.notices[0];
  assert.deepEqual([g.kind, g.title, g.orderTitle, g.daysAgo, g.key.startsWith('order:'), g.ids.length], ['order', go.title, go.title, 0, true, 2]); assert.deepEqual(g.claims.map((c) => [c.label.includes('Notice'), c.refunded, c.forfeited, c.handle]).sort(), [[true, 0, 0, p1.handle], [true, 10, 0, p1.handle]].sort(), 'the paid claim says £10 credited, the unpaid one says nothing was paid — £10 in total, never counted twice');
  assert.equal((await notices(p2)).notices[0].claims.length, 1, 'the other person has their own'); assert.deepEqual((await notices(p3)).notices, [], 'someone with no claim gets nothing');
});

test('A CANCELLED ITEM: just the people who claimed THAT item, named by the item (and the group order it was in); two cancelled items are two notices, newest first; the rest of the group order is untouched', async () => {
  const go = await order(), a = await item(go, 'Item to cancel'), b = await item(go, 'Another to cancel'), keep = await item(go, 'Stays'); const p = await person(), q = await person();
  await claim(p, a); await claim(p, keep); await claim(q, keep); await cancel('item', a); await new Promise((r) => setTimeout(r, 30)); await claim(p, b); await cancel('item', b);
  const list = (await notices(p)).notices; assert.deepEqual(list.map((x) => [x.kind, x.title, x.orderTitle]), [['item', 'Another to cancel', go.title], ['item', 'Item to cancel', go.title]], 'newest first, named by the item'); assert.deepEqual((await notices(q)).notices, [], 'a person who only claimed the item that stayed');
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND status = 'confirmed'", [keep.id]))[0].n, 2, 'the other item was not touched');
});

test('THE MONEY IS RECORDED AS IT WAS: credited, nothing paid, or forfeited for a blocked handle', async () => {
  const go = await order(), a = await item(go), b = await item(go); const paid = await person(), unpaid = await person(), blocked = await person();
  await claim(paid, a); await pay(paid, 10); await claim(unpaid, b); await claim(blocked, a); await pay(blocked, 10); await app.q('UPDATE joiners SET is_blocked = 1 WHERE instagram_handle = ?', [blocked.handle]); await cancel('order', go);
  const one = async (p) => (await notices(p)).notices[0].claims[0]; assert.deepEqual([(await one(paid)).refunded, (await one(paid)).forfeited], [10, 0]); assert.deepEqual([(await one(unpaid)).refunded, (await one(unpaid)).forfeited], [0, 0]); assert.deepEqual([(await one(blocked)).refunded, (await one(blocked)).forfeited], [0, 10]);
});

test('WHAT DOES NOT MAKE A NOTICE: cancelling one person\'s claim, a claim already cancelled, or a claim already received — only a whole group order or item cancelled by the GOM', async () => {
  const go = await order(), a = await item(go); const p = await person(), q = await person(), r = await person(); const cp = await claim(p, a), cq = await claim(q, a), cr = await claim(r, a);
  assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: [cp] })).status, 200); assert.deepEqual((await notices(p)).notices, [], 'the GOM cancelled just this one claim: no notice');
  await app.q("UPDATE claims SET pipeline = 'completed' WHERE id = ?", [cr]); await cancel('item', a); assert.equal((await notices(q)).notices.length, 1, 'a live claim: a notice'); assert.deepEqual((await notices(r)).notices, [], 'a claim already received: the person has it, nothing to buy elsewhere'); assert.deepEqual((await notices(p)).notices, [], 'a claim already cancelled earlier: still no notice'); assert.ok(cq);
});

test('"GOT IT": hides the notice straight away (all the claims of one cancellation at once); only the person\'s own; harmless twice; checked; signed out refused', async () => {
  const go = await order(), a = await item(go), b = await item(go); const p = await person(), q = await person(); await claim(p, a); await claim(p, b); await claim(q, a); await cancel('order', go);
  const g = (await notices(p)).notices[0]; assert.equal(g.ids.length, 2); const theirs = (await notices(q)).notices[0].ids;
  const stolen = await api('POST', '/api/my/cancelled/dismiss', { ids: theirs }, p.cookie); assert.deepEqual([stolen.status, stolen.json.dismissed], [200, 0], 'someone else\'s notice can\'t be dismissed'); assert.equal((await notices(q)).notices.length, 1);
  const done = await api('POST', '/api/my/cancelled/dismiss', { ids: g.ids }, p.cookie); assert.deepEqual([done.status, done.json.dismissed], [200, 2]); assert.deepEqual((await notices(p)).notices, []); assert.equal((await api('POST', '/api/my/cancelled/dismiss', { ids: g.ids }, p.cookie)).json.dismissed, 0, 'twice: nothing more to do');
  for (const bad of [{ ids: [] }, { ids: ['x'] }, { ids: [0] }, {}]) assert.equal((await api('POST', '/api/my/cancelled/dismiss', bad, p.cookie)).status, 400, JSON.stringify(bad)); assert.equal((await app.api('POST', '/api/my/cancelled/dismiss', { ids: [1] })).status, 401); assert.equal((await app.api('GET', '/api/my/cancelled')).status, 401);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM cancel_notices WHERE joiner_id IN (SELECT id FROM joiners WHERE instagram_handle = ?)', [p.handle]))[0].n, 2, 'the record is kept, just hidden');
});

test('30 DAYS: a notice is shown for 30 days after the cancellation, then it goes (the record stays); the days are counted for the screen', async () => {
  const go = await order(), a = await item(go); const p = await person(); await claim(p, a); await cancel('order', go); const id = (await notices(p)).notices[0].ids[0]; const age = (d) => app.q('UPDATE cancel_notices SET cancelled_at = NOW(3) - INTERVAL ? DAY WHERE id = ?', [d, id]);
  await age(29); const g = (await notices(p)).notices[0]; assert.deepEqual([g.daysAgo, g.claims.length], [29, 1], '29 days: still there'); const ageH = (h) => app.q('UPDATE cancel_notices SET cancelled_at = NOW(3) - INTERVAL ? HOUR WHERE id = ?', [h, id]); await ageH(719); assert.equal((await notices(p)).notices.length, 1, '30 days less an hour: still there'); await ageH(721); assert.equal((await notices(p)).notices.length, 0, '30 days and an hour: gone — the limit is exactly 30 days'); await age(31); assert.deepEqual((await notices(p)).notices, [], '31 days: gone'); assert.equal((await app.q('SELECT COUNT(*) AS n FROM cancel_notices WHERE id = ?', [id]))[0].n, 1, 'but the record is kept');
});

test('THE EMAIL IS OPT-IN: nobody gets it by default (even with order emails on); once they switch this kind on they get ONE email per cancellation — wording, items, money — and it stops when they switch it off or turn emails off', async () => {
  const on = await person({ emails: true, optIn: true }), def = await person({ emails: true }), offAll = await person({ emails: true, optIn: true }), none = await person();
  const go = await order('The Big Order'), a = await item(go, 'Album one'), b = await item(go, 'Photocard two'); await claim(on, a); await pay(on, 10); await claim(on, b); await claim(def, a); await claim(offAll, a); await claim(none, a);
  await api('PUT', '/api/my/notifications', { enabled: false }, offAll.cookie); await cancel('order', go); await settle();
  assert.equal(mails(def).length + mails(offAll).length + mails(none).length, 0, 'not opted in / emails off / no emails: nothing'); assert.equal(mails(on).length, 1, 'one email for the person with two claims on it'); const m = mails(on)[0];
  assert.equal(m.subject, `A group order you joined was cancelled (@${on.handle})`); assert.match(m.text, new RegExp(`^Hi @${on.handle},\\n\\nThe GOM has had to cancel the group order “The Big Order” — it couldn't go ahead\\.\\n\\nYour items on it:\\n\\n  • .*Album one.* — £10\\.00 credited to your account\\n  • .*Photocard two.* — you hadn't paid anything yet\\n\\nYou may want to buy them somewhere else\\. This will also show at the top of My orders for the next 30 days: `));
  const go2 = await order(), c = await item(go2, 'Single thing'); await claim(on, c); await cancel('item', c); await settle(); const m2 = mails(on)[1]; assert.equal(m2.subject, `An item you claimed was cancelled (@${on.handle})`); assert.match(m2.text, /The GOM has had to cancel the item “Single thing” — it couldn't go ahead\.\n\nYour item on it:\n\n  • .*Single thing.* — £10\.00 credited to your account\n\nYou may want to buy it somewhere else\./, 'their credit from the earlier cancellation had been applied to this claim, and it is returned');
  assert.equal((await api('PUT', '/api/my/notifications', { events: { orderCancelled: false } }, on.cookie)).status, 200); const go3 = await order(), d = await item(go3); await claim(on, d); await cancel('item', d); await settle(); assert.equal(mails(on).length, 2, 'switched off again: no more');
  const kinds = (await api('GET', '/api/my/notifications', undefined, def.cookie)).json.events; assert.deepEqual([kinds.find((e) => e.key === 'orderCancelled').enabled, kinds.find((e) => e.key === 'itemsReady').enabled], [false, true], 'only this kind is opt-in; the others stay on by default');
});

test('THE MIGRATION BACKFILL: cancellations from the last 30 days become notices (kind from whether the whole order was cancelled, money unknown), older ones and claims cancelled on their own do not', async () => {
  const sql = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations/048_cancel_notices.sql'), 'utf8'); const insert = sql.slice(sql.indexOf('INSERT INTO cancel_notices'), sql.lastIndexOf(';') + 1); assert.ok(insert.startsWith('INSERT INTO cancel_notices') && insert.includes('NOW(3) - INTERVAL 30 DAY'));
  const fresh = await order(), old = await order(), solo = await order(); const f1 = await item(fresh), o1 = await item(old), s1 = await item(solo), s2 = await item(solo); const p = await person(); const cf = await claim(p, f1), co = await claim(p, o1), cs = await claim(p, s1); await claim(p, s2);
  await cancel('order', fresh); await cancel('order', old); await cancel('item', s1); assert.equal((await api('POST', '/api/admin/claims/cancel', { claimIds: [(await app.q('SELECT id FROM claims WHERE item_id = ? AND joiner_id IN (SELECT id FROM joiners WHERE instagram_handle = ?)', [s2.id, p.handle]))[0].id] })).status, 200);
  await app.q('UPDATE items SET cancelled_at = NOW(3) - INTERVAL 40 DAY WHERE id = ?', [o1.id]); await app.q('UPDATE claims SET updated_at = NOW(3) - INTERVAL 40 DAY WHERE id = ?', [co]);
  await app.q('DELETE FROM cancel_notices'); await app.q(insert);                 // (the table is empty when the migration runs; the tests above have made notices of their own)
  const rows = await app.q('SELECT claim_id, kind, refunded, forfeited, order_title, item_title FROM cancel_notices WHERE claim_id IN (?) ORDER BY claim_id', [[cf, co, cs]]); assert.deepEqual(rows.map((r) => [r.claim_id, r.kind, r.refunded, r.forfeited]), [[cf, 'order', null, null], [cs, 'item', null, null]], 'the recent order and the recent item; not the one cancelled 40 days ago');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM cancel_notices WHERE item_id = ?', [s2.id]))[0].n, 0, 'a claim the GOM cancelled on its own is not a notice');
});
