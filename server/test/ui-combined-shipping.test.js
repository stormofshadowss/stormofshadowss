import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure, tickParcel } from './helpers.js';
import { openPage, gomPage, modal, press, toast } from './ui.helpers.js';

const READY = 'ready to pack / on hand';
let app, admin, w, N = 0, ITEM;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const go = (await app.api('POST', '/api/admin/orders', { groupId: w.group, title: 'UI shared GO' }, admin)).json.id;
  const mk = async (title, price) => (await app.api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price }, admin)).json.id;
  ITEM = { a: await mk('Album', 20), b: await mk('Badge', 5), c: await mk('Card', 3), x: await mk('Mug <img src=x onerror="window.pwned=1">', 4) };
});
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ui') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p, sel = '#view') => p.text(p.q(sel));
const go = async (p, hash) => { if (p.window.location.hash === hash) p.window.dispatchEvent(new p.window.HashChangeEvent('hashchange')); else p.window.location.hash = hash; await sleep(30); await p.settle(); };
const btn = (p, re, root) => p.qa('button', root).find((b) => re.test(p.text(b)));
async function person(handle = u(), nItems = 1, items = [ITEM.a, ITEM.b, ITEM.c]) {
  const cookie = await joinerSession(app, `${handle}@x.com`, handle);
  await api('PUT', '/api/my/address', { fullName: `${handle} Name`, address: `1 ${handle} Road`, email: `${handle}@x.com`, phone: '0700' }, cookie);
  const ids = []; for (let i = 0; i < nItems; i++) { const [id] = await claimAndSecure(app, admin, handle, items[i]); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); ids.push(id); }
  return { handle, cookie, ids };
}
const request = (p, body = {}) => api('POST', '/api/my/parcels', { claimIds: p.ids, method: 'UK Royal Mail Tracked 48', addressConfirmed: true, ...body }, p.cookie);
const myPage = (p, hash) => openPage(app, `/my.html${hash ? '' : ''}`, { cookies: [p.cookie] });
async function shared(nA = 1, nB = 1) {
  const [a, b] = [await person(u('rcpt'), nA), await person(u('frnd'), nB)];
  const r = await request(a, { shareWith: b.handle });
  await api('POST', `/api/my/parcels/${r.json.id}/companion/accept`, { claimIds: b.ids }, b.cookie);
  return { a, b, id: r.json.id };
}
const queueCard = (p, id) => p.q(`[data-parcel="${id}"]`);

// ───────────── the person asking ─────────────
test('the request form offers "ship together with a friend"; naming one asks them, and the parcel says it is waiting — and can be taken back', async () => {
  const [a, b] = [await person(u('rcpt')), await person(u('frnd'))];
  const p = await myPage(a); await go(p, '#/ship');
  const form = () => p.q('form[data-form="ship"]');
  assert.match(text(p), /Ship together with friends \(optional\).*post one parcel to your address.*up to 5 people.*equally per person for UK postage.*by the weight of each person's items for worldwide.*signed in to this site/s);
  p.q('input[name="claim"]').checked = true; await p.choose(form().elements.method, 'UK Royal Mail Tracked 48');
  form().elements.addressConfirmed.checked = true; form().elements.shareWith.value = `@${b.handle}`;
  await p.submit(form());
  assert.match(text(p, '[data-sent]'), new RegExp(`We've asked @${b.handle} to share it — it can't be packed until they answer`));
  assert.match(text(p, '[data-share="invited"]'), new RegExp(`Waiting for @${b.handle} to answer.*Withdraw the invitation`, 's'));
  assert.match(text(p, '[data-parcel]'), /This parcel can't be packed until everyone you asked has answered/);
  await p.click(btn(p, /^Withdraw the invitation/));
  assert.match(p.text(modal(p)), new RegExp(`Take this back\\?.*@${b.handle} won't be asked to share this parcel any more`, 's'));
  await press(p, 'Not yet'); assert.ok(p.q('[data-share="invited"]'));
  await p.click(btn(p, /^Withdraw the invitation/)); await press(p, 'Yes, take it back');
  assert.equal(p.q('[data-share]'), null);
  assert.match(toast(p), /Done\./);
  assert.deepEqual(p.errors, []);
  p.close();
});

test('naming a friend who cannot be asked shows why, and no parcel is created', async () => {
  const a = await person(u('rcpt')); const before = (await app.q('SELECT COUNT(*) AS n FROM parcels'))[0].n;
  const p = await myPage(a); await go(p, '#/ship');
  const form = () => p.q('form[data-form="ship"]');
  p.q('input[name="claim"]').checked = true; await p.choose(form().elements.method, 'UK Royal Mail Tracked 48');
  form().elements.addressConfirmed.checked = true; form().elements.shareWith.value = '@nobody_at_all_xyz';
  await p.submit(form());
  assert.match(text(p, '[data-msg]'), /@nobody_at_all_xyz isn't on the site yet.*sign in here first — or ask the GOM to combine your parcels/s);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM parcels'))[0].n, before);
  p.close();
});

