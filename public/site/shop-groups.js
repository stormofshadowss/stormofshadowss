// Group pages. The home page is the front of the shop: round group avatars (with filter chips for Boy bands / Girl groups / Solos / Duos) and the orders as picture cards under
// "Open now / Closing soon / New". Every group has its own page at #/group/<id>-<name>. A group with nothing open is left off the home page and the group tabs (its page still works
// by its link) until an order opens. shop.js hands over to this file (SITE.groupPages.show) for the home page and the group pages, and uses href() for its "back to the group" link.
(function () {
  const { esc, fmtDate, api, hue, initials } = SITE;
  const slug = (name) => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
  const href = (g) => `#/group/${g.id}-${slug(g.name)}`;                         // the id decides the page; the name is only there to read nicely
  let paint = 0;                                                                    // so a slow answer never paints over a page you have already moved on from
  const KINDS = [['boy band', 'Boy bands'], ['girl group', 'Girl groups'], ['solo', 'Solos'], ['duo', 'Duos']];
  const SOON_DAYS = 7, NEW_DAYS = 7;
  let kind = '', tabNow = 'open', last = null;                                      // the chosen chip and tab (kept while you move around), and what the page was last drawn from

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const day = (iso) => String(iso || '').slice(0, 10);
  const daysLeft = (iso) => { const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((new Date(`${day(iso)}T00:00:00`) - t) / 86400000); };      // calendar days: 0 = today, 1 = tomorrow
  const isNew = (o) => o.createdAt && Date.now() - new Date(o.createdAt).getTime() < NEW_DAYS * 86400000;
  const closingSoon = (o) => o.status === 'open' && o.closeDate && daysLeft(o.closeDate) >= 0 && daysLeft(o.closeDate) <= SOON_DAYS;

  const cover = (o) => (o.cover ? `<img class="cover" src="${esc(o.cover.thumb)}" alt="" loading="lazy">` : `<div class="cover ph" data-i="${esc(initials(o.title))}" style="--h:${hue(o.title)}; font-size:2.2rem" aria-hidden="true"></div>`);
  const orderCard = (o) => {
    const left = o.status === 'open' && o.closeDate ? daysLeft(o.closeDate) : null;
    const flag = closingSoon(o) ? `<span class="flag">${left <= 0 ? 'Closes today' : left === 1 ? 'Closes tomorrow' : `Closes in ${left} days`}</span>` : o.status === 'open' && isNew(o) ? '<span class="flag new">New</span>' : '';
    return `<a class="ocard" href="#/order/${o.id}" data-order="${o.id}">${flag}${cover(o)}<div class="meta"><strong>${esc(o.title)}</strong><span class="sub">${esc(o.group)} · ${plural(o.items.length, 'item', 'items')}${o.closeDate ? ` · closes ${fmtDate(day(o.closeDate))}` : ''}${o.paymentDeadline ? ` · pay by ${fmtDate(day(o.paymentDeadline))}` : ''}</span></div></a>`;
  };
  const avatar = (g) => `<a class="avatar-link" href="${href(g)}" data-group="${g.id}"><span class="avatar-ring">${g.cover ? `<img src="${esc(g.cover.thumb)}" alt="" loading="lazy">` : `<span class="ph" data-i="${esc(initials(g.name))}" style="--h:${hue(g.name)}" aria-hidden="true"></span>`}</span>${esc(g.name)}<span class="avatar-sub">${plural(g.openOrders, 'open order', 'open orders')}</span></a>`;
  const chip = (g, current) => `<a class="chip" data-tab="${g.id}" href="${href(g)}" ${current ? 'aria-current="page"' : ''}>${esc(g.name)}</a>`;

  function homePage(view, groups, orders, shopItems) {
    last = { view, groups, orders, shopItems };
    const active = groups.filter((g) => g.openOrders > 0);
    const kinds = KINDS.filter(([k]) => active.some((g) => g.kind === k));
    if (kind && !kinds.some(([k]) => k === kind)) kind = '';                       // that kind has nothing open any more
    const shown = active.filter((g) => !kind || g.kind === kind), ids = new Set(shown.map((g) => g.id));
    const open = orders.filter((o) => o.status === 'open' && ids.has(o.groupId));
    const sections = { open: open.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), soon: open.filter(closingSoon).sort((a, b) => day(a.closeDate).localeCompare(day(b.closeDate))), new: open.filter(isNew).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) };
    const tabs = [['open', 'Open now'], ['soon', 'Closing soon'], ['new', 'New']].filter(([k]) => k === 'open' || sections[k].length);
    if (!tabs.some(([k]) => k === tabNow)) tabNow = 'open';
    const left = shopItems.filter((i) => i.left > 0).length;
    const shopCard = shopItems.length ? `<h2 class="kicker" style="margin-top:6px">Shop</h2><div class="cards" style="margin-bottom:18px"><a class="gocard" href="#/shop"><strong>Shop — on hand now</strong><span class="sub">${plural(left, 'item', 'items')} available · held for you as soon as you claim</span></a></div>` : '';
    view.innerHTML = `<section class="hero"><h1>Group orders</h1>
        <p class="muted">Pick what you want and claim it with just your Instagram handle — no password, no sign-up. Storm will confirm claims, then you pay.</p></section>
      ${shopCard}
      ${active.length ? `<h2 class="kicker" style="margin-top:6px">Artists</h2>
        ${kinds.length ? `<div class="chips" id="kindChips" role="group" aria-label="Filter artists"><button type="button" class="chip ${kind ? '' : 'on'}" data-kind="" aria-pressed="${!kind}">All</button>${kinds.map(([k, l]) => `<button type="button" class="chip ${kind === k ? 'on' : ''}" data-kind="${k}" aria-pressed="${kind === k}">${l}</button>`).join('')}</div>` : ''}
        <div class="avatars" id="groupCards">${shown.map(avatar).join('')}</div>
        <div class="utabs" id="homeTabs" role="group" aria-label="Which orders">${tabs.map(([k, l]) => `<button type="button" class="utab ${tabNow === k ? 'on' : ''}" data-home-tab="${k}" aria-pressed="${tabNow === k}">${l}<span class="n">${sections[k].length}</span></button>`).join('')}</div>
        <div class="ordergrid" id="homeOrders">${sections[tabNow].map(orderCard).join('') || '<p class="muted">Nothing here right now.</p>'}</div>`
      : '<div class="card"><p class="muted">No group orders are open right now — check back soon.</p></div>'}`;
  }
  // the chips and tabs on the home page
  document.getElementById('view')?.addEventListener('click', (e) => {
    const k = e.target.closest('[data-kind]'), t = e.target.closest('[data-home-tab]');
    if (!last || !(k || t)) return;
    if (k) kind = k.dataset.kind; if (t) tabNow = t.dataset.homeTab;
    homePage(last.view, last.groups, last.orders, last.shopItems);
  });

  function groupPage(view, groups, orders, id) {
    const g = groups.find((x) => x.id === id);
    if (!g) { view.innerHTML = '<div class="card"><p>That group isn\'t available.</p><a href="#/">← All group orders</a></div>'; return; }
    const mine = orders.filter((o) => o.groupId === id), open = mine.filter((o) => o.status === 'open'), closed = mine.filter((o) => o.status !== 'open');
    const tabs = groups.filter((x) => x.openOrders > 0 || x.id === id);
    view.innerHTML = `<div class="crumb"><a href="#/">← Group orders</a></div>
      ${tabs.length > 1 ? `<nav id="groupTabs" class="chips" aria-label="Groups" style="margin-top:10px">${tabs.map((x) => chip(x, x.id === id)).join('')}</nav>` : ''}
      <div class="row" style="justify-content:flex-start; gap:14px; margin:8px 0 16px"><span class="avatar-ring" style="width:64px; height:64px">${g.cover ? `<img src="${esc(g.cover.thumb)}" alt="">` : `<span class="ph" data-i="${esc(initials(g.name))}" style="--h:${hue(g.name)}" aria-hidden="true"></span>`}</span><h1 style="margin:0">${esc(g.name)}</h1></div>
      ${open.length ? `<div class="ordergrid">${open.map(orderCard).join('')}</div>` : `<div class="card"><p class="muted">No group orders are open for ${esc(g.name)} right now — check back soon.</p></div>`}
      ${closed.length ? `<details style="margin-top:22px"><summary>Closed orders (${closed.length})</summary><div class="ordergrid" style="margin-top:8px">${closed.map(orderCard).join('')}</div></details>` : ''}`;
  }

  async function show({ view, orders, shopItems }, hash) {
    const mine = ++paint;
    const r = await api('GET', '/api/groups');
    if (mine !== paint) return;                                                      // they have already gone somewhere else
    const groups = r.ok ? r.json.groups : [];
    const m = /^#\/group\/(\d+)/.exec(hash || '');
    if (m) return groupPage(view, groups, orders, Number(m[1]));
    if ((hash || '').startsWith('#/group/')) { view.innerHTML = '<div class="card"><p>That group isn\'t available.</p><a href="#/">← All group orders</a></div>'; return; }
    homePage(view, groups, orders, shopItems);
  }

  SITE.groupPages = { show, href };
})();
