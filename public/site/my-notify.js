// Email notifications: off until the person turns them on. One setting for their account (every handle linked to it).
(function () {
  const { esc, errText } = SITE;

  SITE.views.notifications = async (view) => {
    const S = SITE.my;
    const n = S.notify;
    view.innerHTML = `${S.crumb}<h1 style="margin:4px 0 6px">Email notifications</h1>
      <p class="muted">These are <strong>off</strong> unless you turn them on. When they're on, we'll email <strong>${esc(n.email)}</strong> when:</p>
      <div class="card"><ul style="margin:0; padding-left:20px; line-height:1.7">
        <li>your claims are secured (and what you now owe)</li>
        <li>a payment of yours has been verified — or couldn't be</li>
        <li>your parcel has been shipped</li>
        <li>a payment is overdue — one reminder per item, never repeated</li></ul></div>
      <div class="card" style="margin-top:14px"><label class="chk" style="display:flex; font-weight:600"><input type="checkbox" id="notifyToggle" ${n.enabled ? 'checked' : ''}> Email me about my orders</label>
        <p class="sub" style="margin:8px 0 0" data-state>${n.enabled ? 'Notifications are on.' : 'Notifications are off.'} This covers every Instagram handle linked to your email. Sign-in emails are separate and always sent when you ask for one.</p>
        <p class="msg" data-msg hidden></p></div>`;

    view.onchange = async (e) => {
      if (e.target.id !== 'notifyToggle') return;
      const want = e.target.checked;
      const r = await S.api('PUT', '/api/my/notifications', { enabled: want });
      const m = view.querySelector('[data-msg]');
      if (!r.ok) { e.target.checked = !want; m.textContent = errText(r); m.className = 'msg'; m.hidden = false; return; }
      S.notify.enabled = r.json.enabled;
      view.querySelector('[data-state]').textContent = `${r.json.enabled ? 'Notifications are on.' : 'Notifications are off.'} This covers every Instagram handle linked to your email. Sign-in emails are separate and always sent when you ask for one.`;
      SITE.toast(r.json.enabled ? 'Email notifications turned on.' : 'Email notifications turned off.');
    };
  };
})();
