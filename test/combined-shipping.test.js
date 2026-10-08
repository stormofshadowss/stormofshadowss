import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure, tickParcel } from './helpers.js';

const READY = 'ready to pack / on hand';
let app, admin, w, N = 0, ITEM;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const go = (await app.api('POST', '/api/admin/orders', { groupId: w.group, title: 'Shared shipping GO' }, admin)).json.id;
  const mk = async (title, price) => (await app.api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price }, admin)).json.id;
  ITEM = { a: await mk('Album', 20), b: await mk('Badge', 5), c: await mk('Card', 3) };
});
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (p = 'sh') => `${p}${++N}`;
const settle = () => app.notifier.idle();
// someone signed in, with a delivery address and some items ready to ship
async function person(handle = u(), nItems = 1, { name = 'Pat Kay' } = {}) {
  const cookie = await joinerSession(app, `${handle}@x.com`, handle);
  await app.api('PUT', '/api/my/address', { fullName: name, address: `1 ${handle} Road, Leeds`, email: `${handle}@x.com`, phone: '0700' }, cookie);
  const ids = [];
  const items = [ITEM.a, ITEM.b, ITEM.c, ITEM.a, ITEM.b];
  for (let i = 0; i < nItems; i++) { const [id] = await claimAndSecure(app, admin, handle, items[i]); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); ids.push(id); }
  return { handle, cookie, ids };
}
const request = (p, body = {}) => app.api('POST', '/api/my/parcels', { claimIds: p.ids, method: 'UK Royal Mail Tracked 48', addressConfirmed: true, ...body }, p.cookie);
const mine = async (p) => (await app.api('GET', '/api/my/parcels', undefined, p.cookie)).json;
const queue = async (status = 'requested') => (await api('GET', `/api/admin/packing?status=${status}`)).json.parcels;
const parcelOf = async (id) => (await queue()).find((x) => x.id === id);
const fees = (id, body) => api('POST', `/api/admin/parcels/${id}/fees`, body);
const accept = (p, parcelId, body = {}) => app.api('POST', `/api/my/parcels/${parcelId}/companion/accept`, { claimIds: p.ids, ...body }, p.cookie);
const costs = async (claimIds, cat) => (await app.q(`SELECT claim_id, cost FROM claim_costs WHERE category = ? AND claim_id IN (?) ORDER BY claim_id`, [cat, claimIds])).map((r) => Number(r.cost));
const sum = (a) => Math.round(a.reduce((s, x) => s + x, 0) * 100) / 100;
// two people with a shared parcel, set up the joiner way
async function shared(nA = 1, nB = 1, reqBody = {}, accBody = {}) {
  const [a, b] = [await person(u('rcpt'), nA), await person(u('frnd'), nB)];
  const r = await request(a, { shareWith: `@${b.handle}`, ...reqBody });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const ac = await accept(b, r.json.id, accBody); assert.equal(ac.status, 200, JSON.stringify(ac.json));
  return { a, b, id: r.json.id };
}

test('FEES ARE SPLIT EQUALLY PER PERSON: the postage and packaging are halved between the two friends, then shared across each person\'s own items', async () => {
  const { a, b, id } = await shared(3, 1);
  assert.equal((await fees(id, { doms: 10, packaging: 2 })).status, 200);
  const [aDoms, bDoms, aPack, bPack] = [await costs(a.ids, 'doms'), await costs(b.ids, 'doms'), await costs(a.ids, 'packaging'), await costs(b.ids, 'packaging')];
  assert.deepEqual([sum(aDoms), sum(bDoms), sum(aPack), sum(bPack)], [5, 5, 1, 1], 'five pounds of postage each, even though one has three items and the other one');
  assert.deepEqual(aDoms, [1.66, 1.67, 1.67], "a's half is shared over a's three items (the spare penny goes to the later items, as everywhere on the site)");
  assert.deepEqual(bDoms, [5]);
  const owed = (await api('GET', '/api/admin/claims')).json.people;
  assert.equal(owed[a.handle].owed - 20 - 5 - 3, 6, "a owes their items plus £6 (a's half of postage and packaging)");
  assert.equal(sum([...aDoms, ...bDoms]), 10, 'all the postage is accounted for');
  const p = await parcelOf(id);
  assert.deepEqual([p.domsTotal, p.packagingTotal, p.feesSet], [10, 2, true]);
});

