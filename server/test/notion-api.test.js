import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { row, csv } from './notion.fixture.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (p = 'n') => `${p}${++N}`;
const upload = (text, { filename = 'Claims_all.csv', cookie = admin, csrf = true } = {}) =>
  fetch(`${app.base}/api/admin/import/notion?filename=${encodeURIComponent(filename)}`, { method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'X-Requested-With': 'sos' } : {}), 'Content-Type': 'text/csv' }, body: text })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const state = (id) => api('GET', `/api/admin/import/batches/${id}`);
const putMap = (id, body) => api('PUT', `/api/admin/import/batches/${id}/mapping`, body);
const preview = (id) => api('GET', `/api/admin/import/batches/${id}/preview`);
const run = (id) => api('POST', `/api/admin/import/batches/${id}/run`, {});
const undo = (id) => api('POST', `/api/admin/import/batches/${id}/undo`, {});
const count = async (table) => (await app.q(`SELECT COUNT(*) AS n FROM ${table}`))[0].n;
const snapshot = async () => ({ claims: await count('claims'), joiners: await count('joiners'), orders: await count('group_orders'), items: await count('items'), payments: await count('payments'), groups: await count('artist_groups'), records: await count('import_records') });
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const iso = (d) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const longDate = (d) => { const t = new Date(Date.now() + d * 86_400_000); return `${t.getUTCDate()} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][t.getUTCMonth()]} ${t.getUTCFullYear()}`; };
// uploads a file, applies a mapping and runs it
async function importFile(rows, mapping = { scope: 'all' }) {
  const up = await upload(csv(rows)); assert.equal(up.status, 201, JSON.stringify(up.json));
  const m = await putMap(up.json.id, { scope: 'all', ...mapping }); assert.equal(m.status, 200, JSON.stringify(m.json));
  const r = await run(up.json.id);
  return { id: up.json.id, r };
}

test('uploading: a good export becomes a draft; anything else is refused with the reason — and only the GOM can upload', async () => {
  const ok = await upload(csv([row({ joiner: u('amy') })]));
  assert.equal(ok.status, 201); assert.equal(ok.json.rows, 1);
  const st = (await state(ok.json.id)).json;
  assert.deepEqual([st.status, st.rowCount, st.filename], ['draft', 1, 'Claims_all.csv']);
  const bad = await upload('Joiner,Item\nbob,thing\n');
  assert.equal(bad.status, 400); assert.equal(bad.json.code, 'bad_export'); assert.match(bad.json.error, /missing: GO, Order Status, Initials, Amount Paid/);
  assert.equal((await upload('   ')).json.code, 'no_file');
  const big = await upload('x'.repeat(13 * 1024 * 1024));
  assert.equal(big.status, 413); assert.match(big.json.error, /limit is 12 MB/);
  const j = await app.login('imp.joiner@x.com');
  assert.equal((await upload(csv([row()]), { cookie: j })).status, 403);
  assert.equal((await upload(csv([row()]), { cookie: null })).status, 401);
  assert.equal((await upload(csv([row()]), { csrf: false })).status, 403);
  for (const [m, p, b] of [['GET', '/api/admin/import/batches'], ['GET', `/api/admin/import/batches/${ok.json.id}`], ['PUT', `/api/admin/import/batches/${ok.json.id}/mapping`, {}], ['GET', `/api/admin/import/batches/${ok.json.id}/preview`], ['POST', `/api/admin/import/batches/${ok.json.id}/run`, {}], ['POST', `/api/admin/import/batches/${ok.json.id}/undo`, {}], ['DELETE', `/api/admin/import/batches/${ok.json.id}`]]) {
    assert.equal((await api(m, p, b, j)).status, 403, `${m} ${p}`);
  }
});

