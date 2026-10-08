// Overdue tab: who still owes money past their pay-by date, and items that have sat on hand past their keep-until date.
(function () {
  const { esc, money, fmtDate, api, errText, $, $$ } = GOM;
  let root = null, data = { payments: [], storage: [], proxy: [], totals: {} };

  async function render(el) {
    root = el;
    const r = await api('GET', '/api/admin/overdue');
    data = r.json || data;
    draw();
  }

  const late = (n) => `<strong style="color:var(--accent)">${n} day${n === 1 ? '' : 's'} overdue</strong>`;

  function paymentsCard() {
    const byPerson = new Map();
    data.payments.forEach((r) => { if (!byPerson.has(r.handle)) byPerson.set(r.handle, []); byPerson.get(r.handle).push(r); });
    return `<div class="card"><h2>Overdue payments</h2>
      <p class="sub">Claims still owing after their pay-by date (the item's own date if it has one, otherwise its group order's). A date lives all day, so something due today isn't overdue until tomorrow.</p>
      ${byPerson.size ? [...byPerson.entries()].map(([handle, rows]) => `<div style="border-top:1px solid var(--line); margin-top:10px; padding-top:8px" data-person="${esc(handle)}">
        <div class="row"><strong>@${esc(handle)}</strong><span>owes <strong>${money(rows.reduce((t, r) => t + r.owed, 0))}</strong> overdue · ${rows.length} item${rows.length === 1 ? '' : 's'}</span></div>
        ${rows.map((r) => `<div class="itemrow" data-claim="${r.claimId}"><div class="grow">${esc(r.label)} <span class="sub">${esc(r.orderTitle)}</span>
          <div class="sub">Owed ${money(r.owed)} · was due ${fmtDate(r.due)}${r.ownDate ? " (this item's own date)" : ''}${r.remindedAt ? ` · reminder emailed ${fmtDate(r.remindedAt)}` : ''}</div></div><div>${late(r.daysOverdue)}</div></div>`).join('')}</div>`).join('')
        : '<p class="muted">Nothing overdue right now.</p>'}</div>`;
  }

  function storageCard() {
    return `<div class="card"><h2>Overdue storage</h2>
      <p class="sub">Items sitting ready to pack past their keep-until date. Small items (XS and S) are kept 60 days, bigger ones (M, L, XL) 30 days, counted from when they became ready to pack — unless you've set a date by hand, which always wins. The clock stops once an item is packed.</p>
      ${data.storage.length ? data.storage.map((r) => `<div class="itemrow" data-claim="${r.claimId}"><div class="grow"><strong>@${esc(r.handle)}</strong> · ${esc(r.label)} <span class="sub">${esc(r.orderTitle)}</span>
          <div class="sub">${r.readyDate ? `On hand since ${fmtDate(r.readyDate)} · ` : ''}size ${esc(r.size)} · deadline was ${fmtDate(r.deadline)}${r.overridden ? ' (set by you)' : ''}</div>
          <form data-form="extend" data-id="${r.claimId}" class="btn-row" style="margin-top:6px; align-items:end"><div><label style="font-size:.75rem">Keep until</label><input type="date" name="date" style="max-width:170px"></div>
            <button type="submit" class="sm">Extend</button>${r.overridden ? `<button type="button" class="sm secondary" data-act="clear" data-id="${r.claimId}">Back to the normal rule</button>` : ''}<span class="msg" data-msg hidden></span></form></div>
          <div>${late(r.daysOverdue)}</div></div>`).join('') : '<p class="muted">Nothing overdue right now.</p>'}</div>`;
  }

  function proxyCard() {
    return `<div class="card"><h2>Overdue proxy payments</h2>
      <p class="sub">Payments you've logged for your proxies that aren't ticked as paid and are past their pay-by date.</p>
      ${data.proxy.length ? data.proxy.map((r) => `<div class="itemrow" data-proxy="${r.id}"><div class="grow"><strong>${esc(r.proxy)}</strong> — ${esc(r.summary || '')}<div class="sub">Due ${fmtDate(r.deadline)}</div></div><div>${late(r.daysOverdue)}</div></div>`).join('') : '<p class="muted">Nothing overdue right now.</p>'}</div>`;
  }

  function draw() {
    const t = data.totals || {};
    const clear = !data.payments.length && !data.storage.length && !data.proxy.length;
    root.innerHTML = `<h1 style="margin:18px 0 10px">Overdue</h1>
      <div class="card" ${clear ? 'style="background:#E5F0EC"' : ''}><p style="margin:0">${clear ? 'All clear — nothing is overdue right now. 🎉'
        : `<strong>${money(t.paymentsOwed)}</strong> overdue across <strong>${t.people}</strong> ${t.people === 1 ? 'person' : 'people'} · <strong>${t.storageItems}</strong> item${t.storageItems === 1 ? '' : 's'} past their storage deadline${t.proxyPayments ? ` · <strong>${t.proxyPayments}</strong> unpaid proxy payment${t.proxyPayments === 1 ? '' : 's'} past their date` : ''}`}</p></div>
      ${paymentsCard()}${storageCard()}${proxyCard()}`;
  }

  async function onSubmit(e) {
    const form = e.target; if (form.dataset.form !== 'extend') return;
    e.preventDefault();
    const m = $('[data-msg]', form), date = form.elements.date.value;
    if (!date) { m.textContent = 'Pick the date to keep it until.'; m.className = 'msg'; m.hidden = false; return; }
    const r = await api('PATCH', `/api/admin/claims/${form.dataset.id}`, { storageDeadlineOverride: date });
    if (!r.ok) { m.textContent = errText(r); m.className = 'msg'; m.hidden = false; return; }
    await render(root); GOM.refreshBadges(); GOM.toast(`Keeping it until ${fmtDate(date)}.`);
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act="clear"]'); if (!b) return;
    const r = await api('PATCH', `/api/admin/claims/${b.dataset.id}`, { storageDeadlineOverride: null });
    await render(root); GOM.refreshBadges();
    GOM.toast(r.ok ? 'Back to the normal storage rule.' : errText(r), !r.ok);
  }

  GOM.registerTab({
    id: 'overdue', label: 'Overdue',
    badgeCount: async () => { const t = (await api('GET', '/api/admin/overdue')).json; return t ? t.payments.length + t.storage.length + (t.proxy || []).length : 0; },
    async render(el) { await render(el); el.onclick = onClick; el.onsubmit = onSubmit; },
  });
})();
