import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { gomPage, toast } from './ui.helpers.js';

// GOM → Shop: give each on-hand item an artist (in the forms, or by ticking several and setting them at once); find the ones with no artist yet.
let app, admin, w, N = 0, G;
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const group = async (name) => (await api('POST', '/api/admin/groups', { name })).json.id;
const item = async (title, groupId) => (await api('POST', '/api/admin/shop', { title, price: 3, qty: 4, ...(groupId ? { groupId } : {}) })).json.id;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); G = { a: await group('Ateez GOM'), s: await group('Stray Kids GOM') }; });
after(async () => { await app.stop(); });
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Shop')); await sleep(150); await p.settle(); return p; };
const card = (p, id) => p.q(`[data-shop="${id}"]`);
const artistOf = (p, id) => p.text(p.q('[data-artist]', card(p, id)));
const tick = async (p, ...ids) => { for (const id of ids) await p.click(p.q(`input[data-act="pick"][data-id="${id}"]`)); };
const groupOf = async (id) => (await api('GET', '/api/admin/shop')).json.items.find((i) => i.id === id).groupId;
const filter = async (p, v) => { const s = p.q('select[data-filter="group"]'); s.value = v; s.dispatchEvent(new p.window.Event('change', { bubbles: true })); await sleep(60); };

