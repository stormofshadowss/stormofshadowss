import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure, tickParcel } from './helpers.js';

const READY = 'ready to pack / on hand';
let app, admin, w, N = 0, ITEM;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const go = (await app.api('POST', '/api/admin/orders', { groupId: w.group, title: 'Many people GO' }, admin)).json.id;
  const mk = async (title, price) => (await app.api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price }, admin)).json.id;
  ITEM = { a: await mk('Album', 20), b: await mk('Badge', 5), c: await mk('Card', 3) };
});
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (p = 'mp') => `${p}${++N}`;
const settle = () => app.notifier.idle();
async function person(handle = u(), nItems = 1, weights = []) {
  const cookie = await joinerSession(app, `${handle}@x.com`, handle);
  await api('PUT', '/api/my/address', { fullName: `${handle} Name`, address: `1 ${handle} Road`, email: `${handle}@x.com`, phone: '0700' }, cookie);
  const ids = [], items = [ITEM.a, ITEM.b, ITEM.c];
  for (let i = 0; i < nItems; i++) {
    const [id] = await claimAndSecure(app, admin, handle, items[i % 3]);
    await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY, ...(weights[i] ? { weightG: weights[i] } : {}) });
    ids.push(id);
  }
  return { handle, cookie, ids };
}
const request = (p, body = {}) => api('POST', '/api/my/parcels', { claimIds: p.ids, method: 'UK Royal Mail Tracked 48', addressConfirmed: true, ...body }, p.cookie);
const requestWW = (p, body = {}) => request(p, { method: 'WW Tracked', declaredValue: 'true', ...body });
const accept = (p, parcelId, body = {}) => api('POST', `/api/my/parcels/${parcelId}/companion/accept`, { claimIds: p.ids, ...body }, p.cookie);
const mine = async (p) => (await api('GET', '/api/my/parcels', undefined, p.cookie)).json;
const parcelOf = async (id, status = 'requested') => (await api('GET', `/api/admin/packing?status=${status}`)).json.parcels.find((x) => x.id === id);
const fees = (id, body) => api('POST', `/api/admin/parcels/${id}/fees`, body);
const split = (id, body) => api('POST', `/api/admin/parcels/${id}/split`, body);
const costs = async (ids, cat) => (await app.q('SELECT cost FROM claim_costs WHERE category = ? AND claim_id IN (?) ORDER BY claim_id', [cat, ids])).map((r) => Number(r.cost));
const sum = (a) => Math.round(a.reduce((s, x) => s + x, 0) * 100) / 100;
// a recipient plus friends, everyone joined (the joiner-led way)
async function group(nFriends, { ww = false, items = [1, 1, 1, 1, 1], weights = [] } = {}) {
  const a = await person(u('rcpt'), items[0], weights[0] || []);
  const friends = []; for (let i = 0; i < nFriends; i++) friends.push(await person(u('frnd'), items[i + 1], weights[i + 1] || []));
  const r = await (ww ? requestWW : request)(a, { shareWith: friends.map((f) => `@${f.handle}`) });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  for (const f of friends) assert.equal((await accept(f, r.json.id)).status, 200);
  return { a, friends, id: r.json.id, all: [a, ...friends] };
}

// ───────────── more than two people ─────────────
test('NAMING SEVERAL FRIENDS: a list or a spaced/comma-separated string invites each; the parcel waits for ALL of them', async () => {
  const [a, b, c, d] = [await person(u('rcpt')), await person(u('b')), await person(u('c')), await person(u('d'))];
  const r = await request(a, { shareWith: `@${b.handle}, ${c.handle}  @${d.handle.toUpperCase()}` });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.companions.map((x) => x.handle), [b.handle, c.handle, d.handle]);
  for (const f of [b, c, d]) assert.equal((await mine(f)).invites.length, 1);
  const q = await parcelOf(r.json.id);
  assert.deepEqual(q.companions.map((x) => x.status), ['invited', 'invited', 'invited']);
  await tickParcel(app, admin, r.json.id);
  let pack = await api('POST', `/api/admin/parcels/${r.json.id}/packed`);
  assert.equal(pack.json.code, 'companion_pending'); assert.match(pack.json.error, new RegExp(`@${b.handle}, @${c.handle}, @${d.handle} haven't answered`));
  await accept(b, r.json.id); await app.api('POST', `/api/my/parcels/${r.json.id}/companion/decline`, {}, c.cookie);
  pack = await api('POST', `/api/admin/parcels/${r.json.id}/packed`);
  assert.match(pack.json.error, new RegExp(`@${d.handle} hasn't answered`), 'one still waiting holds it up, named singly');
  await accept(d, r.json.id);
  await tickParcel(app, admin, r.json.id);
  assert.equal((await api('POST', `/api/admin/parcels/${r.json.id}/packed`)).status, 200, 'a decline and two yeses: it goes');
  assert.deepEqual((await parcelOf(r.json.id, 'packed')).items.map((i) => i.owner).sort(), [a.handle, b.handle, d.handle].sort());
  // being invited to another parcel is allowed, but the same items can never be in two parcels
  const r2 = await request(await person(u('r2')), { shareWith: [b.handle] });
  assert.equal(r2.status, 201);
  assert.equal((await accept(b, r2.json.id)).json.code, 'not_ready', 'their items were packed in the first parcel, so they cannot go in a second');
});

