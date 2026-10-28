import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { gomPage, toast } from './ui.helpers.js';

// GOM → Group Orders → an order's items → Edit: a "Member names" section on member items and member sets, so a spelling mistake can be fixed after the item is saved.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'ur') => `${x}${++N}`;
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Edit members GO '), proxy: 'Sam' })).json.id;
const item = async (go, title, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'independent', price: 5, title, members: ['Han', 'Felix', 'Lee Know'], ...extra })).json.id;
const editPage = async (go, id) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.q(`[data-act="open-items"][data-id="${go}"]`)); await sleep(80); await p.settle(); await p.click(p.q(`[data-act="edit-item"][data-id="${id}"]`)); return p; };
const form = (p) => p.q('form[data-form="edit-item"]');
const inputs = (p) => p.qa('input[data-member-id]', form(p));
const names = async (go, id) => (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === id).members.map((m) => m.name);
const save = async (p) => { await p.submit(form(p)); await sleep(400); await p.settle(); };

test('THE EDIT FORM HAS A "MEMBER NAMES" SECTION for member items and member sets (in order, filled in); ordinary, size and random items have none', async () => {
  const go = await goOrder(); const ind = await item(go, 'Per member'), set = await item(go, 'A set', { type: 'set', members: ['A', 'B'] }), plain = await item(go, 'Plain', { type: 'normal', members: undefined }), size = await item(go, 'Sized', { type: 'size', members: undefined, variants: ['M'] });
  let p = await editPage(go, ind); assert.deepEqual(inputs(p).map((i) => i.value), ['Han', 'Felix', 'Lee Know']); assert.match(p.text(p.q('[data-members-edit]')), /^Member names\s*Fix a spelling here — the new name is carried through to any claims already made\. \(To add or remove members, make a new item\.\)$/); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
  p = await editPage(go, set); assert.deepEqual(inputs(p).map((i) => i.value), ['A', 'B']); p.close();
  for (const id of [plain, size]) { p = await editPage(go, id); assert.equal(p.q('[data-members-edit]', form(p)), null, `item ${id}`); p.close(); }
});

test('FIXING A SPELLING: change the name, Save — the roster, the claims already made (and their labels) and the joiner\'s own orders all show the new name; the message says what changed', async () => {
  const go = await goOrder(); const it = await item(go, 'Pop-up photocards'); const h = u('owner'); const cookie = await joinerSession(app, `${h}@x.com`, h); for (const handle of [h, u('other')]) await app.api('POST', '/api/claims', { handle, lines: [{ itemId: it, member: 'Han' }] });
  const p = await editPage(go, it); inputs(p)[0].value = 'Hanni'; await save(p); assert.match(toast(p), /^Saved — “Han” is now “Hanni” \(2 claims updated\)\.$/); assert.deepEqual(await names(go, it), ['Hanni', 'Felix', 'Lee Know']); assert.match(p.text(p.q('#itemsPanel')), /Hanni, Felix, Lee Know/);
  const labels = (await app.q('SELECT label FROM claims WHERE item_id = ?', [it])).map((c) => c.label); assert.deepEqual(labels, ['Pop-up photocards — Hanni', 'Pop-up photocards — Hanni']); p.close();
  const j = await app.api('GET', `/api/my/summary?handle=${h}`, undefined, cookie); assert.ok(j.json.orders.flatMap((o) => o.claims).some((c) => c.label === 'Pop-up photocards — Hanni'), 'the joiner sees the corrected name');
});

test('NOTHING CHANGED = A PLAIN "Saved."; a rename saved together with a price change mentions both', async () => {
  const go = await goOrder(); const it = await item(go, 'Plain save'); let p = await editPage(go, it); await save(p); assert.equal(toast(p), 'Saved.'); assert.deepEqual(await names(go, it), ['Han', 'Felix', 'Lee Know']); p.close();
  const h = u('rq'); await joinerSession(app, `${h}@x.com`, h); await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: it, member: 'Felix' }] });                              // an unsecured request, which a price change re-prices
  p = await editPage(go, it); inputs(p)[1].value = 'Felixx'; form(p).elements.price.value = '9'; await save(p); assert.match(toast(p), /^Saved — 1 unsecured claim now uses the new price\. Secured claims keep theirs\. Also: “Felix” is now “Felixx” \(1 claim updated\)\.$/); p.close();
});

test('A MISTAKE IS SAID PLAINLY AND NOTHING IS SAVED: a blank name; a name another member has (even in other capitals)', async () => {
  const go = await goOrder(); const it = await item(go, 'Mistakes'); let p = await editPage(go, it); inputs(p)[0].value = '   '; await save(p); assert.match(p.text(p.q('[data-msg]', form(p))), /^A member's name can't be blank\.$/); assert.deepEqual(await names(go, it), ['Han', 'Felix', 'Lee Know']); p.close();
  p = await editPage(go, it); inputs(p)[0].value = 'FELIX'; form(p).elements.title.value = 'Should not be saved either'; await save(p); assert.match(p.text(p.q('[data-msg]', form(p))), /^Another member is already called “Felix” — pick a different name\.$/); assert.deepEqual(await names(go, it), ['Han', 'Felix', 'Lee Know']);
  assert.equal((await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === go).items.find((i) => i.id === it).title, 'Mistakes', 'the rest of the form was not saved either (all or nothing)'); p.close();
});

test('MEMBER NAMES WITH HTML ARE SHOWN AS TEXT in the form and the list', async () => {
  const go = await goOrder(); const it = await item(go, 'Escaped', { members: ['<img src=x onerror="window.pwned=1">', '<b>Bold</b>'] }); const p = await editPage(go, it);
  assert.equal(p.q('img[src="x"]'), null); assert.equal(p.window.pwned, undefined); assert.equal(inputs(p)[0].value, '<img src=x onerror="window.pwned=1">'); assert.equal(inputs(p)[1].dataset.orig, '<b>Bold</b>'); inputs(p)[1].value = '<b>Bolder</b>'; await save(p); assert.deepEqual(await names(go, it), ['<img src=x onerror="window.pwned=1">', '<b>Bolder</b>']); p.close();
});
