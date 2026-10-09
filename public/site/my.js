// My orders: the shell. Sign-in, handle linking, the landing page, the ongoing/completed lists, account deletion.
// Sub-pages (pay, address, ship) live in my-pay.js and my-ship.js and register themselves in SITE.views.
(function () {
  const { esc, money, fmtDate, $, $$, api, errText, normalizeHandle } = SITE;
  const view = $('#view');
  $('#hdr').innerHTML = SITE.header('my');
  const READY = 'ready to pack / on hand';
  const CATS = [['initials', 'Initials'], ['ems', 'EMS'], ['customs', 'Customs'], ['doms', 'Doms'], ['packaging', 'Packaging']];

  const S = (SITE.my = { me: null, handle: null, summary: null, address: null, parcels: [], invites: [], fixed: { fixed: [], requests: [] }, notify: { enabled: false, email: '' } });
  S.say = (el, text, ok) => { if (!el) return; el.textContent = text; el.className = 'msg' + (ok ? ' ok' : ''); el.hidden = !text; };
  S.q = (path) => `${path}${path.includes('?') ? '&' : '?'}handle=${encodeURIComponent(S.handle)}`;
  S.api = (method, path, body) => api(method, S.q(path), body);
  S.crumb = '<div class="crumb"><a href="#/">← My orders</a></div>';
  S.activeParcelClaimIds = () => new Set(S.parcels.filter((p) => ['requested', 'packed', 'shipped'].includes(p.status)).flatMap((p) => p.items.map((i) => i.claimId)));
  S.allClaims = () => (S.summary ? S.summary.orders.flatMap((o) => o.claims.map((c) => ({ ...c, orderTitle: o.title }))) : []);
  S.readyItems = () => { const busy = S.activeParcelClaimIds(); return S.allClaims().filter((c) => c.status === 'confirmed' && c.pipeline === READY && !busy.has(c.id)); };
  S.owedFor = (orderId) => (orderId ? (S.summary.orders.find((o) => o.id === orderId)?.owed || 0) : S.summary.owed.total);

  S.reload = async () => {
    const m = await api('GET', '/api/me');
    if (!m.ok) { S.me = null; return false; }
    S.me = m.json;
    const handles = S.me.handles.map((h) => h.handle);
    if (!S.handle || !handles.includes(S.handle)) S.handle = handles[0] || null;
    S.summary = S.address = null; S.parcels = []; S.invites = []; S.fixed = { fixed: [], requests: [] };
    { const nr = await S.api('GET', '/api/my/notifications'); if (nr.ok) S.notify = nr.json; }
    if (S.handle) {
      const [s, a, p, f] = await Promise.all([S.api('GET', '/api/my/summary'), S.api('GET', '/api/my/address'), S.api('GET', '/api/my/parcels'), S.api('GET', '/api/my/fixed')]);
      S.summary = s.ok ? s.json : null; S.address = a.json?.address || null; S.parcels = p.json?.parcels || []; S.invites = p.json?.invites || [];
      if (f.ok) S.fixed = f.json;
    }
    return true;
  };

  // ── signed out ──
  function signedOut() {
    view.innerHTML = `<h1 style="margin:18px 0 6px">My orders</h1>
      <section class="card"><h2>Sign in</h2><p>No password or PIN. Enter your email and we'll send you a one-time link.</p>
        <form data-form="signin"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required placeholder="you@example.com">
        <p class="msg" data-msg hidden></p><button type="submit">Email me a sign-in link</button></form>
        <p class="sub">Just claimed something? You'll have been offered to add your email right then — that's the quickest way to link your handle.</p></section>`;
  }

  // ── landing ──
  function costChips(c) {
    if (c.priceTbc) return '<span class="pill">Price TBC — nothing to pay yet</span>';          // never shown as £0.00
    return CATS.filter(([k]) => c.costs[k] && (c.costs[k].cost || c.costs[k].paid)).map(([k, name]) => {
      const x = c.costs[k], owed = Math.max(0, x.cost - x.paid);
      return `<span class="pill ${owed > 0 && c.status === 'confirmed' ? 'warn' : 'ok'}">${name} ${money(x.cost)}${k === 'initials' && c.splitShare > 0 ? ` (includes ${money(c.splitShare)} for an unclaimed part)` : ''}${c.status !== 'confirmed' ? '' : owed > 0 ? ` · ${money(owed)} to pay` : x.paidDate ? ` · paid ${fmtDate(x.paidDate)}` : ' · paid'}</span>`;
    }).join(' ');
  }

  async function home() {
    const m = S.me, handles = m.handles.map((h) => h.handle);
    const sum = S.summary, o = sum?.owed;
    const claims = S.allClaims();
    const ongoing = claims.filter((c) => c.pipeline !== 'completed'), completed = claims.filter((c) => c.pipeline === 'completed');
    const ready = S.readyItems().length;
    const tile = (label, n, cls = '') => `<div class="tile ${cls}"><div class="sub" style="color:inherit">${label}</div><div class="n">${money(n)}</div></div>`;
    const card = (href, title, hint) => `<a class="gocard" href="${href}"><strong>${title}</strong><span class="sub">${hint}</span></a>`;
    const settingsCard = card('#/settings', 'My settings', m.pending.length ? `${m.pending.length} handle${m.pending.length === 1 ? '' : 's'} waiting for the GOM` : 'handles, email & preferences');
    view.innerHTML = `<div class="row" style="margin:18px 0 8px"><h1 style="margin:0">My orders</h1><span class="muted">${handles.length === 1 ? `<strong>@${esc(handles[0])}</strong> · ` : ''}${esc(m.account.email)} · <a href="#" data-act="logout">Sign out</a></span></div>
      ${handles.length > 1 ? `<div class="card"><label for="sw">Viewing</label><select id="sw" data-act="switch">${handles.map((h) => `<option value="${esc(h)}" ${h === S.handle ? 'selected' : ''}>@${esc(h)}</option>`).join('')}</select></div>` : ''}
      ${S.invites.length ? `<div class="card" data-invite-notice style="background:var(--paper)"><strong>${S.invites.length === 1 ? `@${esc(S.invites[0].fromHandle)} has asked` : `${S.invites.length} people have asked`} to ship a parcel together with yours</strong><div class="sub">One parcel, one address — you choose which of your items go in. Nothing happens unless you say yes.</div><a class="pillbtn" href="#/ship" style="margin-top:8px">Have a look</a></div>` : ''}
      ${sum ? `<div class="card"><h2>What you owe</h2><div class="tiles">${CATS.map(([k, n]) => tile(n, o[k])).join('')}${tile('Total to pay', o.total, 'total')}</div>
        ${sum.credit > 0 ? `<p class="sub">You have ${money(sum.credit)} credit on your account — it's used automatically against what you owe.</p>` : ''}</div>
      <div class="cards">${card('#/pay', 'Make a payment', o.total > 0 ? `${money(o.total)} owed` : 'nothing owing')}
        ${card('#/ship', 'Request shipping', `${ready ? `${ready} item${ready === 1 ? '' : 's'} ready` : 'nothing ready yet'}${S.invites.length ? ` · ${S.invites.length} invitation${S.invites.length === 1 ? '' : 's'}` : ''}`)}
        ${card('#/ongoing', 'Ongoing orders', `${ongoing.length} item${ongoing.length === 1 ? '' : 's'}${S.parcels.some((p) => p.status === 'shipped') ? ' · a parcel is on its way' : ''}`)}
        ${card('#/completed', 'Completed orders', `${completed.length} received`)}
        ${S.fixed.fixed.length || S.fixed.requests.length ? card('#/fixed', 'Fixed claims', `${S.fixed.fixed.length} standing claim${S.fixed.fixed.length === 1 ? '' : 's'}${S.fixed.fixed.some((x) => x.pending) ? ' · a request is waiting' : ''}`) : ''}
        ${card('#/notifications', 'Email notifications', S.notify.enabled ? 'on' : 'off')}
        ${card('#/address', 'Delivery details', S.address ? esc(S.address.fullName) : 'not added yet')}
        ${settingsCard}</div>` : `<div class="cards">${settingsCard}</div>`}
      ${!handles.length ? `<div class="card" id="handleCard"><h2>Link your Instagram handle</h2>
        <p class="sub">Your orders are tied to your Instagram handle, so link it to see them here.</p>
        ${m.pending.length ? `<div>${m.pending.map((p) => `<span class="pill warn">@${esc(p.handle)} — waiting for the GOM to confirm it's you</span>`).join('')}</div>` : ''}
        <form data-form="handle"><label for="handle">Which Instagram handle is yours?</label><input id="handle" name="handle" placeholder="@yourhandle" autocomplete="off" autocapitalize="none" required>
        <p class="msg" data-msg hidden></p><button type="submit">This is mine</button></form></div>` : ''}
      ${sum && !sum.orders.length ? '<div class="card"><p class="muted">No claims yet — <a href="/">browse group orders</a>.</p></div>' : ''}`;
  }

  // ── ongoing / completed ──
  function ordersList(kind) {
    const done = kind === 'completed';
    const claims = S.allClaims().filter((c) => (c.pipeline === 'completed') === done);
    const inParcel = new Map();
    S.parcels.filter((p) => ['requested', 'packed', 'shipped'].includes(p.status)).forEach((p) => p.items.forEach((i) => inParcel.set(i.claimId, p)));
    const byGo = new Map();
    claims.forEach((c) => { if (!byGo.has(c.orderTitle)) byGo.set(c.orderTitle, []); byGo.get(c.orderTitle).push(c); });
    const stage = (c) => {
      const p = inParcel.get(c.id);
      if (done) return `Received ${fmtDate(c.receivedDate)}`;
      if (c.status === 'requested') return 'waiting for the GOM to confirm';
      if (p) return p.status === 'shipped' ? `On its way (parcel #${p.id})` : p.status === 'packed' ? `Packed (parcel #${p.id})` : `Shipping requested (parcel #${p.id})`;
      return c.pipeline;
    };
    // "Ask to cancel": the GOM has to approve it. The state of a request is shown under the item; the form opens in place.
    const paidOn = (c) => CATS.reduce((s, [k]) => s + (c.costs[k]?.paid || 0), 0);
    const cancelUi = (c) => {
      if (done) return '';
      const cr = c.cancelRequest;
      if (cr?.status === 'pending') return `<div class="sub" data-cancel-state="pending">⏳ You've asked to cancel this — waiting for the GOM to answer. <button class="sm secondary" data-act="cancel-withdraw" data-req="${cr.id}">Withdraw request</button></div>`;
      if (!['confirmed', 'requested'].includes(c.status) || c.isFixed || inParcel.has(c.id)) return '';
      if (S.cancelOpen === c.id) return `<form data-form="cancel" data-id="${c.id}" class="card" style="background:var(--paper); margin-top:8px"><strong>Ask to cancel “${esc(c.label)}”</strong>
        <p class="sub">${c.status === 'requested' ? "This hasn't been confirmed yet, but any cancellation still has to be approved by the GOM — it keeps member sets tidy. Nothing changes until they answer." : `The GOM has to approve this — nothing changes until they answer. If they do, ${paidOn(c) > 0 ? `the ${money(paidOn(c))} you've paid towards it` : 'anything you pay towards it'} comes back to your account as credit, but they may keep a cancellation fee, especially if it has already been ordered.`}</p>
        <label>Why? (optional)</label><textarea name="reason" rows="2" maxlength="500" style="width:100%; padding:10px 12px; border:1.5px solid var(--line); border-radius:8px; font:inherit"></textarea>
        <p class="msg" data-msg hidden></p><div class="btn-row"><button type="submit">Send request</button><button type="button" class="secondary" data-act="cancel-close">Never mind</button></div></form>`;
      return `${cr?.status === 'declined' ? `<div class="sub" data-cancel-state="declined">Your request to cancel this was declined${cr.note ? `: “${esc(cr.note)}”` : ''}.</div>` : ''}<button class="sm secondary" data-act="cancel-ask" data-id="${c.id}" style="margin-top:4px">${cr?.status === 'declined' ? 'Ask again' : 'Ask to cancel'}</button>`;
    };
    view.innerHTML = `${S.crumb}<h1 style="margin:4px 0 10px">${done ? 'Completed orders' : 'Ongoing orders'}</h1>
      ${byGo.size ? [...byGo.entries()].map(([title, cs]) => `<div class="card"><h2>${esc(title)}</h2>${cs.map((c) => `<div class="itemrow"><div class="grow">${esc(c.label)} ${c.isFixed ? '<span class="pill">fixed</span>' : ''}
        <div class="sub">${esc(stage(c))}${c.payBy && c.owed > 0 ? ` · pay by ${fmtDate(c.payBy)}` : ''}</div><div style="margin-top:4px">${costChips(c)}</div>${cancelUi(c)}</div>
        <div>${c.overdue ? '<span class="pill warn">overdue</span>' : ''}</div></div>`).join('')}</div>`).join('')
      : `<div class="card"><p class="muted">${done ? 'Nothing has been received yet.' : 'No ongoing orders. <a href="#/completed">See completed orders</a>'}</p></div>`}
      ${!done ? shippedBanner() : ''}`;
  }
  function shippedBanner() {
    const on = S.parcels.filter((p) => p.status === 'shipped');
    return on.length ? `<div class="card"><h2>Parcels on their way</h2>${on.map((p) => `<div class="itemrow"><div class="grow">Parcel #${p.id} <span class="sub">${p.items.map((i) => esc(i.label)).join(', ')}</span>${p.shared?.active ? `<div class="sub" data-shared-note>${p.canConfirm ? `Shared with ${p.shared.people.filter((x) => x.status === 'accepted').map((x) => `@${esc(x.handle)}`).join(', ')} — pressing the button confirms it for everyone.` : `Posted to @${esc(p.shared.people[0].handle)}'s address together with theirs. @${esc(p.shared.people[0].handle)} will confirm when it arrives.`}</div>` : ''}</div>${p.canConfirm ? `<button data-act="received" data-id="${p.id}">It's arrived — mark as received</button>` : ''}</div>`).join('')}</div>` : '';
  }
  SITE.views.ongoing = async () => ordersList('ongoing');
  SITE.views.completed = async () => ordersList('completed');

  // ── account ──
  // ── events ──
  view.addEventListener('submit', async (e) => {                                  // sending a request to cancel
    const form = e.target; if (form.dataset?.form !== 'cancel') return;
    e.preventDefault();
    const r = await S.api('POST', `/api/my/claims/${form.dataset.id}/cancel-request`, { reason: form.elements.reason.value.trim() || undefined });
    if (!r.ok) return S.say($('[data-msg]', form), errText(r));
    S.cancelOpen = null; await S.reload(); SITE.toast('Request sent — the GOM will let you know.'); route();
  });
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'logout') { e.preventDefault(); await api('POST', '/api/auth/logout', {}); S.me = null; location.hash = '#/'; return signedOut(); }
    if (b.dataset.act === 'cancel-ask') { S.cancelOpen = Number(b.dataset.id); return route(); }
    if (b.dataset.act === 'cancel-close') { S.cancelOpen = null; return route(); }
    if (b.dataset.act === 'cancel-withdraw') {
      if (!(await SITE.confirm('Take back your request to cancel this?\n\nThe item stays in your order as it was.', { ok: 'Yes, take it back', cancel: 'Not yet' }))) return;
      const r = await S.api('DELETE', `/api/my/cancel-requests/${b.dataset.req}`);
      if (!r.ok) return SITE.toast(errText(r), true);
      await S.reload(); SITE.toast('Request withdrawn.'); return route();
    }
    if (b.dataset.act === 'received') {
      const r = await S.api('POST', `/api/my/parcels/${b.dataset.id}/received`, {});
      if (!r.ok) return SITE.toast(errText(r), true);
      await S.reload(); SITE.toast('Marked as received — enjoy!'); return route();
    }

  });
  view.addEventListener('change', async (e) => {
    if (e.target.dataset.act === 'switch') { S.handle = e.target.value; await S.reload(); route(); }
  });
  view.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!['signin', 'handle'].includes(form.dataset.form)) return;
    e.preventDefault();
    const msg = $('[data-msg]', form);
    if (form.dataset.form === 'signin') {
      const r = await api('POST', '/api/auth/request-link', { email: form.elements.email.value });
      return S.say(msg, r.ok ? r.json.message : errText(r), r.ok);
    }
    const r = await api('POST', '/api/me/handles', { handle: normalizeHandle(form.elements.handle.value) });
    if (!r.ok) return S.say(msg, errText(r));
    if (r.json.status !== 'pending_approval') S.handle = r.json.handle;
    await S.reload(); await home();
    if (r.json.status === 'pending_approval') S.say($('#handleCard [data-msg]'), "That handle already has orders, so the GOM needs to confirm it's you. You'll see everything here once they have — nothing else is held up.", true);
  });

  async function route() {
    view.onsubmit = view.oninput = view.onchange = view.onclick = null;   // a sub-page's handlers must not outlive it
    if (!(await S.reload())) return signedOut();            // always load fresh figures, e.g. after the GOM verified a payment
    if (S.me.account.isAdmin) {
      view.innerHTML = '<div class="card"><h1>You\'re signed in as the GOM</h1><p>This page is for joiners. Your tools are at <a href="/admin.html">/admin.html</a>.</p><button data-act="logout" class="secondary">Sign out</button></div>';
      return;
    }
    const name = (location.hash || '#/').replace(/^#\/?/, '') || 'home';
    if (name === 'account') { location.replace('#/settings'); return; }                // the old "Your account" page now lives in Settings
    if (!['home', 'settings'].includes(name) && !S.handle) { location.hash = '#/'; return; }
    const fn = SITE.views[name];
    if (!fn || name === 'home') return home();
    view.innerHTML = '<p class="muted">Loading…</p>';
    await fn(view);
  }
  S.route = route;
  window.addEventListener('hashchange', route);

  route();
})();
