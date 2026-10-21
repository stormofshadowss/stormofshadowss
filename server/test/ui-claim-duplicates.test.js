import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';
import { openPage } from './ui.helpers.js';

// What a JOINER sees: the Claim button locks while sending (a second press does nothing); if their handle already has what they are claiming the page ASKS ("You already have 1 × … — claim another?");
// and the confirmation is kept (and reminded) so nobody is left wondering whether their claim went through after Back or Refresh.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (x = 'jd') => `${x}${++N}`;
const goOrder = async () => (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Dup UI GO '), proxy: 'Sam' })).json.id;
const item = async (go, title, extra = {}) => (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', price: 5, title, ...extra })).json.id;
const shop = (opts) => openPage(app, '/', opts);
const go = async (p, hash) => { p.window.location.hash = hash; await sleep(40); await p.settle(); };
const plus = async (p, itemId, { member, variant } = {}) => p.click(p.q(`[data-act="inc"][data-item="${itemId}"]${member ? `[data-member="${member}"]` : ''}${variant ? `[data-variant="${variant}"]` : ''}`));
const submit = async (p, handle) => { p.q('#ig').value = handle; await p.submit(p.q('form[data-form="claim"]')); await sleep(250); await p.settle(); };
const count = async (h, itemId) => (await app.q("SELECT COUNT(*) AS n FROM claims c JOIN joiners j ON j.id = c.joiner_id WHERE j.instagram_handle = ? AND c.item_id = ? AND c.status <> 'cancelled'", [h, itemId]))[0].n;
const claimVia = (h, itemId, extra = {}) => app.api('POST', '/api/claims', { handle: h, allowDuplicates: true, lines: [{ itemId, ...extra }] });
const basketTitles = (p) => p.qa('#view .itemrow .grow').map((e) => p.text(e.firstChild ? e : e).split(/\s{2,}|\n/)[0]);
const withClaimDelay = (p, ms = 350) => { const orig = p.window.fetch; const seen = { posts: 0 }; p.window.fetch = (url, opts) => (String(url).includes('/api/claims') && opts?.method === 'POST' ? (seen.posts++, new Promise((r) => setTimeout(r, ms)).then(() => orig(url, opts))) : orig(url, opts)); return seen; };

test('THE CLAIM BUTTON LOCKS WHILE SENDING: it says "Sending…", pressing again (or Enter in the handle box) sends nothing, and exactly one claim is made', async () => {
  const g = await goOrder(); const it = await item(g, 'OT8 photocards'); const p = await shop(); await go(p, `#/order/${g}`); await plus(p, it); await go(p, '#/basket'); const seen = withClaimDelay(p, 500); const h = u('tap');
  p.q('#ig').value = h; const form = p.q('form[data-form="claim"]'); const first = p.submit(form); await sleep(120); const btn = p.q('button[type="submit"]', form);
  assert.equal(btn.disabled, true, 'locked'); assert.equal(p.text(btn), 'Sending…'); const second = p.submit(form), third = p.submit(form); await Promise.all([first, second, third]); await sleep(800); await p.settle();
  assert.equal(seen.posts, 1, 'one request left the browser — the repeat presses did nothing'); assert.equal(await count(h, it), 1); assert.match(p.text(p.q('#view h1')), /Claims submitted/); assert.deepEqual([p.errors], [[]]); p.close();
});

test('IF THE HANDLE ALREADY HAS IT THE PAGE ASKS: your exact words, the basket and handle untouched, nothing added; the button works again afterwards', async () => {
  const g = await goOrder(); const it = await item(g, 'OT8 photocards'); const h = u('ask'); await claimVia(h, it);
  const p = await shop(); await go(p, `#/order/${g}`); await plus(p, it); await go(p, '#/basket'); await submit(p, h);
  const card = p.q('[data-dup]'); assert.ok(card, 'the question appears'); assert.match(p.text(card), /^You already have 1 × OT8 photocards — claim another\?\s*If you were just making sure your claim went through — it did\. Only claim another if you really want a second one\./);
  assert.deepEqual(p.qa('[data-act^="dup-"]', card).map((b) => p.text(b)), ['Yes, claim another', 'No, take it out of my basket']); assert.equal(await count(h, it), 1, 'nothing was added'); assert.equal(p.q('#ig').value, h, 'their handle is still there'); assert.match(p.text(p.q('#basketPill')), /Basket \(1\)/, 'and so is the basket');
  assert.equal(p.q('button[type="submit"]').disabled, false, 'the button is usable again'); assert.equal(p.text(p.q('button[type="submit"]')), 'Submit claims'); assert.deepEqual([p.errors], [[]]); p.close();
});

test('"YES, CLAIM ANOTHER" CLAIMS IT: a second claim is made and the confirmation shows', async () => {
  const g = await goOrder(); const it = await item(g, 'OT8 photocards'); const h = u('yes'); await claimVia(h, it);
  const p = await shop(); await go(p, `#/order/${g}`); await plus(p, it); await go(p, '#/basket'); await submit(p, h); await p.click(p.q('[data-act="dup-yes"]')); await sleep(300); await p.settle();
  assert.equal(await count(h, it), 2); assert.match(p.text(p.q('#view h1')), /Claims submitted/); assert.match(p.text(p.q('#view')), /1 × OT8 photocards/); assert.equal(p.q('[data-dup]'), null); p.close();
});

test('"NO, TAKE IT OUT OF MY BASKET" REMOVES ONLY THE REPEATS: other items stay and can be claimed; a repeated member / part / shop item is matched exactly', async () => {
  const g = await goOrder(); const have = await item(g, 'Already have'), fresh = await item(g, 'Brand new'), mem = await item(g, 'Per member', { type: 'independent', members: ['Han', 'Felix'] }); const sid = (await api('POST', '/api/admin/shop', { title: 'Shop sticker', price: 3, qty: 9 })).json.id; const h = u('no');
  await claimVia(h, have); await claimVia(h, mem, { member: 'Han' }); await app.api('POST', '/api/claims', { handle: h, lines: [{ leftoverId: sid }] });
  const p = await shop(); await go(p, `#/order/${g}`); await plus(p, have); await plus(p, fresh); await plus(p, mem, { member: 'Han' }); await plus(p, mem, { member: 'Felix' }); await go(p, '/#/basket'.slice(1)); await go(p, '#/basket');
  const pill = () => Number(p.text(p.q('#basketPill')).match(/\((\d+)\)/)?.[1] || 0); assert.equal(pill(), 4); await submit(p, h); assert.match(p.text(p.q('[data-dup]')), /You already have 1 × Already have, 1 × Per member — Han — claim another\?/); assert.equal(await count(h, fresh), 0, 'nothing at all was added, not even the new items');
  await p.click(p.q('[data-act="dup-no"]')); assert.equal(p.q('[data-dup]'), null); assert.equal(pill(), 2, 'only "Already have" and Han were taken out'); const left = p.text(p.q('#view')); assert.ok(left.includes('Brand new') && left.includes('Per member — Felix') && !left.includes('Already have') && !left.includes('Per member — Han'), 'Felix and the new item remain');
  await submit(p, h); assert.match(p.text(p.q('#view h1')), /Claims submitted/); assert.deepEqual([await count(h, fresh), await count(h, mem)], [1, 2], 'the rest went through (Han 1 + Felix 1)'); p.close();
  const q = await shop(); await go(q, '#/shop'); await q.click(q.q(`[data-act="shopinc"][data-shop="${sid}"]`)); await go(q, '#/basket'); await submit(q, h); assert.match(q.text(q.q('[data-dup]')), /You already have 1 × Shop sticker/); await q.click(q.q('[data-act="dup-no"]')); assert.match(q.text(q.q('#view')), /Nothing selected yet/, 'the shop line was matched and removed'); q.close();
});

test('SOMEONE ELSE IS NEVER ASKED, and a brand-new handle goes straight through', async () => {
  const g = await goOrder(); const it = await item(g, 'OT8 photocards'); await claimVia(u('owner'), it); const p = await shop(); await go(p, `#/order/${g}`); await plus(p, it); await go(p, '#/basket'); await submit(p, u('someone_else'));
  assert.equal(p.q('[data-dup]'), null); assert.match(p.text(p.q('#view h1')), /Claims submitted/); p.close();
});

test('THE CONFIRMATION IS KEPT: after a Refresh the "Claims submitted" page comes back (not the home page); after 30 minutes it is gone', async () => {
  const g = await goOrder(); const it = await item(g, 'OT8 photocards'); const h = u('keep'); const p = await shop(); await go(p, `#/order/${g}`); await plus(p, it); await go(p, '#/basket'); await submit(p, h);
  const saved = p.window.sessionStorage.getItem('sos_done'); assert.ok(saved, 'it was kept'); const at = JSON.parse(saved).at; p.close();
  const refreshed = await openPage(app, '/#/done', { init: (win) => win.sessionStorage.setItem('sos_done', saved) }); await sleep(300); await refreshed.settle(); assert.match(refreshed.text(refreshed.q('#view h1')), /Claims submitted/, 'back on the confirmation'); assert.match(refreshed.text(refreshed.q('#view')), new RegExp(`@${h}`)); assert.match(refreshed.text(refreshed.q('#view')), /1 × OT8 photocards/); refreshed.close();
  const old = JSON.stringify({ ...JSON.parse(saved), at: at - 31 * 60 * 1000 }); const expired = await openPage(app, '/#/done', { init: (win) => win.sessionStorage.setItem('sos_done', old) }); await sleep(300); await expired.settle(); assert.doesNotMatch(expired.text(expired.q('#view')), /Claims submitted/, 'after half an hour it no longer pretends'); assert.equal(expired.q('[data-recent-claim]'), null); expired.close();
});

test('"YOUR CLAIM WENT THROUGH" STAYS IN VIEW on other pages — including the empty basket you land on after pressing Back; it can be dismissed (and stays dismissed); it is not shown on the confirmation itself', async () => {
  const g = await goOrder(); const it = await item(g, 'OT8 photocards'); const h = u('remind'); const p = await shop(); await go(p, `#/order/${g}`); await plus(p, it); await go(p, '#/basket'); await submit(p, h);
  assert.equal(p.q('[data-recent-claim]'), null, 'not on the confirmation page itself (it says so already)'); await go(p, '#/basket'); const b = p.q('[data-recent-claim]'); assert.ok(b, 'on the empty basket after Back'); assert.match(p.text(b), new RegExp(`^✓ Your claim went through — 1 item for @${h}, at \\d\\d:\\d\\d\\. See what you claimed`)); assert.equal(b.querySelector('a').getAttribute('href'), '#/done'); assert.match(p.text(p.q('#view')), /Nothing selected yet/);
  for (const hash of ['#/', `#/order/${g}`, '#/shop']) { await go(p, hash); assert.ok(p.q('[data-recent-claim]'), `shown on ${hash}`); }
  await p.click(p.q('[data-act="dismiss-recent"]')); assert.equal(p.q('[data-recent-claim]'), null, 'gone'); await go(p, '#/basket'); assert.equal(p.q('[data-recent-claim]'), null, 'and it stays gone'); await go(p, '#/done'); assert.match(p.text(p.q('#view h1')), /Claims submitted/, 'the confirmation itself is still there'); p.close();
});

test('NAMES WITH HTML ARE SHOWN AS TEXT in the question and the reminder; other problems (a closed item) are still reported plainly', async () => {
  const g = await goOrder(); const odd = await item(g, '<b>Bold</b> <img src=x onerror="window.pwned=1"> card'); const h = u('esc'); await claimVia(h, odd);
  const p = await shop(); await go(p, `#/order/${g}`); await plus(p, odd); await go(p, '#/basket'); await submit(p, h); assert.equal(p.q('[data-dup] b'), null); assert.equal(p.q('[data-dup] img'), null); assert.equal(p.window.pwned, undefined); assert.ok(p.text(p.q('[data-dup]')).includes('<b>Bold</b> <img src=x onerror="window.pwned=1"> card'));
  await p.click(p.q('[data-act="dup-yes"]')); await sleep(300); await p.settle(); await go(p, '#/basket'); assert.equal(p.q('[data-recent-claim] img'), null); p.close();
  const c = await item(g, 'Closing soon'); const q = await shop(); await go(q, `#/order/${g}`); await plus(q, c); await go(q, '#/basket'); await api('PATCH', `/api/admin/items/${c}`, { closed: true }); await submit(q, u('late')); assert.match(q.text(q.q('#view')), /closed|isn't open|no longer/i); assert.equal(q.q('[data-dup]'), null); q.close();
});
