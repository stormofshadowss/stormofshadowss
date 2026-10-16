import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { openPage } from './ui.helpers.js';

// The Shop (on hand) page: artist avatars like the home page that FILTER IN PLACE — tap an artist for just their items, tap again (or "All") to clear; unassigned items are under "Other".
let app, admin, w, N = 0, G;
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const group = async (name) => (await api('POST', '/api/admin/groups', { name })).json.id;
const item = async (title, groupId) => (await api('POST', '/api/admin/shop', { title, price: 3, qty: 4, ...(groupId ? { groupId } : {}) })).json.id;
before(async () => {
  app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin);
  G = { ateez: await group('Ateez Test'), sk: await group('Stray Kids Test'), none: await group('Empty Crew'), hidden: await group('Secret Crew') };
  await app.q('UPDATE artist_groups SET sort_order = 800 WHERE id = ?', [G.ateez]); await app.q('UPDATE artist_groups SET sort_order = 801 WHERE id = ?', [G.sk]);
  G.items = { a1: await item('Ateez Lip Cards', G.ateez), a2: await item('Ateez ID Backs', G.ateez), s1: await item('Skz Sticker Backs', G.sk), o1: await item('Loose Photocard'), o2: await item('Another Loose Thing'), h1: await item('Secret Thing', G.hidden) };
  await app.q('UPDATE artist_groups SET is_hidden = 1 WHERE id = ?', [G.hidden]);
});
after(async () => { await app.stop(); });
const shop = async () => { const p = await openPage(app, '/#/shop'); await sleep(250); await p.settle(); return p; };
const shown = (p) => p.qa('[data-shop-item] strong').map((x) => p.text(x)).sort();
const avatars = (p) => p.qa('#shopArtists .avatar-link');
const av = (p, key) => p.q(`#shopArtists [data-g="${key}"]`);
const label = (p, a) => p.text(a);

test('THE AVATAR ROW: "All" and each artist that has something on the shelf (home page order, with how many items), then "Other" — "All" starts selected and everything is shown', async () => {
  const p = await shop(); const row = avatars(p).map((a) => label(p, a)); assert.deepEqual(row.slice(0, 3), ['All6 items', 'Ateez Test2 items', 'Stray Kids Test1 item'], 'All, then the artists in the home page order');
  assert.equal(row.at(-1), 'Other3 items', 'items with no artist — and the hidden artist\'s — are under Other'); assert.ok(!row.some((r) => /Empty Crew|Secret Crew/.test(r)), 'no avatar for an artist with nothing, or a hidden one');
  assert.deepEqual(avatars(p).map((a) => a.getAttribute('aria-pressed')), ['true', 'false', 'false', 'false']); assert.equal(shown(p).length, 6); assert.ok(avatars(p).every((a) => a.tagName === 'BUTTON' && a.type === 'button'));
  assert.ok(p.q('.ph[data-i="AT"]', av(p, G.ateez)), 'no picture: their initials, like the home page'); assert.deepEqual([p.errors], [[]]); p.close();
});

test('TAP AN ARTIST TO FILTER IN PLACE; tap it again to clear; "All" clears; tapping another switches straight to it', async () => {
  const p = await shop(); await p.click(av(p, G.ateez)); assert.deepEqual(shown(p), ['Ateez ID Backs', 'Ateez Lip Cards']); assert.equal(av(p, G.ateez).getAttribute('aria-pressed'), 'true'); assert.equal(av(p, 'all').getAttribute('aria-pressed'), 'false'); assert.equal(p.window.location.hash, '#/shop', 'still on the Shop page');
  await p.click(av(p, G.ateez)); assert.equal(shown(p).length, 6, 'tap again: cleared'); assert.equal(av(p, 'all').getAttribute('aria-pressed'), 'true');
  await p.click(av(p, G.sk)); assert.deepEqual(shown(p), ['Skz Sticker Backs']); await p.click(av(p, G.ateez)); assert.deepEqual(shown(p), ['Ateez ID Backs', 'Ateez Lip Cards'], 'straight from one artist to another'); await p.click(av(p, 'all')); assert.equal(shown(p).length, 6, '"All" clears'); p.close();
});

test('"OTHER" HOLDS EVERYTHING WITHOUT AN ARTIST (including items whose artist is hidden)', async () => {
  const p = await shop(); await p.click(av(p, 'other')); assert.deepEqual(shown(p), ['Another Loose Thing', 'Loose Photocard', 'Secret Thing']); assert.equal(av(p, 'other').getAttribute('aria-pressed'), 'true'); p.close();
});

test('CLAIMING WHILE FILTERED keeps the filter: the item is added to the basket and you stay looking at that artist', async () => {
  const p = await shop(); await p.click(av(p, G.ateez)); const card = p.q(`[data-shop-item="${G.items.a1}"]`); await p.click(p.q('[data-act="shopinc"]', card));
  assert.deepEqual(shown(p), ['Ateez ID Backs', 'Ateez Lip Cards'], 'the filter is still on'); assert.match(p.text(p.q('.stepper span', p.q(`[data-shop-item="${G.items.a1}"]`))), /^1$/); assert.equal(av(p, G.ateez).getAttribute('aria-pressed'), 'true'); p.close();
});

test('WITH NOTHING TO CHOOSE BETWEEN THERE IS NO ROW: all items in one lot (all Other, or just one artist) shows no avatars', async () => {
  const keep = (await app.q('SELECT id FROM leftover_items WHERE is_active = 1')).map((r) => r.id);
  try {
    await app.q('UPDATE leftover_items SET is_active = 0 WHERE group_id IS NOT NULL'); let p = await shop(); assert.equal(p.q('#shopArtists'), null, 'only "Other" items: nothing to choose'); assert.ok(p.qa('[data-shop-item]').length >= 2, 'but the items are all shown'); p.close();
    await app.q('UPDATE leftover_items SET is_active = 1 WHERE id IN (?)', [keep]); await app.q('UPDATE leftover_items SET is_active = 0 WHERE group_id IS NULL OR group_id <> ?', [G.ateez]); p = await shop(); assert.equal(p.q('#shopArtists'), null, 'only one artist: nothing to choose'); assert.equal(shown(p).length, 2); p.close();
  } finally { await app.q('UPDATE leftover_items SET is_active = 1 WHERE id IN (?)', [keep]); }
});

test('ARTIST NAMES WITH HTML ARE SHOWN AS TEXT', async () => {
  const g = await group('<img src=x onerror="window.pwned=1"> Crew'); await item('Weird thing', g); const p = await shop(); assert.equal(p.q('#shopArtists img[src="x"]'), null); assert.equal(p.window.pwned, undefined); assert.ok(avatars(p).some((a) => label(p, a).startsWith('<img src=x onerror="window.pwned=1"> Crew'))); p.close();
});
