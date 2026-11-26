import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';

// PAUSING A SHIPPING REQUEST: the joiner parks an unpacked request (it leaves the queue, their items stay) and resumes it later — original place within 30 days, the end after that; one reminder after 30 days.
let app, admin, w, N = 0;
const READY = 'ready to pack / on hand';
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'pz') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Pause GO '), proxy: 'Sam' })).json.id;
async function person({ notify = false } = {}) { const h = u('pz'), email = `${h}@x.com`; const cookie = await joinerSession(app, email, h); await api('PUT', '/api/my/address', { fullName: 'Pause Person', address: '12 Test Street, Leeds, LS1 1AA', email, phone: '07700 900123' }, cookie); if (notify) await api('PUT', '/api/my/notifications', { enabled: true }, cookie); return { h, email, cookie, go: await goOrder() }; }
async function ready(p) { const it = (await api('POST', `/api/admin/orders/${p.go}/items`, { type: 'normal', title: u('Thing '), price: 5 })).json.id; const [id] = await claimAndSecure(app, admin, p.h, it); assert.equal((await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY })).status, 200); return id; }
const request = async (p, claimIds) => { const r = await api('POST', `/api/my/parcels?handle=${p.h}`, { claimIds, method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, p.cookie); assert.equal(r.status, 201, r.text); return r.json.id; };
const requestOne = async (p) => request(p, [await ready(p)]);
const mine = async (p, id) => (await api('GET', '/api/my/parcels', undefined, p.cookie)).json.parcels.find((x) => x.id === id);
const pause = (p, id, c = p.cookie) => api('POST', `/api/my/parcels/${id}/pause`, {}, c);
const resume = (p, id, c = p.cookie) => api('POST', `/api/my/parcels/${id}/resume`, {}, c);
const pausedFor = (id, days) => app.q('UPDATE parcels SET paused_at = NOW(3) - INTERVAL ? DAY WHERE id = ?', [days, id]);
const queue = async () => (await api('GET', '/api/admin/packing?status=requested')).json;

test('PAUSE: the request leaves the queue (no place, and the people behind it move up); its items stay; the joiner can still add items; the screen says what they can do', async () => {
  const a = await person(), b = await person(), c = await person(); const pa = await requestOne(a), pb = await requestOne(b), pc = await requestOne(c);
  assert.deepEqual([(await mine(a, pa)).queuePosition, (await mine(b, pb)).queuePosition, (await mine(c, pc)).queuePosition].map((n, i) => n - [0, 0, 0][i] > 0), [true, true, true]); const posB = (await mine(b, pb)).queuePosition, posC = (await mine(c, pc)).queuePosition;
  const items = (await mine(a, pa)).items.length; assert.equal((await pause(a, pa)).status, 200); const m = await mine(a, pa);
  assert.deepEqual([m.paused, m.queuePosition, m.canPause, m.canResume, m.canAddItems, m.status, m.pausedDays, m.resumeKeepsPlace], [true, null, false, true, true, 'requested', 0, true]); assert.ok(m.pausedAt); assert.equal(m.items.length, items, 'its items are still on it');
  assert.deepEqual([(await mine(b, pb)).queuePosition, (await mine(c, pc)).queuePosition], [posB - 1, posC - 1], 'the people behind it move up'); const extra = await ready(a); const add = await api('POST', `/api/my/parcels/${pa}/items`, { claimIds: [extra] }, a.cookie); assert.equal(add.status, 201, add.text); assert.equal(add.json.queuePosition, null, 'and the reply doesn\'t claim a place in the queue'); assert.equal((await mine(a, pa)).items.length, items + 1, 'items can still be added while it is paused');
});

test('RESUME KEEPS ITS ORIGINAL PLACE when it was paused for under 30 days (even 29), and goes to the END at 30 days or more', async () => {
  const a = await person(), b = await person(), c = await person(); const pa = await requestOne(a), pb = await requestOne(b), pc = await requestOne(c); const reqAt = async (id) => String((await app.q('SELECT requested_at AS r FROM parcels WHERE id = ?', [id]))[0].r);
  const base = (await mine(a, pa)).queuePosition; assert.equal((await pause(a, pa)).status, 200); const r0 = await reqAt(pa); const quick = await resume(a, pa); assert.deepEqual([quick.status, quick.json.keptPlace, quick.json.queuePosition], [200, true, base], 'straight back: the same place'); assert.equal(await reqAt(pa), r0, 'requested_at untouched');
  await pause(a, pa); await pausedFor(pa, 29); const day29 = await resume(a, pa); assert.deepEqual([day29.json.keptPlace, day29.json.queuePosition], [true, base], '29 days: still its place'); assert.equal(await reqAt(pa), r0);
  await pause(a, pa); await pausedFor(pa, 30); const m = await mine(a, pa); assert.deepEqual([m.pausedDays, m.resumeKeepsPlace], [30, false], 'the screen knows it is now 30 days'); const day30 = await resume(a, pa); assert.equal(day30.json.keptPlace, false); assert.ok(await reqAt(pa) > r0, 'a fresh place in the queue');
  const total = (await queue()).parcels.length; assert.equal(day30.json.queuePosition, total, 'the end of the queue'); const order = (await queue()).parcels.map((x) => x.id); assert.ok(order.indexOf(pb) < order.indexOf(pa) && order.indexOf(pc) < order.indexOf(pa), 'behind the people who were behind it');
});

test('WHO CAN PAUSE AND WHEN: only the person it is posted to (a friend who joined it is told no; a stranger finds no such parcel); not once packed or cancelled; not twice; resume only if paused; signed out is refused', async () => {
  const a = await person(), friend = await person(), stranger = await person(); const pa = await requestOne(a); const jid = async (p) => (await app.q('SELECT id FROM joiners WHERE instagram_handle = ?', [p.h]))[0].id;
  await app.q("INSERT INTO parcel_companions (parcel_id, joiner_id, status, how) VALUES (?, ?, 'accepted', 'joiner')", [pa, await jid(friend)]);
  const f = await pause(friend, pa); assert.equal(f.status, 403); assert.match(f.json.error, /Only the person this parcel is being posted to can pause or resume it\./); assert.equal((await pause(stranger, pa)).status, 404); assert.equal((await app.api('POST', `/api/my/parcels/${pa}/pause`, {})).status, 401); assert.equal((await mine(a, pa)).paused, false, 'nobody else changed it');
  assert.equal((await resume(a, pa)).json.code, 'not_not_paused'.replace('not_not_paused', 'not_paused'), 'resume needs it to be paused'); assert.equal((await pause(a, pa)).status, 200); const twice = await pause(a, pa); assert.deepEqual([twice.status, twice.json.code], [409, 'already_paused']);
  assert.equal((await resume(friend, pa)).status, 403, 'a friend can\'t resume it either'); assert.equal((await mine(a, pa)).paused, true);
  for (const st of ['packed', 'cancelled']) { const q = await person(); const id = await requestOne(q); await app.q('UPDATE parcels SET status = ? WHERE id = ?', [st, id]); const r = await pause(q, id); assert.deepEqual([r.status, r.json.code], [409, 'parcel_not_open'], st); assert.match(r.json.error, st === 'cancelled' ? /was cancelled, so it can't be paused/ : /already been packed, so it can't be paused/, st); }
  assert.ok((await app.q("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('parcel.pause', 'parcel.resume')"))[0].n >= 1, 'recorded');
});

test('YOUR PACKING TAB: the Queue leaves out paused requests, a "paused" list shows them (with days), they can\'t be marked packed, can\'t be combined, and don\'t count as queue places', async () => {
  const a = await person(), b = await person(), c = await person(); const pa = await requestOne(a), pb = await requestOne(b); await requestOne(c); assert.equal((await pause(a, pa)).status, 200);
  const q = await queue(); assert.equal(q.parcels.some((x) => x.id === pa), false, 'not in the Queue'); assert.ok(q.parcels.some((x) => x.id === pb)); assert.ok(q.pausedCount >= 1, 'and the count of paused requests is given'); const pq = (await api('GET', '/api/admin/packing?status=paused')).json; const paused = pq.parcels.find((x) => x.id === pa);
  assert.ok(paused, 'listed under Paused'); assert.deepEqual([paused.paused, paused.queuePosition, paused.pausedDays, paused.handle], [true, null, 0, a.h]); assert.equal(pq.parcels.some((x) => x.paused === false), false, 'only paused ones are in it'); assert.equal(q.parcels.every((x) => x.paused === false && x.queuePosition > 0), true);
  const search = (await api('GET', `/api/admin/packing?q=${pa}`)).json.parcels.find((x) => x.id === pa); assert.deepEqual([search.paused, search.queuePosition], [true, null], 'a search still finds it, marked paused');
  const packed = await api('POST', `/api/admin/parcels/${pa}/packed`, {}); assert.deepEqual([packed.status, packed.json.code], [409, 'paused']); assert.match(packed.json.error, /is paused — they're waiting for more items — so it can't be packed until they resume it\./);
  const cands = (await api('GET', `/api/admin/parcels/${pb}/combine-candidates`)).json; assert.equal(JSON.stringify(cands).includes(`"id":${pa}`), false, 'not offered as something to combine'); const comb = await api('POST', `/api/admin/parcels/${pb}/combine`, { withParcelId: pa, confirmed: true }); assert.deepEqual([comb.status, comb.json.code], [409, 'paused']);
  assert.equal((await resume(a, pa)).status, 200); assert.ok((await queue()).parcels.some((x) => x.id === pa), 'back in the Queue once resumed');
});

test('"MORE OF YOUR ITEMS HAVE ARRIVED" STILL REACHES SOMEONE WITH A PAUSED REQUEST (they are the people who are waiting for more items)', async () => {
  const p = await person({ notify: true }); const pa = await requestOne(p); await pause(p, pa); await ready(p); await sleep(250); await app.notifier.idle(); await sleep(50); await app.notifier.idle();
  assert.equal(app.mailer.outbox.filter((m) => m.to === p.email && /More of your items have arrived/.test(m.subject)).length, 1);
});

test('THE REMINDER: one email after 30 days paused — resuming now goes to the end of the queue, no rush, link to the shipping page; not before 30 days, not twice, not once resumed or packed, not without emails or with the kind off; paused again = a new reminder', async () => {
  const mails = (p) => app.mailer.outbox.filter((m) => m.to === p.email && /still paused/.test(m.subject));
  const p = await person({ notify: true }); const pa = await requestOne(p); await pause(p, pa); await pausedFor(pa, 29); let r = await app.notifier.sendPauseReminders(); await app.notifier.idle(); assert.equal(mails(p).length, 0, '29 days: not yet'); // exactly 30 days is when it goes out
  await pausedFor(pa, 30); r = await app.notifier.sendPauseReminders(); await app.notifier.idle(); assert.equal(mails(p).length, 1); const m = mails(p)[0]; assert.equal(m.subject, `Your shipping request is still paused (@${p.h})`);
  assert.match(m.text, new RegExp(`^Hi @${p.h},\\n\\nYour shipping request \\(parcel #${pa}\\) has been paused for 30 days\\.\\n\\nWhen you're ready, you can resume it from your shipping page: .*/my\\.html#/ship\\n\\nA paused request keeps its place in the queue for 30 days\\. It has now been longer than that, so if you resume it now it will join the end of the queue\\.\\n\\nIf you're still waiting for more items there's no rush`)); assert.ok(r.emails >= 1);
  await app.notifier.sendPauseReminders(); await app.notifier.idle(); assert.equal(mails(p).length, 1, 'only ever one'); assert.ok((await app.q('SELECT pause_reminded_at AS r FROM parcels WHERE id = ?', [pa]))[0].r, 'recorded');
  assert.equal((await resume(p, pa)).status, 200); assert.equal((await app.q('SELECT pause_reminded_at AS r FROM parcels WHERE id = ?', [pa]))[0].r, null, 'resuming clears it'); await pause(p, pa); await pausedFor(pa, 40); await app.notifier.sendPauseReminders(); await app.notifier.idle(); assert.equal(mails(p).length, 2, 'paused AGAIN and left: a new reminder');
  const resumed = await person({ notify: true }); const rid = await requestOne(resumed); await pause(resumed, rid); await pausedFor(rid, 45); await resume(resumed, rid); await app.notifier.sendPauseReminders(); await app.notifier.idle(); assert.equal(mails(resumed).length, 0, 'resumed: nothing to remind');
  const packed = await person({ notify: true }); const kid = await requestOne(packed); await pause(packed, kid); await pausedFor(kid, 45); await app.q("UPDATE parcels SET status = 'packed' WHERE id = ?", [kid]); await app.notifier.sendPauseReminders(); await app.notifier.idle(); assert.equal(mails(packed).length, 0, 'packed: no');
  const off = await person({ notify: false }); const oid = await requestOne(off); await pause(off, oid); await pausedFor(oid, 45); await app.notifier.sendPauseReminders(); await app.notifier.idle(); assert.equal(mails(off).length, 0, 'emails not turned on');
  const kind = await person({ notify: true }); await api('PUT', '/api/my/notifications', { events: { pauseReminder: false } }, kind.cookie); const kid2 = await requestOne(kind); await pause(kind, kid2); await pausedFor(kid2, 45); await app.notifier.sendPauseReminders(); await app.notifier.idle(); assert.equal(mails(kind).length, 0, 'this kind switched off');
});

test('STRUCTURE: the reminder runs on the same timer as the overdue reminders', () => {
  const src = require_fs('../src/index.js'); assert.match(src, /sendPauseReminders\(\)/);
});
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
function require_fs(rel) { return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), rel), 'utf8'); }
