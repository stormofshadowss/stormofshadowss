// Group Orders tab: create and edit group orders, add and edit their items.
(function () {
  const { esc, money, fmtDate, api, errText, $, $$ } = GOM;
  let orders = [], groups = [], root = null;
  document.addEventListener('gom:picture', (e) => {            // a picture changed: keep what this tab remembers in step, so the next redraw is right
    const { kind, id, image } = e.detail;
    if (kind === 'item') orders.forEach((x) => x.items.forEach((i) => { if (i.id === id) i.image = image; }));
    if (kind === 'order') orders.forEach((x) => { if (x.id === id) x.cover = image; });
    if (kind === 'group') groups.forEach((g) => { if (g.id === id) g.cover = image; });
  });
  // ticking "price to be confirmed" switches the price box off (and back on)
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name !== 'priceTbc' || !t.form) return;
    const price = t.form.elements.price; price.disabled = t.checked; price.required = !t.checked; if (t.checked) price.value = '';
  });
  const priceBody = (form) => (form.elements.priceTbc.checked ? { priceTbc: true } : { price: Number(val(form, 'price')) });
  let showNew = false, editingId = null, itemsFor = null, editingItem = null, fixedFor = null, fixedList = [];

  const TYPES = [
    ['normal', 'Normal item'], ['independent', 'Independent — claim any member, any quantity'],
    ['size', 'Sizes (hoodies, shirts…)'], ['set', 'Member set — one of each part per set'], ['random', 'Random'],
  ];
  const typeName = Object.fromEntries(TYPES.map(([k, v]) => [k, v.split(' —')[0].split(' (')[0]]));
  const EXTRA = {
    independent: ['Members', 'Bang Chan, Han, Felix'], size: ['Sizes', 'S, M, L, XL'],
    set: ['Parts — give a part its own price like Diary=2', 'Bang Chan, Han, Diary=2, Washi tape=1'],
  };

  async function render(el) {
    root = el;
    const [o, g] = await Promise.all([api('GET', '/api/admin/orders'), api('GET', '/api/admin/groups')]);
    orders = o.json?.orders || []; groups = g.json?.groups || [];
    draw();
  }

  const dateInput = (name, v, label) => `<div><label>${label}</label><input type="date" name="${name}" value="${esc(v || '')}"></div>`;

  function orderForm(o) {
    const editing = !!o;
    return `<form data-form="${editing ? 'edit-order' : 'new-order'}" ${editing ? `data-id="${o.id}"` : ''}>
      <div class="formgrid">
        ${editing ? `<div><label>Group</label><div>${esc(o.group)}</div></div><div class="full">${GOM.pictureControl('order', o.id, o.cover, 'Cover picture for this group order')}</div>` : `
          <div><label>Group</label><select name="group"><option value="">Choose…</option>${groups.filter((g) => !g.hidden).map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></div>
          <div><label>…or a new group</label><input name="newGroup" placeholder="e.g. Stray Kids" maxlength="80"></div>
          <div class="span2"><label>New group's members (optional, comma-separated)</label><input name="newGroupMembers" placeholder="Bang Chan, Lee Know, …"></div>`}
        <div class="span2"><label>Title</label><input name="title" value="${esc(o?.title || '')}" maxlength="160" required></div>
        <div><label>Status</label><select name="status"><option value="open" ${o?.status !== 'closed' ? 'selected' : ''}>Open</option><option value="closed" ${o?.status === 'closed' ? 'selected' : ''}>Closed</option></select></div>
        ${dateInput('closeDate', o?.closeDate, 'Closes')}${dateInput('paymentDeadline', o?.paymentDeadline, 'Payment due')}${dateInput('expectedShipDate', o?.expectedShipDate, 'Expected ship date')}
        <div><label>Proxy</label><input name="proxy" list="proxyList" value="${esc(o?.proxy || '')}" maxlength="80"></div>
        <div class="full"><label class="chk"><input type="checkbox" name="isPrivate" ${o?.isPrivate ? 'checked' : ''}> Private — not listed publicly (for off-site orders you assign by hand)</label></div>
      </div>
      <p class="msg" data-msg hidden></p>
      <div class="btn-row"><button type="submit">${editing ? 'Save changes' : 'Create group order'}</button>
      <button type="button" class="secondary" data-act="${editing ? 'cancel-edit' : 'toggle-new'}">Cancel</button></div>
    </form>`;
  }

  function itemSummary(it) {
    if (it.type === 'set') {
      const mixed = it.members.some((m) => m.price !== it.price);
      return `${it.members.length} parts${mixed && it.wholeSetPrice != null ? ' · ' + money(it.wholeSetPrice) + ' whole set' : ''}${it.requiresFullSet ? ' · <span class="pill warn">every part required</span>' : ''}
        <div class="sub">${it.members.map((m) => `${esc(m.name)}${m.price !== it.price ? ' ' + money(m.price) : ''}`).join(', ')}</div>`;
    }
    if (it.type === 'independent') return `<span class="sub">${it.members.map((m) => esc(m.name)).join(', ')}</span>`;
    if (it.type === 'size') return `<span class="sub">${it.variants.map(esc).join(', ')}</span>`;
    return '';
  }

  function itemRow(it) {
    if (editingItem === it.id) {
      return `<tr><td colspan="8"><form data-form="edit-item" data-id="${it.id}"><div class="formgrid">
        <div class="span2"><label>Title</label><input name="title" value="${esc(it.title)}" maxlength="160" required></div>
        <div><label>Price (£)</label><input name="price" type="number" step="0.01" min="0" value="${it.priceTbc ? '' : it.price}" ${it.priceTbc ? 'disabled' : 'required'}><label class="chk" style="display:flex; margin-top:6px"><input type="checkbox" name="priceTbc" ${it.priceTbc ? 'checked' : ''}> Price to be confirmed (TBC)</label><div class="sub" data-price-note>Claims that haven't been secured yet will switch to the new price. Anything already secured keeps the price it was secured at. Tick TBC if the price isn't final yet: people can still claim, but nothing can be secured until you set a price.</div></div>
        <div class="full"><label>Description (optional)</label><textarea name="description" rows="3" maxlength="2000" style="width:100%; padding:10px 12px; border:1.5px solid var(--line); border-radius:8px; font:inherit" placeholder="Anything joiners should know…">${esc(it.description || '')}</textarea></div>
        <div class="full">${GOM.pictureControl('item', it.id, it.image, 'Item picture')}</div>
        ${dateInput('paymentDeadline', it.ownPaymentDeadline, "Pay by (blank = the GO's date)")}
        <div><label>Proxy (blank = the GO's)</label><input name="proxy" list="proxyList" value="${esc(it.proxy && it.proxy !== currentOrder().proxy ? it.proxy : '')}"></div>
      </div>
      <p class="sub">Changing the price only affects future claims — existing claims keep the price they were made at.</p>
      <p class="msg" data-msg hidden></p>
      <div class="btn-row"><button type="submit" class="sm">Save</button><button type="button" class="sm secondary" data-act="cancel-item-edit">Cancel</button></div></form></td></tr>`;
    }
    return `<tr><td>${it.image ? `<img class="thumb sm" src="${esc(it.image.thumb)}" alt="" style="float:left; margin-right:10px">` : ''}${esc(it.title)}${it.description ? `<div class="sub" style="white-space:pre-line">${esc(it.description.length > 140 ? it.description.slice(0, 140) + '…' : it.description)}</div>` : ''}</td><td>${esc(typeName[it.type])}</td><td class="nowrap">${it.priceTbc ? '<span class="pill warn">TBC</span>' : money(it.price)}</td>
      <td class="nowrap">${fmtDate(it.payBy)}${it.ownPaymentDeadline ? ' <span class="sub">(own)</span>' : ''}</td><td>${esc(it.proxy || '—')}</td>
      <td>${itemSummary(it)}</td><td>${it.claimed}</td><td><button class="sm secondary" data-act="edit-item" data-id="${it.id}">Edit</button> <button class="sm secondary danger" data-act="delete-item" data-id="${it.id}">Delete</button>${it.type === 'set' ? ` <button class="sm secondary" data-act="fixed" data-id="${it.id}">Fixed claimers</button>` : ''}</td></tr>`;
  }

  const currentOrder = () => orders.find((o) => o.id === itemsFor) || {};

  function itemsPanel() {
    const o = currentOrder();
    return `<div class="card" id="itemsPanel"><div class="row"><h2 style="margin:0">Items — ${esc(o.title)}</h2><button class="sm secondary" data-act="close-items">Close</button></div>
      <div class="scroll"><table class="grid"><thead><tr><th>Item</th><th>Type</th><th>Price</th><th>Pay by</th><th>Proxy</th><th>Parts / sizes</th><th>Claimed</th><th></th></tr></thead>
      <tbody>${o.items.length ? o.items.map(itemRow).join('') : '<tr><td colspan="8" class="muted">No items yet — add the first one below.</td></tr>'}</tbody></table></div>
      <h2 style="margin-top:20px">Add an item</h2>
      <form data-form="new-item" data-id="${o.id}"><div class="formgrid">
        <div class="span2"><label>Type</label><select name="type">${TYPES.map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
        <div class="span2"><label>Title</label><input name="title" maxlength="160" required></div>
        <div><label>Price (£)</label><input name="price" type="number" step="0.01" min="0" required><label class="chk" style="display:flex; margin-top:6px"><input type="checkbox" name="priceTbc" > Price to be confirmed (TBC)</label><div class="sub">Tick TBC if you're hosting before the price is final — people can claim, and you set the price later.</div></div>
        <div class="full"><label>Description (optional — shown to joiners on the item)</label><textarea name="description" rows="3" maxlength="2000" style="width:100%; padding:10px 12px; border:1.5px solid var(--line); border-radius:8px; font:inherit" placeholder="Contents, size, edition, release notes, anything joiners should know…"></textarea></div>
        <div data-only="size,normal,random,independent,set"><label>Size (for postage)</label><select name="sizeBucket"><option>XS</option><option>S</option><option selected>M</option><option>L</option><option>XL</option></select></div>
        ${dateInput('paymentDeadline', '', "Pay by (blank = the GO's date)")}
        <div><label>Proxy (blank = the GO's)</label><input name="proxy" list="proxyList" maxlength="80"></div>
        <div class="full" data-extra hidden><label data-extra-label></label><input name="extra"><div class="btn-row" style="margin-top:6px"><button type="button" class="sm secondary" data-act="fill-members">Use the group's members</button></div></div>
        <div class="full" data-setonly hidden><label class="chk"><input type="checkbox" name="requiresFullSet"> Every part must be claimed — a set that doesn't fill can't go ahead</label></div>
      </div>
      <p class="msg" data-msg hidden></p>
      <div class="btn-row"><button type="submit">Add item</button></div></form></div>`;
  }

  // Fixed claimers: regulars who always want a particular member of a set item. Each gets that part reserved in the earliest set that has it free.
  function fixedPanel() {
    const it = currentOrder().items.find((x) => x.id === fixedFor);
    if (!it) return '';
    const others = orders.flatMap((o) => o.items.filter((x) => x.type === 'set' && x.id !== it.id).map((x) => ({ id: x.id, label: `${o.title} — ${x.title}` })));
    return `<div class="card" id="fixedPanel"><div class="row"><h2 style="margin:0">Fixed claimers — ${esc(it.title)}</h2><button class="sm secondary" data-act="close-fixed">Close</button></div>
      <p class="sub">Regulars who always take the same member. Each gets that part reserved in the earliest set that has it free, so two people fixed on one member land in different sets and everyone else's claims skip their part.</p>
      <div class="scroll"><table class="grid"><thead><tr><th>Person</th><th>Member</th><th>Set</th><th>State</th><th></th></tr></thead><tbody>
      ${fixedList.length ? fixedList.map((f) => `<tr data-fixed="${f.id}"><td>@${esc(f.handle)}</td><td>${esc(f.member)}</td><td>Set ${f.setNumber}</td>
        <td><span class="pill ${f.setDecision === 'secured' ? 'ok' : 'warn'}">${f.setDecision === 'secured' ? 'set secured' : 'not secured yet'}</span></td>
        <td><button class="sm secondary" data-act="remove-fixed" data-id="${f.id}" data-handle="${esc(f.handle)}" data-member="${esc(f.member)}">Remove</button></td></tr>`).join('') : '<tr><td colspan="5" class="muted">No fixed claimers yet.</td></tr>'}</tbody></table></div>
      <form data-form="add-fixed" data-id="${it.id}" style="margin-top:12px"><div class="formgrid"><div><label>Instagram handle</label><input name="handle" placeholder="@handle" autocomplete="off"></div>
        <div><label>Member</label><select name="member">${it.members.map((m) => `<option>${esc(m.name)}</option>`).join('')}</select></div><div><button type="submit" class="sm">Add fixed claimer</button></div></div><p class="msg" data-msg hidden></p></form>
      ${others.length ? `<form data-form="copy-fixed" data-id="${it.id}" style="margin-top:12px"><div class="formgrid"><div class="span2"><label>Copy the regulars from another comeback</label><select name="from">${others.map((x) => `<option value="${x.id}">${esc(x.label)}</option>`).join('')}</select></div><div><button type="submit" class="sm secondary">Copy them over</button></div></div><p class="msg" data-msg hidden></p></form>` : ''}</div>`;
  }
  async function loadFixed() { const r = await api('GET', `/api/admin/items/${fixedFor}/fixed`); fixedList = r.json?.fixed || []; }

  function draw() {
    const proxies = [...new Set(orders.flatMap((o) => [o.proxy, ...o.items.map((i) => i.proxy)]).filter(Boolean))];
    root.innerHTML = `
      <div class="row" style="margin:18px 0 10px"><h1 style="margin:0">Group orders</h1>
        <button data-act="toggle-new" class="${showNew ? 'secondary' : ''}">${showNew ? 'Close' : '＋ New group order'}</button></div>
      <details class="card" id="groupPics"><summary>Artist / group pictures (${groups.length})</summary>${groups.length ? groups.map((g) => GOM.pictureControl('group', g.id, g.cover, g.name)).join('') : '<p class="muted">No artist groups yet — one is created with your first group order.</p>'}</details>
      <datalist id="proxyList">${proxies.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      ${showNew ? `<div class="card"><h2>New group order</h2>${orderForm(null)}</div>` : ''}
      <div class="card"><div class="scroll"><table class="grid"><thead><tr><th>Title</th><th>Group</th><th>Status</th><th>Listing</th><th>Closes</th><th>Payment due</th><th>Proxy</th><th></th></tr></thead><tbody>
      ${orders.length ? orders.map((o) => `<tr data-order="${o.id}"><td>${o.cover ? `<img class="thumb sm" src="${esc(o.cover.thumb)}" alt="" style="float:left; margin-right:10px">` : ''}<strong>${esc(o.title)}</strong></td><td>${esc(o.group)}</td>
        <td><span class="pill ${o.status === 'open' ? 'ok' : 'dim'}">${o.status === 'open' ? 'Open' : 'Closed'}</span></td>
        <td>${o.isPrivate ? '<span class="pill warn">Private</span>' : 'Public'}</td><td>${fmtDate(o.closeDate)}</td><td>${fmtDate(o.paymentDeadline)}</td><td>${esc(o.proxy || '—')}</td>
        <td class="nowrap"><button class="sm secondary" data-act="edit-order" data-id="${o.id}">Edit</button> <button class="sm" data-act="open-items" data-id="${o.id}">Items (${o.items.length})</button> <button class="sm secondary danger" data-act="delete-order" data-id="${o.id}">Delete</button></td></tr>
        ${editingId === o.id ? `<tr><td colspan="8">${orderForm(o)}</td></tr>` : ''}`).join('') : '<tr><td colspan="8" class="muted">No group orders yet. Create your first one above.</td></tr>'}
      </tbody></table></div></div>
      ${itemsFor ? itemsPanel() : ''}${itemsFor && fixedFor ? fixedPanel() : ''}`;
    $$('form[data-form="new-item"]', root).forEach(syncTypeFields);
  }

  function syncTypeFields(form) {
    const type = form.elements.type.value;
    const extra = EXTRA[type];
    $('[data-extra]', form).hidden = !extra;
    if (extra) { $('[data-extra-label]', form).textContent = extra[0]; form.elements.extra.placeholder = extra[1]; }
    $('[data-setonly]', form).hidden = type !== 'set';
  }

  const showMsg = (form, text) => { const m = $('[data-msg]', form); m.textContent = text; m.className = 'msg'; m.hidden = !text; };
  const val = (form, name) => (form.elements[name].value || '').trim();
  // Deleting asks the server what depends on it first. If something real does (confirmed orders, money, a parcel…) it explains and stops; otherwise it says exactly what will go.
  async function deleteIt(kind, id, name = 'this') {
    const what = kind === 'orders' ? 'group order' : 'item';
    const c = await api('GET', `/api/admin/${kind}/${id}/delete-check`);
    if (!c.ok) return GOM.toast(errText(c), true);
    if (!c.json.canDelete) return GOM.alert(`“${name}” can't be deleted yet.\n\n${c.json.blockers.map((b) => `• ${b.message}`).join('\n')}`);
    const r = c.json.removes, n = (x, one, many) => `${x} ${x === 1 ? one : many}`, bits = [];
    if (kind === 'orders' && r.items) bits.push(n(r.items, 'item', 'items'));
    if (r.claims) bits.push(`${n(r.claims, 'unconfirmed request', 'unconfirmed requests')} from ${n(r.people, 'person', 'people')}`);
    if (r.fixed) bits.push(n(r.fixed, 'fixed claimer', 'fixed claimers'));
    if (r.pictures) bits.push(n(r.pictures, 'picture', 'pictures'));
    const ok = await GOM.confirm(`Delete the ${what} “${name}”?\n\n${bits.length ? `This also removes ${bits.join(', ')}.` : 'Nothing else depends on it.'}\n\nThis can't be undone.`, { ok: 'Delete it', cancel: 'Keep it' });
    if (!ok) return;
    const d = await api('DELETE', `/api/admin/${kind}/${id}`);
    if (!d.ok) return GOM.toast(errText(d), true);
    if (kind === 'orders' && itemsFor === id) itemsFor = null;
    editingItem = null; editingId = null;
    await reload(true); GOM.toast(`Deleted “${name}”.`);
  }

  async function reload(keepOpen) { const keep = itemsFor; await render(root); if (keepOpen) { itemsFor = keep; draw(); } }

  function parseExtra(type, raw) {
    const tokens = raw.split(',').map((t) => t.trim()).filter(Boolean);
    if (type === 'size') return { variants: tokens };
    if (type === 'independent') return { members: tokens };
    if (type === 'set') {
      return { members: tokens.map((t) => {
        const i = t.lastIndexOf('=');
        if (i === -1) return t;
        const price = Number(t.slice(i + 1));
        if (!t.slice(i + 1).trim() || Number.isNaN(price)) throw new Error(`"${t.slice(0, i).trim()}" has a price that isn't a number — write it like Diary=2.`);
        return { name: t.slice(0, i).trim(), price };
      }) };
    }
    return {};
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.target, kind = form.dataset.form;
    showMsg(form, '');
    if (kind === 'new-order') {
      let groupId = Number(form.elements.group.value);
      const newName = val(form, 'newGroup');
      if (newName) {
        const members = val(form, 'newGroupMembers').split(',').map((s) => s.trim()).filter(Boolean);
        const g = await api('POST', '/api/admin/groups', { name: newName, members });
        if (!g.ok) return showMsg(form, errText(g));
        groupId = g.json.id;
      }
      if (!groupId) return showMsg(form, 'Choose a group, or type a new group name.');
      const r = await api('POST', '/api/admin/orders', {
        groupId, title: val(form, 'title'), status: val(form, 'status'), isPrivate: form.elements.isPrivate.checked,
        closeDate: val(form, 'closeDate') || null, paymentDeadline: val(form, 'paymentDeadline') || null,
        expectedShipDate: val(form, 'expectedShipDate') || null, proxy: val(form, 'proxy') || null,
      });
      if (!r.ok) return showMsg(form, errText(r));
      showNew = false; itemsFor = r.json.id; await render(root); GOM.toast('Group order created — now add its items.');
    } else if (kind === 'edit-order') {
      const r = await api('PATCH', `/api/admin/orders/${form.dataset.id}`, {
        title: val(form, 'title'), status: val(form, 'status'), isPrivate: form.elements.isPrivate.checked,
        closeDate: val(form, 'closeDate') || null, paymentDeadline: val(form, 'paymentDeadline') || null,
        expectedShipDate: val(form, 'expectedShipDate') || null, proxy: val(form, 'proxy') || null,
      });
      if (!r.ok) return showMsg(form, errText(r));
      editingId = null; await reload(true); GOM.toast('Saved.');
    } else if (kind === 'new-item') {
      if (!form.elements.priceTbc.checked && val(form, 'price') === '') return showMsg(form, 'Enter a price, or tick "price to be confirmed".');   // an empty box must never become £0.00
      const type = val(form, 'type');
      let extra;
      try { extra = parseExtra(type, val(form, 'extra')); } catch (err) { return showMsg(form, err.message); }
      const body = {
        type, title: val(form, 'title'), description: val(form, 'description'), ...priceBody(form), sizeBucket: val(form, 'sizeBucket'),
        paymentDeadline: val(form, 'paymentDeadline') || null, proxy: val(form, 'proxy') || null, ...extra,
      };
      if (type === 'set') body.requiresFullSet = form.elements.requiresFullSet.checked;
      const r = await api('POST', `/api/admin/orders/${form.dataset.id}/items`, body);
      if (!r.ok) return showMsg(form, errText(r));
      await reload(true); GOM.toast('Item added.');
    } else if (kind === 'add-fixed') {
      const r = await api('POST', `/api/admin/items/${form.dataset.id}/fixed`, { handle: val(form, 'handle'), member: val(form, 'member') });
      if (!r.ok) return showMsg(form, errText(r));
      await loadFixed(); draw(); GOM.toast(`Added — reserved in Set ${r.json.setNumber}.`);
    } else if (kind === 'copy-fixed') {
      const r = await api('POST', `/api/admin/items/${form.dataset.id}/fixed/copy`, { fromItemId: Number(val(form, 'from')) });
      if (!r.ok) return showMsg(form, errText(r));
      await loadFixed(); draw();
      GOM.toast(`Copied ${r.json.added} regular${r.json.added === 1 ? '' : 's'}.`);
      if (r.json.skipped.length) await GOM.alert(`Some weren't copied:\n\n${r.json.skipped.join('\n')}`);
    } else if (kind === 'edit-item') {
      if (!form.elements.priceTbc.checked && val(form, 'price') === '') return showMsg(form, 'Enter a price, or tick "price to be confirmed".');
      const r = await api('PATCH', `/api/admin/items/${form.dataset.id}`, {
        title: val(form, 'title'), ...priceBody(form), description: val(form, 'description'),
        paymentDeadline: val(form, 'paymentDeadline') || null, proxy: val(form, 'proxy') || null,
      });
      if (!r.ok) return showMsg(form, errText(r));
      editingItem = null; await reload(true);
      const n = r.json.repriced;
      GOM.toast(!n ? 'Saved.' : form.elements.priceTbc.checked ? `Saved — ${n} unsecured claim${n === 1 ? ' is' : 's are'} now marked price TBC. Secured claims keep theirs.` : `Saved — ${n} unsecured claim${n === 1 ? ' now uses' : 's now use'} the new price. Secured claims keep theirs.`);
    }
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    switch (b.dataset.act) {
      case 'toggle-new': showNew = !showNew; editingId = null; draw(); break;
      case 'edit-order': editingId = id; showNew = false; draw(); break;
      case 'cancel-edit': editingId = null; draw(); break;
      case 'open-items': itemsFor = id; editingItem = null; draw(); $('#itemsPanel', root)?.scrollIntoView?.(); break;
      case 'close-items': itemsFor = null; editingItem = null; fixedFor = null; draw(); break;
      case 'fixed': fixedFor = id; await loadFixed(); draw(); break;
      case 'close-fixed': fixedFor = null; draw(); break;
      case 'remove-fixed': {
        const ok = await GOM.confirm(`Remove @${b.dataset.handle}'s fixed claim on ${b.dataset.member}?\n\nTheir claim is cancelled, anything they've already paid goes back to them as credit (unless their handle is blocked), and the part opens up for others.`, { ok: 'Remove it', cancel: 'Keep it' });
        if (!ok) return;
        const r = await api('DELETE', `/api/admin/fixed/${id}`);
        if (!r.ok) return GOM.toast(errText(r), true);
        await loadFixed(); draw(); GOM.toast(r.json.refunded > 0 ? `Removed. £${r.json.refunded.toFixed(2)} returned as credit.` : 'Removed.');
        break;
      }
      case 'delete-item': await deleteIt('items', id, currentOrder().items?.find((x) => x.id === id)?.title); break;
      case 'delete-order': await deleteIt('orders', id, orders.find((x) => x.id === id)?.title); break;
      case 'edit-item': editingItem = id; draw(); break;
      case 'cancel-item-edit': editingItem = null; draw(); break;
      case 'fill-members': {
        const form = b.closest('form');
        const g = groups.find((x) => x.name === currentOrder().group);
        if (!g || !g.members.length) return GOM.alert(`There's no member list saved for ${currentOrder().group || 'this group'} yet. Type the names in, separated by commas.`);
        form.elements.extra.value = g.members.join(', ');
        break;
      }
      default:
    }
  }

  async function onChange(e) {
    if (e.target.name === 'type' && e.target.form) syncTypeFields(e.target.form);
  }

  GOM.registerTab({
    id: 'orders', label: 'Group Orders',
    async render(el) { await render(el); el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = onChange; },
  });
})();
