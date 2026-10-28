import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { relabel } from '../src/lib/rename-members.js';

// FIX A SPELLING: renaming a member of a member item or a member set. The new name is carried through to every claim already made (and its label), the set slots and the fixed claims — in one step.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'rm') => `${x}${++N}`;
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Rename GO '), proxy: 'Sam' })).json.id;
const item = async (go, title, extra) => { const r = await api('POST', `/api/admin/orders/${go}/items`, { type: 'independent', price: 5, title, members: ['Han', 'Felix', 'Lee Know'], ...extra }); assert.equal(r.status, 201, r.text); return r.json.id; };
const roster = async (go, id) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === id).members;
const rename = (id, renames, extra = {}) => api('PATCH', `/api/admin/items/${id}`, { renameMembers: renames, ...extra });
const claimOf = (handle, id, member) => app.api('POST', '/api/claims', { handle, lines: [{ itemId: id, member }] });
const rows = (sql, p) => app.q(sql, p);

test('RENAMING A MEMBER OF A MEMBER ITEM: the roster keeps its order, ids and prices; claims already made on it follow (member and label); other members\' claims are untouched', async () => {
  const go = await goOrder(); const it = await item(go, 'Pop-up photocards'); const [han, felix] = await roster(go, it); const h1 = u('a'), h2 = u('b'); await claimOf(h1, it, 'Han'); await claimOf(h2, it, 'Felix');
  const r = await rename(it, [{ id: han.id, name: 'Hanni' }]); assert.equal(r.status, 200, r.text); const after = await roster(go, it); assert.deepEqual(after.map((m) => [m.id, m.name]), [[han.id, 'Hanni'], [felix.id, 'Felix'], [after[2].id, 'Lee Know']], 'same ids, same order, only the name changed'); assert.equal(after[0].price, han.price);
  const mine = await rows("SELECT c.member_name AS member, c.label FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE c.item_id = ? ORDER BY j.instagram_handle", [it]); assert.deepEqual(mine.map((c) => [c.member, c.label]), [['Hanni', 'Pop-up photocards — Hanni'], ['Felix', 'Pop-up photocards — Felix']]);
  assert.equal((await claimOf(u('c'), it, 'Hanni')).status, 201, 'the new name can be claimed'); const old = await claimOf(u('d'), it, 'Han'); assert.notEqual(old.status, 201, 'the old name no longer exists'); assert.equal((await rows('SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND member_name = ?', [it, 'Han']))[0].n, 0);
  const pub = (await app.api('GET', '/api/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === it); assert.deepEqual(pub.members.map((m) => m.name), ['Hanni', 'Felix', 'Lee Know'], 'joiners see the corrected name'); assert.ok(!('id' in pub.members[0]), 'and no internal ids');
});

test('A MEMBER SET: the set slots and the claim labels (with "(Set N)") follow the rename, and so do the set\'s fixed claimers', async () => {
  const go = await goOrder(); const set = await item(go, 'The set', { type: 'set', members: ['A', 'B', 'C'] }); const [a] = await roster(go, set); const h = u('setter'); await joinerSession(app, `${h}@x.com`, h);
  assert.equal((await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }, { member: 'B', qty: 1 }] }] })).status, 201);
  const fx = u('fix'); assert.equal((await api('POST', `/api/admin/items/${set}/fixed`, { handle: fx, member: 'A' })).status, 201, 'a fixed claimer on A');
  assert.equal((await rename(set, [{ id: a.id, name: 'Alpha' }])).status, 200);
  assert.deepEqual((await rows("SELECT ss.member_name AS m FROM set_slots ss JOIN item_sets s ON s.id = ss.set_id WHERE s.item_id = ? ORDER BY ss.member_name", [set])).map((x) => x.m), ['Alpha', 'Alpha', 'B'], 'slots (the claimer and the fixed claimer) follow');
  assert.deepEqual((await rows('SELECT label FROM claims WHERE item_id = ? ORDER BY label', [set])).map((x) => x.label), ['The set — Alpha (Set 1)', 'The set — Alpha (Set 2)', 'The set — B (Set 1)']);
  assert.deepEqual((await rows('SELECT member_name AS m FROM fixed_claims WHERE item_id = ?', [set])).map((x) => x.m), ['Alpha'], 'the fixed claim follows');
  assert.equal((await api('GET', `/api/admin/items/${set}/fixed`)).json.fixed[0].member, 'Alpha');
});

test('ONLY THE MEMBER PART OF A LABEL CHANGES: a title that itself contains " — Han", or a title edited since the claim was made, is left alone', async () => {
  assert.equal(relabel('Album — Han Edition — Han', 'Han', 'Hanni'), 'Album — Han Edition — Hanni'); assert.equal(relabel('Old title — Han (Set 2)', 'Han', 'Hanni'), 'Old title — Hanni (Set 2)'); assert.equal(relabel('No member here', 'Han', 'Hanni'), 'No member here'); assert.equal(relabel('Hand — Hannah', 'Han', 'X'), 'Hand — Hannah', 'a longer name that merely starts the same is not touched'); assert.equal(relabel('Hannah — Han (M)', 'Han', 'X'), 'Hannah — X (M)'); assert.equal(relabel('A — Han — Hannah — Han', 'Han', 'X'), 'A — Han — Hannah — X');
  const go = await goOrder(); const it = await item(go, 'Album — Han Edition'); const [han] = await roster(go, it); await claimOf(u('lbl'), it, 'Han'); await api('PATCH', `/api/admin/items/${it}`, { title: 'Album renamed later' });
  await rename(it, [{ id: han.id, name: 'Hanni' }]); assert.equal((await rows('SELECT label FROM claims WHERE item_id = ?', [it]))[0].label, 'Album — Han Edition — Hanni', 'the old title in the label stays; just the member changes');
});

