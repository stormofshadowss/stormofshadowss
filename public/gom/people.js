// People tab: (1) people asking to be linked to a handle that already has orders — the rare fallback; (2) who linked an email lately, so you can
// check them after the fact; (3) blocked handles and people who deleted their account, with what they owe or hold, and a way to block someone.
(function () {
  const { esc, money, fmtDate, api, errText, $ } = GOM;
  let root = null, requests = [], links = [], flagged = [], invites = { totals: {}, people: [], days: 7 }, fresh = [], inviteSkipped = [];
  const inv = { filter: 'all', q: '', template: "Hi! I've moved my group orders to a new site, and your orders are all there. Open this link to see them: {link}\n\n(It works once, and expires on {date}. Please only use it if it's your own Instagram account.)" };
  const view = { days: 14, onlyUnchecked: false };
  const VIA = { self_new: 'added it themselves (a new handle)', claim_device: 'linked from the browser that made the claim', approved: 'approved by you', invite: 'used the link you sent' };
  const stamp = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '—');

  async function render(el) {
    root = el;
    const [r, l, f, i] = await Promise.all([api('GET', '/api/admin/handle-requests'), api('GET', `/api/admin/joiners/recent-links?days=${view.days}`), api('GET', '/api/admin/joiners/flagged'), api('GET', `/api/admin/invites?filter=${inv.filter}&q=${encodeURIComponent(inv.q)}`)]);
    requests = r.json?.requests || []; links = l.json?.links || []; flagged = f.json?.joiners || []; invites = i.json || invites;
    GOM.setBadge('people', requests.length);
    draw();
  }

  function requestsCard() {
    return `<div class="card"><h2>Handle requests</h2>
      <p class="sub">Someone asked to be linked to a handle that already has orders, from a browser that didn't make the original claim (a new phone, cleared cookies). Approve once you're happy it's really them.</p>
      ${requests.length ? requests.map((q) => `<div class="row" style="margin:12px 0" data-req="${q.id}"><div><strong>@${esc(q.handle)}</strong> ← ${esc(q.email)}
        <div class="sub">${q.claims} claim${q.claims === 1 ? '' : 's'} on that handle</div></div>
        <div class="btn-row" style="margin:0"><button class="sm" data-act="approve" data-id="${q.id}">Approve</button><button class="sm secondary" data-act="decline" data-id="${q.id}">Decline</button></div></div>`).join('')
        : '<p class="muted">Nothing waiting.</p>'}</div>`;
  }

  const expires = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const messageFor = (l) => inv.template.replace(/\{link\}/g, l.url).replace(/\{date\}/g, expires(l.expiresAt));
  const STATUS = { none: ['', 'no link yet'], active: ['ok', 'link made'], expired: ['warn', 'link expired'] };

  function invitesCard() {
    const t = invites.totals || {}, shown = (invites.people || []).slice(0, 200);
    return `<div class="card" id="inviteCard"><h2>Invite people to claim their orders</h2>
      <p class="sub">People who have orders but haven't signed in yet — for example everyone an import brought across. Make each person a <strong>one-time link</strong> and send it to them, for example by Instagram DM. Opening it and signing in links their handle straight away, with no approval step. Links work for ${invites.days} days; making a new one switches the old one off.</p>
      <p data-invite-totals><strong>${t.unlinked || 0}</strong> waiting · ${t.active || 0} with a live link · ${t.expired || 0} expired · ${t.none || 0} with no link yet · ${t.linked || 0} already signed in</p>
      <label for="inviteMsg">Message to send with each link (<code>{link}</code> and <code>{date}</code> are filled in)</label>
      <textarea id="inviteMsg" rows="4" style="width:100%; padding:10px 12px; border:1.5px solid var(--line); border-radius:8px; font:inherit">${esc(inv.template)}</textarea>
      <div class="btn-row" style="align-items:center"><button data-act="invite-missing" ${t.none || t.expired ? '' : 'disabled'}>Make links for everyone without one (${(t.none || 0) + (t.expired || 0)})</button>
        <select data-invite-filter aria-label="Show"><option value="all" ${inv.filter === 'all' ? 'selected' : ''}>Everyone waiting</option><option value="none" ${inv.filter === 'none' ? 'selected' : ''}>No link yet</option><option value="active" ${inv.filter === 'active' ? 'selected' : ''}>Link made</option><option value="expired" ${inv.filter === 'expired' ? 'selected' : ''}>Link expired</option></select>
        <input id="inviteSearch" placeholder="Search a handle" value="${esc(inv.q)}" style="max-width:200px" autocomplete="off"></div>
      ${fresh.length ? `<div data-fresh class="card" style="background:var(--paper); margin-top:10px"><h3 style="margin:0 0 4px; font-size:1rem">${fresh.length} new link${fresh.length === 1 ? '' : 's'} — copy them now</h3>
        <p class="sub">Links are only shown here, once. Leave this page and they can't be seen again (you'd make a new one, which replaces the old).</p>
        <div class="btn-row"><button class="sm" data-act="invite-csv">Download all as a spreadsheet (CSV)</button><button class="sm secondary" data-act="invite-clear">Done — hide these</button></div>
        <div class="scroll"><table class="grid"><thead><tr><th>Person</th><th>Link</th><th></th></tr></thead><tbody>${fresh.map((l, i) => `<tr data-fresh-row="${esc(l.handle)}"><td>@${esc(l.handle)}</td><td><input readonly value="${esc(l.url)}" style="min-width:260px" aria-label="Link for ${esc(l.handle)}"></td>
          <td><button class="sm" data-act="copy-link" data-i="${i}">Copy link</button> <button class="sm secondary" data-act="copy-msg" data-i="${i}">Copy message</button></td></tr>`).join('')}</tbody></table></div></div>` : ''}
      ${inviteSkipped.length ? `<p class="msg" data-skipped>Not made for: ${esc(inviteSkipped.map((s) => `@${s.handle} (${s.reason})`).join(', '))}</p>` : ''}
      ${shown.length ? `<div class="scroll"><table class="grid" style="margin-top:10px"><thead><tr><th>Person</th><th>Orders</th><th>Owes</th><th>Link</th><th></th></tr></thead><tbody>
        ${shown.map((p) => `<tr data-invitee="${esc(p.handle)}"><td>@${esc(p.handle)}</td><td>${p.claims}</td><td>${money(p.owed)}</td>
          <td><span class="pill ${STATUS[p.status][0]}">${STATUS[p.status][1]}</span>${p.status === 'active' ? ` <span class="sub">until ${esc(expires(p.expiresAt))}</span>` : ''}</td>
          <td><button class="sm secondary" data-act="invite-one" data-handle="${esc(p.handle)}">${p.status === 'none' ? 'Make link' : 'Make a new link'}</button>${p.status === 'active' ? ` <button class="sm secondary" data-act="invite-revoke" data-handle="${esc(p.handle)}">Switch off</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
        ${invites.people.length > shown.length ? `<p class="sub">Showing the first ${shown.length} of ${invites.people.length} — search to find someone.</p>` : ''}`
        : `<p class="muted" style="margin-top:10px">${t.unlinked ? 'Nobody matches that.' : 'Everyone who has orders has already signed in.'}</p>`}</div>`;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch { /* the box above is selectable instead */ } ta.remove(); }
    GOM.toast('Copied.');
  }
  const csvOf = (ls) => ['handle,link,expires,message', ...ls.map((l) => [l.handle, l.url, new Date(l.expiresAt).toISOString().slice(0, 10), messageFor(l)].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function makeLinks(body) {
    inv.template = $('#inviteMsg', root)?.value || inv.template;
    const r = await api('POST', '/api/admin/invites', body);
    if (!r.ok) return GOM.toast(errText(r), true);
    fresh = [...r.json.links, ...fresh.filter((f) => !r.json.links.some((l) => l.handle === f.handle))]; inviteSkipped = r.json.skipped;
    await render(root); GOM.toast(`Made ${r.json.links.length} link${r.json.links.length === 1 ? '' : 's'}.`);
  }

  function linksCard() {
    const shown = links.filter((x) => !(view.onlyUnchecked && x.verified));
    return `<div class="card"><h2>Recently linked emails</h2>
      <p class="sub">Most people link their own email straight after claiming — nothing here waits on you. Tick someone as checked once you're satisfied they are who they say (for example over Instagram DMs). Handles you haven't checked are flagged in the packing queue.</p>
      <div class="btn-row" style="align-items:center"><label for="linkDays" class="sub" style="margin:0">Show the last</label>
        <select id="linkDays" data-filter="days" style="width:auto">${[7, 14, 30, 90].map((d) => `<option value="${d}" ${view.days === d ? 'selected' : ''}>${d} days</option>`).join('')}</select>
        <label class="chk"><input type="checkbox" data-filter="only" ${view.onlyUnchecked ? 'checked' : ''}> Only ones I haven't checked</label></div>
      ${shown.length ? shown.map((x) => `<div class="itemrow" data-link="${esc(x.handle)}"><div class="grow"><strong>@${esc(x.handle)}</strong> ← ${esc(x.email)}
          <div class="sub">${esc(stamp(x.linkedAt))} · ${esc(VIA[x.linkedVia] || x.linkedVia || '')} · ${x.claims} claim${x.claims === 1 ? '' : 's'}</div></div>
          <span class="pill ${x.verified ? 'ok' : 'warn'}">${x.verified ? 'checked' : 'not checked'}</span>
          <button class="sm secondary" data-act="${x.verified ? 'unverify' : 'verify'}" data-handle="${esc(x.handle)}">${x.verified ? 'Un-check' : 'Mark checked'}</button></div>`).join('')
        : `<p class="muted" style="margin-top:10px">${links.length ? 'Everyone in this period has been checked.' : `No emails linked in the last ${view.days} days.`}</p>`}</div>`;
  }

  function flaggedCard() {
    return `<div class="card"><h2>Blocked and flagged handles</h2>
      <p class="sub">Blocked handles can't place new orders, and anything they'd paid towards a claim that gets cancelled is kept rather than returned as credit. Also shown: people who deleted their account, with what they still owe or hold.</p>
      ${flagged.length ? flagged.map((j) => `<div class="itemrow" data-flag="${esc(j.handle)}"><div class="grow"><strong>@${esc(j.handle)}</strong>
          ${j.blocked ? ' <span class="pill warn">blocked</span>' : ''}${j.accountDeletedAt ? ` <span class="pill">deleted their account ${fmtDate(j.accountDeletedAt)}</span>` : ''}
          ${j.blocked && j.blockedReason ? `<div class="sub">Reason: ${esc(j.blockedReason)}</div>` : ''}
          <div class="sub">Owes ${money(j.owed)} · Credit ${money(j.credit)} · Forfeited ${money(j.forfeited)} · ${j.openClaims} open claim${j.openClaims === 1 ? '' : 's'}</div></div>
          ${j.blocked ? `<button class="sm secondary" data-act="unblock" data-handle="${esc(j.handle)}">Unblock</button>` : ''}</div>`).join('')
        : '<p class="muted">Nobody is blocked or flagged.</p>'}
      <form data-form="block" style="margin-top:14px"><h3 style="margin:0 0 6px; font-size:.95rem">Block a handle</h3>
        <div class="formgrid"><div><label for="blkHandle">Instagram handle</label><input id="blkHandle" name="handle" placeholder="@handle" autocomplete="off" maxlength="40"></div>
          <div><label for="blkReason">Reason (kept in your records)</label><input id="blkReason" name="reason" maxlength="255" autocomplete="off"></div>
          <div><button type="submit" class="sm">Block</button></div></div><p class="msg" data-msg hidden></p></form></div>`;
  }

  function draw() {
    const typed = $('#inviteMsg', root); if (typed) inv.template = typed.value;                    // keep a message you've edited when the page redraws
    root.innerHTML = `<h1 style="margin:18px 0 10px">People</h1>${requestsCard()}${invitesCard()}${linksCard()}${flaggedCard()}`;
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'approve' || act === 'decline') {
      const r = await api('POST', `/api/admin/handle-requests/${b.dataset.id}/${act}`, {});
      if (!r.ok) return GOM.toast(errText(r), true);
      await render(root); return GOM.toast(act === 'approve' ? 'Approved.' : 'Declined.');
    }
    if (act === 'invite-one') return makeLinks({ handles: [b.dataset.handle] });
    if (act === 'invite-missing') {
      const n = (invites.totals.none || 0) + (invites.totals.expired || 0);
      const ok = await GOM.confirm(`Make links for ${n} ${n === 1 ? 'person' : 'people'}?\n\nEach gets a one-time link that works for ${invites.days} days. Anyone who already has a live link is left as they are. You'll then copy them or download them all as a spreadsheet.`, { ok: 'Make the links', cancel: 'Not yet' });
      return ok ? makeLinks({ mode: 'missing' }) : undefined;
    }
    if (act === 'invite-revoke') { await api('POST', '/api/admin/invites/revoke', { handle: b.dataset.handle }); fresh = fresh.filter((f) => f.handle !== b.dataset.handle); await render(root); return GOM.toast(`@${b.dataset.handle}'s link switched off.`); }
    if (act === 'copy-link') return copy(fresh[Number(b.dataset.i)].url);
    if (act === 'copy-msg') { inv.template = $('#inviteMsg', root)?.value || inv.template; return copy(messageFor(fresh[Number(b.dataset.i)])); }
    if (act === 'invite-csv') { inv.template = $('#inviteMsg', root)?.value || inv.template; return download(`claim-links-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(fresh)); }
    if (act === 'invite-clear') { fresh = []; inviteSkipped = []; return draw(); }
    if (act === 'verify' || act === 'unverify') {
      const r = await api('POST', `/api/admin/joiners/${act}`, { handle: b.dataset.handle });
      await render(root); return GOM.toast(r.ok ? (act === 'verify' ? `@${b.dataset.handle} marked as checked.` : `@${b.dataset.handle} un-checked.`) : errText(r), !r.ok);
    }
    if (act === 'unblock') {
      const h = b.dataset.handle;
      const ok = await GOM.confirm(`Unblock @${h}?\n\nThey can place orders again. Money already recorded as forfeited stays forfeited — if you want to put it back, add it as credit under Payments → Credit and tips.`, { ok: 'Unblock', cancel: 'Keep blocked' });
      if (!ok) return;
      const r = await api('POST', '/api/admin/joiners/unblock', { handle: h });
      await render(root); return GOM.toast(r.ok ? `@${h} unblocked.` : errText(r), !r.ok);
    }
  }

  async function onSubmit(e) {
    const form = e.target; if (form.dataset.form !== 'block') return;
    e.preventDefault();
    const m = $('[data-msg]', form), handle = form.elements.handle.value.trim(), reason = form.elements.reason.value.trim();
    const say = (t) => { m.textContent = t; m.className = 'msg'; m.hidden = false; };
    if (!handle) return say('Enter the Instagram handle to block.');
    if (!reason) return say('Give a reason — it is kept in your records.');
    const shown = handle.replace(/^@/, '');
    const ok = await GOM.confirm(`Block @${shown}?\n\nThey won't be able to place new orders, and you won't be able to add them to a set. Their existing orders carry on as normal. If one of their claims is cancelled, anything they'd paid towards it is kept (recorded as forfeited) rather than returned as credit.\n\nYou can unblock them at any time.`, { ok: 'Block them', cancel: 'Cancel' });
    if (!ok) return;
    const r = await api('POST', '/api/admin/joiners/block', { handle, reason });
    if (!r.ok) return say(errText(r));
    await render(root); GOM.toast(`@${shown.toLowerCase()} blocked.`);
  }

  async function onChange(e) {
    const t = e.target;
    if (t.matches?.('[data-invite-filter]')) { inv.filter = t.value; return render(root); }
    if (!t.dataset.filter) return;
    if (t.dataset.filter === 'days') { view.days = Number(t.value); return render(root); }
    view.onlyUnchecked = t.checked; draw();
  }

  GOM.registerTab({
    id: 'people', label: 'People',
    badgeCount: async () => ((await api('GET', '/api/admin/handle-requests')).json?.requests || []).length,
    async render(el) {
      await render(el); el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = onChange;
      el.oninput = (e) => { if (e.target.id !== 'inviteSearch') return; inv.q = e.target.value.trim(); clearTimeout(el._t); el._t = setTimeout(async () => { const pos = e.target.selectionStart; await render(el); const s = $('#inviteSearch', el); s.focus(); s.setSelectionRange(pos, pos); }, 150); };
    },
  });
})();