test('THREE PEOPLE, UK: postage is split equally per PERSON (a third each), then across each person\'s own items, to the penny', async () => {
  const { all, id } = await group(2, { items: [3, 1, 2] });
  await fees(id, { doms: 10, packaging: 1 });
  const per = [];
  for (const p of all) per.push([sum(await costs(p.ids, 'doms')), sum(await costs(p.ids, 'packaging'))]);
  assert.equal(sum(per.map((x) => x[0])), 10); assert.equal(sum(per.map((x) => x[1])), 1);
  assert.ok(per.every(([d]) => d >= 3.33 && d <= 3.34), `a third each: ${JSON.stringify(per)}`);
  assert.deepEqual(await costs(all[1].ids, 'doms'), [per[1][0]], 'a one-item friend carries their third on that one item');
  assert.equal(sum(await costs(all[0].ids, 'doms')), per[0][0], 'the three-item person shares theirs across three');
  const q = await parcelOf(id);
  assert.deepEqual([q.feeSplit, q.people.map((x) => x.role)], [{ mode: 'equal', auto: true }, ['recipient', 'friend', 'friend']]);
});

test('THE LIMIT: up to 5 people share one parcel; a 6th is refused (and so is combining into a full parcel); a declined friend does not count', async () => {
  const { a, friends, id } = await group(4);                                        // the recipient + 4 friends = 5
  const extra = await person(u('extra'));
  const six = await api('POST', `/api/my/parcels/${id}/companion/invite`, { handles: extra.handle }, a.cookie);
  assert.equal(six.status, 409); assert.equal(six.json.code, 'too_many_people'); assert.match(six.json.error, /up to 5 people/);
  const rExtra = await request(extra);
  assert.equal((await api('POST', `/api/admin/parcels/${id}/combine`, { withParcelId: rExtra.json.id, confirmed: true })).json.code, 'too_many_people');
  assert.equal((await api('GET', `/api/admin/parcels/${id}/combine-candidates`)).json.eligible, false);
  assert.equal((await parcelOf(id)).maxPeople, 5);
  // more than 4 friends named at once is refused by the request itself
  const names = [await person(u('x')), await person(u('y')), await person(u('z')), await person(u('w')), await person(u('v'))].map((p) => p.handle);
  assert.equal((await request(await person(u('r6')), { shareWith: names })).status, 400);
});

test('a declined or withdrawn invitation does not take up a place', async () => {
  const { a, id } = await group(3);                                                  // 4 people
  const [d1, d2] = [await person(u('d1')), await person(u('d2'))];
  assert.equal((await api('POST', `/api/my/parcels/${id}/companion/invite`, { handles: d1.handle }, a.cookie)).status, 201, 'the 5th place');
  assert.equal((await api('POST', `/api/my/parcels/${id}/companion/invite`, { handles: d2.handle }, a.cookie)).json.code, 'too_many_people');
  await api('POST', `/api/my/parcels/${id}/companion/decline`, {}, d1.cookie);
  assert.equal((await api('POST', `/api/my/parcels/${id}/companion/invite`, { handles: d2.handle }, a.cookie)).status, 201, 'a declined invitation freed the place');
  assert.equal((await api('DELETE', `/api/my/parcels/${id}/companion?friend=${d2.handle}`, undefined, a.cookie)).status, 200);
  assert.equal((await api('POST', `/api/my/parcels/${id}/companion/invite`, { handles: d1.handle }, a.cookie)).status, 201, 'and so did withdrawing one');
});

