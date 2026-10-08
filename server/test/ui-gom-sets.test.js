import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

let app, admin, w, S, P;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const add = (body) => app.api('POST', `/api/admin/orders/${w.order}/items`, body, admin).then((r) => r.json.id);
  S = await add({ type: 'set', title: 'Seasons Greetings', price: 3, requiresFullSet: true, members: ['Bang Chan', 'Han', { name: 'Diary', price: 2 }, { name: 'Washi tape', price: 1 }] });
  P = await add({ type: 'set', title: 'Photocard set', price: 8, members: ['A', 'B', 'C'] });
});
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const claim = (handle, itemId, ...parts) => api('POST', '/api/claims', { handle, lines: [{ itemId, parts: parts.map((member) => ({ member, qty: 1 })) }] }, undefined);
const sets = async (itemId) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === itemId);
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const open = async (label = 'Sets') => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', label)); return p; };
const card = (p, id) => p.q(`[data-set="${id}"]`);

test('the Sets tab lists each set with who holds each part, how full it is, and why it cannot be secured yet', async () => {
  await claim('amy_s', S, 'Bang Chan', 'Diary');
  const [s1] = await sets(S);
  const p = await open();
  const text = p.text(card(p, s1.id));
  assert.match(text, /Seasons Greetings — Set 1.*Run It GO/);
  assert.match(text, /not decided.*2\/4 filled.*every part required/);
  assert.match(text, /Bang Chan.*£3\.00.*@amy_s requested/); assert.match(text, /Diary.*£2\.00.*@amy_s requested/);
  assert.match(text, /Han.*open.*Add someone/); assert.match(text, /Washi tape.*£1\.00.*open/);
  assert.equal(p.q('[data-act="secure"]', card(p, s1.id)).disabled, true);
  assert.match(text, /Waiting for 2 more parts — this set can't go ahead unless every part is claimed/);
  assert.equal(p.q('#tabs [data-tab="sets"] .badge').textContent, '1', 'the tab shows how many sets are waiting');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('putting someone into an open part by hand: the form, mistakes explained, then it appears', async () => {
  const [s1] = await sets(S);
  const p = await open();
  await p.click(p.q(`[data-act="add"][data-set="${s1.id}"][data-member="Han"]`));
  const form = () => p.q('form[data-form="assign"]');
  form().elements.handle.value = 'not a handle!'; await p.submit(form());
  assert.match(p.text(p.q('[data-msg]', form())), /not a valid Instagram handle/);
  await api('POST', '/api/admin/joiners/block', { handle: 'blocked_s', reason: 'test' });
  form().elements.handle.value = '@Blocked_S'; await p.submit(form());
  assert.match(p.text(p.q('[data-msg]', form())), /blocked/);
  await p.click(p.byText('[data-act="cancel-add"]', 'Cancel'));
  assert.equal(form(), null, 'cancelling closes the form');
  await p.click(p.q(`[data-act="add"][data-set="${s1.id}"][data-member="Han"]`));
  form().elements.handle.value = '@Bob_S'; await p.submit(form());
  assert.match(toast(p), /Added\./);
  assert.match(p.text(card(p, s1.id)), /Han.*@bob_s requested/);
  assert.match(p.text(card(p, s1.id)), /3\/4 filled/);
  p.close();
});

test('securing: disabled until a must-be-full set is full; the dialog says what happens; "Cancel" changes nothing; confirming confirms every claim', async () => {
  const [s1] = await sets(S);
  await api('POST', `/api/admin/sets/${s1.id}/slots`, { member: 'Washi tape', handle: 'cat_s' });
  const p = await open();
  const btn = () => p.q('[data-act="secure"]', card(p, s1.id));
  assert.equal(btn().disabled, false, 'every part is claimed now');
  await p.click(btn());
  assert.match(p.text(modal(p)), /Secure Seasons Greetings — Set 1\?/);
  assert.match(p.text(modal(p)), /4 claims become confirmed, and what each person owes starts to count/);
  assert.doesNotMatch(p.text(modal(p)), /still open/);
  await press(p, 'Cancel');
  assert.deepEqual((await claimsOf('amy_s')).map((c) => c.status), ['requested', 'requested']);
  await p.click(btn()); await press(p, 'Secure it');
  assert.match(toast(p), /Secured — 4 claims confirmed/);
  assert.deepEqual((await claimsOf('amy_s')).map((c) => c.status), ['confirmed', 'confirmed']);
  assert.equal(card(p, s1.id), null, 'it has left the "waiting" list');
  await p.choose(p.q('[data-filter="decision"]'), 'secured');
  assert.match(p.text(card(p, s1.id)), /secured.*4\/4 filled/);
  assert.equal(p.q('#tabs [data-tab="sets"] .badge').hidden, true, 'the badge cleared');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('an ordinary set can be secured with parts open (your call): the dialog warns, and you can still fill the gap afterwards — confirmed at once', async () => {
  await claim('dee_s', P, 'A');
  const target = (await sets(P)).find((s) => s.parts.some((x) => x.handle === 'dee_s'));
  const p = await open();
  assert.equal(p.q('[data-act="secure"]', card(p, target.id)).disabled, false, 'no "every part" rule here');
  await p.click(p.q('[data-act="secure"]', card(p, target.id)));
  assert.match(p.text(modal(p)), /2 parts are still open and will stay open — you can put someone into them afterwards/);
  await press(p, 'Secure it');
  await p.choose(p.q('[data-filter="decision"]'), 'secured');
  assert.match(p.text(card(p, target.id)), /2 parts are still open — you can put someone into them above/);
  await p.click(p.q(`[data-act="add"][data-set="${target.id}"][data-member="B"]`));
  p.q('form[data-form="assign"]').elements.handle.value = 'eve_s'; await p.submit(p.q('form[data-form="assign"]'));
  assert.match(toast(p), /Added — and confirmed, since the set is already secured/);
  assert.equal((await claimsOf('eve_s'))[0].status, 'confirmed');
  p.close();
});

test('cancelling a set: the dialog explains the money; keeping it does nothing; confirming returns paid money as credit and frees the parts', async () => {
  const c = await joinerSession(app, 'fay_s@x.com', 'fay_s');
  const set = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: 'Cancel set', price: 10, members: ['K', 'L'] })).json.id;
  await claim('fay_s', set, 'K', 'L');
  const [s1] = await sets(set);
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  const pay = await app.api('POST', '/api/my/payments', { method: 'PayPal', amount: 20, reference: 'F' }, c);
  await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  const p = await open();
  await p.choose(p.q('[data-filter="decision"]'), 'secured');
  await p.click(p.q('[data-act="cancel-set"]', card(p, s1.id)));
  assert.match(p.text(modal(p)), /Cancel Cancel set — Set 1\?.*All 2 claims in it are cancelled.*goes back to each person as credit.*parts become free/s);
  await press(p, 'Keep it');
  assert.equal((await sets(set))[0].decision, 'secured');
  await p.click(p.q('[data-act="cancel-set"]', card(p, s1.id))); await press(p, 'Cancel the set');
  assert.match(toast(p), /Set cancelled\. £20\.00 returned as credit/);
  assert.equal((await app.api('GET', '/api/my/summary', undefined, c)).json.credit, 20);
  await p.choose(p.q('[data-filter="decision"]'), 'cancelled');
  assert.match(p.text(card(p, s1.id)), /cancelled.*0\/2 filled/);
  assert.equal(p.q('[data-act="add"]', card(p, s1.id)), null, 'no adding people to a cancelled set');
  p.close();
});

test('a stale page: acting on a set that was already decided elsewhere is explained and the screen refreshes', async () => {
  await claim('gus_s', P, 'A', 'B', 'C');
  const target = (await sets(P)).find((s) => s.decision === 'none' && s.parts.some((x) => x.handle === 'gus_s'));
  const p = await open();
  await api('POST', `/api/admin/sets/${target.id}/secure`, {});                   // done in another tab
  await p.click(p.q('[data-act="secure"]', card(p, target.id))); await press(p, 'Secure it');
  assert.match(toast(p), /already secured/);
  assert.equal(card(p, target.id), null);
  p.close();
});

test('the Claims tab: set parts wait for their set, so they are not counted in "Secure all requested", and are labelled', async () => {
  await claim('hal_s', P, 'A');
  await api('POST', '/api/claims', { handle: 'hal_s', lines: [{ itemId: w.keyring }] }, undefined);
  const p = await gomPage(app, admin);
  await p.click(p.byText('#tabs button', 'Claims'));
  const text = p.text(p.byText('#tabBody .card', 'Run It GO'));
  assert.match(text, /set parts? waiting for their set \(see the Sets tab\)/);
  const waitingNonSet = (await api('GET', '/api/admin/claims?status=requested')).json.claims.filter((c) => !c.setId).length;
  assert.match(text, new RegExp(`Secure all requested \\(${waitingNonSet}\\)`), 'only ordinary claims are counted');
  await p.click(p.q('[data-buyer="hal_s"] [data-act="toggle"]'));
  assert.match(p.text(p.byText('[data-buyer="hal_s"] tr', 'Photocard set')), /set part/);
  await p.click(p.q('[data-act="secure"]')); await press(p, 'Secure them');
  const rows = await claimsOf('hal_s');
  assert.equal(rows.find((x) => /Keyring/.test(x.label)).status, 'confirmed');
  assert.equal(rows.find((x) => /Photocard set/.test(x.label)).status, 'requested', 'the set part is untouched');
  p.close();
});

test('filters, empty states, and names with HTML are shown as text', async () => {
  const set = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: '<img src=x onerror="window.pwned=1"> set', price: 1, members: ['<b>One</b>', 'Two'] })).json.id;
  await claim('ivy_s', set, '<b>One</b>');
  const p = await open();
  assert.equal(p.q('img[src="x"]'), null);
  assert.match(p.text(p.q('#tabBody')), /<img src=x onerror="window\.pwned=1"> set — Set 1/);
  assert.match(p.text(p.q('#tabBody')), /<b>One<\/b>/);
  assert.equal(p.window.pwned, undefined);
  await p.choose(p.q('[data-filter="decision"]'), 'cancelled');
  assert.match(p.text(p.q('#tabBody')), /Cancel set — Set 1/);
  const o = (await api('GET', '/api/admin/orders')).json.orders.find((x) => x.title === 'Run It GO');
  await p.choose(p.q('[data-filter="order"]'), String(o.id));
  assert.match(p.text(p.q('#tabBody')), /Cancel set/);
  const lonely = (await api('POST', '/api/admin/orders', { groupId: w.group, title: 'Set GO with no claims' })).json.id;
  await api('POST', `/api/admin/orders/${lonely}/items`, { type: 'set', title: 'Unclaimed set', price: 1, members: ['X', 'Y'] });
  await p.click(p.byText('#tabs button', 'Sets'));                               // reload so the new order is in the list
  await p.choose(p.q('[data-filter="order"]'), String(lonely));
  assert.match(p.text(p.q('#tabBody')), /No sets here/, 'an order whose set nobody has claimed yet has no sets to show');
  p.close();
});