test('the review screen\'s data: people needing a look come first (with a suggestion and the linked name as a hint), orders with counts, statuses with their defaults', async () => {
  const [plain, spaced, br] = [u('plain'), `${u('lex')} cole`, `${u('chan')}_4life (Jenn)`];
  const up = await upload(csv([row({ joiner: plain, go: 'Review GO A' }), row({ joiner: plain, go: 'Review GO A', item: 'B' }), row({ joiner: spaced, go: 'Review GO B', relation: 'Lexie', status: 'Completed' }), row({ joiner: br, go: 'Review GO B', status: 'Weird status' })]));
  const s = (await state(up.json.id)).json;
  assert.deepEqual(s.people.map((p) => [p.raw === plain ? 'plain' : p.raw === spaced ? 'spaced' : 'bracket', p.needsReview, p.count]).sort(), [['bracket', true, 1], ['plain', false, 2], ['spaced', true, 1]]);
  assert.equal(s.people[2].raw, plain, 'the one that needs no attention is last');
  const sp = s.people.find((p) => p.raw === spaced);
  assert.deepEqual([sp.suggestion, sp.confident, sp.hint, sp.why], [spaced.replace(/ /g, ''), false, 'Lexie', 'has spaces or odd characters — tidied']);
  assert.deepEqual(s.groups.map((g) => [g.go, g.count, g.existsOnSite]), [['Review GO A', 2, false], ['Review GO B', 2, false]]);
  assert.deepEqual(s.statuses.map((x) => [x.raw, x.count, x.mapped, x.isDefault]).sort(), [['Completed', 1, 'completed', true], ['Ordered via Proxy', 2, 'ordered via proxy / warehouse', true], ['Weird status', 1, null, false]]);
  assert.ok(s.stages.includes('cancelled') && s.stages.includes('shipped')); assert.ok(Array.isArray(s.existingArtists));
  assert.equal(s.defaultGroup, 'Imported from Notion');
});

