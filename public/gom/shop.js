// Shop tab: stock you already have on hand. Joiners claim it from the Shop page and it's held for them at once; it becomes ready to pack when paid,
// and shows in Overdue if it isn't paid within the item's pay-by days (you cancel it yourself, in Claims, to free the unit).
(function () {
  const { esc, money, fmtDate, api, errText, $ } = GOM;
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  let root = null, items = [], editing = null, showHidden = true;
  let groups = [], picked = new Set(), groupFilter = '';       // the artists; the items ticked for "Set artist"; the Stock filter ('' = all, 'none' = no artist yet, or an artist's id)
  document.addEventListener('gom:picture', (e) => { if (e.detail.kind === 'shop') items.forEach((i) => { if (i.id === e.detail.id) i.image = e.detail.image; }); });
  const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
  const OPTION_LABELS = ['Member', 'Size', 'Version', 'Option'];                  // what the picker is called when a shop item has options
  // "Han=1, Felix=2, Album B=2@18" → [{ name, qty, price }]: Name=how many (just a name means 1), and @price when that option costs something different from the listing.
  function parseOptions(text) {
    const options = [];
    for (const raw of text.split(/[,\n]/).map((t) => t.trim()).filter(Boolean)) {
      let rest = raw, price = null, qty = 1;
      const pm = /@\s*(\d+(?:\.\d{1,2})?)\s*$/.exec(rest); if (pm) { price = Number(pm[1]); rest = rest.slice(0, pm.index); }
      const qm = /=\s*(\d+)\s*$/.exec(rest); if (qm) { qty = Number(qm[1]); rest = rest.slice(0, qm.index); }
      const name = rest.trim();
      if (!name || /[=@]/.test(name)) return { error: `“${raw}” — write each option like Han=2, or Album B=2@18 (how many, then @price if it costs something different).` };
      options.push({ name, qty, price });
    }
    return { options };
  }

  async function render(el) {
    root = el;
    const [s, g] = await Promise.all([api('GET', '/api/admin/shop'), api('GET', '/api/admin/groups')]);
    items = s.json?.items || []; groups = g.json?.groups || []; picked = new Set([...picked].filter((id) => items.some((i) => i.id === id)));
    draw();
  }

  const num = (form, n) => Number(form.elements[n].value);
  // WHAT BUYERS CHOOSE: nothing (one item, one count), or a member / size / version / option — each with its own count and, if it differs, its own price. Rows to edit once there are options.
  const labelSelect = (cur, blank) => `<select name="optionLabel">${blank ? '<option value="">Nothing — it is just one item</option>' : ''}${OPTION_LABELS.map((l) => `<option ${l === cur ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const optionsBlock = (it = {}) => {
    if (it.options) {
      return `<div class="span2" data-option-rows><label>What buyers choose</label>${labelSelect(it.optionLabel, false)}
        <div style="display:grid; gap:6px; margin:8px 0">${it.options.map((o) => `<div class="optrow" data-opt-id="${o.id}" style="display:flex; gap:6px; flex-wrap:wrap; align-items:center"><input data-opt-name value="${esc(o.name)}" maxlength="80" aria-label="Name" style="flex:1; min-width:120px"><input data-opt-qty type="number" step="1" min="${o.claimed}" value="${o.qty}" aria-label="How many" style="width:84px"><input data-opt-price type="number" step="0.01" min="0.01" value="${o.ownPrice ?? ''}" placeholder="${esc(String(it.price ?? ''))}" aria-label="Price (blank = the listing's price)" style="width:96px"><label class="chk" style="margin:0"><input type="checkbox" data-opt-remove ${o.claimed ? 'disabled' : ''}> Remove</label><span class="sub">${o.claimed} claimed · ${o.left} left</span></div>`).join('')}</div>
        <input name="moreOptions" placeholder="Add more: e.g. XL=2, Album C=1@20" autocomplete="off">
        <div class="sub">Name · how many you have · its own price (blank = the listing's price). Renaming carries through to claims already made. An option someone has claimed can't be removed — set its count to what is claimed instead.</div></div>`;
    }
    if (it.id && it.claimed) return '';                                            // an item people have claimed can't be turned into one with options
    return `<div class="span2"><label>What can buyers choose?</label>${labelSelect('', true)}</div>
      <div class="span2" data-options-box hidden><label>Options and how many you have</label><input name="optionsText" placeholder="Han=1, Felix=2, Seungmin" autocomplete="off">
        <div class="sub">Write each as <strong>Name=how many</strong> (just the name means 1). If one costs a different price add <strong>@price</strong> — e.g. <em>Album A=3, Album B=2@18</em>. The price above is used for the rest.</div></div>`;
  };
  const fields = (it = {}) => `<div class="formgrid">
      <div class="span2"><label>Name</label><input name="title" maxlength="160" value="${esc(it.title || '')}" required></div>
      <div><label>Price (£)</label><input name="price" type="number" step="0.01" min="0.01" value="${it.price ?? ''}" required></div>
      ${it.options ? '' : `<div data-qty-box><label>Quantity in stock</label><input name="qty" type="number" step="1" min="0" value="${it.qty ?? ''}" required></div>`}
      <div><label>Days to pay</label><input name="payDays" type="number" step="1" min="1" max="60" value="${it.payDays ?? 5}"></div>
      <div><label>Size</label><select name="size">${SIZES.map((s) => `<option ${s === (it.size || 'M') ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div><label>Artist / group</label><select name="groupId"><option value="">None (shown under “Other”)</option>${groups.map((g) => `<option value="${g.id}" ${g.id === it.groupId ? 'selected' : ''}>${esc(g.name)}${g.hidden ? ' (hidden)' : ''}</option>`).join('')}</select></div>
      ${optionsBlock(it)}
      <div class="span2"><label>Notes (shown to joiners)</label><input name="notes" maxlength="255" value="${esc(it.notes || '')}" placeholder="e.g. Minor corner ding, otherwise mint"></div></div>`;

  function claimRow(c) {
    return `<div class="itemrow" data-claim="${c.claimId}"><div class="grow">@${esc(c.handle)}${c.option ? ` <span class="sub" data-claim-option>— ${esc(c.option)}</span>` : ''}${c.pipeline === 'ready to pack / on hand' ? ' <span class="sub">· ready to pack</span>' : ''}</div>
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
        ${it.options ? `<div class="sub" data-options>${esc(it.optionLabel)}s: ${it.options.map((o) => `${esc(o.name)} ${o.left ? `${o.left} left` : 'sold out'} (of ${o.qty})${o.ownPrice != null ? ` · ${money(o.ownPrice)}` : ''}`).join(' · ')}</div>` : ''}
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
    const body = { title: form.elements.title.value, price: num(form, 'price'), payDays: num(form, 'payDays') || 5, size: form.elements.size.value, notes: form.elements.notes.value, groupId: form.elements.groupId.value ? Number(form.elements.groupId.value) : null };
    const label = form.elements.optionLabel?.value, rows = $$('[data-opt-id]', form);
    if (rows.length) {                                                         // an item that already has options: send them all back (a row left out is removed)
      const options = [];
      for (const r of rows) {
        if ($('[data-opt-remove]', r).checked) continue;
        const name = $('[data-opt-name]', r).value.trim(), qty = Number($('[data-opt-qty]', r).value), raw = $('[data-opt-price]', r).value.trim();
        if (!name) return say('An option needs a name.'); if (!Number.isInteger(qty) || qty < 0) return say(`“${name}” needs a number for how many you have.`);
        options.push({ id: Number(r.dataset.optId), name, qty, price: raw === '' ? null : Number(raw) });
      }
      const more = parseOptions(form.elements.moreOptions.value); if (more.error) return say(more.error);
      body.optionLabel = label; body.options = [...options, ...more.options];
      if (!body.options.length) return say('Keep at least one option (or hide the item).');
    } else if (label) {                                                        // choosing options for the first time (a new item, or one nobody has claimed yet)
      const p = parseOptions(form.elements.optionsText.value); if (p.error) return say(p.error); if (!p.options.length) return say(`List the ${label.toLowerCase()}s, like Han=1, Felix=2.`);
      body.optionLabel = label; body.options = p.options;
    } else body.qty = num(form, 'qty');
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
    async render(el) { await render(el); el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = (e) => {
      if (e.target.dataset.filter === 'group') { groupFilter = e.target.value; draw(); }
      if (e.target.name === 'optionLabel' && !e.target.closest('[data-option-rows]')) {                    // choosing what buyers pick: show the options box, hide the single count
        const f = e.target.form, on = !!e.target.value; $('[data-options-box]', f).hidden = !on; const q = $('[data-qty-box]', f); if (q) { q.hidden = on; q.querySelector('input').required = !on; }
      }
    }; },
  });
})();
