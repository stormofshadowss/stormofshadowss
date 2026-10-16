// Payments tab: verify what joiners say they've sent, say where they should send it, and keep an eye on credit and tips.
(function () {
  const { esc, money, fmtDate, api, errText, $, $$ } = GOM;
  let root = null, payments = [], methods = [], tips = 0, ledger = null;
  let methodsOpen = null;            // null = decide from the data (open only when there are no methods yet); true/false once you've opened or saved it
  const filter = { status: 'pending', q: '' };
  let ledgerHandle = '';
  let reversing = null;              // { id, plan, reason, busy } — the "Payment failed…" panel that is open (the plan is a preview: nothing has changed yet)

  const when = (iso) => `${fmtDate((iso || '').slice(0, 10))} ${(iso || '').slice(11, 16)}`;

  async function render(el) {
    root = el;
    const qs = filter.status === 'all' ? '' : `?status=${filter.status}`;
    const [p, m, l] = await Promise.all([api('GET', `/api/admin/payments${qs}`), api('GET', '/api/payment-methods'),
      api('GET', `/api/admin/ledger${ledgerHandle ? `?handle=${encodeURIComponent(ledgerHandle)}` : ''}`)]);
    payments = p.json?.payments || []; methods = m.json?.methods || []; tips = l.json?.tipsTotal || 0;
    ledger = ledgerHandle ? (l.json?.entries || []) : null;
    draw();
  }

  const KIND = { credit: 'Credit added', applied: 'Credit used', removed: 'Credit removed', tip: 'Tip', forfeited: 'Forfeited (blocked handle)' };

  function methodsCard() {
    const isOpen = methodsOpen ?? methods.length === 0;
    const names = methods.map((m) => m.method).join(', ');
    return `<details class="card" id="methodsCard" ${isOpen ? 'open' : ''}><summary style="cursor:pointer"><strong>Where joiners send payment</strong> <span class="sub" data-methods-summary>— ${methods.length ? `${methods.length} method${methods.length === 1 ? '' : 's'}: ${esc(names.length > 80 ? names.slice(0, 77) + '…' : names)} · click to edit` : 'none yet — click to add one'}</span></summary>
      <p class="sub">Joiners see these on the payment page. Remove a row to stop offering that method.</p>
      <form data-form="methods"><div id="methodRows">${methods.map(methodRow).join('')}</div>
        <p class="msg" data-msg hidden></p>
        <div class="btn-row"><button type="button" class="sm secondary" data-act="add-method">＋ Add a method</button><button type="submit" class="sm">Save</button></div></form></details>`;
  }
  const methodRow = (m) => `<div class="formgrid" style="margin-bottom:8px" data-mrow><div><label>Method</label><input name="method" value="${esc(m.method)}" maxlength="40" placeholder="PayPal"></div>
    <div class="span2"><label>Pay to</label><input name="info" value="${esc(m.accountInfo)}" maxlength="255" placeholder="@yourname (Friends & Family)"></div>
    <div><button type="button" class="sm secondary" data-act="remove-method">Remove</button></div></div>`;

  function paymentRow(p) {
    const name = p.payerIsAddressName === true ? '<span class="pill ok">matches address name</span>'
      : p.payerIsAddressName === false ? `<span class="pill warn">different name — address says ${esc(p.addressName || '?')}</span>`
      : '<span class="pill dim">no name on file</span>';
    const extra = p.overpayAmount ? `<strong>${money(p.overpayAmount)}</strong> extra → <span class="pill ${p.overpayChoice === 'tip' ? 'ok' : ''}">${p.overpayChoice === 'tip' ? 'tip' : 'credit'}</span>${p.overpayNote ? `<div class="sub">“${esc(p.overpayNote)}”</div>` : ''}` : '—';
    return `<tr data-payment="${p.id}"><td class="nowrap">${when(p.createdAt)}</td><td>@${esc(p.handle)}</td><td>${esc(p.orderTitle || 'All outstanding')}</td>
      <td class="nowrap"><strong>${money(p.amount)}</strong></td><td>${esc(p.method)}</td>
      <td>${p.reference ? esc(p.reference) : '<span class="sub">no reference</span>'}<div class="sub">${p.payerName ? esc(p.payerName) + ' ' : ''}${name}</div></td><td>${extra}</td>
      <td class="nowrap">${p.status === 'pending' ? `<button class="sm" data-act="verify" data-id="${p.id}">Verify</button> <button class="sm secondary" data-act="reject" data-id="${p.id}">Reject</button>`
        : p.status === 'confirmed' ? `<span class="pill ok">confirmed</span> <button class="sm secondary danger" data-act="reverse" data-id="${p.id}" title="It was verified, but the money never arrived (e.g. a bank transfer that bounced)">Payment failed…</button>`
        : p.status === 'reversed' ? `<span class="pill err" data-reversed>failed after it was received</span><div class="sub">${when(p.reversedAt)}${p.reverseReason ? ` · ${esc(p.reverseReason)}` : ''}</div>`
        : `<span class="pill dim">${p.status}</span>`}</td></tr>`;
  }
  // The "Payment failed…" panel: exactly what would change, before anything does
  function reversePanel() {
    const r = reversing, plan = r?.plan;
    if (!plan) return `<tr data-reverse-panel><td colspan="8"><div class="card" style="margin:0"><p class="sub" style="margin:0">Checking what would change…</p></div></td></tr>`;
    const items = plan.owedAgain.slice(0, 8).map((o) => `<li>${esc(o.label)} <span class="sub">@${esc(o.handle)}${o.category !== 'initials' ? ` · ${esc(o.category)}` : ''}</span> — <strong>${money(o.amount)}</strong>${o.creditHadBeenSpent ? ' <span class="pill warn">paid with credit from this payment</span>' : ''}</li>`).join('');
    return `<tr data-reverse-panel><td colspan="8"><div class="card" style="margin:0; border:2px solid var(--err-line, #d97a7a)"><strong>Mark this ${money(plan.total)} payment as failed</strong>
      <p style="margin:6px 0 4px">If you do this:</p><ul style="margin:0 0 8px 18px">
        <li><strong>${money(plan.owedAgainTotal)}</strong> is owed again${plan.owedAgain.length ? `, across ${plan.owedAgain.length} line${plan.owedAgain.length === 1 ? '' : 's'}:<ul>${items}${plan.owedAgain.length > 8 ? `<li class="sub">…and ${plan.owedAgain.length - 8} more</li>` : ''}</ul>` : '.'}</li>
        ${plan.creditRemoved > 0 ? `<li><strong>${money(plan.creditRemoved)}</strong> of credit that this payment created is taken back.</li>` : ''}
        ${plan.creditSpentUndone > 0 ? `<li><strong>${money(plan.creditSpentUndone)}</strong> of that credit had already been spent, so the items it paid for are owed again too (shown above).</li>` : ''}
        ${plan.tipsNotReceived > 0 ? `<li>The <strong>${money(plan.tipsNotReceived)}</strong> tip is noted as not received.</li>` : ''}
        ${plan.rejectedParts > 0 ? `<li>${plan.rejectedParts} other part${plan.rejectedParts === 1 ? '' : 's'} of the same payment, still waiting, ${plan.rejectedParts === 1 ? 'is' : 'are'} rejected.</li>` : ''}
        ${plan.notRecovered > 0 ? `<li class="late-text"><strong>${money(plan.notRecovered)}</strong> could not be recovered automatically — you will need to sort that out yourself.</li>` : ''}
        <li>The payment stays on record, marked as failed. <strong>No email is sent</strong> — message them yourself.</li></ul>
      <label>Reason (for your records)</label><input name="reverseReason" maxlength="255" value="${esc(r.reason)}" placeholder="e.g. bank transfer bounced">
      <p class="msg err" data-reverse-error hidden></p><div class="btn-row"><button class="sm" data-act="reverse-go" ${r.busy ? 'disabled' : ''}>${r.busy ? 'Working…' : 'Mark as failed'}</button><button class="sm secondary" data-act="reverse-cancel">Cancel</button></div></div></td></tr>`;
  }

  // A combined payment (one transfer covering several of a person's handles) is several rows with one batch key: show it as ONE line, with the split, and verify / reject it as one.
  function batchRow(rows) {
    const first = rows[0], pending = rows.filter((p) => p.status === 'pending'), total = rows.reduce((n, p) => n + Number(p.amount), 0), over = rows.find((p) => p.overpayAmount);
    const name = first.payerIsAddressName === true ? '<span class="pill ok">matches address name</span>' : first.payerIsAddressName === false ? `<span class="pill warn">different name — address says ${esc(first.addressName || '?')}</span>` : '<span class="pill dim">no name on file</span>';
    const status = rows.every((p) => p.status === rows[0].status) ? rows[0].status : 'part verified';
    return `<tr data-payment-batch="${esc(first.batchKey)}"><td class="nowrap">${when(first.createdAt)}</td>
      <td>${rows.map((p) => `<div>@${esc(p.handle)} <strong>${money(p.amount)}</strong>${p.status !== 'pending' ? ` <span class="pill ${p.status === 'confirmed' ? 'ok' : 'dim'}">${p.status}</span>` : ''}</div>`).join('')}<span class="pill">one payment, ${rows.length} handles</span></td>
      <td>${esc(first.orderTitle || 'All outstanding')}</td><td class="nowrap"><strong>${money(total)}</strong></td><td>${esc(first.method)}</td>
      <td>${first.reference ? esc(first.reference) : '<span class="sub">no reference</span>'}<div class="sub">${first.payerName ? esc(first.payerName) + ' ' : ''}${name}</div></td>
      <td>${over ? `<strong>${money(over.overpayAmount)}</strong> extra → <span class="pill ${over.overpayChoice === 'tip' ? 'ok' : ''}">${over.overpayChoice === 'tip' ? 'tip' : 'credit'}</span>${over.overpayNote ? `<div class="sub">“${esc(over.overpayNote)}”</div>` : ''}` : '—'}</td>
      <td class="nowrap">${pending.length ? `<button class="sm" data-act="verify-batch" data-key="${esc(first.batchKey)}">Verify all${pending.length < rows.length ? ` (${pending.length} left)` : ''}</button> <button class="sm secondary" data-act="reject-batch" data-key="${esc(first.batchKey)}">Reject all</button>`
        : status === 'reversed' ? `<span class="pill err" data-reversed>failed after it was received</span><div class="sub">${when(rows[0].reversedAt)}${rows[0].reverseReason ? ` · ${esc(rows[0].reverseReason)}` : ''}</div>`
        : `<span class="pill ${status === 'confirmed' ? 'ok' : 'dim'}">${status}</span>${rows.some((p) => p.status === 'confirmed') ? ` <button class="sm secondary danger" data-act="reverse" data-id="${rows.find((p) => p.status === 'confirmed').id}" title="It was verified, but the money never arrived">Payment failed…</button>` : ''}`}</td></tr>`;
  }
  // rows in the order shown, with each combined payment's rows gathered into one entry at the place its first row appears
  function lines(list) {
    const seen = new Set(), out = [];
    for (const p of list) {
      if (!p.batchKey) { out.push(paymentRow(p) + (reversing && reversing.id === p.id ? reversePanel() : '')); continue; }
      if (seen.has(p.batchKey)) continue; seen.add(p.batchKey);
      const rows = list.filter((x) => x.batchKey === p.batchKey).sort((x, y) => x.id - y.id);
      out.push((rows.length > 1 ? batchRow(rows) : paymentRow(p)) + (reversing && rows.some((x) => x.id === reversing.id) ? reversePanel() : ''));
    }
    return out;
  }

  function visible() {
    const q = filter.q.trim().toLowerCase().replace(/^@/, '');
    const hit = (p) => !q || [p.handle, p.reference, p.payerName].some((v) => (v || '').toLowerCase().includes(q));
    const keep = new Set(payments.filter((p) => p.batchKey && hit(p)).map((p) => p.batchKey));          // a combined payment stays whole if any part of it matches
    return payments.filter((p) => hit(p) || (p.batchKey && keep.has(p.batchKey)));
  }

  function draw() {
    const list = visible();
    root.innerHTML = `<h1 style="margin:18px 0 10px">Payments</h1>${methodsCard()}
      <div class="card"><div class="formgrid" style="margin-bottom:10px">
        <div><label>Show</label><select data-filter="status">${[['pending', 'Waiting for me'], ['confirmed', 'Verified'], ['rejected', 'Rejected'], ['reversed', 'Marked as failed'], ['all', 'Everything']].map(([v, l]) => `<option value="${v}" ${filter.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label>Search handle, reference or payer name</label><input data-filter="q" value="${esc(filter.q)}"></div></div>
      <div class="scroll"><table class="grid"><thead><tr><th>Sent</th><th>Person</th><th>For</th><th>Amount</th><th>Method</th><th>Reference / payer</th><th>Extra</th><th></th></tr></thead><tbody>
      ${list.length ? lines(list).join('') : `<tr><td colspan="8" class="muted">${filter.status === 'pending' ? 'Nothing waiting — all caught up.' : 'No payments match.'}</td></tr>`}</tbody></table></div></div>
      <div class="card"><div class="row"><h2 style="margin:0">Credit and tips</h2><span>Tips received so far: <strong>${money(tips)}</strong></span></div>
        <form data-form="lookup" class="btn-row" style="align-items:end"><div style="flex:1; min-width:180px"><label>Look up a person</label><input name="handle" value="${esc(ledgerHandle)}" placeholder="@handle"></div><button type="submit" class="sm">Look up</button></form>
        ${ledger ? ledgerHtml() : ''}</div>`;
  }

  function ledgerHtml() {
    const bal = ledger.reduce((s, e) => s + e.balanceEffect, 0);
    return `<h3 style="margin:16px 0 6px">@${esc(ledgerHandle.replace(/^@/, '').toLowerCase())} — credit on account: <strong>${money(bal)}</strong></h3>
      <div class="scroll"><table class="grid"><thead><tr><th>When</th><th>What</th><th>Amount</th><th>Reason</th></tr></thead><tbody>
      ${ledger.length ? ledger.map((e) => `<tr><td class="nowrap">${when(e.createdAt)}</td><td>${KIND[e.kind] || esc(e.kind)}</td><td class="nowrap">${e.balanceEffect < 0 ? '−' : ''}${money(Math.abs(e.amount))}</td><td>${esc(e.reason || e.source || '')}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">No credit history.</td></tr>'}</tbody></table></div>
      <div class="formgrid" style="margin-top:12px">
        <form data-form="credit-add" class="full"><div class="formgrid"><div><label>Add credit (£)</label><input name="amount" type="number" step="0.01" min="0.01"></div><div class="span2"><label>Reason (required)</label><input name="reason" maxlength="255" placeholder="e.g. goodwill / put back after contact"></div><div><button type="submit" class="sm">Add credit</button></div></div><p class="msg" data-msg hidden></p></form>
        <form data-form="credit-remove" class="full"><div class="formgrid"><div><label>Remove unspent credit (£)</label><input name="amount" type="number" step="0.01" min="0.01"></div><div class="span2"><label>Reason (optional)</label><input name="reason" maxlength="255" placeholder="e.g. refunded by bank"></div><div><button type="submit" class="sm secondary">Remove credit</button></div></div><p class="msg" data-msg hidden></p></form>
        <form data-form="credit-tip" class="full"><div class="formgrid"><div><label>Turn credit into a tip (£)</label><input name="amount" type="number" step="0.01" min="0.01"></div><div class="span2"><label>Reason (optional)</label><input name="reason" maxlength="255" placeholder="e.g. asked me to keep the change"></div><div><button type="submit" class="sm secondary">Turn into a tip</button></div></div><p class="sub" style="margin:4px 0 0">Only when they've asked you to. The credit leaves their account and is counted as a tip.</p><p class="msg" data-msg hidden></p></form></div>`;
  }

  const readMethods = () => $$('[data-mrow]', root).map((r) => ({ method: r.querySelector('[name=method]').value.trim(), accountInfo: r.querySelector('[name=info]').value.trim() }));
  const showMsg = (form, text) => { const m = $('[data-msg]', form); if (!m) return; m.textContent = text; m.className = 'msg'; m.hidden = !text; };

  async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const p = payments.find((x) => x.id === Number(b.dataset.id));
    switch (b.dataset.act) {
      case 'reverse': {
        reversing = { id: Number(b.dataset.id), plan: null, reason: '', busy: false }; draw();
        const r = await api('POST', `/api/admin/payments/${reversing.id}/reverse`, { dryRun: true });
        if (!r.ok) { reversing = null; draw(); return GOM.toast(errText(r), true); }
        if (reversing) { reversing.plan = r.json; draw(); $('[data-reverse-panel]', root)?.scrollIntoView?.({ block: 'center' }); }
        break;
      }
      case 'reverse-cancel': reversing = null; draw(); break;
      case 'reverse-go': {
        if (!reversing?.plan || reversing.busy) return;
        const keep = reversing; keep.busy = true; draw();
        const r = await api('POST', `/api/admin/payments/${keep.id}/reverse`, { reason: keep.reason.trim() || undefined });
        if (!r.ok) { keep.busy = false; draw(); const m = $('[data-reverse-error]', root); if (m) { m.textContent = errText(r); m.hidden = false; } return; }
        reversing = null; await render(root); GOM.refreshBadges();
        GOM.toast(`Marked as failed: ${money(r.json.owedAgainTotal)} is owed again${r.json.notRecovered > 0 ? ` — but ${money(r.json.notRecovered)} could not be recovered automatically` : ''}.`);
        break;
      }
      case 'verify-batch': {
        const rows = payments.filter((x) => x.batchKey === b.dataset.key && x.status === 'pending').sort((x, y) => x.id - y.id), total = rows.reduce((n, x) => n + Number(x.amount), 0);
        const ok = await GOM.confirm(`Mark the ${money(total)} payment as received?\n\nIt is ONE transfer covering ${rows.length} of this person's handles, split as: ${rows.map((x) => `@${x.handle} ${money(x.amount)}`).join(', ')}.\n\nEach part is applied to what that handle owes (item cost first, then EMS, customs, postage).${rows.some((x) => x.overpayAmount) ? `\n\nThey paid ${money(rows.find((x) => x.overpayAmount).overpayAmount)} extra and chose for it to be ${rows.find((x) => x.overpayAmount).overpayChoice === 'tip' ? 'a tip' : 'credit'}.` : ''}`, { ok: 'Mark all as received', cancel: 'Not yet' });
        if (!ok) return;
        const r = await api('POST', `/api/admin/payments/batch/${encodeURIComponent(b.dataset.key)}/verify`, {});
        await render(root); GOM.refreshBadges();
        if (!r.ok) return GOM.toast(errText(r), true);
        const applied = r.json.parts.reduce((n, x) => n + x.applied, 0), leftover = r.json.parts.reduce((n, x) => n + x.leftover, 0);
        GOM.toast(`Verified: ${money(applied)} applied across ${r.json.verified} handle${r.json.verified === 1 ? '' : 's'}.${leftover > 0 ? ` ${money(leftover)} kept as ${rows.find((x) => x.overpayAmount)?.overpayChoice === 'tip' ? 'a tip' : 'credit'}.` : ''}`);
        break;
      }
      case 'reject-batch': {
        const rows = payments.filter((x) => x.batchKey === b.dataset.key && x.status === 'pending').sort((x, y) => x.id - y.id);
        if (!(await GOM.confirm(`Reject the ${money(rows.reduce((n, x) => n + Number(x.amount), 0))} payment covering ${rows.map((x) => `@${x.handle}`).join(', ')}?\n\nNo money is moved. They'll need to send it again.`, { ok: 'Reject all', cancel: 'Not yet' }))) return;
        const r = await api('POST', `/api/admin/payments/batch/${encodeURIComponent(b.dataset.key)}/reject`, {});
        await render(root); GOM.refreshBadges(); GOM.toast(r.ok ? 'Rejected.' : errText(r), !r.ok);
        break;
      }
      case 'add-method': $('#methodRows', root).insertAdjacentHTML('beforeend', methodRow({ method: '', accountInfo: '' })); break;
      case 'remove-method': b.closest('[data-mrow]').remove(); break;
      case 'verify': {
        const ok = await GOM.confirm(`Mark the ${money(p.amount)} payment from @${p.handle} as received?\n\nIt will be applied to what they owe (item cost first, then EMS, customs, postage).${p.overpayAmount ? `\n\nThey paid ${money(p.overpayAmount)} extra and chose for it to be ${p.overpayChoice === 'tip' ? 'a tip' : 'credit'}.` : ''}${p.payerIsAddressName === false ? `\n\nNote: it was paid under a different name (${p.payerName}).` : ''}`, { ok: 'Yes, it arrived' });
        if (!ok) return;
        const r = await api('POST', `/api/admin/payments/${p.id}/verify`, {});
        await render(root); GOM.refreshBadges();
        if (!r.ok) return GOM.toast(errText(r), true);
        const j = r.json;
        GOM.toast(`Verified: ${money(j.applied)} applied.${j.leftover > 0 ? ` ${money(j.leftover)} ${p.overpayChoice === 'tip' ? 'recorded as a tip' : 'kept as credit'}.` : ''}${j.creditApplied > 0 ? ` ${money(j.creditApplied)} of their credit was used too.` : ''}`);
        break;
      }
      case 'reject': {
        if (!(await GOM.confirm(`Reject the ${money(p.amount)} payment from @${p.handle}?\n\nNo money is moved. They'll need to send it again.`, { ok: 'Reject it' }))) return;
        const r = await api('POST', `/api/admin/payments/${p.id}/reject`, {});
        await render(root); GOM.refreshBadges();
        GOM.toast(r.ok ? 'Rejected.' : errText(r), !r.ok);
        break;
      }
      default:
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.target, kind = form.dataset.form;
    showMsg(form, '');
    if (kind === 'methods') {
      const rows = readMethods().filter((r) => r.method || r.accountInfo);
      if (rows.some((r) => !r.method || !r.accountInfo)) return showMsg(form, 'Each method needs both a name and where to pay.');
      const r = await api('PUT', '/api/admin/payment-methods', { methods: rows });
      if (!r.ok) return showMsg(form, errText(r));
      methodsOpen = false;                                                // saved: tuck it away again
      await render(root); GOM.toast('Saved.');
    } else if (kind === 'lookup') {
      ledgerHandle = form.elements.handle.value.trim().replace(/^@/, '').toLowerCase();
      await render(root);
    } else if (kind === 'credit-tip') {
      const amount = Number(form.elements.amount.value), reason = form.elements.reason.value.trim();
      if (!(amount > 0)) return showMsg(form, 'Enter an amount.');
      const ok = await GOM.confirm(`Turn ${money(amount)} of @${ledgerHandle}'s credit into a tip?\n\nOnly do this if they've asked you to. The credit leaves their account and is recorded as a tip — it can't be turned back into credit afterwards (you could add credit by hand if you ever needed to).`, { ok: 'Turn it into a tip', cancel: 'Cancel' });
      if (!ok) return;
      const r = await api('POST', '/api/admin/credit/tip', { handle: ledgerHandle, amount, reason: reason || undefined });
      if (!r.ok) return showMsg(form, errText(r));
      await render(root); GOM.toast(`${money(amount)} turned into a tip.`);
    } else if (kind === 'credit-add' || kind === 'credit-remove') {
      const amount = Number(form.elements.amount.value), reason = form.elements.reason.value.trim();
      const adding = kind === 'credit-add';
      if (!(amount > 0)) return showMsg(form, 'Enter an amount.');
      if (adding && !reason) return showMsg(form, 'Add a reason so you remember why.');
      const r = await api('POST', `/api/admin/credit/${adding ? 'add' : 'remove'}`, { handle: ledgerHandle, amount, reason: reason || undefined });
      if (!r.ok) return showMsg(form, errText(r));
      await render(root); GOM.toast(adding ? 'Credit added.' : 'Credit removed.');
    }
  }

  async function onChange(e) { if (e.target.dataset.filter === 'status') { filter.status = e.target.value; render(root); } }
  function onInput(e) {
    if (e.target.name === 'reverseReason' && reversing) { reversing.reason = e.target.value; return; }
    if (e.target.dataset.filter === 'q') { filter.q = e.target.value; const pos = e.target.selectionStart; draw(); const q = $('[data-filter="q"]', root); q.focus(); q.setSelectionRange?.(pos, pos); }
  }

  GOM.registerTab({
    id: 'payments', label: 'Payments',
    badgeCount: async () => new Set(((await api('GET', '/api/admin/payments?status=pending')).json?.payments || []).map((p) => p.batchKey || `#${p.id}`)).size,       // a combined payment is one payment
    async render(el) { if (!el._methodsToggle) { el._methodsToggle = true; el.addEventListener('toggle', (e) => { if (e.target.id === 'methodsCard') methodsOpen = e.target.open; }, true); } await render(el); el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = onChange; el.oninput = onInput; },
  });
})();
