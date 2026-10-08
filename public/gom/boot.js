// Starts the GOM app: sign-in, then the tabs.
(function () {
  const { $, api, errText } = GOM;
  const loginView = $('#loginView'), appView = $('#appView');

  function showLogin(note) {
    appView.hidden = true; loginView.hidden = false;
    if (note) { const m = $('#loginMsg'); m.textContent = note; m.className = 'msg'; m.hidden = false; }
  }
  // Only say "session ended" if they were actually inside the app (a first visit just shows the login).
  GOM.onSignedOut = () => { if (!appView.hidden) showLogin('Your session ended — please sign in again.'); };

  function buildTabs() {
    $('#tabs').innerHTML = GOM.tabs.map((t) => `<button data-tab="${t.id}">${t.label}${t.badgeCount ? '<span class="badge" hidden></span>' : ''}</button>`).join('');
  }

  async function start(me) {
    loginView.hidden = true; appView.hidden = false;
    $('#whoami').textContent = `Signed in as ${me.account.username}`;
    buildTabs();
    GOM.showTab(GOM.current && GOM.tabs.some((t) => t.id === GOM.current) ? GOM.current : 'orders');
    // badges (waiting payments, parcels in the queue, handle requests) show before you open a tab
    GOM.refreshBadges();
  }

  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) GOM.showTab(b.dataset.tab); });

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('POST', '/api/admin/login', { username: $('#username').value, password: $('#password').value });
    $('#password').value = '';
    if (!r.ok) { const m = $('#loginMsg'); m.textContent = errText(r); m.className = 'msg'; m.hidden = false; return; }
    $('#loginMsg').hidden = true;
    const me = await api('GET', '/api/me');
    start(me.json);
  });
  $('#logout').addEventListener('click', async () => { await api('POST', '/api/auth/logout', {}); GOM.current = null; showLogin(); });

  (async () => {
    const me = await api('GET', '/api/me');
    if (me.ok && me.json.account.isAdmin) start(me.json); else showLogin();
  })();
})();
