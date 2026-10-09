// "My settings": the Instagram handles on the account (add or remove), the sign-in email, saved shipping defaults, a way into the email choices, and deleting the account.
// Registers itself as SITE.views.settings (my.js routes to it).
(function () {
  const { esc, money, api, errText, normalizeHandle, $ } = SITE;

  SITE.views.settings = async (view) => {
    const S = SITE.my;
    const [chk, dr] = await Promise.all([api('GET', '/api/me/delete-check'), S.handle ? S.api('GET', '/api/my/defaults') : Promise.resolve(null)]);
    const handles = S.me.handles.map((h) => h.handle), pending = S.me.pending;
    const del = chk.ok ? chk.json : { canDelete: true, blockers: [], warnings: { credit: 0, inFlight: 0 } };
    const defs = dr?.ok ? dr.json : { bias: '', lomoName: '' };
    const updated = new URLSearchParams(location.search).get('updated') === 'email';       // arrived here from the "confirm your new email" link
    if (updated) history.replaceState(null, '', location.pathname + location.hash);
    const w = del.warnings || {};

    view.innerHTML = `${S.crumb}<h1 style="margin:4px 0 10px">My settings</h1>
      ${updated ? `<div class="card" data-updated style="border:2px solid var(--accent)"><strong>Your sign-in email is now ${esc(S.me.account.email)}.</strong><div class="sub">You've been signed out on your other devices.</div></div>` : ''}

      <div class="card" id="handleCard"><h2>Your Instagram handle${handles.length > 1 ? 's' : ''}</h2>
        ${handles.map((h) => `<div class="row" style="justify-content:space-between; margin:6px 0" data-handle-row="${esc(h)}"><span class="pill ${h === S.handle ? 'ok' : ''}">@${esc(h)}</span><button class="sm secondary" data-act="remove-handle" data-handle="${esc(h)}">Remove</button></div>`).join('')}
        ${pending.map((p) => `<div style="margin:6px 0"><span class="pill warn">@${esc(p.handle)} — waiting for the GOM to confirm it's you</span></div>`).join('')}
        ${!handles.length && !pending.length ? '<p class="muted">No handle linked yet.</p>' : ''}
        <form data-form="link-handle" style="margin-top:10px"><label for="handle">${handles.length ? 'Link another handle' : 'Which Instagram handle is yours?'}</label>
          <input id="handle" name="handle" placeholder="@yourhandle" autocomplete="off" autocapitalize="none" required>
          <p class="msg" data-msg hidden></p><button type="submit">This is mine</button></form>
        ${handles.length ? '<p class="sub">You can remove a handle once it has no orders in progress, nothing owing and no credit on it.</p>' : ''}</div>

      <div class="card" id="emailCard"><h2>Sign-in email</h2>
        <p>You sign in with <strong>${esc(S.me.account.email)}</strong>.</p>
        <form data-form="email"><label for="newEmail">Change it to</label><input id="newEmail" name="email" type="email" autocomplete="email" required placeholder="new@example.com">
          <p class="msg" data-msg hidden></p><button type="submit">Send a confirmation link</button></form>
        <p class="sub">We email a link to the <strong>new</strong> address, and nothing changes until you open it there. You'll be signed out on your other devices.</p></div>

      ${S.handle ? `<div class="card" id="defaultsCard"><h2>Shipping defaults${handles.length > 1 ? ` for @${esc(S.handle)}` : ''}</h2>
        <p class="sub" style="margin-top:0">We'll fill these in when you ask for shipping. You can still change them each time.</p>
        <form data-form="defaults"><div class="formgrid"><div><label for="defBias">Your bias</label><input id="defBias" name="bias" maxlength="80" value="${esc(defs.bias)}" placeholder="e.g. Hyunjin"></div>
          <div><label for="defLomo">Personalised Lomo name</label><input id="defLomo" name="lomoName" maxlength="80" value="${esc(defs.lomoName)}" placeholder="Leave blank to use your delivery name"></div></div>
          <p class="msg" data-msg hidden></p><button type="submit">Save</button></form></div>` : ''}

      <div class="card" id="emailsCard"><h2>Emails from us</h2>
        <p class="sub" style="margin-top:0">Order emails are <strong>${S.notify.enabled ? 'on' : 'off'}</strong>. You can pick exactly which kinds you want.</p>
        <a class="pillbtn" href="#/notifications">Choose which emails I get</a></div>

      <div class="card" id="deleteCard"><h2>Delete my account</h2>
        <p>This signs you out everywhere and deletes your account and your personal details (name, address, phone and email).</p>
        ${del.blockers.length ? `<div class="msg" data-blocked style="margin:8px 0"><strong>You can't delete your account just yet:</strong>${del.blockers.map((b) => `<div data-blocker="${esc(b.kind)}" style="margin-top:4px">${esc(b.message)}</div>`).join('')}</div>` : ''}
        ${w.credit > 0 ? `<p class="sub" data-warn="credit">You have ${money(w.credit)} credit with the GOM. Deleting your account doesn't pay it back — message the GOM first if you'd like it refunded.</p>` : ''}
        ${w.inFlight > 0 && !del.blockers.length ? `<p class="sub" data-warn="inflight">You have ${w.inFlight} paid item${w.inFlight === 1 ? '' : 's'} that ${w.inFlight === 1 ? "hasn't" : "haven't"} reached you yet. If you delete your account the GOM won't have your address to send ${w.inFlight === 1 ? 'it' : 'them'}.</p>` : ''}
        <p class="msg" data-msg hidden></p>
        <button data-act="delete-account" class="secondary danger" ${del.blockers.length ? 'disabled' : ''}>Delete my account</button></div>`;

    view.onclick = async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'remove-handle') {
        const h = b.dataset.handle;
        if (!(await SITE.confirm(`Remove @${h} from your account?\n\nIt will stop showing in your orders here. If you ever want it back you can link it again.`, { ok: 'Remove it', cancel: 'Keep it' }))) return;
        const r = await api('DELETE', `/api/me/handles/${encodeURIComponent(h)}`);
        if (!r.ok) return S.say($('#handleCard [data-msg]', view), errText(r));
        await S.reload(); await SITE.views.settings(view); SITE.toast(`@${h} removed.`);
      }
      if (b.dataset.act === 'delete-account') {
        if (!(await SITE.confirm("Delete your account?\n\nYour login and personal details will be deleted and you'll be signed out. This can't be undone.", { ok: 'Yes, delete it', cancel: 'Keep my account' }))) return;
        const r = await api('DELETE', '/api/me', { confirm: true });
        if (!r.ok) return S.say($('#deleteCard [data-msg]', view), errText(r));
        S.me = null;
        view.innerHTML = '<div class="card"><h1>Your account has been deleted</h1><p>Your login and personal details are gone. Thanks for ordering with us.</p><a href="/">Back to group orders</a></div>';
      }
    };

    view.onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, msg = $('[data-msg]', f);
      if (f.dataset.form === 'link-handle') {
        const r = await api('POST', '/api/me/handles', { handle: normalizeHandle(f.elements.handle.value) });
        if (!r.ok) return S.say(msg, errText(r));
        if (r.json.status !== 'pending_approval' && !S.handle) S.handle = r.json.handle;
        await S.reload(); await SITE.views.settings(view);
        S.say($('#handleCard [data-msg]', view), r.json.status === 'pending_approval'
          ? "That handle already has orders, so the GOM needs to confirm it's you. You'll see everything here once they have — nothing else is held up." : `@${r.json.handle} is linked.`, true);
      } else if (f.dataset.form === 'email') {
        const r = await api('POST', '/api/my/email/change', { email: f.elements.email.value });
        S.say(msg, r.ok ? r.json.message : errText(r), r.ok);
      } else if (f.dataset.form === 'defaults') {
        const r = await S.api('PUT', '/api/my/defaults', { handle: S.handle, bias: f.elements.bias.value, lomoName: f.elements.lomoName.value });
        S.say(msg, r.ok ? 'Saved.' : errText(r), r.ok);
      }
    };
  };
})();