// ───────────── the friend ─────────────
test('the friend sees the invitation on their home page and the shipping page, explained plainly, and says yes with their own items, bias and Lomo name', async () => {
  const [a, b] = [await person(u('rcpt')), await person(u('frnd'), 2)];
  const r = await request(a, { shareWith: b.handle });
  const p = await myPage(b);
  assert.match(text(p, '[data-invite-notice]'), new RegExp(`@${a.handle} has asked to ship a parcel together with yours.*Nothing happens unless you say yes.*Have a look`, 's'));
  assert.match(text(p), /Request shipping.*2 items ready · 1 invitation/s);
  await go(p, '#/ship');
  const card = () => p.q(`form[data-form="accept"][data-parcel="${r.json.id}"]`);
  assert.match(p.text(card()), new RegExp(`@${a.handle} has asked to ship together with you.*their own address.*shared out equally per person \\(not by how many items each has\\).*more than two of you.*will confirm when it arrives.*your choice — you can say no`, 's'));
  assert.equal(p.qa('input[name="claim"]', card()).length, 2);
  await p.submit(card());
  assert.match(text(p, `form[data-parcel="${r.json.id}"] [data-msg]`), /Choose at least one of your items/);
  p.qa('input[name="claim"]', card())[0].checked = true; card().elements.bias.value = 'Felix'; card().elements.lomoName.value = 'Bee';
  await p.submit(card());
  assert.match(text(p, '[data-joined]'), /You're in — your items are in the parcel now\. Postage and packaging will be split equally/);
  assert.equal(p.q('form[data-form="accept"]'), null, 'the invitation is gone');
  const shared = text(p, `[data-parcel="${r.json.id}"]`);
  assert.match(shared, new RegExp(`Your items: .*@${a.handle}'s items: `, 's'));
  assert.match(text(p, '[data-share="friend"]'), new RegExp(`Posted together with @${a.handle}'s items to @${a.handle}'s address.*@${a.handle} will confirm when it arrives.*split equally.*Take my items out`, 's'));
  assert.equal(p.q('[data-act="received"]'), null);
  const q = (await api('GET', '/api/admin/packing')).json.parcels.find((x) => x.id === r.json.id);
  assert.deepEqual([q.companions[0].bias, q.companions[0].lomoName, q.companions[0].status], ['Felix', 'Bee', 'accepted']);
  assert.deepEqual(p.errors, []);
  p.close();
});

test('saying no, with a confirmation; and with nothing ready to ship you can only say no', async () => {
  const [a, b, c] = [await person(u('rcpt')), await person(u('frnd')), await person(u('empty'), 0)];
  const r1 = await request(a, { shareWith: b.handle });
  const p = await myPage(b); await go(p, '#/ship');
  await p.click(btn(p, /^No thanks/));
  assert.match(p.text(modal(p)), new RegExp(`Say no to sharing with @${a.handle}\\?.*Their parcel will be posted on its own`, 's'));
  await press(p, 'Not yet'); assert.ok(p.q('form[data-form="accept"]'));
  await p.click(btn(p, /^No thanks/)); await press(p, 'No thanks');
  assert.equal(p.q('form[data-form="accept"]'), null); assert.match(toast(p), /You said no/);
  assert.equal((await api('GET', '/api/admin/packing')).json.parcels.find((x) => x.id === r1.json.id).companions[0].status, 'declined');
  p.close();
  const a2 = await person(u('rcpt')); await request(a2, { shareWith: c.handle });
  const q = await myPage(c); await go(q, '#/ship');
  assert.match(text(q, '[data-nothing-ready]'), /You don't have anything ready to ship yet, so you can't join this one/);
  assert.equal(btn(q, /^Yes — add my items/), undefined); assert.ok(btn(q, /^No thanks/));
  q.close();
});

test('an invitation for one of your OTHER handles says so, rather than offering items from the wrong one', async () => {
  const [a, b] = [await person(u('rcpt')), await person(u('frnd'))];
  const second = u('second'); assert.ok([200, 201].includes((await api('POST', '/api/me/handles', { handle: second }, b.cookie)).status));
  await request(a, { shareWith: second });
  const p = await myPage(b); await go(p, '#/ship');
  assert.match(text(p, '[data-other-handle]'), new RegExp(`has asked @${second} to ship together.*Switch to @${second}`, 's'));
  assert.equal(p.q('form[data-form="accept"]'), null);
  p.close();
});

test('leaving a shared parcel: asks first, then the friend\'s items come out and the parcel carries on alone', async () => {
  const { a, b, id } = await shared(1, 1);
  const p = await myPage(b); await go(p, '#/ship');
  await p.click(btn(p, /^Take my items out/));
  assert.match(p.text(modal(p)), /Take your items out of this parcel\?.*back to "ready to ship"/s);
  await press(p, 'Take them out');
  assert.match(toast(p), /Your items are out of the parcel/);
  assert.equal(p.q(`[data-parcel="${id}"]`), null);
  assert.deepEqual((await api('GET', '/api/admin/packing')).json.parcels.find((x) => x.id === id).companions, []);
  assert.ok(a);
  p.close();
});

test('once fees are set each person sees THEIR share (and that it is split equally); only the recipient gets "It\'s arrived" — and it confirms for both', async () => {
  const { a, b, id } = await shared(2, 1);
  await api('POST', `/api/admin/parcels/${id}/fees`, { doms: 10, packaging: 2 });
  const pb = await myPage(b); await go(pb, '#/ship');
  assert.match(text(pb, '[data-fees]'), /Your share — Postage £5\.00 · Packaging £1\.00.*split equally per person/);
  await tickParcel(app, admin, id); await api('POST', `/api/admin/parcels/${id}/packed`); await api('POST', `/api/admin/parcels/${id}/shipped`);
  const pb2 = await myPage(b); await go(pb2, '#/ongoing');
  assert.match(text(pb2, '[data-shared-note]'), new RegExp(`Posted to @${a.handle}'s address together with theirs\\. @${a.handle} will confirm when it arrives`));
  assert.equal(pb2.q('[data-act="received"]'), null, 'the friend has no button');
  pb.close(); pb2.close();
  const pa = await myPage(a); await go(pa, '#/ongoing');
  assert.match(text(pa, '[data-shared-note]'), new RegExp(`Shared with @${b.handle} — pressing the button confirms it for everyone`));
  await pa.click(pa.q('[data-act="received"]'));
  assert.match(toast(pa), /Marked as received/);
  assert.deepEqual((await app.q('SELECT pipeline FROM claims WHERE id IN (?)', [[...a.ids, ...b.ids]])).map((r) => r.pipeline), ['completed', 'completed', 'completed']);
  pa.close();
});

test('item names with HTML in them are shown as text on both sides', async () => {
  const [a, b] = [await person(u('rcpt')), await person(u('frnd'), 1, [ITEM.x])];
  const r = await request(a, { shareWith: b.handle });
  const p = await myPage(b); await go(p, '#/ship');
  assert.equal(p.q('#view img'), null); assert.equal(p.window.pwned, undefined);
  assert.match(text(p), /Mug <img src=x onerror="window\.pwned=1">/);
  p.close(); assert.ok(r);
});

// ───────────── the GOM ─────────────
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Packing')); return p; };
async function twoParcels(nA = 1, nB = 1, extra = {}) {
  const [a, b] = [await person(u('rcpt'), nA), await person(u('frnd'), nB)];
  const ra = await request(a, extra.a || {}), rb = await request(b, extra.b || {});
  return { a, b, ra: ra.json.id, rb: rb.json.id };
}

test('GOM: combining two parcels — the panel lists who can join, needs you to pick and confirm, explains what happens, and the queue then shows ONE shared parcel', async () => {
  const { a, b, ra, rb } = await twoParcels(1, 2, { b: { bias: 'Felix' } });
  const p = await open();
  await p.click(btn(p, /^Combine with another parcel/, queueCard(p, ra)));
  const panel = () => p.q('[data-combine-panel]');
  assert.match(p.text(panel()), new RegExp(`go to @${a.handle}'s address.*same postage method.*@${b.handle} — 2 items`, 's'));
  assert.equal(btn(p, /^Combine them/, panel()).disabled, true);
  await p.click(p.q(`input[data-pick][value="${rb}"]`));
  assert.match(p.text(panel()), new RegExp(`checked with @${a.handle} and @${b.handle} that they're happy to share one parcel to @${a.handle}'s address`));
  assert.equal(btn(p, /^Combine them/, panel()).disabled, true, 'still needs the tick');
  await p.click(p.q('input[data-combine-ok]'));
  assert.equal(btn(p, /^Combine them/, panel()).disabled, false);
  await p.click(btn(p, /^Combine them/, panel()));
  assert.match(p.text(modal(p)), new RegExp(`Combine @${b.handle}'s parcel into @${a.handle}'s\\?.*ONE parcel to @${a.handle}'s address.*shared out between them.*their own bias name.*earlier place in the queue.*split them apart again until you save any fees`, 's'));
  await press(p, 'Not yet');
  assert.ok(queueCard(p, rb), 'not yet means nothing happened');
  await p.click(btn(p, /^Combine them/, panel())); await press(p, 'Combine them');
  assert.match(toast(p), new RegExp(`Combined — parcel ${ra} now holds 2 people`));
  assert.equal(queueCard(p, rb), null, 'the other parcel is gone from the queue');
  const card = text(p, `[data-parcel="${ra}"]`);
  assert.match(card, new RegExp(`shared with @${b.handle}`)); assert.match(card, new RegExp(`One parcel to @${a.handle}'s address, with @${b.handle}'s items \\(combined by you\\)\\. Postage and packaging are split equally per person`));
  assert.match(card, new RegExp(`@${b.handle}'s details: bias Felix`));
  assert.equal(p.qa('[data-checklist] input[data-tick="item"]', queueCard(p, ra)).length, 3);
  assert.match(text(p, `[data-parcel="${ra}"] [data-checklist]`), new RegExp(`@${b.handle}`));
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('GOM: when nothing can be combined it says so; and a parcel with fees set no longer offers it', async () => {
  const a = await person(u('solo')); const ra = (await request(a, { method: 'UK Inpost to Shop' })).json.id;      // a method nobody else asked for
  const p = await open();
  await p.click(btn(p, /^Combine with another parcel/, queueCard(p, ra)));
  assert.match(text(p, '[data-combine-panel]'), /No other parcel in the queue can be combined with this one/);
  assert.equal(btn(p, /^Combine them/, p.q('[data-combine-panel]'))?.disabled, true);
  await p.click(btn(p, /^Cancel/, p.q('[data-combine-panel]')));
  assert.equal(p.q('[data-combine-panel]'), null);
  await api('POST', `/api/admin/parcels/${ra}/fees`, { doms: 3 });
  const q = await open();
  assert.equal(btn(q, /^Combine with another parcel/, queueCard(q, ra)), undefined);
  assert.match(text(q, `[data-parcel="${ra}"] form[data-form="fees"]`), /fees are set, so this parcel can no longer be combined/);
  p.close(); q.close();
});

test('GOM: an invited friend holds the parcel up (with the reason), the invitation can be removed, and a decline is shown', async () => {
  const [a, b, c] = [await person(u('rcpt')), await person(u('frnd')), await person(u('frnd2'))];
  const r = await request(a, { shareWith: b.handle });
  let p = await open();
  let card = () => queueCard(p, r.json.id);
  assert.match(text(p, `[data-parcel="${r.json.id}"] [data-share-line]`), new RegExp(`Waiting for @${b.handle} to say yes to sharing this parcel`));
  assert.match(text(p, `[data-parcel="${r.json.id}"] [data-invited-pill]`), new RegExp(`invited @${b.handle}`));
  assert.equal(btn(p, /^Mark packed/, card()).disabled, true);
  assert.match(text(p, `[data-parcel="${r.json.id}"] [data-pack-hint]`), new RegExp(`Waiting for @${b.handle} to answer the invitation`));
  await p.click(p.q(`[data-parcel="${r.json.id}"] [data-act="tick-all"]`));
  assert.equal(btn(p, /^Mark packed/, card()).disabled, true, 'even with everything ticked, an unanswered invitation holds it');
  await p.click(btn(p, /^Remove the invitation/, card()));
  assert.match(p.text(modal(p)), new RegExp(`Remove the invitation to @${b.handle}\\?.*no longer wait for their answer`, 's'));
  await press(p, 'Yes');
  assert.equal(p.q(`[data-parcel="${r.json.id}"] [data-share-line]`), null);
  assert.equal(btn(p, /^Mark packed/, card()).disabled, false);
  p.close();
  const r2 = await request(await person(u('r2')), { shareWith: c.handle });
  await api('POST', `/api/my/parcels/${r2.json.id}/companion/decline`, {}, c.cookie);
  p = await open();
  assert.match(text(p, `[data-parcel="${r2.json.id}"] [data-share-line]`), new RegExp(`@${c.handle} said no to sharing, so this goes on its own`));
  assert.ok(btn(p, /^Clear this/, queueCard(p, r2.json.id)));
  p.close();
});

test('GOM: the checklist for a shared parcel includes the friend\'s own Lomo name and bias; "Mark packed" confirms what EACH person will owe; "Tick all" covers everything', async () => {
  const [a, b] = [await person(u('rcpt')), await person(u('frnd'))];
  const r = await request(a, { shareWith: b.handle, bias: 'Han' });
  await api('POST', `/api/my/parcels/${r.json.id}/companion/accept`, { claimIds: b.ids, bias: 'Felix', lomoName: 'Bee' }, b.cookie);
  const p = await open();
  const card = () => queueCard(p, r.json.id);
  const list = text(p, `[data-parcel="${r.json.id}"] [data-checklist]`);
  assert.match(list, new RegExp(`Lomo name for @${b.handle} checked — Bee.*Bias name for @${b.handle} checked — Felix`, 's'));
  assert.match(list, /0 of 6 ticked/, '2 items + the recipient\'s Lomo and bias + the friend\'s Lomo and bias');
  await p.click(p.q('input[data-friend][data-tick="lomo"]', card()));
  assert.match(text(p, `[data-parcel="${r.json.id}"] [data-count]`), /1 of 6 ticked/);
  assert.equal((await api('GET', '/api/admin/packing')).json.parcels.find((x) => x.id === r.json.id).companions[0].lomoChecked, true, 'the tick was saved');
  await p.click(btn(p, /^Tick all/, card()));
  assert.match(text(p, `[data-parcel="${r.json.id}"] [data-count]`), /6 of 6 ticked/);
  assert.equal(btn(p, /^Mark packed/, card()).disabled, false);
  const form = p.q(`form[data-form="fees"][data-id="${r.json.id}"]`); form.elements.doms.value = '9'; form.elements.packaging.value = '3';
  await p.click(btn(p, /^Mark packed/, card()));
  assert.match(p.text(modal(p)), new RegExp(`shared with @${b.handle}.*Postage \\(Doms\\): £9\\.00.*Packaging fee: £3\\.00.*@${a.handle} and @${b.handle} will each owe about £6\\.00 for these \\(split equally per person\\)`, 's'));
  await press(p, 'Mark packed');
  assert.match(toast(p), /Marked packed/);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('GOM: splitting a combined parcel apart, until fees are saved', async () => {
  const { a, b, ra, rb } = await twoParcels(1, 1, { b: { bias: 'Felix' } });
  await api('POST', `/api/admin/parcels/${ra}/combine`, { withParcelId: rb, confirmed: true });
  let p = await open();
  await p.click(btn(p, /^Split them apart/, queueCard(p, ra)));
  assert.match(p.text(modal(p)), new RegExp(`Split parcel ${ra} apart\\?.*@${b.handle}'s items go back into a parcel of their own`, 's'));
  await press(p, 'Not yet'); assert.equal(queueCard(p, rb), null);
  await p.click(btn(p, /^Split them apart/, queueCard(p, ra))); await press(p, 'Split them');
  assert.match(toast(p), /Split apart — they each have their own parcel again/);
  assert.equal(p.qa('[data-share-line]').filter((e) => new RegExp(a.handle).test(p.text(e.closest('[data-parcel]')))).length, 0);
  const fresh = (await api('GET', '/api/admin/packing')).json.parcels.find((x) => x.handle === b.handle);
  assert.ok(queueCard(p, fresh.id));
  p.close();
  const c = await twoParcels(1, 1);
  await api('POST', `/api/admin/parcels/${c.ra}/combine`, { withParcelId: c.rb, confirmed: true });
  await api('POST', `/api/admin/parcels/${c.ra}/fees`, { doms: 4 });
  p = await open();
  assert.equal(btn(p, /^Split them apart/, queueCard(p, c.ra)), undefined, 'not once fees are saved');
  p.close();
});

test('GOM: shipped and received tabs show whose item is whose, and "Mark received" completes both people\'s items', async () => {
  const { a, b, id } = await shared(1, 1);
  await tickParcel(app, admin, id); await api('POST', `/api/admin/parcels/${id}/packed`);
  let p = await open(); await p.click(btn(p, /^Packed \(/));
  assert.match(text(p, `[data-parcel="${id}"]`), new RegExp(`shared with @${b.handle}.*@${a.handle}.*@${b.handle}`, 's'));
  await p.click(btn(p, /^Mark shipped/, queueCard(p, id))); await sleep(30); await p.settle();
  await p.click(btn(p, /^Shipped \(/));
  await p.click(btn(p, /^Mark received/, queueCard(p, id))); await press(p, 'Yes, mark received');
  assert.deepEqual((await app.q('SELECT pipeline FROM claims WHERE id IN (?)', [[...a.ids, ...b.ids]])).map((r) => r.pipeline), ['completed', 'completed']);
  p.close();
});
