// Light / dark. Light (the soft pop look) is the default; a choice made with a "Light mode / Dark mode" button is remembered in THIS browser only (it never leaves the device).
// This file is loaded in <head> so the right colours are on screen from the first paint, with no flash.
(function () {
  const KEY = 'sos_theme';
  const LOOKS = ['light', 'dark'];
  const get = () => { try { const t = localStorage.getItem(KEY); return LOOKS.includes(t) ? t : 'light'; } catch { return 'light'; } };
  const apply = (t) => {
    document.documentElement.setAttribute('data-theme', t);
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', t === 'light' ? '#f1eefc' : '#100c18');
  };
  const label = (t) => (t === 'light' ? '☾ Dark mode' : '☀ Light mode');
  const sync = () => document.querySelectorAll('[data-theme-toggle]').forEach((b) => { b.textContent = label(get()); });
  apply(get());
  window.SOS_THEME = { get, label, sync, set(t) { try { localStorage.setItem(KEY, t); } catch { /* private window: it just won't be remembered */ } apply(t); sync(); }, toggle() { const t = get() === 'light' ? 'dark' : 'light'; this.set(t); return t; } };
  document.addEventListener('click', (e) => { if (e.target.closest('[data-theme-toggle]')) { e.preventDefault(); window.SOS_THEME.toggle(); } });
  document.addEventListener('DOMContentLoaded', sync);
})();