test('fees to the penny: an odd total never loses or gains a penny, and correcting the figure only moves each item by the difference', async () => {
  const { a, b, id } = await shared(2, 1);
  await fees(id, { doms: 10.01 });
  const all = [...await costs(a.ids, 'doms'), ...await costs(b.ids, 'doms')];
  assert.equal(sum(all), 10.01);
  assert.ok(Math.abs(sum(await costs(a.ids, 'doms')) - sum(await costs(b.ids, 'doms'))) <= 0.01, 'the two people differ by at most a penny');
  await fees(id, { doms: 6 });
  assert.deepEqual([sum(await costs(a.ids, 'doms')), sum(await costs(b.ids, 'doms'))], [3, 3]);
  await fees(id, { doms: 7 });
  assert.equal(sum([...await costs(a.ids, 'doms'), ...await costs(b.ids, 'doms')]), 7);
});

test('the friend\'s share, once paid, is refunded as credit if the figure comes down — to THEM, not the recipient', async () => {
  const { a, b, id } = await shared(1, 1);
  await fees(id, { doms: 10 });                                                       // £5 each
  await api('POST', '/api/admin/credit/add', { handle: b.handle, amount: 100, reason: 'to pay with' });   // b's credit is spent on what b owes, including the £5
  const before = (await app.api('GET', '/api/my/summary', undefined, b.cookie)).json.credit;
  await fees(id, { doms: 4 });                                                         // now £2 each: b is £3 over
  const after = (await app.api('GET', '/api/my/summary', undefined, b.cookie)).json.credit;
  assert.equal(Math.round((after - before) * 100) / 100, 3, 'b gets their £3 back');
  assert.equal((await app.api('GET', '/api/my/summary', undefined, a.cookie)).json.credit, 0, 'the recipient is not credited for it');
});

test('asking for shipping and naming a friend: the parcel is requested, the friend is invited, and nothing is packed until they answer', async () => {
  const [a, b] = [await person(u('rcpt')), await person(u('frnd'))];
  const r = await request(a, { shareWith: `@${b.handle.toUpperCase()}` });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.companions, [{ handle: b.handle, status: 'invited' }]);
  const mineA = (await mine(a)).parcels.find((p) => p.id === r.json.id);
  assert.deepEqual([mineA.role, mineA.shared.people.map((x) => [x.handle, x.status]), mineA.canConfirm], ['recipient', [[b.handle, 'invited']], true]);
  const inv = (await mine(b)).invites;
  assert.deepEqual(inv.map((i) => [i.parcelId, i.fromHandle, i.forHandle]), [[r.json.id, a.handle, b.handle]]);
  assert.equal((await mine(b)).parcels.length, 0, 'it is not their parcel until they accept');
  const q = await parcelOf(r.json.id);
  assert.deepEqual([q.companions[0].handle, q.companions[0].status, q.companions[0].how], [b.handle, 'invited', 'joiner']);
  await tickParcel(app, admin, r.json.id);
  const pack = await api('POST', `/api/admin/parcels/${r.json.id}/packed`);
  assert.equal(pack.status, 409); assert.equal(pack.json.code, 'companion_pending'); assert.match(pack.json.error, new RegExp(`@${b.handle} hasn't answered`));
});

test('naming a friend who cannot be asked fails the WHOLE request — no parcel is left behind', async () => {
  const a = await person(u('rcpt')); const before = (await app.q('SELECT COUNT(*) AS n FROM parcels'))[0].n;
  const unsigned = u('unsigned'); await app.q('INSERT INTO joiners (instagram_handle) VALUES (?)', [unsigned]);
  const blocked = (await person(u('blk'))).handle; await api('POST', '/api/admin/joiners/block', { handle: blocked, reason: 't' });
  const cases = [[`@${u('nobody')}`, 'friend_unknown'], [`@${unsigned}`, 'friend_not_signed_in'], [`@${a.handle}`, 'friend_is_you'], [`@${blocked}`, 'friend_blocked'], ['bad!handle', 'bad_handle']];
  for (const [shareWith, code] of cases) { const r = await request(a, { shareWith }); assert.deepEqual([r.status, r.json.code], [400, code], shareWith); }
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM parcels'))[0].n, before, 'nothing was created');
  assert.equal((await mine(a)).parcels.length, 0);
  assert.equal((await request(a)).status, 201, 'and an ordinary request still works');
});

