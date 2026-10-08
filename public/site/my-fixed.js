// Fixed claims: a regular's standing claim on one member. They can give it up or swap it for the full set themselves — instantly
// while that set isn't secured; once it is, it becomes a request for the GOM to approve.
(function () {
  const { esc, money, fmtDateTime, $, errText } = SITE;
  const STATUS = { pending: 'waiting for the GOM', approved: 'approved', declined: 'declined', withdrawn: 'withdrawn', void: 'no longer needed' };
  const fullText = (f) => (f.wholeSetPrice == null ? 'the whole set (its price is still TBC)' : f.mixed ? `the whole set = ${money(f.wholeSetPrice)}` : `${f.partCount} × ${money(f.price)} = ${money(f.wholeSetPrice)}`);

  function describe(res, f) {
    const bits = [];
    if (res.action === 'ot8') bits.push(`You now hold ${f.mixed ? 'the full set' : 'a full OT8'} in Set ${res.setNumber} — ${fullText(f)}, owed once the set is secured.`);
    else bits.push("You're no longer claiming anything on this item.");
    if (res.slotOpened) bits.push(`Your fixed ${f.member} slot is now open to other joiners.`);
    if (res.refunded > 0) bits.push(`The ${money(res.refunded)} you'd already paid is now credit on your account.`);
    return bits.join(' ');
  }

  SITE.views.fixed = async (view) => {
    const S = SITE.my;
    const { fixed, requests } = S.fixed;
    let last = '';
    const cards = fixed.map((f) => {
      const heading = f.orderTitle !== last ? `<div style="font-weight:600; margin-top:18px">${esc(f.orderTitle)}</div>` : ''; last = f.orderTitle;
      const secured = f.setDecision === 'secured';
      return `${heading}<div class="card" style="margin-top:8px" data-fixed="${f.id}"><div class="row"><div><strong>${esc(f.itemTitle)}</strong>
        <div style="margin-top:4px">🔒 Your fixed claim: <strong>${esc(f.member)}</strong> · ${f.price == null ? 'Price TBC' : money(f.price)} <span class="sub">· Set ${f.setNumber}</span></div></div>
        <span class="pill ${secured ? 'ok' : 'warn'}">${secured ? 'Set secured' : 'Not secured yet'}</span></div>
        ${f.pending
          ? `<div class="msg" style="margin-top:12px">Request sent — ${f.pending.action === 'ot8' ? 'swap to the full set' : 'give up this claim'}. Waiting for the GOM to approve it.</div><button class="secondary" data-act="withdraw" data-req="${f.pending.id}" style="margin-top:8px">Withdraw request</button>`
          : `<p class="sub" style="margin:10px 0 8px">${f.canChangeNow ? 'You can change this straight away.' : 'This set is already secured, so the GOM needs to approve a change.'}</p>
             <div class="btn-row" style="margin-top:0"><button data-act="ot8" data-id="${f.id}">Swap to the full set</button><button class="secondary" data-act="giveup" data-id="${f.id}">Give it up</button></div>`}</div>`;
    }).join('');
    view.innerHTML = `${S.crumb}<h1 style="margin:4px 0 6px">Fixed claims</h1>
      <p class="muted">Your standing claims on specific members. You can give one up, or swap it for the full set.</p>
      ${cards || '<div class="card"><p class="muted">You have no fixed claims right now.</p></div>'}
      ${requests.length ? `<div class="card" style="margin-top:18px"><h2>Your requests</h2>${requests.map((r) => `<div class="itemrow"><div class="grow">${r.action === 'ot8' ? 'Swap to the full set' : 'Give it up'} <span class="sub">${esc(r.itemTitle)} · ${esc(r.member)} · Set ${r.setNumber} · ${fmtDateTime(r.createdAt)}</span></div><span class="pill ${r.status === 'approved' ? 'ok' : r.status === 'pending' ? 'warn' : ''}">${STATUS[r.status]}</span></div>`).join('')}</div>` : ''}`;

    view.onclick = async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'withdraw') {
        const r = await S.api('POST', `/api/my/fixed/requests/${b.dataset.req}/withdraw`, {});
        if (!r.ok) return SITE.toast(errText(r), true);
        await S.reload(); await SITE.views.fixed(view); return SITE.toast('Request withdrawn.');
      }
      if (!['ot8', 'giveup'].includes(b.dataset.act)) return;
      const f = fixed.find((x) => x.id === Number(b.dataset.id)), action = b.dataset.act;
      const ok = await SITE.confirm(action === 'ot8'
        ? `Swap to the ${f.mixed ? 'full set' : 'full OT8'} on "${f.itemTitle}"?\n\nYou'd take ${f.mixed ? 'every part' : 'one of each member'} in the same set: ${fullText(f)}, instead of ${f.price == null ? `your fixed ${f.member} (price TBC)` : `${money(f.price)} for ${f.member}`}. Your fixed ${f.member} claim is replaced by the full set.${f.canChangeNow ? '' : '\n\nThis set is already secured, so this sends a request to the GOM.'}`
        : `Give up your fixed ${f.member} on "${f.itemTitle}"?\n\nYou'll no longer be claiming anything on this item, and the ${f.member} slot opens up for others.${f.canChangeNow ? '' : '\n\nThis set is already secured, so this sends a request to the GOM.'}`,
      { ok: action === 'ot8' ? 'Swap to the full set' : 'Give it up', cancel: 'Keep it' });
      if (!ok) return;
      const r = await S.api('POST', `/api/my/fixed/${f.id}/change`, { action });
      if (!r.ok) return SITE.toast(errText(r), true);
      await S.reload(); await SITE.views.fixed(view);
      view.insertAdjacentHTML('afterbegin', `<div class="msg ok" data-result>${r.json.instant ? esc(describe(r.json, f)) : 'Request sent — the GOM will approve or decline it. You can withdraw it any time before then.'}</div>`);
    };
  };
})();