test('INVITING MORE FRIENDS LATER: the recipient can add friends (up to the limit) until fees are saved — and not after', async () => {
  const { a, id } = await group(1);
  const [c, d] = [await person(u('c')), await person(u('d'))];
  const add = await api('POST', `/api/my/parcels/${id}/companion/invite`, { handles: [c.handle, d.handle] }, a.cookie);
  assert.deepEqual([add.status, add.json.invited], [201, [c.handle, d.handle]]);
  assert.equal((await mine(c)).invites.length, 1);
  assert.equal((await parcelOf(id)).companions.length, 3);
  await accept(c, id); await accept(d, id);
  await fees(id, { doms: 6 });
  const late = await api('POST', `/api/my/parcels/${id}/companion/invite`, { handles: (await person(u('late'))).handle }, a.cookie);
  assert.equal(late.status, 409); assert.equal(late.json.code, 'fees_set');
  const stranger = await person(u('str'));
  assert.equal((await api('POST', `/api/my/parcels/${id}/companion/invite`, { handles: c.handle }, stranger.cookie)).status, 404, 'only the recipient can invite');
});

test('each person sees the OTHERS: the recipient sees every friend and how they answered; a friend sees the recipient and the other friends who joined', async () => {
  const [a, b, c, d] = [await person(u('rcpt')), await person(u('b')), await person(u('c')), await person(u('d'))];
  const r = await request(a, { shareWith: [b.handle, c.handle, d.handle] });
  await accept(b, r.json.id); await app.api('POST', `/api/my/parcels/${r.json.id}/companion/decline`, {}, c.cookie);
  const view = (await mine(a)).parcels[0];
  assert.deepEqual(view.shared.people.map((x) => [x.handle, x.status]), [[b.handle, 'accepted'], [c.handle, 'declined'], [d.handle, 'invited']]);
  await accept(d, r.json.id);
  const bView = (await mine(b)).parcels[0];
  assert.deepEqual(bView.shared.people.map((x) => [x.handle, x.status]), [[a.handle, 'recipient'], [d.handle, 'accepted']], 'not the friend who declined, and not themselves');
  assert.deepEqual(bView.items.map((i) => i.owner).sort(), [a.handle, b.handle, d.handle].sort());
  assert.equal(bView.items.filter((i) => i.mine).length, 1);
});

test('THE GOM adds a THIRD person by combining another parcel into one that is already shared; the other parcel must be a plain one', async () => {
  const [a, b, c, d] = [await person(u('rcpt')), await person(u('b')), await person(u('c')), await person(u('d'))];
  const [ra, rb, rc, rd] = [await request(a), await request(b), await request(c), await request(d, { shareWith: [a.handle] })];
  assert.equal((await api('POST', `/api/admin/parcels/${ra.json.id}/combine`, { withParcelId: rb.json.id, confirmed: true })).status, 200);
  const cands = (await api('GET', `/api/admin/parcels/${ra.json.id}/combine-candidates`)).json;
  assert.deepEqual([cands.eligible, cands.candidates.map((x) => x.id).includes(rc.json.id), cands.candidates.map((x) => x.id).includes(rb.json.id)], [true, true, false], 'b is already on it; c is plain');
  assert.equal((await api('POST', `/api/admin/parcels/${ra.json.id}/combine`, { withParcelId: rc.json.id, confirmed: true })).status, 200);
  assert.deepEqual((await parcelOf(ra.json.id)).companions.map((x) => x.handle), [b.handle, c.handle]);
  const shared = await api('POST', `/api/admin/parcels/${ra.json.id}/combine`, { withParcelId: rd.json.id, confirmed: true });
  assert.equal(shared.json.code, 'companion_exists', 'a parcel that is itself being shared cannot be folded in');
  assert.equal((await api('POST', `/api/admin/parcels/${ra.json.id}/combine`, { withParcelId: rb.json.id, confirmed: true })).status, 404, 'b\'s old parcel no longer exists');
});