test('the friend accepts: their own items go in, with their own bias, Lomo name and notes; both people see the shared parcel', async () => {
  const [a, b] = [await person(u('rcpt'), 1), await person(u('frnd'), 2, { name: 'Sam Lee' })];
  const r = await request(a, { shareWith: b.handle, bias: 'Han', notes: 'a-notes' });
  const ac = await accept(b, r.json.id, { bias: 'Felix', notes: 'b-notes', lomoName: 'Sammy' });
  assert.equal(ac.status, 200);
  const q = await parcelOf(r.json.id);
  assert.deepEqual(q.items.map((i) => [i.owner]).flat().sort(), [a.handle, b.handle, b.handle].sort());
  const c0 = q.companions[0];
  assert.deepEqual([q.bias, q.notes, c0.status, c0.bias, c0.notes, c0.lomoName, c0.lomoSource], ['Han', 'a-notes', 'accepted', 'Felix', 'b-notes', 'Sammy', 'custom']);
  const bView = (await mine(b)).parcels[0];
  assert.deepEqual([bView.role, bView.shared.people[0].handle, bView.canConfirm, bView.lomoName, bView.items.filter((i) => i.mine).length, bView.items.length], ['friend', a.handle, false, 'Sammy', 2, 3]);
  const aView = (await mine(a)).parcels[0];
  assert.deepEqual([aView.role, aView.shared.people[0].status, aView.items.length], ['recipient', 'accepted', 3]);
  assert.equal((await mine(b)).invites.length, 0, 'the invitation is gone once answered');
  const dflt = await person(u('d'), 1, { name: 'Dee Dee' }); const r2 = await request(await person(u('r2')), { shareWith: dflt.handle });
  await accept(dflt, r2.json.id);
  assert.deepEqual([(await parcelOf(r2.json.id)).companions[0].lomoName, (await parcelOf(r2.json.id)).companions[0].lomoSource], ['Dee Dee', 'delivery'], 'with no name typed, their own delivery name is used');
});

test('only items that are really theirs, ready, and not already in a parcel can be put in — and a friend cannot answer twice or for someone else', async () => {
  const [a, b, c] = [await person(u('rcpt')), await person(u('frnd')), await person(u('other'))];
  const r = await request(a, { shareWith: b.handle });
  const notMine = await accept({ ...b, ids: c.ids }, r.json.id);
  assert.equal(notMine.status, 403);
  const [late] = await claimAndSecure(app, admin, b.handle, ITEM.b);                      // confirmed, but not ready to pack yet
  assert.deepEqual([(await accept({ ...b, ids: [late] }, r.json.id)).status, (await accept({ ...b, ids: [late] }, r.json.id)).json.code], [400, 'not_ready']);
  assert.equal((await accept({ ...b, ids: [] }, r.json.id)).status, 400, 'at least one item');
  assert.equal((await accept(c, r.json.id)).status, 404, 'a stranger was never invited');
  assert.equal((await accept(a, r.json.id)).status, 404, 'the recipient cannot accept their own invitation');
  assert.equal((await accept(b, r.json.id)).status, 200);
  const again = await accept(b, r.json.id); assert.equal(again.status, 409); assert.equal(again.json.code, 'bad_state');
  const busy = await person(u('busy')); await request(busy);                                // already in another parcel
  const r2 = await request(await person(u('r2')), { shareWith: busy.handle });
  assert.equal((await accept(busy, r2.json.id)).json.code, 'already_requested');
});

