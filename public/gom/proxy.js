// Proxy tab: a log of what you owe (or have paid) your proxies, so nothing is paid twice and nothing slips past its date.
(function () {
  const { esc, money, fmtDate, api, errText, $, $$ } = GOM;
  let root = null, cands = [], pays = [], names = [], proxyList = [], selected = new Set(), search = '';
  const val = (id) => ($(`#${id}`, root) || {}).value || '';

  async function render(el) {
    root = el;
    const [c, p, n] = await Promise.all([api('GET', '/api/admin/proxy/candidates'), api('GET', `/api/admin/proxy/payments${search ? `?q=${encodeURIComponent(search)}` : ''}`), api('GET', '/api/admin/proxy/names')]);
    cands = c.json?.candidates || []; pays = p.json?.payments || []; names = n.json?.names || []; proxyList = n.json?.proxies || [];
    selected = new Set([...selected].filter((k) => cands.some((x) => x.key === k)));
    draw();
  }

  function logCard() {
    return `<div class="card"><h2>Log a proxy payment</h2>
      <p class="sub">Tick the sets and items this payment covers. Each can only be logged once, so nothing gets paid for twice. (Set the proxy and pay-by date for an order or item in Group Orders.)</p>
      <div class="scroll"><table class="grid"><thead><tr><th></th><th>What</th><th>Proxy</th><th>Pay by</th></tr></thead><tbody>
      ${cands.length ? cands.map((c) => `<tr data-cand="${esc(c.key)}"><td><input type="checkbox" data-act="pick" data-key="${esc(c.key)}" ${selected.has(c.key) ? 'checked' : ''}></td><td>${esc(c.label)}</td>
        <td>${c.proxy ? esc(c.proxy) : '<span class="sub">not set</span>'}</td><td>${c.deadline ? fmtDate(c.deadline) : '<span class="sub">—</span>'}</td></tr>`).join('')
        : '<tr><td colspan="4" class="muted">No secured sets or items waiting to be paid for right now.</td></tr>'}</tbody></table></div>
      <div class="formgrid" style="margin-top:12px">
        <div><label for="pxName">Proxy</label><input id="pxName" list="pxNames" maxlength="80" autocomplete="off"><datalist id="pxNames">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></div>
        <div><label for="pxDeadline">Pay by</label><input id="pxDeadline" type="date"></div>
        <div class="span2"><label for="pxSummary">Summary</label><div class="btn-row" style="margin:0"><input id="pxSummary" maxlength="255" style="flex:1" placeholder="e.g. Run It photobooks — 3 OT8 sets + 2 other items"><button type="button" class="sm secondary" data-act="suggest">Suggest</button></div></div>
        <div class="span2"><label class="chk"><input type="checkbox" id="pxPaid"> Already paid</label></div></div>
      <div class="btn-row"><button data-act="save">Save</button><span class="msg" id="pxMsg" hidden></span></div></div>`;
  }

  function payCard(p) {
    return `<div class="card" data-pay="${p.id}" style="background:var(--paper)"><div class="row"><div><strong>${esc(p.proxy)}</strong> — ${esc(p.summary || '')}
        ${p.overdue ? ` <span class="pill warn">${p.daysOverdue} day${p.daysOverdue === 1 ? '' : 's'} overdue</span>` : ''}
        <div class="sub">${p.deadline ? `Due ${fmtDate(p.deadline)}` : 'No pay-by date'}</div>
        <div class="sub" style="margin-top:4px">${p.items.map((i) => esc(i.label)).join(' · ')}</div></div>
      <div class="btn-row" style="margin:0; align-items:center"><label class="chk"><input type="checkbox" data-act="paid" data-id="${p.id}" ${p.paid ? 'checked' : ''}> Paid</label><button class="sm secondary" data-act="remove" data-id="${p.id}">Remove</button></div></div></div>`;
  }

  function listCard() {
    const active = pays.filter((p) => !p.paid), done = pays.filter((p) => p.paid);
    return `<div class="card"><div class="row"><h2 style="margin:0">Proxy payments</h2><input id="pxSearch" placeholder="Search proxy, summary or item" value="${esc(search)}" style="max-width:260px"></div>
      <div style="margin-top:10px">${!pays.length ? `<p class="muted">${search ? 'No matches for that search.' : 'No proxy payments logged yet.'}</p>` : active.length ? active.map(payCard).join('') : '<p class="muted">Nothing outstanding.</p>'}</div>
      ${done.length ? `<details style="margin-top:10px"><summary>Paid (${done.length})</summary>${done.map(payCard).join('')}</details>` : ''}</div>`;
  }

  // Which of the proxies is you? Orders using that proxy have nothing to pay and are left out of the lists below.
  const meCard = () => proxyList.length ? `<div class="card" id="proxyMe"><h2>Your proxies</h2><p class="sub" style="margin-top:0">Tick any proxy that is <strong>you</strong>. Orders that use it won't appear in "to pay a proxy".</p>
    ${proxyList.map((x) => `<label class="chk" style="display:flex; margin:6px 0"><input type="checkbox" data-proxy-self="${x.id}" ${x.isSelf ? 'checked' : ''}> ${esc(x.name)} — this is me</label>`).join('')}</div>` : '';
  function draw() {
    const keep = { name: val('pxName'), deadline: val('pxDeadline'), summary: val('pxSummary'), paid: ($('#pxPaid', root) || {}).checked };
    root.innerHTML = `<h1 style="margin:18px 0 10px">Proxy</h1>${meCard()}${logCard()}${listCard()}`;
    $('#pxName', root).value = keep.name; $('#pxDeadline', root).value = keep.deadline; $('#pxSummary', root).value = keep.summary; $('#pxPaid', root).checked = !!keep.paid;
  }
  const msg = (t, ok) => { const m = $('#pxMsg', root); m.textContent = t; m.className = `msg${ok ? ' ok' : ''}`; m.hidden = false; };

  async function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'suggest') {
      const rows = cands.filter((c) => selected.has(c.key));
      if (!rows.length) return GOM.alert('Tick which sets/items this payment covers first.');
      const parts = rows.filter((c) => c.kind === 'set').map((c) => `${c.title} — ${c.count} OT${c.roster} set${c.count === 1 ? '' : 's'}`);
      const others = rows.filter((c) => c.kind !== 'set').length;
      if (others) parts.push(`${others} other item${others === 1 ? '' : 's'}`);
      $('#pxSummary', root).value = parts.join(' + ');
    }
    if (act === 'save') {
      const r = await api('POST', '/api/admin/proxy/payments', { proxy: val('pxName'), deadline: val('pxDeadline') || null, summary: val('pxSummary'), keys: [...selected], paid: !!$('#pxPaid', root).checked });
      if (!r.ok) return msg(errText(r));
      const proxy = val('pxName'), deadline = val('pxDeadline');
      selected.clear(); ['pxName', 'pxDeadline', 'pxSummary'].forEach((i) => { $(`#${i}`, root).value = ''; }); $('#pxPaid', root).checked = false;
      await render(root); GOM.refreshBadges();
      msg(`Saved — ${proxy}${deadline ? `, due ${fmtDate(deadline)}` : ''}.`, true);
    }
    if (act === 'remove') {
      const p = pays.find((x) => x.id === Number(b.dataset.id));
      const ok = await GOM.confirm(`Remove this proxy payment?\n\n${p.proxy} — ${p.summary || ''}\n\nThe sets and items it covers become available to log again. Use this for a payment you logged by mistake.`, { ok: 'Remove it', cancel: 'Keep it' });
      if (!ok) return;
      const r = await api('DELETE', `/api/admin/proxy/payments/${p.id}`); await render(root); GOM.refreshBadges();
      GOM.toast(r.ok ? 'Removed.' : errText(r), !r.ok);
    }
  }

  async function onChange(e) {
    if (e.target.dataset.proxySelf) {
      const r = await api('PATCH', `/api/admin/proxies/${e.target.dataset.proxySelf}`, { isSelf: e.target.checked });
      if (!r.ok) { e.target.checked = !e.target.checked; return GOM.toast(errText(r), true); }
      await render(root); return GOM.toast(e.target.checked ? 'Marked as you — its orders are left out.' : 'No longer marked as you.');
    }
    const t = e.target;
    if (t.dataset.act === 'pick') {
      t.checked ? selected.add(t.dataset.key) : selected.delete(t.dataset.key);
      const rows = cands.filter((c) => selected.has(c.key));
      const proxies = [...new Set(rows.map((c) => c.proxy).filter(Boolean))];
      if (rows.length && proxies.length === 1) $('#pxName', root).value = proxies[0];            // everything ticked shares a proxy: fill it in
      const dates = rows.map((c) => c.deadline).filter(Boolean).sort();
      if (dates.length) $('#pxDeadline', root).value = dates[0];                                  // the earliest pay-by, so nothing slips past its own date
    }
    if (t.dataset.act === 'paid') {
      const r = await api('PATCH', `/api/admin/proxy/payments/${t.dataset.id}`, { paid: t.checked });
      await render(root); GOM.refreshBadges(); if (!r.ok) GOM.toast(errText(r), true);
    }
  }
  const onInput = (e) => {
    if (e.target.id !== 'pxSearch') return;
    search = e.target.value.trim(); clearTimeout(onInput.t);
    onInput.t = setTimeout(async () => { const pos = e.target.selectionStart; const r = await api('GET', `/api/admin/proxy/payments?q=${encodeURIComponent(search)}`); pays = r.json?.payments || []; draw(); const s = $('#pxSearch', root); s.focus(); s.setSelectionRange(pos, pos); }, 120);
  };

  GOM.registerTab({
    id: 'proxy', label: 'Proxy',
    badgeCount: async () => ((await api('GET', '/api/admin/proxy/payments')).json?.payments || []).filter((p) => !p.paid).length,
    async render(el) { await render(el); el.onclick = onClick; el.onchange = onChange; el.oninput = onInput; },
  });
})();
