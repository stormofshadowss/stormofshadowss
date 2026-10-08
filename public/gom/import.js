// Import tab: bring a Notion "Claims" export onto the site. Upload → decide who is who / which artist each order belongs to / what each status means
// → preview exactly what would happen → import → (undo, until money has moved on the imported claims). Nothing is saved until you press Import.
(function () {
  const { esc, money, fmtDate, api, errText, $, $$ } = GOM;
  let root = null, batches = [], cur = null, report = null, result = null, showAllPeople = false, msg = '';
  const SCOPES = [['ongoing', 'Ongoing orders only (not completed or cancelled)'], ['history', 'Completed and cancelled orders only (history)'], ['all', 'Everything']];

  async function render(el) { root = el; batches = (await api('GET', '/api/admin/import/batches')).json?.batches || []; if (cur) await load(cur.id); else draw(); }
  async function load(id) {
    const r = await api('GET', `/api/admin/import/batches/${id}`);
    if (!r.ok) { cur = null; return draw(); }
    cur = r.json; draw();
  }

  const signed = (n) => (n < 0 ? `-${money(-n)}` : money(n));
  const stat = (b) => (b.status === 'imported' ? '<span class="pill ok">imported</span>' : b.status === 'undone' ? '<span class="pill">undone</span>' : '<span class="pill warn">draft — not imported yet</span>');
  const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '');

  function introCard() {
    return `<div class="card"><h2>Import from Notion</h2>
      <p class="sub">Bring your Notion masterlist (the <strong>Claims</strong> database) onto the site. In Notion: open the database, choose <strong>•••</strong> → <strong>Export</strong> → <strong>CSV</strong>, then upload the file whose name ends in <strong>_all.csv</strong>.
      Nothing is saved until you press <strong>Import</strong>, and you can undo an import afterwards (until payments have been made on the imported claims). Imported group orders are hidden and closed, so nobody can claim from them, but everyone's claims show up in their own My orders.</p>
      <div class="formgrid"><div class="span2"><label for="impFile">Notion export (CSV)</label><input id="impFile" type="file" accept=".csv,text/csv"></div>
        <div class="span2"><label for="impScope">What to bring across</label><select id="impScope">${SCOPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div></div>
      <p class="msg" id="impMsg" ${msg ? '' : 'hidden'}>${esc(msg)}</p></div>`;
  }

  function pastCard() {
    if (!batches.length) return '';
    return `<div class="card"><h2>Imports so far</h2>${batches.map((b) => `<div class="itemrow" data-batch="${b.id}"><div class="grow"><strong>${esc(b.filename || 'Untitled')}</strong> ${stat(b)}
        <div class="sub">${esc(when(b.createdAt))} · ${b.rowCount} rows${b.summary?.counts ? ` · ${b.summary.counts.claims} claims for ${b.summary.counts.people.total} people` : ''}${b.status === 'imported' ? ` · imported ${esc(when(b.importedAt))}` : ''}</div></div>
        <div class="btn-row" style="margin:0">${b.status === 'draft' ? '<button class="sm" data-act="open">Open</button>' : ''}${b.status === 'imported' ? '<button class="sm secondary" data-act="undo">Undo this import</button>' : ''}${b.status !== 'imported' ? '<button class="sm secondary" data-act="discard">Discard</button>' : ''}</div></div>`).join('')}</div>`;
  }

  function peopleCard() {
    const need = cur.people.filter((p) => p.needsReview), shown = showAllPeople ? cur.people : need;
    return `<div class="card" id="impPeople"><h2>1. People</h2>
      <p class="sub">${cur.people.length} different names in the Joiner column. ${need.length ? `<strong>${need.length} need your check</strong> — they have spaces or brackets, so I've guessed a handle. For each one, tick <strong>Looks right</strong>, fix the handle, or tick Skip to leave that person's rows out. Nothing is assumed.` : 'Every name already looks like a handle.'}</p>
      <div class="btn-row" style="align-items:center"><label class="chk"><input type="checkbox" data-act="show-all" ${showAllPeople ? 'checked' : ''}> Show everyone (${cur.people.length}), not just the ones to check</label>${need.length ? '<button type="button" class="sm secondary" data-act="accept-all">Tick Looks right on all the guesses</button>' : ''}</div>
      ${shown.length ? `<div class="scroll"><table class="grid"><thead><tr><th>As written in Notion</th><th>Notion's linked name</th><th>Rows</th><th>Instagram handle</th><th>Looks right</th><th>Skip</th></tr></thead><tbody>
        ${shown.map((p) => { const skip = p.mapped === ''; const val = p.mapped === null ? (p.suggestion || '') : (p.mapped || '');
          const flagged = !p.confident;
          return `<tr data-person="${esc(p.raw)}" data-suggestion="${esc(p.suggestion || '')}" ${flagged ? 'data-flagged' : ''}><td>${esc(p.raw)}${p.needsReview ? ` <span class="pill warn">${esc(p.why || 'check')}</span>` : ''}</td><td>${esc(p.hint)}</td><td>${p.count}</td>
            <td><input data-handle value="${esc(val)}" ${skip ? 'disabled' : ''} maxlength="31" style="max-width:190px" autocomplete="off" aria-label="Handle for ${esc(p.raw)}">${p.onSite === 'signed_up' ? ' <span class="pill ok" data-onsite>already signed up</span>' : p.onSite === 'on_site' ? ' <span class="pill" data-onsite>on the site, not signed in</span>' : ''}</td>
            <td>${flagged ? `<input type="checkbox" data-confirm ${p.mapped ? 'checked' : ''} ${skip ? 'disabled' : ''} aria-label="Looks right: ${esc(p.raw)}">` : ''}</td><td><input type="checkbox" data-skip ${skip ? 'checked' : ''} aria-label="Skip ${esc(p.raw)}"></td></tr>`; }).join('')}</tbody></table></div>` : ''}</div>`;
  }

  function ordersCard() {
    return `<div class="card" id="impOrders"><h2>2. Group orders</h2>
      <p class="sub">${cur.groups.length} group orders. Choose which artist or group each belongs to (it can be a new name). Orders you leave blank go under the default below.</p>
      <div class="formgrid"><div class="span2"><label for="impDefault">Default artist/group</label><input id="impDefault" value="${esc(cur.defaultGroup)}" maxlength="80" list="impArtists"></div></div>
      <datalist id="impArtists">${cur.existingArtists.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
      <div class="scroll"><table class="grid"><thead><tr><th>Group order</th><th>Rows</th><th>Artist / group</th></tr></thead><tbody>
      ${cur.groups.map((g) => `<tr data-go="${esc(g.go)}"><td>${esc(g.go)}${g.existsOnSite ? ' <span class="pill warn">already on the site — claims will be added to it</span>' : ''}</td><td>${g.count}</td>
        <td><input data-artist value="${esc(g.artistGroup)}" maxlength="80" list="impArtists" placeholder="${esc(cur.defaultGroup)}" style="max-width:220px" autocomplete="off" aria-label="Artist for ${esc(g.go)}"></td></tr>`).join('')}</tbody></table></div></div>`;
  }

  function statusCard() {
    return `<div class="card" id="impStatuses"><h2>3. Order statuses</h2>
      <p class="sub">What each Notion status means on the site. The usual ones are filled in${cur.statuses.some((s) => !s.mapped) ? '; <strong>choose one for any marked "choose"</strong>' : ''}.</p>
      <div class="scroll"><table class="grid"><thead><tr><th>Status in Notion</th><th>Rows</th><th>On the site</th></tr></thead><tbody>
      ${cur.statuses.map((s) => `<tr data-status="${esc(s.raw)}"><td>${esc(s.raw)}${s.mapped ? '' : ' <span class="pill warn">choose</span>'}</td><td>${s.count}</td>
        <td><select data-stage aria-label="Stage for ${esc(s.raw)}"><option value="" ${s.mapped ? '' : 'selected'}>— choose —</option>${cur.stages.map((st) => `<option ${st === s.mapped ? 'selected' : ''}>${esc(st)}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div></div>`;
  }

  function reportCard() {
    if (!report) return '';
    const c = report.counts, m = report.money;
    const list = (arr, fmt, total) => (arr.length ? `<ul style="margin:4px 0 0; padding-left:20px">${arr.map(fmt).join('')}${total > arr.length ? `<li class="sub">…and ${total - arr.length} more</li>` : ''}</ul>` : '');
    return `<div class="card" id="impReport"><h2>Preview — nothing has been saved</h2>
      ${report.ok ? '' : `<div class="msg" data-blockers><strong>Not ready to import yet.</strong>
        ${report.blockers.unresolvedPeople.length ? `<div>${report.blockers.unresolvedPeople.length} name${report.blockers.unresolvedPeople.length === 1 ? ' still needs' : 's still need'} a handle (or Skip): ${esc(report.blockers.unresolvedPeople.slice(0, 8).map((p) => `${p.raw} (${p.count})`).join(', '))}${report.blockers.unresolvedPeople.length > 8 ? '…' : ''}</div>` : ''}
        ${report.blockers.unknownStatuses.length ? `<div>Choose what these statuses mean: ${esc(report.blockers.unknownStatuses.map((s) => `${s.raw} (${s.count})`).join(', '))}</div>` : ''}</div>`}
      <p data-headline style="margin:10px 0"><strong>${c.claims}</strong> claim${c.claims === 1 ? '' : 's'} (${c.cancelled} cancelled) for <strong>${c.people.total}</strong> people (${c.people.new} new, ${c.people.existing} already on the site${c.people.signedUp ? ` — ${c.people.signedUp} already signed in, so their old claims will appear in their My orders straight away` : ''}) across <strong>${c.orders.total}</strong> group orders (${c.orders.new} new, ${c.orders.existing} already there) and <strong>${c.items}</strong> items.</p>
      ${c.parcels?.parcels ? `<p data-parcels class="sub" style="margin:0 0 8px">${c.parcels.claims} item${c.parcels.claims === 1 ? '' : 's'} marked "Shipping to you" will be put in <strong>${c.parcels.parcels}</strong> shipped parcel${c.parcels.parcels === 1 ? '' : 's'} (one per person), so each person can press "It's arrived" when theirs turns up.</p>` : ''}
      <p data-money>Total due <strong>${money(m.due)}</strong> · paid so far <strong>${money(m.paid)}</strong> · still owed <strong>${money(m.owed)}</strong>${m.excess ? ` · <span class="pill warn">${money(m.excess)} paid beyond what was due</span>` : ''}</p>
      <div class="sub">By stage: ${Object.entries(report.byStage).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || 'nothing'}</div>
      <div class="sub">Left out: ${report.skipped.noJoiner} with no joiner (or skipped) · ${report.skipped.outOfScope} outside what you chose · ${report.skipped.alreadyImported} already imported before · ${report.skipped.blocked} waiting on a decision above</div>
      ${report.attention.excessTotal ? `<div data-excess style="margin-top:10px"><strong>Paid more than was due (${report.attention.excessTotal})</strong> — not turned into credit automatically; add credit by hand (Payments tab) if it is owed to them:${list(report.attention.excess, (x) => `<li>@${esc(x.handle)} — ${money(x.amount)} (${esc(x.item)})</li>`, report.attention.excessTotal)}</div>` : ''}
      ${report.attention.negativesTotal ? `<div data-negatives style="margin-top:10px"><strong>Negative amounts (${report.attention.negativesTotal})</strong> — the site has no negative costs, so these are imported as £0.00. They may mean someone is owed money:${list(report.attention.negatives, (x) => `<li>@${esc(x.handle)} — ${signed(x.amount)} ${esc(x.what)} (${esc(x.item)})</li>`, report.attention.negativesTotal)}</div>` : ''}
      ${report.warningsTotal ? `<details style="margin-top:10px"><summary>${report.warningsTotal} small thing${report.warningsTotal === 1 ? '' : 's'} to be aware of</summary>${list(report.warnings, (x) => `<li>Row ${x.n}: ${esc(x.text)}</li>`, report.warningsTotal)}</details>` : ''}
      <div class="btn-row"><button data-act="run" ${report.ok && c.claims ? '' : 'disabled'}>Import ${c.claims} claim${c.claims === 1 ? '' : 's'}</button>${!c.claims && report.ok ? '<span class="sub">Nothing to import with these settings.</span>' : ''}</div></div>`;
  }

  function resultCard() {
    if (!result) return '';
    const r = result;
    return `<div class="card" id="impResult" style="background:#E5F0EC"><h2>Imported</h2>
      <p data-result>${r.made.claims} claims created, ${r.made.people} new people (${r.reused.people} already existed — their claims were added to their existing accounts), ${r.made.orders} new group orders, ${r.made.items} items, and ${r.made.payments} imported payment${r.made.payments === 1 ? '' : 's'} so what people have already paid is recorded.${r.made.parcels ? ` ${r.made.parcels} shipped parcel${r.made.parcels === 1 ? '' : 's'} were created for items already on their way.` : ''}
      ${r.counts ? `Still owed: ${money(r.money.owed)}.` : ''}</p>
      <p class="sub">People will need to be linked to their handle before they can see their orders. Check the People tab, or undo this import from the list above if something looks wrong.</p></div>`;
  }

  function workspace() {
    if (!cur) return '';
    if (cur.status !== 'draft') return '';
    return `<h2 style="margin:18px 0 6px">${esc(cur.filename || 'Untitled')} <span class="sub">${cur.rowCount} rows</span></h2>
      <div class="card"><label for="impScope2">What to bring across</label><select id="impScope2">${SCOPES.map(([v, l]) => `<option value="${v}" ${v === cur.scope ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${peopleCard()}${ordersCard()}${statusCard()}
      <div class="card"><div class="btn-row" style="margin:0; align-items:center"><button data-act="save">Save my decisions</button><button class="secondary" data-act="preview">Save and preview</button><span class="sub">Your decisions are only used for this upload.</span></div></div>
      ${reportCard()}`;
  }

  function draw() { root.innerHTML = `<h1 style="margin:18px 0 10px">Import</h1>${introCard()}${pastCard()}${workspace()}${resultCard()}`; }

  // everything on the screen → the decisions to save
  function collect() {
    const body = { scope: $('#impScope2', root).value, defaultGroup: ($('#impDefault', root).value || '').trim() || undefined, people: {}, groups: {}, statuses: {} };
    $$('[data-person]', root).forEach((tr) => {
      const raw = tr.dataset.person, skip = $('[data-skip]', tr).checked, v = $('[data-handle]', tr).value.trim();
      const confirmed = tr.hasAttribute('data-flagged') ? ($('[data-confirm]', tr).checked || v !== tr.dataset.suggestion) : v !== tr.dataset.suggestion;   // a guess only counts once you've said it is right (or changed it)
      if (skip) body.people[raw] = ''; else if (v && confirmed) body.people[raw] = v; else body.people[raw] = null;
    });
    $$('[data-go]', root).forEach((tr) => { const v = $('[data-artist]', tr).value.trim(); body.groups[tr.dataset.go] = v ? { artistGroup: v } : null; });
    $$('[data-status]', root).forEach((tr) => { const v = $('[data-stage]', tr).value; body.statuses[tr.dataset.status] = v || null; });
    return body;
  }
  async function save() { const r = await api('PUT', `/api/admin/import/batches/${cur.id}/mapping`, collect()); if (!r.ok) { GOM.toast(errText(r), true); return false; } return true; }

  async function upload(file) {
    const scope = $('#impScope', root).value;
    msg = 'Reading the file…'; draw();
    const bytes = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsArrayBuffer(file); });
    const r = await fetch(`/api/admin/import/notion?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'X-Requested-With': 'sos', 'Content-Type': 'text/csv' }, body: new Uint8Array(bytes) });
    let json = {}; try { json = await r.json(); } catch { /* no body */ }
    if (!r.ok) { msg = json.error || 'That file could not be read.'; return render(root); }
    msg = ''; report = null; result = null; showAllPeople = false;
    await api('PUT', `/api/admin/import/batches/${json.id}/mapping`, { scope });
    cur = { id: json.id }; await render(root);
    GOM.toast(`Read ${json.rows} rows. Check the decisions below, then preview.`);
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, id = Number(b.closest('[data-batch]')?.dataset.batch);
    if (act === 'show-all') { showAllPeople = b.checked; return draw(); }
    if (act === 'accept-all') { $$('[data-confirm]:not(:disabled)', root).forEach((c) => { c.checked = true; }); return; }
    if (act === 'open') { report = null; result = null; cur = { id }; return load(id); }
    if (act === 'discard') {
      const ok = await GOM.confirm('Discard this import? Nothing on the site changes — it just removes the saved upload.', { ok: 'Discard it', cancel: 'Keep it' });
      if (!ok) return;
      await api('DELETE', `/api/admin/import/batches/${id}`); if (cur?.id === id) { cur = null; report = null; } return render(root);
    }
    if (act === 'save') { if (await save()) { await load(cur.id); GOM.toast('Decisions saved.'); } return; }
    if (act === 'preview') {
      if (!(await save())) return;
      const r = await api('GET', `/api/admin/import/batches/${cur.id}/preview`);
      if (!r.ok) return GOM.toast(errText(r), true);
      report = r.json; await load(cur.id); return $('#impReport', root)?.scrollIntoView?.();
    }
    if (act === 'run') {
      const c = report.counts, m = report.money;
      const ok = await GOM.confirm(`Import ${c.claims} claim${c.claims === 1 ? '' : 's'} for ${c.people.total} people across ${c.orders.total} group orders?\n\nPeople will be recorded as having paid ${money(m.paid)} and as still owing ${money(m.owed)}. Imported group orders are hidden and closed. You can undo this afterwards, until payments have been made on the imported claims.`, { ok: 'Import them', cancel: 'Not yet' });
      if (!ok) return;
      const r = await api('POST', `/api/admin/import/batches/${cur.id}/run`, {});
      if (!r.ok) return GOM.toast(errText(r), true);
      result = r.json; report = null; cur = null; await render(root); GOM.refreshBadges();
      return GOM.toast(`Imported ${r.json.made.claims} claims.`);
    }
    if (act === 'undo') {
      const bt = batches.find((x) => x.id === id);
      const ok = await GOM.confirm(`Undo the import of "${bt?.filename || 'this file'}"?\n\nEverything it created is removed: its claims, items, group orders, imported payments and any people it added. Anything that existed before is left alone. This can't be done once payments have been made on the imported claims.`, { ok: 'Undo the import', cancel: 'Keep it' });
      if (!ok) return;
      const r = await api('POST', `/api/admin/import/batches/${id}/undo`, {});
      if (!r.ok) return GOM.toast(errText(r), true);
      result = null; await render(root); GOM.refreshBadges();
      return GOM.toast(`Undone — removed ${r.json.gone.claims} claims${r.json.kept.people || r.json.kept.orders ? `; kept ${r.json.kept.people} people and ${r.json.kept.orders} orders that have been used since` : ''}.`);
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.id === 'impFile' && t.files?.[0]) return upload(t.files[0]);
    if (t.matches?.('[data-skip]')) { const tr = t.closest('tr'); $('[data-handle]', tr).disabled = t.checked; const c = $('[data-confirm]', tr); if (c) c.disabled = t.checked; }
  }

  GOM.registerTab({
    id: 'import', label: 'Import',
    async render(el) { await render(el); el.onclick = onClick; el.onchange = onChange; },
  });
})();
