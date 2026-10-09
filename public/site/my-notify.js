// Email notifications: off until the person turns them on, then each kind of email can be switched on or off. One set of choices for their account (every handle linked to it).
(function () {
  const { esc, errText } = SITE;

  SITE.views.notifications = async (view) => {
    const S = SITE.my;
    const n = S.notify;
    const draw = () => {
      view.innerHTML = `${S.crumb}<h1 style="margin:4px 0 6px">Email notifications</h1>
        <p class="muted">These are <strong>off</strong> unless you turn them on. When they're on, we'll email <strong>${esc(n.email)}</strong> — and you choose which kinds below.</p>
        <div class="card"><label class="chk" style="display:flex; font-weight:600"><input type="checkbox" id="notifyToggle" ${n.enabled ? 'checked' : ''}> Email me about my orders</label>
          <p class="sub" style="margin:8px 0 0" data-state>${n.enabled ? 'Notifications are on.' : 'Notifications are off.'} This covers every Instagram handle linked to your email. Sign-in emails are separate and always sent when you ask for one.</p>
          <p class="msg" data-msg hidden></p></div>
        <div class="card" id="kinds" style="margin-top:14px; ${n.enabled ? '' : 'opacity:.55'}"><h2>Which emails?</h2>
          ${(n.events || []).map((e) => `<label class="chk" style="display:flex; margin:8px 0"><input type="checkbox" data-event="${esc(e.key)}" ${e.enabled ? 'checked' : ''} ${n.enabled ? '' : 'disabled'}> ${esc(e.label)}</label>`).join('')}
          ${n.enabled ? '' : '<p class="sub" data-kinds-off>Turn on order emails above to choose which ones.</p>'}</div>`;
    };
    draw();
    const say = (text) => { const m = view.querySelector('[data-msg]'); m.textContent = text; m.className = 'msg'; m.hidden = !text; };

    view.onchange = async (e) => {
      if (e.target.id === 'notifyToggle') {
        const want = e.target.checked;
        const r = await S.api('PUT', '/api/my/notifications', { enabled: want });
        if (!r.ok) { e.target.checked = !want; return say(errText(r)); }
        Object.assign(n, { enabled: r.json.enabled, events: r.json.events });
        draw(); SITE.toast(r.json.enabled ? 'Email notifications turned on.' : 'Email notifications turned off.');
      } else if (e.target.dataset.event) {
        const key = e.target.dataset.event, want = e.target.checked;
        const r = await S.api('PUT', '/api/my/notifications', { events: { [key]: want } });
        if (!r.ok) { e.target.checked = !want; return say(errText(r)); }
        n.events = r.json.events; say('');
      }
    };
  };
})();
