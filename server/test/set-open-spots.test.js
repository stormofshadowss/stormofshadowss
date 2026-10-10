import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, seed } from './helpers.js';

// Open spots in sets: cancelling claims or sets frees spots, and the next person who claims that member FILLS the earliest open spot — including one in a set the GOM has already
// secured (the set is bought, so the spot is real) — instead of starting a new set. Such a claim waits as "requested" until the GOM confirms it.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const u = (x = 'os') => `${x}${++N}`;
const newSet = async (members = ['A', 'B', 'C'], extra = {}) => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Spots GO '), proxy: 'Sam' })).json.id;
  return { go, item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: u('Spots set '), price: 4, members, ...extra })).json.id };
};
const claim = async (item, handle, members, together) => {
  const r = await app.api('POST', '/api/claims', { handle, lines: [{ itemId: item, parts: members.map((m) => ({ member: m, qty: 1 })), ...(together ? { together: true } : {}) }] });
  assert.ok([200, 201].includes(r.status), `${r.status} ${r.text}`); return r.json.placements.map((p) => `${p.member}→${p.setNumber}`).join(' ');
};
const layout = async (item) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item).map((s) => ({ id: s.id, n: s.number, d: s.decision, parts: Object.fromEntries(s.parts.map((p) => [p.member, p.handle ? `${p.handle}:${p.status}` : null])) }));
const set = async (item, n) => (await layout(item)).find((s) => s.n === n);
const claimOf = async (handle, item) => (await api('GET', `/api/admin/claims?handle=${handle}`)).json.claims.find((c) => c.item_id === item || c.label.includes('Spots set') || true && c.status !== 'cancelled');
const cancelClaim = async (handle) => { const c = (await api('GET', `/api/admin/claims?handle=${handle}`)).json.claims.find((x) => x.status !== 'cancelled'); const r = await api('PATCH', `/api/admin/claims/${c.id}`, { status: 'cancelled' }); assert.equal(r.status, 200, r.text); return c.id; };
const secure = async (id) => { const r = await api('POST', `/api/admin/sets/${id}/secure`, {}); assert.equal(r.status, 200, r.text); return r.json; };

test('CANCELLING A CLAIM in a set still waiting for your decision frees the spot, and the next person fills it (the case that always worked)', async () => {
  const { item } = await newSet(); const [p1, p2, p3] = [u(), u(), u()];
  await claim(item, p1, ['A']); await claim(item, p2, ['A']); await claim(item, p3, ['B']);               // Set 1: A,B   Set 2: A
  await cancelClaim(p1);
  assert.equal(await claim(item, u(), ['A']), 'A→1', 'back into Set 1, not Set 3');
});

test('AN OPEN SPOT IN A SECURED SET IS FILLED FIRST (your report): the new claim goes there, not into a brand-new set — and it waits as "requested"', async () => {
  const { item } = await newSet(); const [p1, p2] = [u(), u()];
  await claim(item, p1, ['A', 'B']); await claim(item, p2, ['A']);                                          // Set 1: A,B   Set 2: A
  const s1 = await set(item, 1); await secure(s1.id);                                                        // secured with C still open
  await cancelClaim(p1);                                                                                     // …and now A and B are open in the secured Set 1 too (cancel removes both? one claim each)
  const state = await layout(item); assert.equal(state[0].d, 'secured');
  const h = u(); assert.equal(await claim(item, h, ['C']), 'C→1', 'C was never taken in Set 1');
  const open = Object.entries((await set(item, 1)).parts).filter(([, v]) => !v).map(([k]) => k);
  const a = u(); const where = await claim(item, a, ['A']);
  assert.equal(where, open.includes('A') ? 'A→1' : 'A→3', `A goes to the earliest set with A free (open in Set 1: ${open})`);
  assert.equal((await set(item, 1)).parts.C, `${h}:requested`, 'the claim in the secured set is requested, not confirmed');
});

test('THE EARLIEST OPEN SPOT WINS across several sets, secured or not; a cancelled set is skipped; a full secured set sends the claim on', async () => {
  const { item } = await newSet(['A', 'B']); const hs = [u(), u(), u()];
  await claim(item, hs[0], ['A']); await claim(item, hs[1], ['A']); await claim(item, hs[2], ['A']);        // Sets 1,2,3 each have A
  const [s1, s2, s3] = await layout(item);
  await secure(s2.id);                                                                                        // Set 2 secured (B open)
  assert.equal(await claim(item, u(), ['B']), 'B→1', 'Set 1 (not secured) has B free and is earliest');
  assert.equal(await claim(item, u(), ['B']), 'B→2', 'then Set 2 — secured, B open');
  assert.equal(await claim(item, u(), ['B']), 'B→3', 'then Set 3');
  assert.equal(await claim(item, u(), ['B']), 'B→4', 'everything is full: a new set');
  const c = await api('POST', `/api/admin/sets/${s3.id}/cancel`, {}); assert.equal(c.status, 200);
  assert.equal(await claim(item, u(), ['A']), 'A→4', 'the cancelled Set 3 is never refilled; Set 4 has A free'); void s1;
});

