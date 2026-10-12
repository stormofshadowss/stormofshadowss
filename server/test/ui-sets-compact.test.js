import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

// The Sets tab at scale: a set is ONE LINE (number, dots for its parts, count, what is open, status, quick buttons), grouped under its item, with chips, search, paging
// and "Secure all ready sets". Everything the old tab could do is still there (see ui-gom-sets.test.js).
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'sc') => `${x}${++N}`;
const goOrder = async (title = u('Compact GO ')) => (await api('POST', '/api/admin/orders', { groupId: w.group, title, proxy: 'Sam' })).json.id;
const newSet = async (go, title, members = ['A', 'B', 'C'], extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title, price: 4, members, ...extra })).json.id;
const claim = (handle, item, members, together) => app.api('POST', '/api/claims', { handle, lines: [{ itemId: item, parts: members.map((m) => ({ member: m, qty: 1 })), ...(together ? { together: true } : {}) }] });
const sets = async (item) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item);
const fullSets = async (item, n, members = ['A', 'B', 'C']) => { for (let i = 0; i < n; i++) await claim(u('fs'), item, members, true); };
const open = async (orderTitle) => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Sets')); await sleep(80); await p.settle(); if (orderTitle) { await p.choose(p.q('[data-filter="order"]'), String((await api('GET', '/api/admin/orders')).json.orders.find((o) => o.title === orderTitle).id)); await sleep(120); await p.settle(); } return p; };
const row = (p, id) => p.q(`[data-set="${id}"]`);
const chip = async (p, label) => { await p.click(p.byText('#setChips .chip', label)); await sleep(40); };

