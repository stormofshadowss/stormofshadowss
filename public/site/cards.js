// PHOTOCARDS: single cards sold from spread photos. Cards → groups and open bundles → a bundle → its boards. Tap a card to see it close up and add it to the basket; the basket and claim are the shop's own.
// A taken card is dimmed with an X (never anyone's name); a card with several copies shows a circle that fills as they go; a signed-in person sees their own picks marked.
(function () {
  const { esc, money, fmtDate, $, $$, api, hue, initials } = SITE;
  const view = $('#view');
  let paint = 0, bundle = null, boards = [], zoom = 100, popup = null;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const data = () => SITE.cardsData || { groups: [], bundles: [] };
  const fadeNow = () => { const v = Number(SITE.store.sget('sos_cards_fade', 25)); return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 25; };   // how visible TAKEN cards stay (0–100%)
  const room = () => SITE.shopApi;

  // A way in from the home page
  SITE.homeExtra = () => {
    const d = data(); if (!d.bundles.length) return '';
    const left = d.bundles.reduce((n, b) => n + b.left, 0);
    return `<h2 class="kicker" style="margin-top:6px">Photocards</h2><div class="cards" style="margin-bottom:18px"><a class="gocard" href="#/cards" data-cards-home><strong>Single photocards</strong><span class="sub">${plural(d.bundles.length, 'open bundle', 'open bundles')} · ${plural(left, 'card', 'cards')} left</span></a></div>`;
  };

  // ── Cards: the groups with something open, and the open bundles (a group narrows it) ──
  const cover = (b) => (b.cover ? `<img class="cover" src="${esc(b.cover.thumb)}" alt="" loading="lazy">` : `<div class="cover ph" data-i="${esc(initials(b.title))}" style="--h:${hue(b.title)}; font-size:2.2rem" aria-hidden="true"></div>`);
  const bundleCard = (b) => `<a class="ocard" href="#/cards/bundle/${b.id}" data-bundle="${b.id}">${cover(b)}<div class="meta"><strong>${esc(b.title)}</strong><span class="sub">${esc(b.groupName || '')} · ${plural(b.cards, 'card', 'cards')} · ${b.left} left</span><span class="sub">${b.onHand ? 'In hand — claim now' : 'Pre-order'}${b.closesOn ? ` · closes ${fmtDate(b.closesOn)}` : ''}</span></div></a>`;
  const avatar = (g, on) => `<a class="avatar-link" href="#/cards/group/${g.id}" data-cgroup="${g.id}" ${on ? 'aria-current="page"' : ''}><span class="avatar-ring">${g.cover ? `<img src="${esc(g.cover.thumb)}" alt="" loading="lazy">` : `<span class="ph" data-i="${esc(initials(g.name))}" style="--h:${hue(g.name)}" aria-hidden="true"></span>`}</span>${esc(g.name)}<span class="avatar-sub">${plural(g.openBundles, 'open bundle', 'open bundles')}</span></a>`;
  async function listPage(groupId) {
    const mine = ++paint; const r = await api('GET', '/api/cards'); if (mine !== paint) return;
    const d = r.ok ? r.json : { groups: [], bundles: [] }; SITE.cardsData = d;
    const g = groupId ? d.groups.find((x) => x.id === groupId) : null, shown = d.bundles.filter((b) => !g || b.groupId === g.id);
    view.innerHTML = `<div class="crumb"><a href="#/">← Group orders</a></div><h1 style="margin:8px 0 6px">Photocards</h1>
      <p class="muted">Single cards from spread photos. Tap a card to see it close up, add it to your basket, and claim with just your Instagram handle.</p>
      ${d.groups.length > 1 ? `<div class="avatars" id="cardGroups">${d.groups.map((x) => avatar(x, g && x.id === g.id)).join('')}</div>` : ''}
      ${g ? `<p class="sub" data-showing>Showing ${esc(g.name)} · <a href="#/cards">show every group</a></p>` : ''}
      <div class="ordergrid">${shown.map(bundleCard).join('') || '<div class="card"><p class="muted" data-none>No photocard bundles are open right now — check back soon.</p></div>'}</div>`;
  }

  // ── a bundle: its boards, with a tag on every card ──
  const notOpen = '<div class="card"><p data-not-open>That bundle isn\'t open.</p><a href="#/cards">← Photocards</a></div>';
  function hotHtml(b, bd) {
    const inB = room().qtyOf(b.itemId), gone = b.left <= 0, part = b.qty > 1 && b.left > 0 && b.left < b.qty, claimed = b.qty - b.left;
    const label = `Card ${b.number} on ${bd.title}, ${money(b.price)}, ${gone ? 'taken' : b.qty > 1 ? `${b.left} of ${b.qty} left` : 'available'}${b.mine ? ', yours' : ''}${inB ? `, ${inB} in your basket` : ''}`;
    return `<button type="button" class="hot${gone ? ' gone' : ''}${part ? ' part' : ''}${b.mine ? ' mine' : ''}${inB ? ' inb' : ''}" data-box="${b.id}" ${gone ? 'disabled' : ''} style="left:${b.x * 100}%; top:${b.y * 100}%; width:${b.w * 100}%; height:${b.h * 100}%" aria-label="${esc(label)}">`
      + `<span class="ptag">${money(b.price)}</span>${part ? `<span class="fill" style="--p:${Math.round(claimed / b.qty * 100)}" title="${claimed} of ${b.qty} taken"></span>` : ''}${gone ? '<span class="xmark" aria-hidden="true"></span>' : ''}${b.mine ? '<span class="yours">✓ yours</span>' : ''}${inB ? `<span class="inb">${inB > 1 ? `×${inB} ` : ''}in basket</span>` : ''}</button>`;
  }
  const boardHtml = (bd) => `<section class="pcboard" data-board="${bd.id}"><h2 style="margin:18px 0 6px">${esc(bd.title)}</h2><div class="pcscroll"><div class="pccanvas" style="width:${zoom}%; aspect-ratio:${bd.aspect}"><img src="${esc(bd.image.url)}" alt="${esc(bd.title)}" draggable="false">${bd.boxes.map((b) => hotHtml(b, bd)).join('')}</div></div></section>`;
  function paintBoards() {
    const holder = $('#pcBoards', view); if (!holder) return;
    const keep = $$('.pcscroll', holder).map((s) => [s.scrollLeft, s.scrollTop]);
    holder.innerHTML = boards.map(boardHtml).join('');
    $$('.pcscroll', holder).forEach((s, i) => { if (keep[i]) { s.scrollLeft = keep[i][0]; s.scrollTop = keep[i][1]; } });
  }
  const paintBar = () => { const bar = $('#pcBar', view); if (bar) bar.innerHTML = room().count() ? `<a class="pillbtn" href="#/basket" data-review>Review basket (${room().count()}) · ${room().totalText()}</a>` : ''; };
  const dim = () => `--gone-dim:${(100 - fadeNow()) / 100}`;
  async function bundlePage(id) {
    const mine = ++paint; const r = await api('GET', `/api/cards/bundles/${id}`); if (mine !== paint) return;
    if (!r.ok) { view.innerHTML = notOpen; return; }
    bundle = r.json.bundle; boards = r.json.boards; const b = bundle;
    view.innerHTML = `<div class="crumb"><a href="${b.groupId ? `#/cards/group/${b.groupId}` : '#/cards'}">← ${b.groupName ? esc(b.groupName) : 'Photocards'}</a></div>
      <h1 style="margin:8px 0 4px">${esc(b.title)}</h1>
      <p class="muted">${esc(b.groupName || '')}${b.closesOn ? ` · closes ${fmtDate(b.closesOn)}` : ''}</p>
      ${b.description ? `<p>${esc(b.description)}</p>` : ''}
      <p class="sub" data-how>${b.onHand ? `These cards are in hand. Claim and you owe straight away — pay within ${plural(b.payDays, 'day', 'days')}.` : 'These are pre-orders: Storm confirms claims, then you pay.'} Tap a card to see it close up; a card with an <strong>X</strong> has been taken.</p>
      <div class="pcbar"><span class="btn-row" style="margin:0; gap:6px"><button type="button" class="sm secondary" data-cact="zoom-out" aria-label="Zoom out">−</button><span id="zoomLabel" class="sub">${zoom}%</span><button type="button" class="sm secondary" data-cact="zoom-in" aria-label="Zoom in">+</button></span>
        <label class="sub" for="cardFade">Taken cards still visible: <span id="fadeVal">${fadeNow()}</span>%</label><input id="cardFade" type="range" min="0" max="100" value="${fadeNow()}"><span id="pcBar"></span></div>
      <div id="pcBoards" style="${dim()}"></div>`;
    paintBoards(); paintBar();
  }

  // ── the pop-up: the card close up, its price and copies left, and how many to take ──
  function closePopup() { if (!popup) return; document.removeEventListener('keydown', popup.onKey); popup.el.remove(); popup = null; }
  function openPopup(box, bd) {
    closePopup();
    const inB = room().qtyOf(box.itemId), max = Math.min(box.left, 20), el = document.createElement('div');
    el.className = 'pcpop'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', `Card ${box.number}`);
    el.innerHTML = `<div class="pcpop-box"><button type="button" class="pcpop-x" data-cact="pop-close" aria-label="Close">×</button>${box.crop ? `<img src="${esc(box.crop.url)}" alt="Card ${box.number}">` : ''}
      <h2 style="margin:8px 0 2px">Card ${box.number} <span class="sub">· ${esc(bd.title)}</span></h2><p class="pcprice" data-pop-price>${money(box.price)}</p>
      <p class="sub" data-pop-left>${box.qty > 1 ? `${box.left} of ${box.qty} left` : 'Only 1 — first come, first served'}</p>${box.note ? `<p data-pop-note>${esc(box.note)}</p>` : ''}
      ${max > 1 ? `<div class="stepper" style="margin:8px 0"><button type="button" class="secondary" data-cact="pop-dec" aria-label="One fewer">−</button><span data-pop-qty>${inB || 1}</span><button type="button" class="secondary" data-cact="pop-inc" aria-label="One more">+</button></div>` : ''}
      <div class="btn-row"><button type="button" data-cact="pop-save">${inB ? 'Update basket' : 'Add to basket'}</button>${inB ? '<button type="button" class="secondary" data-cact="pop-remove">Remove from basket</button>' : ''}<button type="button" class="secondary" data-cact="pop-close">Close</button></div></div>`;
    popup = { el, box, max, want: inB || 1, onKey: (e) => { if (e.key === 'Escape') closePopup(); } };
    document.addEventListener('keydown', popup.onKey); document.body.appendChild(el); el.querySelector('[data-cact="pop-save"]')?.focus();
    el.addEventListener('click', (e) => {
      if (e.target === el) return closePopup();
      const a = e.target.closest('[data-cact]'); if (!a) return; const t = a.dataset.cact;
      if (t === 'pop-close') return closePopup();
      if (t === 'pop-inc' || t === 'pop-dec') { popup.want = Math.max(1, Math.min(popup.max, popup.want + (t === 'pop-inc' ? 1 : -1))); const q = el.querySelector('[data-pop-qty]'); if (q) q.textContent = popup.want; return; }
      if (t === 'pop-save' || t === 'pop-remove') { room().setQty(box.itemId, t === 'pop-remove' ? 0 : popup.want); closePopup(); paintBoards(); paintBar(); }
    });
  }

  view.addEventListener('click', (e) => {
    const hot = e.target.closest('.hot[data-box]');
    if (hot && !hot.disabled) { for (const bd of boards) { const box = bd.boxes.find((x) => String(x.id) === hot.dataset.box); if (box) return openPopup(box, bd); } }
    const c = e.target.closest('[data-cact]'); if (!c) return;
    if (c.dataset.cact === 'zoom-in' || c.dataset.cact === 'zoom-out') {
      const steps = [100, 150, 200, 300, 400], i = steps.indexOf(zoom); zoom = steps[Math.max(0, Math.min(steps.length - 1, i + (c.dataset.cact === 'zoom-in' ? 1 : -1)))];
      $$('.pccanvas', view).forEach((cv) => { cv.style.width = `${zoom}%`; }); const l = $('#zoomLabel', view); if (l) l.textContent = `${zoom}%`;
    }
  });
  view.addEventListener('input', (e) => {
    if (e.target.id !== 'cardFade') return; SITE.store.sset('sos_cards_fade', Number(e.target.value));
    const holder = $('#pcBoards', view); if (holder) holder.setAttribute('style', dim()); const v = $('#fadeVal', view); if (v) v.textContent = e.target.value;
  });
  window.addEventListener('hashchange', closePopup);

  function show(h) {
    closePopup();
    const b = /^#\/cards\/bundle\/(\d+)/.exec(h); if (b) return bundlePage(Number(b[1]));
    const g = /^#\/cards\/group\/(\d+)/.exec(h); return listPage(g ? Number(g[1]) : null);
  }
  SITE.cardPages = { show };
})();
