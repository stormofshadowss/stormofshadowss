import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// READ-ONLY "VIEW AS": the GOM opens a person's dashboard exactly as they see it. Enforced on the SERVER: admin only, GET only, only the dashboard's own endpoints, no writes at all.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); await app.q("INSERT IGNORE INTO payment_methods (method, account_info) VALUES ('PayPal', 'pay@example.com')"); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'va') => `${x}${++N}`;
const acct = async (h) => (await app.q('SELECT account_id AS id FROM joiners WHERE instagram_handle = ?', [h]))[0].id;
const as = (id, path, c = admin, m = 'GET', body) => api(m, `/api/admin/view-as/${id}${path}`, body, c);
async function person(...handles) { const email = `${u('p')}@x.com`; const cookie = await joinerSession(app, email, handles[0]); for (const h of handles.slice(1)) assert.equal((await api('POST', '/api/me/handles', { handle: h }, cookie)).status, 200); return { cookie, handles, email, id: await acct(handles[0]) }; }
const withMoney = async (p) => { const g = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('View GO '), proxy: 'Sam', paymentDeadline: '2000-01-01' })).json.id; const it = (await api('POST', `/api/admin/orders/${g}/items`, { type: 'normal', title: 'Thing', price: 12 })).json.id; await claimAndSecure(app, admin, p.handles[0], it); };
const TABLES = ['payments', 'claims', 'claim_costs', 'credit_ledger', 'addresses', 'joiners', 'accounts', 'parcels', 'parcel_items', 'cancel_requests', 'payment_allocations', 'parcel_companions'];
const checksum = async () => Object.fromEntries((await app.q(`CHECKSUM TABLE ${TABLES.join(', ')}`)).map((r) => [String(r.Table).split('.').pop(), String(r.Checksum)]));

test('THE GOM SEES EXACTLY WHAT THE JOINER SEES: every dashboard endpoint returns the same data through view-as as it does to the person themselves', async () => {
  const p = await person(u('same')); await withMoney(p); const h = p.handles[0];
  await api('PUT', `/api/my/address?handle=${h}`, { fullName: 'Sam Kim', address: '5 Example Road, Leeds LS1 1AA', email: p.email, phone: '07700 900123' }, p.cookie);
  for (const path of ['/me', `/my/summary?handle=${h}`, '/my/summary?handle=all', `/my/parcels?handle=${h}`, `/my/payments?handle=${h}`, `/my/fixed?handle=${h}`, `/my/address?handle=${h}`, `/my/notifications?handle=${h}`, `/my/defaults?handle=${h}`]) {
    const mine = await api('GET', `/api${path}`, undefined, p.cookie), viewed = await as(p.id, path); assert.equal(viewed.status, mine.status, path); assert.deepEqual(viewed.json, mine.json, `${path}: identical to what they see`);
  }
  const s = (await as(p.id, '/my/summary?handle=all')).json; assert.equal(s.owed.total, 12); assert.equal(s.orders[0].claims[0].overdue, true, 'including the overdue flag they see');
});

test('IT IS READ-ONLY, ENFORCED ON THE SERVER: every kind of change is refused (even a payment), and nothing is created', async () => {
  const p = await person(u('ro')); await withMoney(p); const h = p.handles[0]; const before = await checksum();
  for (const [m, path, body] of [['POST', `/my/payments?handle=${h}`, { method: 'PayPal', amount: 5, reference: 'X' }], ['PUT', `/my/address?handle=${h}`, { fullName: 'Hacker', address: '1 Nowhere Lane', email: 'a@b.co', phone: '0700' }], ['DELETE', '/my/cancel-requests/1', undefined], ['PATCH', '/my/anything', {}], ['POST', '/my/parcels', { claimIds: [1] }], ['PUT', '/my/notifications', { enabled: true }]]) {
    const r = await as(p.id, path, admin, m, body); assert.equal(r.status, 403, `${m} ${path}`); assert.equal(r.json.code, 'read_only'); assert.match(r.json.error, /read-only view — nothing can be changed from here\./);
  }
  assert.deepEqual(await checksum(), before, 'no table changed');
});

test('ONLY THE DASHBOARD\'S OWN ENDPOINTS ARE REACHABLE: no admin routes, no auth routes, no public ones, no bare prefix; and the person is never an admin on the way through', async () => {
  const p = await person(u('reach'));
  for (const path of ['', '/', '/admin/payments', '/admin/claims', '/auth/logout', '/orders', '/shop', '/groups', '/my-other', '/myfoo/x', '/mexico']) assert.equal((await as(p.id, path)).status, 404, `${path} is not reachable`);
  assert.equal((await as(p.id, '/me')).json.account.isAdmin, false, 'it IS the person, not an admin'); assert.equal((await as(p.id, '/admin/payments')).status, 404);
  const selfAdmin = await as((await app.q("SELECT id FROM accounts WHERE is_admin = 1 LIMIT 1"))[0].id, '/me'); assert.equal(selfAdmin.json.account.isAdmin, false, 'even viewing an admin\'s own account never carries admin rights');
});

