import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { openPage, gomPage, modal, press, toast } from './ui.helpers.js';

// What people see while claiming a set member: where each part's next free spot is, a collapsed grid of the sets (secured ones included), and a "where they'll go" that matches reality.
// And what the GOM sees for the new requests that fill a spot in an already-secured set.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const u = (x = 'ss') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newSet = async (members = ['A', 'B', 'C'], status) => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Spots shop GO '), proxy: 'Sam', ...(status ? { status } : {}) })).json.id;
  return { go, item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: 'Photocard set', price: 4, members })).json.id };
};
const claim = async (item, handle, members) => { const r = await app.api('POST', '/api/claims', { handle, lines: [{ itemId: item, parts: members.map((m) => ({ member: m, qty: 1 })) }] }); assert.ok([200, 201].includes(r.status), r.text); return r.json.placements.map((p) => `${p.member}→${p.setNumber}`).join(' '); };
const sets = async (item) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item);
const secure = async (item, n) => { const s = (await sets(item)).find((x) => x.number === n); assert.equal((await api('POST', `/api/admin/sets/${s.id}/secure`, {})).status, 200); };
const shop = async (go) => { const p = await openPage(app, '/'); p.window.location.hash = `#/order/${go}`; await sleep(80); await p.settle(); return p; };
const hint = (p, name) => p.text(p.q(`.opt[data-opt="${name}"] [data-spot]`));
const press1 = async (p, item, member) => { await p.click(p.q(`[data-act="inc"][data-item="${item}"][data-member="${member}"]`)); await sleep(30); };

async function scenario() {                                                                  // Set 1 (secured): A,B taken, C open.  Set 2: A taken.
  const s = await newSet(); await claim(s.item, u(), ['A']); await claim(s.item, u(), ['B']); await claim(s.item, u(), ['A']);
  await secure(s.item, 1); return s;
}

test('EACH MEMBER SHOWS WHERE ITS NEXT FREE SPOT IS before you click anything — secured sets included — and "next one starts a new set" when every set has it', async () => {
  const { go } = await scenario(); const p = await shop(go);
  assert.equal(hint(p, 'A'), 'next one starts a new set', 'A is taken in both sets');
  assert.equal(hint(p, 'B'), 'open in Set 2'); assert.equal(hint(p, 'C'), 'open in Set 1, 2', 'Set 1 is secured but C is open there, so it counts');
  assert.match(p.text(p.q('.opt[data-opt="C"]')), /\$?£4\.00 · 0 claimed · open in Set 1, 2/);
  assert.deepEqual(p.errors, []); p.close();
});

