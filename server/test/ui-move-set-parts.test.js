import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// GOM → Claims → "Move to another person…": set parts and fixed claims can be moved (a mistyped handle); the preview says they keep their place in their sets.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'umv') => `${x}${++N}`;
const btn = (p, re, root) => p.qa('button', root).find((b) => re.test(p.text(b)));
const text = (p, sel) => p.text(p.q(sel));
async function setup({ fixed = false } = {}) {
  const t = u('Move set GO '); const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: t, proxy: 'Sam' })).json.id; const items = [];
  for (const day of ['Day 3', 'Day 4']) items.push((await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: `${t} ${day}`, price: 6, members: ['Hyunjin', 'Han', 'Felix'] })).json.id);
  const wrong = u('bethan.overtn'), right = u('bethan.overton'); await joinerSession(app, `${right}@x.com`, right);
  for (const [i, it] of items.entries()) await app.api('POST', '/api/claims', { handle: wrong, lines: [{ itemId: it, parts: i ? [{ member: 'Han', qty: 1 }, { member: 'Felix', qty: 1 }, { member: 'Hyunjin', qty: 1 }] : [{ member: 'Hyunjin', qty: 1 }, { member: 'Han', qty: 1 }], together: true }] });
  if (fixed) assert.equal((await api('POST', `/api/admin/items/${items[0]}/fixed`, { handle: wrong, member: 'Felix' })).status, 201);
  for (const it of items) for (const s of (await api('GET', '/api/admin/sets')).json.sets.filter((x) => x.itemId === it && x.decision !== 'secured')) await api('POST', `/api/admin/sets/${s.id}/secure`, {});
  return { t, items, wrong, right };
}
async function open(wrong) {
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Claims')); await p.type(p.q('[data-filter="q"]'), wrong); await p.settle();
  await p.click(btn(p, /^Select all \d+ confirmed claims? here/)); await p.click(btn(p, /^Move to another person/)); return p;
}
const check = async (p, handle) => { p.q('#moveHandle').value = handle; await p.click(btn(p, /^Check$/)); await sleep(300); await p.settle(); };

test('YOUR SCENARIO: a mistyped handle with parts across several sets — all of them "can move", the panel says set parts keep their place in their sets, and moving puts them all on the right handle', async () => {
  const { items, wrong, right } = await setup(); const p = await open(wrong); assert.match(text(p, '#movePanel'), /^Move the 5 selected claims to another person/); await check(p, right);
  assert.match(text(p, '[data-move-preview]'), /5 can move/); assert.doesNotMatch(text(p, '[data-move-preview]'), /can't\b/); assert.equal(text(p, '[data-move-sets]'), '5 are parts of a member set — they keep their place in the set.'); assert.equal(btn(p, /^Move 5 claims to/).disabled, false);
  await p.click(btn(p, /^Move 5 claims to/)); assert.match(p.text(modal(p)), new RegExp(`^Move 5 claims to @${right}\\?`)); await press(p, 'Move them'); await sleep(500); await p.settle(); assert.equal(toast(p), `Moved 5 claims to @${right}.`);
  assert.deepEqual([(await app.q("SELECT COUNT(*) AS n FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.status <> 'cancelled'", [wrong]))[0].n, (await app.q("SELECT COUNT(*) AS n FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.status <> 'cancelled'", [right]))[0].n], [0, 5]);
  const sets = (await api('GET', '/api/admin/sets')).json.sets.filter((s) => items.includes(s.itemId)); assert.ok(sets.every((s) => s.parts.every((q) => q.handle !== wrong)), 'the Sets tab no longer shows the wrong handle'); assert.ok(sets.some((s) => s.parts.some((q) => q.handle === right)));
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('A FIXED CLAIM IS MENTIONED: "1 is a fixed claim, which stays fixed"; one set part reads in the singular', async () => {
  const { wrong, right } = await setup({ fixed: true }); const p = await open(wrong); await check(p, right); assert.match(text(p, '[data-move-sets]'), /^6 are parts of a member set — they keep their place in the set \(1 is a fixed claim, which stays fixed\)\.$/); p.close();
  const solo = u('solo.wrong'), solo2 = u('solo.right'); await joinerSession(app, `${solo2}@x.com`, solo2); const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Solo GO '), proxy: 'Sam' })).json.id; const it = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title: u('Solo set '), price: 4, members: ['A', 'B'] })).json.id;
  await app.api('POST', '/api/claims', { handle: solo, lines: [{ itemId: it, parts: [{ member: 'A', qty: 1 }, { member: 'B', qty: 1 }], together: true }] }); for (const s of (await api('GET', '/api/admin/sets')).json.sets.filter((x) => x.itemId === it)) await api('POST', `/api/admin/sets/${s.id}/secure`, {});
  const q = await gomPage(app, admin); await q.click(q.byText('#tabs button', 'Claims')); await q.type(q.q('[data-filter="q"]'), solo); await q.settle(); await q.click(q.qa('[data-act="pick"]')[0]); await q.click(btn(q, /^Move to another person/)); await check(q, solo2);
  assert.equal(text(q, '[data-move-sets]'), '1 is a part of a member set — it keeps its place in the set.'); q.close();
});

test('ORDINARY CLAIMS SHOW NO SET SENTENCE (nothing changes for them)', async () => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Plain GO ') })).json.id; const it = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: u('Plain item '), price: 5 })).json.id; const from = u('pl.wrong'), to = u('pl.right'); await joinerSession(app, `${to}@x.com`, to);
  await joinerSession(app, `${from}@x.com`, from); const { claimAndSecure } = await import('./helpers.js'); await claimAndSecure(app, admin, from, it); const p = await open(from); await check(p, to); assert.ok(text(p, '[data-move-preview]').includes('1 can move')); assert.equal(p.q('[data-move-sets]'), null); p.close();
});
