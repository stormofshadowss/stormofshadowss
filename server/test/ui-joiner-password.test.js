import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { openPage, modal, press } from './ui.helpers.js';

// JOINER SCREENS for optional passwords: the sign-in page's "Sign in with a password instead", the dashboard nudge, and the Settings card (set / change / remove).
let app, admin, w, N = 0;
const GOOD = 'correct horse battery staple', GOOD2 = 'tangerine-umbrella-42';
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'upw') => `${x}${++N}`;
async function person() { const handle = u(), email = `${handle}@x.com`; const cookie = await joinerSession(app, email, handle); return { handle, email, cookie }; }
const setPw = (p, pw) => api('PUT', '/api/my/password', { newPassword: pw }, p.cookie);
const pwCookie = async (p, pw) => (await api('POST', '/api/auth/password-login', { email: p.email, password: pw })).headers.get('set-cookie').split(';')[0];
const page = async (cookie, hash = '#/') => { const pg = await openPage(app, '/my.html', { cookies: cookie ? [cookie] : [] }); await sleep(300); await pg.settle(); if (hash !== '#/') { pg.window.location.hash = hash; await sleep(250); await pg.settle(); } return pg; };
const done = async (pg) => { await sleep(500); await pg.settle(); };
const hasPassword = async (p) => (await api('GET', '/api/me', undefined, p.cookie)).json.account.hasPassword;
const BAD = "That email and password don't match — or there have been too many wrong tries, so it's paused for a few minutes. You can always use the email link instead.";
const mails = (p, what) => app.mailer.outbox.filter((m) => m.to === p.email && m.subject === `Your StormOfShadowss password was ${what}`);

