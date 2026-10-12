// Incoming (inside the Warehouse tab): orders placed with shops by you or a proxy — what was ordered, tracking numbers to the warehouse, what has arrived, which shop to chase,
// and a button to move the oldest claims along once copies are ordered / have arrived.
(function () {
  const { esc, fmtDate, api, errText, $, $$ } = GOM;
  let root = null, data = null, filter = 'waiting', groupFilter = '', showNew = false, editing = null, addingLine = null, addingShip = null;
  const CARRIERS = [
    ['CJ Logistics', (n) => `https://trace.cjlogistics.com/next/tracking.html?wblNo=${n}`], ['Korea Post / EMS', (n) => `https://service.epost.go.kr/trace.RetrieveEmsRigiTraceList.comm?POST_CODE=${n}`],
    ['Lotte Global Logistics', (n) => `https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=${n}`], ['Hanjin', (n) => `https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&schLang=KR&wblnumText2=${n}`],
    ['Logen', (n) => `https://www.ilogen.com/web/personal/trace/${n}`], ['DHL', (n) => `https://www.dhl.com/gb-en/home/tracking.html?tracking-id=${n}`], ['FedEx', (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`], ['UPS', (n) => `https://www.ups.com/track?tracknum=${n}`], ['Other', null],
  ];
  const trackUrl = (carrier, no) => { const c = CARRIERS.find(([n]) => n === carrier); return c && c[1] ? c[1](encodeURIComponent(String(no).replace(/[ -]/g, ''))) : null; };
  const today = () => new Date().toISOString().slice(0, 10);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const STATE = { waiting: ['warn', 'Waiting'], part: ['warn', 'Part arrived'], arrived: ['ok', 'Arrived'], cancelled: ['dim', 'Cancelled'] };

  // the little switch at the top of the Warehouse tab (Boxes ⇄ Incoming); warehouse.js uses it too
  GOM.whSwitch = (current) => `<div class="chips" id="whSwitch" role="group" aria-label="Warehouse view"><button type="button" class="chip ${current === 'boxes' ? 'on' : ''}" data-act="wh-view" data-view="boxes" aria-pressed="${current === 'boxes'}">Boxes</button><button type="button" class="chip ${current === 'incoming' ? 'on' : ''}" data-act="wh-view" data-view="incoming" aria-pressed="${current === 'incoming'}">Incoming</button></div>`;

  const itemOptions = () => {
    const by = new Map(); for (const o of data.options) { if (!by.has(o.groupOrder)) by.set(o.groupOrder, []); by.get(o.groupOrder).push(o); }
    return `<option value="">Which item?</option>${[...by.entries()].map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((o) => `<option value="${o.itemId}">${esc(o.item)}</option>`).join('')}</optgroup>`).join('')}`;
  };
  const carrierOptions = (sel) => `<option value="">Carrier…</option>${CARRIERS.map(([n]) => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
  const lineRow = () => `<div class="formgrid" data-line-row style="margin-bottom:6px"><div class="span2"><select name="itemId">${itemOptions()}</select></div><div><input name="qty" type="number" min="1" max="9999" placeholder="How many" inputmode="numeric"></div><div><input name="lnote" placeholder="Note (e.g. ver. A)" maxlength="200"></div></div>`;
  const shipRow = () => `<div class="formgrid" data-ship-row style="margin-bottom:6px"><div><select name="carrier">${carrierOptions('')}</select></div><div class="span2"><input name="trackingNo" placeholder="Tracking number to your warehouse" maxlength="40"></div></div>`;

  async function render(el) {
    root = el; const r = await api('GET', '/api/admin/incoming'); data = r.json; draw();
  }
  function counts() {
    const rows = data.counts.filter((c) => !c.cancelled && (!groupFilter || c.groupOrder === groupFilter) && (c.needed || c.ordered));
    const groups = [...new Set(data.counts.filter((c) => !c.cancelled).map((c) => c.groupOrder))];
    return `<div class="card" id="itemCounts"><div class="row"><h2 style="margin:0">Item counts</h2>${groups.length > 1 ? `<select data-filter="group" style="width:auto"><option value="">All group orders</option>${groups.map((g) => `<option ${g === groupFilter ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>` : ''}</div>
      <p class="sub" style="margin:6px 0 10px">Needed = confirmed claims (or secured sets). Ordered and arrived come from your store orders (the Waiting and Arrived chips).</p>
      ${rows.length ? `<div class="scroll"><table class="grid"><thead><tr><th>Item</th><th>Needed</th><th>Ordered</th><th>Arrived</th><th></th><th></th></tr></thead><tbody>${rows.map((c) => `<tr data-count="${c.itemId}"><td>${esc(c.item)}<div class="sub">${esc(c.groupOrder)}${c.type === 'set' ? ' · sets' : ''}</div></td><td>${c.needed}</td><td>${c.ordered}</td><td>${c.arrived}</td>
        <td>${c.toOrder ? `<span class="pill warn">${c.toOrder} still to order</span>` : ''}${c.missing ? `<span class="pill">${c.missing} on the way</span>` : ''}${c.over ? `<span class="pill dim">${c.over} over</span>` : ''}${!c.toOrder && !c.missing && !c.over && c.needed ? '<span class="pill ok">all in</span>' : ''}</td>
        <td class="nowrap"><button class="sm secondary" data-act="advance" data-to="ordered" data-id="${c.itemId}" title="Move the oldest claims to 'ordered'">Mark ordered…</button> <button class="sm secondary" data-act="advance" data-to="arrived" data-id="${c.itemId}" title="Move the oldest claims to 'arrived at warehouse'">Mark arrived…</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing needs ordering yet — counts appear once people have confirmed claims.</p>'}</div>`;
  }
  function orderCard(o) {
    const [cls, label] = STATE[o.state], isEdit = editing === o.id;
    const proxy = o.proxy ? ` · by ${esc(o.proxy)}` : '';
    return `<div class="card" data-store-order="${o.id}"><div class="row"><div><strong>${esc(o.store)}</strong> <span class="sub">${o.orderRef ? `#${esc(o.orderRef)} · ` : ''}ordered ${fmtDate(o.orderedOn)}${proxy}</span>
        <div><span class="pill ${cls}" data-state="${o.state}">${label}${o.state === 'part' ? ` ${o.arrived}/${o.qty}` : ''}${o.daysWaiting != null ? ` · ${plural(o.daysWaiting, 'day', 'days')}` : ''}</span>${o.chase ? '<span class="pill warn" data-chase-flag>Chase this shop</span>' : ''}${o.noTracking && o.state !== 'cancelled' ? '<span class="pill dim">no tracking yet</span>' : ''}${o.lastChasedOn ? `<span class="sub"> chased ${fmtDate(o.lastChasedOn)}</span>` : ''}${o.orderUrl ? ` <a href="${esc(o.orderUrl)}" target="_blank" rel="noopener noreferrer">order page ↗</a>` : ''}</div></div>
      <div class="btn-row" style="margin:0">${o.state === 'waiting' || o.state === 'part' ? `<button class="sm" data-act="arrived-all" data-id="${o.id}">All arrived</button><button class="sm secondary" data-act="chased" data-id="${o.id}">Chased today</button>` : ''}<button class="sm secondary" data-act="edit" data-id="${o.id}">${isEdit ? 'Close' : 'Edit'}</button></div></div>
      ${isEdit ? editForm(o) : ''}
      ${o.notes && !isEdit ? `<p class="sub" style="margin:6px 0 0; white-space:pre-line">${esc(o.notes)}</p>` : ''}
      <div class="scroll" style="margin-top:8px"><table class="grid"><thead><tr><th>Item</th><th>Ordered</th><th>Arrived</th><th></th></tr></thead><tbody>${o.lines.map((l) => `<tr data-line="${l.id}"><td>${esc(l.item)}${l.itemCancelled ? ' <span class="pill dim">item cancelled</span>' : ''}<div class="sub">${esc(l.groupOrder)}${l.note ? ` · ${esc(l.note)}` : ''}</div></td><td>${l.qty}</td><td><input type="number" min="0" max="${l.qty}" value="${l.arrived}" data-arrived="${l.id}" style="width:72px; padding:5px 8px"></td><td><button class="sm secondary danger" data-act="del-line" data-id="${l.id}" aria-label="Remove ${esc(l.item)} from this order">✕</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No items on this order yet.</td></tr>'}</tbody></table></div>
      ${addingLine === o.id ? `<form data-form="add-line" data-id="${o.id}" style="margin-top:6px">${lineRow()}<div class="btn-row"><button class="sm" type="submit">Add</button><button class="sm secondary" type="button" data-act="add-line-close">Cancel</button></div><p class="msg" data-msg hidden></p></form>` : `<button class="sm secondary" data-act="add-line" data-id="${o.id}" style="margin-top:6px">+ Add an item</button>`}
      <div style="margin-top:10px"><div class="sub" style="font-weight:600">Tracking to your warehouse</div>${o.shipments.map((s) => { const url = trackUrl(s.carrier, s.trackingNo); return `<div class="itemrow" data-ship="${s.id}" style="padding:6px 0"><div class="grow">${s.carrier ? `${esc(s.carrier)} · ` : ''}<strong>${esc(s.trackingNo)}</strong> <button class="sm secondary" data-act="copy" data-text="${esc(s.trackingNo)}">Copy</button>${url ? ` <a href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-track>Track ↗</a>` : ''}</div><div>${s.arrivedOn ? `<span class="pill ok">arrived ${fmtDate(s.arrivedOn)}</span>` : `<button class="sm secondary" data-act="ship-arrived" data-id="${s.id}">Mark arrived</button>`}<button class="sm secondary danger" data-act="del-ship" data-id="${s.id}" aria-label="Remove tracking number">✕</button></div></div>`; }).join('') || '<div class="sub">None yet.</div>'}
        ${addingShip === o.id ? `<form data-form="add-ship" data-id="${o.id}" class="formgrid" style="margin-top:6px"><div><select name="carrier">${carrierOptions('')}</select></div><div class="span2"><input name="trackingNo" placeholder="Tracking number" maxlength="40"></div><div class="btn-row" style="margin:0"><button class="sm" type="submit">Add</button><button class="sm secondary" type="button" data-act="add-ship-close">Done</button></div></form><p class="msg" data-ship-msg="${o.id}" hidden></p>` : `<button class="sm secondary" data-act="add-ship" data-id="${o.id}" style="margin-top:6px">+ Add tracking number</button>`}</div></div>`;
  }
  function editForm(o) {
    const names = data.proxies;
    return `<form data-form="edit-order" data-id="${o.id}" class="formgrid" style="margin:8px 0; padding:10px; border:1px solid var(--line); border-radius:12px">
      <div><label>Store</label><input name="store" value="${esc(o.store)}" required maxlength="120"></div><div><label>Order number</label><input name="orderRef" value="${esc(o.orderRef || '')}" maxlength="120"></div>
      <div><label>Ordered on</label><input name="orderedOn" type="date" value="${esc(o.orderedOn)}" required></div><div><label>Placed by</label><select name="proxy"><option value="">Me</option>${names.map((n) => `<option ${n === o.proxy ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
      <div class="span2"><label>Link to the order</label><input name="orderUrl" value="${esc(o.orderUrl || '')}" placeholder="https://…" maxlength="500"></div><div class="full"><label>Notes</label><textarea name="notes" rows="2" maxlength="2000" style="width:100%">${esc(o.notes || '')}</textarea></div>
      <div class="full btn-row"><button class="sm" type="submit">Save</button>${o.status === 'cancelled' ? '<button class="sm secondary" type="button" data-act="reopen" data-id="' + o.id + '">Reopen</button>' : `<button class="sm secondary" type="button" data-act="cancel-order" data-id="${o.id}">Cancel this store order</button>`}<button class="sm secondary danger" type="button" data-act="del-order" data-id="${o.id}">Delete</button></div><p class="msg full" data-msg hidden></p></form>`;
  }
  function newForm() {
    const stores = [...new Set(data.orders.map((o) => o.store))];
    return `<form class="card" data-form="new-order" id="newOrder"><h2>New store order</h2><datalist id="storeList">${stores.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
      <div class="formgrid"><div><label>Store</label><input name="store" list="storeList" required maxlength="120" placeholder="e.g. Ktown4u, Weverse Shop"></div><div><label>Order number</label><input name="orderRef" maxlength="120"></div>
        <div><label>Ordered on</label><input name="orderedOn" type="date" value="${today()}" required></div><div><label>Placed by</label><select name="proxy"><option value="">Me</option>${data.proxies.map((n) => `<option>${esc(n)}</option>`).join('')}</select></div>
        <div class="span2"><label>Link to the order / confirmation</label><input name="orderUrl" placeholder="https://…" maxlength="500"></div></div>
      <div class="sub" style="margin:12px 0 4px; font-weight:600">What's on it</div><div id="lineRows">${lineRow()}</div><button type="button" class="sm secondary" data-act="more-lines">+ Another item</button>
      <div class="sub" style="margin:12px 0 4px; font-weight:600">Tracking numbers to your warehouse (add them now or later)</div><div id="shipRows">${shipRow()}</div><button type="button" class="sm secondary" data-act="more-ships">+ Another tracking number</button>
      <label>Notes</label><textarea name="notes" rows="2" maxlength="2000" style="width:100%" placeholder="e.g. limit 3 per order"></textarea>
      <p class="msg" data-msg hidden></p><div class="btn-row"><button type="submit">Save store order</button><button type="button" class="secondary" data-act="new-close">Cancel</button></div></form>`;
  }
  function draw() {
    const list = data.orders.filter((o) => filter === 'all' || filter === 'items' || (filter === 'waiting' ? o.state === 'waiting' || o.state === 'part' : o.state === filter));
    const sorted = filter === 'waiting' ? list.slice().sort((a, b) => String(a.orderedOn).localeCompare(String(b.orderedOn))) : list;
    const n = (st) => data.orders.filter((o) => (st === 'waiting' ? o.state === 'waiting' || o.state === 'part' : o.state === st)).length;
    const t = data.totals;
    root.innerHTML = `<h1 style="margin:18px 0 10px">Warehouse</h1>${GOM.whSwitch('incoming')}
      <div class="card" id="incomingSummary"><div class="row"><div>${t.waiting ? `<strong>${plural(t.waiting, 'store order', 'store orders')} waiting</strong>${t.toChase ? ` · <span class="pill warn" data-to-chase>${t.toChase} to chase</span>` : ''}` : '<strong>Nothing outstanding</strong>'}${t.missingCopies ? ` <span class="sub">· ${plural(t.missingCopies, 'copy', 'copies')} still on the way</span>` : ''}</div><button data-act="new" style="margin:0">+ New store order</button></div>
        <details style="margin-top:8px" ${data.warehouseAddress ? '' : 'open'}><summary>Your warehouse address</summary>${data.warehouseAddress ? `<pre data-address style="white-space:pre-wrap; margin:6px 0; font:inherit">${esc(data.warehouseAddress)}</pre><button class="sm secondary" data-act="copy" data-text="${esc(data.warehouseAddress)}">Copy address</button>` : '<p class="sub">Save it here once and copy it into any store\'s checkout.</p>'}
          <form data-form="address" style="margin-top:8px"><textarea name="address" rows="4" maxlength="600" style="width:100%" placeholder="Name, address and contact number at your Korean warehouse">${esc(data.warehouseAddress)}</textarea><div class="btn-row"><button class="sm" type="submit">Save address</button></div></form></details></div>
      ${showNew ? newForm() : ''}
      <div class="chips" id="orderFilter" role="group" aria-label="Which store orders">${[['waiting', 'Waiting'], ['arrived', 'Arrived'], ['cancelled', 'Cancelled'], ['all', 'All'], ['items', 'By item']].map(([k, l]) => `<button type="button" class="chip ${filter === k ? 'on' : ''}" data-act="filter" data-k="${k}" aria-pressed="${filter === k}">${l}${k === 'all' || k === 'items' ? '' : `<span class="n">${n(k)}</span>`}</button>`).join('')}</div>
      ${filter === 'items' ? counts() : sorted.length ? sorted.map(orderCard).join('') : `<div class="card"><p class="muted">${filter === 'waiting' ? 'No store orders are waiting. Add one when you order from a shop.' : 'Nothing here.'}</p></div>`}`;
  }
  const fail = (card, text) => { const m = $('[data-msg]', card); if (m) { m.textContent = text; m.hidden = !text; } else GOM.toast(text, true); };
  const val = (f, n) => f.elements[n]?.value?.trim() ?? '';

  async function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, id = Number(b.dataset.id);
    if (act === 'wh-view') { GOM.whView = b.dataset.view; return GOM.showTab('warehouse'); }
    if (act === 'new') { showNew = !showNew; draw(); return $('#newOrder input[name="store"]', root)?.focus(); }
    if (act === 'new-close') { showNew = false; return draw(); }
    if (act === 'more-lines') { $('#lineRows', root).insertAdjacentHTML('beforeend', lineRow()); return; }
    if (act === 'more-ships') { $('#shipRows', root).insertAdjacentHTML('beforeend', shipRow()); return; }
    if (act === 'filter') { filter = b.dataset.k; return draw(); }
    if (act === 'edit') { editing = editing === id ? null : id; return draw(); }
    if (act === 'add-line') { addingLine = id; return draw(); }
    if (act === 'add-line-close') { addingLine = null; return draw(); }
    if (act === 'add-ship') { addingShip = id; draw(); return $('[data-form="add-ship"] input', root)?.focus(); }
    if (act === 'add-ship-close') { addingShip = null; return draw(); }
    if (act === 'copy') { try { await navigator.clipboard.writeText(b.dataset.text); GOM.toast('Copied.'); } catch { GOM.alert(`Copy this:\n\n${b.dataset.text}`); } return; }
    const call = async (method, path, body, msg) => { const r = await api(method, path, body); if (!r.ok) return GOM.toast(errText(r), true); await render(root); if (msg) GOM.toast(msg); };
    if (act === 'arrived-all') { if (!(await GOM.confirm('Mark everything on this store order as arrived?\n\nEvery item is counted as fully arrived and every tracking number is dated today.', { ok: 'Yes, all arrived', cancel: 'Not yet' }))) return; return call('POST', `/api/admin/store-orders/${id}/arrived-all`, {}, 'Marked as arrived.'); }
    if (act === 'chased') return call('PATCH', `/api/admin/store-orders/${id}`, { lastChasedOn: today() }, 'Noted — chased today.');
    if (act === 'cancel-order') { if (!(await GOM.confirm('Cancel this store order?\n\nIts copies stop counting as ordered. You can reopen it.', { ok: 'Cancel it', cancel: 'Keep it' }))) return; editing = null; return call('PATCH', `/api/admin/store-orders/${id}`, { status: 'cancelled' }, 'Store order cancelled.'); }
    if (act === 'reopen') { editing = null; return call('PATCH', `/api/admin/store-orders/${id}`, { status: 'open' }, 'Reopened.'); }
    if (act === 'del-order') { if (!(await GOM.confirm('Delete this store order and its tracking numbers?\n\nThis only removes your record of it — no claims are changed.', { ok: 'Delete', cancel: 'Keep it' }))) return; editing = null; return call('DELETE', `/api/admin/store-orders/${id}`, undefined, 'Deleted.'); }
    if (act === 'del-line') return call('DELETE', `/api/admin/store-order-lines/${id}`);
    if (act === 'del-ship') return call('DELETE', `/api/admin/store-shipments/${id}`);
    if (act === 'ship-arrived') return call('PATCH', `/api/admin/store-shipments/${id}`, { arrivedOn: today() });
    if (act === 'advance') {                                                           // which claims should move, then the ordinary "move stage" action does it
      const to = b.dataset.to, r = await api('GET', `/api/admin/incoming/items/${id}/advance-plan?to=${to}`);
      if (!r.ok) return GOM.toast(errText(r), true);
      const p = r.json, what = to === 'ordered' ? 'ordered' : 'arrived at the warehouse';
      if (!p.moves.length) return GOM.toast(p.target === 0 ? `No copies are marked ${what} on a store order yet.` : `Nothing to move — claims already match the ${p.target} ${what}.`);
      const who = p.moves.map((m) => m.handles.map((h) => `@${h}`).join(', ')).join(', ');
      if (!(await GOM.confirm(`Move ${plural(p.moves.length, p.type === 'set' ? 'set' : 'claim', p.type === 'set' ? 'sets' : 'claims')} to “${p.stage}”?\n\nThe oldest first: ${who}.\n\n${p.ordered} ordered · ${p.arrived} arrived · ${p.needed} needed.`, { ok: 'Move them', cancel: 'Not yet' }))) return;
      const m = await api('POST', '/api/admin/claims/pipeline', { claimIds: p.claimIds, pipeline: p.stage });
      if (!m.ok) return GOM.toast(errText(m), true);
      await render(root); GOM.refreshBadges?.();
      return GOM.toast(`Moved ${plural(m.json.changed, 'claim', 'claims')}.${m.json.skipped.length ? ` ${m.json.skipped.length} left alone (${m.json.skipped[0].reason}).` : ''}`);
    }
  }
  async function onSubmit(e) {
    const f = e.target; const kind = f.dataset.form; if (!kind) return; e.preventDefault();
    const call = async (method, path, body) => { const r = await api(method, path, body); if (!r.ok) { fail(f, errText(r)); return null; } return r; };
    if (kind === 'address') { if (await call('PUT', '/api/admin/settings/warehouse-address', { address: f.elements.address.value })) { await render(root); GOM.toast('Address saved.'); } return; }
    if (kind === 'new-order') {
      const lines = $$('[data-line-row]', f).map((r) => ({ itemId: Number(r.querySelector('[name=itemId]').value), qty: Number(r.querySelector('[name=qty]').value), note: r.querySelector('[name=lnote]').value.trim() || null })).filter((l) => l.itemId || l.qty);
      if (lines.some((l) => !l.itemId || !(l.qty >= 1))) return fail(f, 'Each item line needs an item and how many.');
      const shipments = $$('[data-ship-row]', f).map((r) => ({ carrier: r.querySelector('[name=carrier]').value || null, trackingNo: r.querySelector('[name=trackingNo]').value.trim() })).filter((s) => s.trackingNo);
      const body = { store: val(f, 'store'), orderRef: val(f, 'orderRef') || null, orderedOn: val(f, 'orderedOn'), proxy: val(f, 'proxy') || null, orderUrl: val(f, 'orderUrl') || null, notes: val(f, 'notes') || null, lines, shipments };
      if (await call('POST', '/api/admin/store-orders', body)) { showNew = false; filter = 'waiting'; await render(root); GOM.toast('Store order saved.'); } return;
    }
    if (kind === 'edit-order') {
      const body = { store: val(f, 'store'), orderRef: val(f, 'orderRef') || null, orderedOn: val(f, 'orderedOn'), proxy: val(f, 'proxy') || null, orderUrl: val(f, 'orderUrl') || null, notes: val(f, 'notes') || null };
      if (await call('PATCH', `/api/admin/store-orders/${f.dataset.id}`, body)) { editing = null; await render(root); GOM.toast('Saved.'); } return;
    }
    if (kind === 'add-line') {
      const itemId = Number(f.querySelector('[name=itemId]').value), qty = Number(f.querySelector('[name=qty]').value);
      if (!itemId || !(qty >= 1)) return fail(f, 'Choose an item and how many.');
      if (await call('POST', `/api/admin/store-orders/${f.dataset.id}/lines`, { itemId, qty, note: f.querySelector('[name=lnote]').value.trim() || null })) { addingLine = null; await render(root); } return;
    }
    if (kind === 'add-ship') {
      const no = f.elements.trackingNo.value.trim(); if (!no) return;
      const r = await api('POST', `/api/admin/store-orders/${f.dataset.id}/shipments`, { carrier: f.elements.carrier.value || null, trackingNo: no });
      if (!r.ok) { const m = $(`[data-ship-msg="${f.dataset.id}"]`, root); m.textContent = errText(r); m.hidden = false; return; }
      await render(root);
    }
  }
  async function onChange(e) {
    const t = e.target;
    if (t.dataset.filter === 'group') { groupFilter = t.value; return draw(); }
    if (t.dataset.arrived) {                                                           // how many have arrived on a line: saved as you change it
      const r = await api('PATCH', `/api/admin/store-order-lines/${t.dataset.arrived}`, { arrivedQty: Number(t.value || 0) });
      if (!r.ok) GOM.toast(errText(r), true);
      await render(root);
    }
  }
  GOM.incoming = { render: async (el) => { await render(el); el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = onChange; el.oninput = null; } };
})();