test('declining: the parcel carries on alone; the recipient can invite someone else, or take the invitation back', async () => {
  const [a, b, c] = [await person(u('rcpt')), await person(u('frnd')), await person(u('frnd2'))];
  const r = await request(a, { shareWith: b.handle });
  assert.equal((await app.api('POST', `/api/my/parcels/${r.json.id}/companion/decline`, {}, b.cookie)).status, 200);
  assert.equal((await parcelOf(r.json.id)).companions[0].status, 'declined');
  assert.equal((await mine(b)).invites.length, 0);
  assert.equal((await app.api('POST', `/api/my/parcels/${r.json.id}/companion/decline`, {}, b.cookie)).json.code, 'bad_state');
  await tickParcel(app, admin, r.json.id);
  assert.equal((await api('POST', `/api/admin/parcels/${r.json.id}/packed`)).status, 200, 'a declined invitation no longer blocks packing');
  const r2 = await request(await person(u('r2')), { shareWith: b.handle });
  assert.equal((await app.api('POST', `/api/my/parcels/${r2.json.id}/companion/decline`, {}, b.cookie)).status, 200);
  const re = await app.api('POST', '/api/my/parcels', { claimIds: [], method: 'x', addressConfirmed: true }, a.cookie);
  assert.equal(re.status, 400);
  // withdraw: the recipient takes it back before an answer
  const rcpt = await person(u('rcpt3')); const r3 = await request(rcpt, { shareWith: c.handle });
  assert.equal((await app.api('DELETE', `/api/my/parcels/${r3.json.id}/companion`, undefined, rcpt.cookie)).status, 200);
  assert.equal((await mine(c)).invites.length, 0); assert.deepEqual((await parcelOf(r3.json.id)).companions, []);
  assert.equal((await app.api('DELETE', `/api/my/parcels/${r3.json.id}/companion`, undefined, rcpt.cookie)).status, 404);
});

test('the same friend cannot be invited twice to one parcel (until they decline or the invitation is withdrawn)', async () => {
  const [a, b] = [await person(u('rcpt')), await person(u('frnd'))];
  const r = await request(a, { shareWith: b.handle });
  const again = await app.api('POST', `/api/my/parcels/${r.json.id}/companion/invite`, { handles: b.handle }, a.cookie);
  assert.equal(again.status, 409); assert.equal(again.json.code, 'companion_exists'); assert.match(again.json.error, new RegExp(`already invited @${b.handle}`));
  await app.api('POST', `/api/my/parcels/${r.json.id}/companion/decline`, {}, b.cookie);
  assert.equal((await app.api('POST', `/api/my/parcels/${r.json.id}/companion/invite`, { handles: b.handle }, a.cookie)).status, 201, 'after a decline they can be asked again');
  assert.equal((await parcelOf(r.json.id)).companions.length, 1);
  assert.equal((await mine(b)).invites.length, 1);
});

test('the friend can leave before fees are set (their items go back to "ready to pack"); once fees are on the parcel, who is in it is locked', async () => {
  const { a, b, id } = await shared(1, 1);
  const bClaim = b.ids[0];
  await fees(id, { doms: 10 });
  const locked = await app.api('POST', `/api/my/parcels/${id}/companion/leave`, {}, b.cookie);
  assert.equal(locked.status, 409); assert.equal(locked.json.code, 'fees_set'); assert.match(locked.json.error, /set those fees back to £0/);
  await fees(id, { doms: 0 });
  const left = await app.api('POST', `/api/my/parcels/${id}/companion/leave`, {}, b.cookie);
  assert.equal(left.status, 200);
  assert.deepEqual((await parcelOf(id)).items.map((i) => i.owner), [a.handle]);
  assert.deepEqual((await parcelOf(id)).companions, []);
  assert.equal((await app.q('SELECT pipeline FROM claims WHERE id = ?', [bClaim]))[0].pipeline, READY, 'their item is ready to ship again');
  assert.equal((await mine(b)).parcels.length, 0);
  assert.equal((await app.api('POST', `/api/my/parcels/${id}/companion/leave`, {}, b.cookie)).status, 404);
  // and a friend cannot ACCEPT after fees are set
  const [a2, b2] = [await person(u('rcpt')), await person(u('frnd'))];
  const r = await request(a2, { shareWith: b2.handle });
  await fees(r.json.id, { doms: 4 });
  const late = await accept(b2, r.json.id); assert.equal(late.status, 409); assert.equal(late.json.code, 'fees_set');
});

