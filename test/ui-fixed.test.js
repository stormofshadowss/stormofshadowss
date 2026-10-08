import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { openPage, gomPage, modal, press, toast } from './ui.helpers.js';

let app, admin, w, N = 0;
const ROSTER = ['Bang Chan', 'Han', 'Felix', 'Hyunjin'];
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const newItem = async (title = 'Fixed set', members = ROSTER, price = 8) => (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: `${title} ${++N}`, price, members })).json.id;
const addFixed = (item, handle, member) => api('POST', `/api/admin/items/${item}/fixed`, { handle, member });
const fixedOf = async (item) => (await api('GET', `/api/admin/items/${item}/fixed`)).json.fixed;
const setsOf = async (item) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item);
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
const member = async (h) => joinerSession(app, `${h}@x.com`, h);
const mine = (c) => openPage(app, '/my.html', { cookies: [c] });
const go = async (p, hash) => { if (p.window.location.hash === hash) p.window.dispatchEvent(new p.window.HashChangeEvent('hashchange')); else p.window.location.hash = hash; await new Promise((r) => setTimeout(r, 30)); await p.settle(); };
const text = (p, sel = '#view') => p.text(p.q(sel));

// ───────────── the GOM: fixed claimers on an item ─────────────
async function openFixed(p, itemTitleStart) {
  await p.click(p.byText('#tabs button', 'Group Orders'));
  const o = (await api('GET', '/api/admin/orders')).json.orders.find((x) => x.title === 'Run It GO');
  await p.click(p.q(`[data-act="open-items"][data-id="${o.id}"]`));
  const row = p.byText('#itemsPanel tbody tr', itemTitleStart);
  await p.click(p.q('[data-act="fixed"]', row));
}