test('saving your decisions: handles are checked, entries can be removed, and nothing can change once it has been imported', async () => {
  const raw = `${u('who')} x`;
  const up = await upload(csv([row({ joiner: raw })]));
  const id = up.json.id;
  const bad = await putMap(id, { people: { [raw]: 'not a handle!' } });
  assert.equal(bad.status, 400); assert.equal(bad.json.code, 'bad_handle'); assert.match(bad.json.error, /isn't a valid Instagram handle/);
  assert.equal((await putMap(id, { scope: 'sometimes' })).status, 400);
  assert.equal((await putMap(id, { statuses: { 'Ordered via Proxy': 'teleported' } })).status, 400);
  assert.equal((await putMap(id, { people: { [raw]: '@Fixed_One' }, groups: { 'Run It GO': { artistGroup: 'Stray Kids' } }, scope: 'all', defaultGroup: 'Other' })).status, 200);
  let s = (await state(id)).json;
  assert.deepEqual([s.people[0].mapped, s.groups[0].artistGroup, s.scope, s.defaultGroup], ['fixed_one', 'Stray Kids', 'all', 'Other']);
  await putMap(id, { people: { [raw]: null }, groups: { 'Run It GO': null } });
  s = (await state(id)).json;
  assert.deepEqual([s.people[0].mapped, s.groups[0].artistGroup], [null, ''], 'null removes a decision');
  await putMap(id, { people: { [raw]: 'fixed_one' } });
  assert.equal((await run(id)).status, 200);
  const after = await putMap(id, { scope: 'ongoing' });
  assert.equal(after.status, 409); assert.equal(after.json.code, 'bad_state');
  assert.equal((await api('PUT', '/api/admin/import/batches/999999/mapping', {})).status, 404);
});

test('the preview shows exactly what will happen, saves NOTHING, and matches what the import then does', async () => {
  const [a, b, go] = [u('pv'), u('pv'), u('Preview GO')];
  const up = await upload(csv([row({ joiner: a, go, item: 'Album', initials: 20, paid: 20, status: 'Completed' }), row({ joiner: b, go, item: 'Album', initials: 20, ems: 4, paid: 10, status: 'Shipping to you', initialDue: longDate(-9) })]));
  await putMap(up.json.id, { scope: 'all' });
  const before = await snapshot();
  const pv = (await preview(up.json.id)).json;
  assert.deepEqual(await snapshot(), before, 'previewing wrote nothing');
  assert.deepEqual([pv.ok, pv.counts.claims, pv.counts.people, pv.counts.orders, pv.counts.items], [true, 2, { total: 2, new: 2, existing: 0, signedUp: 0 }, { total: 1, new: 1, existing: 0 }, 1]);
  assert.deepEqual(pv.money, { due: 44, paid: 30, owed: 14, excess: 0 });
  assert.deepEqual(pv.byStage, { completed: 1, shipped: 1 });
  const r = (await run(up.json.id)).json;
  assert.deepEqual([r.counts.claims, r.made.claims, r.made.people, r.made.orders, r.made.items, r.made.payments], [2, 2, 2, 1, 1, 2]);
  assert.deepEqual(r.money, pv.money);
  assert.equal((await preview(up.json.id)).status, 409, 'once imported there is nothing to preview');
});

test('IMPORTING: orders are hidden and closed, items and claims carry the right status, stage, dates and costs, and each person\'s paid money becomes one verified payment that reconciles', async () => {
  const [a, b, go] = [u('run'), u('run'), u('Run GO')];
  const { id, r } = await importFile([
    row({ joiner: a, go, item: 'Album', qty: 2, initials: 40, ems: 6, customs: 2, doms: 1.5, packing: 0.75, paid: 45, status: 'Ready To Pack / On Hand with GOM', initialDue: longDate(-12), ready: longDate(-40), storage: longDate(-3) }),
    row({ joiner: a, go, item: 'Photocards', initials: 8, paid: 8, status: 'Completed' }),
    row({ joiner: b, go, item: 'Album', qty: 1, initials: 20, paid: 0, status: 'Awaiting Fulfilment', initialDue: longDate(5) }),
    row({ joiner: b, go, item: 'Cancelled thing', initials: 9, paid: 0, status: 'Cancelled - Sold Out' }),
  ], { scope: 'all', groups: { [go]: { artistGroup: 'Stray Kids' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // the order, hidden and closed, under the chosen artist
  const [o] = await app.q("SELECT go.id, go.status, go.is_private, ag.name AS artist, ag.is_hidden FROM group_orders go JOIN artist_groups ag ON ag.id = go.group_id WHERE go.title = ?", [go]);
  assert.deepEqual([o.status, o.is_private, o.artist, o.is_hidden], ['closed', 1, 'Stray Kids', 0]);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM items WHERE order_id = ?', [o.id]))[0].n, 3, 'Album, Photocards, Cancelled thing');
  // claims
  const rowsA = await app.q(`SELECT c.label, c.status, c.pipeline, c.pay_by, c.ready_to_pack_date AS ready, c.storage_deadline_override AS storage FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? ORDER BY c.id`, [a]);
  assert.deepEqual(rowsA.map((x) => [x.label, x.status, x.pipeline]), [['Album (×2)', 'confirmed', 'ready to pack / on hand'], ['Photocards', 'confirmed', 'completed']]);
  const iso0 = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  assert.deepEqual([iso0(rowsA[0].pay_by), iso0(rowsA[0].ready), iso0(rowsA[0].storage)], [iso(-12), iso(-40), iso(-3)]);
  const rowsB = await app.q(`SELECT c.label, c.status, c.pipeline FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? ORDER BY c.id`, [b]);
  assert.deepEqual(rowsB.map((x) => [x.label, x.status, x.pipeline]), [['Album', 'confirmed', 'awaiting fulfillment'], ['Cancelled thing', 'cancelled', 'awaiting fulfillment']]);
  // costs and paid, per category
  const costs = Object.fromEntries((await app.q(`SELECT cc.category, cc.cost, cc.paid FROM claim_costs cc JOIN claims c ON c.id = cc.claim_id JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.label = 'Album (×2)'`, [a])).map((x) => [x.category, [Number(x.cost), Number(x.paid)]]));
  assert.deepEqual(costs, { initials: [40, 40], ems: [6, 5], customs: [2, 0], doms: [1.5, 0], packaging: [0.75, 0] });
  // ONE payment per person, reconciling with the allocations and with what each claim says is paid
  const pays = await app.q("SELECT p.id, p.amount, p.method, p.reference, p.status, j.instagram_handle AS h FROM payments p JOIN joiners j ON j.id = p.joiner_id WHERE j.instagram_handle IN (?, ?)", [a, b]);
  assert.deepEqual(pays.map((p) => [p.h, Number(p.amount), p.method, p.status]), [[a, 53, 'Imported from Notion', 'confirmed']], 'b paid nothing, so b has no payment');
  assert.match(pays[0].reference, new RegExp(`Notion import #${id}`));
  assert.equal(Number((await app.q('SELECT SUM(amount) AS s FROM payment_allocations WHERE payment_id = ?', [pays[0].id]))[0].s), 53);
  const people = (await api('GET', '/api/admin/claims')).json.people;
  assert.deepEqual([people[a].owed, people[a].paid, people[b].owed, people[b].paid], [5.25, 53, 20, 0]);   // 40 + 6 + 2 + 1.5 + 0.75 = 50.25 less the 45 paid
  // every imported claim has all five cost rows and the books balance
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM claims c JOIN import_records ir ON ir.kind = 'claim' AND ir.entity_id = c.id WHERE (SELECT COUNT(*) FROM claim_costs WHERE claim_id = c.id) <> 5"))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost'))[0].n, 0);
  // the batch
  const b2 = (await state(id)).json;
  assert.equal(b2.status, 'imported'); assert.equal((await app.q('SELECT payload FROM import_batches WHERE id = ?', [id]))[0].payload, null, 'the uploaded rows are not kept after importing');
});

test('imported history stays out of the way: not claimable or visible in the shop, not "pay your proxy" candidates, no emails sent', async () => {
  const [h, go] = [u('quiet'), u('Quiet GO')];
  const mails = app.mailer.outbox.length;
  await importFile([row({ joiner: h, go, item: 'Quiet item', initials: 10, paid: 10, status: 'Ordered via Proxy' })]);
  const pub = (await app.api('GET', '/api/orders')).json.orders;
  assert.equal(pub.some((o) => o.title === go), false, 'not in the shop');
  const itemId = (await app.q('SELECT id FROM items WHERE title = ?', ['Quiet item']))[0].id;
  assert.equal((await app.api('POST', '/api/claims', { handle: u('late'), lines: [{ itemId }] })).status, 404, 'nobody can claim from it');
  const cand = (await api('GET', '/api/admin/proxy/candidates')).json.candidates;
  assert.equal(cand.some((c) => c.itemId === itemId), false, 'not offered as something to pay a proxy for');
  assert.equal(app.mailer.outbox.length, mails, 'no emails of any kind');
});

test('money on the existing screens: an unpaid imported claim is overdue once its date passes; storage deadlines from Notion are honoured; paid ones are not chased', async () => {
  const [late, fine, store, go] = [u('late'), u('fine'), u('store'), u('Overdue GO')];
  await importFile([
    row({ joiner: late, go, item: 'Late thing', initials: 12, paid: 2, status: 'Ordered via Proxy', initialDue: longDate(-6) }),
    row({ joiner: fine, go, item: 'Paid thing', initials: 12, paid: 12, status: 'Ordered via Proxy', initialDue: longDate(-6) }),
    row({ joiner: store, go, item: 'Stored thing', initials: 5, paid: 5, status: 'Ready To Pack / On Hand with GOM', ready: longDate(-20), storage: longDate(-2) }),
  ]);
  const o = (await api('GET', '/api/admin/overdue')).json;
  const row_ = o.payments.find((x) => x.handle === late);
  assert.deepEqual([row_.owed, row_.daysOverdue, row_.ownDate], [10, 6, true]);
  assert.equal(o.payments.some((x) => x.handle === fine), false);
  const st = o.storage.find((x) => x.handle === store);
  assert.deepEqual([st.daysOverdue, st.overridden], [2, true]);
});

test('what a joiner sees: once linked, their imported orders appear under the right order, with what they owe, and completed ones under Completed', async () => {
  const [h, go] = [u('mine'), u('Mine GO')];
  await importFile([row({ joiner: h, go, item: 'Ongoing thing', initials: 15, paid: 5, status: 'Ordered via Proxy' }), row({ joiner: h, go, item: 'Done thing', initials: 9, paid: 9, status: 'Completed' })]);
  const cookie = await app.login(`${h}@x.com`);
  await app.q('UPDATE joiners SET account_id = (SELECT id FROM accounts WHERE email = ?) WHERE instagram_handle = ?', [`${h}@x.com`, h]);
  const s = (await app.api('GET', '/api/my/summary', undefined, cookie)).json;
  const g = s.orders.find((x) => x.title === go);
  assert.deepEqual(g.claims.map((c) => [c.label, c.pipeline]).sort(), [['Done thing', 'completed'], ['Ongoing thing', 'ordered via proxy / warehouse']]);
  assert.equal(s.owed.total, 10, '£15 owed less the £5 already paid');
});

test('existing people and orders are reused, not duplicated — and an order that already exists keeps its place', async () => {
  const [h, go] = [u('exist'), u('Existing GO')];
  await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: w.keyring }] });                 // a person who is already on the site
  const goId = (await api('POST', '/api/admin/orders', { groupId: w.group, title: go })).json.id;        // an order that is already on the site
  const before = await snapshot();
  const { r } = await importFile([row({ joiner: h, go, item: 'Imported into it', initials: 10, paid: 10 })]);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.made.people, r.json.reused.people, r.json.made.orders, r.json.reused.orders], [0, 1, 0, 1]);
  const after = await snapshot();
  assert.deepEqual([after.joiners - before.joiners, after.orders - before.orders, after.claims - before.claims, after.items - before.items], [0, 0, 1, 1]);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM items WHERE order_id = ? AND title = 'Imported into it'", [goId]))[0].n, 1);
  assert.equal((await app.q('SELECT status FROM group_orders WHERE id = ?', [goId]))[0].status, 'open', 'its settings were not touched');
});

