import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage, gomPage, modal, press, toast } from './ui.helpers.js';

const READY = 'ready to pack / on hand';
let app, admin, w, N = 0, ITEM;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  const go = (await app.api('POST', '/api/admin/orders', { groupId: w.group, title: 'UI cancel GO' }, admin)).json.id;
  const mk = async (title, price) => (await app.api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price }, admin)).json.id;
  ITEM = { twenty: await mk('Twenty thing', 20), odd: await mk('Odd <img src=x onerror="window.pwned=1"> thing', 5) };
});
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'uc') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p, sel = '#view') => p.text(p.q(sel));
const go = async (p, hash) => { if (p.window.location.hash === hash) p.window.dispatchEvent(new p.window.HashChangeEvent('hashchange')); else p.window.location.hash = hash; await sleep(30); await p.settle(); };
const btn = (p, re, root) => p.qa('button', root).find((b) => re.test(p.text(b)));
async function person({ stage = 'ordered via proxy / warehouse', pay = 0, item = ITEM.twenty, handle = u() } = {}) {
  const cookie = await joinerSession(app, `${handle}@x.com`, handle);
  const [id] = await claimAndSecure(app, admin, handle, item);
  if (stage) await api('PATCH', `/api/admin/claims/${id}`, { pipeline: stage });
  if (pay) { const p = await api('POST', '/api/my/payments', { method: 'PayPal', amount: pay, reference: `R${handle}` }, cookie); await api('POST', `/api/admin/payments/${p.json.id}/verify`, {}); }
  return { handle, cookie, id };
}
const myPage = (p) => openPage(app, '/my.html', { cookies: [p.cookie] });
const ask = (p, body = {}) => api('POST', `/api/my/claims/${p.id}/cancel-request`, body, p.cookie);
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); return p; };
const reqCard = (p, id) => p.q(`[data-cancel-req="${id}"]`);
const credit = async (p) => (await api('GET', '/api/my/summary', undefined, p.cookie)).json.credit;

