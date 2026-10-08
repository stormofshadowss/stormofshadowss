// Delivery details, requesting shipping, and following your parcels.
(function () {
  const { esc, money, fmtDate, $, errText } = SITE;
  const METHODS = ['UK Royal Mail Tracked 48', 'UK Royal Mail Tracked 24', 'UK Inpost to Shop', 'UK Inpost to House', 'WW Tracked', 'WW Stamped'];

  // ── delivery details ──
  SITE.views.address = async (view) => {
    const S = SITE.my, a = S.address;
    view.innerHTML = `${S.crumb}<h1 style="margin:4px 0 10px">Delivery details</h1>
      <form class="card" data-form="address"><p class="sub">We only use these to post your orders. ${a?.confirmedAt ? `Last confirmed ${fmtDate(a.confirmedAt.slice(0, 10))}.` : ''}</p>
        <div class="formgrid"><div class="span2"><label>Full name</label><input name="fullName" value="${esc(a?.fullName || '')}" maxlength="120" autocomplete="name"></div>
        <div class="full"><label>Address (including postcode and country)</label><textarea name="address" rows="4" maxlength="600" autocomplete="street-address" style="width:100%; padding:10px 12px; border:1.5px solid var(--line); border-radius:8px; font:inherit">${esc(a?.address || '')}</textarea></div>
        <div><label>Email</label><input name="email" type="email" value="${esc(a?.email || S.me.account.email)}" maxlength="254" autocomplete="email"></div>
        <div><label>Phone number</label><input name="phone" type="tel" value="${esc(a?.phone || '')}" maxlength="40" autocomplete="tel"></div></div>
        <p class="msg" data-msg hidden></p><button type="submit">Save delivery details</button></form>`;
    view.onsubmit = async (e) => {
      if (e.target.dataset.form !== 'address') return;
      e.preventDefault();
      const f = e.target.elements, msg = $('[data-msg]', e.target);
      const r = await S.api('PUT', '/api/my/address', { fullName: f.fullName.value, address: f.address.value, email: f.email.value, phone: f.phone.value });
      if (!r.ok) return S.say(msg, errText(r));
      await S.reload();
      view.innerHTML = `${S.crumb}<div class="card"><h2>Saved ✓</h2><p>Your delivery details are up to date.</p><p><a class="pillbtn" href="#/ship">Request shipping</a> &nbsp; <a href="#/">Back to My orders</a></p></div>`;
    };
  };

  // ── request shipping + your parcels ──
  const STATUS = {
    requested: (p) => `In the queue — number ${p.queuePosition}`, packed: () => 'Packed', shipped: () => 'On its way',
    received: (p) => `Received ${fmtDate(p.receivedDate)}`,
  };
  // What this parcel looks like when it's shared with friends (one parcel, one address; fees split between everyone).
  const listNames = (hs) => { const t = hs.map((h) => `@${esc(h)}`); return t.length <= 1 ? t.join('') : `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}`; };
  const MAX_PEOPLE = 5;
  const splitWords = (p) => (p.feeSplit === 'weight' ? "split by the weight of each person's items" : 'split equally per person');
  const shareHtml = (p) => {
    const sh = p.shared; if (!sh) return '';
    const btn = (act, label, friend) => `<button class="sm secondary" data-act="${act}" data-id="${p.id}" ${friend ? `data-friend="${esc(friend)}"` : ''}>${label}</button>`;
    if (p.role === 'recipient') {
      const lines = sh.people.map((x) => x.status === 'invited' ? `<div class="sub" data-share="invited">⏳ Waiting for <strong>@${esc(x.handle)}</strong> to answer. ${btn('withdraw', 'Withdraw the invitation', x.handle)}</div>`
        : x.status === 'declined' ? `<div class="sub" data-share="declined">@${esc(x.handle)} said no. ${btn('withdraw', 'Clear this', x.handle)}</div>`
        : `<div class="sub" data-share="accepted">Shared with <strong>@${esc(x.handle)}</strong> ✓ — their items are in this parcel too.</div>`).join('');
      const taking = sh.people.filter((x) => x.status !== 'declined').length + 1;
      const waiting = sh.people.some((x) => x.status === 'invited');
      const more = p.status === 'requested' && taking < MAX_PEOPLE ? `<form data-form="invite" data-id="${p.id}" class="sub" style="margin-top:6px"><label style="display:inline">Ask another friend:</label> <input name="handles" maxlength="120" placeholder="@friend" style="max-width:220px" aria-label="Another friend's handle"> <button class="sm" type="submit">Invite</button> <span class="msg" data-msg hidden></span></form>` : '';
      return `${lines}${waiting ? '<div class="sub">This parcel can\'t be packed until everyone you asked has answered.</div>' : ''}${sh.active ? `<div class="sub" data-split-note>Posted to your address. Postage and packaging are ${splitWords(p)}.</div>` : ''}${more}`;
    }
    const others = sh.people.filter((x) => x.status !== 'recipient').map((x) => x.handle);
    return `<div class="sub" data-share="friend">Posted together with <strong>@${esc(sh.people[0].handle)}</strong>'s items${others.length ? ` (and ${listNames(others)}'s)` : ''} to @${esc(sh.people[0].handle)}'s address. @${esc(sh.people[0].handle)} will confirm when it arrives. Postage and packaging are ${splitWords(p)}. ${p.status === 'requested' ? btn('leave', 'Take my items out') : ''}</div>`;
  };
  const parcelsHtml = (S) => S.parcels.length ? `<div class="card"><h2>Your parcels</h2>${S.parcels.map((p) => {
    const active = p.shared?.active, mineItems = p.items.filter((i) => i.mine);
    const owners = [...new Set(p.items.filter((i) => !i.mine).map((i) => i.owner))];
    const feeBits = active ? [p.domsTotal != null && `Postage ${money(p.myDoms)}`, p.packagingTotal != null && `Packaging ${money(p.myPackaging)}`].filter(Boolean) : [p.domsTotal != null && `Postage ${money(p.domsTotal)}`, p.packagingTotal != null && `Packaging ${money(p.packagingTotal)}`].filter(Boolean);
    return `<div class="itemrow" data-parcel="${p.id}"><div class="grow">
      <strong>Parcel #${p.id}</strong> <span class="pill ${p.status === 'received' ? 'ok' : ''}">${STATUS[p.status](p)}</span>
      <div class="sub">${active ? `Your items: ${mineItems.map((i) => esc(i.label)).join(', ')}${owners.map((o) => ` · @${esc(o)}'s items: ${p.items.filter((i) => i.owner === o).map((i) => esc(i.label)).join(', ')}`).join('')}` : p.items.map((i) => esc(i.label)).join(', ')} · ${esc(p.method)}</div>
      ${feeBits.length ? `<div class="sub" data-fees>${active ? 'Your share — ' : ''}${feeBits.join(' · ')}${active ? ` <span class="muted">(${splitWords(p)})</span>` : ''}</div>` : ''}
      ${p.lomoName ? `<div class="sub">Personalised Lomo: ${esc(p.lomoName)}</div>` : ''}${shareHtml(p)}</div>
      ${p.status === 'shipped' && p.canConfirm ? `<button data-act="received" data-id="${p.id}">It's arrived${active ? ' — confirms it for everyone' : ' — mark as received'}</button>` : ''}</div>`;
  }).join('')}</div>` : '';

  // Invitations from a friend to share THEIR parcel: pick your own items, give your own bias / Lomo name, or say no.
  const invitesHtml = (S, ready, a) => {
    const here = S.invites.filter((i) => i.forHandle === S.handle), elsewhere = S.invites.filter((i) => i.forHandle !== S.handle);
    return here.map((i) => `<form class="card" data-form="accept" data-parcel="${i.parcelId}" style="border:2px solid var(--accent)"><h2>@${esc(i.fromHandle)} has asked to ship together with you</h2>
      <p>@${esc(i.fromHandle)} is posting a parcel to <strong>their own address</strong> and would like your items in the same box. It's one parcel, and the postage and packaging are shared out <strong>${/^ww\b/i.test(i.method) ? "by the weight of each person's items" : 'equally per person'}</strong>${/^ww\b/i.test(i.method) ? '' : ' (not by how many items each has)'} — there may be more than two of you. @${esc(i.fromHandle)} will confirm when it arrives. It's your choice — you can say no.</p>
      ${ready.length ? `<label>Which of your items should go in?</label>${ready.map((c) => `<label class="chk" style="margin:6px 0"><input type="checkbox" name="claim" value="${c.id}"> ${esc(c.label)} <span class="sub">${esc(c.orderTitle)}</span></label>`).join('')}
        <div class="formgrid" style="margin-top:10px"><div><label>Your bias (for your thank-you card 💌)</label><input name="bias" maxlength="80" placeholder="e.g. Felix"></div>
        <div><label>Personalised Lomo name</label><input name="lomoName" maxlength="80" placeholder="${a?.fullName ? `Leave blank to use ${esc(a.fullName.trim())}` : 'optional'}"></div></div>
        <label style="margin-top:10px">Packing notes (optional)</label><textarea name="notes" rows="2" maxlength="1000" style="width:100%; padding:10px 12px; border:1.5px solid var(--line); border-radius:8px; font:inherit"></textarea>`
      : '<p class="muted" data-nothing-ready>You don\'t have anything ready to ship yet, so you can\'t join this one. You can say no, or wait until something is ready.</p>'}
      <p class="msg" data-msg hidden></p><div class="btn-row">${ready.length ? '<button type="submit">Yes — add my items</button>' : ''}<button type="button" class="secondary" data-act="decline" data-id="${i.parcelId}" data-from="${esc(i.fromHandle)}">No thanks</button></div></form>`).join('')
      + elsewhere.map((i) => `<div class="card" data-other-handle style="border:2px solid var(--accent)"><strong>@${esc(i.fromHandle)} has asked @${esc(i.forHandle)} to ship together.</strong><div class="sub">Switch to @${esc(i.forHandle)} (at the top of My orders) to answer.</div></div>`).join('');
  };

  SITE.views.ship = async (view) => {
    const S = SITE.my, a = S.address, ready = S.readyItems();
    let body;
    if (!a) {
      body = `<div class="card"><h2>Add your delivery details first</h2><p>We need to know where to send your parcel.</p><a class="pillbtn" href="#/address">Add delivery details</a></div>`;
    } else if (!ready.length) {
      body = '<div class="card"><p class="muted">Nothing is ready to ship yet. Items appear here once they\'ve arrived with the GOM and been checked.</p></div>';
    } else {
      const name = a.fullName.trim();
      body = `<form class="card" data-form="ship"><h2>Request shipping</h2>
        <label>Which items would you like sent?</label>${ready.map((c) => `<label class="chk" style="margin:6px 0"><input type="checkbox" name="claim" value="${c.id}"> ${esc(c.label)} <span class="sub">${esc(c.orderTitle)}</span></label>`).join('')}
        <div class="formgrid" style="margin-top:12px"><div><label>Shipping method (for a price quote)</label><select name="method"><option value="">Choose a method…</option>${METHODS.map((x) => `<option>${esc(x)}</option>`).join('')}</select></div></div>
        <div data-declared hidden style="margin-top:10px"><label>Declared value for customs</label>
          <label class="chk"><input type="radio" name="declaredValue" value="true"> True value</label><label class="chk"><input type="radio" name="declaredValue" value="reduced"> Reduced value</label>
          <div class="sub">Reduced value lowers the customs charge risk but isn't covered for the full amount if the parcel is lost.</div></div>
        <label style="margin-top:12px">Ship together with friends (optional)</label>
        <div class="sub" style="margin-bottom:6px">If friends live nearby, you can post <strong>one parcel to your address</strong> with everyone's items in it — up to 5 people in all. They'll each be asked to say yes and choose their own items. Postage and packaging are shared out between you: equally per person for UK postage, or by the weight of each person's items for worldwide. They need to have signed in to this site.</div>
        <input name="shareWith" maxlength="200" placeholder="Their Instagram handles, e.g. @friend1, @friend2" autocomplete="off">
        <label style="margin-top:12px">Packing notes for your parcel (optional)</label><textarea name="notes" rows="2" maxlength="1000" placeholder="e.g. please keep photocards in a toploader, pack fragile items away from the edge of the box…" style="width:100%; padding:10px 12px; border:1.5px solid var(--line); border-radius:8px; font:inherit"></textarea>
        <label>Your bias (so we know whose photo to sneak into your thank-you card 💌)</label><input name="bias" maxlength="80" placeholder="e.g. Hyunjin">
        <label>Personalised Lomo</label><div class="sub" style="margin-bottom:6px">Sometimes I like to include a personalised Lomo in with orders. Can I use the name you provided in your delivery details (<strong>${esc(name)}</strong>)? If you have a name you would prefer me to use, please enter it here.</div>
        <input name="lomoName" maxlength="80" placeholder="Leave blank to use ${esc(name)}">
        <div class="card" style="background:var(--paper); margin-top:14px"><strong>Sending to</strong><div style="white-space:pre-line">${esc(a.fullName)}\n${esc(a.address)}\n${esc(a.email)} · ${esc(a.phone)}</div>
          <label class="chk" style="margin-top:8px"><input type="checkbox" name="addressConfirmed"> This is still the correct address, email and phone number</label><a href="#/address">Change delivery details</a></div>
        <p class="msg" data-msg hidden></p><button type="submit">Request shipping for selected</button></form>`;
    }
    view.innerHTML = `${S.crumb}<h1 style="margin:4px 0 10px">Request shipping</h1>${invitesHtml(S, ready, a)}${body}${parcelsHtml(S)}`;

    view.onchange = (e) => {
      if (e.target.name === 'method') $('[data-declared]', view).hidden = !/^ww\b/i.test(e.target.value);
    };
    view.onclick = async (e) => {                                          // answering an invitation, withdrawing one, or leaving a shared parcel
      const b = e.target.closest('[data-act]'); if (!b || !['decline', 'withdraw', 'leave'].includes(b.dataset.act)) return;
      const id = b.dataset.id, ask = {
        decline: [`Say no to sharing with @${b.dataset.from}?\n\nTheir parcel will be posted on its own.`, 'No thanks', 'POST', `/api/my/parcels/${id}/companion/decline`, 'You said no.'],
        withdraw: [`Take this back?\n\n@${b.dataset.friend} won't be asked to share this parcel any more.`, 'Yes, take it back', 'DELETE', `/api/my/parcels/${id}/companion?friend=${encodeURIComponent(b.dataset.friend)}`, 'Done.'],
        leave: ['Take your items out of this parcel?\n\nThey go back to "ready to ship", and the parcel is posted without them.', 'Take them out', 'POST', `/api/my/parcels/${id}/companion/leave`, 'Your items are out of the parcel.'],
      }[b.dataset.act];
      if (!(await SITE.confirm(ask[0], { ok: ask[1], cancel: 'Not yet' }))) return;
      const r = await S.api(ask[2], ask[3], ask[2] === 'POST' ? {} : undefined);
      if (!r.ok) return SITE.toast(errText(r), true);
      await S.reload(); await SITE.views.ship(view); SITE.toast(ask[4]);
    };
    view.onsubmit = async (e) => {
      if (e.target.dataset.form === 'invite') {                           // ask another friend to join an existing parcel
        e.preventDefault();
        const form = e.target, msg = $('[data-msg]', form), handles = form.elements.handles.value.trim();
        if (!handles) return S.say(msg, 'Enter their Instagram handle.');
        const r = await S.api('POST', `/api/my/parcels/${form.dataset.id}/companion/invite`, { handles });
        if (!r.ok) return S.say(msg, errText(r));
        await S.reload(); await SITE.views.ship(view); SITE.toast(`Asked ${listNames(r.json.invited)}.`);
        return;
      }
      if (e.target.dataset.form === 'accept') {
        e.preventDefault();
        const form = e.target, f = form.elements, msg = $('[data-msg]', form);
        const claimIds = [...form.querySelectorAll('input[name="claim"]:checked')].map((c) => Number(c.value));
        if (!claimIds.length) return S.say(msg, 'Choose at least one of your items to put in the parcel.');
        const payload = { claimIds };
        if (f.bias.value.trim()) payload.bias = f.bias.value.trim();
        if (f.lomoName.value.trim()) payload.lomoName = f.lomoName.value.trim();
        if (f.notes.value.trim()) payload.notes = f.notes.value.trim();
        const r = await S.api('POST', `/api/my/parcels/${form.dataset.parcel}/companion/accept`, payload);
        if (!r.ok) return S.say(msg, errText(r));
        await S.reload(); await SITE.views.ship(view);
        view.insertAdjacentHTML('afterbegin', `<div class="msg ok" data-joined>You're in — your items are in the parcel now. Postage and packaging will be split equally between the two of you.</div>`);
        return;
      }
      if (e.target.dataset.form !== 'ship') return;
      e.preventDefault();
      const form = e.target, f = form.elements, msg = $('[data-msg]', form), say = (t) => S.say(msg, t);
      const claimIds = [...form.querySelectorAll('input[name="claim"]:checked')].map((c) => Number(c.value));
      const method = f.method.value;
      if (!claimIds.length) return say('Select at least one item.');
      if (!method) return say('Choose a shipping method first.');
      const ww = /^ww\b/i.test(method);
      if (ww && !f.declaredValue.value) return say('Choose a declared value for customs.');
      if (!f.addressConfirmed.checked) return say('Please confirm your delivery details are still correct.');
      const payload = { claimIds, method, addressConfirmed: true };
      if (ww) payload.declaredValue = f.declaredValue.value;
      if (f.notes.value.trim()) payload.notes = f.notes.value.trim();
      if (f.bias.value.trim()) payload.bias = f.bias.value.trim();
      if (f.lomoName.value.trim()) payload.lomoName = f.lomoName.value.trim();
      if (f.shareWith.value.trim()) payload.shareWith = f.shareWith.value.trim();
      const r = await S.api('POST', '/api/my/parcels', payload);
      if (!r.ok) return say(errText(r));
      await S.reload(); await SITE.views.ship(view);
      view.insertAdjacentHTML('afterbegin', `<div class="msg ok" data-sent>Shipping requested — parcel #${r.json.id} is number ${r.json.queuePosition} in the packing queue.${r.json.companions?.length ? ` We've asked ${listNames(r.json.companions.map((c) => c.handle))} to share it — it can't be packed until ${r.json.companions.length === 1 ? 'they answer' : 'they have all answered'}.` : ''}</div>`);
    };
  };
})();
