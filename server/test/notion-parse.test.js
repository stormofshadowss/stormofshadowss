import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, parseQty, parseDate, parseNotionClaims, suggestHandle, allocatePaid, buildPlan, DEFAULT_STATUS, STAGES, ImportError } from '../src/lib/notion-import.js';
import { row, csv } from './notion.fixture.js';

const plan = (rows, mapping = {}, existing = {}) => buildPlan(parseNotionClaims(csv(rows)).rows, { scope: 'all', ...mapping }, existing);

test('money: £ amounts, negatives, thousands separators, blanks — and nonsense is flagged rather than guessed', () => {
  assert.deepEqual(['£10.50', '-£9.99', '£1,234.50', '£0.00', '', '  £7 ', '£.50'].map(parseMoney), [10.5, -9.99, 1234.5, 0, null, 7, 0.5]);
  assert.ok(Number.isNaN(parseMoney('about £5')));
  assert.ok(Number.isNaN(parseMoney('£5.555x')));
});
test('quantity and dates: "3.0", blanks, and Notion\'s "26 March 2026" — impossible dates are flagged', () => {
  assert.deepEqual(['3.0', '1', '', '2.5'].map(parseQty), [3, 1, null, 2.5]);
  assert.ok(Number.isNaN(parseQty('lots')));
  assert.deepEqual(['26 March 2026', '1 January 2027', '', ' 7 october 2026 '].map(parseDate), ['2026-03-26', '2027-01-01', null, '2026-10-07']);
  for (const bad of ['31 February 2026', '26/03/2026', '2026-03-26', 'Marchy 5 2026']) assert.ok(Number.isNaN(parseDate(bad)), bad);
});

test('reading the file: quotes, line breaks inside a cell, a byte-order mark, and Notion\'s "(https://…)" link text are all handled', () => {
  const text = csv([row({ item: 'Line one\nLine two "quoted"', go: 'Run It GO', relation: 'Amy K' })], { bom: true });
  const { rows } = parseNotionClaims(text);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].item, rows[0].go, rows[0].relation, rows[0].joiner, rows[0].n], ['Line one Line two "quoted"', 'Run It GO', 'Amy K', 'amy_k', 2]);
});

test('a file that is not the right export is refused with a clear reason', () => {
  assert.throws(() => parseNotionClaims(''), ImportError);
  assert.throws(() => parseNotionClaims('Joiner,Item\nbob,thing\n'), (e) => e instanceof ImportError && /missing: GO, Order Status, Initials, Amount Paid.*_all\.csv/.test(e.message));
  assert.throws(() => parseNotionClaims('not,a\n"unterminated'), ImportError);
  assert.throws(() => parseNotionClaims('Joiner,GO,Item,Order Status,Initials,Amount Paid\n'), /no rows/);
  const ok = parseNotionClaims('Joiner,GO,Item,Order Status,Initials,Amount Paid\nbob,"Some GO (https://x.y/z)",thing,Completed,£5.00,£5.00\n');
  assert.equal(ok.rows[0].go, 'Some GO', 'the optional columns really are optional');
});

test('handles: plain ones pass; spaces, brackets and @ are tidied and flagged for a human look; unusable ones are refused', () => {
  assert.deepEqual(suggestHandle('Amy_K'), { handle: 'amy_k', confident: true, why: '' });
  assert.deepEqual(suggestHandle('@amy.k'), { handle: 'amy.k', confident: true, why: '' });
  assert.deepEqual([suggestHandle('lexie cole').handle, suggestHandle('lexie cole').confident], ['lexiecole', false]);
  const br = suggestHandle('Chanified_4Life (Jenn)');
  assert.deepEqual([br.handle, br.confident, br.why], ['chanified_4life', false, 'has brackets — took the part before them']);
  assert.equal(suggestHandle('').handle, null); assert.equal(suggestHandle('😀😀').handle, null);
  assert.equal(suggestHandle('a'.repeat(31)).confident, false);
  assert.equal(suggestHandle(`${'a'.repeat(25)} ${'b'.repeat(10)}`).handle, null, 'too long once tidied');
});