// ───────────── the joiner ─────────────
test('an ongoing item offers "Ask to cancel"; the form explains it needs approval and what happens to money; sending it shows a waiting state that can be withdrawn', async () => {
  const p = await person({ pay: 12 });
  const page = await myPage(p); await go(page, '#/ongoing');
  assert.ok(btn(page, /^Ask to cancel/));
  await page.click(btn(page, /^Ask to cancel/));
  const form = () => page.q('form[data-form="cancel"]');
  assert.match(page.text(form()), /Ask to cancel “Twenty thing”.*The GOM has to approve this — nothing changes until they answer.*the £12\.00 you've paid towards it comes back to your account as credit, but they may keep a cancellation fee/s);
  await page.click(btn(page, /^Never mind/, form()));
  assert.equal(form(), null); assert.ok(btn(page, /^Ask to cancel/));
  await page.click(btn(page, /^Ask to cancel/));
  form().elements.reason.value = 'Changed my mind';
  await page.submit(form());
  assert.match(toast(page), /Request sent — the GOM will let you know/);
  assert.match(text(page, '[data-cancel-state="pending"]'), /You've asked to cancel this — waiting for the GOM to answer.*Withdraw request/s);
  assert.equal(btn(page, /^Ask to cancel/), undefined, 'no second request while one is waiting');
  assert.equal((await api('GET', '/api/admin/cancel-requests')).json.requests.find((r) => r.handle === p.handle).reason, 'Changed my mind');
  await page.click(btn(page, /^Withdraw request/));
  assert.match(page.text(modal(page)), /Take back your request to cancel this\?.*stays in your order as it was/s);
  await press(page, 'Not yet'); assert.ok(page.q('[data-cancel-state="pending"]'));
  await page.click(btn(page, /^Withdraw request/)); await press(page, 'Yes, take it back');
  assert.match(toast(page), /Request withdrawn/);
  assert.equal(page.q('[data-cancel-state]'), null); assert.ok(btn(page, /^Ask to cancel/));
  assert.deepEqual(page.errors, []);
  page.close();
});

test('the button is not offered where it cannot work: received items and items in a parcel (every other stage can ask)', async () => {
  const [done, parcel] = [await person({ stage: 'completed' }), await person({ stage: READY })];
  await api('PUT', '/api/my/address', { fullName: 'Pat Kay', address: '1 Test Road, Leeds', email: 'p@x.com', phone: '0700' }, parcel.cookie);
  await api('POST', '/api/my/parcels', { claimIds: [parcel.id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, parcel.cookie);
  let page = await myPage(done); await go(page, '#/completed');
  assert.equal(btn(page, /Ask to cancel/), undefined, 'nothing to cancel once received'); page.close();
  page = await myPage(parcel); await go(page, '#/ongoing');
  assert.equal(btn(page, /Ask to cancel/), undefined, 'in a parcel'); page.close();
});

test('EVERY STAGE: an item that is still only a request can be asked about too — the form says the GOM must approve it to keep sets tidy', async () => {
  const h = u(); const c = await joinerSession(app, `${h}@x.com`, h);
  await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: ITEM.twenty }] });
  const page = await myPage({ cookie: c }); await go(page, '#/ongoing');
  assert.match(text(page), /waiting for the GOM to confirm/);
  await page.click(btn(page, /^Ask to cancel/));
  assert.match(page.text(page.q('form[data-form="cancel"]')), /This hasn't been confirmed yet, but any cancellation still has to be approved by the GOM — it keeps member sets tidy\. Nothing changes until they answer\./);
  assert.doesNotMatch(page.text(page.q('form[data-form="cancel"]')), /cancellation fee/, 'no talk of fees for something nobody has paid for');
  await page.submit(page.q('form[data-form="cancel"]'));
  assert.match(toast(page), /Request sent/);
  assert.match(text(page, '[data-cancel-state="pending"]'), /waiting for the GOM to answer/);
  const row = (await api('GET', '/api/admin/cancel-requests')).json.requests.find((r) => r.handle === h);
  assert.equal(row.claimStatus, 'requested');
  const gom = await open();
  assert.match(gom.text(reqCard(gom, row.id)), /At: not confirmed yet · paid £0\.00/);
  gom.close(); page.close();
});

test('a declined request shows the GOM\'s message and lets you ask again; a problem on the server is explained', async () => {
  const p = await person(); const r = await ask(p);
  await api('POST', `/api/admin/cancel-requests/${r.json.id}/decline`, { note: 'It has already shipped from Korea.' });
  const page = await myPage(p); await go(page, '#/ongoing');
  assert.match(text(page, '[data-cancel-state="declined"]'), /Your request to cancel this was declined: “It has already shipped from Korea\.”/);
  await page.click(btn(page, /^Ask again/));
  // the item is received while the form is open
  await api('PATCH', `/api/admin/claims/${p.id}`, { pipeline: 'completed' });
  await page.submit(page.q('form[data-form="cancel"]'));
  assert.match(text(page, 'form[data-form="cancel"] [data-msg]'), /That item has already been received, so it can't be cancelled/);
  assert.equal((await api('GET', '/api/admin/cancel-requests')).json.requests.some((x) => x.handle === p.handle), false);
  page.close();
});

// ───────────── the GOM ─────────────
test('GOM: requests appear at the top of Claims with the details that matter; the tab shows a count; the fee box shows what they would get back as you type', async () => {
  const p = await person({ pay: 15 }); const r = await ask(p, { reason: 'No longer want it' });
  const page = await open();
  const card = () => reqCard(page, r.json.id);
  assert.match(text(page, '#cancelRequests h2'), /Cancellation requests \d+/);
  assert.match(page.text(card()), new RegExp(`@${p.handle} asks to cancel “Twenty thing”.*UI cancel GO.*ordered via proxy / warehouse.*paid £15\\.00 of £20\\.00.*“No longer want it”.*They'd get £15\\.00 back as credit`, 's'));
  await sleep(60); await page.settle();
  const badge = page.q('#tabs [data-tab="claims"] .badge');
  assert.ok(badge && Number(page.text(badge)) >= 1, 'the Claims tab shows how many requests are waiting');
  const keep = () => page.q('[data-keep]', card());
  keep().value = '4'; keep().dispatchEvent(new page.window.Event('input', { bubbles: true }));
  assert.match(text(page, `[data-cancel-req="${r.json.id}"] [data-keep-preview]`), /They'd get £11\.00 back as credit; you keep £4\.00\./);
  keep().value = '20'; keep().dispatchEvent(new page.window.Event('input', { bubbles: true }));
  assert.match(text(page, `[data-cancel-req="${r.json.id}"] [data-keep-preview]`), /They have only paid £15\.00/);
  assert.deepEqual([page.errors, page.native], [[], 0]);
  page.close();
});

test('GOM: approving with a fee asks first, then cancels, returns the rest as credit, and moves the request to "recently decided"', async () => {
  const p = await person({ pay: 15 }); const r = await ask(p);
  const page = await open();
  const card = () => reqCard(page, r.json.id);
  page.q('[data-keep]', card()).value = '5'; page.q('[data-note]', card()).value = 'Proxy order was already placed.';
  await page.click(btn(page, /^Approve cancellation/, card()));
  assert.match(page.text(modal(page)), new RegExp(`Cancel “Twenty thing” for @${p.handle}\\?.*£10\\.00 goes back to them as credit; you keep £5\\.00 as a cancellation fee.*They will see your message`, 's'));
  await press(page, 'Not yet');
  assert.equal((await api('GET', `/api/admin/claims?handle=${p.handle}`)).json.claims[0].status, 'confirmed', '"not yet" changed nothing');
  await page.click(btn(page, /^Approve cancellation/, card())); await press(page, 'Approve cancellation');
  assert.match(toast(page), /Cancelled — £10\.00 returned as credit, £5\.00 kept\./);
  assert.equal(reqCard(page, r.json.id), null, 'it is no longer waiting');
  assert.equal(await credit(p), 10);
  assert.match(text(page, '#cancelRequests details'), new RegExp(`@${p.handle} — “Twenty thing” — approved \\(£10\\.00 back as credit, £5\\.00 kept\\) · “Proxy order was already placed\\.”`));
  page.close();
});

test('GOM: a fee bigger than what they paid is refused on the spot, and nothing is sent', async () => {
  const p = await person({ pay: 6 }); const r = await ask(p);
  const page = await open();
  page.q('[data-keep]', reqCard(page, r.json.id)).value = '7';
  await page.click(btn(page, /^Approve cancellation/, reqCard(page, r.json.id)));
  assert.match(toast(page), /They have only paid £6\.00, so you can't keep £7\.00/);
  assert.equal(page.q('.ui-modal'), null, 'no confirmation was even offered');
  assert.equal((await api('GET', `/api/admin/claims?handle=${p.handle}`)).json.claims[0].status, 'confirmed');
  page.close();
});

test('GOM: an unpaid item has no fee to keep; declining asks first, keeps the item, and the joiner sees your message', async () => {
  const p = await person(); const r = await ask(p);
  const page = await open();
  const card = () => reqCard(page, r.json.id);
  assert.equal(page.q('[data-keep]', card()).disabled, true);
  assert.match(text(page, `[data-cancel-req="${r.json.id}"] [data-keep-preview]`), /They haven't paid anything towards it, so there's nothing to return/);
  page.q('[data-note]', card()).value = 'Sorry, it has already shipped.';
  await page.click(btn(page, /^Decline/, card()));
  assert.match(page.text(modal(page)), new RegExp(`Decline @${p.handle}'s request to cancel “Twenty thing”\\?.*stays exactly as it is.*They will see your message`, 's'));
  await press(page, 'Decline it');
  assert.match(toast(page), /Declined\./);
  assert.equal((await api('GET', `/api/admin/claims?handle=${p.handle}`)).json.claims[0].status, 'confirmed');
  const mine = (await api('GET', '/api/my/summary', undefined, p.cookie)).json.orders[0].claims[0];
  assert.deepEqual([mine.cancelRequest.status, mine.cancelRequest.note], ['declined', 'Sorry, it has already shipped.']);
  assert.match(text(page, '#cancelRequests details'), /declined.*Sorry, it has already shipped\./);
  page.close();
});

test('GOM: warnings are shown for set parts and blocked handles; with nothing waiting the card says so', async () => {
  const goId = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Set GO ') })).json.id;
  const set = (await api('POST', `/api/admin/orders/${goId}/items`, { type: 'set', title: u('Set '), price: 4, members: ['A', 'B'] })).json.id;
  const h = u(); const c = await joinerSession(app, `${h}@x.com`, h); const h2 = u();
  await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] });
  await app.api('POST', '/api/claims', { handle: h2, lines: [{ itemId: set, parts: [{ member: 'B', qty: 1 }] }] });
  await api('POST', `/api/admin/sets/${(await api('GET', '/api/admin/sets')).json.sets.find((s) => s.itemId === set).id}/secure`, {});
  const claim = (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims[0];
  const r = await api('POST', `/api/my/claims/${claim.id}/cancel-request`, {}, c);
  const blocked = await person(); const rb = await ask(blocked); await api('POST', '/api/admin/joiners/block', { handle: blocked.handle, reason: 't' });
  const page = await open();
  assert.match(text(page, `[data-cancel-req="${r.json.id}"] [data-cancel-warn]`), /Part of a member set — approving frees the part/);
  assert.match(page.text(reqCard(page, rb.json.id)), /This handle is blocked, so anything they paid is forfeited rather than credited/);
  page.close();
  for (const x of await api('GET', '/api/admin/cancel-requests').then((q) => q.json.requests)) await api('POST', `/api/admin/cancel-requests/${x.id}/decline`, {});
  const q = await open();
  assert.match(text(q, '#cancelRequests'), /No requests waiting\./);
  assert.equal(q.q('[data-cancel-count]'), null);
  q.close();
});

test('names, items and reasons with HTML in them are shown as text', async () => {
  const p = await person({ item: ITEM.odd }); const r = await ask(p, { reason: '<b>bold</b> <img src=x onerror="window.pwned=2">' });
  const page = await open();
  assert.equal(page.q('#cancelRequests img'), null); assert.equal(page.q('#cancelRequests b'), null); assert.equal(page.window.pwned, undefined);
  assert.match(text(page, `[data-cancel-req="${r.json.id}"]`), /Odd <img src=x onerror="window\.pwned=1"> thing/);
  assert.match(text(page, `[data-cancel-req="${r.json.id}"] [data-cancel-reason]`), /<b>bold<\/b> <img src=x onerror="window\.pwned=2">/);
  page.close();
  const jp = await myPage(p); await go(jp, '#/ongoing');
  assert.equal(jp.q('#view img'), null); assert.equal(jp.window.pwned, undefined);
  jp.close();
});

test('GOM: a part with a request waiting is marked on the Sets tab and the set cannot be secured until you answer', async () => {
  const goId = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Sets GO ') })).json.id;
  const set = (await api('POST', `/api/admin/orders/${goId}/items`, { type: 'set', title: u('Tidy set '), price: 4, members: ['A', 'B'] })).json.id;
  const [h1, h2] = [u(), u()]; const c1 = await joinerSession(app, `${h1}@x.com`, h1);
  await app.api('POST', '/api/claims', { handle: h1, lines: [{ itemId: set, parts: [{ member: 'A', qty: 1 }] }] });
  await app.api('POST', '/api/claims', { handle: h2, lines: [{ itemId: set, parts: [{ member: 'B', qty: 1 }] }] });
  const sid = (await api('GET', '/api/admin/sets')).json.sets.find((x) => x.itemId === set).id;
  const mine = (await api('GET', `/api/admin/claims?handle=${h1}`)).json.claims[0];
  const r = await api('POST', `/api/my/claims/${mine.id}/cancel-request`, {}, c1);
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Sets'));
  const card = () => p.q(`[data-set="${sid}"]`);
  assert.match(p.text(p.q('tr[data-part="A"]', card())), /cancel requested/);
  assert.equal(p.q('tr[data-part="B"] [data-cancel-asked]', card()), null, 'only the part concerned');
  assert.equal(p.q('[data-act="secure"]', card()).disabled, true);
  assert.match(p.text(card()), /A joiner has asked to cancel one of these parts — answer that first \(top of the Claims tab\) before this set can be secured/);
  await api('POST', `/api/admin/cancel-requests/${r.json.id}/decline`, {});
  await p.click(p.byText('#tabs button', 'Sets'));
  assert.equal(p.q('[data-act="secure"]', card()).disabled, false);
  assert.equal(p.q('[data-cancel-asked]', card()), null);
  p.close();
});

test('GOM: "Secure all requested" says how many it left because the person asked to cancel', async () => {
  const goId = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Bulk GO ') })).json.id;
  const it = (await api('POST', `/api/admin/orders/${goId}/items`, { type: 'normal', title: u('Bulk item '), price: 6 })).json.id;
  const [a, b] = [u(), u()]; const ca = await joinerSession(app, `${a}@x.com`, a);
  await app.api('POST', '/api/claims', { handle: a, lines: [{ itemId: it }] }); await app.api('POST', '/api/claims', { handle: b, lines: [{ itemId: it }] });
  const claim = (await api('GET', `/api/admin/claims?handle=${a}`)).json.claims[0];
  await api('POST', `/api/my/claims/${claim.id}/cancel-request`, {}, ca);
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims'));
  await p.type(p.q('[data-filter="q"]'), (await api('GET', '/api/admin/orders')).json.orders.find((o) => o.id === goId).items[0].title); await p.settle();
  await p.click(btn(p, /^Secure all requested/));
  await press(p, 'Secure them');
  assert.match(toast(p), /Secured 1 claim\. 1 left because the person has asked to cancel\./);
  p.close();
});
