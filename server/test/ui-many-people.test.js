import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure, tickParcel } from './helpers.js';
import { openPage, gomPage, modal, press, toast } from './ui.helpers.js';

const READY = 'ready to pack / on hand';
let app, admin, w, N = 0, ITEM;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const go = (await app.api('POST', '/api/admin/orders', { groupId: w.group, title: 'UI many GO' }, admin)).json.id;
  const mk = async (title, price) => (await app.api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price }, admin)).json.id;
  ITEM = { a: await mk('Album', 20), b: await mk('Badge', 5) };
});
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'mn') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p, sel = '#view') => p.text(p.q(sel));
const go = async (p, hash) => { if (p.window.location.hash === hash) p.window.dispatchEvent(new p.window.HashChangeEvent('hashchange')); else p.window.location.hash = hash; await sleep(30); await p.settle(); };
const btn = (p, re, root) => p.qa('button', root).find((b) => re.test(p.text(b)));
async function person(handle = u(), weight = null) {
  const cookie = await joinerSession(app, `${handle}@x.com`, handle);
  await api('PUT', '/api/my/address', { fullName: `${handle} Name`, address: `1 ${handle} Road`, email: `${handle}@x.com`, phone: '0700' }, cookie);
  const [id] = await claimAndSecure(app, admin, handle, ITEM.a);
  await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY, ...(weight ? { weightG: weight } : {}) });
  return { handle, cookie, ids: [id] };
}
const request = (p, body = {}) => api('POST', '/api/my/parcels', { claimIds: p.ids, method: 'UK Royal Mail Tracked 48', addressConfirmed: true, ...body }, p.cookie);
const requestWW = (p, body = {}) => request(p, { method: 'WW Tracked', declaredValue: 'true', ...body });
const accept = (p, id) => api('POST', `/api/my/parcels/${id}/companion/accept`, { claimIds: p.ids }, p.cookie);
const myPage = (p) => openPage(app, '/my.html', { cookies: [p.cookie] });
async function group(n, { ww = false, weights = [] } = {}) {
  const a = await person(u('rcpt'), weights[0] || null), fr = [];
  for (let i = 0; i < n; i++) fr.push(await person(u('frnd'), weights[i + 1] || null));
  const r = await (ww ? requestWW : request)(a, { shareWith: fr.map((f) => f.handle) });
  for (const f of fr) await accept(f, r.json.id);
  return { a, fr, id: r.json.id };
}
const costs = async (ids, cat) => Math.round((await app.q('SELECT COALESCE(SUM(cost), 0) AS s FROM claim_costs WHERE category = ? AND claim_id IN (?)', [cat, ids]))[0].s * 100) / 100;
const queueCard = (p, id) => p.q(`[data-parcel="${id}"]`);
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Packing')); return p; };

// ───────────── the joiner side ─────────────
test('naming several friends in the box asks each; the parcel lists them all, with a way to withdraw each — and to ask another friend', async () => {
  const [a, b, c, d] = [await person(u('rcpt')), await person(u('b')), await person(u('c')), await person(u('d'))];
  const x = await person(u('x'));
  const p = await myPage(a); await go(p, '#/ship');
  const form = () => p.q('form[data-form="ship"]');
  p.q('input[name="claim"]').checked = true; await p.choose(form().elements.method, 'UK Royal Mail Tracked 48');
  form().elements.addressConfirmed.checked = true; form().elements.shareWith.value = `@${b.handle}, @${c.handle} ${d.handle}`;
  await p.submit(form());
  assert.match(text(p, '[data-sent]'), new RegExp(`We've asked @${b.handle}, @${c.handle} and @${d.handle} to share it — it can't be packed until they have all answered`));
  const lines = p.qa('[data-share="invited"]').map((e) => p.text(e));
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => /Withdraw the invitation/.test(l)));
  assert.match(text(p, '[data-parcel]'), /This parcel can't be packed until everyone you asked has answered/);
  // take one back: the confirmation names who
  await p.click(btn(p, /^Withdraw the invitation/, p.qa('[data-share="invited"]')[1]));
  assert.match(p.text(modal(p)), new RegExp(`@${c.handle} won't be asked to share this parcel any more`));
  await press(p, 'Yes, take it back');
  assert.equal(p.qa('[data-share="invited"]').length, 2);
  // ask another friend
  const inv = () => p.q('form[data-form="invite"]');
  assert.ok(inv(), 'there is room for more');
  inv().elements.handles.value = `@${x.handle}`; await p.submit(inv());
  assert.match(toast(p), new RegExp(`Asked @${x.handle}`));
  assert.equal(p.qa('[data-share="invited"]').length, 3);
  inv().elements.handles.value = '@nobody_at_all_zzz'; await p.submit(inv());
  assert.match(text(p, 'form[data-form="invite"] [data-msg]'), /isn't on the site yet/);
  assert.deepEqual(p.errors, []);
  p.close();
});

