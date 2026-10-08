// Shared pieces for the GOM screens: API calls, in-page dialogs, toasts, tabs. No build step, no libraries.
(function () {
  const GOM = (window.GOM = { tabs: [], current: null, onSignedOut: null });

  GOM.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  GOM.money = (n) => '£' + Number(n || 0).toFixed(2);
  GOM.fmtDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—'); // stored ISO, shown UK style
  GOM.$ = (sel, root) => (root || document).querySelector(sel);
  GOM.$$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

  GOM.api = async (method, path, body) => {
    const res = await fetch(path, {
      method,
      headers: { 'X-Requested-With': 'sos', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch { /* no body */ }
    if (res.status === 401 && GOM.onSignedOut) GOM.onSignedOut();
    return { ok: res.ok, status: res.status, json };
  };
  // Turns an API error into one readable sentence.
  GOM.errText = (r) => {
    const j = r.json || {};
    if (j.issues && j.issues.length) return j.issues.map((i) => `${i.path ? i.path + ': ' : ''}${i.message}`).join('; ');
    return j.error || 'Something went wrong.';
  };

  // In-page dialogs (never the browser's own alert/confirm).
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
  GOM.alert = (message) => dialog(message, [{ label: 'OK', value: true, primary: true }]);
  GOM.confirm = (message, o = {}) => dialog(message, [{ label: o.cancel || 'Cancel', value: false }, { label: o.ok || 'Yes, continue', value: true, primary: true }]);

  let toastTimer;
  GOM.toast = (text, isError) => {
    const t = document.getElementById('toast');
    t.textContent = text; t.className = isError ? 'err' : ''; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3000);
  };

  // Tabs. Each screen registers { id, label, render(el) }.
  GOM.registerTab = (tab) => GOM.tabs.push(tab);
  GOM.setBadge = (id, n) => {
    const b = document.querySelector(`#tabs [data-tab="${id}"] .badge`);
    if (b) { b.textContent = n; b.hidden = !n; }
  };
  GOM.showTab = async (id) => {
    GOM.current = id;
    GOM.$$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    const tab = GOM.tabs.find((t) => t.id === id);
    const body = document.getElementById('tabBody');
    body.innerHTML = '<p class="muted">Loading…</p>';
    await tab.render(body);
  };
  GOM.refresh = () => GOM.showTab(GOM.current);
  GOM.refreshBadges = () => GOM.tabs.filter((t) => t.badgeCount).forEach(async (t) => { try { GOM.setBadge(t.id, await t.badgeCount()); } catch { /* badges are a nicety */ } });
  // ── pictures ──
  // One picture per thing (item, shop item, group order, artist group). Choosing a file uploads it straight away; the server shrinks it,
  // strips anything hidden in it (like location), and keeps a thumbnail.
  const MAX_PICTURE_MB = 8;
  GOM.pictureControl = (kind, id, image, label = 'Picture') => `<div class="picctl" data-pic-kind="${kind}" data-pic-id="${id}">
    <div class="piclabel">${GOM.esc(label)}</div>
    <div class="picrow">${image ? `<a href="${GOM.esc(image.url)}" target="_blank" rel="noopener"><img class="thumb" src="${GOM.esc(image.thumb)}" alt="${GOM.esc(label)}"></a>` : '<div class="thumb placeholder">No picture</div>'}
      <div><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-pic-file aria-label="${GOM.esc(`Choose a picture — ${label}`)}">
        ${image ? '<button type="button" class="sm secondary" data-pic-remove>Remove picture</button>' : ''}
        <div class="sub">JPEG, PNG, WebP or GIF, up to ${MAX_PICTURE_MB} MB. It's shrunk for the web and any location data is removed.</div>
        <span class="msg" data-pic-msg hidden></span></div></div></div>`;

  GOM.uploadPicture = async (kind, id, file) => {
    const bytes = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsArrayBuffer(file); });
    const r = await fetch(`/api/admin/images/${kind}/${id}`, { method: 'PUT', headers: { 'X-Requested-With': 'sos', 'Content-Type': file.type || 'application/octet-stream' }, body: new Uint8Array(bytes) });
    let json = null; try { json = await r.json(); } catch { /* no body */ }
    if (r.status === 401 && GOM.onSignedOut) GOM.onSignedOut();
    return { ok: r.ok, status: r.status, json };
  };
  const picState = (ctl, image) => {                                    // redraw one control in place, and tell the tabs so their lists stay right
    const kind = ctl.dataset.picKind, id = Number(ctl.dataset.picId), label = ctl.querySelector('.piclabel').textContent;
    const fresh = document.createElement('div'); fresh.innerHTML = GOM.pictureControl(kind, id, image, label);
    ctl.replaceWith(fresh.firstElementChild);
    document.dispatchEvent(new CustomEvent('gom:picture', { detail: { kind, id, image } }));
  };
  const picMsg = (ctl, text) => { const m = ctl.querySelector('[data-pic-msg]'); m.textContent = text; m.className = 'msg'; m.hidden = !text; };
  document.addEventListener('change', async (e) => {
    const input = e.target.closest ? e.target.closest('input[data-pic-file]') : null; if (!input) return;
    const ctl = input.closest('.picctl'), file = input.files && input.files[0]; if (!file) return;
    if (file.size > MAX_PICTURE_MB * 1024 * 1024) { input.value = ''; return picMsg(ctl, `That picture is too big — the limit is ${MAX_PICTURE_MB} MB.`); }
    picMsg(ctl, 'Uploading…');
    const r = await GOM.uploadPicture(ctl.dataset.picKind, Number(ctl.dataset.picId), file);
    if (!r.ok) { input.value = ''; return picMsg(ctl, GOM.errText(r)); }
    picState(ctl, r.json.image); GOM.toast('Picture saved.');
  });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest ? e.target.closest('[data-pic-remove]') : null; if (!b) return;
    const ctl = b.closest('.picctl');
    const ok = await GOM.confirm('Remove this picture?', { ok: 'Remove it', cancel: 'Keep it' });
    if (!ok) return;
    const r = await GOM.api('DELETE', `/api/admin/images/${ctl.dataset.picKind}/${ctl.dataset.picId}`);
    if (!r.ok) return picMsg(ctl, GOM.errText(r));
    picState(ctl, null); GOM.toast('Picture removed.');
  });
})();
