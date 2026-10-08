// Payments tab: verify what joiners say they've sent, say where they should send it, and keep an eye on credit and tips.
(function () {
  const { esc, money, fmtDate, api, errText, $, $$ } = GOM;
  let root = null, payments = [], methods = [], tips = 0, ledger = null;
  const filter = { status: 'pending', q: '' };
  let ledgerHandle = '';

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
    return `<div class="card"><h2>Where joiners send payment</h2>
      <p class="sub">Joiners see these on the payment page. Remove a row to stop offering that method.</p>
      <form data-form="methods"><div id="methodRows">${methods.map(methodRow).join('')}</div>
        <p class="msg" data-msg hidden></p>
        <div class="btn-row"><button type="button" class="sm secondary" data-act="add-method">＋ Add a method</button><button type="submit" class="sm">Save</button></div></form></div>`;
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
        : `<span class="pill ${p.status === 'confirmed' ? 'ok' : 'dim'}">${p.status}</span>`}</td></tr>`;
  }

  function visible() {
    const q = filter.q.trim().toLowerCase().replace(/^@/, '');
    return payments.filter((p) => !q || [p.handle, p.reference, p.payerName].some((v) => (v || '').toLowerCase().includes(q)));
  }

  function draw() {
    const list = visible();
    root.innerHTML = `<h1 style="margin:18px 0 10px">Payments</h1>${methodsCard()}
      <div class="card"><div class="formgrid" style="margin-bottom:10px">
        <div><label>Show</label><select data-filter="status">${[['pending', 'Waiting for me'], ['confirmed', 'Verified'], ['rejected', 'Rejected'], ['all', 'Everything']].map(([v, l]) => `<option value="${v}" ${filter.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label>Search handle, reference or payer name</label><input data-filter="q" value="${esc(filter.q)}"></div></div>
      <div class="scroll"><table class="grid"><thead><tr><th>Sent</th><th>Person</th><th>For</th><th>Amount</th><th>Method</th><th>Reference / payer</th><th>Extra</th><th></th></tr></thead><tbody>
      ${list.length ? list.map(paymentRow).join('') : `<tr><td colspan="8" class="muted">${filter.status === 'pending' ? 'Nothing waiting — all caught up.' : 'No payments match.'}</td></tr>`}</tbody></table></div></div>
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
    if (e.target.dataset.filter === 'q') { filter.q = e.target.value; const pos = e.target.selectionStart; draw(); const q = $('[data-filter="q"]', root); q.focus(); q.setSelectionRange?.(pos, pos); }
  }

  GOM.registerTab({
    id: 'payments', label: 'Payments',
    badgeCount: async () => ((await api('GET', '/api/admin/payments?status=pending')).json?.payments || []).length,
    async render(el) { await render(el); el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = onChange; el.oninput = onInput; },
  });
})();
