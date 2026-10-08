import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, claimAndSecure, joinerSession } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b) => app.api(m, p, b, admin);
const text = (p, sel = '#tabBody') => p.text(p.q(sel));
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'People')); return p; };
const link = (handle, via, daysAgo = 1) => app.q('UPDATE joiners SET linked_via = ?, linked_at = NOW(3) - INTERVAL ? DAY WHERE instagram_handle = ?', [via, daysAgo, handle]);
async function person(handle, via = 'self_new', daysAgo = 1) { const c = await joinerSession(app, `${handle}@x.com`, handle); await link(handle, via, daysAgo); return c; }

test('a quiet People tab says so in all three places', async () => {
  const p = await open();
  assert.match(text(p), /Handle requests.*Nothing waiting/s);
  assert.match(text(p), /Recently linked emails.*No emails linked in the last 14 days/s);
  assert.match(text(p), /Blocked and flagged handles.*Nobody is blocked or flagged/s);
  assert.ok(p.q('form[data-form="block"]'));
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('recently linked emails: who, which email, when, how, how many claims — and whether you have checked them', async () => {
  await person('link_amy', 'claim_device', 2); await person('link_bea', 'approved', 3); await person('link_cat', 'self_new', 1);
  await claimAndSecure(app, admin, 'link_amy', w.keyring);
  const p = await open();
  const amy = text(p, '[data-link="link_amy"]');
  assert.match(amy, /@link_amy ← link_amy@x\.com/);
  assert.match(amy, /\d\d\/\d\d\/\d{4}.*linked from the browser that made the claim.*1 claim/);
  assert.match(amy, /not checked/);
  assert.match(text(p, '[data-link="link_bea"]'), /approved by you.*0 claims/);
  assert.match(text(p, '[data-link="link_cat"]'), /added it themselves \(a new handle\)/);
  const order = p.qa('[data-link]').map((e) => e.dataset.link);
  assert.ok(order.indexOf('link_cat') < order.indexOf('link_amy') && order.indexOf('link_amy') < order.indexOf('link_bea'), 'newest first');
  p.close();
});

test('marking someone checked (and un-checking) is saved, shown, and filterable', async () => {
  await person('chk_dan');
  const p = await open();
  const row = () => p.q('[data-link="chk_dan"]');
  await p.click(p.byText('button', 'Mark checked', row()));
  assert.match(toast(p), /@chk_dan marked as checked/);
  assert.match(p.text(row()), /checked/); assert.doesNotMatch(p.text(row()), /not checked/);
  assert.equal((await app.q('SELECT verified_at IS NOT NULL AS v FROM joiners WHERE instagram_handle = ?', ['chk_dan']))[0].v, 1);
  await p.click(p.q('input[data-filter="only"]'));
  assert.equal(p.q('[data-link="chk_dan"]'), null, '"only the ones I haven\'t checked" hides it');
  await p.click(p.q('input[data-filter="only"]'));
  await p.click(p.byText('button', 'Un-check', row()));
  assert.match(toast(p), /@chk_dan un-checked/);
  assert.match(p.text(row()), /not checked/);
  p.close();
});

test('the time window filters older links in and out', async () => {
  await person('old_eve', 'self_new', 20);
  const p = await open();
  assert.equal(p.q('[data-link="old_eve"]'), null, 'linked 20 days ago: outside the default 14');
  await p.choose(p.q('select[data-filter="days"]'), '30');
  assert.ok(p.q('[data-link="old_eve"]'));
  await p.choose(p.q('select[data-filter="days"]'), '7');
  assert.equal(p.q('[data-link="old_eve"]'), null);
  assert.equal(p.q('select[data-filter="days"]').value, '7', 'the choice sticks');
  p.close();
});

test('blocking: needs a handle and a reason, explains exactly what it does, "Cancel" does nothing, confirming blocks and lists them with the reason', async () => {
  const p = await open();
  const form = () => p.q('form[data-form="block"]');
  await p.submit(form());
  assert.match(p.text(p.q('[data-msg]', form())), /Enter the Instagram handle to block/);
  p.fill(form(), { handle: '@Bad_Actor' }); await p.submit(form());
  assert.match(p.text(p.q('[data-msg]', form())), /Give a reason/);
  p.fill(form(), { reason: 'Never paid for the last GO' }); await p.submit(form());
  const d = p.text(modal(p));
  assert.match(d, /Block @Bad_Actor\?/);
  assert.match(d, /won't be able to place new orders.*won't be able to add them to a set.*existing orders carry on as normal/s);
  assert.match(d, /claims is cancelled, anything they'd paid towards it is kept \(recorded as forfeited\) rather than returned as credit.*unblock them at any time/s);
  await press(p, 'Cancel');
  assert.equal((await api('GET', '/api/admin/joiners/flagged')).json.joiners.some((j) => j.handle === 'bad_actor'), false, 'cancelling blocked nobody');
  await p.submit(form()); await press(p, 'Block them');
  assert.match(toast(p), /@bad_actor blocked/);
  const row = text(p, '[data-flag="bad_actor"]');
  assert.match(row, /@bad_actor.*blocked.*Reason: Never paid for the last GO.*Owes £0\.00 · Credit £0\.00 · Forfeited £0\.00 · 0 open claims/s);
  assert.equal(form().elements.handle.value, '', 'the form is cleared');
  const claim = await app.api('POST', '/api/claims', { handle: 'bad_actor', lines: [{ itemId: w.keyring }] }, undefined);
  assert.deepEqual([claim.status, claim.json.code], [403, 'handle_blocked'], 'and they really are blocked');
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('an invalid handle is explained by the server and nothing is blocked', async () => {
  const p = await open();
  const form = () => p.q('form[data-form="block"]');
  p.fill(form(), { handle: 'not a handle!', reason: 'x' }); await p.submit(form()); await press(p, 'Block them');
  assert.match(p.text(p.q('[data-msg]', form())), /not a valid Instagram handle/);
  p.close();
});

test('flagged people show what they owe, hold and have forfeited, and how many claims are still open', async () => {
  await person('flag_fay');
  await claimAndSecure(app, admin, 'flag_fay', w.keyring); await claimAndSecure(app, admin, 'flag_fay', w.keyring);   // owes for two keyrings
  await api('POST', '/api/admin/joiners/block', { handle: 'flag_fay', reason: 'chargeback' });
  let p = await open();
  assert.match(text(p, '[data-flag="flag_fay"]'), /Reason: chargeback.*Owes £12\.00 · Credit £0\.00 · Forfeited £0\.00 · 2 open claims/s);
  p.close();
  await api('POST', '/api/admin/credit/add', { handle: 'flag_fay', amount: 50, reason: 'goodwill' });                // covers what is owed; the rest is held
  p = await open();
  assert.match(text(p, '[data-flag="flag_fay"]'), /Owes £0\.00 · Credit £38\.00 · Forfeited £0\.00 · 2 open claims/);
  p.close();
});

test('unblocking: asks first, says what it does not undo, then lets them order again', async () => {
  await api('POST', '/api/admin/joiners/block', { handle: 'unblock_gus', reason: 'mistake' });
  const p = await open();
  await p.click(p.byText('button', 'Unblock', p.q('[data-flag="unblock_gus"]')));
  assert.match(text(p, '.ui-modal'), /Unblock @unblock_gus\?.*place orders again.*already recorded as forfeited stays forfeited.*Payments → Credit and tips/s);
  await press(p, 'Keep blocked');
  assert.ok(p.q('[data-flag="unblock_gus"]'));
  await p.click(p.byText('button', 'Unblock', p.q('[data-flag="unblock_gus"]'))); await press(p, 'Unblock');
  assert.match(toast(p), /@unblock_gus unblocked/);
  assert.equal(p.q('[data-flag="unblock_gus"]'), null);
  assert.equal((await app.api('POST', '/api/claims', { handle: 'unblock_gus', lines: [{ itemId: w.keyring }] }, undefined)).status, 201);
  p.close();
});

test('someone who deleted their account is flagged with the date, even though they are not blocked', async () => {
  const c = await person('gone_hal');
  await claimAndSecure(app, admin, 'gone_hal', w.keyring);
  assert.equal((await app.api('DELETE', '/api/me', { confirm: true }, c)).status, 200);
  const p = await open();
  const row = text(p, '[data-flag="gone_hal"]');
  assert.match(row, /@gone_hal.*deleted their account \d\d\/\d\d\/\d{4}.*1 open claim/s);
  assert.doesNotMatch(row, /blocked/);
  assert.equal(p.q('button[data-act="unblock"]', p.q('[data-flag="gone_hal"]')), null, 'nothing to unblock');
  p.close();
});

test('handle requests still work from the same tab', async () => {
  // someone from another browser asks to link a handle that already has orders
  await app.api('POST', '/api/claims', { handle: 'req_ivy', lines: [{ itemId: w.keyring }] }, undefined);
  const c = await app.login('req_ivy_new@x.com');
  const r = await app.api('POST', '/api/me/handles', { handle: 'req_ivy' }, c);
  assert.equal(r.status, 202);
  const p = await open();
  assert.match(text(p, '[data-req]'), /@req_ivy ← req_ivy_new@x\.com.*1 claim/);
  assert.equal(p.q('#tabs [data-tab="people"] .badge').textContent, '1');
  await p.click(p.byText('button', 'Approve'));
  assert.match(toast(p), /Approved/);
  assert.equal(p.q('[data-req]'), null);
  p.close();
});

test('handles, emails and reasons with HTML in them are shown as text', async () => {
  await person('xss_jon');
  await api('POST', '/api/admin/joiners/block', { handle: 'xss_kim', reason: '<img src=x onerror="window.pwned=1">' });
  const p = await open();
  assert.equal(p.q('#tabBody img'), null);
  assert.match(text(p, '[data-flag="xss_kim"]'), /Reason: <img src=x onerror="window\.pwned=1">/);
  assert.equal(p.window.pwned, undefined);
  p.close();
});
