// Make a payment: say how much you sent, how, and how to match it. The GOM verifies it; nothing is counted until then.
(function () {
  const { esc, money, fmtDateTime, $, $$, api, errText } = SITE;
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  SITE.views.pay = async (view) => {
    const S = SITE.my;
    const [m, h] = await Promise.all([api('GET', '/api/payment-methods'), S.api('GET', '/api/my/payments')]);
    const methods = m.json?.methods || [], history = h.json?.payments || [];
    const owedTotal = S.summary.owed.total, addrName = S.address?.fullName || '';
    const scopes = S.summary.orders.filter((o) => o.id && o.owed > 0);

    const statusPill = (p) => p.status === 'confirmed' ? '<span class="pill ok">received ✓</span>' : p.status === 'rejected' ? '<span class="pill warn">not received — please check with the GOM</span>' : '<span class="pill">waiting for the GOM to check</span>';
    view.innerHTML = `${S.crumb}<h1 style="margin:4px 0 10px">Make a payment</h1>
      <div class="card"><h2>Where to send it</h2>${methods.length ? methods.map((x) => `<span class="pill">${esc(x.method)}: ${esc(x.accountInfo)}</span>`).join(' ') : '<p class="muted">The GOM hasn\'t added payment details yet — message them to ask where to send it.</p>'}
        <p class="sub">Send the payment - make sure there are no notes in the transfer reference, then confirm it below. Storm checks it against their account and marks it received. No need for screenshots!</p></div>
      ${owedTotal > 0 ? `<form class="card" data-form="pay"><h2>I've sent a payment</h2><div class="formgrid">
        <div><label>Which order is this for?</label><select name="scope"><option value="">All outstanding — combined (${money(owedTotal)})</option>${scopes.map((o) => `<option value="${o.id}">${esc(o.title)} (${money(o.owed)})</option>`).join('')}</select></div>
        <div><label>Method</label>${methods.length ? `<select name="method"><option value="">Select method…</option>${methods.map((x) => `<option>${esc(x.method)}</option>`).join('')}</select>` : '<input name="method" placeholder="e.g. PayPal" maxlength="40">'}</div>
        <div><label>Amount paid (£)</label><input name="amount" type="number" step="0.01" min="0.01" value="${owedTotal}"></div>
        <div><label>Transaction ID / payer's name</label><input name="reference" maxlength="255" placeholder="PayPal: transaction ID · bank transfer / Wise: the name it was sent under"><div class="sub">${addrName ? 'Optional if you paid under your delivery name.' : 'We need something to match it by.'}</div></div></div>
        ${addrName ? `<div style="margin-top:10px"><label>Whose name was the payment made under?</label>
          <label class="chk"><input type="radio" name="payerChoice" value="address" checked> My delivery name (${esc(addrName)})</label>
          <label class="chk"><input type="radio" name="payerChoice" value="other"> A different name</label>
          <input name="payerName" placeholder="The name on the payment" maxlength="120" hidden></div>` : ''}
        <div class="card" data-overpay hidden style="background:var(--paper); border-style:dashed; margin-top:12px"><strong data-overpay-head></strong><p style="margin:6px 0 10px">It's your call what happens to the extra:</p>
          <label class="chk"><input type="radio" name="overpayChoice" value="credit"> Keep it as credit toward my next costs</label>
          <label class="chk"><input type="radio" name="overpayChoice" value="tip"> It's a tip for you 💌</label>
          <label style="margin-top:8px">Note (optional)</label><input name="overpayNote" maxlength="255" placeholder="e.g. paying ahead for postage"></div>
        <p class="msg" data-msg hidden></p><button type="submit">Send payment details</button></form>`
        : '<div class="card"><p>Nothing owing right now — you\'re all paid up. 🎉</p></div>'}
      <div class="card"><h2>Your payments</h2>${history.length ? history.map((p) => `<div class="itemrow"><div class="grow"><strong>${money(p.amount)}</strong> · ${esc(p.method)} <span class="sub">${fmtDateTime(p.createdAt)} · ${esc(p.orderTitle || 'All outstanding')}${p.reference ? ` · ${esc(p.reference)}` : ''}</span></div>${statusPill(p)}</div>`).join('') : '<p class="muted">No payments yet.</p>'}</div>`;

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
      if (e.target.name === 'scope') { form.elements.amount.value = scopeOwed(); syncOverpay(); }
      if (e.target.name === 'payerChoice') form.elements.payerName.hidden = form.elements.payerChoice.value !== 'other';
    };
    view.oninput = (e) => { if (e.target.name === 'amount') syncOverpay(); };
    view.onsubmit = async (e) => {
      if (e.target.dataset.form !== 'pay') return;
      e.preventDefault();
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
      } else if (!ref) return say('Add the name the payment was sent under or the transaction ID, so it can be matched.');
      const extra = r2(amount - scopeOwed());
      if (extra > 0.004) {
        const choice = f.overpayChoice.value;
        if (!choice) return say(`You're paying ${money(extra)} more than you owe — choose whether that's credit for next time or a tip.`);
        body.overpay = { choice, ...(f.overpayNote.value.trim() ? { note: f.overpayNote.value.trim() } : {}) };
      }
      const r = await S.api('POST', '/api/my/payments', body);
      if (!r.ok) return say(errText(r));
      await SITE.views.pay(view);
      view.insertAdjacentHTML('afterbegin', `<div class="msg ok" data-sent>Thanks! Your ${money(amount)} payment is with Storm to check — it'll count once they've marked it received.</div>`);
    };
  };
})();