test('importing the same file again adds nothing; a file with one new row adds just that one', async () => {
  const [h, go] = [u('twice'), u('Twice GO')];
  const rows = [row({ joiner: h, go, item: 'A', initials: 10, paid: 10 }), row({ joiner: h, go, item: 'B', initials: 5, paid: 0 })];
  assert.equal((await importFile(rows)).r.status, 200);
  const before = await snapshot();
  const up = await upload(csv(rows)); await putMap(up.json.id, { scope: 'all' });
  const pv = (await preview(up.json.id)).json;
  assert.deepEqual([pv.counts.claims, pv.skipped.alreadyImported], [0, 2]);
  const r = await run(up.json.id);
  assert.equal(r.status, 400); assert.equal(r.json.code, 'nothing_to_import');
  assert.deepEqual(await snapshot(), before, 'nothing was duplicated');
  const more = await upload(csv([...rows, row({ joiner: h, go, item: 'C new', initials: 7, paid: 7 })])); await putMap(more.json.id, { scope: 'all' });
  const r2 = (await run(more.json.id)).json;
  assert.deepEqual([r2.made.claims, r2.skipped.alreadyImported, r2.reused.people], [1, 2, 1]);
  assert.deepEqual((await claimsOf(h)).map((c) => c.label).sort(), ['A', 'B', 'C new']);
});

