import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';

let app, admin, w;
before(async () => {
  app = await startApp();
  admin = await app.adminLogin();
  w = await seed(app, admin);
});
after(async () => { await app.stop(); });

test('a brand-new handle links straight away (nothing is at stake)', async () => {
  const c = await app.login('amy@example.com');
  const r = await app.api('POST', '/api/me/handles', { handle: '@Amy_Fan' }, c);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'linked');
  assert.equal(r.json.handle, 'amy_fan', 'normalised: no @, lower-case');
  assert.deepEqual((await app.api('GET', '/api/me', undefined, c)).json.handles.map((h) => h.handle), ['amy_fan']);
});

test('invalid handles are refused', async () => {
  const c = await app.login('badhandle@example.com');
  for (const h of ['has space', 'a'.repeat(31), 'no/slash', '', '😀']) {
    assert.equal((await app.api('POST', '/api/me/handles', { handle: h }, c)).status, 400, `rejected: ${JSON.stringify(h)}`);
  }
});

test('linking the same handle again is harmless', async () => {
  const c = await app.login('again@example.com');
  await app.api('POST', '/api/me/handles', { handle: 'again_h' }, c);
  const r = await app.api('POST', '/api/me/handles', { handle: 'again_h' }, c);
  assert.equal(r.json.status, 'already_linked');
});

test('a handle already linked to someone else cannot be taken', async () => {
  const a = await app.login('owner@example.com');
  await app.api('POST', '/api/me/handles', { handle: 'owned_h' }, a);
  const b = await app.login('thief@example.com');
  const r = await app.api('POST', '/api/me/handles', { handle: 'owned_h' }, b);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'handle_taken');
});

test('a handle that already has orders needs the GOM to say yes — and sees nothing until then', async () => {
  // Someone claims as @claimed_h without ever signing in.
  const claim = await app.api('POST', '/api/claims', { handle: 'claimed_h', lines: [{ itemId: w.keyring }] });
  assert.equal(claim.status, 201);

  // A different person signs in and says "that's me".
  const imposter = await app.login('imposter@example.com');
  const r = await app.api('POST', '/api/me/handles', { handle: 'claimed_h' }, imposter);
  assert.equal(r.status, 202);
  assert.equal(r.json.status, 'pending_approval');

  // Until approved they can see NOTHING of that handle's orders.
  const sum = await app.api('GET', '/api/my/summary', undefined, imposter);
  assert.equal(sum.status, 403);
  assert.equal(sum.json.code, 'no_handle');
  assert.equal((await app.api('GET', '/api/my/address', undefined, imposter)).status, 403);
  assert.equal((await app.api('GET', '/api/my/parcels', undefined, imposter)).status, 403);

  // The GOM sees the request, with how much is at stake.
  const list = await app.api('GET', '/api/admin/handle-requests', undefined, admin);
  const req = list.json.requests.find((x) => x.handle === 'claimed_h');
  assert.equal(req.email, 'imposter@example.com');
  assert.equal(req.claims, 1);

  // Declined: still nothing.
  assert.equal((await app.api('POST', `/api/admin/handle-requests/${req.id}/decline`, {}, admin)).status, 200);
  assert.equal((await app.api('GET', '/api/my/summary', undefined, imposter)).status, 403);

  // The real owner asks; the GOM approves; now they see their order.
  const real = await app.login('real.owner@example.com');
  await app.api('POST', '/api/me/handles', { handle: 'claimed_h' }, real);
  const req2 = (await app.api('GET', '/api/admin/handle-requests', undefined, admin)).json.requests.find((x) => x.handle === 'claimed_h');
  assert.equal((await app.api('POST', `/api/admin/handle-requests/${req2.id}/approve`, {}, admin)).status, 200);
  const mine = await app.api('GET', '/api/my/summary', undefined, real);
  assert.equal(mine.status, 200);
  assert.equal(mine.json.handle, 'claimed_h');
  assert.equal(mine.json.orders[0].claims[0].label, 'Keyring');
});

test('two people asking for one handle: approving one settles it', async () => {
  await app.api('POST', '/api/claims', { handle: 'contested_h', lines: [{ itemId: w.keyring }] });
  const a = await app.login('contest.a@example.com');
  const b = await app.login('contest.b@example.com');
  await app.api('POST', '/api/me/handles', { handle: 'contested_h' }, a);
  await app.api('POST', '/api/me/handles', { handle: 'contested_h' }, b);
  const pending = (await app.api('GET', '/api/admin/handle-requests', undefined, admin)).json.requests.filter((x) => x.handle === 'contested_h');
  assert.equal(pending.length, 2);
  assert.equal((await app.api('POST', `/api/admin/handle-requests/${pending[0].id}/approve`, {}, admin)).status, 200);
  assert.equal((await app.api('POST', `/api/admin/handle-requests/${pending[1].id}/approve`, {}, admin)).status, 404, 'the other request was closed automatically');
  assert.equal((await app.api('GET', '/api/my/summary', undefined, b)).status, 403);
});

test('only the GOM can approve', async () => {
  const c = await app.login('sneaky@example.com');
  assert.equal((await app.api('POST', '/api/admin/handle-requests/1/approve', {}, c)).status, 403);
  assert.equal((await app.api('GET', '/api/admin/handle-requests', undefined, c)).status, 403);
});

test('you cannot act as a handle that is not yours', async () => {
  const a = await app.login('actor.a@example.com');
  await app.api('POST', '/api/me/handles', { handle: 'actor_a' }, a);
  const b = await app.login('actor.b@example.com');
  await app.api('POST', '/api/me/handles', { handle: 'actor_b' }, b);
  assert.equal((await app.api('GET', '/api/my/summary?handle=actor_a', undefined, b)).status, 403);
  assert.equal((await app.api('GET', '/api/my/summary?handle=actor_b', undefined, b)).status, 200);
});

test('a person with two handles must say which one', async () => {
  const c = await app.login('two.handles@example.com');
  await app.api('POST', '/api/me/handles', { handle: 'two_h1' }, c);
  await app.api('POST', '/api/me/handles', { handle: 'two_h2' }, c);
  const r = await app.api('GET', '/api/my/summary', undefined, c);
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'handle_required');
  assert.equal((await app.api('GET', '/api/my/summary?handle=two_h2', undefined, c)).json.handle, 'two_h2');
});

test('the GOM can detach a handle from an account', async () => {
  const c = await app.login('detach@example.com');
  const linked = await app.api('POST', '/api/me/handles', { handle: 'detach_h' }, c);
  assert.equal((await app.api('DELETE', `/api/admin/joiners/${linked.json.joinerId}/account`, undefined, admin)).status, 200);
  assert.equal((await app.api('GET', '/api/my/summary', undefined, c)).status, 403);
});
