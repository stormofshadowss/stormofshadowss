// Sets tab: every member set, who holds each part, and the decisions — secure it, cancel it, or put someone into an open part.
(function () {
  const { esc, money, api, errText, $, $$ } = GOM;
  let root = null, orders = [], sets = [], requests = [], adding = null;   // adding: "setId::member" whose inline form is open
  const filter = { order: '', decision: 'none' };

  async function render(el) {
    root = el;
    const [o, s, q] = await Promise.all([api('GET', '/api/admin/orders'), api('GET', `/api/admin/sets${filter.order ? `?order=${filter.order}` : ''}`), api('GET', '/api/admin/fixed-requests')]);
    orders = o.json?.orders || []; sets = s.json?.sets || []; requests = q.json?.requests || [];
    draw();
  }

  const pill = (d) => `<span class="pill ${d === 'secured' ? 'ok' : d === 'cancelled' ? 'dim' : 'warn'}">${d === 'none' ? 'not decided' : d}</span>`;
  const visible = () => sets.filter((s) => filter.decision === 'all' || s.decision === filter.decision);

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
  function setCard(s) {
    const open = s.total - s.filled;
    const blocked = s.decision === 'none' && (s.filled === 0 || (s.requiresFullSet && open > 0) || s.hasTbc || s.hasRequests);
    return `<div class="card" data-set="${s.id}"><div class="row"><div><h2 style="margin:0">${esc(s.itemTitle)} — Set ${s.number}</h2><div class="sub">${esc(s.orderTitle)}</div></div>
      <div>${pill(s.decision)} <span class="pill">${s.filled}/${s.total} filled</span>${s.requiresFullSet ? ' <span class="pill warn">every part required</span>' : ''}</div></div>
      <div class="scroll"><table class="grid" style="margin-top:8px"><thead><tr><th>Part</th><th>Price</th><th>Held by</th><th></th></tr></thead><tbody>
      ${s.parts.map((p) => `<tr data-part="${esc(p.member)}"><td>${esc(p.member)}</td><td>${p.price == null ? '<span class="pill warn">TBC</span>' : money(p.price)}</td>
        <td>${p.handle ? `@${esc(p.handle)} <span class="pill ${p.status === 'confirmed' ? 'ok' : 'warn'}">${esc(p.status || '')}</span>${p.fixed ? ' <span class="pill">fixed</span>' : ''}${p.cancelAsked ? ' <span class="pill warn" data-cancel-asked>cancel requested</span>' : ''}${p.raffle?.status === 'resolved' ? ' <span class="pill ok">raffle win</span>' : ''}` : p.raffle?.status === 'pending' ? '<span class="pill warn">raffle pending</span>' : '<span class="sub">open</span>'}</td>
        <td>${partActions(s, p)}</td></tr>`).join('')}</tbody></table></div>
      ${s.parts.filter((p) => p.raffle).map((p) => `<div class="sub" style="margin-top:6px">Each person in this set took on about ${money(p.raffle.share)} extra for the unclaimed ${esc(p.member)} part${p.raffle.status === 'pending' ? ' — pick a raffle winner above.' : ' — it was raffled.'}</div>`).join('')}
      ${s.decision === 'none' ? `<div class="btn-row" style="align-items:center"><button data-act="secure" data-id="${s.id}" ${blocked ? 'disabled' : ''}>Secure this set</button><button class="secondary" data-act="cancel-set" data-id="${s.id}">Cancel this set</button>
        ${blocked ? `<span class="sub">${s.hasRequests ? 'A joiner has asked to cancel one of these parts — answer that first (top of the Claims tab) before this set can be secured.' : s.hasTbc ? "The price is still TBC — set it (Group Orders → Items → Edit) before this set can be secured." : s.filled === 0 ? 'Nobody has claimed anything in this set yet.' : `Waiting for ${open} more part${open === 1 ? '' : 's'} — this set can't go ahead unless every part is claimed.`}</span>` : ''}</div>`
      : s.decision === 'secured' ? `<div class="btn-row" style="align-items:center">${confirmNewBtn(s)}<button class="secondary" data-act="cancel-set" data-id="${s.id}">Cancel this set</button>${open ? `<span class="sub">${open} part${open === 1 ? ' is' : 's are'} still open — you can put someone into ${open === 1 ? 'it' : 'them'} above.</span>` : ''}</div>` : ''}</div>`;
  }

  function draw() {
    const list = visible();
    const reqCard = requests.length ? `<div class="card"><h2>Fixed-claim requests (${requests.length})</h2><p class="sub">Regulars whose set is already secured asking to give up or swap. Anyone whose set isn't secured yet can change it themselves.</p>
      ${requests.map((q) => `<div class="itemrow" data-req="${q.id}"><div class="grow"><strong>@${esc(q.handle)}</strong> wants to ${q.action === 'ot8' ? 'swap to the full set' : 'give up this claim'}<div class="sub">${esc(q.orderTitle)} — ${esc(q.itemTitle)} · ${esc(q.member)} · Set ${q.setNumber}</div></div>
        <div class="btn-row" style="margin:0"><button class="sm" data-act="approve-req" data-id="${q.id}" data-handle="${esc(q.handle)}" data-action="${q.action}">Approve</button><button class="sm secondary" data-act="decline-req" data-id="${q.id}">Decline</button></div></div>`).join('')}</div>` : '';
    root.innerHTML = `<h1 style="margin:18px 0 10px">Sets</h1>${reqCard}
      <div class="card"><div class="formgrid"><div><label>Group order</label><select data-filter="order"><option value="">All</option>${orders.filter((o) => o.items.some((i) => i.type === 'set')).map((o) => `<option value="${o.id}" ${String(o.id) === String(filter.order) ? 'selected' : ''}>${esc(o.title)}</option>`).join('')}</select></div>
        <div><label>Show</label><select data-filter="decision">${[['none', 'Waiting for a decision'], ['secured', 'Secured'], ['cancelled', 'Cancelled'], ['all', 'Everything']].map(([v, l]) => `<option value="${v}" ${filter.decision === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div></div>
      ${list.length ? list.map(setCard).join('') : '<div class="card"><p class="muted">No sets here.</p></div>'}`;
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, id = Number(b.dataset.id), s = sets.find((x) => x.id === id);
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
    const r = await api('POST', `/api/admin/sets/${form.dataset.set}/slots`, { member: form.dataset.member, handle: form.elements.handle.value });
    if (!r.ok) { m.textContent = errText(r); m.className = 'msg'; m.hidden = false; return; }
    adding = null; await render(root); GOM.toast(r.json.status === 'confirmed' ? 'Added — and confirmed, since the set is already secured.' : 'Added.');
  }

  async function onChange(e) {
    const t = e.target; if (!t.dataset.filter) return;
    filter[t.dataset.filter] = t.value;
    if (t.dataset.filter === 'order') return render(root);
    draw();
  }

  GOM.registerTab({
    id: 'sets', label: 'Sets',
    badgeCount: async () => ((await api('GET', '/api/admin/sets?decision=none')).json?.sets || []).length + ((await api('GET', '/api/admin/fixed-requests')).json?.requests || []).length
      + ((await api('GET', '/api/admin/sets?decision=secured')).json?.sets || []).reduce((n, s) => n + s.parts.filter((p) => p.status === 'requested').length, 0),
    async render(el) { await render(el); el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = onChange; },
  });
})();
