import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession, claimAndSecure, tickParcel } from './helpers.js';
import { gomPage, modal, press, toast } from './ui.helpers.js';

const READY = 'ready to pack / on hand';
let app, admin, w, cookies = {}, parcel = {};
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });

const api = (m, p, b, c = admin) => app.api(m, p, b, c);
const open = async () => { const p = await gomPage(app, admin); await p.click(p.byText('#tabs button', 'Packing')); return p; };
const card = (p, id) => p.q(`[data-parcel="${id}"]`);
// the screen's own "Tick all" button, then the Mark packed button
const tickAll = (p, id) => p.click(p.q(`[data-act="tick-all"][data-id="${id}"]`));
const pack = async (p, id) => { await tickAll(p, id); await p.click(p.q(`[data-act="packed"][data-id="${id}"]`)); };
const claimsOf = async (h) => (await api('GET', `/api/admin/claims?handle=${h}`)).json.claims;
async function makeParcel(handle, name, extra = {}, itemIds = [w.keyring]) {
  const c = await joinerSession(app, `${handle}@x.com`, handle);
  cookies[handle] = c;
  await api('PUT', '/api/my/address', { fullName: name, address: '12 Test Street, Leeds, LS1 1AA', email: `${handle}@x.com`, phone: '07700 900123' }, c);
  const ids = [];
  for (const it of itemIds) { const [id] = await claimAndSecure(app, admin, handle, it); await api('PATCH', `/api/admin/claims/${id}`, { pipeline: READY }); ids.push(id); }
  const r = await api('POST', '/api/my/parcels', { claimIds: ids, method: 'UK Royal Mail Tracked 48', addressConfirmed: true, ...extra }, c);
  parcel[handle] = r.json.id;
  return r.json.id;
}