test('the import is refused until the open decisions are made — and says so', async () => {
  const raw = `${u('needs')} decision`;
  const up = await upload(csv([row({ joiner: raw }), row({ joiner: u('ok'), item: 'B', status: 'Mystery' })]));
  await putMap(up.json.id, { scope: 'all' });
  const pv = (await preview(up.json.id)).json;
  assert.equal(pv.ok, false); assert.deepEqual(pv.blockers.unresolvedPeople, [{ raw, count: 1 }]); assert.equal(pv.blockers.unknownStatuses[0].raw, 'Mystery');
  const r = await run(up.json.id);
  assert.equal(r.status, 409); assert.equal(r.json.code, 'needs_decisions');
  assert.equal((await app.q('SELECT status FROM import_batches WHERE id = ?', [up.json.id]))[0].status, 'draft');
  await putMap(up.json.id, { people: { [raw]: u('settled') }, statuses: { Mystery: 'cancelled' } });
  assert.equal((await run(up.json.id)).status, 200);
});

test('two decisions about the same upload at the same instant: it runs once', async () => {
  const up = await upload(csv([row({ joiner: u('dbl'), go: u('Dbl GO'), item: 'A' })])); await putMap(up.json.id, { scope: 'all' });
  const before = await snapshot();
  const rs = await Promise.all([run(up.json.id), run(up.json.id), run(up.json.id)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  const after = await snapshot();
  assert.deepEqual([after.claims - before.claims, after.orders - before.orders], [1, 1]);
});

test('if anything fails part-way, NOTHING is imported — the whole import rolls back', async () => {
  const [go, h] = [u('Boom GO'), u('boom')];
  await app.q("CREATE TRIGGER boom BEFORE INSERT ON claims FOR EACH ROW BEGIN IF NEW.label = 'EXPLODE' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'boom'; END IF; END");
  try {
    const up = await upload(csv([row({ joiner: h, go, item: 'Fine', initials: 5, paid: 5 }), row({ joiner: h, go, item: 'EXPLODE' })])); await putMap(up.json.id, { scope: 'all' });
    const before = await snapshot();
    const quiet = console.error; console.error = () => {};
    let r; try { r = await run(up.json.id); } finally { console.error = quiet; }
    assert.equal(r.status, 500);
    assert.deepEqual(await snapshot(), before, 'not one row was left behind');
    assert.equal((await app.q('SELECT status FROM import_batches WHERE id = ?', [up.json.id]))[0].status, 'draft', 'and it can be tried again');
  } finally { await app.q('DROP TRIGGER boom'); }
});

test('history first, then ongoing: two batches from one file never duplicate a person or an order', async () => {
  const [h, go] = [u('split'), u('Split GO')];
  const rows = [row({ joiner: h, go, item: 'Old', status: 'Completed', initials: 10, paid: 10 }), row({ joiner: h, go, item: 'Current', status: 'Ordered via Proxy', initials: 10, paid: 4 })];
  const a = await importFile(rows, { scope: 'ongoing' }), b = await importFile(rows, { scope: 'history' });
  assert.deepEqual([a.r.json.made.claims, a.r.json.made.people, a.r.json.made.orders], [1, 1, 1]);
  assert.deepEqual([b.r.json.made.claims, b.r.json.made.people, b.r.json.made.orders, b.r.json.reused.people, b.r.json.reused.orders], [1, 0, 0, 1, 1]);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM joiners WHERE instagram_handle = ?", [h]))[0].n, 1);
  assert.deepEqual((await claimsOf(h)).map((c) => c.pipeline).sort(), ['completed', 'ordered via proxy / warehouse']);
});

// ───────────── undo ─────────────
test('UNDO removes exactly what the import created and nothing else, and the same file can be imported again afterwards', async () => {
  const [h, known, go] = [u('undo'), u('known'), u('Undo GO')];
  await app.api('POST', '/api/claims', { handle: known, lines: [{ itemId: w.keyring }] });
  const before = await snapshot();
  const { id, r } = await importFile([row({ joiner: h, go, item: 'A', initials: 10, paid: 6 }), row({ joiner: known, go, item: 'B', initials: 5, paid: 5 })], { scope: 'all', groups: { [go]: { artistGroup: u('NewArtist') } } });
  assert.equal(r.status, 200);
  const u1 = await undo(id);
  assert.equal(u1.status, 200);
  assert.deepEqual(u1.json.gone, { claims: 2, items: 2, orders: 1, groups: 1, people: 1, payments: 2, parcels: 0 });
  assert.deepEqual(await snapshot(), { ...before, records: before.records }, 'the site is exactly as it was before the import');
  assert.equal((await claimsOf(known)).length, 1, 'the person who was already there is still there, with only their own claim');
  assert.equal((await state(id)).json.status, 'undone');
  assert.equal((await undo(id)).status, 409, 'undoing twice is refused');
  const again = await importFile([row({ joiner: h, go, item: 'A', initials: 10, paid: 6 })], { scope: 'all' });
  assert.equal(again.r.status, 200, 'after an undo the same rows can be imported again');
});

test('UNDO is refused once money has moved on the imported claims — and then leaves everything exactly as it is', async () => {
  const [h, go] = [u('paid'), u('Paid GO')];
  const { id } = await importFile([row({ joiner: h, go, item: 'Owes', initials: 30, paid: 10 })]);
  const c = await app.login(`${h}@x.com`);
  await app.q('UPDATE joiners SET account_id = (SELECT id FROM accounts WHERE email = ?) WHERE instagram_handle = ?', [`${h}@x.com`, h]);
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 5, reference: 'LATER' }, c);
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  const before = await snapshot();
  const r = await undo(id);
  assert.equal(r.status, 409); assert.equal(r.json.code, 'import_in_use'); assert.match(r.json.error, /can't be undone any more.*payments or credit/);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await state(id)).json.status, 'imported');
});

test('UNDO is also refused after credit was applied to an imported claim, or when someone has claimed one of its items', async () => {
  const [h, go, h2, go2] = [u('cred'), u('Cred GO'), u('item'), u('Item GO')];
  const a = await importFile([row({ joiner: h, go, item: 'Owes', initials: 30, paid: 0 })]);
  await api('POST', '/api/admin/credit/add', { handle: h, amount: 5, reason: 'x' });                    // credit is spent on what they owe
  assert.equal((await undo(a.id)).status, 409);
  const b = await importFile([row({ joiner: h2, go: go2, item: 'Claimed later', initials: 3, paid: 3 })]);
  const itemId = (await app.q('SELECT id FROM items WHERE title = ?', ['Claimed later']))[0].id;
  const j = (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [h2]))[0].id;
  await app.q("INSERT INTO claims (joiner_id, order_id, item_id, label) SELECT ?, order_id, id, 'added by hand' FROM items WHERE id = ?", [j, itemId]);
  const r = await undo(b.id);
  assert.equal(r.status, 409); assert.match(r.json.error, /someone has since claimed one of its items/);
});

