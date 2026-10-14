// Claims tab: everyone's claims, grouped by group order then person. Secure, edit costs, move along the pipeline, cancel.
(function () {
  const { esc, money, fmtDate, api, errText, $, $$ } = GOM;
  const CATS = [['initials', 'Initials'], ['ems', 'EMS'], ['customs', 'Customs'], ['doms', 'Doms'], ['packaging', 'Packaging']];
  const PIPELINE = ['awaiting fulfillment', 'ordered via proxy / warehouse', 'arrived at proxy / warehouse', 'shipping requested',
    'enroute to GOM', 'arrived at GOM', 'checking parcel', 'ready to pack / on hand', 'packed', 'shipped', 'completed'];
  const BULK_STAGES = ['awaiting fulfillment', 'ordered via proxy / warehouse', 'arrived at proxy / warehouse', 'arrived at GOM', 'checking parcel', 'ready to pack / on hand'];
  const SORTS = [['person', 'Person (A–Z)'], ['owed', 'Most owed first'], ['stage', 'Earliest stage first'], ['newest', 'Newest first']];
  let root = null, orders = [], claims = [], people = {}, cancelReqs = [], cancelDone = [];
  const filter = { order: '', status: 'active', q: '', stage: '', unpaid: false, sort: 'person' };
  const picked = new Set();    // claim ids ticked for a bulk stage move
  let moveState = null;        // the "move to another person" panel: { handle, create, preview, previewFor, error }
  const open = new Set();      // "orderId::handle" accordions that are open
  let editing = null;          // claim id being edited
  // "Fix…" on a claim row: change WHAT it is (item / size / member, with the price question asked each time), delete it outright (when nothing has been paid), or turn a filler line into credit
  let fixing = null;
  const fixS = { mode: 'change', plan: null, orderId: '', itemId: '', member: '', variant: '', pricing: '', amount: '', reason: '' };
  // "Add a claim for someone": a panel for the GOM to enter a claim on a person's behalf (a gap in an import, or an order that came by DM, often on a private group order)
  let addOpen = false, addMsg = null, addLook = { for: '', exact: false, blocked: false, matches: [] }, lookTimer = null;     // addLook: what the server said about the handle typed so far
  const addS = { handle: '', create: false, orderId: '', itemId: '', qty: '1', variant: '', parts: {}, together: false, status: '', stage: 'awaiting fulfillment' };
  let view = 'person';         // "By person" or "By item" (remembered in this browser)
  try { if (localStorage.getItem('gom.claims.view') === 'item') view = 'item'; } catch { /* private window: just don't remember */ }
  const openGroups = new Set();   // merged rows ("×5") that are expanded to their individual claims
  const goChosen = new Map();     // group order id → true/false once you've opened or closed it yourself; otherwise a short list (3 orders or fewer), or any search/filter, opens by itself
  const shown = new Map();        // how many people / items a group order's card lists (grows by PAGE with "Show more")
  const PAGE = 25;
  let truncated = false;          // the server had more claims than it sends — the screen says so

  async function render(el) {
    root = el;
    const [o, c, cr, cd] = await Promise.all([api('GET', '/api/admin/orders'), api('GET', `/api/admin/claims${filter.order ? `?order=${filter.order}` : ''}`), api('GET', '/api/admin/cancel-requests'), api('GET', '/api/admin/cancel-requests?status=decided')]);
    orders = o.json?.orders || []; claims = c.json?.claims || []; people = c.json?.people || {};
    cancelReqs = cr.json?.requests || []; cancelDone = cd.json?.requests || [];
    truncated = !!c.json?.truncated;
    draw();
  }

  const owedOf = (c) => (c.status !== 'confirmed' ? 0 : CATS.reduce((s, [k]) => s + Math.max(0, (c.costs[k]?.cost || 0) - (c.costs[k]?.paid || 0)), 0));
  const paidOf = (c) => CATS.reduce((s, [k]) => s + (c.costs[k]?.paid || 0), 0);
  const statusPill = (s) => `<span class="pill ${s === 'confirmed' ? 'ok' : s === 'requested' ? 'warn' : 'dim'}">${s === 'requested' ? 'requested' : s}</span>`;

  function visible(opts = {}) {
    const q = filter.q.trim().toLowerCase().replace(/^@/, '');
    return claims.filter((c) => {
      if (filter.status === 'active' ? c.status === 'cancelled' : filter.status !== 'all' && c.status !== filter.status) return false;
      if (filter.stage && !opts.ignoreStage && c.pipeline !== filter.stage) return false;
      if (filter.unpaid && owedOf(c) <= 0) return false;
      return !q || c.handle.includes(q) || c.label.toLowerCase().includes(q);
    });
  }

  function fixPanel(c) {
    const p = fixS.plan, btn = (m, l) => `<button type="button" class="sm ${fixS.mode === m ? '' : 'secondary'}" data-act="fix-mode" data-mode="${m}" aria-pressed="${fixS.mode === m}">${l}</button>`;
    const head = `<div class="row"><strong>Fix “${esc(c.label)}” — @${esc(c.handle)}${c.orderTitle ? ` · ${esc(c.orderTitle)}` : ''}</strong><button type="button" class="sm secondary" data-act="fix-close">Close</button></div>`;
    if (!p || p.id !== c.id) return `<tr><td colspan="7"><div data-form="fix" data-id="${c.id}">${head}<p class="sub">Checking what can be done…</p></div></td></tr>`;
    const blocked = (reasons, hint) => `<div class="msg err" data-fix-blocked>${reasons.map((r) => `<div>${esc(r)}</div>`).join('')}${hint ? `<div style="margin-top:6px">${hint}</div>` : ''}</div>`;
    let body = '';
    if (fixS.mode === 'change') {
      if (!p.change.ok) body = blocked(p.change.reasons);
      else {
        const live = orders.filter((o) => !o.cancelled), items = (orders.find((o) => String(o.id) === String(fixS.orderId))?.items || []).filter((i) => !i.cancelled && i.type !== 'set'), it = items.find((i) => String(i.id) === String(fixS.itemId));
        const changedItem = it && String(it.id) !== String(p.itemId), askPrice = changedItem && (it.priceTbc || Number(it.price) !== Number(p.cost));
        body = `<div class="formgrid"><div><label>Group order</label><select name="orderId">${live.map((o) => `<option value="${o.id}" ${String(o.id) === String(fixS.orderId) ? 'selected' : ''}>${esc(o.title)}${o.isPrivate ? ' (private)' : ''}${o.status && o.status !== 'open' ? ` (${esc(o.status)})` : ''}</option>`).join('')}</select></div>
          <div><label>Item</label><select name="itemId"><option value="">Choose…</option>${items.map((i) => `<option value="${i.id}" ${String(i.id) === String(fixS.itemId) ? 'selected' : ''}>${esc(i.title)}${i.priceTbc ? ' (price TBC)' : i.price != null ? ` — ${money(i.price)}` : ''}</option>`).join('')}</select></div>
          ${it?.type === 'independent' ? `<div><label>Member</label><select name="member"><option value="">Choose…</option>${it.members.map((m) => `<option ${m.name === fixS.member ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>` : ''}
          ${it?.type === 'size' ? `<div><label>Size</label><select name="variant"><option value="">Choose…</option>${(it.variants || []).map((v) => `<option ${v === fixS.variant ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>` : ''}</div>
          ${askPrice ? `<div class="sub" style="margin:10px 0 4px; font-weight:600" data-ask-price>What should happen to its price? — you choose each time</div>
            <label class="chk"><input type="radio" name="pricing" value="reprice" ${fixS.pricing === 'reprice' ? 'checked' : ''}> <strong>Re-price it</strong> — set it to the new item's price (${it.priceTbc ? 'TBC' : money(it.price)}). What's already paid is kept, so any difference shows as owed or as credit.</label>
            <label class="chk"><input type="radio" name="pricing" value="keep" ${fixS.pricing === 'keep' ? 'checked' : ''}> <strong>Keep the old price</strong> (${money(p.cost)}) — only what it's called changes.</label>` : ''}
          ${changedItem ? '<p class="sub">If you have already recorded a payment to a proxy for the old item, check the Proxy tab.</p>' : ''}
          <p class="msg err" data-fix-error hidden></p><div class="btn-row"><button type="button" class="sm" data-act="fix-change">Change it…</button></div>`;
      }
    } else if (fixS.mode === 'delete') {
      body = !p.delete.ok ? blocked(p.delete.reasons)
        : `<p class="sub" style="margin:6px 0">Removes it completely, as if it had never been added — it isn't kept anywhere, and it can't be undone. They stay on the site; nothing else changes.</p><p class="msg err" data-fix-error hidden></p><div class="btn-row"><button type="button" class="sm" data-act="fix-delete">Delete it…</button></div>`;
    } else {
      body = !p.credit.ok ? blocked(p.credit.reasons)
        : `<p class="sub" style="margin:6px 0">For a line that stood for credit rather than a real item: adds this credit to @${esc(c.handle)}'s account (it's used on anything they owe) and removes the line.</p>
          <div class="formgrid"><div><label>Credit (£)</label><input name="amount" type="number" step="0.01" min="0.01" value="${esc(fixS.amount)}"></div><div class="span2"><label>Reason (they can see this)</label><input name="reason" maxlength="255" value="${esc(fixS.reason)}"></div></div>
          <p class="msg err" data-fix-error hidden></p><div class="btn-row"><button type="button" class="sm" data-act="fix-credit">Turn into credit…</button></div>`;
    }
    return `<tr><td colspan="7"><div data-form="fix" data-id="${c.id}">${head}<div class="btn-row" style="margin:8px 0" role="group" aria-label="What to do">${btn('change', 'Change what it is')}${btn('delete', 'Delete it')}${btn('credit', 'Turn into credit')}</div>${body}</div></td></tr>`;
  }
  function readFix(t) {
    if (t.name === 'orderId') { fixS.orderId = t.value; fixS.itemId = ''; fixS.member = ''; fixS.variant = ''; fixS.pricing = ''; }
    else if (t.name === 'itemId') { fixS.itemId = t.value; fixS.member = ''; fixS.variant = ''; fixS.pricing = ''; }
    else if (t.name === 'member') fixS.member = t.value; else if (t.name === 'variant') fixS.variant = t.value; else if (t.name === 'pricing') fixS.pricing = t.value;
    else if (t.name === 'amount') fixS.amount = t.value; else if (t.name === 'reason') fixS.reason = t.value;
  }
  const fixErr = (text) => { const m = $('[data-form="fix"] [data-fix-error]', root); if (m) { m.textContent = text; m.hidden = !text; } else GOM.toast(text, true); };
  function claimRow(c) {
    if (fixing === c.id) return fixPanel(c);
    if (editing === c.id) {
      return `<tr><td colspan="7"><form data-form="edit-costs" data-id="${c.id}"><strong>${esc(c.label)}</strong>
        <div class="cost-edit" style="margin:10px 0"><span></span><span class="sub">Cost (£)</span><span class="sub">Paid (£)</span>
        ${CATS.map(([k, name]) => `<span>${name}</span><input type="number" step="0.01" min="0" name="${k}_cost" value="${c.costs[k]?.cost ?? 0}"><input type="number" step="0.01" min="0" name="${k}_paid" value="${c.costs[k]?.paid ?? 0}">`).join('')}</div>
        <p class="sub">Raising a cost never changes what's already been paid. A paid amount above the cost becomes credit.</p>
        <p class="msg" data-msg hidden></p>
        <div class="btn-row"><button type="submit" class="sm">Save</button><button type="button" class="sm secondary" data-act="cancel-edit">Cancel</button></div></form></td></tr>`;
    }
    const owed = owedOf(c);
    return `<tr data-claim="${c.id}"><td>${c.status === 'confirmed' ? `<input type="checkbox" data-act="pick" data-id="${c.id}" ${picked.has(c.id) ? 'checked' : ''} aria-label="Select ${esc(c.label)}">` : ''}</td><td>${esc(c.label)} ${c.setId ? '<span class="pill">set part</span>' : ''}${c.is_fixed ? '<span class="pill">fixed</span>' : ''}${c.is_direct ? '<span class="pill">assigned</span>' : ''}</td>
      <td>${statusPill(c.status)}</td>
      <td>${c.status === 'cancelled' ? '<span class="sub">—</span>' : `<select data-act-change="pipeline" data-id="${c.id}">${PIPELINE.map((p) => `<option ${p === c.pipeline ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>`}</td>
      <td class="nowrap">${c.priceTbc ? '<span class="pill warn">Price TBC</span>' : ''}${CATS.map(([k, name]) => (c.costs[k]?.cost || c.costs[k]?.paid) ? `<div class="sub">${name} ${money(c.costs[k].cost)} <span class="${c.costs[k].paid >= c.costs[k].cost ? '' : 'pill warn'}">paid ${money(c.costs[k].paid)}</span></div>` : '').join('')}</td>
      <td class="nowrap">${c.status === 'confirmed' ? (owed > 0 ? `<strong>${money(owed)}</strong> owed` : '<span class="pill ok">paid</span>') : '—'}</td>
      <td class="nowrap">${c.status === 'cancelled' ? '' : `<button class="sm secondary" data-act="edit" data-id="${c.id}">Edit costs</button> <button class="sm secondary" data-act="fix" data-id="${c.id}">Fix…</button> <button class="sm secondary" data-act="cancel" data-id="${c.id}">Cancel</button>`}</td></tr>`;
  }


  // ── scale: identical confirmed claims show as ONE row ("independent item — Felix ×5"); expand it for the individual claims ──
  const costsCell = (c) => `<td class="nowrap">${c.priceTbc ? '<span class="pill warn">Price TBC</span>' : ''}${CATS.map(([k, name]) => (c.costs[k]?.cost || c.costs[k]?.paid) ? `<div class="sub">${name} ${money(c.costs[k].cost)} <span class="${c.costs[k].paid >= c.costs[k].cost ? '' : 'pill warn'}">paid ${money(c.costs[k].paid)}</span></div>` : '').join('')}</td>`;
  const sig = (c) => CATS.map(([k]) => `${c.costs[k]?.cost || 0}/${c.costs[k]?.paid || 0}`).join(',');
  const mergeKey = (c) => (c.status === 'confirmed' && !c.setId ? [c.label, c.pipeline, c.isFixed || c.is_fixed ? 1 : 0, c.priceTbc ? 1 : 0, sig(c)].join('|') : null);
  function mergedRow(g) {
    const first = g[0], ids = g.map((c) => c.id), key = `g${ids[0]}x${ids.length}`, isOpen = openGroups.has(key);
    const owed = g.reduce((s, c) => s + owedOf(c), 0);
    return `<tr data-group="${key}"><td><input type="checkbox" data-act="pick-person" data-ids="${ids.join(',')}" ${ids.every((i) => picked.has(i)) ? 'checked' : ''} aria-label="Select all ${ids.length} of ${esc(first.label)}"></td>
      <td>${esc(first.label)} <span class="pill" data-times>×${ids.length}</span> <button class="ghost sm" data-act="group-toggle" data-key="${key}" style="border:0">${isOpen ? 'Hide the' : 'Show the'} ${ids.length}</button></td>
      <td>${statusPill('confirmed')}</td>
      <td><select data-act-change="pipeline-group" data-ids="${ids.join(',')}" aria-label="Stage for all ${ids.length}">${PIPELINE.map((p) => `<option ${p === first.pipeline ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></td>
      ${costsCell(first).replace('</td>', '<div class="sub">each</div></td>')}
      <td class="nowrap">${owed > 0 ? `<strong>${money(owed)}</strong> owed` : '<span class="pill ok">paid</span>'}</td><td></td></tr>`;
  }
  function rowsFor(cs) {
    const groups = new Map();
    for (const c of cs) { const k = mergeKey(c); if (k) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); } }
    const done = new Set(), out = [];
    for (const c of cs) {
      const k = mergeKey(c), g = k && groups.get(k);
      if (!g || g.length < 2) { out.push(claimRow(c)); continue; }
      if (done.has(k)) continue; done.add(k);
      out.push(mergedRow(g));
      if (openGroups.has(`g${g[0].id}x${g.length}`) || (editing && g.some((x) => x.id === editing))) g.forEach((x) => out.push(claimRow(x)));
    }
    return out.join('');
  }
  // "20 ready to pack / on hand · 5 ordered …" on a collapsed line, so you can see where someone's claims are without opening them
  function stageMix(cs) {
    const n = new Map(); for (const c of cs) if (c.status === 'confirmed') n.set(c.pipeline, (n.get(c.pipeline) || 0) + 1);
    const top = PIPELINE.filter((p) => n.get(p)).map((p) => `<span class="pill dim" data-mix>${n.get(p)} ${esc(p)}</span>`);
    return top.length ? ` ${top.slice(0, 3).join(' ')}${top.length > 3 ? ` <span class="sub">+${top.length - 3} more</span>` : ''}` : '';
  }
  // a strip of stages with counts — click one to filter to it, click again to clear
  function strip() {
    const base = visible({ ignoreStage: true });
    const n = new Map(); for (const c of base) if (c.status === 'confirmed') n.set(c.pipeline, (n.get(c.pipeline) || 0) + 1);
    const owing = base.filter((c) => owedOf(c) > 0).length, requested = base.filter((c) => c.status === 'requested').length;
    const chip = (act, label, count, on, extra = '') => `<button class="sm ${on ? '' : 'secondary'}" data-act="${act}" ${extra} aria-pressed="${on}">${label} <strong>${count}</strong></button>`;
    const chips = [...PIPELINE.filter((p) => n.get(p)).map((p) => chip('stage-chip', esc(p), n.get(p), filter.stage === p, `data-stage="${esc(p)}"`)),
      owing ? chip('owing-chip', 'owing money', owing, filter.unpaid) : '', requested ? chip('requested-chip', 'waiting to be secured', requested, filter.status === 'requested') : ''].filter(Boolean);
    return chips.length ? `<div class="card" id="stageStrip"><div class="sub" style="margin-bottom:6px">Where everything is — click one to show just those</div><div class="btn-row" style="flex-wrap:wrap; gap:6px; margin:0">${chips.join('')}</div></div>` : '';
  }
  const more = (total, limit, key, noun) => (total > limit ? `<div style="margin-top:10px"><button class="sm secondary" data-act="more" data-key="${key}">Show ${Math.min(PAGE, total - limit)} more ${noun} (${total - limit} not shown)</button></div>` : '');
  const searching = () => !!filter.q.trim();
  const goOpen = (key, n) => (goChosen.has(key) ? goChosen.get(key) : (searching() || !!filter.stage || !!filter.unpaid || n <= 3));
  function allKeys() {                                            // every person (or item) currently listed, for "Expand all"
    const keys = new Set();
    for (const c of visible()) keys.add(view === 'item' ? `i:${c.order_id || 0}::${c.label}` : `${c.order_id || 0}::${c.handle}`);
    return keys;
  }
  // ── the "By item" view: one block per item with its total, then who has it ──
  function itemsBlock(g) {
    const by = new Map();
    for (const c of [...g.people.values()].flat()) { if (!by.has(c.label)) by.set(c.label, []); by.get(c.label).push(c); }
    const entries = [...by.entries()].sort(([a], [b]) => a.localeCompare(b)), k = `i${g.id || 0}`, limit = searching() ? entries.length : (shown.get(k) || PAGE);
    return entries.slice(0, limit).map(([label, cs]) => itemBlock(g, label, cs)).join('') + more(entries.length, limit, k, 'items');
  }
  function itemBlock(g, label, cs) {
    const key = `i:${g.id || 0}::${label}`, isOpen = open.has(key) || searching();
    const ids = confirmedIds(cs), owed = cs.reduce((s, c) => s + owedOf(c), 0), req = cs.filter((c) => c.status === 'requested').length, byWho = new Map();
    for (const c of cs) { if (!byWho.has(c.handle)) byWho.set(c.handle, []); byWho.get(c.handle).push(c); }
    const stageOf = (l) => { const st = [...new Set(l.map((c) => c.pipeline))]; return st.length === 1 ? esc(st[0]) : `<span class="sub">mixed: ${st.map(esc).join(', ')}</span>`; };
    return `<div style="border-top:1px solid var(--line); margin-top:10px; padding-top:8px" data-item="${esc(label)}">
      <div class="row"><span style="display:flex; align-items:center; gap:6px">${ids.length ? `<input type="checkbox" data-act="pick-person" data-ids="${ids.join(',')}" ${ids.every((i) => picked.has(i)) ? 'checked' : ''} aria-label="Select all confirmed claims for ${esc(label)}">` : ''}<button class="ghost sm" data-act="toggle" data-key="${esc(key)}" style="border:0">${isOpen ? '▾' : '▸'} <strong>${esc(label)}</strong></button></span>
        <span class="sub">${cs.length} claim${cs.length === 1 ? '' : 's'} · ${byWho.size} ${byWho.size === 1 ? 'person' : 'people'}${req ? ` · <span class="pill warn">${req} requested</span>` : ''}${owed > 0 ? ` · owed <strong>${money(owed)}</strong>` : ''}</span></div>
      <div>${stageMix(cs)}</div>
      ${isOpen ? `<div class="scroll"><table class="grid"><thead><tr><th>Person</th><th>Claims</th><th>Stage</th><th>Owed</th></tr></thead><tbody>${[...byWho.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([h, l]) => `<tr data-who="${esc(h)}"><td>@${esc(h)}</td><td>${l.length}</td><td>${stageOf(l)}${l.some((c) => c.status === 'requested') ? ' <span class="pill warn">requested</span>' : ''}</td><td class="nowrap">${(() => { const o = l.reduce((s, c) => s + owedOf(c), 0); return o > 0 ? `<strong>${money(o)}</strong>` : '<span class="pill ok">paid</span>'; })()}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>`;
  }

  // one person's block in a group order's card
  const personBlock = (g, [handle, rawCs]) => {
            const cs = sortClaims(rawCs);
            const key = `${g.id || 0}::${handle}`, isOpen = open.has(key) || searching() || editing && cs.some((c) => c.id === editing);
            const owed = cs.reduce((s, c) => s + owedOf(c), 0), req = cs.filter((c) => c.status === 'requested').length;
            return `<div style="border-top:1px solid var(--line); margin-top:10px; padding-top:8px" data-buyer="${esc(handle)}">
              <div class="row"><span style="display:flex; align-items:center; gap:6px">${confirmedIds(cs).length ? `<input type="checkbox" data-act="pick-person" data-ids="${confirmedIds(cs).join(',')}" ${confirmedIds(cs).every((i) => picked.has(i)) ? 'checked' : ''} aria-label="Select all of @${esc(handle)}'s confirmed claims here">` : ''}<button class="ghost sm" data-act="toggle" data-key="${esc(key)}" style="border:0">${isOpen ? '▾' : '▸'} <strong>@${esc(handle)}</strong></button></span>
              <span class="sub">${cs.length} claim${cs.length === 1 ? '' : 's'}${req ? ` · <span class="pill warn">${req} requested</span>` : ''}${owed > 0 ? ` · owes <strong>${money(owed)}</strong>` : ''}</span></div>
              <div>${stageMix(cs)}</div>
              ${totalsLine(handle)}
              ${isOpen ? `<div class="scroll"><table class="grid"><thead><tr><th></th><th>Item</th><th>Status</th><th>Stage</th><th>Costs</th><th>Owed</th><th></th></tr></thead><tbody>${rowsFor(cs)}</tbody></table></div>` : ''}</div>`;
  };
  function peopleBlock(g) {
    const entries = sortPeople([...g.people.entries()]), k = `p${g.id || 0}`, limit = searching() ? entries.length : (shown.get(k) || PAGE);
    return entries.slice(0, limit).map((e) => personBlock(g, e)).join('') + more(entries.length, limit, k, 'people');
  }

  const stageIdx = (p) => PIPELINE.indexOf(p);
  function sortClaims(cs) {
    const by = { person: (a, b) => a.id - b.id, owed: (a, b) => owedOf(b) - owedOf(a) || a.id - b.id, stage: (a, b) => stageIdx(a.pipeline) - stageIdx(b.pipeline) || a.id - b.id, newest: (a, b) => b.id - a.id }[filter.sort];
    return cs.slice().sort(by);
  }
  function sortPeople(entries) {                       // entries: [handle, that person's claims here]
    const key = {
      person: ([a], [b]) => a.localeCompare(b),
      owed: ([a], [b]) => (people[b]?.owed || 0) - (people[a]?.owed || 0) || a.localeCompare(b),
      stage: ([a, ca], [b, cb]) => Math.min(...ca.map((c) => stageIdx(c.pipeline))) - Math.min(...cb.map((c) => stageIdx(c.pipeline))) || a.localeCompare(b),
      newest: ([a, ca], [b, cb]) => Math.max(...cb.map((c) => c.id)) - Math.max(...ca.map((c) => c.id)) || a.localeCompare(b),
    }[filter.sort];
    return entries.slice().sort(key);
  }
  const totalsLine = (h) => (people[h] ? `<div class="sub" data-totals="${esc(h)}">Overall: owes <strong>${money(people[h].owed)}</strong> · paid ${money(people[h].paid)} · credit ${money(people[h].credit)}</div>` : '');
  const confirmedIds = (cs) => cs.filter((c) => c.status === 'confirmed').map((c) => c.id);
  const pickRow = (g) => { const ids = confirmedIds([...g.people.values()].flat()); return ids.length ? `<div style="margin-top:8px"><button class="sm secondary" data-act="pick-order" data-ids="${ids.join(',')}">${ids.every((i) => picked.has(i)) ? 'Unselect' : 'Select'} all ${ids.length} confirmed claim${ids.length === 1 ? '' : 's'} here</button></div>` : ''; };
  // "Move these claims to someone else" — always checks first and shows exactly what would happen.
  const pickKey = () => [...picked].sort((a, b) => a - b).join(',');
  function movePanel() {
    if (!moveState) return '';
    const pv = moveState.previewFor === pickKey() ? moveState.preview : null;           // a check made for a different selection is out of date
    const t = pv?.target;
    const need = t && !t.exists && !t.blocked;
    const targetLine = !t ? '' : t.blocked ? `<span class="pill warn">@${esc(t.handle)} is blocked</span>` : t.exists ? (t.signedUp ? `<span class="pill ok">@${esc(t.handle)} is already signed up</span>` : `<span class="pill">@${esc(t.handle)} is on the site but hasn't signed in yet</span>`)
      : `<span class="pill warn">@${esc(t.handle)} isn't on the site yet</span> <label class="chk" style="display:inline-flex"><input type="checkbox" id="moveCreate" ${moveState.create ? 'checked' : ''}> Create @${esc(t.handle)} and move the claims there</label>`;
    return `<div id="movePanel" style="margin-top:10px; padding-top:10px; border-top:1px solid var(--line)"><strong>Move the ${picked.size} selected claim${picked.size === 1 ? '' : 's'} to another person</strong>
      <p class="sub" style="margin:4px 0 8px">Everything goes with them — costs, stage, dates and the money already paid. A claim that can't be moved safely stays where it is, and you'll see why.</p>
      <div class="btn-row" style="align-items:end; margin:0"><div><label for="moveHandle">Their Instagram handle</label><input id="moveHandle" value="${esc(moveState.handle)}" maxlength="31" placeholder="@handle" autocomplete="off" style="max-width:220px"></div>
        <button class="sm" data-act="move-check">Check</button><button class="sm secondary" data-act="move-close">Cancel</button></div>
      ${moveState.error ? `<p class="msg" style="margin:8px 0 0">${esc(moveState.error)}</p>` : ''}
      ${pv ? `<div data-move-preview style="margin-top:10px"><div>${targetLine}</div>
        <p style="margin:8px 0 4px"><strong>${pv.movable.length}</strong> can move${pv.blocked.length ? ` · <strong>${pv.blocked.length}</strong> can't` : ''}. <span data-move-money>${money(pv.money.paid)} already paid goes with them; ${money(pv.money.owed)} is still owed.</span>${pv.parcels.length ? ` ${pv.parcels.length} shipped parcel${pv.parcels.length === 1 ? ' goes' : 's go'} with ${pv.parcels.length === 1 ? 'its' : 'their'} claims.` : ''}</p>
        ${pv.blocked.length ? `<ul style="margin:0 0 8px; padding-left:20px" data-move-blocked>${pv.blocked.slice(0, 8).map((b) => `<li>${esc(b.label)} — ${esc(b.reason)}</li>`).join('')}${pv.blocked.length > 8 ? `<li class="sub">…and ${pv.blocked.length - 8} more</li>` : ''}</ul>` : ''}
        <button data-act="move-go" ${pv.movable.length && t && !t.blocked && (t.exists || moveState.create) ? '' : 'disabled'}>Move ${pv.movable.length} claim${pv.movable.length === 1 ? '' : 's'} to @${esc(t.handle)}</button></div>` : ''}</div>`;
  }
  const bulkBar = () => `<div class="card" id="bulkBar" style="position:sticky; top:0; z-index:5; background:var(--paper)"><div class="row"><strong>${picked.size} claim${picked.size === 1 ? '' : 's'} selected</strong>
      <div class="btn-row" style="margin:0; align-items:center"><label for="bulkStage" class="sub" style="margin:0">Move to</label><select id="bulkStage">${BULK_STAGES.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
        <button class="sm" data-act="bulk-apply">Move them</button><button class="sm secondary" data-act="move-open">Move to another person…</button><button class="sm secondary" data-act="bulk-delete">Delete…</button><button class="sm secondary" data-act="bulk-clear">Clear</button></div></div>${movePanel()}</div>`;

  // Joiners' requests to cancel an item. You decide each one, and choose how much of what they paid to KEEP as a cancellation fee.
  const asked = (iso) => `${fmtDate((iso || '').slice(0, 10))} ${(iso || '').slice(11, 16)}`;
  function cancelCard() {
    if (!cancelReqs.length && !cancelDone.length) return '';
    return `<div class="card" id="cancelRequests"><h2>Cancellation requests ${cancelReqs.length ? `<span class="pill warn" data-cancel-count>${cancelReqs.length}</span>` : ''}</h2>
      ${cancelReqs.length ? `<p class="sub">Joiners have asked to cancel these. Nothing happens until you approve. When you do, what they've paid comes back as credit — less any cancellation fee you choose to keep.</p>` : '<p class="muted">No requests waiting.</p>'}
      ${cancelReqs.map((r) => `<div class="itemrow" data-cancel-req="${r.id}" data-paid="${r.paid}" style="align-items:flex-start"><div class="grow">
          <strong>@${esc(r.handle)}</strong> asks to cancel “${esc(r.label)}” <span class="sub">(${esc(r.orderTitle || 'Shop')})</span>
          <div class="sub">At: ${esc(r.claimStatus === 'requested' ? 'not confirmed yet' : (r.stage || r.pipeline))} · paid ${money(r.paid)} of ${money(r.cost)} · asked ${asked(r.requestedAt)}</div>
          ${r.reason ? `<div class="sub" data-cancel-reason>“${esc(r.reason)}”</div>` : ''}
          ${r.problem ? `<div class="msg" data-cancel-problem style="margin:6px 0">${esc(r.problem)}</div>` : ''}
          ${r.setPart ? '<div class="sub" data-cancel-warn>Part of a member set — approving frees the part (you may need to refill it).</div>' : ''}
          ${r.boxId ? `<div class="sub" data-cancel-warn>In box #${r.boxId} — it may already be on its way to you.</div>` : ''}
          ${r.blocked ? '<div class="sub" data-cancel-warn>This handle is blocked, so anything they paid is forfeited rather than credited.</div>' : ''}
          <div class="formgrid" style="max-width:640px; margin-top:8px"><div><label>Keep as a cancellation fee (£)</label><input data-keep type="number" step="0.01" min="0" max="${r.paid}" value="0" ${r.paid > 0 ? '' : 'disabled'} aria-label="Cancellation fee to keep"></div>
            <div class="span2"><label>Message to them (optional)</label><input data-note maxlength="500" placeholder="e.g. the proxy order was already placed"></div></div>
          <div class="sub" data-keep-preview>${r.paid > 0 ? `They'd get ${money(r.paid)} back as credit.` : "They haven't paid anything towards it, so there's nothing to return."}</div></div>
        <div class="btn-row" style="margin:0"><button data-act="cancel-approve" data-id="${r.id}" ${r.problem ? 'disabled' : ''}>Approve cancellation</button><button class="secondary" data-act="cancel-decline" data-id="${r.id}">Decline</button></div></div>`).join('')}
      ${cancelDone.length ? `<details style="margin-top:10px"><summary>Recently decided (${cancelDone.length})</summary>${cancelDone.map((r) => `<div class="sub" data-cancel-done style="margin:6px 0">@${esc(r.handle)} — “${esc(r.label)}” — <strong>${r.status}</strong>${r.status === 'approved' ? ` (${money(r.refunded || 0)} back as credit${Number(r.kept) > 0 ? `, ${money(r.kept)} kept` : ''})` : ''}${r.decisionNote ? ` · “${esc(r.decisionNote)}”` : ''} · ${asked(r.decidedAt)}</div>`).join('')}</details>` : ''}</div>`;
  }
  async function cancelAction(b) {
    const id = Number(b.dataset.id), row = b.closest('[data-cancel-req]'), r = cancelReqs.find((x) => x.id === id);
    const note = $('[data-note]', row).value.trim();
    if (b.dataset.act === 'cancel-decline') {
      if (!(await GOM.confirm(`Decline @${r.handle}'s request to cancel “${r.label}”?\n\nIt stays exactly as it is.${note ? ' They will see your message.' : ''}`, { ok: 'Decline it', cancel: 'Not yet' }))) return;
      const res = await api('POST', `/api/admin/cancel-requests/${id}/decline`, note ? { note } : {});
      await render(root); GOM.refreshBadges(); return GOM.toast(res.ok ? 'Declined.' : errText(res), !res.ok);
    }
    const keep = Number($('[data-keep]', row).value || 0);
    if (Number.isNaN(keep) || keep < 0) return GOM.toast('The cancellation fee must be £0 or more.', true);
    if (keep > r.paid + 0.004) return GOM.toast(`They have only paid ${money(r.paid)}, so you can't keep ${money(keep)}.`, true);
    const back = Math.round((r.paid - keep) * 100) / 100;
    const ok = await GOM.confirm(`Cancel “${r.label}” for @${r.handle}?\n\n${r.blocked ? `Their handle is blocked, so ${money(r.paid)} is forfeited, not credited.` : r.paid > 0 ? `${money(back)} goes back to them as credit${keep > 0 ? `; you keep ${money(keep)} as a cancellation fee` : ''}.` : "They haven't paid anything, so there's nothing to return."}${note ? '\n\nThey will see your message.' : ''}`, { ok: 'Approve cancellation', cancel: 'Not yet' });
    if (!ok) return;
    const res = await api('POST', `/api/admin/cancel-requests/${id}/approve`, { keep, ...(note ? { note } : {}) });
    await render(root); GOM.refreshBadges();
    GOM.toast(res.ok ? `Cancelled — ${money(res.json.refunded)} returned as credit${res.json.kept > 0 ? `, ${money(res.json.kept)} kept` : ''}.` : errText(res), !res.ok);
  }

  // ── Add a claim for someone ──
  const addItems = () => (orders.find((o) => String(o.id) === String(addS.orderId))?.items || []).filter((i) => !i.cancelled);
  const addItem = () => addItems().find((i) => String(i.id) === String(addS.itemId));
  const cleanHandle = (h) => String(h || '').trim().replace(/^@+/, '').toLowerCase();
  function addDetail(it) {
    if (!it) return '';
    const tbc = it.priceTbc ? '<p class="sub" data-tbc>The price is still TBC — you can add this as a request, but it can\'t be confirmed until the price is set.</p>' : '';
    const num = (name, val, lab) => `<label class="sub" style="display:inline-flex; align-items:center; gap:6px; margin:0 12px 6px 0">${lab}<input type="number" min="0" max="20" ${name} value="${esc(val)}" style="width:70px; padding:5px 8px"></label>`;
    if (it.type === 'set') return `${tbc}<div class="sub" style="margin:8px 0 4px; font-weight:600">Which parts, and how many of each</div><div>${it.members.map((m) => num(`data-part="${esc(m.name)}"`, addS.parts[m.name] || '', esc(m.name))).join('')}</div>
      ${it.members.length > 1 ? `<label class="chk"><input type="checkbox" name="together" ${addS.together ? 'checked' : ''}> Keep these together in the same set</label>` : ''}<p class="sub">They are placed exactly as when a joiner claims: the first set with room, or a new one. A set's parts only confirm once their set is secured (Sets tab).</p>`;
    if (it.type === 'independent') return `${tbc}<div class="sub" style="margin:8px 0 4px; font-weight:600">Which members, and how many of each</div><div>${it.members.map((m) => num(`data-part="${esc(m.name)}"`, addS.parts[m.name] || '', esc(m.name))).join('')}</div>`;
    if (it.type === 'size') return `${tbc}<div class="formgrid"><div><label>Size</label><select name="variant"><option value="">Choose a size…</option>${(it.variants || []).map((v) => `<option ${v === addS.variant ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div><div><label>How many</label><input name="qty" type="number" min="1" max="20" value="${esc(addS.qty)}"></div></div>`;
    return `${tbc}<div class="formgrid"><div><label>How many</label><input name="qty" type="number" min="1" max="20" value="${esc(addS.qty)}"></div></div>`;
  }
  function addCard() {
    if (!addOpen) return '';
    const live = orders.filter((o) => !o.cancelled), it = addItem();
    return `<form class="card" id="addClaim" data-form="add-claim"><div class="row"><h2 style="margin:0">Add a claim for someone</h2><button type="button" class="sm secondary" data-act="add-close">Close</button></div>
      <p class="sub" style="margin:4px 0 10px">For a gap in an import, or an order that came by message. It follows the same rules as when a joiner claims — but you can add to private and closed group orders. They'll see it in My orders; no email is sent.</p>
      ${addMsg ? `<div class="msg ${addMsg.ok ? '' : 'err'}" data-add-msg style="${addMsg.ok ? 'background:var(--ok-bg); color:var(--ok-ink); border-color:var(--ok-line)' : ''}">${esc(addMsg.text)}${addMsg.ok && addMsg.handle ? ` <button type="button" class="sm secondary" data-act="add-show" data-handle="${esc(addMsg.handle)}">Show @${esc(addMsg.handle)}'s claims</button>` : ''}</div>` : ''}
      <div class="formgrid"><div><label>Person (Instagram handle)</label><input name="handle" list="knownHandles" value="${esc(addS.handle)}" placeholder="@handle" autocomplete="off" required><datalist id="knownHandles">${addLook.matches.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
          <label class="chk" style="margin-top:6px"><input type="checkbox" name="createHandle" ${addS.create ? 'checked' : ''}> New person — create this handle</label><div class="sub" data-unknown hidden></div></div>
        <div><label>Group order</label><select name="orderId"><option value="">Choose…</option>${live.map((o) => `<option value="${o.id}" ${String(o.id) === String(addS.orderId) ? 'selected' : ''}>${esc(o.title)}${o.isPrivate ? ' (private)' : ''}${o.status && o.status !== 'open' ? ` (${esc(o.status)})` : ''}</option>`).join('')}</select></div>
        <div><label>Item</label><select name="itemId" ${addS.orderId ? '' : 'disabled'}><option value="">${addS.orderId ? 'Choose…' : 'Choose a group order first'}</option>${addItems().map((i) => `<option value="${i.id}" ${String(i.id) === String(addS.itemId) ? 'selected' : ''}>${esc(i.title)}${i.priceTbc ? ' (price TBC)' : i.price != null ? ` — ${money(i.price)}` : ''}</option>`).join('')}</select></div></div>
      <div data-add-detail>${addDetail(it)}</div>
      <div class="sub" style="margin:12px 0 4px; font-weight:600">Status — you choose each time</div>
      <label class="chk"><input type="radio" name="status" value="requested" ${addS.status === 'requested' ? 'checked' : ''}> <strong>Requested</strong> — waits for you to secure it, like a joiner's claim</label>
      <label class="chk"><input type="radio" name="status" value="confirmed" ${addS.status === 'confirmed' ? 'checked' : ''}> <strong>Confirmed</strong> — counts as owed now (any credit they hold is used straight away)</label>
      ${addS.status === 'confirmed' ? `<div style="margin-top:8px" data-add-stage><label>Where is it now? <span class="sub">(for something already ordered or arrived)</span></label><select name="stage">${BULK_STAGES.map((p) => `<option ${p === addS.stage ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>` : ''}
      <p class="msg err" data-add-error hidden></p><div class="btn-row"><button type="submit">Add the claim</button></div></form>`;
  }
  // read the panel back into addS (typing doesn't redraw, so nothing is lost or loses focus)
  function addHint() {                                                                    // updated IN PLACE: redrawing while you type would move the cursor
    const el = $('#addClaim [data-unknown]', root); if (!el) return;
    const h = cleanHandle(addS.handle), fresh = h && addLook.for === h;                     // only once the server has answered for exactly what is typed
    const text = fresh && addLook.blocked ? `@${h} is blocked — unblock them on the People tab first.` : fresh && !addLook.exact && !addS.create ? `There's no @${h} on the site yet — tick “New person” if that's right.` : '';
    el.hidden = !text; el.textContent = text;
    const dl = $('#knownHandles', root); if (dl) dl.innerHTML = addLook.matches.map((x) => `<option value="${esc(x)}">`).join('');
  }
  function lookupLater() { clearTimeout(lookTimer); lookTimer = setTimeout(lookup, 160); }
  async function lookup() {
    const h = cleanHandle(addS.handle);
    if (!h) { addLook = { for: '', exact: false, blocked: false, matches: [] }; return addHint(); }
    const r = await api('GET', `/api/admin/joiners/lookup?q=${encodeURIComponent(h)}`);
    if (!r.ok || cleanHandle(addS.handle) !== h) return;                                    // the answer is for something no longer typed
    addLook = { for: h, exact: !!r.json.exact, blocked: !!r.json.blocked, matches: r.json.matches || [] }; addHint();
  }
  function readAdd(t) {
    if (t.name === 'handle') { addS.handle = t.value; addHint(); lookupLater(); }
    else if (t.name === 'createHandle') { addS.create = t.checked; addHint(); }
    else if (t.name === 'orderId') { addS.orderId = t.value; addS.itemId = ''; addS.parts = {}; addS.variant = ''; addS.qty = '1'; addS.together = false; }
    else if (t.name === 'itemId') { addS.itemId = t.value; addS.parts = {}; addS.variant = ''; addS.qty = '1'; addS.together = false; }
    else if (t.name === 'qty') addS.qty = t.value;
    else if (t.name === 'variant') addS.variant = t.value;
    else if (t.name === 'together') addS.together = t.checked;
    else if (t.name === 'status') addS.status = t.value;
    else if (t.name === 'stage') addS.stage = t.value;
    else if (t.dataset?.part !== undefined) addS.parts[t.dataset.part] = t.value;
  }
  async function submitAdd(form) {
    const err = (text) => { const m = $('[data-add-error]', form); m.textContent = text; m.hidden = !text; };
    err('');
    const handle = cleanHandle(addS.handle), it = addItem(); let lines;
    if (!handle) return err('Enter the person\'s Instagram handle.');
    if (!addS.orderId || !it) return err('Choose the group order and the item.');
    const q = Number(addS.qty);
    if (it.type === 'set' || it.type === 'independent') {
      const asked = it.members.map((m) => ({ member: m.name, qty: Number(addS.parts[m.name] || 0) })).filter((p) => p.qty > 0);
      if (!asked.length) return err(it.type === 'set' ? 'Enter how many of at least one part.' : 'Enter how many of at least one member.');
      if (asked.some((p) => !Number.isInteger(p.qty) || p.qty > 20)) return err('Each number must be a whole number from 1 to 20.');
      lines = it.type === 'set' ? [{ itemId: it.id, parts: asked, together: !!addS.together }] : asked.map((p) => ({ itemId: it.id, member: p.member, qty: p.qty }));
    } else {
      if (!Number.isInteger(q) || q < 1 || q > 20) return err('How many: a whole number from 1 to 20.');
      if (it.type === 'size' && !addS.variant) return err('Choose a size.');
      lines = [{ itemId: it.id, qty: q, ...(it.type === 'size' ? { variant: addS.variant } : {}) }];
    }
    if (!addS.status) return err('Choose Requested or Confirmed — there is no default.');            // checked last, so problems are reported top to bottom, in the order of the form
    const r = await api('POST', '/api/admin/claims/add', { handle, createHandle: addS.create, status: addS.status, ...(addS.status === 'confirmed' ? { pipeline: addS.stage } : {}), lines });
    if (!r.ok) return err(errText(r));
    const j = r.json, n = j.claimIds.length, left = j.leftAsRequests;
    const how = addS.status === 'requested' ? (n === 1 ? 'as a request' : 'as requests') : `${j.confirmed} confirmed${left ? `, ${left} left as request${left === 1 ? '' : 's'}` : ''}`;
    addMsg = { ok: true, handle: j.handle, text: `Added ${n} claim${n === 1 ? '' : 's'} for @${j.handle}${j.newHandle ? ' (a new person was created)' : ''} — ${how}.${j.placements.length ? ` Placed: ${j.placements.map((p) => `${p.member} → Set ${p.setNumber}`).join(', ')}.` : ''}${addS.status === 'confirmed' && j.skippedTbc ? ` ${j.skippedTbc} still need the price set (TBC).` : ''}${addS.status === 'confirmed' && left - j.skippedTbc > 0 ? ' Set parts stay requests until their set is secured (Sets tab).' : ''}` };
    Object.assign(addS, { itemId: '', qty: '1', variant: '', parts: {}, together: false, create: false });
    await render(root);
  }

  function draw() {
    if (moveState) { const h = $('#moveHandle', root), cr = $('#moveCreate', root); if (h) moveState.handle = h.value; if (cr) moveState.create = cr.checked; }
    const list = visible();
    const shown = new Set(list.filter((c) => c.status === 'confirmed').map((c) => c.id));
    for (const id of [...picked]) if (!shown.has(id)) picked.delete(id);      // never act on a claim you can't currently see
    const byOrder = new Map();
    for (const c of list) {
      const k = c.order_id || 0;
      if (!byOrder.has(k)) byOrder.set(k, { id: c.order_id, title: c.orderTitle || 'Shop (on hand)', people: new Map() });
      const g = byOrder.get(k);
      if (!g.people.has(c.handle)) g.people.set(c.handle, []);
      g.people.get(c.handle).push(c);
    }
    const goCount = byOrder.size;
    root.innerHTML = `<div class="row" style="margin:18px 0 10px"><h1 style="margin:0">Claims</h1><div class="btn-row" style="margin:0"><button class="sm" data-act="add-open" aria-expanded="${addOpen}">+ Add a claim</button><span role="group" aria-label="How to group claims" style="display:inline-flex; gap:8px"><button class="sm ${view === 'person' ? '' : 'secondary'}" data-act="view" data-view="person" aria-pressed="${view === 'person'}">By person</button><button class="sm ${view === 'item' ? '' : 'secondary'}" data-act="view" data-view="item" aria-pressed="${view === 'item'}">By item</button></span></div></div>
      ${truncated ? `<div class="card" data-truncated style="border:2px solid var(--accent)"><strong>Only the first ${claims.length.toLocaleString('en-GB')} claims are shown.</strong> There are more than that — narrow it with <em>Group order</em> above to see the rest.</div>` : ''}
      ${cancelCard()}
      ${addCard()}
      <div class="card"><div class="formgrid">
        <div><label>Group order</label><select data-filter="order"><option value="">All</option>${orders.map((o) => `<option value="${o.id}" ${String(o.id) === String(filter.order) ? 'selected' : ''}>${esc(o.title)}</option>`).join('')}</select></div>
        <div><label>Show</label><select data-filter="status">${[['active', 'Active (requested + confirmed)'], ['requested', 'Requested only'], ['confirmed', 'Confirmed only'], ['cancelled', 'Cancelled'], ['all', 'Everything']].map(([v, l]) => `<option value="${v}" ${filter.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label>Search a handle or item</label><input data-filter="q" value="${esc(filter.q)}" placeholder="@handle or item"></div>
        <div><label>Stage</label><select data-filter="stage"><option value="">All stages</option>${PIPELINE.map((p) => `<option ${p === filter.stage ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
        <div><label>Sort by</label><select data-filter="sort">${SORTS.map(([v, l]) => `<option value="${v}" ${v === filter.sort ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label class="chk" style="margin-top:24px"><input type="checkbox" data-filter="unpaid" ${filter.unpaid ? 'checked' : ''}> Only claims that still owe money</label></div></div></div>
      ${(() => { const ids = confirmedIds(list); return ids.length ? `<div class="row" style="margin:0 0 10px; justify-content:flex-start; gap:12px; align-items:center"><button class="sm secondary" data-act="pick-all" data-ids="${ids.join(',')}">${ids.every((i) => picked.has(i)) ? 'Unselect' : 'Select'} all ${ids.length} confirmed claim${ids.length === 1 ? '' : 's'} shown</button><span class="sub">Narrow with <em>Group order</em>, <em>Stage</em> or search first to select just those.</span></div>` : ''; })()}
      ${strip()}
      ${list.length ? `<div class="btn-row" style="margin:0 0 10px; gap:8px"><button class="sm secondary" data-act="expand-all">Expand all</button><button class="sm secondary" data-act="collapse-all">Collapse all</button></div>` : ''}
      ${picked.size ? bulkBar() : ''}
      ${byOrder.size ? [...byOrder.values()].map((g) => {
        const all = [...g.people.values()].flat();
        const requested = all.filter((c) => c.status === 'requested' && (!c.setId || c.setDecision === 'secured') && !c.priceTbc).length;
        const tbcWaiting = all.filter((c) => c.status === 'requested' && c.priceTbc).length;
        const setWaiting = all.filter((c) => c.status === 'requested' && c.setId && c.setDecision !== 'secured').length;
        const gOpen = goOpen(g.id || 0, goCount), gOwed = all.reduce((n, c) => n + owedOf(c), 0);
        return `<div class="card" data-go="${g.id || 0}"><div class="row"><div><h2 style="margin:0"><button class="ghost gotoggle" data-act="toggle-go" data-go="${g.id || 0}" aria-expanded="${gOpen}" aria-label="${gOpen ? 'Hide' : 'Show'} the claims in ${esc(g.title)}"><span aria-hidden="true">${gOpen ? '▾' : '▸'}</span> ${esc(g.title)}</button></h2><div class="sub">${all.length} claim${all.length === 1 ? '' : 's'} · ${requested} waiting to be secured${tbcWaiting ? ` · ${tbcWaiting} waiting for a price (TBC)` : ''}${setWaiting ? ` · ${setWaiting} set part${setWaiting === 1 ? '' : 's'} waiting for their set (see the Sets tab)` : ''}${gOwed > 0 ? ` · owed <strong>${money(gOwed)}</strong>` : ''}</div></div>
          ${requested && g.id ? `<button data-act="secure" data-id="${g.id}" data-n="${requested}" data-title="${esc(g.title)}">Secure all requested (${requested})</button>` : ''}</div>
          ${gOpen ? `${pickRow(g)}${view === 'item' ? itemsBlock(g) : peopleBlock(g)}` : ''}</div>`;
      }).join('') : '<div class="card"><p class="muted">No claims match.</p></div>'}`;
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'cancel-approve' || b.dataset.act === 'cancel-decline') return cancelAction(b);
    const id = Number(b.dataset.id);
    const claim = claims.find((c) => c.id === id);
    switch (b.dataset.act) {
      case 'pick': b.checked ? picked.add(id) : picked.delete(id); draw(); break;
      case 'pick-person': case 'pick-order': case 'pick-all': {
        const ids = b.dataset.ids.split(',').map(Number);
        const all = ids.every((i) => picked.has(i));
        ids.forEach((i) => (b.dataset.act === 'pick-person' ? b.checked : !all) ? picked.add(i) : picked.delete(i));
        draw(); break;
      }
      case 'bulk-clear': picked.clear(); moveState = null; draw(); break;
      case 'move-open': moveState = { handle: '', create: false, preview: null, previewFor: '', error: '' }; draw(); $('#moveHandle', root)?.focus(); break;
      case 'move-close': moveState = null; draw(); break;
      case 'move-check': {
        moveState.handle = ($('#moveHandle', root).value || '').trim(); moveState.error = ''; moveState.preview = null;
        if (!moveState.handle) { moveState.error = 'Enter the handle to move them to.'; draw(); break; }
        const r = await api('POST', '/api/admin/claims/move', { claimIds: [...picked], handle: moveState.handle, dryRun: true });
        if (!r.ok) moveState.error = errText(r); else { moveState.preview = r.json; moveState.previewFor = pickKey(); moveState.create = false; }
        draw(); break;
      }
      case 'move-go': {
        const pv = moveState.preview, h = pv.target.handle;
        const ok = await GOM.confirm(`Move ${pv.movable.length} claim${pv.movable.length === 1 ? '' : 's'} to @${h}?\n\nThey'll appear in @${h}'s My orders, with ${money(pv.money.paid)} already paid and ${money(pv.money.owed)} still owed. ${pv.blocked.length ? `${pv.blocked.length} that can't be moved safely stay where they are. ` : ''}${pv.target.exists ? '' : `@${h} will be created. `}`, { ok: 'Move them', cancel: 'Not yet' });
        if (!ok) return;
        const r = await api('POST', '/api/admin/claims/move', { claimIds: [...picked], handle: h, create: moveState.create });
        if (!r.ok) { moveState.error = errText(r); return draw(); }
        picked.clear(); moveState = null; await render(root); GOM.refreshBadges();
        return GOM.toast(`Moved ${r.json.moved} claim${r.json.moved === 1 ? '' : 's'} to @${h}.${r.json.blocked.length ? ` ${r.json.blocked.length} left where they were.` : ''}`);
      }
      case 'bulk-apply': {
        const stage = $('#bulkStage', root).value, n = picked.size;
        const ok = await GOM.confirm(`Move ${n} claim${n === 1 ? '' : 's'} to "${stage}"?\n\nOnly confirmed claims are moved. Anything that's in a parcel, or in a box that hasn't arrived yet, is left alone (those are managed from the Packing and Warehouse tabs) — you'll be told which.`, { ok: 'Move them', cancel: 'Cancel' });
        if (!ok) return;
        const r = await api('POST', '/api/admin/claims/pipeline', { claimIds: [...picked], pipeline: stage });
        if (!r.ok) return GOM.toast(errText(r), true);
        picked.clear(); await render(root);
        GOM.toast(`Moved ${r.json.changed} claim${r.json.changed === 1 ? '' : 's'} to "${stage}".${r.json.unchanged ? ` ${r.json.unchanged} already there.` : ''}${r.json.skipped.length ? ` ${r.json.skipped.length} left alone.` : ''}`);
        if (r.json.skipped.length) {
          const lines = r.json.skipped.slice(0, 12).map((s) => `• ${s.label} — ${s.reason}`);
          await GOM.alert(`${r.json.skipped.length} claim${r.json.skipped.length === 1 ? ' was' : 's were'} left where ${r.json.skipped.length === 1 ? 'it was' : 'they were'}:\n\n${lines.join('\n')}${r.json.skipped.length > 12 ? `\n…and ${r.json.skipped.length - 12} more` : ''}`);
        }
        break;
      }
      case 'toggle': open.has(b.dataset.key) ? open.delete(b.dataset.key) : open.add(b.dataset.key); draw(); break;
      case 'group-toggle': openGroups.has(b.dataset.key) ? openGroups.delete(b.dataset.key) : openGroups.add(b.dataset.key); draw(); break;
      case 'more': shown.set(b.dataset.key, (shown.get(b.dataset.key) || PAGE) + PAGE); draw(); break;
      case 'view': view = b.dataset.view; try { localStorage.setItem('gom.claims.view', view); } catch { /* fine */ } draw(); break;
      case 'add-open': addOpen = true; addMsg = null; draw(); $('#addClaim input[name="handle"]', root)?.focus(); if (addS.handle) lookupLater(); break;
      case 'add-close': addOpen = false; draw(); break;
      case 'add-show': filter.q = b.dataset.handle; goChosen.clear(); draw(); break;
      case 'toggle-go': { const k = Number(b.dataset.go); goChosen.set(k, b.getAttribute('aria-expanded') !== 'true'); draw(); break; }
      case 'expand-all': for (const x of visible()) goChosen.set(x.order_id || 0, true); for (const k of allKeys()) open.add(k); for (const k of [...shown.keys()]) shown.set(k, 1e9); draw(); break;
      case 'collapse-all': for (const x of visible()) goChosen.set(x.order_id || 0, false); open.clear(); openGroups.clear(); shown.clear(); draw(); break;
      case 'stage-chip': filter.stage = filter.stage === b.dataset.stage ? '' : b.dataset.stage; draw(); break;
      case 'owing-chip': filter.unpaid = !filter.unpaid; draw(); break;
      case 'requested-chip': filter.status = filter.status === 'requested' ? 'active' : 'requested'; draw(); break;
      case 'edit': editing = id; fixing = null; draw(); break;
      case 'fix': {
        fixing = id; editing = null; Object.assign(fixS, { mode: 'change', plan: null, orderId: '', itemId: '', member: '', variant: '', pricing: '', amount: '', reason: '' }); draw();
        const r = await api('GET', `/api/admin/claims/${id}/fix-plan`); if (fixing !== id) break;
        if (!r.ok) { fixing = null; draw(); return GOM.toast(errText(r), true); }
        const p = r.json; Object.assign(fixS, { plan: p, orderId: String(p.orderId || ''), itemId: String(p.itemId || ''), member: p.member || '', variant: p.variant || '', amount: p.credit.amount ? String(p.credit.amount) : '', reason: `Credit (was a filler line: “${p.label}”)` }); draw(); break;
      }
      case 'fix-close': fixing = null; draw(); break;
      case 'fix-mode': fixS.mode = b.dataset.mode; draw(); break;
      case 'fix-change': {
        const cid = fixing, p = fixS.plan, it = (orders.find((o) => String(o.id) === String(fixS.orderId))?.items || []).find((i) => String(i.id) === String(fixS.itemId));
        if (!it) return fixErr('Choose the item.');
        const changedItem = String(it.id) !== String(p.itemId), askPrice = changedItem && (it.priceTbc || Number(it.price) !== Number(p.cost));
        if (it.type === 'independent' && !fixS.member) return fixErr('Choose a member.'); if (it.type === 'size' && !fixS.variant) return fixErr('Choose a size.');
        if (askPrice && !fixS.pricing) return fixErr('Choose whether to re-price it or keep the old price — there is no default.');
        const pricing = changedItem ? (askPrice ? fixS.pricing : 'keep') : undefined, now = `${it.title}${it.type === 'independent' ? ` — ${fixS.member}` : ''}${it.type === 'size' ? ` (${fixS.variant})` : ''}`;
        const ok = await GOM.confirm(`Change “${p.label}” to “${now}” for @${p.handle}?${changedItem ? `\n\n${pricing === 'reprice' ? `Its price becomes ${it.priceTbc ? 'TBC (0)' : money(it.price)}; what's paid is kept, so any difference shows as owed or credit.` : `It keeps its price (${money(p.cost)}).`}` : ''}`, { ok: 'Change it', cancel: 'Not yet' });
        if (!ok) return;
        const r = await api('POST', `/api/admin/claims/${cid}/change`, { itemId: it.id, ...(it.type === 'independent' ? { member: fixS.member } : {}), ...(it.type === 'size' ? { variant: fixS.variant } : {}), ...(pricing ? { pricing } : {}) });
        if (!r.ok) return fixErr(errText(r)); fixing = null; await render(root); GOM.toast(`Changed to “${r.json.label}”${r.json.repriced ? ' and re-priced' : ''}.`); break;
      }
      case 'fix-delete': {
        const cid = fixing, p = fixS.plan; const ok = await GOM.confirm(`Delete “${p.label}” for @${p.handle} completely?\n\nIt is removed as if it had never been added. This can't be undone.`, { ok: 'Delete it', cancel: 'Not yet' }); if (!ok) return;
        const r = await api('POST', '/api/admin/claims/delete', { claimIds: [cid] }); if (!r.ok) return fixErr(errText(r));
        if (!r.json.deleted) return fixErr(r.json.refused[0].reasons.join(' ')); fixing = null; picked.delete(cid); await render(root); GOM.toast('Deleted.'); break;
      }
      case 'fix-credit': {
        const cid = fixing, p = fixS.plan, amount = Number(fixS.amount), reason = (fixS.reason || '').trim();
        if (!(amount > 0)) return fixErr('Enter the credit amount.'); if (!reason) return fixErr('Enter a reason — they can see it.');
        const ok = await GOM.confirm(`Add ${money(amount)} credit to @${p.handle} and remove “${p.label}”?\n\nThe credit is used on anything they owe straight away. This can't be undone.`, { ok: 'Turn into credit', cancel: 'Not yet' }); if (!ok) return;
        const r = await api('POST', `/api/admin/claims/${cid}/to-credit`, { amount, reason }); if (!r.ok) return fixErr(errText(r));
        fixing = null; picked.delete(cid); await render(root); GOM.toast(`Added ${money(amount)} credit for @${p.handle}.`); break;
      }
      case 'bulk-delete': {
        const ids = [...picked]; const d = await api('POST', '/api/admin/claims/delete', { claimIds: ids, dryRun: true }); if (!d.ok) return GOM.toast(errText(d), true);
        const j = d.json; if (!j.deleted) return GOM.toast(`None of the ${ids.length} can be deleted — ${j.refused[0].reasons[0]}`, true);
        const ok = await GOM.confirm(`Delete ${j.deleted} claim${j.deleted === 1 ? '' : 's'} completely?\n\n${j.refused.length ? `${j.refused.length} can't be deleted and will be left alone (for example “${j.refused[0].label}” for @${j.refused[0].handle}: ${j.refused[0].reasons[0]})\n\n` : ''}They are removed as if they had never been added. This can't be undone.`, { ok: `Delete ${j.deleted}`, cancel: 'Not yet' }); if (!ok) return;
        const r = await api('POST', '/api/admin/claims/delete', { claimIds: ids }); if (!r.ok) return GOM.toast(errText(r), true);
        picked.clear(); moveState = null; await render(root); GOM.toast(`Deleted ${r.json.deleted}.${r.json.refused.length ? ` ${r.json.refused.length} left alone.` : ''}`); break;
      }
      case 'cancel-edit': editing = null; draw(); break;
      case 'secure': {
        const ok = await GOM.confirm(`Secure ${b.dataset.n} requested claim${b.dataset.n === '1' ? '' : 's'} in "${b.dataset.title}"?\n\nThey become confirmed, and what each person owes starts to count (any credit they hold is used straight away).`, { ok: 'Secure them' });
        if (!ok) return;
        const r = await api('POST', '/api/admin/claims/secure', { orderId: id });
        if (!r.ok) return GOM.toast(errText(r), true);
        await render(root); GOM.toast(`Secured ${r.json.secured} claim${r.json.secured === 1 ? '' : 's'}.${r.json.skippedTbc ? ` ${r.json.skippedTbc} left waiting because their price is still TBC.` : ''}${r.json.skippedCancel ? ` ${r.json.skippedCancel} left because the person has asked to cancel.` : ''}`);
        break;
      }
      case 'cancel': {
        const paid = paidOf(claim);
        const ok = await GOM.confirm(`Cancel "${claim.label}" for @${claim.handle}?\n\n${paid > 0 ? `${money(paid)} has already been paid on it, so it goes back to them as credit (unless their handle is blocked).` : 'Nothing has been paid on it.'}`, { ok: 'Yes, cancel it', cancel: 'Keep it' });
        if (!ok) return;
        const r = await api('PATCH', `/api/admin/claims/${id}`, { status: 'cancelled' });
        if (!r.ok) return GOM.toast(errText(r), true);
        await render(root); GOM.toast(paid > 0 ? `Cancelled. ${money(paid)} returned as credit.` : 'Cancelled.');
        break;
      }
      default:
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (e.target.dataset.form === 'fix') return;
    if (e.target.dataset.form === 'add-claim') return submitAdd(e.target);
    const form = e.target, id = Number(form.dataset.id), claim = claims.find((c) => c.id === id);
    const costs = {};
    for (const [k] of CATS) {
      const cost = Number(form.elements[`${k}_cost`].value), paid = Number(form.elements[`${k}_paid`].value);
      const patch = {};
      if (cost !== (claim.costs[k]?.cost || 0)) patch.cost = cost;
      if (paid !== (claim.costs[k]?.paid || 0)) patch.paid = paid;
      if (Object.keys(patch).length) costs[k] = patch;
    }
    if (!Object.keys(costs).length) { editing = null; return draw(); }
    const r = await api('PATCH', `/api/admin/claims/${id}`, { costs });
    if (!r.ok) { const m = $('[data-msg]', form); m.textContent = errText(r); m.className = 'msg'; m.hidden = false; return; }
    editing = null; await render(root); GOM.toast('Saved.');
  }

  async function onChange(e) {
    const t = e.target;
    if (t.closest?.('[data-form="fix"]')) { readFix(t); if (['orderId', 'itemId', 'pricing'].includes(t.name)) draw(); return; }
    if (t.closest?.('#addClaim')) { readAdd(t); if (['orderId', 'itemId', 'status'].includes(t.name)) draw(); return; }
    if (t.id === 'moveCreate') { moveState.create = t.checked; return draw(); }
    if (t.dataset.filter) {
      filter[t.dataset.filter] = t.type === 'checkbox' ? t.checked : t.value;
      if (['stage', 'unpaid'].includes(t.dataset.filter)) goChosen.clear();            // a filter always shows what it found
      if (t.dataset.filter === 'order') return render(root);   // different data
      return draw();
    }
    if (t.dataset.actChange === 'pipeline-group') {                              // one stage change for a whole merged row ("×5")
      const ids = t.dataset.ids.split(',').map(Number), stage = t.value;
      const r = await api('POST', '/api/admin/claims/pipeline', { claimIds: ids, pipeline: stage });
      if (!r.ok) { GOM.toast(errText(r), true); return render(root); }
      await render(root); return GOM.toast(`Moved ${r.json.changed} claim${r.json.changed === 1 ? '' : 's'} to "${stage}".${r.json.skipped.length ? ` ${r.json.skipped.length} left alone (${r.json.skipped[0].reason}).` : ''}`);
    }
    if (t.dataset.actChange === 'pipeline') {
      const r = await api('PATCH', `/api/admin/claims/${t.dataset.id}`, { pipeline: t.value });
      if (!r.ok) GOM.toast(errText(r), true);
      await render(root);
    }
  }
  // typing in the search box filters as you go without losing focus
  function onInput(e) {
    if (e.target.closest?.('[data-form="fix"]')) return readFix(e.target);
    if (e.target.closest?.('#addClaim')) return readAdd(e.target);
    if (e.target.matches?.('[data-keep]')) {                                          // what they'd get back, as you type the fee
      const row = e.target.closest('[data-cancel-req]'), paid = Number(row.dataset.paid), keep = Number(e.target.value || 0), box = $('[data-keep-preview]', row);
      box.textContent = Number.isNaN(keep) || keep < 0 ? 'Enter a fee of £0 or more.' : keep > paid + 0.004 ? `They have only paid ${money(paid)}.` : `They'd get ${money(Math.round((paid - keep) * 100) / 100)} back as credit${keep > 0 ? `; you keep ${money(keep)}` : ''}.`;
      return;
    }
    if (e.target.dataset.filter === 'q') {
      filter.q = e.target.value; goChosen.clear(); const pos = e.target.selectionStart; draw();
      const q = $('[data-filter="q"]', root); q.focus(); q.setSelectionRange?.(pos, pos);
    }
  }

  GOM.registerTab({
    id: 'claims', label: 'Claims',
    badgeCount: async () => ((await api('GET', '/api/admin/cancel-requests')).json?.requests || []).length,
    async render(el) { await render(el); el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = onChange; el.oninput = onInput; },
  });
})();