test('paying: a payment is spread over the costs in the site\'s own order, never over-filling a cost; the rest is "excess"', () => {
  const costs = { initials: 10, ems: 5, customs: 3, doms: 2, packaging: 1 };
  assert.deepEqual(allocatePaid(costs, 14), { alloc: { initials: 10, ems: 4, customs: 0, doms: 0, packaging: 0 }, excess: 0 });
  assert.deepEqual(allocatePaid(costs, 21).alloc, costs);
  assert.deepEqual(allocatePaid(costs, 25), { alloc: costs, excess: 4 });
  assert.deepEqual(allocatePaid(costs, 0).alloc, { initials: 0, ems: 0, customs: 0, doms: 0, packaging: 0 });
  assert.deepEqual(allocatePaid({ initials: 0.1, ems: 0.2, customs: 0, doms: 0, packaging: 0 }, 0.3), { alloc: { initials: 0.1, ems: 0.2, customs: 0, doms: 0, packaging: 0 }, excess: 0 }, 'pennies stay exact');
});

test('every Notion status has a destination, and every destination is a real stage', () => {
  for (const [k, v] of Object.entries(DEFAULT_STATUS)) assert.ok(v === 'cancelled' || STAGES.includes(v), `${k} → ${v}`);
  const statuses = ['Awaiting Fulfilment', 'Ordered via Proxy', 'Ordered Via Warehouse', 'Ordered (UK)', '@ Proxy', 'Shipping Requested', 'Enroute to GOM', 'Ready To Pack / On Hand with GOM', 'Shipping to you', 'Completed', 'Cancelled - Sold Out', 'Cancelled - Joiner Request'];
  const p = plan(statuses.map((s, i) => row({ joiner: `p${i}`, item: `I${i}`, status: s })));
  assert.deepEqual(p.claims.map((c) => [c.status, c.pipeline]), [['confirmed', 'awaiting fulfillment'], ['confirmed', 'ordered via proxy / warehouse'], ['confirmed', 'ordered via proxy / warehouse'], ['confirmed', 'ordered via proxy / warehouse'],
    ['confirmed', 'arrived at proxy / warehouse'], ['confirmed', 'shipping requested'], ['confirmed', 'enroute to GOM'], ['confirmed', 'ready to pack / on hand'], ['confirmed', 'shipped'], ['confirmed', 'completed'],
    ['cancelled', 'awaiting fulfillment'], ['cancelled', 'awaiting fulfillment']]);
  assert.equal(p.report.ok, true);
});

test('an unknown status stops the import until the GOM says what it means — one decision however it is capitalised — and then it flows through', () => {
  const rows = [row({ joiner: 'amy_k', status: 'Lost in the post' }), row({ joiner: 'bob', item: 'B', status: 'lost in the post ' }), row({ joiner: 'cat', item: 'C' })];
  const p = plan(rows);
  assert.equal(p.report.ok, false);
  assert.deepEqual(p.report.blockers.unknownStatuses, [{ raw: 'Lost in the post', count: 2 }]);
  assert.equal(p.claims.length, 1, 'only the recognised row is planned meanwhile');
  const fixed = plan(rows, { statuses: { 'Lost in the post': 'cancelled' } });
  assert.equal(fixed.report.ok, true); assert.deepEqual(fixed.claims.map((c) => c.status).sort(), ['cancelled', 'cancelled', 'confirmed']);
});

test('people: plain handles are accepted; tidied ones wait for a decision (their rows are held back); the GOM can fix, merge or skip them', () => {
  const rows = [row({ joiner: 'Amy_K' }), row({ joiner: 'lexie cole', item: 'B' }), row({ joiner: 'lexie cole', item: 'C' }), row({ joiner: 'Chanified_4Life (Jenn)', item: 'D' }), row({ joiner: '', item: 'E' })];
  const p = plan(rows);
  assert.deepEqual(p.report.blockers.unresolvedPeople, [{ raw: 'lexie cole', count: 2 }, { raw: 'Chanified_4Life (Jenn)', count: 1 }]);
  assert.equal(p.report.ok, false);
  assert.equal(p.report.skipped.noJoiner, 1, 'a row with no joiner at all is left out and counted');
  assert.deepEqual(p.people.map((x) => x.handle), ['amy_k']);
  const fixed = plan(rows, { people: { 'lexie cole': 'lexie_cole', 'Chanified_4Life (Jenn)': '' } });
  assert.equal(fixed.report.ok, true);
  assert.deepEqual(fixed.people.map((x) => [x.handle, x.claims]), [['amy_k', 1], ['lexie_cole', 2]], 'two spellings of one person become one; a skipped person\'s rows are dropped');
  const merged = plan([row({ joiner: 'Amy_K' }), row({ joiner: 'amy_k', item: 'B' }), row({ joiner: '@AMY_K', item: 'C' })]);
  assert.deepEqual(merged.people.map((x) => [x.handle, x.claims]), [['amy_k', 3]], 'case and @ never create a second person');
});

