// Incoming (inside the Warehouse tab): orders placed with shops by you or a proxy — what was ordered, tracking numbers to the warehouse, what has arrived, which shop to chase,
// and a button to move the oldest claims along once copies are ordered / have arrived.
(function () {
  const { esc, fmtDate, api, errText, $, $$ } = GOM;
  let showAllItems = false;                                        // the "Show all items" tick on the item picker (default: only items with something still waiting to be ordered)
  let newPrefill = null, toOrderGroups = new Map();                  // newPrefill: the New store order form filled in from a To order group; toOrderGroups: the groups on screen, by key
  let toOrder = { rows: [], total: 0 }, toOrderBy = 'order';        // what still needs ordering (secured, not yet marked ordered), and how it is grouped: 'order' or 'proxy'
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

  // THE ITEM PICKER: a search box, not a long dropdown. It offers items that still have something WAITING to be ordered (secured claims at 'awaiting fulfillment' — the To order list's rule), unless
  // "Show all items" is ticked. Typing filters (every word you type must appear in the group order or item name, in any order); the list is grouped by group order and says how many are waiting.
  // The chosen item's id lives in a hidden input named itemId, so saving works exactly as it did with the dropdown.
  const MAX_SHOWN = 60; let comboN = 0;
  const optLabel = (o) => `${o.item} — ${o.groupOrder}`;
  const comboRow = (pre) => {
    const sel = pre?.itemId ? (data.options.find((o) => o.itemId === pre.itemId) || { itemId: pre.itemId, item: pre.title || 'This item', groupOrder: '' }) : null, id = `combo${++comboN}`;
    return `<div class="span2 combo" data-combo><input type="text" class="combo-input" data-combo-input role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="${id}" autocomplete="off" spellcheck="false" placeholder="Which item? Start typing…" aria-label="Item" value="${sel ? esc(sel.groupOrder ? optLabel(sel) : sel.item) : ''}"><input type="hidden" name="itemId" value="${sel ? sel.itemId : ''}"><div class="combo-list" id="${id}" role="listbox" hidden></div></div>`;
  };
  const showAllTick = () => `<label class="chk" style="margin:8px 0 0"><input type="checkbox" data-act="show-all-items" ${showAllItems ? 'checked' : ''}> Show all items (even ones with nothing waiting)</label>`;
  const comboMatches = (q) => { const words = q.toLowerCase().split(/\s+/).filter(Boolean); return data.options.filter((o) => (showAllItems || o.waiting > 0) && words.every((w) => `${o.groupOrder} ${o.item}`.toLowerCase().includes(w))); };
  function comboOpen(combo, q) {
    const list = $('.combo-list', combo), input = $('[data-combo-input]', combo), all = comboMatches(q), shown = all.slice(0, MAX_SHOWN);
    if (!all.length) list.innerHTML = `<div class="combo-empty" data-combo-empty>No items match${q.trim() ? ` “${esc(q.trim())}”` : ''}${showAllItems ? '' : ' that are waiting to be ordered. Tick “Show all items” to include the rest'}.</div>`;
    else {
      const by = new Map(); for (const o of shown) { if (!by.has(o.groupOrder)) by.set(o.groupOrder, []); by.get(o.groupOrder).push(o); }
      list.innerHTML = [...by.entries()].map(([g, items]) => `<div class="combo-group" role="presentation">${esc(g)}</div>${items.map((o) => `<div class="combo-opt" role="option" id="${list.id}-${o.itemId}" data-id="${o.itemId}" aria-selected="false"><span>${esc(o.item)}</span><span class="sub" data-waiting> — ${o.waiting ? `${o.waiting} waiting` : 'none waiting'}</span></div>`).join('')}`).join('')
        + (all.length > shown.length ? `<div class="combo-empty">…and ${all.length - shown.length} more — keep typing to narrow it down.</div>` : '');
    }
    list.hidden = false; input.setAttribute('aria-expanded', 'true'); input.removeAttribute('aria-activedescendant');
  }
  function comboClose(combo) { const list = $('.combo-list', combo), input = $('[data-combo-input]', combo); list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
  function comboMove(combo, delta) {
    const list = $('.combo-list', combo), input = $('[data-combo-input]', combo), opts = $$('.combo-opt', list); if (!opts.length) return;
    let i = opts.findIndex((o) => o.getAttribute('aria-selected') === 'true'); opts.forEach((o) => o.setAttribute('aria-selected', 'false')); i = i < 0 ? (delta > 0 ? 0 : opts.length - 1) : (i + delta + opts.length) % opts.length;
    opts[i].setAttribute('aria-selected', 'true'); input.setAttribute('aria-activedescendant', opts[i].id); opts[i].scrollIntoView?.({ block: 'nearest' });
  }
  function comboPick(combo, opt) {
    const o = data.options.find((x) => x.itemId === Number(opt.dataset.id)); if (!o) return;
    $('[name=itemId]', combo).value = String(o.itemId); const input = $('[data-combo-input]', combo); input.value = optLabel(o); input.removeAttribute('aria-invalid'); comboClose(combo);
  }
  function wireCombos(el) {
    if (el._comboWired) return; el._comboWired = true;
    const combo = (e) => e.target.closest?.('[data-combo]');
    el.addEventListener('input', (e) => { const c = e.target.matches?.('[data-combo-input]') && combo(e); if (!c) return; $('[name=itemId]', c).value = ''; e.target.removeAttribute('aria-invalid'); comboOpen(c, e.target.value); });
    el.addEventListener('focusin', (e) => { const c = e.target.matches?.('[data-combo-input]') && combo(e); if (!c) return; e.target.select?.(); comboOpen(c, $('[name=itemId]', c).value ? '' : e.target.value); });
    el.addEventListener('click', (e) => { const c = e.target.matches?.('[data-combo-input]') && combo(e); if (c && $('.combo-list', c).hidden) comboOpen(c, $('[name=itemId]', c).value ? '' : e.target.value); });
    el.addEventListener('mousedown', (e) => { const opt = e.target.closest?.('.combo-opt'); if (!opt) return; e.preventDefault(); comboPick(combo({ target: opt }), opt); });          // mousedown, so the box doesn't lose focus first
    el.addEventListener('focusout', (e) => { const c = e.target.matches?.('[data-combo-input]') && combo(e); if (!c) return; comboClose(c); if (e.target.value.trim() && !$('[name=itemId]', c).value) e.target.setAttribute('aria-invalid', 'true'); });
    el.addEventListener('keydown', (e) => {
      const c = e.target.matches?.('[data-combo-input]') && combo(e); if (!c) return; const list = $('.combo-list', c), open = !list.hidden;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!open) comboOpen(c, $('[name=itemId]', c).value ? '' : e.target.value); comboMove(c, e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'Enter' && open) { e.preventDefault(); const active = $('.combo-opt[aria-selected="true"]', list), only = $$('.combo-opt', list); if (active) comboPick(c, active); else if (only.length === 1) comboPick(c, only[0]); }       // never submits the form while the list is open
      else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); comboClose(c); }
    });
  }
  const carrierOptions = (sel) => `<option value="">Carrier…</option>${CARRIERS.map(([n]) => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
  const lineRow = (pre) => `<div class="formgrid" data-line-row style="margin-bottom:6px">${comboRow(pre)}<div><input name="qty" type="number" min="1" max="9999" placeholder="How many" inputmode="numeric" value="${pre ? esc(pre.qty) : ''}"></div><div><input name="lnote" placeholder="Note (e.g. ver. A)" maxlength="200" value="${pre ? esc(pre.note || '') : ''}"></div></div>`;
  const shipRow = () => `<div class="formgrid" data-ship-row style="margin-bottom:6px"><div><select name="carrier">${carrierOptions('')}</select></div><div class="span2"><input name="trackingNo" placeholder="Tracking number to your warehouse" maxlength="40"></div></div>`;

  async function render(el) {
    root = el; const [r, t] = await Promise.all([api('GET', '/api/admin/incoming'), api('GET', '/api/admin/incoming/to-order')]); data = r.json; toOrder = t.json || { rows: [], total: 0 }; draw();
  }
  // ── To order: secured claims that are still waiting to be ordered, counted per option ──
  function toOrderCard() {
    const rows = toOrder.rows;
    if (!rows.length) return `<div class="card" data-to-order><h2>To order</h2><p class="muted" style="margin:0">Nothing is waiting to be ordered — everything that has been secured is marked as ordered. 🎉</p></div>`;
    const orders = new Map();                                                                                 // group order → item → options
    for (const r of rows) {
      if (!orders.has(r.orderId)) orders.set(r.orderId, { id: r.orderId, title: r.order, proxies: new Set(), items: new Map() });
      const o = orders.get(r.orderId); o.proxies.add(r.proxy || 'Me');
      if (!o.items.has(r.itemId)) o.items.set(r.itemId, { id: r.itemId, title: r.item, proxy: r.proxy || 'Me', options: [], total: 0 });
      const it = o.items.get(r.itemId); it.options.push({ option: r.option, qty: r.qty }); it.total += r.qty;
    }
    const itemLine = (it) => `${it.title}: ${it.options.some((x) => x.option) ? it.options.map((x) => `${x.qty}× ${x.option || 'no option'}`).join(', ') : `${it.total}×`}`;
    const itemHtml = (it, showProxy) => `<div class="itemrow" data-to-order-item="${it.id}"><div class="grow"><strong>${esc(it.title)}</strong> <span class="sub">${it.total} in all${showProxy ? ` · ${esc(it.proxy)}` : ''}</span>
        <div style="margin-top:4px">${it.options.some((x) => x.option) ? it.options.map((x) => `<span class="pill" data-option>${x.qty}× ${esc(x.option || 'no option')}</span>`).join(' ') : `<span class="pill" data-option>${it.total}×</span>`}</div></div></div>`;
    const groups = toOrderBy === 'order'
      ? [...orders.values()].map((o) => ({ key: `o${o.id}`, title: o.title, sub: [...o.proxies].join(', '), body: [...o.items.values()].map((it) => itemHtml(it, o.proxies.size > 1)).join(''), text: `${o.title} (${[...o.proxies].join(', ')})\n${[...o.items.values()].map(itemLine).join('\n')}`, total: [...o.items.values()].reduce((n, it) => n + it.total, 0) }))
      : [...new Set(rows.map((r) => r.proxy || 'Me'))].map((px) => {
          const mine = [...orders.values()].map((o) => ({ o, items: [...o.items.values()].filter((it) => it.proxy === px) })).filter((x) => x.items.length);
          return { key: `p${px}`, title: px === 'Me' ? 'Me (no proxy)' : px, sub: `${mine.length} group order${mine.length === 1 ? '' : 's'}`, body: mine.map((x) => `<div class="sub" style="margin:8px 0 2px; font-weight:600">${esc(x.o.title)}</div>${x.items.map((it) => itemHtml(it, false)).join('')}`).join(''),
            text: `${px === 'Me' ? 'Me (no proxy)' : px}\n${mine.map((x) => `${x.o.title}\n${x.items.map((it) => `  ${itemLine(it)}`).join('\n')}`).join('\n')}`, total: mine.reduce((n, x) => n + x.items.reduce((m, it) => m + it.total, 0), 0) };
        });
    // what the New store order form is filled in with: one line per item (how many, and the options in the line's note — kept within the note's 200 characters)
    const noteOf = (it) => { const t = it.options.some((x) => x.option) ? it.options.map((x) => `${x.qty}× ${x.option || 'no option'}`).join(', ') : ''; return t.length > 200 ? `${t.slice(0, 199)}…` : t; };
    const linesOf = (items) => items.map((it) => ({ itemId: it.id, title: it.title, qty: it.total, note: noteOf(it) }));
    toOrderGroups = new Map();
    for (const g of groups) {
      const items = toOrderBy === 'order' ? [...orders.get(Number(g.key.slice(1))).items.values()] : [...orders.values()].flatMap((o) => [...o.items.values()].filter((it) => it.proxy === g.key.slice(1)));
      const proxies = [...new Set(items.map((it) => it.proxy))];
      toOrderGroups.set(g.key, { from: g.title, proxy: proxies.length === 1 && proxies[0] !== 'Me' ? proxies[0] : null, lines: linesOf(items) });
    }
    const all = groups.map((g) => g.text).join('\n\n');
    return `<div class="card" data-to-order><div class="row"><div><h2 style="margin:0">To order</h2><div class="sub">${plural(toOrder.total, 'copy', 'copies')} secured and waiting to be ordered. They leave this list once they are moved to “ordered” (Claims → Stage, or <em>Mark ordered…</em> under By item after you've logged the store order).</div></div>
        <div class="btn-row" style="margin:0"><span role="group" aria-label="Group by" style="display:inline-flex; gap:6px"><button class="sm ${toOrderBy === 'order' ? '' : 'secondary'}" data-act="to-by" data-by="order" aria-pressed="${toOrderBy === 'order'}">By group order</button><button class="sm ${toOrderBy === 'proxy' ? '' : 'secondary'}" data-act="to-by" data-by="proxy" aria-pressed="${toOrderBy === 'proxy'}">By proxy</button></span>
        <button class="sm secondary" data-act="copy" data-text="${esc(all)}" data-copy-all>Copy all</button></div></div></div>
      ${groups.map((g) => `<div class="card" data-to-order-group="${esc(g.key)}"><div class="row"><div><strong>${esc(g.title)}</strong> <span class="sub">· ${plural(g.total, 'copy', 'copies')}${g.sub ? ` · ${esc(g.sub)}` : ''}</span></div><div class="btn-row" style="margin:0"><button class="sm" data-act="log-order" data-key="${esc(g.key)}" title="Open a new store order with these items already filled in">Log as a store order…</button><button class="sm secondary" data-act="copy" data-text="${esc(g.text)}">Copy list</button></div></div>${g.body}</div>`).join('')}`;
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
      ${addingLine === o.id ? `<form data-form="add-line" data-id="${o.id}" style="margin-top:6px">${lineRow()}<div style="margin:2px 0 8px">${showAllTick()}</div><div class="btn-row"><button class="sm" type="submit">Add</button><button class="sm secondary" type="button" data-act="add-line-close">Cancel</button></div><p class="msg" data-msg hidden></p></form>` : `<button class="sm secondary" data-act="add-line" data-id="${o.id}" style="margin-top:6px">+ Add an item</button>`}
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
    return `<form class="card" data-form="new-order" id="newOrder"><h2>New store order</h2>${newPrefill ? `<p class="sub" data-prefill style="margin:0 0 10px">Filled in from <strong>${esc(newPrefill.from)}</strong> on your To order list — check the quantities, add the store, then save.</p>` : ''}<datalist id="storeList">${stores.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
      <div class="formgrid"><div><label>Store</label><input name="store" list="storeList" required maxlength="120" placeholder="e.g. Ktown4u, Weverse Shop"></div><div><label>Order number</label><input name="orderRef" maxlength="120"></div>
        <div><label>Ordered on</label><input name="orderedOn" type="date" value="${today()}" required></div><div><label>Placed by</label><select name="proxy"><option value="">Me</option>${data.proxies.map((n) => `<option ${n === newPrefill?.proxy ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
        <div class="span2"><label>Link to the order / confirmation</label><input name="orderUrl" placeholder="https://…" maxlength="500"></div></div>
      <div class="sub" style="margin:12px 0 4px; font-weight:600">What's on it</div><div id="lineRows">${newPrefill?.lines?.length ? newPrefill.lines.map((l) => lineRow(l)).join('') : lineRow()}</div><button type="button" class="sm secondary" data-act="more-lines">+ Another item</button> ${showAllTick()}
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
      <div class="chips" id="orderFilter" role="group" aria-label="Which store orders">${[['toorder', `To order${toOrder.total ? ` (${toOrder.total})` : ''}`], ['waiting', 'Waiting'], ['arrived', 'Arrived'], ['cancelled', 'Cancelled'], ['all', 'All'], ['items', 'By item']].map(([k, l]) => `<button type="button" class="chip ${filter === k ? 'on' : ''}" data-act="filter" data-k="${k}" aria-pressed="${filter === k}">${l}${k === 'all' || k === 'items' || k === 'toorder' ? '' : `<span class="n">${n(k)}</span>`}</button>`).join('')}</div>
      ${filter === 'toorder' ? toOrderCard() : filter === 'items' ? counts() : sorted.length ? sorted.map(orderCard).join('') : `<div class="card"><p class="muted">${filter === 'waiting' ? 'No store orders are waiting. Add one when you order from a shop.' : 'Nothing here.'}</p></div>`}`;
  }
  const fail = (card, text) => { const m = $('[data-msg]', card); if (m) { m.textContent = text; m.hidden = !text; } else GOM.toast(text, true); };
  const val = (f, n) => f.elements[n]?.value?.trim() ?? '';

  async function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, id = Number(b.dataset.id);
    if (act === 'wh-view') { GOM.whView = b.dataset.view; return GOM.showTab('warehouse'); }
    if (act === 'new') { showNew = !showNew; newPrefill = null; draw(); return $('#newOrder input[name="store"]', root)?.focus(); }
    if (act === 'new-close') { showNew = false; newPrefill = null; return draw(); }
    if (act === 'log-order') {                                                        // the To order list → a New store order with its items already in
      const g = toOrderGroups.get(b.dataset.key); if (!g) return;
      newPrefill = g; showNew = true; draw(); const f = $('#newOrder', root); f?.scrollIntoView?.({ block: 'start' }); return $('input[name="store"]', f)?.focus();
    }
    if (act === 'show-all-items') { showAllItems = b.checked; $$('[data-act="show-all-items"]', root).forEach((c) => { c.checked = showAllItems; }); return; }
    if (act === 'more-lines') { $('#lineRows', root).insertAdjacentHTML('beforeend', lineRow()); return; }
    if (act === 'more-ships') { $('#shipRows', root).insertAdjacentHTML('beforeend', shipRow()); return; }
    if (act === 'filter') { filter = b.dataset.k; return draw(); }
    if (act === 'to-by') { toOrderBy = b.dataset.by; return draw(); }
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
      const unchosen = $$('[data-line-row]', f).find((r) => r.querySelector('[data-combo-input]').value.trim() && !r.querySelector('[name=itemId]').value);
      if (unchosen) { const b = unchosen.querySelector('[data-combo-input]'); b.setAttribute('aria-invalid', 'true'); b.focus?.(); return fail(f, `Choose “${b.value.trim()}” from the list — start typing, then pick the item.`); }
      if (lines.some((l) => !l.itemId || !(l.qty >= 1))) return fail(f, 'Each item line needs an item and how many.');
      const shipments = $$('[data-ship-row]', f).map((r) => ({ carrier: r.querySelector('[name=carrier]').value || null, trackingNo: r.querySelector('[name=trackingNo]').value.trim() })).filter((s) => s.trackingNo);
      const body = { store: val(f, 'store'), orderRef: val(f, 'orderRef') || null, orderedOn: val(f, 'orderedOn'), proxy: val(f, 'proxy') || null, orderUrl: val(f, 'orderUrl') || null, notes: val(f, 'notes') || null, lines, shipments };
      if (await call('POST', '/api/admin/store-orders', body)) { const fromList = !!newPrefill; showNew = false; newPrefill = null; filter = fromList ? 'toorder' : 'waiting'; await render(root); GOM.toast(fromList ? 'Store order saved. To move those claims on, use “Mark ordered…” under By item.' : 'Store order saved.'); } return;
    }
    if (kind === 'edit-order') {
      const body = { store: val(f, 'store'), orderRef: val(f, 'orderRef') || null, orderedOn: val(f, 'orderedOn'), proxy: val(f, 'proxy') || null, orderUrl: val(f, 'orderUrl') || null, notes: val(f, 'notes') || null };
      if (await call('PATCH', `/api/admin/store-orders/${f.dataset.id}`, body)) { editing = null; await render(root); GOM.toast('Saved.'); } return;
    }
    if (kind === 'add-line') {
      const itemId = Number(f.querySelector('[name=itemId]').value), qty = Number(f.querySelector('[name=qty]').value);
      const tb = f.querySelector('[data-combo-input]'), typed = tb.value.trim(); if (!itemId && typed) { tb.setAttribute('aria-invalid', 'true'); return fail(f, `Choose “${typed}” from the list — start typing, then pick the item.`); }
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
  GOM.incoming = { render: async (el) => { await render(el); wireCombos(el); el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = onChange; el.oninput = null; } };
})();