test('the queue shows each parcel in order with everything needed to pack it', async () => {
  await makeParcel('pk1', 'Pat One', { notes: 'toploader please', bias: 'Han', method: 'WW Tracked', declaredValue: 'reduced' }, [w.keyring, w.album]);
  await makeParcel('pk2', 'Pat Two', { lomoName: 'Cara' });
  await makeParcel('pk3', 'Pat Three');
  const p = await open();
  assert.equal(p.q('#tabs [data-tab="packing"] .badge').textContent, '3');
  assert.deepEqual(p.qa('[data-parcel]').map((c) => c.dataset.parcel), [parcel.pk1, parcel.pk2, parcel.pk3].map(String), 'oldest request first');
  const one = p.text(card(p, parcel.pk1));
  assert.match(one, /#1 in the queue · Parcel \d+ — @pk1/);
  assert.match(one, /WW Tracked.*declared reduced value/);
  assert.match(one, /Send to\s*Pat One 12 Test Street, Leeds, LS1 1AA Tel: 07700 900123/);
  assert.match(one, /Keyring.*Album/);
  assert.match(one, /Packing notes: toploader please/); assert.match(one, /Bias \(thank-you card\): Han/);
  assert.match(one, /Personalised Lomo: Pat One their delivery name/);
  assert.match(p.text(card(p, parcel.pk2)), /Personalised Lomo: Cara a name they chose/);
  assert.match(p.text(card(p, parcel.pk3)), /#3 in the queue/);
  assert.match(p.text(p.q('.btn-row')), /Queue \(3\).*Packed \(0\).*Shipped \(0\).*Received \(0\)/);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('an unchecked handle is flagged before its first parcel goes out, and you can mark it checked', async () => {
  const p = await open();
  assert.match(p.text(card(p, parcel.pk1)), /not checked yet.*quick Instagram DM/);
  await p.click(p.q(`[data-parcel="${parcel.pk1}"] [data-act="verify"]`));
  assert.match(toast(p), /@pk1 marked as checked/);
  assert.doesNotMatch(p.text(card(p, parcel.pk1)), /not checked yet/);
  assert.match(p.text(card(p, parcel.pk2)), /not checked yet/, 'others are still flagged');
  p.close();
});

test('postage and packaging fee: two boxes, validated, saved separately or together, shared across the items, correctable', async () => {
  const p = await open();
  const form = () => p.q(`[data-parcel="${parcel.pk1}"] form[data-form="fees"]`);
  assert.match(p.text(form()), /Postage — Doms \(£\).*Packaging fee \(£\)/);
  assert.match(p.text(form()), /Not set yet: postage and packaging fee/);
  await p.submit(form());
  assert.match(p.text(p.q('[data-msg]', form())), /Enter the postage and\/or the packaging fee/);
  form().elements.doms.value = '-3'; await p.submit(form());
  assert.match(p.text(p.q('[data-msg]', form())), /postage must be an amount of £0 or more/);
  form().elements.doms.value = ''; form().elements.packaging.value = '-1'; await p.submit(form());
  assert.match(p.text(p.q('[data-msg]', form())), /packaging fee must be an amount of £0 or more/);
  form().elements.packaging.value = '1.234'; await p.submit(form());
  assert.ok(p.text(p.q('[data-msg]', form())).length > 0, 'pennies only — the server\'s refusal is shown');

  form().elements.packaging.value = ''; form().elements.doms.value = '10'; await p.submit(form());       // postage on its own
  assert.match(toast(p), /Fees saved — postage £10\.00/);
  let cs = await claimsOf('pk1');
  assert.deepEqual(cs.map((c) => c.costs.doms.cost).sort(), [5, 5]);
  assert.deepEqual(cs.map((c) => c.costs.packaging.cost), [0, 0], 'packaging untouched');
  assert.match(p.text(form()), /Not set yet: packaging fee/);
  form().elements.packaging.value = '1'; await p.submit(form());                                          // then packaging
  assert.match(p.text(form()), /Saved: postage £10\.00 · packaging £1\.00/);
  cs = await claimsOf('pk1');
  assert.deepEqual(cs.map((c) => c.costs.packaging.cost).sort(), [0.5, 0.5]);
  form().elements.doms.value = '9'; await p.submit(form());                                                // corrected down
  cs = await claimsOf('pk1');
  assert.equal(cs.reduce((t, c) => t + c.costs.doms.cost, 0), 9);
  assert.match(p.text(form()), /Saved: postage £9\.00 · packaging £1\.00/);
  assert.equal(form().elements.doms.value, '9', 'the boxes show what is saved');
  p.close();
});

test('copying the address: with no clipboard available it shows the address to copy by hand', async () => {
  const p = await open();
  await p.click(p.q(`[data-parcel="${parcel.pk2}"] [data-act="copy"]`));
  assert.match(p.text(modal(p)), /Copy this address:\s*Pat Two\s*12 Test Street, Leeds, LS1 1AA/);
  await press(p, 'OK');
  assert.equal(p.native, 0);
  p.close();
});

test('packed → shipped → received moves a parcel across the tabs, and receiving completes its items', async () => {
  const p = await open();
  await pack(p, parcel.pk1);
  assert.match(p.text(modal(p)), /Postage \(Doms\): £9\.00.*Packaging fee: £1\.00.*@pk1 will owe £10\.00/s);
  assert.doesNotMatch(p.text(modal(p)), /haven't set/, 'both fees are set, so no warning');
  await press(p, 'Mark packed');
  assert.match(toast(p), /Marked packed/);
  assert.equal(card(p, parcel.pk1), null, 'left the queue');
  assert.match(p.text(p.q('.btn-row')), /Queue \(2\).*Packed \(1\)/);
  assert.match(p.text(card(p, parcel.pk2)), /#1 in the queue/, 'everyone behind moves up');
  assert.equal(p.q('#tabs [data-tab="packing"] .badge').textContent, '2');
  await p.click(p.byText('[data-act="status"]', 'Packed'));
  assert.match(p.text(card(p, parcel.pk1)), /packed \d\d\/\d\d\/\d{4}/);
  assert.match(p.text(card(p, parcel.pk1)), /Postage £9\.00 · Packaging £1\.00/);
  assert.equal(p.q(`[data-parcel="${parcel.pk1}"] form[data-form="fees"]`), null, 'fees can no longer be edited once packed');
  await p.click(p.q(`[data-act="shipped"][data-id="${parcel.pk1}"]`));
  await p.click(p.byText('[data-act="status"]', 'Shipped'));
  assert.match(p.text(card(p, parcel.pk1)), /packed \d\d\/\d\d\/\d{4} · shipped \d\d\/\d\d\/\d{4}/);
  await p.click(p.q(`[data-act="received"][data-id="${parcel.pk1}"]`));
  assert.match(p.text(modal(p)), /received on behalf of @pk1/);
  await press(p, 'Cancel');
  assert.deepEqual((await claimsOf('pk1')).map((c) => c.pipeline), ['shipped', 'shipped'], 'cancelling the dialog did nothing');
  await p.click(p.q(`[data-act="received"][data-id="${parcel.pk1}"]`)); await press(p, 'Yes, mark received');
  assert.deepEqual((await claimsOf('pk1')).map((c) => c.pipeline), ['completed', 'completed']);
  assert.match(p.text(p.q('.btn-row')), /Received \(1\)/);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('cancelling a parcel: the dialog explains, keeping does nothing, confirming frees the items to be requested again', async () => {
  const p = await open();
  await p.click(p.q(`[data-act="cancel"][data-id="${parcel.pk2}"]`));
  assert.match(p.text(modal(p)), /go back to "ready to pack".*postage and packaging fee you added are taken off/);
  await press(p, 'Keep it');
  assert.ok(card(p, parcel.pk2));
  await p.click(p.q(`[data-act="cancel"][data-id="${parcel.pk2}"]`)); await press(p, 'Cancel the parcel');
  assert.match(toast(p), /Parcel cancelled/);
  assert.equal(card(p, parcel.pk2), null);
  const again = await api('POST', '/api/my/parcels', { claimIds: [(await claimsOf('pk2'))[0].id], method: 'UK Royal Mail Tracked 48', addressConfirmed: true }, cookies.pk2);
  assert.equal(again.status, 201, 'the joiner can request shipping again');
  p.close();
});

test('a stale page: ticking on a parcel that already moved on is explained, and the screen refreshes', async () => {
  const p = await open();
  await tickParcel(app, admin, parcel.pk3);
  await api('POST', `/api/admin/parcels/${parcel.pk3}/packed`, {});            // done from another tab
  await p.click(p.q(`[data-parcel="${parcel.pk3}"] input[data-tick="item"]`));
  assert.match(toast(p), /is packed, so its checklist can't be changed/);
  assert.equal(card(p, parcel.pk3), null, 'and it is no longer listed in the queue');
  p.close();
});

test('empty states, and names with HTML are shown as text', async () => {
  await makeParcel('pk4', '<b>Bold</b> Name', { notes: '<img src=x onerror="window.pwned=1">' });
  const p = await open();
  assert.equal(p.q('img[src="x"]'), null);
  assert.match(p.text(card(p, parcel.pk4)), /<b>Bold<\/b> Name/);
  assert.equal(p.window.pwned, undefined);
  await p.click(p.byText('[data-act="status"]', 'Received'));
  assert.match(p.text(card(p, parcel.pk1)), /received \d\d\/\d\d\/\d{4}/, 'the finished parcel keeps its dates');
  assert.equal(p.q('[data-act="received"]'), null, 'and has no further buttons');
  await p.click(p.byText('[data-act="status"]', 'Queue'));
  assert.ok(card(p, parcel.pk4));
  await api('POST', `/api/admin/parcels/${parcel.pk4}/cancel`, {});
  await p.click(p.byText('[data-act="status"]', 'Queue'));
  assert.equal(card(p, parcel.pk4), null, 'a cancelled parcel is gone from the queue');
  p.close();
});

const owedBy = async (handle) => (await api('GET', '/api/my/summary', undefined, cookies[handle])).json.owed;

test('Mark packed with the two boxes filled in: it shows what they will owe, "Not yet" saves nothing, confirming saves the fees AND packs', async () => {
  await makeParcel('pk6', 'Pat Six', {}, [w.keyring, w.keyring]);
  const p = await open();
  const form = () => p.q(`[data-parcel="${parcel.pk6}"] form[data-form="fees"]`);
  form().elements.doms.value = '3'; form().elements.packaging.value = '1.5';          // typed, NOT saved
  await pack(p, parcel.pk6);
  const text = p.text(modal(p));
  assert.match(text, /Mark parcel \d+ for @pk6 as packed\?/);
  assert.match(text, /Postage \(Doms\): £3\.00/); assert.match(text, /Packaging fee: £1\.50/);
  assert.match(text, /@pk6 will owe £4\.50 for these, on top of anything they already owe/);
  await press(p, 'Not yet');
  const row = (await api('GET', '/api/admin/packing?status=requested')).json.parcels.find((x) => x.id === parcel.pk6);
  assert.deepEqual([row.domsTotal, row.packagingTotal], [null, null], 'saying "not yet" saved nothing');
  assert.deepEqual([(await owedBy('pk6')).doms, (await owedBy('pk6')).packaging], [0, 0]);

  await p.click(p.q(`[data-act="packed"][data-id="${parcel.pk6}"]`)); await press(p, 'Mark packed');
  assert.match(toast(p), /Marked packed/);
  const packed = (await api('GET', '/api/admin/packing?status=packed')).json.parcels.find((x) => x.id === parcel.pk6);
  assert.deepEqual([packed.domsTotal, packed.packagingTotal], [3, 1.5], 'the typed fees were saved on the way');
  const o = await owedBy('pk6');
  assert.deepEqual([o.doms, o.packaging], [3, 1.5], 'and the joiner now owes them');
  await p.click(p.byText('[data-act="status"]', 'Packed'));
  assert.match(p.text(card(p, parcel.pk6)), /Postage £3\.00 · Packaging £1\.50/);
  assert.deepEqual([p.errors, p.native], [[], 0]);
  p.close();
});

test('Mark packed with nothing set warns you, but lets you carry on (a parcel can genuinely have no fees)', async () => {
  await makeParcel('pk7', 'Pat Seven');
  const p = await open();
  await pack(p, parcel.pk7);
  const text = p.text(modal(p));
  assert.match(text, /Postage \(Doms\): not set/); assert.match(text, /Packaging fee: not set/);
  assert.match(text, /@pk7 will owe £0\.00/);
  assert.match(text, /You haven't set the postage or the packaging fee\. Pack it anyway\?/);
  await press(p, 'Mark packed');
  assert.match(toast(p), /Marked packed/);
  assert.equal((await api('GET', '/api/admin/packing?status=packed')).json.parcels.some((x) => x.id === parcel.pk7), true);
  p.close();
});

test('only one fee set: the warning names the missing one', async () => {
  await makeParcel('pk8', 'Pat Eight');
  const p = await open();
  const form = () => p.q(`[data-parcel="${parcel.pk8}"] form[data-form="fees"]`);
  form().elements.doms.value = '2.75';
  await pack(p, parcel.pk8);
  const text = p.text(modal(p));
  assert.match(text, /Postage \(Doms\): £2\.75/); assert.match(text, /Packaging fee: not set/);
  assert.match(text, /You haven't set the packaging fee\. Pack it anyway\?/);
  assert.doesNotMatch(text, /set the postage/);
  await press(p, 'Not yet');
  p.close();
});

test('a mistyped fee on Mark packed is explained and no dialog opens', async () => {
  await makeParcel('pk9', 'Pat Nine');
  const p = await open();
  const form = () => p.q(`[data-parcel="${parcel.pk9}"] form[data-form="fees"]`);
  form().elements.packaging.value = '-2';
  await pack(p, parcel.pk9);
  assert.equal(modal(p), null);
  assert.match(p.text(p.q('[data-msg]', form())), /packaging fee must be an amount of £0 or more/);
  assert.equal((await api('GET', '/api/admin/packing?status=requested')).json.parcels.some((x) => x.id === parcel.pk9), true, 'still in the queue');
  p.close();
});

test('fees differ per joiner: each parcel keeps its own figures, and the Claims screen shows the packaging line', async () => {
  const p = await open();
  const f = (id) => p.q(`[data-parcel="${id}"] form[data-form="fees"]`);
  f(parcel.pk8).elements.doms.value = '2.75'; f(parcel.pk8).elements.packaging.value = '0.80'; await p.submit(f(parcel.pk8));
  f(parcel.pk9).elements.doms.value = '6'; f(parcel.pk9).elements.packaging.value = '0'; await p.submit(f(parcel.pk9));
  assert.deepEqual([(await owedBy('pk8')).doms, (await owedBy('pk8')).packaging], [2.75, 0.8]);
  assert.deepEqual([(await owedBy('pk9')).doms, (await owedBy('pk9')).packaging], [6, 0]);
  assert.match(p.text(f(parcel.pk9).parentElement), /Saved: postage £6\.00 · packaging £0\.00/, 'zero is saved as a real answer');
  await p.click(p.byText('#tabs button', 'Claims'));
  await p.click(p.q('[data-buyer="pk8"] [data-act="toggle"]'));
  assert.match(p.text(p.q('[data-buyer="pk8"] table')), /Packaging £0\.80/);
  p.close();
});

// ───────────── the packing checklist ─────────────
const stateOf = async (id) => (await api('GET', '/api/admin/packing?status=requested')).json.parcels.find((x) => x.id === id);

test('the checklist: every item, the address, the Lomo name and the bias name — with Mark packed locked until all are ticked', async () => {
  await makeParcel('ck1', 'Cee Kay', { lomoName: 'Kayy', bias: 'Han' }, [w.keyring, w.album]);
  const p = await open();
  const c = card(p, parcel.ck1);
  const list = p.text(p.q('[data-checklist]', c));
  assert.match(list, /Packing checklist 0 of 5 ticked/, '2 items + address + Lomo + bias');
  assert.match(list, /Keyring/); assert.match(list, /Album/);
  assert.match(list, /Delivery address checked/);
  assert.match(list, /Lomo name checked — Kayy \(a name they chose\)/);
  assert.match(list, /Bias name checked — Han \(for the thank-you card\)/);
  assert.equal(p.q('[data-act="packed"]', c).disabled, true);
  assert.match(p.text(c), /Tick everything on the checklist to enable Mark packed/);
  p.close();
});

test('ticking: the count and the button follow each tick, ticks are saved as you go and survive a reload, unticking locks it again', async () => {
  const p = await open();
  const c = () => card(p, parcel.ck1);
  const boxes = () => p.qa('input[data-tick]', c());
  const count = () => p.text(p.q('[data-count]', c()));
  assert.equal(boxes().length, 5);
  for (const [n, box] of boxes().slice(0, 4).entries()) {
    await p.click(box);
    assert.equal(count(), `${n + 1} of 5 ticked`);
    assert.equal(p.q('[data-act="packed"]', c()).disabled, true, 'still locked');
  }
  const saved = await stateOf(parcel.ck1);
  assert.deepEqual(saved.items.map((i) => i.packed), [true, true]);
  assert.deepEqual([saved.addressChecked, saved.lomoChecked, saved.biasChecked], [true, true, false], 'saved on the server as each box was ticked');
  await p.click(p.byText('#tabs button', 'Packing'));                              // a fresh load of the tab
  assert.equal(count(), '4 of 5 ticked', 'the ticks were still there');
  await p.click(boxes()[4]);
  assert.equal(count(), '5 of 5 ticked');
  assert.equal(p.q('[data-act="packed"]', c()).disabled, false, 'everything ticked: unlocked');
  assert.equal(p.q('[data-pack-hint]', c()).hidden, true);
  await p.click(boxes()[0]);                                                      // take one back
  assert.equal(p.q('[data-act="packed"]', c()).disabled, true);
  assert.equal((await stateOf(parcel.ck1)).items[0].packed, false);
  assert.equal(p.errors.length, 0);
  p.close();
});

test('ticking never redraws the screen, so fees you have typed are not lost', async () => {
  const p = await open();
  const f = () => p.q(`[data-parcel="${parcel.ck1}"] form[data-form="fees"]`);
  f().elements.doms.value = '3.25'; f().elements.packaging.value = '0.75';
  await p.click(p.q(`[data-parcel="${parcel.ck1}"] input[data-tick="item"]`));
  assert.equal(f().elements.doms.value, '3.25'); assert.equal(f().elements.packaging.value, '0.75');
  p.close();
});

test('"Tick all", then Mark packed: the whole flow works and the parcel moves on with its checklist intact', async () => {
  const p = await open();
  await tickAll(p, parcel.ck1);
  assert.match(p.text(p.q('[data-count]', card(p, parcel.ck1))), /5 of 5 ticked/);
  const s = await stateOf(parcel.ck1);
  assert.deepEqual([s.items.every((i) => i.packed), s.addressChecked, s.lomoChecked, s.biasChecked], [true, true, true, true]);
  await p.click(p.q(`[data-act="packed"][data-id="${parcel.ck1}"]`)); await press(p, 'Mark packed');
  assert.match(toast(p), /Marked packed/);
  await p.click(p.byText('[data-act="status"]', 'Packed'));
  const text = p.text(card(p, parcel.ck1));
  assert.match(text, /✓ Keyring/); assert.match(text, /✓ Album/);
  assert.equal(p.qa('input[data-tick]', card(p, parcel.ck1)).length, 0, 'once packed the checklist is read-only');
  p.close();
});

test('a parcel with no bias has no bias box; the Lomo box is only there when there is a Lomo name', async () => {
  await makeParcel('ck2', 'Dee Kay', {}, [w.keyring]);
  const p = await open();
  const list = p.text(p.q('[data-checklist]', card(p, parcel.ck2)));
  assert.match(list, /0 of 3 ticked/, 'item + address + Lomo (their delivery name)');
  assert.match(list, /Lomo name checked — Dee Kay \(their delivery name\)/);
  assert.doesNotMatch(list, /Bias name checked/);
  for (const box of p.qa('input[data-tick]', card(p, parcel.ck2))) await p.click(box);
  assert.equal(p.q(`[data-act="packed"][data-id="${parcel.ck2}"]`).disabled, false);
  p.close();
});

test('names with HTML in the Lomo or bias are shown as text in the checklist', async () => {
  await makeParcel('ck3', 'Eee Kay', { lomoName: '<img src=x onerror="window.pwned=1">', bias: '<b>Han</b>' }, [w.keyring]);
  const p = await open();
  assert.equal(p.q('img[src="x"]'), null);
  assert.match(p.text(p.q('[data-checklist]', card(p, parcel.ck3))), /<img src=x onerror="window\.pwned=1">.*<b>Han<\/b>/);
  assert.equal(p.window.pwned, undefined);
  p.close();
});