test('SPLITTING ONE PERSON OFF a bigger parcel: say which friend; the rest stay together', async () => {
  const { a, friends, id } = await group(2, { items: [1, 2, 1] });
  const [b, c] = friends;
  const ask = await api('POST', `/api/admin/parcels/${id}/uncombine`, {});
  assert.equal(ask.status, 400); assert.equal(ask.json.code, 'which_friend'); assert.match(ask.json.error, new RegExp(`@${b.handle}, @${c.handle}`));
  assert.equal((await api('POST', `/api/admin/parcels/${id}/uncombine`, { friend: 'nobody_here' })).status, 404);
  const r = await api('POST', `/api/admin/parcels/${id}/uncombine`, { friend: `@${b.handle}` });
  assert.equal(r.status, 200); assert.equal(r.json.handle, b.handle);
  const left = await parcelOf(id);
  assert.deepEqual([left.companions.map((x) => x.handle), left.items.map((i) => i.owner).sort()], [[c.handle], [a.handle, c.handle].sort()]);
  const fresh = await parcelOf(r.json.newParcelId);
  assert.deepEqual([fresh.handle, fresh.items.length, fresh.companions], [b.handle, 2, []]);
  const only = await api('POST', `/api/admin/parcels/${id}/uncombine`, {});
  assert.equal(only.status, 200, 'with a single friend left no name is needed');
});

test('REMOVING INVITATIONS: by handle when there are several; nothing to remove once they have joined', async () => {
  const [a, b, c] = [await person(u('rcpt')), await person(u('b')), await person(u('c'))];
  const r = await request(a, { shareWith: [b.handle, c.handle] });
  const ambiguous = await api('DELETE', `/api/admin/parcels/${r.json.id}/companion`);
  assert.equal(ambiguous.status, 400); assert.equal(ambiguous.json.code, 'which_friend');
  assert.equal((await api('DELETE', `/api/admin/parcels/${r.json.id}/companion?friend=${b.handle}`)).status, 200);
  assert.deepEqual((await parcelOf(r.json.id)).companions.map((x) => x.handle), [c.handle]);
  assert.equal((await api('DELETE', `/api/my/parcels/${r.json.id}/companion?friend=${c.handle}`, undefined, a.cookie)).status, 200, 'the recipient can take one back too');
  await accept(b, r.json.id).catch(() => null);
  const r2 = await request(await person(u('r2')), { shareWith: [c.handle] });
  await accept(c, r2.json.id);
  const joined = await api('DELETE', `/api/admin/parcels/${r2.json.id}/companion`);
  assert.equal(joined.status, 409); assert.match(joined.json.error, /already joined this parcel/);
});

test('THE CHECKLIST for several people: every friend\'s Lomo name and bias must be ticked; `true` ticks everyone, a handle ticks one', async () => {
  const [a, b, c] = [await person(u('rcpt')), await person(u('b')), await person(u('c'))];
  const r = await request(a, { shareWith: [b.handle, c.handle], bias: 'Han' });
  await accept(b, r.json.id, { bias: 'Felix', lomoName: 'Bee' }); await accept(c, r.json.id, { bias: 'Jin', lomoName: 'Cee' });
  await api('POST', `/api/admin/parcels/${r.json.id}/items-packed`, { packed: true });
  await api('POST', `/api/admin/parcels/${r.json.id}/checks`, { address: true, lomo: true, bias: true });
  let p = await api('POST', `/api/admin/parcels/${r.json.id}/packed`);
  assert.match(p.json.error, new RegExp(`the Lomo name for @${b.handle}, the bias name for @${b.handle}, the Lomo name for @${c.handle}, the bias name for @${c.handle}`));
  await api('POST', `/api/admin/parcels/${r.json.id}/checks`, { friend: b.handle, lomo: true, bias: true });
  p = await api('POST', `/api/admin/parcels/${r.json.id}/packed`);
  assert.match(p.json.error, new RegExp(`@${c.handle}`)); assert.doesNotMatch(p.json.error, new RegExp(`@${b.handle}`));
  assert.equal((await api('POST', `/api/admin/parcels/${r.json.id}/checks`, { friend: 'someone_else', lomo: true })).status, 404);
  await api('POST', `/api/admin/parcels/${r.json.id}/checks`, { friend: true, lomo: true, bias: true });
  assert.equal((await api('POST', `/api/admin/parcels/${r.json.id}/packed`)).status, 200);
});