test('UNDO keeps what has since been built on: a person who signed in, and an order that someone added to', async () => {
  const [h, go] = [u('keep'), u('Keep GO')];
  const { id } = await importFile([row({ joiner: h, go, item: 'Imported', initials: 5, paid: 5 })]);
  await app.login(`${h}@x.com`);
  await app.q('UPDATE joiners SET account_id = (SELECT id FROM accounts WHERE email = ?) WHERE instagram_handle = ?', [`${h}@x.com`, h]);
  const orderId = (await app.q('SELECT id FROM group_orders WHERE title = ?', [go]))[0].id;
  await api('POST', `/api/admin/orders/${orderId}/items`, { type: 'normal', title: 'Added later by the GOM', price: 4 });
  const r = await undo(id);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.kept.people, r.json.kept.orders, r.json.gone.people, r.json.gone.orders], [1, 1, 0, 0]);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM joiners WHERE instagram_handle = ?', [h]))[0].n, 1);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM items WHERE order_id = ? AND title = 'Added later by the GOM'", [orderId]))[0].n, 1);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM items WHERE title = 'Imported'"))[0].n, 0, 'the imported item itself is gone');
});

test('drafts can be discarded; a live import cannot be deleted without undoing it first; unknown imports are not found', async () => {
  const d = await upload(csv([row({ joiner: u('draft') })]));
  assert.equal((await api('DELETE', `/api/admin/import/batches/${d.json.id}`)).status, 200);
  assert.equal((await state(d.json.id)).status, 404);
  const { id } = await importFile([row({ joiner: u('live'), go: u('Live GO') })]);
  assert.equal((await api('DELETE', `/api/admin/import/batches/${id}`)).status, 409);
  await undo(id);
  assert.equal((await api('DELETE', `/api/admin/import/batches/${id}`)).status, 200);
  assert.equal((await api('POST', '/api/admin/import/batches/999999/run', {})).status, 404);
  const list = (await api('GET', '/api/admin/import/batches')).json.batches;
  assert.ok(list.length > 5 && list.every((b) => ['draft', 'imported', 'undone'].includes(b.status)));
});

