// The shop: browse group orders, fill a basket, claim with just an Instagram handle.
// Claiming never needs an account. Afterwards we offer to add an email so people can see their orders and pay.
(function () {
  const { esc, money, fmtDate, $, $$, api, errText, normalizeHandle, store } = SITE;
  const MAX_QTY = 20;
  let orders = [], shopItems = [], loaded = false;
  let basket = store.sget('sos_basket', []);   // [{ key, itemId, orderTitle, title, label, price, qty, member, variant }]
  let together = store.sget('sos_together', {});  // { itemId: true } — "keep these together in the same set"
  let done = null;                              // result of the last submit, shown as the confirmation page
  const view = $('#view');

  const saveBasket = () => { store.sset('sos_basket', basket); store.sset('sos_together', together); drawHeader(); };

  // The same rules the server applies (kept identical on purpose): a set holds ONE of each part, so asking for the same part
  // more than once spreads it across sets; "together" goes round by round. Only a preview here — the server places for real.
  function planSet(roster, parts, tog, held) {
    const taken = held.map((s) => new Set(s)); const at = (i) => (taken[i] ||= new Set()); const out = [];
    const place = (group) => { let i = 0; while (group.some((m) => at(i).has(m))) i++; group.forEach((m) => { at(i).add(m); out.push({ member: m, setIdx: i }); }); };
    if (tog && parts.length > 1) {
      const qty = {}; parts.forEach((m) => { qty[m] = (qty[m] || 0) + 1; });
      const rounds = Math.max(...Object.values(qty));
      for (let r = 0; r < rounds; r++) place(roster.filter((m) => qty[m] > r));
    } else parts.forEach((m) => place([m]));
    return out;
  }
  function placementText(it) {
    const lines = basket.filter((l) => l.itemId === it.id);
    const parts = it.members.map((m) => m.name).flatMap((n) => Array(lines.filter((l) => l.member === n).reduce((s, l) => s + l.qty, 0)).fill(n));
    if (!parts.length) return '';
    const open = it.sets.filter((s) => s.decision === 'none');
    const maxAll = Math.max(0, ...it.sets.map((s) => s.number));
    const plan = planSet(it.members.map((m) => m.name), parts, !!together[it.id] && parts.length > 1, open.map((s) => s.taken));
    const bySet = {}; plan.forEach((p) => { (bySet[p.setIdx] = bySet[p.setIdx] || []).push(p.member); });
    return Object.keys(bySet).map(Number).sort((a, b) => a - b).map((i) => {
      const fresh = i >= open.length;
      return `Set ${fresh ? maxAll + (i - open.length) + 1 : open[i].number}${fresh ? ' (new set)' : ''}: ${bySet[i].map(esc).join(', ')}`;
    }).join(' · ');
  }
  const lineKey = (itemId, member, variant) => `${itemId}|${member || ''}|${variant || ''}`;
  const count = () => basket.reduce((n, l) => n + l.qty, 0);
  // A price that is still "to be confirmed" is null — it is never shown or added up as £0.00.
  const priceText = (pr) => (pr == null ? 'Price TBC' : money(pr));
  const eachText = (pr) => (pr == null ? 'Price TBC' : `${money(pr)} each`);
  const known = (ls) => ls.reduce((s, l) => (l.price == null ? s : s + l.qty * l.price), 0);
  const tbcN = (ls) => ls.reduce((n, l) => (l.price == null ? n + l.qty : n), 0);
  const totalText = (ls = basket) => { const k = known(ls), t = tbcN(ls); return t ? (k ? `${money(k)} + ${t} TBC` : `${t} TBC`) : money(k); };
  const total = () => known(basket);

  function drawHeader() {
    $('#hdr').innerHTML = SITE.header('shop');
    $('#basketPill').innerHTML = count() ? `<a href="#/basket" class="pillbtn">Basket (${count()}) · ${totalText()}</a>` : '';
  }

  async function load() {
    const [r, s] = await Promise.all([api('GET', '/api/orders'), api('GET', '/api/shop')]);
    orders = r.json?.orders || []; shopItems = s.json?.items || []; loaded = true;
    // forget basket lines for things that no longer exist or whose order has closed; shop lines are trimmed to what's still in stock
    const live = new Map(orders.filter((o) => o.status === 'open').flatMap((o) => o.items.map((i) => [i.id, i])));
    const liveShop = new Map(shopItems.map((i) => [i.id, i]));
    const before = JSON.stringify(basket);
    basket = basket.filter((l) => (l.shopId ? liveShop.has(l.shopId) : live.has(l.itemId)))
      .map((l) => {
        if (l.shopId) return { ...l, qty: Math.min(l.qty, liveShop.get(l.shopId).left) };
        const it = live.get(l.itemId);
        return { ...l, price: l.member ? (it.members?.find((m) => m.name === l.member)?.price ?? it.price) : it.price };
      }).filter((l) => l.qty > 0);
    if (JSON.stringify(basket) !== before) saveBasket();
  }

  const findItem = (id) => { for (const o of orders) for (const i of o.items) if (i.id === id) return { order: o, item: i }; return null; };
  const qtyOf = (itemId, member, variant) => basket.find((l) => l.key === lineKey(itemId, member, variant))?.qty || 0;

  function bump(itemId, member, variant, delta) {
    const f = findItem(itemId); if (!f || f.order.status !== 'open') return;
    const key = lineKey(itemId, member, variant);
    let line = basket.find((l) => l.key === key);
    if (!line) {
      if (delta < 0) return;
      const price = member ? (f.item.members.find((m) => m.name === member)?.price ?? f.item.price) : f.item.price;
      line = { key, itemId, orderTitle: f.order.title, title: f.item.title, price, qty: 0, member: member || null, variant: variant || null, isSet: f.item.type === 'set',
        label: `${f.item.title}${member ? ` — ${member}` : ''}${variant ? ` (${variant})` : ''}` };
      basket.push(line);
    }
    line.qty = Math.max(0, Math.min(MAX_QTY, line.qty + delta));
    if (!line.qty) basket = basket.filter((l) => l !== line);
    if (f.item.type === 'set' && !basket.some((l) => l.itemId === itemId && l.qty)) delete together[itemId];
    saveBasket();
  }

  // ── shop (items already on hand) ──
  const shopQty = (id) => basket.find((l) => l.shopId === id)?.qty || 0;
  function bumpShop(id, delta) {
    const it = shopItems.find((x) => x.id === id); if (!it) return;
    let line = basket.find((l) => l.shopId === id);
    if (!line) { if (delta < 0 || it.left < 1) return; line = { key: `shop:${id}`, shopId: id, orderTitle: 'Shop (on hand)', title: it.title, label: it.title, price: it.price, qty: 0, payDays: it.payDays }; basket.push(line); }
    line.qty = Math.max(0, Math.min(MAX_QTY, it.left, line.qty + delta));
    if (!line.qty) basket = basket.filter((l) => l !== line);
    saveBasket();
  }
  function shopPage() {
    view.innerHTML = `<div class="crumb"><a href="#/">← Group orders</a></div><h1 style="margin:4px 0 6px">Shop</h1>
      <p class="muted">Items we already have on hand — no waiting for an order to arrive. They're held for you as soon as you claim them, and you pay afterwards; once paid they're ready to send.</p>
      ${shopItems.length ? shopItems.map((it) => { const q = shopQty(it.id), out = it.left < 1;
        return `<div class="card" data-shop-item="${it.id}">${it.image ? picbox(it.image, it.title) : ''}<div class="itemrow" style="border:0; padding:0"><div class="grow"><strong>${esc(it.title)}</strong>
          <div class="sub">${money(it.price)} · ${out ? '<strong>Sold out</strong>' : `${it.left} left`} · pay within ${it.payDays} day${it.payDays === 1 ? '' : 's'} of claiming</div></div>
          ${out ? '' : `<span class="stepper"><button class="secondary" data-act="shopdec" data-shop="${it.id}" ${q ? '' : 'disabled'} aria-label="One fewer">−</button><span>${q}</span><button data-act="shopinc" data-shop="${it.id}" ${q >= it.left || q >= MAX_QTY ? 'disabled' : ''} aria-label="One more">+</button></span>`}</div>
          ${it.notes ? `<p class="itemdesc">${esc(it.notes)}</p>` : ''}</div>`; }).join('')
        : '<div class="card"><p class="muted">Nothing in the shop right now — check back soon.</p></div>'}`;
  }

  const stepper = (itemId, member, variant, closed) => {
    const q = qtyOf(itemId, member, variant);
    const attrs = `data-item="${itemId}" ${member ? `data-member="${esc(member)}"` : ''} ${variant ? `data-variant="${esc(variant)}"` : ''}`;
    return closed ? '' : `<span class="stepper"><button class="secondary" data-act="dec" ${attrs} ${q ? '' : 'disabled'} aria-label="One fewer">−</button><span>${q}</span><button data-act="inc" ${attrs} ${q >= MAX_QTY ? 'disabled' : ''} aria-label="One more">+</button></span>`;
  };

  // ── pages ──
  function home() {
    const open = orders.filter((o) => o.status === 'open'), closed = orders.filter((o) => o.status !== 'open');
    const byGroup = new Map();
    open.forEach((o) => { if (!byGroup.has(o.group)) byGroup.set(o.group, []); byGroup.get(o.group).push(o); });
    const card = (o) => `<a class="gocard" href="#/order/${o.id}">${o.cover ? `<img class="thumb sm" src="${esc(o.cover.thumb)}" alt="">` : ''}<strong>${esc(o.title)}</strong><span class="sub">${o.items.length} item${o.items.length === 1 ? '' : 's'}${o.closeDate ? ` · closes ${fmtDate(o.closeDate)}` : ''}${o.paymentDeadline ? ` · pay by ${fmtDate(o.paymentDeadline)}` : ''}</span></a>`;
    const shopCard = shopItems.length ? `<h2 style="margin:18px 0 8px">Shop</h2><div class="cards"><a class="gocard" href="#/shop"><strong>Shop — on hand now</strong><span class="sub">${shopItems.filter((i) => i.left > 0).length} item${shopItems.filter((i) => i.left > 0).length === 1 ? '' : 's'} available · held for you as soon as you claim</span></a></div>` : '';
    view.innerHTML = `<h1 style="margin:18px 0 6px">Group orders</h1>
      <p class="muted">Pick what you want and claim it with just your Instagram handle — no password, no sign-up. Storm will confirm claims, then you pay.</p>
      ${shopCard}
      ${open.length ? [...byGroup.entries()].map(([g, os]) => `<h2 style="margin:18px 0 8px">${os[0].groupCover ? `<img class="avatar" src="${esc(os[0].groupCover.thumb)}" alt="">` : ''}${esc(g)}</h2><div class="cards">${os.map(card).join('')}</div>`).join('') : '<div class="card"><p class="muted">No group orders are open right now — check back soon.</p></div>'}
      ${closed.length ? `<details style="margin-top:22px"><summary>Closed orders (${closed.length})</summary><div class="cards" style="margin-top:8px">${closed.map(card).join('')}</div></details>` : ''}`;
  }

  // a picture sits to the left of its item; tapping it opens the full-size one
  const picbox = (img, alt) => `<a class="picbox" href="${esc(img.url)}" target="_blank" rel="noopener"><img class="thumb" src="${esc(img.thumb)}" width="84" height="84" loading="lazy" alt="${esc(alt)}"></a>`;
  // Options are drawn as little boxes you can tap (member names, set parts) and horizontal pills (sizes). A box or pill is highlighted once you've picked some.
  const tile = (it, name, sub, closed) => `<div class="opt${qtyOf(it.id, name, null) ? ' on' : ''}" data-opt="${esc(name)}"><span class="opt-name">${esc(name)}</span> <span class="opt-sub">${sub}</span>${stepper(it.id, name, null, closed)}</div>`;
  const sizePill = (it, v, closed) => `<div class="sizepill${qtyOf(it.id, null, v) ? ' on' : ''}" data-opt="${esc(v)}"><span class="sz">Size ${esc(v)}</span> ${stepper(it.id, null, v, closed)}</div>`;

  function itemBlock(o, it) {
    const html = itemBlockRaw(o, it);
    return it.image ? html.replace('<div class="card">', `<div class="card">${picbox(it.image, it.title)}`) : html;
  }
  function itemBlockRaw(o, it) {
    const closed = o.status !== 'open';
    const d = it.description ? `<p class="itemdesc">${esc(it.description)}</p>` : '';   // the GOM's own words; line breaks kept, nothing run
    const meta = `<span class="sub">${it.claimed} claimed${it.payBy ? ` · pay by ${fmtDate(it.payBy)}` : ''}</span>`;
    if (it.type === 'set') {
      const mine = basket.filter((l) => l.itemId === it.id && l.qty);
      const count = mine.reduce((s, l) => s + l.qty, 0);
      const multi = mine.some((l) => l.qty > 1);
      const summary = it.members.filter((m) => mine.some((l) => l.member === m.name)).map((m) => { const q = mine.find((l) => l.member === m.name).qty; return q > 1 ? `${q} × ${esc(m.name)}` : esc(m.name); }).join(', ');
      return `<div class="card"><div class="row"><div><strong>${esc(it.title)}</strong><div class="sub">${it.wholeSetPrice == null ? 'Price TBC' : `${money(it.wholeSetPrice)} for the whole set`}${it.requiresFullSet ? ' · <strong>every part must be claimed for it to go ahead</strong>' : ''}</div></div>${meta}</div>
        ${d}<p class="sub">Press + for each part you want — you can take more than one of the same part, and each goes in a different set. If every existing set already has a part, a new set opens for you.</p>
        <div class="opts">${it.members.map((m) => tile(it, m.name, `${priceText(m.price)} · ${it.partsClaimed[m.name] || 0} claimed`, closed)).join('')}</div>
        ${closed ? '' : `<div class="btn-row"><button class="secondary" data-act="whole" data-item="${it.id}">Claim the whole set (${it.wholeSetPrice == null ? 'price TBC' : money(it.wholeSetPrice)}, all in one set)</button></div>`}
        ${count ? `<div class="sub" style="margin-top:10px"><strong>Selected:</strong> ${summary} — ${totalText(mine)}</div>
          <div class="sub"><strong>Where they'll go:</strong> ${placementText(it)} <em>(this can shift if someone else claims first)</em></div>
          ${count >= 2 ? `<label class="chk" style="margin-top:6px"><input type="checkbox" data-act="together" data-item="${it.id}" ${together[it.id] ? 'checked' : ''}> Keep these together in the same set</label>${multi ? '<div class="sub">With this on, one of each part goes in the same set, then the next one of each in the next set, and so on.</div>' : ''}` : ''}` : ''}</div>`;
    }
    if (it.type === 'independent') {
      return `<div class="card"><div class="row"><div><strong>${esc(it.title)}</strong></div>${meta}</div>${d}
        <div class="opts">${it.members.map((m) => tile(it, m.name, priceText(m.price), closed)).join('')}</div></div>`;
    }
    if (it.type === 'size') {
      return `<div class="card"><div class="row"><div><strong>${esc(it.title)}</strong> <span class="sub">${eachText(it.price)}</span></div>${meta}</div>${d}
        <div class="pills">${it.variants.map((v) => sizePill(it, v, closed)).join('')}</div></div>`;
    }
    return `<div class="card"><div class="itemrow" style="border:0; padding:0"><div class="grow"><strong>${esc(it.title)}</strong><div class="sub">${eachText(it.price)}</div>${meta}</div>${stepper(it.id, null, null, closed)}</div>${d}</div>`;
  }

  function orderPage(id) {
    const o = orders.find((x) => x.id === id);
    if (!o) { view.innerHTML = '<div class="card"><p>That group order isn\'t available.</p><a href="#/">← All group orders</a></div>'; return; }
    view.innerHTML = `<div class="crumb"><a href="${SITE.groupPages && o.groupId ? SITE.groupPages.href({ id: o.groupId, name: o.group }) : '#/'}">← ${SITE.groupPages && o.groupId ? esc(o.group) : 'All group orders'}</a></div>
      ${o.cover ? `<img class="banner" src="${esc(o.cover.url)}" alt="${esc(o.title)}">` : ''}
      <h1 style="margin:4px 0">${esc(o.title)}</h1>
      <p class="muted">${esc(o.group)}${o.closeDate ? ` · closes ${fmtDate(o.closeDate)}` : ''}${o.paymentDeadline ? ` · payment due ${fmtDate(o.paymentDeadline)}` : ''}</p>
      ${o.status !== 'open' ? '<div class="msg">This group order has closed, so it can\'t be claimed any more.</div>' : ''}
      ${o.items.length ? o.items.map((it) => itemBlock(o, it)).join('') : '<div class="card"><p class="muted">No items have been added yet.</p></div>'}
      ${count() ? `<p><a class="pillbtn" href="#/basket">Review basket (${count()}) · ${totalText()}</a></p>` : ''}`;
  }

  function basketPage(message) {
    const handle = store.get('sos_handle', '');
    view.innerHTML = `<div class="crumb"><a href="#/">← Keep browsing</a></div><h1 style="margin:4px 0 10px">Your selections</h1>
      ${basket.length ? `<div class="card">${basket.map((l) => `<div class="itemrow"><div class="grow">${esc(l.label)}<div class="sub">${esc(l.orderTitle)} · ${eachText(l.price)}</div></div>
        <span class="stepper">${l.shopId ? `<button class="secondary" data-act="shopdec" data-shop="${l.shopId}" aria-label="One fewer">−</button><span>${l.qty}</span><button data-act="shopinc" data-shop="${l.shopId}" ${l.qty >= (shopItems.find((x) => x.id === l.shopId)?.left ?? 0) ? 'disabled' : ''} aria-label="One more">+</button>` : `<button class="secondary" data-act="dec" data-item="${l.itemId}" ${l.member ? `data-member="${esc(l.member)}"` : ''} ${l.variant ? `data-variant="${esc(l.variant)}"` : ''} aria-label="One fewer">−</button><span>${l.qty}</span><button data-act="inc" data-item="${l.itemId}" ${l.member ? `data-member="${esc(l.member)}"` : ''} ${l.variant ? `data-variant="${esc(l.variant)}"` : ''} ${l.qty >= MAX_QTY ? 'disabled' : ''} aria-label="One more">+</button>`}</span>
        <strong class="nowrap" style="min-width:70px; text-align:right">${l.price == null ? 'TBC' : money(l.qty * l.price)}</strong></div>`).join('')}
        <div class="itemrow" style="font-weight:700"><div class="grow">Total</div><div>${totalText()}</div></div>
        ${tbcN(basket) ? `<p class="sub" style="margin:6px 0 0"><strong>Price TBC:</strong> the price of ${tbcN(basket) === 1 ? 'one item is' : `${tbcN(basket)} items are`} still to be confirmed. You won't owe anything for ${tbcN(basket) === 1 ? 'it' : 'them'} until the price is set and the GOM confirms your claim.</p>` : ''}
        ${[...new Set(basket.filter((l) => l.isSet).map((l) => l.itemId))].map((id) => { const f = findItem(id); return f ? `<div class="sub" style="margin-top:6px"><strong>${esc(f.item.title)} — where they'll go:</strong> ${placementText(f.item)}${together[id] ? ' <em>(kept together)</em>' : ''}</div>` : ''; }).join('')}</div>
        <form class="card" data-form="claim"><label for="ig">Your Instagram ID</label><input id="ig" name="handle" value="${esc(handle)}" placeholder="@yourhandle" autocomplete="off" autocapitalize="none" spellcheck="false">
        <p class="sub">No password needed. ${basket.some((l) => l.shopId) ? `Shop items are held for you straight away and you'll owe for them right away (you have ${Math.min(...basket.filter((l) => l.shopId).map((l) => l.payDays))} day${Math.min(...basket.filter((l) => l.shopId).map((l) => l.payDays)) === 1 ? '' : 's'} to pay).${basket.some((l) => !l.shopId) ? ' Group-order items are requests: nothing is owed for those until the GOM confirms them, and their price is final once they do.' : ''}` : 'These are requests: nothing is owed until the GOM confirms them, and the price is final once they do.'}</p>
        <p class="msg" data-msg ${message ? '' : 'hidden'}>${esc(message || '')}</p>
        <button type="submit">Submit claims</button></form>` : `${message ? `<div class="msg">${esc(message)}</div>` : ''}<div class="card"><p class="muted">Nothing selected yet — pick items from a group order.</p><a href="#/">Browse group orders</a></div>`}`;
  }

  function donePage() {
    const d = done, h = d.handle;
    let follow;
    if (h.canLinkEmail) {
      follow = `<div class="card"><h2>Want to see your orders and pay?</h2>
        <p>Add your email and we'll send a one-time sign-in link. You'll use it to see <strong>My orders</strong>, pay, and confirm your delivery address. It works from any device and you don't need a password.</p>
        <form data-form="email"><label for="em">Your email</label><input id="em" name="email" type="email" autocomplete="email" placeholder="you@example.com" required>
        <p class="msg" data-msg hidden></p><div class="btn-row"><button type="submit">Send me the link</button><button type="button" class="secondary" data-act="skip-email">Not now</button></div></form></div>`;
    } else if (h.hasAccount) {
      follow = `<div class="card"><h2>Welcome back</h2><p>@${esc(h.name)} already has an account. <a href="/my.html">Sign in to see your orders</a>.</p></div>`;
    } else {
      follow = `<div class="card"><h2>See your orders</h2><p>To see your orders and pay, <a href="/my.html">sign in with your email</a>.</p></div>`;
    }
    view.innerHTML = `<h1 style="margin:18px 0 6px">Claims submitted</h1>
      <div class="card"><p>Thanks, <strong>@${esc(h.name)}</strong>! Your claims are in:</p><ul style="margin:0; padding-left:20px">${d.lines.map((l) => `<li>${l.qty} × ${esc(l.label)} <span class="sub">${l.price == null ? 'Price TBC' : money(l.qty * l.price)}</span></li>`).join('')}</ul>
      ${d.placements.length ? `<p class="sub" style="margin:10px 0 0"><strong>Where your set parts went:</strong> ${d.placements.map((x) => `${esc(x.member)} — Set ${x.setNumber}`).join(' · ')}</p>` : ''}
      <p class="sub" style="margin-bottom:0">Total ${totalText(d.lines)}.${tbcN(d.lines) ? ' Items marked Price TBC cost nothing until their price is confirmed — you\'ll see it in My orders once it is.' : ''} ${d.lines.some((l) => l.shopId) ? `Your shop items are held for you — pay within ${Math.min(...d.lines.filter((l) => l.shopId).map((l) => l.payDays))} day${Math.min(...d.lines.filter((l) => l.shopId).map((l) => l.payDays)) === 1 ? '' : 's'} (you'll find how in My orders).${d.lines.some((l) => !l.shopId) ? ' The rest are requests for now — the GOM will confirm them, then you can pay.' : ''}` : "They're requests for now — the GOM will confirm them, then you'll be able to pay."}</p></div>
      <div id="follow">${follow}</div><p><a href="#/">← Back to group orders</a></p>`;
  }

  function route() {
    if (!loaded) { view.innerHTML = '<p class="muted">Loading…</p>'; return; }
    const h = location.hash || '#/';
    drawHeader();
    if (h.startsWith('#/order/')) return orderPage(Number(h.slice(8)));
    if (h === '#/shop') return shopPage();
    if (h === '#/basket') return basketPage();
    if (h === '#/done' && done) return donePage();
    if (SITE.groupPages) return SITE.groupPages.show({ view, orders, shopItems }, h);       // the home page and the group pages (site/shop-groups.js)
    home();
  }

  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'inc' || b.dataset.act === 'dec') {
      bump(Number(b.dataset.item), b.dataset.member || null, b.dataset.variant || null, b.dataset.act === 'inc' ? 1 : -1);
      return route();
    }
    if (b.dataset.act === 'shopinc' || b.dataset.act === 'shopdec') { bumpShop(Number(b.dataset.shop), b.dataset.act === 'shopinc' ? 1 : -1); return route(); }
    if (b.dataset.act === 'whole') {                        // one of every part, kept together
      const f = findItem(Number(b.dataset.item));
      f.item.members.forEach((m) => bump(f.item.id, m.name, null, 1));
      together[f.item.id] = true; saveBasket(); return route();
    }
    if (b.dataset.act === 'skip-email') { $('#follow').innerHTML = '<div class="card"><p>No problem. Whenever you want to see your orders, use <a href="/my.html">My orders</a>.</p></div>'; }
  });

  view.addEventListener('change', (e) => {
    if (e.target.dataset.act === 'together') { together[Number(e.target.dataset.item)] = e.target.checked; saveBasket(); route(); }
  });

  view.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target, msg = $('[data-msg]', form);
    const say = (t) => { msg.textContent = t; msg.hidden = !t; msg.className = 'msg'; };
    if (form.dataset.form === 'claim') {
      const handle = normalizeHandle(form.elements.handle.value);
      if (!handle) return say('Enter your Instagram ID first.');
      say('');
      const lines = basket.filter((l) => !l.isSet && !l.shopId).map((l) => ({ itemId: l.itemId, qty: l.qty, ...(l.member ? { member: l.member } : {}), ...(l.variant ? { variant: l.variant } : {}) }));
      for (const l of basket.filter((x) => x.shopId)) lines.push({ leftoverId: l.shopId, qty: l.qty });
      for (const id of [...new Set(basket.filter((l) => l.isSet).map((l) => l.itemId))]) {
        lines.push({ itemId: id, parts: basket.filter((l) => l.itemId === id).map((l) => ({ member: l.member, qty: l.qty })), together: !!together[id] });
      }
      const r = await api('POST', '/api/claims', { handle, lines });
      if (!r.ok) { if (r.status === 404 || ['order_closed', 'sold_out'].includes(r.json?.code)) await load(); return basketPage(errText(r)); }
      store.set('sos_handle', handle);
      done = { handle: r.json.handle, lines: basket.slice(), total: total(), placements: r.json.placements || [] };
      basket = []; together = {}; saveBasket();
      location.hash = '#/done';
      route();
    } else if (form.dataset.form === 'email') {
      const r = await api('POST', '/api/auth/request-link', { email: form.elements.email.value, handle: done.handle.name });
      if (!r.ok) return say(errText(r));
      $('#follow').innerHTML = `<div class="card"><h2>Check your email</h2><p>${esc(r.json.message)}</p>${r.json.willLinkHandle ? `<p>Opening the link signs you in and connects <strong>@${esc(done.handle.name)}</strong> to your email, from any device.</p>` : `<p class="sub">This device can't connect @${esc(done.handle.name)} automatically, so after signing in you may be asked to confirm it's you.</p>`}</div>`;
    }
  });

  window.addEventListener('hashchange', route);
  drawHeader();
  route();
  load().then(route);
})();