test('ONLY AN ADMIN: a signed-in joiner (even looking at their OWN account), a signed-out visitor, and an unknown account are all refused', async () => {
  const p = await person(u('who')); const other = await person(u('oth')); assert.equal((await as(p.id, '/me', p.cookie)).status, 403, 'not even their own account via this route'); assert.equal((await as(other.id, '/my/summary?handle=all', p.cookie)).status, 403);
  assert.equal((await app.api('GET', `/api/admin/view-as/${p.id}/me`)).status, 401); assert.equal((await as(99999999, '/me')).status, 404); assert.equal((await as('abc', '/me')).status, 404, 'not a number');
});

test('NOTHING IN THE DATABASE CHANGES while a dashboard is looked at — including the address lookup, which WOULD tidy up a person\'s addresses if they looked themselves', async () => {
  const [a, b] = [u('ha'), u('hb')]; const p = await person(a, b); await withMoney(p);
  await app.q(`INSERT INTO addresses (joiner_id, full_name, address, email, phone, confirmed_at) SELECT id, 'Old Name', '1 Old Lane, Hull', 'o@x.com', '0111', '2026-01-01 10:00:00' FROM joiners WHERE instagram_handle = ?`, [a]);
  await app.q(`INSERT INTO addresses (joiner_id, full_name, address, email, phone, confirmed_at) SELECT id, 'Newer Name', '2 Newer Road, Leeds', 'n@x.com', '0222', '2026-09-01 10:00:00' FROM joiners WHERE instagram_handle = ?`, [b]);
  const before = await checksum();
  for (const path of ['/me', '/my/summary?handle=all', `/my/summary?handle=${a}`, '/my/parcels?handle=all', '/my/payments?handle=all', `/my/fixed?handle=${a}`, `/my/address?handle=${a}`, `/my/address?handle=${b}`, `/my/notifications?handle=${a}`, `/my/defaults?handle=${a}`]) assert.equal((await as(p.id, path)).status, 200, path);
  assert.deepEqual(await checksum(), before, 'every table is exactly as it was');
  assert.equal((await as(p.id, `/my/address?handle=${a}`)).json.address.address, '1 Old Lane, Hull', 'they are shown as stored — their addresses were not tidied');
  assert.equal((await api('GET', `/api/my/address?handle=${a}`, undefined, p.cookie)).json.address.address, '2 Newer Road, Leeds', 'control: when the PERSON looks, the addresses ARE brought into line — so the guard matters');
});

test('OPENING A DASHBOARD IS RECORDED (once per admin and person per 10 minutes, so loading the page isn\'t noise); looking things up does not record it', async () => {
  const p = await person(u('aud')), q = await person(u('aud')); const count = async (id) => (await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'view_as' AND entity_id = ?", [id]))[0].n;
  await as(p.id, '/my/summary?handle=all'); assert.equal(await count(p.id), 0, 'only the dashboard opening (/me) is recorded'); await as(p.id, '/me'); assert.equal(await count(p.id), 1); await as(p.id, '/me'); await as(p.id, '/me'); assert.equal(await count(p.id), 1, 'reloading inside 10 minutes adds nothing');
  await as(q.id, '/me'); assert.equal(await count(q.id), 1, 'a different person is recorded separately'); const row = (await app.q("SELECT account_id, detail FROM audit_log WHERE action = 'view_as' AND entity_id = ?", [p.id]))[0];
  assert.equal(row.account_id, (await app.q('SELECT id FROM accounts WHERE is_admin = 1 LIMIT 1'))[0].id, 'recorded against the GOM who looked'); assert.match(String(row.detail), new RegExp(p.email.replace('.', '\\.')));
  await app.q("UPDATE audit_log SET created_at = created_at - INTERVAL 20 MINUTE WHERE action = 'view_as' AND entity_id = ?", [p.id]); await as(p.id, '/me'); assert.equal(await count(p.id), 2, 'a later visit is recorded again');
});

test('LOOKING NEVER SIGNS ANYONE IN OR OUT: no session is created for the person, the GOM stays the GOM, and ordinary admin calls still work afterwards', async () => {
  const p = await person(u('sess')); const n0 = (await app.q('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?', [p.id]))[0].n; await as(p.id, '/me'); await as(p.id, '/my/summary?handle=all');
  assert.equal((await app.q('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?', [p.id]))[0].n, n0); assert.equal((await api('GET', '/api/admin/payments')).status, 200, 'still the GOM'); assert.equal((await api('GET', '/api/me')).json.account.isAdmin, true);
});

test('FRAMING: only an ADMIN opening /my.html?viewAs=… may have the page framed (by this site itself, for the People tab); everyone else and every other page stays unframeable', async () => {
  const csp = async (path, cookie) => (await fetch(`${app.base}${path}`, { headers: cookie ? { cookie } : {} })).headers.get('content-security-policy') || '';
  const j = await person(u('frm')); const jc = j.cookie;
  assert.match(await csp('/my.html?viewAs=1', admin), /frame-ancestors 'self'/, 'an admin viewing as someone');
  for (const [what, p, c] of [['a joiner', '/my.html?viewAs=1', jc], ['signed out', '/my.html?viewAs=1', null], ['an admin without viewAs', '/my.html', admin], ['an admin on another page', '/index.html?viewAs=1', admin], ['the admin page', '/admin.html?viewAs=1', admin]]) assert.match(await csp(p, c), /frame-ancestors 'none'/, what);
  assert.match(await csp('/my.html?viewAs=1', admin), /script-src 'self'/, 'the rest of the policy is unchanged');
});
