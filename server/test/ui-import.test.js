import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';
import { row, csv } from './notion.fixture.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p, sel = '#tabBody') => p.text(p.q(sel));
const u = (x = 'i') => `${x}${++N}`;
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Import')); return p; };
// pretend the GOM chose a file in the file chooser
async function choose(p, text_, name = 'Claims_all.csv') {
  const input = p.q('#impFile');
  const file = new p.window.File([Buffer.from(text_)], name, { type: 'text/csv' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await sleep(200); await p.settle(); await sleep(100); await p.settle();
}
const cnt = async (t) => (await app.q(`SELECT COUNT(*) AS n FROM ${t}`))[0].n;

test('the tab explains how to export from Notion and what will (and will not) happen', async () => {
  const p = await open();
  const t = text(p);
  assert.match(t, /Import from Notion.*Claims.*•••.*Export.*CSV.*_all\.csv/s);
  assert.match(t, /Nothing is saved until you press Import, and you can undo an import afterwards/);
  assert.match(t, /Imported group orders are hidden and closed/);
  assert.ok(p.q('#impFile') && p.q('#impScope'));
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('a wrong file is refused in plain words and nothing is created', async () => {
  const p = await open(); const before = await cnt('import_batches');
  await choose(p, 'Joiner,Item\nbob,thing\n', 'wrong.csv');
  assert.match(text(p, '#impMsg'), /doesn't look like the full Claims export — these columns are missing: GO, Order Status, Initials, Amount Paid/);
  assert.equal(await cnt('import_batches'), before);
  p.close();
});

test('uploading shows the decisions to make: people to check (and everyone on request), orders, statuses — with a guess filled in for each', async () => {
  const [plain, spaced, br, go1, go2] = [u('plain'), `${u('lex')} cole`, `${u('chan')}_4life (Jenn)`, u('GO One'), u('GO Two')];
  const p = await open();
  await choose(p, csv([row({ joiner: plain, go: go1 }), row({ joiner: spaced, go: go1, item: 'B', relation: 'Lexie' }), row({ joiner: br, go: go2, item: 'C', status: 'Completed' }), row({ joiner: plain, go: go2, item: 'D', status: 'Odd status' })]));
  const t = text(p);
  assert.match(t, /Claims_all\.csv.*4 rows/);
  assert.match(t, /3 different names in the Joiner column\. 2 need your check/);
  assert.equal(p.qa('[data-person]').length, 2, 'only the names that need a look are shown by default');
  const sp = p.q(`[data-person="${spaced}"]`);
  assert.equal(p.q('[data-handle]', sp).value, spaced.replace(/ /g, ''), 'a tidied guess is pre-filled');
  assert.match(p.text(sp), /has spaces or odd characters — tidied.*Lexie/s);
  assert.match(p.text(p.q(`[data-person="${br}"]`)), /has brackets — took the part before them/);
  await p.click(p.q('input[data-act="show-all"]'));
  assert.equal(p.qa('[data-person]').length, 3, '"show everyone" shows the plain handle too');
  assert.deepEqual(p.qa('[data-go]').map((e) => e.dataset.go), [go1, go2].sort());
  assert.equal(p.q('#impDefault').value, 'Imported from Notion');
  assert.equal(p.q('[data-status="Ordered via Proxy"] select').value, 'ordered via proxy / warehouse', 'known statuses come pre-mapped');
  assert.match(p.text(p.q('[data-status="Odd status"]')), /choose/);
  assert.equal(p.q('[data-status="Odd status"] select').value, '');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('the whole flow: decide → preview (with the reasons it is not ready) → import → what was created → undo', async () => {
  const [plain, spaced, skipme, go, artist] = [u('flow'), `${u('lex')} cole`, `${u('skip')} me`, u('Flow GO'), u('Stray Kids ')];
  const p = await open();
  await choose(p, csv([
    row({ joiner: plain, go, item: 'Album', initials: 20, ems: 5, paid: 22, status: 'Ready To Pack / On Hand with GOM' }),
    row({ joiner: spaced, go, item: 'Photocards', initials: 8, paid: 10, status: 'Completed' }),
    row({ joiner: skipme, go, item: 'Skipped', initials: 3, paid: 0 }),
    row({ joiner: plain, go, item: 'Mystery', initials: 4, paid: 0, status: 'Odd status' }),
  ]));
  await p.choose(p.q('#impScope2'), 'all');
  await p.click(p.byText('button', 'Save and preview'));
  let rep = text(p, '#impReport');
  assert.match(rep, /Preview — nothing has been saved.*Not ready to import yet/s);
  assert.match(rep, /2 names still need a handle \(or Skip\)/);
  assert.match(rep, /Choose what these statuses mean: Odd status \(1\)/);
  assert.equal(p.q('[data-act="run"]').disabled, true, 'the Import button is off until the decisions are made');
  // make the decisions
  const tr = p.q(`[data-person="${spaced}"]`);
  p.q('[data-handle]', tr).value = 'lexie_cole';
  await p.click(p.q('[data-skip]', p.q(`[data-person="${skipme}"]`)));
  assert.equal(p.q('[data-handle]', p.q(`[data-person="${skipme}"]`)).disabled, true, 'ticking Skip switches the handle box off');
  p.q(`[data-go="${go}"] [data-artist]`).value = artist;
  p.q('[data-status="Odd status"] select').value = 'cancelled';
  await p.click(p.byText('button', 'Save and preview'));
  rep = text(p, '#impReport');
  assert.doesNotMatch(rep, /Not ready to import yet/);
  assert.match(text(p, '[data-headline]'), /3 claims \(1 cancelled\) for 2 people \(2 new, 0 already on the site\) across 1 group orders \(1 new, 0 already there\) and 3 items\./);
  assert.match(text(p, '[data-money]'), /Total due £37\.00 · paid so far £30\.00 · still owed £3\.00 · £2\.00 paid beyond what was due/);
  assert.match(rep, /Paid more than was due \(1\).*not turned into credit automatically.*@lexie_cole — £2\.00 \(Photocards\)/s);
  assert.match(rep, /Left out: 1 with no joiner \(or skipped\)/);
  assert.equal(p.q('[data-act="run"]').disabled, false);
  const claimsBefore = await cnt('claims');
  // import: asks first
  await p.click(p.q('[data-act="run"]'));
  assert.match(p.text(modal(p)), /Import 3 claims for 2 people across 1 group orders\?.*recorded as having paid £30\.00 and as still owing £3\.00.*hidden and closed.*You can undo this afterwards/s);
  await press(p, 'Not yet');
  assert.equal(await cnt('claims'), claimsBefore, 'saying "not yet" imported nothing');
  await p.click(p.q('[data-act="run"]')); await press(p, 'Import them');
  assert.match(toast(p), /Imported 3 claims/);
  assert.match(text(p, '[data-result]'), /3 claims created, 2 new people \(0 already existed — their claims were added to their existing accounts\), 1 new group orders, 3 items, and 2 imported payments/);
  assert.equal(await cnt('claims'), claimsBefore + 3);
  assert.equal((await app.q('SELECT ag.name FROM group_orders go JOIN artist_groups ag ON ag.id = go.group_id WHERE go.title = ?', [go]))[0].name, artist.trim());
  assert.equal((await api('GET', '/api/admin/claims?handle=lexie_cole')).json.claims[0].pipeline, 'completed');
  assert.match(text(p, '.itemrow[data-batch]'), /Claims_all\.csv.*imported.*3 claims for 2 people/s);
  // undo: asks first, explains, then removes everything
  await p.click(p.byText('button', 'Undo this import'));
  assert.match(p.text(modal(p)), /Undo the import of "Claims_all\.csv"\?.*Everything it created is removed.*Anything that existed before is left alone.*can't be done once payments have been made/s);
  await press(p, 'Keep it');
  assert.equal(await cnt('claims'), claimsBefore + 3);
  await p.click(p.byText('button', 'Undo this import')); await press(p, 'Undo the import');
  assert.match(toast(p), /Undone — removed 3 claims/);
  assert.equal(await cnt('claims'), claimsBefore);
  assert.match(text(p, '.itemrow[data-batch]'), /undone/);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('negative amounts are explained, and the preview lists what the site cannot represent', async () => {
  const [h, go] = [u('neg'), u('Neg GO')];
  const p = await open();
  await choose(p, csv([row({ joiner: h, go, item: 'Refunded thing', initials: -12.5, paid: 0, status: 'Awaiting Fulfilment' })]));
  await p.choose(p.q('#impScope2'), 'all');
  await p.click(p.byText('button', 'Save and preview'));
  assert.match(text(p, '[data-negatives]'), /Negative amounts \(1\).*imported as £0\.00.*may mean someone is owed money.*-£12\.50 initials \(Refunded thing\)/s);
  p.close();
});

test('a draft can be reopened later and discarded, and a "wrong scope" choice is respected', async () => {
  const [h, go] = [u('draft'), u('Draft GO')];
  let p = await open();
  await choose(p, csv([row({ joiner: h, go, item: 'Old', status: 'Completed' }), row({ joiner: h, go, item: 'New', status: 'Ordered via Proxy' })]));
  assert.equal(p.q('#impScope2').value, 'ongoing', 'ongoing is the default');
  await p.click(p.byText('button', 'Save and preview'));
  assert.match(text(p, '[data-headline]'), /^1 claim \(0 cancelled\)/);
  p.close();
  p = await open();
  assert.match(text(p, '.itemrow[data-batch]'), /draft — not imported yet/);
  await p.click(p.byText('button', 'Open'));
  assert.ok(p.q('#impPeople'), 'the saved draft opens again');
  await p.click(p.byText('button', 'Discard')); await press(p, 'Discard it');
  assert.equal(p.q('#impPeople'), null);
  p.close();
});

test('names, orders and statuses with HTML in them are shown as text', async () => {
  const p = await open();
  await choose(p, csv([row({ joiner: '<img src=x onerror="window.pwned=1"> name', go: '<b>Bold GO</b>', item: '<script>window.pwned=2</script>', status: '<i>odd</i>' })]));
  assert.equal(p.q('#tabBody img'), null); assert.equal(p.q('#tabBody b'), null); assert.equal(p.q('#tabBody script'), null);
  assert.match(text(p), /<img src=x onerror="window\.pwned=1"> name/);
  assert.match(text(p), /<b>Bold GO<\/b>/);
  assert.equal(p.window.pwned, undefined);
  p.close();
});

test('a guessed handle only counts once you confirm it: Save alone confirms nothing; "Looks right", editing it, or the all-button each do', async () => {
  const [a, b, c, go] = [`${u('g')} one`, `${u('g')} two`, `${u('g')} three`, u('Guess GO')];
  const p = await open();
  await choose(p, csv([row({ joiner: a, go, item: 'A' }), row({ joiner: b, go, item: 'B' }), row({ joiner: c, go, item: 'C' })]));
  const preview = () => p.click(p.byText('button', 'Save and preview'));
  const blockers = () => (p.q('[data-blockers]') ? text(p, '[data-blockers]') : '');
  await preview();
  assert.match(blockers(), /3 names still need a handle \(or Skip\)/, 'pressing Save/preview did not quietly accept the guesses');
  await p.click(p.q('[data-confirm]', p.q(`[data-person="${a}"]`))); await preview();
  assert.match(blockers(), /2 names still need a handle/, '"Looks right" confirms one');
  p.q('[data-handle]', p.q(`[data-person="${b}"]`)).value = 'my_own_choice'; await preview();
  assert.match(blockers(), /1 name still needs a handle/, 'typing a handle of your own is a decision too');
  await p.click(p.byText('button', 'Tick Looks right on all the guesses')); await preview();
  assert.equal(p.q('[data-blockers]'), null, 'every guess confirmed: nothing is blocking the import');
  assert.equal(p.q('[data-act="run"]').disabled, false);
  assert.deepEqual((await api('GET', `/api/admin/import/batches/${(await app.q('SELECT MAX(id) AS id FROM import_batches'))[0].id}`)).json.people.map((x) => x.mapped).sort(), [a.replace(/ /g, ''), 'my_own_choice', c.replace(/ /g, '')].sort());
  p.close();
});

// ───────── "Imports so far": folded away, a one-line summary, correct counts and plurals ─────────
const upload = async (name, rows) => { const r = await fetch(`${app.base}/api/admin/import/notion?filename=${encodeURIComponent(name)}`, { method: 'POST', headers: { cookie: admin, 'X-Requested-With': 'sos', 'Content-Type': 'text/csv' }, body: csv(rows) }); return { status: r.status, json: await r.json() }; };
const asImported = (id, claims, people) => app.q("UPDATE import_batches SET status = 'imported', imported_at = NOW(), summary = ? WHERE id = ?", [JSON.stringify({ counts: { claims, people: { total: people } } }), id]);
const drafts = async () => (await api('GET', '/api/admin/import/batches')).json.batches.filter((b) => b.status === 'draft').length;

test('IMPORTS SO FAR is folded away by default, with a one-line summary: how many, when the last was, and what it brought in', async () => {
  const a = await upload(`${u('first')}.csv`, [row({ joiner: u('h'), item: 'A' })]); assert.equal(a.status, 201, JSON.stringify(a.json)); await asImported(a.json.id, 1, 1);
  const b = await upload(`${u('second')}.csv`, [row({ joiner: u('h'), item: 'B' }), row({ joiner: u('h'), item: 'C' })]); await asImported(b.json.id, 25, 3);
  const p = await open(); await sleep(100); await p.settle(); const d = p.q('#pastImports');
  assert.ok(d && d.tagName === 'DETAILS'); assert.equal(d.open, false, 'folded away until you open it');
  assert.match(p.text(p.q('summary', d)), /^Imports so far \(\d+\) — last \d\d\/\d\d\/\d{4}, \d\d:\d\d: 25 claims for 3 people/, 'the latest one is described on the summary line');
  assert.ok(p.q('[data-batch]', d), 'the list is inside it'); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('THE LIST SAYS THE RIGHT THINGS: a real row count (never "undefined"), and "1 claim for 1 person" / "2 rows" / "25 claims for 3 people"', async () => {
  const one = (await upload(`${u('single')}.csv`, [row({ joiner: u('h'), item: 'Only' })])).json.id; await asImported(one, 1, 1);
  const many = (await upload(`${u('many')}.csv`, [row({ joiner: u('h'), item: 'X' }), row({ joiner: u('h'), item: 'Y' })])).json.id; await asImported(many, 25, 3);
  const list = (await api('GET', '/api/admin/import/batches')).json.batches; assert.deepEqual([list.find((x) => x.id === one).rowCount, list.find((x) => x.id === many).rowCount], [1, 2], 'the list endpoint sends rowCount');
  const p = await open(); await sleep(100); await p.settle(); const sub = (id) => p.text(p.q('.sub', p.q(`[data-batch="${id}"]`)));
  assert.match(sub(one), /· 1 row · 1 claim for 1 person · imported/); assert.match(sub(many), /· 2 rows · 25 claims for 3 people · imported/); assert.doesNotMatch(p.text(p.q('#pastImports')), /undefined|NaN/); p.close();
});

test('OPENING IT STAYS OPEN: discarding something redraws the screen without folding it away again; an unfinished upload is called out on the summary, and the count follows', async () => {
  const draft = (await upload(`${u('draft')}.csv`, [row({ joiner: u('h'), item: 'D' })])).json.id; const n = await drafts();
  const p = await open(); await sleep(100); await p.settle(); const sum = () => p.text(p.q('#pastImports summary'));
  assert.match(sum(), new RegExp(`${n} unfinished uploads? — open to resume`)); assert.equal(p.q('#pastImports').open, false);
  p.q('#pastImports').open = true; await p.click(p.q(`[data-batch="${draft}"] [data-act="discard"]`)); await press(p, 'Discard it'); await sleep(300); await p.settle();
  const after = p.q('#pastImports'); assert.ok(after, 'the list is still there'); assert.equal(after.open, true, 'and still open'); assert.equal(await drafts(), n - 1);
  assert.equal(p.q(`[data-batch="${draft}"]`), null, 'the discarded upload is gone from the list'); p.close();
});
