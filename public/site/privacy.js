// The privacy notice: the header, and the GOM's contact email if one has been set (CONTACT_EMAIL). Without one the notice says to get in touch the usual way.
(function () {
  document.getElementById('hdr').innerHTML = SITE.header('');
  SITE.api('GET', '/api/site-info').then((r) => {
    const email = r.ok && r.json && r.json.contactEmail;
    if (!email) return;
    const a = document.createElement('a');
    a.href = `mailto:${email}`; a.textContent = email;                                  // text and attribute only — never parsed as HTML
    const slot = document.getElementById('contact');
    slot.textContent = ''; slot.appendChild(a);
  }).catch(() => {});
})();
