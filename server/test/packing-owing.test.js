import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

// A part-paid parcel: the packing list says who still owes what (items vs postage), whether a payment from them is already waiting for the GOM, and NEVER blocks packing or shipping —
// people often pay the last balance together with the postage.
let app, admin, w, N = 0;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const u = (x = 'ow') => `${x}${++N}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READY = 'ready to pack / on hand';
const pay = async (me, amount, verify = true) => { const r = await api('POST', '/api/my/payments', { method: 'PayPal', amount, reference: u('R') }, me); assert.equal(r.status, 201, r.text); if (verify) assert.equal((await api('POST', `/api/admin/payments/${r.json.id}/verify`, {})).status, 200); return r.json.id; };
// a joiner with one £10 item, ready to ship, with a parcel requested
async function parcelFor({ handle = u(), price = 10, title = 'Hoodie' } = {}) {
  const go = (await api('POST', '/api/admin/orders', { groupId: w.group, title: u('Owing GO '), proxy: 'Sam' })).json.id;
  const item = (await api('POST', `/api/admin/orders/${go}/items`, { type: 'normal', title, price })).json.id;
  const me = await joinerSession(app, `${handle}@x.com`, handle);
  await api('PUT', '/api/my/address', { fullName: 'Owing Person', address: '1 Road, Leeds', email: `${handle}@x.com`, phone: '0700123456' }, me);
  const [claimId] = await claimAndSecure(app, admin, handle, item); await api('PATCH', `/api/admin/claims/${claimId}`, { pipeline: READY });
  const par = await api('POST', '/api/my/parcels', { claimIds: [claimId], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, me); assert.equal(par.status, 201, par.text);
  return { me, handle, claimId, parcelId: par.json.id };
}
const packingOf = async (id, status = 'requested') => (await api('GET', `/api/admin/packing?status=${status}`)).json.parcels.find((p) => p.id === id);
const packIt = async (id) => {
  await api('POST', `/api/admin/parcels/${id}/items-packed`, { packed: true }); await api('POST', `/api/admin/parcels/${id}/checks`, { lomo: true, bias: true });
  assert.equal((await api('POST', `/api/admin/parcels/${id}/fees`, { doms: 3, packaging: 1 })).status, 200); return api('POST', `/api/admin/parcels/${id}/packed`, { confirmed: true });
};

test('A PART-PAID PARCEL SAYS WHO OWES WHAT: £5 of a £10 hoodie paid → owes £5, split by category; a fully paid one says nothing', async () => {
  const a = await parcelFor(); await pay(a.me, 5);
  const p = await packingOf(a.parcelId);
  assert.deepEqual(p.owing, [{ handle: a.handle, total: 5, categories: [{ category: 'initials', owed: 5 }], pending: 0 }]);
  const b = await parcelFor(); await pay(b.me, 10);
  assert.deepEqual((await packingOf(b.parcelId)).owing, [], 'paid in full: no warning');
  const c = await parcelFor();                                                       // nothing paid
  assert.deepEqual((await packingOf(c.parcelId)).owing, [{ handle: c.handle, total: 10, categories: [{ category: 'initials', owed: 10 }], pending: 0 }]);
});

test('A PAYMENT ALREADY WAITING FOR THE GOM IS SHOWN (the "paying it together" case) — and the warning clears once it is verified', async () => {
  const a = await parcelFor(); await pay(a.me, 5);
  const waiting = await pay(a.me, 5, false);                                          // sent, not yet verified
  assert.equal((await packingOf(a.parcelId)).owing[0].pending, 5, 'a £5 payment is waiting');
  await api('POST', `/api/admin/payments/${waiting}/verify`, {});
  assert.deepEqual((await packingOf(a.parcelId)).owing, [], 'verified: nothing owing');
  const other = await parcelFor(); await pay(other.me, 4, false);
  assert.equal((await packingOf(a.parcelId)).owing.length, 0); assert.equal((await packingOf(other.parcelId)).owing[0].pending, 4, 'each person\'s own pending payment only');
});

test('IT IS ONLY A HEADS-UP: a parcel with money owing can still be packed, shipped and received — and the postage then shows as owing too', async () => {
  const a = await parcelFor(); await pay(a.me, 5);
  const packed = await packIt(a.parcelId); assert.equal(packed.status, 200, packed.text);
  const p = await packingOf(a.parcelId, 'packed');
  assert.ok(p.owing[0].categories.some((c) => c.category === 'initials' && c.owed === 5), 'the item balance');
  assert.ok(p.owing[0].categories.some((c) => c.category === 'doms') && p.owing[0].categories.some((c) => c.category === 'packaging'), 'and the postage and packaging fees just added');
  assert.equal(p.owing[0].total, 5 + 3 + 1);
  assert.equal((await api('POST', `/api/admin/parcels/${a.parcelId}/shipped`, {})).status, 200, 'shipping is not blocked');
  assert.ok((await packingOf(a.parcelId, 'shipped')).owing.length === 1, 'still flagged while shipped');
  assert.equal((await api('POST', `/api/admin/parcels/${a.parcelId}/received`, {})).status, 200, 'receiving is not blocked either');
});

test('AFTER THE FINAL PAYMENT covering item balance AND postage together, the warning is gone', async () => {
  const a = await parcelFor(); await pay(a.me, 5); await packIt(a.parcelId);
  await pay(a.me, 9);                                                                 // £5 left on the item + £3 postage + £1 packaging, paid in one go
  assert.deepEqual((await packingOf(a.parcelId, 'packed')).owing, []);
});

// ── on screen ──
test('ON SCREEN: an amber "Still owing" banner naming the person, the amount, what it is for and any waiting payment; none when paid; names with HTML are shown as text', async () => {
  const a = await parcelFor({ handle: u('ui') }); await pay(a.me, 5); await pay(a.me, 2, false);
  const paid = await parcelFor({ handle: u('ui') }); await pay(paid.me, 10);
  const nasty = await parcelFor({ handle: u('xs') }); await app.q("UPDATE joiners SET instagram_handle = ? WHERE instagram_handle = ?", ['<b>bold</b>_h', nasty.handle]);
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Packing')); await sleep(100); await p.settle();
  const card = (id) => p.q(`[data-parcel="${id}"]`);
  const banner = p.q('[data-owing]', card(a.parcelId));
  assert.match(p.text(banner), /Still owing — just a heads-up, you can still pack and ship\./);
  assert.match(p.text(p.q(`[data-owing-person="${a.handle}"]`, banner)), new RegExp(`@${a.handle} owes £5\\.00 \\(items £5\\.00\\) · a £2\\.00 payment is waiting for you to verify`));
  assert.equal(p.q('[data-owing]', card(paid.parcelId)), null, 'paid in full: no banner');
  const html = p.q('[data-owing]', card(nasty.parcelId)); assert.equal(p.q('b', html), null); assert.match(p.text(html), /@<b>bold<\/b>_h owes £10\.00/);
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});

test('ON SCREEN: the "Mark packed" confirmation repeats the figure — "Not yet" changes nothing, and going ahead packs it anyway', async () => {
  const a = await parcelFor({ handle: u('cf') }); await pay(a.me, 5);
  const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Packing')); await sleep(100); await p.settle();
  await p.click(p.q(`[data-act="tick-all"][data-id="${a.parcelId}"]`)); await sleep(60);
  const packBtn = () => p.q(`[data-act="packed"][data-id="${a.parcelId}"]`);
  await p.click(packBtn());
  assert.match(p.text(modal(p)), new RegExp(`⚠ Still owing on what's in it: @${a.handle} £5\\.00\\. You can still pack it\\.`));
  await press(p, 'Not yet'); assert.equal((await packingOf(a.parcelId)).status, 'requested', 'not yet means not yet');
  await p.click(packBtn()); await press(p, 'Mark packed'); await sleep(150); await p.settle();
  assert.equal((await api('GET', '/api/admin/packing?status=packed')).json.parcels.some((x) => x.id === a.parcelId), true, 'packed, with money still owing — only a warning');
  assert.deepEqual([p.errors, p.native], [[], 0]); p.close();
});
