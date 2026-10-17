import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { notFound } from '../errors.js';
import { fixPlan, deleteClaims, claimToCredit, changeClaim } from '../lib/claim-fix.js';

// Fixing mistakes in claims (see lib/claim-fix.js): what can be done with this claim, change what it is, delete (only when nothing would be lost), turn a filler line into credit.
export function claimFixRoutes(app, { pool }) {
  app.get('/api/admin/claims/:id/fix-plan', requireAdmin, wrap(async (req, res) => {
    const plan = await fixPlan(pool, Number(req.params.id)); if (!plan) throw notFound('No such claim');
    res.json(plan);
  }));

  app.post('/api/admin/claims/:id/change', requireAdmin, wrap(async (req, res) => {
    const b = z.object({ itemId: z.number().int().positive(), member: z.string().max(80).optional(), variant: z.string().max(40).optional(), pricing: z.enum(['reprice', 'keep']).optional(), overrideLimit: z.boolean().optional() }).parse(req.body);
    const out = await withTx(pool, (conn) => changeClaim(conn, Number(req.params.id), b, req.account.id, audit));
    res.json({ ok: true, ...out });
  }));

  // dryRun only reports what would happen. Whatever can be deleted is; the rest come back with their reasons.
  app.post('/api/admin/claims/delete', requireAdmin, wrap(async (req, res) => {
    const b = z.object({ claimIds: z.array(z.number().int().positive()).min(1).max(200), dryRun: z.boolean().optional() }).parse(req.body);
    const out = await withTx(pool, async (conn) => {
      const r = await deleteClaims(conn, b.claimIds, { dryRun: !!b.dryRun });
      if (!b.dryRun && r.deleted.length) await audit(conn, req.account.id, 'claims.delete', 'claim', null, { count: r.deleted.length, refused: r.refused.length, ids: r.deleted.map((d) => d.id) });
      return r;
    });
    res.json({ ok: true, dryRun: !!b.dryRun, deleted: out.deleted.length, deletedClaims: out.deleted, refused: out.refused });
  }));

  app.post('/api/admin/claims/:id/to-credit', requireAdmin, wrap(async (req, res) => {
    const b = z.object({ amount: z.number().positive().max(100000), reason: z.string().trim().min(1).max(255) }).parse(req.body);
    const out = await withTx(pool, (conn) => claimToCredit(conn, Number(req.params.id), b, req.account.id, audit));
    res.json({ ok: true, ...out });
  }));
}
