import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, seed } from './helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (p = 'iv') => `${p}${++N}`;
// someone who has an order on the site but has never signed in (like everyone an import brings across)
const person = async (handle = u()) => { await app.api('POST', '/api/claims', { handle, lines: [{ itemId: w.keyring }] }); return handle; };
const list = async (qs = '') => (await api('GET', `/api/admin/invites${qs}`)).json;
const make = (body) => api('POST', '/api/admin/invites', body);
const tokenOf = (url) => new URL(url).hash.replace(/^#t=/, '');
const preview = (t) => app.api('GET', `/api/invites/${encodeURIComponent(t)}`);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const joinerRow = async (h) => (await app.q('SELECT account_id, linked_via, verified_at FROM joiners WHERE instagram_handle = ?', [h]))[0];
// the person opens the link, asks for the sign-in email, and uses the emailed link
async function signInViaInvite(token, email) {
  const r = await app.api('POST', `/api/invites/${encodeURIComponent(token)}/request-link`, { email });
  if (r.status !== 200) return { r };
  const mailToken = app.tokenFromMail(email);
  const conf = await fetch(`${app.base}/auth/confirm`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(mailToken)}` });
  return { r, conf, cookie: (conf.headers.get('set-cookie') || '').split(';')[0] };
}

test('who is listed: people with orders but no account — not people who have signed in, have no orders, are blocked, or have only cancelled claims', async () => {
  const [wants, linked, blocked, cancelledOnly, nothing] = [await person(), await person(), await person(), await person(), u('nothing')];
  await app.login(`${linked}@x.com`); await app.q('UPDATE joiners SET account_id = (SELECT id FROM accounts WHERE email = ?) WHERE instagram_handle = ?', [`${linked}@x.com`, linked]);
  await api('POST', '/api/admin/joiners/block', { handle: blocked, reason: 'test' });
  const c = (await api('GET', `/api/admin/claims?handle=${cancelledOnly}`)).json.claims[0];
  await api('PATCH', `/api/admin/claims/${c.id}`, { status: 'cancelled' });
  await app.q('INSERT IGNORE INTO joiners (instagram_handle) VALUES (?)', [nothing]);
  const l = await list();
  const handles = l.people.map((p) => p.handle);
  assert.ok(handles.includes(wants));
  for (const h of [linked, blocked, cancelledOnly, nothing]) assert.equal(handles.includes(h), false, `${h} should not be listed`);
  assert.deepEqual(l.people.find((p) => p.handle === wants), { handle: wants, claims: 1, owed: 0, status: 'none', createdAt: null, expiresAt: null });
  assert.equal(l.totals.unlinked, l.people.length); assert.equal(l.totals.none, l.people.length); assert.equal(l.days, 7);
  assert.ok(l.totals.linked >= 1);
});

test('what people owe is shown, and the list can be searched and filtered', async () => {
  const h = u('owes'); await person(h);
  await api('POST', '/api/admin/claims/secure', { claimIds: (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims.map((c) => c.id) });
  assert.equal((await list(`?q=@${h.toUpperCase()}`)).people[0].owed, 6, 'the keyring costs £6');
  assert.deepEqual((await list('?q=zzz-nobody')).people, []);
  await make({ handles: [h] });
  assert.deepEqual((await list('?filter=active&q=owes')).people.map((p) => p.handle), [h]);
  assert.equal((await list('?filter=none&q=' + h)).people.length, 0);
});

test('making a link: it works for 7 days, lives in the #fragment, is shown ONCE (only a hash is kept), and the person becomes "active"', async () => {
  const h = await person();
  const r = await make({ handles: [`@${h}`] });
  assert.equal(r.status, 201);
  const [link] = r.json.links;
  assert.match(link.url, new RegExp(`^${app.cfg.publicUrl.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/claim\\.html#t=[A-Za-z0-9_-]{40,}$`));
  const days = (new Date(link.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 6.99 && days <= 7.001, `expires in ${days.toFixed(3)} days`);
  const token = tokenOf(link.url);
  const [row] = await app.q('SELECT token_hash FROM handle_invites WHERE joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)', [h]);
  assert.equal(row.token_hash, sha(token));
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM handle_invites WHERE token_hash = ?', [token]))[0].n, 0, 'the link itself is never stored');
  const p = (await list(`?q=${h}`)).people[0];
  assert.equal(p.status, 'active'); assert.ok(p.expiresAt);
});

test('making a NEW link switches the old one off; a link can be revoked; "missing" makes links only for people without a live one', async () => {
  const [a, b] = [await person(), await person()];
  const first = tokenOf((await make({ handles: [a] })).json.links[0].url);
  assert.equal((await preview(first)).status, 200);
  const second = tokenOf((await make({ handles: [a] })).json.links[0].url);
  assert.equal((await preview(first)).status, 404, 'the old link stopped working');
  assert.equal((await preview(second)).status, 200);
  assert.equal((await api('POST', '/api/admin/invites/revoke', { handle: a })).json.revoked, 1);
  assert.equal((await preview(second)).status, 404);
  assert.equal((await list(`?q=${a}`)).people[0].status, 'none');
  await make({ handles: [b] });
  const bulk = await make({ mode: 'missing' });
  const made = bulk.json.links.map((l) => l.handle);
  assert.ok(made.includes(a), 'a (revoked) gets a new link'); assert.equal(made.includes(b), false, 'b already has a live one');
  const again = await make({ mode: 'missing' });
  assert.deepEqual(again.json.links, [], 'nobody is left without one');
  assert.equal((await list()).totals.none, 0);
});

test('people who cannot have a link are skipped with a reason: unknown, not a handle, already signed in, blocked', async () => {
  const [linked, blocked] = [await person(), await person()];
  await app.login(`${linked}@x.com`); await app.q('UPDATE joiners SET account_id = (SELECT id FROM accounts WHERE email = ?) WHERE instagram_handle = ?', [`${linked}@x.com`, linked]);
  await api('POST', '/api/admin/joiners/block', { handle: blocked, reason: 't' });
  const r = await make({ handles: ['nobody_here_xyz', 'not a handle!', linked, blocked] });
  assert.deepEqual(r.json.links, []);
  assert.deepEqual(r.json.skipped.map((s) => s.reason).sort(), ['has already signed in', 'is blocked', "isn't a valid handle", 'is not on the site'].sort());
  assert.equal((await make({})).status, 400);
  assert.equal((await make({ handles: [] })).status, 400);
});

test('opening a link shows only the handle; every kind of bad link gets the same answer and reveals nothing', async () => {
  const [h, gone, used, rev] = [await person(), await person(), await person(), await person()];
  const t = tokenOf((await make({ handles: [h] })).json.links[0].url);
  const ok = await preview(t);
  assert.deepEqual([ok.status, ok.json.valid, ok.json.handle], [200, true, h]);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const tExpired = tokenOf((await make({ handles: [gone] })).json.links[0].url);
  await app.q('UPDATE handle_invites SET expires_at = NOW(3) - INTERVAL 1 MINUTE WHERE token_hash = ?', [sha(tExpired)]);
  const tUsed = tokenOf((await make({ handles: [used] })).json.links[0].url);
  assert.equal((await app.api('POST', `/api/invites/${tUsed}/redeem`, {}, await app.login(`${used}@x.com`))).status, 200);     // genuinely used
  const tRevoked = tokenOf((await make({ handles: [rev] })).json.links[0].url);
  await api('POST', '/api/admin/invites/revoke', { handle: rev });
  const answers = [];
  for (const bad of [tExpired, tUsed, tRevoked, 'not-a-real-token', 'x'.repeat(200), '%20']) { const r = await preview(bad); assert.equal(r.status, 404, bad.slice(0, 12)); answers.push(JSON.stringify(r.json)); }
  assert.equal(new Set(answers).size, 1, 'identical answers: nothing about WHY, and no handle');
  assert.match(answers[0], /not valid any more/); assert.ok(!answers[0].includes(gone));
  assert.equal((await list(`?q=${gone}`)).people[0].status, 'expired');
});

test('THE FLOW: open the link → ask for the sign-in email → use it → the handle is linked, checked, the link is spent, and they land on My orders', async () => {
  const h = await person(); const email = `${h}@claim.example`;
  const token = tokenOf((await make({ handles: [h] })).json.links[0].url);
  const { r, conf, cookie } = await signInViaInvite(token, email);
  assert.equal(r.status, 200); assert.match(r.json.message, /sign-in link is on its way/);
  const mail = app.mailer.outbox.filter((m) => m.to === email).pop();
  assert.match(mail.subject, /your orders are ready/); assert.match(mail.text, new RegExp(`links @${h}'s orders to this email address`));
  assert.deepEqual([conf.status, conf.headers.get('location')], [303, '/my.html']);
  const j = await joinerRow(h);
  assert.ok(j.account_id); assert.equal(j.linked_via, 'invite'); assert.ok(j.verified_at, 'the GOM sent it to the real owner, so the handle counts as checked');
  const me = (await app.api('GET', '/api/me', undefined, cookie)).json;
  assert.deepEqual(me.handles.map((x) => x.handle), [h]);
  assert.equal((await preview(token)).status, 404, 'a link works once');
  assert.equal((await app.api('POST', `/api/invites/${token}/request-link`, { email: 'someone.else@x.com' })).status, 404);
  assert.equal((await list(`?q=${h}`)).people.length, 0, 'no longer listed as waiting');
  const recent = (await api('GET', '/api/admin/joiners/recent-links?days=1')).json.links.find((x) => x.handle === h);
  assert.deepEqual([recent.linkedVia, recent.verified], ['invite', true]);
});

test('already signed in? The link links straight away; a spent link cannot be used again, even by another signed-in person', async () => {
  const h = await person(); const email = `${h}@x.com`;
  const token = tokenOf((await make({ handles: [h] })).json.links[0].url);
  assert.equal((await app.api('POST', `/api/invites/${token}/redeem`, {})).status, 401, 'needs to be signed in');
  const cookie = await app.login(email);
  const r = await app.api('POST', `/api/invites/${token}/redeem`, {}, cookie);
  assert.deepEqual([r.status, r.json.handle], [200, h]);
  assert.equal((await joinerRow(h)).linked_via, 'invite');
  assert.equal((await app.api('POST', `/api/invites/${token}/redeem`, {}, cookie)).status, 404);
  const stranger = await app.login(`${u('stranger')}@x.com`);
  assert.equal((await app.api('POST', `/api/invites/${token}/redeem`, {}, stranger)).status, 404);
});

test('a link can be used by only ONE of two people racing for it', async () => {
  const h = await person();
  const token = tokenOf((await make({ handles: [h] })).json.links[0].url);
  const [c1, c2, c3] = [await app.login(`${u('r')}@x.com`), await app.login(`${u('r')}@x.com`), await app.login(`${u('r')}@x.com`)];
  const rs = await Promise.all([c1, c2, c3].map((c) => app.api('POST', `/api/invites/${token}/redeem`, {}, c)));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 404, 404]);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM handle_invites WHERE used_at IS NOT NULL AND joiner_id = (SELECT id FROM joiners WHERE instagram_handle = ?)', [h]))[0].n, 1);
});