// ───────────── open parts: split the cost and raffle it ─────────────
let M = 0;
async function securedWithOpenPart(price = 8) {
  const item = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: `Open part ${++M}`, price, members: ['A', 'B', 'C', 'D'] })).json.id;
  const people = [`op${M}a`, `op${M}b`, `op${M}c`];
  for (const [i, h] of people.entries()) await claim(h, item, ['A', 'B', 'C'][i]);
  const [s1] = await sets(item);
  await api('POST', `/api/admin/sets/${s1.id}/secure`, {});
  return { item, set: s1.id, people };
}
const partRow = (p, set, member) => p.q(`[data-set="${set}"] tr[data-part="${member}"]`);

test('open parts: a secured set offers "Split cost & raffle" next to "Add someone"; an undecided one does not', async () => {
  const { set } = await securedWithOpenPart();
  const undecided = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: `Undecided ${++M}`, price: 3, members: ['P', 'Q'] })).json.id;
  await claim(`ud${M}`, undecided, 'P');
  const p = await open();
  await p.choose(p.q('[data-filter="decision"]'), 'all');
  const row = partRow(p, set, 'D');
  assert.ok(p.q('[data-act="add"]', row) && p.q('[data-act="split"]', row));
  const [u] = await sets(undecided);
  assert.ok(p.q(`[data-set="${u.id}"] [data-act="add"]`));
  assert.equal(p.q(`[data-set="${u.id}"] [data-act="split"]`), null, 'an unsecured set can simply be secured, left, or filled — no split yet');
  p.close();
});

