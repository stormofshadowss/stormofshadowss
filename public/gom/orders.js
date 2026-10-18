// Group Orders tab: create and edit group orders, add and edit their items.
(function () {
  const { esc, money, fmtDate, api, errText, $, $$ } = GOM;
  let orders = [], groups = [], root = null, cancelFlow = null, orderQ = '', closedOpen = false;     // orderQ: the search box; closedOpen: whether the Closed section is unfolded
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
        <div class="full"><label class="chk"><input type="checkbox" name="isTest" ${o?.isTest ? 'checked' : ''}> Test order — can be deleted with everything on it (payments, parcels…) from the Launch tab, until you go live</label></div>
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

  const ukToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  // when does this item stop taking claims? (its own date, or closed by hand; otherwise it follows its group order)
  function closesCell(it) {
    if (it.cancelled) return '—';
    if (it.closedByHand) return `<span class="pill dim" data-item-state="hand">Closed by hand</span><div><button class="sm secondary" data-act="item-reopen" data-id="${it.id}">Reopen</button></div>`;
    if (it.closed) return `<span class="pill dim" data-item-state="date">Closed ${fmtDate(it.closeDate)}</span><div><button class="sm secondary" data-act="item-reopen" data-id="${it.id}">Reopen</button></div>`;
    return `${it.closeDate ? `<span data-item-state="dated">${fmtDate(it.closeDate)}</span>` : '<span class="sub">with the order</span>'}<div><button class="sm secondary" data-act="item-close" data-id="${it.id}">Close now</button></div>`;
  }
  function itemRow(it) {
    if (editingItem === it.id) {
      return `<tr><td colspan="9"><form data-form="edit-item" data-id="${it.id}"><div class="formgrid">
        <div class="span2"><label>Title</label><input name="title" value="${esc(it.title)}" maxlength="160" required></div>
        <div><label>Price (£)</label><input name="price" type="number" step="0.01" min="0" value="${it.priceTbc ? '' : it.price}" ${it.priceTbc ? 'disabled' : 'required'}><label class="chk" style="display:flex; margin-top:6px"><input type="checkbox" name="priceTbc" ${it.priceTbc ? 'checked' : ''}> Price to be confirmed (TBC)</label><div class="sub" data-price-note>Claims that haven't been secured yet will switch to the new price. Anything already secured keeps the price it was secured at. Tick TBC if the price isn't final yet: people can still claim, but nothing can be secured until you set a price.</div></div>
        <div class="full"><label>Description (optional)</label><textarea name="description" rows="3" maxlength="2000" style="width:100%; padding:10px 12px; border:1.5px solid var(--line); border-radius:8px; font:inherit" placeholder="Anything joiners should know…">${esc(it.description || '')}</textarea></div>
        <div class="full">${GOM.pictureControl('item', it.id, it.image, 'Item picture')}</div>
        ${dateInput('paymentDeadline', it.ownPaymentDeadline, "Pay by (blank = the GO's date)")}
        <div>${dateInput('closeDate', it.closeDate, "Closes (blank = when the group order closes)")}<div class="sub">Claims on this item stop after this day (UK time).${currentOrder().closeDate ? ` It can't be later than the group order's ${fmtDate(currentOrder().closeDate)}.` : ''}</div></div>
        <div><label>Purchase limit (blank = none)</label><input name="purchaseLimit" type="number" min="1" max="9999" inputmode="numeric" placeholder="e.g. 5" value="${it.limit ? it.limit.n : ''}"><div class="sub">At most this many across everyone, first come first served. Lowering it never cancels claims people already have — it only stops new ones.</div></div>
        ${['set', 'independent', 'size'].includes(it.type) ? `<div><label>The limit counts</label><select name="limitScope"><option value="item" ${it.limit?.scope === 'option' ? '' : 'selected'}>The whole item together</option><option value="option" ${it.limit?.scope === 'option' ? 'selected' : ''}>Each member / size separately</option></select></div>` : ''}
        <div><label>Proxy (blank = the GO's)</label><input name="proxy" list="proxyList" value="${esc(it.proxy && it.proxy !== currentOrder().proxy ? it.proxy : '')}"></div>
      </div>
      <p class="sub">Changing the price only affects future claims — existing claims keep the price they were made at.</p>
      <p class="msg" data-msg hidden></p>
      <div class="btn-row"><button type="submit" class="sm">Save</button><button type="button" class="sm secondary" data-act="cancel-item-edit">Cancel</button></div></form></td></tr>`;
    }
    return `<tr><td>${it.image ? `<img class="thumb sm" src="${esc(it.image.thumb)}" alt="" style="float:left; margin-right:10px">` : ''}${esc(it.title)}${it.description ? `<div class="sub" style="white-space:pre-line">${esc(it.description.length > 140 ? it.description.slice(0, 140) + '…' : it.description)}</div>` : ''}</td><td>${esc(typeName[it.type])}</td><td class="nowrap">${it.priceTbc ? '<span class="pill warn">TBC</span>' : money(it.price)}</td>
      <td class="nowrap">${fmtDate(it.payBy)}${it.ownPaymentDeadline ? ' <span class="sub">(own)</span>' : ''}</td>
      <td class="nowrap" data-closes>${closesCell(it)}</td><td>${esc(it.proxy || '—')}</td>
      <td>${itemSummary(it)}</td><td>${it.claimed}${limitCell(it)}</td><td><button class="sm secondary" data-act="edit-item" data-id="${it.id}">Edit</button> <button class="sm secondary danger" data-act="delete-item" data-id="${it.id}">Delete</button>${it.cancelled ? ' <span class="pill warn" data-cancelled>Cancelled</span>' : ` <button class="sm secondary danger" data-act="cancel-item" data-id="${it.id}">Cancel…</button>`}${it.type === 'set' ? ` <button class="sm secondary" data-act="fixed" data-id="${it.id}">Fixed claimers</button>` : ''}</td></tr>`;
  }

  const currentOrder = () => orders.find((o) => o.id === itemsFor) || {};
  // open group orders whose closing date has passed no longer take claims — easy to miss for imported ones, so say so
  function dateNotice() {
    const late = orders.filter((o) => !o.cancelled && o.closedByDate); if (!late.length) return '';
    return `<div class="card" data-date-notice style="border:2px solid var(--warn-line); background:var(--warn-bg); color:var(--warn-ink)"><strong>${late.length} open group order${late.length === 1 ? ' is' : 's are'} past ${late.length === 1 ? 'its' : 'their'} closing date, so ${late.length === 1 ? 'it no longer takes' : 'they no longer take'} claims</strong>
      <div style="color:inherit">${late.map((o) => `${esc(o.title)} (${fmtDate(o.closeDate)})`).join(' · ')}</div><div class="sub" style="color:inherit">To reopen one, edit it and change or clear its closing date. Or set its status to Closed to tidy it up.</div></div>`;
  }

  function itemsPanel() {
    const o = currentOrder();
    return `<div class="card" id="itemsPanel"><div class="row"><h2 style="margin:0">Items — ${esc(o.title)}</h2><button class="sm secondary" data-act="close-items">Close</button></div>
      <div class="scroll"><table class="grid"><thead><tr><th>Item</th><th>Type</th><th>Price</th><th>Pay by</th><th>Closes</th><th>Proxy</th><th>Parts / sizes</th><th>Claimed</th><th></th></tr></thead>
      <tbody>${o.items.length ? o.items.map(itemRow).join('') : '<tr><td colspan="9" class="muted">No items yet — add the first one below.</td></tr>'}</tbody></table></div>
      <h2 style="margin-top:20px">Add an item</h2>
      <form data-form="new-item" data-id="${o.id}"><div class="formgrid">
        <div class="span2"><label>Type</label><select name="type">${TYPES.map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
        <div class="span2"><label>Title</label><input name="title" maxlength="160" required></div>
        <div><label>Price (£)</label><input name="price" type="number" step="0.01" min="0" required><label class="chk" style="display:flex; margin-top:6px"><input type="checkbox" name="priceTbc" > Price to be confirmed (TBC)</label><div class="sub">Tick TBC if you're hosting before the price is final — people can claim, and you set the price later.</div></div>
        <div class="full"><label>Description (optional — shown to joiners on the item)</label><textarea name="description" rows="3" maxlength="2000" style="width:100%; padding:10px 12px; border:1.5px solid var(--line); border-radius:8px; font:inherit" placeholder="Contents, size, edition, release notes, anything joiners should know…"></textarea></div>
        <div data-only="size,normal,random,independent,set"><label>Size (for postage)</label><select name="sizeBucket"><option>XS</option><option>S</option><option selected>M</option><option>L</option><option>XL</option></select></div>
        ${dateInput('paymentDeadline', '', "Pay by (blank = the GO's date)")}
        <div>${dateInput('closeDate', '', "Closes (blank = when the group order closes)")}<div class="sub">Claims on this item stop after this day (UK time) — use it when an item closes before the rest of the order.</div></div>
        <div><label>Purchase limit (blank = none)</label><input name="purchaseLimit" type="number" min="1" max="9999" inputmode="numeric" placeholder="e.g. 5"><div class="sub">At most this many across everyone, first come first served — for a store limit or a bulky item.</div></div>
        <div data-limit-scope hidden><label>The limit counts</label><select name="limitScope"><option value="item">The whole item together</option><option value="option">Each member / size separately</option></select></div>
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
      <form data-form="add-fixed" data-id="${it.id}" style="margin-top:12px"><div class="formgrid"><div><label>Instagram handle</label><input name="handle" list="fixedHandles" placeholder="@handle" autocomplete="off"><datalist id="fixedHandles"></datalist><div class="sub" data-fixed-hint hidden></div></div>
        <div><label>Member</label><select name="member">${it.members.map((m) => `<option>${esc(m.name)}</option>`).join('')}</select></div><div><button type="submit" class="sm">Add fixed claimer</button></div></div><p class="msg" data-msg hidden></p></form>
      ${others.length ? `<form data-form="copy-fixed" data-id="${it.id}" style="margin-top:12px"><div class="formgrid"><div class="span2"><label>Copy the regulars from another comeback</label><select name="from">${others.map((x) => `<option value="${x.id}">${esc(x.label)}</option>`).join('')}</select></div><div><button type="submit" class="sm secondary">Copy them over</button></div></div><p class="msg" data-msg hidden></p></form>` : ''}</div>`;
  }
  async function loadFixed() { const r = await api('GET', `/api/admin/items/${fixedFor}/fixed`); fixedList = r.json?.fixed || []; }

  // Cancelling a group order or an item that can't be fulfilled: first the impact, then the exact name typed, then one last "are you sure".
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  function cancelPanel() {
    if (!cancelFlow) return '';
    const { kind, plan: p } = cancelFlow, s = p.summary, what = kind === 'order' ? 'group order' : 'item';
    const blocked = p.blockers.length > 0;
    return `<div class="card" id="cancelPanel" style="border:2px solid var(--accent)"><h2>Cancel the ${what} “${esc(p.title)}”?</h2>
      ${s.claims ? `<p data-impact>This will cancel <strong>${s.claims} claim${s.claims === 1 ? '' : 's'}</strong> (${s.confirmed} confirmed, ${s.requested} unconfirmed) from <strong>${s.people} ${s.people === 1 ? 'person' : 'people'}</strong>${s.paid > 0 ? ` and return the <strong>${money(s.credit)}</strong> they've paid to them as credit` : ''}.${s.forfeited > 0 ? ` <strong>${money(s.forfeited)}</strong> paid by blocked handles will <em>not</em> be credited.` : ''}</p>
        <ul style="margin:0 0 8px; padding-left:20px" data-claims>${p.claims.map((c) => `<li>@${esc(c.handle)} — ${esc(c.label)} <span class="sub">(${c.status}${c.paid > 0 ? `, paid ${money(c.paid)}` : ''})</span></li>`).join('')}${s.claims > p.claims.length ? `<li class="sub">…and ${s.claims - p.claims.length} more</li>` : ''}</ul>`
        : '<p data-impact>Nobody has a live claim on it, so no claims change.</p>'}
      <p class="sub" style="margin-top:0">${kind === 'order' ? 'The order closes and disappears from the shop (all its items go with it).' : 'The item disappears from the shop and can no longer be claimed.'} <strong>Nothing is emailed</strong> — you'll need to tell people yourself.</p>
      ${blocked ? `<div class="msg" data-blockers><strong>It can't be cancelled yet:</strong>${p.blockers.map((b) => `<div style="margin-top:4px">“${esc(b.label)}” (@${esc(b.handle)}) — ${esc(b.reason)}</div>`).join('')}</div>` : `<label for="cancelTyped">To confirm, type the name: <strong>${esc(p.title)}</strong></label><input id="cancelTyped" autocomplete="off" style="max-width:420px">`}
      <p class="msg" data-msg hidden></p>
      <div class="btn-row"><button class="danger" data-act="cancel-go" disabled ${blocked ? 'hidden' : ''}>Cancel the ${what}…</button><button class="secondary" data-act="cancel-close">${blocked ? 'Close' : 'Keep it'}</button></div></div>`;
  }
  // a group order is CLOSED when it was closed by hand, its closing date has passed, or it was cancelled
  const isClosedOrder = (o) => o.cancelled || o.status !== 'open' || o.closedByDate;
  const orderRow = (o) => `<tr data-order="${o.id}"><td>${o.cover ? `<img class="thumb sm" src="${esc(o.cover.thumb)}" alt="" style="float:left; margin-right:10px">` : ''}<strong>${esc(o.title)}</strong></td><td>${esc(o.group)}</td>
        <td>${o.cancelled ? '<span class="pill warn" data-cancelled>Cancelled</span>' : o.closedByDate ? '<span class="pill warn" data-closed-by-date title="Its closing date has passed, so it no longer takes claims">Closed (date passed)</span>' : `<span class="pill ${o.status === 'open' ? 'ok' : 'dim'}">${o.status === 'open' ? 'Open' : 'Closed'}</span>`}</td>
        <td>${o.isPrivate ? '<span class="pill warn">Private</span>' : 'Public'}${o.isTest ? ' <span class="pill" data-test>Test</span>' : ''}</td><td>${fmtDate(o.closeDate)}</td><td>${fmtDate(o.paymentDeadline)}</td><td>${esc(o.proxy || '—')}</td>
        <td class="nowrap"><button class="sm secondary" data-act="edit-order" data-id="${o.id}">Edit</button> <button class="sm" data-act="open-items" data-id="${o.id}">Items (${o.items.length})</button> <button class="sm secondary danger" data-act="delete-order" data-id="${o.id}">Delete</button>${o.cancelled ? '' : ` <button class="sm secondary danger" data-act="cancel-order" data-id="${o.id}">Cancel…</button>`}</td></tr>
        ${editingId === o.id ? `<tr><td colspan="8">${orderForm(o)}</td></tr>` : ''}`;
  const orderTable = (list) => `<div class="scroll"><table class="grid"><thead><tr><th>Title</th><th>Group</th><th>Status</th><th>Listing</th><th>Closes</th><th>Payment due</th><th>Proxy</th><th></th></tr></thead><tbody>${list.map(orderRow).join('')}</tbody></table></div>`;
  // the list: open orders in a table, everything closed folded away underneath; the search box filters both
  function listHtml() {
    const q = orderQ.trim().toLowerCase(), hit = (o) => !q || [o.title, o.group, o.proxy].some((v) => (v || '').toLowerCase().includes(q));
    const open = orders.filter((o) => !isClosedOrder(o) && hit(o)), closed = orders.filter((o) => isClosedOrder(o) && hit(o)), closedAll = orders.filter(isClosedOrder).length;
    const unfold = closedOpen || (q && closed.length > 0) || closed.some((o) => o.id === editingId);                // searching, or editing one of them, opens it
    return `<div class="card" id="openOrders">${open.length ? orderTable(open) : `<p class="muted" style="margin:0">${orders.length ? (q ? `No open group orders match “${esc(orderQ.trim())}”.` : 'No open group orders right now.') : 'No group orders yet. Create your first one above.'}</p>`}</div>
      ${closedAll ? `<details class="card" id="closedOrders" ${unfold ? 'open' : ''}><summary><strong>Closed</strong> (${closedAll}${q ? `, ${closed.length} match` : ''}) <span class="sub">— closed, past their closing date, or cancelled</span></summary>${closed.length ? orderTable(closed) : `<p class="muted">No closed group orders match “${esc(orderQ.trim())}”.</p>`}</details>` : ''}`;
  }

  function draw() {
    { const d = $('#closedOrders', root); if (d) closedOpen = d.open; }                  // remember whether the Closed section was unfolded across redraws
    const proxies = [...new Set(orders.flatMap((o) => [o.proxy, ...o.items.map((i) => i.proxy)]).filter(Boolean))];
    root.innerHTML = `
      <div class="row" style="margin:18px 0 10px"><h1 style="margin:0">Group orders</h1>
        <button data-act="toggle-new" class="${showNew ? 'secondary' : ''}">${showNew ? 'Close' : '＋ New group order'}</button></div>
      <details class="card" id="groupPics"><summary>Artist / group pictures and type (${groups.length})</summary>${groups.length ? '<p class="sub" style="margin:0 0 6px">The type is what the shop\'s filter chips (Boy bands, Girl groups…) use. Leave it blank and the group only shows under All.</p>' + groups.map((g) => `<div data-group-row="${g.id}">${GOM.pictureControl('group', g.id, g.cover, g.name)}<label class="sub" style="display:inline-block; margin:0 8px 0 0">Type</label><select data-kind-for="${g.id}" style="width:auto; display:inline-block"><option value="">— none —</option>${[['boy band', 'Boy band'], ['girl group', 'Girl group'], ['solo', 'Solo'], ['duo', 'Duo']].map(([v, l]) => `<option value="${v}" ${g.kind === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`).join('') : '<p class="muted">No artist groups yet — one is created with your first group order.</p>'}</details>
      <datalist id="proxyList">${proxies.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      ${showNew ? `<div class="card"><h2>New group order</h2>${orderForm(null)}</div>` : ''}
      ${dateNotice()}
      ${cancelPanel()}
      <div class="card"><input id="orderSearch" type="search" placeholder="Search group orders by name…" value="${esc(orderQ)}" aria-label="Search group orders" autocomplete="off"></div>
      <div id="orderList">${listHtml()}</div>
      ${itemsFor ? itemsPanel() : ''}${itemsFor && fixedFor ? fixedPanel() : ''}`;
    $$('form[data-form="new-item"]', root).forEach(syncTypeFields);
  }

  // under "Claimed" in the items list: the purchase limit and how much of it is used (whole item, or the options that are full)
  const limitCell = (it) => {
    const l = it.limit; if (!l) return '';
    if (l.scope === 'item') return `<div class="sub" data-item-limit>Limit ${l.n} · ${l.left > 0 ? `${l.left} left` : l.used > l.n ? `<strong>full (${l.used - l.n} over)</strong>` : '<strong>full</strong>'}</div>`;
    const full = Object.entries(l.options).filter(([, o]) => o.left === 0).map(([n]) => n);
    return `<div class="sub" data-item-limit>Limit ${l.n} of each${full.length ? ` · full: ${full.map(esc).join(', ')}` : ''}</div>`;
  };

  function syncTypeFields(form) {
    const type = form.elements.type.value;
    const extra = EXTRA[type];
    $('[data-extra]', form).hidden = !extra;
    if (extra) { $('[data-extra-label]', form).textContent = extra[0]; form.elements.extra.placeholder = extra[1]; }
    $('[data-setonly]', form).hidden = type !== 'set';
    $('[data-limit-scope]', form).hidden = !['set', 'independent', 'size'].includes(type);
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
        groupId, title: val(form, 'title'), status: val(form, 'status'), isPrivate: form.elements.isPrivate.checked, isTest: form.elements.isTest.checked,
        closeDate: val(form, 'closeDate') || null, paymentDeadline: val(form, 'paymentDeadline') || null,
        expectedShipDate: val(form, 'expectedShipDate') || null, proxy: val(form, 'proxy') || null,
      });
      if (!r.ok) return showMsg(form, errText(r));
      showNew = false; itemsFor = r.json.id; await render(root); GOM.toast('Group order created — now add its items.');
    } else if (kind === 'edit-order') {
      const r = await api('PATCH', `/api/admin/orders/${form.dataset.id}`, {
        title: val(form, 'title'), status: val(form, 'status'), isPrivate: form.elements.isPrivate.checked, isTest: form.elements.isTest.checked,
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
        paymentDeadline: val(form, 'paymentDeadline') || null, closeDate: val(form, 'closeDate') || null, proxy: val(form, 'proxy') || null, ...extra,
        purchaseLimit: val(form, 'purchaseLimit') === '' ? null : Number(val(form, 'purchaseLimit')), limitScope: ['set', 'independent', 'size'].includes(type) ? val(form, 'limitScope') : 'item',
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
        paymentDeadline: val(form, 'paymentDeadline') || null, closeDate: val(form, 'closeDate') || null, proxy: val(form, 'proxy') || null,
        purchaseLimit: val(form, 'purchaseLimit') === '' ? null : Number(val(form, 'purchaseLimit')), ...(form.elements.limitScope ? { limitScope: val(form, 'limitScope') } : {}),
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
      case 'cancel-order': case 'cancel-item': {
        const kind = b.dataset.act === 'cancel-order' ? 'order' : 'item';
        const r = await api('GET', `/api/admin/${kind}s/${id}/cancel-plan`);
        if (!r.ok) return GOM.toast(errText(r), true);
        cancelFlow = { kind, id, plan: r.json }; draw();
        const panel = $('#cancelPanel', root); panel?.scrollIntoView?.({ block: 'center' }); $('#cancelTyped', root)?.focus(); break;
      }
      case 'cancel-close': cancelFlow = null; draw(); break;
      case 'cancel-go': {
        const { kind, id: cid, plan: p } = cancelFlow, typed = $('#cancelTyped', root).value, s = p.summary;
        if (norm(typed) !== norm(p.title)) return;
        const ok = await GOM.confirm(`Really cancel “${p.title}”?\n\n${s.claims ? `${s.claims} claim${s.claims === 1 ? '' : 's'} will be cancelled${s.credit > 0 ? ` and ${money(s.credit)} returned to people as credit` : ''}.` : 'No claims will change.'} Nobody is emailed. This can't be undone.`, { ok: 'Yes, cancel it', cancel: 'Go back' });
        if (!ok) return;
        const r = await api('POST', `/api/admin/${kind}s/${cid}/cancel`, { confirm: typed });
        if (!r.ok) return GOM.toast(errText(r), true);
        cancelFlow = null; await reload(true); GOM.toast(`Cancelled “${r.json.title}” — ${r.json.claims} claim${r.json.claims === 1 ? '' : 's'}${r.json.credit > 0 ? `, ${money(r.json.credit)} returned as credit` : ''}.`); break;
      }
      case 'delete-item': await deleteIt('items', id, currentOrder().items?.find((x) => x.id === id)?.title); break;
      case 'delete-order': await deleteIt('orders', id, orders.find((x) => x.id === id)?.title); break;
      case 'edit-item': editingItem = id; draw(); break;
      case 'item-close': {
        const it = currentOrder().items.find((i) => i.id === id);
        if (!(await GOM.confirm(`Close “${it.title}” for claims now?\n\nJoiners will see it greyed out, saying “Closed for claims”. The rest of the group order stays open, anything already claimed is untouched, and you can reopen it any time.`, { ok: 'Close it', cancel: 'Not yet' }))) break;
        const r = await api('PATCH', `/api/admin/items/${id}`, { closed: true }); if (!r.ok) return GOM.toast(errText(r), true); await reload(true); GOM.toast('Closed for claims.'); break;
      }
      case 'item-reopen': {
        const it = currentOrder().items.find((i) => i.id === id), clears = !!it.closeDate && it.closeDate < ukToday();           // its own date has passed: reopening clears it too
        if (!(await GOM.confirm(`Reopen “${it.title}” for claims?${clears ? `\n\nIts closing date (${fmtDate(it.closeDate)}) has passed, so that date is cleared as well — it will then follow the group order.` : ''}`, { ok: 'Reopen it', cancel: 'Not yet' }))) break;
        const r = await api('PATCH', `/api/admin/items/${id}`, { closed: false }); if (!r.ok) return GOM.toast(errText(r), true); await reload(true); GOM.toast('Reopened.'); break;
      }
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
    if (e.target.dataset.kindFor) {                                                      // a group's type (Boy band / Girl group / Solo / Duo)
      const r = await api('PATCH', `/api/admin/groups/${e.target.dataset.kindFor}`, { kind: e.target.value || null });
      if (!r.ok) return GOM.toast(errText(r), true);
      const g = groups.find((x) => x.id === Number(e.target.dataset.kindFor)); if (g) g.kind = e.target.value || null;
      return GOM.toast('Saved.');
    }
    if (e.target.name === 'type' && e.target.form) syncTypeFields(e.target.form);
  }

  // Fixed claimers: as you type a handle, people already signed up to the site are suggested. Anyone else is fine too — they're added as a new person. Updated IN PLACE, so the cursor never moves.
  let fixedLook = { for: '', exact: false, blocked: false, matches: [] }, fixedTimer = null;
  const fixedHandle = (v) => String(v || '').trim().replace(/^@+/, '').toLowerCase();
  function fixedHint(form) {
    const h = fixedHandle(form.elements.handle.value), hint = $('[data-fixed-hint]', form), fresh = h && fixedLook.for === h;                   // only once the server has answered for exactly what is typed
    const text = fresh && fixedLook.blocked ? `@${h} is blocked — unblock them on the People tab first.` : fresh && !fixedLook.exact ? `@${h} isn't on the site yet — that's fine, they'll be added as a new person.` : '';
    hint.hidden = !text; hint.textContent = text;
    // a browser only offers suggestions that match what's typed, so if you type or paste "@maiju" the suggestions carry the "@" too (the server accepts either)
    const at = /^\s*@/.test(form.elements.handle.value) ? '@' : '', dl = $('#fixedHandles', form); if (dl) dl.innerHTML = fixedLook.matches.map((x) => `<option value="${at}${esc(x)}">`).join('');
  }
  function fixedLookupLater(form) {
    clearTimeout(fixedTimer);
    fixedTimer = setTimeout(async () => {
      const h = fixedHandle(form.elements.handle.value);
      if (!h) { fixedLook = { for: '', exact: false, blocked: false, matches: [] }; return fixedHint(form); }
      const r = await api('GET', `/api/admin/joiners/lookup?q=${encodeURIComponent(h)}`);
      if (!r.ok || fixedHandle(form.elements.handle.value) !== h) return;                                      // the answer is for something no longer typed
      fixedLook = { for: h, exact: !!r.json.exact, blocked: !!r.json.blocked, matches: r.json.matches || [] }; fixedHint(form);
    }, 160);
  }

  GOM.registerTab({
    id: 'orders', label: 'Group Orders',
    async render(el) { await render(el); el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = onChange; el.oninput = (e) => {
      if (e.target.matches?.('form[data-form="add-fixed"] input[name="handle"]')) { fixedHint(e.target.form); fixedLookupLater(e.target.form); return; }
      if (e.target.id === 'orderSearch') {                                                   // only the LIST is redrawn, so the cursor stays in the box
        { const d = $('#closedOrders', root); if (d) closedOpen = d.open; }
        orderQ = e.target.value; $('#orderList', root).innerHTML = listHtml(); return;
      }
      if (e.target.id === 'cancelTyped' && cancelFlow) $('[data-act="cancel-go"]', root).disabled = norm(e.target.value) !== norm(cancelFlow.plan.title); }; },
  });
})();