test('THE ADD AND EDIT FORMS HAVE AN "ARTIST / GROUP" CHOICE (none = shown under "Other"); the card shows the artist; saving none clears it', async () => {
  const p = await open(); const add = p.q('form[data-form="add"]'); const sel = add.elements.groupId; assert.equal(sel.options[0].textContent, 'None (shown under “Other”)'); assert.ok([...sel.options].some((o) => o.textContent === 'Ateez GOM'));
  add.elements.title.value = 'Ateez keyring'; add.elements.price.value = '4'; add.elements.qty.value = '3'; sel.value = String(G.a); await p.submit(add); await sleep(350); await p.settle();
  const id = (await api('GET', '/api/admin/shop')).json.items.find((i) => i.title === 'Ateez keyring').id; assert.equal(await groupOf(id), G.a); assert.equal(p.q('form[data-form="edit"]').elements.groupId.value, String(G.a), 'adding opens the edit panel (for the picture), already showing the artist'); await p.click(p.q('[data-act="cancel-edit"]')); assert.equal(artistOf(p, id), 'Ateez GOM', 'the card says whose it is');
  await p.click(p.q('[data-act="edit"]', card(p, id))); const edit = p.q('form[data-form="edit"]'); assert.equal(edit.elements.groupId.value, String(G.a), 'the edit form shows the current artist'); edit.elements.groupId.value = String(G.s); await p.submit(edit); await sleep(300); await p.settle(); assert.equal(await groupOf(id), G.s);
  await p.click(p.q('[data-act="edit"]', card(p, id))); const e2 = p.q('form[data-form="edit"]'); e2.elements.groupId.value = ''; await p.submit(e2); await sleep(300); await p.settle(); assert.equal(await groupOf(id), null); assert.match(artistOf(p, id), /no artist yet/); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('TICK SEVERAL AND SET THEIR ARTIST AT ONCE: the bar appears with the count, Apply sets them all, the ticks clear, the cards and the joiner list follow', async () => {
  const ids = [await item('Tick one'), await item('Tick two'), await item('Tick three'), await item('Not ticked')]; const p = await open(); assert.equal(p.q('[data-bulk]'), null, 'no bar until something is ticked');
  await tick(p, ids[0], ids[1], ids[2]); const bar = p.q('[data-bulk]'); assert.match(p.text(bar), /^3 ticked — set their artist:/); bar.querySelector('select').value = String(G.a); await p.click(p.q('[data-act="bulk-group"]'));
  await sleep(350); await p.settle(); assert.match(toast(p), /3 items set to Ateez GOM\./); assert.deepEqual(await Promise.all(ids.map(groupOf)), [G.a, G.a, G.a, null], 'only the ticked ones changed'); assert.equal(p.q('[data-bulk]'), null, 'the ticks are cleared'); assert.equal(artistOf(p, ids[0]), 'Ateez GOM'); assert.match(artistOf(p, ids[3]), /no artist yet/);
  const pub = (await app.api('GET', '/api/shop')).json; assert.equal(pub.items.find((i) => i.id === ids[0]).groupId, G.a); assert.ok(pub.groups.some((g) => g.id === G.a), 'and the joiner Shop page now has that artist');
  await tick(p, ids[0]); p.q('[data-bulk] select').value = 'none'; await p.click(p.q('[data-act="bulk-group"]')); await sleep(300); await p.settle(); assert.equal(await groupOf(ids[0]), null, '"No artist" takes it out'); assert.match(toast(p), /1 item taken out of any artist\./); p.close();
});

test('APPLY WITH NOTHING CHOSEN says so and changes nothing; "Clear ticks" clears them', async () => {
  const id = await item('Choose first'); const p = await open(); await tick(p, id); await p.click(p.q('[data-act="bulk-group"]')); await sleep(60); assert.match(toast(p), /Choose an artist first \(or “No artist”\)\./); assert.equal(await groupOf(id), null);
  await p.click(p.q('[data-act="pick-clear"]')); assert.equal(p.q('[data-bulk]'), null); assert.equal(p.q(`input[data-act="pick"][data-id="${id}"]`).checked, false); p.close();
});

test('"NO ARTIST YET" FINDS WHAT STILL NEEDS SORTING, "Tick all shown" ticks them, and applying empties the filter', async () => {
  const loose = [await item('Loose A'), await item('Loose B')]; const done = await item('Already sorted', G.s); const p = await open();
  await filter(p, 'none'); assert.match(p.text(p.q('select[data-filter="group"]').selectedOptions[0]), /^No artist yet \(\d+\)$/); assert.ok(loose.every((id) => card(p, id))); assert.equal(card(p, done), null, 'items that have an artist are hidden by this filter');
  const shownN = p.qa('[data-shop]').length; await p.click(p.byText('button', `Tick all shown (${shownN})`)); assert.equal(p.q('[data-bulk] strong').textContent, `${shownN} ticked`, 'every shown item is ticked');
  p.q('[data-bulk] select').value = String(G.a); await p.click(p.q('[data-act="bulk-group"]')); await sleep(350); await p.settle(); assert.deepEqual(await Promise.all(loose.map(groupOf)), [G.a, G.a]); assert.match(p.text(p.q('select[data-filter="group"]').selectedOptions[0]), /^No artist yet \(0\)$/); assert.equal(p.qa('[data-shop]').length, 0, 'nothing left to sort');
  await filter(p, String(G.a)); assert.ok(loose.every((id) => card(p, id)), 'and they are under their artist'); p.close();
});

test('FILTERING BY ARTIST SHOWS JUST THEIR ITEMS (and "All artists" brings everything back)', async () => {
  const s1 = await item('Skz only one', G.s); const a1 = await item('Ateez only one', G.a); const p = await open(); await filter(p, String(G.s)); assert.ok(card(p, s1)); assert.equal(card(p, a1), null);
  await filter(p, ''); assert.ok(card(p, s1) && card(p, a1)); p.close();
});

test('NAMES WITH HTML ARE SHOWN AS TEXT (artists in the choice, the bar and the cards)', async () => {
  const g = await group('<img src=x onerror="window.pwned=1"> Crew'); const id = await item('<b>Bold</b> thing', g); const p = await open(); assert.equal(p.q('img[src="x"]'), null); assert.equal(p.window.pwned, undefined);
  assert.equal(artistOf(p, id), '<img src=x onerror="window.pwned=1"> Crew'); assert.ok([...p.q('form[data-form="add"]').elements.groupId.options].some((o) => o.textContent === '<img src=x onerror="window.pwned=1"> Crew')); p.close();
});
