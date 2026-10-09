import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seed, joinerSession } from './helpers.js';
import { openPage } from './ui.helpers.js';

let app, admin, w;
before(async () => { app = await startApp(); admin = await app.adminLogin(); w = await seed(app, admin); });
after(async () => { await app.stop(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p, sel) => p.text(p.q(sel));

test('A "Privacy notice" link sits at the foot of the shop, My orders and claim-your-orders pages — once each', async () => {
  const c = await joinerSession(app, 'priv1@x.com', 'priv_one');
  for (const [url, opts] of [['/', {}], ['/my.html', { cookies: [c] }], ['/claim.html', {}], ['/privacy.html', {}]]) {
    const p = await openPage(app, url, opts); await sleep(40); await p.settle();
    const links = p.qa('footer#siteFoot a[href="/privacy.html"]');
    assert.equal(links.length, 1, url); assert.equal(p.text(links[0]), 'Privacy notice', url);
    assert.equal(p.qa('footer#siteFoot').length, 1, `${url}: never added twice`);
    assert.deepEqual(p.errors, [], url); p.close();
  }
});

test('the notice page: header, every section, a way back; and with no contact email set it says to get in touch the usual way', async () => {
  const p = await openPage(app, '/privacy.html'); await sleep(60); await p.settle();
  assert.ok(p.q('header.site-top'), 'the normal site header');
  const t = text(p, '#view');
  assert.match(t, /Privacy notice.*Last updated October 2026.*Who we are.*What we keep, and why.*Cookies.*Who else sees it.*Why we're allowed to.*How long we keep it.*Your rights.*Changes/s);
  assert.match(text(p, '#contact'), /get in touch with the GOM the same way you normally order/); assert.equal(p.q('#contact a'), null);
  assert.ok(p.q('a[href="/"]'), 'a link back to the group orders');
  assert.deepEqual(p.errors, []); p.close();
});

test('with a contact email set it is a mailto link, shown as plain text (even with awkward but valid characters)', async () => {
  const a = await startApp({ CONTACT_EMAIL: "o'brien+orders@example.com" });
  try {
    const p = await openPage(a, '/privacy.html'); await sleep(80); await p.settle();
    const link = p.q('#contact a'); assert.ok(link);
    assert.equal(link.getAttribute('href'), "mailto:o'brien+orders@example.com"); assert.equal(p.text(link), "o'brien+orders@example.com");
    assert.doesNotMatch(text(p, '#contact'), /get in touch with the GOM the same way/); assert.equal(p.q('#contact img, #contact script'), null);
    assert.deepEqual(p.errors, []); p.close();
  } finally { await a.stop(); }
});

test('My settings links to the notice (in a new tab, safely)', async () => {
  const c = await joinerSession(app, 'priv2@x.com', 'priv_two');
  const p = await openPage(app, '/my.html#/settings', { cookies: [c] }); await sleep(80); await p.settle();
  const link = p.q('#view a[href="/privacy.html"]'); assert.ok(link);
  assert.deepEqual([link.getAttribute('target'), link.getAttribute('rel'), p.text(link)], ['_blank', 'noopener', 'Privacy notice']);
  assert.match(text(p, '#view'), /Privacy notice — what we keep, why, and for how long\./);
  p.close();
});