test('THE SIGN-IN PAGE: says no password is needed (one can be set later); "Sign in with a password instead" reveals email + password (email carried over); a wrong one shows the plain message and keeps them signed out; the right one signs them in', async () => {
  const p = await person(); await setPw(p, GOOD); const pg = await page(null); const form = () => pg.q('form[data-form="pwlogin"]');
  assert.match(pg.text(pg.q('#view')), /Sign in.*Enter your email and we'll send you a one-time link — no password needed\. \(You can choose to set a password later, in Settings\.\).*Email me a sign-in link.*Sign in with a password instead/); assert.equal(form().hidden, true, 'hidden until asked for');
  pg.q('#email').value = p.email; await pg.click(pg.q('[data-act="show-password-login"]')); assert.equal(form().hidden, false); assert.equal(form().elements.email.value, p.email, 'the email they typed is carried over'); assert.equal(form().elements.password.type, 'password'); assert.equal(form().elements.password.autocomplete, 'current-password'); assert.match(pg.text(form()), /Forgotten it\? Use the email link above — once you're in you can set a new password in Settings\./);
  form().elements.password.value = 'not my password'; await pg.submit(form()); await done(pg); assert.equal(pg.text(pg.q('[data-msg]', form())), BAD); assert.ok(pg.byText('h2', 'Sign in'), 'still signed out'); await pg.click(pg.q('[data-act="show-password-login"]')); assert.equal(form().hidden, true, 'the link toggles it away again');
  await pg.click(pg.q('[data-act="show-password-login"]')); form().elements.password.value = GOOD; await pg.submit(form()); await done(pg);
  assert.ok(pg.byText('h1', 'My orders'), 'signed in: the dashboard'); assert.ok(pg.text(pg.q('#view')).includes(p.email)); assert.equal((await app.q('SELECT via FROM sessions WHERE account_id = (SELECT id FROM accounts WHERE email = ?) ORDER BY id DESC LIMIT 1', [p.email]))[0].via, 'password'); assert.deepEqual([pg.errors], [[]]); pg.close();
});

test('THE NUDGE on the dashboard: "Want to skip the email next time?" with "Set a password" and "No thanks"; No thanks is remembered; not shown once they have a password, and not on the other pages', async () => {
  const p = await person(), q = await person(); await setPw(q, GOOD); const pg = await page(p.cookie); const card = () => pg.q('[data-password-nudge]');
  assert.ok(card(), 'shown on the dashboard'); assert.match(pg.text(card()), /^Want to skip the email next time\? Set a password and you can sign in with just your email and password\. The email link will always still work\.\s*Set a password\s*No thanks$/); assert.equal(pg.q('[data-nudge-set]', card()).getAttribute('href'), '#/settings');
  const ongoing = await page(p.cookie, '#/ongoing'); assert.equal(ongoing.q('[data-password-nudge]'), null, 'only on the dashboard'); ongoing.close(); const withPw = await page(q.cookie); assert.equal(withPw.q('[data-password-nudge]'), null, 'not for someone who has a password'); withPw.close();
  await pg.click(pg.q('[data-act="nudge-off"]', card())); await done(pg); assert.equal(card(), null, 'gone straight away'); assert.equal((await api('GET', '/api/me', undefined, p.cookie)).json.account.passwordNudge, false); const again = await page(p.cookie); assert.equal(again.q('[data-password-nudge]'), null, 'and it stays gone'); assert.deepEqual([pg.errors, again.errors], [[], []]); pg.close(); again.close();
  const r = await person(); const go = await page(r.cookie); await go.click(go.q('[data-nudge-set]')); await done(go); assert.ok(go.q('#passwordCard'), '"Set a password" goes to Settings, where the password card is'); go.close();
});

test('SETTINGS — SET A PASSWORD: the card explains it and the rule; "Show it" reveals what they typed; a weak one is refused with the reason; a good one is saved (the card changes, a security email is sent, the nudge goes)', async () => {
  const p = await person(); const pg = await page(p.cookie, '#/settings'); const card = () => pg.q('#passwordCard'); const form = () => pg.q('form[data-form="pw-set"]', card());
  assert.match(pg.text(pg.q('h2', card())), /^Sign in with a password \(optional\)$/); assert.match(pg.text(card()), /Skip the email next time: choose a password and you can sign in with just your email and password\. The emailed link will always still work\./); assert.match(pg.text(card()), /At least 10 characters, and not a common one\. A few random words strung together works well\./); assert.match(pg.text(card()), /We'll email you whenever your password is set, changed or removed\./);
  assert.equal(form().elements.password.type, 'password'); assert.equal(form().elements.password.autocomplete, 'new-password'); assert.equal(form().elements.current, undefined, 'no "current password" when there isn\'t one'); await pg.click(pg.q('[data-act="show-pw"]', form())); assert.equal(form().elements.password.type, 'text', 'Show it'); await pg.click(pg.q('[data-act="show-pw"]', form())); assert.equal(form().elements.password.type, 'password');
  form().elements.password.value = 'short'; await pg.submit(form()); await done(pg); assert.equal(pg.text(pg.q('[data-msg]', form())), 'Your password must be at least 10 characters. A few random words strung together works well.'); assert.equal(await hasPassword(p), false);
  form().elements.password.value = GOOD; await pg.submit(form()); await done(pg); assert.equal(await hasPassword(p), true); assert.match(pg.text(pg.q('[data-msg]', card())), /^Password set — you can now sign in with your email and password\.$/); assert.match(pg.text(card()), /A password is set \(since .+\)\. You can sign in with your email and password, or use an emailed link any time\./); assert.ok(pg.q('form[data-form="pw-change"]', card()) && pg.q('form[data-form="pw-remove"]', card()));
  assert.equal(mails(p, 'set').length, 1, 'the security email'); const home = await page(p.cookie); assert.equal(home.q('[data-password-nudge]'), null, 'no nudge once one is set'); assert.deepEqual([pg.errors, home.errors], [[], []]); pg.close(); home.close();
});

test('SETTINGS — CHANGE AND REMOVE after an EMAIL LINK sign-in: no current password asked for; changing saves and emails; "Remove my password" asks first ("Keep it" does nothing) and then the card goes back to "set"', async () => {
  const p = await person(); await setPw(p, GOOD); const pg = await page(p.cookie, '#/settings'); const card = () => pg.q('#passwordCard');
  assert.equal(pg.q('input[name="current"]', card()), null, 'signed in by the link: no current password field'); const change = () => pg.q('form[data-form="pw-change"]', card()); assert.equal(change().elements.password.autocomplete, 'new-password');
  change().elements.password.value = GOOD2; await pg.submit(change()); await done(pg); assert.match(pg.text(pg.q('[data-msg]', card())), /^Password changed\.$/); assert.equal(mails(p, 'changed').length, 1); assert.equal((await api('POST', '/api/auth/password-login', { email: p.email, password: GOOD2 })).status, 200, 'the new one works');
  await pg.submit(pg.q('form[data-form="pw-remove"]', card())); await sleep(200); assert.match(pg.text(modal(pg)), /^Remove your password\?\s*You can still sign in with an emailed link any time\.\s*Keep it\s*Remove it$/); await press(pg, 'Keep it'); await done(pg); assert.equal(await hasPassword(p), true, '"Keep it": nothing changed');
  await pg.submit(pg.q('form[data-form="pw-remove"]', card())); await sleep(200); await press(pg, 'Remove it'); await done(pg); assert.equal(await hasPassword(p), false); assert.match(pg.text(pg.q('[data-msg]', card())), /^Password removed\. You sign in with an emailed link\.$/); assert.ok(pg.q('form[data-form="pw-set"]', card()), 'back to "choose a password"'); assert.equal(mails(p, 'removed').length, 1); assert.deepEqual([pg.errors], [[]]); pg.close();
});

test('SETTINGS after a PASSWORD sign-in: the current password IS asked for (to change and to remove); a wrong one shows the message; the right one works', async () => {
  const p = await person(); await setPw(p, GOOD); const cookie = await pwCookie(p, GOOD); const pg = await page(cookie, '#/settings'); const card = () => pg.q('#passwordCard'); const change = () => pg.q('form[data-form="pw-change"]', card()), remove = () => pg.q('form[data-form="pw-remove"]', card());
  assert.ok(change().elements.current && remove().elements.current, 'both forms ask for the current password'); assert.equal(change().elements.current.autocomplete, 'current-password'); assert.match(pg.text(pg.q('label[for="pwCur"]', card())), /^Your current password$/);
  change().elements.current.value = 'not my password'; change().elements.password.value = GOOD2; await pg.submit(change()); await done(pg); assert.equal(pg.text(pg.q('[data-msg]', change())), "That isn't your current password."); assert.equal((await api('POST', '/api/auth/password-login', { email: p.email, password: GOOD })).status, 200, 'nothing changed');
  change().elements.current.value = GOOD; await pg.submit(change()); await done(pg); assert.match(pg.text(pg.q('[data-msg]', card())), /^Password changed\.$/); assert.equal((await api('POST', '/api/auth/password-login', { email: p.email, password: GOOD2 })).status, 200);
  remove().elements.current.value = 'nope nope nope'; await pg.submit(remove()); await sleep(200); await press(pg, 'Remove it'); await done(pg); assert.equal(pg.text(pg.q('[data-msg]', remove())), "That isn't your current password."); assert.equal(await hasPassword(p), true, 'still set');
  assert.deepEqual([pg.errors], [[]]); pg.close();
});
