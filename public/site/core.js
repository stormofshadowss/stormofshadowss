// Shared bits for the joiner pages: API calls, dialogs, toasts. No build step.
(function () {
  const SITE = (window.SITE = {});
  SITE.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  SITE.money = (n) => '£' + Number(n || 0).toFixed(2);
  SITE.fmtDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : ''); // stored ISO, shown UK style
  SITE.$ = (sel, root) => (root || document).querySelector(sel);
  SITE.$$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  SITE.fmtDateTime = (iso) => (iso ? `${SITE.fmtDate(iso.slice(0, 10))} ${iso.slice(11, 16)}` : '');
  SITE.views = {};   // joiner sub-pages register themselves here (pay, address, ship, …)
  SITE.normalizeHandle = (v) => String(v || '').trim().toLowerCase().replace(/^@/, '');

  SITE.api = async (method, path, body) => {
    const res = await fetch(path, {
      method,
      headers: { 'X-Requested-With': 'sos', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch { /* no body */ }
    return { ok: res.ok, status: res.status, json };
  };
  SITE.errText = (r) => {
    const j = r.json || {};
    if (j.issues && j.issues.length) return j.issues.map((i) => `${i.path ? i.path + ': ' : ''}${i.message}`).join('; ');
    return j.error || 'Something went wrong — please try again.';
  };

  // In-page dialogs, never the browser's own pop-ups.
  function dialog(message, buttons) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'ui-backdrop';
      back.innerHTML = '<div class="ui-modal" role="dialog" aria-modal="true"><p class="ui-text"></p><div class="ui-actions"></div></div>';
      back.querySelector('.ui-text').textContent = message;
      const done = (v) => { document.removeEventListener('keydown', onKey); back.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      buttons.forEach((b) => {
        const el = document.createElement('button');
        el.textContent = b.label; if (!b.primary) el.className = 'secondary';
        el.addEventListener('click', () => done(b.value));
        back.querySelector('.ui-actions').appendChild(el);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(back);
      const primary = back.querySelector('button:not(.secondary)'); if (primary) primary.focus();
    });
  }
  SITE.alert = (m) => dialog(m, [{ label: 'OK', value: true, primary: true }]);
  SITE.confirm = (m, o = {}) => dialog(m, [{ label: o.cancel || 'Cancel', value: false }, { label: o.ok || 'Yes, continue', value: true, primary: true }]);

  let timer;
  SITE.toast = (text, isError) => {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = text; t.className = isError ? 'err' : ''; t.hidden = false;
    clearTimeout(timer); timer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3000);
  };

  // Safe wrappers: storage can be blocked (private browsing), and that must never break the page.
  SITE.store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    sget(k, d) { try { const v = sessionStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    sset(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // A "Privacy notice" link at the foot of every page that uses this file.
  if (!document.getElementById('siteFoot')) document.body.insertAdjacentHTML('beforeend', '<footer id="siteFoot" style="text-align:center; padding:6px 20px 28px; font-size:.85rem"><a href="/privacy.html" style="color:inherit">Privacy notice</a></footer>');

  // The header: brand, links, and (on the shop) the basket.
  SITE.header = (active) => `<header class="top site-top"><span class="brand">StormOf<span>Shadowss</span></span>
    <nav class="site-nav"><a href="/" class="${active === 'shop' ? 'on' : ''}">Group orders</a><a href="/my.html" class="${active === 'my' ? 'on' : ''}">My orders</a>
    <span id="basketPill"></span></nav></header>`;
})();
