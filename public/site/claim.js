// "Claim your orders": opened from the one-time link the GOM sent. The link's secret is in the #fragment (browsers never send that to a server), is read once, and
// is then removed from the address bar. Signed out → we email a sign-in link that also links the handle. Signed in → one tap.
(function () {
  const { esc, api, errText } = SITE;
  const view = document.getElementById('view');
  document.getElementById('hdr').innerHTML = SITE.header ? SITE.header('') : '';
  const token = (/[#&]t=([A-Za-z0-9_-]+)/.exec(location.hash) || [])[1] || '';
  if (token && history.replaceState) history.replaceState(null, '', location.pathname);      // keep the secret out of the address bar and history

  const gone = (why) => { view.innerHTML = `<div class="card"><h1 style="margin:0 0 8px">This link isn't working</h1><p>${esc(why || 'It may have expired or already been used.')}</p>
    <p class="sub">Ask whoever sent it for a new one — each link only works once, and for a limited time.</p><p><a href="/my.html">Go to My orders</a></p></div>`; };

  async function start() {
    if (!token) return gone('There is no link here.');
    const info = await api('GET', `/api/invites/${encodeURIComponent(token)}`);
    if (!info.ok) return gone(info.json?.error);
    const handle = info.json.handle;
    const me = await api('GET', '/api/me');
    const signedIn = me.ok && me.json?.account && !me.json.account.isAdmin;
    view.innerHTML = `<div class="card"><h1 style="margin:0 0 6px">Your orders are ready</h1>
      <p>Your group orders have moved to this new site. This link is for <strong>@${esc(handle)}</strong>.</p>
      ${signedIn
        ? `<p>You're signed in as <strong>${esc(me.json.account.email)}</strong>. Link <strong>@${esc(handle)}</strong> to this account to see your orders.</p>
           <div class="btn-row"><button data-act="link">Link @${esc(handle)} to my account</button></div>`
        : `<p>Enter your email and we'll send you a sign-in link. Using it signs you in and connects <strong>@${esc(handle)}</strong>'s orders to that email.</p>
           <form data-form="email"><label for="em">Your email</label><input id="em" name="email" type="email" required autocomplete="email" maxlength="254" style="max-width:360px">
           <div class="btn-row"><button type="submit">Email me a sign-in link</button></div></form>`}
      <p class="msg" data-msg hidden></p>
      <p class="sub">This link works once and expires on ${esc(new Date(info.json.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}. Only use it if it's really your Instagram handle.</p></div>`;
    const msg = (t, ok) => { const m = view.querySelector('[data-msg]'); m.textContent = t; m.className = `msg${ok ? ' ok' : ''}`; m.hidden = false; };

    view.querySelector('form[data-form="email"]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button'); btn.disabled = true;
      const r = await api('POST', `/api/invites/${encodeURIComponent(token)}/request-link`, { email: e.target.elements.email.value });
      if (!r.ok) { btn.disabled = false; return msg(errText(r)); }
      e.target.hidden = true;
      msg(`Check your email — a sign-in link is on its way to ${e.target.elements.email.value.trim()}. It works once and expires in a few minutes. Open it on this device to see your orders.`, true);
    });
    view.querySelector('[data-act="link"]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const r = await api('POST', `/api/invites/${encodeURIComponent(token)}/redeem`, {});
      if (!r.ok) { e.target.disabled = false; return msg(errText(r)); }
      msg(`Done — @${handle} is now linked to your account. Taking you to your orders…`, true);
      setTimeout(() => { location.href = '/my.html'; }, 900);
    });
  }
  start();
})();