test('splitting: the dialog explains the maths and that it is not auto-undoable; "Not yet" does nothing; confirming shows a pending raffle and who can win', async () => {
  const { item, set, people } = await securedWithOpenPart(8);
  const p = await open();
  await p.choose(p.q('[data-filter="decision"]'), 'secured');
  await p.click(p.q('[data-act="split"]', partRow(p, set, 'D')));
  const dialog = p.text(modal(p));
  assert.match(dialog, /Split the cost of the unclaimed D \(£8\.00\) across the 3 claims in this set\?/);
  assert.match(dialog, /Each claim takes on about £2\.67 extra.*raffle winner who receives the D at no further cost/s);
  assert.match(dialog, /can't be undone automatically.*edit the costs in Claims/s);
  await press(p, 'Not yet');
  assert.equal((await sets(item))[0].parts.find((x) => x.member === 'D').raffle, null, 'nothing was changed');
  await p.click(p.q('[data-act="split"]', partRow(p, set, 'D'))); await press(p, 'Split the cost');
  assert.match(toast(p), /Split — each of 3 claims takes on about £2\.67\. Now pick a raffle winner/);
  const row = partRow(p, set, 'D');
  assert.match(p.text(row), /raffle pending/);
  assert.equal(p.q('[data-act="add"]', row), null, 'no adding someone while a raffle is pending');
  assert.deepEqual([...p.q('select', row).options].map((o) => o.value).sort(), people.slice().sort(), 'the candidates are the people in the set');
  assert.match(p.text(p.q(`[data-set="${set}"]`)), /Each person in this set took on about £2\.67 extra for the unclaimed D part — pick a raffle winner above/);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('picking the winner: asks first, then they hold the part and the note says it was raffled', async () => {
  const { set, item, people } = await securedWithOpenPart(8);
  await api('POST', `/api/admin/sets/${set}/split`, { member: 'D' });
  const p = await open();
  await p.choose(p.q('[data-filter="decision"]'), 'secured');
  const row = () => partRow(p, set, 'D');
  p.q('select', row()).value = people[1];
  await p.click(p.byText('[data-act="raffle"]', 'Confirm winner', row()));
  assert.match(p.text(modal(p)), new RegExp(`Give the raffled D to @${people[1]}\\?.*costs them nothing more.*already paid their share`, 's'));
  await press(p, 'Not yet');
  assert.equal((await sets(item))[0].parts.find((x) => x.member === 'D').handle, null);
  await p.click(p.byText('[data-act="raffle"]', 'Confirm winner', row())); await press(p, 'Confirm winner');
  assert.match(toast(p), new RegExp(`@${people[1]} wins the D`));
  assert.match(p.text(row()), new RegExp(`@${people[1]} confirmed raffle win`));
  assert.match(p.text(p.q(`[data-set="${set}"]`)), /4\/4 filled/);
  assert.match(p.text(p.q(`[data-set="${set}"]`)), /it was raffled/);
  assert.equal(p.q('[data-act="split"]', row()), null, 'nothing more to do for that part');
  p.close();
});

test('a stale page: splitting a part that was already split elsewhere is explained and the screen refreshes', async () => {
  const { set } = await securedWithOpenPart();
  const p = await open();
  await p.choose(p.q('[data-filter="decision"]'), 'secured');
  await api('POST', `/api/admin/sets/${set}/split`, { member: 'D' });                  // done in another tab
  await p.click(p.q('[data-act="split"]', partRow(p, set, 'D'))); await press(p, 'Split the cost');
  assert.match(toast(p), /already held, or a split is already under way/);
  assert.match(p.text(partRow(p, set, 'D')), /raffle pending/, 'and the screen now shows what really happened');
  p.close();
});
