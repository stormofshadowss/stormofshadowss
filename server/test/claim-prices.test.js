import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';

// CHANGE THE PRICE OF SEVERAL CLAIMS AT ONCE: "set a new price" or "add / take off an amount", for the selected claims whatever stage they're at; the item cost only; anything already paid beyond the new cost comes back as credit;
// the preview runs the real thing and rolls it back; the people affected are emailed (those with emails on).
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const fresh = (x = 'cp') => `${x}${++N}`;
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: fresh('Price GO '), proxy: 'Sam' })).json.id;
const item = async (go, price = 10, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: fresh('Album '), price, ...extra })).json.id;
async function person({ email = false } = {}) { const h = fresh('pp'), e = `${h}@x.com`; const cookie = await joinerSession(app, e, h); if (email) await app.api('PUT', '/api/my/notifications', { enabled: true }, cookie); return { h, e, cookie }; }
const claim = async (p, itemId) => { const [id] = await claimAndSecure(app, admin, p.h, itemId); return id; };
const line = async (id, cat = 'initials') => (await app.q('SELECT cost, paid FROM claim_costs WHERE claim_id = ? AND category = ?', [id, cat])).map((r) => [Number(r.cost), Number(r.paid)])[0];
const credit = async (h) => Number((await app.q('SELECT COALESCE(SUM(l.balance_effect), 0) AS c FROM credit_ledger l JOIN joiners j ON j.id = l.joiner_id WHERE j.instagram_handle = ?', [h]))[0].c);
const price = (claimIds, mode, amount, extra = {}) => api('POST', '/api/admin/claims/price', { claimIds, mode, amount, ...extra });
const mails = (email) => app.mailer.outbox.filter((m) => m.to === email && /price of your order/i.test(m.subject));

test('SET A NEW PRICE: every selected claim\'s item cost becomes it, whatever stage it is at; claims already at that price are left; the item\'s own price (for new claims) is NOT changed', async () => {
  const go = await goOrder(); const it = await item(go, 10); const ps = [await person(), await person(), await person()]; const ids = []; for (const p of ps) ids.push(await claim(p, it));
  await api('PATCH', `/api/admin/claims/${ids[1]}`, { pipeline: 'ordered via proxy / warehouse' }); await api('PATCH', `/api/admin/claims/${ids[2]}`, { costs: { initials: { cost: 12 } } });
  const r = await price(ids, 'set', 12, { notify: false }); assert.equal(r.status, 200, r.text); assert.deepEqual([r.json.changes.length, r.json.unchanged, r.json.total, r.json.people], [2, 1, 4, 2]);
  assert.deepEqual((await Promise.all(ids.map((id) => line(id)))).map((l) => l[0]), [12, 12, 12], 'the claim already ordered was changed too'); assert.equal(Number((await app.q('SELECT price FROM items WHERE id = ?', [it]))[0].price), 10, 'new claims still use the item\'s price');
  assert.ok((await app.q("SELECT 1 FROM audit_log WHERE action = 'claims.price' ORDER BY id DESC LIMIT 1")).length === 1, 'recorded');
});

test('ADD OR TAKE OFF AN AMOUNT: each claim moves by that much from where it is now (different starting prices stay different)', async () => {
  const go = await goOrder(); const a = await item(go, 10), b = await item(go, 20); const [p, q] = [await person(), await person()]; const [ia, ib] = [await claim(p, a), await claim(q, b)];
  assert.equal((await price([ia, ib], 'adjust', 0.75, { notify: false })).status, 200); assert.deepEqual([(await line(ia))[0], (await line(ib))[0]], [10.75, 20.75]);
  const down = await price([ia, ib], 'adjust', -1.25, { notify: false }); assert.equal(down.status, 200); assert.deepEqual([(await line(ia))[0], (await line(ib))[0]], [9.5, 19.5], 'taking off works too'); assert.deepEqual([down.json.total, down.json.changes[0].diff], [-2.5, -1.25]);
  const none = await price([ia], 'adjust', 0, { notify: false }); assert.deepEqual([none.json.changes.length, none.json.unchanged], [0, 1], 'adding nothing changes nothing');
});

