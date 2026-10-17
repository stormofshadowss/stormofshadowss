import { HttpError } from '../errors.js';
import { audit } from '../auth.js';

// READ-ONLY "VIEW AS": the GOM can open a person's dashboard exactly as they see it. A GET to /api/admin/view-as/<accountId>/me (or /my/…) is run through the REAL joiner endpoint as that
// person — so it can never drift from what they actually see. It is safe because: only a signed-in ADMIN gets in; ONLY GET is allowed (anything else is refused with 'read_only'); only the
// dashboard's own endpoints (/me and /my/…) are reachable; and the person's account is not an admin, so it can't reach any admin route. The one joiner "read" that writes (address
// sharing) is switched off by req.viewAs. Opening a dashboard is recorded in the activity log (once per admin and person per 10 minutes, so a page load isn't noise).
const PATH = /^\/api\/admin\/view-as\/(\d+)(\/.*)?$/;

export function viewAs(pool) {
  return async (req, res, next) => {
    const m = PATH.exec(req.path);
    if (!m) return next();
    try {
      if (!req.account) throw new HttpError(401, 'Please sign in', 'not_signed_in');
      if (!req.account.isAdmin) throw new HttpError(403, 'Admins only');
      if (req.method !== 'GET') throw new HttpError(403, 'This is a read-only view — nothing can be changed from here.', 'read_only');
      const rest = m[2] || '';
      if (!(rest === '/me' || rest === '/my' || rest.startsWith('/my/'))) throw new HttpError(404, 'Not found');
      const accountId = Number(m[1]);
      const [[acc]] = await pool.query('SELECT id, email, username FROM accounts WHERE id = ?', [accountId]);
      if (!acc) throw new HttpError(404, 'No such account');
      if (rest === '/me') {
        const [[seen]] = await pool.query("SELECT 1 AS n FROM audit_log WHERE action = 'view_as' AND account_id = ? AND entity_id = ? AND created_at > NOW() - INTERVAL 10 MINUTE LIMIT 1", [req.account.id, accountId]);
        if (!seen) await audit(pool, req.account.id, 'view_as', 'account', accountId, { email: acc.email });
      }
      req.adminAccount = req.account;
      req.account = { id: acc.id, email: acc.email, isAdmin: false, username: acc.username || null };         // from here on this request IS that person (not an admin)
      req.viewAs = true;
      const q = req.url.indexOf('?'); req.url = `/api${rest === '/my' ? '/my' : rest}${q >= 0 ? req.url.slice(q) : ''}`;
      next();
    } catch (e) { next(e); }
  };
}
