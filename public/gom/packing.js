// Packing tab: the first-come-first-served queue, with everything you need to pack and post each parcel.
(function () {
  const { esc, money, fmtDate, api, errText, $, $$ } = GOM;
  const STATES = [['requested', 'Queue'], ['packed', 'Packed'], ['shipped', 'Shipped'], ['received', 'Received']];
  let root = null, parcels = [], counts = {}, status = 'requested';
  let combine = null;       // the "combine with another parcel" panel that is open: { id, candidates, pick, ok }

  async function render(el) {
    root = el;
    const results = await Promise.all(STATES.map(([s]) => api('GET', `/api/admin/packing?status=${s}`)));
    STATES.forEach(([s], i) => { counts[s] = (results[i].json?.parcels || []).length; });
    parcels = results[STATES.findIndex(([s]) => s === status)].json?.parcels || [];
    draw();
  }

  // What must be ticked before a parcel can be marked packed: every item, the address, and the Lomo name / bias name when it has them — and the
  // same two for a friend sharing the parcel. A friend who has been asked but hasn't answered holds the parcel up.
  const friends = (p) => (p.companions || []).filter((c) => c.status === 'accepted');
  const waiting = (p) => (p.companions || []).filter((c) => c.status === 'invited');
  const declined = (p) => (p.companions || []).filter((c) => c.status === 'declined');
  const names = (hs) => { const t = hs.map((h) => `@${esc(h)}`); return t.length <= 1 ? t.join('') : `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}`; };
  const checkTotal = (p) => p.items.length + 1 + (p.lomoName ? 1 : 0) + (p.bias ? 1 : 0) + friends(p).reduce((n, f) => n + (f.lomoName ? 1 : 0) + (f.bias ? 1 : 0), 0);
  const checkDone = (p) => p.items.filter((i) => i.packed).length + (p.addressChecked ? 1 : 0) + (p.lomoName && p.lomoChecked ? 1 : 0) + (p.bias && p.biasChecked ? 1 : 0)
    + friends(p).reduce((n, f) => n + (f.lomoName && f.lomoChecked ? 1 : 0) + (f.bias && f.biasChecked ? 1 : 0), 0);
  const allTicked = (p) => checkDone(p) === checkTotal(p) && !waiting(p).length;
  const tag = (p, i) => (friends(p).length ? ` <span class="sub">@${esc(i.owner)}</span>` : '');
  const splitWords = (p) => (p.feeSplit?.mode === 'weight' ? "by the weight of each person's items" : 'equally per person');

  function checklist(p) {
    const box = (kind, checked, label, claim, friendHandle) => `<label class="chk" style="margin:4px 0"><input type="checkbox" data-tick="${kind}" ${claim ? `data-claim="${claim}"` : ''} ${friendHandle ? `data-friend="${esc(friendHandle)}"` : ''} ${checked ? 'checked' : ''}> ${label}</label>`;
    return `<div data-checklist><div class="row" style="margin-bottom:4px"><label style="margin:0">Packing checklist <span class="pill" data-count>${checkDone(p)} of ${checkTotal(p)} ticked</span></label><button class="sm secondary" data-act="tick-all" data-id="${p.id}">Tick all</button></div>
      ${p.items.map((i) => box('item', i.packed, `${esc(i.label)}${tag(p, i)}`, i.claimId)).join('')}
      ${box('address', p.addressChecked, 'Delivery address checked')}
      ${p.lomoName ? box('lomo', p.lomoChecked, `Lomo name checked — <strong>${esc(p.lomoName)}</strong> <span class="sub">(${p.lomoSource === 'custom' ? 'a name they chose' : 'their delivery name'})</span>`) : ''}
      ${p.bias ? box('bias', p.biasChecked, `Bias name checked — <strong>${esc(p.bias)}</strong> <span class="sub">(for the thank-you card)</span>`) : ''}
      ${friends(p).map((f) => `${f.lomoName ? box('lomo', f.lomoChecked, `Lomo name for @${esc(f.handle)} checked — <strong>${esc(f.lomoName)}</strong> <span class="sub">(${f.lomoSource === 'custom' ? 'a name they chose' : 'their delivery name'})</span>`, null, f.handle) : ''}
        ${f.bias ? box('bias', f.biasChecked, `Bias name for @${esc(f.handle)} checked — <strong>${esc(f.bias)}</strong> <span class="sub">(for their thank-you card)</span>`, null, f.handle) : ''}`).join('')}</div>`;
  }

  // Updates the counter and the Mark packed button in place — no redraw, so fees you've typed are never lost.
  function refreshChecklist(card, p) {
    $('[data-count]', card).textContent = `${checkDone(p)} of ${checkTotal(p)} ticked`;
    const btn = $('[data-act="packed"]', card), ready = allTicked(p);
    if (btn) btn.disabled = !ready;
    const hint = $('[data-pack-hint]', card); if (hint) hint.hidden = ready;
  }

  const when = (iso) => `${fmtDate((iso || '').slice(0, 10))} ${(iso || '').slice(11, 16)}`;

  const HOW = { joiner: 'they agreed on the site', gom: 'combined by you' };
  function card(p) {
    const addr = [p.deliveryName, p.deliveryAddress, p.deliveryPhone && `Tel: ${p.deliveryPhone}`].filter(Boolean).join('\n');
    const fr = friends(p), wt = waiting(p), dc = declined(p);
    const friendBits = fr.map((c) => `<div data-friend-details style="margin-top:6px"><strong>@${esc(c.handle)}'s details:</strong> ${[c.bias && `bias ${esc(c.bias)}`, c.lomoName && `Lomo ${esc(c.lomoName)} (${c.lomoSource === 'custom' ? 'a name they chose' : 'their delivery name'})`, c.notes && `notes: ${esc(c.notes)}`].filter(Boolean).join(' · ') || 'nothing extra'}</div>`).join('');
    return `<div class="card" data-parcel="${p.id}">
      <div class="row"><div><strong>${p.status === 'requested' ? `#${p.queuePosition} in the queue · ` : ''}Parcel ${p.id} — @${esc(p.handle)}</strong>${fr.length ? ` <span class="pill" data-shared-pill>shared with ${fr.map((f) => `@${esc(f.handle)}`).join(', ')}</span>` : ''}${wt.length ? ` <span class="pill warn" data-invited-pill>invited ${wt.map((f) => `@${esc(f.handle)}`).join(', ')}</span>` : ''}
        ${p.handleVerified ? '' : ` <span class="pill warn">not checked yet</span> <button class="sm secondary" data-act="verify" data-handle="${esc(p.handle)}">Mark as checked</button>`}
        <div class="sub">Requested ${when(p.requestedAt)} · ${esc(p.method)}${p.declaredValue ? ` · declared ${p.declaredValue === 'true' ? 'true value' : 'reduced value'}` : ''}</div>
        ${fr.length ? `<div class="sub" data-share-line>One parcel to @${esc(p.handle)}'s address, with ${fr.map((f) => `@${esc(f.handle)}'s`).join(' and ')} items${fr.length === 1 ? ` (${HOW[fr[0].how]})` : ''}. Postage and packaging are split ${splitWords(p)}.</div>` : ''}
        ${wt.length ? `<div class="sub" data-share-line>⏳ Waiting for ${names(wt.map((f) => f.handle))} to say yes to sharing this parcel — it can't be packed until ${wt.length === 1 ? 'they answer' : 'they have all answered'}.</div>` : ''}
        ${dc.length ? `<div class="sub" data-share-line>${names(dc.map((f) => f.handle))} said no to sharing${fr.length || wt.length ? '' : ', so this goes on its own'}.</div>` : ''}</div></div>
      ${p.handleVerified ? '' : '<p class="sub">You haven\'t checked this person yet. Worth a quick Instagram DM to confirm the address before their first parcel goes out.</p>'}
      <div class="formgrid" style="margin-top:8px"><div class="span2"><label>Send to</label><pre style="margin:0; white-space:pre-wrap; font:inherit">${addr ? esc(addr) : 'No address on file'}</pre>
        ${addr ? `<button class="sm secondary" data-act="copy" data-id="${p.id}" style="margin-top:6px">Copy address</button>` : ''}</div>
        <div class="span2">${p.status === 'requested' ? checklist(p) : `<label>Items</label><ul style="margin:0; padding-left:18px; list-style:none">${p.items.map((i) => `<li>${i.packed ? '✓ ' : ''}${esc(i.label)}${tag(p, i)}</li>`).join('')}</ul>`}</div></div>
      <div class="sub" style="margin-top:8px">${p.notes ? `<div><strong>Packing notes:</strong> ${esc(p.notes)}</div>` : ''}${p.bias ? `<div><strong>Bias (thank-you card):</strong> ${esc(p.bias)}</div>` : ''}
        <div><strong>Personalised Lomo:</strong> ${p.lomoName ? `${esc(p.lomoName)} <span class="pill ${p.lomoSource === 'custom' ? 'warn' : ''}">${p.lomoSource === 'custom' ? 'a name they chose' : 'their delivery name'}</span>` : 'no name given'}</div>${friendBits}</div>
      <div data-combine-slot></div>
      ${actions(p)}</div>`;
  }

  // The "combine with another parcel" panel, shown inside the parcel's own card (so nothing typed elsewhere is lost).
  function combinePanel(p) {
    const cs = combine.candidates, pick = cs.find((c) => c.id === combine.pick);
    return `<div class="card" data-combine-panel style="background:var(--paper); margin-top:10px"><strong>Combine with another parcel</strong>
      <p class="sub">The other parcel's items join this one and go to <strong>@${esc(p.handle)}</strong>'s address, in one parcel (up to ${p.maxPeople} people). Only parcels asking for the same postage method (${esc(p.method)}) and with no fees set yet are listed.</p>
      ${cs.length ? cs.map((c) => `<label class="chk" style="margin:6px 0"><input type="radio" name="pick-${p.id}" data-pick value="${c.id}" ${combine.pick === c.id ? 'checked' : ''}> <strong>@${esc(c.handle)}</strong> — ${c.items.length} item${c.items.length === 1 ? '' : 's'}: ${esc(c.items.join(', '))} <span class="sub">(requested ${when(c.requestedAt)})</span></label>`).join('')
        : '<p class="muted" data-none>No other parcel in the queue can be combined with this one.</p>'}
      ${cs.length ? `<label class="chk" style="margin-top:8px"><input type="checkbox" data-combine-ok ${combine.ok ? 'checked' : ''}> <span>I've checked with ${pick ? names([p.handle, ...friends(p).map((f) => f.handle), pick.handle]) : 'everyone involved'} that they're happy to share one parcel to @${esc(p.handle)}'s address</span></label>` : ''}
      <div class="btn-row"><button data-act="combine-go" data-id="${p.id}" ${pick && combine.ok ? '' : 'disabled'}>Combine them</button><button class="secondary" data-act="combine-cancel" data-id="${p.id}">Cancel</button></div></div>`;
  }
  const showCombine = (id) => { const card = $(`[data-parcel="${id}"]`); if (card) $('[data-combine-slot]', card).innerHTML = combine ? combinePanel(parcels.find((x) => x.id === id)) : ''; };

  function actions(p) {
    if (p.status === 'requested') {
      const unset = [p.domsTotal == null && 'postage', p.packagingTotal == null && 'packaging fee'].filter(Boolean);
      const fr = friends(p), others = (p.companions || []).filter((c) => c.status !== 'accepted'), places = 1 + (p.companions || []).filter((c) => c.status !== 'declined').length;
      const share = [
        !p.feesSet && places < p.maxPeople ? `<button class="secondary" data-act="combine-open" data-id="${p.id}">Combine with another parcel…</button>` : '',
        !p.feesSet ? fr.map((f) => `<button class="secondary" data-act="uncombine" data-id="${p.id}" data-friend="${esc(f.handle)}">${fr.length === 1 ? 'Split them apart' : `Split @${esc(f.handle)} off`}</button>`).join('') : '',
        others.map((c) => `<button class="secondary" data-act="remove-invite" data-id="${p.id}" data-friend="${esc(c.handle)}">${others.length === 1 ? (c.status === 'invited' ? 'Remove the invitation' : 'Clear this') : (c.status === 'invited' ? `Remove @${esc(c.handle)}'s invitation` : `Clear @${esc(c.handle)}`)}</button>`).join(''),
      ].join('');
      // how the fees are split between the people, and what each person's things weigh
      const mode = p.feeSplit ? (p.feeSplit.auto ? 'auto' : p.feeSplit.mode) : 'auto';
      const splitBox = fr.length ? `<div data-split style="margin-top:12px"><label>How to split the postage and packaging between ${p.people.length} people</label>
          <select data-split-mode aria-label="How to split fees"><option value="auto" ${mode === 'auto' ? 'selected' : ''}>Automatic — by weight for worldwide postage, equally per person for UK${p.feeSplit?.auto ? ` (this one: ${p.feeSplit.mode === 'weight' ? 'by weight' : 'equally'})` : ''}</option>
            <option value="equal" ${mode === 'equal' ? 'selected' : ''}>Equally per person</option><option value="weight" ${mode === 'weight' ? 'selected' : ''}>By weight</option></select>
          <div class="scroll"><table class="grid" style="margin-top:6px"><thead><tr><th>Person</th><th>Items</th><th>Estimated</th><th>You weighed (g)</th><th>Postage</th><th>Packaging</th></tr></thead><tbody>
          ${p.people.map((x) => `<tr data-person="${esc(x.handle)}"><td>@${esc(x.handle)}${x.role === 'recipient' ? ' <span class="sub">(posted to)</span>' : ''}</td><td>${x.items}</td><td>${x.estimatedG} g</td>
            <td><input data-weight type="number" min="1" step="1" value="${x.weightG ?? ''}" placeholder="${x.estimatedG}" style="max-width:100px" aria-label="Weight in grams for @${esc(x.handle)}"></td>
            <td>${p.domsTotal != null ? money(x.doms) : '—'}</td><td>${p.packagingTotal != null ? money(x.packaging) : '—'}</td></tr>`).join('')}</tbody></table></div>
          <div class="sub" data-split-hint>${p.feeSplit.mode === 'weight' ? "Each person pays in proportion to their weight. Type what you weighed for each person, or leave a box blank to use the estimate (from their items' own weights, or their sizes)." : 'Weights are only used when splitting by weight — you can still record them here.'}</div>
          <button class="sm" data-act="split-save" data-id="${p.id}" style="margin-top:6px">Save split</button></div>` : '';
      return `<form data-form="fees" data-id="${p.id}" style="margin-top:10px"><div class="formgrid" style="max-width:520px">
          <div><label>Postage — Doms (£)</label><input name="doms" type="number" step="0.01" min="0" value="${p.domsTotal ?? ''}" placeholder="e.g. 4.50"></div>
          <div><label>Packaging fee (£)</label><input name="packaging" type="number" step="0.01" min="0" value="${p.packagingTotal ?? ''}" placeholder="e.g. 1.00"></div>
          <div><button type="submit" class="sm">Save fees</button></div></div>
        <div class="sub" style="margin-top:4px">${unset.length ? `Not set yet: ${unset.join(' and ')}. Each is for the whole parcel, ${fr.length ? `split ${splitWords(p)}, then shared across each person's own items` : 'shared across its items'}.` : `Saved: postage ${money(p.domsTotal)} · packaging ${money(p.packagingTotal)}`}${p.feesSet && !(p.companions || []).length ? ' (fees are set, so this parcel can no longer be combined)' : ''}</div>
        <p class="msg" data-msg hidden></p></form>
        ${splitBox}
        <div class="btn-row" style="align-items:center"><button data-act="packed" data-id="${p.id}" ${allTicked(p) ? '' : 'disabled'}>Mark packed</button><button class="secondary" data-act="cancel" data-id="${p.id}">Cancel parcel</button>${share}
          <span class="sub" data-pack-hint ${allTicked(p) ? 'hidden' : ''}>${waiting(p).length ? `Waiting for ${names(waiting(p).map((f) => f.handle))} to answer the invitation${waiting(p).length === 1 ? '' : 's'} before this can be packed.` : 'Tick everything on the checklist to enable Mark packed.'}</span></div>`;
    }
    const next = { packed: ['shipped', 'Mark shipped'], shipped: ['received', 'Mark received (on their behalf)'] }[p.status];
    return `<div class="sub" style="margin-top:8px">${[p.domsTotal != null && `Postage ${money(p.domsTotal)}`, p.packagingTotal != null && `Packaging ${money(p.packagingTotal)}`].filter(Boolean).join(' · ')}${p.domsTotal != null || p.packagingTotal != null ? ' · ' : ''}${[p.packedDate && `packed ${fmtDate(p.packedDate)}`, p.shippedDate && `shipped ${fmtDate(p.shippedDate)}`, p.receivedDate && `received ${fmtDate(p.receivedDate)}`].filter(Boolean).join(' · ')}</div>
      ${next ? `<div class="btn-row"><button data-act="${next[0]}" data-id="${p.id}">${next[1]}</button></div>` : ''}`;
  }

  function draw() {
    root.innerHTML = `<h1 style="margin:18px 0 10px">Packing</h1>
      <div class="btn-row" style="margin:0 0 12px">${STATES.map(([s, l]) => `<button class="sm ${status === s ? '' : 'secondary'}" data-act="status" data-status="${s}">${l} (${counts[s] ?? 0})</button>`).join('')}</div>
      ${parcels.length ? parcels.map(card).join('') : `<div class="card"><p class="muted">${status === 'requested' ? 'The queue is empty.' : 'Nothing here.'}</p></div>`}`;
  }

  // Reads the two fee boxes of a parcel's form. blank = left alone; returns { values, error }.
  function readFees(form) {
    const values = {};
    for (const key of ['doms', 'packaging']) {
      const raw = form.elements[key].value.trim();
      if (raw === '') continue;
      const n = Number(raw);
      if (Number.isNaN(n) || n < 0) return { error: `The ${key === 'doms' ? 'postage' : 'packaging fee'} must be an amount of £0 or more.` };
      values[key] = n;
    }
    return { values };
  }
  const feeMsg = (form, text) => { const m = $('[data-msg]', form); m.textContent = text; m.className = 'msg'; m.hidden = !text; };

  async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, id = Number(b.dataset.id);
    const p = parcels.find((x) => x.id === id);
    if (act === 'status') { status = b.dataset.status; return render(root); }
    if (act === 'tick-all') {
      const card = $(`[data-parcel="${id}"]`);
      const a = await api('POST', `/api/admin/parcels/${id}/items-packed`, { packed: true });
      const c = a.ok && await api('POST', `/api/admin/parcels/${id}/checks`, { address: true, lomo: true, bias: true });
      const f = a.ok && c.ok && friends(p).length ? await api('POST', `/api/admin/parcels/${id}/checks`, { friend: true, lomo: true, bias: true }) : { ok: true };
      if (!a.ok || !c.ok || !f.ok) { GOM.toast(errText(!a.ok ? a : !c.ok ? c : f), true); return render(root); }
      p.items.forEach((i) => { i.packed = true; }); p.addressChecked = p.lomoChecked = p.biasChecked = true;
      friends(p).forEach((f2) => { f2.lomoChecked = f2.biasChecked = true; });
      $$('input[data-tick]', card).forEach((x) => { x.checked = true; });
      return refreshChecklist(card, p);
    }
    if (act === 'combine-open') {
      const r = await api('GET', `/api/admin/parcels/${id}/combine-candidates`);
      if (!r.ok) return GOM.toast(errText(r), true);
      combine = { id, candidates: r.json.candidates, pick: null, ok: false }; return showCombine(id);
    }
    if (act === 'combine-cancel') { combine = null; return showCombine(id); }
    if (act === 'combine-go') {
      const other = combine.candidates.find((c) => c.id === combine.pick);
      const ok = await GOM.confirm(`Combine @${other.handle}'s parcel into @${p.handle}'s?\n\nIt becomes ONE parcel to @${p.handle}'s address with everyone's items. Postage and packaging will be shared out between them (equally per person for UK postage, or by weight for worldwide). Each keeps their own bias name, Lomo name and notes, and the combined parcel keeps the earlier place in the queue.\n\nYou can split them apart again until you save any fees.`, { ok: 'Combine them', cancel: 'Not yet' });
      if (!ok) return;
      const r = await api('POST', `/api/admin/parcels/${id}/combine`, { withParcelId: other.id, confirmed: true });
      combine = null; await render(root); GOM.refreshBadges();
      return GOM.toast(r.ok ? `Combined — parcel ${id} now holds ${1 + friends(parcels.find((x) => x.id === id) || { companions: [] }).length} people.` : errText(r), !r.ok);
    }
    if (act === 'uncombine') {
      const who = b.dataset.friend || friends(p)[0].handle;
      if (!(await GOM.confirm(`Split parcel ${id} apart?\n\n@${who}'s items go back into a parcel of their own, with their own bias, Lomo name and notes, in the place they had in the queue.${friends(p).length > 1 ? ' The others stay together.' : ''}`, { ok: 'Split them', cancel: 'Not yet' }))) return;
      const r = await api('POST', `/api/admin/parcels/${id}/uncombine`, { friend: who });
      await render(root); GOM.refreshBadges(); return GOM.toast(r.ok ? 'Split apart — they each have their own parcel again.' : errText(r), !r.ok);
    }
    if (act === 'remove-invite') {
      const who = b.dataset.friend, c = p.companions.find((x) => x.handle === who);
      if (!(await GOM.confirm(c.status === 'invited' ? `Remove the invitation to @${who}?\n\nThis parcel will no longer wait for their answer.` : 'Clear this?', { ok: 'Yes', cancel: 'Not yet' }))) return;
      const r = await api('DELETE', `/api/admin/parcels/${id}/companion?friend=${encodeURIComponent(who)}`);
      await render(root); return GOM.toast(r.ok ? 'Done.' : errText(r), !r.ok);
    }
    if (act === 'split-save') {                      // how the fees are split, and what each person's things weighed
      const box = $(`[data-parcel="${id}"] [data-split]`), weights = {};
      for (const row of $$('tr[data-person]', box)) {
        const raw = $('[data-weight]', row).value.trim();
        if (raw !== '' && (!/^\d+$/.test(raw) || Number(raw) < 1)) return GOM.toast(`Enter a whole number of grams for @${row.dataset.person}, or leave it blank.`, true);
        weights[row.dataset.person] = raw === '' ? null : Number(raw);
      }
      const r = await api('POST', `/api/admin/parcels/${id}/split`, { mode: $('[data-split-mode]', box).value, weights });
      await render(root); return GOM.toast(r.ok ? 'Split saved.' : errText(r), !r.ok);
    }
    if (act === 'verify') {
      const r = await api('POST', '/api/admin/joiners/verify', { handle: b.dataset.handle });
      await render(root); return GOM.toast(r.ok ? `@${b.dataset.handle} marked as checked.` : errText(r), !r.ok);
    }
    if (act === 'copy') {
      const text = [p.deliveryName, p.deliveryAddress].filter(Boolean).join('\n');
      try { await navigator.clipboard.writeText(text); GOM.toast('Address copied.'); } catch { GOM.alert(`Copy this address:\n\n${text}`); }
      return;
    }
    if (act === 'packed') {
      if (!allTicked(p)) return GOM.toast('Tick everything on the checklist first.', true);
      // Fees are typed in by hand each time, so show exactly what the joiner will owe before this goes ahead.
      const form = $(`[data-parcel="${id}"] form[data-form="fees"]`);
      const { values, error } = readFees(form);
      if (error) return feeMsg(form, error);
      feeMsg(form, '');
      const doms = values.doms ?? p.domsTotal, packaging = values.packaging ?? p.packagingTotal;
      const line = (label, v) => `${label}: ${v == null ? 'not set' : money(v)}`;
      const total = (doms || 0) + (packaging || 0);
      const missing = [doms == null && 'postage', packaging == null && 'packaging fee'].filter(Boolean);
      const fr = friends(p), ppl = p.people || [];
      const sumW = ppl.reduce((t, x) => t + x.usedG, 0);
      const owes = !fr.length ? `@${p.handle} will owe ${money(total)} for these, on top of anything they already owe.`
        : p.feeSplit?.mode === 'weight' && sumW > 0 ? `Split by the weight of each person's items: ${ppl.map((x) => `@${x.handle} about ${money(total * x.usedG / sumW)}`).join(', ')} — on top of anything they already owe.`
        : `${names(ppl.map((x) => x.handle)).replace(/<[^>]*>/g, '')} will each owe about ${money(total / ppl.length)} for these (split equally per person), on top of anything they already owe.`;
      const ok = await GOM.confirm(`Mark parcel ${id} for @${p.handle}${fr.length ? ` (shared with ${fr.map((f2) => `@${f2.handle}`).join(', ')})` : ''} as packed?\n\n${line('Postage (Doms)', doms)}\n${line('Packaging fee', packaging)}\n\n${owes}${missing.length ? `\n\nYou haven't set the ${missing.join(' or the ')}. Pack it anyway? (Fees can't be changed once it's packed.)` : ''}`, { ok: 'Mark packed', cancel: 'Not yet' });
      if (!ok) return;
      if (Object.keys(values).length) {             // save whatever was typed, then pack — nothing is saved if you say "Not yet"
        const s = await api('POST', `/api/admin/parcels/${id}/fees`, values);
        if (!s.ok) { await render(root); return GOM.toast(errText(s), true); }
      }
    }
    if (act === 'cancel') {
      if (!(await GOM.confirm(`Cancel parcel ${id} for @${p.handle}?\n\nTheir items go back to "ready to pack", and any postage and packaging fee you added are taken off (returned as credit if they'd already paid them). They can request shipping again.`, { ok: 'Cancel the parcel', cancel: 'Keep it' }))) return;
    }
    if (act === 'received' && !(await GOM.confirm(`Mark parcel ${id} as received on behalf of @${p.handle}?\n\nTheir items move to Completed.`, { ok: 'Yes, mark received' }))) return;
    const r = await api('POST', `/api/admin/parcels/${id}/${act}`, {});
    await render(root); GOM.refreshBadges();
    const done = { packed: 'Marked packed.', shipped: 'Marked shipped.', received: 'Marked received.', cancel: 'Parcel cancelled.' }[act];
    GOM.toast(r.ok ? done : errText(r), !r.ok);
  }

  // Ticks are saved the moment you make them. If the server refuses (e.g. the parcel moved on in another tab), you're told and the screen refreshes.
  async function onChange(e) {
    if (e.target.matches?.('input[data-pick]')) { combine.pick = Number(e.target.value); return showCombine(combine.id); }
    if (e.target.matches?.('input[data-combine-ok]')) { combine.ok = e.target.checked; return showCombine(combine.id); }
    const box = e.target.closest('input[data-tick]'); if (!box) return;
    const card = box.closest('[data-parcel]'), id = Number(card.dataset.parcel), p = parcels.find((x) => x.id === id);
    const kind = box.dataset.tick, on = box.checked;
    const isFriend = !!box.dataset.friend;
    if (kind === 'item') p.items.find((i) => i.claimId === Number(box.dataset.claim)).packed = on; else if (isFriend) p.companions.find((c) => c.handle === box.dataset.friend)[`${kind}Checked`] = on; else p[`${kind}Checked`] = on;
    refreshChecklist(card, p);
    const r = kind === 'item'
      ? await api('POST', `/api/admin/parcels/${id}/items-packed`, { packed: on, claimIds: [Number(box.dataset.claim)] })
      : await api('POST', `/api/admin/parcels/${id}/checks`, isFriend ? { friend: box.dataset.friend, [kind]: on } : { [kind]: on });
    if (!r.ok) { GOM.toast(errText(r), true); await render(root); }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.target, id = Number(form.dataset.id);
    const { values, error } = readFees(form);
    if (error) return feeMsg(form, error);
    if (!Object.keys(values).length) return feeMsg(form, 'Enter the postage and/or the packaging fee.');
    feeMsg(form, '');
    const r = await api('POST', `/api/admin/parcels/${id}/fees`, values);
    if (!r.ok) return feeMsg(form, errText(r));
    await render(root);
    GOM.toast(`Fees saved${'doms' in values ? ` — postage ${money(values.doms)}` : ''}${'packaging' in values ? ` — packaging ${money(values.packaging)}` : ''}.`);
  }

  GOM.registerTab({
    id: 'packing', label: 'Packing',
    badgeCount: async () => ((await api('GET', '/api/admin/packing?status=requested')).json?.parcels || []).length,
    async render(el) { await render(el); el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = onChange; },
  });
})();