test('PAID ALREADY: someone who paid more than the new cost gets the difference back as credit (and it is never shown as paid beyond the cost); someone who paid less simply owes more; fees are untouched', async () => {
  const go = await goOrder(); const it = await item(go, 10); const [p, q] = [await person(), await person()]; const [ip, iq] = [await claim(p, it), await claim(q, it)];
  await api('PATCH', `/api/admin/claims/${ip}`, { costs: { initials: { paid: 10 } } }); await api('PATCH', `/api/admin/claims/${iq}`, { costs: { initials: { paid: 4 }, ems: { cost: 5, dueDate: '2099-01-01' } } });
  const before = await credit(p.h); const down = await price([ip, iq], 'set', 6, { notify: false }); assert.equal(down.status, 200, down.text); assert.deepEqual(down.json.changes.map((c) => [c.from, c.to, c.paid, c.creditBack]), [[10, 6, 10, 4], [10, 6, 4, 0]]);
  assert.deepEqual([await line(ip), await line(iq)], [[6, 6], [6, 4]], 'p is paid up (not "over"); q still owes 2'); assert.equal(Number(((await credit(p.h)) - before).toFixed(2)), 4, 'the £4 p had paid beyond the new cost is credit'); assert.deepEqual(await line(iq, 'ems'), [5, 0], 'the EMS fee was not touched');
  const up = await price([ip], 'set', 8, { notify: false }); assert.equal(up.status, 200); assert.equal((await line(ip))[0], 8); assert.ok((await line(ip))[1] >= 6, 'p now owes the extra (or the credit already covered it)');
});