test('A SET IS ONE LINE: number, a dot per part (held / confirmed / open), the count, what is open, a status, quick buttons — and its parts stay tucked away until opened', async () => {
  const go = await goOrder('Line GO'); const item = await newSet(go, 'Line set', ['Bang Chan', 'Lee Know', 'Changbin', 'Hyunjin']);
  await claim(u(), item, ['Bang Chan', 'Lee Know']); await fullSets(item, 3, ['Bang Chan', 'Lee Know', 'Changbin', 'Hyunjin']);
  const all = await sets(item); const part = all.find((s) => s.filled === 2), full = all.find((s) => s.filled === 4);
  const p = await open('Line GO');
  const r = row(p, part.id);
  assert.match(p.text(p.q('.setline', r)), /^▸ Set \d+ 2\/4open: Changbin, Hyunjin needs 2 moreSecureCancel set$/);
  assert.equal(p.qa('.dot', r).length, 4); assert.equal(p.qa('.dot.held', r).length, 2, 'two held and waiting'); assert.equal(p.qa('.dot.ok', r).length, 0);
  assert.ok(p.q('.dot[title="Bang Chan — @' + part.parts[0].handle + '"]', r), 'hover shows who'); assert.ok(p.q('.dot[title="Changbin — open"]', r));
  assert.equal(p.q('table', r), null, 'parts tucked away'); assert.equal(p.q('[data-act="toggle-set"]', r).getAttribute('aria-expanded'), 'false');
  assert.match(p.text(row(p, full.id)), /4\/4.*ready to secure/s); assert.ok(p.q('[data-ready]', row(p, full.id)));
  await p.click(p.q('[data-act="toggle-set"]', r)); assert.ok(p.q('table', row(p, part.id)), 'opened'); assert.equal(p.q('[data-act="toggle-set"]', row(p, part.id)).getAttribute('aria-expanded'), 'true'); assert.match(p.text(row(p, part.id)), /▾ Set/);
  await p.click(p.q('[data-act="toggle-set"]', row(p, part.id))); assert.equal(p.q('table', row(p, part.id)), null, 'closed again');
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('A SHORT LIST OPENS BY ITSELF (3 sets or fewer) and your own open/close choice then sticks', async () => {
  const go = await goOrder('Short GO'); const item = await newSet(go, 'Short set'); await fullSets(item, 2);
  const [a] = await sets(item); const p = await open('Short GO');
  assert.ok(p.q('table', row(p, a.id)), 'two sets: the parts are showing');
  await p.click(p.q('[data-act="toggle-set"]', row(p, a.id))); assert.equal(p.q('table', row(p, a.id)), null, 'you closed it'); await p.click(p.byText('#setChips .chip', 'All')); assert.equal(p.q('table', row(p, a.id)), null, 'and it stays closed');
  p.close();
});

test('GROUPED UNDER THEIR ITEM, with counts: sets, ready, to fill, secured', async () => {
  const go = await goOrder('Group GO'); const a = await newSet(go, 'Item Alpha'), b = await newSet(go, 'Item Beta');
  await fullSets(a, 3); await claim(u(), a, ['A']); await claim(u(), b, ['A', 'B', 'C'], true);
  const [first] = await sets(a); await api('POST', `/api/admin/sets/${first.id}/secure`, {});
  const p = await open('Group GO'); const secA = p.q(`[data-item="${a}"]`), secB = p.q(`[data-item="${b}"]`);
  assert.match(p.text(p.q('.row', secA)), /Item Alpha.*Group GO.*4 sets.*2 ready.*1 to fill.*1 secured/s); assert.match(p.text(p.q('.row', secB)), /Item Beta.*1 set.*1 ready/s);
  assert.equal(p.qa('.setrow', secA).length, 3, 'To decide: the secured one is not listed'); p.close();
});

test('CHIPS: To decide / Ready to secure / Secured / Cancelled / All, with counts, filtering what is listed', async () => {
  const go = await goOrder('Chip GO'); const item = await newSet(go, 'Chip set'); await fullSets(item, 3); await claim(u(), item, ['A']);
  const all = await sets(item); await api('POST', `/api/admin/sets/${all[0].id}/secure`, {}); await api('POST', `/api/admin/sets/${all[1].id}/cancel`, {});
  const p = await open('Chip GO'); const labels = () => p.qa('#setChips .chip').map((c) => p.text(c));
  assert.deepEqual(labels(), ['To decide2', 'Ready to secure1', 'Secured1', 'Cancelled1', 'All4']); assert.equal(p.q('#setChips .chip.on').textContent, 'To decide2'); assert.equal(p.q('#setChips .chip.on').getAttribute('aria-pressed'), 'true');
  assert.equal(p.qa('.setrow').length, 2); await chip(p, 'Ready to secure'); assert.equal(p.qa('.setrow').length, 1); assert.ok(p.q('[data-ready]'));
  await chip(p, 'Secured'); assert.deepEqual(p.qa('.setrow').map((r) => r.dataset.set), [String(all[0].id)]); assert.ok(!p.q('[data-act="secure"]'), 'a secured set offers no Secure');
  await chip(p, 'Cancelled'); assert.deepEqual(p.qa('.setrow').map((r) => r.dataset.set), [String(all[1].id)]); await chip(p, 'All'); assert.equal(p.qa('.setrow').length, 4);
  p.close();
});

test('SEARCH: by @handle (with or without the @), part name or item; matches open themselves; nothing found says so; clearing brings the list back', async () => {
  const go = await goOrder('Search GO'); const item = await newSet(go, 'Searchable set', ['Felix', 'Han', 'Chan']); const other = await newSet(go, 'Other thing', ['X', 'Y']);
  await claim('needle_fan', item, ['Felix', 'Han', 'Chan'], true); await fullSets(item, 4, ['Felix', 'Han', 'Chan']); await fullSets(other, 4, ['X', 'Y']);
  const p = await open('Search GO'); const box = () => p.q('#setSearch'); const type = async (v) => { box().value = v; box().dispatchEvent(new p.window.Event('input', { bubbles: true })); await sleep(40); };
  assert.equal(p.qa('.setrow').length, 9); assert.equal(p.q('table'), null, 'everything is a line');
  await type('@needle_fan'); assert.equal(p.qa('.setrow').length, 1); assert.ok(p.q('table', p.q('.setrow')), 'a search match opens'); assert.equal(box().value, '@needle_fan', 'what you typed stays');
  await type('needle_fan'); assert.equal(p.qa('.setrow').length, 1);
  await type('Y'); assert.ok(p.qa('.setrow').length >= 4 && p.qa('.setrow').every((r) => /Other thing/.test(r.closest('section').textContent)), 'by part name — only the other item');
  await type('searchable'); assert.equal(p.qa('.setrow').length, 5, 'by item title (5 sets, all opened)');
  await type('zzz-nobody'); assert.match(p.text(p.q('#tabBody')), /No sets here\./); await type(''); assert.equal(p.qa('.setrow').length, 9, 'cleared: back to the list'); assert.equal(p.q('table'), null, 'and back to one line each');
  p.close();
});

test('SECURE ALL READY: appears with the count when sets are ready; says what happens; "Not yet" changes nothing; confirming secures them all; nothing it should not touch', async () => {
  const go = await goOrder('Bulk GO'); const item = await newSet(go, 'Bulk set'); await fullSets(item, 3); await claim(u(), item, ['A']);                        // 3 ready + 1 not
  const p = await open('Bulk GO'); assert.match(p.text(p.q('#bulkSecure')), /3 sets are ready to secure.*Every part is held and nothing is in the way\./s); assert.equal(p.text(p.q('[data-act="secure-ready"]')), 'Secure all 3…');
  await p.click(p.q('[data-act="secure-ready"]'));
  assert.match(p.text(modal(p)), /Secure 3 ready sets\?.*9 claims become confirmed.*Every part in these sets is already held\./s); await press(p, 'Not yet');
  assert.equal((await sets(item)).filter((s) => s.decision === 'secured').length, 0, 'not yet means not yet');
  await p.click(p.q('[data-act="secure-ready"]')); await press(p, 'Secure 3'); await sleep(300); await p.settle();
  assert.match(toast(p), /Secured 3 sets — 9 claims confirmed\./);
  const after = await sets(item); assert.equal(after.filter((s) => s.decision === 'secured').length, 3); assert.equal(after.filter((s) => s.decision === 'none').length, 1, 'the part-filled set was left alone');
  assert.equal(p.q('#bulkSecure'), null, 'nothing left that is ready'); p.close();
});

test('SECURE ALL READY, when one cannot be secured any more (done elsewhere): the rest are secured and the one that could not is named', async () => {
  const go = await goOrder('Stale GO'); const item = await newSet(go, 'Stale set'); await fullSets(item, 3);
  const [a] = await sets(item); const p = await open('Stale GO');
  await api('POST', `/api/admin/sets/${a.id}/secure`, {});                                    // done in another tab after this page loaded
  await p.click(p.q('[data-act="secure-ready"]')); await press(p, 'Secure 3'); await sleep(300); await p.settle();
  assert.match(toast(p), /Secured 2 sets — 6 claims confirmed\. 1 could not be secured \(Stale set — Set \d+: .*already secured/);
  assert.equal((await sets(item)).filter((s) => s.decision === 'secured').length, 3); p.close();
});

test('LONG LISTS ARE PAGED: 12 sets per item with "Show more"; Open all / Close all', async () => {
  const go = await goOrder('Many GO'); const item = await newSet(go, 'Many set', ['A', 'B']); await fullSets(item, 15, ['A', 'B']);
  const p = await open('Many GO'); const rows = () => p.qa('.setrow', p.q(`[data-item="${item}"]`));
  assert.equal(rows().length, 12); const more = p.byText('button', 'Show 3 more sets'); assert.match(p.text(more), /Show 3 more sets \(3 not shown\)/);
  await p.click(more); assert.equal(rows().length, 15); assert.equal(p.byText('button', 'Show'), undefined, 'no more button once everything is listed');
  await p.click(p.byText('button', 'Open all')); assert.equal(p.qa('table', p.q(`[data-item="${item}"]`)).length, 15); await p.click(p.byText('button', 'Close all')); assert.equal(p.qa('table', p.q(`[data-item="${item}"]`)).length, 0);
  p.close();
});

test('WHY A SET CANNOT BE SECURED is visible without opening it: price TBC, a cancel request, nobody yet, waiting for parts', async () => {
  const go = await goOrder('Why GO'); const tbc = await newSet(go, 'Tbc set', ['A', 'B'], { price: undefined, priceTbc: true }); const must = await newSet(go, 'Must be full', ['A', 'B'], { requiresFullSet: true });
  await claim(u(), tbc, ['A']); await claim(u(), must, ['A']);
  const ask = await newSet(go, 'Asked cancel', ['A', 'B']); const h = u('asker'); const cookie = await joinerSession(app, `${h}@x.com`, h); await claim(h, ask, ['A', 'B'], true);
  const [as] = await sets(ask); await api('POST', `/api/admin/sets/${as.id}/secure`, {});                         // a request to cancel needs a part to ask about — use an unsecured set instead
  const un = await newSet(go, 'Unsecured ask', ['A', 'B']); const h2 = u('asker'); const c2 = await joinerSession(app, `${h2}@x.com`, h2); await claim(h2, un, ['A', 'B'], true);
  const [us] = await sets(un); const claimId = us.parts.find((x) => x.claimId).claimId; assert.equal((await api('POST', `/api/my/claims/${claimId}/cancel-request`, {}, c2)).status, 201);
  const p = await open('Why GO'); const why = (id) => p.text(p.q('.setwhy', row(p, id)));
  assert.match(why((await sets(tbc))[0].id), /The price is still TBC — set it \(Group Orders → Items → Edit\) before this set can be secured\./);
  assert.match(why((await sets(must))[0].id), /Waiting for 1 more part — this set can't go ahead unless every part is claimed\./);
  assert.match(why(us.id), /A joiner has asked to cancel one of these parts — answer that first \(top of the Claims tab\) before this set can be secured\./);
  assert.equal(p.q('[data-act="secure"]', row(p, us.id)).disabled, true); void cookie; p.close();
});

test('NAMES WITH HTML are shown as text on the lines and in the item headings', async () => {
  const go = await goOrder('<i>Html</i> GO'); const item = await newSet(go, '<img src=x onerror="window.pwned=1"> set', ['<b>One</b>', 'Two']); await claim('<u>nope</u>'.replace(/[^a-z_.0-9]/g, '') || 'plain_h', item, ['<b>One</b>']);
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Sets')); await sleep(100); await p.settle();
  assert.equal(p.q('img[src="x"]'), null); assert.equal(p.window.pwned, undefined); assert.match(p.text(p.q(`[data-item="${item}"]`)), /<img src=x onerror="window\.pwned=1"> set.*<i>Html<\/i> GO.*open: Two/s); p.close();
});