test('SHIPPING A BIG PARCEL: the recipient confirms for EVERYONE; each friend\'s email names the others; the recipient\'s email lists them all', async () => {
  const { a, friends, id, all } = await group(2);
  for (const p of all) await api('PUT', '/api/my/notifications', { enabled: true }, p.cookie);
  await tickParcel(app, admin, id); await fees(id, { doms: 9 });
  await api('POST', `/api/admin/parcels/${id}/packed`); await api('POST', `/api/admin/parcels/${id}/shipped`); await settle();
  const mails = (p) => app.mailer.outbox.filter((m) => m.to === `${p.handle}@x.com` && !/auth\/confirm/.test(m.text));
  const ma = mails(a).find((m) => /on its way/.test(m.subject));
  assert.match(ma.text, new RegExp(`shared with @${friends[0].handle} and @${friends[1].handle}.*confirms it for all of you`, 's'));
  const mb = mails(friends[0]).find((m) => /on their way/.test(m.subject));
  assert.match(mb.text, new RegExp(`in a parcel with @${a.handle}'s items \\(and @${friends[1].handle}'s\\) to @${a.handle}'s address`));
  assert.equal((await api('POST', `/api/my/parcels/${id}/received`, {}, friends[1].cookie)).status, 404);
  assert.equal((await api('POST', `/api/my/parcels/${id}/received`, {}, a.cookie)).status, 200);
  assert.deepEqual((await app.q('SELECT pipeline FROM claims WHERE id IN (?)', [all.flatMap((p) => p.ids)])).map((r) => r.pipeline), ['completed', 'completed', 'completed']);
});

test('CANCELLING a three-person parcel refunds each person their own share and frees everyone\'s items; one friend LEAVING does not disturb the others', async () => {
  const { a, friends, id, all } = await group(2);
  await fees(id, { doms: 9 });
  for (const p of friends) await api('POST', '/api/admin/credit/add', { handle: p.handle, amount: 50, reason: 'pay' });
  const credit = async (p) => (await api('GET', '/api/my/summary', undefined, p.cookie)).json.credit;
  const before = [await credit(friends[0]), await credit(friends[1])];
  assert.equal((await api('POST', `/api/admin/parcels/${id}/cancel`)).status, 200);
  assert.deepEqual([await credit(friends[0]) - before[0], await credit(friends[1]) - before[1]].map((x) => Math.round(x * 100) / 100), [3, 3], 'each friend gets their £3 back');
  for (const p of all) assert.deepEqual(await costs(p.ids, 'doms'), [0]);
  const g2 = await group(2);
  const left = await api('POST', `/api/my/parcels/${g2.id}/companion/leave`, {}, g2.friends[0].cookie);
  assert.equal(left.status, 200);
  const q = await parcelOf(g2.id);
  assert.deepEqual([q.companions.map((x) => x.handle), q.items.map((i) => i.owner).sort()], [[g2.friends[1].handle], [g2.a.handle, g2.friends[1].handle].sort()]);
  assert.ok(a);
});

// ───────────── fees split by WEIGHT ─────────────
test('WORLDWIDE POSTAGE IS SPLIT BY WEIGHT automatically (UK stays equal): the heavier person pays more, to the penny', async () => {
  const { a, friends, id } = await group(1, { ww: true, items: [2, 1], weights: [[200, 200], [800]] });     // a: 400g, b: 800g
  await fees(id, { doms: 12, packaging: 3 });
  const [aD, bD, aP, bP] = [sum(await costs(a.ids, 'doms')), sum(await costs(friends[0].ids, 'doms')), sum(await costs(a.ids, 'packaging')), sum(await costs(friends[0].ids, 'packaging'))];
  assert.deepEqual([aD, bD, aP, bP], [4, 8, 1, 2], '400g : 800g = 1 : 2');
  const q = await parcelOf(id);
  assert.deepEqual(q.feeSplit, { mode: 'weight', auto: true });
  assert.deepEqual(q.people.map((x) => [x.handle, x.estimatedG, x.usedG, x.weightG, x.doms, x.packaging]), [[a.handle, 400, 400, null, 4, 1], [friends[0].handle, 800, 800, null, 8, 2]]);
  // a UK parcel with the very same people and weights stays equal
  const uk = await group(1, { items: [2, 1], weights: [[200, 200], [800]] });
  await fees(uk.id, { doms: 12 });
  assert.deepEqual([sum(await costs(uk.a.ids, 'doms')), sum(await costs(uk.friends[0].ids, 'doms'))], [6, 6]);
  assert.deepEqual((await parcelOf(uk.id)).feeSplit, { mode: 'equal', auto: true });
});