test('"TOGETHER" claims need one set with every wanted part open — secured sets count', async () => {
  const { item } = await newSet(['A', 'B', 'C']); const [x, y] = [u(), u()];
  await claim(item, x, ['A', 'B']); await claim(item, y, ['B']);                                              // Set 1: A,B   Set 2: B
  const s1 = await set(item, 1); await secure(s1.id);                                                         // Set 1 secured; C is open there, A/B taken
  assert.equal(await claim(item, u(), ['B', 'C'], true), 'B→3 C→3', 'no set has both B and C open: Set 1 lacks B, Set 2 lacks B — a new set');
  assert.equal(await claim(item, u(), ['C', 'A'], true), 'A→2 C→2', 'A is taken in Set 1, so C+A together go to Set 2, where both are free');
});

test('THE GOM CONFIRMS THEM: "Secure all requested" and a single confirm include a request in an already-secured set, never one in a set still waiting; the person is told and credit is applied', async () => {
  const { go, item } = await newSet(['A', 'B']); const [p1, h] = [u(), u()];
  await claim(item, p1, ['A']); const s1 = await set(item, 1); await secure(s1.id);                          // Set 1 secured, B open
  const where = await claim(item, h, ['B']); assert.equal(where, 'B→1');
  assert.equal((await api('POST', '/api/admin/credit/add', { handle: h, amount: 4, reason: 'goodwill' })).status, 200);   // they now exist, and have £4 credit
  const mine = (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims[0];
  assert.deepEqual([mine.status, mine.setDecision], ['requested', 'secured'], 'the admin list says its set is already secured');
  // a request in a set still waiting for a decision is left alone
  const other = await newSet(['A', 'B']); const oh = u(); await claim(other.item, oh, ['A']); await claim(other.item, u(), ['B']);
  const single = await api('PATCH', `/api/admin/claims/${(await api('GET', `/api/admin/claims?handle=${oh}`)).json.claims[0].id}`, { status: 'confirmed' });
  assert.equal(single.status, 400); assert.equal(single.json.code, 'set_part');
  const r = await api('POST', '/api/admin/claims/secure', { orderId: go }); assert.equal(r.status, 200); assert.equal(r.json.secured, 1, 'only that one');
  const after = (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims[0]; assert.equal(after.status, 'confirmed');
  assert.deepEqual([after.costs.initials.cost, after.costs.initials.paid], [4, 4], 'owed £4, covered by the credit they already had');
  const left = await api('POST', '/api/admin/claims/secure', { orderId: other.go }); assert.equal(left.json.secured, 0, 'the unsecured set\'s parts are still left for the Sets screen');
  // single confirm works for a secured-set request
  const { item: i3 } = await newSet(['A', 'B']); await claim(i3, u(), ['A']); await secure((await set(i3, 1)).id); const h3 = u(); await claim(i3, h3, ['B']);
  const c3 = (await api('GET', `/api/admin/claims?handle=${h3}`)).json.claims[0];
  assert.equal((await api('PATCH', `/api/admin/claims/${c3.id}`, { status: 'confirmed' })).status, 200); assert.equal((await set(i3, 1)).parts.B, `${h3}:confirmed`);
});

test('A REQUEST IN A SECURED SET can still be cancelled by the person or the GOM, and the spot opens again', async () => {
  const { item } = await newSet(['A', 'B']); await claim(item, u(), ['A']); await secure((await set(item, 1)).id);
  const h = u(); await claim(item, h, ['B']); assert.equal((await set(item, 1)).parts.B, `${h}:requested`);
  await cancelClaim(h); assert.equal((await set(item, 1)).parts.B, null, 'open again');
  assert.equal(await claim(item, u(), ['B']), 'B→1');
});

test('THE SHOP\'S PUBLIC DATA lists secured sets with what is taken, so what people are shown matches where claims really go', async () => {
  const { go, item } = await newSet(['A', 'B']); await claim(item, u(), ['A']); await secure((await set(item, 1)).id); await claim(item, u(), ['A']);
  const pub = (await fetch(`${app.base}/api/orders`).then((r) => r.json())).orders.find((o) => o.id === go).items.find((i) => i.id === item);
  assert.deepEqual(pub.sets.map((s) => [s.number, s.decision, [...s.taken].sort()]), [[1, 'secured', ['A']], [2, 'none', ['A']]]);
  assert.ok(pub.sets.every((s) => s.taken.every((m) => typeof m === 'string')), 'member names only — never who holds them');
});

test('CONCURRENCY: many people claiming the same member while the GOM secures, cancels and assigns in that set → no server errors, and no part is ever held twice', async () => {
  for (let round = 0; round < 4; round++) {
    const { item } = await newSet(['A', 'B']); const seed1 = u(); await claim(item, seed1, ['A']);
    const s1 = await set(item, 1);
    const ops = [...Array.from({ length: 6 }, () => app.api('POST', '/api/claims', { handle: u('race'), lines: [{ itemId: item, parts: [{ member: 'B', qty: 1 }] }] })),
      api('POST', `/api/admin/sets/${s1.id}/secure`, {}), api('POST', `/api/admin/claims/secure`, { orderId: undefined, claimIds: [1] }),
      api('POST', `/api/admin/sets/${s1.id}/slots`, { member: 'B', handle: u('hand') })];
    const rs = await Promise.all(ops);
    assert.ok(rs.every((r) => r.status < 500), `round ${round}: ${rs.map((r) => r.status)}`);
    const dup = await app.q('SELECT COUNT(*) AS n FROM (SELECT set_id, member_name FROM set_slots GROUP BY set_id, member_name HAVING COUNT(*) > 1) d'); assert.equal(dup[0].n, 0, 'no set holds the same part twice');
    const orphan = await app.q("SELECT COUNT(*) AS n FROM claims c LEFT JOIN set_slots s ON s.id = c.slot_id WHERE c.set_id IS NOT NULL AND c.status <> 'cancelled' AND s.id IS NULL"); assert.equal(orphan[0].n, 0, 'every live set claim has its slot');
  }
});

// The shop previews placement with its OWN copy of the rule (public/site/shop.js). If it ever drifts from the server's, people are told one set and get another.
// So: run random mixes of claim / secure / cancel-a-claim / cancel-a-set, and before every claim compare the shop's preview (using only what the public API shows) with where the server really puts it.
const shopSrc = fs.readFileSync(new URL('../../public/site/shop.js', import.meta.url), 'utf8');
const planSet = new Function(`${shopSrc.match(/function planSet\([\s\S]*?\n  \}\n/)[0]}\nreturn planSet;`)();
test('THE SHOP\'S PREVIEW ALWAYS MATCHES WHERE THE SERVER REALLY PUTS CLAIMS — across random mixes of claims, secures, cancelled claims and cancelled sets', async () => {
  let seedN = 12345; const rnd = (n) => { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN % n; };
  const roster = ['A', 'B', 'C', 'D']; let checked = 0;
  for (let round = 0; round < 6; round++) {
    const { go, item } = await newSet(roster); const live = [];
    for (let step = 0; step < 28; step++) {
      const roll = rnd(100), cur = (await api('GET', '/api/admin/sets')).json.sets.filter((x) => x.itemId === item);
      if (roll < 62 || !cur.length) {
        const k = 1 + rnd(3), want = []; for (let i = 0; i < k; i++) want.push(roster[rnd(roster.length)]);
        const together = rnd(2) === 1, parts = roster.flatMap((n) => Array(want.filter((x) => x === n).length).fill(n));
        const pub = (await fetch(`${app.base}/api/orders`).then((r) => r.json())).orders.find((o) => o.id === go).items.find((i) => i.id === item);
        const open = pub.sets.filter((x) => x.decision !== 'cancelled'), maxAll = Math.max(0, ...pub.sets.map((x) => x.number));
        const preview = planSet(roster, parts, together && parts.length > 1, open.map((x) => x.taken)).map((x) => `${x.member}→${x.setIdx >= open.length ? maxAll + (x.setIdx - open.length) + 1 : open[x.setIdx].number}`).sort();
        const h = u('par'); const counts = {}; want.forEach((m) => { counts[m] = (counts[m] || 0) + 1; });
        const r = await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: item, parts: Object.entries(counts).map(([member, qty]) => ({ member, qty })), ...(together ? { together: true } : {}) }] });
        assert.ok([200, 201].includes(r.status), r.text);
        assert.deepEqual(r.json.placements.map((x) => `${x.member}→${x.setNumber}`).sort(), preview, `round ${round} step ${step}: preview ≠ reality`); checked++; live.push(h);
      } else if (roll < 74) { const open = cur.filter((x) => x.decision === 'none' && x.filled > 0 && !x.hasRequests); if (open.length) await api('POST', `/api/admin/sets/${open[rnd(open.length)].id}/secure`, {}); }
      else if (roll < 92) { if (live.length) { const h = live.splice(rnd(live.length), 1)[0]; const c = (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims.filter((x) => x.status !== 'cancelled'); for (const x of c) await api('PATCH', `/api/admin/claims/${x.id}`, { status: 'cancelled' }); } }
      else { const target = cur.filter((x) => x.decision !== 'cancelled'); if (target.length) await api('POST', `/api/admin/sets/${target[rnd(target.length)].id}/cancel`, {}); }
    }
  }
  assert.ok(checked > 60, `${checked} claims compared`);
});
