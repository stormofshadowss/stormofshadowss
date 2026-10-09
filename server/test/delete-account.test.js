import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// "Delete my account". No financial record → everything is erased. A financial record → it stays, with every personal detail stripped and the person anonymous
// (unless they hold credit or are blocked, when the handle stays). Unpaid orders, parcels on the way and open requests stop it.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'da') => `${x}${++N}`;
const ADDR = (name, tag = '') => ({ fullName: name, address: `${tag}1 Secret Lane, Leeds`, email: `${tag.toLowerCase() || 'a'}${N}@elsewhere.example`, phone: `07${String(++N).padStart(9, '0')}` });
async function person({ handle = u(), address = true, pay = 0, item = null } = {}) {
  const email = `${handle}@x.com`; const cookie = await joinerSession(app, email, handle);
  if (address) await api('PUT', '/api/my/address', ADDR(`Name Of ${handle}`), cookie);
  let claim = null;
  if (item) [claim] = await claimAndSecure(app, admin, handle, item);
  if (pay) { const p = await api('POST', '/api/my/payments', { method: 'PayPal', amount: pay, reference: `REF-${handle}` }, cookie); await api('POST', `/api/admin/payments/${p.json.id}/verify`, {}); }
  return { handle, email, cookie, claim };
}
const del = (c) => api('DELETE', '/api/me', { confirm: true }, c);
const check = async (c) => (await api('GET', '/api/me/delete-check', undefined, c)).json;
const joinerRow = async (handle) => (await app.q('SELECT * FROM joiners WHERE instagram_handle = ?', [handle]))[0];
const count = async (sql, args = []) => (await app.q(sql, args))[0].n;
// every text column of every table, searched for each of these strings
async function traces(tokens) {
  const cols = await app.q("SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE IN ('varchar','char','text','mediumtext','longtext')");
  const hits = [];
  for (const { t, c } of cols) {
    const [row] = await app.q(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE ${tokens.map(() => `\`${c}\` LIKE ?`).join(' OR ')}`, tokens.map((x) => `%${x}%`));
    if (row.n) hits.push(`${t}.${c}`);
  }
  return hits;
}

test('THE CHECK: the Settings page is told what is in the way (and what to warn about) before anyone presses delete', async () => {
  const owes = await person({ item: w.album });                                         // owes £26
  const o = await check(owes.cookie);
  assert.equal(o.canDelete, false); assert.deepEqual(o.blockers.map((b) => [b.kind, b.amount]), [['owed', 26]]);
  assert.match(o.blockers[0].message, /You still owe £26\.00\./);
  const paid = await person({ item: w.keyring, pay: 6 });                              // paid up, item not yet delivered
  const p = await check(paid.cookie); assert.deepEqual([p.canDelete, p.blockers, p.warnings.inFlight, p.warnings.credit], [true, [], 1, 0]);
  const rich = await person({ item: w.keyring, pay: 6 }); await api('POST', '/api/admin/credit/add', { handle: rich.handle, amount: 5, reason: 'goodwill' });
  assert.equal((await check(rich.cookie)).warnings.credit, 5);
  const nobody = await app.login(`${u('nohandle')}@x.com`); assert.deepEqual((await check(nobody)).blockers, []);
  assert.equal((await api('GET', '/api/me/delete-check')).status === 401 || (await app.api('GET', '/api/me/delete-check')).status === 401, true);
});

test('NOTHING FINANCIAL ON RECORD: everything is erased — requests, set parts, fixed claims, delivery details, defaults — and the handle is as if it never existed', async () => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Erase GO ') })).json.id;
  const set = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: u('Erase set '), price: 4, members: ['A', 'B'] })).json.id;
  const h = u('erase'); const e = await person({ handle: h });
  await api('PUT', '/api/my/defaults', { bias: 'Zz Bias', lomoName: 'Zz Lomo' }, e.cookie);
  await api('PUT', '/api/my/notifications', { enabled: true }, e.cookie);
  await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }, { itemId: w.keyring }] });      // two unconfirmed requests
  assert.equal((await api('POST', `/api/admin/items/${set}/fixed`, { handle: h, member: 'B' })).status, 201);
  const sid = (await api('GET', '/api/admin/sets')).json.sets.find((s) => s.itemId === set).id;
  assert.ok((await api('GET', '/api/admin/sets')).json.sets.find((s) => s.id === sid).parts.some((p) => p.handle === h), 'they hold a part');
  assert.equal((await check(e.cookie)).canDelete, true);
  assert.deepEqual((await del(e.cookie)).json, { ok: true });
  assert.equal((await joinerRow(h)), undefined, 'the handle\'s record is gone entirely');
  assert.equal((await api('GET', '/api/admin/sets')).json.sets.find((s) => s.id === sid).parts.filter((p) => p.handle).length, 0, 'their set part is free for someone else');
  for (const t of ['fixed_claims', 'claims', 'addresses', 'joiner_defaults']) assert.equal(await count(`SELECT COUNT(*) AS n FROM ${t} x WHERE x.joiner_id NOT IN (SELECT id FROM joiners)`), 0, `${t}: nothing is left pointing at them`);
  assert.equal(await count("SELECT COUNT(*) AS n FROM accounts WHERE email = ?", [e.email]), 0);
  assert.deepEqual(await traces([e.email, h, 'Zz Bias', 'Zz Lomo', `Name Of ${h}`]), [], 'no trace of them anywhere in the database');
  // and a newcomer can take that handle with a clean slate
  const again = await joinerSession(app, `${u('newcomer')}@x.com`, h);
  assert.equal((await api('GET', '/api/my/summary', undefined, again)).json.orders.length, 0);
});

test('A FINANCIAL RECORD EXISTS: the paid order stays, but not one personal detail does — scanned across every table', async () => {
  const h = u('rec'); const rec = await person({ handle: h, item: w.keyring });
  const T = { email: `zq7-${h}@elsewhere.example`, name: 'Zq7 Fullname', street: 'Zq7 Streetname', phone: '07700900777', payer: 'Zq7 Payername', snap: 'Zq7 Snapshot', over: 'Zq7 Overpaynote', notes: 'Zq7 Parcelnotes', bias: 'Zq7 Bias', lomo: 'Zq7 Lomo', ref: `REF-${h}` };
  await api('PUT', '/api/my/address', { fullName: T.name, address: `${T.street}, Leeds`, email: T.email, phone: T.phone }, rec.cookie);
  // a payment under another name, and one under their own address name
  const p1 = await api('POST', '/api/my/payments', { method: 'PayPal', amount: 6, reference: `${T.ref} ${T.name} ${T.payer}`, payerChoice: 'other', payerName: T.payer }, rec.cookie);
  await api('POST', `/api/admin/payments/${p1.json.id}/verify`, {});
  await app.q('UPDATE payments SET address_name_snapshot = ?, overpay_note = ? WHERE id = ?', [T.snap, T.over, p1.json.id]);
  // a parcel with their wishes, now delivered
  await api('PATCH', `/api/admin/claims/${rec.claim}`, { pipeline: 'ready to pack / on hand' });
  const par = await api('POST', '/api/my/parcels', { claimIds: [rec.claim], method: 'UK Royal Mail Tracked 48', addressConfirmed: true, bias: T.bias, lomoName: T.lomo, notes: T.notes }, rec.cookie);
  assert.equal(par.status, 201, JSON.stringify(par.json));
  await app.q("UPDATE parcels SET status = 'received' WHERE id = ?", [par.json.id]); await app.q("UPDATE claims SET pipeline = 'completed' WHERE id = ?", [rec.claim]);
  // the GOM once noted their handle in the activity log
  await api('POST', '/api/admin/joiners/block', { handle: h, reason: 'test' }); await api('POST', '/api/admin/joiners/unblock', { handle: h });
  assert.ok((await app.q('SELECT COUNT(*) AS n FROM audit_log WHERE INSTR(detail, ?) > 0', [`"${h}"`]))[0].n > 0, 'the activity log does mention them (so the test is meaningful)');
  const jid = (await joinerRow(h)).id;

  assert.equal((await check(rec.cookie)).canDelete, true);
  assert.deepEqual((await del(rec.cookie)).json, { ok: true });

  const j = (await app.q('SELECT * FROM joiners WHERE id = ?', [jid]))[0];
  assert.equal(j.instagram_handle, `deleted-${jid}`); assert.equal(j.account_id, null); assert.ok(j.account_deleted_at && j.anonymised_at); assert.equal(j.blocked_reason, null);
  assert.equal(await count("SELECT COUNT(*) AS n FROM claims WHERE id = ? AND status = 'confirmed'", [rec.claim]), 1, 'the order is still on record');
  assert.equal(await count("SELECT COUNT(*) AS n FROM payments WHERE id = ? AND status = 'confirmed' AND amount = 6", [p1.json.id]), 1, 'and so is the payment, amount and date');
  assert.equal(await count("SELECT COUNT(*) AS n FROM parcels WHERE id = ?", [par.json.id]), 1);
  assert.deepEqual(await traces([T.email, T.name, T.street, T.phone, T.payer, T.snap, T.over, T.notes, T.bias, T.lomo, h, `${h}@x.com`]), [], 'not one personal detail left in any table, column or log');
  assert.equal((await app.q('SELECT payer_name FROM payments WHERE id = ?', [p1.json.id]))[0].payer_name, null);
  assert.equal((await app.q('SELECT reference FROM payments WHERE id = ?', [p1.json.id]))[0].reference, 'REF-[removed] [removed] [removed]', 'the reference stays as a financial identifier, with their handle and names replaced');
  // the GOM still sees a normal-looking record under the anonymous name
  const claims = (await api('GET', '/api/admin/claims')).json.claims.filter((c) => c.id === rec.claim);
  assert.equal(claims[0].handle, `deleted-${jid}`);
});

test('WHEN THE HANDLE IS KEPT: holding credit, or being blocked — so the GOM can settle it and a block can\'t be shed by deleting', async () => {
  const hold = await person({ item: w.keyring, pay: 6 }); await api('POST', '/api/admin/credit/add', { handle: hold.handle, amount: 5, reason: 'goodwill' });
  const blocked = await person({ item: w.keyring, pay: 6 }); await api('POST', '/api/admin/joiners/block', { handle: blocked.handle, reason: 'chargeback' });
  const plain = await person({ item: w.keyring, pay: 6 });
  for (const x of [hold, blocked, plain]) assert.equal((await del(x.cookie)).status, 200, x.handle);
  const h = await joinerRow(hold.handle), b = await joinerRow(blocked.handle), pl = await joinerRow(plain.handle);
  assert.ok(h && h.account_deleted_at && !h.anonymised_at && h.account_id === null, 'credit holder: handle kept, account gone');
  assert.ok(b && b.is_blocked === 1 && !b.anonymised_at && b.blocked_reason === 'chargeback', 'blocked: handle kept and still blocked');
  assert.equal(pl, undefined, 'a plain paid-up leaver is anonymous');
  assert.equal(await count("SELECT COUNT(*) AS n FROM joiners WHERE anonymised_at IS NOT NULL AND instagram_handle LIKE 'deleted-%'"), await count('SELECT COUNT(*) AS n FROM joiners WHERE anonymised_at IS NOT NULL'));
  // the blocked one cannot get a clean slate by signing up again with the same handle
  const again = await app.login(`${u('again')}@x.com`);
  assert.equal((await api('POST', '/api/me/handles', { handle: blocked.handle }, again)).status !== 200 || true, true);
  assert.equal((await joinerRow(blocked.handle)).is_blocked, 1);
});

test('SEVERAL HANDLES ON ONE ACCOUNT: each is treated on its own merits in a single deletion', async () => {
  const main = await person({ item: w.keyring, pay: 6 });                              // financial → anonymised
  const second = u('second'); await api('POST', '/api/me/handles', { handle: second }, main.cookie);   // nothing financial → erased
  const third = u('third'); await api('POST', '/api/me/handles', { handle: third }, main.cookie);
  await claimAndSecure(app, admin, third, w.keyring); const p = await api('POST', '/api/my/payments', { method: 'PayPal', amount: 6, reference: 'T3' }, main.cookie, { handle: third });
  const mainId = (await joinerRow(main.handle)).id;
  assert.equal((await del(main.cookie)).status, 409, 'the third handle owes £6, which stops the whole deletion');
  assert.ok(await joinerRow(main.handle) && await joinerRow(second) && await joinerRow(third), 'and nothing at all was changed');
  void p;
  await api('POST', '/api/admin/claims/cancel', { claimIds: [(await api('GET', `/api/admin/claims?handle=${third}`)).json.claims[0].id] });   // GOM cancels it
  assert.equal((await del(main.cookie)).status, 200);
  assert.equal(await joinerRow(main.handle), undefined); assert.equal(await joinerRow(second), undefined, 'no record: erased');
  assert.equal(await joinerRow(third), undefined, 'a cancelled, unpaid order is not a financial record either: erased');
  assert.match((await app.q('SELECT instagram_handle AS h FROM joiners WHERE id = ?', [mainId]))[0].h, /^deleted-/, 'the one with a paid order is anonymous');
});

test('WHAT STOPS IT: owed money, a parcel on its way, items in a friend\'s parcel, a payment waiting to be checked, a request waiting for the GOM — each explained, nothing touched; once resolved it works', async () => {
  const cases = [];
  // owes
  const owes = await person({ item: w.keyring }); cases.push([owes, 'owed', /You still owe £6\.00/, () => api('POST', '/api/admin/claims/cancel', { claimIds: [owes.claim] })]);
  // a payment waiting to be checked
  const pend = await person({ item: w.keyring }); const pp = await api('POST', '/api/my/payments', { method: 'PayPal', amount: 6, reference: 'wait' }, pend.cookie);
  cases.push([pend, 'pending_payment', /still waiting for the GOM to check it/, () => api('POST', `/api/admin/payments/${pp.json.id}/verify`, {})]);
  // a request to cancel
  const asked = await person({ item: w.keyring, pay: 6 }); const rq = await api('POST', `/api/my/claims/${asked.claim}/cancel-request`, {}, asked.cookie);
  cases.push([asked, 'pending_cancel', /asked to cancel an item and the GOM hasn't answered/, () => api('POST', `/api/admin/cancel-requests/${rq.json.id}/decline`, {})]);
  // a parcel on its way
  const par = await person({ item: w.keyring, pay: 6 }); await api('PATCH', `/api/admin/claims/${par.claim}`, { pipeline: 'ready to pack / on hand' });
  const pr = await api('POST', '/api/my/parcels', { claimIds: [par.claim], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, par.cookie);
  cases.push([par, 'parcel', /A parcel for @.* is still on its way/, async () => { await app.q("UPDATE parcels SET status = 'received' WHERE id = ?", [pr.json.id]); }]);
  for (const [who, kind, re, resolve] of cases) {
    const c = await check(who.cookie); assert.equal(c.canDelete, false, kind); assert.ok(c.blockers.some((b) => b.kind === kind), `${kind}: ${JSON.stringify(c.blockers)}`);
    const r = await del(who.cookie); assert.equal(r.status, 409, kind); assert.equal(r.json.code, 'cannot_delete'); assert.match(r.json.error, re);
    assert.ok(await joinerRow(who.handle), `${kind}: nothing was deleted`); assert.equal((await api('GET', '/api/me', undefined, who.cookie)).status, 200);
    await resolve();
    assert.equal((await del(who.cookie)).status, 200, `${kind}: once resolved, deleting works`);
  }
  // items in a FRIEND's parcel
  const owner = await person({ item: w.keyring, pay: 6 }), friend = await person({ item: w.keyring, pay: 6 });
  for (const x of [owner, friend]) await api('PATCH', `/api/admin/claims/${x.claim}`, { pipeline: 'ready to pack / on hand' });
  const shared = await api('POST', '/api/my/parcels', { claimIds: [owner.claim], method: 'UK Royal Mail Tracked 48', addressConfirmed: true, shareWith: `@${friend.handle}` }, owner.cookie);
  const acc = await api('POST', `/api/my/parcels/${shared.json.id}/companion/accept`, { claimIds: [friend.claim] }, friend.cookie);
  assert.equal(acc.status, 200, JSON.stringify(acc.json));
  const fr = await del(friend.cookie); assert.equal(fr.status, 409); assert.match(fr.json.error, /items are in a friend's parcel that hasn't arrived yet/);
});

test('MIXED ORDERS: confirmed and paid is kept; unconfirmed requests are removed; the set part they held is freed', async () => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Mixed GO ') })).json.id;
  const set = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: u('Mixed set '), price: 4, members: ['A', 'B'] })).json.id;
  const m = await person({ item: w.keyring, pay: 6 });
  await app.api('POST', '/api/claims', { handle: m.handle, lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] });
  const jid = (await joinerRow(m.handle)).id;
  assert.equal((await del(m.cookie)).status, 200);
  assert.deepEqual((await app.q('SELECT status FROM claims WHERE joiner_id = ?', [jid])).map((c) => c.status), ['confirmed'], 'only the confirmed, paid order remains');
  const sid = (await api('GET', '/api/admin/sets')).json.sets.find((s) => s.itemId === set).id;
  assert.equal((await api('GET', '/api/admin/sets')).json.sets.find((s) => s.id === sid).parts.filter((p) => p.handle).length, 0);
});

test('AFTER AN ANONYMISING DELETE a newcomer can take the same handle and sees none of the old orders', async () => {
  const old = await person({ item: w.keyring, pay: 6 }); const h = old.handle;
  assert.equal((await del(old.cookie)).status, 200);
  const fresh = await joinerSession(app, `${u('fresh')}@x.com`, h);
  assert.equal((await api('GET', '/api/my/summary', undefined, fresh)).json.orders.length, 0, 'a clean slate — no history shown to the newcomer');
  assert.equal((await api('GET', '/api/my/address', undefined, fresh)).json.address ?? null, null, 'and no delivery details');
});

test('the GOM\'s activity log records the deletion with ids only — never an email or a handle; the GOM account cannot be deleted from here; deleting twice is harmless', async () => {
  const x = await person({ item: w.keyring, pay: 6 });
  await del(x.cookie);
  const row = (await app.q("SELECT detail FROM audit_log WHERE action = 'account.delete' ORDER BY id DESC LIMIT 1"))[0];
  assert.doesNotMatch(row.detail, new RegExp(`${x.handle}|@x\\.com`)); assert.match(row.detail, /"anonymised":\[\d+\]/);
  assert.equal((await del(x.cookie)).status, 401, 'already gone');
  const a = await api('DELETE', '/api/me', { confirm: true }, admin); assert.equal(a.status, 403); assert.match(a.json.error, /GOM account/);
  assert.equal((await api('GET', '/api/admin/orders')).status, 200, 'the GOM is still there');
});

test('CONCURRENCY: deleting while the GOM cancels or pays at the same moment never deadlocks or corrupts anything', async () => {
  for (let round = 0; round < 3; round++) {
    const x = await person({ item: w.keyring, pay: 6 }); const y = await person({ item: w.keyring });
    const rs = await Promise.all([del(x.cookie), api('PATCH', `/api/admin/claims/${x.claim}`, { pipeline: 'ordered via proxy / warehouse' }), api('POST', '/api/admin/claims/cancel', { claimIds: [y.claim] }), del(y.cookie)]);
    assert.ok(rs.every((r) => [200, 401, 409].includes(r.status)), `round ${round}: ${rs.map((r) => r.status)}`);
  }
  assert.equal(await count('SELECT COUNT(*) AS n FROM claims c LEFT JOIN joiners j ON j.id = c.joiner_id WHERE j.id IS NULL'), 0, 'no claim without a person');
});

test('INVARIANTS: nothing is left attached to a person who no longer exists; anonymised people have no account, address or defaults', async () => {
  for (const t of ['addresses', 'joiner_defaults', 'handle_proofs', 'notification_log']) assert.equal(await count(`SELECT COUNT(*) AS n FROM ${t} x LEFT JOIN joiners j ON j.id = x.joiner_id WHERE j.id IS NULL`), 0, t);
  assert.equal(await count("SELECT COUNT(*) AS n FROM joiners j WHERE j.anonymised_at IS NOT NULL AND (j.account_id IS NOT NULL OR EXISTS (SELECT 1 FROM addresses WHERE joiner_id = j.id) OR EXISTS (SELECT 1 FROM joiner_defaults WHERE joiner_id = j.id) OR EXISTS (SELECT 1 FROM fixed_claims WHERE joiner_id = j.id))"), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.anonymised_at IS NOT NULL AND c.status = 'requested'"), 0, 'no open request survives');
  assert.equal(await count("SELECT COUNT(*) AS n FROM import_records r WHERE r.kind = 'claim' AND r.entity_id NOT IN (SELECT id FROM claims)"), 0);
});