test('INVARIANTS: every import record points at something real, the books balance, and nothing is overpaid', async () => {
  for (const [kind, table] of [['claim', 'claims'], ['item', 'items'], ['order', 'group_orders'], ['group', 'artist_groups'], ['joiner', 'joiners'], ['payment', 'payments']]) {
    assert.equal((await app.q(`SELECT COUNT(*) AS n FROM import_records ir LEFT JOIN ${table} t ON t.id = ir.entity_id WHERE ir.kind = '${kind}' AND t.id IS NULL`))[0].n, 0, `${kind} records`);
  }
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM payments p WHERE p.method = 'Imported from Notion' AND p.amount <> COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id = p.id), 0)"))[0].n, 0, 'an imported payment equals what it is allocated to');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM claim_costs WHERE paid > cost OR cost < 0'))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM (SELECT kind, source_key FROM import_records WHERE source_key IS NOT NULL GROUP BY kind, source_key HAVING COUNT(*) > 1) x'))[0].n, 0, 'no spreadsheet row was imported twice');
});

// ───────────── shipped parcels for "Shipping to you" ─────────────
test('"Shipping to you" items go into ONE shipped parcel per person, and the joiner pressing "It\'s arrived" completes every one of them', async () => {
  const [h, other, go1, go2] = [u('ship'), u('ship'), u('Ship GO'), u('Ship GO')];
  const { r } = await importFile([row({ joiner: h, go: go1, item: 'On its way A', initials: 10, paid: 10, status: 'Shipping to you' }), row({ joiner: h, go: go2, item: 'On its way B', initials: 6, paid: 6, status: 'Shipping to you' }),
    row({ joiner: h, go: go1, item: 'Still ordering', initials: 5, paid: 0, status: 'Ordered via Proxy' }), row({ joiner: other, go: go1, item: 'Other on its way', initials: 4, paid: 4, status: 'Shipping to you' })]);
  assert.equal(r.json.made.parcels, 2, 'one for each person who has something on its way');
  const [mine] = await app.q("SELECT p.id, p.status, p.method FROM parcels p JOIN joiners j ON j.id = p.joiner_id WHERE j.instagram_handle = ?", [h]);
  assert.deepEqual([mine.status, mine.method], ['shipped', 'Shipped before the move to this site']);
  assert.deepEqual((await app.q('SELECT c.label FROM parcel_items pi JOIN claims c ON c.id = pi.claim_id WHERE pi.parcel_id = ? ORDER BY c.label', [mine.id])).map((x) => x.label), ['On its way A', 'On its way B']);
  // the joiner sees it and presses "It's arrived"
  const cookie = await app.login(`${h}@x.com`);
  await app.q('UPDATE joiners SET account_id = (SELECT id FROM accounts WHERE email = ?) WHERE instagram_handle = ?', [`${h}@x.com`, h]);
  const parcels = (await app.api('GET', '/api/my/parcels', undefined, cookie)).json.parcels;
  assert.equal(parcels.length, 1); assert.equal(parcels[0].status, 'shipped');
  const got = await app.api('POST', `/api/my/parcels/${parcels[0].id}/received`, {}, cookie);
  assert.equal(got.status, 200, JSON.stringify(got.json));
  const rows = (await claimsOf(h)).map((c) => [c.label, c.pipeline]).sort();
  assert.deepEqual(rows, [['On its way A', 'completed'], ['On its way B', 'completed'], ['Still ordering', 'ordered via proxy / warehouse']]);
});

