import fs from 'node:fs';
import path from 'node:path';
import { versionHtml, pageFile } from './lib/asset-version.js';
import { createNotifier } from './lib/notify.js';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { viewAs } from './lib/view-as.js';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { HttpError } from './errors.js';
import { attachAccount } from './auth.js';
import authRoutes from './routes/auth.js';
import handleRoutes from './routes/handles.js';
import adminAuthRoutes from './routes/adminAuth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.resolve(here, '../../public');

export function createApp({ cfg, pool, mailer, extraRoutes = [] }) {
  const app = express();
  app.set('trust proxy', cfg.trustProxy);
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], formAction: ["'self'"],
        frameAncestors: ["'none'"], baseUri: ["'self'"], objectSrc: ["'none'"],
        // "Fetch every stylesheet/script over https" is only right when the site IS served over https. On plain http (e.g. http://192.168.1.12:2999) it makes browsers
        // request the CSS and JS over https on a port that doesn't speak it, so they fail and the page shows as bare, unstyled HTML.
        upgradeInsecureRequests: cfg.cookieSecure ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use(attachAccount(pool, cfg));

  app.use('/api', rateLimit({
    windowMs: 60_000, limit: cfg.rateLimits.apiPerMinutePerIp, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Slow down a little — too many requests.' },
  }));

  // Anything that changes data must carry a header a plain cross-site form can't send.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('x-requested-with') !== 'sos') return next(new HttpError(403, 'Missing X-Requested-With header'));
    next();
  });

  app.use(viewAs(pool));                                                                         // an admin opening a person's dashboard, read-only (lib/view-as.js)

  const notifier = createNotifier({ pool, mailer, cfg });
  app.locals.notifier = notifier;
  const ctx = { cfg, pool, mailer, notifier };
  app.get('/healthz', async (req, res, next) => { try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch (e) { next(e); } });
  app.use(authRoutes(ctx));
  app.use(adminAuthRoutes(ctx));
  app.use('/api', handleRoutes(ctx));
  for (const mount of extraRoutes) mount(app, ctx);

  // The design preview is one self-contained demo page with inline scripts, so it gets its own relaxed policy.
  app.get('/preview.html', (req, res) => {
    res.set('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'");
    res.sendFile(path.join(PUBLIC_DIR, 'preview.html'));
  });
  const selfFrame = helmet.contentSecurityPolicy({ directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], formAction: ["'self'"], frameAncestors: ["'self'"], baseUri: ["'self'"], objectSrc: ["'none'"], upgradeInsecureRequests: cfg.cookieSecure ? [] : null } });
  app.get('/my.html', (req, res, next) => (req.account?.isAdmin && req.query.viewAs ? selfFrame(req, res, next) : next()));       // everyone else (and everything else) stays unframeable
  // PAGES are always re-checked (so a new version is picked up straight away) and are sent with every script / stylesheet link stamped with that file's fingerprint (…/orders.js?v=3fa9c1d2e0).
  // A stamped file can be kept for a year, because its address changes the moment its contents do; an unstamped one is always re-checked. Result: nobody has to purge Cloudflare after an update.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const file = pageFile(PUBLIC_DIR, req.path); if (!file) return next();
    fs.readFile(file, 'utf8', (err, html) => { if (err) return next(); res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.send(versionHtml(html, PUBLIC_DIR)); });
  });
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '5m', setHeaders: (res, file) => { if (/\.(js|css)$/i.test(file)) res.set('Cache-Control', res.req?.query?.v ? 'public, max-age=31536000, immutable' : 'no-cache'); } }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'Invalid input', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}
