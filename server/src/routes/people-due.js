import { wrap } from '../lib/http.js';
import { requireAdmin, audit } from '../auth.js';
import { notFound } from '../errors.js';
import { normalizeHandle } from '../lib/handles.js';
import { explainDue } from '../lib/explain-due.js';

// GOM → People → look up a person: what they owe and why (and, from the same page, their dashboard exactly as they see it — see lib/view-as.js).
export function peopleDueRoutes(app, { pool }) {
  app.get('/api/admin/people/:handle/due', requireAdmin, wrap(async (req, res) => {
    const out = await explainDue(pool, normalizeHandle(req.params.handle)); if (!out) throw notFound('No one with that handle');
    await audit(pool, req.account.id, 'people.lookup', 'joiner', null, { handle: out.handle });
    res.json(out);
  }));
}
