import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { gomPage, openPage, modal, press, toast } from './ui.helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'ui') => `${x}${++N}`;
const person = async (h = u()) => { await app.api('POST', '/api/claims', { handle: h, lines: [{ itemId: w.keyring }] }); return h; };
const text = (p, sel = '#tabBody') => p.text(p.q(sel));
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'People')); return p; };
const tokenOf = (url) => new URL(url).hash.replace(/^#t=/, '');
const row = (p, h) => p.q(`[data-invitee="${h}"]`);
// capture what the page copies and downloads
function spy(p) {
  const out = { copied: [], blobs: [] };
  Object.defineProperty(p.window.navigator, 'clipboard', { value: { writeText: async (t) => { out.copied.push(t); } }, configurable: true });
  p.window.URL.createObjectURL = (b) => { out.blobs.push(b); return 'blob:test'; }; p.window.URL.revokeObjectURL = () => {};
  p.window.HTMLAnchorElement.prototype.click = function () { out.lastDownload = this.download; };
  return out;
}
const blobText = (p, blob) => new Promise((res) => { const fr = new p.window.FileReader(); fr.onload = () => res(fr.result); fr.readAsText(blob); });

test('the card explains what links are, and counts who is waiting — and who is not', async () => {
  const [a, b] = [await person(), await person()];
  await api('POST', '/api/admin/invites', { handles: [a] });
  const p = await open();
  const t = text(p, '#inviteCard');
  assert.match(t, /Invite people to claim their orders.*one-time link.*Instagram DM.*no approval step.*Links work for 7 days/s);
  const tot = text(p, '[data-invite-totals]');
  assert.match(tot, /\d+ waiting · 1 with a live link · 0 expired · \d+ with no link yet · \d+ already signed in/);
  assert.match(p.text(row(p, a)), new RegExp(`@${a}.*1.*link made.*until \\d+ \\w+ \\d{4}.*Make a new link.*Switch off`, 's'));
  assert.match(p.text(row(p, b)), new RegExp(`@${b}.*no link yet.*Make link`, 's'));
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('making a link for one person: shown once with copy buttons; the link really works; the copied message has the link and expiry filled in', async () => {
  const h = await person();
  const p = await open(); const s = spy(p);
  await p.click(p.byText('button', 'Make link', row(p, h)));
  const fresh = p.q(`[data-fresh-row="${h}"]`);
  assert.match(text(p, '[data-fresh]'), /1 new link — copy them now.*only shown here, once/s);
  const url = p.q('input', fresh).value;
  assert.match(url, /\/claim\.html#t=[A-Za-z0-9_-]{40,}$/);
  assert.equal((await app.api('GET', `/api/invites/${tokenOf(url)}`)).json.handle, h, 'the link on the screen is a real, working link');
  await p.click(p.byText('button', 'Copy link', fresh));
  assert.equal(s.copied[0], url); assert.match(toast(p), /Copied/);
  p.q('#inviteMsg').value = 'Hey! Your orders: {link} (valid till {date})';
  await p.click(p.byText('button', 'Copy message', fresh));
  assert.match(s.copied[1], new RegExp(`^Hey! Your orders: ${url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\(valid till \\d+ \\w+ \\d{4}\\)$`));
  assert.match(p.text(row(p, h)), /link made/);
  p.close();
});

test('making links for everyone without one: asks first; then every link can be downloaded as a spreadsheet with the message ready to paste', async () => {
  const hs = [await person(), await person()];
  const p = await open(); const s = spy(p);
  p.q('#inviteMsg').value = 'Hi {link} until {date}';
  await p.click(p.q('[data-act="invite-missing"]'));
  assert.match(p.text(modal(p)), /Make links for \d+ (people|person)\?.*one-time link that works for 7 days.*Anyone who already has a live link is left as they are/s);
  await press(p, 'Not yet');
  assert.equal(p.q('[data-fresh]'), null, 'nothing was made');
  await p.click(p.q('[data-act="invite-missing"]')); await press(p, 'Make the links');
  assert.match(toast(p), /Made \d+ links?/);
  for (const h of hs) assert.ok(p.q(`[data-fresh-row="${h}"]`), `${h} has a link`);
  assert.equal(p.q('[data-act="invite-missing"]').disabled, true, 'nobody is left without one');
  await p.click(p.byText('button', 'Download all as a spreadsheet (CSV)'));
  assert.match(s.lastDownload, /^claim-links-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await blobText(p, s.blobs.at(-1));
  const lines = csv.split('\n');
  assert.equal(lines[0], 'handle,link,expires,message');
  const mine = lines.find((l) => l.startsWith(`"${hs[0]}"`));
  assert.match(mine, new RegExp(`^"${hs[0]}","[^"]+claim\\.html#t=[A-Za-z0-9_-]+","\\d{4}-\\d{2}-\\d{2}","Hi [^"]+claim\\.html#t=[A-Za-z0-9_-]+ until \\d+ \\w+ \\d{4}"$`));
  await p.click(p.byText('button', 'Done — hide these'));
  assert.equal(p.q('[data-fresh]'), null);
  p.close();
});

test('an edited message is kept when you search; the list can be filtered and searched', async () => {
  const [a, b] = [await person(u('findme')), await person(u('other'))];
  await api('POST', '/api/admin/invites', { handles: [a] });
  const p = await open();
  p.q('#inviteMsg').value = 'My own wording {link}';
  await p.type(p.q('#inviteSearch'), 'findme'); await sleep(300); await p.settle();
  assert.ok(row(p, a)); assert.equal(row(p, b), null);
  assert.equal(p.q('#inviteMsg').value, 'My own wording {link}', 'the redraw did not throw away what you typed');
  await p.type(p.q('#inviteSearch'), ''); await sleep(300); await p.settle();
  await p.choose(p.q('[data-invite-filter]'), 'none'); assert.equal(row(p, a), null); assert.ok(row(p, b));
  await p.choose(p.q('[data-invite-filter]'), 'active'); assert.ok(row(p, a)); assert.equal(row(p, b), null);
  p.close();
});

test('"Switch off" stops a link working; and if someone signs in after the page loaded, trying to make them a link explains why not', async () => {
  const [h, late] = [await person(), await person()];
  const token = tokenOf((await api('POST', '/api/admin/invites', { handles: [h] })).json.links[0].url);
  const p = await open();
  await p.click(p.byText('button', 'Switch off', row(p, h)));
  assert.match(toast(p), new RegExp(`@${h}'s link switched off`));
  assert.match(p.text(row(p, h)), /no link yet/);
  assert.equal((await app.api('GET', `/api/invites/${token}`)).status, 404);
  // the page still lists `late` as waiting, but they sign in before the GOM clicks
  await app.login(`${late}@x.com`);
  await app.q('UPDATE joiners SET account_id = (SELECT id FROM accounts WHERE email = ?) WHERE instagram_handle = ?', [`${late}@x.com`, late]);
  await p.click(p.byText('button', 'Make link', row(p, late)));
  assert.match(text(p, '[data-skipped]'), new RegExp(`Not made for: @${late} \\(has already signed in\\)`));
  assert.equal(p.q(`[data-fresh-row="${late}"]`), null, 'no link was made for someone who no longer needs one');
  p.close();
});

test('someone who used their link shows in "Recently linked emails" as having used the link you sent, already checked', async () => {
  const h = await person(); const email = `${h}@x.com`;
  const token = tokenOf((await api('POST', '/api/admin/invites', { handles: [h] })).json.links[0].url);
  assert.equal((await app.api('POST', `/api/invites/${token}/redeem`, {}, await app.login(email))).status, 200);
  const p = await open();
  assert.equal(row(p, h), null, 'no longer waiting');
  const r = text(p, `[data-link="${h}"]`);
  assert.match(r, /used the link you sent/); assert.match(r, /checked/); assert.doesNotMatch(r, /not checked/);
  p.close();
});

// ───────────── the page the person opens ─────────────
const claimPage = (token, opts) => openPage(app, `/claim.html${token ? `#t=${token}` : ''}`, opts);
const settle = async (p) => { await sleep(80); await p.settle(); await sleep(40); await p.settle(); };
const linkFor = async (h) => tokenOf((await api('POST', '/api/admin/invites', { handles: [h] })).json.links[0].url);

test('opening a good link (signed out): shows the handle and an email box; the secret is removed from the address bar', async () => {
  const h = await person(); const token = await linkFor(h);
  const p = await claimPage(token); await settle(p);
  const t = p.text(p.q('#view'));
  assert.match(t, new RegExp(`Your orders are ready.*moved to this new site.*@${h}.*Enter your email.*Email me a sign-in link`, 's'));
  assert.match(t, /works once and expires on \d+ \w+ \d{4}.*Only use it if it's really your Instagram handle/s);
  assert.equal(p.window.location.hash, '', 'the secret is no longer in the address bar or history');
  assert.deepEqual(p.errors, []);
  p.close();
});

test('the whole journey on the page: email → "check your email" → the emailed link signs them in and links the handle', async () => {
  const h = await person(); const email = `${h}@journey.example`; const token = await linkFor(h);
  const p = await claimPage(token); await settle(p);
  p.q('#em').value = email; await p.submit(p.q('form[data-form="email"]')); await settle(p);
  assert.match(p.text(p.q('[data-msg]')), new RegExp(`Check your email — a sign-in link is on its way to ${email.replace('.', '\\.')}`));
  assert.equal(p.q('form[data-form="email"]').hidden, true);
  assert.match(app.mailer.outbox.filter((m) => m.to === email).pop().text, new RegExp(`links @${h}'s orders`));
  const conf = await fetch(`${app.base}/auth/confirm`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(app.tokenFromMail(email))}` });
  assert.equal(conf.headers.get('location'), '/my.html');
  assert.equal((await app.q('SELECT linked_via FROM joiners WHERE instagram_handle = ?', [h]))[0].linked_via, 'invite');
  p.close();
});

test('already signed in: one tap links the handle', async () => {
  const h = await person(); const email = `${h}@x.com`; const token = await linkFor(h);
  const cookie = await app.login(email);
  const p = await claimPage(token, { cookies: [cookie] }); await settle(p);
  const t = p.text(p.q('#view'));
  assert.match(t, new RegExp(`You're signed in as ${email}.*Link @${h} to my account`, 's'));
  assert.equal(p.q('form[data-form="email"]'), null, 'no need to ask for an email');
  await p.click(p.q('[data-act="link"]')); await settle(p);
  assert.match(p.text(p.q('[data-msg]')), new RegExp(`Done — @${h} is now linked to your account`));
  assert.ok((await app.q('SELECT account_id FROM joiners WHERE instagram_handle = ?', [h]))[0].account_id);
  p.close();
});

test('a link that does not work says so plainly and reveals nothing: expired, used, missing, or made up', async () => {
  const [exp, used] = [await person(), await person()];
  const tExp = await linkFor(exp);
  await app.q('UPDATE handle_invites SET expires_at = NOW(3) - INTERVAL 1 MINUTE WHERE joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)', [exp]);
  const tUsed = await linkFor(used);
  await app.api('POST', `/api/invites/${tUsed}/redeem`, {}, await app.login(`${used}@x.com`));
  for (const [token, label] of [[tExp, 'expired'], [tUsed, 'used'], ['made-up-token-123', 'made up']]) {
    const p = await claimPage(token); await settle(p);
    const t = p.text(p.q('#view'));
    assert.match(t, /This link isn't working.*not valid any more.*Ask whoever sent it for a new one/s, label);
    assert.doesNotMatch(t, new RegExp(`${exp}|${used}`), `${label}: no handle shown`);
    p.close();
  }
  const none = await claimPage(null); await settle(none);
  assert.match(none.text(none.q('#view')), /There is no link here/);
  none.close();
});

test('a GOM who happens to be signed in is still offered the email route, not the one-tap link', async () => {
  const h = await person(); const token = await linkFor(h);
  const p = await claimPage(token, { cookies: [admin] }); await settle(p);
  assert.ok(p.q('form[data-form="email"]')); assert.equal(p.q('[data-act="link"]'), null);
  p.close();
});