test('at the limit of 5 people there is no "ask another friend" box', async () => {
  const { a } = await group(4);
  const p = await myPage(a); await go(p, '#/ship');
  assert.equal(p.q('form[data-form="invite"]'), null);
  assert.equal(p.qa('[data-share="accepted"]').length, 4);
  assert.match(text(p, '[data-split-note]'), /Posted to your address\. Postage and packaging are split equally per person/);
  p.close();
});

test('a friend sees the OTHER friends too, and an invitation to a worldwide parcel explains the weight split', async () => {
  const { a, fr } = await group(2);
  const p = await myPage(fr[0]); await go(p, '#/ship');
  assert.match(text(p, '[data-share="friend"]'), new RegExp(`Posted together with @${a.handle}'s items \\(and @${fr[1].handle}'s\\) to @${a.handle}'s address`));
  assert.match(text(p, '[data-parcel]'), new RegExp(`@${fr[1].handle}'s items:`));
  p.close();
  const [r, f] = [await person(u('rcpt')), await person(u('frnd'))];
  await requestWW(r, { shareWith: f.handle });
  const q = await myPage(f); await go(q, '#/ship');
  assert.match(text(q, 'form[data-form="accept"]'), /shared out by the weight of each person's items — there may be more than two of you/);
  q.close();
});

test('joiners are told how their share was worked out: by weight for worldwide parcels', async () => {
  const { a, fr, id } = await group(1, { ww: true, weights: [300, 900] });
  await api('POST', `/api/admin/parcels/${id}/fees`, { doms: 12, packaging: 4 });
  const p = await myPage(fr[0]); await go(p, '#/ship');
  assert.match(text(p, '[data-fees]'), /Your share — Postage £9\.00 · Packaging £3\.00 \(split by the weight of each person's items\)/);
  assert.match(text(p, '[data-share="friend"]'), /Postage and packaging are split by the weight of each person's items/);
  p.close();
  const q = await myPage(a); await go(q, '#/ship');
  assert.match(text(q, '[data-fees]'), /Your share — Postage £3\.00 · Packaging £1\.00/);
  q.close();
});

// ───────────── the GOM ─────────────
test('GOM: a parcel shared by three people — pills, one line saying how fees are split, each friend\'s details, a checklist covering everyone, and "Tick all"', async () => {
  const { a, fr, id } = await group(2);
  const p = await open();
  const card = () => queueCard(p, id);
  assert.match(text(p, `[data-parcel="${id}"] [data-shared-pill]`), new RegExp(`shared with @${fr[0].handle}, @${fr[1].handle}`));
  assert.match(text(p, `[data-parcel="${id}"] [data-share-line]`), new RegExp(`One parcel to @${a.handle}'s address, with @${fr[0].handle}'s and @${fr[1].handle}'s items\\. Postage and packaging are split equally per person`));
  assert.equal(p.qa('[data-friend-details]', card()).length, 2);
  assert.equal(p.qa('[data-checklist] input[data-tick="item"]', card()).length, 3);
  await p.click(btn(p, /^Tick all/, card()));
  assert.match(text(p, `[data-parcel="${id}"] [data-count]`), /\d+ of \d+ ticked/);
  assert.equal(btn(p, /^Mark packed/, card()).disabled, false);
  const form = p.q(`form[data-form="fees"][data-id="${id}"]`); form.elements.doms.value = '9';
  await p.click(btn(p, /^Mark packed/, card()));
  assert.match(p.text(modal(p)), new RegExp(`@${a.handle}, @${fr[0].handle} and @${fr[1].handle} will each owe about £3\\.00 for these \\(split equally per person\\)`));
  await press(p, 'Not yet');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('GOM: the split panel — mode, each person\'s estimated weight, and typing what you weighed; saving re-shares the fees and shows each person\'s amounts', async () => {
  const { a, fr, id } = await group(1, { ww: true, weights: [200, 600] });
  await api('POST', `/api/admin/parcels/${id}/fees`, { doms: 8, packaging: 2 });
  const p = await open();
  const box = () => p.q(`[data-parcel="${id}"] [data-split]`);
  assert.match(p.text(box()), /How to split the postage and packaging between 2 people/);
  assert.equal(p.q('[data-split-mode]', box()).value, 'auto');
  assert.match(p.text(p.q('[data-split-mode]', box())), /Automatic — by weight for worldwide postage, equally per person for UK \(this one: by weight\)/);
  const row = (h) => p.q(`tr[data-person="${h}"]`, box());
  assert.match(p.text(row(a.handle)), new RegExp(`@${a.handle} \\(posted to\\).*1.*200 g.*£2\\.00.*£0\\.50`));
  assert.match(p.text(row(fr[0].handle)), new RegExp(`@${fr[0].handle}.*1.*600 g.*£6\\.00.*£1\\.50`));
  assert.equal(p.q('[data-weight]', row(a.handle)).placeholder, '200');
  assert.match(p.text(p.q('[data-split-hint]', box())), /Each person pays in proportion to their weight/);
  // you weighed a's things: they are really 1000g
  p.q('[data-weight]', row(a.handle)).value = '1000';
  await p.click(btn(p, /^Save split/, box()));
  assert.match(toast(p), /Split saved\./);
  assert.deepEqual([await costs(a.ids, 'doms'), await costs(fr[0].ids, 'doms')], [5, 3], '1000g : 600g of £8');
  const row2 = (h) => p.q(`[data-parcel="${id}"] [data-split] tr[data-person="${h}"]`);
  assert.match(p.text(row2(a.handle)), /1000 g|200 g.*£5\.00/);
  assert.equal(p.q('[data-weight]', row2(a.handle)).value, '1000');
  p.close();
});

test('GOM: switching the split to "equally" (and back to automatic) re-shares the fees; bad weights are refused before anything is sent', async () => {
  const { a, fr, id } = await group(1, { ww: true, weights: [100, 700] });
  await api('POST', `/api/admin/parcels/${id}/fees`, { doms: 8 });
  assert.deepEqual([await costs(a.ids, 'doms'), await costs(fr[0].ids, 'doms')], [1, 7]);
  let p = await open();
  const box = () => p.q(`[data-parcel="${id}"] [data-split]`);
  await p.choose(p.q('[data-split-mode]', box()), 'equal');
  await p.click(btn(p, /^Save split/, box()));
  assert.deepEqual([await costs(a.ids, 'doms'), await costs(fr[0].ids, 'doms')], [4, 4]);
  p.close();
  p = await open();
  assert.equal(p.q(`[data-parcel="${id}"] [data-split-mode]`).value, 'equal');
  p.q(`[data-parcel="${id}"] [data-weight]`).value = '12.5';
  const before = (await app.q('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?', ['parcel.split']))[0].n;
  await p.click(btn(p, /^Save split/, p.q(`[data-parcel="${id}"] [data-split]`)));
  assert.match(toast(p), /Enter a whole number of grams/);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?', ['parcel.split']))[0].n, before, 'nothing was sent');
  await p.choose(p.q(`[data-parcel="${id}"] [data-split-mode]`), 'auto'); p.q(`[data-parcel="${id}"] [data-weight]`).value = '';
  await p.click(btn(p, /^Save split/, p.q(`[data-parcel="${id}"] [data-split]`)));
  assert.deepEqual([await costs(a.ids, 'doms'), await costs(fr[0].ids, 'doms')], [1, 7], 'automatic again: worldwide goes by weight');
  p.close();
});

test('GOM: splitting ONE person off a three-person parcel, removing ONE invitation among several, and the room for more', async () => {
  const [a, b, c, d] = [await person(u('rcpt')), await person(u('b')), await person(u('c')), await person(u('d'))];
  const r = await request(a, { shareWith: [b.handle, c.handle, d.handle] });
  await accept(b, r.json.id); await accept(c, r.json.id);
  let p = await open();
  const card = () => queueCard(p, r.json.id);
  assert.match(text(p, `[data-parcel="${r.json.id}"] [data-invited-pill]`), new RegExp(`invited @${d.handle}`));
  assert.ok(p.qa(`[data-parcel="${r.json.id}"] [data-share-line]`).some((e) => new RegExp(`Waiting for @${d.handle} to say yes`).test(p.text(e))));
  await p.click(btn(p, new RegExp(`^Split @${b.handle} off`), card()));
  assert.match(p.text(modal(p)), new RegExp(`Split parcel ${r.json.id} apart\\?.*@${b.handle}'s items go back into a parcel of their own.*The others stay together`, 's'));
  await press(p, 'Split them');
  assert.match(toast(p), /Split apart/);
  assert.deepEqual((await api('GET', '/api/admin/packing')).json.parcels.find((x) => x.id === r.json.id).companions.map((x) => [x.handle, x.status]), [[c.handle, 'accepted'], [d.handle, 'invited']]);
  await p.click(btn(p, /^Remove the invitation/, card())); await press(p, 'Yes');
  assert.deepEqual((await api('GET', '/api/admin/packing')).json.parcels.find((x) => x.id === r.json.id).companions.map((x) => x.handle), [c.handle]);
  p.close();
});

test('GOM: combining into a parcel that already has friends adds another person; at 5 people the Combine button goes away', async () => {
  const { a, id } = await group(1);
  const x = await person(u('x')); const rx = await request(x);
  let p = await open();
  await p.click(btn(p, /^Combine with another parcel/, queueCard(p, id)));
  await p.click(p.q(`input[data-pick][value="${rx.json.id}"]`)); await p.click(p.q('input[data-combine-ok]'));
  assert.match(text(p, '[data-combine-panel]'), new RegExp(`checked with @${a.handle}, @.*frnd.* and @${x.handle}`));
  await p.click(btn(p, /^Combine them/, p.q('[data-combine-panel]'))); await press(p, 'Combine them');
  assert.match(toast(p), new RegExp(`Combined — parcel ${id} now holds 3 people`));
  assert.match(text(p, `[data-parcel="${id}"] [data-shared-pill]`), new RegExp(`@${x.handle}`));
  p.close();
  const full = await group(4);
  p = await open();
  assert.equal(btn(p, /^Combine with another parcel/, queueCard(p, full.id)), undefined, 'a full parcel offers no more');
  p.close();
});

test('item names with HTML in them are shown as text in the checklist and the combine list', async () => {
  const goId = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('HTML GO ') })).json.id;
  const itemId = (await api('POST', `/api/admin/orders/${goId}/items`, { type: 'normal', title: 'Mug <img src=x onerror="window.pwned=1">', price: 4 })).json.id;
  const a = await person(u('rcpt')); const b = await person(u('frnd'));
  const [claim] = await claimAndSecure(app, admin, b.handle, itemId); await api('PATCH', `/api/admin/claims/${claim}`, { pipeline: READY });
  const ra = await request(a), rb = await request({ ...b, ids: [claim] });
  const p = await open();
  await p.click(btn(p, /^Combine with another parcel/, queueCard(p, ra.json.id)));
  assert.match(text(p, '[data-combine-panel]'), /Mug <img src=x onerror="window\.pwned=1">/);
  assert.equal(p.q('#tabBody img'), null);
  await p.click(p.q(`input[data-pick][value="${rb.json.id}"]`)); await p.click(p.q('input[data-combine-ok]'));
  await p.click(btn(p, /^Combine them/, p.q('[data-combine-panel]'))); await press(p, 'Combine them');
  assert.match(text(p, `[data-parcel="${ra.json.id}"] [data-checklist]`), /Mug <img src=x onerror="window\.pwned=1">/);
  assert.equal(p.q('#tabBody img'), null); assert.equal(p.window.pwned, undefined);
  p.close();
});
