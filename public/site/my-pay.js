// Make a payment: say how much you sent, how, and how to match it. The GOM verifies it; nothing is counted until then.
(function () {
  const { esc, money, fmtDateTime, $, $$, api, errText } = SITE;
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  // opts.sent = a payment was JUST sent (show a clear confirmation instead of the form); opts.again = they chose to send another one anyway
  SITE.views.pay = async (view, opts = {}) => {
    const S = SITE.my;
    const [m, h] = await Promise.all([api('GET', '/api/payment-methods'), S.api('GET', '/api/my/payments')]);
    const methods = m.json?.methods || [], history = h.json?.payments || [];
    const owedTotal = S.summary.owed.total, addrName = S.address?.fullName || '';
    const scopes = S.summary.orders.filter((o) => o.id && o.owed > 0);
    // Payments already sent and waiting for the GOM to check count towards what they owe — so the form never asks for the same money twice
    const waiting = history.filter((p) => p.status === 'pending'), waitingTotal = r2(waiting.reduce((n, p) => n + Number(p.amount), 0));
    const waitingFor = (orderId) => (orderId ? r2(waiting.filter((p) => p.orderId === orderId).reduce((n, p) => n + Number(p.amount), 0)) : waitingTotal);
    const stillToCover = (orderId) => Math.max(0, r2(S.owedFor(orderId) - waitingFor(orderId)));
    const defaultAmount = stillToCover(null) > 0.004 ? stillToCover(null) : owedTotal;
    const allCovered = owedTotal > 0 && waitingTotal > 0 && stillToCover(null) <= 0.004 && !opts.again;
    const showForm = owedTotal > 0 && !opts.sent && !allCovered;
    const sentHtml = opts.sent ? `<div class="card" data-sent role="status" tabindex="-1" style="border:2px solid var(--ok-line); background:var(--ok-bg); color:var(--ok-ink)"><h2 style="margin:0 0 6px; color:inherit">✓ Payment details sent</h2>
        <p style="margin:0 0 6px; color:inherit">${opts.sent.duplicate ? `You'd already sent this one — it's with the GOM to check, and nothing was recorded twice.` : `Thanks! Your ${money(opts.sent.amount)} payment is with the GOM to check — it'll count once they've marked it received.`}${opts.sent.split}</p>
        <p class="sub" style="margin:0 0 8px; color:inherit">You don't need to do anything else, and please don't send it again — it's listed under <em>Your payments</em> below.</p>
        <button type="button" class="sm secondary" data-act="pay-again">I'm sending a different payment</button></div>` : '';
    const waitingHtml = !opts.sent && waitingTotal > 0 ? `<div class="card" data-waiting style="border:2px solid var(--warn-line); background:var(--warn-bg); color:var(--warn-ink)"><strong style="color:inherit">You've already sent ${money(waitingTotal)} — it's waiting for the GOM to check.</strong>
        <div style="color:inherit">${allCovered ? 'That covers what you owe, so there is nothing more to send.' : `Only ${money(stillToCover(null))} is still to cover — the amount below is filled in for you.`}</div>
        ${allCovered ? '<div style="margin-top:8px"><button type="button" class="sm secondary" data-act="pay-again">I\'m sending a different payment</button></div>' : ''}</div>` : '';

    const statusPill = (p) => p.status === 'confirmed' ? '<span class="pill ok">received ✓</span>' : p.status === 'reversed' ? '<span class="pill err" data-failed>the payment failed after it was received — it is owed again, please check with the GOM</span>' : p.status === 'rejected' ? '<span class="pill warn">not received — please check with the GOM</span>' : '<span class="pill">waiting for the GOM to check</span>';
    view.innerHTML = `${S.crumb}<h1 style="margin:4px 0 10px">Make a payment</h1>
      <div class="card"><h2>Where to send it</h2>${methods.length ? methods.map((x) => `<span class="pill">${esc(x.method)}: ${esc(x.accountInfo)}</span>`).join(' ') : '<p class="muted">The GOM hasn\'t added payment details yet — message them to ask where to send it.</p>'}
        <p class="sub">Send the payment, then tell us about it below. The GOM checks it against their account and marks it received.</p></div>
      ${sentHtml}${waitingHtml}
      ${showForm ? `<form class="card" data-form="pay"><h2>I've sent a payment</h2><div class="formgrid">
        <div><label>Which order is this for?</label><select name="scope"><option value="">All outstanding — combined (${money(owedTotal)})</option>${scopes.map((o) => `<option value="${o.id}">${esc(o.title)} (${money(o.owed)})</option>`).join('')}</select></div>
        <div><label>Method</label>${methods.length ? `<select name="method"><option value="">Select method…</option>${methods.map((x) => `<option>${esc(x.method)}</option>`).join('')}</select>` : '<input name="method" placeholder="e.g. PayPal" maxlength="40">'}</div>
        <div><label>Amount paid (£)</label><input name="amount" type="number" step="0.01" min="0.01" value="${defaultAmount}"></div>
        <div><label>Transaction ID / payer's name</label><input name="reference" maxlength="255" placeholder="PayPal: transaction ID · bank transfer / Wise: the name it was sent under"><div class="sub">${addrName ? 'Optional if you paid under your delivery name.' : 'We need something to match it by.'}</div></div></div>
        ${addrName ? `<div style="margin-top:10px"><label>Whose name was the payment made under?</label>
          <label class="chk"><input type="radio" name="payerChoice" value="address" checked> My delivery name (${esc(addrName)})</label>
          <label class="chk"><input type="radio" name="payerChoice" value="other"> A different name</label>
          <input name="payerName" placeholder="The name on the payment" maxlength="120" hidden></div>` : ''}
        <div class="card" data-overpay hidden style="background:var(--paper); border-style:dashed; margin-top:12px"><strong data-overpay-head></strong><p style="margin:6px 0 10px">It's your call what happens to the extra:</p>
          <label class="chk"><input type="radio" name="overpayChoice" value="credit"> Keep it as credit toward my next costs</label>
          <label class="chk"><input type="radio" name="overpayChoice" value="tip"> It's a tip for my GOM 💌</label>
          <label style="margin-top:8px">Note (optional)</label><input name="overpayNote" maxlength="255" placeholder="e.g. paying ahead for postage"></div>
        <p class="msg" data-msg hidden></p><button type="submit">Send payment details</button></form>`
        : owedTotal > 0 ? '' : '<div class="card"><p>Nothing owing right now — you\'re all paid up. 🎉</p></div>'}
      <div class="card"><h2>Your payments</h2>${history.length ? history.map((p) => `<div class="itemrow"><div class="grow"><strong>${money(p.amount)}</strong> · ${esc(p.method)} <span class="sub">${fmtDateTime(p.createdAt)} · ${esc(p.orderTitle || 'All outstanding')}${p.reference ? ` · ${esc(p.reference)}` : ''}</span>${S.tag(p.handle)}</div>${statusPill(p)}</div>`).join('') : '<p class="muted">No payments yet.</p>'}</div>`;

    view.onclick = (e) => { if (e.target.closest('[data-act="pay-again"]')) SITE.views.pay(view, { again: true }); };
    if (opts.sent) { const card = $('[data-sent]', view); card?.scrollIntoView?.({ block: 'center' }); card?.focus?.({ preventScroll: true }); }
    const form = $('form[data-form="pay"]', view);
    if (!form) return;
    const scopeOwed = () => S.owedFor(form.elements.scope.value ? Number(form.elements.scope.value) : null);
    const syncOverpay = () => {
      const extra = r2(Number(form.elements.amount.value) - scopeOwed());
      const box = $('[data-overpay]', form);
      box.hidden = !(extra > 0.004);
      if (!box.hidden) $('[data-overpay-head]', form).textContent = `You're paying ${money(extra)} more than you owe.`;
    };
    view.onchange = (e) => {
      if (e.target.name === 'scope') { const o = form.elements.scope.value ? Number(form.elements.scope.value) : null; form.elements.amount.value = stillToCover(o) > 0.004 ? stillToCover(o) : scopeOwed(); syncOverpay(); }
      if (e.target.name === 'payerChoice') form.elements.payerName.hidden = form.elements.payerChoice.value !== 'other';
    };
    view.oninput = (e) => { if (e.target.name === 'amount') syncOverpay(); };
    view.onsubmit = async (e) => {
      if (e.target.dataset.form !== 'pay') return;
      e.preventDefault();
      if (form.dataset.busy) return;                                                          // already sending: a second tap does nothing
      const f = form.elements, msg = $('[data-msg]', form), say = (t) => S.say(msg, t);
      const amount = Number(f.amount.value), method = f.method.value.trim(), ref = f.reference.value.trim();
      const orderId = f.scope.value ? Number(f.scope.value) : null;
      if (!(amount > 0)) return say('Enter the amount you paid.');
      if (!method) return say('Choose how you paid.');
      const body = { orderId, amount, method };
      if (ref) body.reference = ref;
      if (addrName) {
        body.payerChoice = f.payerChoice.value;
        if (body.payerChoice === 'other') {
          const nm = f.payerName.value.trim();
          if (!nm) return say('Type the name the payment was made under.');
          body.payerName = nm;
        }
      } else if (!ref) return say('Add a transaction ID or the name the payment was sent under, so it can be matched.');
      const extra = r2(amount - scopeOwed());
      if (extra > 0.004) {
        const choice = f.overpayChoice.value;
        if (!choice) return say(`You're paying ${money(extra)} more than you owe — choose whether that's credit for next time or a tip.`);
        body.overpay = { choice, ...(f.overpayNote.value.trim() ? { note: f.overpayNote.value.trim() } : {}) };
      }
      const btn = $('button[type="submit"]', form); form.dataset.busy = '1'; btn.disabled = true; btn.textContent = 'Sending…';
      const r = await S.api('POST', '/api/my/payments', body);
      if (!r.ok) { delete form.dataset.busy; btn.disabled = false; btn.textContent = 'Send payment details'; return say(errText(r)); }
      const split = r.json.split && r.json.split.length > 1 ? ` It covers ${r.json.split.map((x) => `@${esc(x.handle)} ${money(x.amount)}`).join(' and ')} — one payment, so you only send it once.` : '';
      await SITE.views.pay(view, { sent: { amount, split, duplicate: !!r.json.duplicate } });
    };
  };
})();
