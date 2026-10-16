// Shop tab: stock you already have on hand. Joiners claim it from the Shop page and it's held for them at once; it becomes ready to pack when paid,
// and shows in Overdue if it isn't paid within the item's pay-by days (you cancel it yourself, in Claims, to free the unit).
(function () {
  const { esc, money, fmtDate, api, errText, $ } = GOM;
  let root = null, items = [], editing = null, showHidden = true;
  let groups = [], picked = new Set(), groupFilter = '';       // the artists; the items ticked for "Set artist"; the Stock filter ('' = all, 'none' = no artist yet, or an artist's id)
  document.addEventListener('gom:picture', (e) => { if (e.detail.kind === 'shop') items.forEach((i) => { if (i.id === e.detail.id) i.image = e.detail.image; }); });
  const SIZES = ['XS', 'S', 'M', 'L', 'XL'];

  async function render(el) {
    root = el;
    const [s, g] = await Promise.all([api('GET', '/api/admin/shop'), api('GET', '/api/admin/groups')]);
    items = s.json?.items || []; groups = g.json?.groups || []; picked = new Set([...picked].filter((id) => items.some((i) => i.id === id)));
    draw();
  }

  const num = (form, n) => Number(form.elements[n].value);
  const fields = (it = {}) => `<div class="formgrid">
      <div class="span2"><label>Name</label><input name="title" maxlength="160" value="${esc(it.title || '')}" required></div>
      <div><label>Price (£)</label><input name="price" type="number" step="0.01" min="0.01" value="${it.price ?? ''}" required></div>
      <div><label>Quantity in stock</label><input name="qty" type="number" step="1" min="0" value="${it.qty ?? ''}" required></div>
      <div><label>Days to pay</label><input name="payDays" type="number" step="1" min="1" max="60" value="${it.payDays ?? 5}"></div>
      <div><label>Size</label><select name="size">${SIZES.map((s) => `<option ${s === (it.size || 'M') ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div><label>Artist / group</label><select name="groupId"><option value="">None (shown under “Other”)</option>${groups.map((g) => `<option value="${g.id}" ${g.id === it.groupId ? 'selected' : ''}>${esc(g.name)}${g.hidden ? ' (hidden)' : ''}</option>`).join('')}</select></div>
      <div class="span2"><label>Notes (shown to joiners)</label><input name="notes" maxlength="255" value="${esc(it.notes || '')}" placeholder="e.g. Minor corner ding, otherwise mint"></div></div>`;

  function claimRow(c) {
    return `<div class="itemrow" data-claim="${c.claimId}"><div class="grow">@${esc(c.handle)}${c.pipeline === 'ready to pack / on hand' ? ' <span class="sub">· ready to pack</span>' : ''}</div>
      <span>${c.paid ? '<span class="pill ok">paid</span>' : `<span class="pill ${c.overdue ? 'warn' : ''}">unpaid</span>`}${!c.paid && c.payBy ? ` <span class="sub">pay by ${fmtDate(c.payBy)}</span>` : ''}${c.overdue ? ' <strong style="color:var(--accent)">overdue</strong>' : ''}</span></div>`;
  }

  const groupName = (id) => groups.find((g) => g.id === id)?.name || '';
  const shownItems = () => items.filter((i) => (showHidden || i.active) && (groupFilter === '' || (groupFilter === 'none' ? !i.groupId : i.groupId === Number(groupFilter))));
  function itemCard(it) {
    if (editing === it.id) {
      return `<div class="card" data-shop="${it.id}"><h2>Edit ${esc(it.title)}</h2>
        <form data-form="edit" data-id="${it.id}">${fields(it)}${GOM.pictureControl('shop', it.id, it.image, 'Picture of this item')}
          <p class="sub">A new price or pay-by time only applies to claims made from now on — claims already made keep what they were made at. ${it.claimed ? `${it.claimed} already claimed, so the quantity can't go below that.` : ''}</p>
          <div class="btn-row"><button type="submit" class="sm">Save</button><button type="button" class="sm secondary" data-act="cancel-edit">Cancel</button><span class="msg" data-msg hidden></span></div></form></div>`;
    }
    return `<div class="card" data-shop="${it.id}" ${it.active ? '' : 'style="opacity:.7"'}>${it.image ? `<span class="picbox"><img class="thumb" src="${esc(it.image.thumb)}" alt=""></span>` : ''}<div class="row"><div><label class="chk" style="display:inline-flex; margin:0 6px 0 0"><input type="checkbox" data-act="pick" data-id="${it.id}" ${picked.has(it.id) ? 'checked' : ''} aria-label="Select ${esc(it.title)}"></label><strong>${esc(it.title)}</strong>${it.active ? '' : ' <span class="pill">hidden from joiners</span>'}
        <div class="sub">${money(it.price)} · ${it.claimed} of ${it.qty} claimed · <strong>${it.left} left</strong> · ${it.payDays} day${it.payDays === 1 ? '' : 's'} to pay · size ${esc(it.size)} · <span data-artist>${groupName(it.groupId) ? esc(groupName(it.groupId)) : '<em>no artist yet</em>'}</span></div>
        ${it.notes ? `<div class="sub">${esc(it.notes)}</div>` : ''}</div>
      <div class="btn-row" style="margin:0"><button class="sm secondary" data-act="edit" data-id="${it.id}">Edit</button><button class="sm secondary" data-act="${it.active ? 'hide' : 'show'}" data-id="${it.id}">${it.active ? 'Hide' : 'Show'}</button></div></div>
      ${it.claims.length ? `<div style="margin-top:8px">${it.claims.map(claimRow).join('')}</div>` : ''}</div>`;
  }

  function draw() {
    const visible = shownItems(), noArtist = items.filter((i) => !i.groupId).length;
    root.innerHTML = `<h1 style="margin:18px 0 10px">Shop</h1>
      <div class="card"><h2>Add a shop item</h2><p class="sub">Stock you already have. Joiners claim it from the Shop page and it's held for them straight away; it's ready to pack once they've paid.</p>
        <form data-form="add">${fields()}<div class="btn-row"><button type="submit">Add item</button><span class="msg" data-msg hidden></span></div></form></div>
      <div class="card"><div class="row"><h2 style="margin:0">Stock</h2><label class="chk"><input type="checkbox" data-act="toggle-hidden" ${showHidden ? 'checked' : ''}> Show hidden items</label></div>
        <div class="formgrid" style="margin:8px 0 0"><div><label>Show</label><select data-filter="group"><option value="">All artists</option><option value="none" ${groupFilter === 'none' ? 'selected' : ''}>No artist yet (${noArtist})</option>${groups.map((g) => `<option value="${g.id}" ${groupFilter === String(g.id) ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
          <div style="align-self:end"><button class="sm secondary" data-act="pick-all">Tick all shown (${visible.length})</button></div></div>
        ${picked.size ? `<div data-bulk style="margin-top:10px; padding:10px; border-radius:12px; background:var(--surface-2)"><strong>${picked.size} ticked</strong> — set their artist: <select name="bulkGroup" aria-label="Artist for the ticked items"><option value="">Choose…</option><option value="none">No artist</option>${groups.map((g) => `<option value="${g.id}">${esc(g.name)}${g.hidden ? ' (hidden)' : ''}</option>`).join('')}</select> <button class="sm" data-act="bulk-group">Apply</button> <button class="sm secondary" data-act="pick-clear">Clear ticks</button></div>` : ''}
        <p class="sub">To free a unit that was never paid for, cancel that person's claim in <strong>Claims</strong> (it's under "Shop (on hand)"). Unpaid claims past their pay-by date also show in <strong>Overdue</strong>.</p></div>
      ${visible.length ? visible.map(itemCard).join('') : '<div class="card"><p class="muted">No shop items yet.</p></div>'}`;
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, id = Number(b.dataset.id);
    if (act === 'toggle-hidden') { showHidden = b.checked; return draw(); }
    if (act === 'pick') { if (b.checked) picked.add(id); else picked.delete(id); return draw(); }
    if (act === 'pick-all') { shownItems().forEach((i) => picked.add(i.id)); return draw(); }
    if (act === 'pick-clear') { picked.clear(); return draw(); }
    if (act === 'bulk-group') {
      const v = $('select[name="bulkGroup"]', root).value; if (!v) return GOM.toast('Choose an artist first (or “No artist”).', true);
      const r = await api('POST', '/api/admin/shop/group', { itemIds: [...picked], groupId: v === 'none' ? null : Number(v) });
      if (!r.ok) return GOM.toast(errText(r), true);
      picked.clear(); await render(root); return GOM.toast(`${r.json.updated} item${r.json.updated === 1 ? '' : 's'} ${v === 'none' ? 'taken out of any artist' : `set to ${groupName(Number(v))}`}.`);
    }
    if (act === 'edit') { editing = id; return draw(); }
    if (act === 'cancel-edit') { editing = null; return draw(); }
    if (act === 'hide' || act === 'show') {
      const r = await api('PATCH', `/api/admin/shop/${id}`, { active: act === 'show' });
      await render(root); GOM.refreshBadges();
      return GOM.toast(r.ok ? (act === 'show' ? 'Showing it to joiners again.' : 'Hidden from joiners. Claims already made are untouched.') : errText(r), !r.ok);
    }
  }

  async function onSubmit(e) {
    const form = e.target; if (!form.dataset.form) return;
    e.preventDefault();
    const m = $('[data-msg]', form), say = (t) => { m.textContent = t; m.className = 'msg'; m.hidden = false; };
    const body = { title: form.elements.title.value, price: num(form, 'price'), qty: num(form, 'qty'), payDays: num(form, 'payDays') || 5, size: form.elements.size.value, notes: form.elements.notes.value, groupId: form.elements.groupId.value ? Number(form.elements.groupId.value) : null };
    if (form.dataset.form === 'add') {
      const r = await api('POST', '/api/admin/shop', body);
      if (!r.ok) return say(errText(r));
      editing = r.json.id; await render(root); return GOM.toast(`Added "${body.title.trim()}" — you can add a picture below.`);
    }
    const r = await api('PATCH', `/api/admin/shop/${form.dataset.id}`, body);
    if (!r.ok) return say(errText(r));
    editing = null; await render(root); GOM.toast('Saved.');
  }

  GOM.registerTab({
    id: 'shop', label: 'Shop',
    badgeCount: async () => ((await api('GET', '/api/admin/shop')).json?.items || []).reduce((t, i) => t + i.claims.filter((c) => c.overdue).length, 0),
    async render(el) { await render(el); el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = (e) => { if (e.target.dataset.filter === 'group') { groupFilter = e.target.value; draw(); } }; },
  });
})();