test('the preview mentions the parcels it will create; undo removes them — but is refused once someone has confirmed one arrived', async () => {
  const [h, go] = [u('ship'), u('Ship GO')];
  const up = await upload(csv([row({ joiner: h, go, item: 'Parcel item', initials: 5, paid: 5, status: 'Shipping to you' })])); await putMap(up.json.id, { scope: 'all' });
  assert.deepEqual((await preview(up.json.id)).json.counts.parcels, { parcels: 1, claims: 1 });
  assert.equal((await run(up.json.id)).status, 200);
  const before = await snapshot();
  assert.equal((await count('parcels')) >= 1, true);
  const u1 = await undo(up.json.id);
  assert.equal(u1.status, 200); assert.equal(u1.json.gone.parcels, 1);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM parcels p JOIN joiners j ON j.id = p.joiner_id WHERE j.instagram_handle = ?', [h]))[0].n, 0);
  assert.ok(before);
  // now one that someone confirms
  const [h2, go2] = [u('arrived'), u('Arrived GO')];
  const { id } = await importFile([row({ joiner: h2, go: go2, item: 'Will arrive', initials: 5, paid: 5, status: 'Shipping to you' })]);
  const cookie = await app.login(`${h2}@x.com`);
  await app.q('UPDATE joiners SET account_id = (SELECT id FROM accounts WHERE email = ?) WHERE instagram_handle = ?', [`${h2}@x.com`, h2]);
  const pid = (await app.api('GET', '/api/my/parcels', undefined, cookie)).json.parcels[0].id;
  await app.api('POST', `/api/my/parcels/${pid}/received`, {}, cookie);
  const r = await undo(id);
  assert.equal(r.status, 409); assert.equal(r.json.code, 'import_in_use'); assert.match(r.json.error, /already confirmed that one of its parcels arrived/);
});

// ───────────── people who signed up BEFORE their old claims were imported ─────────────
test('ALPHA TESTERS: someone who signed up first (and made their own claim) gets their old claims added to the SAME account — visible in My orders at once, no invite needed', async () => {
  const [h, go] = [u('kei'), u('Alpha GO')];
  const cookie = await joinerSession(app, `${h}@x.com`, h);                                             // signed up, handle linked
  await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: w.keyring }] });                   // a test claim on the new site
  const accountBefore = (await app.q('SELECT account_id FROM joiners WHERE instagram_handle = ?', [h]))[0].account_id;
  const before = await snapshot();
  const notionSpelling = h[0].toUpperCase() + h.slice(1);                                                // Notion has "Kei12", the site has "kei12"
  const up = await upload(csv([row({ joiner: notionSpelling, go, item: 'Old album', initials: 20, paid: 5, status: 'Ordered via Proxy' }), row({ joiner: notionSpelling, go, item: 'Old hoodie', initials: 40, paid: 40, status: 'Completed' })]));
  await putMap(up.json.id, { scope: 'all' });
  // the review screen tells you what will happen
  const st = (await state(up.json.id)).json;
  assert.equal(st.people[0].onSite, 'signed_up', 'it says this person is already signed up');
  const pv = (await preview(up.json.id)).json;
  assert.deepEqual([pv.counts.people.new, pv.counts.people.existing, pv.counts.people.signedUp], [0, 1, 1]);
  const r = await run(up.json.id);
  assert.deepEqual([r.json.made.people, r.json.reused.people], [0, 1]);
  assert.deepEqual([(await snapshot()).joiners - before.joiners], [0], 'no second person was created');
  assert.equal((await app.q('SELECT account_id FROM joiners WHERE instagram_handle = ?', [h]))[0].account_id, accountBefore, 'still the same account');
  // what they see, straight away, on the account they already had
  const s = (await app.api('GET', '/api/my/summary', undefined, cookie)).json;
  const titles = s.orders.map((o) => o.title);
  assert.ok(titles.includes(go), 'the imported order appears in their My orders');
  const imported = s.orders.find((o) => o.title === go);
  assert.deepEqual(imported.claims.map((c) => [c.label, c.pipeline]).sort(), [['Old album', 'ordered via proxy / warehouse'], ['Old hoodie', 'completed']]);
  assert.equal(s.owed.total, 15, '£20 for the album less the £5 paid; the hoodie is paid in full');
  assert.equal((await claimsOf(h)).length, 3, 'their own test claim and the two old ones, all under one handle');
  // and they need no invite
  assert.equal((await api('GET', `/api/admin/invites?q=${h}`)).json.people.length, 0);
});