test('IT CARRIES THROUGH EVERYTHING ELSE THAT KEYS OFF THE NAME: a purchase limit counted per member keeps counting; cancelled claims keep their history under the new name', async () => {
  const go = await goOrder(); const it = await item(go, 'Limited per member', { purchaseLimit: 1, limitScope: 'option' }); const [han] = await roster(go, it); await claimOf(u('lim'), it, 'Han'); const cancelled = u('can'); await claimOf(cancelled, it, 'Felix'); await app.q("UPDATE claims SET status = 'cancelled' WHERE item_id = ? AND member_name = 'Felix'", [it]);
  const [, felix] = await roster(go, it); await rename(it, [{ id: han.id, name: 'Hanni' }, { id: felix.id, name: 'Felixx' }]);
  const full = await claimOf(u('lim2'), it, 'Hanni'); assert.deepEqual([full.status, full.json.code], [409, 'limit_reached'], 'Hanni is still full at 1'); assert.equal((await rows("SELECT member_name AS m FROM claims WHERE item_id = ? AND status = 'cancelled'", [it]))[0].m, 'Felixx', 'a cancelled claim follows too');
});

test('A CAPITALISATION FIX WORKS (han → Han), and renaming several members in one go works; saving the same name is a no-op (nothing recorded)', async () => {
  const go = await goOrder(); const it = await item(go, 'Case item', { members: ['han', 'felix'] }); const [a, b] = await roster(go, it); await claimOf(u('cs'), it, 'han');
  assert.equal((await rename(it, [{ id: a.id, name: 'Han' }, { id: b.id, name: 'Felix' }])).status, 200); assert.deepEqual((await roster(go, it)).map((m) => m.name), ['Han', 'Felix']); assert.equal((await rows('SELECT member_name AS m, label FROM claims WHERE item_id = ?', [it]))[0].m, 'Han');
  const before = (await rows("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'item' AND entity_id = ? AND action = 'item.rename_member'", [it]))[0].n; assert.equal((await rename(it, [{ id: a.id, name: 'Han' }])).status, 200); assert.equal((await rows("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'item' AND entity_id = ? AND action = 'item.rename_member'", [it]))[0].n, before, 'same name: nothing changes, nothing recorded');
});

test('IT IS REFUSED, WITH A PLAIN REASON, FOR: a blank name, another member\'s name (any capitals), two members given one name, a swap, an unknown member, a member of a different item, an item with no members — and nothing is changed (all or nothing)', async () => {
  const go = await goOrder(); const it = await item(go, 'Strict item'); const other = await item(go, 'Other item'); const [han, felix, lee] = await roster(go, it); const [foreign] = await roster(go, other);
  const bad = async (renames, code, re) => { const r = await rename(it, renames); assert.equal(r.status === 400 || r.status === 409, true, `${r.status} ${r.text}`); if (code) assert.equal(r.json.code, code); if (re) assert.match(r.json.error, re); return r; };
  await bad([{ id: han.id, name: '   ' }], 'member_name_blank', /can't be blank/); await bad([{ id: han.id, name: 'felix' }], 'member_name_taken', /Another member is already called “Felix”/); await bad([{ id: han.id, name: 'Same' }, { id: lee.id, name: 'SAME' }], 'member_name_taken', /Two members can't both be called/);
  await bad([{ id: han.id, name: 'Felix' }, { id: felix.id, name: 'Han' }], 'member_name_taken', /already called/); await bad([{ id: 99999999, name: 'Nobody' }], 'no_such_member', /isn't on this item/); await bad([{ id: foreign.id, name: 'Hijack' }], 'no_such_member');
  await bad([{ id: han.id, name: 'Fine name' }, { id: lee.id, name: 'Han' }], 'member_name_taken'); assert.deepEqual((await roster(go, it)).map((m) => m.name), ['Han', 'Felix', 'Lee Know'], 'the valid rename in that request was NOT applied either');
  const plain = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title: 'Plain' })).json.id; const r = await rename(plain, [{ id: han.id, name: 'X' }]); assert.deepEqual([r.status, r.json.code], [400, 'no_members']); assert.equal((await rename(it, [{ id: han.id, name: 'x'.repeat(81) }])).status, 400, 'too long');
});

test('GOM ONLY; it is recorded; and it can be combined with other edits in the same save', async () => {
  const go = await goOrder(); const it = await item(go, 'Combined'); const [han] = await roster(go, it); const j = await joinerSession(app, `${u('jj')}@x.com`, u('jj'));
  assert.equal((await rename(it, [{ id: han.id, name: 'Nope' }], {}).then(() => api('PATCH', `/api/admin/items/${it}`, { renameMembers: [{ id: han.id, name: 'Nope' }] }, j))).status, 403); assert.equal((await app.api('PATCH', `/api/admin/items/${it}`, { renameMembers: [{ id: han.id, name: 'Nope' }] })).status, 401);
  await claimOf(u('cb'), it, 'Nope'); const r = await rename(it, [{ id: han.id, name: 'Hanni' }], { title: 'Combined, retitled', price: 7 }); assert.equal(r.status, 200, r.text); const row = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === it); assert.deepEqual([row.title, row.price, row.members[0].name], ['Combined, retitled', 7, 'Hanni']);
  const log = await rows("SELECT detail FROM audit_log WHERE entity = 'item' AND entity_id = ? AND action = 'item.rename_member' ORDER BY id", [it]); assert.deepEqual(log.map((l) => (typeof l.detail === 'string' ? JSON.parse(l.detail) : l.detail)), [{ from: 'Han', to: 'Nope', claims: 0 }, { from: 'Nope', to: 'Hanni', claims: 1 }]);
});