test('THE GOM COMBINES TWO PARCELS that were requested separately: one parcel to one address, the friend\'s details kept, the earlier place in the queue', async () => {
  const [a, b] = [await person(u('rcpt'), 2), await person(u('frnd'), 1)];
  const ra = await request(a, { bias: 'Han' });
  await new Promise((r) => setTimeout(r, 15));
  const rb = await request(b, { bias: 'Felix', notes: 'b note', lomoName: 'Bee' });
  const cand = (await api('GET', `/api/admin/parcels/${ra.json.id}/combine-candidates`)).json;
  assert.equal(cand.eligible, true); assert.ok(cand.candidates.some((c) => c.id === rb.json.id && c.handle === b.handle && c.items.length === 1));
  const earlier = (await app.q('SELECT requested_at FROM parcels WHERE id = ?', [ra.json.id]))[0].requested_at;
  const r = await api('POST', `/api/admin/parcels/${ra.json.id}/combine`, { withParcelId: rb.json.id, confirmed: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.parcelId, r.json.friendId > 0], [ra.json.id, true]);
  const q = await parcelOf(ra.json.id);
  assert.deepEqual(q.items.map((i) => i.owner).sort(), [a.handle, a.handle, b.handle].sort());
  assert.deepEqual([q.companions[0].handle, q.companions[0].status, q.companions[0].how, q.companions[0].bias, q.companions[0].notes, q.companions[0].lomoName], [b.handle, 'accepted', 'gom', 'Felix', 'b note', 'Bee']);
  assert.equal((await queue()).some((x) => x.id === rb.json.id), false, 'the absorbed parcel is gone from the queue');
  assert.deepEqual((await app.q('SELECT requested_at FROM parcels WHERE id = ?', [ra.json.id]))[0].requested_at, earlier);
  assert.equal((await mine(b)).parcels.some((p) => p.id === ra.json.id && p.role === 'friend'), true, 'the friend sees the shared parcel');
  assert.equal((await mine(b)).parcels.some((p) => p.id === rb.json.id), false);
  assert.equal((await app.api('POST', `/api/my/parcels/${rb.json.id}/received`, {}, b.cookie)).status, 404);
});

