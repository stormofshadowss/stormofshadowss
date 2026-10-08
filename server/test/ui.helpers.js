import { JSDOM } from 'jsdom';

// Opens a real page from the running test server in a simulated browser. Its fetch() talks to the real API and
// database, with its own cookie jar — so what these tests exercise is exactly what a person's browser would.
export async function openPage(app, path, { cookies = [], init } = {}) {
  const jar = new Map(cookies.map((c) => c.split(';')[0]).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
  let inflight = 0;
  const errors = [];
  const dom = await JSDOM.fromURL(`${app.base}${path}`, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(window) {
      if (init) init(window);
      window.fetch = async (url, opts = {}) => {
        inflight++;
        try {
          const headers = { ...(opts.headers || {}) };
          if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
          const res = await fetch(new URL(url, app.base), { ...opts, headers, redirect: 'manual' });
          for (const sc of res.headers.getSetCookie()) {
            const pair = sc.split(';')[0], i = pair.indexOf('=');
            if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(sc)) jar.delete(pair.slice(0, i)); else jar.set(pair.slice(0, i), pair.slice(i + 1));
          }
          return res;
        } finally { inflight--; }
      };
      window.addEventListener('error', (e) => errors.push(e.message));
    },
  });
  const { window } = dom;
  const { document } = window;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Waits until the page has finished everything it was doing (requests and the redraws that follow).
  async function settle() { let calm = 0; for (let i = 0; i < 400 && calm < 4; i++) { await sleep(8); calm = inflight === 0 ? calm + 1 : 0; } }
  const q = (sel, root = document) => root.querySelector(sel);
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const text = (el = document.body) => el.textContent.replace(/\s+/g, ' ').trim();
  async function click(el) { if (!el) throw new Error('click: element not found'); el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); await settle(); }
  async function type(el, value) { if (!el) throw new Error('type: element not found'); el.value = value; el.dispatchEvent(new window.Event('input', { bubbles: true })); await settle(); }
  async function choose(el, value) { if (!el) throw new Error('choose: element not found'); el.value = value; el.dispatchEvent(new window.Event('change', { bubbles: true })); await settle(); }
  async function submit(form) { if (!form) throw new Error('submit: form not found'); form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle(); }
  const byText = (sel, t, root = document) => qa(sel, root).find((el) => el.textContent.trim().startsWith(t));
  // fills a form's named fields: { title: 'x', isPrivate: true, status: 'closed' }
  function fill(form, values) {
    for (const [name, v] of Object.entries(values)) {
      const el = form.elements[name]; if (!el) throw new Error(`no field "${name}"`);
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    }
  }
  // JSDOM.fromURL can return while the page's scripts are still loading; wait for the real load event first.
  if (document.readyState !== 'complete') await new Promise((r) => window.addEventListener('load', r, { once: true }));
  await settle();
  return { dom, window, document, q, qa, text, click, type, choose, submit, byText, fill, settle, errors, close: () => window.close() };
}

// A signed-in GOM page that counts any use of the browser's own pop-ups (there must be none).
export async function gomPage(app, cookie) {
  const p = await openPage(app, '/admin.html', { cookies: [cookie] });
  p.native = 0;
  for (const k of ['alert', 'confirm', 'prompt']) p.window[k] = () => { p.native++; return true; };
  return p;
}
export const modal = (p) => p.q('.ui-modal');
export const press = (p, label) => p.click(p.byText('.ui-modal button', label));
export const toast = (p) => (p.q('#toast').hidden ? '' : p.q('#toast').textContent);
