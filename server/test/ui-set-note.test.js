import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { openPage } from './ui.helpers.js';

// Member sets carry a note joiners can see: a set one member short (e.g. 7 of 8 claimed) may still go through; if no buyer is found for the remaining member before the payment deadline, its cost is split
// amongst the set and the card is raffled to the set. (It is true to what the GOM's Sets tab does: secure the set, split the open part's cost across the claims, raffle the part.)
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Set note GO ${++N}`, proxy: 'Sam', paymentDeadline: '2099-01-01' })).json.id;
const item = async (go, title, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title, ...extra })).json.id;
const open = async (go) => { const p = await openPage(app, '/'); await sleep(250); await p.settle(); p.window.location.hash = `#/order/${go}`; await sleep(250); await p.settle(); return p; };
const card = (p, id) => p.q(`[data-item-card="${id}"]`);
const NOTE = 'If a set is one member short (for example 7 of 8 claimed), it may still go through. If no buyer is found for the remaining member before the payment deadline, its cost is split amongst everyone in the set and the card is raffled to the set.';
const APPROVED = 'Press + on the members you want. Each goes in the first available set with a free space for it, or a new set starts if there isn’t one. You can also choose to keep your members in the same set but this may affect if your claim goes through or not.';

test('EVERY ORDINARY MEMBER SET SHOWS THE NOTE, in your wording, right under the existing explanation and above the members — once per set', async () => {
  const go = await goOrder(); const a = await item(go, 'OT8 Digipack', { type: 'set', members: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] }), b = await item(go, 'Unit Digipack', { type: 'set', members: ['One', 'Two'] }); const p = await open(go);
  for (const id of [a, b]) { const c = card(p, id); const notes = p.qa('[data-set-short-note]', c); assert.equal(notes.length, 1, 'once'); assert.equal(p.text(notes[0]), NOTE); const kids = [...notes[0].parentElement.children]; const at = kids.indexOf(notes[0]); assert.match(p.text(kids[at - 1]), /^Press \+ on the members you want/, 'directly under the explanation'); assert.ok(kids[at + 1].classList.contains('opts'), 'and above the members'); }
  assert.deepEqual([p.errors], [[]]); p.close();
});

test('THE GOM-APPROVED EXPLANATION IS UNTOUCHED (word for word) — the note is separate, not a rewrite of it', async () => {
  const go = await goOrder(); const a = await item(go, 'Words set', { type: 'set', members: ['A', 'B'] }); const p = await open(go); const para = [...card(p, a).querySelectorAll('p.sub')].map((x) => p.text(x)); assert.ok(para.includes(APPROVED), 'the approved wording is exactly as it was'); assert.ok(para.includes(NOTE)); assert.notEqual(APPROVED, NOTE); p.close();
});

test('IT IS ONLY ON MEMBER SETS: not on ordinary items, member items, sizes or random items — and not on the Shop page', async () => {
  const go = await goOrder(); const plain = await item(go, 'Plain'), mem = await item(go, 'Per member', { type: 'independent', members: ['Han', 'Felix'] }), sz = await item(go, 'Sized', { type: 'size', variants: ['M', 'L'] }), rnd = await item(go, 'Random', { type: 'random' }); const p = await open(go);
  for (const id of [plain, mem, sz, rnd]) assert.equal(p.q('[data-set-short-note]', card(p, id)), null, `item ${id}`); assert.equal(p.qa('[data-set-short-note]').length, 0); p.window.location.hash = '#/shop'; await sleep(250); await p.settle(); assert.equal(p.q('[data-set-short-note]'), null); p.close();
});

test('SETS THAT NEED EVERY PART ARE NOT TOLD THIS (it would be untrue — they can\'t go ahead until full); they keep their own "every part must be claimed" line', async () => {
  const go = await goOrder(); const strict = await item(go, 'All or nothing', { type: 'set', members: ['A', 'B', 'C'], requiresFullSet: true }); const ok = await item(go, 'Flexible set', { type: 'set', members: ['A', 'B', 'C'] }); const p = await open(go);
  assert.equal(p.q('[data-set-short-note]', card(p, strict)), null); assert.match(p.text(card(p, strict)), /every part must be claimed for it to go ahead/); assert.ok(p.q('[data-set-short-note]', card(p, ok)), 'the flexible one still has it'); p.close();
});

test('IT STAYS ON A SET THAT HAS CLOSED FOR NEW CLAIMS (people who already claimed still want to know what happens)', async () => {
  const go = await goOrder(); const a = await item(go, 'Closing set', { type: 'set', members: ['A', 'B'] }); await api('PATCH', `/api/admin/items/${a}`, { closed: true }); const p = await open(go); assert.equal(p.text(p.q('[data-set-short-note]', card(p, a))), NOTE); p.close();
});