test('combining is refused when it would be wrong, and says why: no confirmation, same person, different postage or customs value, fees already set, or already shared', async () => {
  const [a, b, c, d] = [await person(u('a')), await person(u('b')), await person(u('c')), await person(u('d'))];
  const [pa, pb, pc, pd] = [await request(a), await request(b), await request(c, { method: 'UK Royal Mail Tracked 24' }), await request(d)];
  const combine = (id, withId, extra = {}) => api('POST', `/api/admin/parcels/${id}/combine`, { withParcelId: withId, confirmed: true, ...extra });
  assert.equal((await api('POST', `/api/admin/parcels/${pa.json.id}/combine`, { withParcelId: pb.json.id })).status, 400);
  const unconfirmed = await api('POST', `/api/admin/parcels/${pa.json.id}/combine`, { withParcelId: pb.json.id, confirmed: false });
  assert.match(unconfirmed.json.issues[0].message, /confirm that you've checked this with both people/);
  assert.equal((await combine(pa.json.id, pa.json.id)).status, 400);
  const diff = await combine(pa.json.id, pc.json.id); assert.deepEqual([diff.status, diff.json.code], [409, 'different_method']); assert.match(diff.json.error, /different postage methods/);
  const ww1 = await request(await person(u('w1')), { method: 'WW Tracked', declaredValue: 'true' }), ww2 = await request(await person(u('w2')), { method: 'WW Tracked', declaredValue: 'reduced' });
  assert.equal((await combine(ww1.json.id, ww2.json.id)).json.code, 'different_declared_value');
  await fees(pb.json.id, { doms: 3 });
  assert.equal((await combine(pa.json.id, pb.json.id)).json.code, 'fees_set');
  assert.equal((await combine(pb.json.id, pa.json.id)).json.code, 'fees_set');
  assert.equal((await combine(pa.json.id, pd.json.id)).status, 200);
  const shared = await combine(pa.json.id, pb.json.id); assert.ok([409].includes(shared.status));
  const same = await person(u('same'), 2); const s1 = await request({ ...same, ids: [same.ids[0]] }), s2 = await request({ ...same, ids: [same.ids[1]] });
  assert.equal((await combine(s1.json.id, s2.json.id)).status, 400);
  assert.equal((await combine(999999, pa.json.id)).status, 404);
  const j = await app.login('cmb.joiner@x.com');
  assert.equal((await api('POST', `/api/admin/parcels/${pa.json.id}/combine`, { withParcelId: pb.json.id, confirmed: true }, j)).status, 403);
  const cands = (await api('GET', `/api/admin/parcels/${pc.json.id}/combine-candidates`)).json.candidates.map((x) => x.id);
  assert.equal(cands.includes(pa.json.id), false, 'a different postage method is never offered');
});

test('uncombining gives the friend their own parcel back — with their items, bias, Lomo, notes and place in the queue — unless fees are on it', async () => {
  const [a, b] = [await person(u('rcpt'), 1), await person(u('frnd'), 2)];
  const ra = await request(a), rb = await request(b, { bias: 'Felix', notes: 'n', lomoName: 'Bee' });
  const placeB = (await parcelOf(rb.json.id)).queuePosition;
  await api('POST', `/api/admin/parcels/${ra.json.id}/combine`, { withParcelId: rb.json.id, confirmed: true });
  await fees(ra.json.id, { doms: 6 });
  const blocked = await api('POST', `/api/admin/parcels/${ra.json.id}/uncombine`, {});
  assert.equal(blocked.status, 409); assert.equal(blocked.json.code, 'fees_set');
  await fees(ra.json.id, { doms: 0 });
  const r = await api('POST', `/api/admin/parcels/${ra.json.id}/uncombine`, {});
  assert.equal(r.status, 200);
  const fresh = await parcelOf(r.json.newParcelId);
  assert.deepEqual([fresh.handle, fresh.bias, fresh.notes, fresh.lomoName, fresh.items.length, fresh.queuePosition > 0], [b.handle, 'Felix', 'n', 'Bee', 2, true]);
  assert.deepEqual((await parcelOf(ra.json.id)).items.map((i) => i.owner), [a.handle]);
  assert.deepEqual((await parcelOf(ra.json.id)).companions, []);
  assert.equal((await api('POST', `/api/admin/parcels/${ra.json.id}/uncombine`, {})).json.code, 'bad_state');
  assert.ok(placeB);
});

test('the GOM can remove an invitation nobody has accepted — but not a friend who has joined', async () => {
  const [a, b] = [await person(u('rcpt')), await person(u('frnd'))];
  const r = await request(a, { shareWith: b.handle });
  assert.equal((await api('DELETE', `/api/admin/parcels/${r.json.id}/companion`)).status, 200);
  assert.equal((await mine(b)).invites.length, 0);
  const { id } = await shared(1, 1);
  assert.equal((await api('DELETE', `/api/admin/parcels/${id}/companion`)).status, 409);
});

test('PACKING A SHARED PARCEL: the checklist covers BOTH people\'s Lomo names and bias names; shipping it and the recipient pressing "It\'s arrived" completes both people\'s items', async () => {
  const { a, b, id } = await shared(1, 1, { bias: 'Han' }, { bias: 'Felix', lomoName: 'Bee' });
  await api('POST', `/api/admin/parcels/${id}/items-packed`, { packed: true });
  await api('POST', `/api/admin/parcels/${id}/checks`, { address: true, lomo: true, bias: true });
  let r = await api('POST', `/api/admin/parcels/${id}/packed`);
  assert.equal(r.status, 409); assert.equal(r.json.code, 'checklist_incomplete'); assert.match(r.json.error, new RegExp(`the Lomo name for @${b.handle}, the bias name for @${b.handle}`));
  assert.equal((await api('POST', `/api/admin/parcels/${id}/checks`, { friend: true, address: true })).status, 400, 'the address is the recipient\'s, not the friend\'s');
  await api('POST', `/api/admin/parcels/${id}/checks`, { friend: true, lomo: true });
  assert.match((await api('POST', `/api/admin/parcels/${id}/packed`)).json.error, /bias name for/);
  await api('POST', `/api/admin/parcels/${id}/checks`, { friend: true, bias: true });
  await fees(id, { doms: 8, packaging: 2 });
  assert.equal((await api('POST', `/api/admin/parcels/${id}/packed`)).status, 200);
  assert.equal((await api('POST', `/api/admin/parcels/${id}/shipped`)).status, 200);
  assert.deepEqual((await app.q('SELECT pipeline FROM claims WHERE id IN (?) ORDER BY id', [[...a.ids, ...b.ids]])).map((r) => r.pipeline), ['shipped', 'shipped']);
  const bView = (await mine(b)).parcels[0];
  assert.deepEqual([bView.status, bView.canConfirm, bView.myDoms, bView.myPackaging, bView.domsTotal], ['shipped', false, 4, 1, 8], 'the friend sees their own share and the whole');
  assert.equal((await app.api('POST', `/api/my/parcels/${id}/received`, {}, b.cookie)).status, 404, 'the friend cannot confirm it');
  assert.equal((await app.api('POST', `/api/my/parcels/${id}/received`, {}, a.cookie)).status, 200, 'the recipient confirms for both');
  assert.deepEqual((await app.q('SELECT pipeline, received_date FROM claims WHERE id IN (?) ORDER BY id', [[...a.ids, ...b.ids]])).map((r) => [r.pipeline, !!r.received_date]), [['completed', true], ['completed', true]]);
  assert.equal((await mine(b)).parcels[0].status, 'received');
});

test('a shared parcel the GOM marks received on their behalf also completes both people\'s items', async () => {
  const { a, b, id } = await shared(1, 1);
  await tickParcel(app, admin, id); await api('POST', `/api/admin/parcels/${id}/packed`); await api('POST', `/api/admin/parcels/${id}/shipped`);
  assert.equal((await api('POST', `/api/admin/parcels/${id}/received`)).status, 200);
  assert.deepEqual((await app.q('SELECT pipeline FROM claims WHERE id IN (?)', [[...a.ids, ...b.ids]])).map((r) => r.pipeline), ['completed', 'completed']);
});

test('cancelling a shared parcel takes the fees off BOTH people (refunding what they paid as credit) and frees everyone\'s items', async () => {
  const { a, b, id } = await shared(1, 1);
  await fees(id, { doms: 10, packaging: 4 });
  await api('POST', '/api/admin/credit/add', { handle: b.handle, amount: 50, reason: 'pay' });
  const before = (await app.api('GET', '/api/my/summary', undefined, b.cookie)).json.credit;
  assert.equal((await api('POST', `/api/admin/parcels/${id}/cancel`)).status, 200);
  assert.deepEqual([await costs(a.ids, 'doms'), await costs(b.ids, 'doms'), await costs(a.ids, 'packaging'), await costs(b.ids, 'packaging')], [[0], [0], [0], [0]]);
  assert.equal(Math.round(((await app.api('GET', '/api/my/summary', undefined, b.cookie)).json.credit - before) * 100) / 100, 7, 'b gets their £5 + £2 back');
  assert.equal((await mine(a)).parcels.length, 0); assert.equal((await mine(b)).parcels.length, 0);
  assert.equal((await request(a)).status, 201, 'items are free to be requested again');
});

test('EMAILS (opt-in): the friend is told about an invitation; when it ships the recipient is asked to confirm for both and the friend is told where it is going', async () => {
  const [a, b] = [await person(u('rcpt')), await person(u('frnd'))];
  const off = await person(u('quiet'));
  for (const p of [a, b]) await app.api('PUT', '/api/my/notifications', { enabled: true }, p.cookie);
  const mails = (email) => app.mailer.outbox.filter((m) => m.to === email && !/auth\/confirm/.test(m.text));
  const r = await request(a, { shareWith: b.handle }); await settle();
  assert.equal(mails(`${b.handle}@x.com`).length, 1);
  assert.match(mails(`${b.handle}@x.com`)[0].subject, new RegExp(`@${a.handle} would like to ship together with you`));
  assert.match(mails(`${b.handle}@x.com`)[0].text, /Nothing happens unless you say yes/);
  const r2 = await request(off, { shareWith: a.handle }); await settle();
  await app.api('POST', `/api/my/parcels/${r2.json.id}/companion/decline`, {}, a.cookie);
  assert.equal(mails(`${off.handle}@x.com`).length, 0, 'someone who has not turned emails on gets none');
  await accept(b, r.json.id); await tickParcel(app, admin, r.json.id); await api('POST', `/api/admin/parcels/${r.json.id}/packed`); await api('POST', `/api/admin/parcels/${r.json.id}/shipped`); await settle();
  const ma = mails(`${a.handle}@x.com`).find((m) => /on its way/.test(m.subject)), mb = mails(`${b.handle}@x.com`).find((m) => /on their way/.test(m.subject));
  assert.match(ma.text, new RegExp(`shared with @${b.handle}.*press "It's arrived".*confirms it for all of you`, 's'));
  assert.match(mb.text, new RegExp(`in a parcel with @${a.handle}'s items to @${a.handle}'s address.*@${a.handle} will confirm when it arrives`, 's'));
  assert.doesNotMatch(mb.text, /press "It's arrived"/, 'the friend is not asked to confirm');
});

test('concurrency: the friend answering twice at once, or accepting while the GOM combines, leaves one consistent parcel', async () => {
  const [a, b] = [await person(u('rcpt')), await person(u('frnd'), 2)];
  const r = await request(a, { shareWith: b.handle });
  const rs = await Promise.all([accept(b, r.json.id), accept(b, r.json.id), app.api('POST', `/api/my/parcels/${r.json.id}/companion/decline`, {}, b.cookie)]);
  assert.equal(rs.filter((x) => x.status === 200).length, 1, `exactly one answer won (${rs.map((x) => x.status)})`);
  const q = await parcelOf(r.json.id);
  assert.ok(['accepted', 'declined'].includes(q.companions[0].status));
  assert.equal(q.items.filter((i) => i.owner === b.handle).length, q.companions[0].status === 'accepted' ? 2 : 0, 'items are in the parcel if and only if they accepted');
  const [c, d] = [await person(u('c')), await person(u('d'))];
  const [pc, pd] = [await request(c), await request(d)];
  const both = await Promise.all([api('POST', `/api/admin/parcels/${pc.json.id}/combine`, { withParcelId: pd.json.id, confirmed: true }), api('POST', `/api/admin/parcels/${pd.json.id}/combine`, { withParcelId: pc.json.id, confirmed: true })]);
  assert.equal(both.filter((x) => x.status === 200).length, 1, `two combines the opposite way round: one wins (${both.map((x) => x.status)})`);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM parcels WHERE id IN (?) AND status = \'requested\'', [[pc.json.id, pd.json.id]]))[0].n, 1);
});

