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
  function dialog(message, buttons, select) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'ui-backdrop';
      back.innerHTML = '<div class="ui-modal" role="dialog" aria-modal="true"><p class="ui-text"></p><div class="ui-pick"></div><div class="ui-actions"></div></div>';
      back.querySelector('.ui-text').textContent = message;
      let sel = null;                                                                   // an optional drop-down: the primary button then answers with the chosen value
      if (select) { sel = document.createElement('select'); sel.setAttribute('aria-label', 'Choose one'); for (const o of select.options) { const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label; if (o.value === select.value) opt.selected = true; sel.appendChild(opt); } back.querySelector('.ui-pick').appendChild(sel); }
      const done = (v) => { document.removeEventListener('keydown', onKey); back.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      buttons.forEach((b) => {
        const el = document.createElement('button');
        el.textContent = b.label; if (!b.primary) el.className = 'secondary';
        el.addEventListener('click', () => done(sel && b.primary ? sel.value : b.value));
        back.querySelector('.ui-actions').appendChild(el);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(back);
      const primary = back.querySelector('button:not(.secondary)'); if (primary) primary.focus();
    });
  }
  GOM.inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);          // a suggested date: today + n days
  GOM.alert = (message) => dialog(message, [{ label: 'OK', value: true, primary: true }]);
  GOM.confirm = (message, o = {}) => dialog(message, [{ label: o.cancel || 'Cancel', value: false }, { label: o.ok || 'Yes, continue', value: true, primary: true }]);
  // Ask for one choice from a list: resolves to the chosen value, or null if cancelled.
  GOM.choose = async (message, o) => { const v = await dialog(message, [{ label: o.cancel || 'Cancel', value: false }, { label: o.ok || 'OK', value: true, primary: true }], { options: o.options, value: o.value }); return v === false ? null : v; };

  // TAKING ONE ITEM OUT of an incoming box ("it wasn't in the box") or a requested shipping list ("it wasn't on hand"): choose where it goes back to, see exactly what would change (a preview that changes nothing), then confirm.
  // Returns true if something was removed. No email is sent — the GOM tells the person herself.
  const STAGE_NAMES = { 'arrived at proxy / warehouse': 'Arrived at the proxy / warehouse', 'ordered via proxy / warehouse': 'Ordered via proxy / warehouse', 'awaiting fulfillment': 'Awaiting fulfillment', 'arrived at GOM': 'Arrived at the GOM', 'checking parcel': 'Checking parcel', 'ready to pack / on hand': 'Ready to pack / on hand' };
  GOM.removeItem = async ({ kind, id, claimId, label, handle }) => {
    const box = kind === 'box', url = `/api/admin/${box ? 'boxes' : 'parcels'}/${id}/remove-item`;
    const stages = box ? ['arrived at proxy / warehouse', 'ordered via proxy / warehouse', 'awaiting fulfillment'] : ['arrived at proxy / warehouse', 'ordered via proxy / warehouse', 'awaiting fulfillment', 'arrived at GOM', 'checking parcel', 'ready to pack / on hand'];
    const options = stages.map((s) => ({ value: s, label: s === 'ready to pack / on hand' ? 'Keep as ready to pack (it IS on hand)' : STAGE_NAMES[s] }));
    const stage = await GOM.choose(`Take “${label}” (@${handle}) out of ${box ? `box #${id}` : 'this shipping request'}?\n\nWhere should it go back to?`, { options, value: stages[0], ok: 'Review…', cancel: 'Cancel' });
    if (!stage) return false;
    const pv = await GOM.api('POST', url, { claimId, stage, preview: true }); if (!pv.ok) { GOM.toast(GOM.errText(pv), true); return false; }
    const p = pv.json, n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    const lines = [`“${label}” (@${handle}) goes back to “${STAGE_NAMES[stage]}”.`];
    if (box) lines.push(p.boxRemoved ? 'It is the last item, so the box is removed as well.' : `The box's EMS and customs are shared out again across the ${n(p.left, 'item', 'items')} still in it — the box totals stay the same.`);
    else {
      if (p.parcelRemoved) lines.push('It is the only item, so the whole request is removed (its postage and packaging come off).');
      else lines.push(`Postage and packaging (if set) are shared out again across the ${n(p.left, 'item', 'items')} left — the totals stay the same.`);
      if (p.companionRemoved) lines.push(`@${p.companionRemoved} has no items left, so they leave the parcel.`);
    }
    if (p.changes.length) lines.push('What changes:\n' + p.changes.map((c) => `• @${c.handle}: ${c.feeChange === 0 ? 'no change' : `${c.feeChange > 0 ? '+' : '−'}${GOM.money(Math.abs(c.feeChange))}`}${c.creditBack > 0 ? ` — the ${GOM.money(c.creditBack)} they had paid goes back to them as credit` : ''}`).join('\n'));
    lines.push('No email is sent — you will need to tell them yourself.');
    if (!(await GOM.confirm(lines.join('\n\n'), { ok: 'Take it out', cancel: 'Not yet' }))) return false;
    const r = await GOM.api('POST', url, { claimId, stage }); if (!r.ok) { GOM.toast(GOM.errText(r), true); return false; }
    GOM.toast(`Took “${label}” out${r.json.boxRemoved ? ' — and the box, as it was the last item' : r.json.parcelRemoved ? ' — and the request, as it was the only item' : ''}.`); return true;
  };

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
