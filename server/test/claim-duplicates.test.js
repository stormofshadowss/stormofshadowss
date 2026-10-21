import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';

// "You already have 1 × OT8 photocards — claim another?" — people unsure their first claim went through submit it again. The public claim form now ASKS before adding a repeat of what the handle already has
// (the same item, or the same member / size / set part); saying yes sends allowDuplicates. The GOM's own "Add a claim" is not affected.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const u = (x = 'dp') => `${x}${++N}`;
const goOrder = async (title = u('Dup GO ')) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam' })).json.id;
const item = async (go, title = u('Thing '), extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title, ...extra })).json.id;
const claim = (handle, lines, extra = {}) => app.api('POST', '/api/claims', { handle, lines, ...extra });
const count = async (handle, itemId) => (await app.q("SELECT COUNT(*) AS n FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.item_id = ? AND c.status <> 'cancelled'", [handle, itemId]))[0].n;

test('CLAIMING WHAT YOU ALREADY HAVE ASKS FIRST: refused with the plain question and exactly what they have; nothing is added; "claim another" (allowDuplicates) adds it', async () => {
  const go = await goOrder(); const it = await item(go, 'OT8 photocards'); const h = u('ann'); assert.equal((await claim(h, [{ itemId: it }])).status, 201, 'the first claim just works');
  const again = await claim(h, [{ itemId: it }]); assert.deepEqual([again.status, again.json.code], [409, 'already_claimed']); assert.equal(again.json.error, 'You already have 1 × OT8 photocards — claim another?'); assert.deepEqual(again.json.have, [{ label: 'OT8 photocards', count: 1, itemId: it }], 'with which item it is, so the page can match its basket'); assert.equal(await count(h, it), 1, 'nothing was added');
  const yes = await claim(h, [{ itemId: it }], { allowDuplicates: true }); assert.equal(yes.status, 201, yes.text); assert.equal(await count(h, it), 2); const third = await claim(h, [{ itemId: it }]); assert.equal(third.json.error, 'You already have 2 × OT8 photocards — claim another?', 'and it keeps count');
});

test('IT IS ABOUT THIS PERSON AND THIS ITEM ONLY: another person, another item, or the same title in another order never triggers it; @ and capitals do not hide a repeat; cancelled claims do not count; requests and secured claims both do', async () => {
  const go = await goOrder(), go2 = await goOrder(); const it = await item(go, 'Same title'), other = await item(go, 'Another thing'), twin = await item(go2, 'Same title'); const [a, b] = [u('ann'), u('ben')];
  await claim(a, [{ itemId: it }]); assert.equal((await claim(b, [{ itemId: it }])).status, 201, 'someone else'); assert.equal((await claim(a, [{ itemId: other }])).status, 201, 'a different item'); assert.equal((await claim(a, [{ itemId: twin }])).status, 201, 'the same title in a different order is a different item');
  assert.equal((await claim(`@${a.toUpperCase()}`, [{ itemId: it }])).status, 409, '"@ANN" is still ann'); await app.q("UPDATE claims SET status = 'cancelled' WHERE item_id = ? AND joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)", [it, a]); assert.equal((await claim(a, [{ itemId: it }])).status, 201, 'a cancelled claim does not count');
  const c = u('cat'); await claim(c, [{ itemId: it }]); await api('POST', '/api/admin/claims/secure', { orderId: go }); assert.equal((await claim(c, [{ itemId: it }])).status, 409, 'a secured claim counts (the first was an unsecured request, now secured — either way)');
});

test('MEMBERS, SIZES AND SET PARTS ARE CHECKED ONE BY ONE: Han twice asks, Felix does not; the message names the member or size', async () => {
  const go = await goOrder(); const mem = await item(go, 'Per member', { type: 'independent', members: ['Han', 'Felix'] }), sz = await item(go, 'Per size', { type: 'size', variants: ['M', 'L'] }), set = await item(go, 'The set', { type: 'set', members: ['A', 'B'] }); const h = u('opt');
  await claim(h, [{ itemId: mem, member: 'Han' }, { itemId: sz, variant: 'M' }, { itemId: set, parts: [{ member: 'A', qty: 1 }] }]);
  assert.equal((await claim(h, [{ itemId: mem, member: 'Felix' }])).status, 201, 'a different member'); assert.equal((await claim(h, [{ itemId: sz, variant: 'L' }])).status, 201, 'a different size'); assert.equal((await claim(h, [{ itemId: set, parts: [{ member: 'B', qty: 1 }] }])).status, 201, 'a different part');
  const r1 = await claim(h, [{ itemId: mem, member: 'Han' }]); assert.equal(r1.json.error, 'You already have 1 × Per member — Han — claim another?'); const r2 = await claim(h, [{ itemId: sz, variant: 'M' }]); assert.deepEqual(r2.json.have, [{ label: 'Per size — M', count: 1, itemId: sz, option: 'M' }]);
  const r3 = await claim(h, [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }]); assert.deepEqual(r3.json.have, [{ label: 'The set — A', count: 1, itemId: set, option: 'A' }]);
});

test('A BASKET WITH SEVERAL LINES: only the repeated ones are named, the WHOLE request waits (nothing is added, not even the fine lines), and "claim another" adds everything', async () => {
  const go = await goOrder(); const have = await item(go, 'Already have'), fresh = await item(go, 'Brand new'); const h = u('multi'); await claim(h, [{ itemId: have }]);
  const r = await claim(h, [{ itemId: fresh }, { itemId: have, qty: 2 }]); assert.deepEqual([r.status, r.json.have], [409, [{ label: 'Already have', count: 1, itemId: have }]], 'only the repeat is named'); assert.equal(await count(h, fresh), 0, 'the fine line was not added either');
  assert.equal((await claim(h, [{ itemId: fresh }, { itemId: have, qty: 2 }], { allowDuplicates: true })).status, 201); assert.deepEqual([await count(h, fresh), await count(h, have)], [1, 3]);
});

