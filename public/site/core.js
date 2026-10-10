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
  if (!document.getElementById('siteFoot')) document.body.insertAdjacentHTML('beforeend', '<footer id="siteFoot" style="text-align:center; padding:6px 20px 28px; font-size:.85rem"><a href="/privacy.html" style="color:inherit">Privacy notice</a><div><button type="button" class="themebtn" data-theme-toggle></button></div></footer>');
  if (window.SOS_THEME) window.SOS_THEME.sync();

  // The header: brand, links, and (on the shop) the basket.
  // A colour and initials for anything without a picture, so a missing picture still looks designed (the same name always gets the same colour).
  SITE.hue = (str) => { let h = 0; for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  SITE.initials = (str) => String(str).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

  // On a phone the main links live in a bar along the bottom (thumb reach): Home, Basket (with a count), My orders. It's hidden on wider screens by the stylesheet.
  const ICONS = {
    home: '<svg class="ic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
    bag: '<svg class="ic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 7h12l1 13H5L6 7z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg>',
    user: '<svg class="ic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>',
  };
  const basketCount = () => { const l = SITE.store.sget('sos_basket', []); return Array.isArray(l) ? l.reduce((n, x) => n + (Number(x.qty) || 0), 0) : 0; };
  SITE.refreshBottomBar = () => { const c = document.querySelector('#bottomBar .cnt'); if (!c) return; const n = basketCount(); c.textContent = n; c.hidden = !n; };
  SITE.mountBottomBar = (active) => {
    let bar = document.getElementById('bottomBar');
    if (!bar) { bar = document.createElement('nav'); bar.id = 'bottomBar'; bar.className = 'bottombar'; bar.setAttribute('aria-label', 'Main'); document.body.appendChild(bar); document.body.classList.add('has-bottombar'); }
    bar.innerHTML = `<a href="/#/" data-nav="shop" class="${active === 'shop' ? 'on' : ''}">${ICONS.home}<span>Home</span></a>
      <a href="/#/basket" data-nav="basket">${ICONS.bag}<span>Basket</span><span class="cnt" hidden></span></a>
      <a href="/my.html" data-nav="my" class="${active === 'my' ? 'on' : ''}">${ICONS.user}<span>My orders</span></a>`;
    SITE.refreshBottomBar();
  };

  SITE.header = (active) => { SITE.mountBottomBar(active); return `<header class="top site-top"><span class="brand">StormOf<span>Shadowss</span></span>
    <nav class="site-nav"><a href="/" class="${active === 'shop' ? 'on' : ''}">Group orders</a><a href="/my.html" class="${active === 'my' ? 'on' : ''}">My orders</a>
    <span id="basketPill"></span></nav></header>`; };
})();