test('INVARIANTS: shared parcels hold only their two people\'s items, no item is in two live parcels, and fees add up to the parcel total', async () => {
  assert.equal((await app.q(`SELECT COUNT(*) AS n FROM (SELECT pi.parcel_id FROM parcel_items pi JOIN claims c ON c.id = pi.claim_id JOIN parcels p ON p.id = pi.parcel_id
       LEFT JOIN parcel_companions pc ON pc.parcel_id = p.id WHERE c.joiner_id <> p.joiner_id AND (pc.joiner_id IS NULL OR pc.joiner_id <> c.joiner_id)) x`))[0].n, 0, 'every item belongs to the recipient or the friend');
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM parcel_items pi JOIN parcels p ON p.id = pi.parcel_id WHERE p.status IN ('requested','packed','shipped') AND pi.claim_id IN (SELECT pi2.claim_id FROM parcel_items pi2 JOIN parcels p2 ON p2.id = pi2.parcel_id WHERE p2.status IN ('requested','packed','shipped') GROUP BY pi2.claim_id HAVING COUNT(*) > 1)"))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM parcels p WHERE p.status <> 'cancelled' AND p.doms_total IS NOT NULL AND ABS(p.doms_total - COALESCE((SELECT SUM(doms_share) FROM parcel_items WHERE parcel_id = p.id), 0)) > 0.005"))[0].n, 0, 'the postage shares add up to the postage');
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM parcel_companions pc LEFT JOIN parcels p ON p.id = pc.parcel_id WHERE p.id IS NULL"))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost OR cost < 0'))[0].n, 0);
});