test('scope: ongoing, history (completed and cancelled), or everything', () => {
  const rows = [row({ item: 'A', status: 'Ordered via Proxy' }), row({ item: 'B', status: 'Completed' }), row({ item: 'C', status: 'Cancelled - Sold Out' }), row({ item: 'D', status: 'Shipping to you' })];
  const n = (scope) => plan(rows, { scope }).claims.map((c) => c.itemFull).sort();
  assert.deepEqual([n('ongoing'), n('history'), n('all')], [['A', 'D'], ['B', 'C'], ['A', 'B', 'C', 'D']]);
  assert.equal(plan(rows, { scope: 'ongoing' }).report.skipped.outOfScope, 2);
});

test('costs and payments: all five cost types kept, what was paid is spread over them, and money totals reconcile', () => {
  const p = plan([row({ initials: 10, ems: 5, customs: 3, doms: 2, packing: 1, paid: 14 })]);
  const c = p.claims[0];
  assert.deepEqual(c.costs, { initials: 10, ems: 5, customs: 3, doms: 2, packaging: 1 });
  assert.deepEqual(c.alloc, { initials: 10, ems: 4, customs: 0, doms: 0, packaging: 0 });
  assert.deepEqual(p.report.money, { due: 21, paid: 14, owed: 7, excess: 0 });
});

test('overpaid and negative amounts are flagged for the GOM, never silently turned into money', () => {
  const p = plan([row({ joiner: 'over', initials: 10, paid: 12.5 }), row({ joiner: 'neg', item: 'Refunded thing', initials: -293.05, paid: 0, status: 'Awaiting Fulfilment' }), row({ joiner: 'neg2', item: 'X', initials: -5, ems: 2, paid: 1 })]);
  assert.deepEqual(p.report.attention.excess.map((x) => [x.handle, x.amount]), [['over', 2.5]]);
  assert.deepEqual(p.report.attention.negatives.map((x) => [x.handle, x.amount, x.what]), [['neg', -293.05, 'initials'], ['neg2', -5, 'initials']]);
  assert.deepEqual(p.claims.map((c) => c.costs.initials), [10, 0, 0], 'a negative cost is imported as £0 — the site has no negative costs');
  assert.deepEqual(p.claims[2].alloc, { initials: 0, ems: 1, customs: 0, doms: 0, packaging: 0 });
  assert.equal(p.report.money.excess, 2.5);
});

test('quantity: one claim per row, labelled "(×3)"; blank or zero counts as 1 with a warning; fractions are kept as written', () => {
  const p = plan([row({ item: 'A', qty: 3 }), row({ item: 'B', qty: 1 }), row({ item: 'C', qty: null }), row({ item: 'D', qty: 0 }), row({ item: 'E', qty: 2.5 })]);
  assert.deepEqual(p.claims.map((c) => c.label), ['A (×3)', 'B', 'C', 'D', 'E (×2.5)']);
  const w = p.report.warnings.map((x) => x.text).join(' | ');
  assert.match(w, /no quantity — counted as 1/); assert.match(w, /quantity 0 — counted as 1/); assert.match(w, /fractional quantity 2\.5/);
});

test('long item names: shortened on the claim and the item, with the full text kept in the item\'s description', () => {
  const long = `Stray Kids ${'very long benefit name '.repeat(15)}`.trim();
  const p = plan([row({ item: long, qty: 4 })]);
  const c = p.claims[0], it = p.orders[0].items[0];
  assert.ok(c.label.length <= 255 && c.label.endsWith('… (×4)'), c.label.slice(-20));
  assert.ok(it.title.length <= 160 && it.truncated && it.full === long);
  assert.ok(p.report.warnings.some((x) => /longer than 255/.test(x.text)));
});

test('missing pieces get sensible, reported defaults: no group order, no item name, bad dates', () => {
  const p = plan([row({ go: '', item: '' }), row({ item: 'Dated', initialDue: '31 February 2026', ready: '5 May 2026', storage: '1 June 2026' })]);
  assert.equal(p.claims[0].goTitle, 'Notion import — no group order named'); assert.equal(p.claims[0].label, '(no item name)');
  assert.equal(p.claims[1].payBy, null);
  assert.deepEqual([p.claims[1].readyDate, p.claims[1].storageDeadline], ['2026-05-05', '2026-06-01']);
  assert.equal(parseNotionClaims(csv([row({ initialDue: '31 February 2026' })])).rows[0].bad.length, 1);
});

