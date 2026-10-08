import { loadConfig } from './config.js';
import fs from 'node:fs/promises';
import { createPool } from './db.js';
import { createMailer } from './mail.js';
import { migrate } from './migrate.js';
import { createApp } from './app.js';
import { cleanupExpired } from './auth.js';
import { adminCount, bootstrapAdmin } from './lib/admins.js';
import { catalogRoutes } from './routes/catalog.js';
import { claimRoutes } from './routes/claims.js';
import { meRoutes } from './routes/me.js';
import { adminRoutes } from './routes/admin.js';
import { setRoutes } from './routes/sets.js';
import { fixedRoutes } from './routes/fixed.js';
import { boxRoutes } from './routes/boxes.js';
import { proxyRoutes } from './routes/proxy.js';
import { shopRoutes } from './routes/shop.js';
import { imageRoutes } from './routes/images.js';
import { importRoutes } from './routes/import.js';
import { inviteRoutes } from './routes/invites.js';
import { cancelRequestRoutes } from './routes/cancel-requests.js';

const cfg = loadConfig();
if (cfg.prod && cfg.mail.mode === 'console') console.warn('WARNING: SMTP is not configured, so sign-in links are printed to this log instead of emailed.');

// The database container can take a few seconds to accept connections on first start.
async function waitForDb(tries = 40) {
  for (let i = 1; i <= tries; i++) {
    try { await migrateOrPing(); return; } catch (e) {
      if (i === tries) throw e;
      console.log(`waiting for the database (${i}/${tries}): ${e.code || e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
async function migrateOrPing() { if (cfg.autoMigrate) await migrate(cfg); else await pool.query('SELECT 1'); }

const pool = createPool(cfg);
await waitForDb();
await bootstrapAdmin(pool, cfg.initialAdmin);
if ((await adminCount(pool)) === 0) {
  console.warn('\nNO ADMIN ACCOUNT YET. Either set INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD in your settings and restart, or create one with:\n   docker exec -it <the app container> node src/admin-cli.js create\n   (or, with the clone install:  docker compose run --rm app node src/admin-cli.js create)\n');
}
const mailer = createMailer(cfg);
const app = createApp({ cfg, pool, mailer, extraRoutes: [catalogRoutes, claimRoutes, meRoutes, adminRoutes, setRoutes, fixedRoutes, boxRoutes, proxyRoutes, shopRoutes, imageRoutes, importRoutes, inviteRoutes, cancelRequestRoutes] });
// Uploaded pictures need a folder the app can write to. Say so loudly at start-up rather than failing later, when someone uploads one.
try { await fs.mkdir(cfg.uploadsDir, { recursive: true }); await fs.access(cfg.uploadsDir, fs.constants.W_OK); }
catch { console.error(`WARNING: the pictures folder (${cfg.uploadsDir}) can't be written to, so picture uploads will fail. In Docker, run:  chown -R 1000:1000 <DATA_DIR>/uploads   then restart the app.`); }
app.listen(cfg.port, () => console.log(`StormOfShadowss listening on :${cfg.port} (${cfg.publicUrl})`));

// Overdue reminders: check once shortly after start, then every hour. Each overdue claim is only ever reminded once, so checking often is harmless.
if (cfg.reminders.enabled) {
  const runReminders = () => app.locals.notifier.sendOverdueReminders().then((r) => { if (r.emails) console.log(`reminders: ${r.emails} email(s) for ${r.claims} overdue claim(s)`); }).catch((e) => console.error('reminders failed:', e.message));
  setTimeout(runReminders, 60_000).unref();
  setInterval(runReminders, cfg.reminders.everyMinutes * 60_000).unref();
}
setInterval(() => cleanupExpired(pool).catch((e) => console.error('cleanup failed', e.message)), 3_600_000).unref();