test('without exact weights each item counts at its size\'s usual weight; an item with a known exact weight counts at that', async () => {
  const { a, friends, id } = await group(1, { ww: true, items: [3, 1] });          // sizes default to M (175g): 525g vs 175g
  await fees(id, { doms: 8 });
  assert.deepEqual([sum(await costs(a.ids, 'doms')), sum(await costs(friends[0].ids, 'doms'))], [6, 2], '525 : 175 = 3 : 1');
  const g = await group(1, { ww: true, items: [1, 1], weights: [[], [525]] });       // a: M 175g (estimated), b: 525g (exact)
  await fees(g.id, { doms: 8 });
  assert.deepEqual([sum(await costs(g.a.ids, 'doms')), sum(await costs(g.friends[0].ids, 'doms'))], [2, 6]);
});

test('TYPING IN WHAT YOU WEIGHED overrides the estimate; fees already on the parcel are shared out again, and a reduced share goes back to credit', async () => {
  const { a, friends, id } = await group(1, { ww: true, items: [1, 1], weights: [[500], [500]] });
  await fees(id, { doms: 10 });
  assert.deepEqual([sum(await costs(a.ids, 'doms')), sum(await costs(friends[0].ids, 'doms'))], [5, 5]);
  await api('POST', '/api/admin/credit/add', { handle: friends[0].handle, amount: 40, reason: 'pay' });
  const credit = async () => (await api('GET', '/api/my/summary', undefined, friends[0].cookie)).json.credit;
  const before = await credit();
  const r = await split(id, { weights: { [a.handle]: 1500, [friends[0].handle]: 500 } });         // a's things are really 3x heavier
  assert.equal(r.status, 200);
  assert.deepEqual([sum(await costs(a.ids, 'doms')), sum(await costs(friends[0].ids, 'doms'))], [7.5, 2.5]);
  assert.equal(Math.round((await credit() - before) * 100) / 100, 2.5, 'b paid £5, now owes £2.50 — the difference is refunded as credit');
  const q = await parcelOf(id);
  assert.deepEqual(q.people.map((x) => [x.weightG, x.estimatedG, x.usedG, x.doms]), [[1500, 500, 1500, 7.5], [500, 500, 500, 2.5]]);
  await split(id, { weights: { [a.handle]: null } });
  assert.deepEqual([sum(await costs(a.ids, 'doms')), sum(await costs(friends[0].ids, 'doms'))], [5, 5], 'clearing a weight goes back to the estimate');
});

test('YOU CAN OVERRIDE the automatic choice either way, and set it back to automatic', async () => {
  const uk = await group(1, { items: [1, 1], weights: [[100], [300]] });
  await fees(uk.id, { doms: 8 });
  assert.deepEqual([sum(await costs(uk.a.ids, 'doms')), sum(await costs(uk.friends[0].ids, 'doms'))], [4, 4]);
  assert.equal((await split(uk.id, { mode: 'weight' })).status, 200);
  assert.deepEqual([sum(await costs(uk.a.ids, 'doms')), sum(await costs(uk.friends[0].ids, 'doms'))], [2, 6], 'UK parcel split by weight on request');
  assert.deepEqual((await parcelOf(uk.id)).feeSplit, { mode: 'weight', auto: false });
  await split(uk.id, { mode: 'auto' });
  assert.deepEqual([sum(await costs(uk.a.ids, 'doms')), sum(await costs(uk.friends[0].ids, 'doms'))], [4, 4]);
  const ww = await group(1, { ww: true, items: [1, 1], weights: [[100], [300]] });
  await split(ww.id, { mode: 'equal' });
  await fees(ww.id, { doms: 8 });
  assert.deepEqual([sum(await costs(ww.a.ids, 'doms')), sum(await costs(ww.friends[0].ids, 'doms'))], [4, 4], 'worldwide split equally on request');
});

