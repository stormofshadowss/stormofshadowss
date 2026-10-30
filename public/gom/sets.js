// Sets tab: every member set, who holds each part, and the decisions — secure it, cancel it, or put someone into an open part.
(function () {
  const { esc, money, api, errText, $, $$ } = GOM;
  let root = null, orders = [], sets = [], requests = [], adding = null;   // adding: "setId::member" whose inline form is open
  const filter = { order: '', decision: 'none', q: '' };                      // decision: none (to decide) | ready | secured | cancelled | all
  const chosen = new Map();                                                   // set id → true/false once you have opened or closed it yourself; otherwise a short list (3 sets or fewer) opens by itself
  const shown = new Map();                                                    // how many sets an item lists before "Show more"
  const PAGE = 12;

  async function render(el) {
    root = el;
    const [o, s, q] = await Promise.all([api('GET', '/api/admin/orders'), api('GET', `/api/admin/sets${filter.order ? `?order=${filter.order}` : ''}`), api('GET', '/api/admin/fixed-requests')]);
    orders = o.json?.orders || []; sets = s.json?.sets || []; requests = q.json?.requests || [];
    draw();
  }

  const pill = (d) => `<span class="pill ${d === 'secured' ? 'ok' : d === 'cancelled' ? 'dim' : 'warn'}">${d === 'none' ? 'not decided' : d}</span>`;
  // What state is a set in, in words? Ready = every part is held and nothing stops it being secured; blocked = something must be sorted first.
  const openCount = (s) => s.total - s.filled;
  const blockReason = (s) => (s.decision !== 'none' ? '' : s.hasRequests ? 'A joiner has asked to cancel one of these parts — answer that first (top of the Claims tab) before this set can be secured.' : s.hasTbc ? "The price is still TBC — set it (Group Orders → Items → Edit) before this set can be secured." : s.filled === 0 ? 'Nobody has claimed anything in this set yet.' : s.requiresFullSet && openCount(s) > 0 ? `Waiting for ${openCount(s)} more part${openCount(s) === 1 ? '' : 's'} — this set can't go ahead unless every part is claimed.` : '');
  const isReady = (s) => s.decision === 'none' && s.total > 0 && s.filled === s.total && !s.hasTbc && !s.hasRequests;
  const matches = (s) => { const q = filter.q.trim().toLowerCase().replace(/^@/, ''); return !q || [s.itemTitle, s.orderTitle, ...s.parts.flatMap((p) => [p.member, p.handle || ''])].some((t) => String(t).toLowerCase().includes(q)); };
  const inChip = (s) => filter.decision === 'all' || (filter.decision === 'ready' ? isReady(s) : s.decision === filter.decision);
  const visible = () => sets.filter((s) => inChip(s) && matches(s));
  const isOpen = (s) => chosen.has(s.id) ? chosen.get(s.id) : (adding?.startsWith(`${s.id}::`) || !!filter.q.trim() || visible().length <= 3);

  // What can be done with one part: put someone in, or (in a secured set) share its cost and raffle it.
  function partActions(s, p) {
    if (p.handle || s.decision === 'cancelled') return '';
    if (p.raffle?.status === 'pending') {
      const people = [...new Set(s.parts.filter((x) => x.handle).map((x) => x.handle))];
      return `<div class="btn-row" style="margin:0"><select data-raffle-pick="${esc(p.member)}" style="max-width:180px">${people.map((h) => `<option value="${esc(h)}">@${esc(h)}</option>`).join('')}</select>
        <button class="sm" data-act="raffle" data-set="${s.id}" data-member="${esc(p.member)}">Confirm winner</button></div>`;
    }
    if (adding === `${s.id}::${p.member}`) {
      return `<form data-form="assign" data-set="${s.id}" data-member="${esc(p.member)}" class="btn-row" style="margin:0"><input name="handle" placeholder="@handle" style="max-width:160px" autocomplete="off"><button type="submit" class="sm">Add</button><button type="button" class="sm secondary" data-act="cancel-add">Cancel</button><span class="msg" data-msg hidden></span></form>`;
    }
    return `<button class="sm secondary" data-act="add" data-set="${s.id}" data-member="${esc(p.member)}">Add someone</button>${s.decision === 'secured' ? ` <button class="sm secondary" data-act="split" data-set="${s.id}" data-member="${esc(p.member)}">Split cost &amp; raffle</button>` : ''}`;
  }

  // A new request can join a set that is ALREADY secured (it fills an open part). It waits as "requested" until confirmed here.
  const newRequests = (s) => s.decision === 'secured' ? s.parts.filter((p) => p.status === 'requested' && p.claimId).map((p) => p.claimId) : [];
  const confirmNewBtn = (s) => { const ids = newRequests(s); return ids.length ? `<span class="pill warn" data-new-requests>${ids.length} new request${ids.length === 1 ? '' : 's'} waiting</span><button data-act="confirm-new" data-id="${s.id}" data-ids="${ids.join(',')}">Confirm ${ids.length === 1 ? 'it' : `these ${ids.length}`}</button>` : ''; };
  // a little row of dots: one per part — held and confirmed, held and waiting, or open
  const dots = (s) => `<span class="dots" role="img" aria-label="${s.filled} of ${s.total} parts held">${s.parts.map((p) => `<i class="dot ${p.handle ? (p.status === 'confirmed' ? 'ok' : 'held') : ''}" title="${esc(p.member)}${p.handle ? ` — @${esc(p.handle)}` : ' — open'}"></i>`).join('')}</span>`;
  const statusPill = (s) => {
    if (s.decision === 'secured') return `<span class="pill ok">secured</span>${openCount(s) ? `<span class="pill warn">${openCount(s)} open</span>` : ''}`;
    if (s.decision === 'cancelled') return '<span class="pill dim">cancelled</span>';
    if (isReady(s)) return '<span class="pill ok" data-ready>ready to secure</span>';
    return `<span class="pill warn">${s.filled === 0 ? 'empty' : `needs ${openCount(s)} more`}</span>`;
  };
  function setCard(s) {
    const open = openCount(s), blocked = s.decision === 'none' && (s.filled === 0 || (s.requiresFullSet && open > 0) || s.hasTbc || s.hasRequests), isOpenNow = isOpen(s);
    const missing = s.parts.filter((p) => !p.handle).map((p) => p.member), why = blockReason(s);
    const quick = s.decision === 'none' ? `<button class="sm" data-act="secure" data-id="${s.id}" ${blocked ? 'disabled' : ''} aria-label="Secure ${esc(s.itemTitle)} — Set ${s.number}">Secure</button><button class="sm secondary" data-act="cancel-set" data-id="${s.id}" aria-label="Cancel ${esc(s.itemTitle)} — Set ${s.number}">Cancel set</button>`
      : s.decision === 'secured' ? `${confirmNewBtn(s)}<button class="sm secondary" data-act="cancel-set" data-id="${s.id}" aria-label="Cancel ${esc(s.itemTitle)} — Set ${s.number}">Cancel set</button>` : '';
    return `<div class="setrow ${isOpenNow ? 'open' : ''}" data-set="${s.id}">
      <div class="setline"><button class="ghost sm setbtn" data-act="toggle-set" data-id="${s.id}" aria-expanded="${isOpenNow}" aria-label="${isOpenNow ? 'Hide' : 'Show'} the parts of Set ${s.number}">${isOpenNow ? '▾' : '▸'} <strong>Set ${s.number}</strong></button>
        ${dots(s)}<span class="sub nowrap">${s.filled}/${s.total}</span>${s.decision === 'none' && missing.length ? `<span class="sub" data-missing>open: ${esc(missing.slice(0, 4).join(', '))}${missing.length > 4 ? ` +${missing.length - 4}` : ''}</span>` : ''}
        <span class="grow"></span>${statusPill(s)}${s.requiresFullSet ? '<span class="pill warn">every part required</span>' : ''}<span class="btn-row" style="margin:0">${quick}</span></div>
      ${why ? `<div class="sub setwhy" style="margin:2px 0 0 28px">${why}</div>` : ''}
      ${isOpenNow ? `<div class="setbody"><div class="scroll"><table class="grid" style="margin-top:6px"><thead><tr><th>Part</th><th>Price</th><th>Held by</th><th></th></tr></thead><tbody>
      ${s.parts.map((p) => `<tr data-part="${esc(p.member)}"><td>${esc(p.member)}</td><td>${p.price == null ? '<span class="pill warn">TBC</span>' : money(p.price)}</td>
        <td>${p.handle ? `@${esc(p.handle)} <span class="pill ${p.status === 'confirmed' ? 'ok' : 'warn'}">${esc(p.status || '')}</span>${p.fixed ? ' <span class="pill">fixed</span>' : ''}${p.cancelAsked ? ' <span class="pill warn" data-cancel-asked>cancel requested</span>' : ''}${p.raffle?.status === 'resolved' ? ' <span class="pill ok">raffle win</span>' : ''}` : p.raffle?.status === 'pending' ? '<span class="pill warn">raffle pending</span>' : '<span class="sub">open</span>'}</td>
        <td>${partActions(s, p)}</td></tr>`).join('')}</tbody></table></div>
      ${s.parts.filter((p) => p.raffle).map((p) => `<div class="sub" style="margin-top:6px">Each person in this set took on about ${money(p.raffle.share)} extra for the unclaimed ${esc(p.member)} part${p.raffle.status === 'pending' ? ' — pick a raffle winner above.' : ' — it was raffled.'}</div>`).join('')}
      ${s.decision === 'secured' && open ? `<div class="sub" style="margin-top:6px">${open} part${open === 1 ? ' is' : 's are'} still open — you can put someone into ${open === 1 ? 'it' : 'them'} above.</div>` : ''}</div>` : ''}</div>`;
  }
  // sets grouped under their item, with counts and "Show more"
  function itemSection(group) {
    const [first] = group.all, k = String(first.itemId ?? first.itemTitle), limit = filter.q.trim() ? group.list.length : (shown.get(k) || PAGE);
    const c = (f) => group.all.filter(f).length;
    return `<section class="itemsec" data-item="${esc(k)}"><div class="row" style="margin:14px 0 4px"><div><h2 style="margin:0">${esc(first.itemTitle)}</h2><div class="sub">${esc(first.orderTitle)}</div></div>
      <div><span class="pill">${group.all.length} set${group.all.length === 1 ? '' : 's'}</span>${c(isReady) ? `<span class="pill ok">${c(isReady)} ready</span>` : ''}${c((s) => s.decision === 'none' && !isReady(s)) ? `<span class="pill warn">${c((s) => s.decision === 'none' && !isReady(s))} to fill</span>` : ''}${c((s) => s.decision === 'secured') ? `<span class="pill">${c((s) => s.decision === 'secured')} secured</span>` : ''}</div></div>
      <div class="card" style="padding:6px 10px">${group.list.slice(0, limit).map(setCard).join('')}${group.list.length > limit ? `<div style="padding:8px 4px"><button class="sm secondary" data-act="more" data-key="${esc(k)}">Show ${Math.min(PAGE, group.list.length - limit)} more sets (${group.list.length - limit} not shown)</button></div>` : ''}</div></section>`;
  }

  function draw() {
    const list = visible();
    const reqCard = requests.length ? `<div class="card"><h2>Fixed-claim requests (${requests.length})</h2><p class="sub">Regulars whose set is already secured asking to give up or swap. Anyone whose set isn't secured yet can change it themselves.</p>
      ${requests.map((q) => `<div class="itemrow" data-req="${q.id}"><div class="grow"><strong>@${esc(q.handle)}</strong> wants to ${q.action === 'ot8' ? 'swap to the full set' : 'give up this claim'}<div class="sub">${esc(q.orderTitle)} — ${esc(q.itemTitle)} · ${esc(q.member)} · Set ${q.setNumber}</div></div>
        <div class="btn-row" style="margin:0"><button class="sm" data-act="approve-req" data-id="${q.id}" data-handle="${esc(q.handle)}" data-action="${q.action}">Approve</button><button class="sm secondary" data-act="decline-req" data-id="${q.id}">Decline</button></div></div>`).join('')}</div>` : '';
    const inOrder = sets;                                                          // (already limited to the chosen group order by the server)
    const count = { none: inOrder.filter((x) => x.decision === 'none').length, ready: inOrder.filter(isReady).length, secured: inOrder.filter((x) => x.decision === 'secured').length, cancelled: inOrder.filter((x) => x.decision === 'cancelled').length, all: inOrder.length };
    const groups = []; const by = new Map();
    for (const st of inOrder) { const key = st.itemId ?? st.itemTitle; if (!by.has(key)) by.set(key, { all: [], list: [] }); by.get(key).all.push(st); }
    for (const st of list) by.get(st.itemId ?? st.itemTitle).list.push(st);
    for (const g of by.values()) if (g.list.length) groups.push(g);
    const ready = list.filter(isReady);
    root.innerHTML = `<h1 style="margin:18px 0 10px">Sets</h1><div class="row" style="margin:0 0 10px"><button type="button" class="sm secondary" data-act="fill-gaps" title="Moves people up from later sets into open spots">Fill gaps…</button><span class="sub">Moves people up from later sets into spots that are open now.</span></div>${reqCard}
      <div class="card"><div class="formgrid"><div><label>Group order</label><select data-filter="order"><option value="">All</option>${orders.filter((o) => o.items.some((i) => i.type === 'set') && (!o.archivedAt || String(o.id) === String(filter.order))).map((o) => `<option value="${o.id}" ${String(o.id) === String(filter.order) ? 'selected' : ''}>${esc(o.title)}</option>`).join('')}</select></div>
        <div><label for="setSearch">Find a handle, member or item</label><input id="setSearch" data-filter="q" value="${esc(filter.q)}" placeholder="@handle, Felix, photocard…" autocomplete="off"></div></div>
        <div class="chips" id="setChips" role="group" aria-label="Which sets" style="margin-top:10px">${[['none', 'To decide'], ['ready', 'Ready to secure'], ['secured', 'Secured'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([v, l]) => `<button type="button" class="chip ${filter.decision === v ? 'on' : ''}" data-act="chip" data-v="${v}" aria-pressed="${filter.decision === v}">${l}<span class="n">${count[v]}</span></button>`).join('')}</div></div>
      ${ready.length ? `<div class="card" id="bulkSecure" style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap"><div><strong>${ready.length} ${ready.length === 1 ? 'set is' : 'sets are'} ready to secure</strong><div class="sub">Every part is held and nothing is in the way.</div></div><button data-act="secure-ready" style="margin:0">Secure all ${ready.length}…</button></div>` : ''}
      ${list.length ? `<div class="btn-row" style="margin:0 0 4px"><button class="sm secondary" data-act="expand-all">Open all</button><button class="sm secondary" data-act="collapse-all">Close all</button></div>${groups.map(itemSection).join('')}` : '<div class="card"><p class="muted">No sets here.</p></div>'}`;
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, id = Number(b.dataset.id), s = sets.find((x) => x.id === id);
    if (act === 'fill-gaps') {                                           // preview who would move up into every open spot, then do it
      const pv = await api('GET', '/api/admin/sets/fill-gaps'); if (!pv.ok) return GOM.toast(errText(pv), true);
      if (!pv.json.total) return GOM.alert('No gaps can be filled right now. Nobody is waiting in a later set for an open spot — or the people who are have asked to stay together, are fixed claimers, or are waiting on a cancel request.');
      const lines = pv.json.items.flatMap((it) => [`${it.itemTitle} — ${it.orderTitle}`, ...pv.json.moves.filter((m) => m.itemId === it.itemId).map((m) => `  • @${m.handle} — ${m.member}: Set ${m.fromSet} → Set ${m.toSet}${m.secured ? ' (secured straight away)' : ''}`)]);
      const shown = lines.slice(0, 40), more = lines.length - shown.length;
      const ok = await GOM.confirm(`Move ${pv.json.total} ${pv.json.total === 1 ? 'person' : 'people'} up?\n\n${shown.join('\n')}${more > 0 ? `\n…and ${more} more line${more === 1 ? '' : 's'}` : ''}\n\nThey aren't emailed. Anyone moved into a secured set is secured straight away.`, { ok: 'Move them up', cancel: 'Not yet' });
      if (!ok) return;
      const r = await api('POST', '/api/admin/sets/fill-gaps', {}); if (!r.ok) return GOM.toast(errText(r), true);
      await render(root); return GOM.toast(r.json.total ? `Moved ${r.json.total} ${r.json.total === 1 ? 'person' : 'people'} up.` : 'Nothing needed moving any more.');
    }
    if (act === 'approve-req') {
      const ok = await GOM.confirm(`Approve @${b.dataset.handle}'s request to ${b.dataset.action === 'ot8' ? 'swap to the full set' : 'give up their fixed claim'}?\n\nTheir fixed claim ends, anything already paid goes back to them as credit, and ${b.dataset.action === 'ot8' ? 'a full set is placed for them in a set that is still open.' : 'the part opens up in the secured set (you can put someone into it from here).'}`, { ok: 'Approve it' });
      if (!ok) return;
      const r = await api('POST', `/api/admin/fixed-requests/${id}/approve`, {});
      await render(root); GOM.refreshBadges();
      return GOM.toast(r.ok ? (r.json.voided ? 'That fixed claim had already ended, so nothing was needed.' : `Approved.${r.json.setNumber ? ` Full set placed in Set ${r.json.setNumber}.` : ''}${r.json.refunded > 0 ? ` £${r.json.refunded.toFixed(2)} returned as credit.` : ''}`) : errText(r), !r.ok);
    }
    if (act === 'decline-req') {
      const r = await api('POST', `/api/admin/fixed-requests/${id}/decline`, {});
      await render(root); GOM.refreshBadges();
      return GOM.toast(r.ok ? 'Declined — nothing changes.' : errText(r), !r.ok);
    }
    if (act === 'split') {
      const set = sets.find((x) => x.id === Number(b.dataset.set)), part = set.parts.find((x) => x.member === b.dataset.member);
      if (part.price == null) return GOM.alert("That part's price is still TBC, so its cost can't be shared out yet. Set the item's price first (Group Orders → Items → Edit).");
      const n = set.parts.filter((x) => x.handle).length;
      const ok = await GOM.confirm(`Split the cost of the unclaimed ${part.member} (${money(part.price)}) across the ${n} claim${n === 1 ? '' : 's'} in this set?\n\nEach claim takes on about ${money(part.price / n)} extra (it shows in what each person owes), and you can then pick a raffle winner who receives the ${part.member} at no further cost.\n\nThis can't be undone automatically — if you change your mind, edit the costs in Claims.`, { ok: 'Split the cost', cancel: 'Not yet' });
      if (!ok) return;
      const r = await api('POST', `/api/admin/sets/${set.id}/split`, { member: part.member });
      await render(root);
      return GOM.toast(r.ok ? `Split — each of ${r.json.holders} claim${r.json.holders === 1 ? '' : 's'} takes on about ${money(r.json.share)}. Now pick a raffle winner.` : errText(r), !r.ok);
    }
    if (act === 'raffle') {
      const pick = $(`select[data-raffle-pick="${b.dataset.member}"]`, b.closest('tr'));
      const winner = pick?.value;
      if (!winner) return;
      const ok = await GOM.confirm(`Give the raffled ${b.dataset.member} to @${winner}?\n\nIt costs them nothing more — they've already paid their share of it.`, { ok: 'Confirm winner', cancel: 'Not yet' });
      if (!ok) return;
      const r = await api('POST', `/api/admin/sets/${b.dataset.set}/raffle`, { member: b.dataset.member, handle: winner });
      await render(root);
      return GOM.toast(r.ok ? `@${winner} wins the ${b.dataset.member}.` : errText(r), !r.ok);
    }
    if (act === 'toggle-set') { chosen.set(id, !isOpen(s)); return draw(); }
    if (act === 'chip') { filter.decision = b.dataset.v; return draw(); }
    if (act === 'more') { shown.set(b.dataset.key, (shown.get(b.dataset.key) || PAGE) + PAGE); return draw(); }
    if (act === 'expand-all') { for (const x of visible()) chosen.set(x.id, true); return draw(); }
    if (act === 'collapse-all') { for (const x of visible()) chosen.set(x.id, false); adding = null; return draw(); }
    if (act === 'secure-ready') {                                                  // every set that is ready, one after another; whatever can't be secured is reported, nothing is forced
      const ready = visible().filter(isReady), claims = ready.reduce((n, x) => n + x.parts.filter((p) => p.status === 'requested').length, 0);
      const ok = await GOM.confirm(`Secure ${ready.length} ready set${ready.length === 1 ? '' : 's'}?\n\n${claims} claim${claims === 1 ? '' : 's'} become confirmed, and what each person owes starts to count (any credit they hold is used straight away). Every part in these sets is already held.`, { ok: `Secure ${ready.length}`, cancel: 'Not yet' });
      if (!ok) return;
      let done = 0, confirmed = 0; const failed = [];
      for (const x of ready) { const r = await api('POST', `/api/admin/sets/${x.id}/secure`, {}); if (r.ok) { done += 1; confirmed += r.json.secured; } else failed.push(`${x.itemTitle} — Set ${x.number}: ${errText(r)}`); }
      await render(root); GOM.refreshBadges();
      return GOM.toast(`Secured ${done} set${done === 1 ? '' : 's'} — ${confirmed} claim${confirmed === 1 ? '' : 's'} confirmed.${failed.length ? ` ${failed.length} could not be secured (${failed[0]}).` : ''}`, failed.length > 0);
    }
    if (act === 'add') { adding = `${b.dataset.set}::${b.dataset.member}`; return draw(); }
    if (act === 'cancel-add') { adding = null; return draw(); }
    if (act === 'secure') {
      const open = s.total - s.filled, n = s.parts.filter((p) => p.status === 'requested').length;
      const ok = await GOM.confirm(`Secure ${s.itemTitle} — Set ${s.number}?\n\n${n} claim${n === 1 ? '' : 's'} become confirmed, and what each person owes starts to count (any credit they hold is used straight away).${open ? `\n\n${open} part${open === 1 ? ' is' : 's are'} still open and will stay open — you can put someone into ${open === 1 ? 'it' : 'them'} afterwards.` : ''}`, { ok: 'Secure it' });
      if (!ok) return;
      const r = await api('POST', `/api/admin/sets/${id}/secure`, {});
      await render(root); GOM.refreshBadges();
      return GOM.toast(r.ok ? `Secured — ${r.json.secured} claim${r.json.secured === 1 ? '' : 's'} confirmed.` : errText(r), !r.ok);
    }
    if (act === 'confirm-new') {
      const ids = b.dataset.ids.split(',').map(Number);
      const ok = await GOM.confirm(`Confirm ${ids.length} new request${ids.length === 1 ? '' : 's'} in ${s.itemTitle} — Set ${s.number}?\n\nThe set is already secured, so each becomes a confirmed claim and what the person owes starts to count (any credit they hold is used first). They're emailed if they've asked for that.`, { ok: 'Confirm', cancel: 'Not yet' });
      if (!ok) return;
      const r = await api('POST', '/api/admin/claims/secure', { claimIds: ids });
      await render(root); GOM.refreshBadges();
      return GOM.toast(r.ok ? `Confirmed ${r.json.secured} claim${r.json.secured === 1 ? '' : 's'}.${r.json.skippedTbc ? ` ${r.json.skippedTbc} left (price still TBC).` : ''}${r.json.skippedCancel ? ` ${r.json.skippedCancel} left (they asked to cancel).` : ''}` : errText(r), !r.ok);
    }
    if (act === 'cancel-set') {
      const held = s.parts.filter((p) => p.handle).length;
      const ok = await GOM.confirm(`Cancel ${s.itemTitle} — Set ${s.number}?\n\nAll ${held} claim${held === 1 ? '' : 's'} in it are cancelled. Anything already paid goes back to each person as credit (unless their handle is blocked), and the parts become free for others.`, { ok: 'Cancel the set', cancel: 'Keep it' });
      if (!ok) return;
      const r = await api('POST', `/api/admin/sets/${id}/cancel`, {});
      await render(root); GOM.refreshBadges();
      return GOM.toast(r.ok ? `Set cancelled.${r.json.refunded > 0 ? ` ${money(r.json.refunded)} returned as credit.` : ''}${r.json.forfeited > 0 ? ` ${money(r.json.forfeited)} kept (blocked handle).` : ''}` : errText(r), !r.ok);
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.target; if (form.dataset.form !== 'assign') return;
    const m = $('[data-msg]', form);
    const slotBody = { member: form.dataset.member, handle: form.elements.handle.value };
    let r = await api('POST', `/api/admin/sets/${form.dataset.set}/slots`, slotBody);
    if (!r.ok && r.json?.code === 'limit_reached') {                                                   // over the item's purchase limit: you may go past it, but only knowingly
      if (!(await GOM.confirm(`${r.json.error}\n\nAdd them anyway? As the GOM you can go over a purchase limit.`, { ok: 'Add anyway', cancel: "Don't add" }))) { m.textContent = r.json.error; m.className = 'msg'; m.hidden = false; return; }
      r = await api('POST', `/api/admin/sets/${form.dataset.set}/slots`, { ...slotBody, overrideLimit: true });
    }
    if (!r.ok) { m.textContent = errText(r); m.className = 'msg'; m.hidden = false; return; }
    adding = null; await render(root); GOM.toast(r.json.status === 'confirmed' ? 'Added — and confirmed, since the set is already secured.' : 'Added.');
  }

  async function onChange(e) {
    const t = e.target; if (!t.dataset.filter || t.dataset.filter === 'q') return;
    filter[t.dataset.filter] = t.value;
    if (t.dataset.filter === 'order') return render(root);
    draw();
  }
  function onInput(e) {                                                          // searching redraws as you type, and keeps the cursor where it was
    const t = e.target; if (t.dataset.filter !== 'q') return;
    filter.q = t.value; const pos = t.selectionStart; draw(); const box = $('#setSearch', root); if (box) { box.focus(); box.setSelectionRange(pos, pos); }
  }

  GOM.registerTab({
    id: 'sets', label: 'Sets',
    badgeCount: async () => ((await api('GET', '/api/admin/sets?decision=none')).json?.sets || []).length + ((await api('GET', '/api/admin/fixed-requests')).json?.requests || []).length
      + ((await api('GET', '/api/admin/sets?decision=secured')).json?.sets || []).reduce((n, s) => n + s.parts.filter((p) => p.status === 'requested').length, 0),
    async render(el) { await render(el); el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = onChange; el.oninput = onInput; },
  });
})();