test('if things change between asking for the email and using it, the handle is NOT linked: expired, switched off, or taken by someone else', async () => {
  const mk = async () => { const h = await person(); return { h, token: tokenOf((await make({ handles: [h] })).json.links[0].url) }; };
  // expired in the meantime
  let { h, token } = await mk(); let em = `${h}@x.com`;
  await app.api('POST', `/api/invites/${token}/request-link`, { email: em });
  await app.q('UPDATE handle_invites SET expires_at = NOW(3) - INTERVAL 1 MINUTE WHERE token_hash = ?', [sha(token)]);
  let conf = await fetch(`${app.base}/auth/confirm`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(app.tokenFromMail(em))}` });
  assert.equal((await joinerRow(h)).account_id, null, 'expired: not linked'); assert.equal(conf.headers.get('location'), '/', 'they are signed in, just not linked');
  // switched off in the meantime
  ({ h, token } = await mk()); em = `${h}@x.com`;
  await app.api('POST', `/api/invites/${token}/request-link`, { email: em });
  await api('POST', '/api/admin/invites/revoke', { handle: h });
  await fetch(`${app.base}/auth/confirm`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(app.tokenFromMail(em))}` });
  assert.equal((await joinerRow(h)).account_id, null, 'revoked: not linked');
  // somebody else got the handle first
  ({ h, token } = await mk()); em = `${h}@x.com`;
  await app.api('POST', `/api/invites/${token}/request-link`, { email: em });
  const other = await app.login(`${u('first')}@x.com`);
  await app.q('UPDATE joiners SET account_id = (SELECT id FROM accounts WHERE email = ?) WHERE instagram_handle = ?', [(await app.q('SELECT email FROM accounts ORDER BY id DESC LIMIT 1'))[0].email, h]);
  const before = (await joinerRow(h)).account_id;
  await fetch(`${app.base}/auth/confirm`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(app.tokenFromMail(em))}` });
  assert.equal((await joinerRow(h)).account_id, before, 'the handle stays with whoever had it');
  assert.ok(other);
});

test('an admin email cannot be used with an invite, and gets the same answer as anyone else', async () => {
  const h = await person();
  const token = tokenOf((await make({ handles: [h] })).json.links[0].url);
  const adminEmail = (await app.q('SELECT email FROM accounts WHERE is_admin = 1 LIMIT 1'))[0].email;
  const sent = app.mailer.outbox.length;
  const r = await app.api('POST', `/api/invites/${token}/request-link`, { email: adminEmail });
  assert.equal(r.status, 200); assert.equal(app.mailer.outbox.length, sent, 'no email');
  assert.equal((await joinerRow(h)).account_id, null);
  assert.equal((await app.api('POST', `/api/invites/${token}/request-link`, { email: 'not an email' })).status, 400);
});

test('a normal sign-in is untouched by all this: it links nothing and lands on the home page', async () => {
  const email = `${u('plain')}@x.com`;
  await app.api('POST', '/api/auth/request-link', { email });
  const conf = await fetch(`${app.base}/auth/confirm`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(app.tokenFromMail(email))}` });
  assert.deepEqual([conf.status, conf.headers.get('location')], [303, '/']);
});

test('only the GOM can make, list or revoke links', async () => {
  const j = await app.login('inv.joiner@x.com');
  for (const [m, p, b] of [['GET', '/api/admin/invites'], ['POST', '/api/admin/invites', { handles: ['x'] }], ['POST', '/api/admin/invites/revoke', { handle: 'x' }]]) {
    assert.equal((await api(m, p, b, j)).status, 403, p); assert.equal((await app.api(m, p, b)).status, 401, `${p} signed out`);
  }
});

test('INVARIANTS: a spent link always has an owner, and no handle has two live links', async () => {
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM handle_invites i JOIN joiners j ON j.id = i.joiner_id WHERE i.used_at IS NOT NULL AND j.account_id IS NULL"))[0].n, 0);
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM (SELECT joiner_id FROM handle_invites WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW(3) GROUP BY joiner_id HAVING COUNT(*) > 1) x'))[0].n, 0);
  assert.equal((await app.q("SELECT COUNT(*) AS n FROM joiners WHERE linked_via = 'invite' AND verified_at IS NULL"))[0].n, 0);
});