test('orders and items: one item per distinct item text within an order; its price is the usual unit price; orders map to artist groups', () => {
  const p = plan([row({ item: 'Album', qty: 2, initials: 40 }), row({ joiner: 'bob', item: 'Album', qty: 1, initials: 20 }), row({ joiner: 'cat', item: 'Album', qty: 1, initials: 25 }), row({ item: 'Hoodie', go: 'Other GO', initials: 50 })],
    { groups: { 'Run It GO': { artistGroup: 'Stray Kids' } }, defaultGroup: 'Misc' });
  assert.deepEqual(p.orders.map((o) => [o.title, o.artistGroup, o.items.length]), [['Run It GO', 'Stray Kids', 1], ['Other GO', 'Misc', 1]]);
  assert.equal(p.orders[0].items[0].price, 20, '£20 was the most common unit price');
  assert.deepEqual(p.report.counts, { claims: 4, cancelled: 0, people: { total: 3, new: 3, existing: 0, signedUp: 0 }, orders: { total: 2, new: 2, existing: 0 }, items: 2, parcels: { parcels: 0, claims: 0 } });
});

test('what the site already has is recognised: existing people and orders are reused, and rows imported before are skipped, not duplicated', () => {
  const rows = [row({ joiner: 'amy_k', item: 'A' }), row({ joiner: 'bob', item: 'B' })];
  const first = plan(rows);
  const again = plan(rows, {}, { orders: new Set(['run it go']), handles: new Set(['amy_k']), keys: new Set([first.claims[0].key]) });
  assert.deepEqual([again.claims.length, again.report.skipped.alreadyImported], [1, 1]);
  assert.deepEqual([again.report.counts.orders.existing, again.report.counts.people.existing, again.report.counts.people.new], [1, 0, 1], 'the skipped row\'s person is not counted again');
});

test('identical rows are kept as separate claims (each gets its own key), and a row\'s key does not depend on the order of the file', () => {
  const same = row({ joiner: 'amy_k', item: 'Twin', paid: 5 });
  const a = plan([same, same, row({ joiner: 'bob', item: 'Other' })]);
  assert.equal(a.claims.length, 3); assert.equal(new Set(a.claims.map((c) => c.key)).size, 3);
  const b = plan([row({ joiner: 'bob', item: 'Other' }), same, same]);
  assert.deepEqual(a.claims.map((c) => c.key).sort(), b.claims.map((c) => c.key).sort());
});

test('the real export\'s size is no problem: 3,000 rows are read and planned in well under a second', () => {
  const rows = Array.from({ length: 3000 }, (_, i) => row({ joiner: `user${i % 280}`, item: `Item ${i % 900}`, go: `GO ${i % 60}`, qty: (i % 5) + 1, initials: 12.5, ems: i % 3 ? 1.1 : null, paid: 12.5 }));
  const t = Date.now(); const p = plan(rows);
  assert.equal(p.claims.length, 3000); assert.ok(Date.now() - t < 1500, `${Date.now() - t}ms`);
});

test('"Shipping to you" items are planned into ONE shipped parcel per person (and only those, and only if confirmed)', () => {
  const p = plan([row({ joiner: 'amy_k', item: 'A', status: 'Shipping to you' }), row({ joiner: 'amy_k', item: 'B', status: 'Shipping to you', go: 'Other GO' }), row({ joiner: 'amy_k', item: 'C', status: 'Ordered via Proxy' }),
    row({ joiner: 'bob', item: 'D', status: 'Shipping to you' }), row({ joiner: 'cat', item: 'E', status: 'Completed' }), row({ joiner: 'dan', item: 'F', status: 'Cancelled - Sold Out' })]);
  assert.deepEqual(p.parcels.map((x) => [x.handle, x.keys.length]), [['amy_k', 2], ['bob', 1]]);
  assert.deepEqual(p.report.counts.parcels, { parcels: 2, claims: 3 });
  const keys = new Set(p.claims.filter((c) => c.pipeline === 'shipped').map((c) => c.key));
  assert.ok(p.parcels.flatMap((x) => x.keys).every((k) => keys.has(k)), 'each parcel holds exactly the shipped claims');
  assert.deepEqual(plan([row({ status: 'Completed' })]).parcels, []);
});
