import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { openPage, modal, press, toast } from './ui.helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'us') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p, sel = '#view') => p.text(p.q(sel));
const go = async (p, hash) => { if (p.window.location.hash === hash) p.window.dispatchEvent(new p.window.HashChangeEvent('hashchange')); else p.window.location.hash = hash; await sleep(40); await p.settle(); };
async function person({ handle = u(), address = true } = {}) { const cookie = await joinerSession(app, `${handle}@x.com`, handle); if (address) await api('PUT', '/api/my/address', { fullName: `Name ${handle}`, address: '1 Test Road, Leeds', email: `${handle}@x.com`, phone: '0700123456' }, cookie); return { handle, email: `${handle}@x.com`, cookie }; }
const page = async (p, hash = '#/') => { const pg = await openPage(app, '/my.html', { cookies: [p.cookie] }); if (hash !== '#/') await go(pg, hash); return pg; };
const type = (pg, sel, value) => { pg.q(sel).value = value; };

test('MY SETTINGS: a card on the home page opens it; the handles box and the delete link have moved there; the old "Your account" address goes to Settings', async () => {
  const p = await person(); const pg = await page(p);
  const card = pg.q('a.gocard[href="#/settings"]'); assert.ok(card); assert.match(pg.text(card), /My settings.*handles, email & preferences/);
  assert.equal(pg.q('#handleCard'), null, 'no handles box on the home page'); assert.doesNotMatch(text(pg), /Delete my account/, 'no delete link on the home page');
  assert.match(text(pg, '.row'), new RegExp(`@${p.handle}.*${p.email}`), 'but the handle you are viewing is still shown at the top');
  await pg.click(card); await sleep(40); await pg.settle();
  assert.equal(pg.window.location.hash, '#/settings');
  const t = text(pg);
  assert.match(t, /My settings.*Your Instagram handle.*Sign-in email.*Shipping defaults.*Emails from us.*Delete my account/s);
  for (const id of ['handleCard', 'emailCard', 'defaultsCard', 'emailsCard', 'deleteCard']) assert.ok(pg.q(`#${id}`), id);
  await go(pg, '#/account'); assert.equal(pg.window.location.hash, '#/settings', 'old links still work');
  assert.deepEqual(pg.errors, []); pg.close();
});

test('A NEWCOMER with no handle yet still sees the "link your handle" box on the home page (otherwise they would not know what to do), and Settings still works for them', async () => {
  const cookie = await app.login(`${u('new')}@x.com`); const pg = await page({ cookie });
  assert.match(text(pg, '#handleCard'), /Link your Instagram handle.*Your orders are tied to your Instagram handle/s);
  assert.ok(pg.q('a.gocard[href="#/settings"]'), 'the Settings card is there even with no handle');
  await go(pg, '#/settings');
  assert.match(text(pg, '#handleCard'), /No handle linked yet/); assert.ok(pg.q('#emailCard') && pg.q('#deleteCard')); assert.equal(pg.q('#defaultsCard'), null, 'shipping defaults need a handle');
  assert.equal(pg.q('[data-act="delete-account"]').disabled, false);
  pg.close();
});

