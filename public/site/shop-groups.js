// Group pages. The home page lists the groups that have group orders open (each a card); every group has its own page at #/group/<id>-<name> with that group's orders,
// and tabs along the top to jump between groups. A group with nothing open is left off the home page and the tabs (its page still works by its link) until an order opens.
// shop.js hands over to this file (SITE.groupPages.show) for the home page and the group pages, and uses href() for its "back to the group" link.
(function () {
  const { esc, fmtDate, api } = SITE;
  const slug = (name) => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
  const href = (g) => `#/group/${g.id}-${slug(g.name)}`;                         // the id decides the page; the name is only there to read nicely
  let paint = 0;                                                                    // so a slow answer never paints over a page you have already moved on from

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const orderCard = (o) => `<a class="gocard" href="#/order/${o.id}">${o.cover ? `<img class="thumb sm" src="${esc(o.cover.thumb)}" alt="">` : ''}<strong>${esc(o.title)}</strong><span class="sub">${plural(o.items.length, 'item', 'items')}${o.closeDate ? ` · closes ${fmtDate(o.closeDate)}` : ''}${o.paymentDeadline ? ` · pay by ${fmtDate(o.paymentDeadline)}` : ''}</span></a>`;
  const groupCard = (g) => `<a class="gocard" href="${href(g)}" data-group="${g.id}">${g.cover ? `<img class="thumb sm" src="${esc(g.cover.thumb)}" alt="">` : ''}<strong>${esc(g.name)}</strong><span class="sub">${plural(g.openOrders, 'open order', 'open orders')}</span></a>`;
  const tab = (g, current) => `<a data-tab="${g.id}" href="${href(g)}" ${current ? 'aria-current="page"' : ''} style="padding:6px 14px; border-radius:999px; border:1.5px solid ${current ? 'var(--accent)' : 'var(--line)'}; background:${current ? '#F7ECEA' : 'var(--surface)'}; color:inherit; text-decoration:none; font-weight:600">${esc(g.name)}</a>`;

  function homePage(view, groups, shopItems) {
    const active = groups.filter((g) => g.openOrders > 0);
    const left = shopItems.filter((i) => i.left > 0).length;
    const shopCard = shopItems.length ? `<h2 style="margin:18px 0 8px">Shop</h2><div class="cards"><a class="gocard" href="#/shop"><strong>Shop — on hand now</strong><span class="sub">${plural(left, 'item', 'items')} available · held for you as soon as you claim</span></a></div>` : '';
    view.innerHTML = `<h1 style="margin:18px 0 6px">Group orders</h1>
      <p class="muted">Pick what you want and claim it with just your Instagram handle — no password, no sign-up. Storm will confirms claims, then you pay.</p>
      ${shopCard}
      ${active.length ? `<div class="cards" id="groupCards" style="margin-top:14px">${active.map(groupCard).join('')}</div>` : '<div class="card"><p class="muted">No group orders are open right now — check back soon.</p></div>'}`;
  }

  function groupPage(view, groups, orders, id) {
    const g = groups.find((x) => x.id === id);
    if (!g) { view.innerHTML = '<div class="card"><p>That group isn\'t available.</p><a href="#/">← All group orders</a></div>'; return; }
    const mine = orders.filter((o) => o.groupId === id), open = mine.filter((o) => o.status === 'open'), closed = mine.filter((o) => o.status !== 'open');
    const tabs = groups.filter((x) => x.openOrders > 0 || x.id === id);
    view.innerHTML = `<div class="crumb"><a href="#/">← Group orders</a></div>
      ${tabs.length > 1 ? `<nav id="groupTabs" aria-label="Groups" style="display:flex; flex-wrap:wrap; gap:8px; margin:10px 0 14px">${tabs.map((x) => tab(x, x.id === id)).join('')}</nav>` : ''}
      <h1 style="margin:6px 0 10px">${g.cover ? `<img class="avatar" src="${esc(g.cover.thumb)}" alt="">` : ''}${esc(g.name)}</h1>
      ${open.length ? `<div class="cards">${open.map(orderCard).join('')}</div>` : `<div class="card"><p class="muted">No group orders are open for ${esc(g.name)} right now — check back soon.</p></div>`}
      ${closed.length ? `<details style="margin-top:22px"><summary>Closed orders (${closed.length})</summary><div class="cards" style="margin-top:8px">${closed.map(orderCard).join('')}</div></details>` : ''}`;
  }

  async function show({ view, orders, shopItems }, hash) {
    const mine = ++paint;
    const r = await api('GET', '/api/groups');
    if (mine !== paint) return;                                                      // they have already gone somewhere else
    const groups = r.ok ? r.json.groups : [];
    const m = /^#\/group\/(\d+)/.exec(hash || '');
    if (m) return groupPage(view, groups, orders, Number(m[1]));
    if ((hash || '').startsWith('#/group/')) { view.innerHTML = '<div class="card"><p>That group isn\'t available.</p><a href="#/">← All group orders</a></div>'; return; }
    homePage(view, groups, shopItems);
  }

  SITE.groupPages = { show, href };
})();
