// Launch: delete test orders (with everything on them), reset everything for launch, and finally go live — which switches both of those off for good.
(function () {
  const { esc, money, fmtDate, api, errText, $ } = GOM;
  let root = null, st = { live: false, testOrders: [] }, del = null;
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

  async function render(el) { root = el; const r = await api('GET', '/api/admin/launch'); st = r.json || st; del = null; draw(); }

  const liveCard = () => `<div class="card" data-live><h2>The site is live</h2><p>It went live on ${fmtDate(String(st.launchedAt || '').slice(0, 10))}. Resetting and deleting test orders are switched off for good.</p></div>`;

  const testCard = () => `<div class="card" id="testOrders"><h2>Test orders</h2>
    <p class="sub" style="margin-top:0">Tick <strong>Test order</strong> when you create or edit a group order (Group Orders tab). A test order can be deleted here <em>together with everything on it</em> — its claims, the payments made towards them, parcels and boxes — until you go live.</p>
    ${st.testOrders.length ? st.testOrders.map((o) => `<div class="itemrow" data-test-order="${o.id}"><div class="grow"><strong>${esc(o.title)}</strong> <span class="sub">${o.claims} claim${o.claims === 1 ? '' : 's'} · ${o.payments} payment${o.payments === 1 ? '' : 's'}</span></div><button class="sm secondary danger" data-act="td-open" data-id="${o.id}">Delete…</button></div>`).join('') : '<p class="muted">No orders are ticked as test orders.</p>'}
    ${del ? deletePanel() : ''}</div>`;

  function deletePanel() {
    const p = del.plan, r = p.removes, blocked = p.blockers.length > 0;
    return `<div class="card" id="tdPanel" style="border:2px solid var(--accent); margin-top:10px"><h3 style="margin-top:0">Delete the test order “${esc(p.title)}”?</h3>
      <p data-removes>This removes <strong>${r.items} item${r.items === 1 ? '' : 's'}</strong>, <strong>${r.claims} claim${r.claims === 1 ? '' : 's'}</strong> from ${r.people} ${r.people === 1 ? 'person' : 'people'}${r.payments ? `, <strong>${r.payments} payment${r.payments === 1 ? '' : 's'} (${money(r.money)})</strong>` : ''}${r.parcels ? `, ${r.parcels} parcel${r.parcels === 1 ? '' : 's'}` : ''}${r.boxes ? `, ${r.boxes} box${r.boxes === 1 ? '' : 'es'}` : ''}${r.proxyPayments ? `, ${r.proxyPayments} proxy payment${r.proxyPayments === 1 ? '' : 's'}` : ''}, and puts anyone's credit back to how it was before this order. The people themselves stay.</p>
      ${blocked ? `<div class="msg" data-blockers><strong>It can't be deleted on its own:</strong>${p.blockers.map((b) => `<div style="margin-top:4px">${esc(b.message)}</div>`).join('')}</div>`
        : `<label for="tdTyped">To confirm, type the name: <strong>${esc(p.title)}</strong></label><input id="tdTyped" autocomplete="off" style="max-width:420px">`}
      <p class="msg" data-msg hidden></p>
      <div class="btn-row"><button class="danger" data-act="td-go" disabled ${blocked ? 'hidden' : ''}>Delete it…</button><button class="secondary" data-act="td-close">${blocked ? 'Close' : 'Keep it'}</button></div></div>`;
  }

  const resetCard = () => `<div class="card" id="resetCard"><h2>Reset for launch</h2>
    <p class="sub" style="margin-top:0">Wipes <strong>every</strong> order, item, claim, payment, parcel, box, proxy payment, shop item, picture and log — the test data. <strong>Kept:</strong> your artists/groups, payment methods, proxies and your own GOM login. Do this <em>before</em> the Notion import, and when nobody is using the site.</p>
    <p style="margin:8px 0 4px"><strong>1. Take a backup first.</strong> In the Unraid terminal run:</p>
    <pre data-backup-cmd style="background:var(--paper); padding:8px 12px; border-radius:8px; overflow:auto; margin:0 0 6px">docker exec -e ONCE=1 sos-backup /bin/sh /backup.sh</pre>
    <label class="chk" style="display:flex"><input type="checkbox" id="rsBackup"> I've taken a backup just now</label>
    <p style="margin:10px 0 4px"><strong>2. People</strong></p>
    <label class="chk" style="display:flex"><input type="checkbox" id="rsKeep"> Keep people — their accounts, Instagram handles and delivery details (their orders, payments and credit are still wiped)</label>
    <p style="margin:10px 0 4px"><strong>3. Type RESET to confirm</strong></p>
    <input id="rsTyped" autocomplete="off" style="max-width:240px"><p class="msg" data-msg hidden></p>
    <div class="btn-row"><button class="danger" data-act="rs-go" disabled>Reset everything…</button></div></div>`;

  const goLiveCard = () => `<div class="card" id="goLiveCard"><h2>Go live</h2>
    <p class="sub" style="margin-top:0">The last step, once the real data is in. It's <strong>permanent</strong>: resetting and deleting test orders are switched off for good, so a real order can never be wiped by accident.</p>
    <label for="glTyped">Type GO LIVE to confirm</label><input id="glTyped" autocomplete="off" style="max-width:240px"><p class="msg" data-msg hidden></p>
    <div class="btn-row"><button class="danger" data-act="gl-go" disabled>Go live…</button></div></div>`;

  function draw() {
    root.innerHTML = `<h1 style="margin:18px 0 10px">Launch</h1>${st.live ? liveCard() : `${testCard()}${resetCard()}${goLiveCard()}`}`;
  }
  const say = (card, text) => { const m = $('[data-msg]', card); m.textContent = text; m.hidden = !text; m.className = 'msg'; };

  async function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'td-open') {
      const r = await api('GET', `/api/admin/orders/${b.dataset.id}/test-delete-plan`);
      if (!r.ok) return GOM.toast(errText(r), true);
      del = { id: Number(b.dataset.id), plan: r.json }; draw(); $('#tdTyped', root)?.focus(); return;
    }
    if (act === 'td-close') { del = null; draw(); return; }
    if (act === 'td-go') {
      const typed = $('#tdTyped', root).value, p = del.plan;
      if (norm(typed) !== norm(p.title)) return;
      if (!(await GOM.confirm(`Really delete “${p.title}” and everything on it?\n\nThis can't be undone.`, { ok: 'Yes, delete it', cancel: 'Go back' }))) return;
      const r = await api('POST', `/api/admin/orders/${del.id}/test-delete`, { confirm: typed });
      if (!r.ok) return say($('#tdPanel', root), errText(r));
      GOM.toast(`Deleted “${r.json.title}” and everything on it.`); await render(root); return;
    }
    if (act === 'rs-go') {
      const card = $('#resetCard', root), keep = $('#rsKeep', root).checked;
      if (!(await GOM.confirm(`Reset everything for launch?\n\nEvery order, claim, payment, parcel and picture will be wiped${keep ? '' : ', and every person with them'}. Your setup and your GOM login stay.\n\nYou've taken a backup. This can't be undone.`, { ok: 'Yes, reset everything', cancel: 'Go back' }))) return;
      const r = await api('POST', '/api/admin/launch/reset', { confirm: $('#rsTyped', root).value, backupConfirmed: true, keepPeople: keep });
      if (!r.ok) return say(card, errText(r));
      const x = r.json.removed; GOM.toast(`Reset done — removed ${x.orders} order${x.orders === 1 ? '' : 's'}, ${x.claims} claim${x.claims === 1 ? '' : 's'}, ${x.payments} payment${x.payments === 1 ? '' : 's'}${keep ? '' : `, ${x.people} ${x.people === 1 ? 'person' : 'people'}`}.`);
      await render(root); return;
    }
    if (act === 'gl-go') {
      const card = $('#goLiveCard', root);
      if (!(await GOM.confirm('Go live?\n\nResetting and deleting test orders will be switched off for good. This can never be undone.', { ok: 'Yes, go live', cancel: 'Not yet' }))) return;
      const r = await api('POST', '/api/admin/launch/go-live', { confirm: $('#glTyped', root).value });
      if (!r.ok) return say(card, errText(r));
      GOM.toast('The site is live.'); await render(root);
    }
  }
  // buttons wake up only when everything they need is in place — typing never redraws, so nothing you type is lost
  function onInput() {
    if (del && $('#tdTyped', root)) $('[data-act="td-go"]', root).disabled = norm($('#tdTyped', root).value) !== norm(del.plan.title);
    if ($('#rsTyped', root)) $('[data-act="rs-go"]', root).disabled = !($('#rsBackup', root).checked && norm($('#rsTyped', root).value) === 'reset');
    if ($('#glTyped', root)) $('[data-act="gl-go"]', root).disabled = norm($('#glTyped', root).value) !== 'go live';
  }

  GOM.registerTab({
    id: 'launch', label: 'Launch',
    async render(el) { await render(el); el.onclick = onClick; el.oninput = onInput; el.onchange = onInput; },
  });
})();
