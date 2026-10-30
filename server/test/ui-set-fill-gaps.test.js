import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// GOM: when cancelling a claim makes someone from a later set move up into the freed spot, the confirmation says who (otherwise it is exactly as before).
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'uf') => `${x}${++N}`;
const newSet = async () => { const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Fill UI GO '), proxy: 'Sam' })).json.id; return { go, item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: u('Fill UI set '), price: 4, members: ['A', 'B'] })).json.id }; };
const claim = (item, handle, members) => app.api('POST', '/api/claims', { handle, allowDuplicates: true, lines: [{ itemId: item, parts: members.map((m) => ({ member: m, qty: 1 })) }] });
const claimOf = async (handle, item) => (await app.q("SELECT c.id, c.label FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.item_id = ? AND c.status <> 'cancelled' ORDER BY c.id", [handle, item]))[0];
const claimsTab = async (handle) => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', 'Claims')); await sleep(150); await p.settle(); await p.type(p.q('[data-filter="q"]'), handle); await p.settle(); await p.click(p.q(`[data-buyer="${handle}"] [data-act="toggle"]`)); return p; };

test('CANCELLING FROM THE CLAIMS TAB TELLS YOU WHO MOVED UP: "@x moved up from Set 3 into Set 1." — a longer chain lists each move; the person\'s label changes', async () => {
  const { item } = await newSet(); const [a, b, c, d] = [u('fa'), u('fb'), u('fc'), u('fd')]; for (const [h, m] of [[a, ['A']], [b, ['B']], [c, ['A']], [d, ['A']]]) await claim(item, h, m);               // Set 1: A,B   Set 2: A   Set 3: A
  const p = await claimsTab(a); const mine = await claimOf(a, item); await p.click(p.q(`[data-act="cancel"][data-id="${mine.id}"]`)); await press(p, 'Yes, cancel it'); await sleep(450); await p.settle();
  assert.equal(toast(p), `Cancelled. @${c} moved up from Set 2 into Set 1; @${d} moved up from Set 3 into Set 2.`); assert.match((await claimOf(c, item)).label, /\(Set 1\)$/); assert.match((await claimOf(d, item)).label, /\(Set 2\)$/); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('WHEN NOBODY CAN MOVE UP THE MESSAGE IS EXACTLY AS BEFORE ("Cancelled."), and a paid claim still says what was returned as credit', async () => {
  const { item } = await newSet(); const [a, b] = [u('fa'), u('fb')]; await claim(item, a, ['A']); await claim(item, b, ['B']);
  const p = await claimsTab(a); const mine = await claimOf(a, item); await p.click(p.q(`[data-act="cancel"][data-id="${mine.id}"]`)); await press(p, 'Yes, cancel it'); await sleep(450); await p.settle(); assert.equal(toast(p), 'Cancelled.'); p.close();
  const { item: it2 } = await newSet(); const [x, y] = [u('fx'), u('fy')]; await claim(it2, x, ['A']); await claim(it2, y, ['A']); const cx = await claimOf(x, it2); await api('PATCH', `/api/admin/claims/${cx.id}`, { costs: { initials: { paid: 2 } } });
  const q = await claimsTab(x); await q.click(q.q(`[data-act="cancel"][data-id="${cx.id}"]`)); await press(q, 'Yes, cancel it'); await sleep(450); await q.settle(); assert.equal(toast(q), `Cancelled. £2.00 returned as credit. @${y} moved up from Set 2 into Set 1.`, 'credit and the move are both said'); q.close();
});

test('APPROVING A CANCEL REQUEST SAYS IT TOO', async () => {
  const { item } = await newSet(); const [a, b, c] = [u('fa'), u('fb'), u('fc')]; const cookie = await joinerSession(app, `${a}@x.com`, a); await claim(item, a, ['A']); await claim(item, b, ['B']); await claim(item, c, ['A']); const mine = await claimOf(a, item);
  assert.ok([200, 201].includes((await api('POST', `/api/my/claims/${mine.id}/cancel-request`, { reason: 'changed my mind' }, cookie)).status)); const reqs = (await api('GET', '/api/admin/cancel-requests')).json.requests; const pend = reqs.find((r) => r.claimId === mine.id || r.claim_id === mine.id);
  const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', 'Claims')); await sleep(200); await p.settle();
  const btn = p.q(`[data-act="cancel-approve"][data-id="${pend.id}"]`); assert.ok(btn, 'the request is on the Claims tab'); await p.click(btn); await sleep(200); await press(p, 'Approve cancellation');
  await sleep(450); await p.settle(); assert.match(toast(p), new RegExp(`@${c} moved up from Set 2 into Set 1\\.$`)); p.close();
});
