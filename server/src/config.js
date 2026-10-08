import path from 'node:path';
// All configuration comes from environment variables (see .env.example).
const truthy = (v, dflt = false) => (v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

export function loadConfig(overrides = {}) {
  const e = { ...process.env, ...overrides };
  const prod = e.NODE_ENV === 'production';
  return {
    prod,
    port: Number(e.PORT || 3000),
    // Optional: creates the FIRST admin automatically on start-up (only if there is no admin yet). Lets a fresh install work from the settings file alone.
    initialAdmin: { username: (e.INITIAL_ADMIN_USERNAME || '').trim(), email: (e.INITIAL_ADMIN_EMAIL || '').trim(), password: e.INITIAL_ADMIN_PASSWORD || '' },
    // The address people use in their browser. Sign-in links are built from it.
    publicUrl: (e.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
    db: {
      host: e.DB_HOST || 'db',
      port: Number(e.DB_PORT || 3306),
      user: e.DB_USER || 'sos',
      password: e.DB_PASSWORD || '',
      database: e.DB_NAME || 'sos',
    },
    autoMigrate: truthy(e.AUTO_MIGRATE, true),
    inviteDays: Number(e.INVITE_DAYS || 7),                // how long a "claim your orders" link works
    // where uploaded pictures are kept (a folder that survives restarts — in Docker, a mounted volume)
    uploadsDir: path.resolve(e.UPLOADS_DIR || './uploads'),
    // the one-off overdue-payment reminder emails (only ever sent to people who opted in to notifications)
    reminders: { enabled: truthy(e.REMINDERS_ENABLED, true), everyMinutes: Number(e.REMINDER_EVERY_MINUTES || 60) },
    // Admin accounts live in the database (created with the admin command, see README) — not in this file.
    adminSessionHours: Number(e.ADMIN_SESSION_HOURS || 12),
    adminMaxFailures: Number(e.ADMIN_MAX_FAILURES || 5),
    adminLockMinutes: Number(e.ADMIN_LOCK_MINUTES || 15),
    cookieSecure: truthy(e.COOKIE_SECURE, prod),
    trustProxy: Number(e.TRUST_PROXY ?? (prod ? 1 : 0)), // 1 = behind one proxy (Cloudflare Tunnel / nginx)
    sessionDays: Number(e.SESSION_DAYS || 30),
    claimProofDays: Number(e.CLAIM_PROOF_DAYS || 30),
    loginLinkMinutes: Number(e.LOGIN_LINK_MINUTES || 15),
    loginLinksPerEmailPerHour: Number(e.LOGIN_LINKS_PER_EMAIL_PER_HOUR || 5),
    rateLimits: {
      requestLinkPerHourPerIp: Number(e.RATE_REQUEST_LINK_PER_HOUR || 20),
      claimsPer10MinPerIp: Number(e.RATE_CLAIMS_PER_10MIN || 60),
      apiPerMinutePerIp: Number(e.RATE_API_PER_MIN || 600),
      adminLoginPer15MinPerIp: Number(e.RATE_ADMIN_LOGIN_PER_15MIN || 20),
    },
    mail: {
      // smtp = send for real · console = print links to the container log · memory = tests
      mode: e.MAIL_MODE || (e.SMTP_HOST ? 'smtp' : 'console'),
      from: e.SMTP_FROM || 'StormOfShadowss <no-reply@localhost>',
      smtp: {
        host: e.SMTP_HOST,
        port: Number(e.SMTP_PORT || 587),
        secure: truthy(e.SMTP_SECURE, false),
        user: e.SMTP_USER,
        pass: e.SMTP_PASS,
      },
    },
  };
}
