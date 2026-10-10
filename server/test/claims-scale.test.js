import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed } from './helpers.js';

// The admin Claims list used to stop silently at 1,000 claims (sorted by handle, so people late in the alphabet vanished). It now returns up to 20,000 and SAYS when there are more.
let app, admin, w;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { delete process.env.CLAIMS_LIST_MAX; await app.stop(); });
const api = (m, p, b) => app.api(m, p, b, admin);
let N = 0;

test('MORE THAN 1,000 CLAIMS ALL COME BACK (it used to cut off at 1,000), including people at the end of the alphabet — quickly, and with their totals', async () => {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: 'Big GO' })).json.id;
  const it = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title: 'Big item', price: 1 })).json.id;
  const handles = ['aaa_first', 'mmm_middle', 'zzz_last'];
  for (const h of handles) for (let i = 0; i < 20; i++) {                                    // 20 lines × 20 = 400 claims each → 1,200
    const r = await app.api('POST', '/api/claims', { handle: h, lines: Array.from({ length: 1 }, () => ({ itemId: it, qty: 20 })) }); assert.ok([200, 201].includes(r.status), `${h} ${r.status} ${r.text}`);
  }
  const t0 = Date.now(); const r = await api('GET', '/api/admin/claims'); const ms = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.ok(r.json.claims.length >= 1200, `got ${r.json.claims.length}`); assert.equal(r.json.truncated, false);
  assert.ok(r.json.claims.some((c) => c.handle === 'zzz_last'), 'the last handle alphabetically is there — it used to be cut off');
  assert.deepEqual(Object.keys(r.json.people).filter((h) => handles.includes(h)).sort(), handles);
  assert.ok(ms < 3000, `${ms}ms for ${r.json.claims.length} claims`);
  assert.ok(r.json.claims.every((c) => c.costs && typeof c.costs === 'object'), 'every claim still carries its costs');
  const one = r.json.claims.find((c) => c.handle === 'zzz_last'); assert.ok(Object.keys(one.costs).length > 0);
});

test('WHEN THERE ARE REALLY MORE than the list can carry, it says so (truncated: true) instead of silently dropping them', async () => {
  const all = (await api('GET', '/api/admin/claims')).json.claims.length;
  process.env.CLAIMS_LIST_MAX = '50';
  const r = await api('GET', '/api/admin/claims');
  assert.equal(r.json.claims.length, 50); assert.equal(r.json.truncated, true); assert.ok(all > 50);
  process.env.CLAIMS_LIST_MAX = String(all);
  const exact = await api('GET', '/api/admin/claims'); assert.equal(exact.json.truncated, false, 'exactly at the limit is not "more"'); assert.equal(exact.json.claims.length, all);
  delete process.env.CLAIMS_LIST_MAX;
  assert.equal((await api('GET', '/api/admin/claims')).json.truncated, false);
  assert.equal((await app.api('GET', '/api/admin/claims')).status, 401);
});
