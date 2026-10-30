import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { gomPage, toast, modal, press } from './ui.helpers.js';

// GOM → Sets → "Fill gaps…": previews who would move up into every open spot (and says which are secured straight away), then moves them on confirmation.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'uf') => `${x}${++N}`;
const newSet = async (title = u('Fill UI set '), members = ['A', 'B']) => { const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: `Fill UI GO ${++N}`, proxy: 'Sam' })).json.id; return { go, item: (await api('POST', `/api/admin/orders/${go}/items`, { type: 'set', title, price: 4, members })).json.id }; };
const claim = async (item, handle, members) => { const r = await app.api('POST', '/api/claims', { handle, allowDuplicates: true, lines: [{ itemId: item, parts: members.map((m) => ({ member: m, qty: 1 })) }] }); assert.ok([200, 201].includes(r.status), r.text); };
const shape = async (item) => (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item).sort((a, b) => a.number - b.number).map((s) => `${s.number}:${s.parts.filter((p) => p.handle).map((p) => `${p.member}=${p.handle}`).join(',')}`).join(' | ');
const strand = async (handle, item) => { const [c] = await app.q("SELECT c.id, c.slot_id AS slot FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.item_id = ? AND c.status <> 'cancelled' ORDER BY c.id", [handle, item]); await app.q("UPDATE claims SET status = 'cancelled', slot_id = NULL WHERE id = ?", [c.id]); await app.q('DELETE FROM set_slots WHERE id = ?', [c.slot]); };
const clean = async () => { await api('POST', '/api/admin/sets/fill-gaps', {}); };                                          // start each test with no other gaps around
const setsTab = async () => { const p = await gomPage(app, admin); await sleep(100); await p.settle(); await p.click(p.byText('#tabs button', 'Sets')); await sleep(300); await p.settle(); return p; };
const fillBtn = (p) => p.q('[data-act="fill-gaps"]');

test('THE BUTTON IS AT THE TOP OF THE SETS TAB', async () => {
  await clean(); const p = await setsTab(); assert.ok(fillBtn(p)); assert.equal(p.text(fillBtn(p)), 'Fill gaps…'); assert.match(p.text(fillBtn(p).parentElement), /Moves people up from later sets into spots that are open now\./); assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('PREVIEW THEN CONFIRM: the dialog names the item, each person, the member and the sets they move between (and which are secured straight away); "Not yet" changes nothing; "Move them up" does it and says how many', async () => {
  await clean(); const { item } = await newSet('Preview photocards'); const h = Array.from({ length: 5 }, () => u('pv')); for (const [i, m] of [['A'], ['B'], ['A'], ['B'], ['A']].entries()) await claim(item, h[i], m);                    // Set 1: A,B  Set 2: A,B  Set 3: A
  const sets = (await api('GET', '/api/admin/sets')).json.sets.filter((s) => s.itemId === item).sort((a, b) => a.number - b.number); await api('POST', `/api/admin/sets/${sets[0].id}/secure`, {}); await strand(h[0], item);                // a gap in the SECURED Set 1
  const before = await shape(item); const p = await setsTab(); await p.click(fillBtn(p)); await sleep(300);
  const t = p.text(modal(p)); assert.match(t, /^Move 2 people up\?/); assert.match(t, /Preview photocards — Fill UI GO \d+/); assert.match(t, new RegExp(`• @${h[2]} — A: Set 2 → Set 1 \\(secured straight away\\)`)); assert.match(t, new RegExp(`• @${h[4]} — A: Set 3 → Set 2(?! \\(secured)`)); assert.match(t, /They aren't emailed\. Anyone moved into a secured set is secured straight away\.\s*Not yetMove them up$/);
  await press(p, 'Not yet'); await sleep(200); assert.equal(await shape(item), before, 'Not yet: nothing moved'); await p.click(fillBtn(p)); await sleep(300); await press(p, 'Move them up'); await sleep(500); await p.settle();
  assert.equal(toast(p), 'Moved 2 people up.'); assert.equal(await shape(item), `1:A=${h[2]},B=${h[1]} | 2:A=${h[4]},B=${h[3]} | 3:`); assert.equal((await app.q("SELECT status FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.item_id = ? AND c.status <> 'cancelled'", [h[2], item]))[0].status, 'confirmed'); p.close();
});

test('WHEN THERE IS NOTHING TO FILL you are told why, plainly; one person reads "1 person"', async () => {
  await clean(); const p = await setsTab(); await p.click(fillBtn(p)); await sleep(300); assert.match(p.text(modal(p)), /^No gaps can be filled right now\. Nobody is waiting in a later set for an open spot — or the people who are have asked to stay together, are fixed claimers, or are waiting on a cancel request\.OK$/); await press(p, 'OK'); p.close();
  const { item } = await newSet(); const [a, b, c] = [u(), u(), u()]; await claim(item, a, ['A']); await claim(item, b, ['B']); await claim(item, c, ['A']); await strand(a, item); const q = await setsTab(); await q.click(fillBtn(q)); await sleep(300); assert.match(q.text(modal(q)), /^Move 1 person up\?/); await press(q, 'Move them up'); await sleep(500); await q.settle(); assert.equal(toast(q), 'Moved 1 person up.'); q.close();
});

test('IF THINGS CHANGED between the preview and your confirmation you are told "Nothing needed moving any more."', async () => {
  await clean(); const { item } = await newSet(); const [a, b, c] = [u(), u(), u()]; await claim(item, a, ['A']); await claim(item, b, ['B']); await claim(item, c, ['A']); await strand(a, item); const p = await setsTab(); await p.click(fillBtn(p)); await sleep(300); assert.ok(modal(p));
  await api('POST', '/api/admin/sets/fill-gaps', {}); await press(p, 'Move them up'); await sleep(500); await p.settle(); assert.equal(toast(p), 'Nothing needed moving any more.'); p.close();
});

test('A LONG LIST IS SHORTENED ("…and N more lines") and item titles with HTML are shown as text', async () => {
  await clean(); const hs = []; for (let i = 0; i < 6; i++) { const { item } = await newSet(i === 0 ? '<img src=x onerror="window.pwned=1"> Big set' : u('Many set '), ['A', 'B', 'C', 'D']); const mem = ['A', 'B', 'C', 'D'];
    for (let set = 0; set < 3; set++) for (const m of mem) { const h = u('lg'); await claim(item, h, [m]); hs.push([item, h, set, m]); } for (const [it, h, set] of hs.filter((x) => x[0] === item && x[2] === 0)) await strand(h, it); }
  const p = await setsTab(); await p.click(fillBtn(p)); await sleep(400); const t = p.text(modal(p)); assert.match(t, /^Move \d+ people up\?/); assert.match(t, /…and \d+ more lines?/); assert.equal(p.q('img[src="x"]', modal(p)), null); assert.equal(p.window.pwned, undefined); assert.ok(t.includes('<img src=x onerror="window.pwned=1"> Big set — Fill UI GO'));
  await press(p, 'Not yet'); p.close();
});