test('ADDING AND REMOVING HANDLES: add in Settings; remove asks first; one with business in progress says why and stays', async () => {
  const p = await person(); const second = u('sec'); const pg = await page(p, '#/settings');
  type(pg, '#handle', `@${second.toUpperCase()}`); await pg.submit(pg.q('form[data-form="link-handle"]'));
  assert.match(text(pg, '#handleCard'), new RegExp(`@${p.handle}.*@${second}`, 's')); assert.match(text(pg, '#handleCard [data-msg]'), new RegExp(`@${second} is linked`));
  assert.equal(pg.qa('[data-act="remove-handle"]').length, 2);
  // one that is busy
  const [busy] = await claimAndSecure(app, admin, second, w.keyring); void busy;
  await pg.click(pg.q(`[data-act="remove-handle"][data-handle="${second}"]`));
  assert.match(pg.text(modal(pg)), new RegExp(`Remove @${second} from your account\\?.*stop showing in your orders here.*link it again`, 's'));
  await press(pg, 'Keep it'); assert.equal(pg.qa('[data-act="remove-handle"]').length, 2, 'saying no removed nothing');
  await pg.click(pg.q(`[data-act="remove-handle"][data-handle="${second}"]`)); await press(pg, 'Remove it');
  assert.match(text(pg, '#handleCard [data-msg]'), /can't be removed yet — it still has orders that are still in progress, money owed/);
  assert.equal(pg.qa('[data-act="remove-handle"]').length, 2, 'still there');
  // one that is clean
  const clean = u('clean'); type(pg, '#handle', clean); await pg.submit(pg.q('form[data-form="link-handle"]'));
  await pg.click(pg.q(`[data-act="remove-handle"][data-handle="${clean}"]`)); await press(pg, 'Remove it');
  assert.match(toast(pg), new RegExp(`@${clean} removed`)); assert.equal(pg.q(`[data-handle-row="${clean}"]`), null);
  assert.equal((await app.q('SELECT account_id FROM joiners WHERE instagram_handle = ?', [clean]))[0].account_id, null);
  assert.deepEqual(pg.errors, []); pg.close();
});

test('CHANGING THE SIGN-IN EMAIL: a link is sent to the new address; mistakes are explained; and the confirmation banner appears once, then the address is clean', async () => {
  const p = await person(); const taken = await person(); const pg = await page(p, '#/settings');
  assert.match(text(pg, '#emailCard'), new RegExp(`You sign in with ${p.email}`));
  type(pg, '#newEmail', taken.email); await pg.submit(pg.q('form[data-form="email"]'));
  assert.match(text(pg, '#emailCard [data-msg]'), /already used by another account/);
  type(pg, '#newEmail', p.email); await pg.submit(pg.q('form[data-form="email"]')); assert.match(text(pg, '#emailCard [data-msg]'), /already your sign-in email/);
  const fresh = `${u('fresh')}@elsewhere.com`; type(pg, '#newEmail', fresh); await pg.submit(pg.q('form[data-form="email"]'));
  assert.match(text(pg, '#emailCard [data-msg]'), new RegExp(`We've sent a confirmation link to ${fresh.replace('.', '\\.')}.*signed out on your other devices`));
  assert.equal(pg.q('#emailCard [data-msg]').className.includes('ok'), true);
  const token = /token=([A-Za-z0-9_-]+)/.exec(app.mailer.outbox.filter((m) => m.to === fresh).pop().text)[1];
  const r = await fetch(`${app.base}/auth/confirm`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}`, redirect: 'manual' });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const after = await openPage(app, '/my.html?updated=email#/settings', { cookies: [cookie] }); await sleep(60); await after.settle();
  assert.match(text(after, '[data-updated]'), new RegExp(`Your sign-in email is now ${fresh.replace('.', '\\.')}.*signed out on your other devices`));
  assert.equal(after.window.location.search, '', 'the ?updated=email is removed so a refresh does not repeat the banner');
  assert.match(text(after, '#emailCard'), new RegExp(`You sign in with ${fresh.replace('.', '\\.')}`));
  pg.close(); after.close();
});

test('SHIPPING DEFAULTS: saved in Settings, pre-filled on the shipping page and in a friend\'s invitation (never forced), and shown safely if they contain HTML', async () => {
  const p = await person(); const pg = await page(p, '#/settings');
  assert.equal(pg.q('#defBias').value, ''); assert.match(text(pg, '#defaultsCard'), /We'll fill these in when you ask for shipping\. You can still change them each time\./);
  type(pg, '#defBias', '  Hyunjin '); type(pg, '#defLomo', '"><img src=x onerror="window.pwned=1">'); await pg.submit(pg.q('form[data-form="defaults"]'));
  assert.match(text(pg, '#defaultsCard [data-msg]'), /Saved\./);
  assert.deepEqual((await api('GET', '/api/my/defaults', undefined, p.cookie)).json, { handle: p.handle, bias: 'Hyunjin', lomoName: '"><img src=x onerror="window.pwned=1">' });
  await go(pg, '#/'); await go(pg, '#/settings');
  assert.equal(pg.q('#defBias').value, 'Hyunjin', 'remembered'); assert.equal(pg.q('#defaultsCard img'), null); assert.equal(pg.window.pwned, undefined);
  // the shipping page is pre-filled
  const [claim] = await claimAndSecure(app, admin, p.handle, w.keyring); await api('PATCH', `/api/admin/claims/${claim}`, { pipeline: 'ready to pack / on hand' });
  await go(pg, '#/ship');
  assert.equal(pg.q('form[data-form="ship"] input[name="bias"]').value, 'Hyunjin'); assert.equal(pg.q('form[data-form="ship"] input[name="lomoName"]').value, '"><img src=x onerror="window.pwned=1">');
  assert.equal(pg.q('#view img'), null); assert.equal(pg.window.pwned, undefined);
  // a friend's invitation form is pre-filled too
  const owner = await person(); const [oc] = await claimAndSecure(app, admin, owner.handle, w.keyring); await api('PATCH', `/api/admin/claims/${oc}`, { pipeline: 'ready to pack / on hand' });
  const sh = await api('POST', '/api/my/parcels', { claimIds: [oc], method: 'UK Royal Mail Tracked 48', addressConfirmed: true, shareWith: `@${p.handle}` }, owner.cookie); assert.equal(sh.status, 201, JSON.stringify(sh.json));
  await go(pg, '#/'); await go(pg, '#/ship');
  assert.equal(pg.q('form[data-form="accept"] input[name="bias"]').value, 'Hyunjin');
  // clearing them removes the defaults
  await go(pg, '#/settings'); type(pg, '#defBias', ''); type(pg, '#defLomo', ''); await pg.submit(pg.q('form[data-form="defaults"]'));
  assert.deepEqual((await api('GET', '/api/my/defaults', undefined, p.cookie)).json, { handle: p.handle, bias: '', lomoName: '' });
  pg.close();
});

test('with two handles the defaults are per handle, and the heading says which', async () => {
  const p = await person(); const second = u('two'); await api('POST', '/api/me/handles', { handle: second }, p.cookie);
  const pg = await page(p, '#/settings');
  assert.match(text(pg, '#defaultsCard h2'), new RegExp(`Shipping defaults for @${p.handle}`));
  type(pg, '#defBias', 'First'); await pg.submit(pg.q('form[data-form="defaults"]'));
  assert.equal((await api('GET', `/api/my/defaults?handle=${second}`, undefined, p.cookie)).json.bias, '', 'the other handle is untouched');
  pg.close();
});

test('CHOOSING WHICH EMAILS: switching emails on enables the list; each kind saves on its own tick; switching off greys them out but remembers; the home card reflects it', async () => {
  const p = await person(); const pg = await page(p, '#/notifications');
  const boxes = () => pg.qa('input[data-event]');
  assert.equal(boxes().length, 6); assert.ok(boxes().every((b) => b.disabled && b.checked)); assert.match(text(pg, '[data-kinds-off]'), /Turn on order emails above to choose which ones/);
  await pg.click(pg.q('#notifyToggle'));
  assert.match(toast(pg), /Email notifications turned on/); assert.ok(boxes().every((b) => !b.disabled && b.checked), 'now they can be chosen');
  await pg.click(pg.q('input[data-event="parcelShipped"]')); await pg.click(pg.q('input[data-event="overdue"]'));
  assert.deepEqual((await api('GET', '/api/my/notifications', undefined, p.cookie)).json.events.filter((e) => !e.enabled).map((e) => e.key), ['parcelShipped', 'overdue'], 'saved');
  await pg.click(pg.q('#notifyToggle'));
  assert.ok(boxes().every((b) => b.disabled), 'off: greyed out');
  assert.deepEqual(boxes().filter((b) => !b.checked).map((b) => b.dataset.event), ['parcelShipped', 'overdue'], 'but your choices are remembered');
  await go(pg, '#/'); assert.match(text(pg, 'a.gocard[href="#/notifications"]'), /Email notifications.*off/);
  await go(pg, '#/settings'); assert.match(text(pg, '#emailsCard'), /Order emails are off\./); assert.ok(pg.q('#emailsCard a[href="#/notifications"]'));
  assert.deepEqual(pg.errors, []); pg.close();
});

test('THE DELETE CARD: warns about credit and about paid items still on their way — without ever mentioning what the GOM keeps', async () => {
  const p = await person(); const [claim] = await claimAndSecure(app, admin, p.handle, w.keyring); void claim;
  const pay = await api('POST', '/api/my/payments', { method: 'PayPal', amount: 6, reference: 'w' }, p.cookie); await api('POST', `/api/admin/payments/${pay.json.id}/verify`, {});
  await api('POST', '/api/admin/credit/add', { handle: p.handle, amount: 4.5, reason: 'goodwill' });
  const pg = await page(p, '#/settings');
  assert.match(text(pg, '[data-warn="credit"]'), /You have £4\.50 credit with the GOM\. Deleting your account doesn't pay it back — message the GOM first if you'd like it refunded\./);
  assert.match(text(pg, '[data-warn="inflight"]'), /1 paid item that hasn't reached you yet/);
  assert.doesNotMatch(text(pg, '#deleteCard'), /history|record|kept|retain|anonym|financial/i);
  assert.equal(pg.q('[data-act="delete-account"]').disabled, false);
  pg.close();
});
