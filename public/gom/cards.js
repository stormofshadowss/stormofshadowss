(() => {
  const { esc, money, api, errText, $ } = GOM;
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  let root = null, data = { types: [], groups: [], bundles: [] }, view = { name: 'list' }, E = null, keyN = 0, claimData = null;
  const bundleOf = (id) => data.bundles.find((b) => b.id === id), typeOf = (id) => data.types.find((t) => t.id === id);
  const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
  const r6 = (n) => Math.round(n * 1e6) / 1e6;

  async function load() { const r = await api('GET', '/api/admin/cards'); if (r.ok) data = r.json; }
  async function render(el) { root = el; await load(); draw(); }
  const draw = () => (view.name === 'list' ? drawList() : view.name === 'bundle' ? drawBundle() : drawEditor());
  const go = async (v) => { leaveEditor(); view = v; await load(); draw(); };

  // ── reading order (the same sums the server does, so the numbers on screen match what is saved) ──
  function readingOrder(boxes) {
    if (!boxes.length) return [];
    const items = boxes.map((b, i) => ({ i, cx: b.x + b.w / 2, cy: b.y + b.h / 2 })), hs = boxes.map((b) => b.h).sort((a, b) => a - b), tol = (hs[Math.floor(hs.length / 2)] || 0.05) * 0.5;
    items.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    const rows = []; let anchor = 0;
    for (const it of items) { if (!rows.length || it.cy - anchor > tol) { rows.push([it]); anchor = it.cy; } else rows[rows.length - 1].push(it); }
    return rows.flatMap((r) => r.sort((a, b) => a.cx - b.cx || a.cy - b.cy)).map((it) => it.i);
  }

  // ── the list: card types, a new-bundle form, and the bundles ──
  const bundleFields = (b = {}) => `<div class="formgrid">
    <div><label>Name</label><input name="title" value="${esc(b.title || '')}" maxlength="160" required></div>
    <div><label>Group</label><select name="groupId"><option value="">(no group)</option>${data.groups.map((g) => `<option value="${g.id}" ${g.id === b.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
    <div><label>Closes on (optional)</label><input type="date" name="closesOn" value="${esc(b.closesOn || '')}"></div>
    <div><label>Days to pay after claiming</label><input type="number" name="payDays" min="1" max="60" value="${b.payDays ?? 5}"></div>
    <div class="span2"><label>Description (optional)</label><textarea name="description" rows="2" maxlength="2000">${esc(b.description || '')}</textarea></div>
    <div class="span2"><label class="chk"><input type="checkbox" name="notOnHand" ${b.onHand === false ? 'checked' : ''}> Not on hand — these cards still need ordering, so claims go through the normal ordering and shipping process, like a group order</label></div></div>`;
  const readBundle = (f) => ({ title: f.elements.title.value.trim(), groupId: f.elements.groupId.value ? Number(f.elements.groupId.value) : null, closesOn: f.elements.closesOn.value || null, payDays: Number(f.elements.payDays.value), description: f.elements.description.value.trim() || null, onHand: !f.elements.notOnHand.checked });
  const statusPill = (b) => `<span class="pill ${b.status === 'open' ? 'ok' : b.status === 'closed' ? '' : 'warn'}" data-status>${b.status === 'open' ? 'Open' : b.status === 'closed' ? 'Closed' : 'Draft'}</span>`;

  function drawList() {
    root.innerHTML = `<h1 style="margin:18px 0 10px">Cards</h1>
      <div class="card" data-types><h2 style="margin:0 0 6px">Card types</h2><p class="sub" style="margin:0 0 8px">A card follows its type's price unless you give it a price of its own. Changing a type's price changes every card that follows it.</p>
        ${data.types.length ? data.types.map((t) => `<div class="btn-row" data-type-row="${t.id}" style="margin:4px 0; align-items:center"><input data-type-name value="${esc(t.name)}" maxlength="60" aria-label="Type name" style="max-width:220px"><span>£</span><input data-type-price type="number" step="0.01" min="0.01" value="${t.price}" aria-label="Default price" style="max-width:100px"><button class="sm secondary" data-act="type-save" data-id="${t.id}">Save</button><button class="sm secondary" data-act="type-del" data-id="${t.id}">Delete</button></div>`).join('') : '<p class="muted" data-no-types>No types yet — add the kinds of card you sell (POB, lucky draw, album inclusion…) with a usual price.</p>'}
        <form data-form="new-type" class="btn-row" style="margin-top:8px; align-items:end"><div><label>New type</label><input name="name" maxlength="60" placeholder="e.g. POB" required></div><div><label>Usual price (£)</label><input name="price" type="number" step="0.01" min="0.01" required style="max-width:110px"></div><button class="sm" type="submit">Add type</button><span class="msg" data-msg hidden></span></form></div>
      <div class="card"><h2 style="margin:0 0 6px">New bundle</h2><form data-form="new-bundle">${bundleFields()}<div class="btn-row" style="margin-top:8px"><button type="submit">Create bundle</button><span class="msg" data-msg hidden></span></div></form></div>
      <div class="card" data-bundles><h2 style="margin:0 0 6px">Bundles</h2>${data.bundles.length ? data.bundles.map((b) => `<div class="itemrow" data-bundle="${b.id}"><div class="grow"><strong>${esc(b.title)}</strong> ${statusPill(b)} ${b.onHand ? '' : '<span class="pill warn" data-not-on-hand>not on hand</span>'}<div class="sub">${esc(b.groupName || 'No group')} · ${b.boards.length} board${b.boards.length === 1 ? '' : 's'} · ${b.cards} card${b.cards === 1 ? '' : 's'} (${b.copies} cop${b.copies === 1 ? 'y' : 'ies'})</div></div><button class="sm secondary" data-act="open-bundle" data-id="${b.id}">Open</button></div>`).join('') : '<p class="muted">No bundles yet.</p>'}</div>`;
  }

  // ── one bundle: its details, its status, and its boards ──
  function drawBundle() {
    const b = bundleOf(view.id); if (!b) { view = { name: 'list' }; return drawList(); }
    root.innerHTML = `<div class="btn-row" style="margin:18px 0 6px"><button class="sm secondary" data-act="back-list">← All bundles</button></div>
      <h1 style="margin:6px 0 10px">${esc(b.title)} ${statusPill(b)}</h1>
      ${b.orderId ? `<p class="sub" data-order-info style="margin:0 0 10px">Claims, payments and ordering for this bundle appear in the usual tabs under “${esc(b.title)}”. ${b.claims} claim${b.claims === 1 ? '' : 's'} so far. ${b.onHand ? 'On hand: claims are confirmed at once.' : 'Not on hand: claims wait for you to secure them.'}</p>` : ''}
      <div class="card"><form data-form="bundle" data-id="${b.id}">${bundleFields(b)}<div class="btn-row" style="margin-top:8px"><button type="submit">Save details</button>
        ${b.status === 'open' ? '<button type="button" class="secondary" data-act="status" data-to="closed">Close bundle</button>' : b.status === 'closed' ? '<button type="button" class="secondary" data-act="status" data-to="open">Re-open bundle</button>' : '<button type="button" data-act="status" data-to="open">Publish</button>'}
        <button type="button" class="secondary" data-act="delete-bundle">Delete bundle</button><span class="msg" data-msg hidden></span></div></form></div>
      <div class="card" data-boards><h2 style="margin:0 0 6px">Boards</h2><p class="sub" style="margin:0 0 8px">A board is one photo of a spread of cards (a binder page, or a whole collection laid out). Upload it, then draw a box on each card.</p>
        ${b.boards.length ? b.boards.map((x) => `<div class="itemrow" data-board="${x.id}"><img class="thumb" src="${esc(x.image?.thumb || '')}" alt="" style="width:64px"><div class="grow"><strong>${esc(x.title)}</strong><div class="sub">${x.cards} card${x.cards === 1 ? '' : 's'} (${x.copies} cop${x.copies === 1 ? 'y' : 'ies'})</div></div><button class="sm" data-act="edit-board" data-id="${x.id}">Draw boxes</button><button class="sm secondary" data-act="delete-board" data-id="${x.id}">Delete</button></div>`).join('') : '<p class="muted">No boards yet.</p>'}
        <div class="btn-row" style="margin-top:10px; align-items:end"><div><label>Board name (optional)</label><input data-board-title maxlength="120" placeholder="e.g. Binder 1"></div><div><label>Photo</label><input type="file" data-board-file accept="image/jpeg,image/png,image/webp,image/gif" aria-label="Choose a board photo"></div></div>
        <div class="sub">JPEG, PNG, WebP or GIF, up to 25 MB. Straight-on, even light and a flat page give the sharpest card pictures. The full-size photo is kept for cutting out each card; location data is removed.</div><span class="msg" data-board-msg hidden></span></div>
      ${b.orderId ? '<div class="card" data-claims-card><h2 style="margin:0 0 6px">Claims</h2><div id="cardClaims" class="muted">Loading…</div></div>' : ''}`;
    if (b.orderId) loadClaims();
  }
  // WHO HAS WHAT: each person with their cards (the card's picture, number and price, ticked once paid), and what they still owe
  async function loadClaims() {
    const holder = $('#cardClaims', root); if (!holder) return;
    const r = await api('GET', `/api/admin/card-bundles/${view.id}/claims`); if (!r.ok) { holder.textContent = errText(r); return; }
    claimData = r.json; renderClaims();
  }
  function renderClaims() {
    const holder = $('#cardClaims', root); if (!holder || !claimData) return; const b = bundleOf(view.id), want = view.claimBoard ? Number(view.claimBoard) : 0, s = claimData.summary;
    const people = claimData.people.map((p) => ({ ...p, cards: p.cards.filter((c) => !want || c.boardId === want) })).filter((p) => p.cards.length);
    holder.className = '';
    holder.innerHTML = !claimData.people.length ? '<p class="muted" data-no-claims>No claims yet.</p>'
      : `<p class="sub" data-claims-summary>${s.cards} card${s.cards === 1 ? '' : 's'} claimed by ${s.people} ${s.people === 1 ? 'person' : 'people'} · ${money(s.paid)} paid · ${money(s.owed)} owed${s.waiting ? ` · ${s.waiting} waiting for you to secure` : ''}</p>
        ${b && b.boards.length > 1 ? `<div style="margin:6px 0"><label for="claimBoard">Show</label><select id="claimBoard" style="max-width:260px"><option value="">All boards</option>${b.boards.map((x) => `<option value="${x.id}" ${want === x.id ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select></div>` : ''}
        ${people.map((p) => `<div class="itemrow" data-claimer="${esc(p.handle)}"><div class="grow"><strong>@${esc(p.handle)}</strong> <span class="sub">${p.cards.length} card${p.cards.length === 1 ? '' : 's'}</span>
          <div class="cthumbs">${p.cards.map((c) => `<span class="cthumb" data-claim="${c.claimId}" title="${esc(c.boardTitle)} · #${c.number} · ${money(c.price)}${c.status === 'requested' ? ' · waiting for you to secure it' : c.paidUp ? ' · paid' : ''}">${c.thumb ? `<img src="${esc(c.thumb)}" alt="">` : ''}<b>#${c.number} ${money(c.price)}</b>${c.paidUp ? '<i>✓</i>' : ''}</span>`).join('')}</div></div>
          <div class="btn-row" style="margin:0">${p.waiting ? '<span class="pill warn" data-waiting>waiting to be secured</span>' : ''}${p.owed > 0 ? `<span class="pill warn" data-owed>${money(p.owed)} owed</span>` : p.waiting ? '' : '<span class="pill ok" data-paid>✓ Paid</span>'}</div></div>`).join('') || '<p class="muted">Nobody has claimed anything on this board yet.</p>'}`;
  }
  async function uploadBoard(file) {
    const msg = $('[data-board-msg]', root), say = (t) => { msg.textContent = t; msg.className = 'msg'; msg.hidden = !t; };
    say('Uploading…'); const title = $('[data-board-title]', root).value.trim();
    const bytes = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsArrayBuffer(file); });
    const r = await fetch(`/api/admin/card-bundles/${view.id}/boards${title ? `?title=${encodeURIComponent(title)}` : ''}`, { method: 'PUT', headers: { 'X-Requested-With': 'sos', 'Content-Type': file.type || 'application/octet-stream' }, body: new Uint8Array(bytes) });
    let json = null; try { json = await r.json(); } catch { /* no body */ }
    if (!r.ok) return say(errText({ json }));
    await go({ name: 'bundle', id: view.id }); GOM.toast('Board added — now draw a box on each card.');
  }

  // ── the box editor ──
  async function openBoard(id) {
    const r = await api('GET', `/api/admin/card-boards/${id}`); if (!r.ok) return GOM.toast(errText(r), true);
    leaveEditor(); view = { name: 'board', bundleId: view.id ?? view.bundleId, id };
    const last = data.types[0];
    E = { board: r.json.board, boxes: r.json.boxes.map((b) => ({ key: `s${b.id}`, ...b, override: b.priceOverride })), sel: new Set(), zoom: 100, mode: 'draw', dirty: false, brush: { typeId: last ? last.id : null, price: '', qty: 1 }, gridArea: null };
    E.keyHandler = onKey; document.addEventListener('keydown', E.keyHandler); draw();
  }
  function leaveEditor() { if (E?.keyHandler) document.removeEventListener('keydown', E.keyHandler); E = null; }
  const byKey = (k) => E.boxes.find((b) => b.key === k);
  const numbers = () => { const ord = readingOrder(E.boxes), m = new Map(); ord.forEach((i, n) => m.set(E.boxes[i].key, n + 1)); return m; };
  const place = (el, b) => { el.style.left = `${b.x * 100}%`; el.style.top = `${b.y * 100}%`; el.style.width = `${b.w * 100}%`; el.style.height = `${b.h * 100}%`; };
  const boxHtml = (b, n) => `<div class="cbox ${E.sel.has(b.key) ? 'sel' : ''}" data-key="${b.key}" style="left:${b.x * 100}%; top:${b.y * 100}%; width:${b.w * 100}%; height:${b.h * 100}%"><span class="cn">${n}</span><span class="cp">${b.price > 0 ? money(b.price) : '£?'}${b.qty > 1 ? ` ×${b.qty}` : ''}</span>${E.sel.has(b.key) && E.sel.size === 1 ? '<span class="handle"></span>' : ''}</div>`;

  function drawEditor() {
    const { board } = E, n = numbers();
    root.innerHTML = `<div id="cardEditor"><div class="btn-row" style="margin:18px 0 6px"><button class="sm secondary" data-act="back-bundle">← Back to the bundle</button></div>
      <h1 style="margin:6px 0 6px">${esc(board.title)}</h1>
      <p class="sub" style="margin:0 0 8px">Drag on the photo to draw a box round a card. Click a box to select it (Shift-click to add more), drag it to move it, drag its corner to resize. <strong>Grid tool</strong> lays out a whole binder page at once. Delete removes the selected boxes; the arrow keys nudge them.</p>
      <div class="card" style="margin-bottom:8px"><div class="btn-row" style="align-items:end; flex-wrap:wrap; gap:10px">
        <button class="sm ${E.mode === 'draw' ? '' : 'secondary'}" data-act="mode-draw" aria-pressed="${E.mode === 'draw'}">Draw boxes</button><button class="sm ${E.mode === 'grid' ? '' : 'secondary'}" data-act="mode-grid" aria-pressed="${E.mode === 'grid'}">Grid tool</button>
        <div><label for="zoomSel">Zoom</label><select id="zoomSel">${[100, 150, 200, 300, 400].map((z) => `<option value="${z}" ${z === E.zoom ? 'selected' : ''}>${z}%</option>`).join('')}</select></div>
        <div><label for="brushType">New cards start as</label><select id="brushType"><option value="">(no type)</option>${data.types.map((t) => `<option value="${t.id}" ${t.id === E.brush.typeId ? 'selected' : ''}>${esc(t.name)} — ${money(t.price)}</option>`).join('')}</select></div>
        <div><label for="brushPrice">Price (£, blank = the type's)</label><input id="brushPrice" type="number" step="0.01" min="0.01" value="${esc(E.brush.price)}" style="max-width:110px"></div>
        <div><label for="brushQty">Copies</label><input id="brushQty" type="number" step="1" min="1" max="999" value="${E.brush.qty}" style="max-width:80px"></div>
        <button class="sm" data-act="save-layout">Save cards</button><span class="sub" id="dirtyNote">${E.dirty ? 'Unsaved changes' : ''}</span></div><span class="msg" data-save-error hidden></span></div>
      <div id="gridFormBox"></div>
      <div class="cscroll"><div id="boardCanvas" class="ccanvas" style="width:${E.zoom}%; aspect-ratio:${board.aspect}"><img src="${esc(board.image.url)}" alt="${esc(board.title)}" draggable="false">${E.boxes.map((b) => boxHtml(b, n.get(b.key))).join('')}</div></div>
      <div class="card" id="boxPanel" style="margin-top:8px"></div><div class="card" id="boxList" style="margin-top:8px"></div></div>`;
    $('#boardCanvas', root).addEventListener('mousedown', onCanvasDown); refreshPanel(); refreshGridForm();
  }
  const markDirty = () => { E.dirty = true; const d = $('#dirtyNote', root); if (d) d.textContent = 'Unsaved changes'; };
  function refreshBoxes() {                                                            // redraw just the boxes (after a selection or number change) without touching the photo
    const c = $('#boardCanvas', root), n = numbers(); $$('.cbox', c).forEach((el) => el.remove());
    c.insertAdjacentHTML('beforeend', E.boxes.map((b) => boxHtml(b, n.get(b.key))).join('')); refreshPanel();
  }
  function refreshPanel() {
    const sel = [...E.sel].map(byKey).filter(Boolean), n = numbers(), same = (f) => (sel.length && sel.every((b) => f(b) === f(sel[0])) ? f(sel[0]) : '');
    $('#boxPanel', root).innerHTML = sel.length ? `<strong>${sel.length} selected</strong> <span class="sub">Change what you like, then Apply (anything left blank stays as it is).</span>
      <div class="btn-row" style="align-items:end; flex-wrap:wrap; gap:10px; margin-top:6px"><div><label for="boxType">Type</label><select id="boxType"><option value="">(leave as is)</option><option value="0">(no type)</option>${data.types.map((t) => `<option value="${t.id}">${esc(t.name)} — ${money(t.price)}</option>`).join('')}</select></div>
        <div><label for="boxPrice">Price (£)</label><input id="boxPrice" type="number" step="0.01" min="0.01" placeholder="${same((b) => b.price) ? money(same((b) => b.price)) : 'mixed'}" style="max-width:110px"></div>
        <div><label for="boxQty">Copies</label><input id="boxQty" type="number" step="1" min="1" max="999" placeholder="${same((b) => b.qty) || 'mixed'}" style="max-width:80px"></div>
        <div><label for="boxNote">Note</label><input id="boxNote" maxlength="255" placeholder="${esc(same((b) => b.note) || (sel.length > 1 ? 'mixed' : 'e.g. corner ding'))}"></div>
        <button class="sm" data-act="apply">Apply</button><button class="sm secondary" data-act="use-type-price">Use the type's price</button><button class="sm secondary" data-act="delete-boxes">Delete selected</button><button class="sm secondary" data-act="select-none">Select none</button></div>`
      : `<span class="sub">${E.boxes.length ? 'Click a box to change its type, price or copies. ' : ''}<button class="sm secondary" data-act="select-all" ${E.boxes.length ? '' : 'disabled'}>Select all</button></span>`;
    $('#boxList', root).innerHTML = `<strong>${E.boxes.length} card${E.boxes.length === 1 ? '' : 's'}</strong> <span class="sub">(${E.boxes.reduce((s, b) => s + b.qty, 0)} cop${E.boxes.reduce((s, b) => s + b.qty, 0) === 1 ? 'y' : 'ies'})</span>
      ${E.boxes.length ? `<div style="max-height:260px; overflow:auto; margin-top:6px"><table><thead><tr><th>#</th><th>Type</th><th>Price</th><th>Copies</th><th>Note</th></tr></thead><tbody>${[...E.boxes].sort((a, b) => n.get(a.key) - n.get(b.key)).map((b) => `<tr data-key="${b.key}" class="${E.sel.has(b.key) ? 'sel' : ''}" style="cursor:pointer"><td>${n.get(b.key)}</td><td>${esc(b.typeId ? typeOf(b.typeId)?.name || '' : '—')}</td><td>${b.price > 0 ? money(b.price) : '<strong>needs a price</strong>'}${b.override && b.typeId ? ' <span class="sub" title="its own price">•</span>' : ''}</td><td>${b.qty}</td><td>${esc(b.note || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  }

  const newBox = (rect) => {
    const t = E.brush.typeId ? typeOf(E.brush.typeId) : null, own = !t || E.brush.price !== '';
    return { key: `n${++keyN}`, id: null, x: r6(rect.x), y: r6(rect.y), w: r6(rect.w), h: r6(rect.h), typeId: t ? t.id : null, price: own ? Number(E.brush.price || 0) : t.price, override: own, qty: Number(E.brush.qty) || 1, note: '' };
  };
  function onCanvasDown(e) {
    if (e.button !== 0) return;
    const canvas = $('#boardCanvas', root), rect = () => canvas.getBoundingClientRect();
    const pt = (ev) => { const r = rect(); return { x: clamp((ev.clientX - r.left) / r.width), y: clamp((ev.clientY - r.top) / r.height) }; };
    const boxEl = e.target.closest('.cbox'), start = pt(e), multi = e.shiftKey || e.ctrlKey || e.metaKey;
    const drag = (onMove, onUp) => { const mm = (ev) => onMove(pt(ev)), mu = (ev) => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); onUp(pt(ev)); }; document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu); };
    e.preventDefault();
    if (e.target.closest('.handle') && boxEl) {                                          // resize the selected box by its corner
      const b = byKey(boxEl.dataset.key); drag((p) => { b.w = r6(clamp(p.x - b.x, 0.004, 1 - b.x)); b.h = r6(clamp(p.y - b.y, 0.004, 1 - b.y)); place(boxEl, b); }, () => { markDirty(); refreshBoxes(); });
      return;
    }
    if (boxEl) {                                                                         // select, and drag to move everything selected
      const k = boxEl.dataset.key;
      if (multi && E.sel.has(k)) { E.sel.delete(k); return refreshBoxes(); }
      if (!E.sel.has(k)) { if (!multi) E.sel = new Set(); E.sel.add(k); refreshBoxes(); }
      const moving = [...E.sel].map((key) => { const b = byKey(key); return { b, x: b.x, y: b.y }; });
      drag((p) => { const dx = p.x - start.x, dy = p.y - start.y; for (const m of moving) { m.b.x = r6(clamp(m.x + dx, 0, 1 - m.b.w)); m.b.y = r6(clamp(m.y + dy, 0, 1 - m.b.h)); const el = $(`.cbox[data-key="${m.b.key}"]`, canvas); if (el) place(el, m.b); } },
        (p) => { if (Math.abs(p.x - start.x) + Math.abs(p.y - start.y) > 0.0005) { markDirty(); refreshBoxes(); } });
      return;
    }
    const area = document.createElement('div'); area.className = 'carea'; canvas.appendChild(area);   // draw a box (or the area for the grid tool)
    const asRect = (p) => ({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
    drag((p) => place(area, asRect(p)), (p) => {
      area.remove(); const r = asRect(p);
      if (r.w < 0.012 || r.h < 0.012) { if (E.sel.size) { E.sel = new Set(); refreshBoxes(); } return; }       // just a click on empty photo: select nothing
      if (E.mode === 'grid') { E.gridArea = r; return refreshGridForm(); }
      const b = newBox(r); E.boxes.push(b); E.sel = new Set([b.key]); markDirty(); refreshBoxes();
    });
  }

  // ── the grid tool: drag over the area that covers all the cards, say how many across and down, and the boxes appear ──
  const gridCells = (a, cols, rows, gapPct) => {
    const gx = a.w * gapPct / 100, gy = a.h * gapPct / 100, cw = (a.w - gx * (cols - 1)) / cols, ch = (a.h - gy * (rows - 1)) / rows, out = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ x: a.x + c * (cw + gx), y: a.y + r * (ch + gy), w: cw, h: ch });
    return out;
  };
  const gridVals = () => ({ cols: clamp(parseInt($('#gridCols', root).value, 10) || 1, 1, 40), rows: clamp(parseInt($('#gridRows', root).value, 10) || 1, 1, 40), gap: clamp(Number($('#gridGap', root).value) || 0, 0, 20) });
  function refreshGridForm() {
    const box = $('#gridFormBox', root), canvas = $('#boardCanvas', root); $$('.cgrid-preview', canvas).forEach((el) => el.remove());
    if (E.mode !== 'grid') { box.innerHTML = ''; return; }
    if (!E.gridArea) { box.innerHTML = '<div class="card" style="margin-bottom:8px"><span class="sub" data-grid-hint>Grid tool: drag over the area that covers all the cards you want boxes on.</span></div>'; return; }
    if (!$('#gridCols', root)) box.innerHTML = `<div class="card" id="gridForm" style="margin-bottom:8px"><div class="btn-row" style="align-items:end; flex-wrap:wrap; gap:10px"><div><label for="gridCols">Across</label><input id="gridCols" type="number" min="1" max="40" value="3" style="max-width:80px"></div><div><label for="gridRows">Down</label><input id="gridRows" type="number" min="1" max="40" value="3" style="max-width:80px"></div><div><label for="gridGap">Gap between (% of the area)</label><input id="gridGap" type="number" min="0" max="20" step="0.5" value="1" style="max-width:90px"></div><button class="sm" data-act="grid-make">Make the boxes</button><button class="sm secondary" data-act="grid-cancel">Cancel</button><span class="sub" id="gridCount"></span></div></div>`;
    const v = gridVals(), cells = gridCells(E.gridArea, v.cols, v.rows, v.gap); $('#gridCount', root).textContent = `${v.cols} × ${v.rows} = ${cells.length} cards`;
    for (const c of cells) { const el = document.createElement('div'); el.className = 'cgrid-preview'; place(el, c); canvas.appendChild(el); }
  }

  async function save() {
    const err = $('[data-save-error]', root), say = (t) => { err.textContent = t; err.className = 'msg'; err.hidden = !t; };
    const bad = E.boxes.filter((b) => !(b.price > 0));
    if (bad.length) { E.sel = new Set(bad.map((b) => b.key)); refreshBoxes(); return say(`${bad.length} card${bad.length === 1 ? ' still needs' : 's still need'} a price — they're selected. Set a type or a price, then Apply.`); }
    say('');
    const boxes = E.boxes.map((b) => ({ ...(b.id ? { id: b.id } : {}), x: b.x, y: b.y, w: b.w, h: b.h, typeId: b.typeId, qty: b.qty, note: b.note || null, priceOverride: !!b.override, ...(b.override || !b.typeId ? { price: b.price } : {}) }));
    const r = await api('PUT', `/api/admin/card-boards/${E.board.id}/boxes`, { boxes }); if (!r.ok) return say(errText(r));
    const keep = new Set(); E.boxes = r.json.boxes.map((b) => ({ key: `s${b.id}`, ...b, override: b.priceOverride })); E.sel = keep; E.dirty = false; refreshBoxes(); const d = $('#dirtyNote', root); if (d) d.textContent = '';
    GOM.toast(`Saved ${E.boxes.length} card${E.boxes.length === 1 ? '' : 's'}.`);
  }
  function applySel() {
    const sel = [...E.sel].map(byKey).filter(Boolean); if (!sel.length) return;
    const t = $('#boxType', root).value, p = $('#boxPrice', root).value.trim(), q = $('#boxQty', root).value.trim(), note = $('#boxNote', root).value.trim();
    for (const b of sel) {
      if (t !== '') { b.typeId = t === '0' ? null : Number(t); if (b.typeId && !b.override) b.price = typeOf(b.typeId).price; }
      if (p !== '') { b.price = Number(p); b.override = true; }
      if (q !== '') b.qty = clamp(parseInt(q, 10) || 1, 1, 999);
      if (note !== '') b.note = note;
    }
    markDirty(); refreshBoxes();
  }
  function onKey(e) {
    if (!E || !document.body.contains($('#boardCanvas', root) || document.createElement('i'))) return leaveEditor();
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
    const sel = [...E.sel].map(byKey).filter(Boolean), step = e.shiftKey ? 0.01 : 0.001;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) { e.preventDefault(); return act('delete-boxes'); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); return act('select-all'); }
    if (e.key === 'Escape') { E.sel = new Set(); E.gridArea = null; refreshBoxes(); return refreshGridForm(); }
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d && sel.length) { e.preventDefault(); for (const b of sel) { b.x = r6(clamp(b.x + d[0], 0, 1 - b.w)); b.y = r6(clamp(b.y + d[1], 0, 1 - b.h)); } markDirty(); refreshBoxes(); }
  }

  // ── actions ──
  const say = (form, text) => { const m = $('[data-msg]', form); if (m) { m.textContent = text; m.className = 'msg'; m.hidden = !text; } };
  async function act(name, b) {
    const id = b ? Number(b.dataset.id) : null;
    switch (name) {
      case 'open-bundle': return go({ name: 'bundle', id });
      case 'back-list': return go({ name: 'list' });
      case 'back-bundle': if (E?.dirty && !(await GOM.confirm('You have unsaved changes to this board. Leave without saving them?', { ok: 'Leave without saving', cancel: 'Stay' }))) return; return go({ name: 'bundle', id: view.bundleId });
      case 'type-save': { const row = $(`[data-type-row="${id}"]`, root), r = await api('PATCH', `/api/admin/card-types/${id}`, { name: $('[data-type-name]', row).value.trim(), price: Number($('[data-type-price]', row).value) }); if (!r.ok) return GOM.toast(errText(r), true); await go(view); return GOM.toast(r.json.repriced ? `Saved — ${r.json.repriced} card${r.json.repriced === 1 ? '' : 's'} that ${r.json.repriced === 1 ? 'follows' : 'follow'} this price changed with it.` : 'Saved.'); }
      case 'type-del': { if (!(await GOM.confirm('Delete this card type? Cards of this type keep their current price (it becomes their own).', { ok: 'Delete the type', cancel: 'Keep it' }))) return; const r = await api('DELETE', `/api/admin/card-types/${id}`); if (!r.ok) return GOM.toast(errText(r), true); return go(view); }
      case 'status': { const r = await api('PATCH', `/api/admin/card-bundles/${view.id}`, { status: b.dataset.to }); if (!r.ok) return GOM.toast(errText(r), true); await go(view); return GOM.toast(b.dataset.to === 'open' ? 'Published.' : 'Closed.'); }
      case 'delete-bundle': { if (!(await GOM.confirm('Delete this bundle, its boards and every card on them? This can\'t be undone.', { ok: 'Delete it', cancel: 'Keep it' }))) return; const r = await api('DELETE', `/api/admin/card-bundles/${view.id}`); if (!r.ok) return GOM.toast(errText(r), true); return go({ name: 'list' }); }
      case 'edit-board': return openBoard(id);
      case 'delete-board': { if (!(await GOM.confirm('Delete this board and every card on it?', { ok: 'Delete it', cancel: 'Keep it' }))) return; const r = await api('DELETE', `/api/admin/card-boards/${id}`); if (!r.ok) return GOM.toast(errText(r), true); return go(view); }
      case 'mode-draw': case 'mode-grid': E.mode = name === 'mode-grid' ? 'grid' : 'draw'; E.gridArea = null; { const keep = E.dirty; draw(); E.dirty = keep; } return;
      case 'save-layout': return save();
      case 'apply': return applySel();
      case 'use-type-price': for (const x of [...E.sel].map(byKey)) if (x?.typeId) { x.override = false; x.price = typeOf(x.typeId).price; } markDirty(); return refreshBoxes();
      case 'delete-boxes': { const n = E.sel.size; E.boxes = E.boxes.filter((x) => !E.sel.has(x.key)); E.sel = new Set(); markDirty(); refreshBoxes(); return GOM.toast(`Removed ${n} card${n === 1 ? '' : 's'} from the board (press Save cards to keep that).`); }
      case 'select-all': E.sel = new Set(E.boxes.map((x) => x.key)); return refreshBoxes();
      case 'select-none': E.sel = new Set(); return refreshBoxes();
      case 'grid-cancel': E.gridArea = null; return refreshGridForm();
      case 'grid-make': { const v = gridVals(); const made = gridCells(E.gridArea, v.cols, v.rows, v.gap).map(newBox); E.boxes.push(...made); E.sel = new Set(made.map((x) => x.key)); E.gridArea = null; E.mode = 'draw'; markDirty(); { const keep = E.dirty; draw(); E.dirty = keep; } return GOM.toast(`Made ${made.length} boxes — they're selected, so you can set their type or price now.`); }
      default:
    }
  }
  const onClick = async (e) => {
    const row = e.target.closest('#boxList tr[data-key]'); if (row && E) { const k = row.dataset.key, multi = e.shiftKey || e.ctrlKey || e.metaKey; if (!multi) E.sel = new Set(); multi && E.sel.has(k) ? E.sel.delete(k) : E.sel.add(k); return refreshBoxes(); }
    const b = e.target.closest('[data-act]'); if (b) return act(b.dataset.act, b);
  };
  const onSubmit = async (e) => {
    const f = e.target; e.preventDefault();
    if (f.dataset.form === 'new-type') { const r = await api('POST', '/api/admin/card-types', { name: f.elements.name.value.trim(), price: Number(f.elements.price.value) }); if (!r.ok) return say(f, errText(r)); return go(view); }
    if (f.dataset.form === 'new-bundle') { const r = await api('POST', '/api/admin/card-bundles', readBundle(f)); if (!r.ok) return say(f, errText(r)); await go({ name: 'bundle', id: r.json.id }); return GOM.toast('Bundle created — now add a board photo.'); }
    if (f.dataset.form === 'bundle') { const r = await api('PATCH', `/api/admin/card-bundles/${f.dataset.id}`, readBundle(f)); if (!r.ok) return say(f, errText(r)); await go(view); return GOM.toast('Saved.'); }
  };
  const onChange = (e) => {
    const t = e.target;
    if (t.matches('[data-board-file]') && t.files?.[0]) return uploadBoard(t.files[0]);
    if (t.id === 'claimBoard') { view.claimBoard = t.value; return renderClaims(); }
    if (!E) return;
    if (t.id === 'zoomSel') { E.zoom = Number(t.value); $('#boardCanvas', root).style.width = `${E.zoom}%`; }
    if (t.id === 'brushType') E.brush.typeId = t.value ? Number(t.value) : null;
    if (t.id === 'brushPrice') E.brush.price = t.value.trim();
    if (t.id === 'brushQty') E.brush.qty = clamp(parseInt(t.value, 10) || 1, 1, 999);
  };
  const onInput = (e) => { if (E && ['gridCols', 'gridRows', 'gridGap'].includes(e.target.id)) refreshGridForm(); };

  GOM.registerTab({ id: 'cards', label: 'Cards', async render(el) { view = view.name === 'board' ? { name: 'bundle', id: view.bundleId } : view; await render(el); el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = onChange; el.oninput = onInput; } });
})();