test('GOM: add fixed claimers to a set item — each reserved in the earliest set with that part free', async () => {
  const item = await newItem('Panel set');
  const p = await gomPage(app, admin);
  await openFixed(p, `Panel set ${N}`);
  assert.match(text(p, '#fixedPanel'), /Fixed claimers — Panel set.*No fixed claimers yet/);
  const form = () => p.q('form[data-form="add-fixed"]');
  form().elements.handle.value = '@Reg_One'; form().elements.member.value = 'Bang Chan'; await p.submit(form());
  assert.match(toast(p), /Added — reserved in Set 1/);
  form().elements.handle.value = 'reg_two'; form().elements.member.value = 'Bang Chan'; await p.submit(form());
  assert.match(toast(p), /Added — reserved in Set 2/, 'two people on one member go in different sets');
  form().elements.handle.value = 'reg_three'; form().elements.member.value = 'Han'; await p.submit(form());
  assert.match(toast(p), /Set 1/, 'a different member packs into the existing Set 1');
  const t = text(p, '#fixedPanel');
  assert.match(t, /@reg_one.*Bang Chan.*Set 1.*not secured yet/); assert.match(t, /@reg_two.*Bang Chan.*Set 2/); assert.match(t, /@reg_three.*Han.*Set 1/);
  assert.equal((await fixedOf(item)).length, 3);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('GOM: mistakes are explained — bad handle, the same person and member twice, a blocked handle', async () => {
  const p = await gomPage(app, admin);
  await openFixed(p, `Panel set ${N}`);
  const form = () => p.q('form[data-form="add-fixed"]');
  form().elements.handle.value = 'not a handle!'; await p.submit(form());
  assert.match(p.text(p.q('form[data-form="add-fixed"] [data-msg]')), /not a valid Instagram handle/);
  form().elements.handle.value = 'reg_one'; form().elements.member.value = 'Bang Chan'; await p.submit(form());
  assert.match(p.text(p.q('form[data-form="add-fixed"] [data-msg]')), /already have a fixed claim on Bang Chan/);
  await api('POST', '/api/admin/joiners/block', { handle: 'blocked_reg', reason: 't' });
  form().elements.handle.value = 'blocked_reg'; await p.submit(form());
  assert.match(p.text(p.q('form[data-form="add-fixed"] [data-msg]')), /blocked/);
  p.close();
});

test('GOM: removing a fixed claimer asks first, explains the money, and frees the part', async () => {
  const item = (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.title === 'Run It GO').items.find((i) => i.title === `Panel set ${N}`).id;
  const p = await gomPage(app, admin);
  await openFixed(p, `Panel set ${N}`);
  await p.click(p.q('[data-act="remove-fixed"][data-handle="reg_three"]'));
  assert.match(text(p, '.ui-modal'), /Remove @reg_three's fixed claim on Han\?.*claim is cancelled.*credit.*opens up/s);
  await press(p, 'Keep it');
  assert.equal((await fixedOf(item)).length, 3);
  await p.click(p.q('[data-act="remove-fixed"][data-handle="reg_three"]')); await press(p, 'Remove it');
  assert.match(toast(p), /Removed\./);
  assert.equal((await fixedOf(item)).length, 2);
  assert.equal(p.q('[data-fixed]') && p.qa('[data-fixed]').length, 2);
  p.close();
});

test('GOM: copy the regulars from another comeback, and be told what was skipped', async () => {
  const from = await newItem('Copy from', ROSTER), to = await newItem('Copy to', ROSTER.slice(0, 2));
  await addFixed(from, 'cp_x', 'Bang Chan'); await addFixed(from, 'cp_y', 'Hyunjin');
  const p = await gomPage(app, admin);
  await openFixed(p, `Copy to ${N}`);
  const form = () => p.q('form[data-form="copy-fixed"]');
  assert.ok([...form().elements.from.options].some((o) => new RegExp(`Copy from ${N - 1}`).test(o.textContent)));
  form().elements.from.value = String(from); await p.submit(form());
  assert.match(toast(p), /Copied 1 regular\./);
  assert.match(text(p, '.ui-modal'), /Some weren't copied.*@cp_y.*Hyunjin.*isn't part of/s);
  await press(p, 'OK');
  assert.deepEqual((await fixedOf(to)).map((f) => [f.handle, f.member]), [['cp_x', 'Bang Chan']]);
  p.close();
});

test('GOM: requests from regulars whose set is secured appear on the Sets tab with a badge, and can be approved or declined', async () => {
  const item = await newItem('Request set');
  const a = `rq_a${N}`, b = `rq_b${N}`; const ca = await member(a), cb = await member(b);
  await addFixed(item, a, 'Han'); await addFixed(item, b, 'Felix');
  await api('POST', `/api/admin/sets/${(await setsOf(item))[0].id}/secure`, {});
  const fa = (await app.api('GET', '/api/my/fixed', undefined, ca)).json.fixed[0], fb = (await app.api('GET', '/api/my/fixed', undefined, cb)).json.fixed[0];
  await app.api('POST', `/api/my/fixed/${fa.id}/change`, { action: 'ot8' }, ca); await app.api('POST', `/api/my/fixed/${fb.id}/change`, { action: 'giveup' }, cb);
  const p = await gomPage(app, admin);
  assert.ok(Number(p.q('#tabs [data-tab="sets"] .badge').textContent) >= 2, 'the Sets tab badge counts waiting requests');
  await p.click(p.byText('#tabs button', 'Sets'));
  const t = text(p, '#tabBody');
  assert.match(t, new RegExp(`@${a} wants to swap to the full set.*Han · Set 1`));
  assert.match(t, new RegExp(`@${b} wants to give up this claim.*Felix · Set 1`));
  await p.click(p.q(`[data-act="approve-req"][data-handle="${a}"]`));
  assert.match(text(p, '.ui-modal'), /swap to the full set\?.*Their fixed claim ends.*full set is placed for them in a set that is still open/s);
  await press(p, 'Cancel');
  assert.equal((await claimsOf(a))[0].status, 'confirmed', 'cancelling the dialog did nothing');
  await p.click(p.q(`[data-act="approve-req"][data-handle="${a}"]`)); await press(p, 'Approve it');
  assert.match(toast(p), /Approved\. Full set placed in Set 2/);
  assert.equal((await claimsOf(a)).filter((c) => c.status !== 'cancelled').length, 4);
  await p.click(p.q(`[data-act="decline-req"]`));
  assert.match(toast(p), /Declined — nothing changes/);
  assert.equal((await claimsOf(b))[0].status, 'confirmed', 'a declined request changes nothing');
  assert.match(text(p, '#tabBody'), /No sets here|Sets/);
  assert.equal(p.q('[data-req]'), null, 'no requests left');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('GOM: the Sets tab marks reserved parts as fixed', async () => {
  const item = await newItem('Marked set'); await addFixed(item, `mk${N}`, 'Han');
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Sets'));
  assert.match(text(p, `[data-set="${(await setsOf(item))[0].id}"]`), new RegExp(`Han.*@mk${N} requested fixed`));
  p.close();
});

// ───────────── the joiner ─────────────
test('joiner: no Fixed claims card unless you have some; with them, the page shows each with its price and whether a change is instant', async () => {
  const none = await member(`nofix${++N}`);
  const p0 = await mine(none);
  assert.equal(p0.q('a.gocard[href="#/fixed"]'), null);
  p0.close();
  const h = `fx${++N}`; const c = await member(h); const item = await newItem('Joiner set');
  await addFixed(item, h, 'Han');
  const p = await mine(c);
  assert.match(text(p, 'a.gocard[href="#/fixed"]'), /Fixed claims.*1 standing claim/);
  await go(p, '#/fixed');
  const t = text(p);
  assert.match(t, /Fixed claims.*Run It GO.*Joiner set \d+.*Your fixed claim: Han · £8\.00 · Set 1.*Not secured yet.*You can change this straight away/);
  assert.ok(p.byText('button', 'Swap to the full set') && p.byText('button', 'Give it up'));
  p.close();
});

test('joiner: instant swap to the full set — the dialog does the maths, "Keep it" changes nothing, and the result is explained', async () => {
  const h = `sw${++N}`; const c = await member(h); const item = await newItem('Swap set');
  await addFixed(item, h, 'Han');
  const p = await mine(c); await go(p, '#/fixed');
  await p.click(p.byText('button', 'Swap to the full set'));
  assert.match(text(p, '.ui-modal'), /Swap to the full OT8 on "Swap set \d+"\?.*one of each member in the same set: 4 × £8\.00 = £32\.00, instead of £8\.00 for Han/s);
  await press(p, 'Keep it');
  assert.equal((await fixedOf(item)).length, 1);
  await p.click(p.byText('button', 'Swap to the full set')); await press(p, 'Swap to the full set');
  assert.match(text(p, '[data-result]'), /You now hold a full OT8 in Set 1 — 4 × £8\.00 = £32\.00, owed once the set is secured\./);
  assert.doesNotMatch(text(p, '[data-result]'), /slot is now open/, 'it landed in the same set, so the slot is theirs again');
  assert.match(text(p), /You have no fixed claims right now/);
  assert.equal((await claimsOf(h)).filter((x) => x.status !== 'cancelled').length, 4);
  p.close();
});

test('joiner: giving it up is instant before the set is secured, and explains what happened to the slot', async () => {
  const h = `gu${++N}`; const c = await member(h); const item = await newItem('Giveup set');
  await addFixed(item, h, 'Felix');
  const p = await mine(c); await go(p, '#/fixed');
  await p.click(p.byText('button', 'Give it up'));
  assert.match(text(p, '.ui-modal'), /Give up your fixed Felix on "Giveup set \d+"\?.*no longer be claiming anything.*opens up for others/s);
  assert.doesNotMatch(text(p, '.ui-modal'), /sends a request/);
  await press(p, 'Give it up');
  assert.match(text(p, '[data-result]'), /You're no longer claiming anything on this item\. Your fixed Felix slot is now open to other joiners\./);
  assert.equal((await claimsOf(h))[0].status, 'cancelled');
  p.close();
});

test('joiner: once the set is secured a change becomes a request — it says so, waits, can be withdrawn, and the outcome is recorded', async () => {
  const h = `rq${++N}`; const c = await member(h); const item = await newItem('Secured set');
  await addFixed(item, h, 'Han');
  await api('POST', `/api/admin/sets/${(await setsOf(item))[0].id}/secure`, {});
  const p = await mine(c); await go(p, '#/fixed');
  assert.match(text(p), /Set secured.*already secured, so the GOM needs to approve a change/);
  await p.click(p.byText('button', 'Give it up'));
  assert.match(text(p, '.ui-modal'), /This set is already secured, so this sends a request to the GOM/);
  await press(p, 'Give it up');
  assert.match(text(p, '[data-result]'), /Request sent — the GOM will approve or decline it/);
  assert.match(text(p), /Request sent — give up this claim\. Waiting for the GOM to approve it/);
  assert.equal(p.byText('button', 'Give it up'), undefined, 'the change buttons are replaced while a request is waiting');
  assert.equal((await claimsOf(h))[0].status, 'confirmed', 'nothing changed yet');
  assert.match(text(p), /Your requests.*Give it up.*waiting for the GOM/);
  await p.click(p.byText('button', 'Withdraw request'));
  assert.match(toast(p), /Request withdrawn/);
  assert.match(text(p), /Your requests.*withdrawn/);
  await p.click(p.byText('button', 'Swap to the full set')); await press(p, 'Swap to the full set');
  const reqId = (await api('GET', '/api/admin/fixed-requests')).json.requests.find((r) => r.handle === h).id;
  await api('POST', `/api/admin/fixed-requests/${reqId}/approve`, {});
  await go(p, '#/fixed');
  assert.match(text(p), /Your requests.*approved.*withdrawn/s);
  assert.deepEqual(p.errors, []);
  p.close();
});

test('joiner: a mixed-price set words the swap with the real total, and HTML in names is shown as text', async () => {
  const h = `mx${++N}`; const c = await member(h);
  const item = (await api('POST', `/api/admin/orders/${w.order}/items`, { type: 'set', title: '<img src=x onerror="window.pwned=1"> Greetings', price: 3, members: ['Han', { name: 'Diary', price: 2 }, { name: 'Washi tape', price: 1 }] })).json.id;
  await addFixed(item, h, 'Han');
  const p = await mine(c); await go(p, '#/fixed');
  assert.equal(p.q('#view img'), null);
  assert.match(text(p), /<img src=x onerror="window\.pwned=1"> Greetings/);
  await p.click(p.byText('button', 'Swap to the full set'));
  assert.match(text(p, '.ui-modal'), /Swap to the full set on.*every part in the same set: the whole set = £6\.00, instead of £3\.00 for Han/s);
  await press(p, 'Keep it');
  assert.equal(p.window.pwned, undefined);
  p.close();
});