test('three people by weight: shares add to the total exactly, however awkward the figures', async () => {
  const { all, id } = await group(2, { ww: true, items: [1, 1, 1], weights: [[100], [200], [300]] });
  await fees(id, { doms: 10.01, packaging: 0.07 });
  const d = [], pk = [];
  for (const p of all) { d.push(sum(await costs(p.ids, 'doms'))); pk.push(sum(await costs(p.ids, 'packaging'))); }
  assert.equal(sum(d), 10.01); assert.equal(sum(pk), 0.07);
  assert.ok(d[0] < d[1] && d[1] < d[2], `heavier pays more: ${d}`);
  assert.ok(Math.abs(d[2] - 5.01) <= 0.01 && Math.abs(d[1] - 3.34) <= 0.01 && Math.abs(d[0] - 1.67) <= 0.01, `100:200:300 of £10.01 — ${d}`);
});

test('the split settings are checked: only people on the parcel, sensible weights, only while it is waiting, and only the GOM', async () => {
  const { a, id } = await group(1, { ww: true });
  const stranger = await person(u('str'));
  assert.equal((await split(id, { weights: { [stranger.handle]: 500 } })).status, 400);
  assert.equal((await split(id, { weights: { [a.handle]: 0 } })).status, 400);
  assert.equal((await split(id, { weights: { [a.handle]: -5 } })).status, 400);
  assert.equal((await split(id, { weights: { [a.handle]: 1.5 } })).status, 400);
  assert.equal((await split(id, { mode: 'nonsense' })).status, 400);
  assert.equal((await split(id, {})).status, 400);
  assert.equal((await split(999999, { mode: 'equal' })).status, 404);
  assert.equal((await api('POST', `/api/admin/parcels/${id}/split`, { mode: 'equal' }, a.cookie)).status, 403);
  assert.equal((await app.api('POST', `/api/admin/parcels/${id}/split`, { mode: 'equal' })).status, 401);
  await tickParcel(app, admin, id); await api('POST', `/api/admin/parcels/${id}/packed`);
  assert.equal((await split(id, { mode: 'equal' })).json.code, 'bad_state');
});

test('a parcel with one person is unaffected by the split setting; joiners are told how a shared parcel is split', async () => {
  const solo = await person(u('solo'), 2); const r = await requestWW(solo);
  await split(r.json.id, { mode: 'weight' });
  await fees(r.json.id, { doms: 7 });
  assert.equal(sum(await costs(solo.ids, 'doms')), 7);
  assert.equal((await mine(solo)).parcels[0].feeSplit, null, 'nothing to split');
  const ww = await group(1, { ww: true }), uk = await group(1);
  assert.equal((await mine(ww.a)).parcels[0].feeSplit, 'weight'); assert.equal((await mine(ww.friends[0])).parcels[0].feeSplit, 'weight');
  assert.equal((await mine(uk.a)).parcels[0].feeSplit, 'equal');
});

test('INVARIANTS: fee shares add up to the parcel totals everywhere, every item belongs to someone on its parcel, nothing is overpaid', async () => {
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM parcels p WHERE p.status <> 'cancelled' AND p.doms_total IS NOT NULL AND ABS(p.doms_total - COALESCE((SELECT SUM(doms_share) FROM parcel_items WHERE parcel_id = p.id), 0)) > 0.005"))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM parcels p WHERE p.status <> 'cancelled' AND p.packaging_total IS NOT NULL AND ABS(p.packaging_total - COALESCE((SELECT SUM(packaging_share) FROM parcel_items WHERE parcel_id = p.id), 0)) > 0.005"))[0].n, 0);
  assert.equal((await app.q(`SELECT COUNT(*) AS n FROM parcel_items pi JOIN claims c ON c.id = pi.claim_id JOIN parcels p ON p.id = pi.parcel_id
       WHERE c.joiner_id <> p.joiner_id AND NOT EXISTS (SELECT 1 FROM parcel_companions pc WHERE pc.parcel_id = p.id AND pc.joiner_id = c.joiner_id AND pc.status = 'accepted')`))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM (SELECT parcel_id FROM parcel_companions WHERE status <> 'declined' GROUP BY parcel_id HAVING COUNT(*) > 4) x"))[0].n, 0, 'never more than 5 people');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost OR cost < 0'))[0].n, 0);
});
