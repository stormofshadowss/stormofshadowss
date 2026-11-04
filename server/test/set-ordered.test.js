import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { STAGES } from '../src/lib/incoming.js';

// A set is "ORDERED" (it moves off the Sets tab's "Secured" list) when it is SECURED, FULL, and every claim in it is at "ordered via proxy / warehouse" or any LATER stage. Worked out from the claims' stages each time.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const u = (x = 'so') => `${x}${++N}`;
const newSet = async (members = ['A', 'B']) => { const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Ordered GO '), proxy: 'Sam' })).json.id; return (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: u('Ordered set '), price: 4, members })).json.id; };
const claim = async (item, handle, members) => { const r = await app.api('POST', '/api/claims', { handle, allowDuplicates: true, lines: [{ itemId: item, parts: members.map((m) => ({ member: m, qty: 1 })) }] }); assert.equal(r.status, 201, r.text); };
const theSet = async (item, n = 1) => (await api('GET', '/api/admin/sets')).json.sets.find((s) => s.itemId === item && s.number === n);
const secure = async (item, n = 1) => { const s = await theSet(item, n); const r = await api('POST', `/api/admin/sets/${s.id}/secure`, {}); assert.equal(r.status, 200, r.text); };
const stage = async (claimIds, pipeline) => { for (const id of claimIds) assert.equal((await api('PATCH', `/api/admin/claims/${id}`, { pipeline })).status, 200); };
const ids = async (item, n = 1) => (await theSet(item, n)).parts.filter((p) => p.claimId).map((p) => p.claimId);
const fullSecured = async () => { const item = await newSet(); await claim(item, u(), ['A']); await claim(item, u(), ['B']); await secure(item); return item; };
const ordered = async (item, n = 1) => (await theSet(item, n)).ordered;

test('THE RULE: not ordered while any claim is still "awaiting fulfillment"; ordered once EVERY claim is "ordered via proxy / warehouse"; and it stays ordered at every later stage; it goes back if a claim goes back', async () => {
  const item = await fullSecured(); const c = await ids(item); assert.equal(await ordered(item), false, 'secured and full, but nothing ordered yet');
  await stage([c[0]], 'ordered via proxy / warehouse'); assert.equal(await ordered(item), false, 'one of the two is not ordered');
  await stage([c[1]], 'ordered via proxy / warehouse'); assert.equal(await ordered(item), true); assert.deepEqual((await theSet(item)).parts.map((p) => p.pipeline), ['ordered via proxy / warehouse', 'ordered via proxy / warehouse'], 'each part carries its claim\'s stage');
  for (const s of STAGES.slice(STAGES.indexOf('ordered via proxy / warehouse'))) { await stage(c, s); assert.equal(await ordered(item), true, `still ordered at "${s}"`); }
  await stage([c[1]], 'awaiting fulfillment'); assert.equal(await ordered(item), false, 'back in "Secured" if a claim is moved back');
});

test('MIXED STAGES: one claim well past "ordered" and one still awaiting is NOT ordered', async () => {
  const item = await fullSecured(); const c = await ids(item); await stage([c[0]], 'shipped'); await stage([c[1]], 'awaiting fulfillment'); assert.equal(await ordered(item), false);
});

test('IT MUST BE FULL: a secured set with an open part is not ordered even if every claim in it is; filling the gap (and ordering it) makes it ordered; an open part held for a raffle counts as open', async () => {
  const item = await newSet(['A', 'B']); await claim(item, u(), ['A']); await secure(item); const c = await ids(item); await stage(c, 'ordered via proxy / warehouse'); assert.equal(await ordered(item), false, 'B is still open');
  const s = await theSet(item); const add = await api('POST', `/api/admin/sets/${s.id}/slots`, { member: 'B', handle: u('late') }); assert.ok([200, 201].includes(add.status), add.text); assert.equal(await ordered(item), false, 'the new claim is not ordered yet'); await stage(await ids(item), 'ordered via proxy / warehouse'); assert.equal(await ordered(item), true);
  const item2 = await newSet(['A', 'B']); await claim(item2, u(), ['A']); await secure(item2); await stage(await ids(item2), 'ordered via proxy / warehouse'); const s2 = await theSet(item2); const sp = await api('POST', `/api/admin/sets/${s2.id}/split`, { member: 'B' }); assert.equal(sp.status, 200, sp.text); assert.equal((await theSet(item2)).ordered, false, 'a part held for a raffle has no holder yet: not full');
});

test('ONLY A SECURED SET CAN BE ORDERED: an undecided set, a cancelled set and a claim still waiting as "requested" never count', async () => {
  const item = await newSet(); await claim(item, u(), ['A']); await claim(item, u(), ['B']); const c = await ids(item); await app.q("UPDATE claims SET pipeline = 'ordered via proxy / warehouse' WHERE id IN (?)", [c]); assert.equal(await ordered(item), false, 'not secured: never ordered, whatever the stages say');
  await secure(item); assert.equal(await ordered(item), true); const s = await theSet(item); assert.equal((await api('POST', `/api/admin/sets/${s.id}/cancel`, {})).status, 200); assert.equal((await theSet(item)).ordered, false, 'cancelled');
  const item2 = await newSet(); await claim(item2, u(), ['A']); await secure(item2); await claim(item2, u(), ['B']); await stage((await ids(item2)).slice(0, 1), 'ordered via proxy / warehouse'); const waiting = (await theSet(item2)).parts.find((p) => p.member === 'B'); assert.equal(waiting.status, 'requested'); assert.equal((await theSet(item2)).ordered, false, 'a request waiting in a secured set is not ordered'); await app.q("UPDATE claims SET pipeline = 'ordered via proxy / warehouse' WHERE id = ?", [waiting.claimId]); assert.equal((await theSet(item2)).ordered, false, 'even if its stage said ordered, a request that is not secured is not');
});