test('THE DOT MAP IS ALWAYS VISIBLE: a row per set with room (secured ones marked), a dot per part — ringed = open, filled = taken (RED in a secured set — never green, which could read as open) — "N of M taken", and the open members written out', async () => {
  const { go } = await scenario(); const p = await shop(go);                                                   // Set 1 (secured): A,B taken, C open.  Set 2: A taken.
  assert.ok(p.q('.spotmap'), 'there with no clicking'); assert.equal(p.q('details.setgrid'), null, 'no more folded table'); assert.match(p.text(p.q('.spotmap .row')), /Where the open spots are\s*open\s*taken/);
  const rows = p.qa('.spotrow').map((r) => ({ set: r.dataset.set, title: p.text(r.querySelector('strong')), dots: p.qa('.dot', r.querySelector('.dots')).map((d) => d.classList.contains('free') ? 'open' : d.classList.contains('lock') ? 'taken-secured' : 'taken'), count: p.text(r.querySelector('[data-count]')), open: p.text(r.querySelector('[data-open-names]')), secured: !!r.querySelector('.pill.ok') }));
  assert.deepEqual(rows, [{ set: '1', title: 'Set 1', dots: ['taken-secured', 'taken-secured', 'open'], count: '2 of 3 taken', open: 'Open: C', secured: true }, { set: '2', title: 'Set 2', dots: ['taken', 'open', 'open'], count: '1 of 3 taken', open: 'Open: B, C', secured: false }]);
  assert.deepEqual(p.qa('.spotrow')[1].querySelectorAll('.dot').length, 3, 'one dot per part, in the same order as the members'); assert.equal(p.q('.spotrow .dots').getAttribute('aria-label'), '2 of 3 taken'); assert.equal(p.q('.spotrow [data-open]').title, 'C — open', 'hover/tap names the dot');
  assert.equal(p.q('.spotmap .dot.ok'), null, 'no green dots on the joiner page'); assert.match(p.text(p.q('.spotmap .legend')), /open\s*taken\s*taken, set secured/, 'the legend explains the red'); assert.equal(p.qa('.spotrow')[1].querySelectorAll('.dot.lock').length, 0, 'taken in an unsecured set stays grey');
  assert.match(p.text(p.q('.spotmap')), /A part you claim goes in the earliest set where it's open\. Sets marked secured are already bought — a spot there is confirmed by the GOM after you claim it\./);
  await press1(p, p.q('[data-spotmap]').dataset.spotmap, 'C'); assert.ok(p.q('.spotmap'), 'still there after the page redraws'); assert.equal(p.qa('.spotrow').length, 2); p.close();
});

test('"WHERE THEY\'LL GO" COUNTS SECURED SETS, SAYS SO, AND MATCHES WHERE THE CLAIM REALLY GOES', async () => {
  const { go, item } = await scenario(); const p = await shop(go);
  await press1(p, item, 'C'); await press1(p, item, 'B');
  const t = p.text(p.q('[data-item], .card')) && p.text(p.qa('.sub').find((x) => /Where they'll go/.test(p.text(x))));
  assert.match(t, /Set 1 \(already secured — the GOM confirms yours\): C · Set 2: B/);
  const real = await claim(item, u(), ['C', 'B']); assert.equal(real, 'B→2 C→1', 'the same as the preview: C in the secured Set 1, B in Set 2');
  p.close();
});

test('MANY SETS STAY READABLE: the first 5 sets with room, then "Show N more sets" (and "Show fewer"); a cancelled set and full sets never appear; hints are shortened', async () => {
  const s = await newSet(['A', 'B']); for (let i = 0; i < 24; i++) await claim(s.item, u(), ['A']);          // 24 sets, each with A taken and B open
  await claim(s.item, u(), ['B']);                                                                           // fills B in Set 1 → Set 1 is full
  const set3 = (await sets(s.item)).find((x) => x.number === 3); assert.equal((await api('POST', `/api/admin/sets/${set3.id}/cancel`, {})).status, 200);
  const p = await shop(s.go); const nums = () => p.qa('.spotrow').map((r) => r.dataset.set); const btn = () => p.q('[data-act="moresets"]');
  assert.equal(p.q('.dot.lock'), null, 'no secured set → no red dots'); assert.doesNotMatch(p.text(p.q('.spotmap .legend')), /secured/, 'and no red entry in the legend');
  assert.deepEqual(nums(), ['2', '4', '5', '6', '7'], 'the first five sets with room — no Set 1 (full), no Set 3 (cancelled)'); assert.equal(p.text(btn()), 'Show 17 more sets', '22 sets with room − 5 shown'); assert.match(p.text(p.q('.spotmap')), /1 full set not shown\./);
  await p.click(btn()); assert.equal(nums().length, 22, 'all of them'); assert.equal(p.text(btn()), 'Show fewer sets'); assert.equal(nums()[0], '2');
  await press1(p, s.item, 'B'); assert.equal(nums().length, 22, 'stays expanded while you press buttons (the page redraws)');
  await p.click(btn()); assert.equal(nums().length, 5, 'and "Show fewer sets" folds it back'); assert.equal(hint(p, 'B'), 'open in Set 2, 4, 5 +19 more'); assert.equal(hint(p, 'A'), 'next one starts a new set'); p.close();
});

test('A HUGE NUMBER OF SETS IS CAPPED (40 rows once expanded, the rest counted); a set size with only a few sets shows no "show more" button', async () => {
  const big = await newSet(['A', 'B']); for (let i = 0; i < 44; i++) await claim(big.item, u(), ['A']); const p = await shop(big.go); await p.click(p.q('[data-act="moresets"]')); assert.equal(p.qa('.spotrow').length, 40); assert.match(p.text(p.q('.spotmap')), /…and 4 more sets with room\./); p.close();
  const small = await newSet(['A', 'B']); for (let i = 0; i < 5; i++) await claim(small.item, u(), ['A']); const q = await shop(small.go); assert.equal(q.qa('.spotrow').length, 5); assert.equal(q.q('[data-act="moresets"]'), null, 'five sets: nothing to expand'); q.close();
});

test('WHEN EVERY SET IS FULL the map says so plainly and shows no rows; the member tiles still say a new set will start', async () => {
  const s = await newSet(['A']); await claim(s.item, u(), ['A']); await claim(s.item, u(), ['A']); const p = await shop(s.go); assert.equal(p.qa('.spotrow').length, 0); assert.match(p.text(p.q('.spotmap')), /Every set so far is full — a new one starts when you claim\./); assert.equal(hint(p, 'A'), 'next one starts a new set'); p.close();
});

test('CLOSED ORDERS show no hints or map; member names with HTML are shown as text (in the dots\' tooltips and the open list)', async () => {
  const closed = await newSet(['A', 'B'], 'closed'); await claim(closed.item, u(), ['A']).catch(() => {}); const pc = await shop(closed.go);
  assert.equal(pc.q('[data-spot]'), null); assert.equal(pc.q('.spotmap'), null); pc.close();
  const s = await newSet(['<b>x</b>', 'B']); await claim(s.item, u(), ['B']); const p = await shop(s.go);
  assert.equal(p.q('.spotmap b'), null); assert.match(p.text(p.q('[data-open-names]')), /Open: <b>x<\/b>/); assert.equal(p.q('.spotrow [data-open]').title, '<b>x</b> — open'); p.close();
});

test('FOR THE GOM: a new request that filled a spot in a secured set shows on the Sets tab (and its badge), and one button confirms it — the person owes from then on', async () => {
  const { go, item } = await scenario();
  const h = u('new'); await claim(item, h, ['C']);                                                           // fills the open C in the secured Set 1
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Sets')); await sleep(80); await p.settle();
  await p.click(p.byText('#setChips .chip', 'Secured')); await sleep(60);
  const card = () => p.q(`[data-set="${(sets_.find((x) => x.number === 1)).id}"]`);
  var sets_ = await sets(item);
  assert.match(p.text(card()), /1 new request waiting/);
  if (!p.q('table', card())) await p.click(p.q('[data-act="toggle-set"]', card())); assert.match(p.text(card()), new RegExp(`C.*@${h}.*requested`, 's'));
  assert.match(p.text(p.byText('#tabs button', 'Sets')), /\d/, 'the tab badge counts it');
  await p.click(p.q('[data-act="confirm-new"]', card()));
  assert.match(p.text(modal(p)), /Confirm 1 new request in Photocard set — Set 1\?.*already secured.*becomes? a confirmed claim|each becomes a confirmed claim/s);
  await press(p, 'Not yet'); assert.equal((await sets(item)).find((x) => x.number === 1).parts.find((x) => x.member === 'C').status, 'requested', 'not yet means not yet');
  await p.click(p.q('[data-act="confirm-new"]', card())); await press(p, 'Confirm'); await sleep(120); await p.settle();
  assert.match(toast(p), /Confirmed 1 claim\./);
  assert.equal((await sets(item)).find((x) => x.number === 1).parts.find((x) => x.member === 'C').status, 'confirmed');
  assert.equal(p.q('[data-new-requests]', card()), null, 'nothing waiting on this set any more'); void go;
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('FOR THE GOM: the Claims tab counts such a request as "waiting to be secured" and "Secure all requested" confirms it — a request in a set still waiting for a decision is not counted that way', async () => {
  const { go, item } = await scenario(); const h = u('cl'); await claim(item, h, ['C']);                   // joins secured Set 1 → secure-able
  await claim(item, u(), ['B']);                                                                              // joins Set 2 (unsecured) → waits on the set
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); await sleep(80); await p.settle();
  await p.choose(p.q('[data-filter="order"]'), String(go)); await sleep(100); await p.settle();
  const card = p.qa('.card').find((c) => /Spots shop GO/.test(p.text(c)) && c.querySelector('[data-act="secure"]'));
  assert.match(p.text(card), /1 waiting to be secured/); assert.match(p.text(card.querySelector('[data-act="secure"]')), /Secure all requested \(1\)/);
  await p.click(card.querySelector('[data-act="secure"]')); await press(p, 'Secure'); await sleep(150); await p.settle();
  assert.equal((await sets(item)).find((x) => x.number === 1).parts.find((x) => x.member === 'C').status, 'confirmed');
  assert.equal((await sets(item)).find((x) => x.number === 2).parts.find((x) => x.member === 'B').status, 'requested', 'the unsecured set\'s part is untouched');
  p.close();
});