test('THE PREVIEW CHANGES NOTHING AND MATCHES WHAT THEN HAPPENS (no email, nothing recorded)', async () => {
  const go = await goOrder(); const it = await item(go, 10); const [p, q] = [await person({ email: true }), await person()]; const [ip, iq] = [await claim(p, it), await claim(q, it)]; await api('PATCH', `/api/admin/claims/${ip}`, { costs: { initials: { paid: 10 } } });
  const sent = app.mailer.outbox.length, auditN = (await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'claims.price'"))[0].n, cr = await credit(p.h);
  const pv = await price([ip, iq], 'set', 7.5, { preview: true }); assert.equal(pv.status, 200, pv.text); assert.deepEqual([(await line(ip)), (await line(iq))], [[10, 10], [10, 0]], 'nothing changed'); assert.equal(await credit(p.h), cr); await app.notifier.idle(); assert.equal(app.mailer.outbox.length, sent, 'no email'); assert.equal((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'claims.price'"))[0].n, auditN);
  const real = await price([ip, iq], 'set', 7.5, { notify: false }); assert.deepEqual(real.json.changes, pv.json.changes, 'what happened is exactly what the preview said'); assert.deepEqual([real.json.total, pv.json.total], [-5, -5]);
});

test('IT IS ALL OR NOTHING AND CHECKED: a cancelled claim, a result below £0, a TBC price when adding, an unknown claim, bad amounts — nothing is changed; GOM only', async () => {
  const go = await goOrder(); const it = await item(go, 10), tbc = await item(go, undefined, { priceTbc: true, price: undefined }); const [p, q] = [await person(), await person()]; const [ip, iq] = [await claim(p, it), await claim(q, it)];
  const tb = (await app.api('POST', '/api/claims', { handle: fresh('tb'), lines: [{ itemId: tbc }] })).status; assert.equal(tb, 201); const [tbcId] = (await app.q("SELECT c.id FROM claims c WHERE c.item_id = ?", [tbc])).map((r) => r.id);
  const expectNo = async (body, status, code, label) => { const r = await price(body.ids, body.mode, body.amount, { notify: false }); assert.deepEqual([r.status, code ? r.json.code : undefined], [status, code], `${label}: ${r.text}`); assert.deepEqual([await line(ip), await line(iq)], [[10, 0], [10, 0]], `${label}: nothing changed`); };
  await expectNo({ ids: [ip, iq], mode: 'adjust', amount: -11 }, 400, 'negative_price', 'below £0'); await expectNo({ ids: [ip, tbcId], mode: 'adjust', amount: 1 }, 400, 'tbc_claim', 'a TBC price when adding'); await expectNo({ ids: [ip, 99999999], mode: 'set', amount: 5 }, 404, undefined, 'unknown claim');
  await app.q("UPDATE claims SET status = 'cancelled' WHERE id = ?", [iq]); const c = await price([ip, iq], 'set', 5, { notify: false }); assert.deepEqual([c.status, c.json.code], [409, 'claim_cancelled']); assert.equal((await line(ip))[0], 10);
  assert.equal((await price([ip], 'set', -1)).status, 400); assert.equal((await price([ip], 'set', 1.555)).status, 400); assert.equal((await price([], 'set', 1)).status, 400); assert.equal((await price([ip], 'multiply', 2)).status, 400);
  const j = await joinerSession(app, `${fresh('jj')}@x.com`, fresh('jj')); assert.equal((await api('POST', '/api/admin/claims/price', { claimIds: [ip], mode: 'set', amount: 5 }, j)).status, 403); assert.equal((await app.api('POST', '/api/admin/claims/price', { claimIds: [ip], mode: 'set', amount: 5 })).status, 401);
  const ok = await price([tbcId], 'set', 9, { notify: false }); assert.equal(ok.status, 200, ok.text); assert.deepEqual([(await line(tbcId))[0], (await app.q('SELECT price_tbc AS t FROM claims WHERE id = ?', [tbcId]))[0].t], [9, 0], 'a TBC claim given a price is no longer TBC');
});

test('THE PEOPLE AFFECTED ARE EMAILED (once each, listing every claim, what they were and are, and what they now owe), if they have emails on and haven\'t switched this kind off; "don\'t email" and the preview send none', async () => {
  const go = await goOrder(); const it = await item(go, 10), it2 = await item(go, 4); const [on, off, kind, quiet] = [await person({ email: true }), await person(), await person({ email: true }), await person({ email: true })];
  await app.api('PUT', '/api/my/notifications', { events: { priceChanged: false } }, kind.cookie); const a1 = await claim(on, it), a2 = await claim(on, it2), b = await claim(off, it), c = await claim(kind, it), d = await claim(quiet, it);
  await price([a1, a2, b, c], 'adjust', 0.75); await app.notifier.idle(); const m = mails(on.e); assert.equal(m.length, 1, 'once, not once per claim'); assert.match(m[0].subject, /^The price of your order has changed \(@/); assert.match(m[0].text, /some of your claims have changed/); assert.match(m[0].text, /• Album .* — £10\.00 → £10\.75 \(\+£0\.75\)/); assert.match(m[0].text, /• Album .* — £4\.00 → £4\.75 \(\+£0\.75\)/); assert.match(m[0].text, /You now owe £15\.50 in total/);
  assert.equal(mails(off.e).length, 0, 'emails off'); assert.equal(mails(kind.e).length, 0, 'this kind switched off'); await price([d], 'adjust', 1, { notify: false }); await app.notifier.idle(); assert.equal(mails(quiet.e).length, 0, '"don\'t email" sends none');
  await price([a1], 'set', 9); await app.notifier.idle(); const last = mails(on.e).at(-1); assert.match(last.text, /one of your claims has changed/); assert.match(last.text, /£10\.75 → £9\.00 \(−£1\.75\)/, 'a drop is worded as a drop');
});

test('A PERSON WITH SEVERAL HANDLES: each handle\'s claims are changed and told about under that handle', async () => {
  const go = await goOrder(); const it = await item(go, 10); const p = await person({ email: true }); const sib = fresh('sib'); assert.equal((await app.api('POST', '/api/me/handles', { handle: sib }, p.cookie)).status, 200); const a = await claim(p, it), b = await claimAndSecure(app, admin, sib, it);
  assert.equal((await price([a, ...b], 'adjust', 2)).status, 200); await app.notifier.idle(); const m = mails(p.e); assert.equal(m.length, 2, 'one email per handle'); assert.ok(m.some((x) => x.subject.includes(`(@${p.h})`)) && m.some((x) => x.subject.includes(`(@${sib})`)));
});

test('CREDIT THEY ALREADY HAD MEETS THE EXTRA THEY NOW OWE, as it does for any new cost (so a price rise doesn\'t leave someone owing while holding credit)', async () => {
  const go = await goOrder(); const it = await item(go, 10); const p = await person(); const id = await claim(p, it); await api('PATCH', `/api/admin/claims/${id}`, { costs: { initials: { paid: 10 } } });
  const jid = (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [p.h]))[0].id; await app.q("INSERT INTO credit_ledger (joiner_id, kind, amount, balance_effect, reason, source) VALUES (?, 'credit', 4, 4, 'test credit', 'test')", [jid]); const before = await credit(p.h);
  assert.equal((await price([id], 'adjust', 3, { notify: false })).status, 200); assert.deepEqual(await line(id), [13, 13], 'the credit paid the extra £3'); assert.equal(Number(((await credit(p.h)) - before).toFixed(2)), -3, 'and £3 of the credit was used');
});
