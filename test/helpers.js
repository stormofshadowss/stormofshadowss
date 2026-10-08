import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { createMailer } from '../src/mail.js';
import { migrate } from '../src/migrate.js';
import { createApp } from '../src/app.js';
import { catalogRoutes } from '../src/routes/catalog.js';
import { claimRoutes } from '../src/routes/claims.js';
import { meRoutes } from '../src/routes/me.js';
import { adminRoutes } from '../src/routes/admin.js';
import { setRoutes } from '../src/routes/sets.js';
import { fixedRoutes } from '../src/routes/fixed.js';
import { boxRoutes } from '../src/routes/boxes.js';
import { proxyRoutes } from '../src/routes/proxy.js';
import { shopRoutes } from '../src/routes/shop.js';
import { imageRoutes } from '../src/routes/images.js';
import { importRoutes } from '../src/routes/import.js';
import { inviteRoutes } from '../src/routes/invites.js';
import { cancelRequestRoutes } from '../src/routes/cancel-requests.js';
import { createAdmin } from '../src/lib/admins.js';

export const ADMIN = { username: 'boss', email: 'boss@example.com', password: 'correct horse battery staple' };
const DB = { host: process.env.TEST_DB_HOST || '127.0.0.1', user: process.env.TEST_DB_USER || 'sos', password: process.env.TEST_DB_PASSWORD || 'sos_pw' };

// A fresh app on a throwaway database, listening on a random port.
export async function startApp(overrides = {}) {
  const dbName = `sos_test_${crypto.randomBytes(4).toString('hex')}`;
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-uploads-'));       // each app keeps its pictures in its own throwaway folder
  const cfg = loadConfig({
    UPLOADS_DIR: uploadsDir,
    DB_HOST: DB.host, DB_USER: DB.user, DB_PASSWORD: DB.password, DB_NAME: dbName,
    MAIL_MODE: 'memory', COOKIE_SECURE: 'false', PUBLIC_URL: 'http://test.local',
    RATE_REQUEST_LINK_PER_HOUR: '1000', LOGIN_LINKS_PER_EMAIL_PER_HOUR: '50', RATE_CLAIMS_PER_10MIN: '1000', RATE_API_PER_MIN: '100000',
    ...overrides,
  });
  const root = await mysql.createConnection(DB);
  await root.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await root.end();
  await migrate(cfg, () => {});
  const pool = createPool(cfg);
  const mailer = createMailer(cfg);
  const app = createApp({ cfg, pool, mailer, extraRoutes: [catalogRoutes, claimRoutes, meRoutes, adminRoutes, setRoutes, fixedRoutes, boxRoutes, proxyRoutes, shopRoutes, imageRoutes, importRoutes, inviteRoutes, cancelRequestRoutes] });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  await createAdmin(pool, ADMIN);   // the GOM account every test suite signs in with

  async function api(method, path, body, cookie) {
    const headers = { 'x-requested-with': 'sos' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  const tokenFromMail = (email) => /token=([A-Za-z0-9_-]+)/.exec(mailer.outbox.filter((m) => m.to === email).pop().text)[1];
  async function confirm(token) {
    const res = await fetch(`${base}/auth/confirm`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}`, redirect: 'manual' });
    return { status: res.status, setCookie: res.headers.get('set-cookie'), text: await res.text() };
  }
  // Signs in via the emailed link, once per address (links are throttled per email).
  async function login(email) {
    if (cookies[email]) return cookies[email];
    await api('POST', '/api/auth/request-link', { email });
    const out = await confirm(tokenFromMail(email));
    cookies[email] = out.setCookie.split(';')[0];
    return cookies[email];
  }
  // Signs the GOM in with username + password, once.
  async function adminLogin(username = ADMIN.username, password = ADMIN.password) {
    const key = `admin:${username}`;
    if (cookies[key]) return cookies[key];
    const r = await api('POST', '/api/admin/login', { username, password });
    if (r.status !== 200) throw new Error(`admin login failed: ${r.status} ${r.text}`);
    cookies[key] = r.headers.get('set-cookie').split(';')[0];
    return cookies[key];
  }
  async function stop() {
    await new Promise((r) => server.close(r));
    await pool.end();
    const root2 = await mysql.createConnection(DB);
    await root2.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await root2.end();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
  return { cfg, pool, mailer, notifier: app.locals.notifier, api, login, adminLogin, confirm, tokenFromMail, base, stop, q: (sql, p) => pool.query(sql, p).then(([r]) => r) };
}

// The standard fixture: one GO with each simple item type, plus a private GO.
export async function seed(app, adminCookie) {
  const { api } = app;
  const group = (await api('POST', '/api/admin/groups', { name: 'Stray Kids', members: ['Bang Chan', 'Han'] }, adminCookie)).json.id;
  const order = (await api('POST', '/api/admin/orders', { groupId: group, title: 'Run It GO', paymentDeadline: '2099-01-10', proxy: 'Sam' }, adminCookie)).json.id;
  const item = async (body, ord = order) => (await api('POST', `/api/admin/orders/${ord}/items`, body, adminCookie)).json.id;
  const keyring = await item({ type: 'normal', title: 'Keyring', price: 6 });
  const photocards = await item({ type: 'independent', title: 'Solo Photocards', price: 8, members: ['Bang Chan', 'Han'] });
  const hoodie = await item({ type: 'size', title: 'Hoodie', price: 50, variants: ['M', 'L'], sizeBucket: 'L' });
  const album = await item({ type: 'normal', title: 'Album', price: 26, paymentDeadline: '2099-02-02', proxy: 'Lulu' });
  const secret = (await api('POST', '/api/admin/orders', { groupId: group, title: 'Off-site Weverse', isPrivate: true }, adminCookie)).json.id;
  const secretItem = await item({ type: 'normal', title: 'Secret thing', price: 10 }, secret);
  return { group, order, keyring, photocards, hoodie, album, secret, secretItem };
}

// Claim as a handle (no sign-in) and have the GOM secure it.
export async function claimAndSecure(app, adminCookie, handle, itemId, extra = {}) {
  const r = await app.api('POST', '/api/claims', { handle, lines: [{ itemId, ...extra }] });
  if (r.status !== 201) throw new Error(`claim failed: ${r.status} ${r.text}`);
  await app.api('POST', '/api/admin/claims/secure', { claimIds: r.json.claimIds }, adminCookie);
  return r.json.claimIds;
}

// Links a signed-in account to a brand-new handle and returns its cookie.
export async function joinerSession(app, email, handle) {
  const cookie = await app.login(email);
  const r = await app.api('POST', '/api/me/handles', { handle }, cookie);
  if (r.status !== 200) throw new Error(`link failed: ${r.status} ${r.text}`);
  return cookie;
}

// Ticks everything on a parcel's packing checklist (every item, the address, the Lomo name and the bias name).
export async function tickParcel(app, adminCookie, parcelId) {
  await app.api('POST', `/api/admin/parcels/${parcelId}/items-packed`, { packed: true }, adminCookie);
  await app.api('POST', `/api/admin/parcels/${parcelId}/checks`, { address: true, lomo: true, bias: true }, adminCookie);
  // a shared parcel also has its friend's own Lomo name / bias name to check
  const [c] = await app.q("SELECT 1 FROM parcel_companions WHERE parcel_id = ? AND status = 'accepted'", [parcelId]);
  if (c) await app.api('POST', `/api/admin/parcels/${parcelId}/checks`, { friend: true, lomo: true, bias: true }, adminCookie);
}
