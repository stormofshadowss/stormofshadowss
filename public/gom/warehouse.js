// Warehouse tab: boxes coming in from your proxy. Pick the items that have arrived at the proxy, enter what EMS (and customs) actually charged,
// and the cost is shared between them — EMS by weight, customs by value. Then take the box through en route → arrived → ready to pack.
(function () {
  const { esc, money, api, errText, $, $$ } = GOM;
  let root = null, candidates = [], boxes = [], search = '', selected = new Set(), preview = null, note = '';
  const val = (id) => ($(`#${id}`, root) || {}).value || '';
  const num = (id) => Number(val(id)) || 0;

  async function render(el) {
    root = el;
    const [c, b] = await Promise.all([api('GET', '/api/admin/boxes/candidates'), api('GET', `/api/admin/boxes${search ? `?q=${encodeURIComponent(search)}` : ''}`)]);
    candidates = c.json?.candidates || []; boxes = b.json?.boxes || [];
    selected = new Set([...selected].filter((id) => candidates.some((x) => x.claimId === id)));
    draw(); await refreshPreview();
  }

  const STATUS = { shipping_requested: ['warn', 'Shipping requested'], enroute: ['info', 'En route to GOM'], arrived: ['ok', 'Arrived at GOM'] };
  const ITEM = { ready: ['ok', 'Ready to pack'], checking: ['warn', 'Checking parcel'] };

  function candidatesCard() {
    return `<div class="card"><h2>New box</h2>
      <p class="sub">Tick the items going in this box (only items that have arrived at your proxy appear). Enter an exact weight where you have one — items without one share the box's real weight by size.</p>
      <div class="scroll"><table class="grid"><thead><tr><th></th><th>Person</th><th>Item</th><th>Size</th><th>Weight (g)</th><th>Price</th></tr></thead><tbody>
      ${candidates.length ? candidates.map((c) => `<tr data-cand="${c.claimId}"><td><input type="checkbox" data-act="pick" data-id="${c.claimId}" ${selected.has(c.claimId) ? 'checked' : ''}></td>
        <td>@${esc(c.handle)}</td><td>${esc(c.label)} <span class="sub">${esc(c.orderTitle)}</span></td>
        <td><select data-act="size" data-id="${c.claimId}" style="width:auto">${['XS', 'S', 'M', 'L', 'XL'].map((s) => `<option ${s === c.size ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
        <td><input type="number" min="1" step="1" data-act="weight" data-id="${c.claimId}" value="${c.weightG ?? ''}" placeholder="est." style="width:90px"></td><td>${money(c.price)}</td></tr>`).join('')
        : '<tr><td colspan="6" class="muted">Nothing is waiting to be boxed. Items appear here once their pipeline stage is "arrived at proxy / warehouse".</td></tr>'}</tbody></table></div>
      <div class="formgrid" style="margin-top:12px">
        <div><label for="boxEms">EMS total (£) — what you were charged</label><input id="boxEms" type="number" step="0.01" min="0"></div>
        <div><label for="boxCustoms">Customs total (£), if you already know it</label><input id="boxCustoms" type="number" step="0.01" min="0"></div>
        <div><label for="boxWeight">Total box weight (g), optional</label><input id="boxWeight" type="number" min="0" step="1"></div>
        <div><label for="boxTracking">Tracking ID (internal only)</label><input id="boxTracking" maxlength="80"></div></div>
      <div id="boxPreview"></div>
      <div class="btn-row"><button data-act="create">Create box</button><span class="msg" id="boxMsg" hidden></span></div></div>`;
  }

  function previewHtml() {
    if (!selected.size) return '<p class="sub" style="margin-top:12px">Select at least one item above to see the split.</p>';
    if (!preview) return '';
    if (preview.error) return `<p class="msg" style="margin-top:12px">${esc(preview.error)}</p>`;
    return `<div class="scroll"><table class="grid" style="margin-top:12px"><thead><tr><th>Person</th><th>Item</th><th>Weight used</th><th>EMS share</th><th>Customs share</th></tr></thead><tbody>
      ${preview.rows.map((r) => { const c = candidates.find((x) => x.claimId === r.claimId); return `<tr><td>@${esc(c?.handle || '')}</td><td>${esc(r.label)}</td><td>${r.weightUsedG}g${r.estimated ? ' <span class="sub">(est.)</span>' : ''}</td><td>${money(r.emsShare)}</td><td>${money(r.customsShare)}</td></tr>`; }).join('')}</tbody></table></div>
      ${preview.note ? `<p class="sub" style="margin-top:6px">${esc(preview.note)}</p>` : ''}`;
  }

  function boxCard(b) {
    const [cls, label] = STATUS[b.status];
    return `<div class="card" data-box="${b.id}" style="background:var(--paper)"><div class="row"><div><strong>Box #${b.id}</strong> <span class="pill ${cls}">${label}</span>
        <div class="sub" style="margin-top:6px">${b.items.map((i) => `@${esc(i.handle)} — ${esc(i.label)}${i.itemStatus && ITEM[i.itemStatus] ? ` <span class="pill ${ITEM[i.itemStatus][0]}">${ITEM[i.itemStatus][1]}</span>` : ''}`).join(' · ')}</div>
        <div class="sub">EMS total: ${money(b.emsTotal)}${b.totalWeightG ? ` · Box weight: ${b.totalWeightG}g` : ''}${b.customsTotal > 0 ? ` · Customs total: ${money(b.customsTotal)}` : ' · Customs: not added yet'}</div></div>
      <div class="btn-row" style="margin:0">${b.status === 'shipping_requested' ? `<button class="sm" data-act="enroute" data-id="${b.id}">Mark en route</button>` : ''}${b.status === 'enroute' ? `<button class="sm" data-act="arrived" data-id="${b.id}">Mark arrived</button>` : ''}${b.status !== 'arrived' ? `<button class="sm secondary" data-act="undo" data-id="${b.id}">Undo box</button>` : ''}</div></div>
      ${b.status === 'arrived' ? `<div style="margin-top:12px; padding-top:12px; border-top:1px solid var(--line)"><strong style="font-size:.85rem">Mark ready to pack</strong>
        <p class="sub">Untick anything that isn't actually fine before saving — those stay at "checking parcel" instead of moving on.</p>
        ${b.items.map((i) => `<label class="chk" style="display:flex; margin-bottom:6px"><input type="checkbox" data-ready="${b.id}" data-claim="${i.claimId}" ${i.itemStatus !== 'checking' ? 'checked' : ''}> @${esc(i.handle)} — ${esc(i.label)}</label>`).join('')}
        <button class="sm" data-act="ready" data-id="${b.id}">Save ready-to-pack selections</button></div>` : ''}
      <div class="formgrid" style="margin-top:12px; align-items:end"><div><label>Tracking ID (internal only)</label><input data-track="${b.id}" value="${esc(b.trackingId || '')}" placeholder="not yet known" maxlength="80"></div>
        <div><button class="sm secondary" data-act="track" data-id="${b.id}">Save</button></div>
        <div><label>${b.customsTotal > 0 ? 'Update customs total (£)' : 'Add customs total (£)'}</label><input type="number" step="0.01" min="0" data-customs="${b.id}" value="${b.customsTotal > 0 ? b.customsTotal : ''}" placeholder="e.g. 14.50"></div>
        <div><button class="sm secondary" data-act="customs" data-id="${b.id}">${b.customsTotal > 0 ? 'Update' : 'Apply'} customs split</button></div></div></div>`;
  }

  function boxesCard() {
    const active = boxes.filter((b) => !b.archived), done = boxes.filter((b) => b.archived);
    return `<div class="card"><div class="row"><h2 style="margin:0">Boxes</h2><input id="boxSearch" placeholder="Search box #, tracking, person or item" value="${esc(search)}" style="max-width:280px"></div>
      ${boxes.length ? '' : `<p class="muted" style="margin-top:10px">${search ? 'No boxes match that search.' : 'No boxes yet — create one above.'}</p>`}
      <div style="margin-top:10px">${active.map(boxCard).join('')}</div>
      ${done.length ? `<details style="margin-top:10px"><summary>Archived boxes (${done.length}) — fully checked and ready, kept for reference</summary>${done.map(boxCard).join('')}</details>` : ''}</div>`;
  }

  function draw() {
    const keep = { ems: val('boxEms'), customs: val('boxCustoms'), weight: val('boxWeight'), track: val('boxTracking'), q: search };
    root.innerHTML = `<h1 style="margin:18px 0 10px">Warehouse</h1>${candidatesCard()}${boxesCard()}`;
    $('#boxEms', root).value = keep.ems; $('#boxCustoms', root).value = keep.customs; $('#boxWeight', root).value = keep.weight; $('#boxTracking', root).value = keep.track;
    $('#boxPreview', root).innerHTML = previewHtml();
  }

  async function refreshPreview() {
    if (!selected.size) { preview = null; const el = $('#boxPreview', root); if (el) el.innerHTML = previewHtml(); return; }
    const r = await api('POST', '/api/admin/boxes/preview', { claimIds: [...selected], emsTotal: num('boxEms'), customsTotal: num('boxCustoms'), totalWeightG: Math.round(num('boxWeight')) });
    preview = r.ok ? r.json : { error: errText(r) };
    const el = $('#boxPreview', root); if (el) el.innerHTML = previewHtml();
  }
  const msg = (t, ok) => { const m = $('#boxMsg', root); m.textContent = t; m.className = `msg${ok ? ' ok' : ''}`; m.hidden = false; };

  async function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, id = Number(b.dataset.id);
    if (act === 'create') {
      if (!selected.size) return msg('Select at least one item first.');
      if (!(num('boxEms') > 0)) return msg("Enter an EMS total — that's what creates the box.");
      const hadCustoms = num('boxCustoms') > 0;                          // read before the form is cleared
      const r = await api('POST', '/api/admin/boxes', { claimIds: [...selected], emsTotal: num('boxEms'), customsTotal: num('boxCustoms'), totalWeightG: Math.round(num('boxWeight')), trackingId: val('boxTracking') });
      if (!r.ok) return msg(errText(r));
      selected.clear(); preview = null;
      ['boxEms', 'boxCustoms', 'boxWeight', 'boxTracking'].forEach((i) => { $(`#${i}`, root).value = ''; });
      await render(root); GOM.refreshBadges();
      return msg(`Box #${r.json.id} created — ${r.json.items} item${r.json.items === 1 ? '' : 's'} marked "shipping requested" and their EMS${hadCustoms ? '/customs' : ''} added.`, true);
    }
    if (act === 'enroute' || act === 'arrived') { const r = await api('POST', `/api/admin/boxes/${id}/${act}`, {}); await render(root); return GOM.toast(r.ok ? (act === 'arrived' ? 'Marked arrived.' : 'Marked en route.') : errText(r), !r.ok); }
    if (act === 'undo') {
      const ok = await GOM.confirm(`Undo box #${id}?\n\nIts items go back to "arrived at proxy / warehouse", the EMS and customs it added come off again (anything already paid towards them is returned to each person as credit), and the box record is deleted.`, { ok: 'Undo the box', cancel: 'Keep it' });
      if (!ok) return;
      const r = await api('DELETE', `/api/admin/boxes/${id}`); await render(root); GOM.refreshBadges();
      return GOM.toast(r.ok ? `Box #${id} undone.` : errText(r), !r.ok);
    }
    if (act === 'ready') {
      const boxes_ = $$(`input[data-ready="${id}"]`, root);
      const r = await api('POST', `/api/admin/boxes/${id}/ready`, { ready: boxes_.filter((x) => x.checked).map((x) => Number(x.dataset.claim)), checking: boxes_.filter((x) => !x.checked).map((x) => Number(x.dataset.claim)) });
      await render(root); return GOM.toast(r.ok ? 'Saved.' : errText(r), !r.ok);
    }
    if (act === 'track') { const r = await api('PATCH', `/api/admin/boxes/${id}`, { trackingId: $(`input[data-track="${id}"]`, root).value }); await render(root); return GOM.toast(r.ok ? 'Tracking saved.' : errText(r), !r.ok); }
    if (act === 'customs') {
      const total = Number($(`input[data-customs="${id}"]`, root).value) || 0;
      if (!(total > 0)) return GOM.alert('Enter a customs total first.');
      const ok = await GOM.confirm(`Set the customs total for box #${id} to ${money(total)}?\n\nIt's shared across the items by their value. Each person's customs charge is recalculated; anyone who has already paid more than their new share gets the difference back as credit.`, { ok: 'Apply customs' });
      if (!ok) return;
      const r = await api('POST', `/api/admin/boxes/${id}/customs`, { customsTotal: total }); await render(root);
      return GOM.toast(r.ok ? 'Customs applied.' : errText(r), !r.ok);
    }
  }

  async function onChange(e) {
    const t = e.target, act = t.dataset.act;
    if (act === 'pick') { t.checked ? selected.add(Number(t.dataset.id)) : selected.delete(Number(t.dataset.id)); return refreshPreview(); }
    if (act === 'size' || act === 'weight') {
      const body = act === 'size' ? { sizeBucket: t.value } : { weightG: t.value ? Math.round(Number(t.value)) : null };
      const r = await api('PATCH', `/api/admin/claims/${t.dataset.id}`, body);
      if (!r.ok) GOM.toast(errText(r), true);
      const c = await api('GET', '/api/admin/boxes/candidates'); candidates = c.json?.candidates || candidates; draw(); return refreshPreview();
    }
  }
  const onInput = (e) => {
    if (['boxEms', 'boxCustoms', 'boxWeight'].includes(e.target.id)) refreshPreview();
    if (e.target.id === 'boxSearch') { search = e.target.value.trim(); clearTimeout(onInput.t); onInput.t = setTimeout(async () => { const r = await api('GET', `/api/admin/boxes?q=${encodeURIComponent(search)}`); boxes = r.json?.boxes || []; const pos = e.target.selectionStart; draw(); const s = $('#boxSearch', root); s.focus(); s.setSelectionRange(pos, pos); await refreshPreview(); }, 120); }
  };

  GOM.registerTab({
    id: 'warehouse', label: 'Warehouse',
    badgeCount: async () => ((await api('GET', '/api/admin/boxes/candidates')).json?.candidates || []).length,
    async render(el) { await render(el); el.onclick = onClick; el.onchange = onChange; el.oninput = onInput; },
  });
})();