test('SHOP (ON HAND) ITEMS TOO: claiming the same shop item again asks first, by its name; saying yes works', async () => {
  const sid = (await api('POST', '/api/admin/shop', { title: 'Shop sticker', price: 3, qty: 5 })).json.id; const h = u('shop'); assert.equal((await claim(h, [{ leftoverId: sid }])).status, 201);
  const r = await claim(h, [{ leftoverId: sid }]); assert.deepEqual([r.status, r.json.error, r.json.have[0].leftoverId], [409, 'You already have 1 × Shop sticker — claim another?', sid]); assert.equal((await claim(h, [{ leftoverId: sid }], { allowDuplicates: true })).status, 201);
});

test('A BRAND-NEW HANDLE IS NEVER ASKED (nothing to repeat), even for several copies in one go', async () => {
  const go = await goOrder(); const it = await item(go); const r = await claim(u('newbie'), [{ itemId: it, qty: 3 }]); assert.equal(r.status, 201, r.text);
});

test('TWENTY-FOUR IDENTICAL PRESSES AT ONCE (the double-tap, or two tabs): exactly ONE claim is made; the rest are told they already have it; nothing breaks — for a brand-new handle and for an existing one', async () => {
  const go = await goOrder(); const it = await item(go, 'Raced item');
  for (const handle of [u('fresh'), (async () => { const h = u('old'); await claim(h, [{ itemId: await item(go) }]); return h; })()]) {
    const h = await handle; const rs = await Promise.all(Array.from({ length: 24 }, () => claim(h, [{ itemId: it }])));
    assert.equal(rs.filter((r) => r.status === 201).length, 1, `${h}: exactly one went through`); assert.equal(rs.filter((r) => r.status === 409 && r.json.code === 'already_claimed').length, 23, `${h}: the others were told they already have it`); assert.equal(rs.filter((r) => r.status >= 500).length, 0, 'no crash'); assert.equal(await count(h, it), 1);
  }
});

test('THE GOM IS NOT ASKED: "Add a claim" can add a repeat (it is deliberate), and the other errors are unchanged (no extra fields on them)', async () => {
  const go = await goOrder(); const it = await item(go); const h = u('gom'); await claim(h, [{ itemId: it }]);
  const add = await api('POST', '/api/admin/claims/add', { handle: h, status: 'requested', lines: [{ itemId: it }] }); assert.equal(add.status, 201, add.text); assert.equal(await count(h, it), 2);
  await api('POST', '/api/admin/joiners/block', { handle: h, reason: 'x' }); const blocked = await claim(h, [{ itemId: it }]); assert.deepEqual([blocked.status, blocked.json.code, 'have' in blocked.json], [403, 'handle_blocked', false]);
});

test('"CLAIM ANOTHER" DOES NOT BYPASS THE OTHER RULES: a full purchase limit or a closed item still refuses; and allowDuplicates must be a true/false', async () => {
  const go = await goOrder(); const lim = await item(go, 'Limited', { purchaseLimit: 1 }); const h = u('lim'); assert.equal((await claim(h, [{ itemId: lim }])).status, 201);
  const r = await claim(h, [{ itemId: lim }], { allowDuplicates: true }); assert.deepEqual([r.status, r.json.code], [409, 'limit_reached'], 'allowing a repeat does not let anyone past the store limit');
  const closed = await item(go, 'Closed'); await claim(h, [{ itemId: closed }]); await api('PATCH', `/api/admin/items/${closed}`, { closed: true }); assert.equal((await claim(h, [{ itemId: closed }], { allowDuplicates: true })).json.code, 'item_closed');
  assert.equal((await claim(h, [{ itemId: lim }], { allowDuplicates: 'yes' })).status, 400, 'not a boolean');
});

test('THE CHECK HAPPENS ONLY AFTER THE ITEM IS LOCKED (deterministic, not luck): a claim that is waiting for the item sees the competitor that slipped in while it waited', async () => {
  const go = await goOrder(); const it = await item(go, 'Contended'); const h = u('wait'); await claim(h, [{ itemId: await item(go) }]);                    // an existing handle (so "first claim" rules don't apply)
  const conn = await app.pool.getConnection(); await conn.beginTransaction(); await conn.query('SELECT id FROM items WHERE id = ? FOR UPDATE', [it]);      // someone else is holding the item
  const waiting = claim(h, [{ itemId: it }]); await new Promise((r) => setTimeout(r, 400));                                                                // our claim is now waiting for the lock
  const [[j]] = await conn.query('SELECT id FROM joiners WHERE instagram_handle = ?', [h]);
  await conn.query("INSERT INTO claims (joiner_id, order_id, item_id, label, size_bucket, price_tbc) VALUES (?, ?, ?, 'Competitor', 'M', 0)", [j.id, go, it]); await conn.commit(); conn.release();   // …the competing first press lands and the lock is released
  const r = await waiting; assert.deepEqual([r.status, r.json.code], [409, 'already_claimed'], 'it checked AFTER getting the lock, so it saw the competitor'); assert.equal(await count(h, it), 1, 'and no second claim was made');
});
